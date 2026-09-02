/**
 * Pure price simulation. No database, no clock reads beyond what is passed in —
 * the seeder uses it to build history, and the tick loop uses it to advance the
 * live tape. Keeping it dependency-free is what makes a given MARKET_SEED
 * reproduce the same market every time.
 *
 * ## The model
 *
 * Independent geometric Brownian motions per symbol looked wrong the moment you
 * put two charts side by side: on a day the whole index should be red, half the
 * names were green. So returns are now a three-level factor model, which is the
 * standard way to say "these things move together, but not identically":
 *
 *     r(i,t) = alpha(i)·dt                    a small permanent per-name drift
 *            + marketBeta(i)  · m(t)          one common factor, everything loads on it
 *            + sectorBeta(i)  · s(sector,t)   what is left that only the sector shares
 *            + idioVol(i)·√dt·ε               the name's own noise
 *
 * `beta` from the stock table is what drives `marketBeta`, so it stopped
 * being decorative: a 1.5-beta semiconductor name really does swing half again as
 * hard as the market, and a 0.4-beta utility really does barely notice.
 *
 * Three things sit on top of that, each because its absence was visible:
 *
 * - **Volatility clustering.** A shared log-volatility follows an OU process, so
 *   the market has calm stretches and turbulent ones instead of the same
 *   amplitude every day. It scales the market, sector and idiosyncratic shocks
 *   together, which is what makes a turbulent week look turbulent everywhere.
 * - **Mean reversion.** Each factor and each name's residual is pulled back
 *   toward its trend. Weakly — the point is not to model reality, it is that a
 *   pure random walk over 270 sessions regularly produced a 6× or a 0.15× and
 *   the demo has to look like a stock chart every time, not most times.
 * - **Jumps.** Rare market-wide risk-off days, and per-name earnings gaps at
 *   roughly quarterly frequency. Without them every distribution was perfectly
 *   Gaussian and the charts had no personality.
 *
 * ## Determinism
 *
 * Same MARKET_SEED, same market — and adding or removing an stock still
 * perturbs nothing else. The factor paths are seeded from the market seed and the
 * session dates alone; they never touch the stock list. Each name's
 * idiosyncratic stream is seeded from its own ticker, exactly as before. So a
 * constituent change reprices that one name and leaves the other 502 byte-identical.
 *
 * Total variance is held at the stock's declared `volatility`: whatever the
 * factors claim, the idiosyncratic part is sized to make the sum come out right
 * (see `factorLoadings`).
 */
const { createRng, gaussian, hashString, randomBetween } = require('../lib/random.js');
const { REGULAR_SESSION_MINUTES } = require('./clock.js');

const TRADING_DAYS_PER_YEAR = 252;
const MINUTES_PER_SESSION = REGULAR_SESSION_MINUTES;

// --- factor model constants -------------------------------------------------
// Annualized. 15% is roughly a calm-to-normal index; individual names carry more.
const MARKET_FACTOR_VOL = 0.17;
// What a sector shares beyond the market. Small on purpose: sector dispersion is
// real but second-order next to the market move.
const SECTOR_FACTOR_VOL = 0.11;
const MARKET_DRIFT = 0.07;
// Reserve at least this share of a name's variance for its own noise, so no two
// names in a sector can end up moving in lockstep.
const IDIO_VARIANCE_FLOOR = 0.15;
// Spread of permanent per-name drift, annualized. This is what makes a 1Y screen
// show winners and losers rather than 500 copies of the index.
const ALPHA_SPREAD = 0.09;

// Log-volatility OU. `VOL_PERSISTENCE` is per trading day — 0.94 is an 11-session
// half-life, so a regime lasts a couple of weeks and is visible on a 3M chart.
//
// `LOG_VOL_SD` is the *stationary* standard deviation of log-volatility, not the
// per-step innovation: `volatilityPath` scales the innovation by √(1 − ρ²) so the
// two coincide whatever the step size. At 0.4 the market spends most of its time
// between 0.67× and 1.49× its average amplitude and occasionally doubles it, which
// puts the autocorrelation of |return| around 0.19 — the range real equity indices
// show, and enough that a turbulent fortnight is obvious on a chart.
const VOL_PERSISTENCE = 0.94;
const LOG_VOL_SD = 0.4;
const LOG_VOL_VARIANCE = LOG_VOL_SD ** 2;

