/**
 * Orders, filled against the live tape.
 *
 * There is no resting book yet: an order is validated and filled at the current quote,
 * and a limit that the market does not reach is refused rather than held. A limit
 * order therefore does one job here — it puts a floor or a ceiling on the price — and
 * it does it well: the marketability test runs against the same quote row the fill
 * uses, inside the same transaction, so it cannot be beaten by the tape moving.
 * Every fill writes three things in one transaction —
 *
 *   1. a row in `trades`, which is append-only and is what history is read from,
 *   2. the effect on `lots`, which tracks what is still held for cost basis,
 *   3. the cash movement on the account.
 *
 * A sale writes a fourth: a row in `lot_closures` for each lot it consumed, saying
 * which purchase was sold, what it cost, and when it was bought. `lots` cannot
 * answer that afterwards — `closed_quantity` is a running total, so once it moves
 * the order the shares went in is gone.
 *
 * And every fill writes a fifth: the order itself, in `orders`. Today that is nearly
 * redundant with the trade — a market order is accepted and filled in the same
 * transaction, so the two describe one event. It stops being redundant the moment an
 * order can exist without having filled, which is what `orders` is here for.
 *
 * The split matters. `trades` is immutable, so a past session's reported value is a
 * function of the trades dated on or before it and cannot change afterwards. `lots`
 * is mutable — a sale raises `closed_quantity` — but nothing historical reads it,
 * so mutating it cannot rewrite the past.
 *
 * This is the shape the first version got wrong: it deleted lot rows on a sale, and
 * because the curve and the ledger were both reconstructed from surviving lots, a
 * single sale moved 222 of 251 charted sessions and shrank the ledger by an entry.
 *
 * One thing about this endpoint is *not* real: part of its latency is simulated. See
 * `payFillCost` below for what is added, why, and why it happens outside the transaction.
 */
const { ApiError } = require('../middleware/errors.js');
const { config } = require('../config/index.js');
const { simulatedCost } = require('../lib/daypart.js');
const { query, transaction } = require('../db/pool.js');
const { reservedCash, reservedShares } = require('./capacity.js');
const { fraudScreeningEnabled, screenTrade } = require('../fraud/fraudClient.js');
const { setContext } = require('../observability/telemetry.js');

const SIDES = new Set(['BUY', 'SELL']);

// Guards the arithmetic rather than the business: a quantity this large overflows
// numeric(18,2) on the notional long before anyone could afford it.
const MAX_QUANTITY = 1_000_000;

const TYPES = new Set(['MARKET', 'LIMIT']);

// The range a `numeric(18,4)` price column can hold honestly. The floor is one tick:
// anything smaller stores as 0.0000 and trips the column's own `> 0` check, which
// would surface as a 500 rather than the 400 it is.
const MIN_PRICE = 0.0001;
const MAX_PRICE = 1_000_000;
const PRICE_DECIMALS = 4;

const round2 = (value) => Math.round(value * 100) / 100;
const round4 = (value) => Math.round(value * 10000) / 10000;

/**
 * A `date` column, back to the `YYYY-MM-DD` Postgres will read as the same day.
 *
 * Normally a no-op: `src/db/pool.js` pins the DATE parser to the identity, precisely
 * so a calendar date never becomes a `Date` and picks up a timezone on the way past.
 * The branch is here because this is the one place that sends a date *back* — a lot's
 * open date is what a holding period is measured from, and if that parser is ever
 * relaxed, the default is a Date at local midnight whose `toISOString()` lands on the
 * previous day anywhere west of UTC. Formatting with the local accessors round-trips
 * whatever the parser decides, so the failure stays impossible rather than merely
 * unlikely.
 */
const isoDate = (value) =>
  value instanceof Date
    ? `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(
        value.getDate(),
      ).padStart(2, '0')}`
    : String(value);

/**
 * The simulated cost of a fill, paid before the transaction opens.
 *
 * **Why any is added.** A market order here is nine indexed statements against small
 * tables, averaging 0.1ms each; the endpoint averages ~14ms and its p50 and p90 sit a few
 * milliseconds apart. Honest, and a distribution nothing can be read from — no spread, no
 * tail, and so no way to tell a bad deploy from a busy afternoon in a graph.
 *
 * **Why it is here and not inside `transaction()`.** A fill holds `FOR UPDATE` on the
 * account row from the moment it reads it. Sleeping under that lock would serialise every
 * other order on the same account behind this one, and would count against
 * `DB_FILL_STATEMENT_TIMEOUT_MS`. The same argument the fraud client makes about not
 * screening under the lock applies with more force to a deliberate wait.
 *
 * Seeded from the order and the ET minute, so the same order twice in one minute costs
 * the same — which keeps a retried request from looking like the source of the variance.
 */
