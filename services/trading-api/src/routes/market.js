const { Router } = require('express');

const {
  countInstruments,
  getHistory,
  getHistoryVersion,
  getMovers,
  getQuote,
  getQuotes,
  getSectorDetail,
  getSectorSummary,
  getSparklines,
  isKnownSymbol,
  listQuotes,
  listSectors,
} = require('../market/repository.js');
const { marketTicker } = require('../market/ticker.js');
const { ApiError } = require('../middleware/errors.js');
const { requireAuth } = require('../middleware/requireAuth.js');

const marketRouter = Router();

const SORTABLE = new Set(['symbol', 'name', 'price', 'changePercent', 'volume', 'marketCapB', 'sector']);
const HISTORY_RANGES = new Set(['1D', '5D', '1M', '3M', '1Y']);

// A page of the S&P 500 with sparklines is ~35 KB; the whole board would be
// ~350 KB, polled every four seconds by every open tab. The cap is what stops a
// client asking for that by accident.
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 250;

// A watchlist, not a page of the universe. Fifty is more names than anyone compares
// at once, and it bounds the sparkline query that goes with them. Over the cap is a
// 400 rather than a silent truncation: a caller asking for sixty names and getting
// fifty back has no way to tell which ten went missing, and a watchlist quietly
// losing rows is worse than one that refuses to load.
const MAX_SYMBOLS = 50;

// Session status is public: the login screen shows it before anyone signs in.
marketRouter.get('/status', async (_req, res, next) => {
  try {
    res.json({ ...marketTicker.status, instruments: await countInstruments() });
  } catch (error) {
    next(error);
  }
});

marketRouter.use(requireAuth);

/**
 * A page of quotes. `total` counts everything matching the filters, so a client
 * can page without a second endpoint; `limit`/`offset` echo what was applied.
 *
 * Sparklines are 24 intraday closes per row and roughly a third of the payload.
 * They stay on by default because the markets table wants them, and `sparkline=0`
 * turns them off for callers that only need the numbers.
 */
marketRouter.get('/instruments', async (req, res, next) => {
  try {
    const { search = '', sector = '', sort = 'symbol', order = 'asc' } = req.query;

    if (!SORTABLE.has(sort)) {
      throw new ApiError(`Cannot sort by "${sort}". Sortable: ${[...SORTABLE].join(', ')}`, {
        status: 400,
        code: 'invalid_sort',
      });
    }

    const limit = boundedInt(req.query.limit, DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE);
    const offset = boundedInt(req.query.offset, 0, 0, Number.MAX_SAFE_INTEGER);
    const withSparkline = !['0', 'false', 'no'].includes(String(req.query.sparkline ?? '').toLowerCase());

    const { quotes, total } = await listQuotes({
      search: String(search).trim(),
      sector: String(sector).trim(),
      sort,
      order,
      limit,
      offset,
    });

    // One query for every sparkline on the page, rather than one query per row.
    const sparklines = withSparkline
      ? await getSparklines(quotes.map((quote) => quote.symbol))
      : new Map();

    res.json({
      instruments: withSparkline
        ? quotes.map((quote) => ({ ...quote, sparkline: sparklines.get(quote.symbol) ?? [] }))
        : quotes,
      total,
      limit,
      offset,
      asOf: new Date().toISOString(),
    });
  } catch (error) {
    next(error);
  }
});

/**
 * Quotes for a named list of symbols, in the order they were asked for.
 *
 * The only way to get several specific quotes today is one call each, and each of
 * those costs a quote query plus a sparkline query — twenty-four round trips for a
 * twelve-name watchlist. This is one of each.
 *
 * <b>An unknown symbol does not fail the request.</b> It comes back in `unknown`
 * alongside the quotes that were found. A watchlist is a list somebody saved, and a
 * name that has since stopped being priced should cost them that one row rather than
 * the whole screen — which is exactly what a 404 would do. Callers that want the
 * strict behaviour can compare `unknown` against what they sent, and callers that
 * do not get a page that still renders.
 */
