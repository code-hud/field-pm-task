/**
 * Orders that did not fill.
 *
 * The hard part is not the row — it is that the row has to survive the rollback that
 * is the whole point of the refusal. These assert both halves: the refusal is
 * recorded, and recording it never changes what the caller is told.
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
  const { body: market } = await authed(token, '/api/market/instruments');
  return market.instruments.find((quote) => !held.has(quote.symbol)).symbol;
};

const accountIdOf = async (username) => {
  const { rows } = await query('SELECT id FROM accounts WHERE username_key = $1', [
    username.toLowerCase(),
  ]);
  return rows[0].id;
};

const rejections = async (accountId) => {
  const { rows } = await query(
    `SELECT * FROM orders WHERE account_id = $1 AND status = 'REJECTED' ORDER BY id`,
    [accountId],
  );
  return rows;
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

describe('rejected orders', () => {
  it('survives the rollback that refused it', async () => {
    // The assertion this whole change exists for. The refusal is a rolled-back
    // transaction, so a row written inside it would be gone.
    const token = await signIn('rejected-survivor');
    const accountId = await accountIdOf('rejected-survivor');
    const symbol = await unheldSymbol(token);

    const { status, body } = await order(token, { symbol, side: 'SELL', quantity: 4 });
    assert.equal(status, 422);
    assert.equal(body.error.code, 'insufficient_shares');

    const [rejected] = await rejections(accountId);
    assert.equal(rejected.symbol, symbol);
    assert.equal(rejected.side, 'SELL');
    assert.equal(Number(rejected.quantity), 4);
    assert.equal(Number(rejected.filled_quantity), 0);
    assert.equal(rejected.fill_price, null);
    assert.equal(rejected.trade_id, null);
    assert.ok(rejected.resolved_at);
  });

  it('keeps both the code and the sentence', async () => {
    // Different jobs. The code is what a list groups on and is promised not to move;
    // the sentence is what makes one row make sense on its own, and "holding 2, tried
    // to sell 9" is not derivable from `insufficient_shares`.
    const token = await signIn('rejected-wording');
    const accountId = await accountIdOf('rejected-wording');
    const symbol = await unheldSymbol(token);

    await order(token, { symbol, side: 'BUY', quantity: 2 });
    const { body } = await order(token, { symbol, side: 'SELL', quantity: 9 });

    const [rejected] = await rejections(accountId);
    assert.equal(rejected.reject_code, 'insufficient_shares');
    assert.equal(rejected.reject_reason, body.error.message);
    assert.match(rejected.reject_reason, /holding 2/);
  });

  it('records an order refused for cash', async () => {
    const token = await signIn('rejected-broke');
    const accountId = await accountIdOf('rejected-broke');
    const symbol = await unheldSymbol(token);

    const { status } = await order(token, { symbol, side: 'BUY', quantity: 900_000 });
    assert.equal(status, 422);

    const [rejected] = await rejections(accountId);
    assert.equal(rejected.reject_code, 'insufficient_cash');
    assert.equal(rejected.side, 'BUY');
  });

  it('does not record a request that was never an order', async () => {
    // A 400 means the body was not a well-formed order — no side, a quantity of "x".
    // There is nothing to file under the account, and filing it would mean relaxing
    // the constraints that make this table worth having.
    const token = await signIn('rejected-malformed');
    const accountId = await accountIdOf('rejected-malformed');
    const symbol = await unheldSymbol(token);

    assert.equal((await order(token, { symbol, side: 'SIDEWAYS', quantity: 1 })).status, 400);
    assert.equal((await order(token, { symbol, side: 'BUY', quantity: 'x' })).status, 400);
    assert.equal((await order(token, { symbol, side: 'BUY', quantity: 0 })).status, 400);
    assert.equal((await order(token, { symbol, side: 'BUY', quantity: 1, type: 'STOP' })).status, 400);

    assert.deepEqual(await rejections(accountId), []);
  });

  it('does not record an order for a symbol that does not exist', async () => {
    // Nothing for the foreign key to reach. The 404 is still the 404.
    const token = await signIn('rejected-nosymbol');
    const accountId = await accountIdOf('rejected-nosymbol');

    const { status, body } = await order(token, { symbol: 'NOTREAL', side: 'BUY', quantity: 1 });
    assert.equal(status, 404);
    assert.equal(body.error.code, 'unknown_symbol');

    assert.deepEqual(await rejections(accountId), []);
  });

  it('leaves the account exactly as it was', async () => {
    // Recording the refusal must not become a way for a refused order to touch
    // anything: no cash movement, no lot, no trade, no position.
    const token = await signIn('rejected-untouched');
    const symbol = await unheldSymbol(token);

    const { body: before } = await authed(token, '/api/portfolio');
    await order(token, { symbol, side: 'SELL', quantity: 3 });
    const { body: after } = await authed(token, '/api/portfolio');

    assert.equal(after.summary.cash, before.summary.cash);
    assert.equal(after.summary.positionCount, before.summary.positionCount);
    assert.equal(after.summary.realizedPnl, before.summary.realizedPnl);
  });

  it('still refuses in the same words when it cannot record the refusal', async () => {
    // The rule the recording lives by. A bookkeeping failure turning "insufficient
    // shares" into a 500 would be a worse bug than not recording anything, so this
    // breaks the write on purpose and asserts the caller notices nothing.
    const token = await signIn('rejected-unrecordable');
    const accountId = await accountIdOf('rejected-unrecordable');
    const symbol = await unheldSymbol(token);

    // NOT VALID: the constraint applies to new rows only, so it does not trip over
    // the rejections the tests above already recorded.
    await query(
      `ALTER TABLE orders ADD CONSTRAINT orders_temporarily_broken
         CHECK (status <> 'REJECTED') NOT VALID`,
    );
    try {
      const { status, body } = await order(token, { symbol, side: 'SELL', quantity: 2 });
      assert.equal(status, 422);
      assert.equal(body.error.code, 'insufficient_shares');
      assert.deepEqual(await rejections(accountId), []);
    } finally {
      await query('ALTER TABLE orders DROP CONSTRAINT orders_temporarily_broken');
    }
  });

  it('refuses a rejected row that claims to have traded', async () => {
    const token = await signIn('rejected-claims');
    const accountId = await accountIdOf('rejected-claims');
    const symbol = await unheldSymbol(token);

    await assert.rejects(
      query(
        `INSERT INTO orders (account_id, symbol, side, type, quantity, status,
                             filled_quantity, fill_price, reject_code, resolved_at)
         VALUES ($1, $2, 'BUY', 'MARKET', 3, 'REJECTED', 0, 41.5, 'insufficient_cash', now())`,
        [accountId, symbol],
      ),
      /orders_rejected_is_empty/,
    );
  });

  it('refuses a filled row that carries a refusal', async () => {
    const token = await signIn('rejected-both');
    const symbol = await unheldSymbol(token);

    const { body } = await order(token, { symbol, side: 'BUY', quantity: 1 });

    await assert.rejects(
      query('UPDATE orders SET reject_code = $2 WHERE id = $1', [body.order.id, 'insufficient_cash']),
      /orders_filled_has_no_reject_code/,
    );
  });
});
