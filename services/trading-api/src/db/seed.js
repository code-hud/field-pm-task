#!/usr/bin/env node
/**
 * Populates the database with a complete, believable demo.
 *
 *   npm run seed                       # migrate, then seed if the universe is empty
 *   npm run seed -- --reset            # drop everything and rebuild from scratch
 *   npm run seed -- --force            # re-seed market data over what is there
 *   npm run seed -- --accounts a,b,c   # also pre-create these demo accounts
 *   npm run seed -- --market-seed 42   # a different market
 *
 * Safe to run repeatedly: without --reset or --force it will not overwrite data.
 * The output is fully determined by --market-seed, so two people running this get
 * the same market and the same portfolios.
 */
const { realpathSync } = require('node:fs');

const { config } = require('../config/index.js');
const { INSTRUMENTS, SECTORS } = require('../data/instruments.js');
const { createRng, hashString } = require('../lib/random.js');
const { sessionState } = require('../market/clock.js');
const {
  buildDailyBars,
  buildFactorHistory,
  buildIntradayBars,
  buildIntradayFactors,
  factorLoadings,
  MINUTES_PER_SESSION,
  tradingSessionDates,
  round2,
} = require('../market/simulation.js');
const { generatePortfolio, selectPortfolioSymbols } = require('../portfolio/generator.js');
const { migrate, dropAll } = require('./migrate.js');
const { closePool, pool, query, transaction, waitForDatabase } = require('./pool.js');

// Calendar days of history to generate; weekends drop out, leaving ~271 sessions.
const HISTORY_CALENDAR_DAYS = 380;
const FIFTY_TWO_WEEK_SESSIONS = 252;

// Accounts every fresh demo gets, so there is something to show without inventing
// a username on the spot. Any other username still works — it is created on login.
const DEFAULT_ACCOUNTS = ['a.okafor', 'dan', 'demo'];

