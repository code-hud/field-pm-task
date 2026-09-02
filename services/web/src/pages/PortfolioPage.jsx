import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';

import { api } from '../api/client.js';
import { BarList } from '../components/BarList.jsx';
import { ChartCard, RangePicker } from '../components/ChartCard.jsx';
import { Delta } from '../components/Delta.jsx';
import { LineChart } from '../components/LineChart.jsx';
import { StatTile } from '../components/StatTile.jsx';
import { ErrorState, LoadingState, StaleNotice } from '../components/States.jsx';
import { TradeTicket } from '../components/TradeTicket.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import { useLiveQuery } from '../hooks/useLiveQuery.js';
import {
  clockTime,
  compactMoney,
  mediumDate,
  money,
  percent,
  shares,
  shortDate,
  signedMoney,
  signedPercent,
} from '../lib/format.js';

const RANGES = ['1M', '3M', '6M', '1Y', 'ALL'];
const REFRESH_MS = 5000;

export function PortfolioPage() {
  const { user } = useAuth();
  const [range, setRange] = useState('3M');
  // { symbol, side } while a ticket is open.
  const [ticket, setTicket] = useState(null);

  const portfolio = useLiveQuery((signal) => api.portfolio(signal), { intervalMs: REFRESH_MS });
  const allocation = useLiveQuery((signal) => api.allocation(signal), { intervalMs: REFRESH_MS });
  const history = useLiveQuery((signal) => api.portfolioHistory(range, signal), {
    intervalMs: 30_000,
    deps: [range],
  });
  // The ledger only changes when the account does — no need to poll it.
  const activity = useLiveQuery((signal) => api.transactions(8, signal));
  // Realized P/L moves only when something is sold, which this page finds out about
  // from the fill itself. Polling it would spend a request a tick to re-read a number
  // that changes a few times a day.
  const realized = useLiveQuery((signal) => api.realized(signal));
  // Polled, unlike the realized breakdown: these fill on their own, on a market tick
  // nothing on this page hears about. A card that only refreshed on a fill would keep
  // showing an order that traded ten minutes ago.
  const open = useLiveQuery((signal) => api.orders({ status: 'OPEN', limit: 50 }, signal), {
    intervalMs: REFRESH_MS,
  });

  if (portfolio.isLoading) return <LoadingState label="Loading your portfolio" height={420} />;
  if (portfolio.error) return <ErrorState error={portfolio.error} onRetry={portfolio.refresh} title="Could not load your portfolio" />;

  const { summary, positions, asOf } = portfolio.data;

  return (
    <>
      <div className="pagehead">
        <div className="pagehead__titles">
          <h1>Portfolio</h1>
          <p>
            {user?.accountType} · {user?.accountNumber} · {summary.positionCount} positions · advised by{' '}
            {user?.advisor}
          </p>
        </div>
        <span className="pill">Updated {clockTime(asOf)}</span>
      </div>

      {portfolio.refreshError && (
        <StaleNotice
          error={portfolio.refreshError}
          since={clockTime(asOf)}
          onRetry={portfolio.refresh}
        />
      )}

      <div className="grid grid--tiles">
        <StatTile
          hero
          label="Total account value"
          value={money(summary.totalValue, { cents: false })}
          delta={`${signedMoney(summary.dayPnl)} (${signedPercent(summary.dayPnlPercent)})`}
          deltaValue={summary.dayPnl}
          footnote="today"
        />
        <StatTile
          label="Unrealized P/L"
          value={signedMoney(summary.unrealizedPnl)}
          delta={signedPercent(summary.unrealizedPnlPercent)}
          deltaValue={summary.unrealizedPnl}
          footnote={`on ${money(summary.costBasis, { cents: false })} cost basis`}
        />
        <StatTile
          label="Holdings value"
          value={money(summary.marketValue, { cents: false })}
          footnote={`${percent((summary.marketValue / summary.totalValue) * 100, { digits: 1 })} invested`}
        />
        <StatTile
          label="Cash"
          value={money(summary.cash, { cents: false })}
          // What is spendable, once open orders are accounted for. Only said out loud
          // when something is actually held — otherwise it is a caveat about nothing.
          footnote={
            summary.reservedCash > 0
              ? `${money(summary.availableCash, { cents: false })} available · ${money(
                  summary.reservedCash,
                  { cents: false },
                )} on open orders`
              : `${money(summary.buyingPower, { cents: false })} buying power`
          }
        />
        <StatTile
          label="Realized P/L"
          value={signedMoney(summary.realizedPnl)}
          deltaValue={summary.realizedPnl}
          footnote={`booked on ${summary.closedTrades} ${summary.closedTrades === 1 ? 'sale' : 'sales'}`}
        />
        <StatTile
          label="Dividend income"
          value={money(summary.dividendIncome, { cents: false })}
          footnote="since funding"
        />
      </div>

      <div className="grid" style={{ marginBottom: 16 }}>
        <EquityCurveCard query={history} range={range} onRangeChange={setRange} />
      </div>

      <div className="grid grid--halves">
        <AllocationCard query={allocation} />
        <ActivityCard query={activity} />
      </div>

      <OpenOrdersCard query={open} onChanged={() => {
        open.refresh?.();
        portfolio.refresh?.();
      }} />

      <RealizedCard query={realized} />

      <HoldingsCard
        positions={positions}
        stale={portfolio.isRefreshing}
        asOf={asOf}
        onTrade={setTicket}
      />

      {ticket && (
        <TradeTicket
          symbol={ticket.symbol}
          side={ticket.side}
          onClose={() => setTicket(null)}
          onFilled={() => {
            // A fill moves the holding, the cash, the allocation and the curve.
            portfolio.refresh?.();
            allocation.refresh?.();
            history.refresh?.();
            activity.refresh?.();
            // A sale books a gain; a purchase does not. Refreshed either way rather
            // than branching on the side, because this is the only place the page
            // learns that anything happened at all.
            realized.refresh?.();
            // And a limit order may have rested rather than filled, which belongs in
            // the open orders card immediately rather than on the next poll.
            open.refresh?.();
          }}
        />
      )}
    </>
  );
}

