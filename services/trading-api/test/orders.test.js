/**
 * Order entry, against a real database.
 *
 * These assert the invariant that makes order entry honest: after a fill, the
 * portfolio read — which derives everything from `lots` and `accounts.cash` — agrees
 * with what the fill said it did. A mocked repository would prove nothing here,
 * since the whole point is that the rows moved.
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

/** A symbol the account does not already hold, so buys start from a clean slate. */
const unheldSymbol = async (token) => {
  const { body: portfolio } = await authed(token, '/api/portfolio');
  const held = new Set(portfolio.positions.map((position) => position.symbol));
  const { body: market } = await authed(token, '/api/market/instruments');
  return market.instruments.find((quote) => !held.has(quote.symbol)).symbol;
};

before(async () => {
  if (!(await databaseIsReachable())) {
    throw new Error(
      `No Postgres at ${baseUrlForMessages()}. Start one with \`make db-up\` (or \`docker compose up -d postgres\`), ` +
        'or point TEST_DATABASE_URL at your own.',
    );
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

describe('order entry', () => {
  it('requires a token', async () => {
    const { status } = await call('/api/orders', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ symbol: 'NVAX', side: 'BUY', quantity: 1 }),
    });
    assert.equal(status, 401);
  });

  it('fills a buy, debits cash, and shows up in the portfolio', async () => {
    const token = await signIn('buyer');
    const symbol = await unheldSymbol(token);
    const { body: before } = await authed(token, '/api/portfolio');

    const { status, body } = await order(token, { symbol, side: 'BUY', quantity: 3 });
    assert.equal(status, 201);
    assert.equal(body.order.status, 'FILLED');
    assert.equal(body.order.symbol, symbol);
    assert.equal(body.order.quantity, 3);
    assert.ok(body.order.price > 0);
    assert.ok(Math.abs(body.order.notional - body.order.price * 3) < 0.01);
    assert.equal(body.position.quantity, 3);

    const { body: after } = await authed(token, '/api/portfolio');
    assert.ok(
      Math.abs(after.summary.cash - (before.summary.cash - body.order.notional)) < 0.01,
      'cash falls by exactly the notional',
    );

    const position = after.positions.find((entry) => entry.symbol === symbol);
    assert.equal(position.quantity, 3);
    assert.ok(Math.abs(position.averageCost - body.order.price) < 0.01);
  });

  it('adds to an existing position as a second lot', async () => {
    const token = await signIn('adder');
    const symbol = await unheldSymbol(token);

    await order(token, { symbol, side: 'BUY', quantity: 2 });
    const { body: second } = await order(token, { symbol, side: 'BUY', quantity: 5 });
    assert.equal(second.position.quantity, 7);

    const { body: ledger } = await authed(token, '/api/portfolio/transactions?limit=200');
    const buys = ledger.transactions.filter((entry) => entry.type === 'BUY' && entry.symbol === symbol);
    assert.equal(buys.length, 2, 'each fill is its own lot, and its own ledger line');
  });

  it('fills a sell, credits cash, and reduces the holding', async () => {
    const token = await signIn('seller');
    const { body: before } = await authed(token, '/api/portfolio');
    const holding = before.positions[0];

    const quantity = Math.max(1, Math.floor(holding.quantity / 2));
    const { status, body } = await order(token, { symbol: holding.symbol, side: 'SELL', quantity });
    assert.equal(status, 201);
    assert.equal(body.position.quantity, holding.quantity - quantity);

    const { body: after } = await authed(token, '/api/portfolio');
    assert.ok(
      Math.abs(after.summary.cash - (before.summary.cash + body.order.notional)) < 0.01,
      'cash rises by exactly the proceeds',
    );
    assert.equal(
      after.positions.find((entry) => entry.symbol === holding.symbol).quantity,
      holding.quantity - quantity,
    );
  });

  it('closes the position when the last share is sold', async () => {
    const token = await signIn('closer');
    const { body: before } = await authed(token, '/api/portfolio');
    const holding = before.positions[0];

    const { body } = await order(token, {
      symbol: holding.symbol,
      side: 'SELL',
      quantity: holding.quantity,
    });
    assert.equal(body.position.quantity, 0);
    assert.equal(body.position.closed, true);

    const { body: after } = await authed(token, '/api/portfolio');
    assert.ok(!after.positions.some((entry) => entry.symbol === holding.symbol));
    assert.equal(after.summary.positionCount, before.summary.positionCount - 1);
  });

  it('leaves the portfolio internally consistent after trading', async () => {
    const token = await signIn('consistency');
    const symbol = await unheldSymbol(token);
    await order(token, { symbol, side: 'BUY', quantity: 4 });
    await order(token, { symbol, side: 'SELL', quantity: 1 });

    const { body: portfolio } = await authed(token, '/api/portfolio');
    const marketValue = portfolio.positions.reduce((total, entry) => total + entry.marketValue, 0);
    assert.ok(Math.abs(marketValue - portfolio.summary.marketValue) < 0.05);
    assert.ok(
      Math.abs(portfolio.summary.totalValue - (portfolio.summary.marketValue + portfolio.summary.cash)) < 0.05,
    );

    // The curve is pinned to the live valuation, which is what the header shows.
    const { body: history } = await authed(token, '/api/portfolio/history?range=3M');
    assert.equal(history.points.at(-1).value, portfolio.summary.totalValue);

    const { body: allocation } = await authed(token, '/api/portfolio/allocation');
    const sectorTotal = allocation.sectors.reduce((total, entry) => total + entry.marketValue, 0);
    assert.ok(Math.abs(sectorTotal - portfolio.summary.marketValue) < 1);
  });

  it('refuses a buy the account cannot afford, and changes nothing', async () => {
    const token = await signIn('broke');
    const { body: before } = await authed(token, '/api/portfolio');
    const symbol = await unheldSymbol(token);

    const { status, body } = await order(token, { symbol, side: 'BUY', quantity: 1_000_000 });
    assert.equal(status, 422);
    assert.equal(body.error.code, 'insufficient_cash');

    const { body: after } = await authed(token, '/api/portfolio');
    assert.equal(after.summary.cash, before.summary.cash);
    assert.equal(after.summary.positionCount, before.summary.positionCount);
  });

  it('refuses to sell shares the account does not hold', async () => {
    const token = await signIn('shortseller');
    const unheld = await unheldSymbol(token);

    const missing = await order(token, { symbol: unheld, side: 'SELL', quantity: 1 });
    assert.equal(missing.status, 422);
    assert.equal(missing.body.error.code, 'insufficient_shares');

    const { body: portfolio } = await authed(token, '/api/portfolio');
    const holding = portfolio.positions[0];
    const tooMany = await order(token, {
      symbol: holding.symbol,
      side: 'SELL',
      quantity: holding.quantity + 1,
    });
    assert.equal(tooMany.status, 422);
    assert.equal(tooMany.body.error.code, 'insufficient_shares');
  });

  it('rejects unknown symbols and malformed orders', async () => {
    const token = await signIn('validator');

    const unknown = await order(token, { symbol: 'NOPE', side: 'BUY', quantity: 1 });
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.error.code, 'unknown_symbol');

    const cases = [
      [{ symbol: 'NVAX', side: 'HOLD', quantity: 1 }, 'invalid_side'],
      [{ symbol: '', side: 'BUY', quantity: 1 }, 'symbol_required'],
      [{ symbol: 'NVAX', side: 'BUY', quantity: 0 }, 'invalid_quantity'],
      [{ symbol: 'NVAX', side: 'BUY', quantity: -5 }, 'invalid_quantity'],
      [{ symbol: 'NVAX', side: 'BUY', quantity: 1.5 }, 'invalid_quantity'],
      [{ symbol: 'NVAX', side: 'BUY', quantity: 'lots' }, 'invalid_quantity'],
      [{ symbol: 'NVAX', side: 'BUY', quantity: 1, type: 'STOP' }, 'invalid_order_type'],
      // LIMIT is a supported type now, but not without a price.
      [{ symbol: 'NVAX', side: 'BUY', quantity: 1, type: 'LIMIT' }, 'limit_price_required'],
    ];

    for (const [payload, code] of cases) {
      const { status, body } = await order(token, payload);
      assert.equal(status, 400, `${JSON.stringify(payload)} is a 400`);
      assert.equal(body.error.code, code);
    }
  });

  it('accepts a lowercase symbol and side', async () => {
    const token = await signIn('caseinsensitive');
    const symbol = await unheldSymbol(token);
    const { status, body } = await order(token, {
      symbol: symbol.toLowerCase(),
      side: 'buy',
      quantity: 1,
    });
    assert.equal(status, 201);
    assert.equal(body.order.symbol, symbol);
    assert.equal(body.order.side, 'BUY');
  });

  it('does not overdraw when concurrent buys race for the same cash', async () => {
    const token = await signIn('racer');
    const symbol = await unheldSymbol(token);
    const { body: before } = await authed(token, '/api/portfolio');
    const { body: quote } = await authed(token, `/api/market/instruments/${symbol}`);

    // Each order alone is affordable; together they are not. Without the row lock
    // both would read the same balance and both would pass the check.
    const quantity = Math.ceil((before.summary.cash * 0.6) / quote.price);
    const results = await Promise.all([
      order(token, { symbol, side: 'BUY', quantity }),
      order(token, { symbol, side: 'BUY', quantity }),
    ]);

    assert.equal(results.filter((result) => result.status === 201).length, 1, 'exactly one fills');
    assert.equal(results.filter((result) => result.status === 422).length, 1, 'the other is rejected');

    const { body: after } = await authed(token, '/api/portfolio');
    assert.ok(after.summary.cash >= 0, 'cash never goes negative');
  });
});
