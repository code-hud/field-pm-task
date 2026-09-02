/**
 * Withdrawing a resting order.
 *
 * The interesting case is not the happy one. The sweep is filling orders on every
 * market tick, so a cancel and a fill can be reaching for the same row at the same
 * moment, and exactly one of them has to win — a cancel that overwrote a fill would
 * erase a trade that really happened and leave the cash movement and the lot behind.
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

const call = async (path, options = {}) => {
  const response = await fetch(`${baseUrl}${path}`, options);
  return { status: response.status, body: await response.json().catch(() => null) };
};

const authed = (token, path, options = {}) =>
  call(path, { ...options, headers: { authorization: `Bearer ${token}`, ...options.headers } });

const cancel = (token, id) => authed(token, `/api/orders/${id}`, { method: 'DELETE' });

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
  const { body: market } = await authed(token, '/api/market/instruments');
  return market.instruments.find((quote) => !held.has(quote.symbol) && !skip.has(quote.symbol))
    .symbol;
};

const repriceTo = async (symbol, price) => {
  await query('UPDATE quotes SET price = $2 WHERE symbol = $1', [symbol, price]);
};

const setCash = async (token, amount) => {
  const { body } = await authed(token, '/api/portfolio');
  await query('UPDATE accounts SET cash = $2 WHERE id = $1', [body.account.userId, amount]);
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

  ({ sweepRestingOrders } = require('../src/orders/restingBook.js'));

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

describe('cancelling an order', () => {
  it('withdraws a waiting order and answers with it', async () => {
    const token = await signIn('cancel-basic');
    const symbol = await unheldSymbol(token);
    await repriceTo(symbol, 80);

    const { body: placed } = await order(token, {
      symbol, side: 'BUY', quantity: 2, type: 'LIMIT', limitPrice: 70,
    });

    const { status, body } = await cancel(token, placed.order.id);

    assert.equal(status, 200);
    assert.equal(body.status, 'CANCELLED');
    assert.equal(body.id, placed.order.id);
    assert.equal(body.limitPrice, 70, 'and still says what it had been waiting for');
    assert.equal(body.fillPrice, null);
    assert.ok(body.resolvedAt, 'it has stopped waiting');
  });

  it('gives the cash back', async () => {
    // Nothing is "given back" so much as no longer counted: reservations are derived
    // from the open orders, so leaving OPEN releases the capacity by itself.
    const token = await signIn('cancel-cash');
    const symbol = await unheldSymbol(token);
    await setCash(token, 1000);
    await repriceTo(symbol, 100);

    const { body: placed } = await order(token, {
      symbol, side: 'BUY', quantity: 9, type: 'LIMIT', limitPrice: 90,
    });

    const { body: held } = await authed(token, '/api/portfolio');
    assert.equal(held.summary.reservedCash, 810);
    assert.equal(held.summary.availableCash, 190);

    await cancel(token, placed.order.id);

    const { body: released } = await authed(token, '/api/portfolio');
    assert.equal(released.summary.reservedCash, 0);
    assert.equal(released.summary.availableCash, 1000);
    assert.equal(released.summary.cash, 1000, 'and the balance never moved at all');
  });

  it('gives the shares back', async () => {
    const token = await signIn('cancel-shares');
    const symbol = await unheldSymbol(token);
    await repriceTo(symbol, 40);
    await order(token, { symbol, side: 'BUY', quantity: 10 });

    const { body: placed } = await order(token, {
      symbol, side: 'SELL', quantity: 8, type: 'LIMIT', limitPrice: 55,
    });

    // Eight of ten committed, so nine cannot be sold.
    assert.equal((await order(token, { symbol, side: 'SELL', quantity: 9 })).status, 422);

    await cancel(token, placed.order.id);

    assert.equal((await order(token, { symbol, side: 'SELL', quantity: 9 })).status, 201);
  });

  it('leaves a cancelled order out of the sweep', async () => {
    const token = await signIn('cancel-swept');
    const symbol = await unheldSymbol(token);
    await repriceTo(symbol, 80);

    const { body: placed } = await order(token, {
      symbol, side: 'BUY', quantity: 1, type: 'LIMIT', limitPrice: 70,
    });
    await cancel(token, placed.order.id);

    // The tape arrives where the order had been waiting. It is not there any more.
    await repriceTo(symbol, 65);
    await sweepRestingOrders();

    const { body } = await authed(token, `/api/orders/${placed.order.id}`);
    assert.equal(body.status, 'CANCELLED');
    assert.equal(body.tradeId, null);
  });

  it('refuses to cancel an order that has already filled', async () => {
    // The race, from the losing side. A cancel arriving after the fill must not
    // overwrite it — that would erase a trade that really happened while leaving the
    // cash movement and the lot behind.
    const token = await signIn('cancel-toolate');
    const symbol = await unheldSymbol(token);
    await repriceTo(symbol, 80);

    const { body: placed } = await order(token, {
      symbol, side: 'BUY', quantity: 1, type: 'LIMIT', limitPrice: 70,
    });

    await repriceTo(symbol, 65);
    await sweepRestingOrders();

    const { status, body } = await cancel(token, placed.order.id);
    assert.equal(status, 409);
    assert.equal(body.error.code, 'order_not_open');
    assert.match(body.error.message, /filled/);

    const { body: order_ } = await authed(token, `/api/orders/${placed.order.id}`);
    assert.equal(order_.status, 'FILLED');
    assert.ok(order_.tradeId, 'the fill is untouched');
  });

  it('refuses to cancel a market order that already went through', async () => {
    const token = await signIn('cancel-market');
    const symbol = await unheldSymbol(token);

    const { body: placed } = await order(token, { symbol, side: 'BUY', quantity: 1 });
    const { status, body } = await cancel(token, placed.order.id);

    assert.equal(status, 409);
    assert.equal(body.error.code, 'order_not_open');
  });

  it('cancels once, however many times it is asked', async () => {
    const token = await signIn('cancel-twice');
    const symbol = await unheldSymbol(token);
    await repriceTo(symbol, 80);

    const { body: placed } = await order(token, {
      symbol, side: 'BUY', quantity: 1, type: 'LIMIT', limitPrice: 70,
    });

    assert.equal((await cancel(token, placed.order.id)).status, 200);

    // Not idempotent-with-a-200: the second attempt genuinely conflicts with the
    // state, and saying so is more useful than pretending it did something.
    const second = await cancel(token, placed.order.id);
    assert.equal(second.status, 409);
    assert.match(second.body.error.message, /cancelled/);
  });

  it('will not let one account cancel another account order', async () => {
    // A 404, not a 403 — the same reason reading one is. A 403 confirms the id
    // exists, and here it would also confirm the order is still open.
    const mine = await signIn('cancel-owner');
    const symbol = await unheldSymbol(mine);
    await repriceTo(symbol, 80);

    const { body: placed } = await order(mine, {
      symbol, side: 'BUY', quantity: 1, type: 'LIMIT', limitPrice: 70,
    });

    const theirs = await signIn('cancel-stranger');
    const { status, body } = await cancel(theirs, placed.order.id);

    assert.equal(status, 404);
    assert.equal(body.error.code, 'order_not_found');

    const { body: untouched } = await authed(mine, `/api/orders/${placed.order.id}`);
    assert.equal(untouched.status, 'OPEN');
  });

  it('rejects an id that is not one', async () => {
    const token = await signIn('cancel-nonsense');
    const { status, body } = await cancel(token, 'abc');

    assert.equal(status, 400);
    assert.equal(body.error.code, 'invalid_parameter');
  });

  it('requires a token', async () => {
    assert.equal((await call('/api/orders/1', { method: 'DELETE' })).status, 401);
  });

  it('lists cancelled orders under their own status', async () => {
    const token = await signIn('cancel-listed');
    const symbol = await unheldSymbol(token);
    await repriceTo(symbol, 80);

    const { body: placed } = await order(token, {
      symbol, side: 'BUY', quantity: 1, type: 'LIMIT', limitPrice: 70,
    });
    await cancel(token, placed.order.id);

    const { body } = await authed(token, '/api/orders?status=CANCELLED');
    assert.equal(body.total, 1);
    assert.equal(body.orders[0].id, placed.order.id);

    // And not as a rejection: the customer changed their mind, the venue refused
    // nothing.
    const { body: rejected } = await authed(token, '/api/orders?status=REJECTED');
    assert.equal(rejected.total, 0);
  });

  it('refuses a cancelled order that claims to have traded', async () => {
    const token = await signIn('cancel-liar');
    const symbol = await unheldSymbol(token);
    await repriceTo(symbol, 80);

    const { body: placed } = await order(token, {
      symbol, side: 'BUY', quantity: 1, type: 'LIMIT', limitPrice: 70,
    });
    await cancel(token, placed.order.id);

    await assert.rejects(
      query('UPDATE orders SET fill_price = 70, filled_quantity = 1 WHERE id = $1', [
        placed.order.id,
      ]),
      /orders_cancelled_is_empty/,
    );
  });
});