// Mean reversion rates, per trading day. Half-life = ln 2 / rate.
const MARKET_REVERSION = 0.002; // ~170 sessions — only stops runaways
const SECTOR_REVERSION = 0.008; // ~46 sessions — sector rotation
const IDIO_REVERSION = 0.003; //  ~58 sessions

const MARKET_JUMP_PROB = 0.012; // ~3 risk-off days a year
const IDIO_JUMP_PROB = 1 / 63; // ~4 earnings gaps a year

const round2 = (value) => Math.round(value * 100) / 100;

const PRICE_FLOOR = 0.5;

/**
 * Intraday volatility is U-shaped: the open and the close are where the news and
 * the closing auction are. Normalized so the mean square over a session is 1,
 * which keeps a day's total variance equal to the flat-vol case.
 */
// sqrt(E[(0.65 + 1.75u²)²]) for u uniform on [-1,1] — closed form, not a guess.
const INTRADAY_VOL_SHAPE_NORM = Math.sqrt(0.65 ** 2 + (2 * 0.65 * 1.75) / 3 + 1.75 ** 2 / 5);
const intradayVolShape = (progress) =>
  (0.65 + 1.75 * (2 * progress - 1) ** 2) / INTRADAY_VOL_SHAPE_NORM;

/** Volume is U-shaped too, and heavier still on days that actually move. */
const intradayVolumeShape = (progress) => 0.6 + 1.8 * (2 * progress - 1) ** 2;

/**
 * How a single stock loads on the factors. Pure and deterministic from the
 * stock alone, so the seeder and the tick loop cannot disagree about it.
 *
 * The scale guard exists because `beta` and `volatility` are drawn independently:
 * a name declaring 16% vol and a beta of 1.2 would need more systematic variance
 * than it has variance. Rather than let realized volatility overshoot the number
 * the UI prints, the systematic loadings are shrunk until they fit the budget. It
 * fires on roughly a sixth of the universe — the low-volatility tail — and the
 * seeder stores the shrunk `marketBeta` back as the stock's `beta`, so the
 * beta shown on screen is always the beta the returns actually exhibit.
 */
function factorLoadings(stock) {
  const rng = createRng(hashString(`loadings:${stock.symbol}`));
  const sectorLoading = randomBetween(rng, 0.7, 1.3);
  const alpha = gaussian(rng) * ALPHA_SPREAD;

  const targetVar = stock.volatility ** 2;
  const systematicVar =
    stock.beta ** 2 * MARKET_FACTOR_VOL ** 2 + sectorLoading ** 2 * SECTOR_FACTOR_VOL ** 2;
  const budget = targetVar * (1 - IDIO_VARIANCE_FLOOR);
  const scale = systematicVar > budget ? Math.sqrt(budget / systematicVar) : 1;

  return {
    marketBeta: stock.beta * scale,
    sectorBeta: sectorLoading * scale,
    sectorLoading,
    idioVolatility: Math.sqrt(targetVar - systematicVar * scale ** 2),
    alpha,
  };
}

/**
 * The shared volatility regime: an OU process in log-volatility, sampled at
 * `steps` points `dtDays` apart, as a multiplier on every shock in the model.
 *
 * **Normalized to a root-mean-square of exactly 1 over the path it returns.**
 * That matters more than it sounds. Centring analytically on E[m²] = 1 is correct
 * in expectation, but the mean of a lognormal lives in its right tail, so any
 * *individual* 271-session path came out 15–25% quiet and every stock's
 * realized volatility landed below the number the UI prints next to it.
 * Normalizing the path keeps the clustering — the calm and turbulent stretches are
 * exactly as pronounced — while making "annualized volatility" a promise the data
 * keeps rather than a parameter that happens to be in the formula.
 *
 * The tick loop cannot do this (it has no future to normalize against) and uses
 * the analytic centring instead; over a few hours of tape the difference is not
 * observable.
 */
function volatilityPath(seed, steps, dtDays) {
  const rng = createRng(hashString('factor:volatility') ^ seed);
  // Exact OU discretization, so a 1-day step and 390 one-minute steps describe
  // the same process.
  const persistence = VOL_PERSISTENCE ** dtDays;
  const innovation = LOG_VOL_SD * Math.sqrt(1 - persistence ** 2);

  const path = new Array(steps);
  let logVol = 0;
  let sumSquares = 0;
  for (let i = 0; i < steps; i += 1) {
    logVol = persistence * logVol + innovation * gaussian(rng);
    path[i] = Math.exp(logVol);
    sumSquares += path[i] ** 2;
  }

  const rms = Math.sqrt(sumSquares / steps) || 1;
  for (let i = 0; i < steps; i += 1) path[i] /= rms;
  return path;
}

