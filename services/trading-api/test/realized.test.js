/**
 * The realized P/L breakdown.
 *
 * The assertion running through all of these is that the endpoint never contradicts
 * `trades.realized_pnl`, which the portfolio header already reports. It can explain
 * less than that total — sales made before `lot_closures` existed cannot be attributed
 * to anything — but it has to say so, and the parts always have to add back up.
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

const unheldSymbol = async (token, skip = new Set()) => {
  const { body: portfolio } = await authed(token, '/api/portfolio');
  const held = new Set(portfolio.positions.map((position) => position.symbol));
  const { body: market } = await authed(token, '/api/market/stocks');
  return market.stocks.find((quote) => !held.has(quote.symbol) && !skip.has(quote.symbol))
    .symbol;
};

const repriceTo = async (symbol, price) => {
  await query('UPDATE quotes SET price = $2 WHERE symbol = $1', [symbol, price]);
};

/**
 * Ages every lot on a position, so a sale can close something older than today.
 *
 * Fills always date a lot CURRENT_DATE, so there is no sequence of API calls that
 * produces a long-held share. Backdating the row is the only way to reach the far side
 * of the one-year line, and it is exactly what the passage of time would have done.
 *
 * Applied between two buys, it ages only the first — which is how these build a position
 * with one old lot and one new one.
 */