function EquityCurveCard({ query, range, onRangeChange }) {
  const points = useMemo(
    () => (query.data?.points ?? []).map((point) => ({ label: point.date, value: point.value })),
    [query.data],
  );

  const summary = query.data?.summary;

  return (
    <ChartCard
      title="Account value"
      subtitle={
        summary
          ? `${money(summary.startValue, { cents: false })} → ${money(summary.endValue, { cents: false })} over ${range}`
          : 'Loading…'
      }
      actions={<RangePicker label="Account value range" value={range} options={RANGES} onChange={onRangeChange} />}
      table={
        <div className="tablewrap">
          <table className="table">
            <caption>Account value at each session close.</caption>
            <thead>
              <tr>
                <th scope="col">Date</th>
                <th scope="col">Account value</th>
                <th scope="col">Invested</th>
              </tr>
            </thead>
            <tbody>
              {(query.data?.points ?? [])
                .slice()
                .reverse()
                .map((point) => (
                  <tr key={point.date}>
                    <td>{mediumDate(point.date)}</td>
                    <td>{money(point.value)}</td>
                    <td>{money(point.invested)}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      }
    >
      {query.isLoading ? (
        <LoadingState height={280} label="Loading account history" />
      ) : query.error ? (
        <ErrorState error={query.error} onRetry={query.refresh} />
      ) : (
        <>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 4 }}>
            <span style={{ fontSize: 20, fontWeight: 600 }}>{money(summary.endValue, { cents: false })}</span>
            <Delta value={summary.change}>
              {signedMoney(summary.change)} ({signedPercent(summary.changePercent)})
            </Delta>
          </div>
          <LineChart
            points={points}
            height={264}
            stale={query.isRefreshing}
            valueFormat={(value) => money(value, { cents: false })}
            tickFormat={compactMoney}
            labelFormat={shortDate}
            ariaLabel={`Account value over the last ${range}, ${money(summary.startValue)} to ${money(summary.endValue)}`}
          />
        </>
      )}
    </ChartCard>
  );
}

function AllocationCard({ query }) {
  const sectors = query.data?.sectors ?? [];
  const items = sectors.map((sector) => ({
    key: sector.sector,
    label: sector.sector,
    value: sector.weightPercent,
  }));

  return (
    <ChartCard
      title="Allocation by sector"
      subtitle="Share of holdings value"
      table={
        <div className="tablewrap">
          <table className="table">
            <caption>Holdings value by sector.</caption>
            <thead>
              <tr>
                <th scope="col">Sector</th>
                <th scope="col">Weight</th>
                <th scope="col">Value</th>
                <th scope="col">Holdings</th>
              </tr>
            </thead>
            <tbody>
              {sectors.map((sector) => (
                <tr key={sector.sector}>
                  <td>{sector.sector}</td>
                  <td>{percent(sector.weightPercent, { digits: 1 })}</td>
                  <td>{money(sector.marketValue, { cents: false })}</td>
                  <td>{sector.symbols.join(', ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      }
    >
      {query.isLoading ? (
        <LoadingState height={240} label="Loading allocation" />
      ) : query.error ? (
        <ErrorState error={query.error} onRetry={query.refresh} />
      ) : (
        <>
          <BarList
            items={items}
            stale={query.isRefreshing}
            valueFormat={(value) => percent(value, { digits: 1 })}
          />
          <p className="card__subtitle" style={{ marginTop: 14 }}>
            Cash is a further {percent(query.data.cash.weightPercent, { digits: 1 })} of the account,
            held outside these weights.
          </p>
        </>
      )}
    </ChartCard>
  );
}

const ACTIVITY_LABEL = { DEPOSIT: 'Deposit', BUY: 'Buy', SELL: 'Sell', DIVIDEND: 'Dividend' };

/** The ledger the equity curve is built from — same lots, same dividends. */
function ActivityCard({ query }) {
  const entries = query.data?.transactions ?? [];

  return (
    <section className="card" aria-labelledby="activity-title">
      <header className="card__head">
        <div className="card__titles">
          <h2 className="card__title" id="activity-title">
            Recent activity
          </h2>
          <p className="card__subtitle">
            {query.data ? `Latest ${entries.length} of ${query.data.total} entries` : 'Loading…'}
          </p>
        </div>
      </header>
      <div className="card__body" style={{ padding: '4px 0 0' }}>
        {query.isLoading ? (
          <LoadingState height={200} label="Loading activity" />
        ) : query.error ? (
          <ErrorState error={query.error} onRetry={query.refresh} />
        ) : (
          <div className="tablewrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Date</th>
                  <th scope="col" className="cell--left">
                    Activity
                  </th>
                  <th scope="col">Amount</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry) => (
                  <tr key={entry.id}>
                    <td>{shortDate(entry.date)}</td>
                    <td className="cell--left">
                      <span className="symbol">
                        <span className="symbol__ticker">
                          {ACTIVITY_LABEL[entry.type] ?? entry.type}
                          {entry.symbol ? ` · ${entry.symbol}` : ''}
                        </span>
                        <span className="symbol__name">{entry.description}</span>
                      </span>
                    </td>
                    <td>{signedMoney(entry.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}

/**
 * Orders that have been accepted and have not happened.
 *
 * The card exists at all because a resting order is invisible everywhere else: it is
 * not a holding, not a trade, and not in the ledger — but it is holding capacity, and
 * it will act on its own. Somewhere has to say so, and offer the way out.
 *
 * Cancelling is optimistic about nothing. The button disables while the request is in
 * flight, and a 409 — the order filled first, on a market tick, between the render and
 * the click — is reported as what it is rather than retried.
 */
function OpenOrdersCard({ query, onChanged }) {
  const orders = query.data?.orders ?? [];
  const [cancelling, setCancelling] = useState(null);
  const [error, setError] = useState(null);

  // Nothing waiting is the normal state, and an empty card every time would be a
  // permanent reminder of a feature nobody is using.
  if (!query.isLoading && orders.length === 0 && !error) return null;

  const cancel = async (id) => {
    setCancelling(id);
    setError(null);
    try {
      await api.cancelOrder(id);
    } catch (caught) {
      setError(
        caught.code === 'order_not_open'
          ? 'That order was filled before it could be cancelled.'
          : (caught.message ?? 'The order could not be cancelled.'),
      );
    } finally {
      setCancelling(null);
      onChanged?.();
    }
  };

  return (
    <section className="card" aria-labelledby="open-orders-title" style={{ marginBottom: 16 }}>
      <header className="card__head">
        <div className="card__titles">
          <h2 className="card__title" id="open-orders-title">
            Open orders
          </h2>
          <p className="card__subtitle">
            {query.data
              ? `${orders.length} waiting — each fills on its own when the market reaches its price`
              : 'Loading…'}
          </p>
        </div>
      </header>

      <div className="card__body" style={{ padding: '4px 0 0' }}>
        {error && (
          <div className="notice notice--error" role="alert">
            <span className="notice__glyph" aria-hidden="true">
              !
            </span>
            <span>{error}</span>
          </div>
        )}

        {query.isLoading ? (
          <LoadingState height={160} label="Loading open orders" />
        ) : query.error ? (
          <ErrorState error={query.error} onRetry={query.refresh} />
        ) : (
          <div className={`tablewrap${query.isRefreshing ? ' chart--stale' : ''}`}>
            <table className="table">
              <caption>Orders accepted but not yet filled.</caption>
              <thead>
                <tr>
                  <th scope="col" className="cell--left">
                    Symbol
                  </th>
                  <th scope="col">Side</th>
                  <th scope="col">Shares</th>
                  <th scope="col">Limit</th>
                  <th scope="col">Held aside</th>
                  <th scope="col">Placed</th>
                  <th scope="col">
                    <span className="visually-hidden">Cancel</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {orders.map((entry) => (
                  <tr key={entry.id}>
                    <td className="cell--left">
                      <span className="symbol">
                        <Link to={`/markets/${entry.symbol}`} className="symbol__ticker">
                          {entry.symbol}
                        </Link>
                        <span className="symbol__name">{entry.name}</span>
                      </span>
                    </td>
                    <td>{entry.side === 'BUY' ? 'Buy' : 'Sell'}</td>
                    <td>{shares(entry.quantity)}</td>
                    <td>{money(entry.limitPrice)}</td>
                    {/* Cash for a buy, shares for a sell — the same units the
                        reservation is actually taken in. */}
                    <td>
                      {entry.side === 'BUY'
                        ? money(entry.quantity * entry.limitPrice)
                        : `${shares(entry.quantity)} shares`}
                    </td>
                    <td>{clockTime(entry.placedAt)}</td>
                    <td>
                      <span className="rowactions">
                        <button
                          type="button"
                          className="rowaction"
                          disabled={cancelling === entry.id}
                          onClick={() => cancel(entry.id)}
                        >
                          {cancelling === entry.id ? 'Cancelling…' : 'Cancel'}
                        </button>
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}

/**
 * A holding period, at the resolution the number deserves.
 *
 * Days up to a year, then years — an average of "412 days" is arithmetic, and "1.1y" is
 * the fact. Zero is "same day" rather than "0d", which reads as missing data.
 */
const heldFor = (days) => {
  if (days === null || days === undefined) return '—';
  if (days < 1) return 'same day';
  if (days < 365) return `${Math.round(days)}d`;
  return `${(days / 365).toFixed(1)}y`;
};

/**
 * Realized P/L: what the account has booked, and on what.
 *
 * The number in the tile above comes from `trades` and is complete for all time. This
 * table comes from the lot closures, which only exist for sales made since the record
 * began — so when the two disagree, the difference is stated here in words rather than
 * left for someone to find by adding the column up. A breakdown quietly short of the
 * total it sits under is the one thing this card must not be.
 */
function RealizedCard({ query }) {
  const summary = query.data?.summary;
  const rows = query.data?.bySymbol ?? [];
  const unattributed = summary?.unattributedPnl ?? 0;

  return (
    <section className="card" aria-labelledby="realized-title" style={{ marginBottom: 16 }}>
      <header className="card__head">
        <div className="card__titles">
          <h2 className="card__title" id="realized-title">
            Realized P/L
          </h2>
          <p className="card__subtitle">
            {summary
              ? `Booked on shares already sold — ${summary.sales} ${
                  summary.sales === 1 ? 'sale' : 'sales'
                }, ${summary.closures} ${summary.closures === 1 ? 'lot' : 'lots'} closed`
              : 'Loading…'}
          </p>
        </div>
      </header>

      <div className="card__body" style={{ padding: '4px 0 0' }}>
        {query.isLoading ? (
          <LoadingState height={200} label="Loading realized P/L" />
        ) : query.error ? (
          <ErrorState error={query.error} onRetry={query.refresh} />
        ) : summary.sales === 0 ? (
          <p className="card__subtitle" style={{ padding: '8px 0 16px' }}>
            Nothing closed yet. Selling shares books a gain or a loss, and it appears here
            broken down by what was sold.
          </p>
        ) : (
          <>
            <dl className="deflist" style={{ marginBottom: 16 }}>
              {/* A side with no lots on it shows a dash, not a signed zero. "Nothing was
                  held that long" and "the long-held lots came out even" are different
                  facts, and a green +$0.00 states the second one. */}
              <div>
                <dt>Short term</dt>
                <dd>
                  {summary.shortTerm.closures === 0 ? (
                    '—'
                  ) : (
                    <Delta value={summary.shortTerm.realizedPnl}>
                      {signedMoney(summary.shortTerm.realizedPnl)}
                    </Delta>
                  )}
                </dd>
              </div>
              <div>
                <dt>Long term</dt>
                <dd>
                  {summary.longTerm.closures === 0 ? (
                    '—'
                  ) : (
                    <Delta value={summary.longTerm.realizedPnl}>
                      {signedMoney(summary.longTerm.realizedPnl)}
                    </Delta>
                  )}
                </dd>
              </div>
              <div>
                <dt>Win rate</dt>
                {/* Over the lots that had an outcome. A flat close is neither, and the
                    count beside it is what stops the percentage reading as the whole
                    story. */}
                <dd>
                  {percent(summary.winRatePercent, { digits: 0 })}{' '}
                  <span className="tag">
                    {summary.winners}W / {summary.losers}L
                    {summary.flat > 0 ? ` / ${summary.flat} flat` : ''}
                  </span>
                </dd>
              </div>
              <div>
                <dt>Average held</dt>
                <dd>{heldFor(summary.averageHoldingDays)}</dd>
              </div>
            </dl>

            {unattributed !== 0 && (
              <p className="notice">
                <span className="notice__glyph" aria-hidden="true">
                  ⓘ
                </span>
                <span>
                  {signedMoney(unattributed)} across {summary.unattributedSales}{' '}
                  {summary.unattributedSales === 1 ? 'sale' : 'sales'} is counted in the total
                  above but not broken down below — those sales were made before this account
                  began recording which lots each one closed.
                </span>
              </p>
            )}

            {rows.length > 0 && (
              <div className={`tablewrap${query.isRefreshing ? ' chart--stale' : ''}`}>
                <table className="table">
                  <caption>Realized gains and losses by symbol, best first.</caption>
                  <thead>
                    <tr>
                      <th scope="col" className="cell--left">
                        Symbol
                      </th>
                      <th scope="col">Shares sold</th>
                      <th scope="col">Cost</th>
                      <th scope="col">Realized</th>
                      <th scope="col">Return</th>
                      <th scope="col">W/L</th>
                      <th scope="col">Avg held</th>
                      <th scope="col">Short term</th>
                      <th scope="col">Long term</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => (
                      <tr key={row.symbol}>
                        <td className="cell--left">
                          <span className="symbol">
                            <Link to={`/markets/${row.symbol}`} className="symbol__ticker">
                              {row.symbol}
                            </Link>
                            <span className="symbol__name">{row.name}</span>
                          </span>
                        </td>
                        <td>{shares(row.shares)}</td>
                        <td>{money(row.costOfSold)}</td>
                        <td>
                          <Delta value={row.realizedPnl}>{signedMoney(row.realizedPnl)}</Delta>
                        </td>
                        <td>
                          <Delta value={row.returnPercent}>{signedPercent(row.returnPercent)}</Delta>
                        </td>
                        <td>
                          {row.winners}/{row.losers}
                        </td>
                        <td>{heldFor(row.averageHoldingDays)}</td>
                        {/* A dash, not a zero, for a side with nothing on it: zero booked
                            long-term and no long-term lots at all are different facts. */}
                        <td>
                          {row.longTerm.closures === row.closures
                            ? '—'
                            : signedMoney(row.shortTerm.realizedPnl)}
                        </td>
                        <td>
                          {row.longTerm.closures === 0 ? '—' : signedMoney(row.longTerm.realizedPnl)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}

const HOLDING_COLUMNS = [
  { key: 'symbol', label: 'Symbol', align: 'left' },
  { key: 'quantity', label: 'Shares' },
  { key: 'averageCost', label: 'Avg cost' },
  { key: 'price', label: 'Last' },
  { key: 'dayChangePercent', label: 'Day' },
  { key: 'marketValue', label: 'Market value' },
  { key: 'unrealizedPnl', label: 'Unrealized P/L' },
  { key: 'weightPercent', label: 'Weight' },
];

function HoldingsCard({ positions, stale, asOf, onTrade }) {
  const [sort, setSort] = useState({ key: 'marketValue', order: 'desc' });

  const rows = useMemo(() => {
    const sorted = [...positions].sort((a, b) => {
      const left = a[sort.key];
      const right = b[sort.key];
      const comparison = typeof left === 'string' ? left.localeCompare(right) : left - right;
      return sort.order === 'asc' ? comparison : -comparison;
    });
    return sorted;
  }, [positions, sort]);

  const toggle = (key) =>
    setSort((current) =>
      current.key === key
        ? { key, order: current.order === 'asc' ? 'desc' : 'asc' }
        : { key, order: key === 'symbol' ? 'asc' : 'desc' },
    );

  return (
    <section className="card" aria-labelledby="holdings-title">
      <header className="card__head">
        <div className="card__titles">
          <h2 className="card__title" id="holdings-title">
            Holdings
          </h2>
          <p className="card__subtitle">
            {positions.length} positions, marked to the simulated market at {clockTime(asOf)}
          </p>
        </div>
      </header>

      <div className={`tablewrap${stale ? ' chart--stale' : ''}`} style={{ marginTop: 12 }}>
        <table className="table">
          <thead>
            <tr>
              {HOLDING_COLUMNS.map((column) => (
                <th
                  key={column.key}
                  scope="col"
                  aria-sort={sort.key === column.key ? (sort.order === 'asc' ? 'ascending' : 'descending') : 'none'}
                >
                  <button type="button" className="table__sort" onClick={() => toggle(column.key)}>
                    {column.label}
                    {sort.key === column.key && (
                      <span className="table__sort-caret" aria-hidden="true">
                        {sort.order === 'asc' ? '▲' : '▼'}
                      </span>
                    )}
                  </button>
                </th>
              ))}
              <th scope="col">
                <span className="visually-hidden">Trade</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((position) => (
              <tr key={position.symbol}>
                <td>
                  <span className="symbol">
                    <Link to={`/markets/${position.symbol}`} className="symbol__ticker">
                      {position.symbol}
                    </Link>
                    <span className="symbol__name">{position.name}</span>
                  </span>
                </td>
                <td>{shares(position.quantity)}</td>
                <td>{money(position.averageCost)}</td>
                <td>{money(position.price)}</td>
                <td>
                  <Delta value={position.dayChangePercent}>{signedPercent(position.dayChangePercent)}</Delta>
                </td>
                <td>{money(position.marketValue)}</td>
                <td>
                  <Delta value={position.unrealizedPnl}>
                    {signedMoney(position.unrealizedPnl)} ({signedPercent(position.unrealizedPnlPercent)})
                  </Delta>
                </td>
                <td>{percent(position.weightPercent, { digits: 1 })}</td>
                <td>
                  <span className="rowactions">
                    <button
                      type="button"
                      className="rowaction"
                      onClick={() => onTrade({ symbol: position.symbol, side: 'BUY' })}
                    >
                      Buy
                    </button>
                    <button
                      type="button"
                      className="rowaction"
                      onClick={() => onTrade({ symbol: position.symbol, side: 'SELL' })}
                    >
                      Sell
                    </button>
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