async function payFillCost(user, order) {
  const shape = config.orders.latency;
  if (!shape.enabled) return;

  const cost = simulatedCost(`${user.id}:${order.symbol}:${order.side}:${order.quantity}`, shape);
  if (cost.ms <= 0) return;

  // Dimensions, not a log line: "were the slow fills slow because of the day or because
  // they stalled" is then a question the traces can answer by grouping rather than by grep.
  setContext({ fillCostMs: cost.ms, loadFactor: Number(cost.factor.toFixed(3)), fillStalled: cost.stalled });

  await new Promise((resolve) => {
    const timer = setTimeout(resolve, cost.ms);
    // Unref'd so a pending wait cannot hold the process open through a shutdown. The
    // request is already in flight and will be answered; what must not happen is the
    // container failing to stop because a simulated cost is outstanding.
    timer.unref();
  });
}

/** Rejects anything the database or the arithmetic could not represent honestly. */
function parseOrder(body) {
  const side = String(body?.side ?? '').trim().toUpperCase();
  if (!SIDES.has(side)) {
    throw new ApiError(`Unsupported side "${body?.side ?? ''}". Supported: BUY, SELL.`, {
      status: 400,
      code: 'invalid_side',
    });
  }

  const symbol = String(body?.symbol ?? '').trim().toUpperCase();
  if (!symbol) {
    throw new ApiError('A symbol is required.', { status: 400, code: 'symbol_required' });
  }

  const quantity = Number(body?.quantity);
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_QUANTITY) {
    throw new ApiError(`Quantity must be a whole number between 1 and ${MAX_QUANTITY}.`, {
      status: 400,
      code: 'invalid_quantity',
    });
  }

  const type = String(body?.type ?? 'MARKET').trim().toUpperCase();
  if (!TYPES.has(type)) {
    throw new ApiError(`Unsupported order type "${type}". Supported: ${[...TYPES].join(', ')}.`, {
      status: 400,
      code: 'invalid_order_type',
    });
  }

  return { side, symbol, quantity, type, limitPrice: parseLimitPrice(body, type) };
}

/**
 * The price a limit order names, or null for a market order.
 *
 * <b>Too much precision is refused, not rounded.</b> Rounding 41.33335 to 41.3334 for
 * a buy raises the price the customer authorised — by a hundredth of a cent, on an
 * order they were explicit about. The whole point of a limit is that the number came
 * from them. Refusing is a 400 they can fix; rounding is a fill they did not ask for.
 *
 * Exponent notation is refused for the same reason: `1e-7` is not a price anybody
 * typed, and whatever it was meant to be, guessing is worse than asking.
 */
function parseLimitPrice(body, type) {
  const raw = body?.limitPrice;

  if (type !== 'LIMIT') {
    if (raw !== undefined && raw !== null) {
      throw new ApiError('Only LIMIT orders carry a limit price.', {
        status: 400,
        code: 'unexpected_limit_price',
      });
    }
    return null;
  }

  if (raw === undefined || raw === null || raw === '') {
    throw new ApiError('A LIMIT order needs a limitPrice.', {
      status: 400,
      code: 'limit_price_required',
    });
  }

  const limitPrice = Number(raw);
  const written = String(raw);
  const decimals = written.includes('.') ? written.split('.')[1].length : 0;

  if (
    !Number.isFinite(limitPrice) ||
    limitPrice < MIN_PRICE ||
    limitPrice > MAX_PRICE ||
    written.toLowerCase().includes('e') ||
    decimals > PRICE_DECIMALS
  ) {
    throw new ApiError(
      `limitPrice must be between ${MIN_PRICE} and ${MAX_PRICE} with at most ` +
        `${PRICE_DECIMALS} decimal places, not "${raw}".`,
      { status: 400, code: 'invalid_limit_price' },
    );
  }

  return limitPrice;
}

/**
 * Whether a limit order can fill against this quote.
 *
 * A buy fills at or below its limit, a sell at or above. Equality fills: a limit is
 * the worst price acceptable, not a price to beat.
 */
const isMarketable = (side, limitPrice, price) =>
  side === 'BUY' ? price <= limitPrice : price >= limitPrice;

/**
 * The current quote, read outside any transaction, for the fraud service's benefit.
 *
 * Raises the same 404 the fill would, which is what keeps an unknown symbol looking
 * identical to the client whether screening is on or off — and saves a screening call
 * for a trade that could never have been filled.
 */
async function quotedPrice(symbol) {
  const { rows } = await query('SELECT price FROM quotes WHERE symbol = $1', [symbol]);
  if (rows.length === 0) {
    throw new ApiError(`Unknown symbol "${symbol}".`, { status: 404, code: 'unknown_symbol' });
  }
  return round4(rows[0].price);
}

/**
 * Withdraw a resting order.
 *
 * <b>One conditional UPDATE, not a read followed by a write.</b> The sweep is filling
 * orders on every market tick, so between reading a row and updating it the order can
 * have already traded — and a cancel that overwrote a fill would erase a trade that
 * really happened while leaving the cash movement and the lot behind. Making OPEN
 * part of the WHERE clause means the database decides which of the two got there
 * first, and the loser is told so.
 *
 * The same guard exists on the other side: the sweep's fill updates
 * `WHERE id = $1 AND status = 'OPEN'` and rolls its whole transaction back if that
 * matches nothing. Whichever arrives second finds the door shut.
 *
 * <b>No account lock, and nothing to unwind.</b> Reservations are derived from the
 * open orders rather than stored as a balance, so an order leaving OPEN releases its
 * capacity by no longer being counted. There is no second write that could fail
 * halfway and leave cash held for an order that no longer exists.
 */
