import { useEffect, useRef, useState } from 'react';

import { api } from '../api/client.js';
import { useLiveQuery } from '../hooks/useLiveQuery.js';
import { money, shares, signedMoney } from '../lib/format.js';
import { Delta } from './Delta.jsx';

/**
 * Order ticket, market or limit.
 *
 * A native <dialog>, so focus trapping, Escape-to-close, inertness of the page
 * behind, and the backdrop all come from the platform rather than from hand-rolled
 * key handlers that usually get one of those wrong.
 *
 * The quote keeps polling while the ticket is open: this fills at the live price,
 * so showing a price frozen from when the button was clicked would misstate what
 * the order costs. The estimate is labelled as an estimate for the same reason —
 * the tape moves between render and fill, and the receipt shows what was actually
 * paid.
 *
 * A limit order has two possible outcomes and the ticket shows both. If the market
 * is already at the price it fills straight away; otherwise it rests, and the
 * receipt says so rather than implying a trade happened.
 *
 * What the ticket checks against is what is *available*, not what the account holds.
 * Cash promised to open buy orders cannot be spent again and shares promised to open
 * sells cannot be sold again, so the balance on its own would offer the customer
 * money that is already committed.
 */

const ERRORS = {
  insufficient_cash: 'Not enough available cash for this order.',
  insufficient_shares: 'You do not have that many shares available.',
  unknown_symbol: 'That symbol is not tradable here.',
  invalid_quantity: 'Enter a whole number of shares.',
  invalid_limit_price: 'Enter a limit price with at most four decimal places.',
  limit_price_required: 'A limit order needs a price.',
  order_not_open: 'That order has already been filled or cancelled.',
  account_missing: 'Your session no longer has an account. Sign in again.',
  network_error: 'Could not reach the trading API. Nothing was submitted.',
};

/**
 * The same limit-price rule the API enforces, so the common mistake is caught before
 * a round trip. Refusing extra precision rather than rounding it is deliberate there
 * — rounding a buy limit up raises the price the customer authorised — so this has
 * to refuse it too, or the field would accept something the server will not.
 */
const parseLimitPrice = (raw) => {
  const trimmed = String(raw).trim();
  if (trimmed === '') return { empty: true };
  const value = Number(trimmed);
  const decimals = trimmed.includes('.') ? trimmed.split('.')[1].length : 0;
  if (!Number.isFinite(value) || value < 0.0001 || value > 1_000_000 || decimals > 4) {
    return { invalid: true };
  }
  return { value };
};

