/**
 * Every read the market endpoints make, as SQL. Kept separate from the tick loop
 * so reads stay serveable by any replica while only one replica writes.
 */
const { query } = require('../db/pool.js');
const { minuteLabel } = require('./simulation.js');

const round2 = (value) => Math.round(value * 100) / 100;

/**
 * Derived fields — change, spread, bid/ask — are computed on read rather than
 * stored, so they can never go stale against the price they describe.
 */
const presentQuote = (row) => {
  const change = round2(row.price - row.previous_close);
  // Two basis points a side, floored at a cent a side. The floor is not cosmetic:
  // a one-cent *total* spread rounds `price ± 0.005` onto the same cent for about
  // 4% of prices, so bid could equal ask. The old 25-name universe started at
  // $39.74, where 4 bps always cleared a cent, and never showed it; the S&P 500
  // has names in the teens. Deriving `spread` from the two sides afterwards keeps
  // the three numbers from ever disagreeing.
  const half = Math.max(round2(row.price * 0.0002), 0.01);
  const bid = round2(row.price - half);
  const ask = round2(row.price + half);
  return {
    symbol: row.symbol,
    name: row.name,
    sector: row.sector,
    industry: row.industry,
    currency: row.currency,
    exchange: row.exchange,
    price: row.price,
    open: row.open,
    previousClose: row.previous_close,
    change,
    changePercent: round2((change / row.previous_close) * 100),
    dayHigh: row.day_high,
    dayLow: row.day_low,
    bid,
    ask,
    spread: round2(ask - bid),
    volume: row.volume,
    avgVolume: row.avg_volume,
    marketCapB: row.market_cap_b,
    beta: row.beta,
    peRatio: row.pe_ratio,
    dividendYield: row.dividend_yield,
    fiftyTwoWeekHigh: row.fifty_two_week_high,
    fiftyTwoWeekLow: row.fifty_two_week_low,
    updatedAt: row.updated_at?.toISOString?.() ?? row.updated_at,
  };
};

const QUOTE_SELECT = `
  SELECT q.symbol, q.price, q.open, q.previous_close, q.day_high, q.day_low,
         q.volume, q.updated_at,
         i.name, i.sector, i.industry, i.currency, i.exchange, i.avg_volume, i.market_cap_b,
         i.beta, i.pe_ratio, i.dividend_yield, i.fifty_two_week_high, i.fifty_two_week_low
  FROM quotes q
  JOIN stocks i USING (symbol)
`;

// Whitelist, not interpolation — these map to real columns and nothing else can.
const SORT_COLUMNS = {
  symbol: 'q.symbol',
  name: 'i.name',
  price: 'q.price',
  volume: 'q.volume',
  marketCapB: 'i.market_cap_b',
  sector: 'i.sector',
  // Not a stored column; the same expression the presenter uses.
  changePercent: '((q.price - q.previous_close) / q.previous_close)',
};

/** The WHERE clause shared by the page query and the count that goes with it. */
function quoteFilters({ search = '', sector = '' }) {
  const params = [];
  const where = [];

  if (search) {
    params.push(`%${search}%`);
    where.push(`(q.symbol ILIKE $${params.length} OR i.name ILIKE $${params.length})`);
  }
  if (sector) {
    params.push(sector);
    where.push(`i.sector = $${params.length}`);
  }

  return { params, clause: where.length ? `WHERE ${where.join(' AND ')}` : '' };
}

/**
 * One page of quotes, plus how many matched in total.
 *
 * Paging arrived with the S&P 500 universe: 25 rows was one screenful and 503 is
 * a 350 KB response polled every four seconds. `total` is the size of the match,
 * not of the page, because that is the number the UI needs to render "1–50 of
 * 503" and to know whether there is a next page.
 *
 * @returns {Promise<{ quotes: object[], total: number }>}
 */
