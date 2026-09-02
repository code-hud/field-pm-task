/**
 * The tradable universe for the demo: the real S&P 500 constituent list.
 *
 * ## What is real and what is not
 *
 * Exactly four fields come from the outside world — `symbol`, `name`, `sector`,
 * and `industry`. They are the S&P 500 membership list, which is public reference
 * data, not market data. **Every number below is invented.** Base prices,
 * volatility, volumes, market caps, betas, P/E ratios and dividend yields are all
 * derived from a hash of the ticker through the same seeded PRNG that drives the
 * price simulation. None of them was ever a real quote or a real fundamental.
 *
 * That trade is deliberate. Recognisable tickers make the demo legible in a way
 * that invented issuers never did — a viewer knows what a utility is supposed to
 * look like next to a semiconductor company. The cost is that the app now shows
 * real companies at fictional prices, so the fiction has to be stated loudly
 * rather than assumed: `exchange` is `DEMO` on every row, the API says
 * `simulated: true`, the web client carries a standing banner, and the READMEs
 * say so. If you find a place that implies these prices are real, that is a bug.
 *
 * ## Provenance of the list
 *
 * `sp500-constituents.csv` is a verbatim copy of
 *   https://raw.githubusercontent.com/datasets/s-and-p-500-companies/main/data/constituents.csv
 *   commit 493df85c63794d76e8e01a3d0d2ac3c36c55fb59, dated 2026-07-22,
 *   fetched 2026-08-03. Licence: ODC-PDDL-1.0 (public domain dedication).
 *   Upstream source: Wikipedia, "List of S&P 500 companies".
 *
 * It is committed, not fetched — the demo must seed identically on a machine with
 * no network, and a universe that changed under us would break every stored
 * portfolio. Refresh it by re-running that curl and diffing; nothing else reads
 * the network.
 */
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const { createRng, hashString, randomBetween } = require('../lib/random.js');

const CSV_PATH = join(__dirname, 'sp500-constituents.csv');

/** The 11 GICS sectors, in the order the index publishes them. */
const SECTORS = [
  'Communication Services',
  'Consumer Discretionary',
  'Consumer Staples',
  'Energy',
  'Financials',
  'Health Care',
  'Industrials',
  'Information Technology',
  'Materials',
  'Real Estate',
  'Utilities',
];

/**
 * Per-sector envelopes for the synthetic fundamentals. These are shaped to be
 * *typical* of the sector rather than accurate for any member of it: utilities
 * are low-beta and pay dividends, software is high-beta and does not. Ranges are
 * inclusive and every draw is uniform inside them.
 *
 * `vol` and `beta` have to be mutually consistent — a name cannot have 14%
 * annualized volatility and a beta of 1.4 against a 15%-vol market factor,
 * because the systematic part alone would exceed its total variance. The
 * simulation guards against that (see `factorLoadings`), but the envelopes are
 * chosen so the guard almost never has to fire.
 */
const SECTOR_PROFILES = {
  'Communication Services': { vol: [0.24, 0.44], beta: [0.95, 1.35], yield: [0, 0.022], pe: [14, 40], noEarnings: 0.06 },
  'Consumer Discretionary': { vol: [0.24, 0.46], beta: [0.95, 1.45], yield: [0, 0.024], pe: [14, 42], noEarnings: 0.05 },
  'Consumer Staples':       { vol: [0.15, 0.26], beta: [0.42, 0.82], yield: [0.014, 0.036], pe: [16, 30], noEarnings: 0.01 },
  Energy:                   { vol: [0.27, 0.46], beta: [0.82, 1.30], yield: [0.020, 0.055], pe: [8, 20], noEarnings: 0.04 },
  Financials:               { vol: [0.20, 0.36], beta: [0.85, 1.35], yield: [0.012, 0.042], pe: [9, 24], noEarnings: 0.02 },
  'Health Care':            { vol: [0.20, 0.44], beta: [0.55, 1.15], yield: [0, 0.028], pe: [13, 38], noEarnings: 0.08 },
  Industrials:              { vol: [0.20, 0.38], beta: [0.88, 1.32], yield: [0.006, 0.030], pe: [13, 30], noEarnings: 0.03 },
  'Information Technology': { vol: [0.27, 0.52], beta: [1.00, 1.60], yield: [0, 0.016], pe: [20, 58], noEarnings: 0.07 },
  Materials:                { vol: [0.22, 0.40], beta: [0.92, 1.36], yield: [0.010, 0.034], pe: [11, 26], noEarnings: 0.03 },
  'Real Estate':            { vol: [0.20, 0.36], beta: [0.72, 1.18], yield: [0.026, 0.058], pe: [17, 46], noEarnings: 0.04 },
  Utilities:                { vol: [0.16, 0.27], beta: [0.34, 0.72], yield: [0.026, 0.052], pe: [14, 24], noEarnings: 0.01 },
};