async function cancelOrder(user, id) {
  const { rows } = await query(
    `UPDATE orders
        SET status = 'CANCELLED', resolved_at = now()
      WHERE id = $1 AND account_id = $2 AND status = 'OPEN'
      RETURNING id`,
    [id, user.id],
  );
  if (rows.length > 0) return rows[0].id;

  // Nothing was updated, and the two reasons are different answers. Read afterwards
  // rather than before, so the common case is one statement and this one is only
  // paid for when something actually went wrong.
  const { rows: existing } = await query(
    'SELECT status FROM orders WHERE id = $1 AND account_id = $2',
    [id, user.id],
  );

  // Another account's order is a 404 for the same reason reading one is: a 403 would
  // confirm the id exists.
  if (existing.length === 0) {
    throw new ApiError(`No order ${id} on this account.`, { status: 404, code: 'order_not_found' });
  }

  // 409, not 400: the request was well formed and would have been valid a moment
  // ago. What it conflicts with is the order's current state.
  throw new ApiError(
    `Order ${id} is ${existing[0].status.toLowerCase()} and can no longer be cancelled.`,
    { status: 409, code: 'order_not_open' },
  );
}

/** Postgres' unique_violation. Raised by the partial index on (account_id, client_order_id). */
const UNIQUE_VIOLATION = '23505';

/**
 * The order this key already placed, or null.
 *
 * Only FILLED and OPEN claim a key. A rejection does not, so a client retrying after a
 * transient 503 can still get its order placed — the alternative is a key burned by a
 * refusal the caller never even saw, which turns a retryable failure into a permanent
 * one. The cost is that a client hammering an unaffordable order is screened afresh
 * every time, which is the correct answer to a genuinely new attempt.
 */
async function existingOrderFor(accountId, clientOrderId) {
  if (!clientOrderId) return null;
  const { rows } = await query(
    `SELECT id FROM orders
      WHERE account_id = $1 AND client_order_id = $2 AND status IN ('FILLED', 'OPEN')`,
    [accountId, clientOrderId],
  );
  return rows[0]?.id ?? null;
}

/**
 * Records an order that did not fill.
 *
 * <b>Written outside the transaction, after it has already rolled back.</b> That is
 * forced, not chosen: the refusal *is* the rollback, so a row inserted inside the
 * fill's transaction would be discarded along with the reason it exists. This runs on
 * a pool connection of its own, once the failure has happened.
 *
 * Three rules it lives by.
 *
 * <b>It must never mask the original error.</b> Whatever happens in here, the caller
 * gets the refusal they were owed — a bookkeeping failure that turned
 * "insufficient cash" into a 500 would be a worse bug than not recording anything.
 * So every failure is swallowed after a warning, and the caller's error is rethrown
 * by the catch block that called this.
 *
 * <b>It records refusals of real orders only.</b> A 400 means the request was not a
 * well-formed order at all — no side, a quantity of "x" — and an unknown symbol has
 * no row in `instruments` for the foreign key to reach. Recording either would mean
 * relaxing the constraints that make this table worth having. A malformed request is
 * a client bug and belongs in the access log, not in an account's order history.
 *
 * <b>It costs one write on a path that is already failing.</b> Refusals are rare
 * against fills, and the load generator's insufficient-shares attempts are exactly
 * the ones worth being able to see afterwards.
 */
async function recordRejection(user, { symbol, side, quantity, type, limitPrice }, error) {
  try {
    const { rows } = await query(
      `INSERT INTO orders (account_id, symbol, side, type, quantity, limit_price, status,
                           filled_quantity, reject_code, reject_reason, resolved_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'REJECTED', 0, $7, $8, now())
       RETURNING id`,
      [user.id, symbol, side, type, quantity, limitPrice, error.code, error.message],
    );
    return rows[0].id;
  } catch (recordingFailed) {
    // Deliberately not rethrown. See above.
    console.warn(
      `[${config.serviceName}] could not record rejected order for ${user.id} ${side} ${symbol}:`,
      recordingFailed.message,
    );
    return null;
  }
}

/** Refusals that describe a real order, rather than a request that was never one. */
const isRecordableRefusal = (error) =>
  error instanceof ApiError && error.status !== 400 && error.code !== 'unknown_symbol';

