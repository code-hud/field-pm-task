/**
 * One sector in detail, and the movers board that stopped counting for nothing.
 *
 * `/sectors` gives an average across a sector and nothing to drill into. An average
 * of +0.4% is the same number whether every name rose slightly or two thirds fell and
 * one very large one carried the rest — and those are different days. The breadth and
 * the two weightings are what tell them apart, so most of these tests construct a
 * sector where the two answers disagree and assert that both are reported honestly.
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

/** A sector with enough names in it to have leaders and laggards. */
const someSector = async (token) => {
  const { body } = await authed(token, '/api/market/sectors');
  return body.performance.find((entry) => entry.stocks >= 6).sector;
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

describe('sector detail', () => {
  it('requires a token', async () => {
    assert.equal((await call('/api/market/sectors/Technology')).status, 401);
  });

  it('describes a sector its summary row cannot', async () => {
    const token = await signIn('sector-detail');
    const sector = await someSector(token);

    const { status, body } = await authed(
      token,
      `/api/market/sectors/${encodeURIComponent(sector)}`,
    );

    assert.equal(status, 200);
    assert.equal(body.sector, sector);
    assert.ok(body.stocks >= 6);
    assert.equal(
      body.breadth.advancing + body.breadth.declining + body.breadth.unchanged,
      body.stocks,
      'every name in the sector is on exactly one side of the line',
    );
    assert.ok(body.leaders.length > 0 && body.laggards.length > 0);
    assert.ok(body.marketCapB > 0);
    assert.ok(body.asOf, 'and says how fresh it is');
  });

  it('separates the cap-weighted answer from the equal-weighted one', async () => {
    // The whole reason both are reported. One enormous name falling while everything
    // small rises is a sector that looks green by headcount and red by money, and a
    // single average cannot say so.
    const token = await signIn('sector-weighting');
    const sector = await someSector(token);

    const { rows } = await query(
      `SELECT symbol, market_cap_b FROM stocks WHERE sector = $1
       ORDER BY market_cap_b DESC`,
      [sector],
    );
    const giant = rows[0].symbol;
    const rest = rows.slice(1).map((row) => row.symbol);

    // The largest name down 10%, everything else up 5%.
    await query(
      'UPDATE quotes SET price = previous_close * 0.90 WHERE symbol = $1',
      [giant],
    );
    await query(
      'UPDATE quotes SET price = previous_close * 1.05 WHERE symbol = ANY($1)',
      [rest],
    );

    const { body } = await authed(token, `/api/market/sectors/${encodeURIComponent(sector)}`);

    assert.ok(body.equalWeightedChangePercent > 0, 'most names rose');
    assert.ok(
      body.capWeightedChangePercent < body.equalWeightedChangePercent,
      'and the money did worse than the headcount',
    );
    assert.equal(body.breadth.declining, 1);
    assert.equal(body.breadth.advancing, rows.length - 1);
    assert.equal(body.laggards[0].symbol, giant, 'the one that fell reads first');
  });

  it('lists laggards worst-first, not best-last', async () => {
    const token = await signIn('sector-laggards');
    const sector = await someSector(token);

    const { body } = await authed(
      token,
      `/api/market/sectors/${encodeURIComponent(sector)}?count=4`,
    );

    // Measured from the prices, not from the reported `changePercent`. The presenter
    // derives that field from a change it has already rounded to the cent
    // (`round2(price - previous_close)`), while the sort uses the exact ratio — so on
    // a low-priced name the two can disagree by a few basis points, and a name whose
    // true change is exactly 5.00% can be reported as 4.99%. Asserting on the rounded
    // field would be asserting on that discrepancy rather than on the ordering.
    const trueChange = (quote) => (quote.price - quote.previousClose) / quote.previousClose;

    // Compared with a tolerance, because the database sorted these and JavaScript is
    // re-deriving them. Postgres does this arithmetic in `numeric`, where
    // `previous_close * 1.05` is exact and several names tie at precisely 5% — those
    // ties are broken by symbol, which is `listQuotes`' documented secondary sort.
    // Recomputing the same ratio in a float reintroduces error in the seventeenth
    // decimal place that the ordering never had, so a strict comparison here would be
    // asserting on float noise rather than on the sort.
    const ordered = (values, direction) =>
      values.every((value, index) =>
        index === 0 ? true : direction * (value - values[index - 1]) >= -1e-12,
      );

    const laggards = body.laggards.map(trueChange);
    assert.ok(ordered(laggards, 1), `laggards ascend: ${laggards}`);
    // And leaders the other way, so the two lists read outward from the extremes.
    const leaders = body.leaders.map(trueChange);
    assert.ok(ordered(leaders, -1), `leaders descend: ${leaders}`);
    assert.ok(laggards[0] <= leaders.at(-1) + 1e-12, 'the two ends do not overlap');
  });

  it('honours a count, and clamps an unreasonable one', async () => {
    const token = await signIn('sector-count');
    const sector = await someSector(token);

    const { body: three } = await authed(
      token,
      `/api/market/sectors/${encodeURIComponent(sector)}?count=3`,
    );
    assert.equal(three.leaders.length, 3);

    const { body: silly } = await authed(
      token,
      `/api/market/sectors/${encodeURIComponent(sector)}?count=9999`,
    );
    assert.ok(silly.leaders.length <= 25);
  });

  it('is a 404 for a sector that does not exist', async () => {
    // Distinguishable from a sector where nothing moved, which is the reason the
    // repository checks the stock count rather than trusting the aggregate row —
    // count(*) over no rows returns 0, not no row.
    const token = await signIn('sector-missing');
    const { status, body } = await authed(token, '/api/market/sectors/Nonsense');

    assert.equal(status, 404);
    assert.equal(body.error.code, 'unknown_sector');
  });

  it('agrees with the summary that lists it', async () => {
    const token = await signIn('sector-agrees');
    const { body: summary } = await authed(token, '/api/market/sectors');
    const entry = summary.performance.find((row) => row.stocks >= 6);

    const { body: detail } = await authed(
      token,
      `/api/market/sectors/${encodeURIComponent(entry.sector)}`,
    );

    assert.equal(detail.stocks, entry.stocks);
    // The summary's average is the equal-weighted one, so they have to match.
    assert.equal(detail.equalWeightedChangePercent, entry.averageChangePercent);
  });
});

describe('the movers board', () => {
  it('stops asking for counts it throws away', async () => {
    // A top-5 that returns exactly 5 rows does not satisfy `quotes.length < limit`, so
    // every request used to fire three `count(*)`s over the joined tables and discard
    // all three answers. This asserts the flag that stops it, at the level where the
    // waste happened.
    const { listQuotes } = require('../src/market/repository.js');

    const counted = await listQuotes({ sort: 'volume', order: 'desc', limit: 5 });
    assert.equal(counted.total, 503, 'a caller that wants the total still gets it');

    const uncounted = await listQuotes({
      sort: 'volume',
      order: 'desc',
      limit: 5,
      countTotal: false,
    });
    assert.equal(uncounted.total, null, 'and one that does not, does not pay for it');
    assert.deepEqual(
      uncounted.quotes.map((quote) => quote.symbol),
      counted.quotes.map((quote) => quote.symbol),
      'the rows are identical either way',
    );
  });

  it('still returns the three boards', async () => {
    const token = await signIn('movers-shape');
    const { status, body } = await authed(token, '/api/market/movers');

    assert.equal(status, 200);
    assert.equal(body.gainers.length, 5);
    assert.equal(body.losers.length, 5);
    assert.equal(body.mostActive.length, 5);
    assert.equal(body.count, 5);
  });

  it('takes a count', async () => {
    const token = await signIn('movers-count');
    const { body } = await authed(token, '/api/market/movers?count=3');

    assert.equal(body.gainers.length, 3);
    assert.equal(body.count, 3);
  });

  it('reports how fresh the board is', async () => {
    const token = await signIn('movers-asof');
    const { body } = await authed(token, '/api/market/movers');

    const newest = [...body.gainers, ...body.losers, ...body.mostActive]
      .map((quote) => quote.updatedAt)
      .reduce((latest, at) => (at > latest ? at : latest));
    assert.equal(body.asOf, newest);
  });
});