async function listQuotes({
  search = '',
  sector = '',
  sort = 'symbol',
  order = 'asc',
  limit,
  offset = 0,
  // Whether the caller needs `total`. Callers that only want a top-N — the movers
  // board — do not, and asking for it costs a full `count(*)` over the joined tables
  // whose answer is then dropped on the floor.
  countTotal = true,
} = {}) {
  const column = SORT_COLUMNS[sort] ?? SORT_COLUMNS.symbol;
  const direction = order === 'desc' ? 'DESC' : 'ASC';
  const { params, clause } = quoteFilters({ search, sector });

  // Secondary sort on symbol: without it a page boundary can repeat or drop a row
  // when several stocks tie on the sort column.
  let sql = `${QUOTE_SELECT} ${clause} ORDER BY ${column} ${direction}, q.symbol ASC`;

  const paged = Number.isFinite(limit) && limit > 0;
  if (paged) {
    params.push(limit);
    sql += ` LIMIT $${params.length}`;
    if (offset > 0) {
      params.push(offset);
      sql += ` OFFSET $${params.length}`;
    }
  }

  const { rows } = await query(sql, params);
  const quotes = rows.map(presentQuote);

  // Only worth a second round trip when the page could be hiding something — and only
  // when somebody is going to read the answer.
  //
  // `quotes.length < limit` is deliberately strict: a full page means there may be
  // more behind it. The consequence is that a top-5 that returns exactly 5 always
  // counted, which is every request the movers board makes.
  if (!countTotal) return { quotes, total: null };
  if (!paged || (offset === 0 && quotes.length < limit)) {
    return { quotes, total: quotes.length };
  }

  const { params: countParams, clause: countClause } = quoteFilters({ search, sector });
  const { rows: countRows } = await query(
    `SELECT count(*)::int AS n FROM quotes q JOIN stocks i USING (symbol) ${countClause}`,
    countParams,
  );
  return { quotes, total: countRows[0].n };
}

/**
 * Several named quotes in one query.
 *
 * The endpoint this exists for is a watchlist or a comparison view: a caller who
 * already knows which symbols it wants and would otherwise fetch them one at a time.
 * Twelve names cost twelve quote queries plus twelve sparkline queries, which is the
 * N+1 that `getSparklines` was written to avoid one level down.
 *
 * Returns a Map rather than an array, because the caller cares about the order it
 * asked in and the database has no opinion on it. Ordering here — `array_position`
 * or a CTE with an index — would push a presentation concern into SQL to save a loop
 * over at most a few dozen rows.
 */
async function getQuotes(symbols) {
  if (symbols.length === 0) return new Map();

  const { rows } = await query(`${QUOTE_SELECT} WHERE q.symbol = ANY($1)`, [symbols]);
  return new Map(rows.map((row) => [row.symbol, presentQuote(row)]));
}

async function getQuote(symbol) {
  const { rows } = await query(`${QUOTE_SELECT} WHERE q.symbol = $1`, [String(symbol).toUpperCase()]);
  return rows[0] ? presentQuote(rows[0]) : null;
}

/**
 * Evenly spaced intraday closes for the row-level sparklines, for every symbol in
 * one query. Doing this per row would be a textbook N+1.
 */
async function getSparklines(symbols, points = 24) {
  if (symbols.length === 0) return new Map();

  const { rows } = await query(
    `WITH latest AS (
       SELECT symbol, max(session_date) AS session_date
       FROM intraday_bars WHERE symbol = ANY($1) GROUP BY symbol
     ),
     ranked AS (
       SELECT b.symbol, b.minute, b.close,
              row_number() OVER (PARTITION BY b.symbol ORDER BY b.minute) AS rn,
              count(*)     OVER (PARTITION BY b.symbol)                   AS total
       FROM intraday_bars b JOIN latest l USING (symbol, session_date)
     )
     SELECT symbol, close FROM ranked
     -- Keep every nth bar, and always the last one.
     WHERE rn % GREATEST(total / $2, 1) = 0 OR rn = total
     ORDER BY symbol, minute`,
    [symbols, points],
  );

  const bySymbol = new Map();
  for (const row of rows) {
    if (!bySymbol.has(row.symbol)) bySymbol.set(row.symbol, []);
    bySymbol.get(row.symbol).push(row.close);
  }
  return bySymbol;
}

/**
 * Whether the market knows this symbol at all, without building a quote for it.
 *
 * The history endpoint asks only to choose between a 404 and an empty bar list, and
 * it was asking `getQuote`, which selects eighteen columns across two tables and
 * derives a bid, an ask and a spread that nothing then reads. The join stays: "known"
 * has to keep meaning what it meant — a quote row with an stock behind it — and
 * not quietly widen to stocks that were never priced.
 */
async function isKnownSymbol(symbol) {
  const { rows } = await query(
    'SELECT 1 FROM quotes q JOIN stocks i USING (symbol) WHERE q.symbol = $1',
    [String(symbol).toUpperCase()],
  );
  return rows.length > 0;
}