/**
 * Screens, validates, and fills in one transaction.
 *
 * The quote is read inside the transaction and the account row is locked before the
 * balance is checked, so two concurrent orders on the same account cannot both pass
 * an affordability check against the same cash and overdraw it.
 *
 * Fraud screening happens first, and outside that transaction — see
 * `src/fraud/fraudClient.js` for why the network call must not be made under the row
 * lock, and for what happens when the fraud service cannot answer.
 *
 * Everything from screening onwards is wrapped so that a refusal is recorded before
 * it is rethrown. The wrapper starts *after* `parseOrder`, on purpose: below that
 * line there is no order to record, only a malformed request.
 */
async function placeOrder(user, body, { clientOrderId = null } = {}) {
  const parsed = { ...parseOrder(body), clientOrderId };

  // Checked before anything is screened or locked. The common case for a retry is that
  // the first attempt finished and the answer was lost, and that case should cost one
  // indexed lookup rather than a screening call and a row lock.
  const already = await existingOrderFor(user.id, clientOrderId);
  if (already !== null) return { replayed: already };

  try {
    return await fillOrder(user, parsed);
  } catch (error) {
    // The concurrent case, and the reason this is not just the lookup above. Two
    // requests with one key race; the loser blocks on the unique index until the
    // winner commits, and only then raises. By that point the loser has done the whole
    // fill — lots, closures, the trade, the cash movement — and held the account row
    // lock throughout. `transaction()` has already rolled all of it back, which is
    // what makes replaying safe rather than merely convenient.
    //
    // Deliberately not added to RETRYABLE_CODES in the pool: retrying a duplicate key
    // three times reaches the same answer three times.
    if (error?.code === UNIQUE_VIOLATION && clientOrderId) {
      const winner = await existingOrderFor(user.id, clientOrderId);
      if (winner !== null) return { replayed: winner };
    }

    // Not filed as a rejection: a duplicate key is not a refusal of the order, it is
    // this request losing a race to an order that exists. Filing it would put a
    // REJECTED row beside a FILLED one for the same intent.
    if (isRecordableRefusal(error) && error?.code !== UNIQUE_VIOLATION) {
      await recordRejection(user, parsed, error);
    }
    // The caller's error, unchanged and unconditional — including when recording it
    // failed, and including when recording it succeeded.
    throw error;
  }
}

/** The accept-and-fill path itself. Throws on any refusal; `placeOrder` records it. */
async function fillOrder(user, { side, symbol, quantity, type, limitPrice, clientOrderId }) {
  if (fraudScreeningEnabled()) {
    // An extra read of a row the transaction will read again, and worth it: a screening
    // service that cannot see the notional can only ever check the symbol and the share
    // count, and the first real rule would need a payload change to get it. Guarded so
    // that with screening off the query does not happen at all.
    await screenTrade({ accountId: user.id, symbol, side, quantity, price: await quotedPrice(symbol) });
  }

  // Last thing before the lock is taken, and deliberately after screening: the fraud call
  // is a real dependency with its own latency, and putting a simulated wait in front of it
  // would make the two indistinguishable in a trace.
  await payFillCost(user, { symbol, side, quantity });

  return transaction((tx) =>
    executeOrder(tx, user.id, { side, symbol, quantity, type, limitPrice }, { clientOrderId }),
  );
}

/**
 * Accept one order inside an open transaction: fill it, or rest it.
 *
 * Shared by the request path and the sweep that fills resting orders when the tape
 * reaches them, so both take the account lock in the same order, check capacity the
 * same way, and write the same five records. The alternative — a second copy for the
 * background path — is two fill paths that agree until one of them is edited.
 *
 * @param restingOrderId the order being filled, when this is a resting order finally
 *   going off. Null on the request path, where the order row does not exist yet.
 */
async function executeOrder(tx, accountId, order, { restingOrderId = null, clientOrderId = null } = {}) {
  const { side, symbol, quantity, type, limitPrice } = order;

  // Scoped to this transaction, so it bounds the fill without touching migrations or
  // the seed, which legitimately run long. A statement canceled by this is a race
  // rather than a refusal, and `transaction()` retries it.
  await tx.query(`SET LOCAL statement_timeout = ${config.db.fillStatementTimeoutMs}`);

  const { rows: quoteRows } = await tx.query(
    'SELECT symbol, price FROM quotes WHERE symbol = $1',
    [symbol],
  );
  if (quoteRows.length === 0) {
    throw new ApiError(`Unknown symbol "${symbol}".`, { status: 404, code: 'unknown_symbol' });
  }

  const price = round4(quoteRows[0].price);

  // Read against the same quote row the fill is about to use, and not a statement
  // earlier against the one the fraud call read. The tape moves every two seconds; a
  // marketability test outside this transaction is a test of a price that is no
  // longer the price, and losing that race means filling above a limit. The
  // constraint in 007 exists because this is the line a bug would be on.
  const marketable = type !== 'LIMIT' || isMarketable(side, limitPrice, price);

  // The account row, locked before anything is checked against it, so two concurrent
  // orders cannot both pass against the same balance. Locked for a resting order too:
  // reserving capacity is a claim on the same cash a fill would spend.
  const { rows: accountRows } = await tx.query(
    'SELECT id, cash FROM accounts WHERE id = $1 FOR UPDATE',
    [accountId],
  );
  if (accountRows.length === 0) {
    throw new ApiError('No account found for this session.', {
      status: 404,
      code: 'account_missing',
    });
  }
  const cashBefore = round2(accountRows[0].cash);

  if (!marketable) {
    if (restingOrderId !== null) {
      // The sweep selected this order because the tape had reached it, and the price
      // moved back before the lock was taken. Not an error and not a fill — it stays
      // open and the next tick will look again.
      throw new PriceMovedAway(symbol);
    }
    return restOrder(tx, accountId, order, price, cashBefore, clientOrderId);
  }

  return completeFill(tx, accountId, order, { price, cashBefore, restingOrderId, clientOrderId });
}

