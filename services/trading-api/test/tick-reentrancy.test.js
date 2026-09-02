/**
 * One tick at a time, and a sweep that finishes the book.
 *
 * `setInterval` does not wait for its callback, so a tick that overruns the interval
 * used to run alongside the next one. Both read the quote rows, both compute from
 * what they read, and both write — so `day_high` and `volume`, which are
 * read-modify-write, could go backwards. These pin the guard that stops it, and the
 * cursor that stops the sweep from re-reading the same prefix forever.
 */
const assert = require('node:assert/strict');
const { after, before, describe, it } = require('node:test');

const {
  baseUrlForMessages,
  createTestDatabase,
  databaseIsReachable,
  dropTestDatabase,
} = require('./helpers/database.js');

let testDb;
let closePool;
let query;
let MarketTicker;
let sweepRestingOrders;
let marketableOrders;
let baseUrl;
let server;

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

const repriceTo = async (symbol, price) => {
  await query('UPDATE quotes SET price = $2 WHERE symbol = $1', [symbol, price]);
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

  ({ MarketTicker } = require('../src/market/ticker.js'));
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

describe('one tick at a time', () => {
  it('does not let a second tick start while the first is running', async () => {
    const ticker = new MarketTicker({ intervalMs: 2000 });

    // Both firings are started without awaiting the first, which is exactly what
    // setInterval does when a tick overruns.
    const first = ticker.runScheduledTick();
    const second = ticker.runScheduledTick();
    await Promise.all([first, second]);

    assert.equal(ticker.tickCount, 1, 'only one tick did any work');
    assert.equal(ticker.skippedTicks, 1, 'and the other was counted rather than dropped');
  });

  it('runs the next tick normally once the first has finished', async () => {
    // The guard is a skip, not a latch. A tick that overran must not stop the tape.
    const ticker = new MarketTicker({ intervalMs: 2000 });

    await ticker.runScheduledTick();
    await ticker.runScheduledTick();

    assert.equal(ticker.tickCount, 2);
    assert.equal(ticker.skippedTicks, 0);
  });

  it('never lets the day high go backwards across overlapping firings', async () => {
    // The bug the guard exists for, stated as the property rather than as the
    // mechanism: two ticks that both read `day_high` before either wrote it will each
    // compute from the same starting point, and the later write wins.
    const ticker = new MarketTicker({ intervalMs: 2000 });
    const highs = [];

    for (let round = 0; round < 6; round += 1) {
      await Promise.all([ticker.runScheduledTick(), ticker.runScheduledTick()]);
      const { rows } = await query('SELECT max(day_high) AS high FROM quotes');
      highs.push(Number(rows[0].high));
    }

    for (let i = 1; i < highs.length; i += 1) {
      assert.ok(highs[i] >= highs[i - 1], `day high never falls: ${highs}`);
    }
  });

  it('publishes the skip count, because nothing else would show it', async () => {
    const ticker = new MarketTicker({ intervalMs: 2000 });
    await Promise.all([ticker.runScheduledTick(), ticker.runScheduledTick()]);

    assert.equal(ticker.status.skippedTicks, 1);
  });
});

describe('a sweep that finishes the book', () => {
  /**
   * Empties the book.
   *
   * The sweep is the venue's, not an account's, so orders left open by an earlier
   * test are in every later pass. Starting each of these from an empty book is what
   * makes an assertion about a cursor mean anything.
   */
  const clearBook = async () => {
    await query(
      `UPDATE orders SET status = 'CANCELLED', resolved_at = now() WHERE status = 'OPEN'`,
    );
  };

  /** Rests `count` non-marketable buy limits on one symbol, oldest first. */
  const restOrders = async (username, symbol, count) => {
    const token = await signIn(username);
    await repriceTo(symbol, 100);
    const ids = [];
    for (let i = 0; i < count; i += 1) {
      const { body } = await order(token, {
        symbol,
        side: 'BUY',
        quantity: 1,
        type: 'LIMIT',
        limitPrice: 90,
      });
      ids.push(body.order.id);
    }
    return ids;
  };

  it('visits every order across successive passes, however small the page', async () => {
    // The starvation this replaces: a shortlist of the first N every time meant the
    // N+1th order was never looked at at all.
    await clearBook();
    const ids = await restOrders('sweep-traversal', 'AAPL', 5);
    await repriceTo('AAPL', 80);

    const seen = new Set();
    let cursor = null;
    for (let pass = 0; pass < 5; pass += 1) {
      const before = await marketableOrders(2, cursor);
      before.forEach((row) => seen.add(Number(row.id)));
      const result = await sweepRestingOrders({ limit: 2, cursor });
      cursor = result.cursor;
      if (cursor === null) break;
    }

    for (const id of ids) {
      assert.ok(seen.has(Number(id)), `order ${id} was reached`);
    }
  });

  it('starts again from the head once it reaches the end', async () => {
    await clearBook();
    await restOrders('sweep-wrap', 'MSFT', 2);
    await repriceTo('MSFT', 80);

    const result = await sweepRestingOrders({ limit: 50 });

    assert.equal(result.cursor, null, 'a short page means the book ran out, not the clock');
  });

  it('stops when the budget runs out and says where it got to', async () => {
    await clearBook();
    const ids = await restOrders('sweep-budget', 'NVDA', 4);
    await repriceTo('NVDA', 80);

    // A clock that jumps past the budget after the first order, so the pass stops
    // there deterministically rather than depending on how fast the machine is. Two
    // readings before the jump: one to stamp the start, one for the check in front of
    // the first order — which happens before any work, so that a pass beginning with
    // no time left does nothing rather than one thing.
    let calls = 0;
    const clock = () => (calls++ < 2 ? 0 : 10_000);

    const result = await sweepRestingOrders({ limit: 50, budgetMs: 500, clock });

    assert.equal(result.considered, 1, 'one order, then out of time');
    assert.ok(result.cursor !== null, 'and it says where to resume');
    assert.equal(Number(result.cursor.id), Number(ids[0]), 'resuming after the oldest');
  });

  it('advances past an order that cannot fill, rather than retrying it forever', async () => {
    // The permanent starvation in the old shape: a failing order sat at the head of
    // the shortlist and occupied a slot on every subsequent tick, so nothing behind
    // it was ever reached.
    //
    // Made to fail for real rather than by stubbing: the account's cash is emptied
    // after the orders are accepted, so `fillBuy` refuses them. That is the shape of
    // failure this branch was written for, and stubbing would have proved only that
    // the test can throw.
    await clearBook();
    const ids = await restOrders('sweep-blocked', 'AMZN', 3);
    await query(
      `UPDATE accounts SET cash = 0 WHERE username_key = 'sweep-blocked'`,
    );
    await repriceTo('AMZN', 80);

    const result = await sweepRestingOrders({ limit: 2 });

    assert.equal(result.failed, 2, 'both were refused');
    assert.equal(result.considered, 2, 'and the first refusal did not stop the pass');
    assert.equal(
      Number(result.cursor.id),
      Number(ids[1]),
      'the cursor moved past them, so they do not block the next pass',
    );

    // They are still open — a refusal leaves the order alone — which is what makes
    // the head-of-line blocking possible in the first place.
    const { rows } = await query(
      `SELECT count(*)::int AS open FROM orders WHERE id = ANY($1) AND status = 'OPEN'`,
      [ids],
    );
    assert.equal(rows[0].open, 3);
  });
});
