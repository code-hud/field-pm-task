/**
 * What a sale closed, against a real database.
 *
 * `trades.realized_pnl` already says how much a sale made. These assert the thing it
 * cannot: which purchases it sold, what they cost, and when they were bought — the
 * questions a tax lot statement asks, and the ones that become unanswerable the
 * moment `lots.closed_quantity` moves.
 *
 * Against a real Postgres for the usual reason: the constraints are half of the
 * design, and a fake would assert only that this file agrees with itself.
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

/** A symbol the account does not already hold, so its lots are only the ones made here. */
const unheldSymbol = async (token) => {
  const { body: portfolio } = await authed(token, '/api/portfolio');
  const held = new Set(portfolio.positions.map((position) => position.symbol));
  const { body: market } = await authed(token, '/api/market/instruments');
  return market.instruments.find((quote) => !held.has(quote.symbol)).symbol;
};

/**
 * Moves the tape. Two buys at the same quote are indistinguishable lots, so a FIFO
 * test that never repriced would pass just as well on a store that picked at random.
 */
const repriceTo = async (symbol, price) => {
  await query('UPDATE quotes SET price = $2 WHERE symbol = $1', [symbol, price]);
};

const closuresFor = async (tradeId) => {
  const { rows } = await query(
    `SELECT lot_id, quantity, cost_price, sale_price, opened_on, closed_on, realized_pnl
     FROM lot_closures WHERE trade_id = $1 ORDER BY id`,
    [tradeId],
  );
  return rows;
};

/** The id of the most recent trade on an account — the one a fill just wrote. */
const lastTradeId = async (accountId) => {
  const { rows } = await query(
    'SELECT id FROM trades WHERE account_id = $1 ORDER BY id DESC LIMIT 1',
    [accountId],
  );
  return rows[0].id;
};