const backdateLots = async (accountId, symbol, interval) => {
  await query(
    `UPDATE lots SET trade_date = (CURRENT_DATE - $3::interval)::date
     WHERE position_id = (SELECT id FROM positions WHERE account_id = $1 AND symbol = $2)`,
    [accountId, symbol, interval],
  );
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

describe('realized P/L breakdown', () => {
  it('requires a token', async () => {
    const { status } = await call('/api/portfolio/realized');
    assert.equal(status, 401);
  });

  it('reports zeroes for an account that has never sold', async () => {
    const token = await signIn('never-sold');
    const { status, body } = await authed(token, '/api/portfolio/realized');

    assert.equal(status, 200);
    assert.equal(body.summary.realizedPnl, 0);
    assert.equal(body.summary.attributedPnl, 0);
    assert.equal(body.summary.unattributedPnl, 0);
    assert.equal(body.summary.sales, 0);
    assert.deepEqual(body.bySymbol, []);
    // Not NaN, and not 100. Nothing has been closed, so there is no rate yet.
    assert.equal(body.summary.winRatePercent, 0);
  });

  it('breaks a sale down by symbol', async () => {
    const token = await signIn('breaker');
    const winner = await unheldSymbol(token);
    const loser = await unheldSymbol(token, new Set([winner]));

    await repriceTo(winner, 100);
    await order(token, { symbol: winner, side: 'BUY', quantity: 10 });
    await repriceTo(winner, 140);
    await order(token, { symbol: winner, side: 'SELL', quantity: 10 });

    await repriceTo(loser, 50);
    await order(token, { symbol: loser, side: 'BUY', quantity: 4 });
    await repriceTo(loser, 35);
    await order(token, { symbol: loser, side: 'SELL', quantity: 4 });

    const { body } = await authed(token, '/api/portfolio/realized');

    // Best contribution first, so the winner leads whatever order the trades were in.
    assert.deepEqual(
      body.bySymbol.map((entry) => entry.symbol),
      [winner, loser],
    );

    const [gain, loss] = body.bySymbol;
    assert.equal(gain.realizedPnl, 400);
    assert.equal(gain.shares, 10);
    assert.equal(gain.winners, 1);
    assert.equal(gain.losers, 0);
    // 400 against the 1000 the shares cost, not against the 1400 they fetched.
    assert.equal(gain.returnPercent, 40);

    assert.equal(loss.realizedPnl, -60);
    assert.equal(loss.winners, 0);
    assert.equal(loss.losers, 1);
    assert.equal(loss.returnPercent, -30);

    assert.equal(body.summary.realizedPnl, 340);
    assert.equal(body.summary.bestClosure, 400);
    assert.equal(body.summary.worstClosure, -60);
    assert.equal(body.summary.winRatePercent, 50);
  });

  it('never contradicts the total the portfolio reports', async () => {
    const token = await signIn('agreer');
    const symbol = await unheldSymbol(token);

    await repriceTo(symbol, 33.3331);
    await order(token, { symbol, side: 'BUY', quantity: 7 });
    await repriceTo(symbol, 41.6669);
    await order(token, { symbol, side: 'BUY', quantity: 5 });
    await repriceTo(symbol, 47.7773);
    await order(token, { symbol, side: 'SELL', quantity: 9 });

    const { body: portfolio } = await authed(token, '/api/portfolio');
    const { body: realized } = await authed(token, '/api/portfolio/realized');

    assert.equal(realized.summary.realizedPnl, portfolio.summary.realizedPnl);
    assert.equal(
      realized.summary.attributedPnl + realized.summary.unattributedPnl,
      realized.summary.realizedPnl,
      'attributed and unattributed always add back to the authority',
    );
  });

  it('counts each lot a sale closed, not just the sale', async () => {
    // One sale can be a win and a loss at once. Counting it as a single trade whose
    // net came out positive would hide the losing half from every figure here.
    const token = await signIn('splitter');
    const accountId = await accountIdOf('splitter');
    const symbol = await unheldSymbol(token);

    await repriceTo(symbol, 20);
    await order(token, { symbol, side: 'BUY', quantity: 5 });
    await repriceTo(symbol, 90);
    await order(token, { symbol, side: 'BUY', quantity: 5 });

    // Between the two: the first lot is well up, the second well down.
    await repriceTo(symbol, 60);
    await order(token, { symbol, side: 'SELL', quantity: 10 });

    const { body } = await authed(token, '/api/portfolio/realized');
    const entry = body.bySymbol.find((row) => row.symbol === symbol);

    assert.equal(entry.sales, 1, 'one sale');
    assert.equal(entry.closures, 2, 'two round trips');
    assert.equal(entry.winners, 1);
    assert.equal(entry.losers, 1);
    assert.equal(entry.bestClosure, 200); // 5 × (60 − 20)
    assert.equal(entry.worstClosure, -150); // 5 × (60 − 90)
    assert.equal(entry.realizedPnl, 50);

    const { rows } = await query(
      `SELECT COALESCE(SUM(realized_pnl), 0) AS total FROM trades
       WHERE account_id = $1 AND side = 'SELL' AND symbol = $2`,
      [accountId, symbol],
    );
    assert.equal(entry.realizedPnl, Number(rows[0].total));
  });

  it('owns up to the sales it cannot explain', async () => {
    // Standing in for a sale made before 004: the money is on the trade, but nothing
    // records which lots went out, and no honest reconstruction exists.
    const token = await signIn('historian');
    const accountId = await accountIdOf('historian');
    const symbol = await unheldSymbol(token);

    await repriceTo(symbol, 10);
    await order(token, { symbol, side: 'BUY', quantity: 20 });
    await repriceTo(symbol, 18);
    await order(token, { symbol, side: 'SELL', quantity: 5 });

    const { rows: tradeRows } = await query(
      `SELECT id FROM trades WHERE account_id = $1 AND side = 'SELL' ORDER BY id DESC LIMIT 1`,
      [accountId],
    );
    await query('DELETE FROM lot_closures WHERE trade_id = $1', [tradeRows[0].id]);

    const { body } = await authed(token, '/api/portfolio/realized');

    assert.equal(body.summary.realizedPnl, 40, 'the trade still says what it made');
    assert.equal(body.summary.attributedPnl, 0, 'and the closures can explain none of it');
    assert.equal(body.summary.unattributedPnl, 40);
    assert.equal(body.summary.sales, 1);
    assert.equal(body.summary.unattributedSales, 1, 'the gap has a size, not just a value');
    assert.deepEqual(body.bySymbol, [], 'nothing is invented to fill the hole');
  });

  it('counts a sale spanning several lots once', async () => {
    // The join hazard: three closure rows for one sale must not read as three sales,
    // and must not multiply the authority by three either.
    const token = await signIn('spanner');
    const symbol = await unheldSymbol(token);

    for (const price of [11, 12, 13]) {
      await repriceTo(symbol, price);
      await order(token, { symbol, side: 'BUY', quantity: 2 });
    }
    await repriceTo(symbol, 20);
    await order(token, { symbol, side: 'SELL', quantity: 6 });

    const { body } = await authed(token, '/api/portfolio/realized');

    assert.equal(body.summary.sales, 1);
    assert.equal(body.summary.unattributedSales, 0);
    assert.equal(body.summary.closures, 3);
    assert.equal(body.summary.realizedPnl, body.summary.attributedPnl);
  });

  it('does not count a flat close as either a win or a loss', async () => {
    const token = await signIn('flatliner');
    const symbol = await unheldSymbol(token);

    await repriceTo(symbol, 25);
    await order(token, { symbol, side: 'BUY', quantity: 3 });
    await order(token, { symbol, side: 'SELL', quantity: 3 });

    const { body } = await authed(token, '/api/portfolio/realized');
    const entry = body.bySymbol.find((row) => row.symbol === symbol);

    assert.equal(entry.realizedPnl, 0);
    assert.equal(entry.winners, 0);
    assert.equal(entry.losers, 0);
    assert.equal(body.summary.flat, 1);
    // The rate is over closures that had an outcome; a tie is not a loss.
    assert.equal(body.summary.winRatePercent, 0);
  });

  it('sees only the account that asked', async () => {
    const mine = await signIn('mine-only');
    const symbol = await unheldSymbol(mine);

    await repriceTo(symbol, 15);
    await order(mine, { symbol, side: 'BUY', quantity: 6 });
    await repriceTo(symbol, 26);
    await order(mine, { symbol, side: 'SELL', quantity: 6 });

    const theirs = await signIn('theirs-only');
    const { body } = await authed(theirs, '/api/portfolio/realized');

    assert.equal(body.summary.realizedPnl, 0);
    assert.deepEqual(body.bySymbol, []);
  });
});

describe('holding period', () => {
  it('splits one sale across the line', async () => {
    const token = await signIn('splitter-term');
    const accountId = await accountIdOf('splitter-term');
    const symbol = await unheldSymbol(token);

    await repriceTo(symbol, 10);
    await order(token, { symbol, side: 'BUY', quantity: 5 });
    await backdateLots(accountId, symbol, '400 days');
    await repriceTo(symbol, 30);
    await order(token, { symbol, side: 'BUY', quantity: 5 });

    await repriceTo(symbol, 50);
    await order(token, { symbol, side: 'SELL', quantity: 10 });

    const { body } = await authed(token, '/api/portfolio/realized');
    const entry = body.bySymbol.find((row) => row.symbol === symbol);

    assert.equal(entry.longTerm.closures, 1);
    assert.equal(entry.longTerm.realizedPnl, 200); // 5 × (50 − 10), bought 400 days ago
    assert.equal(entry.shortTerm.closures, 1);
    assert.equal(entry.shortTerm.realizedPnl, 100); // 5 × (50 − 30), bought today

    assert.equal(body.summary.longTerm.realizedPnl, 200);
    assert.equal(body.summary.shortTerm.realizedPnl, 100);
    assert.equal(body.summary.longestHoldDays, 400);
    assert.equal(body.summary.shortestHoldDays, 0);
  });

  it('counts the sale itself once, however it splits', async () => {
    // The trap the second query exists to avoid: a sale on both sides of the line has a
    // row in each term group, and adding the two DISTINCT counts would report two sales.
    const token = await signIn('once-term');
    const accountId = await accountIdOf('once-term');
    const symbol = await unheldSymbol(token);

    await repriceTo(symbol, 12);
    await order(token, { symbol, side: 'BUY', quantity: 3 });
    await backdateLots(accountId, symbol, '500 days');
    await order(token, { symbol, side: 'BUY', quantity: 3 });
    await repriceTo(symbol, 18);
    await order(token, { symbol, side: 'SELL', quantity: 6 });

    const { body } = await authed(token, '/api/portfolio/realized');
    const entry = body.bySymbol.find((row) => row.symbol === symbol);

    assert.equal(entry.sales, 1);
    assert.equal(entry.closures, 2);
    assert.equal(body.summary.sales, 1);
  });

  it('always adds the two sides back to the attributed total', async () => {
    const token = await signIn('adds-back');
    const accountId = await accountIdOf('adds-back');
    const symbol = await unheldSymbol(token);

    await repriceTo(symbol, 27.7771);
    await order(token, { symbol, side: 'BUY', quantity: 8 });
    await backdateLots(accountId, symbol, '3 years');
    await repriceTo(symbol, 31.1113);
    await order(token, { symbol, side: 'BUY', quantity: 7 });
    await repriceTo(symbol, 44.4447);
    await order(token, { symbol, side: 'SELL', quantity: 15 });

    const { body } = await authed(token, '/api/portfolio/realized');

    assert.equal(
      round2(body.summary.shortTerm.realizedPnl + body.summary.longTerm.realizedPnl),
      body.summary.attributedPnl,
      'every closure is on exactly one side of a date comparison — there is no third answer',
    );
  });

  it('treats exactly one year as short term', async () => {
    // The rule is *more than* a year. A lot sold on its anniversary is one day short,
    // and reporting it as long-term is the error that costs someone money.
    const token = await signIn('anniversary');
    const accountId = await accountIdOf('anniversary');
    const symbol = await unheldSymbol(token);

    await repriceTo(symbol, 40);
    await order(token, { symbol, side: 'BUY', quantity: 2 });
    await backdateLots(accountId, symbol, '1 year');
    await repriceTo(symbol, 55);
    await order(token, { symbol, side: 'SELL', quantity: 2 });

    const { body } = await authed(token, '/api/portfolio/realized');
    const entry = body.bySymbol.find((row) => row.symbol === symbol);

    assert.equal(entry.shortTerm.closures, 1);
    assert.equal(entry.longTerm.closures, 0);
    assert.equal(entry.longTerm.realizedPnl, 0, 'zeroes, not a missing key');
  });

  it('treats one day past the year as long term', async () => {
    // The other side of the same boundary, expressed as an interval rather than a day
    // count, so it holds whether or not the intervening February had 29 days.
    const token = await signIn('day-after');
    const accountId = await accountIdOf('day-after');
    const symbol = await unheldSymbol(token);

    await repriceTo(symbol, 40);
    await order(token, { symbol, side: 'BUY', quantity: 2 });
    await backdateLots(accountId, symbol, '1 year 1 day');
    await repriceTo(symbol, 55);
    await order(token, { symbol, side: 'SELL', quantity: 2 });

    const { body } = await authed(token, '/api/portfolio/realized');
    const entry = body.bySymbol.find((row) => row.symbol === symbol);

    assert.equal(entry.longTerm.closures, 1);
    assert.equal(entry.shortTerm.closures, 0);
  });

  it('weights the average holding period by shares', async () => {
    // One share held over a year and ninety-nine bought this morning. An unweighted mean
    // over the two closures says two hundred days, which describes no part of this
    // account.
    const token = await signIn('weigher');
    const accountId = await accountIdOf('weigher');
    const symbol = await unheldSymbol(token);

    await repriceTo(symbol, 5);
    await order(token, { symbol, side: 'BUY', quantity: 1 });
    await backdateLots(accountId, symbol, '400 days');
    await order(token, { symbol, side: 'BUY', quantity: 99 });
    await repriceTo(symbol, 7);
    await order(token, { symbol, side: 'SELL', quantity: 100 });

    const { body } = await authed(token, '/api/portfolio/realized');
    const entry = body.bySymbol.find((row) => row.symbol === symbol);

    // (1 × 400 + 99 × 0) / 100.
    assert.equal(entry.averageHoldingDays, 4);
    assert.equal(entry.longTerm.averageHoldingDays, 400);
    assert.equal(entry.shortTerm.averageHoldingDays, 0);
  });

  it('reports both sides as zeroes for an account that has never sold', async () => {
    const token = await signIn('never-sold-term');
    const { body } = await authed(token, '/api/portfolio/realized');

    assert.equal(body.summary.shortTerm.closures, 0);
    assert.equal(body.summary.longTerm.closures, 0);
    assert.equal(body.summary.averageHoldingDays, 0);
    assert.equal(body.summary.longestHoldDays, 0);
  });
});

const round2 = (value) => Math.round(value * 100) / 100;
