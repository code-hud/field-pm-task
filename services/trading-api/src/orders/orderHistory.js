/**
 * Reading the order log.
 *
 * Separate from `orderService.js`, which places orders — the two share a table and
 * nothing else. Everything here is a read, and none of it can move money.
 *
 * The log answers a question the ledger cannot. `/api/portfolio/transactions` lists
 * what happened to the account: deposits, fills, dividends. This lists what was
 * *asked for*, which includes the orders that were refused and the reason each one
 * was. An account that tried to sell shares it did not have four times this morning
 * looks identical to a quiet one in the ledger, and that is exactly the morning
 * somebody wants to see.
 */
const { ApiError } = require('../middleware/errors.js');
const { query } = require('../db/pool.js');

const STATUSES = new Set(['FILLED', 'REJECTED', 'OPEN', 'CANCELLED']);

const round2 = (value) => Math.round(value * 100) / 100;

const toOrder = (row) => ({
  id: row.id,
  symbol: row.symbol,
  name: row.name,
  side: row.side,
  type: row.type,
  quantity: row.quantity,
  // The price the order named, and null for a market order that named none. On an
  // open order this is the whole point of the row — a waiting order with no visible
  // limit gives a reader no way to tell what it is waiting for.
  limitPrice: row.limit_price === null ? null : Number(row.limit_price),
  status: row.status,
  filledQuantity: row.filled_quantity,
  // Null rather than 0 on a rejection: 0 is a price, and this order never had one.
  fillPrice: row.fill_price === null ? null : Number(row.fill_price),
  notional: row.fill_price === null ? null : round2(row.filled_quantity * row.fill_price),
  tradeId: row.trade_id,
  rejectCode: row.reject_code,
  rejectReason: row.reject_reason,
  placedAt: row.placed_at,
  resolvedAt: row.resolved_at,
});

/**
 * One page of the account's orders, newest first.
 *
 * `total` counts the rows matching the same filters, not the account's orders
 * overall — it is what a pager needs, and a count over a different set than the one
 * being displayed is how a list ends up claiming there are more pages of something
 * than exist. A caller wanting "how many were rejected" asks with that filter.
 */
async function listOrders(user, { status, symbol, limit = 50, offset = 0 } = {}) {
  const { rows } = await query(
    `SELECT o.*, i.name, count(*) OVER () AS total
     FROM orders o
     JOIN instruments i ON i.symbol = o.symbol
     WHERE o.account_id = $1
       AND ($2::text IS NULL OR o.status = $2)
       AND ($3::text IS NULL OR o.symbol = $3)
     -- id as the tiebreak, not just the timestamp: a market order is placed and
     -- resolved inside one transaction, so several can share a placed_at to the
     -- microsecond, and an unstable order would shuffle rows between pages.
     ORDER BY o.placed_at DESC, o.id DESC
     LIMIT $4 OFFSET $5`,
    [user.id, status ?? null, symbol ?? null, limit, offset],
  );

  return {
    orders: rows.map(toOrder),
    // 0 when the page is empty: the window function has no row to report from, and
    // an offset past the end is a legitimate way to get here.
    total: rows.length === 0 ? 0 : Number(rows[0].total),
    limit,
    offset,
  };
}

/**
 * One order, or a 404.
 *
 * Another account's order is a 404, not a 403. A 403 would confirm the id exists,
 * which is the one thing a stranger guessing ids should not be able to learn.
 */
async function getOrder(user, id) {
  const { rows } = await query(
    `SELECT o.*, i.name FROM orders o
     JOIN instruments i ON i.symbol = o.symbol
     WHERE o.id = $1 AND o.account_id = $2`,
    [id, user.id],
  );
  if (rows.length === 0) {
    throw new ApiError(`No order ${id} on this account.`, { status: 404, code: 'order_not_found' });
  }
  return toOrder(rows[0]);
}

module.exports = { getOrder, listOrders, STATUSES };
