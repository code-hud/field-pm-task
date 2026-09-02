/**
 * Realized P/L, broken down by what was actually sold.
 *
 * Two sources, and the difference between them is the point.
 *
 * `trades.realized_pnl` is the **authority**: every sale this account has ever made
 * carries one, so summing it gives a total that is complete for all time. That is the
 * number the portfolio header already shows, and this endpoint must never contradict it.
 *
 * `lot_closures` is the **explanation**: which purchases each sale consumed, what they
 * cost, and what they fetched. It only exists for sales made after `004_lot_closures.sql`,
 * because FIFO consumption order was never written down before that and inventing one
 * would look complete while being fiction.
 *
 * So the response reports both and names the gap. `attributedPnl` is what the closures
 * explain, `unattributedPnl` is the rest, and the two always add to the authority. A
 * reader who sees a breakdown that does not sum to the total they know is owed an answer
 * for why, and "these sales predate the record" is one; silence is not.
 *
 * <b>The short/long split here is a holding period, not tax advice.</b> It applies the
 * one-year test to the lot's own dates and stops there. Real lot accounting also has wash
 * sales, corporate actions, gifted and inherited basis, and elections that override the
 * calendar entirely — none of which this demo models, and all of which can move a lot
 * from one side of the line to the other.
 */
const { query } = require('../db/pool.js');

const round2 = (value) => Math.round(value * 100) / 100;
// Holding periods are reported to a tenth of a day. Whole days would round a
// share-weighted mean of 41.4 and 41.6 to the same number, and the whole reason the
// mean is weighted is that those are different facts.
const round1 = (value) => Math.round(value * 10) / 10;
const pct = (part, whole) => (whole > 0 ? round2((part / whole) * 100) : 0);

/**
 * One side of the holding-period split, from its grouped row.
 *
 * A symbol with nothing on one side gets zeroes rather than a missing key: "no
 * long-term gains" is a fact about the account, and a caller should not have to
 * distinguish it from a field this endpoint forgot to send.
 */
const termOf = (row) => ({
  closures: row?.closures ?? 0,
  shares: row?.shares ?? 0,
  realizedPnl: round2(row?.realized ?? 0),
  winners: row?.winners ?? 0,
  losers: row?.losers ?? 0,
  averageHoldingDays: row?.shares > 0 ? round1(row.share_days / row.shares) : 0,
});

/** Adds one grouped row into a running total for its side of the line. */
const addTerm = (total, row) => ({
  closures: total.closures + (row?.closures ?? 0),
  shares: total.shares + (row?.shares ?? 0),
  realized: total.realized + Number(row?.realized ?? 0),
  winners: total.winners + (row?.winners ?? 0),
  losers: total.losers + (row?.losers ?? 0),
  shareDays: total.shareDays + Number(row?.share_days ?? 0),
});

const NO_TERM = { closures: 0, shares: 0, realized: 0, winners: 0, losers: 0, shareDays: 0 };

const summarisedTerm = (total) => ({
  closures: total.closures,
  shares: total.shares,
  realizedPnl: round2(total.realized),
  winners: total.winners,
  losers: total.losers,
  averageHoldingDays: total.shares > 0 ? round1(total.shareDays / total.shares) : 0,
});

/**
 * What the account has realized, and on what.
 *
 * Wins and losses are counted per **closure**, not per sale — a closure is one round
 * trip, a specific purchase bought and sold, which is the unit the money was actually
 * made on. One sale that empties a profitable lot and a losing one is a win and a loss,
 * and calling it a single "winning trade" because the net came out positive would hide
 * the losing half from every count on this page.
 */
