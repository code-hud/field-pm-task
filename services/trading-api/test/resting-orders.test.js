/**
 * Limit orders that wait, and the sweep that fills them.
 *
 * Two properties run through all of this.
 *
 * An accepted order stays fillable. A buy reserves cash at its limit — the worst it
 * can cost — so the money set aside when it was accepted is always enough when the
 * tape finally reaches it. A sell reserves the shares the same way.
 *
 * And a promise made is a promise kept: cash committed to an open order is not
 * available to the next one, and shares committed cannot be sold twice.
 *
 * The sweep is called directly rather than through the ticker. The ticker's job is
 * deciding *when* — one leader, after the quotes are written — and that is a
 * different thing from what happens when it does.
 */
const assert = require('node:assert/strict');
const { after, before, describe, it } = require('node:test');

const {
  baseUrlForMessages,
  createTestDatabase,
  databaseIsReachable,
  dropTestDatabase,
} = require('./helpers/database.js');

let baseUrl;
let server;
let testDb;
let closePool;
let query;
let sweepRestingOrders;
let marketableOrders;

const call = async (path, options = {}) => {
  const response = await fetch(`${baseUrl}${path}`, options);
  return { status: response.status, body: await response.json() };
};

const authed = (token, path) => call(path, { headers: { authorization: `Bearer ${token}` } });

const signIn = async (username) => {
  const { body } = await call('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password: 'demo' }),
  });
  return body.token;
};

const order = (token, payload) =>
  call('/api/orders', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  });

const unheldSymbol = async (token, skip = new Set()) => {
  const { body: portfolio } = await authed(token, '/api/portfolio');
  const held = new Set(portfolio.positions.map((position) => position.symbol));
  const { body: market } = await authed(token, '/api/market/stocks');
  return market.stocks.find((quote) => !held.has(quote.symbol) && !skip.has(quote.symbol))
    .symbol;
};

const repriceTo = async (symbol, price) => {
  await query('UPDATE quotes SET price = $2 WHERE symbol = $1', [symbol, price]);
};

const orderRow = async (id) => {
  const { rows } = await query('SELECT * FROM orders WHERE id = $1', [id]);
  return rows[0];
};

/**
 * Whether the shortlist has reached one particular order.
 *
 * The sweep is global — it is the venue's, not an account's — so earlier tests in
 * this file leave open orders of their own behind. Anything asserting on a count
 * would be asserting on the rest of the file, so these ask about their own order.
 */
const isShortlisted = async (id) =>
  (await marketableOrders(500)).some((row) => Number(row.id) === Number(id));

/** Empties an account's spendable cash so a reservation test has a known ceiling. */
const setCash = async (token, amount) => {
  const { body } = await authed(token, '/api/portfolio');
  await query('UPDATE accounts SET cash = $2 WHERE id = $1', [body.account.userId, amount]);
  return body.account.userId;
};

before(async () => {
  if (!(await databaseIsReachable())) {
    throw new Error(`No Postgres at ${baseUrlForMessages()}. Start one with \`make db-up\`.`);
  }

  testDb = await createTestDatabase();

  const { migrate } = require('../src/db/migrate.js');
  const { seed } = require('../src/db/seed.js');
  ({ closePool, query } = require('../src/db/pool.js'));

  await migrate();
  await seed({ reset: false, force: true, quiet: true, accounts: [], marketSeed: 20260803 });

  ({ sweepRestingOrders, marketableOrders } = require('../src/orders/restingBook.js'));

  const { createApp } = require('../src/app.js');
  server = createApp().listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server?.close();
  await closePool?.();
  if (testDb) await dropTestDatabase(testDb.name);
});

