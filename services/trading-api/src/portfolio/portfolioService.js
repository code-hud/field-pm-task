/**
 * Portfolio reads, as SQL.
 *
 * Two tables, two jobs. `trades` is append-only and answers "what happened", so the
 * equity curve and the ledger read from it and history cannot be rewritten by a
 * trade made today. `lots` is mutable and answers "what is still held" — open
 * quantity is `quantity - closed_quantity` — so cost basis and FIFO read from it.
 * Both are derived rather than stored alongside, so they cannot drift apart.
 *
 * Portfolio *generation* lives in ./generator.js; this module only reads.
 */
const { config } = require('../config/index.js');
const { query } = require('../db/pool.js');
const { reservedCash } = require('../orders/capacity.js');

const round2 = (value) => Math.round(value * 100) / 100;
const round4 = (value) => Math.round(value * 10000) / 10000;
const pct = (part, whole) => (whole > 0 ? round2((part / whole) * 100) : 0);

/** Positions joined to the live tape, with cost basis rolled up from the lots. */
async function getPortfolio(user) {
  const { rows: accountRows } = await query(
    'SELECT id, username, base_currency, cash FROM accounts WHERE id = $1',
    [user.id],
  );
  if (accountRows.length === 0) return null;
  const account = accountRows[0];

  const { rows } = await query(
    `SELECT p.symbol, i.name, i.sector, p.opened_at,
            SUM(l.quantity - l.closed_quantity)::bigint             AS quantity,
            SUM((l.quantity - l.closed_quantity) * l.price)         AS cost_basis,
            q.price, q.previous_close
     FROM positions p
     JOIN stocks i ON i.symbol = p.symbol
     JOIN quotes q      ON q.symbol = p.symbol
     JOIN lots l        ON l.position_id = p.id
     WHERE p.account_id = $1
     GROUP BY p.symbol, i.name, i.sector, p.opened_at, q.price, q.previous_close
     -- A fully sold position keeps its rows as history but is not a holding.
     HAVING SUM(l.quantity - l.closed_quantity) > 0
     ORDER BY SUM(l.quantity - l.closed_quantity) * q.price DESC`,
    [user.id],
  );

  const positions = rows.map((row) => {
    const marketValue = round2(row.quantity * row.price);
    const costBasis = round2(row.cost_basis);
    const unrealizedPnl = round2(marketValue - costBasis);
    const dayChange = round2(row.price - row.previous_close);

    return {
      symbol: row.symbol,
      name: row.name,
      sector: row.sector,
      quantity: row.quantity,
      averageCost: round4(costBasis / row.quantity),
      costBasis,
      openedAt: row.opened_at,
      price: row.price,
      previousClose: row.previous_close,
      dayChange,
      dayChangePercent: pct(dayChange, row.previous_close),
      marketValue,
      dayPnl: round2(row.quantity * dayChange),
      unrealizedPnl,
      unrealizedPnlPercent: pct(unrealizedPnl, costBasis),
    };
  });

  const { rows: dividendRows } = await query(
    'SELECT COALESCE(SUM(amount), 0) AS total FROM dividends WHERE account_id = $1',
    [user.id],
  );

  // Booked gains and losses on shares already sold. Kept separate from unrealized:
  // one is money in the account, the other is a mark that can still move.
  const { rows: realizedRows } = await query(
    `SELECT COALESCE(SUM(realized_pnl), 0) AS total, count(*)::int AS sells
     FROM trades WHERE account_id = $1 AND side = 'SELL'`,
    [user.id],
  );

  // Cash promised to open limit orders. Derived from the orders themselves rather
  // than tracked on the account, so there is no second number to drift — the same
  // argument cost basis makes about being read from the lots.
  const committed = await reservedCash(null, user.id);
  const availableCash = round2(account.cash - committed);

  const realized = round2(Number(realizedRows[0].total));
  const marketValue = round2(positions.reduce((total, p) => total + p.marketValue, 0));
  const costBasis = round2(positions.reduce((total, p) => total + p.costBasis, 0));
  const dayPnl = round2(positions.reduce((total, p) => total + p.dayPnl, 0));
  const totalValue = round2(marketValue + account.cash);
  const previousValue = round2(totalValue - dayPnl);
  const unrealizedPnl = round2(marketValue - costBasis);

  return {
    account: {
      userId: account.id,
      username: account.username,
      baseCurrency: account.base_currency,
    },
    summary: {
      totalValue,
      marketValue,
      cash: account.cash,
      // What is spoken for, and what is left. `cash` is still the balance — that is
      // what the ledger sums to — but an account with 10,000 in it and 9,000 committed
      // to open buy orders cannot spend 10,000, and a screen that only shows the
      // balance says it can.
      reservedCash: committed,
      availableCash,
      // Against what is actually spendable. Doubling the full balance would offer
      // margin on money already promised to an order.
      buyingPower: round2(availableCash * 2),
      costBasis,
      dayPnl,
      dayPnlPercent: pct(dayPnl, previousValue),
      unrealizedPnl,
      unrealizedPnlPercent: pct(unrealizedPnl, costBasis),
      realizedPnl: realized,
      // Realized plus unrealized: what the account has made on trading overall,
      // whether or not the position is still open.
      totalPnl: round2(realized + unrealizedPnl),
      closedTrades: realizedRows[0].sells,
      dividendIncome: round2(dividendRows[0].total),
      positionCount: positions.length,
    },
    positions: positions.map((position) => ({
      ...position,
      weightPercent: pct(position.marketValue, marketValue),
    })),
    asOf: new Date().toISOString(),
  };
}

