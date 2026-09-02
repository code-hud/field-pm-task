/**
 * Counters and latency distributions, in constant memory.
 *
 * This process is meant to run for weeks, so nothing here may grow with the number
 * of requests. Latency goes into a fixed set of logarithmic buckets rather than an
 * array of samples: 70 integers per endpoint, whether that endpoint has served ten
 * requests or ten billion. Percentiles are read back off the buckets, accurate to
 * the bucket width (~15%), which is all a load report needs — nobody tunes anything
 * on the difference between a p95 of 210ms and 214ms.
 *
 * Labels are route templates supplied by the caller, never request URLs. Keying on
 * `/api/market/stocks/NVAX` would put an entry per symbol in the map, and one
 * per user id or search term in some future activity — a slow leak that only shows
 * up in week three.
 */

const BUCKET_GROWTH = 1.15;
const BUCKET_COUNT = 80; // 1.15^79 ≈ 66,000ms — past any timeout worth setting.

/** Upper bound of each bucket, in ms. Computed once and shared by every histogram. */
const BUCKET_BOUNDS = Array.from({ length: BUCKET_COUNT }, (_, i) => BUCKET_GROWTH ** i);

const bucketFor = (ms) => {
  if (!(ms > 1)) return 0;
  return Math.min(Math.ceil(Math.log(ms) / Math.log(BUCKET_GROWTH)), BUCKET_COUNT - 1);
};

class Histogram {
  constructor() {
    this.counts = new Int32Array(BUCKET_COUNT);
    this.total = 0;
    this.sum = 0;
    this.max = 0;
  }

  record(ms) {
    this.counts[bucketFor(ms)] += 1;
    this.total += 1;
    this.sum += ms;
    if (ms > this.max) this.max = ms;
  }

  reset() {
    this.counts.fill(0);
    this.total = 0;
    this.sum = 0;
    this.max = 0;
  }

  /** The upper bound of the bucket the requested quantile falls in. */
  quantile(q) {
    if (this.total === 0) return 0;
    const target = Math.ceil(q * this.total);
    let seen = 0;
    for (let i = 0; i < BUCKET_COUNT; i += 1) {
      seen += this.counts[i];
      if (seen >= target) return Math.round(BUCKET_BOUNDS[i]);
    }
    return Math.round(this.max);
  }

  get mean() {
    return this.total === 0 ? 0 : this.sum / this.total;
  }
}

/**
 * One endpoint's tallies. `rejected` is deliberately separate from `failed`: a 422
 * from an order the account cannot afford is the API working correctly, and folding
 * it into the error rate would make a healthy run look broken.
 */
class EndpointStats {
  constructor() {
    this.sent = 0;
    this.ok = 0;
    this.rejected = 0;
    this.failed = 0;
    this.latency = new Histogram();
  }

  reset() {
    this.sent = 0;
    this.ok = 0;
    this.rejected = 0;
    this.failed = 0;
    this.latency.reset();
  }
}

/**
 * A window of measurements. Two of these exist — one reset at every report, one kept
 * for the life of the process — so the summary can show both "right now" and "since
 * start" without keeping any history in between.
 */
class Window {
  constructor() {
    this.startedAt = Date.now();
    this.endpoints = new Map();
    this.latency = new Histogram();
    this.statuses = new Map(); // HTTP status → count; at most a few dozen keys.
    this.failureKinds = new Map(); // 'timeout' | 'network' | 'server_error' | …
    this.sent = 0;
    this.ok = 0;
    this.rejected = 0;
    this.failed = 0;
    this.logins = 0;
    this.reauths = 0;
    this.trades = { filled: 0, rejected: 0 };
    // Market intelligence. `bytes` accumulates so the report can show mean upload
    // size, which is the number that explains the processor's latency.
    this.intel = { accepted: 0, refused: 0, bytes: 0, done: 0, failed: 0, pending: 0 };
    // Submissions by generated format. A fixed five-key map, not per-file.
    this.intelKinds = new Map();
  }

  endpoint(label) {
    let stats = this.endpoints.get(label);
    if (!stats) {
      stats = new EndpointStats();
      this.endpoints.set(label, stats);
    }
    return stats;
  }

  reset() {
    this.startedAt = Date.now();
    // Reset in place rather than dropping the maps: the key set is the fixed list of
    // route templates, so reusing the entries keeps allocation flat report to report.
    for (const stats of this.endpoints.values()) stats.reset();
    this.latency.reset();
    for (const key of this.statuses.keys()) this.statuses.set(key, 0);
    for (const key of this.failureKinds.keys()) this.failureKinds.set(key, 0);
    this.sent = 0;
    this.ok = 0;
    this.rejected = 0;
    this.failed = 0;
    this.logins = 0;
    this.reauths = 0;
    this.trades.filled = 0;
    this.trades.rejected = 0;
    this.intel.accepted = 0;
    this.intel.refused = 0;
    this.intel.bytes = 0;
    this.intel.done = 0;
    this.intel.failed = 0;
    this.intel.pending = 0;
    for (const key of this.intelKinds.keys()) this.intelKinds.set(key, 0);
  }

  get elapsedSec() {
    return Math.max((Date.now() - this.startedAt) / 1000, 0.001);
  }
}

const bump = (map, key, by = 1) => map.set(key, (map.get(key) ?? 0) + by);

export class Metrics {
  constructor() {
    this.total = new Window();
    this.window = new Window();
    this.startedAt = Date.now();
    this.activeSessions = 0;
    this.backingOff = 0;
  }

  /** Records one completed request against both windows. */
  record({ label, status, kind, durationMs }) {
    for (const window of [this.total, this.window]) {
      const endpoint = window.endpoint(label);
      window.sent += 1;
      endpoint.sent += 1;
      window.latency.record(durationMs);
      endpoint.latency.record(durationMs);

      if (status) bump(window.statuses, status);

      if (kind === 'ok') {
        window.ok += 1;
        endpoint.ok += 1;
      } else if (kind === 'rejected') {
        window.rejected += 1;
        endpoint.rejected += 1;
      } else {
        window.failed += 1;
        endpoint.failed += 1;
        bump(window.failureKinds, kind);
      }
    }
  }

  countLogin({ reauth = false } = {}) {
    for (const window of [this.total, this.window]) {
      window.logins += 1;
      if (reauth) window.reauths += 1;
    }
  }

  countTrade({ filled }) {
    for (const window of [this.total, this.window]) {
      if (filled) window.trades.filled += 1;
      else window.trades.rejected += 1;
    }
  }

  countIntel({ accepted, kind, bytes }) {
    for (const window of [this.total, this.window]) {
      if (accepted) window.intel.accepted += 1;
      else window.intel.refused += 1;
      window.intel.bytes += bytes;
      bump(window.intelKinds, kind);
    }
  }

  /** How a followed submission ended: processed, failed, or still running when we
   *  stopped watching. `pending` is not an error — a 2 MiB file legitimately outlasts
   *  a user's patience. */
  countIntelOutcome(outcome) {
    for (const window of [this.total, this.window]) {
      if (outcome === 'done') window.intel.done += 1;
      else if (outcome === 'failed') window.intel.failed += 1;
      else window.intel.pending += 1;
    }
  }

  rollWindow() {
    this.window.reset();
  }
}

export const metrics = new Metrics();