describe('resting orders', () => {
  it('fills when the tape comes to it, at the market rather than the limit', async () => {
    const token = await signIn('rest-buyer');
    const symbol = await unheldSymbol(token);

    await repriceTo(symbol, 60);
    const { status, body } = await order(token, {
      symbol,
      side: 'BUY',
      quantity: 4,
      type: 'LIMIT',
      limitPrice: 50,
    });
    assert.equal(status, 202);
    const orderId = body.order.id;

    // Still away: the sweep does not reach it.
    assert.equal(await isShortlisted(orderId), false);
    await sweepRestingOrders();
    assert.equal((await orderRow(orderId)).status, 'OPEN');

    // The tape crosses, and goes further than the limit asked for.
    await repriceTo(symbol, 47);
    assert.equal(await isShortlisted(orderId), true);
    await sweepRestingOrders();

    const row = await orderRow(orderId);
    assert.equal(row.status, 'FILLED');
    assert.equal(Number(row.fill_price), 47, 'filled at the market, not at the limit');
    assert.equal(Number(row.filled_quantity), 4);
    assert.ok(row.trade_id, 'and it points at a real trade');
    assert.ok(row.resolved_at);

    const { body: portfolio } = await authed(token, '/api/portfolio');
    const position = portfolio.positions.find((entry) => entry.symbol === symbol);
    assert.equal(position.quantity, 4);
  });

  it('fills a resting sell and books the gain', async () => {
    const token = await signIn('rest-seller');
    const symbol = await unheldSymbol(token);

    await repriceTo(symbol, 20);
    await order(token, { symbol, side: 'BUY', quantity: 5 });

    const { body } = await order(token, {
      symbol,
      side: 'SELL',
      quantity: 5,
      type: 'LIMIT',
      limitPrice: 30,
    });
    assert.equal(body.order.status, 'OPEN');

    await repriceTo(symbol, 32);
    await sweepRestingOrders();

    const row = await orderRow(body.order.id);
    assert.equal(row.status, 'FILLED');

    // The whole fill path ran, not a shortcut: the trade, the lot closures and the
    // realized figure all exist and agree.
    const { rows: trades } = await query('SELECT * FROM trades WHERE id = $1', [row.trade_id]);
    assert.equal(Number(trades[0].realized_pnl), 60); // 5 × (32 − 20)
    const { rows: closures } = await query(
      'SELECT count(*)::int AS total FROM lot_closures WHERE trade_id = $1',
      [row.trade_id],
    );
    assert.equal(closures[0].total, 1);

    const { body: realized } = await authed(token, '/api/portfolio/realized');
    assert.equal(realized.summary.realizedPnl, 60);
  });

  it('holds the cash an open buy order will need', async () => {
    // The promise the account has already made. Without this the same cash backs two
    // orders, and it is discovered when the second one fills.
    const token = await signIn('rest-reserver');
    const symbol = await unheldSymbol(token);
    const other = await unheldSymbol(token, new Set([symbol]));

    await setCash(token, 1000);
    await repriceTo(symbol, 100);
    await repriceTo(other, 100);

    // 8 × 90 = 720 reserved, leaving 280.
    const { status } = await order(token, {
      symbol,
      side: 'BUY',
      quantity: 8,
      type: 'LIMIT',
      limitPrice: 90,
    });
    assert.equal(status, 202);

    const { body: portfolio } = await authed(token, '/api/portfolio');
    assert.equal(portfolio.summary.cash, 1000, 'the balance has not moved');
    assert.equal(portfolio.summary.reservedCash, 720);
    assert.equal(portfolio.summary.availableCash, 280);
    assert.equal(portfolio.summary.buyingPower, 560, 'margin is offered on what is spendable');

    // A market order for 400 would fit in the balance and not in what is left of it.
    const refused = await order(token, { symbol: other, side: 'BUY', quantity: 4 });
    assert.equal(refused.status, 422);
    assert.equal(refused.body.error.code, 'insufficient_cash');
    assert.match(refused.body.error.message, /held for open orders/);

    // Two hundred does fit.
    assert.equal((await order(token, { symbol: other, side: 'BUY', quantity: 2 })).status, 201);
  });

  it('holds the shares an open sell order will need', async () => {
    const token = await signIn('rest-shareholder');
    const symbol = await unheldSymbol(token);

    await repriceTo(symbol, 40);
    await order(token, { symbol, side: 'BUY', quantity: 10 });

    // Six of the ten are spoken for.
    await order(token, { symbol, side: 'SELL', quantity: 6, type: 'LIMIT', limitPrice: 55 });

    const refused = await order(token, { symbol, side: 'SELL', quantity: 8 });
    assert.equal(refused.status, 422);
    assert.equal(refused.body.error.code, 'insufficient_shares');
    assert.match(refused.body.error.message, /6 committed to open orders/);

    assert.equal((await order(token, { symbol, side: 'SELL', quantity: 4 })).status, 201);
  });

  it('does not let an order compete with its own reservation', async () => {
    // The exclusion that makes the sweep work at all. An order's own reservation is
    // the cash it is about to spend; counting it would make every resting fill look
    // short by exactly its own notional.
    const token = await signIn('rest-selfcompete');
    const symbol = await unheldSymbol(token);

    await setCash(token, 500);
    await repriceTo(symbol, 100);

    // Reserves 480 of the 500 available — nothing else could fill alongside it.
    const { body } = await order(token, {
      symbol,
      side: 'BUY',
      quantity: 6,
      type: 'LIMIT',
      limitPrice: 80,
    });

    await repriceTo(symbol, 79);
    await sweepRestingOrders();
    assert.equal(
      (await orderRow(body.order.id)).status,
      'FILLED',
      'the order filled against cash its own reservation was holding',
    );
  });

  it('fills the order that has waited longest first', async () => {
    // Time priority, which every venue shares. It decides which order gets the cash
    // when two on one account want the same money.
    const token = await signIn('rest-queue');
    const symbol = await unheldSymbol(token);
    await repriceTo(symbol, 100);

    const first = await order(token, {
      symbol, side: 'BUY', quantity: 1, type: 'LIMIT', limitPrice: 90,
    });
    const second = await order(token, {
      symbol, side: 'BUY', quantity: 1, type: 'LIMIT', limitPrice: 95,
    });

    await repriceTo(symbol, 85);
    await sweepRestingOrders();

    const older = await orderRow(first.body.order.id);
    const newer = await orderRow(second.body.order.id);
    assert.ok(
      Number(older.trade_id) < Number(newer.trade_id),
      'the order placed first traded first',
    );
  });

  it('only shortlists orders the tape has actually reached', async () => {
    const token = await signIn('rest-shortlist');
    const symbol = await unheldSymbol(token);
    await repriceTo(symbol, 50);

    const near = await order(token, {
      symbol, side: 'BUY', quantity: 1, type: 'LIMIT', limitPrice: 49,
    });
    const far = await order(token, {
      symbol, side: 'BUY', quantity: 1, type: 'LIMIT', limitPrice: 10,
    });

    await repriceTo(symbol, 49);

    // Equality counts: a limit is the worst price acceptable, not one to beat.
    assert.equal(await isShortlisted(near.body.order.id), true);
    assert.equal(await isShortlisted(far.body.order.id), false);
  });

  it('leaves an order open when it is no longer marketable at the lock', async () => {
    // The sweep's shortlist is read outside any transaction, so a price can move back
    // between selection and fill. That is not an error and not a fill.
    const token = await signIn('rest-movedaway');
    const symbol = await unheldSymbol(token);
    await repriceTo(symbol, 50);

    const { body } = await order(token, {
      symbol, side: 'BUY', quantity: 1, type: 'LIMIT', limitPrice: 45,
    });

    await repriceTo(symbol, 44);
    assert.equal(await isShortlisted(body.order.id), true);
    const [shortlisted] = (await marketableOrders(500)).filter(
      (row) => Number(row.id) === Number(body.order.id),
    );

    // The tape moves back before anything acts on the shortlist.
    await repriceTo(symbol, 50);
    const { executeOrder, PriceMovedAway } = require('../src/orders/orderService.js');
    const { transaction } = require('../src/db/pool.js');

    await assert.rejects(
      transaction((tx) =>
        executeOrder(
          tx,
          shortlisted.account_id,
          { side: 'BUY', symbol, quantity: 1, type: 'LIMIT', limitPrice: 45 },
          { restingOrderId: shortlisted.id },
        ),
      ),
      PriceMovedAway,
    );

    assert.equal((await orderRow(body.order.id)).status, 'OPEN', 'still waiting');
  });

  it('refuses to rest an order the account could not honour', async () => {
    // Checked at acceptance, not at the fill. An order accepted now and failing in an
    // hour on money spent in between is a promise quietly broken; this is one
    // refused up front.
    const token = await signIn('rest-overcommitted');
    const symbol = await unheldSymbol(token);

    await setCash(token, 100);
    await repriceTo(symbol, 50);

    const { status, body } = await order(token, {
      symbol, side: 'BUY', quantity: 10, type: 'LIMIT', limitPrice: 45,
    });

    assert.equal(status, 422);
    assert.equal(body.error.code, 'insufficient_cash');
    const { rows } = await query(
      `SELECT count(*)::int AS total FROM orders o JOIN accounts a ON a.id = o.account_id
       WHERE a.username_key = 'rest-overcommitted' AND o.status = 'OPEN'`,
    );
    assert.equal(rows[0].total, 0);
  });

  it('shows a waiting order in the order log', async () => {
    const token = await signIn('rest-listed');
    const symbol = await unheldSymbol(token);
    await repriceTo(symbol, 70);

    await order(token, { symbol, side: 'BUY', quantity: 1, type: 'LIMIT', limitPrice: 60 });

    const { status, body } = await authed(token, '/api/orders?status=OPEN');
    assert.equal(status, 200);
    assert.equal(body.total, 1);
    assert.equal(body.orders[0].status, 'OPEN');
    assert.equal(body.orders[0].limitPrice, 60, 'a waiting order shows what it waits for');
    assert.equal(body.orders[0].fillPrice, null);
    assert.equal(body.orders[0].resolvedAt, null);
  });

  it('refuses a waiting order that claims to have filled', async () => {
    const token = await signIn('rest-liar');
    const symbol = await unheldSymbol(token);
    await repriceTo(symbol, 70);

    const { body } = await order(token, {
      symbol, side: 'BUY', quantity: 1, type: 'LIMIT', limitPrice: 60,
    });

    await assert.rejects(
      query('UPDATE orders SET fill_price = 60 WHERE id = $1', [body.order.id]),
      /orders_open_is_waiting/,
    );
  });

  it('will not let a market order rest', async () => {
    // Nothing in the code path can do this — a market order always fills or is
    // refused — but a market order that could wait would be waiting for nothing.
    const token = await signIn('rest-market');
    const symbol = await unheldSymbol(token);

    const { body } = await order(token, { symbol, side: 'BUY', quantity: 1 });

    await assert.rejects(
      query(
        `UPDATE orders SET status = 'OPEN', filled_quantity = 0, fill_price = NULL,
                           trade_id = NULL, resolved_at = NULL WHERE id = $1`,
        [body.order.id],
      ),
      /orders_open_is_waiting/,
    );
  });
});
