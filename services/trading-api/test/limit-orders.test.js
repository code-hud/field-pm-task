/**
 * Limit orders that fill immediately.
 *
 * A limit order carries one promise: it will not fill at a worse price than the one
 * the customer named. Everything here is about that promise — that it is kept, that
 * it is checked against the price the fill actually uses, and that the improvement
 * when the market is better than the limit goes to the customer.
 *
 * An order the market has not reached rests instead — `resting-orders.test.js` covers
 * what happens to it after that.
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

const unheldSymbol = async (token) => {
  const { body: portfolio } = await authed(token, '/api/portfolio');
  const held = new Set(portfolio.positions.map((position) => position.symbol));
  const { body: market } = await authed(token, '/api/market/stocks');
  return market.stocks.find((quote) => !held.has(quote.symbol)).symbol;
};

const repriceTo = async (symbol, price) => {
  await query('UPDATE quotes SET price = $2 WHERE symbol = $1', [symbol, price]);
};

const orderRow = async (id) => {
  const { rows } = await query('SELECT * FROM orders WHERE id = $1', [id]);
  return rows[0];
};

const accountIdOf = async (username) => {
  const { rows } = await query('SELECT id FROM accounts WHERE username_key = $1', [
    username.toLowerCase(),
  ]);
  return rows[0].id;
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

describe('limit orders', () => {
  it('fills a buy at the market, not at the limit', async () => {
    // The improvement belongs to the customer. A limit is the worst price
    // acceptable, not the price to trade at.
    const token = await signIn('limit-buyer');
    const symbol = await unheldSymbol(token);
    await repriceTo(symbol, 40);

    const { status, body } = await order(token, {
      symbol,
      side: 'BUY',
      quantity: 5,
      type: 'LIMIT',
      limitPrice: 50,
    });

    assert.equal(status, 201);
    assert.equal(body.order.type, 'LIMIT');
    assert.equal(body.order.limitPrice, 50);
    assert.equal(body.order.price, 40, 'filled at the market');
    assert.equal(body.order.priceImprovement, 10);
    assert.equal(body.order.notional, 200);
  });

  it('fills a sell above its limit and keeps the difference', async () => {
    const token = await signIn('limit-seller');
    const symbol = await unheldSymbol(token);

    await repriceTo(symbol, 30);
    await order(token, { symbol, side: 'BUY', quantity: 4 });

    await repriceTo(symbol, 45);
    const { body } = await order(token, {
      symbol,
      side: 'SELL',
      quantity: 4,
      type: 'LIMIT',
      limitPrice: 35,
    });

    assert.equal(body.order.price, 45);
    assert.equal(body.order.priceImprovement, 10);
    assert.equal(body.order.realizedPnl, 60); // 4 × (45 − 30)
  });

  it('fills at exactly the limit', async () => {
    // A limit is the worst price acceptable, not a price to beat, so equality fills.
    const token = await signIn('limit-exact');
    const symbol = await unheldSymbol(token);
    await repriceTo(symbol, 42.5);

    const { status, body } = await order(token, {
      symbol,
      side: 'BUY',
      quantity: 1,
      type: 'LIMIT',
      limitPrice: 42.5,
    });

    assert.equal(status, 201);
    assert.equal(body.order.priceImprovement, 0);
  });

  it('rests a buy limit below the market instead of filling it', async () => {
    const token = await signIn('limit-lowball');
    const accountId = await accountIdOf('limit-lowball');
    const symbol = await unheldSymbol(token);
    await repriceTo(symbol, 60);

    const { body: before } = await authed(token, '/api/portfolio');
    const { status, body } = await order(token, {
      symbol,
      side: 'BUY',
      quantity: 2,
      type: 'LIMIT',
      limitPrice: 55,
    });

    // 202, not 201: the venue has accepted an instruction it has not carried out.
    assert.equal(status, 202);
    assert.equal(body.order.status, 'OPEN');
    assert.equal(body.order.price, null, 'nothing was bought, so there is no price');
    assert.equal(body.order.marketPrice, 60, 'and the market is reported as context');

    const { body: after } = await authed(token, '/api/portfolio');
    assert.equal(after.summary.cash, before.summary.cash, 'nothing moved');

    const { rows } = await query(
      `SELECT * FROM orders WHERE account_id = $1 ORDER BY id DESC LIMIT 1`,
      [accountId],
    );
    assert.equal(rows[0].status, 'OPEN');
    assert.equal(Number(rows[0].limit_price), 55);
    assert.equal(rows[0].resolved_at, null, 'a waiting order has not resolved');
  });

  it('rests a sell limit above the market', async () => {
    const token = await signIn('limit-greedy');
    const symbol = await unheldSymbol(token);

    await repriceTo(symbol, 20);
    await order(token, { symbol, side: 'BUY', quantity: 3 });

    const { status, body } = await order(token, {
      symbol,
      side: 'SELL',
      quantity: 3,
      type: 'LIMIT',
      limitPrice: 25,
    });

    assert.equal(status, 202);
    assert.equal(body.order.status, 'OPEN');
  });

  it('records the limit on the filled order', async () => {
    const token = await signIn('limit-recorded');
    const symbol = await unheldSymbol(token);
    await repriceTo(symbol, 12);

    const { body } = await order(token, {
      symbol,
      side: 'BUY',
      quantity: 2,
      type: 'LIMIT',
      limitPrice: 15,
    });

    const row = await orderRow(body.order.id);
    assert.equal(row.type, 'LIMIT');
    assert.equal(Number(row.limit_price), 15);
    assert.equal(Number(row.fill_price), 12);
  });

  it('will not let a filled buy limit record a price above its limit', async () => {
    // The duplicated check. The fill path already refuses this; the constraint is
    // there because the fill path is where the bug would be — an inverted comparison,
    // or a marketability test moved outside the transaction and racing the tape.
    const token = await signIn('limit-constraint');
    const symbol = await unheldSymbol(token);
    await repriceTo(symbol, 12);

    const { body } = await order(token, {
      symbol,
      side: 'BUY',
      quantity: 1,
      type: 'LIMIT',
      limitPrice: 15,
    });

    await assert.rejects(
      query('UPDATE orders SET fill_price = 16 WHERE id = $1', [body.order.id]),
      /orders_fill_respects_limit/,
    );
  });

  it('will not let a market order carry a limit price', async () => {
    const token = await signIn('limit-mismatch');
    const symbol = await unheldSymbol(token);

    const { body } = await order(token, { symbol, side: 'BUY', quantity: 1 });

    await assert.rejects(
      query('UPDATE orders SET limit_price = 10 WHERE id = $1', [body.order.id]),
      /orders_limit_price_matches_type/,
    );
  });

  it('refuses a limit price with more precision than a price has', async () => {
    // Refused rather than rounded. Rounding 41.33335 up to 41.3334 raises the price
    // the customer authorised, on the one number they were explicit about.
    const token = await signIn('limit-precise');
    const symbol = await unheldSymbol(token);

    const cases = [
      [{ limitPrice: 41.33335 }, 'invalid_limit_price'],
      [{ limitPrice: 0 }, 'invalid_limit_price'],
      [{ limitPrice: -5 }, 'invalid_limit_price'],
      [{ limitPrice: 'cheap' }, 'invalid_limit_price'],
      [{ limitPrice: 1e9 }, 'invalid_limit_price'],
      [{}, 'limit_price_required'],
      [{ limitPrice: null }, 'limit_price_required'],
    ];

    for (const [extra, code] of cases) {
      const { status, body } = await order(token, {
        symbol,
        side: 'BUY',
        quantity: 1,
        type: 'LIMIT',
        ...extra,
      });
      assert.equal(status, 400, `${JSON.stringify(extra)} is a 400`);
      assert.equal(body.error.code, code, JSON.stringify(extra));
    }
  });

  it('refuses a limit price on a market order', async () => {
    const token = await signIn('limit-unexpected');
    const symbol = await unheldSymbol(token);

    const { status, body } = await order(token, {
      symbol,
      side: 'BUY',
      quantity: 1,
      limitPrice: 40,
    });

    assert.equal(status, 400);
    assert.equal(body.error.code, 'unexpected_limit_price');
  });

  it('accepts four decimal places, the precision a quote has', async () => {
    const token = await signIn('limit-fourdp');
    const symbol = await unheldSymbol(token);
    await repriceTo(symbol, 33.1234);

    const { status, body } = await order(token, {
      symbol,
      side: 'BUY',
      quantity: 1,
      type: 'LIMIT',
      limitPrice: 33.1234,
    });

    assert.equal(status, 201);
    assert.equal(body.order.priceImprovement, 0);
  });

  it('shows up in the order log as a limit order', async () => {
    const token = await signIn('limit-logged');
    const symbol = await unheldSymbol(token);
    await repriceTo(symbol, 18);

    await order(token, { symbol, side: 'BUY', quantity: 1, type: 'LIMIT', limitPrice: 20 });
    await order(token, { symbol, side: 'BUY', quantity: 1, type: 'LIMIT', limitPrice: 10 });

    const { body } = await authed(token, `/api/orders?symbol=${symbol}`);
    assert.deepEqual(
      body.orders.map((entry) => [entry.type, entry.status]),
      [
        ['LIMIT', 'OPEN'],
        ['LIMIT', 'FILLED'],
      ],
    );
  });
});