/**
 * The common factors, advanced one step at a time.
 *
 * One engine drives history (`dtDays = 1`), another drives the current session
 * (`dtDays = 1/390`), and the ticker keeps a third alive across ticks. All three
 * are the same code, because the difference between a day and two seconds is a
 * value of `dt` and nothing else.
 *
 * Levels are tracked as *deviations from trend*, which is what makes the mean
 * reversion term a one-liner: the pull is toward zero, and the trend is added
 * back on top.
 */
class FactorEngine {
  /**
   * @param {object} options
   * @param {number} options.seed         PRNG seed — the whole path follows from it
   * @param {string[]} options.sectors    sectors needing their own factor
   * @param {number} [options.driftAnnual]
   * @param {number} [options.volScale]   session-phase damping (see clock.js)
   */
  constructor({ seed, sectors, driftAnnual = MARKET_DRIFT, volScale = 1 }) {
    this.driftAnnual = driftAnnual;
    this.volScale = volScale;
    this.marketRng = createRng(hashString('factor:market') ^ seed);
    this.volRng = createRng(hashString('factor:volatility') ^ seed);
    this.marketDeviation = 0;
    this.logVol = 0;
    this.sectors = new Map(
      sectors.map((sector) => [
        sector,
        { rng: createRng(hashString(`factor:sector:${sector}`) ^ seed), deviation: 0 },
      ]),
    );
  }

  /**
   * Advance every factor by `dtDays` trading days.
   *
   * @param {number} dtDays
   * @param {number} [presetVolMultiplier] from `volatilityPath`, when the caller
   *   knows the whole path up front. Omitted, the engine walks its own log-vol
   *   process — which is what the tick loop has to do.
   * @returns {{ market: number, sectors: Map<string, number>, volMultiplier: number }}
   *   log returns for the step, and the shared volatility multiplier that
   *   idiosyncratic shocks must also be scaled by.
   */
  step(dtDays, presetVolMultiplier) {
    const dt = dtDays / TRADING_DAYS_PER_YEAR;
    const sqrtDt = Math.sqrt(dt);

    let volMultiplier;
    if (presetVolMultiplier === undefined) {
      const persistence = VOL_PERSISTENCE ** dtDays;
      this.logVol =
        persistence * this.logVol +
        LOG_VOL_SD * Math.sqrt(1 - persistence ** 2) * gaussian(this.volRng);
      // Centred so E[multiplier²] = 1 over the stationary distribution.
      volMultiplier = Math.exp(this.logVol - LOG_VOL_VARIANCE);
    } else {
      volMultiplier = presetVolMultiplier;
    }
    volMultiplier *= this.volScale;

    const drift = (this.driftAnnual - 0.5 * MARKET_FACTOR_VOL ** 2) * dt;
    const pull = -MARKET_REVERSION * dtDays * this.marketDeviation;
    let shock = MARKET_FACTOR_VOL * volMultiplier * sqrtDt * gaussian(this.marketRng);
    // Jump *frequency* scales with the session phase, not jump size. Damping the
    // size would make overnight news a gentle drift, which is backwards; damping
    // how often it arrives keeps the quiet hours quiet without making the shocks
    // that do land look wrong next to the diffusion around them.
    if (this.marketRng() < MARKET_JUMP_PROB * dtDays * this.volScale) {
      // Risk-off is faster than risk-on: two thirds of the jumps are down.
      const direction = this.marketRng() < 0.66 ? -1 : 1;
      shock += direction * (0.008 + Math.abs(gaussian(this.marketRng)) * 0.018);
    }
    this.marketDeviation += pull + shock;
    const market = drift + pull + shock;

    const sectors = new Map();
    for (const [name, state] of this.sectors) {
      const sectorPull = -SECTOR_REVERSION * dtDays * state.deviation;
      const sectorShock = SECTOR_FACTOR_VOL * volMultiplier * sqrtDt * gaussian(state.rng);
      state.deviation += sectorPull + sectorShock;
      sectors.set(name, sectorPull + sectorShock);
    }

    return { market, sectors, volMultiplier, volScale: this.volScale };
  }
}