export function TradeTicket({ symbol, side: initialSide = 'BUY', onClose, onFilled }) {
  const dialogRef = useRef(null);
  const [side, setSide] = useState(initialSide);
  const [type, setType] = useState('MARKET');
  const [quantity, setQuantity] = useState('');
  const [limitPrice, setLimitPrice] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(null);
  const [receipt, setReceipt] = useState(null);

  // showModal() rather than the `open` attribute: only the modal form makes the
  // rest of the page inert and renders the ::backdrop.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  const quote = useLiveQuery((signal) => api.stock(symbol, signal), {
    intervalMs: 4000,
    deps: [symbol],
  });
  const portfolio = useLiveQuery((signal) => api.portfolio(signal), { intervalMs: 10_000 });
  // What this symbol already has waiting. The portfolio reports cash reservations
  // across the whole account, but shares are reserved per symbol and only the order
  // book knows by how much.
  const open = useLiveQuery((signal) => api.orders({ status: 'OPEN', symbol }, signal), {
    intervalMs: 10_000,
    deps: [symbol],
  });

  const price = quote.data?.price ?? null;
  // Available, not the balance: cash promised to an open buy order cannot be spent
  // twice, and offering it would be offering money that is already committed.
  const cash = portfolio.data?.summary?.availableCash ?? 0;
  const heldShares = portfolio.data?.positions?.find((p) => p.symbol === symbol)?.quantity ?? 0;
  const committedShares = (open.data?.orders ?? [])
    .filter((entry) => entry.side === 'SELL')
    .reduce((total, entry) => total + entry.quantity, 0);
  const held = Math.max(heldShares - committedShares, 0);

  const parsed = Number.parseInt(quantity, 10);
  const validQuantity = Number.isInteger(parsed) && parsed > 0;

  const limit = type === 'LIMIT' ? parseLimitPrice(limitPrice) : { value: null };
  const limitInvalid = type === 'LIMIT' && Boolean(limit.invalid);
  const limitMissing = type === 'LIMIT' && Boolean(limit.empty);

  // A limit order is estimated at its limit rather than at the market, because that
  // is the most it can cost — and it is the amount that will be reserved if it rests.
  // Estimating at the market would understate what the order ties up.
  const rate = type === 'LIMIT' ? limit.value : price;
  const estimate = validQuantity && rate ? parsed * rate : null;

  // The same rules the API enforces, checked here so the common mistakes are caught
  // before a round trip. The server remains the authority — it re-checks under a row
  // lock, which is the only place the answer can be relied on.
  const overCash = side === 'BUY' && estimate !== null && estimate > cash;
  const overShares = side === 'SELL' && validQuantity && parsed > held;
  const canSubmit =
    validQuantity &&
    price !== null &&
    !limitInvalid &&
    !limitMissing &&
    !overCash &&
    !overShares &&
    !pending;

  const maxAffordable = rate ? Math.floor(cash / rate) : 0;
  const maxForSide = side === 'BUY' ? maxAffordable : held;
  // Whether it would go off now, which is what decides between "Buy 5" and "Place order".
  const marketable =
    type === 'MARKET' ||
    (price !== null && limit.value != null && (side === 'BUY' ? price <= limit.value : price >= limit.value));

  const close = () => {
    dialogRef.current?.close();
    onClose();
  };

  const submit = async (event) => {
    event.preventDefault();
    if (!canSubmit) return;

    setPending(true);
    setError(null);
    try {
      const filled = await api.placeOrder({
        symbol,
        side,
        quantity: parsed,
        type,
        limitPrice: limit.value,
      });
      setReceipt(filled);
      // Let the page refresh its own data; the ticket stays open on the receipt so
      // the fill price is readable rather than flashing past.
      onFilled?.(filled);
    } catch (caught) {
      setError(ERRORS[caught.code] ?? caught.message ?? 'The order could not be placed.');
    } finally {
      setPending(false);
    }
  };

  return (
    <dialog ref={dialogRef} className="ticket" onCancel={close} onClose={onClose}>
      {receipt ? (
        <Receipt receipt={receipt} onClose={close} onAgain={() => setReceipt(null)} />
      ) : (
        <form className="ticket__form" onSubmit={submit}>
          <header className="ticket__head">
            <div>
              <h2 className="ticket__title">
                {side === 'BUY' ? 'Buy' : 'Sell'} {symbol}
              </h2>
              <p className="ticket__sub">{quote.data?.name ?? 'Loading…'}</p>
            </div>
            <button type="button" className="iconbutton" onClick={close} aria-label="Close">
              <span aria-hidden="true">✕</span>
            </button>
          </header>

          <div className="segmented ticket__sides" role="group" aria-label="Order side">
            {['BUY', 'SELL'].map((option) => (
              <button
                key={option}
                type="button"
                aria-pressed={side === option}
                onClick={() => {
                  setSide(option);
                  setError(null);
                }}
              >
                {option === 'BUY' ? 'Buy' : 'Sell'}
              </button>
            ))}
          </div>

          <div className="segmented ticket__sides" role="group" aria-label="Order type">
            {[
              ['MARKET', 'Market'],
              ['LIMIT', 'Limit'],
            ].map(([option, label]) => (
              <button
                key={option}
                type="button"
                aria-pressed={type === option}
                onClick={() => {
                  setType(option);
                  setError(null);
                }}
              >
                {label}
              </button>
            ))}
          </div>

          <dl className="ticket__facts">
            <div>
              <dt>Last price</dt>
              <dd>
                {price === null ? '—' : money(price)}{' '}
                {quote.data && (
                  <Delta value={quote.data.change} className="ticket__delta">
                    {signedMoney(quote.data.change)}
                  </Delta>
                )}
              </dd>
            </div>
            <div>
              <dt>{side === 'BUY' ? 'Cash available' : 'Shares available'}</dt>
              <dd>
                {side === 'BUY' ? money(cash) : shares(held)}
                {/* Only when there is something to explain. A parenthetical about
                    reservations on an account with none is noise. */}
                {side === 'BUY' && portfolio.data?.summary?.reservedCash > 0 && (
                  <span className="ticket__muted">
                    {' '}
                    ({money(portfolio.data.summary.reservedCash)} on open orders)
                  </span>
                )}
                {side === 'SELL' && committedShares > 0 && (
                  <span className="ticket__muted"> ({shares(committedShares)} on open orders)</span>
                )}
              </dd>
            </div>
          </dl>

          <label className="formfield">
            <span className="formfield__label">Quantity</span>
            <input
              className="input"
              inputMode="numeric"
              autoFocus
              value={quantity}
              onChange={(event) => {
                setQuantity(event.target.value.replace(/[^\d]/g, ''));
                setError(null);
              }}
              placeholder="Number of shares"
              aria-describedby="ticket-estimate"
            />
          </label>

          {type === 'LIMIT' && (
            <label className="formfield">
              <span className="formfield__label">
                Limit price {side === 'BUY' ? '(pay no more than)' : '(take no less than)'}
              </span>
              <input
                className="input"
                inputMode="decimal"
                value={limitPrice}
                onChange={(event) => {
                  setLimitPrice(event.target.value.replace(/[^\d.]/g, ''));
                  setError(null);
                }}
                placeholder={price === null ? 'Price per share' : money(price)}
                aria-describedby="ticket-estimate"
              />
            </label>
          )}

          <div className="ticket__presets">
            {[0.25, 0.5, 1].map((fraction) => {
              const value = Math.floor(maxForSide * fraction);
              return (
                <button
                  key={fraction}
                  type="button"
                  className="button button--ghost"
                  disabled={value < 1}
                  onClick={() => {
                    setQuantity(String(value));
                    setError(null);
                  }}
                >
                  {fraction === 1 ? 'Max' : `${fraction * 100}%`}
                </button>
              );
            })}
            <span className="ticket__max">
              max {shares(maxForSide)} {side === 'BUY' ? 'affordable' : 'held'}
            </span>
          </div>

          <p className="ticket__estimate" id="ticket-estimate">
            {estimate === null ? (
              <span className="ticket__muted">
                {limitMissing
                  ? 'Enter a limit price.'
                  : 'Enter a quantity to see the estimated total.'}
              </span>
            ) : type === 'LIMIT' ? (
              <>
                {/* At the limit, not at the market: this is the most it can cost, and
                    the amount held aside if it rests. Quoting the market price here
                    would understate what the order ties up. */}
                At most <strong>{money(estimate)}</strong>
                <span className="ticket__muted">
                  {marketable
                    ? ' — the market is there now, so this should fill straight away, at the market price if that is better'
                    : ' — held aside until the market reaches your price'}
                </span>
              </>
            ) : (
              <>
                Estimated {side === 'BUY' ? 'cost' : 'proceeds'}{' '}
                <strong>{money(estimate)}</strong>
                <span className="ticket__muted"> — fills at the price when the order lands</span>
              </>
            )}
          </p>

          {(overCash || overShares || limitInvalid || error) && (
            <div className="notice notice--error" role="alert">
              <span className="notice__glyph" aria-hidden="true">
                !
              </span>
              <span>
                {error ??
                  (limitInvalid
                    ? 'A limit price needs to be a number with at most four decimal places.'
                    : overCash
                      ? `That is ${money(estimate - cash)} more than you have available.`
                      : `You have ${shares(held)} ${symbol} available to sell.`)}
              </span>
            </div>
          )}

          <div className="ticket__actions">
            <button type="button" className="button button--ghost" onClick={close}>
              Cancel
            </button>
            <button type="submit" className="button" disabled={!canSubmit}>
              {/* "Place order" when it will rest, because "Buy 5" would promise a
                  trade that is not going to happen yet. */}
              {pending
                ? 'Placing…'
                : marketable
                  ? `${side === 'BUY' ? 'Buy' : 'Sell'} ${validQuantity ? parsed : ''}`.trim()
                  : 'Place order'}
            </button>
          </div>

          <p className="ticket__disclaimer">
            Simulated order against a simulated market. No real security is traded and no
            money moves.
          </p>
        </form>
      )}
    </dialog>
  );
}

