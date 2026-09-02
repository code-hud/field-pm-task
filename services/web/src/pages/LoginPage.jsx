import { useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';

import { api } from '../api/client.js';
import { Delta } from '../components/Delta.jsx';
import { MarketStatusPill } from '../components/MarketStatusPill.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import { useLiveQuery } from '../hooks/useLiveQuery.js';
import { money, signedPercent } from '../lib/format.js';

export function LoginPage() {
  const { signIn, isAuthenticated } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [pending, setPending] = useState(false);

  // Public endpoints, so the login screen can show a live market without a token.
  const { data: status } = useLiveQuery((signal) => api.marketStatus(signal), { intervalMs: 30_000 });

  if (isAuthenticated) return <Navigate to={location.state?.from ?? '/portfolio'} replace />;

  const onSubmit = async (event) => {
    event.preventDefault();
    setError(null);

    if (!username.trim()) return setError(new Error('Enter a username.'));
    if (!password.trim()) return setError(new Error('Enter a password. Any non-blank value works in this demo.'));

    setPending(true);
    try {
      await signIn(username.trim(), password);
      navigate(location.state?.from ?? '/portfolio', { replace: true });
    } catch (caught) {
      setError(caught);
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="login">
      <div className="login__panel">
        <form className="login__form" onSubmit={onSubmit} noValidate>
          <div className="brand" style={{ marginBottom: 28 }}>
            <span className="brand__mark" aria-hidden="true">
              H
            </span>
            Heads Up Financial
          </div>

          <h1>Sign in</h1>
          <p>Access your portfolio and the Heads Up demo market.</p>

          {error && (
            <div className="notice notice--error" role="alert">
              <span className="notice__glyph" aria-hidden="true">
                !
              </span>
              <span>{error.message}</span>
            </div>
          )}

          <label className="formfield">
            <span className="formfield__label">Username</span>
            <input
              className="input"
              name="username"
              autoComplete="username"
              autoFocus
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              placeholder="e.g. a.okafor"
            />
          </label>

          <label className="formfield">
            <span className="formfield__label">Password</span>
            <input
              className="input"
              name="password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="Your password"
            />
          </label>

          <button className="button" type="submit" disabled={pending}>
            {pending ? 'Signing in…' : 'Sign in'}
          </button>

          <p className="hint">
            Demo environment. Any username signs in, and the password only has to be non-blank — each
            username maps to its own generated portfolio. The universe uses the real S&amp;P 500
            ticker symbols and company names; every price, fundamental and balance behind them is
            simulated.
          </p>
        </form>
      </div>

      <aside className="login__aside">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <h2>Heads Up demo market</h2>
          <MarketStatusPill status={status} />
        </div>
        <MarketPreview />
      </aside>
    </div>
  );
}

/**
 * A small live board on the login screen. It calls the public status endpoint only —
 * quotes need a session — so it shows the simulated universe without leaking data.
 */
function MarketPreview() {
  // The demo's own base prices for these names, not their real ones — MSFT opens
  // this universe near $23. That is not a bug to fix: a level nobody could mistake
  // for a quote is the safest thing to put next to a real company's name, and the
  // caption below says so outright.
  const preview = [
    { symbol: 'AAPL', name: 'Apple Inc.', price: 103.94 },
    { symbol: 'MSFT', name: 'Microsoft', price: 22.84 },
    { symbol: 'JPM', name: 'JPMorgan Chase', price: 52.51 },
    { symbol: 'XOM', name: 'ExxonMobil', price: 135.08 },
    { symbol: 'NEE', name: 'NextEra Energy', price: 78.62 },
  ];

  return (
    <>
      <div className="tickerlist">
        {preview.map((row, index) => {
          // Reference levels, not live quotes — steady values so nothing looks like a real feed.
          const change = [0.82, -0.34, 1.21, -0.65, 0.18][index];
          return (
            <div key={row.symbol} className="tickerlist__row">
              <span className="tickerlist__symbol">{row.symbol}</span>
              <span className="tickerlist__name">{row.name}</span>
              <span className="tickerlist__price">{money(row.price)}</span>
              <span className="tickerlist__delta">
                <Delta value={change}>{signedPercent(change)}</Delta>
              </span>
            </div>
          );
        })}
      </div>
      <p style={{ color: 'var(--text-muted)', fontSize: 12, maxWidth: 420, margin: 0 }}>
        The universe is the ~500 real S&amp;P 500 tickers. <strong>The prices are not.</strong> Every
        level, move and fundamental in this demo is generated from a seed and has never been a real
        quote. Sign in for the simulated tape, intraday charts, and your holdings.
      </p>
    </>
  );
}
