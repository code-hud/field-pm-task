/**
 * The order record, against a real database.
 *
 * A market order and the trade it becomes are the same event today, so most of what
 * is asserted here is that the two agree. The value is in what that buys later: an
 * order that exists without having filled has somewhere to live, and the constraints
 * that make a half-written fill impossible are already in force.
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

const accountIdOf = async (username) => {
  const { rows } = await query('SELECT id FROM accounts WHERE username_key = $1', [
    username.toLowerCase(),
  ]);
  return rows[0].id;
};

const orderRow = async (id) => {
  const { rows } = await query('SELECT * FROM orders WHERE id = $1', [id]);
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

describe('order records', () => {
  it('records the order a fill came from, and hands back its id', async () => {
    const token = await signIn('recorder');
    const symbol = await unheldSymbol(token);

    const { status, body } = await order(token, { symbol, side: 'BUY', quantity: 4 });
    assert.equal(status, 201);
    assert.ok(body.order.id, 'the receipt carries an order id');

    const row = await orderRow(body.order.id);
    assert.equal(row.symbol, symbol);
    assert.equal(row.side, 'BUY');
    assert.equal(row.type, 'MARKET');
    assert.equal(row.status, 'FILLED');
    assert.equal(Number(row.quantity), 4);
    assert.equal(Number(row.filled_quantity), 4);
    assert.equal(Number(row.fill_price), body.order.price);
    assert.ok(row.resolved_at, 'a resolved order says when it stopped being live');
  });

  it('points at the trade it became, and at the same numbers', async () => {
    const token = await signIn('pointer');
    const symbol = await unheldSymbol(token);

    const { body } = await order(token, { symbol, side: 'BUY', quantity: 2 });
    const row = await orderRow(body.order.id);

    const { rows } = await query('SELECT * FROM trades WHERE id = $1', [row.trade_id]);
    const trade = rows[0];

    assert.equal(trade.symbol, row.symbol);
    assert.equal(trade.side, row.side);
    assert.equal(Number(trade.quantity), Number(row.filled_quantity));
    assert.equal(Number(trade.price), Number(row.fill_price));
  });

  it('records the sell side too, alongside its closures', async () => {
    const token = await signIn('seller');
    const symbol = await unheldSymbol(token);

    await order(token, { symbol, side: 'BUY', quantity: 5 });
    const { body } = await order(token, { symbol, side: 'SELL', quantity: 3 });

    const row = await orderRow(body.order.id);
    assert.equal(row.side, 'SELL');
    assert.equal(Number(row.filled_quantity), 3);

    const { rows } = await query('SELECT count(*)::int AS total FROM lot_closures WHERE trade_id = $1', [
      row.trade_id,
    ]);
    assert.equal(rows[0].total, 1, 'the same fill wrote both records');
  });

  it('leaves no filled order behind when the fill is refused', async () => {
    // The FILLED row is written inside the fill's transaction, so a refusal rolls it
    // back with everything else. What the account is left with is a REJECTED order —
    // written afterwards, on its own connection, precisely because it has to outlive
    // that rollback. `order-rejections.test.js` covers that side.
    const token = await signIn('refused');
    const accountId = await accountIdOf('refused');
    const symbol = await unheldSymbol(token);

    const before = await filledCount(accountId);
    const { status } = await order(token, { symbol, side: 'SELL', quantity: 5 });
    assert.equal(status, 422);

    assert.equal(await filledCount(accountId), before);
  });

  it('gave every trade that predates the table an order', async () => {
    // The backfill. A trade is the record of a market order that filled in full at
    // one price, so unlike the lot closures in 004 there is nothing to invent here.
    const token = await signIn('backfilled');
    const accountId = await accountIdOf('backfilled');

    const { rows } = await query(
      `SELECT count(*)::int AS trades,
              count(o.id)::int AS with_orders
       FROM trades t LEFT JOIN orders o ON o.trade_id = t.id
       WHERE t.account_id = $1`,
      [accountId],
    );

    assert.ok(rows[0].trades > 0, 'the seeded account has trades');
    assert.equal(rows[0].with_orders, rows[0].trades, 'and every one of them has an order');
  });

  it('refuses to record a fill that is only half written', async () => {
    // The constraint is the point of the table having one. A FILLED row missing its
    // price, its trade, or its quantity would read later as a complete fill.
    const token = await signIn('halfwritten');
    const accountId = await accountIdOf('halfwritten');
    const symbol = await unheldSymbol(token);

    await assert.rejects(
      query(
        `INSERT INTO orders (account_id, symbol, side, type, quantity, status, filled_quantity, resolved_at)
         VALUES ($1, $2, 'BUY', 'MARKET', 3, 'FILLED', 3, now())`,
        [accountId, symbol],
      ),
      /orders_filled_is_complete/,
    );
  });

  it('refuses to let two orders claim the same fill', async () => {
    const token = await signIn('doubleclaim');
    const accountId = await accountIdOf('doubleclaim');
    const symbol = await unheldSymbol(token);

    const { body } = await order(token, { symbol, side: 'BUY', quantity: 1 });
    const row = await orderRow(body.order.id);

    await assert.rejects(
      query(
        `INSERT INTO orders (account_id, symbol, side, type, quantity, status,
                             filled_quantity, fill_price, trade_id, resolved_at)
         VALUES ($1, $2, 'BUY', 'MARKET', 1, 'FILLED', 1, 10, $3, now())`,
        [accountId, symbol, row.trade_id],
      ),
      /orders_one_per_trade/,
    );
  });

  it('refuses an order type the fill path does not know about', async () => {
    // Widening the type is a migration on purpose. A new type reaching the fill path
    // because someone added a string somewhere is the change this makes impossible.
    const token = await signIn('unknowntype');
    const symbol = await unheldSymbol(token);

    const { body } = await order(token, { symbol, side: 'BUY', quantity: 1 });

    await assert.rejects(
      query('UPDATE orders SET type = $2 WHERE id = $1', [body.order.id, 'STOP']),
      /orders_type_check/,
    );
  });
});

const filledCount = async (accountId) => {
  const { rows } = await query(
    `SELECT count(*)::int AS total FROM orders WHERE account_id = $1 AND status = 'FILLED'`,
    [accountId],
  );
  return rows[0].total;
};