/** Raised when a resting order stops being marketable between selection and lock. */
class PriceMovedAway extends Error {
  constructor(symbol) {
    super(`${symbol} moved away before the fill`);
    this.name = 'PriceMovedAway';
  }
}

/**
 * Hold a limit order until the tape reaches it.
 *
 * The capacity check happens here rather than at the fill, and that is the whole
 * design: a buy reserves `quantity × limitPrice`, the worst it can cost, so an order
 * that was affordable when it was accepted is still affordable whenever it goes off.
 * Checking only at fill time would mean an order could be accepted, sit for an hour,
 * and then fail on money that had been spent in the meantime — which is a promise
 * quietly broken rather than one refused up front.
 */
async function restOrder(
  tx,
  accountId,
  { side, symbol, quantity, limitPrice },
  price,
  cashBefore,
  clientOrderId,
) {
  if (side === 'BUY') {
    const committed = await reservedCash(tx, accountId);
    const available = round2(cashBefore - committed);
    const needed = round2(quantity * limitPrice);
    if (needed > available) {
      throw new ApiError(
        `Insufficient cash: ${symbol} × ${quantity} at ${limitPrice.toFixed(2)} reserves ` +
          `${needed.toFixed(2)}, available ${available.toFixed(2)}` +
          (committed > 0 ? ` after ${committed.toFixed(2)} already held for open orders.` : '.'),
        { status: 422, code: 'insufficient_cash' },
      );
    }
  } else {
    const { open, committed } = await sharePosition(tx, accountId, symbol);
    const available = open - committed;
    if (quantity > available) {
      throw new ApiError(
        `Insufficient shares: holding ${open} ${symbol}` +
          (committed > 0 ? `, ${committed} already committed to open orders` : '') +
          `, tried to sell ${quantity}.`,
        { status: 422, code: 'insufficient_shares' },
      );
    }
  }

  const { rows } = await tx.query(
    `INSERT INTO orders (account_id, symbol, side, type, quantity, limit_price, status,
                         filled_quantity, client_order_id)
     VALUES ($1, $2, $3, 'LIMIT', $4, $5, 'OPEN', 0, $6)
     RETURNING id, placed_at`,
    [accountId, symbol, side, quantity, limitPrice, clientOrderId],
  );

  return {
    order: {
      id: rows[0].id,
      symbol,
      side,
      type: 'LIMIT',
      limitPrice,
      quantity,
      // No price and no improvement: nothing has been bought or sold. The market is
      // reported separately, as context for how far away the limit is.
      price: null,
      priceImprovement: null,
      notional: null,
      status: 'OPEN',
      realizedPnl: null,
      marketPrice: price,
      placedAt: rows[0].placed_at,
      filledAt: null,
    },
    position: null,
    account: { cash: cashBefore, cashBefore },
  };
}

/** Open and committed share counts for one symbol, in one round trip each. */
async function sharePosition(tx, accountId, symbol, exclude = null) {
  const { rows } = await tx.query(
    `SELECT COALESCE(SUM(l.quantity - l.closed_quantity), 0)::bigint AS open
     FROM lots l JOIN positions p ON p.id = l.position_id
     WHERE p.account_id = $1 AND p.symbol = $2`,
    [accountId, symbol],
  );
  return {
    open: Number(rows[0].open),
    committed: await reservedShares(tx, accountId, symbol, exclude),
  };
}

