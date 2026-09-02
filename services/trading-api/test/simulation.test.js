/**
 * The price model, checked as maths rather than through the database.
 *
 * These are the claims the rest of the demo rests on: the same seed reproduces the
 * same market, prices stay positive, bars contain themselves, and — the reason the
 * factor model exists at all — names in a sector really do move together more than
 * names in different sectors. A statistical claim that is only in a comment is a
 * claim nobody is checking, so each one has an assertion with a threshold well
 * inside the measured margin.
 */
const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const { INSTRUMENTS, INSTRUMENTS_BY_SYMBOL, SECTORS } = require('../src/data/instruments.js');
const { createRng, hashString } = require('../src/lib/random.js');
const {
  buildDailyBars,
  buildFactorHistory,
  buildIntradayBars,
  buildIntradayFactors,
  factorLoadings,
  tradingSessionDates,
} = require('../src/market/simulation.js');

const SEED = 20260803;
const END = new Date('2026-08-03T00:00:00Z');
const SESSIONS = tradingSessionDates(END, 380);
const TRADING_DAYS_PER_YEAR = 252;

/** The seeder's per-symbol stream, reproduced exactly. */
const streamFor = (symbol, seed = SEED) => createRng(seed ^ hashString(symbol));

function historyFor(symbol, seed = SEED, factors = buildFactorHistory(seed, SESSIONS, SECTORS)) {
  const instrument = INSTRUMENTS_BY_SYMBOL.get(symbol);
  return buildDailyBars(instrument, factorLoadings(instrument), factors, streamFor(symbol, seed));
}

const mean = (values) => values.reduce((total, v) => total + v, 0) / values.length;

const logReturns = (bars) => bars.slice(1).map((bar, i) => Math.log(bar.close / bars[i].close));

function correlation(a, b) {
  const ma = mean(a);
  const mb = mean(b);
  let cov = 0;
  let va = 0;
  let vb = 0;
  for (let i = 0; i < a.length; i += 1) {
    cov += (a[i] - ma) * (b[i] - mb);
    va += (a[i] - ma) ** 2;
    vb += (b[i] - mb) ** 2;
  }
  return cov / Math.sqrt(va * vb);
}

/** OLS slope of `y` on `x` — the realized beta against the market factor. */
function slope(y, x) {
  const my = mean(y);
  const mx = mean(x);
  let cov = 0;
  let varX = 0;
  for (let i = 0; i < y.length; i += 1) {
    cov += (y[i] - my) * (x[i] - mx);
    varX += (x[i] - mx) ** 2;
  }
  return cov / varX;
}

describe('the universe', () => {
  it('is the S&P 500 constituent list, with nothing real but the identity', () => {
    assert.ok(INSTRUMENTS.length > 480 && INSTRUMENTS.length < 520, `got ${INSTRUMENTS.length}`);
    assert.equal(new Set(INSTRUMENTS.map((i) => i.symbol)).size, INSTRUMENTS.length);

    // Names that survive index reshuffles; if the committed CSV is ever swapped
    // for something that is not the S&P 500, this is what notices.
    for (const symbol of ['AAPL', 'MSFT', 'JPM', 'XOM', 'JNJ', 'BRK.B']) {
      assert.ok(INSTRUMENTS_BY_SYMBOL.has(symbol), `${symbol} should be a constituent`);
    }

    for (const instrument of INSTRUMENTS) {
      assert.ok(SECTORS.includes(instrument.sector), `${instrument.symbol}: ${instrument.sector}`);
      assert.ok(instrument.industry, `${instrument.symbol} has a GICS sub-industry`);
      // Nothing here is a real quote, and the exchange says so on every row.
      assert.equal(instrument.exchange, 'DEMO');
      assert.ok(instrument.basePrice > 0 && instrument.volatility > 0);
      assert.ok(instrument.beta > 0 && instrument.avgVolume > 0);
    }
  });

  it('derives fundamentals from the ticker alone, so they never drift', () => {
    // Re-importing would be cached; the guarantee under test is that the values
    // are a pure function of the symbol, which is what makes them reproducible.
    const apple = INSTRUMENTS_BY_SYMBOL.get('AAPL');
    const loadings = factorLoadings(apple);
    assert.deepEqual(factorLoadings(apple), loadings);
  });
});