marketRouter.get('/quotes', async (req, res, next) => {
  try {
    const requested = String(req.query.symbols ?? '')
      .split(',')
      .map((symbol) => symbol.trim().toUpperCase())
      .filter(Boolean);

    if (requested.length === 0) {
      throw new ApiError('Name at least one symbol, as ?symbols=AAPL,MSFT.', {
        status: 400,
        code: 'symbols_required',
      });
    }

    // Deduplicated, but keeping the first position of each: a caller repeating a
    // symbol means the list it has, not two of that quote.
    const symbols = [...new Set(requested)];

    if (symbols.length > MAX_SYMBOLS) {
      throw new ApiError(
        `Asked for ${symbols.length} symbols; the limit is ${MAX_SYMBOLS} per request.`,
        { status: 400, code: 'too_many_symbols' },
      );
    }

    const found = await getQuotes(symbols);
    const withSparkline = !['0', 'false', 'no'].includes(String(req.query.sparkline ?? '').toLowerCase());
    const sparklines = withSparkline ? await getSparklines([...found.keys()]) : new Map();

    const quotes = symbols
      .filter((symbol) => found.has(symbol))
      .map((symbol) =>
        withSparkline
          ? { ...found.get(symbol), sparkline: sparklines.get(symbol) ?? [] }
          : found.get(symbol),
      );

    res.json({
      quotes,
      // Named separately rather than as nulls in the list, so a caller iterating the
      // quotes never has to guard against a hole in it.
      unknown: symbols.filter((symbol) => !found.has(symbol)),
      requested: symbols.length,
      // The freshest quote in the response, not the clock. What a caller wants to
      // know is how old this data is, and `new Date()` answers a different question —
      // when the response was serialised — which is always "just now" and therefore
      // never useful.
      asOf: quotes.reduce(
        (latest, quote) => (latest === null || quote.updatedAt > latest ? quote.updatedAt : latest),
        null,
      ),
    });
  } catch (error) {
    next(error);
  }
});

