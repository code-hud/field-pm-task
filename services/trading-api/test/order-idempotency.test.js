/**
 * Retrying an order without placing it twice.
 *
 * The sequential replay is the easy half. The interesting one is two requests carrying
 * the same key at the same moment: the loser blocks on the unique index until the
 * winner commits, and by then it has done the whole fill — lots, closures, the trade,
 * the cash movement — while holding the account row lock. What makes replaying safe is
 * that all of it is rolled back, and that is what these assert.
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

const call = async (path, options = {}) => {
  const response = await fetch(`${baseUrl}${path}`, options);
  return { status: response.status, body: await response.json().catch(() => null) };
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

const order = (token, payload, key) =>
  call('/api/orders', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
      ...(key ? { 'idempotency-key': key } : {}),
    },
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

const accountIdOf = async (username) => {
  const { rows } = await query('SELECT id FROM accounts WHERE username_key = $1', [
    username.toLowerCase(),
  ]);
  return rows[0].id;
};

const counts = async (accountId, symbol) => {
  const { rows } = await query(
    `SELECT (SELECT count(*)::int FROM trades WHERE account_id = $1 AND symbol = $2)  AS trades,
            (SELECT count(*)::int FROM orders WHERE account_id = $1 AND symbol = $2)  AS orders`,
    [accountId, symbol],
  );
  return rows[0];
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

describe('an order placed twice with one key', () => {
  it('fills once and replays the second time', async () => {
    const token = await signIn('idem-basic');
    const accountId = await accountIdOf('idem-basic');
    const symbol = await unheldSymbol(token);

    const first = await order(token, { symbol, side: 'BUY', quantity: 3 }, 'key-basic');
    assert.equal(first.status, 201);

    const second = await order(token, { symbol, side: 'BUY', quantity: 3 }, 'key-basic');

    // 200, not 201: nothing moved on this request.
    assert.equal(second.status, 200);
    assert.equal(second.body.replayed, true);
    assert.equal(second.body.order.id, first.body.order.id);

    const { trades, orders } = await counts(accountId, symbol);
    assert.equal(trades, 1, 'one trade');
    assert.equal(orders, 1, 'one order');
  });

  it('moves the cash once', async () => {
    const token = await signIn('idem-cash');
    const symbol = await unheldSymbol(token);

    const { body: before } = await authed(token, '/api/portfolio');
    const { body: receipt } = await order(token, { symbol, side: 'BUY', quantity: 2 }, 'key-cash');
    const { body: afterFirst } = await authed(token, '/api/portfolio');
    await order(token, { symbol, side: 'BUY', quantity: 2 }, 'key-cash');
    const { body: afterSecond } = await authed(token, '/api/portfolio');

    assert.ok(
      Math.abs(before.summary.cash - afterFirst.summary.cash - receipt.order.notional) < 0.01,
    );
    assert.equal(afterSecond.summary.cash, afterFirst.summary.cash, 'the retry cost nothing');
  });

  it('survives two requests racing with the same key', async () => {
    // The concurrent case. Whichever loses blocks on the unique index until the winner
    // commits, discovers the duplicate after having done the entire fill, and has all
    // of it rolled back.
    const token = await signIn('idem-race');
    const accountId = await accountIdOf('idem-race');
    const symbol = await unheldSymbol(token);

    const [a, b] = await Promise.all([
      order(token, { symbol, side: 'BUY', quantity: 4 }, 'key-race'),
      order(token, { symbol, side: 'BUY', quantity: 4 }, 'key-race'),
    ]);

    const statuses = [a.status, b.status].sort();
    assert.deepEqual(statuses, [200, 201], 'one placed it, one replayed it');

    const { trades, orders } = await counts(accountId, symbol);
    assert.equal(trades, 1, 'exactly one trade');
    assert.equal(orders, 1, 'exactly one order');

    // And both callers were told about the same order.
    const placed = a.status === 201 ? a.body.order.id : b.body.order.id;
    const replayed = a.status === 200 ? a.body.order.id : b.body.order.id;
    assert.equal(replayed, placed);
  });

  it('leaves a lot behind for exactly one of the two', async () => {
    // The rollback, checked where it would show if it were incomplete: the loser wrote
    // a lot and a closure before its insert raised.
    const token = await signIn('idem-lots');
    const accountId = await accountIdOf('idem-lots');
    const symbol = await unheldSymbol(token);

    await Promise.all([
      order(token, { symbol, side: 'BUY', quantity: 5 }, 'key-lots'),
      order(token, { symbol, side: 'BUY', quantity: 5 }, 'key-lots'),
    ]);

    const { rows } = await query(
      `SELECT count(*)::int AS lots, COALESCE(SUM(l.quantity), 0)::int AS shares
       FROM lots l JOIN positions p ON p.id = l.position_id
       WHERE p.account_id = $1 AND p.symbol = $2`,
      [accountId, symbol],
    );
    assert.equal(rows[0].lots, 1);
    assert.equal(rows[0].shares, 5);
  });

  it('replays a resting order too', async () => {
    const token = await signIn('idem-resting');
    const symbol = await unheldSymbol(token);
    await repriceTo(symbol, 100);

    const first = await order(
      token,
      { symbol, side: 'BUY', quantity: 1, type: 'LIMIT', limitPrice: 80 },
      'key-rest',
    );
    assert.equal(first.status, 202);

    const second = await order(
      token,
      { symbol, side: 'BUY', quantity: 1, type: 'LIMIT', limitPrice: 80 },
      'key-rest',
    );

    assert.equal(second.status, 200);
    assert.equal(second.body.order.status, 'OPEN');
    assert.equal(second.body.order.id, first.body.order.id);
  });

  it('does not let a refusal burn the key', async () => {
    // A key consumed by a rejection the caller may never have seen would turn a
    // retryable failure into a permanent one.
    const token = await signIn('idem-refused');
    const symbol = await unheldSymbol(token);

    const refused = await order(token, { symbol, side: 'SELL', quantity: 9 }, 'key-refused');
    assert.equal(refused.status, 422);

    // The same key, now for something the account can actually do.
    const accepted = await order(token, { symbol, side: 'BUY', quantity: 1 }, 'key-refused');
    assert.equal(accepted.status, 201, 'the key was still available');
  });

  it('does not file the duplicate as a rejection', async () => {
    // A duplicate key is not a refusal of the order; it is this request losing a race
    // to an order that exists. A REJECTED row beside the FILLED one would describe one
    // intent as two outcomes.
    const token = await signIn('idem-notrejected');
    const accountId = await accountIdOf('idem-notrejected');
    const symbol = await unheldSymbol(token);

    await Promise.all([
      order(token, { symbol, side: 'BUY', quantity: 1 }, 'key-dupe'),
      order(token, { symbol, side: 'BUY', quantity: 1 }, 'key-dupe'),
    ]);

    const { rows } = await query(
      `SELECT count(*)::int AS n FROM orders
        WHERE account_id = $1 AND status = 'REJECTED' AND symbol = $2`,
      [accountId, symbol],
    );
    assert.equal(rows[0].n, 0);
  });

  it('scopes the key to the account', async () => {
    const mine = await signIn('idem-mine');
    const theirs = await signIn('idem-theirs');
    const symbol = await unheldSymbol(mine);

    assert.equal((await order(mine, { symbol, side: 'BUY', quantity: 1 }, 'shared')).status, 201);
    // Two customers picking the same key are two orders, not one.
    assert.equal((await order(theirs, { symbol, side: 'BUY', quantity: 1 }, 'shared')).status, 201);
  });

  it('behaves exactly as before with no key', async () => {
    const token = await signIn('idem-nokey');
    const accountId = await accountIdOf('idem-nokey');
    const symbol = await unheldSymbol(token);

    await order(token, { symbol, side: 'BUY', quantity: 1 });
    await order(token, { symbol, side: 'BUY', quantity: 1 });

    const { trades } = await counts(accountId, symbol);
    assert.equal(trades, 2, 'two orders, because nothing said they were one');
  });

  it('refuses a key that is present but empty', async () => {
    // A caller that meant to send one and did not. Treating it as absent is how
    // somebody ends up believing they have protection they do not.
    const token = await signIn('idem-blank');
    const symbol = await unheldSymbol(token);

    const { status, body } = await call('/api/orders', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
        'idempotency-key': '   ',
      },
      body: JSON.stringify({ symbol, side: 'BUY', quantity: 1 }),
    });

    assert.equal(status, 400);
    assert.equal(body.error.code, 'invalid_idempotency_key');
  });

  it('refuses a key longer than the column', async () => {
    const token = await signIn('idem-long');
    const symbol = await unheldSymbol(token);

    const { status, body } = await order(
      token,
      { symbol, side: 'BUY', quantity: 1 },
      'x'.repeat(129),
    );

    assert.equal(status, 400);
    assert.equal(body.error.code, 'invalid_idempotency_key');
  });

  it('records the key on the order it placed', async () => {
    const token = await signIn('idem-recorded');
    const symbol = await unheldSymbol(token);

    const { body } = await order(token, { symbol, side: 'BUY', quantity: 1 }, 'key-recorded');

    const { rows } = await query('SELECT client_order_id FROM orders WHERE id = $1', [
      body.order.id,
    ]);
    assert.equal(rows[0].client_order_id, 'key-recorded');
  });
});
