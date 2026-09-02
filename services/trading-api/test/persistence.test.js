/**
 * Tests for the properties the database was introduced to provide: data outlives
 * the process, seeding is safe to re-run, and only one replica writes the tape.
 */
const assert = require('node:assert/strict');
const { after, before, describe, it } = require('node:test');

const {
  baseUrlForMessages,
  createTestDatabase,
  databaseIsReachable,
  dropTestDatabase,
} = require('./helpers/database.js');

let testDb;
let db;
let seedModule;
let MarketTicker;

/** Polls `predicate` until it is true or the budget runs out. */
async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return predicate();
}

before(async () => {
  if (!(await databaseIsReachable())) {
    throw new Error(`No Postgres at ${baseUrlForMessages()}. Start one with \`make db-up\`.`);
  }

  testDb = await createTestDatabase();

  const { migrate } = require('../src/db/migrate.js');
  db = require('../src/db/pool.js');
  seedModule = require('../src/db/seed.js');
  ({ MarketTicker } = require('../src/market/ticker.js'));

  await migrate();
  await seedModule.seed({ reset: false, force: true, quiet: true, accounts: [], marketSeed: 4242 });
});

after(async () => {
  await db?.closePool();
  if (testDb) await dropTestDatabase(testDb.name);
});

describe('seeding', () => {
  it('populates the full universe', async () => {
    const counts = await db.query(`
      SELECT (SELECT count(*) FROM stocks)   AS stocks,
             (SELECT count(*) FROM daily_bars)    AS daily,
             (SELECT count(*) FROM intraday_bars) AS intraday,
             (SELECT count(*) FROM quotes)        AS quotes
    `);
    const row = counts.rows[0];
    const { STOCKS } = require('../src/data/stocks.js');
    assert.equal(row.stocks, STOCKS.length);
    assert.equal(row.quotes, STOCKS.length);
    assert.ok(row.daily > 130_000, `expected a year of daily bars per name, got ${row.daily}`);
    assert.ok(row.intraday > 0);
  });

  it('stores the factor loadings the tick loop reads', async () => {
    // The seeder derives these and the ticker reads them back; a null column here
    // would silently drop a name out of the factor model.
    const { rows } = await db.query(
      `SELECT count(*)::int AS n FROM stocks
       WHERE industry IS NULL OR sector_loading IS NULL
          OR idio_volatility IS NULL OR drift_annual IS NULL
          OR idio_volatility <= 0 OR beta <= 0`,
    );
    assert.equal(rows[0].n, 0);
  });

  it('is safe to run again without --force', async () => {
    const before = await db.query('SELECT symbol, price FROM quotes ORDER BY symbol');
    await seedModule.seed({ reset: false, force: false, quiet: true, accounts: [], marketSeed: 4242 });
    const after = await db.query('SELECT symbol, price FROM quotes ORDER BY symbol');
    assert.deepEqual(after.rows, before.rows, 're-seeding without --force must not change data');
  });

  it('gives every quote a coherent day range', async () => {
    const { rows } = await db.query(
      `SELECT symbol FROM quotes
       WHERE price <= 0 OR day_low > price OR day_high < price OR previous_close <= 0`,
    );
    assert.deepEqual(rows, [], 'every quote should sit inside its own day range');
  });

  it('predicts a portfolio\'s symbols without reading any price history', async () => {
    // `seedAccount` uses this to fetch bars for 5–9 symbols instead of all 503.
    // If the two ever draw differently the portfolio silently loses positions, so
    // the pair is pinned here rather than trusted.
    const { generatePortfolio, selectPortfolioSymbols } = await import(
      '../src/portfolio/generator.js'
    );
    const { rows } = await db.query(
      'SELECT symbol, session_date, close FROM daily_bars ORDER BY symbol, session_date',
    );
    const bars = new Map();
    for (const row of rows) {
      if (!bars.has(row.symbol)) bars.set(row.symbol, []);
      bars.get(row.symbol).push({ date: row.session_date, close: row.close });
    }

    for (const username of ['a.okafor', 'dan', 'someone.new']) {
      const predicted = selectPortfolioSymbols(username);
      const generated = generatePortfolio(username, bars).positions.map((p) => p.symbol);
      assert.deepEqual(generated, predicted, `${username}: selection and generation must agree`);
      assert.ok(predicted.length >= 5 && predicted.length <= 9);
    }
  });

  it('creates an account with lots that back its cost basis', async () => {
    const result = await seedModule.seedAccount('persistence.tester');
    assert.equal(result.created, true);

    const { rows } = await db.query(
      `SELECT a.username, count(DISTINCT p.id)::int AS positions, count(l.id)::int AS lots
       FROM accounts a
       JOIN positions p ON p.account_id = a.id
       JOIN lots l      ON l.position_id = p.id
       WHERE a.username_key = 'persistence.tester'
       GROUP BY a.username`,
    );
    assert.equal(rows.length, 1);
    assert.ok(rows[0].positions >= 5);
    assert.ok(rows[0].lots >= rows[0].positions, 'every position has at least one lot');

    // Second call must not duplicate anything.
    const repeat = await seedModule.seedAccount('persistence.tester');
    assert.equal(repeat.created, false);
    const { rows: after } = await db.query(
      `SELECT count(*)::int AS n FROM positions p
       JOIN accounts a ON a.id = p.account_id WHERE a.username_key = 'persistence.tester'`,
    );
    assert.equal(after[0].n, rows[0].positions);
  });
});