/** Allocation by sector — aggregated in the database, not in a JS reduce. */
async function getAllocation(user) {
  const { rows } = await query(
    `SELECT i.sector,
            SUM((l.quantity - l.closed_quantity) * q.price) AS market_value,
            array_agg(DISTINCT p.symbol) AS symbols
     FROM positions p
     JOIN stocks i ON i.symbol = p.symbol
     JOIN quotes q      ON q.symbol = p.symbol
     JOIN lots l        ON l.position_id = p.id
     WHERE p.account_id = $1
     GROUP BY i.sector
     HAVING SUM(l.quantity - l.closed_quantity) > 0
     ORDER BY market_value DESC`,
    [user.id],
  );

  const { rows: holdingRows } = await query(
    `SELECT p.symbol, i.name, i.sector, SUM((l.quantity - l.closed_quantity) * q.price) AS market_value
     FROM positions p
     JOIN stocks i ON i.symbol = p.symbol
     JOIN quotes q      ON q.symbol = p.symbol
     JOIN lots l        ON l.position_id = p.id
     WHERE p.account_id = $1
     GROUP BY p.symbol, i.name, i.sector
     HAVING SUM(l.quantity - l.closed_quantity) > 0
     ORDER BY market_value DESC`,
    [user.id],
  );

  const { rows: cashRows } = await query('SELECT cash FROM accounts WHERE id = $1', [user.id]);
  const cash = cashRows[0]?.cash ?? 0;
  const marketValue = rows.reduce((total, row) => total + row.market_value, 0);
  const totalValue = marketValue + cash;

  return {
    sectors: rows.map((row) => ({
      sector: row.sector,
      marketValue: round2(row.market_value),
      symbols: row.symbols,
      weightPercent: pct(row.market_value, marketValue),
    })),
    holdings: holdingRows.map((row) => ({
      symbol: row.symbol,
      name: row.name,
      sector: row.sector,
      marketValue: round2(row.market_value),
      weightPercent: pct(row.market_value, marketValue),
    })),
    cash: {
      marketValue: round2(cash),
      weightPercent: pct(cash, totalValue),
    },
    asOf: new Date().toISOString(),
  };
}

const RANGE_SESSIONS = { '1M': 22, '3M': 66, '6M': 132, '1Y': 252, ALL: null };

/**
 * The equity curve, in one query.
 *
 * Every point is a function of `trades` dated on or before that session, and
 * `trades` is append-only — so once a session is in the past its reported value can
 * never move again. That is the property this query exists to guarantee, and there
 * is a test asserting it directly.
 *
 * Holdings at session D are the net shares from every trade up to D (buys add,
 * sells subtract), marked to that session's close. Cash at D is the funding, plus
 * dividends received by D, plus the signed cash effect of every trade by D — so a
 * sale's proceeds land in the series on the day they happened, rather than being
 * invisible the way a lot-derived reconstruction made them.
 *
 * Deliberately reads `trades`, not `lots`: lots are mutated as shares are closed,
 * and anything historical that reads a mutable table can be rewritten by a trade
 * made today.
 */
