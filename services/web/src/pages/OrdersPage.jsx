import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import { api } from '../api/client.js';
import { Pager } from '../components/Pager.jsx';
import { ErrorState, EmptyState, LoadingState } from '../components/States.jsx';
import { useLiveQuery } from '../hooks/useLiveQuery.js';
import { clockTime, money, shares } from '../lib/format.js';

/**
 * Orders: what the account asked for, including what it was refused.
 *
 * The portfolio already answers "what happened to my money" — deposits, fills,
 * dividends — from the ledger. This answers a question the ledger cannot, because
 * the ledger only records the orders that became something. An account that tried
 * four times this morning to sell shares it did not have is indistinguishable from
 * a quiet one in Recent activity, and that is exactly the morning somebody wants to
 * see. Rejections are the reason this page exists; fills are the context that makes
 * them readable.
 */

const PAGE_SIZE = 25;
const REFRESH_MS = 5000;

// The API's own vocabulary, in the order a reader is likely to want it rather than
// alphabetically: the two live states first, then the two terminal ones.
const STATUS_FILTERS = [
  { value: '', label: 'All orders' },
  { value: 'OPEN', label: 'Waiting' },
  { value: 'FILLED', label: 'Filled' },
  { value: 'REJECTED', label: 'Rejected' },
  { value: 'CANCELLED', label: 'Cancelled' },
];

