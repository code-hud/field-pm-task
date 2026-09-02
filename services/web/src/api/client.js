/**
 * Trading API client.
 *
 * The base URL is same-origin `/api` by default: Vite proxies it in dev and nginx
 * proxies it in the container, so the browser never needs to know where the API
 * lives. `window.__APP_CONFIG__.apiBaseUrl` (injected at container start) overrides
 * it when the web service is pointed at an API on another host.
 */
const BASE_URL = (window.__APP_CONFIG__?.apiBaseUrl ?? '/api').replace(/\/$/, '');

const TOKEN_KEY = 'fpd.token';

export const tokenStore = {
  get: () => localStorage.getItem(TOKEN_KEY),
  set: (token) => localStorage.setItem(TOKEN_KEY, token),
  clear: () => localStorage.removeItem(TOKEN_KEY),
};

export class ApiError extends Error {
  constructor(message, { status, code } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

/** Fired when the API rejects our token, so the app can drop back to the login screen. */
const SESSION_EXPIRED = 'fpd:session-expired';
export const onSessionExpired = (handler) => {
  window.addEventListener(SESSION_EXPIRED, handler);
  return () => window.removeEventListener(SESSION_EXPIRED, handler);
};

async function request(path, { method = 'GET', body, signal, auth = true } = {}) {
  const headers = { accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';

  const token = tokenStore.get();
  if (auth && token) headers.authorization = `Bearer ${token}`;

  let response;
  try {
    response = await fetch(`${BASE_URL}${path}`, {
      method,
      headers,
      signal,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    throw new ApiError('Cannot reach the trading API.', { code: 'network_error' });
  }

  const payload = response.status === 204 ? null : await response.json().catch(() => null);

  if (!response.ok) {
    if (response.status === 401 && auth) {
      tokenStore.clear();
      window.dispatchEvent(new Event(SESSION_EXPIRED));
    }
    throw new ApiError(payload?.error?.message ?? `Request failed (${response.status}).`, {
      status: response.status,
      code: payload?.error?.code,
    });
  }

  return payload;
}

const query = (params) => {
  const search = new URLSearchParams(
    Object.entries(params).filter(([, value]) => value !== undefined && value !== null && value !== ''),
  ).toString();
  return search ? `?${search}` : '';
};

export const api = {
  login: (username, password) =>
    request('/auth/login', { method: 'POST', body: { username, password }, auth: false }),
  logout: () => request('/auth/logout', { method: 'POST' }).catch(() => null),
  me: (signal) => request('/auth/me', { signal }),

  marketStatus: (signal) => request('/market/status', { signal, auth: false }),
  instruments: (params = {}, signal) => request(`/market/instruments${query(params)}`, { signal }),
  instrument: (symbol, signal) => request(`/market/instruments/${encodeURIComponent(symbol)}`, { signal }),
  instrumentHistory: (symbol, range, signal) =>
    request(`/market/instruments/${encodeURIComponent(symbol)}/history${query({ range })}`, { signal }),
  movers: (count, signal) => request(`/market/movers${query({ count })}`, { signal }),
  sectors: (signal) => request('/market/sectors', { signal }),
  /** One sector in detail: both weightings, breadth, and the names at each end. */
  sectorDetail: (sector, count, signal) =>
    request(`/market/sectors/${encodeURIComponent(sector)}${query({ count })}`, { signal }),

  /**
   * Places an order. Resolves with the receipt, or throws an ApiError whose `code`
   * the ticket maps to a message — `insufficient_cash`, `insufficient_shares`,
   * `unknown_symbol`, `invalid_quantity`, `invalid_limit_price`.
   *
   * A limit order comes back either filled or resting; `receipt.order.status` says
   * which, and the ticket shows a different receipt for each. `limitPrice` is only
   * sent on a LIMIT order — the API refuses one on a market order rather than
   * ignoring it, which is the behaviour worth keeping.
   */
  placeOrder: ({ symbol, side, quantity, type = 'MARKET', limitPrice }) =>
    request('/orders', {
      method: 'POST',
      body: { symbol, side, quantity, type, ...(type === 'LIMIT' ? { limitPrice } : {}) },
    }),

  orders: (params = {}, signal) => request(`/orders${query(params)}`, { signal }),
  cancelOrder: (id) => request(`/orders/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  portfolio: (signal) => request('/portfolio', { signal }),
  allocation: (signal) => request('/portfolio/allocation', { signal }),
  portfolioHistory: (range, signal) => request(`/portfolio/history${query({ range })}`, { signal }),
  /** Booked gains by symbol, with the short/long split and the part it cannot attribute. */
  realized: (signal) => request('/portfolio/realized', { signal }),
  transactions: (limit, signal) => request(`/portfolio/transactions${query({ limit })}`, { signal }),
};