function parseArgs(argv) {
  const options = {
    reset: false,
    force: false,
    quiet: false,
    accounts: DEFAULT_ACCOUNTS,
    marketSeed: config.market.seed,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--reset') options.reset = true;
    else if (arg === '--force') options.force = true;
    else if (arg === '--quiet') options.quiet = true;
    else if (arg === '--no-accounts') options.accounts = [];
    else if (arg === '--accounts') {
      options.accounts = (argv[++i] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    } else if (arg === '--market-seed') {
      options.marketSeed = Number.parseInt(argv[++i] ?? '', 10);
      if (!Number.isFinite(options.marketSeed)) throw new Error('--market-seed needs a number');
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else {
      throw new Error(`Unknown option "${arg}". Try --help.`);
    }
  }

  return options;
}

const HELP = `
Populate the Heads Up Financial demo database.

  --reset               drop every table, re-migrate, then seed
  --force               re-seed market data even if it is already present
  --accounts a,b,c      demo accounts to pre-create (default: ${DEFAULT_ACCOUNTS.join(',')})
  --no-accounts         seed market data only
  --market-seed N       PRNG seed; same value reproduces the same market
  --quiet               only print the summary
  --help                this message
`.trim();

/**
 * Everything the whole universe shares: the trading calendar, the common factor
 * paths over it, and today's intraday factor path. Cheap to build (11 sectors ×
 * ~270 sessions) and computed once, because the entire point of the factor model
 * is that all 503 names see the *same* market.
 *
 * It depends only on the seed and the dates — never on the instrument list — so
 * adding or dropping a constituent leaves every other name's history untouched.
 */
function buildMarketContext(marketSeed, now) {
  const session = sessionState(now);
  // Clamped: `intraday_bars.minute` is documented as 0..389, and the clock could
  // hand back 390 at the after-hours boundary.
  const minutes =
    session.phase === 'pre-market'
      ? 1
      : Math.min(Math.max(1, session.minutesIntoSession), MINUTES_PER_SESSION);
  const sessionDate = now.toISOString().slice(0, 10);
  const sessions = tradingSessionDates(now, HISTORY_CALENDAR_DAYS);

  return {
    sessionDate,
    sessionCount: sessions.length,
    daily: buildFactorHistory(marketSeed, sessions, SECTORS),
    intraday: buildIntradayFactors(marketSeed, sessionDate, minutes, SECTORS),
  };
}

/**
 * One instrument's complete history: ~270 daily bars, today's minute bars, and
 * the quote they imply.
 *
 * Generated on demand rather than for the whole universe up front. At 25 symbols
 * materializing everything first was free; at 503 it is ~330,000 bar objects and
 * several hundred megabytes, on a demo box with 2 GiB total. Peak memory is now
 * one symbol's worth.
 */
function buildInstrumentData(instrument, context, marketSeed) {
  // Per-symbol stream: adding an instrument does not shift any other's history.
  const rng = createRng(marketSeed ^ hashString(instrument.symbol));
  const loadings = factorLoadings(instrument);

  const daily = buildDailyBars(instrument, loadings, context.daily, rng);
  const previousClose = daily.at(-1)?.close ?? instrument.basePrice;
  const { bars: intraday, open, price } = buildIntradayBars(
    instrument,
    loadings,
    previousClose,
    context.intraday,
    rng,
  );

  // One pass over the window instead of `Math.max(...closes)`: spreading 252
  // arguments 503 times is measurable, and spreading a longer window would blow
  // the argument limit outright.
  let high = -Infinity;
  let low = Infinity;
  for (let i = Math.max(0, daily.length - FIFTY_TWO_WEEK_SESSIONS); i < daily.length; i += 1) {
    if (daily[i].close > high) high = daily[i].close;
    if (daily[i].close < low) low = daily[i].close;
  }

  let dayHigh = price;
  let dayLow = price;
  let volume = 0;
  for (const bar of intraday) {
    if (bar.high > dayHigh) dayHigh = bar.high;
    if (bar.low < dayLow) dayLow = bar.low;
    volume += bar.volume;
  }

  return {
    instrument,
    loadings,
    daily,
    intraday,
    fiftyTwoWeekHigh: high,
    fiftyTwoWeekLow: low,
    quote: { price, open, previousClose, dayHigh, dayLow, volume, sessionDate: context.sessionDate },
  };
}

/**
 * Generates and writes the universe one instrument at a time, all inside one
 * transaction — so a failure halfway through still leaves no partial market
 * behind, without holding the whole thing in memory to get that guarantee.
 *
 * @returns {{ instruments: number, bars: number }}
 */
async function writeUniverse(marketSeed, now = new Date()) {
  const context = buildMarketContext(marketSeed, now);
  let bars = 0;

  await transaction(async (tx) => {
    // Cascades clear the bars and quotes; accounts survive because positions
    // reference instruments, which are re-inserted with the same symbols below.
    await tx.query('TRUNCATE intraday_bars, daily_bars, quotes');

    for (const instrument of INSTRUMENTS) {
      const entry = buildInstrumentData(instrument, context, marketSeed);
      const i = entry.instrument;
      const l = entry.loadings;

      await tx.query(
        `INSERT INTO instruments (symbol, name, sector, industry, currency, exchange, base_price,
           volatility, avg_volume, market_cap_b, beta, pe_ratio, dividend_yield,
           sector_loading, idio_volatility, drift_annual,
           fifty_two_week_high, fifty_two_week_low)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
         ON CONFLICT (symbol) DO UPDATE SET
           name = EXCLUDED.name, sector = EXCLUDED.sector, industry = EXCLUDED.industry,
           base_price = EXCLUDED.base_price,
           volatility = EXCLUDED.volatility, avg_volume = EXCLUDED.avg_volume,
           market_cap_b = EXCLUDED.market_cap_b, beta = EXCLUDED.beta,
           pe_ratio = EXCLUDED.pe_ratio, dividend_yield = EXCLUDED.dividend_yield,
           sector_loading = EXCLUDED.sector_loading,
           idio_volatility = EXCLUDED.idio_volatility,
           drift_annual = EXCLUDED.drift_annual,
           fifty_two_week_high = EXCLUDED.fifty_two_week_high,
           fifty_two_week_low = EXCLUDED.fifty_two_week_low`,
        [
          i.symbol, i.name, i.sector, i.industry, i.currency, i.exchange, i.basePrice,
          i.volatility, i.avgVolume, i.marketCapB,
          // The *effective* market beta, after the variance-budget guard — so the
          // beta on screen is the beta the returns actually exhibit.
          l.marketBeta, i.peRatio, i.dividendYield,
          l.sectorLoading, l.idioVolatility, l.alpha,
          entry.fiftyTwoWeekHigh, entry.fiftyTwoWeekLow,
        ],
      );

      await insertRows(
        tx,
        'daily_bars (symbol, session_date, open, high, low, close, volume)',
        entry.daily.map((bar) => [i.symbol, bar.date, bar.open, bar.high, bar.low, bar.close, bar.volume]),
      );

      await insertRows(
        tx,
        'intraday_bars (symbol, session_date, minute, open, high, low, close, volume)',
        entry.intraday.map((bar) => [
          i.symbol, entry.quote.sessionDate, bar.minute, bar.open, bar.high, bar.low, bar.close, bar.volume,
        ]),
      );

      const q = entry.quote;
      await tx.query(
        `INSERT INTO quotes (symbol, price, open, previous_close, day_high, day_low, volume, session_date)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [i.symbol, q.price, q.open, q.previousClose, q.dayHigh, q.dayLow, q.volume, q.sessionDate],
      );

      bars += entry.daily.length + entry.intraday.length;
    }
  });

  return { instruments: INSTRUMENTS.length, bars };
}

/**
 * Multi-row INSERT, chunked to stay under Postgres' 65535-parameter cap.
 *
 * The chunk is sized in *parameters*, not rows: 8,000 was ~11 statements per
 * symbol at 25 instruments and is ~2 at 503, which took a meaningful bite out of
 * seed time once there were 330,000 bars to write.
 */
async function insertRows(tx, target, rows, maxParams = 8000) {
  if (rows.length === 0) return;
  const columns = rows[0].length;
  const chunkSize = Math.max(1, Math.floor(maxParams / columns));

  for (let offset = 0; offset < rows.length; offset += chunkSize) {
    const chunk = rows.slice(offset, offset + chunkSize);
    const placeholders = chunk
      .map((_, r) => `(${Array.from({ length: columns }, (_, c) => `$${r * columns + c + 1}`).join(',')})`)
      .join(',');
    await tx.query(`INSERT INTO ${target} VALUES ${placeholders}`, chunk.flat());
  }
}

/** Creates one account with its positions, lots, and dividends. Idempotent. */
async function seedAccount(username, { skipExisting = true } = {}) {
  const { buildUser } = require('../auth/authService.js');
  const user = buildUser(username);
  const usernameKey = username.trim().toLowerCase();

  if (skipExisting) {
    const { rows } = await query('SELECT 1 FROM accounts WHERE username_key = $1', [usernameKey]);
    if (rows.length > 0) return { username, created: false };
  }

  // Only the symbols this portfolio will actually hold. Reading every bar was
  // 6,750 rows at 25 instruments and would be 136,000 at 503 — per account, and
  // this also runs on a first sign-in, where it would be a page load.
  const symbols = selectPortfolioSymbols(username);
  const { rows: barRows } = await query(
    'SELECT symbol, session_date, close FROM daily_bars WHERE symbol = ANY($1) ORDER BY symbol, session_date',
    [symbols],
  );
  if (barRows.length === 0) throw new Error('No price history — seed market data before accounts.');

  const dailyBarsBySymbol = new Map();
  for (const row of barRows) {
    if (!dailyBarsBySymbol.has(row.symbol)) dailyBarsBySymbol.set(row.symbol, []);
    dailyBarsBySymbol.get(row.symbol).push({ date: row.session_date, close: row.close });
  }

  const generated = generatePortfolio(username, dailyBarsBySymbol);

  await transaction(async (tx) => {
    await tx.query(
      `INSERT INTO accounts (id, username, username_key, display_name, email, account_number,
         account_type, risk_profile, advisor, member_since, base_currency, cash, funded_amount)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (username_key) DO NOTHING`,
      [
        user.id, user.username, usernameKey, user.displayName, user.email, user.accountNumber,
        user.accountType, user.riskProfile, user.advisor, user.memberSince, 'USD',
        generated.cash, generated.fundedAmount,
      ],
    );

    for (const position of generated.positions) {
      const { rows } = await tx.query(
        `INSERT INTO positions (account_id, symbol, opened_at) VALUES ($1,$2,$3)
         ON CONFLICT (account_id, symbol) DO NOTHING RETURNING id`,
        [user.id, position.symbol, position.openedAt],
      );
      if (rows.length === 0) continue; // already present
      const positionId = rows[0].id;

      for (const lot of position.lots) {
        await tx.query(
          'INSERT INTO lots (position_id, trade_date, quantity, price) VALUES ($1,$2,$3,$4)',
          [positionId, lot.date, lot.quantity, lot.price],
        );

        // The matching trade. A seeded lot is a purchase that "happened", and the
        // equity curve and the ledger read trades — without this a freshly seeded
        // account would report holding nothing on every past session.
        const { rows: tradeRows } = await tx.query(
          `INSERT INTO trades (account_id, symbol, side, quantity, price, cash_delta, trade_date, executed_at)
           VALUES ($1, $2, 'BUY', $3, $4, $5, $6::date, $6::timestamptz)
           RETURNING id`,
          [
            user.id,
            position.symbol,
            lot.quantity,
            lot.price,
            -round2(lot.quantity * lot.price),
            lot.date,
          ],
        );

        // And the order it was. `005_orders.sql` backfills this for trades that
        // existed when it ran, but accounts are created on first sign-in — so an
        // account made after the migration would otherwise have a ledger full of
        // purchases and an order history that claimed it had never traded. The two
        // paths have to agree, or "no orders" stops meaning anything.
        await tx.query(
          `INSERT INTO orders (account_id, symbol, side, type, quantity, status,
                               filled_quantity, fill_price, trade_id, placed_at, resolved_at)
           VALUES ($1, $2, 'BUY', 'MARKET', $3, 'FILLED', $3, $4, $5, $6::timestamptz, $6::timestamptz)`,
          [user.id, position.symbol, lot.quantity, lot.price, tradeRows[0].id, lot.date],
        );
      }
    }

    for (const dividend of generated.dividends) {
      await tx.query(
        'INSERT INTO dividends (account_id, symbol, pay_date, amount) VALUES ($1,$2,$3,$4)',
        [user.id, dividend.symbol, dividend.date, dividend.amount],
      );
    }
  });

  return { username, created: true, positions: generated.positions.length };
}

const marketDataIsSeeded = async () => {
  const { rows } = await query('SELECT count(*)::int AS n FROM quotes');
  return rows[0].n > 0;
};

async function seed(options) {
  const log = options.quiet ? () => {} : (message) => console.log(`  ${message}`);
  const started = Date.now();

  if (options.reset) {
    log('resetting — dropping all tables');
    await dropAll();
  }

  await migrate();

  const alreadySeeded = await marketDataIsSeeded();
  let instrumentCount = 0;
  let barCount = 0;

  if (alreadySeeded && !options.force && !options.reset) {
    log('market data already present — skipping (use --force to re-seed)');
  } else {
    log(`generating market data (seed ${options.marketSeed})`);
    const written = await writeUniverse(options.marketSeed);
    instrumentCount = written.instruments;
    barCount = written.bars;
    log(`wrote ${instrumentCount} instruments and ${barCount.toLocaleString()} bars`);
  }

  const created = [];
  for (const username of options.accounts) {
    const result = await seedAccount(username);
    if (result.created) created.push(username);
  }
  if (options.accounts.length > 0) {
    log(
      created.length > 0
        ? `created accounts: ${created.join(', ')}`
        : 'demo accounts already present',
    );
  }

  return { instrumentCount, barCount, accountsCreated: created, ms: Date.now() - started };
}

// Only run when invoked directly, so tests and the server can require the helpers.
// `realpathSync` on both sides keeps this true through a symlinked entry point.
const invokedDirectly = Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(__filename);

// The await below lives in a function rather than at the top level: this package is
// CommonJS, and a top-level await anywhere in the file makes Node treat it as an ESM
// graph, which then cannot be `require`d by the tests at all.
async function runFromCli() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`\n  ${error.message}\n`);
    process.exit(2);
  }

  if (options.help) {
    console.log(`\n${HELP}\n`);
    process.exit(0);
  }

  console.log(`\nSeeding ${redact(config.db.url)}\n`);

  try {
    await waitForDatabase();
    const result = await seed(options);
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM accounts');
    console.log(`\n  Done in ${result.ms}ms — ${rows[0].n} account(s) in the database.\n`);
  } catch (error) {
    console.error(`\n  Seed failed: ${error.message}\n`);
    process.exitCode = 1;
  } finally {
    await closePool();
  }
}

if (invokedDirectly) {
  runFromCli();
}

/** Never print a password, even to a local terminal. */
function redact(url) {
  try {
    const parsed = new URL(url);
    if (parsed.password) parsed.password = '***';
    return parsed.toString();
  } catch {
    return url;
  }
}

module.exports = { parseArgs, seedAccount, seed, marketDataIsSeeded };
