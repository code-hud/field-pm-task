/**
 * The HTTP layer: one call in, one result object out, never a throw.
 *
 * Activities read like a browser session, and a browser session does not blow up
 * because the server is restarting — it sees a failed request and decides what to
 * do. Returning a result rather than throwing keeps that decision in the activity,
 * and means a forgotten `await` cannot become an unhandled rejection that ends a
 * run three weeks in.
 *
 * Every outcome is classified into one of a fixed set of kinds, which is what the
 * report groups by and what the retry policy keys off:
 *
 *   ok            2xx
 *   rejected      4xx the caller asked for — a 422 on an unaffordable order is the
 *                 API working, not an error, and must not inflate the error rate
 *   unauthorized  401/403 — the session expired; re-login and carry on
 *   client_error  any other 4xx: a bug in this generator, worth seeing
 *   server_error  5xx
 *   timeout       no response inside LOADGEN_REQUEST_TIMEOUT_MS
 *   network       refused, reset, DNS — the API is down or moving
 *   aborted       we are shutting down; not the API's problem, not recorded
 */
import { setMaxListeners } from 'node:events';

import { config } from './config.js';
import { metrics } from './metrics.js';

/**
 * Caps requests in flight across every user. Without it, a stalled API turns each
 * user's queued activity into another open socket, and the generator's own memory
 * and file descriptors become the first thing to fail.
 */
class Semaphore {
  constructor(limit) {
    this.limit = limit;
    this.inFlight = 0;
    this.waiters = [];
  }

  async acquire() {
    if (this.inFlight < this.limit) {
      this.inFlight += 1;
      return;
    }
    await new Promise((resolve) => this.waiters.push(resolve));
    this.inFlight += 1;
  }

  release() {
    this.inFlight -= 1;
    this.waiters.shift()?.();
  }

  /** Lets a shutdown drain the queue instead of leaving callers parked forever. */
  releaseAll() {
    const waiters = this.waiters;
    this.waiters = [];
    for (const resolve of waiters) resolve();
  }
}

const gate = new Semaphore(config.concurrency);

/** Aborted once on shutdown; every in-flight request is wired to it. */
const shutdown = new AbortController();
// One listener per request in flight, which is legitimately more than the default
// warning threshold of ten. Without this the first busy moment prints a
// MaxListenersExceededWarning that looks exactly like the leak it is meant to catch.
setMaxListeners(0, shutdown.signal);

export function abortInFlight() {
  shutdown.abort();
  gate.releaseAll();
}

export const isShuttingDown = () => shutdown.signal.aborted;

const classifyStatus = (status, expected) => {
  if (status >= 200 && status < 300) return 'ok';
  if (status === 401 || status === 403) return 'unauthorized';
  if (expected.includes(status)) return 'rejected';
  if (status >= 500) return 'server_error';
  return 'client_error';
};

/** Node buries the useful part of a fetch failure one or two `cause`s deep. */
function classifyNetworkError(error, timedOut) {
  if (shutdown.signal.aborted) return { kind: 'aborted', detail: 'shutting down' };
  if (timedOut || error?.name === 'TimeoutError' || error?.name === 'AbortError') {
    return { kind: 'timeout', detail: `no response in ${config.requestTimeoutMs}ms` };
  }
  const code = error?.cause?.code ?? error?.code;
  return { kind: 'network', detail: code ?? error?.message ?? 'unknown network error' };
}

/**
 * @param {object} options
 * @param {string} options.label   route template, e.g. `GET /api/market/stocks/:symbol`
 *                                 — the metrics key, so it must be bounded, not a URL
 * @param {string} options.path    the actual path, with parameters filled in
 * @param {string} [options.baseUrl] which service to call. Defaults to the trading
 *                                 API; the market-intel service is the other one.
 * @param {string} [options.token] bearer token
 * @param {number[]} [options.expect] status codes that are a normal outcome here
 * @param {Buffer} [options.raw]   a body to send as-is, with `contentType`. For file
 *                                 uploads: `body` is JSON-encoded, `raw` is not.
 * @param {string} [options.contentType] required with `raw`
 * @param {object} [options.headers] extra request headers
 */
export async function request({
  label,
  path,
  baseUrl = config.baseUrl,
  method = 'GET',
  token,
  body,
  raw,
  contentType,
  headers: extraHeaders,
  expect = [],
}) {
  if (shutdown.signal.aborted) return { ok: false, kind: 'aborted', status: 0, durationMs: 0 };

  await gate.acquire();
  const startedAt = performance.now();

  /**
   * The deadline and the shutdown hook are torn down explicitly in `finally` rather
   * than left to `AbortSignal.timeout` and `AbortSignal.any`. Both of those leave
   * something behind for every request that finishes normally — an armed timer that
   * still has to fire, and a listener on a signal that lives as long as the process.
   * At ten requests a second for three weeks that is not a rounding error, and it is
   * exactly the kind of slow leak this service exists to survive rather than cause.
   */
  let timedOut = false;
  const controller = new AbortController();
  const deadline = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, config.requestTimeoutMs);
  const onShutdown = () => controller.abort();
  shutdown.signal.addEventListener('abort', onShutdown, { once: true });

  try {
    if (shutdown.signal.aborted) return { ok: false, kind: 'aborted', status: 0, durationMs: 0 };

    const headers = { accept: 'application/json', ...extraHeaders };
    if (token) headers.authorization = `Bearer ${token}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    // `raw` wins: a caller that passed bytes and a content type means them literally.
    if (raw !== undefined) headers['content-type'] = contentType ?? 'application/octet-stream';

    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      body: raw !== undefined ? raw : body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });

    // The body must be drained even when it is not used, or the socket is not
    // returned to the agent's pool and the connection count climbs all run.
    const text = await response.text();
    const durationMs = performance.now() - startedAt;
    const kind = classifyStatus(response.status, expect);

    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      // A proxy or a crashed process can answer with HTML; that is a real signal,
      // so keep the status and let the caller see an unparsed body rather than
      // turning it into a client-side exception.
    }

    metrics.record({ label, status: response.status, kind, durationMs });

    return {
      ok: kind === 'ok',
      kind,
      status: response.status,
      body: payload,
      detail: payload?.error?.message ?? (payload ? undefined : text.slice(0, 120)),
      durationMs,
    };
  } catch (error) {
    const durationMs = performance.now() - startedAt;
    const { kind, detail } = classifyNetworkError(error, timedOut);
    // A shutdown abort is our own doing — recording it would show as a burst of
    // failures on every clean stop.
    if (kind !== 'aborted') metrics.record({ label, status: 0, kind, durationMs });
    return { ok: false, kind, status: 0, detail, durationMs };
  } finally {
    clearTimeout(deadline);
    shutdown.signal.removeEventListener('abort', onShutdown);
    gate.release();
  }
}
