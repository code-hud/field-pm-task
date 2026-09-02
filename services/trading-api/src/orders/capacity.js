/**
 * What an account can still commit.
 *
 * A resting order is a promise the account has already made. Ignoring it would let
 * the same cash back two orders and the same shares back two sales, and both would
 * be discovered at the worst possible moment — when the second one fills.
 *
 * <b>Reservations are derived, never stored.</b> There is no `reserved_cash` column,
 * because a running total maintained alongside the orders is a total that can
 * disagree with them, and the disagreement is silent. The same argument the portfolio
 * reads make about cost basis: one source of truth, so there is nothing to drift.
 *
 * <b>A buy reserves at its limit</b>, which is the worst it can cost. That is not
 * conservatism for its own sake — it is what makes an open buy order guaranteed
 * fillable later. The order can only ever fill at or below the price its reservation
 * was taken at, so the money set aside when it was accepted is always enough when the
 * tape finally reaches it.
 */
const { query } = require('../db/pool.js');

const round2 = (value) => Math.round(value * 100) / 100;

/**
 * Cash already committed to open buy orders.
 *
 * @param exclude an order to leave out — the one currently filling. Without this a
 *   resting order would be counted as competing with itself, and every sweep fill
 *   would look unaffordable by exactly its own notional.
 */
async function reservedCash(tx, accountId, exclude = null) {
  const { rows } = await (tx ?? { query }).query(
    `SELECT COALESCE(SUM(quantity * limit_price), 0) AS reserved
     FROM orders
     WHERE account_id = $1 AND status = 'OPEN' AND side = 'BUY'
       AND ($2::bigint IS NULL OR id <> $2)`,
    [accountId, exclude],
  );
  return round2(Number(rows[0].reserved));
}

/** Shares of one symbol already committed to open sell orders. */
async function reservedShares(tx, accountId, symbol, exclude = null) {
  const { rows } = await (tx ?? { query }).query(
    `SELECT COALESCE(SUM(quantity), 0)::bigint AS reserved
     FROM orders
     WHERE account_id = $1 AND symbol = $2 AND status = 'OPEN' AND side = 'SELL'
       AND ($3::bigint IS NULL OR id <> $3)`,
    [accountId, symbol, exclude],
  );
  return Number(rows[0].reserved);
}

module.exports = { reservedCash, reservedShares };
