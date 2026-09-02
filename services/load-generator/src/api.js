/**
 * The trading API's surface, one function per endpoint.
 *
 * The `label` on each call is the route template, and it is the key everything in
 * the report is grouped by. It is written out here rather than derived from the URL
 * so that a path parameter can never become a new metrics key — see metrics.js.
 */
import { config } from './config.js';
import { request } from './client.js';

const qs = (params) => {
  const search = new URLSearchParams(
    Object.entries(params).filter(([, value]) => value !== undefined && value !== ''),
  ).toString();
  return search ? `?${search}` : '';
};

export const login = (username, password) =>
  request({
    label: 'POST /api/auth/login',
    path: '/api/auth/login',
    method: 'POST',
    body: { username, password },
  });

export const me = (token) => request({ label: 'GET /api/auth/me', path: '/api/auth/me', token });

export const marketStatus = () =>
  request({ label: 'GET /api/market/status', path: '/api/market/status' });

export const stocks = (token, params = {}) =>
  request({
    label: 'GET /api/market/stocks',
    path: `/api/market/stocks${qs(params)}`,
    token,
  });

export const stock = (token, symbol) =>
  request({
    label: 'GET /api/market/stocks/:symbol',
    path: `/api/market/stocks/${encodeURIComponent(symbol)}`,
    token,
  });

export const stockHistory = (token, symbol, range) =>
  request({
    label: 'GET /api/market/stocks/:symbol/history',
    path: `/api/market/stocks/${encodeURIComponent(symbol)}/history${qs({ range })}`,
    token,
  });

export const movers = (token) =>
  request({ label: 'GET /api/market/movers', path: '/api/market/movers', token });

export const sectors = (token) =>
  request({ label: 'GET /api/market/sectors', path: '/api/market/sectors', token });

export const portfolio = (token) =>
  request({ label: 'GET /api/portfolio', path: '/api/portfolio', token });

export const allocation = (token) =>
  request({ label: 'GET /api/portfolio/allocation', path: '/api/portfolio/allocation', token });

export const portfolioHistory = (token, range) =>
  request({
    label: 'GET /api/portfolio/history',
    path: `/api/portfolio/history${qs({ range })}`,
    token,
  });

export const transactions = (token, limit) =>
  request({
    label: 'GET /api/portfolio/transactions',
    path: `/api/portfolio/transactions${qs({ limit })}`,
    token,
  });

/**
 * 422 is expected here often enough that it must not read as an error: an account
 * that cannot afford a buy, or has already sold out of a name, is the API deciding
 * correctly. 404 stays unexpected — it means either an unknown symbol or an API old
 * enough not to have order entry, and the caller distinguishes those.
 */
export const placeOrder = (token, order) =>
  request({
    label: 'POST /api/orders',
    path: '/api/orders',
    method: 'POST',
    token,
    body: order,
    expect: [422],
  });

// ---- market intelligence -----------------------------------------------------
// A different service on a different port, so every call here passes `baseUrl`. No
// token: the market-intel service has no auth, for the same reason the fraud service
// has none — on the deployed stack it publishes no port and the only things that can
// reach it are on the compose network.

/**
 * Uploads one synthetic file. The body is raw bytes with a content type, not
 * multipart — see the service's README for why.
 *
 * 413 is expected, not an error: it means the generator built a file larger than the
 * service accepts, which is the limit working. 503 stays unexpected — that is the
 * broker being unreachable, and it should show up in the error rate.
 */
export const submitIntel = ({ body, contentType, filename }) =>
  request({
    label: 'POST /intel',
    baseUrl: config.intel.baseUrl,
    path: '/intel',
    method: 'POST',
    raw: body,
    contentType,
    headers: { 'x-filename': filename },
    expect: [413],
  });

/**
 * Polls one submission. Always 200 — an id that was never submitted and one still
 * queued are indistinguishable to the service, which keeps no database.
 */
export const intelStatus = (intelId) =>
  request({
    label: 'GET /intel/:id',
    baseUrl: config.intel.baseUrl,
    path: `/intel/${encodeURIComponent(intelId)}`,
  });