/**
 * A version string for the bars a history request would return, from a single index
 * lookup rather than from the read itself.
 *
 * What can move is different per range family, and that difference is the whole
 * reason this is worth having.
 *
 * `daily_bars` is written by the seeder and by nothing else — the tick loop never
 * touches it — so 5D through 1Y are immutable for the life of a seeded database.
 * `intraday_bars` is written only while `sessionState()` says `regular`, and even
 * then only for the minute in progress: the tick's ON CONFLICT clause extends that
 * row's high, low and close and leaves every earlier minute alone. So 1D is frozen
 * outside 09:30–16:00 ET, which is four fifths of the week, and inside the session
 * only its last bar moves.
 *
 * The newest bar therefore stands for the whole series, and its high, low and close
 * are in the string as well as its date because those are the three fields the tick
 * can still rewrite. The close also earns its place for a second reason: a reseed
 * with a different `MARKET_SEED` produces the same calendar and different prices, so
 * a version built from dates alone would tell a client its stale chart was current.
 *
 * @returns {Promise<string|null>} null when the symbol has no bars in that family,
 *   which is not the same as an unknown symbol — see `isKnownSymbol`.
 */
async function getHistoryVersion(symbol, range = '1D') {
  const upper = String(symbol).toUpperCase();

  // Both queries are a descending walk of the primary key's tail, so neither reads
  // more than the one row it returns.
  const { rows } =
    range === '1D'
      ? await query(
          `SELECT session_date, minute, high, low, close
           FROM intraday_bars
           WHERE symbol = $1 AND session_date = (
             SELECT max(session_date) FROM intraday_bars WHERE symbol = $1
           )
           ORDER BY minute DESC LIMIT 1`,
          [upper],
        )
      : await query(
          `SELECT session_date, 0 AS minute, high, low, close
           FROM daily_bars WHERE symbol = $1 ORDER BY session_date DESC LIMIT 1`,
          [upper],
        );

  if (!rows[0]) return null;
  const bar = rows[0];
  // The range is part of the version, not just the bar: 1M and 1Y end on the same
  // session and are different responses.
  return [range, bar.session_date, bar.minute, bar.high, bar.low, bar.close].join('-');
}

const DAILY_WINDOW = { '5D': 5, '1M': 22, '3M': 66, '1Y': 252 };

async function getHistory(symbol, range = '1D') {
  const upper = String(symbol).toUpperCase();

  if (range === '1D') {
    const { rows } = await query(
      `SELECT minute, open, high, low, close, volume
       FROM intraday_bars
       WHERE symbol = $1 AND session_date = (
         SELECT max(session_date) FROM intraday_bars WHERE symbol = $1
       )
       ORDER BY minute`,
      [upper],
    );
    return {
      symbol: upper,
      range,
      interval: '1m',
      bars: rows.map((row) => ({
        t: minuteLabel(row.minute),
        open: row.open,
        high: row.high,
        low: row.low,
        close: row.close,
        volume: row.volume,
      })),
    };
  }

  const window = DAILY_WINDOW[range];
  if (!window) return null;

  const { rows } = await query(
    `SELECT session_date, open, high, low, close, volume FROM daily_bars
     WHERE symbol = $1 ORDER BY session_date DESC LIMIT $2`,
    [upper, window],
  );

  return {
    symbol: upper,
    range,
    interval: '1d',
    bars: rows.reverse().map((row) => ({
      t: row.session_date,
      date: row.session_date,
      open: row.open,
      high: row.high,
      low: row.low,
      close: row.close,
      volume: row.volume,
    })),
  };
}

/**
 * Three ordered top-N queries rather than one full scan sliced three ways. At 25
 * stocks pulling the whole board into JS and sorting it was fine; at 503 it
 * meant serializing and presenting 1,500 quotes to return 15.
 */
async function getMovers(count = 5) {
  // `countTotal: false` on all three. Each of these asks for a top-N and reads only
  // the rows; without it, every request ran three `count(*)`s over
  // `quotes JOIN stocks` and discarded all three answers — because a top-5 that
  // returns exactly 5 rows does not satisfy `quotes.length < limit`. On a board that
  // is polled, that was three full counts a tick for nothing.
  const [gainers, losers, mostActive] = await Promise.all([
    listQuotes({ sort: 'changePercent', order: 'desc', limit: count, countTotal: false }),
    listQuotes({ sort: 'changePercent', order: 'asc', limit: count, countTotal: false }),
    listQuotes({ sort: 'volume', order: 'desc', limit: count, countTotal: false }),
  ]);
  return { gainers: gainers.quotes, losers: losers.quotes, mostActive: mostActive.quotes };
}

