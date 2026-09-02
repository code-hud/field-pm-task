/**
 * The market's single writer.
 *
 * Quotes now live in Postgres, so if every API replica ticked, they would all write
 * conflicting prices to the same ~500 rows. Instead each replica tries to take a
 * session-level advisory lock at boot; whoever wins runs the simulation, and the
 * rest serve reads only. The lock is tied to the Postgres session, so if the leader
 * dies its lock is released automatically and another replica picks it up on its
 * next attempt — no heartbeat table, no lease expiry to tune.
 */
const { config } = require('../config/index.js');
const { SECTORS } = require('../data/instruments.js');
const { pool } = require('../db/pool.js');
const { setFailure, wrapFlow } = require('../observability/telemetry.js');
const { sessionState } = require('./clock.js');
const { FactorEngine, instrumentStep, MINUTES_PER_SESSION, round2 } = require('./simulation.js');
const { randomBetween, createRng, hashString } = require('../lib/random.js');
const { sweepRestingOrders } = require('../orders/restingBook.js');

const TICKER_LOCK_ID = 918_273_646;

// How much of a tick the resting-order sweep may spend. The rest of the interval
// belongs to the tape itself — ~500 quote rows and a minute of bars — and to the
// slack that keeps a slow tick from becoming a skipped one.
const SWEEP_BUDGET_FRACTION = 0.4;

/**
 * The factor loadings for one quote row.
 *
 * They are columns rather than a recomputation of `factorLoadings()`, so the tape
 * moves on exactly the numbers the seeder built history with. The fallbacks cover
 * one real case: migration 002 has run on a live database but the seeder has not,
 * so the columns exist and are null. Treating the name as pure idiosyncratic noise
 * at its declared volatility is the pre-factor-model behaviour, which is the right
 * thing to degrade to.
 */
function loadingsFor(row) {
  const hasLoadings = row.idio_volatility !== null && row.sector_loading !== null;
  return {
    marketBeta: hasLoadings ? row.beta : 0,
    sectorBeta: hasLoadings ? row.sector_loading : 0,
    idioVolatility: hasLoadings ? row.idio_volatility : row.volatility,
    alpha: row.drift_annual ?? 0,
  };
}

class MarketTicker {
  constructor({
    intervalMs = config.market.tickIntervalMs,
    seed = config.market.seed,
    electionIntervalMs = config.market.electionIntervalMs,
  } = {}) {
    this.intervalMs = intervalMs;
    this.seed = seed;
    this.electionIntervalMs = electionIntervalMs;
    this.timer = null;
    this.electionTimer = null;
    this.leaderClient = null;
    this.isLeader = false;
    this.tickCount = 0;
    // Ticks that arrived while the previous one was still running. Counted rather
    // than silently dropped: a non-zero number here is the signal that the sweep or
    // the tape write is outgrowing the interval, and it is invisible otherwise.
    this.skippedTicks = 0;
    this.ticking = false;
    // Where the last resting-order pass stopped. Null means "start from the head of
    // the book", which is both the initial state and what a completed pass returns.
    this.sweepCursor = null;
    // Wrapped once rather than on every firing: `wrapFlow` builds the wrapper, and the
    // wrapper is what opens a flow per call.
    this.tickFlow = wrapFlow('market.tick', (now) => this.tick(now));
    this.startedAt = new Date();
    // Per-symbol PRNG streams and residual levels, rebuilt at boot. Prices come
    // from the database, so a restart resumes the tape rather than replaying it.
    this.streams = new Map();
    this.residuals = new Map();
    // The live tape's common factors. Varied by boot time for the same reason the
    // per-symbol streams are: a restart should not replay the same shocks.
    //
    // Its mean reversion starts from zero on every boot, and its volatility
    // regime cannot be normalized the way the seeder's is — there is no future to
    // normalize against. Both are invisible on a tape nobody watches for a whole
    // session; the history the charts draw is the seeder's, and that one is exact.
    this.factors = new FactorEngine({
      seed: this.seed ^ hashString('live') ^ Date.now(),
      sectors: SECTORS,
    });
  }