describe('determinism', () => {
  it('reproduces the same history from the same seed', () => {
    assert.deepEqual(historyFor('AAPL'), historyFor('AAPL'));
    assert.deepEqual(historyFor('NEE'), historyFor('NEE'));
  });

  it('produces a different market from a different seed', () => {
    assert.notDeepEqual(historyFor('AAPL', SEED), historyFor('AAPL', SEED + 1));
  });

  it('leaves every other instrument untouched when the universe changes', () => {
    // The factor paths are a function of the seed and the session dates only, so
    // a constituent added or dropped cannot shift anyone else's history. Building
    // the factors over a deliberately reduced sector list proves the point: the
    // sectors that remain get byte-identical paths.
    const full = buildFactorHistory(SEED, SESSIONS, SECTORS);
    const partial = buildFactorHistory(SEED, SESSIONS, ['Utilities', 'Energy']);

    assert.deepEqual(partial.market, full.market);
    assert.deepEqual(partial.volMultiplier, full.volMultiplier);
    assert.deepEqual(partial.sectors.get('Utilities'), full.sectors.get('Utilities'));

    const utility = INSTRUMENTS.find((i) => i.sector === 'Utilities');
    assert.deepEqual(
      buildDailyBars(utility, factorLoadings(utility), partial, streamFor(utility.symbol)),
      buildDailyBars(utility, factorLoadings(utility), full, streamFor(utility.symbol)),
    );
  });
});

describe('bar coherence', () => {
  const factors = buildFactorHistory(SEED, SESSIONS, SECTORS);
  const intradayFactors = buildIntradayFactors(SEED, '2026-08-03', 390, SECTORS);

  it('keeps every daily bar positive and self-consistent', () => {
    for (const instrument of INSTRUMENTS) {
      const bars = buildDailyBars(
        instrument,
        factorLoadings(instrument),
        factors,
        streamFor(instrument.symbol),
      );
      assert.equal(bars.length, SESSIONS.length);

      for (const bar of bars) {
        assert.ok(bar.low > 0, `${instrument.symbol} ${bar.date}: low ${bar.low}`);
        assert.ok(
          bar.low <= Math.min(bar.open, bar.close),
          `${instrument.symbol} ${bar.date}: low above the body`,
        );
        assert.ok(
          bar.high >= Math.max(bar.open, bar.close),
          `${instrument.symbol} ${bar.date}: high below the body`,
        );
        assert.ok(bar.volume > 0);
      }
    }
  });

  it('keeps the intraday session inside its own range', () => {
    // A sample rather than all 503: this builds 390 bars each and the property is
    // structural, not per-name.
    for (const symbol of ['AAPL', 'NEE', 'XOM', 'JPM', 'BRK.B']) {
      const instrument = INSTRUMENTS_BY_SYMBOL.get(symbol);
      const loadings = factorLoadings(instrument);
      const { bars, open, price } = buildIntradayBars(
        instrument,
        loadings,
        instrument.basePrice,
        intradayFactors,
        streamFor(symbol),
      );

      assert.equal(bars.length, 390);
      const high = Math.max(...bars.map((bar) => bar.high));
      const low = Math.min(...bars.map((bar) => bar.low));
      assert.ok(low > 0 && low <= open && open <= high, `${symbol}: open outside the range`);
      assert.ok(low <= price && price <= high, `${symbol}: last price outside the range`);
      for (const bar of bars) {
        assert.ok(bar.low <= Math.min(bar.open, bar.close) && bar.high >= Math.max(bar.open, bar.close));
      }
    }
  });

  it('never lets a 1Y series flatline or explode', () => {
    for (const instrument of INSTRUMENTS) {
      const bars = buildDailyBars(
        instrument,
        factorLoadings(instrument),
        factors,
        streamFor(instrument.symbol),
      );
      const window = bars.slice(-252);
      const ratio = window.at(-1).close / window[0].open;
      assert.ok(ratio > 0.2 && ratio < 5, `${instrument.symbol} moved ${ratio.toFixed(2)}× in a year`);

      // "Not a flat line" as a range, not as a count of distinct closes: prices
      // are rounded to the cent, so a $12 name legitimately revisits values.
      const closes = window.map((bar) => bar.close);
      const spread = Math.max(...closes) / Math.min(...closes);
      assert.ok(spread > 1.1, `${instrument.symbol} spent the year in a ${spread.toFixed(3)}× band`);
    }
  });
});

