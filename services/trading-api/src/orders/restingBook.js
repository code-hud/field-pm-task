/**
 * Filling the orders that are waiting.
 *
 * An open limit order is a standing instruction: fill me when the tape reaches this
 * price. Something has to notice, and the natural place is the moment the prices
 * change — so this runs at the end of each market tick, on the replica that already
 * holds the writer lock.
 *
 * <b>Why the ticker rather than a timer of its own.</b> Two reasons, and both are
 * about correctness rather than tidiness. The sweep has to run *after* the new quotes
 * are visible, or it matches against the prices it was about to replace. And the
 * ticker is already leader-elected, so exactly one process in the cluster matches —
 * two sweepers racing on the same open order is the failure mode that produces two
 * fills for one instruction, and this design has no way to reach it.
 *
 * That argument is about replicas. Inside one, the ticker's own re-entrancy guard is
 * what stops a pass from overlapping the next; see `runScheduledTick`.
 *
 * <b>What it must never do is stop the tape.</b> A market that stops repricing
 * because an order could not fill would turn a small problem into the visible one.
 * Every failure here is caught, logged and left behind; the order stays open and the
 * next tick tries again.
 */
const { config } = require('../config/index.js');
const { pool, transaction } = require('../db/pool.js');
const { executeOrder, PriceMovedAway } = require('./orderService.js');

/**
 * Orders the tape has reached, oldest first, starting after `cursor`.
 *
 * Time priority, which is the one rule every venue shares: an order that has waited
 * longer goes first. It matters here whenever two orders on one account compete for
 * the same cash — the first one in gets it, rather than whichever the planner
 * happened to return first.
 *
 * <b>The cursor is a keyset, not an offset.</b> The row it names may have filled or
 * been cancelled by the time the next pass runs, so there is no stable row count to
 * skip; the predicate is a tuple comparison against the sort key itself. It has to be
 * the *tuple* rather than `placed_at` alone, because ties on that column are ordinary
 * here — the load generator places bursts inside a millisecond — and a comparison on
 * the timestamp alone silently skips every order sharing one with the cursor.
 *
 * Read outside any transaction on purpose. Each fill takes its own lock and re-checks
 * its own price, so this is a shortlist rather than a decision; holding a transaction
 * open across every fill would serialise the whole book behind the slowest one.
 */
async function marketableOrders(limit, cursor = null) {
  const { rows } = await pool.query(
    `SELECT o.id, o.account_id, o.symbol, o.side, o.quantity, o.limit_price, o.placed_at
     FROM orders o
     JOIN quotes q ON q.symbol = o.symbol
     WHERE o.status = 'OPEN'
       AND ((o.side = 'BUY'  AND q.price <= o.limit_price)
         OR (o.side = 'SELL' AND q.price >= o.limit_price))
       AND ($2::timestamptz IS NULL OR (o.placed_at, o.id) > ($2, $3))
     ORDER BY o.placed_at, o.id
     LIMIT $1`,
    [limit, cursor?.placedAt ?? null, cursor?.id ?? null],
  );
  return rows;
}

const NOTHING_TO_DO = { considered: 0, filled: 0, skipped: 0, failed: 0, cursor: null };

/**
 * Fill the resting orders the tape has reached, for as long as there is time.
 *
 * <b>The pass is bounded and resumable, and that changes what the sweep promises.</b>
 * It used to shortlist the first 200 marketable orders every tick and work through
 * them, which reads as strict global time priority and is not: past 200 the tail was
 * never looked at at all, and an order that failed stayed at the head of the list
 * occupying a slot on every subsequent tick. Both are starvation, and the second one
 * is permanent.
 *
 * With a budget and a cursor the promise becomes <em>time priority within a pass,
 * with bounded staleness across passes</em>: an order that becomes marketable
 * mid-pass and sorts before the cursor waits until the pass wraps. That is weaker on
 * paper and stronger in practice, because it is kept — every open order is reached
 * within one full traversal, however long the book is and however many of its
 * members are failing.
 *
 * @param budgetMs wall-clock ceiling for the pass. 0 means no ceiling, which is what
 *   a caller driving this directly wants; the ticker always passes one.
 * @param cursor where the previous pass stopped, or null to start from the head.
 * @returns counts, plus the cursor for the next pass — null when the book was read to
 *   the end, which is the signal to start again from the head.
 */
async function sweepRestingOrders({ limit = 200, budgetMs = 0, cursor = null, clock = Date.now } = {}) {
  const startedAt = clock();
  const candidates = await marketableOrders(limit, cursor);

  // Nothing left after the cursor means the pass reached the end of the book, so the
  // next one starts from the head. Returning the cursor unchanged here would wedge
  // the sweep at the tail forever.
  if (candidates.length === 0) return NOTHING_TO_DO;

  let filled = 0;
  let skipped = 0;
  let failed = 0;

  // One transaction per order, in sequence. Not one transaction for the batch: a
  // single order that cannot fill would roll back every fill beside it, and orders
  // that have nothing to do with each other should not share a fate. Not in parallel
  // either — orders on one account contend for the same row lock, and the ordering
  // above is the tie-break that would be thrown away.
  let processed = 0;
  let last = null;

  for (const candidate of candidates) {
    // Checked before the order rather than after, so the budget bounds when the pass
    // *stops* rather than how far it overruns. A fill can take a
    // DB_FILL_STATEMENT_TIMEOUT_MS, so the ceiling is only ever approximate — this
    // keeps the overrun to one order instead of to one order per remaining candidate.
    if (budgetMs > 0 && clock() - startedAt >= budgetMs) break;

    try {
      await transaction((tx) =>
        executeOrder(
          tx,
          candidate.account_id,
          {
            side: candidate.side,
            symbol: candidate.symbol,
            quantity: Number(candidate.quantity),
            type: 'LIMIT',
            limitPrice: Number(candidate.limit_price),
          },
          { restingOrderId: candidate.id },
        ),
      );
      filled += 1;
    } catch (error) {
      if (error instanceof PriceMovedAway) {
        // The tape moved back between the shortlist and the lock, or something else
        // resolved the order first. Neither is a problem; it stays open.
        skipped += 1;
      } else {
        failed += 1;
        // Left open deliberately. By construction this should be unreachable for the
        // usual refusals — a buy reserves cash at its limit and a sell reserves the
        // shares, so an accepted order stays fillable — which is exactly why an
        // exception here is worth a line rather than a silent retry forever.
        console.warn(
          `[${config.serviceName}] resting order ${candidate.id} (${candidate.side} ` +
            `${candidate.quantity} ${candidate.symbol}) could not fill: ${error.message}`,
        );
      }
    }

    // Advanced for every outcome, including the failures. An order that cannot fill
    // must not be re-attempted ahead of everything behind it on the next pass —
    // leaving the cursor behind it is exactly the head-of-line blocking this change
    // exists to remove. It stays open and gets its turn again on the next wrap.
    processed += 1;
    last = { placedAt: candidate.placed_at, id: candidate.id };
  }

  return {
    considered: processed,
    filled,
    skipped,
    failed,
    // Null when the pass ran out of book rather than out of time: a short page means
    // there was nothing after these, so the next pass starts from the head. Anything
    // else resumes after the last order this pass touched.
    cursor: processed === candidates.length && candidates.length < limit ? null : last,
  };
}

module.exports = { marketableOrders, sweepRestingOrders };