/** Parses a query-string integer, clamping instead of rejecting. */
function boundedInt(value, fallback, min, max) {
  const parsed = Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

marketRouter.get('/sectors', async (_req, res, next) => {
  try {
    res.json({ sectors: await listSectors(), performance: await getSectorSummary() });
  } catch (error) {
    next(error);
  }
});

/**
 * One sector in detail: both means, the breadth behind them, and the names at each end.
 *
 * Declared above nothing in particular — `/sectors` is an exact path, so there is no
 * shadowing to worry about here the way there is between `/quotes` and a parameterised
 * sibling. It is placed next to `/sectors` because that is where a reader will look.
 */
marketRouter.get('/sectors/:sector', async (req, res, next) => {
  try {
    const count = boundedInt(req.query.count, 5, 1, 25);
    const detail = await getSectorDetail(String(req.params.sector).trim(), count);

    if (!detail) {
      throw new ApiError(`No sector "${req.params.sector}".`, {
        status: 404,
        code: 'unknown_sector',
      });
    }

    res.json(detail);
  } catch (error) {
    next(error);
  }
});

marketRouter.get('/movers', async (req, res, next) => {
  try {
    // Clamped rather than rejected, like every other count on this router. 25 is the
    // point past which "movers" stops meaning anything.
    const count = boundedInt(req.query.count, 5, 1, 25);
    const movers = await getMovers(count);

    res.json({
      ...movers,
      count,
      // The freshest quote on the board, not the clock — the same argument
      // /quotes makes. Null when there is nothing priced at all.
      asOf:
        [...movers.gainers, ...movers.losers, ...movers.mostActive].reduce(
          (latest, quote) => (latest === null || quote.updatedAt > latest ? quote.updatedAt : latest),
          null,
        ),
    });
  } catch (error) {
    next(error);
  }
});

marketRouter.get('/instruments/:symbol', async (req, res, next) => {
  try {
    const quote = await getQuote(req.params.symbol);
    if (!quote) {
      throw new ApiError(`Unknown symbol "${req.params.symbol}".`, { status: 404, code: 'unknown_symbol' });
    }
    const sparklines = await getSparklines([quote.symbol]);
    res.json({ ...quote, sparkline: sparklines.get(quote.symbol) ?? [] });
  } catch (error) {
    next(error);
  }
});

/**
 * A symbol's bars, and the one market read worth answering conditionally.
 *
 * Everything else here is repriced on a two-second tick, so a validator on
 * `/instruments` would be a new number every time it was asked for. Bars are the
 * exception, and `getHistoryVersion` has the argument for how far that goes: a 1Y
 * chart is 252 bars that cannot change at all, and today every request for one is
 * answered in full.
 *
 * Express has been generating an ETag for this response all along and no browser has
 * ever used it, because without a `Cache-Control` there is nothing to say the
 * response may be stored — so nothing is stored, and `If-None-Match` is never sent.
 * The header is the half that was missing.
 *
 * `no-cache` rather than a `max-age`, even for bars that are immutable by
 * construction: `npm run seed -- --reset` replaces the whole calendar in place, and a
 * client holding a freely reusable copy would keep drawing a chart that disagrees
 * with every other number on the page until its own clock ran out. Revalidating costs
 * a round trip and is right at every moment in between.
 */
marketRouter.get('/instruments/:symbol/history', async (req, res, next) => {
  try {
    const range = String(req.query.range ?? '1D').toUpperCase();
    if (!HISTORY_RANGES.has(range)) {
      throw new ApiError(`Unsupported range "${range}". Supported: ${[...HISTORY_RANGES].join(', ')}`, {
        status: 400,
        code: 'invalid_range',
      });
    }

    // An unknown symbol is a 404; a known symbol with no bars yet is an empty list.
    if (!(await isKnownSymbol(req.params.symbol))) {
      throw new ApiError(`Unknown symbol "${req.params.symbol}".`, { status: 404, code: 'unknown_symbol' });
    }

    const version = await getHistoryVersion(req.params.symbol, range);
    res.set('Cache-Control', 'private, no-cache');

    if (version) {
      const etag = `W/"${version}"`;
      res.set('ETag', etag);
      // Answering here, off one index lookup, rather than letting `res.json` reach the
      // same conclusion after the fact is the entire point of versioning the bars
      // separately from reading them — it is what keeps 252 rows in the database
      // instead of on the wire.
      if (matchesEntityTag(req.headers['if-none-match'], etag)) {
        res.status(304).end();
        return;
      }
    }

    res.json(await getHistory(req.params.symbol, range));
  } catch (error) {
    next(error);
  }
});

/**
 * Whether the client already holds this version of the bars.
 *
 * Deliberately not `req.fresh`, which Express offers for exactly this and which
 * refuses any conditional request that also carries `Cache-Control: no-cache`. That
 * is a rule for caches — an end-to-end reload has to be allowed to reach the origin —
 * and this is the origin, which RFC 9110 §13.2.2 says evaluates `If-None-Match`
 * whatever else the request asks of the caches in front of it.
 *
 * The distinction is not academic. `fetch()` appends `Cache-Control: no-cache` by
 * itself the moment a caller sets `If-None-Match` by hand, so deferring to `req.fresh`
 * would have made this work for a browser revalidating its own cache and never once
 * for a client written against the API — the load generator, a script, anything that
 * holds an ETag deliberately.
 *
 * Comparison is weak, which is the only kind `If-None-Match` permits (RFC 9110
 * §13.1.2): `W/"x"` and `"x"` name the same bars here, so the prefix comes off both
 * sides. `*` means "any representation at all", and the caller only gets this far
 * when there is one.
 */
function matchesEntityTag(header, etag) {
  if (!header) return false;
  if (header.trim() === '*') return true;
  const opaque = (tag) => tag.trim().replace(/^W\//, '');
  return header.split(',').some((candidate) => opaque(candidate) === opaque(etag));
}

module.exports = { marketRouter };