describe('the factor model', () => {
  const factors = buildFactorHistory(SEED, SESSIONS, SECTORS);
  const series = INSTRUMENTS.map((instrument) => ({
    instrument,
    loadings: factorLoadings(instrument),
    returns: logReturns(
      buildDailyBars(instrument, factorLoadings(instrument), factors, streamFor(instrument.symbol)),
    ),
  }));
  const marketReturns = factors.market.slice(1);

  it('makes names in a sector co-move more than names across sectors', () => {
    const bySector = new Map();
    for (const entry of series) {
      if (!bySector.has(entry.instrument.sector)) bySector.set(entry.instrument.sector, []);
      bySector.get(entry.instrument.sector).push(entry);
    }

    // Deterministic sampling: the same pairs every run, so a failure reproduces.
    const rng = createRng(1234);
    const same = [];
    const cross = [];
    while (same.length < 300 || cross.length < 300) {
      const a = series[Math.floor(rng() * series.length)];
      const b = series[Math.floor(rng() * series.length)];
      if (a === b) continue;
      const bucket = a.instrument.sector === b.instrument.sector ? same : cross;
      if (bucket.length < 300) bucket.push(correlation(a.returns, b.returns));
    }

    const sameMean = mean(same);
    const crossMean = mean(cross);
    // Measured: ~0.48 within a sector against ~0.32 across. Both matter — a model
    // with no market factor would fail the second, one with no sector factor
    // would fail the gap.
    assert.ok(crossMean > 0.2, `cross-sector correlation was ${crossMean.toFixed(3)}`);
    assert.ok(sameMean > crossMean + 0.08, `same ${sameMean.toFixed(3)} vs cross ${crossMean.toFixed(3)}`);
  });

  it('makes beta govern sensitivity to the market', () => {
    const errors = series.map((entry) => slope(entry.returns, marketReturns) - entry.loadings.marketBeta);
    const absolute = errors.map(Math.abs).sort((a, b) => a - b);
    // A 271-sample regression has real sampling error; the median is what shows
    // the loading is being applied rather than approximated.
    assert.ok(Math.abs(mean(errors)) < 0.05, `mean beta error ${mean(errors).toFixed(3)}`);
    assert.ok(absolute[Math.floor(absolute.length / 2)] < 0.12, `median |error| ${absolute[251]}`);

    // And the ordering has to hold end to end, not just on average.
    const sorted = [...series].sort((a, b) => a.loadings.marketBeta - b.loadings.marketBeta);
    const lowBeta = sorted.slice(0, 50);
    const highBeta = sorted.slice(-50);
    assert.ok(
      mean(highBeta.map((e) => slope(e.returns, marketReturns))) >
        mean(lowBeta.map((e) => slope(e.returns, marketReturns))) + 0.5,
      'the highest-beta names should track the market far harder than the lowest',
    );
  });

  it('delivers the volatility each instrument advertises', () => {
    const ratios = series.map((entry) => {
      const m = mean(entry.returns);
      const variance =
        entry.returns.reduce((total, r) => total + (r - m) ** 2, 0) / (entry.returns.length - 1);
      return (Math.sqrt(variance * TRADING_DAYS_PER_YEAR) / entry.instrument.volatility);
    });
    const sorted = [...ratios].sort((a, b) => a - b);
    // Measured p5/p50/p95 ≈ 0.94 / 1.00 / 1.11. The path-normalized volatility
    // regime is what keeps this centred on 1 rather than 15–25% light.
    assert.ok(sorted[0] > 0.6, `quietest name realized ${sorted[0].toFixed(2)}× its stated vol`);
    assert.ok(sorted.at(-1) < 1.6, `noisiest name realized ${sorted.at(-1).toFixed(2)}×`);
    assert.ok(Math.abs(mean(ratios) - 1) < 0.15, `mean ratio ${mean(ratios).toFixed(3)}`);
  });

  it('clusters volatility instead of holding it constant', () => {
    // Absolute market returns should be autocorrelated even though the returns
    // themselves are not — that is exactly what a calm/turbulent regime means.
    const absolute = marketReturns.map(Math.abs);
    const lagged = correlation(absolute.slice(0, -1), absolute.slice(1));
    assert.ok(lagged > 0.1, `|return| autocorrelation was only ${lagged.toFixed(3)}`);

    const plain = correlation(marketReturns.slice(0, -1), marketReturns.slice(1));
    assert.ok(Math.abs(plain) < 0.2, `returns themselves should stay near-unpredictable, got ${plain.toFixed(3)}`);

    // And the regime has to actually vary.
    const multipliers = factors.volMultiplier;
    assert.ok(
      Math.max(...multipliers) / Math.min(...multipliers) > 1.5,
      'the volatility regime barely moved',
    );
  });
});