  /**
   * Tries to become the writer, and keeps trying if another replica already is.
   * Without the retry a dead leader would freeze the market until something
   * restarted — the lock frees itself, but nobody would be watching for it.
   *
   * @returns {Promise<boolean>} whether this process is the writer right now
   */
  async start() {
    const acquired = await this.#tryAcquire();
    if (!acquired) {
      console.log(`[${config.serviceName}] another replica is driving the market — read-only here.`);
      this.#watchForVacancy();
    }
    return acquired;
  }

  async #tryAcquire() {
    const client = await pool.connect();
    let acquired = false;
    try {
      const { rows } = await client.query('SELECT pg_try_advisory_lock($1) AS acquired', [
        TICKER_LOCK_ID,
      ]);
      acquired = rows[0].acquired;
    } catch (error) {
      client.release();
      throw error;
    }

    if (!acquired) {
      client.release();
      return false;
    }

    // Hold this client for as long as we lead: returning it to the pool would end
    // the session and silently drop the lock with it.
    this.leaderClient = client;
    this.isLeader = true;

    // If the connection dies (database restart, network blip) the lock is gone
    // even though this process still thinks it leads. Step down and re-contend.
    client.on('error', (error) => {
      console.error(`[${config.serviceName}] writer connection lost:`, error.message);
      this.#demote();
    });

    // The tick runs on a timer, not on a request, so no automatic instrumentation
    // opens a flow around it — the market writer would be a blind spot in a service
    // that is otherwise fully observed, and it is the one loop that can silently
    // stop repricing. Wrapping it makes each tick a named unit with its own duration
    // and error rate; a swallowed failure is reported explicitly for the same reason.
    this.timer = setInterval(() => this.runScheduledTick(), this.intervalMs);
    this.timer.unref?.();

