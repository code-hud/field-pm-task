/**
 * Quotes for a named list of symbols.
 *
 * The endpoint exists because the only way to get several specific quotes was one
 * call each, and each of those costs a quote query plus a sparkline query. Most of
 * what is asserted here is not the batching, though — it is what happens when part
 * of the list is wrong, which is the case a watchlist actually hits.
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

/** A few real symbols, taken from the universe rather than assumed. */
const someSymbols = async (token, count) => {
  const { body } = await authed(token, `/api/market/stocks?limit=${count}&sparkline=0`);
  return body.stocks.map((stock) => stock.symbol);
};

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

describe('batch quotes', () => {
  it('requires a token', async () => {
    assert.equal((await call('/api/market/quotes?symbols=AAPL')).status, 401);
  });

  it('answers in the order it was asked, not the order the database chose', async () => {
    // A comparison view lays the columns out in the order the caller listed them.
    // The rows come back in whatever order the plan produced, so the endpoint has to
    // put them back — and asking for them in reverse alphabetical order is what makes
    // the difference visible.
    const token = await signIn('batch-order');
    const symbols = (await someSymbols(token, 4)).slice().reverse();

    const { status, body } = await authed(token, `/api/market/quotes?symbols=${symbols.join(',')}`);

    assert.equal(status, 200);
    assert.deepEqual(
      body.quotes.map((quote) => quote.symbol),
      symbols,
    );
  });

  it('agrees with fetching the same symbols one at a time', async () => {
    // The property that makes this endpoint a shortcut rather than a second opinion.
    const token = await signIn('batch-agrees');
    const symbols = await someSymbols(token, 3);

    const { body: batch } = await authed(
      token,
      `/api/market/quotes?symbols=${symbols.join(',')}&sparkline=0`,
    );

    for (const [index, symbol] of symbols.entries()) {
      const { body: single } = await authed(token, `/api/market/stocks/${symbol}`);
      const { sparkline, ...quote } = single;
      assert.deepEqual(batch.quotes[index], quote, `${symbol} matches its own endpoint`);
    }
  });

  it('reports an unknown symbol instead of failing the request', async () => {
    // The case a saved watchlist actually hits. A name that has stopped being priced
    // should cost the caller that one row, not the whole screen.
    const token = await signIn('batch-unknown');
    const [real] = await someSymbols(token, 1);

    const { status, body } = await authed(
      token,
      `/api/market/quotes?symbols=${real},NOTREAL,${real}X`,
    );

    assert.equal(status, 200);
    assert.deepEqual(
      body.quotes.map((quote) => quote.symbol),
      [real],
    );
    assert.deepEqual(body.unknown, ['NOTREAL', `${real}X`]);
    assert.equal(body.requested, 3);
  });

  it('is still a 200 when nothing in the list exists', async () => {
    // Not a 404. The request was answerable and the answer is "none of these" —
    // which is different from "there is no such endpoint".
    const token = await signIn('batch-allunknown');
    const { status, body } = await authed(token, '/api/market/quotes?symbols=NOPE,ALSONOPE');

    assert.equal(status, 200);
    assert.deepEqual(body.quotes, []);
    assert.deepEqual(body.unknown, ['NOPE', 'ALSONOPE']);
    assert.equal(body.asOf, null, 'nothing was returned, so there is no freshness to report');
  });

  it('treats a repeated symbol as the list it is, not as two rows', async () => {
    const token = await signIn('batch-dupes');
    const [first, second] = await someSymbols(token, 2);

    const { body } = await authed(
      token,
      `/api/market/quotes?symbols=${first},${second},${first}`,
    );

    assert.deepEqual(
      body.quotes.map((quote) => quote.symbol),
      [first, second],
    );
    assert.equal(body.requested, 2);
  });

  it('accepts lowercase and untidy input', async () => {
    const token = await signIn('batch-messy');
    const [symbol] = await someSymbols(token, 1);

    const { status, body } = await authed(
      token,
      `/api/market/quotes?symbols=${encodeURIComponent(` ${symbol.toLowerCase()} ,, `)}`,
    );

    assert.equal(status, 200);
    assert.deepEqual(
      body.quotes.map((quote) => quote.symbol),
      [symbol],
    );
  });

  it('refuses a request that names nothing', async () => {
    const token = await signIn('batch-empty');

    for (const query of ['', '?symbols=', '?symbols=,,,', '?symbols=%20']) {
      const { status, body } = await authed(token, `/api/market/quotes${query}`);
      assert.equal(status, 400, `"${query}" is a 400`);
      assert.equal(body.error.code, 'symbols_required');
    }
  });

  it('refuses more than it will serve rather than truncating', async () => {
    // Silently returning the first fifty would leave a caller unable to tell which of
    // their names went missing.
    const token = await signIn('batch-toomany');
    const symbols = await someSymbols(token, 51);

    const { status, body } = await authed(token, `/api/market/quotes?symbols=${symbols.join(',')}`);

    assert.equal(status, 400);
    assert.equal(body.error.code, 'too_many_symbols');
    assert.match(body.error.message, /51/);
  });

  it('serves exactly the cap', async () => {
    const token = await signIn('batch-atcap');
    const symbols = await someSymbols(token, 50);

    const { status, body } = await authed(
      token,
      `/api/market/quotes?symbols=${symbols.join(',')}&sparkline=0`,
    );

    assert.equal(status, 200);
    assert.equal(body.quotes.length, 50);
  });

  it('carries sparklines, and drops them on request', async () => {
    const token = await signIn('batch-sparkline');
    const symbols = await someSymbols(token, 2);

    const { body: withThem } = await authed(
      token,
      `/api/market/quotes?symbols=${symbols.join(',')}`,
    );
    assert.ok(Array.isArray(withThem.quotes[0].sparkline));

    const { body: without } = await authed(
      token,
      `/api/market/quotes?symbols=${symbols.join(',')}&sparkline=0`,
    );
    assert.equal('sparkline' in without.quotes[0], false);
  });

  it('reports the freshness of the data, not the time of the request', async () => {
    // `new Date()` is always "just now" and therefore never tells a caller anything.
    // The answer they want is how old this quote is.
    const token = await signIn('batch-asof');
    const symbols = await someSymbols(token, 3);

    const { body } = await authed(
      token,
      `/api/market/quotes?symbols=${symbols.join(',')}&sparkline=0`,
    );

    const newest = body.quotes
      .map((quote) => quote.updatedAt)
      .reduce((latest, at) => (at > latest ? at : latest));
    assert.equal(body.asOf, newest);
  });
});