/**
 * One sector, in the detail the summary cannot carry.
 *
 * `/sectors` gives an average across every name in a sector and nothing to drill
 * into, which is enough to rank sectors and not enough to say anything about one. An
 * average of +0.4% is the same number whether every name rose slightly or two thirds
 * fell and one very large one carried the rest — and those are different days.
 *
 * So this reports both means and the breadth behind them, in a single aggregate pass
 * rather than by pulling the sector's rows out and reducing them in JavaScript.
 */
async function getSectorDetail(sector, leaders = 5) {
  const { rows } = await query(
    `SELECT count(*)::int                                                    AS stocks,
            avg((q.price - q.previous_close) / q.previous_close * 100)       AS equal_weighted,
            -- Cap-weighted: the change each name contributes in proportion to its
            -- size, which is what an index tracking this sector would actually do.
            SUM((q.price - q.previous_close) / q.previous_close * 100 * i.market_cap_b)
              / NULLIF(SUM(i.market_cap_b), 0)                               AS cap_weighted,
            SUM(i.market_cap_b)                                              AS market_cap_b,
            SUM(q.volume)::bigint                                            AS volume,
            count(*) FILTER (WHERE q.price > q.previous_close)::int          AS advancing,
            count(*) FILTER (WHERE q.price < q.previous_close)::int          AS declining,
            count(*) FILTER (WHERE q.price = q.previous_close)::int          AS unchanged,
            max(q.updated_at)                                                AS updated_at
     FROM quotes q JOIN stocks i USING (symbol)
     WHERE i.sector = $1`,
    [sector],
  );

  const summary = rows[0];
  // count(*) over no rows is 0, not no row — so an unknown sector arrives here as a
  // populated row of zeroes rather than as undefined. The caller needs to tell "no
  // such sector" from "a sector where nothing moved", and only this can.
  if (summary.stocks === 0) return null;

  const [best, worst] = await Promise.all([
    listQuotes({ sector, sort: 'changePercent', order: 'desc', limit: leaders, countTotal: false }),
    listQuotes({ sector, sort: 'changePercent', order: 'asc', limit: leaders, countTotal: false }),
  ]);

  return {
    sector,
    stocks: summary.stocks,
    equalWeightedChangePercent: round2(summary.equal_weighted),
    capWeightedChangePercent: round2(summary.cap_weighted),
    marketCapB: round2(summary.market_cap_b),
    volume: summary.volume,
    breadth: {
      advancing: summary.advancing,
      declining: summary.declining,
      unchanged: summary.unchanged,
    },
    leaders: best.quotes,
    // Ascending order is already worst-first — the most negative change sorts lowest —
    // so these come back in the order a laggards list is read. Reversing them looks
    // like the obvious tidy-up and puts the least bad name at the top of a list of the
    // worst, which is wrong in a way nobody would notice from the shape of the output.
    laggards: worst.quotes,
    asOf: summary.updated_at?.toISOString?.() ?? summary.updated_at,
  };
}

async function getSectorSummary() {
  const { rows } = await query(
    `SELECT i.sector,
            count(*)::int AS stocks,
            avg((q.price - q.previous_close) / q.previous_close * 100) AS average_change_percent
     FROM quotes q JOIN stocks i USING (symbol)
     GROUP BY i.sector
     ORDER BY average_change_percent DESC`,
  );
  return rows.map((row) => ({
    sector: row.sector,
    stocks: row.stocks,
    averageChangePercent: round2(row.average_change_percent),
  }));
}

const countStocks = async () => {
  const { rows } = await query('SELECT count(*)::int AS n FROM stocks');
  return rows[0].n;
};

const listSectors = async () => {
  const { rows } = await query('SELECT DISTINCT sector FROM stocks ORDER BY sector');
  return rows.map((row) => row.sector);
};

module.exports = {
  listQuotes,
  getQuote,
  getQuotes,
  isKnownSymbol,
  getSparklines,
  getHistory,
  getHistoryVersion,
  getMovers,
  getSectorDetail,
  getSectorSummary,
  countStocks,
  listSectors,
};
