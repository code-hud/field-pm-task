/**
 * The property that motivated the trades table: trading today must not change what
 * the app says about yesterday.
 *
 * The bug these guard against was measured, not theorised — selling one position
 * moved 222 of 251 charted sessions (largest $2,559) and shrank the ledger from 20
 * entries to 19, because both were reconstructed from lots that a sale deleted.
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

const authed = (token, path, options = {}) =>
  call(path, { ...options, headers: { authorization: `Bearer ${token}`, ...options.headers } });

const signIn = async (username) => {
  const { body } = await call('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password: 'demo' }),
  });
  return body.token;
};

const order = (token, body) =>
  authed(token, '/api/orders', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

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

describe('a sale does not rewrite history', () => {
  it('leaves every past point of the equity curve untouched', async () => {
    const token = await signIn('immutability.curve');
    const { body: portfolio } = await authed(token, '/api/portfolio');

    // The oldest position, so its history sits well inside the charted window and a
    // sale would have the most to rewrite.
    const target = [...portfolio.positions].sort((a, b) =>
      a.openedAt.localeCompare(b.openedAt),
    )[0];

    const { body: before } = await authed(token, '/api/portfolio/history?range=1Y');
    const { status } = await order(token, {
      symbol: target.symbol,
      side: 'SELL',
      quantity: target.quantity,
    });
    assert.equal(status, 201);

    const { body: after } = await authed(token, '/api/portfolio/history?range=1Y');
    assert.equal(after.points.length, before.points.length);

    // Every point except the last, which is deliberately pinned to the live
    // valuation and so moves whenever the tape does.
    const moved = [];
    for (let i = 0; i < before.points.length - 1; i += 1) {
      assert.equal(after.points[i].date, before.points[i].date, 'the session dates must line up');
      if (Math.abs(after.points[i].value - before.points[i].value) > 0.01) {
        moved.push({ date: before.points[i].date, from: before.points[i].value, to: after.points[i].value });
      }
    }

    assert.deepEqual(
      moved.slice(0, 5),
      [],
      `selling ${target.quantity} ${target.symbol} rewrote ${moved.length} past sessions`,
    );
  });

  it('grows the ledger and records the sell', async () => {
    const token = await signIn('immutability.ledger');
    const { body: portfolio } = await authed(token, '/api/portfolio');
    const target = portfolio.positions[0];

    const { body: before } = await authed(token, '/api/portfolio/transactions?limit=200');
    const buysBefore = before.transactions.filter(
      (t) => t.type === 'BUY' && t.symbol === target.symbol,
    ).length;
    assert.ok(buysBefore > 0, 'the position should have at least one recorded purchase');

    await order(token, { symbol: target.symbol, side: 'SELL', quantity: target.quantity });

    const { body: after } = await authed(token, '/api/portfolio/transactions?limit=200');

    assert.equal(after.total, before.total + 1, 'a trade must add exactly one ledger entry');
    assert.equal(
      after.transactions.filter((t) => t.type === 'BUY' && t.symbol === target.symbol).length,
      buysBefore,
      'the original purchase must survive the sale',
    );

    const sell = after.transactions.find((t) => t.type === 'SELL' && t.symbol === target.symbol);
    assert.ok(sell, 'the sale must appear in the ledger');
    assert.equal(sell.quantity, target.quantity);
    assert.ok(sell.amount > 0, 'a sale credits cash');
    assert.equal(typeof sell.realizedPnl, 'number');
  });

  it('keeps the position out of holdings once fully sold, without losing its history', async () => {
    const token = await signIn('immutability.closed');
    const { body: portfolio } = await authed(token, '/api/portfolio');
    const target = portfolio.positions[0];

    await order(token, { symbol: target.symbol, side: 'SELL', quantity: target.quantity });

    const { body: after } = await authed(token, '/api/portfolio');
    assert.ok(
      !after.positions.some((p) => p.symbol === target.symbol),
      'a fully sold position is not a holding',
    );
    assert.equal(after.summary.positionCount, portfolio.summary.positionCount - 1);

    const { body: ledger } = await authed(token, '/api/portfolio/transactions?limit=200');
    assert.ok(
      ledger.transactions.some((t) => t.symbol === target.symbol && t.type === 'BUY'),
      'its purchase is still in the history',
    );

    const { body: allocation } = await authed(token, '/api/portfolio/allocation');
    assert.ok(!allocation.holdings.some((h) => h.symbol === target.symbol));
  });
});

describe('realized P/L', () => {
  it('books the gain on the shares sold and leaves the rest unrealized', async () => {
    const token = await signIn('realized.partial');
    const { body: portfolio } = await authed(token, '/api/portfolio');
    assert.equal(portfolio.summary.realizedPnl, 0, 'nothing is realized before any sale');
    assert.equal(portfolio.summary.closedTrades, 0);

    // A position with enough shares to sell half and keep half.
    const target = portfolio.positions.find((p) => p.quantity >= 2);
    const half = Math.floor(target.quantity / 2);

    const { body: fill } = await order(token, {
      symbol: target.symbol,
      side: 'SELL',
      quantity: half,
    });
    assert.equal(typeof fill.order.realizedPnl, 'number');

    const { body: after } = await authed(token, '/api/portfolio');
    const still = after.positions.find((p) => p.symbol === target.symbol);

    assert.equal(still.quantity, target.quantity - half, 'the unsold shares are still held');
    assert.equal(after.summary.closedTrades, 1);
    assert.ok(
      Math.abs(after.summary.realizedPnl - fill.order.realizedPnl) < 0.02,
      'the summary books what the fill reported',
    );

    // FIFO, computed from the actual lots rather than from the position's average
    // cost. Those differ whenever a position has more than one lot, which is the
    // whole point of FIFO — an earlier version of this test used the average and
    // failed on a two-lot position for a correct reason.
    const { query } = require('../src/db/pool.js');
    const { rows: lots } = await query(
      `SELECT l.quantity, l.price
       FROM lots l
       JOIN positions p ON p.id = l.position_id
       JOIN accounts a ON a.id = p.account_id
       WHERE a.username_key = 'realized.partial' AND p.symbol = $1
       ORDER BY l.trade_date, l.id`,
      [target.symbol],
    );

    let remaining = half;
    let fifoCost = 0;
    for (const lot of lots) {
      if (remaining === 0) break;
      const taken = Math.min(lot.quantity, remaining);
      fifoCost += taken * lot.price;
      remaining -= taken;
    }

    const expected = half * fill.order.price - fifoCost;
    assert.ok(
      Math.abs(fill.order.realizedPnl - expected) < 0.02,
      `realized ${fill.order.realizedPnl} should equal proceeds minus FIFO cost ${expected.toFixed(2)}`,
    );
  });

  it('reports nothing realized on a purchase', async () => {
    const token = await signIn('realized.buy');
    const { body: fill } = await order(token, { symbol: 'AAPL', side: 'BUY', quantity: 1 });
    assert.equal(fill.order.realizedPnl, null, 'a buy realizes nothing — null, not zero');

    const { body: ledger } = await authed(token, '/api/portfolio/transactions?limit=200');
    const buy = ledger.transactions.find((t) => t.type === 'BUY' && t.symbol === 'AAPL');
    assert.equal(buy.realizedPnl, null);
  });

  it('adds up: total P/L is realized plus unrealized', async () => {
    const token = await signIn('realized.total');
    const { body: portfolio } = await authed(token, '/api/portfolio');
    const target = portfolio.positions.find((p) => p.quantity >= 2);
    await order(token, {
      symbol: target.symbol,
      side: 'SELL',
      quantity: Math.floor(target.quantity / 2),
    });

    const { body: after } = await authed(token, '/api/portfolio');
    assert.ok(
      Math.abs(after.summary.totalPnl - (after.summary.realizedPnl + after.summary.unrealizedPnl)) < 0.02,
    );
  });
});

describe('lots survive being sold', () => {
  it('records the sale as closed quantity rather than deleting the row', async () => {
    const token = await signIn('lots.survive');
    const { body: portfolio } = await authed(token, '/api/portfolio');
    const target = portfolio.positions.find((p) => p.quantity >= 2);

    const { query } = require('../src/db/pool.js');
    const lotsBefore = await query(
      `SELECT count(*)::int AS n FROM lots l
       JOIN positions p ON p.id = l.position_id
       JOIN accounts a ON a.id = p.account_id
       WHERE a.username_key = 'lots.survive'`,
    );

    await order(token, { symbol: target.symbol, side: 'SELL', quantity: target.quantity });

    const lotsAfter = await query(
      `SELECT count(*)::int AS n,
              COALESCE(SUM(closed_quantity), 0)::int AS closed
       FROM lots l
       JOIN positions p ON p.id = l.position_id
       JOIN accounts a ON a.id = p.account_id
       WHERE a.username_key = 'lots.survive'`,
    );

    assert.equal(lotsAfter.rows[0].n, lotsBefore.rows[0].n, 'no lot row may be deleted');
    assert.equal(lotsAfter.rows[0].closed, target.quantity, 'the sold shares are marked closed');
  });
});
