/**
 * Every knob, with its default, parsed once at boot — same shape as the trading
 * API's src/config/index.js so the two services read alike.
 */
import { hashString } from './random.js';

// Number('') is 0, not NaN, so an unset variable would silently become zero — which
// for LOADGEN_TRADE_WEIGHT means "trading is on" and no trades ever happen.
const num = (value, fallback) => {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const int = (value, fallback) => {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const bool = (value, fallback) => {
  if (value === undefined || value === '') return fallback;
  return !['0', 'false', 'no', 'off'].includes(value.toLowerCase());
};

const list = (value) =>
  (value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);

/**
 * A roster that looks like a customer list rather than user1..userN, because these
 * names end up in the API's logs and in the demo's account list. Any username is a
 * valid account — the API creates it with a generated portfolio on first sign-in.
 */
const ROSTER = [
  'a.okafor', 'l.zhang', 'm.rossi', 'k.novak', 'j.tanaka', 'p.mwangi',
  's.andersson', 'r.dubois', 'n.haddad', 'e.olsen', 'c.mendes', 'y.petrov',
  'i.kowalski', 'd.fitzgerald', 'b.nakamura', 'g.silva', 'h.eriksen', 't.abebe',
  'v.ramirez', 'w.osei', 'f.bergman', 'o.lindqvist', 'q.chen', 'z.varga',
];

/** Wraps the roster and suffixes repeats, so any user count is satisfiable. */
function buildRoster(count) {
  return Array.from({ length: count }, (_, i) => {
    const name = ROSTER[i % ROSTER.length];
    const cycle = Math.floor(i / ROSTER.length);
    return cycle === 0 ? name : `${name}${cycle + 1}`;
  });
}

const baseUrl = (process.env.LOADGEN_BASE_URL ?? 'http://localhost:4000').replace(/\/+$/, '');
const userCount = Math.max(int(process.env.LOADGEN_USERS, 12), 1);
const explicitUsernames = list(process.env.LOADGEN_USERNAMES);

const thinkMinMs = Math.max(int(process.env.LOADGEN_THINK_MIN_MS, 800), 0);

export const config = {
  baseUrl,
  serviceName: process.env.SERVICE_NAME ?? 'load-generator',

  // Same seed → same roster, same activity sequence, same think times. Set it to 0
  // for a genuinely different run; a run you cannot replay is hard to debug.
  seed: int(process.env.LOADGEN_SEED, 20260803),

  users: {
    usernames: explicitUsernames.length > 0 ? explicitUsernames : buildRoster(userCount),
    password: process.env.LOADGEN_PASSWORD ?? 'loadgen-demo',
    // Sign-ins are staggered across this window rather than fired at once: twenty
    // simultaneous first logins each generate a portfolio, which is the single most
    // expensive thing the API does.
    rampMs: Math.max(int(process.env.LOADGEN_RAMP_MS, 10_000), 0),
  },

  // Think time between activities. Real users read the page; a tight loop measures
  // how fast Node can spin, not how the platform behaves under people.
  thinkMinMs,
  thinkMaxMs: Math.max(int(process.env.LOADGEN_THINK_MAX_MS, 6000), thinkMinMs),

  // Ceiling on requests in flight across every user at once. Offered load is really
  // set by user count and think time; this is the guard rail that stops a slow API
  // from turning into a thundering herd as every user's activity piles up.
  concurrency: Math.max(int(process.env.LOADGEN_CONCURRENCY, userCount), 1),

  requestTimeoutMs: Math.max(int(process.env.LOADGEN_REQUEST_TIMEOUT_MS, 15_000), 100),

  trading: {
    enabled: bool(process.env.LOADGEN_TRADING, true),
    // Weight in the activity mix, not a probability — see activities.js for the
    // rest of the table. 0 disables trading as surely as LOADGEN_TRADING=false.
    weight: num(process.env.LOADGEN_TRADE_WEIGHT, 6),
    // Cap each buy at a slice of available cash so accounts trade for weeks instead
    // of spending themselves flat in the first hour and then only ever getting 422s.
    maxNotionalPercent: num(process.env.LOADGEN_MAX_TRADE_NOTIONAL_PCT, 4),
    // How often a trade is a sell rather than a buy. Roughly balanced keeps holdings
    // and cash both in a range where either side can still fill.
    sellProbability: num(process.env.LOADGEN_SELL_PROBABILITY, 0.45),
  },

  // Market intelligence: uploads to the market-intel service, which is a different
  // host on a different port. Off unless a base URL is set, so a stack running
  // without the `intel` profile is not a stack generating failures.
  intel: {
    baseUrl: (process.env.LOADGEN_INTEL_BASE_URL ?? '').trim().replace(/\/+$/, ''),
    // Weight in the same activity table as everything else, so intel submissions are
    // a share of one roster's attention rather than a second load pattern layered on
    // top. Modest by default: each one costs the processor real seconds.
    weight: num(process.env.LOADGEN_INTEL_WEIGHT, 5),
    // Size bounds for the generated files. The distribution is deliberately skewed
    // small (see intel.js) — the tail is what makes size-dependent processing time
    // visible in a latency histogram instead of averaged away.
    minBytes: Math.max(int(process.env.LOADGEN_INTEL_MIN_BYTES, 512), 32),
    maxBytes: Math.max(int(process.env.LOADGEN_INTEL_MAX_BYTES, 2_000_000), 1024),
    // How often a submission is followed by polling for its result, the way a UI
    // showing a progress spinner would. Not always: most of the value is the upload,
    // and polling every one would double the request count for little extra coverage.
    pollProbability: num(process.env.LOADGEN_INTEL_POLL_PROBABILITY, 0.5),
    // Polls per follow-up, and the gap between them. Bounded, so a stuck job cannot
    // park a virtual user forever.
    pollAttempts: Math.max(int(process.env.LOADGEN_INTEL_POLL_ATTEMPTS, 6), 1),
    pollIntervalMs: Math.max(int(process.env.LOADGEN_INTEL_POLL_INTERVAL_MS, 1500), 100),
  },

  // The diurnal shape: how the offered rate moves over an Eastern-time trading day.
  // See daypart.js for the curve itself. Everything here is a knob because the shape is
  // a claim about a distribution, and a claim worth making is one worth being able to
  // flatten when it gets in the way of whatever else is being measured.
  dayShape: {
    // Off gives back the flat rate this generator had before the curve existed, which
    // is the right baseline when the thing under test is the API rather than the shape.
    enabled: bool(process.env.LOADGEN_DAY_SHAPE, true),
    // Multiplicative lognormal wobble per ET minute. 0.12 is enough that the curve is
    // not visibly a drawn line, and small enough that it does not swamp it.
    noiseSigma: Math.max(num(process.env.LOADGEN_DAY_NOISE_SIGMA, 0.12), 0),
    // Per-minute chance of a burst starting. 0.006 is roughly eight or nine a day —
    // occasional, which is the whole point: these are the outliers in the arrival
    // distribution, and a tail that fires every few minutes is not a tail.
    burstProbability: Math.min(Math.max(num(process.env.LOADGEN_DAY_BURST_PROBABILITY, 0.006), 0), 1),
    // Bursts land uniformly in [2x, burstMax] and last 1..burstMaxMinutes, decaying.
    burstMax: Math.max(num(process.env.LOADGEN_DAY_BURST_MAX, 4), 2),
    burstMaxMinutes: Math.max(int(process.env.LOADGEN_DAY_BURST_MAX_MINUTES, 3), 1),
    // Clamps on the composed factor. The floor keeps overnight traffic non-zero, so the
    // report window and the container healthcheck both still see requests at 03:00.
    minFactor: Math.max(num(process.env.LOADGEN_DAY_MIN_FACTOR, 0.08), 0.01),
    maxFactor: Math.max(num(process.env.LOADGEN_DAY_MAX_FACTOR, 6), 1),
    // Floor on a shaped pause, so the busiest burst still leaves the API room to
    // breathe between one user's activities. Concurrency is the other guard rail.
    minPauseMs: Math.max(int(process.env.LOADGEN_DAY_MIN_PAUSE_MS, 120), 1),
    // Whether the activity mix also moves with the day — trades at the open and close,
    // intel uploads pre-market and after hours. Separable from the rate because the two
    // answer different questions: the rate shapes every endpoint at once, the tilt is
    // what makes one endpoint's curve differ from another's.
    tilt: bool(process.env.LOADGEN_DAY_TILT, true),
  },

  backoff: {
    minMs: Math.max(int(process.env.LOADGEN_BACKOFF_MIN_MS, 500), 1),
    maxMs: Math.max(int(process.env.LOADGEN_BACKOFF_MAX_MS, 30_000), 1000),
  },

  // 0 means run until stopped, which is the point of this service.
  durationSec: Math.max(int(process.env.LOADGEN_DURATION_SEC, 0), 0),

  reportIntervalMs: Math.max(int(process.env.LOADGEN_REPORT_INTERVAL_MS, 30_000), 1000),
  // Touched at every report in which at least one request was attempted, so the
  // container healthcheck can tell "still generating load" from "wedged". It stays
  // fresh during an API outage, which is correct — a generator patiently backing off
  // is working, and restarting it would only reset the backoff.
  heartbeatFile: process.env.LOADGEN_HEARTBEAT_FILE ?? '',
  // Individual failures are logged at most this often per error kind. A dead API
  // produces one failure per user per backoff round; printing all of them buries the
  // summary that actually tells you what is happening.
  errorLogIntervalMs: Math.max(int(process.env.LOADGEN_ERROR_LOG_INTERVAL_MS, 10_000), 0),
};

/** A distinct, stable PRNG seed per user, so adding a user does not reshuffle the rest. */
export const seedFor = (username) => (config.seed ^ hashString(username)) >>> 0;

export function describeConfig() {
  return [
    `base URL        ${config.baseUrl}`,
    `users           ${config.users.usernames.length} (${config.users.usernames.slice(0, 6).join(', ')}` +
      `${config.users.usernames.length > 6 ? ', …' : ''})`,
    `think time      ${config.thinkMinMs}–${config.thinkMaxMs}ms`,
    `concurrency     ${config.concurrency} in flight`,
    `trading         ${config.trading.enabled ? `on (weight ${config.trading.weight}, ` +
      `≤${config.trading.maxNotionalPercent}% of cash per buy)` : 'off'}`,
    `intel           ${config.intel.baseUrl
      ? `${config.intel.baseUrl} (weight ${config.intel.weight}, ` +
        `${config.intel.minBytes}–${config.intel.maxBytes} bytes)`
      : 'off (set LOADGEN_INTEL_BASE_URL)'}`,
    `request timeout ${config.requestTimeoutMs}ms`,
    `backoff         ${config.backoff.minMs}ms → ${config.backoff.maxMs}ms, full jitter`,
    `duration        ${config.durationSec === 0 ? 'unlimited' : `${config.durationSec}s`}`,
    `seed            ${config.seed}`,
  ].join('\n  ');
}