async function getRealizedBreakdown(user) {
  const { rows: totalRows } = await query(
    `SELECT COALESCE(SUM(t.realized_pnl), 0)                      AS realized,
            count(*)::int                                         AS sales,
            count(*) FILTER (WHERE attributed.trade_id IS NULL)::int AS unattributed_sales
     FROM trades t
     -- Distinct first: a sale spanning three lots has three closure rows, and joining
     -- them directly would count that sale three times in both figures above.
     LEFT JOIN (SELECT DISTINCT trade_id FROM lot_closures WHERE account_id = $1) attributed
            ON attributed.trade_id = t.id
     WHERE t.account_id = $1 AND t.side = 'SELL'`,
    [user.id],
  );

  const { rows } = await query(
    `SELECT c.symbol, i.name, i.sector,
            count(*)::int                                    AS closures,
            count(DISTINCT c.trade_id)::int                  AS sales,
            SUM(c.quantity)::bigint                          AS shares,
            -- Gross, at the lot's own precision. These are context, not the
            -- authority: realized_pnl carries the reconciliation that makes the
            -- slices add up to the trade, so it can differ from proceeds minus cost
            -- by the odd cent. Reporting that difference as if it were a gain is the
            -- mistake this comment exists to prevent.
            SUM(c.quantity * c.sale_price)                   AS proceeds,
            SUM(c.quantity * c.cost_price)                   AS cost_of_sold,
            SUM(c.realized_pnl)                              AS realized,
            count(*) FILTER (WHERE c.realized_pnl > 0)::int  AS winners,
            count(*) FILTER (WHERE c.realized_pnl < 0)::int  AS losers,
            MAX(c.realized_pnl)                              AS best,
            MIN(c.realized_pnl)                              AS worst,
            MIN(c.closed_on)                                 AS first_closed_on,
            MAX(c.closed_on)                                 AS last_closed_on
     FROM lot_closures c
     JOIN instruments i ON i.symbol = c.symbol
     WHERE c.account_id = $1
     GROUP BY c.symbol, i.name, i.sector
     -- Biggest contribution first, then alphabetically, so two symbols that made the
     -- same money do not swap places between requests.
     ORDER BY SUM(c.realized_pnl) DESC, c.symbol`,
    [user.id],
  );

  // Grouped a second time, by symbol *and* holding period, rather than folded into the
  // query above. `sales` there is a DISTINCT count of trade ids, and one sale can close a
  // lot held for years alongside one bought last week — so the two term rows would each
  // claim that sale and summing them would count it twice. Splitting the questions keeps
  // each count over the grouping it is actually true for.
  const { rows: termRows } = await query(
    `WITH closed AS (
       SELECT c.symbol,
              c.quantity,
              c.realized_pnl,
              (c.closed_on - c.opened_on)::int AS held_days,
              -- More than one year, and expressed as an interval rather than a count of
              -- days. Postgres' calendar knows which Februaries have 29 days; a constant
              -- 365 is wrong for every lot whose year contained one, and wrong in the
              -- direction that reports a long-term gain as short-term.
              (c.closed_on > c.opened_on + INTERVAL '1 year') AS long_term
       FROM lot_closures c
       WHERE c.account_id = $1
     )
     SELECT symbol,
            long_term,
            count(*)::int                                  AS closures,
            SUM(quantity)::bigint                           AS shares,
            SUM(realized_pnl)                               AS realized,
            count(*) FILTER (WHERE realized_pnl > 0)::int   AS winners,
            count(*) FILTER (WHERE realized_pnl < 0)::int   AS losers,
            -- Share-days, so the mean can be weighted below. A 500-share lot held two
            -- years and a single share flipped the same afternoon are not the same fact
            -- about an account, and an unweighted mean says they are.
            SUM(quantity * held_days)::bigint               AS share_days,
            MIN(held_days)::int                             AS shortest,
            MAX(held_days)::int                             AS longest
     FROM closed
     GROUP BY symbol, long_term`,
    [user.id],
  );

  const terms = new Map();
  for (const row of termRows) {
    const forSymbol = terms.get(row.symbol) ?? {};
    forSymbol[row.long_term ? 'longTerm' : 'shortTerm'] = row;
    terms.set(row.symbol, forSymbol);
  }

  const bySymbol = rows.map((row) => ({
    symbol: row.symbol,
    name: row.name,
    sector: row.sector,
    closures: row.closures,
    sales: row.sales,
    shares: row.shares,
    proceeds: round2(row.proceeds),
    costOfSold: round2(row.cost_of_sold),
    realizedPnl: round2(row.realized),
    // Against what the shares cost, which is what "how did this trade do" means.
    // Against proceeds it would flatter every position, since proceeds include the
    // gain being measured.
    returnPercent: pct(row.realized, row.cost_of_sold),
    winners: row.winners,
    losers: row.losers,
    bestClosure: round2(row.best),
    worstClosure: round2(row.worst),
    firstClosedOn: row.first_closed_on,
    lastClosedOn: row.last_closed_on,
    shortTerm: termOf(terms.get(row.symbol)?.shortTerm),
    longTerm: termOf(terms.get(row.symbol)?.longTerm),
    averageHoldingDays: round1(
      ((terms.get(row.symbol)?.shortTerm?.share_days ?? 0) +
        (terms.get(row.symbol)?.longTerm?.share_days ?? 0)) /
        Math.max(row.shares, 1),
    ),
  }));

  const sum = (pick) => round2(bySymbol.reduce((total, entry) => total + pick(entry), 0));

  const shortTerm = termRows
    .filter((row) => !row.long_term)
    .reduce(addTerm, NO_TERM);
  const longTerm = termRows.filter((row) => row.long_term).reduce(addTerm, NO_TERM);
  const heldShares = shortTerm.shares + longTerm.shares;
  const heldShareDays = shortTerm.shareDays + longTerm.shareDays;

  const realized = round2(Number(totalRows[0].realized));
  const attributed = sum((entry) => entry.realizedPnl);
  const winners = bySymbol.reduce((total, entry) => total + entry.winners, 0);
  const losers = bySymbol.reduce((total, entry) => total + entry.losers, 0);
  const closures = bySymbol.reduce((total, entry) => total + entry.closures, 0);

  return {
    summary: {
      // The authority. Equal to what /api/portfolio reports, by construction.
      realizedPnl: realized,
      attributedPnl: attributed,
      // Always `realizedPnl - attributedPnl`, so the breakdown below is never quietly
      // short of the total a reader arrived with.
      unattributedPnl: round2(realized - attributed),
      sales: totalRows[0].sales,
      // Sales this endpoint can say nothing about, because they happened before the
      // closures were recorded. The count is here so the gap has a size as well as a
      // value — one ancient sale worth thousands reads very differently from forty.
      unattributedSales: totalRows[0].unattributed_sales,
      closures,
      shares: bySymbol.reduce((total, entry) => total + entry.shares, 0),
      proceeds: sum((entry) => entry.proceeds),
      costOfSold: sum((entry) => entry.costOfSold),
      winners,
      losers,
      // Neither a win nor a loss: a lot sold for exactly what it cost. Counted rather
      // than folded into either side, so `winners + losers` never has to be read as
      // "everything except the ties".
      flat: closures - winners - losers,
      // Of the closures with an outcome. A tie is not a loss, and dividing by every
      // closure would report one as though it were.
      winRatePercent: pct(winners, winners + losers),
      bestClosure: bySymbol.length ? Math.max(...bySymbol.map((entry) => entry.bestClosure)) : 0,
      worstClosure: bySymbol.length ? Math.min(...bySymbol.map((entry) => entry.worstClosure)) : 0,
      symbols: bySymbol.length,
      // Split by how long the shares were held, using the one-year test on the lot's
      // own dates. The two sides always add back to `attributedPnl`: every closure is
      // on exactly one side of the line, and the line is a date comparison with no
      // third answer.
      shortTerm: summarisedTerm(shortTerm),
      longTerm: summarisedTerm(longTerm),
      // Weighted by shares, for the reason the SQL gives: an account that flipped one
      // share this morning and has held five hundred for three years did not "average
      // eighteen months".
      averageHoldingDays: heldShares > 0 ? round1(heldShareDays / heldShares) : 0,
      shortestHoldDays: termRows.length ? Math.min(...termRows.map((row) => row.shortest)) : 0,
      longestHoldDays: termRows.length ? Math.max(...termRows.map((row) => row.longest)) : 0,
    },
    bySymbol,
    asOf: new Date().toISOString(),
  };
}

module.exports = { getRealizedBreakdown };