/** The five records a fill writes, and the receipt that describes them. */
async function completeFill(tx, accountId, order, { price, cashBefore, restingOrderId, clientOrderId }) {
  const { side, symbol, quantity, type, limitPrice } = order;
  const notional = round2(quantity * price);

  const filled =
    side === 'BUY'
      ? await fillBuy(tx, accountId, symbol, quantity, price, notional, cashBefore, restingOrderId)
      : await fillSell(tx, accountId, symbol, quantity, price, notional, restingOrderId);

  const cashDelta = side === 'BUY' ? -notional : notional;

  // The permanent record. Written after the lot work so a rejected fill leaves no
  // trade behind, and inside the same transaction so the two can never disagree.
  const { rows: tradeRows } = await tx.query(
    `INSERT INTO trades (account_id, symbol, side, quantity, price, cash_delta, realized_pnl, trade_date)
     VALUES ($1, $2, $3, $4, $5, $6, $7, CURRENT_DATE)
     RETURNING id`,
    [accountId, symbol, side, quantity, price, cashDelta, filled.realizedPnl ?? null],
  );

  // What the sale actually closed. After the trade because the rows point at it,
  // and in one statement rather than one per lot: a sale can span every open lot
  // on a position, and this runs under the account's row lock, where each extra
  // round trip is paid for by whatever order is queued behind it.
  //
  // `closed_on` is CURRENT_DATE, the same expression the trade above used, so a
  // sale that straddles midnight cannot land its trade on one date and its
  // closures on another.
  if (filled.closures?.length) {
    await tx.query(
      `INSERT INTO lot_closures
         (trade_id, lot_id, account_id, symbol, quantity,
          cost_price, sale_price, opened_on, closed_on, realized_pnl)
       SELECT $1, slice.lot_id, $2, $3, slice.quantity,
              slice.cost_price, $4, slice.opened_on, CURRENT_DATE, slice.realized_pnl
       FROM unnest($5::bigint[], $6::bigint[], $7::numeric[], $8::date[], $9::numeric[])
            AS slice (lot_id, quantity, cost_price, opened_on, realized_pnl)`,
      [
        tradeRows[0].id,
        accountId,
        symbol,
        price,
        filled.closures.map((closure) => closure.lotId),
        filled.closures.map((closure) => closure.quantity),
        filled.closures.map((closure) => closure.costPrice),
        filled.closures.map((closure) => closure.openedOn),
        filled.closures.map((closure) => closure.realizedPnl),
      ],
    );
  }

  // The order. Inserted in its final state when it filled on arrival — the pending
  // state of an immediate fill is never observable, so the extra write would buy
  // nothing — and updated in place when it had been resting, which is the case that
  // needed the row to exist first.
  const orderRows = restingOrderId
    ? (
        await tx.query(
          `UPDATE orders
              SET status = 'FILLED', filled_quantity = quantity, fill_price = $2,
                  trade_id = $3, resolved_at = now()
            WHERE id = $1 AND status = 'OPEN'
            RETURNING id, placed_at`,
          [restingOrderId, price, tradeRows[0].id],
        )
      ).rows
    : (
        await tx.query(
          `INSERT INTO orders (account_id, symbol, side, type, quantity, limit_price, status,
                               filled_quantity, fill_price, trade_id, resolved_at, client_order_id)
           VALUES ($1, $2, $3, $4, $5, $6, 'FILLED', $5, $7, $8, now(), $9)
           RETURNING id, placed_at`,
          [accountId, symbol, side, type, quantity, limitPrice, price, tradeRows[0].id, clientOrderId],
        )
      ).rows;

  // An UPDATE that matched nothing means the order stopped being OPEN between the
  // sweep selecting it and this transaction reaching it. Throwing rolls back the
  // trade rather than leaving a fill nothing points at.
  if (orderRows.length === 0) {
    throw new PriceMovedAway(symbol);
  }

  const { rows: cashRows } = await tx.query(
    'UPDATE accounts SET cash = cash + $2 WHERE id = $1 RETURNING cash',
    [accountId, cashDelta],
  );

  return {
    order: {
      id: orderRows[0].id,
      symbol,
      side,
      type,
      // Null on a market order, which named no price.
      limitPrice,
      quantity,
      price,
      // What the limit saved, per share. A buy limit at 50 against a market at 47
      // fills at 47 and keeps the difference — a limit is the worst price
      // acceptable, not the price to trade at. Reporting it makes that visible
      // rather than something a customer has to notice by subtracting.
      priceImprovement:
        type === 'LIMIT' ? round4(side === 'BUY' ? limitPrice - price : price - limitPrice) : null,
      notional,
      status: 'FILLED',
      // Null on a buy: a purchase realizes nothing, and reporting 0 would claim
      // it broke even.
      realizedPnl: filled.realizedPnl ?? null,
      marketPrice: price,
      placedAt: orderRows[0].placed_at,
      filledAt: new Date().toISOString(),
    },
    position: filled.position,
    account: { cash: round2(cashRows[0].cash), cashBefore },
  };
}

async function fillBuy(tx, accountId, symbol, quantity, price, notional, cash, exclude = null) {
  // Cash already promised to open buy orders is not available to this one. Excluding
  // the order currently filling matters: without it a resting order competes with
  // itself and every sweep fill looks short by exactly its own notional.
  const committed = await reservedCash(tx, accountId, exclude);
  const available = round2(cash - committed);

  if (notional > available) {
    throw new ApiError(
      `Insufficient cash: ${symbol} × ${quantity} costs ${notional.toFixed(2)}, available ` +
        `${available.toFixed(2)}` +
        (committed > 0 ? ` after ${committed.toFixed(2)} held for open orders.` : '.'),
      { status: 422, code: 'insufficient_cash' },
    );
  }

  // DO UPDATE on a column that is already correct, purely so RETURNING yields the
  // id whether the position existed or not. DO NOTHING returns no row on conflict.
  const { rows } = await tx.query(
    `INSERT INTO positions (account_id, symbol, opened_at) VALUES ($1, $2, CURRENT_DATE)
     ON CONFLICT (account_id, symbol) DO UPDATE SET opened_at = positions.opened_at
     RETURNING id`,
    [accountId, symbol],
  );
  const positionId = rows[0].id;

  await tx.query(
    'INSERT INTO lots (position_id, trade_date, quantity, price) VALUES ($1, CURRENT_DATE, $2, $3)',
    [positionId, quantity, price],
  );

  return { position: await readPosition(tx, positionId, symbol) };
}