    console.log(`[${config.serviceName}] driving the market (tick ${this.intervalMs}ms).`);
    return true;
  }

  /**
   * One firing of the interval: prove we still lead, then tick if the last one is done.
   *
   * Public rather than private because it is the unit of work, not an implementation
   * detail of the timer — it is what a caller means by "do a tick", and it is what the
   * overlap tests drive.
   *
   * <b>The leader probe runs on every firing, including the ones whose work is
   * skipped.</b> `setInterval` does not wait for the previous callback, so a tick that
   * overruns is exactly the situation in which this replica is most likely to have
   * lost its lock and least likely to notice — and a guard placed in front of the
   * probe would stop it noticing at all. Two replicas both believing they lead is the
   * worst outcome available in this file, and it is what `#demote` exists to prevent.
   *
   * <b>A skipped firing does not open a flow.</b> `wrapFlow` measures duration, and a
   * near-instant sample recorded every time a tick overruns would drag the tick
   * duration down precisely when ticks are slow — the metric would look healthiest at
   * the moment it should be loudest. A skip is a counter and a reported failure
   * instead.
   */
  async runScheduledTick() {
    if (!(await this.#stillLeading())) return;

    if (this.ticking) {
      this.skippedTicks += 1;
      setFailure(
        `market tick skipped: the previous tick has not finished after ${this.intervalMs}ms`,
      );
      console.warn(
        `[${config.serviceName}] tick skipped — the previous one is still running ` +
          `(${this.skippedTicks} skipped since boot).`,
      );
      return;
    }

    this.ticking = true;
    try {
      // Awaited rather than fired and forgotten, so the flow closes on the tick
      // actually finishing and its duration means something — and so `ticking` stays
      // true for exactly as long as a tick is running.
      await this.tickFlow();
    } catch (error) {
      setFailure(`market tick failed: ${error.message}`);
      console.error(`[${config.serviceName}] market tick failed:`, error.message);
    } finally {
      this.ticking = false;
    }
  }

  /**
   * Touch the lock-holding session. If it has died this steps down rather than
   * continuing to write while another replica also leads.
   *
   * Lifted out of `tick` so it can run on a firing whose tick is skipped. A replica
   * that has stopped ticking must not also stop checking whether it should be.
   */
  async #stillLeading() {
    if (!this.leaderClient) return true;
    try {
      await this.leaderClient.query('SELECT 1');
      return true;
    } catch (error) {
      console.error(`[${config.serviceName}] lost the writer lock:`, error.message);
      this.#demote();
      return false;
    }
  }

  /** Poll for the lock becoming free, so failover needs no operator action. */
  #watchForVacancy() {
    if (this.electionTimer) return;
    this.electionTimer = setInterval(async () => {
      if (this.isLeader) return;
      try {
        if (await this.#tryAcquire()) {
          clearInterval(this.electionTimer);
          this.electionTimer = null;
          console.log(`[${config.serviceName}] took over as market writer.`);
        }
      } catch (error) {
        console.error(`[${config.serviceName}] writer election failed:`, error.message);
      }
    }, this.electionIntervalMs);
    this.electionTimer.unref?.();
  }

  /** Drop leadership without releasing the lock — the connection already died. */
  #demote() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.leaderClient = null;
    this.isLeader = false;
    this.#watchForVacancy();
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.electionTimer) clearInterval(this.electionTimer);
    this.electionTimer = null;
    if (this.leaderClient) {
      await this.leaderClient
        .query('SELECT pg_advisory_unlock($1)', [TICKER_LOCK_ID])
        .catch(() => {});
      this.leaderClient.release();
      this.leaderClient = null;
    }
    this.isLeader = false;
  }

  #streamFor(symbol) {
    if (!this.streams.has(symbol)) {
      // Vary by tick count so a restart doesn't replay the same shock sequence.
      this.streams.set(symbol, createRng(this.seed ^ hashString(symbol) ^ Date.now()));
    }
    return this.streams.get(symbol);
  }

  /**
   * Advances every price one step and writes the tape back in a single statement.
   * ~500 rows per tick is still small enough that one UPDATE ... FROM (VALUES ...)
   * beats 500 round trips by a wide margin — it is a single ~2,500-parameter
   * statement, well inside Postgres' 65,535 cap.
   */
  async tick(now = new Date()) {
    const session = sessionState(now);
    const dtDays = this.intervalMs / 1000 / 60 / MINUTES_PER_SESSION;
    const sessionDate = now.toISOString().slice(0, 10);

    const { rows: current } = await pool.query(
      `SELECT q.symbol, q.price, q.day_high, q.day_low, q.volume,
              i.sector, i.avg_volume, i.beta, i.sector_loading, i.idio_volatility, i.drift_annual,
              i.volatility
       FROM quotes q JOIN instruments i USING (symbol)`,
    );
    if (current.length === 0) return;

    // One factor step for the whole tape: every name sees the same market move,
    // scaled by its own beta. This is what stopped the tape looking like 500
    // unrelated coin flips.
    this.factors.volScale = session.volatilityFactor;
    const factorStep = this.factors.step(dtDays);

    const updates = current.map((row) => {
      const rng = this.#streamFor(row.symbol);
      const stepResult = instrumentStep({
        loadings: loadingsFor(row),
        factorStep,
        sectorReturn: factorStep.sectors.get(row.sector) ?? 0,
        residual: this.residuals.get(row.symbol) ?? 0,
        dtDays,
        rng,
      });
      this.residuals.set(row.symbol, stepResult.residual);
      const price = Math.max(round2(row.price * Math.exp(stepResult.logReturn)), 0.5);

      const volume =
        session.phase === 'regular'
          ? row.volume +
            Math.round(
              (row.avg_volume / MINUTES_PER_SESSION) *
                (this.intervalMs / 60_000) *
                randomBetween(rng, 0.5, 1.5),
            )
          : row.volume;

      return {
        symbol: row.symbol,
        price,
        dayHigh: round2(Math.max(row.day_high, price)),
        dayLow: round2(Math.min(row.day_low, price)),
        volume,
      };
    });

    await this.#writeQuotes(updates, now);

    if (session.phase === 'regular') {
      await this.#writeIntradayBars(updates, sessionDate, session.minutesIntoSession);
    }

    await this.#fillRestingOrders();

    this.tickCount += 1;
  }

  /**
   * Fill the limit orders this tick's prices have reached.
   *
   * Here rather than on a timer of its own, for two reasons that are both about
   * correctness. It has to run *after* the new quotes are written, or it matches
   * against the prices it was about to replace. And this method only runs on the
   * replica holding the writer lock, so exactly one process in the cluster matches —
   * two sweepers racing on one open order is how an instruction gets filled twice.
   *
   * The market must keep repricing whatever the book does, so a failure here is
   * logged and dropped. A tape that stopped because an order could not fill would
   * turn a contained problem into the one everybody sees.
   */
  async #fillRestingOrders() {
    try {
      const result = await sweepRestingOrders({
        // A fraction of the interval, not all of it. The tick still has to write ~500
        // quotes and a minute of bars, and a sweep allowed to consume the whole
        // interval guarantees the next firing is skipped — which would turn the
        // re-entrancy guard from a safety net into the normal path.
        budgetMs: Math.floor(this.intervalMs * SWEEP_BUDGET_FRACTION),
        cursor: this.sweepCursor,
      });

      // Null means the pass read the book to the end, so the next one starts from the
      // head. Carrying the old cursor forward instead would wedge the sweep at the
      // tail and it would never look at anything again.
      this.sweepCursor = result.cursor;

      if (result.filled > 0) {
        console.log(
          `[${config.serviceName}] filled ${result.filled} resting order(s) ` +
            `from ${result.considered} the tape had reached.`,
        );
      }
    } catch (error) {
      // The cursor is deliberately left where it was: a pass that threw did not
      // establish that it got anywhere, and resuming past orders it may never have
      // looked at would skip them until the next wrap.
      console.error(`[${config.serviceName}] resting order sweep failed:`, error.message);
    }
  }

  async #writeQuotes(updates, now) {
    const values = updates
      .map((_, i) => `($${i * 5 + 1}, $${i * 5 + 2}::numeric, $${i * 5 + 3}::numeric, $${i * 5 + 4}::numeric, $${i * 5 + 5}::bigint)`)
      .join(',');
    const params = updates.flatMap((u) => [u.symbol, u.price, u.dayHigh, u.dayLow, u.volume]);
    params.push(now.toISOString());

    await pool.query(
      `UPDATE quotes SET
         price = v.price, day_high = v.day_high, day_low = v.day_low,
         volume = v.volume, updated_at = $${params.length}
       FROM (VALUES ${values}) AS v(symbol, price, day_high, day_low, volume)
       WHERE quotes.symbol = v.symbol`,
      params,
    );
  }

  /**
   * The current minute's bar: inserted the first time we see that minute, then
   * extended by later ticks within the same minute.
   */
  async #writeIntradayBars(updates, sessionDate, minute) {
    const tuples = updates.map((_, i) => {
      const base = i * 4;
      return `($${base + 1}, $${base + 2}::date, $${base + 3}::smallint, $${base + 4}::numeric)`;
    });
    const params = updates.flatMap((u) => [u.symbol, sessionDate, minute, u.price]);

    await pool.query(
      `INSERT INTO intraday_bars (symbol, session_date, minute, open, high, low, close, volume)
       SELECT symbol, session_date, minute, price, price, price, price, 0
       FROM (VALUES ${tuples.join(',')}) AS v(symbol, session_date, minute, price)
       ON CONFLICT (symbol, session_date, minute) DO UPDATE SET
         high  = GREATEST(intraday_bars.high, EXCLUDED.close),
         low   = LEAST(intraday_bars.low, EXCLUDED.close),
         close = EXCLUDED.close`,
      params,
    );
  }

  get status() {
    const session = sessionState();
    return {
      phase: session.phase,
      isOpen: session.isOpen,
      label: session.label,
      tickIntervalMs: this.intervalMs,
      ticks: this.tickCount,
      // Firings that found the previous tick still running. Published rather than
      // left in the logs because it is the one number that says the writer is
      // outgrowing its interval, and it is otherwise invisible from outside.
      skippedTicks: this.skippedTicks,
      // Surfaced so it is obvious which replica is writing when several are up.
      writer: this.isLeader,
      simulated: true,
      startedAt: this.startedAt.toISOString(),
      asOf: new Date().toISOString(),
    };
  }
}

const marketTicker = new MarketTicker();

module.exports = { MarketTicker, marketTicker };