/**
 * What actually happened, which is not always what the estimate said — and, for a
 * limit order, not always a trade at all.
 *
 * The two outcomes get different words on purpose. "Bought 5 MSFT" for an order that
 * is only waiting would be a lie the customer acts on.
 */
function Receipt({ receipt, onClose, onAgain }) {
  const { order, account } = receipt;
  if (order.status === 'OPEN') return <RestingReceipt order={order} onClose={onClose} onAgain={onAgain} />;

  const bought = order.side === 'BUY';

  return (
    <div className="ticket__form">
      <header className="ticket__head">
        <div>
          <h2 className="ticket__title">
            {bought ? 'Bought' : 'Sold'} {shares(order.quantity)} {order.symbol}
          </h2>
          <p className="ticket__sub">Filled at {money(order.price)}</p>
        </div>
        <button type="button" className="iconbutton" onClick={onClose} aria-label="Close">
          <span aria-hidden="true">✕</span>
        </button>
      </header>

      <dl className="ticket__facts ticket__facts--receipt">
        <div>
          <dt>{bought ? 'Cost' : 'Proceeds'}</dt>
          <dd>{money(order.notional)}</dd>
        </div>
        <div>
          <dt>Cash now</dt>
          <dd>{money(account.cash)}</dd>
        </div>
        {order.realizedPnl !== null && order.realizedPnl !== undefined && (
          <div>
            <dt>Realized P/L</dt>
            <dd>
              <Delta value={order.realizedPnl}>{signedMoney(order.realizedPnl)}</Delta>
            </dd>
          </div>
        )}
        {/* Only worth showing when there was some. A limit that filled exactly at its
            price improved on nothing, and a row of zeroes reads as a missing feature. */}
        {order.type === 'LIMIT' && order.priceImprovement > 0 && (
          <div>
            <dt>Better than your limit</dt>
            <dd>
              <Delta value={order.priceImprovement}>
                {signedMoney(order.priceImprovement)} per share
              </Delta>
            </dd>
          </div>
        )}
      </dl>

      <div className="ticket__actions">
        <button type="button" className="button button--ghost" onClick={onAgain}>
          Place another
        </button>
        <button type="button" className="button" onClick={onClose}>
          Done
        </button>
      </div>
    </div>
  );
}

