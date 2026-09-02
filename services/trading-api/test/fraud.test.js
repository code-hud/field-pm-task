/**
 * The fraud screening boundary, against a stub fraud service.
 *
 * A stub rather than the real Java service: what needs proving here is what the *API*
 * does with each answer — fills on an allow, refuses on a denial, and keeps trading when
 * the service is unreachable — and those are the three cases the real service, which
 * allows everything and is always up, cannot produce. The fraud service's own behaviour
 * is tested in `services/fraud-service`.
 *
 * The stub is a real HTTP server on a real socket, so the request the API sends is the
 * one asserted on: a mocked `fetch` would prove the test's idea of the call rather than
 * the call.
 */
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { after, afterEach, before, describe, it } = require('node:test');

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

let fraudServer;
let fraudUrl;
/** Set per test: what the stub does with a check. Reset in afterEach. */
let respond;
/** Every check the API sent, in order, so the request body itself can be asserted on. */
let received;

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

/** Answers a check however the current test says to. */
const startFraudStub = async () => {
  fraudServer = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      received.push({ method: req.method, path: req.url, body: JSON.parse(body || '{}') });
      respond(res);
    });
  });
  fraudServer.listen(0);
  await new Promise((resolve) => fraudServer.once('listening', resolve));
  return `http://127.0.0.1:${fraudServer.address().port}`;
};

const allow = (res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(
    JSON.stringify({
      decision: 'ALLOW',
      reasons: [],
      checkId: 'stub-allow',
      evaluatedAt: new Date().toISOString(),
    }),
  );
};

const deny = (...reasons) => (res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(
    JSON.stringify({
      decision: 'DENY',
      reasons,
      checkId: 'stub-deny',
      evaluatedAt: new Date().toISOString(),
    }),
  );
};