const DEFAULT_PROFILE = { vol: [0.22, 0.40], beta: [0.80, 1.25], yield: [0, 0.03], pe: [12, 34], noEarnings: 0.05 };

/** Log-uniform: gives a long right tail, which is how caps and prices actually sit. */
const logUniform = (rng, min, max) => Math.exp(randomBetween(rng, Math.log(min), Math.log(max)));

const round2 = (value) => Math.round(value * 100) / 100;
const round4 = (value) => Math.round(value * 10_000) / 10_000;

/**
 * RFC-4180-ish CSV reader. The upstream file quotes fields containing commas
 * ("Block, Inc."), so a `split(',')` would silently shift twelve rows by a column.
 * Small enough to keep here rather than take a dependency for one 53 KB file.
 */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];

    if (quoted) {
      if (char !== '"') field += char;
      else if (text[i + 1] === '"') { field += '"'; i += 1; }
      else quoted = false;
    } else if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i += 1;
      row.push(field);
      field = '';
      rows.push(row);
      row = [];
    } else {
      field += char;
    }
  }

  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  const [header, ...body] = rows;
  return body
    .filter((cells) => cells.length === header.length && cells[0] !== '')
    .map((cells) => Object.fromEntries(header.map((name, index) => [name, cells[index]])));
}

/**
 * Invents everything except the identity. Seeded from the ticker alone and from a
 * namespace distinct from the price streams, so a name's fundamentals are stable
 * whatever else changes and adding or dropping a constituent moves nothing else.
 */
function synthesizeFundamentals({ symbol, sector }) {
  const rng = createRng(hashString(`fundamentals:${symbol}`));
  const profile = SECTOR_PROFILES[sector] ?? DEFAULT_PROFILE;

  // Draw the cap first: it anchors volume, and — weakly — volatility and beta,
  // because in a real index the megacaps are the calmer names.
  const marketCapB = round2(logUniform(rng, 6, 1400));
  const sizeTilt = (Math.log(marketCapB) - Math.log(6)) / (Math.log(1400) - Math.log(6)); // 0 small … 1 mega

  // Bias the vol/beta draws toward the low end of the envelope for the big names.
  const skewed = (min, max, tilt) => min + (max - min) * (rng() ** (1 + tilt * 1.1));
  const volatility = round4(skewed(profile.vol[0], profile.vol[1], sizeTilt));
  const beta = round2(skewed(profile.beta[0], profile.beta[1], sizeTilt * 0.6));

  const basePrice = round2(logUniform(rng, 14, 720));
  // Dollar turnover scales steeply with cap; shares traded is that over the price.
  const dollarVolume = logUniform(rng, 40e6, 1.1e9) * (0.3 + 4 * sizeTilt);
  const avgVolume = Math.max(200_000, Math.round(dollarVolume / basePrice / 1000) * 1000);

  const dividendYield = round4(rng() < 0.28 && profile.yield[0] === 0 ? 0 : randomBetween(rng, ...profile.yield));
  const peRatio = rng() < profile.noEarnings ? null : round2(randomBetween(rng, ...profile.pe));

  return { basePrice, volatility, avgVolume, marketCapB, beta, peRatio, dividendYield };
}

const CONSTITUENTS = parseCsv(readFileSync(CSV_PATH, 'utf8'));

const INSTRUMENTS = CONSTITUENTS.map((row) => {
  const identity = {
    symbol: row.Symbol,
    name: row.Security,
    sector: row['GICS Sector'],
    industry: row['GICS Sub-Industry'],
  };
  return {
    ...identity,
    ...synthesizeFundamentals(identity),
    currency: 'USD',
    // Not a real MIC. Every quote in this app is labelled with an exchange that
    // does not exist, which is the cheapest possible standing disclaimer.
    exchange: 'DEMO',
  };
}).sort((a, b) => a.symbol.localeCompare(b.symbol));

const INSTRUMENTS_BY_SYMBOL = new Map(INSTRUMENTS.map((i) => [i.symbol, i]));

const findInstrument = (symbol) =>
  INSTRUMENTS_BY_SYMBOL.get(String(symbol ?? '').toUpperCase()) ?? null;

module.exports = { SECTORS, INSTRUMENTS, INSTRUMENTS_BY_SYMBOL, findInstrument };