/**
 * One step of a single name, given the factor step it happens inside.
 *
 * `residual` is the name's own accumulated deviation, carried by the caller: it
 * is what mean-reverts, and it is the only per-symbol state the model needs.
 *
 * @returns {{ logReturn: number, residual: number }}
 */
function stockStep({
  loadings,
  factorStep,
  sectorReturn,
  residual,
  dtDays,
  rng,
  volShape = 1,
}) {
  const dt = dtDays / TRADING_DAYS_PER_YEAR;
  const { idioVolatility, marketBeta, sectorBeta, alpha } = loadings;

  const pull = -IDIO_REVERSION * dtDays * residual;
  let idioShock =
    idioVolatility *
    factorStep.volMultiplier *
    volShape *
    Math.sqrt(dt) *
    gaussian(rng);

  // Earnings-style gap: sized against the name's own volatility so a utility
  // gapping 9% never happens. Like the market's jumps, the session phase changes
  // how often one lands, not how big it is.
  if (rng() < IDIO_JUMP_PROB * dtDays * (factorStep.volScale ?? 1)) {
    idioShock += gaussian(rng) * 0.055 * (idioVolatility / 0.3);
  }

  const logReturn =
    (alpha - 0.5 * idioVolatility ** 2) * dt +
    marketBeta * factorStep.market +
    sectorBeta * sectorReturn +
    pull +
    idioShock;

  return { logReturn, residual: residual + pull + idioShock };
}

/** Weekday sessions ending at `endDate`, oldest first, as YYYY-MM-DD strings. */
function tradingSessionDates(endDate, calendarDays) {
  const dates = [];
  for (let i = calendarDays - 1; i >= 0; i -= 1) {
    const date = new Date(endDate);
    date.setUTCDate(date.getUTCDate() - i);
    const weekday = date.getUTCDay();
    if (weekday === 0 || weekday === 6) continue;
    dates.push(date.toISOString().slice(0, 10));
  }
  return dates;
}

/**
 * The whole history of common factors, precomputed once for the seeder.
 *
 * Materializing it costs 11 sectors × ~270 sessions of numbers and lets all 503
 * stocks be generated against the identical path — which is the entire point
 * of a factor model, and also why the seeder can still generate one stock at
 * a time without holding the universe in memory.
 */
function buildFactorHistory(marketSeed, sessions, sectors) {
  const engine = new FactorEngine({ seed: marketSeed, sectors });
  const volMultiplier = volatilityPath(marketSeed, sessions.length, 1);
  const market = new Array(sessions.length);
  const bySector = new Map(sectors.map((sector) => [sector, new Array(sessions.length)]));

  for (let i = 0; i < sessions.length; i += 1) {
    const step = engine.step(1, volMultiplier[i]);
    market[i] = step.market;
    for (const [sector, value] of step.sectors) bySector.get(sector)[i] = value;
  }

  return { sessions, market, sectors: bySector, volMultiplier };
}

/**
 * Daily OHLC bars for one stock over the sessions the factor history covers.
 *
 * @param {object} stock
 * @param {object} loadings   from `factorLoadings`
 * @param {object} factors    from `buildFactorHistory`
 * @param {Function} rng      the stock's own stream
 */
function buildDailyBars(stock, loadings, factors, rng) {
  const bars = new Array(factors.sessions.length);
  const sectorPath = factors.sectors.get(stock.sector);
  let close = stock.basePrice;
  let residual = 0;

  for (let i = 0; i < factors.sessions.length; i += 1) {
    const open = close;
    const stepResult = stockStep({
      loadings,
      factorStep: { market: factors.market[i], volMultiplier: factors.volMultiplier[i] },
      sectorReturn: sectorPath[i],
      residual,
      dtDays: 1,
      rng,
    });
    residual = stepResult.residual;
    close = Math.max(open * Math.exp(stepResult.logReturn), PRICE_FLOOR);

    // Wicks scale with the day's realized move, so a quiet day gets a small
    // range and a gap day gets a wide one.
    const move = Math.abs(close - open);
    const wick = (move + open * stock.volatility * 0.004) * Math.abs(gaussian(rng)) * 0.6;
    // Turnover follows conviction: heavy days trade more.
    const activity = 1 + 6 * Math.abs(stepResult.logReturn);

    bars[i] = {
      date: factors.sessions[i],
      open: round2(open),
      high: round2(Math.max(open, close) + wick),
      low: round2(Math.max(Math.min(open, close) - wick, PRICE_FLOOR)),
      close: round2(close),
      volume: Math.round(stock.avgVolume * activity * randomBetween(rng, 0.55, 1.65)),
    };
  }

  return bars;
}

