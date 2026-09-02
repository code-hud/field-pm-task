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
// Imported dynamically in `before`, after DATABASE_URL points at the test database
// — the config module reads the environment at import time.
let closePool;

const call = async (path, options = {}) => {
  const response = await fetch(`${baseUrl}${path}`, options);
  return { status: response.status, body: await response.json() };
};

const authed = (token, path) => call(path, { headers: { authorization: `Bearer ${token}` } });

const signIn = async (username, password = 'demo') => {
  const { body } = await call('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  return body.token;
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
  // Fixed seed: the assertions below are about invariants, not specific prices,
  // but a stable market makes a failure reproducible.
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

describe('auth', () => {
  it('accepts any username with a non-blank password', async () => {
    for (const username of ['dan', 'ada.lovelace', 'trader_99', 'someone@demo.io']) {
      const { status, body } = await call('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username, password: 'x' }),
      });
      assert.equal(status, 200, `${username} should be able to sign in`);
      assert.ok(body.token, 'a token is issued');
      assert.equal(body.user.username, username);
    }
  });

  it('rejects a blank password', async () => {
    const { status, body } = await call('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'dan', password: '   ' }),
    });
    assert.equal(status, 400);
    assert.equal(body.error.code, 'password_required');
  });

  it('rejects a blank username', async () => {
    const { status, body } = await call('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: '', password: 'hunter2' }),
    });
    assert.equal(status, 400);
    assert.equal(body.error.code, 'username_required');
  });

  it('resolves the same account for the same username', async () => {
    const first = await authed(await signIn('repeatable'), '/api/auth/me');
    const second = await authed(await signIn('repeatable'), '/api/auth/me');
    assert.deepEqual(first.body.user, second.body.user);
  });

  it('guards protected routes', async () => {
    assert.equal((await call('/api/portfolio')).status, 401);
    assert.equal((await call('/api/market/instruments')).status, 401);
    assert.equal((await authed('not-a-jwt', '/api/portfolio')).status, 401);
  });
});

describe('market data', () => {
  it('serves quotes with coherent day ranges', async () => {
    const { status, body } = await authed(await signIn('quotes'), '/api/market/instruments');
    assert.equal(status, 200);
    assert.ok(body.instruments.length >= 20);

    for (const quote of body.instruments) {
      assert.ok(quote.price > 0, `${quote.symbol} has a positive price`);
      assert.ok(quote.dayLow <= quote.price && quote.price <= quote.dayHigh, `${quote.symbol} sits inside its range`);
      // Strictly positive, and equal to the two sides it is derived from. Cheap
      // names are where this breaks: a cent-wide spread can round bid onto ask.
      assert.ok(quote.bid < quote.ask, `${quote.symbol} has a positive spread at ${quote.price}`);
      assert.ok(
        Math.abs(quote.ask - quote.bid - quote.spread) < 1e-9,
        `${quote.symbol}: spread ${quote.spread} does not match ${quote.bid}/${quote.ask}`,
      );
      assert.ok(quote.sparkline.length > 0, `${quote.symbol} has a sparkline`);
      // Real reference data; nothing else on the row is.
      assert.ok(quote.industry, `${quote.symbol} carries its GICS sub-industry`);
      assert.equal(quote.exchange, 'DEMO', `${quote.symbol} is labelled as simulated`);
    }
  });

  it('pages the universe instead of serving all 500 rows', async () => {
    const token = await signIn('paging');
    const { body: first } = await authed(token, '/api/market/instruments');
    // `total` is the size of the match, not of the page — the UI needs both.
    assert.equal(first.limit, 50);
    assert.equal(first.offset, 0);
    assert.equal(first.instruments.length, 50);
    assert.ok(first.total > 480, `expected the S&P 500, got ${first.total}`);

    const { body: second } = await authed(token, '/api/market/instruments?limit=50&offset=50');
    assert.equal(second.offset, 50);
    assert.equal(second.total, first.total);
    const overlap = new Set(first.instruments.map((q) => q.symbol));
    assert.ok(
      second.instruments.every((quote) => !overlap.has(quote.symbol)),
      'consecutive pages must not repeat a symbol',
    );

    // The cap is what stops a client asking for a 350 KB response by accident.
    const { body: capped } = await authed(token, '/api/market/instruments?limit=5000');
    assert.equal(capped.limit, 250);

    const { body: bare } = await authed(token, '/api/market/instruments?limit=5&sparkline=0');
    assert.ok(bare.instruments.every((quote) => quote.sparkline === undefined));
  });

  it('filters and sorts', async () => {
    const token = await signIn('filters');
    const { body: tech } = await authed(token, '/api/market/instruments?sector=Utilities&limit=250');
    assert.ok(tech.instruments.length > 10);
    assert.ok(tech.instruments.every((quote) => quote.sector === 'Utilities'));
    assert.equal(tech.total, tech.instruments.length);

    const { body: sorted } = await authed(token, '/api/market/instruments?sort=changePercent&order=desc');
    const changes = sorted.instruments.map((quote) => quote.changePercent);
    assert.deepEqual(changes, [...changes].sort((a, b) => b - a));

    const { body: search } = await authed(token, '/api/market/instruments?search=exxon');
    assert.equal(search.instruments[0].symbol, 'XOM');
    assert.equal(search.total, 1);
  });

  it('returns intraday and daily history', async () => {
    const token = await signIn('history');
    const { body: intraday } = await authed(token, '/api/market/instruments/AAPL/history?range=1D');
    assert.equal(intraday.interval, '1m');
    assert.ok(intraday.bars.length > 0);

    const { body: monthly } = await authed(token, '/api/market/instruments/AAPL/history?range=1M');
    assert.equal(monthly.interval, '1d');
    assert.equal(monthly.bars.length, 22);
  });

  it('rejects unknown symbols and ranges', async () => {
    const token = await signIn('errors');
    assert.equal((await authed(token, '/api/market/instruments/NOPE')).status, 404);
    assert.equal((await authed(token, '/api/market/instruments/AAPL/history?range=7Y')).status, 400);
    assert.equal((await authed(token, '/api/market/instruments?sort=bogus')).status, 400);
  });

  it('reports movers and sector performance across the whole board', async () => {
    const token = await signIn('movers');
    const { body: movers } = await authed(token, '/api/market/movers');
    assert.equal(movers.gainers.length, 5);
    assert.equal(movers.losers.length, 5);
    assert.equal(movers.mostActive.length, 5);
    assert.ok(movers.gainers[0].changePercent >= movers.losers[0].changePercent);

    const { body: sectors } = await authed(token, '/api/market/sectors');
    assert.equal(sectors.sectors.length, 11, 'all 11 GICS sectors are represented');
    assert.equal(
      sectors.performance.reduce((total, row) => total + row.instruments, 0),
      (await authed(token, '/api/market/instruments?limit=1')).body.total,
    );
  });
});

