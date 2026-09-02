import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';

import { api } from '../api/client.js';
import { Delta } from '../components/Delta.jsx';
import { Pager } from '../components/Pager.jsx';
import { Sparkline } from '../components/Sparkline.jsx';
import { ErrorState, EmptyState, LoadingState, StaleNotice } from '../components/States.jsx';
import { TradeTicket } from '../components/TradeTicket.jsx';
import { useLiveQuery } from '../hooks/useLiveQuery.js';
import {
  clockTime,
  compactNumber,
  marketCap,
  money,
  signedMoney,
  signedPercent,
} from '../lib/format.js';

const REFRESH_MS = 4000;

// The API caps a page at 250 and defaults to 50. 50 is also about as many rows as
// are worth polling every four seconds with a sparkline each — the whole 503-name
// board would be a 350 KB response on repeat.
const PAGE_SIZE = 50;

const COLUMNS = [
  { key: 'symbol', label: 'Symbol', sortable: true },
  { key: 'price', label: 'Last', sortable: true },
  { key: 'changePercent', label: 'Day change', sortable: true },
  { key: null, label: 'Session', sortable: false },
  { key: null, label: 'Bid / ask', sortable: false },
  { key: 'volume', label: 'Volume', sortable: true },
  { key: 'marketCapB', label: 'Mkt cap', sortable: true },
  { key: 'sector', label: 'Sector', sortable: true },
];

