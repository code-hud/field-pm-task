/**
 * Reading the order log.
 *
 * The log answers what the ledger cannot: what was *asked for*, including the orders
 * that were refused. An account that tried four times this morning to sell shares it
 * did not have looks identical to a quiet one in `/api/portfolio/transactions`.
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

before(async () => {
  if (!(await databaseIsReachable())) {
    throw new Error(`No Postgres at ${baseUrlForMessages()}. Start one with \`make db-up\`.`);
  }

  testDb = await createTestDatabase();

  const { migrate } = require('../src/db/migrate.js');
  const { seed } = require('../src/db/seed.js');
  ({ closePool } = require('../src/db/pool.js'));

  await migrate();
  await seed({ reset: false, force: true, quiet: true, accounts: [], marketSeed: 20260803 });

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

describe('order history', () => {
  it('requires a token', async () => {
    assert.equal((await call('/api/orders')).status, 401);
  });

  it('lists what was asked for, refusals included', async () => {
    const token = await signIn('lister');
    const symbol = await unheldSymbol(token);

    await order(token, { symbol, side: 'BUY', quantity: 3 });
    await order(token, { symbol, side: 'SELL', quantity: 99 });

    const { status, body } = await authed(token, `/api/orders?symbol=${symbol}`);
    assert.equal(status, 200);

    // Newest first.
    assert.deepEqual(
      body.orders.map((entry) => [entry.side, entry.status]),
      [
        ['SELL', 'REJECTED'],
        ['BUY', 'FILLED'],
      ],
    );

    const [rejected, filled] = body.orders;
    assert.equal(rejected.rejectCode, 'insufficient_shares');
    assert.equal(rejected.fillPrice, null, 'a rejection has no price, not a price of zero');
    assert.equal(rejected.notional, null);
    assert.equal(rejected.filledQuantity, 0);

    assert.equal(filled.rejectCode, null);
    assert.equal(filled.limitPrice, null, 'a market order named no price');
    assert.ok(filled.fillPrice > 0);
    assert.ok(Math.abs(filled.notional - filled.fillPrice * 3) < 0.01);
    assert.ok(filled.tradeId, 'a fill points at its trade');
    assert.equal(filled.name.length > 0, true, 'and carries the stock name');
  });

  it('filters by status, and counts what it filtered', async () => {
    // `total` is over the same filter as the rows, which is what a pager needs. A
    // count over a different set is how a list claims more pages than exist.
    const token = await signIn('filterer');
    const symbol = await unheldSymbol(token);

    await order(token, { symbol, side: 'BUY', quantity: 1 });
    await order(token, { symbol, side: 'BUY', quantity: 1 });
    await order(token, { symbol, side: 'SELL', quantity: 400 });

    const { body: rejected } = await authed(token, `/api/orders?status=rejected&symbol=${symbol}`);
    assert.equal(rejected.total, 1);
    assert.equal(rejected.orders.length, 1);

    const { body: filled } = await authed(token, `/api/orders?status=FILLED&symbol=${symbol}`);
    assert.equal(filled.total, 2);
    assert.ok(filled.orders.every((entry) => entry.status === 'FILLED'));
  });

  it('rejects a status nobody has', async () => {
    // Rather than an empty list, which is indistinguishable from "you have no
    // rejected orders" — the answer somebody who typed REJECTD would believe.
    const token = await signIn('typo');
    const { status, body } = await authed(token, '/api/orders?status=REJECTD');

    assert.equal(status, 400);
    assert.equal(body.error.code, 'invalid_status');
  });

  it('pages without repeating or dropping a row', async () => {
    // Market orders are placed and resolved in one transaction, so several can share
    // a timestamp to the microsecond. Without the id tiebreak the pages overlap.
    const token = await signIn('pager');
    const symbol = await unheldSymbol(token);

    for (let i = 0; i < 6; i += 1) {
      await order(token, { symbol, side: 'BUY', quantity: 1 });
    }

    const { body: all } = await authed(token, `/api/orders?symbol=${symbol}&limit=6`);
    const { body: first } = await authed(token, `/api/orders?symbol=${symbol}&limit=3`);
    const { body: second } = await authed(token, `/api/orders?symbol=${symbol}&limit=3&offset=3`);

    assert.equal(all.total, 6);
    assert.deepEqual(
      [...first.orders, ...second.orders].map((entry) => entry.id),
      all.orders.map((entry) => entry.id),
    );
    assert.equal(new Set([...first.orders, ...second.orders].map((e) => e.id)).size, 6);
  });

  it('reports zero for a page past the end', async () => {
    const token = await signIn('overshooter');
    const { body } = await authed(token, '/api/orders?offset=100000');

    assert.deepEqual(body.orders, []);
    assert.equal(body.total, 0);
  });

  it('treats a negative offset as the start of the list', async () => {
    // A caller's arithmetic slipping past the front. Postgres errors on a negative
    // OFFSET, so this cannot simply be passed through.
    const token = await signIn('negative');
    const { status, body } = await authed(token, '/api/orders?offset=-5&limit=2');

    assert.equal(status, 200);
    assert.equal(body.offset, 0);
  });

  it('fetches one order by id', async () => {
    const token = await signIn('fetcher');
    const symbol = await unheldSymbol(token);

    const { body: placed } = await order(token, { symbol, side: 'BUY', quantity: 2 });
    const { status, body } = await authed(token, `/api/orders/${placed.order.id}`);

    assert.equal(status, 200);
    assert.equal(body.id, placed.order.id);
    assert.equal(body.symbol, symbol);
    assert.equal(body.filledQuantity, 2);
  });

  it('will not show one account another account order', async () => {
    // A 404, not a 403. A 403 would confirm the id exists, which is the one thing a
    // stranger guessing ids should not be able to learn.
    const mine = await signIn('owner');
    const symbol = await unheldSymbol(mine);
    const { body: placed } = await order(mine, { symbol, side: 'BUY', quantity: 1 });

    const theirs = await signIn('stranger');
    const { status, body } = await authed(theirs, `/api/orders/${placed.order.id}`);

    assert.equal(status, 404);
    assert.equal(body.error.code, 'order_not_found');
  });

  it('rejects an id that is not one', async () => {
    const token = await signIn('nonsense');
    const { status, body } = await authed(token, '/api/orders/abc');

    assert.equal(status, 400);
    assert.equal(body.error.code, 'invalid_parameter');
  });

  it('shows a freshly created account the orders behind its holdings', async () => {
    // Accounts are generated on first sign-in, and the seed writes an order for every
    // lot it creates. An order list that claimed a brand new account had never traded
    // while the ledger showed twenty purchases would be its own kind of wrong.
    const token = await signIn('fresh.arrival');
    const { body } = await authed(token, '/api/orders?limit=200');

    assert.ok(body.total > 0);
    assert.ok(body.orders.every((entry) => entry.status === 'FILLED' && entry.side === 'BUY'));
  });
});