async function getEquityCurve(user, range = '3M') {
  const configured = RANGE_SESSIONS[range] === undefined ? RANGE_SESSIONS['3M'] : RANGE_SESSIONS[range];
  const sessions = Math.min(configured ?? config.portfolio.historyDays, config.portfolio.historyDays);

  const { rows } = await query(
    `WITH windowed AS (
       SELECT session_date FROM (
         SELECT DISTINCT session_date FROM daily_bars ORDER BY session_date DESC LIMIT $2
       ) recent
     ),
     -- Net shares per symbol as of each session in the window.
     holdings AS (
       SELECT w.session_date,
              t.symbol,
              SUM(CASE WHEN t.side = 'BUY' THEN t.quantity ELSE -t.quantity END) AS shares
       FROM windowed w
       JOIN trades t ON t.account_id = $1 AND t.trade_date <= w.session_date
       GROUP BY w.session_date, t.symbol
       -- A position opened and fully closed before D contributes nothing; dropping
       -- it here saves joining a daily bar to multiply by zero.
       HAVING SUM(CASE WHEN t.side = 'BUY' THEN t.quantity ELSE -t.quantity END) <> 0
     )
     SELECT w.session_date,
            COALESCE(SUM(h.shares * db.close), 0) AS holdings_value,
            (SELECT COALESCE(SUM(t.cash_delta), 0) FROM trades t
              WHERE t.account_id = $1 AND t.trade_date <= w.session_date)   AS trade_cash,
            (SELECT COALESCE(SUM(d.amount), 0) FROM dividends d
              WHERE d.account_id = $1 AND d.pay_date <= w.session_date)     AS dividends_paid,
            (SELECT funded_amount FROM accounts WHERE id = $1)              AS funded
     FROM windowed w
     LEFT JOIN holdings h    ON h.session_date = w.session_date
     LEFT JOIN daily_bars db ON db.symbol = h.symbol AND db.session_date = w.session_date
     GROUP BY w.session_date
     ORDER BY w.session_date`,
    [user.id, sessions],
  );

  // `trade_cash` is signed — negative for purchases, positive for sale proceeds —
  // so it adds rather than subtracts, and a sale shows up as cash on its own date.
  const points = rows.map((row) => ({
    date: row.session_date,
    value: round2(row.holdings_value + row.funded + row.dividends_paid + row.trade_cash),
    invested: round2(-row.trade_cash),
  }));

  // Pin the final point to the live valuation so the chart agrees with the header:
  // the last daily close is yesterday's, and the tape has moved since.
  if (points.length > 0) {
    const live = await getPortfolio(user);
    if (live) points[points.length - 1] = { ...points.at(-1), value: live.summary.totalValue };
  }

  const first = points[0]?.value ?? 0;
  const last = points.at(-1)?.value ?? 0;
  const values = points.map((point) => point.value);

  return {
    range,
    points,
    summary: {
      startValue: first,
      endValue: last,
      change: round2(last - first),
      changePercent: first > 0 ? round2(((last - first) / first) * 100) : 0,
      high: values.length ? Math.max(...values) : 0,
      low: values.length ? Math.min(...values) : 0,
    },
    asOf: new Date().toISOString(),
  };
}

/**
 * The ledger: funding, then every trade, then every dividend.
 *
 * Trades come from `trades` rather than from `lots`. That is the whole difference
 * between a ledger that only ever grows and the one this replaced, which read buys
 * out of `lots` — so selling deleted the lot, the buy vanished from the history,
 * and a completed trade made the ledger one entry *shorter*.
 */
async function getTransactions(user, { limit = 50 } = {}) {
  const { rows } = await query(
    `WITH entries AS (
       SELECT 'txn_funding'                                              AS id,
              (SELECT MIN(trade_date) FROM trades WHERE account_id = $1) AS date,
              'DEPOSIT'                                                  AS type,
              NULL::text                                                 AS symbol,
              NULL::bigint                                               AS quantity,
              NULL::numeric                                              AS price,
              a.funded_amount                                            AS amount,
              NULL::numeric                                              AS realized_pnl,
              'ACH deposit — account funding'                            AS description
       FROM accounts a WHERE a.id = $1

       UNION ALL

       SELECT 'txn_trade_' || t.id, t.trade_date, t.side, t.symbol, t.quantity, t.price,
              t.cash_delta, t.realized_pnl,
              CASE WHEN t.side = 'BUY' THEN 'Bought ' ELSE 'Sold ' END
                || t.quantity || ' ' || t.symbol
                || ' @ ' || to_char(t.price, 'FM999999990.00')
       FROM trades t WHERE t.account_id = $1

       UNION ALL

       SELECT 'txn_div_' || d.id, d.pay_date, 'DIVIDEND', d.symbol, NULL, NULL,
              d.amount, NULL, d.symbol || ' cash dividend'
       FROM dividends d WHERE d.account_id = $1
     )
     SELECT *, count(*) OVER () AS total FROM entries
     ORDER BY date DESC, id ASC
     LIMIT $2`,
    [user.id, limit],
  );

  return {
    transactions: rows.map((row) => ({
      id: row.id,
      date: row.date,
      type: row.type,
      symbol: row.symbol,
      quantity: row.quantity,
      price: row.price,
      amount: round2(row.amount),
      // Only present on sells; null everywhere else rather than a misleading zero.
      realizedPnl: row.realized_pnl === null ? null : round2(row.realized_pnl),
      description: row.description,
    })),
    total: rows[0]?.total ?? 0,
  };
}

module.exports = { getPortfolio, getAllocation, getEquityCurve, getTransactions };
