/**
 * Every screening threshold in one place, overridable by environment variable.
 *
 * A first set of fraud thresholds is always a guess about a distribution nobody has
 * measured yet, so the useful thing is being able to move them from the environment
 * against a running service. Defaults are calibrated against the load generator's own
 * traffic (largest ordinary order ~$45,000, roughly one order a minute per account),
 * so ordinary activity is never screened out.
 */
const seconds = (n) => n * 1000;
const minutes = (n) => n * 60 * 1000;

/** Parse "30m" / "60s" / "500ms" / a bare number of ms into milliseconds. */
function durationMs(value, fallbackMs) {
  if (value == null || value === '') return fallbackMs;
  const match = String(value).trim().match(/^(\d+)\s*(ms|s|m|h)?$/);
  if (!match) return fallbackMs;
  const n = Number(match[1]);
  switch (match[2]) {
    case 'h': return n * 60 * 60 * 1000;
    case 'm': return minutes(n);
    case 's': return seconds(n);
    default: return n; // ms, or unit-less
  }
}

const num = (value, fallback) => (value == null || value === '' ? fallback : Number(value));
const bool = (value, fallback) => (value == null || value === '' ? fallback : value === 'true');

const config = {
  serviceName: process.env.OTEL_SERVICE_NAME || 'fraud-service',
  port: num(process.env.PORT, 4100),
  logLevel: process.env.LOG_LEVEL || 'info',

  history: {
    retentionMs: durationMs(process.env.FRAUD_HISTORY_RETENTION, minutes(30)),
    maxAccounts: num(process.env.FRAUD_HISTORY_MAX_ACCOUNTS, 2000),
    maxTradesPerAccount: num(process.env.FRAUD_HISTORY_MAX_TRADES, 64),
  },

  // notional-ceiling — a hard backstop on a single trade, ~5x the largest order the
  // demo ever places. Catches an account with no baseline yet.
  notionalCeiling: {
    limit: num(process.env.FRAUD_MAX_ORDER_NOTIONAL, 250000),
  },

  // trade-velocity — normal is ~1 order a minute per account. Ten in a minute is a script.
  velocity: {
    windowMs: durationMs(process.env.FRAUD_VELOCITY_WINDOW, seconds(60)),
    maxTrades: num(process.env.FRAUD_VELOCITY_MAX_TRADES, 10),
  },

  // notional-spike — a trade far larger than THIS account's own normal.
  notionalSpike: {
    minObservations: num(process.env.FRAUD_SPIKE_MIN_HISTORY, 6),
    multiple: num(process.env.FRAUD_SPIKE_MULTIPLE, 8),
    floor: num(process.env.FRAUD_SPIKE_FLOOR, 50000),
  },

  // rapid-reversal — buying and selling the same instrument within seconds.
  rapidReversal: {
    windowMs: durationMs(process.env.FRAUD_REVERSAL_WINDOW, seconds(45)),
  },

  // Recognises a retried check as the same check, so a lost response is not re-screened
  // (which would double-count the account's velocity). See checkLedger.js.
  dedupe: {
    enabled: bool(process.env.FRAUD_DEDUPE, true),
    ttlMs: durationMs(process.env.FRAUD_DEDUPE_TTL, seconds(30)),
    maxKeys: num(process.env.FRAUD_DEDUPE_MAX_KEYS, 4000),
  },

  // What the service keeps about its own recent decisions, for GET /fraud/decisions.
  audit: {
    enabled: bool(process.env.FRAUD_AUDIT, true),
    maxDecisions: num(process.env.FRAUD_AUDIT_MAX_DECISIONS, 500),
  },
};

module.exports = { config };