/**
 * The current session's common factors, plus the overnight gap.
 *
 * Seeded from the session date so today's path is stable across a re-seed, and
 * independent of how much history preceded it.
 */
function buildIntradayFactors(marketSeed, sessionDate, minutes, sectors) {
  const seed = marketSeed ^ hashString(`intraday:${sessionDate}`);
  const engine = new FactorEngine({ seed, sectors });
  const gapRng = createRng(hashString(`gap:${sessionDate}`) ^ marketSeed);

  // Overnight news arrives as a gap, not as a drift: the market and each sector
  // reopen somewhere other than where they closed.
  const marketGap = gaussian(gapRng) * MARKET_FACTOR_VOL * 0.035;
  const sectorGaps = new Map(
    sectors.map((sector) => [sector, gaussian(gapRng) * SECTOR_FACTOR_VOL * 0.04]),
  );

  const regime = volatilityPath(seed, minutes, 1 / MINUTES_PER_SESSION);
  const market = new Array(minutes);
  const bySector = new Map(sectors.map((sector) => [sector, new Array(minutes)]));
  const volMultiplier = new Array(minutes);

  for (let i = 0; i < minutes; i += 1) {
    // The U-shape rides on top of the regime: both are just multipliers on the
    // same shocks, so they compose.
    const shaped = regime[i] * intradayVolShape(i / MINUTES_PER_SESSION);
    const step = engine.step(1 / MINUTES_PER_SESSION, shaped);
    market[i] = step.market;
    volMultiplier[i] = step.volMultiplier;
    for (const [sector, value] of step.sectors) bySector.get(sector)[i] = value;
  }

  return { minutes, market, sectors: bySector, volMultiplier, marketGap, sectorGaps };
}

/** The current session's 1-minute bars, from the open through `factors.minutes`. */
function buildIntradayBars(stock, loadings, previousClose, factors, rng) {
  const sectorPath = factors.sectors.get(stock.sector);
  const sectorGap = factors.sectorGaps.get(stock.sector) ?? 0;

  // The gap is the factor model applied to a single instantaneous move: the name
  // follows the market and its sector, plus its own overnight surprise.
  const gap =
    loadings.marketBeta * factors.marketGap +
    loadings.sectorBeta * sectorGap +
    gaussian(rng) * loadings.idioVolatility * 0.05;

  let price = Math.max(previousClose * Math.exp(gap), PRICE_FLOOR);
  const open = price;
  let residual = 0;
  const bars = new Array(factors.minutes);

  for (let minute = 0; minute < factors.minutes; minute += 1) {
    const barOpen = price;
    const progress = minute / MINUTES_PER_SESSION;
    const stepResult = stockStep({
      loadings,
      factorStep: { market: factors.market[minute], volMultiplier: factors.volMultiplier[minute] },
      sectorReturn: sectorPath[minute],
      residual,
      dtDays: 1 / MINUTES_PER_SESSION,
      rng,
      volShape: 1, // already folded into volMultiplier above
    });
    residual = stepResult.residual;
    price = Math.max(barOpen * Math.exp(stepResult.logReturn), PRICE_FLOOR);

    const wick = Math.abs(gaussian(rng)) * Math.abs(price - barOpen) * 0.8;
    bars[minute] = {
      minute,
      open: round2(barOpen),
      high: round2(Math.max(barOpen, price) + wick),
      low: round2(Math.max(Math.min(barOpen, price) - wick, PRICE_FLOOR)),
      close: round2(price),
      volume: Math.round(
        (stock.avgVolume / MINUTES_PER_SESSION) *
          intradayVolumeShape(progress) *
          randomBetween(rng, 0.6, 1.4),
      ),
    };
  }

  return { bars, open: round2(open), price: round2(price) };
}

/** Minute 0 is 09:30 ET; render as an ET wall-clock label. */
function minuteLabel(minute) {
  const total = 9 * 60 + 30 + minute;
  const hours = Math.floor(total / 60);
  return `${String(hours).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

module.exports = {
  factorLoadings,
  volatilityPath,
  FactorEngine,
  stockStep,
  tradingSessionDates,
  buildFactorHistory,
  buildDailyBars,
  buildIntradayFactors,
  buildIntradayBars,
  minuteLabel,
  MINUTES_PER_SESSION,
  round2,
};
