/**
 * Conditional requests on `GET /api/market/stocks/:symbol/history`.
 *
 * The property under test is not "a 304 comes back" but *when* one is allowed to.
 * A validator that is too coarse serves a chart the tape has already moved past,
 * and on a demo whose whole point is that the numbers agree with each other that is
 * the worse failure of the two. So the cases below pin both directions: the same
 * bars must revalidate, and a bar that changes — or a different symbol, or a
 * different window over the same bars — must not.
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
// Imported in `before`, after DATABASE_URL points at the test database — the config
// module reads the environment at import time.
let closePool;
let query;
let token;

/** Keeps the headers, which is the entire subject here. */
const call = async (path, options = {}) => {
  const response = await fetch(`${baseUrl}${path}`, options);
  return {
    status: response.status,
    etag: response.headers.get('etag'),
    cacheControl: response.headers.get('cache-control'),
    // A 304 carries no body, and asking fetch to parse one would throw.
    body: response.status === 304 ? null : await response.json(),
  };
};

const history = (symbol, range, headers = {}) =>
  call(`/api/market/stocks/${symbol}/history?range=${range}`, {
    headers: { authorization: `Bearer ${token}`, ...headers },
  });

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

  const { body } = await call('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'charts', password: 'demo' }),
  });
  token = body.token;
});

after(async () => {
  server?.close();
  await closePool?.();
  if (testDb) await dropTestDatabase(testDb.name);
});

describe('conditional requests for chart history', () => {
  it('hands the client a validator and permission to store the chart', async () => {
    const { status, etag, cacheControl, body } = await history('AAPL', '1Y');
    assert.equal(status, 200);
    assert.ok(etag, 'a chart carries an ETag to come back with');
    // Without this header the ETag is decoration: a browser that may not store the
    // response has nothing to revalidate, and never sends If-None-Match at all.
    assert.equal(cacheControl, 'private, no-cache');
    assert.ok(body.bars.length > 0);
  });

  it('answers an unchanged chart with 304 and nothing else', async () => {
    const first = await history('AAPL', '1Y');
    const second = await history('AAPL', '1Y', { 'if-none-match': first.etag });

    assert.equal(second.status, 304);
    assert.equal(second.body, null);
    // Both headers have to be repeated on the 304, or the client has to throw the
    // copy away after one use and the round trip buys nothing the next time.
    assert.equal(second.etag, first.etag);
    assert.equal(second.cacheControl, 'private, no-cache');
  });

  it('answers a client that holds the chart among several validators', async () => {
    const { etag } = await history('AAPL', '1Y');
    const listed = await history('AAPL', '1Y', {
      'if-none-match': `W/"something-else", ${etag}, W/"older-still"`,
    });
    assert.equal(listed.status, 304);

    const wildcard = await history('AAPL', '1Y', { 'if-none-match': '*' });
    assert.equal(wildcard.status, 304, 'the chart exists, so any representation will do');
  });

  it('reads the strong and the weak form of a validator as the same chart', async () => {
    // If-None-Match compares weakly and only weakly, so a client that dropped or
    // added the W/ prefix is still holding these bars and must not be sent them again.
    const { etag } = await history('AAPL', '1M');
    const stripped = await history('AAPL', '1M', { 'if-none-match': etag.replace(/^W\//, '') });
    assert.equal(stripped.status, 304);
  });

  it('answers a conditional request that also tells caches not to serve it', async () => {
    // `Cache-Control: no-cache` on a request is addressed to the caches in between:
    // it says the reload has to reach the origin, which it now has. Express's own
    // `req.fresh` treats it as a reason to ignore the validator entirely, and that is
    // not a small difference — `fetch()` adds this header by itself the moment a
    // caller sets If-None-Match by hand, so every scripted client would be sending it.
    const { etag } = await history('AAPL', '1Y');
    const reload = await history('AAPL', '1Y', {
      'if-none-match': etag,
      'cache-control': 'no-cache',
    });
    assert.equal(reload.status, 304);
  });

  it('gives a symbol the same validator for the same bars', async () => {
    const first = await history('MSFT', '1M');
    const second = await history('MSFT', '1M');
    assert.equal(first.etag, second.etag);
  });

  it('does not let one window revalidate another over the same bars', async () => {
    // 1M and 1Y end on the same session and share their newest bar, which is what a
    // validator built from that bar alone would collapse them onto. They are 22 bars
    // and 252 bars, so the range has to be part of the version too.
    const month = await history('AAPL', '1M');
    const year = await history('AAPL', '1Y');
    assert.notEqual(month.etag, year.etag);

    const stale = await history('AAPL', '1Y', { 'if-none-match': month.etag });
    assert.equal(stale.status, 200);
    assert.ok(stale.body.bars.length > month.body.bars.length);
  });

  it('does not let one symbol revalidate another', async () => {
    const apple = await history('AAPL', '1M');
    const other = await history('MSFT', '1M', { 'if-none-match': apple.etag });
    assert.equal(other.status, 200);
    assert.equal(other.body.symbol, 'MSFT');
  });

  it('serves the same bars whether or not the request was conditional', async () => {
    const plain = await history('AAPL', '5D');
    const conditional = await history('AAPL', '5D', { 'if-none-match': 'W/"nothing-like-it"' });
    assert.equal(conditional.status, 200);
    assert.deepEqual(conditional.body, plain.body);
  });

  it('keeps refusing an unknown symbol and an unsupported range', async () => {
    // Both checks run before the validator is looked up, so neither can be turned
    // into a 304 by a client that guesses an ETag, and neither pays for a lookup.
    assert.equal((await history('NOPE', '1Y')).status, 404);
    assert.equal((await history('AAPL', '7Y')).status, 400);
  });

  // The remaining cases rewrite bars, so they run last: this database belongs to this
  // file alone, but the assertions above expect the market as seeded.
  it('invalidates the client copy as soon as a bar moves', async () => {
    const stored = await history('AAPL', '1D');
    const { rows } = await query(
      `SELECT session_date, minute FROM intraday_bars
       WHERE symbol = 'AAPL' ORDER BY session_date DESC, minute DESC LIMIT 1`,
    );

    // What a tick does to the minute in progress: it extends that bar's close and
    // leaves the calendar exactly as it was. A version made of dates would still
    // match here, which is why the bar's own prices are in it.
    await query(
      `UPDATE intraday_bars SET close = close + 1
       WHERE symbol = 'AAPL' AND session_date = $1 AND minute = $2`,
      [rows[0].session_date, rows[0].minute],
    );

    const reread = await history('AAPL', '1D', { 'if-none-match': stored.etag });
    assert.equal(reread.status, 200, 'a moved bar is not a fresh copy');
    assert.notEqual(reread.etag, stored.etag);
    assert.notDeepEqual(reread.body.bars.at(-1), stored.body.bars.at(-1));
  });

  it('answers a known symbol with no bars with an empty chart, not a 404', async () => {
    await query("DELETE FROM daily_bars WHERE symbol = 'MSFT'");

    const { status, cacheControl, body } = await history('MSFT', '1Y');
    // There is no newest bar to build a version from. That is a symbol we have
    // nothing for yet, not a symbol we do not know, and the endpoint has to survive
    // the missing validator rather than fall over on it.
    assert.equal(status, 200);
    assert.equal(cacheControl, 'private, no-cache');
    assert.deepEqual(body.bars, []);
  });
});