export function MarketsPage() {
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [sector, setSector] = useState('');
  const [sort, setSort] = useState({ key: 'symbol', order: 'asc' });
  // { symbol, side } while a ticket is open over the table.
  const [ticket, setTicket] = useState(null);
  const [offset, setOffset] = useState(0);
  const [moverCount, setMoverCount] = useState(5);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search.trim()), 250);
    return () => clearTimeout(timer);
  }, [search]);

  // Any change to what is being listed puts you back on page one — staying on
  // page 7 of a filter that now returns 3 rows would just show an empty table.
  useEffect(() => setOffset(0), [debouncedSearch, sector, sort.key, sort.order]);

  const sectors = useLiveQuery((signal) => api.sectors(signal));
  // Only while a sector is selected. `enabled` rather than a conditional hook: the
  // query has to keep its place in the hook order whether or not it is running.
  const sectorDetail = useLiveQuery((signal) => api.sectorDetail(sector, 5, signal), {
    intervalMs: REFRESH_MS,
    deps: [sector],
    enabled: Boolean(sector),
  });
  // The other half of that pair: market-wide movers, for when nothing is filtered.
  const movers = useLiveQuery((signal) => api.movers(moverCount, signal), {
    intervalMs: REFRESH_MS,
    deps: [moverCount],
    enabled: !sector,
  });
  const market = useLiveQuery(
    (signal) =>
      api.instruments(
        { search: debouncedSearch, sector, sort: sort.key, order: sort.order, limit: PAGE_SIZE, offset },
        signal,
      ),
    { intervalMs: REFRESH_MS, deps: [debouncedSearch, sector, sort.key, sort.order, offset] },
  );

  const toggle = (key) =>
    setSort((current) =>
      current.key === key
        ? { key, order: current.order === 'asc' ? 'desc' : 'asc' }
        : { key, order: key === 'symbol' || key === 'sector' ? 'asc' : 'desc' },
    );

  const instruments = market.data?.instruments ?? [];
  const total = market.data?.total ?? 0;

  return (
    <>
      <div className="pagehead">
        <div className="pagehead__titles">
          <h1>Markets</h1>
          <p>
            Simulated quotes for the S&amp;P 500 constituents, across{' '}
            {sectors.data?.performance?.length ?? 11} GICS sectors.
          </p>
        </div>
        {market.data && <span className="pill">Quotes as of {clockTime(market.data.asOf)}</span>}
      </div>

      {/* One filter row above everything it scopes — never per-card filters. */}
      <div className="filterbar">
        <div className="field">
          <label htmlFor="market-search">Search</label>
          <input
            id="market-search"
            className="input input--search"
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Symbol or company name"
          />
        </div>
        <div className="field">
          <label htmlFor="market-sector">Sector</label>
          <select
            id="market-sector"
            className="select"
            value={sector}
            onChange={(event) => setSector(event.target.value)}
          >
            <option value="">All sectors</option>
            {(sectors.data?.sectors ?? []).map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </div>
        {(search || sector) && (
          <button
            type="button"
            className="button button--ghost"
            onClick={() => {
              setSearch('');
              setSector('');
            }}
          >
            Clear
          </button>
        )}
        <span className="filterbar__count">
          {/* The error first. Branching on `data` alone put "Loading…" next to an
              error card — a page describing itself as still working after it had
              given up. */}
          {market.error
            ? 'Unavailable'
            : market.data
              ? `${total} instrument${total === 1 ? '' : 's'}${search || sector ? ' matching' : ' available'}`
              : 'Loading…'}
        </span>
      </div>

      {market.refreshError && (
        <StaleNotice
          error={market.refreshError}
          since={market.updatedAt ? clockTime(market.updatedAt) : null}
          onRetry={market.refresh}
        />
      )}

      <SectorStrip performance={sectors.data?.performance} activeSector={sector} onSelect={setSector} />

      {/* One or the other, never both, and deliberately in the same slot. Movers are
          market-wide; showing them beside a table filtered to one sector invites the
          reader to compare two boards that are not about the same thing. When a
          sector is selected its own card carries leaders and laggards, which is the
          same question asked within that scope. */}
      {sector ? (
        <SectorDetailCard sector={sector} query={sectorDetail} />
      ) : (
        <MoversBoard query={movers} count={moverCount} onCountChange={setMoverCount} />
      )}

      <section className="card">
        {market.isLoading ? (
          <LoadingState height={420} label="Loading market data" />
        ) : market.error ? (
          <ErrorState error={market.error} onRetry={market.refresh} title="Could not load market data" />
        ) : instruments.length === 0 ? (
          <EmptyState title="No instruments match those filters" hint="Try clearing the search or sector." />
        ) : (
          <div className={`tablewrap${market.isRefreshing ? ' chart--stale' : ''}`}>
            <table className="table">
              <thead>
                <tr>
                  {COLUMNS.map((column) => (
                    <th
                      key={column.label}
                      scope="col"
                      aria-sort={
                        column.key && sort.key === column.key
                          ? sort.order === 'asc'
                            ? 'ascending'
                            : 'descending'
                          : 'none'
                      }
                    >
                      {column.sortable ? (
                        <button type="button" className="table__sort" onClick={() => toggle(column.key)}>
                          {column.label}
                          {sort.key === column.key && (
                            <span className="table__sort-caret" aria-hidden="true">
                              {sort.order === 'asc' ? '▲' : '▼'}
                            </span>
                          )}
                        </button>
                      ) : (
                        column.label
                      )}
                    </th>
                  ))}
                  <th scope="col">
                    <span className="visually-hidden">Trade</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {instruments.map((quote) => (
                  <tr key={quote.symbol}>
                    <td>
                      <span className="symbol">
                        <Link to={`/markets/${quote.symbol}`} className="symbol__ticker">
                          {quote.symbol}
                        </Link>
                        <span className="symbol__name">{quote.name}</span>
                      </span>
                    </td>
                    <td>{money(quote.price)}</td>
                    <td>
                      <Delta value={quote.change}>
                        {signedMoney(quote.change)} ({signedPercent(quote.changePercent)})
                      </Delta>
                    </td>
                    <td>
                      <Sparkline
                        values={quote.sparkline}
                        changePercent={quote.changePercent}
                        ariaLabel={`${quote.symbol} intraday trend, ${signedPercent(quote.changePercent)} on the session`}
                      />
                    </td>
                    <td>
                      {money(quote.bid)} / {money(quote.ask)}
                    </td>
                    <td>{compactNumber(quote.volume)}</td>
                    <td>{marketCap(quote.marketCapB)}</td>
                    <td>
                      <span className="tag">{quote.sector}</span>
                    </td>
                    <td>
                      <button
                        type="button"
                        className="rowaction"
                        onClick={() => setTicket({ symbol: quote.symbol, side: 'BUY' })}
                      >
                        Buy
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {instruments.length > 0 && (
          <Pager
            offset={offset}
            count={instruments.length}
            total={total}
            pageSize={PAGE_SIZE}
            onChange={setOffset}
            label="Instrument pages"
          />
        )}
      </section>

      {ticket && (
        <TradeTicket
          symbol={ticket.symbol}
          side={ticket.side}
          onClose={() => setTicket(null)}
          onFilled={() => market.refresh?.()}
        />
      )}
    </>
  );
}

/**
 * Sector performance as a row of figures rather than a chart: the story is one
 * number per sector, and eight hues would say less than the numbers do. Doubles as
 * a filter — clicking a sector scopes the table.
 */
/**
 * One sector, in the detail the strip above cannot carry.
 *
 * The strip shows an average per sector, which is enough to rank them and not enough
 * to say anything about one. This card exists for the pair of numbers at the top of
 * it: the same day measured by headcount and measured by money. They agree most of
 * the time and the times they disagree are the interesting ones — a sector where two
 * thirds of the names rose and the largest fell is green by one measure and red by
 * the other, and a single average silently picks a side.
 *
 * Which is why the two are labelled rather than presented as figures to be read off.
 * "Cap-weighted −0.52%" tells a reader nothing they can act on unless they already
 * know what it is being contrasted with.
 */
function SectorDetailCard({ sector, query }) {
  const detail = query.data;
  // Keyed off the requested sector rather than the returned one: the query is still
  // holding the previous sector's answer for the moment after a click, and showing
  // Energy's breadth under a heading that says Utilities is worse than showing
  // nothing.
  const stale = detail?.sector !== sector;

  return (
    <section className="card" aria-labelledby="sector-detail-title" style={{ marginBottom: 16 }}>
      <header className="card__head">
        <div className="card__titles">
          <h2 className="card__title" id="sector-detail-title">
            {sector}
          </h2>
          {/* Branching on the error as well as the data. Checking only `data` puts
              "Loading…" in the header beside the error card in the body, which reads
              as a page still working when it has already given up. */}
          <p className="card__subtitle">
            {query.error
              ? 'Unavailable'
              : detail && !stale
                ? `${detail.instruments} instruments · the same day measured two ways`
                : 'Loading…'}
          </p>
        </div>
      </header>

      <div className="card__body" style={{ padding: '4px 0 0' }}>
        {query.error ? (
          <ErrorState error={query.error} onRetry={query.refresh} title={`Could not load ${sector}`} />
        ) : !detail || stale ? (
          <LoadingState height={160} label={`Loading ${sector}`} />
        ) : (
          <>
            <dl className="deflist" style={{ marginBottom: 16 }}>
              <div>
                <dt>By headcount</dt>
                <dd>
                  <Delta value={detail.equalWeightedChangePercent}>
                    {signedPercent(detail.equalWeightedChangePercent)}
                  </Delta>
                </dd>
              </div>
              <div>
                <dt>By size</dt>
                <dd>
                  <Delta value={detail.capWeightedChangePercent}>
                    {signedPercent(detail.capWeightedChangePercent)}
                  </Delta>
                </dd>
              </div>
              <div>
                <dt>Breadth</dt>
                {/* Counts, not a ratio. "36 up / 38 down" survives being read aloud;
                    "48.6% advancing" needs the denominator to mean anything. */}
                <dd>
                  {detail.breadth.advancing} up / {detail.breadth.declining} down
                  {detail.breadth.unchanged > 0 ? ` / ${detail.breadth.unchanged} flat` : ''}
                </dd>
              </div>
              <div>
                <dt>Market cap</dt>
                <dd>{marketCap(detail.marketCapB)}</dd>
              </div>
            </dl>

            <div className="grid grid--halves">
              <QuoteList title="Leaders" quotes={detail.leaders} />
              <QuoteList title="Laggards" quotes={detail.laggards} />
            </div>
          </>
        )}
      </div>
    </section>
  );
}

/**
 * What is moving across the whole board.
 *
 * Three lists rather than one ranked table: they answer three different questions,
 * and a single table sorted by any one of them buries the other two. The API returns
 * them in one call for the same reason — see `getMovers`.
 */
function MoversBoard({ query, count, onCountChange }) {
  const data = query.data;

  return (
    <section className="card" aria-labelledby="movers-title" style={{ marginBottom: 16 }}>
      <header className="card__head">
        <div className="card__titles">
          <h2 className="card__title" id="movers-title">
            Today&apos;s movers
          </h2>
          <p className="card__subtitle">
            {query.error
              ? 'Unavailable'
              : data
                ? `Across all instruments, as of ${clockTime(data.asOf)}`
                : 'Loading…'}
          </p>
        </div>
        <div className="segmented" role="group" aria-label="How many movers to show">
          {[5, 10].map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={count === option}
              onClick={() => onCountChange(option)}
            >
              Top {option}
            </button>
          ))}
        </div>
      </header>

      <div className="card__body" style={{ padding: '4px 0 0' }}>
        {query.error ? (
          <ErrorState error={query.error} onRetry={query.refresh} title="Could not load movers" />
        ) : !data ? (
          <LoadingState height={200} label="Loading movers" />
        ) : (
          <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))' }}>
            <QuoteList title="Gainers" quotes={data.gainers} />
            <QuoteList title="Losers" quotes={data.losers} />
            <QuoteList title="Most active" quotes={data.mostActive} metric={volumeMetric} />
          </div>
        )}
      </div>
    </section>
  );
}

const changeMetric = (quote) => (
  <Delta value={quote.changePercent}>{signedPercent(quote.changePercent)}</Delta>
);

// Volume, not the change. A most-active list is ranked on volume, and a column
// showing something the ranking ignores invites the reader to wonder why the rows
// are in that order.
const volumeMetric = (quote) => compactNumber(quote.volume);

/**
 * A short list of quotes, in the order the API returned them.
 *
 * Shared by the sector card's two ends and the movers board's three, which are the
 * same object rendered under different headings — and the ordering is the API's in
 * every case, because each of those lists is sorted by something different and
 * re-sorting here would quietly discard it.
 *
 * `metric` is the right-hand column. It defaults to the day's change because that is
 * what four of the five lists are about; the most-active board passes volume, which
 * is the one thing that list is ranked on and the one thing a change column would
 * not show.
 */
function QuoteList({ title, quotes, metric = changeMetric }) {
  return (
    <div>
      <p className="card__subtitle" style={{ marginBottom: 8 }}>
        {title}
      </p>
      {/* A sector with instruments always has a best and a worst, so this is
          unreachable through the API — but a bare heading with nothing under it is a
          worse way to find that out than a sentence. */}
      {quotes.length === 0 && <p className="ticket__muted">Nothing to show.</p>}
      <div className="tickerlist" style={{ maxWidth: 'none' }}>
        {quotes.map((quote) => (
          <div className="tickerlist__row" key={quote.symbol}>
            <Link to={`/markets/${quote.symbol}`} className="tickerlist__symbol">
              {quote.symbol}
            </Link>
            <span className="tickerlist__name">{quote.name}</span>
            <span className="tickerlist__price">{money(quote.price)}</span>
            <span className="tickerlist__delta">{metric(quote)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function SectorStrip({ performance, activeSector, onSelect }) {
  const rows = useMemo(() => performance ?? [], [performance]);
  if (rows.length === 0) return null;

  return (
    <div className="grid grid--tiles" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))' }}>
      {rows.map((row) => (
        <button
          key={row.sector}
          type="button"
          className="tile"
          style={{
            textAlign: 'left',
            borderColor: activeSector === row.sector ? 'var(--accent)' : 'var(--border)',
          }}
          onClick={() => onSelect(activeSector === row.sector ? '' : row.sector)}
          aria-pressed={activeSector === row.sector}
        >
          <div className="tile__label">{row.sector}</div>
          <div style={{ marginTop: 6 }}>
            <Delta value={row.averageChangePercent}>{signedPercent(row.averageChangePercent)}</Delta>
          </div>
          <div className="tile__foot">{row.instruments} instruments</div>
        </button>
      ))}
    </div>
  );
}