/**
 * Makes the slices add up to the trade's own realized figure, to the cent.
 *
 * Two roundings that do not commute. The trade reports
 * `round2(round2(quantity x price) - SUM(costs))`; a slice reports `round2` of its
 * own share. Sell across three lots at a four-decimal price and the slices can miss
 * the total by a cent or two — small, and still enough to make the breakdown
 * disagree with the number on the trade for a reason no reader could ever find.
 *
 * The residual goes to the largest slice, where it is the smallest relative
 * distortion, and to the earliest of equals so the choice never depends on
 * iteration order.
 *
 * A mismatch bigger than rounding can explain is not a rounding problem. It would
 * mean the slices and the total were computed from different numbers, and the honest
 * response is to refuse the fill: this runs inside the fill's transaction, so
 * throwing rolls back the sale rather than committing a ledger already known to be
 * inconsistent. The bound is a cent per slice plus a cent for each of the two
 * roundings on the total, so a real fill cannot reach it.
 */
function reconcileClosures(closures, realizedPnl) {
  if (closures.length === 0) return;

  const summed = round2(closures.reduce((total, closure) => total + closure.realizedPnl, 0));
  const residual = round2(realizedPnl - summed);
  if (residual === 0) return;

  const tolerance = round2(0.01 * (closures.length + 2));
  if (Math.abs(residual) > tolerance) {
    throw new ApiError('Realized P/L could not be attributed to the lots it closed.', {
      status: 500,
      code: 'realized_attribution_mismatch',
    });
  }

  let largest = 0;
  for (let index = 1; index < closures.length; index += 1) {
    if (closures[index].quantity > closures[largest].quantity) largest = index;
  }
  closures[largest].realizedPnl = round2(closures[largest].realizedPnl + residual);
}

/**
 * Closes shares FIFO and returns the realized gain, with the lots it came from.
 *
 * Nothing is deleted. Lots are marked closed, and the position row stays even when
 * fully sold — it is the parent of lots that are part of the account's history. The
 * reads filter on open quantity so a fully-closed position does not appear as a
 * zero-share holding.
 *
 * The returned `closures` describe the same consumption the `UPDATE`s just
 * performed, one entry per lot. They are built here rather than reconstructed by the
 * caller because this loop is the only place that knows the answer: after it
 * returns, `closed_quantity` is a total and the order is unrecoverable.
 */
