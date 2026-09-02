/**
 * Retry pacing, and the sleep every wait in the process goes through.
 *
 * Full jitter, not exponential-with-a-little-noise: the delay is uniform over
 * [0, capped exponential). When the API comes back after being down, twenty users
 * whose backoffs have all converged on the 30s cap would otherwise return in the
 * same tick and hit a cold process with a synchronised burst. Spreading them over
 * the whole interval is the difference between a recovery and a second outage.
 */
import { config } from './config.js';
import { isShuttingDown } from './client.js';

/**
 * Resolves early — and reports it — when the process is shutting down, so a user
 * parked on a 30s backoff does not hold up a SIGTERM.
 */
export function sleep(ms, signal) {
  if (ms <= 0) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve(true);
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Per-user failure state. One of these per virtual user; nothing accumulates. */
export class Backoff {
  constructor(rng, { minMs = config.backoff.minMs, maxMs = config.backoff.maxMs } = {}) {
    this.rng = rng;
    this.minMs = minMs;
    this.maxMs = maxMs;
    this.failures = 0;
  }

  succeed() {
    this.failures = 0;
  }

  /** @returns {number} how long to wait before trying again */
  fail() {
    this.failures += 1;
    // Shift rather than pow: at 40 consecutive failures 2**39 is still exact, and
    // the cap bites long before that anyway.
    const ceiling = Math.min(this.minMs * 2 ** Math.min(this.failures - 1, 20), this.maxMs);
    return Math.round(this.rng() * ceiling);
  }

  get isFailing() {
    return this.failures > 0;
  }
}

/** True while the process should keep working. */
export const running = () => !isShuttingDown();