describe('portfolio', () => {
  it('values positions against live quotes and adds up', async () => {
    const { body } = await authed(await signIn('valuation'), '/api/portfolio');
    assert.ok(body.positions.length >= 5);

    const marketValue = body.positions.reduce((total, position) => total + position.marketValue, 0);
    assert.ok(Math.abs(marketValue - body.summary.marketValue) < 0.05, 'position values sum to marketValue');
    assert.ok(
      Math.abs(body.summary.totalValue - (body.summary.marketValue + body.summary.cash)) < 0.05,
      'total value is holdings plus cash',
    );

    const weights = body.positions.reduce((total, position) => total + position.weightPercent, 0);
    assert.ok(Math.abs(weights - 100) < 0.5, 'weights sum to ~100%');

    for (const position of body.positions) {
      const expected = position.quantity * position.averageCost;
      assert.ok(Math.abs(expected - position.costBasis) < 0.05, `${position.symbol} cost basis matches its lots`);
    }
  });

  it('ends the equity curve on the live account value', async () => {
    const token = await signIn('curve');
    const { body: portfolio } = await authed(token, '/api/portfolio');
    const { body: history } = await authed(token, '/api/portfolio/history?range=3M');

    assert.ok(history.points.length > 40);
    assert.equal(history.points.at(-1).value, portfolio.summary.totalValue);
    assert.ok(history.points.every((point) => point.value > 0));
    // Dates must be strictly increasing for the chart's x-axis to be meaningful.
    const dates = history.points.map((point) => point.date);
    assert.deepEqual(dates, [...dates].sort());
  });

  it('reconciles allocation with the holdings', async () => {
    const token = await signIn('allocation');
    const { body: portfolio } = await authed(token, '/api/portfolio');
    const { body: allocation } = await authed(token, '/api/portfolio/allocation');

    const sectorTotal = allocation.sectors.reduce((total, entry) => total + entry.marketValue, 0);
    assert.ok(Math.abs(sectorTotal - portfolio.summary.marketValue) < 1, 'sector values sum to marketValue');
    assert.ok(new Set(allocation.sectors.map((entry) => entry.sector)).size === allocation.sectors.length);
  });

  it('lists a ledger that starts with the funding deposit', async () => {
    const { body } = await authed(await signIn('ledger'), '/api/portfolio/transactions?limit=200');
    assert.ok(body.transactions.length > 5);
    assert.ok(body.transactions.some((entry) => entry.type === 'DEPOSIT'));
    assert.ok(body.transactions.some((entry) => entry.type === 'BUY'));

    const dates = body.transactions.map((entry) => entry.date);
    assert.deepEqual(dates, [...dates].sort().reverse(), 'newest first');
  });

  it('gives different users different portfolios', async () => {
    const one = await authed(await signIn('alice'), '/api/portfolio');
    const two = await authed(await signIn('bob'), '/api/portfolio');
    assert.notDeepEqual(
      one.body.positions.map((p) => p.symbol),
      two.body.positions.map((p) => p.symbol),
    );
  });
});

describe('probes', () => {
  it('reports health and readiness', async () => {
    const health = await call('/health');
    assert.equal(health.status, 200);
    assert.equal(health.body.status, 'ok');

    const ready = await call('/ready');
    assert.equal(ready.status, 200);
    assert.equal(ready.body.status, 'ready');
  });

  it('exposes market status without a token', async () => {
    const { status, body } = await call('/api/market/status');
    assert.equal(status, 200);
    assert.ok(['regular', 'pre-market', 'after-hours', 'closed'].includes(body.phase));
  });

  it('404s unknown routes as JSON', async () => {
    const { status, body } = await call('/api/nope');
    assert.equal(status, 404);
    assert.equal(body.error.code, 'not_found');
  });
});