export function OrdersPage() {
  const [status, setStatus] = useState('');
  const [symbol, setSymbol] = useState('');
  const [debouncedSymbol, setDebouncedSymbol] = useState('');
  const [offset, setOffset] = useState(0);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSymbol(symbol.trim().toUpperCase()), 250);
    return () => clearTimeout(timer);
  }, [symbol]);

  // Narrowing the list puts you back on page one, for the same reason the screener
  // does it: staying on page 7 of a filter that now returns 3 rows shows an empty
  // table and no explanation.
  useEffect(() => setOffset(0), [status, debouncedSymbol]);

  /**
   * Polled on the first page only.
   *
   * Orders resolve without anyone touching this screen — a resting limit fills on a
   * market tick, and the demo's own load generator is placing orders the whole time
   * — so the newest page has to keep up or it is lying. Every other page is a fixed
   * window somebody navigated to deliberately, and a new order arriving at the top
   * shifts every row in that window down by one. Rows sliding out from under a
   * reader mid-sentence is worse than a page that is a few seconds stale, so paging
   * away stops the clock; coming back to page one starts it again.
   */
  const orders = useLiveQuery(
    (signal) =>
      api.orders(
        { status: status || undefined, symbol: debouncedSymbol || undefined, limit: PAGE_SIZE, offset },
        signal,
      ),
    {
      intervalMs: offset === 0 ? REFRESH_MS : 0,
      deps: [status, debouncedSymbol, offset],
    },
  );

  const rows = orders.data?.orders ?? [];
  const total = orders.data?.total ?? 0;
  const filtered = Boolean(status || debouncedSymbol);

  return (
    <>
      <div className="pagehead">
        <div className="pagehead__titles">
          <h1>Orders</h1>
          <p>
            Every order this account has placed, including the ones that were refused and the
            reason each was — which is the part your activity feed cannot show you.
          </p>
        </div>
        {/* Says out loud what the polling rule below does, because a list that
            silently stops updating when you page back is a list that will be trusted
            on the wrong page. */}
        <span className="pill">{offset === 0 ? 'Updating live' : 'Paused while you page back'}</span>
      </div>

      {/* One filter row above everything it scopes, matching the screener. */}
      <div className="filterbar">
        <div className="field">
          <label htmlFor="orders-status">Outcome</label>
          <select
            id="orders-status"
            className="select"
            value={status}
            onChange={(event) => setStatus(event.target.value)}
          >
            {STATUS_FILTERS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="orders-symbol">Symbol</label>
          <input
            id="orders-symbol"
            className="input input--search"
            type="search"
            value={symbol}
            onChange={(event) => setSymbol(event.target.value)}
            placeholder="e.g. AAPL"
          />
        </div>
        {filtered && (
          <button
            type="button"
            className="button button--ghost"
            onClick={() => {
              setStatus('');
              setSymbol('');
            }}
          >
            Clear
          </button>
        )}
        {/* `total` counts the rows matching these filters, not the account's orders
            overall — the API is deliberate about that — so this is a count of what is
            being looked at and can be read as one.

            Silent when the request failed, rather than "Loading…". The card below is
            already saying the list could not be fetched, and a spinner-ish word beside
            it claims something is still on its way when nothing is. */}
        {!orders.error && (
          <span className="filterbar__count">
            {orders.data
              ? `${total} order${total === 1 ? '' : 's'}${filtered ? ' matching' : ''}`
              : 'Loading…'}
          </span>
        )}
      </div>

      <section className="card" aria-labelledby="orders-title">
        <header className="card__head">
          <div className="card__titles">
            <h2 className="card__title" id="orders-title">
              Order log
            </h2>
            <p className="card__subtitle">
              Newest first. Waiting orders are cancelled from{' '}
              <Link to="/portfolio">your portfolio</Link>, where the cash or shares they are
              holding aside are shown next to them.
            </p>
          </div>
        </header>

        <div className="card__body" style={{ padding: '4px 0 0' }}>
          {orders.isLoading ? (
            <LoadingState height={360} label="Loading your orders" />
          ) : orders.error ? (
            <ErrorState error={orders.error} onRetry={orders.refresh} title="Could not load your orders" />
          ) : rows.length === 0 ? (
            <EmptyState
              title={filtered ? 'No orders match those filters' : 'No orders yet'}
              hint={
                filtered
                  ? // Deliberately not "no such symbol": the API filters on the symbol
                    // without checking it exists, so an empty result here means this
                    // account has no orders for it — not that it is untradable.
                    'This account has not placed an order matching that outcome and symbol.'
                  : 'Buying or selling anything records an order here, whether or not it goes through.'
              }
            />
          ) : (
            <div className={`tablewrap${orders.isRefreshing ? ' chart--stale' : ''}`}>
              <table className="table">
                <caption>Orders placed on this account, newest first.</caption>
                <thead>
                  <tr>
                    <th scope="col">Placed</th>
                    <th scope="col" className="cell--left">
                      Symbol
                    </th>
                    <th scope="col">Side</th>
                    <th scope="col">Type</th>
                    <th scope="col">Shares</th>
                    <th scope="col">Limit</th>
                    <th scope="col" className="cell--left">
                      Outcome
                    </th>
                    <th scope="col">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((order) => (
                    <OrderRow key={order.id} order={order} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {rows.length > 0 && (
          <Pager
            offset={offset}
            count={rows.length}
            total={total}
            pageSize={PAGE_SIZE}
            onChange={setOffset}
            label="Order pages"
          />
        )}
      </section>
    </>
  );
}

const dayLabel = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' });

/**
 * When an order was placed, at the resolution that distinguishes it from its
 * neighbours.
 *
 * A log where every row reads "Aug 31" carries no ordering information at all, and
 * these arrive in bursts seconds apart. Today's orders get a clock; older ones get a
 * date, because by then the minute has stopped meaning anything and the day is what
 * someone is looking for.
 *
 * Both halves are the reader's local day, which is why this does not reach for
 * `shortDate`. That formatter exists for the ledger's date-only strings and pins
 * itself to UTC so a bare `2026-08-31` cannot drift a day; handing it a *timestamp*
 * would put an order placed at half past seven on a Sunday evening in New York on
 * Monday, on the same row as a clock time that says 19:30.
 */
function Placed({ timestamp }) {
  const placed = new Date(timestamp);
  const isToday = placed.toDateString() === new Date().toDateString();
  return <>{isToday ? clockTime(timestamp) : dayLabel.format(placed)}</>;
}

/**
 * What became of one order, in words.
 *
 * A status code in a cell — REJECTED — tells a reader the outcome and withholds the
 * only part they can act on. The API records `rejectReason` as prose written for a
 * person, so it goes in the table rather than behind a tooltip or a details row:
 * scanning a morning's rejections for the one that is not "insufficient funds" is
 * the whole reason to come here, and it cannot be done one hover at a time.
 */
function Outcome({ order }) {
  if (order.status === 'REJECTED') {
    return (
      <span className="symbol">
        <span className="symbol__ticker">Rejected</span>
        {/* The API writes the refusal's own message into `rejectReason` for every
            rejection it records, so the fallback is a safety net rather than a path
            anyone should see. It says so in a sentence instead of falling back to
            `rejectCode`: `insufficient_shares` is the vocabulary of the error handler,
            and a customer reading their own order history should not have to. */}
        <span className="symbol__name">
          {order.rejectReason ?? 'This order was refused and no reason was recorded with it.'}
        </span>
      </span>
    );
  }

  if (order.status === 'OPEN') {
    return (
      <span className="symbol">
        <span className="symbol__ticker">Waiting</span>
        <span className="symbol__name">Fills on its own when the market reaches its price</span>
      </span>
    );
  }

  if (order.status === 'CANCELLED') {
    return (
      <span className="symbol">
        <span className="symbol__ticker">Cancelled</span>
        <span className="symbol__name">
          {order.resolvedAt ? `Withdrawn at ${clockTime(order.resolvedAt)}` : 'Withdrawn before it filled'}
        </span>
      </span>
    );
  }

  // A partial fill is not something this venue can produce today — an order fills
  // whole or not at all — but the quantity is reported per order rather than assumed,
  // so a future partial shows up as one instead of silently reading as complete.
  const partial = order.filledQuantity !== null && order.filledQuantity < order.quantity;
  const better = improvement(order);
  return (
    <span className="symbol">
      <span className="symbol__ticker">{partial ? 'Partly filled' : 'Filled'}</span>
      <span className="symbol__name">
        {partial ? `${shares(order.filledQuantity)} of ${shares(order.quantity)} at ` : 'at '}
        {money(order.fillPrice)}
        {/* Price improvement is the one thing worth saying about a limit fill: the
            difference between the price the customer authorised and the one they got.
            Only shown when there was some — a limit that filled exactly at its price
            improved on nothing, and "$0.00 better" reads as a broken feature. */}
        {better !== null && ` · ${money(better)} better than the limit`}
      </span>
    </span>
  );
}

/**
 * Per-share improvement on a limit fill, or null when there is nothing to say.
 *
 * Direction depends on the side: a buy improves by filling below its limit, a sell by
 * filling above. Subtracting one way for both would report every sell as a loss.
 */
function improvement(order) {
  if (order.type !== 'LIMIT' || order.fillPrice === null || order.limitPrice === null) return null;
  const better = order.side === 'BUY' ? order.limitPrice - order.fillPrice : order.fillPrice - order.limitPrice;
  return better > 0 ? better : null;
}

function OrderRow({ order }) {
  return (
    <tr>
      <td>
        <Placed timestamp={order.placedAt} />
      </td>
      <td className="cell--left">
        <span className="symbol">
          <Link to={`/markets/${order.symbol}`} className="symbol__ticker">
            {order.symbol}
          </Link>
          <span className="symbol__name">{order.name}</span>
        </span>
      </td>
      {/* Plain words, deliberately not the Delta component that colours every other
          signed thing on this site. Delta announces "up" or "down" to a screen reader
          before its contents, which turns this cell into "up Buy" — and a buy is not
          up. The open orders card on the portfolio spells the side out for the same
          reason, and the word is already the whole encoding. */}
      <td>{order.side === 'BUY' ? 'Buy' : 'Sell'}</td>
      <td>{order.type === 'LIMIT' ? 'Limit' : 'Market'}</td>
      <td>{shares(order.quantity)}</td>
      {/* A market order named no price, so this is a dash rather than the price it
          happened to get — which belongs in Amount and would read here as a limit
          that was set and met. */}
      <td>{order.limitPrice === null ? '—' : money(order.limitPrice)}</td>
      <td className="cell--left">
        <Outcome order={order} />
      </td>
      {/* Null, not zero, for an order that never traded: the API is careful to send
          null there, and formatting it as $0.00 would state that a rejected order
          moved no money — true, but indistinguishable from one that traded at zero. */}
      <td>{money(order.notional)}</td>
    </tr>
  );
}