/** An order that was accepted and has not happened yet. */
function RestingReceipt({ order, onClose, onAgain }) {
  const buying = order.side === 'BUY';

  return (
    <div className="ticket__form">
      <header className="ticket__head">
        <div>
          <h2 className="ticket__title">Order placed</h2>
          <p className="ticket__sub">
            {buying ? 'Buy' : 'Sell'} {shares(order.quantity)} {order.symbol}, waiting for{' '}
            {money(order.limitPrice)}
          </p>
        </div>
        <button type="button" className="iconbutton" onClick={onClose} aria-label="Close">
          <span aria-hidden="true">✕</span>
        </button>
      </header>

      <dl className="ticket__facts ticket__facts--receipt">
        <div>
          <dt>Your limit</dt>
          <dd>{money(order.limitPrice)}</dd>
        </div>
        <div>
          <dt>Market now</dt>
          <dd>{money(order.marketPrice)}</dd>
        </div>
        <div>
          {/* Named for what it is. The money has not been spent and the shares have
              not been sold — they are simply no longer available for anything else. */}
          <dt>{buying ? 'Cash held aside' : 'Shares held aside'}</dt>
          <dd>{buying ? money(order.quantity * order.limitPrice) : shares(order.quantity)}</dd>
        </div>
      </dl>

      <p className="ticket__estimate">
        <span className="ticket__muted">
          It fills on its own when the market reaches your price, at the market price if
          that is better. Until then you can cancel it from your portfolio.
        </span>
      </p>

      <div className="ticket__actions">
        <button type="button" className="button button--ghost" onClick={onAgain}>
          Place another
        </button>
        <button type="button" className="button" onClick={onClose}>
          Done
        </button>
      </div>
    </div>
  );
}