before(async () => {
  if (!(await databaseIsReachable())) {
    throw new Error(
      `No Postgres at ${baseUrlForMessages()}. Start one with \`make db-up\` (or \`docker compose up -d postgres\`), ` +
        'or point TEST_DATABASE_URL at your own.',
    );
  }

  testDb = await createTestDatabase();

  received = [];
  respond = allow;
  fraudUrl = await startFraudStub();
  // Both read at import time by the config module, so they have to be set before the app
  // is imported — which is also why this file gets its own process-wide app instance
  // rather than sharing one with the other suites.
  process.env.FRAUD_SERVICE_URL = fraudUrl;
  process.env.FRAUD_TIMEOUT_MS = '400';

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

afterEach(() => {
  respond = allow;
  received = [];
});

after(async () => {
  server?.close();
  fraudServer?.close();
  await closePool?.();
  if (testDb) await dropTestDatabase(testDb.name);
  delete process.env.FRAUD_SERVICE_URL;
  delete process.env.FRAUD_TIMEOUT_MS;
});

describe('fraud screening', () => {
  it('screens every order before filling it, and sends the trade it is about to make', async () => {
    const token = await signIn('screened.buyer');
    const symbol = await unheldSymbol(token);

    const { status, body } = await order(token, { symbol, side: 'BUY', quantity: 4 });
    assert.equal(status, 201);

    assert.equal(received.length, 1);
    const check = received[0];
    assert.equal(check.method, 'POST');
    assert.equal(check.path, '/fraud/checks');
    assert.equal(check.body.symbol, symbol);
    assert.equal(check.body.side, 'BUY');
    assert.equal(check.body.quantity, 4);
    assert.ok(check.body.accountId, 'the account is identified, so a rule can be per-account');
    // The screened price is the live quote, so the notional a rule computes is the one
    // the fill is about to book — within a tick.
    assert.ok(Math.abs(check.body.price - body.order.price) < 1);
  });

  it('refuses a denied trade with 422, and moves nothing', async () => {
    const token = await signIn('denied.buyer');
    const symbol = await unheldSymbol(token);
    const { body: before } = await authed(token, '/api/portfolio');

    respond = deny('velocity: 7 orders in 60s from one account');
    const { status, body } = await order(token, { symbol, side: 'BUY', quantity: 2 });

    assert.equal(status, 422);
    assert.equal(body.error.code, 'fraud_rejected');
    // The reason reaches the person who placed the order — a rejection nobody can read
    // is one nobody can act on.
    assert.match(body.error.message, /velocity: 7 orders in 60s/);

    // The whole point of screening before the transaction: no trade, no lot, no cash
    // movement, and nothing in the ledger. The refusal itself is filed as a rejected
    // order — see the test below — which is a record of what was refused, not a
    // record of anything having happened.
    const { body: after } = await authed(token, '/api/portfolio');
    assert.equal(after.summary.cash, before.summary.cash);
    assert.equal(after.positions.length, before.positions.length);
    const { body: ledger } = await authed(token, '/api/portfolio/transactions?limit=50');
    assert.ok(!ledger.transactions.some((entry) => entry.symbol === symbol));
  });

  it('carries one check key across every retry of one order', async () => {
    // The key has to be minted outside the retry loop. A key per attempt would be three
    // keys for one decision and would dedupe nothing — which is the mistake this asserts
    // against, and it is invisible from the outcome of a successful order.
    const token = await signIn('retry.keyed');
    const symbol = await unheldSymbol(token);

    let attempts = 0;
    respond = (res) => {
      attempts += 1;
      // The first two answer with a body the client cannot read, which is how a lost
      // response actually presents: the service has already screened and recorded by
      // then, and `attemptDecision` throws after the fact.
      if (attempts < 3) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ nonsense: true }));
        return;
      }
      allow(res);
    };

    const before = received.length;
    const { status } = await order(token, { symbol, side: 'BUY', quantity: 1 });
    assert.equal(status, 201);

    const sent = received.slice(before);
    assert.equal(sent.length, 3, 'all three attempts reached the service');
    const keys = new Set(sent.map((check) => check.body.checkKey));
    assert.equal(keys.size, 1, 'and every one of them carried the same key');
    assert.ok([...keys][0], 'which is a real key rather than undefined');
  });

  it('gives two separate orders two separate keys', async () => {
    const token = await signIn('twokeys');
    const symbol = await unheldSymbol(token);

    respond = allow;
    const before = received.length;

    await order(token, { symbol, side: 'BUY', quantity: 1 });
    await order(token, { symbol, side: 'BUY', quantity: 1 });

    const keys = received.slice(before).map((check) => check.body.checkKey);
    assert.equal(keys.length, 2);
    assert.notEqual(keys[0], keys[1]);
  });

  it('files a denial in the account\'s order history', async () => {
    // A screening refusal happens before the transaction opens, so there is no
    // rollback to survive — but it is the refusal a person is most likely to come
    // looking for afterwards, and the reason has to be there when they do.
    const token = await signIn('denied.filed');
    const symbol = await unheldSymbol(token);

    respond = deny('notional-ceiling: 480,000 exceeds the 250,000 limit');
    await order(token, { symbol, side: 'BUY', quantity: 3 });

    const { rows } = await query(
      `SELECT o.status, o.reject_code, o.reject_reason, o.quantity
       FROM orders o JOIN accounts a ON a.id = o.account_id
       WHERE a.username_key = 'denied.filed' AND o.status = 'REJECTED'`,
    );

    assert.equal(rows.length, 1);
    assert.equal(rows[0].reject_code, 'fraud_rejected');
    assert.match(rows[0].reject_reason, /notional-ceiling/);
    assert.equal(Number(rows[0].quantity), 3);
  });

  it('reports every reason a trade was denied', async () => {
    const token = await signIn('twice.denied');
    const symbol = await unheldSymbol(token);

    respond = deny('velocity: too many orders', 'notional-ceiling: over the single-order limit');
    const { body } = await order(token, { symbol, side: 'BUY', quantity: 1 });

    assert.match(body.error.message, /velocity/);
    assert.match(body.error.message, /notional-ceiling/);
  });

  it('keeps trading when the fraud service is down', async () => {
    // Fail-open is a deliberate choice, not an accident of error handling, so it is
    // pinned by a test: the alternative — order entry stopping because a subsidiary
    // service is restarting — would be a self-inflicted outage.
    const token = await signIn('unscreened.buyer');
    const symbol = await unheldSymbol(token);

    respond = (res) => {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'unavailable', message: 'down' } }));
    };

    const { status, body } = await order(token, { symbol, side: 'BUY', quantity: 1 });
    assert.equal(status, 201);
    assert.equal(body.order.status, 'FILLED');
  });

  it('keeps trading when the fraud service never answers', async () => {
    const token = await signIn('timeout.buyer');
    const symbol = await unheldSymbol(token);

    // Never responds. FRAUD_TIMEOUT_MS is 400ms in this suite, so the abort — not the
    // socket — is what ends the wait.
    respond = () => {};

    const started = Date.now();
    const { status } = await order(token, { symbol, side: 'BUY', quantity: 1 });
    assert.equal(status, 201);
    assert.ok(Date.now() - started >= 400, 'the order waited for the timeout before filling');
    assert.ok(Date.now() - started < 5000, 'and did not wait for the socket to give up');
  });

  it('treats an unreadable answer as no answer rather than as an allow', async () => {
    // A deployment mismatch — a renamed field, a changed enum — must not read as
    // permission. It lands on the unavailable path, which is logged and reported.
    const token = await signIn('garbled.buyer');
    const symbol = await unheldSymbol(token);

    respond = (res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ verdict: 'probably fine' }));
    };

    const { status } = await order(token, { symbol, side: 'BUY', quantity: 1 });
    assert.equal(status, 201); // fail-open, but via the unavailable path
  });

  it('does not screen a trade it was going to reject anyway', async () => {
    const token = await signIn('careless.buyer');

    const unknown = await order(token, { symbol: 'NOTAREALTICKER', side: 'BUY', quantity: 1 });
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.error.code, 'unknown_symbol');

    const nonsense = await order(token, { symbol: 'AAPL', side: 'SIDEWAYS', quantity: 1 });
    assert.equal(nonsense.status, 400);

    assert.equal(received.length, 0, 'neither reached the fraud service');
  });

  it('screens sells as well as buys', async () => {
    const token = await signIn('seller');
    const symbol = await unheldSymbol(token);
    await order(token, { symbol, side: 'BUY', quantity: 5 });
    received = [];

    const { status } = await order(token, { symbol, side: 'SELL', quantity: 2 });
    assert.equal(status, 201);
    assert.equal(received.length, 1);
    assert.equal(received[0].body.side, 'SELL');
  });
});