async function fillSell(tx, accountId, symbol, quantity, price, notional, exclude = null) {
  const { rows: positionRows } = await tx.query(
    'SELECT id FROM positions WHERE account_id = $1 AND symbol = $2',
    [accountId, symbol],
  );
  if (positionRows.length === 0) {
    throw new ApiError(`Insufficient shares: no ${symbol} position.`, {
      status: 422,
      code: 'insufficient_shares',
    });
  }
  const positionId = positionRows[0].id;

  // FOR UPDATE so a concurrent sell on the same position cannot close the same
  // shares twice; the ORDER BY makes the consumption FIFO by trade date. Lots with
  // nothing left open are skipped rather than locked.
  const { rows: lots } = await tx.query(
    `SELECT id, trade_date, price, quantity - closed_quantity AS open_quantity
     FROM lots
     WHERE position_id = $1 AND quantity > closed_quantity
     ORDER BY trade_date, id
     FOR UPDATE`,
    [positionId],
  );

  const held = lots.reduce((total, lot) => total + lot.open_quantity, 0);
  // Shares promised to open sell orders are spoken for. Same exclusion as the buy
  // side, for the same reason.
  const committed = await reservedShares(tx, accountId, symbol, exclude);

  if (held - committed < quantity) {
    throw new ApiError(
      `Insufficient shares: holding ${held} ${symbol}` +
        (committed > 0 ? `, ${committed} committed to open orders` : '') +
        `, tried to sell ${quantity}.`,
      { status: 422, code: 'insufficient_shares' },
    );
  }

  // Every lot closed in one statement, rather than one round trip each.
  //
  // **Why it matters here specifically.** This runs under the account row lock — the
  // most contended lock in the service, the one every other order on this account
  // queues behind, and the one this file goes out of its way to keep an HTTP call and
  // a simulated sleep outside of. A sale spanning thirty lots was thirty sequential
  // round trips held under it, and thirty statements against
  // `DB_FILL_STATEMENT_TIMEOUT_MS`, where a long-tailed position turns into a 57014
  // and a retry. The `lot_closures` insert below already makes exactly this argument;
  // the lot updates were the place it had not been applied.
  //
  // **Why the lock is still a separate statement.** Postgres does not allow
  // `FOR UPDATE` alongside a window function, so the running total cannot be computed
  // in the locking query. The two statements therefore see the position at two
  // different moments — which is safe, but only because of something that is not
  // local to this function: `executeOrder` took `FOR UPDATE` on the account row before
  // calling it, so no other fill for this account can be between them.
  //
  // **The frame excludes the current row.** `1 PRECEDING`, so `already` is what
  // earlier lots absorb and this lot takes what is left of the request. Off by one row
  // there silently over- or under-closes shares, and both commit cleanly:
  // `orders_filled_is_complete` does not see it, and `lots_closed_within_opened` only
  // catches the over-close.
  const { rows: closed } = await tx.query(
    `WITH ordered AS (
       SELECT id, trade_date, price, open_quantity,
              COALESCE(
                SUM(open_quantity) OVER (
                  ORDER BY trade_date, id ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
                ), 0) AS already
       FROM unnest($1::bigint[], $2::date[], $3::numeric[], $4::bigint[])
            AS lot (id, trade_date, price, open_quantity)
     ),
     taking AS (
       SELECT id, trade_date, price,
              LEAST(open_quantity, GREATEST($5::bigint - already, 0)) AS taken
       FROM ordered
     )
     UPDATE lots l
        SET closed_quantity = l.closed_quantity + t.taken
       FROM taking t
      WHERE l.id = t.id AND t.taken > 0
      RETURNING l.id, t.trade_date, t.price, t.taken`,
    [
      lots.map((lot) => lot.id),
      lots.map((lot) => isoDate(lot.trade_date)),
      lots.map((lot) => lot.price),
      lots.map((lot) => lot.open_quantity),
      quantity,
    ],
  );

  // Re-sorted, because `RETURNING` has no guaranteed row order. `reconcileClosures`
  // puts the rounding residual on the largest slice and breaks ties on position, so
  // feeding it whatever order the plan produced would make the odd cent land on a
  // different lot from one execution to the next — a non-deterministic breakdown for a
  // deterministic sale. This is the line most easily left out and hardest to notice
  // missing.
  const byFifo = new Map(lots.map((lot, index) => [String(lot.id), index]));
  const taken = closed
    .slice()
    .sort((a, b) => byFifo.get(String(a.id)) - byFifo.get(String(b.id)));

  let costOfSold = 0;
  // One entry per lot this sale consumed, in the order it consumed them. The lot's own
  // price and open date come from the statement's own RETURNING rather than a later
  // lookup: the rows have just been mutated, and a closure that read
  // `closed_quantity` afterwards would be describing a lot that had already moved on.
  const closures = taken.map((row) => {
    const quantityTaken = Number(row.taken);
    const lotPrice = Number(row.price);
    costOfSold += quantityTaken * lotPrice;

    return {
      lotId: row.id,
      quantity: quantityTaken,
      costPrice: round4(lotPrice),
      salePrice: price,
      openedOn: isoDate(row.trade_date),
      realizedPnl: round2(quantityTaken * price - quantityTaken * lotPrice),
    };
  });

  const realizedPnl = round2(notional - costOfSold);
  reconcileClosures(closures, realizedPnl);
  const stillOpen = held - quantity;

  return {
    realizedPnl,
    closures,
    position:
      stillOpen === 0
        ? { symbol, quantity: 0, averageCost: 0, costBasis: 0, closed: true }
        : await readPosition(tx, positionId, symbol),
  };
}

/**
 * The post-trade holding, re-derived from the lots rather than tracked alongside.
 * Everything is measured on the *open* quantity — a closed lot stays on the table
 * as history, so summing `quantity` would keep reporting shares that were sold.
 */
async function readPosition(tx, positionId, symbol) {
  const { rows } = await tx.query(
    `SELECT COALESCE(SUM(quantity - closed_quantity), 0)::bigint         AS quantity,
            COALESCE(SUM((quantity - closed_quantity) * price), 0)       AS cost_basis
     FROM lots WHERE position_id = $1`,
    [positionId],
  );
  const quantity = rows[0]?.quantity ?? 0;
  const costBasis = round2(rows[0]?.cost_basis ?? 0);

  return {
    symbol,
    quantity,
    costBasis,
    averageCost: quantity > 0 ? round4(costBasis / quantity) : 0,
    closed: quantity === 0,
  };
}

module.exports = {
  placeOrder,
  cancelOrder,
  // For the sweep, which fills resting orders on the market tick. It reaches the same
  // transaction body the request path does rather than keeping a second copy.
  executeOrder,
  PriceMovedAway,
  // Exported for the unit test that exercises the tolerance, which has no reachable
  // path through the API: a fill can only ever produce a residual of a cent or two.
  reconcileClosures,
};