const closureCount = async (accountId) => {
  const { rows } = await query(
    'SELECT count(*)::int AS total FROM lot_closures WHERE account_id = $1',
    [accountId],
  );
  return rows[0].total;
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

describe('lot closures', () => {
  it('records one row per lot the sale consumed, oldest first', async () => {
    const token = await signIn('closer');
    const accountId = await accountIdOf('closer');
    const symbol = await unheldSymbol(token);

    await repriceTo(symbol, 100);
    await order(token, { symbol, side: 'BUY', quantity: 5 });
    await repriceTo(symbol, 130);
    await order(token, { symbol, side: 'BUY', quantity: 5 });

    await repriceTo(symbol, 150);
    const { status, body } = await order(token, { symbol, side: 'SELL', quantity: 8 });
    assert.equal(status, 201);

    const closures = await closuresFor(await lastTradeId(accountId));

    // Eight shares out of a five-share lot and a five-share lot: all of the first,
    // three of the second, in that order.
    assert.equal(closures.length, 2);
    assert.deepEqual(
      closures.map((closure) => closure.quantity),
      [5, 3],
    );
    assert.deepEqual(
      closures.map((closure) => Number(closure.cost_price)),
      [100, 130],
      'the cheap lot is sold first, and each row carries its own lot price',
    );
    assert.ok(
      closures.every((closure) => Number(closure.sale_price) === body.order.price),
      'every slice of one sale went off at one price',
    );

    // 5 × (150 − 100) + 3 × (150 − 130).
    assert.equal(Number(closures[0].realized_pnl), 250);
    assert.equal(Number(closures[1].realized_pnl), 60);
  });

  it('adds up to the realized figure on the trade itself', async () => {
    // The invariant the breakdown depends on. If these two ever disagree, one screen
    // says an account made more than another screen does, and neither is wrong on
    // its own terms.
    const token = await signIn('adder-up');
    const accountId = await accountIdOf('adder-up');
    const symbol = await unheldSymbol(token);

    // Prices with a fourth decimal, so the per-slice roundings genuinely have
    // something to disagree about.
    await repriceTo(symbol, 41.3337);
    await order(token, { symbol, side: 'BUY', quantity: 7 });
    await repriceTo(symbol, 39.9991);
    await order(token, { symbol, side: 'BUY', quantity: 9 });
    await repriceTo(symbol, 44.6663);
    await order(token, { symbol, side: 'BUY', quantity: 11 });

    await repriceTo(symbol, 52.7779);
    await order(token, { symbol, side: 'SELL', quantity: 23 });

    const tradeId = await lastTradeId(accountId);
    const { rows } = await query('SELECT realized_pnl FROM trades WHERE id = $1', [tradeId]);
    const closures = await closuresFor(tradeId);

    assert.equal(closures.length, 3);
    const summed = closures.reduce((total, closure) => total + Number(closure.realized_pnl), 0);
    assert.equal(
      Math.round(summed * 100) / 100,
      Number(rows[0].realized_pnl),
      'the slices reconcile to the trade exactly, not approximately',
    );
  });

  it('agrees with the lot rows it claims to have closed', async () => {
    const token = await signIn('agreeable');
    const accountId = await accountIdOf('agreeable');
    const symbol = await unheldSymbol(token);

    await repriceTo(symbol, 60);
    await order(token, { symbol, side: 'BUY', quantity: 4 });
    await repriceTo(symbol, 70);
    await order(token, { symbol, side: 'BUY', quantity: 4 });
    await order(token, { symbol, side: 'SELL', quantity: 2 });
    await order(token, { symbol, side: 'SELL', quantity: 5 });

    // Two sales, three slices between them. Whatever the closures say was taken out
    // of each lot has to be what that lot says was taken out of it.
    const { rows } = await query(
      `SELECT l.id, l.closed_quantity,
              COALESCE(SUM(c.quantity), 0)::bigint AS attributed
       FROM lots l
       JOIN positions p ON p.id = l.position_id
       LEFT JOIN lot_closures c ON c.lot_id = l.id
       WHERE p.account_id = $1 AND p.symbol = $2
       GROUP BY l.id, l.closed_quantity
       ORDER BY l.id`,
      [accountId, symbol],
    );

    assert.equal(rows.length, 2);
    for (const lot of rows) {
      assert.equal(
        Number(lot.attributed),
        Number(lot.closed_quantity),
        `lot ${lot.id}: closures and closed_quantity must describe the same shares`,
      );
    }
  });

  it('measures the holding period from the lot, not from the position', async () => {
    // A position's `opened_at` is its first purchase. Selling shares bought later
    // and dating them from the position would report a holding period the account
    // never had — and would be a plausible-looking wrong answer on a tax statement.
    const token = await signIn('holder');
    const accountId = await accountIdOf('holder');

    // A seeded holding: its lots are real past purchases, so the closure's open date
    // has somewhere to be other than today.
    const { body: portfolio } = await authed(token, '/api/portfolio');
    const holding = portfolio.positions.find((position) => position.quantity > 1);
    await order(token, { symbol: holding.symbol, side: 'SELL', quantity: 1 });

    const closures = await closuresFor(await lastTradeId(accountId));
    assert.equal(closures.length, 1);

    const { rows: positionRows } = await query(
      'SELECT opened_at FROM positions WHERE account_id = $1 AND symbol = $2',
      [accountId, holding.symbol],
    );
    const { rows: lotRows } = await query(
      `SELECT l.trade_date FROM lots l
       JOIN positions p ON p.id = l.position_id
       WHERE p.account_id = $1 AND p.symbol = $2
       ORDER BY l.trade_date, l.id LIMIT 1`,
      [accountId, holding.symbol],
    );

    // Dates arrive as `YYYY-MM-DD` strings — `src/db/pool.js` pins the DATE parser so
    // a calendar date never acquires a timezone — which compares and orders directly.
    assert.equal(
      closures[0].opened_on,
      lotRows[0].trade_date,
      'the open date is the lot it sold, to the day',
    );
    assert.ok(
      closures[0].opened_on >= positionRows[0].opened_at,
      'and never earlier than the position that holds it',
    );
    assert.ok(closures[0].closed_on > closures[0].opened_on, 'sold after it was bought');
  });

  it('writes nothing for a buy', async () => {
    const token = await signIn('buyer-only');
    const accountId = await accountIdOf('buyer-only');
    const symbol = await unheldSymbol(token);

    await order(token, { symbol, side: 'BUY', quantity: 2 });

    assert.deepEqual(await closuresFor(await lastTradeId(accountId)), []);
  });

  it('leaves nothing behind when the sale is refused', async () => {
    const token = await signIn('overreacher');
    const accountId = await accountIdOf('overreacher');
    const symbol = await unheldSymbol(token);

    await order(token, { symbol, side: 'BUY', quantity: 2 });
    const beforeCount = await closureCount(accountId);

    const { status } = await order(token, { symbol, side: 'SELL', quantity: 50 });
    assert.equal(status, 422);

    assert.equal(
      await closureCount(accountId),
      beforeCount,
      'a rolled-back fill records no closures, the same way it records no trade',
    );
  });

  it('does not change what an earlier sale closed', async () => {
    // The same property `trades` exists to guarantee, extended to the rows that
    // explain it: trading today must not alter what yesterday says it sold.
    const token = await signIn('rewriter');
    const accountId = await accountIdOf('rewriter');
    const symbol = await unheldSymbol(token);

    await repriceTo(symbol, 20);
    await order(token, { symbol, side: 'BUY', quantity: 10 });
    await repriceTo(symbol, 25);
    await order(token, { symbol, side: 'SELL', quantity: 3 });

    const firstTradeId = await lastTradeId(accountId);
    const before = await closuresFor(firstTradeId);

    await repriceTo(symbol, 31);
    await order(token, { symbol, side: 'SELL', quantity: 4 });

    assert.deepEqual(await closuresFor(firstTradeId), before);
  });
});

describe('reconciling the slices to the total', () => {
  const { reconcileClosures } = require('../src/orders/orderService.js');

  const slices = (...entries) =>
    entries.map(([quantity, realizedPnl]) => ({ quantity, realizedPnl }));

  it('does nothing when the slices already add up', () => {
    const closures = slices([5, 250], [3, 60]);
    reconcileClosures(closures, 310);

    assert.deepEqual(
      closures.map((closure) => closure.realizedPnl),
      [250, 60],
    );
  });

  it('gives the odd cent to the largest slice', () => {
    // The residual is real and unavoidable — the trade rounds a total, each slice
    // rounds its own share, and the two need not land on the same cent. Where it
    // goes is a choice; leaving the breakdown a cent short of the trade is not.
    const closures = slices([2, 10.0], [9, 20.0], [4, 30.0]);
    reconcileClosures(closures, 60.02);

    assert.deepEqual(
      closures.map((closure) => closure.realizedPnl),
      [10.0, 20.02, 30.0],
    );
  });

  it('breaks a tie in favour of the earlier slice, so FIFO order decides it', () => {
    const closures = slices([6, 10.0], [6, 20.0]);
    reconcileClosures(closures, 30.01);

    assert.deepEqual(
      closures.map((closure) => closure.realizedPnl),
      [10.01, 20.0],
    );
  });

  it('absorbs a loss-side residual the same way', () => {
    const closures = slices([3, -5.0], [8, -12.0]);
    reconcileClosures(closures, -17.01);

    assert.deepEqual(
      closures.map((closure) => closure.realizedPnl),
      [-5.0, -12.01],
    );
  });

  it('refuses a gap too large for rounding to explain', () => {
    // Not a rounding problem: a difference this size means the slices and the total
    // were computed from different numbers. Since this runs inside the fill, the
    // throw rolls the sale back — which is the point. Quietly parking the
    // difference on one lot would commit a ledger already known to be wrong.
    const closures = slices([5, 100.0], [5, 100.0]);

    assert.throws(() => reconcileClosures(closures, 260), {
      code: 'realized_attribution_mismatch',
      status: 500,
    });
  });

  it('has nothing to reconcile for a buy', () => {
    assert.doesNotThrow(() => reconcileClosures([], 0));
  });
});

describe('closing many lots at once', () => {
  /** Buys `prices.length` separate lots on one symbol, one per price, oldest first. */
  const buildLots = async (token, symbol, prices) => {
    for (const price of prices) {
      await repriceTo(symbol, price);
      await order(token, { symbol, side: 'BUY', quantity: 5 });
    }
  };

  it('takes exactly the lots it needs and leaves the next one alone', async () => {
    // The boundary the running-total frame decides. Ten shares is precisely the first
    // two lots, so a frame that included the current row would take a share from the
    // third — and that over-close commits cleanly, because the only constraint that
    // could catch it is on the lot, not on the sale.
    const token = await signIn('fifo-boundary');
    const accountId = await accountIdOf('fifo-boundary');
    const symbol = await unheldSymbol(token);

    await buildLots(token, symbol, [10, 20, 30]);
    await repriceTo(symbol, 50);
    await order(token, { symbol, side: 'SELL', quantity: 10 });

    const closures = await closuresFor(await lastTradeId(accountId));
    assert.equal(closures.length, 2, 'two lots, not three');
    assert.deepEqual(
      closures.map((closure) => Number(closure.quantity)),
      [5, 5],
    );
    assert.deepEqual(
      closures.map((closure) => Number(closure.cost_price)),
      [10, 20],
    );

    // And the third lot is untouched.
    const { rows } = await query(
      `SELECT l.price, l.closed_quantity FROM lots l
       JOIN positions p ON p.id = l.position_id
       WHERE p.account_id = $1 AND p.symbol = $2 ORDER BY l.trade_date, l.id`,
      [accountId, symbol],
    );
    assert.deepEqual(
      rows.map((row) => Number(row.closed_quantity)),
      [5, 5, 0],
    );
  });

  it('spans eight lots and attributes every share', async () => {
    const token = await signIn('fifo-eight');
    const accountId = await accountIdOf('fifo-eight');
    const symbol = await unheldSymbol(token);

    const prices = [11, 13, 17, 19, 23, 29, 31, 37];
    await buildLots(token, symbol, prices);
    await repriceTo(symbol, 40);
    // 38 of the 40 shares held: seven whole lots and three of the eighth.
    await order(token, { symbol, side: 'SELL', quantity: 38 });

    const closures = await closuresFor(await lastTradeId(accountId));

    assert.equal(closures.length, 8);
    assert.deepEqual(
      closures.map((closure) => Number(closure.quantity)),
      [5, 5, 5, 5, 5, 5, 5, 3],
    );
    // FIFO, and in FIFO order — RETURNING has no guaranteed row order, so this is the
    // assertion that the re-sort is happening.
    assert.deepEqual(
      closures.map((closure) => Number(closure.cost_price)),
      prices,
    );

    const summed = closures.reduce((total, closure) => total + Number(closure.realized_pnl), 0);
    const { rows } = await query('SELECT realized_pnl FROM trades WHERE id = $1', [
      await lastTradeId(accountId),
    ]);
    assert.equal(
      Math.round(summed * 100) / 100,
      Number(rows[0].realized_pnl),
      'and the slices still reconcile to the trade across eight of them',
    );
  });

  it('takes part of one lot without touching the rest of it', async () => {
    const token = await signIn('fifo-partial');
    const accountId = await accountIdOf('fifo-partial');
    const symbol = await unheldSymbol(token);

    await buildLots(token, symbol, [100]);
    await repriceTo(symbol, 120);
    await order(token, { symbol, side: 'SELL', quantity: 2 });

    const closures = await closuresFor(await lastTradeId(accountId));
    assert.equal(closures.length, 1);
    assert.equal(Number(closures[0].quantity), 2);

    const { rows } = await query(
      `SELECT l.quantity, l.closed_quantity FROM lots l
       JOIN positions p ON p.id = l.position_id
       WHERE p.account_id = $1 AND p.symbol = $2`,
      [accountId, symbol],
    );
    assert.equal(Number(rows[0].quantity), 5);
    assert.equal(Number(rows[0].closed_quantity), 2);
  });

  it('agrees with the lots about what it closed, across several sales', async () => {
    const token = await signIn('fifo-agrees');
    const accountId = await accountIdOf('fifo-agrees');
    const symbol = await unheldSymbol(token);

    await buildLots(token, symbol, [7, 9, 11, 13]);
    await repriceTo(symbol, 15);
    await order(token, { symbol, side: 'SELL', quantity: 3 });
    await order(token, { symbol, side: 'SELL', quantity: 9 });
    await order(token, { symbol, side: 'SELL', quantity: 4 });

    const { rows } = await query(
      `SELECT l.id, l.closed_quantity, COALESCE(SUM(c.quantity), 0)::bigint AS attributed
       FROM lots l
       JOIN positions p ON p.id = l.position_id
       LEFT JOIN lot_closures c ON c.lot_id = l.id
       WHERE p.account_id = $1 AND p.symbol = $2
       GROUP BY l.id, l.closed_quantity`,
      [accountId, symbol],
    );

    assert.equal(rows.length, 4);
    for (const lot of rows) {
      assert.equal(Number(lot.attributed), Number(lot.closed_quantity), `lot ${lot.id}`);
    }
  });

  it('refuses a sale larger than the position and closes nothing', async () => {
    const token = await signIn('fifo-toobig');
    const accountId = await accountIdOf('fifo-toobig');
    const symbol = await unheldSymbol(token);

    await buildLots(token, symbol, [50, 60]);
    const { status } = await order(token, { symbol, side: 'SELL', quantity: 11 });
    assert.equal(status, 422);

    const { rows } = await query(
      `SELECT COALESCE(SUM(l.closed_quantity), 0)::int AS closed FROM lots l
       JOIN positions p ON p.id = l.position_id
       WHERE p.account_id = $1 AND p.symbol = $2`,
      [accountId, symbol],
    );
    assert.equal(rows[0].closed, 0);
  });
});