describe('market writer election', () => {
  it('lets exactly one ticker hold the lock at a time', async () => {
    const first = new MarketTicker({ intervalMs: 60_000 });
    const second = new MarketTicker({ intervalMs: 60_000 });

    try {
      assert.equal(await first.start(), true, 'the first ticker should become the writer');
      assert.equal(await second.start(), false, 'the second must not also become the writer');
      assert.equal(first.isLeader, true);
      assert.equal(second.isLeader, false);

      // Once the leader steps down, the lock is available again.
      await first.stop();
      assert.equal(await second.start(), true, 'the second takes over after the first releases');
    } finally {
      await first.stop();
      await second.stop();
    }
  });

  it('promotes a follower automatically when the leader goes away', async () => {
    const leader = new MarketTicker({ intervalMs: 60_000 });
    // Poll fast so the test does not sit around waiting for the default interval.
    const follower = new MarketTicker({ intervalMs: 60_000, electionIntervalMs: 50 });

    try {
      assert.equal(await leader.start(), true);
      assert.equal(await follower.start(), false, 'follower starts read-only');

      // Nothing restarts the follower — it must notice the vacancy on its own.
      await leader.stop();

      const promoted = await waitFor(() => follower.isLeader, 3000);
      assert.ok(promoted, 'the follower should take over without being restarted');
    } finally {
      await leader.stop();
      await follower.stop();
    }
  });

  it('moves prices and records them', async () => {
    const ticker = new MarketTicker({ intervalMs: 60_000 });
    try {
      assert.equal(await ticker.start(), true);

      const before = await db.query('SELECT symbol, price FROM quotes ORDER BY symbol');
      await ticker.tick();
      const after = await db.query('SELECT symbol, price FROM quotes ORDER BY symbol');

      const moved = after.rows.filter((row, i) => row.price !== before.rows[i].price);
      assert.ok(moved.length > 0, 'a tick should reprice at least some stocks');
      assert.ok(
        after.rows.every((row) => row.price > 0),
        'no tick may produce a non-positive price',
      );
    } finally {
      await ticker.stop();
    }
  });

  it('drives the live tape through the same factor model as the history', async () => {
    // `dtDays = intervalMs / one session`, so a full-session interval makes each
    // tick one trading day and 60 of them a quarter of tape. Anything shorter and
    // the common factor is smaller than the rounding to the cent.
    const ticker = new MarketTicker({ intervalMs: 390 * 60_000 });
    // A fixed mid-session timestamp, not `new Date()`: outside regular hours the
    // clock damps volatility to 12% and this would measure a whisper.
    const midSession = new Date('2026-08-05T15:00:00Z'); // 11:00 ET, a Wednesday
    const TICKS = 60;

    try {
      assert.equal(await ticker.start(), true);

      const prices = async () => {
        const { rows } = await db.query('SELECT symbol, price FROM quotes ORDER BY symbol');
        return rows.map((row) => row.price);
      };
      const { rows: reference } = await db.query('SELECT symbol, beta FROM stocks ORDER BY symbol');
      const betas = reference.map((row) => Number(row.beta));

      // Per-tick returns for every name, so the assertions below are regressions
      // over 60 observations rather than one net move that could land anywhere.
      const returns = betas.map(() => []);
      const boardMoves = [];
      let previous = await prices();
      for (let i = 0; i < TICKS; i += 1) {
        await ticker.tick(midSession);
        const current = await prices();
        let sum = 0;
        for (let k = 0; k < current.length; k += 1) {
          const r = Math.log(current[k] / previous[k]);
          returns[k].push(r);
          sum += r;
        }
        boardMoves.push(sum / current.length);
        previous = current;
      }

      assert.ok(previous.every((price) => price > 0), 'the tape may never go non-positive');

      const mean = (v) => v.reduce((t, x) => t + x, 0) / v.length;
      const rms = (v) => Math.sqrt(v.reduce((t, x) => t + x ** 2, 0) / v.length);

      // The board has to move *together*. With 503 independent walks the
      // cross-sectional average return would be ~1/√503 of one name's amplitude;
      // a common factor puts it in the same order of magnitude. Comparing sizes
      // rather than signs keeps this off which way the market happened to go.
      const nameAmplitude = mean(returns.map(rms));
      assert.ok(
        rms(boardMoves) > nameAmplitude / 4,
        `board ${rms(boardMoves).toFixed(5)} vs per-name ${nameAmplitude.toFixed(5)} — no common factor`,
      );

      // And beta has to be what scales it: regress each name on the board.
      const boardMean = mean(boardMoves);
      const boardVar = mean(boardMoves.map((m) => (m - boardMean) ** 2));
      const slopes = returns.map((series) => {
        const seriesMean = mean(series);
        const cov = mean(series.map((r, i) => (r - seriesMean) * (boardMoves[i] - boardMean)));
        return cov / boardVar;
      });
      const byBeta = slopes.map((slope, k) => ({ slope, beta: betas[k] })).sort((a, b) => a.beta - b.beta);
      const low = mean(byBeta.slice(0, 160).map((r) => r.slope));
      const high = mean(byBeta.slice(-160).map((r) => r.slope));
      assert.ok(
        high > low + 0.3,
        `high-beta names track the board at ${high.toFixed(2)}, low-beta at ${low.toFixed(2)}`,
      );
    } finally {
      await ticker.stop();
    }
  });
});

describe('durability', () => {
  it('keeps portfolios after the pool is torn down and rebuilt', async () => {
    const { rows: before } = await db.query(
      `SELECT a.id, a.cash, count(l.id)::int AS lots
       FROM accounts a
       JOIN positions p ON p.account_id = a.id
       JOIN lots l ON l.position_id = p.id
       WHERE a.username_key = 'persistence.tester' GROUP BY a.id, a.cash`,
    );
    assert.equal(before.length, 1);

    // A fresh client stands in for a restarted process reading the same database.
    const pg = require('pg');
    const client = new pg.Client({ connectionString: testDb.url });
    await client.connect();
    const { rows: after } = await client.query(
      `SELECT a.id, count(l.id)::int AS lots
       FROM accounts a
       JOIN positions p ON p.account_id = a.id
       JOIN lots l ON l.position_id = p.id
       WHERE a.username_key = 'persistence.tester' GROUP BY a.id`,
    );
    await client.end();

    assert.equal(after.length, 1);
    assert.equal(after[0].id, before[0].id);
    assert.equal(after[0].lots, before[0].lots);
  });
});
