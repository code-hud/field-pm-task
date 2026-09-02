const { Router } = require('express');

const { ApiError } = require('../middleware/errors.js');
const { getOrder, listOrders, STATUSES } = require('../orders/orderHistory.js');
const { cancelOrder, placeOrder } = require('../orders/orderService.js');
const { requireAuth } = require('../middleware/requireAuth.js');

const ordersRouter = Router();

const MAX_LIMIT = 200;

/**
 * The `Idempotency-Key` header, validated or refused.
 *
 * Absent is fine and means what it has always meant: place the order, and a retry is a
 * second order. A present-but-empty header is a caller that meant to send one and did
 * not, which is worth a 400 rather than being quietly treated as absent — that is
 * exactly the mistake that leaves someone believing they have protection they do not.
 */
function idempotencyKey(raw) {
  if (raw === undefined) return null;
  const key = String(raw).trim();
  if (key.length === 0 || key.length > 128) {
    throw new ApiError('Idempotency-Key must be 1 to 128 characters.', {
      status: 400,
      code: 'invalid_idempotency_key',
    });
  }
  return key;
}

/**
 * A path parameter as an order id.
 *
 * Checked here rather than left to Postgres: `/api/orders/abc` is a client mistake
 * worth a 400, and handing it to a bigint column is a 500.
 */
function orderId(raw) {
  const id = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(id) || id < 1) {
    throw new ApiError(`"${raw}" is not an order id.`, {
      status: 400,
      code: 'invalid_parameter',
    });
  }
  return id;
}

ordersRouter.use(requireAuth);

/**
 * Place an order.
 *
 * 201 when it filled and 202 when it is resting, because they are different answers.
 * A 201 means the money has moved and the position has changed; a 202 means the venue
 * has accepted an instruction it has not carried out yet. Reporting both as 201 would
 * make "did I just buy something" a question the status code cannot answer.
 *
 * And **200 when nothing happened just now**: an `Idempotency-Key` this account has
 * already used answers with the order it placed the first time. A third code rather
 * than repeating the original, for the same reason 202 exists — the caller asked "did
 * this happen", and "yes, earlier" is not what 201 says.
 *
 * The replay is deliberately a thinner body than the original receipt.
 * `priceImprovement`, the post-fill position and `cashBefore` are computed during the
 * fill and never stored, so they cannot be reconstructed as they were *then* — only as
 * they are now, which would be a different set of facts wearing the same field names.
 * The order record is what actually happened, and it is read back through the same
 * function `GET /api/orders/:id` uses.
 */
ordersRouter.post('/', async (req, res, next) => {
  try {
    const receipt = await placeOrder(req.user, req.body, {
      clientOrderId: idempotencyKey(req.get('idempotency-key')),
    });

    if (receipt.replayed !== undefined) {
      res.status(200).json({ replayed: true, order: await getOrder(req.user, receipt.replayed) });
      return;
    }

    res.status(receipt.order.status === 'OPEN' ? 202 : 201).json(receipt);
  } catch (error) {
    next(error);
  }
});

/**
 * The account's orders, newest first.
 *
 * `status` and `symbol` are the two filters worth having, and an unrecognised status
 * is a 400 rather than an empty list. An empty list would be indistinguishable from
 * "you have no rejected orders", which is the answer somebody typing `REJECTD` is
 * most likely to believe.
 */
ordersRouter.get('/', async (req, res, next) => {
  try {
    const status = req.query.status ? String(req.query.status).toUpperCase() : undefined;
    if (status && !STATUSES.has(status)) {
      throw new ApiError(`Unknown status "${status}". Known: ${[...STATUSES].join(', ')}.`, {
        status: 400,
        code: 'invalid_status',
      });
    }

    const parsedLimit = Number.parseInt(req.query.limit ?? '', 10);
    const parsedOffset = Number.parseInt(req.query.offset ?? '', 10);

    res.json(
      await listOrders(req.user, {
        status,
        symbol: req.query.symbol ? String(req.query.symbol).trim().toUpperCase() : undefined,
        limit: Number.isFinite(parsedLimit) ? Math.min(Math.max(parsedLimit, 1), MAX_LIMIT) : 50,
        // Clamped at zero rather than rejected: a negative offset is a caller's
        // arithmetic slipping past the start of the list, and the start is what they
        // meant. A negative LIMIT/OFFSET is an error in Postgres, so this cannot be
        // passed through.
        offset: Number.isFinite(parsedOffset) ? Math.max(parsedOffset, 0) : 0,
      }),
    );
  } catch (error) {
    next(error);
  }
});

/**
 * Withdraw a resting order.
 *
 * Answers with the cancelled order rather than a 204, and reads it back through the
 * same function `GET /api/orders/:id` uses so the two cannot describe an order
 * differently. A 204 would leave the caller to assume what changed.
 */
ordersRouter.delete('/:id', async (req, res, next) => {
  try {
    const id = orderId(req.params.id);
    await cancelOrder(req.user, id);
    res.json(await getOrder(req.user, id));
  } catch (error) {
    next(error);
  }
});

/** One order. Another account's is a 404, for the reason given in orderHistory.js. */
ordersRouter.get('/:id', async (req, res, next) => {
  try {
    res.json(await getOrder(req.user, orderId(req.params.id)));
  } catch (error) {
    next(error);
  }
});

module.exports = { ordersRouter };
