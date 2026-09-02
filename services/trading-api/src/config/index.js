const num = (value, fallback) => {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

// parseFloat, for the knobs that are ratios rather than counts. `num` would read a
// congestion of 0.6 as 0, which is the difference between "the day matters a bit" and
// "the day does not exist" — a silent one, since 0 is a legal value for that setting.
const float = (value, fallback) => {
  const parsed = Number.parseFloat(value ?? '');
  return Number.isFinite(parsed) ? parsed : fallback;
};

const bool = (value, fallback) => {
  if (value === undefined || value === '') return fallback;
  return !['0', 'false', 'no', 'off'].includes(value.toLowerCase());
};

const list = (value, fallback) => {
  const entries = (value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  return entries.length > 0 ? entries : fallback;
};

const config = {
  env: process.env.NODE_ENV ?? 'development',
  port: num(process.env.PORT, 4000),
  host: process.env.HOST ?? '0.0.0.0',
  serviceName: process.env.SERVICE_NAME ?? 'trading-api',
  version: process.env.SERVICE_VERSION ?? '0.1.0',

  auth: {
    // Demo credentials policy: any username, any non-blank password.
    jwtSecret: process.env.JWT_SECRET ?? 'demo-secret-do-not-use-in-production',
    jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? '8h',
    issuer: 'fpd-trading-api',
  },

  // Comma-separated list of allowed browser origins. Defaults cover local dev.
  corsOrigins: list(process.env.CORS_ORIGINS, ['http://localhost:5273', 'http://localhost:8080']),

  market: {
    // How often quotes are repriced, and how much of the session we keep in memory.
    tickIntervalMs: num(process.env.MARKET_TICK_INTERVAL_MS, 2000),
    // How often a read-only replica retries for the writer lock, so a dead leader
    // is replaced without operator action.
    electionIntervalMs: num(process.env.MARKET_ELECTION_INTERVAL_MS, 5000),
    barIntervalMs: num(process.env.MARKET_BAR_INTERVAL_MS, 60_000),
    sessionBars: num(process.env.MARKET_SESSION_BARS, 390), // 6.5h of 1-minute bars
    // Fixed seed keeps every demo run reproducible; override for variety.
    seed: num(process.env.MARKET_SEED, 20260803),
  },

  portfolio: {
    historyDays: num(process.env.PORTFOLIO_HISTORY_DAYS, 252),
  },

  // Fraud screening is a separate service (services/fraud-service), called on the way
  // into every fill.
  fraud: {
    // No URL means no screening: the API behaves exactly as it did before the service
    // existed. That is how `make test`, CI, and `make dev-api` on its own run, and it
    // is why adding the service did not add a required dependency to the API.
    url: (process.env.FRAUD_SERVICE_URL ?? '').trim(),
    // Generous next to the single-digit milliseconds the service answers in, because
    // the cost of being wrong is asymmetric: a timeout that fires early turns a
    // healthy screening service into a skipped check.
    timeoutMs: num(process.env.FRAUD_TIMEOUT_MS, 1000),
    // What to do when the check cannot be made at all — unreachable, timed out, or
    // answering something unreadable. Open, so a fraud service outage degrades
    // screening rather than stopping the platform from trading. Every occurrence is
    // logged and recorded on the span; see src/fraud/fraudClient.js for the argument, and
    // set FRAUD_FAIL_OPEN=false to invert it.
    failOpen: bool(process.env.FRAUD_FAIL_OPEN, true),
  },

  orders: {
    /**
     * The simulated cost of a fill, on top of what the fill actually spends.
     *
     * A market order here is a handful of indexed statements against small tables — the
     * whole endpoint averages ~14ms, and `Client.query()` averages 0.1ms across nine
     * queries. That is an honest measurement and a useless distribution: p50 and p90 a
     * few milliseconds apart, no tail, nothing for a latency graph to show. So a cost is
     * added, and it is added *outside* the transaction — see orderService.js, which is
     * where holding the account's row lock while sleeping would be a genuine bug rather
     * than an aesthetic one.
     *
     * Sized to stay well clear of a typical latency alert floor (~150ms on this
     * account): with fraud screening's own simulated cost on top, order p90 lands near
     * 45ms at the busiest hour and p99 near 75ms. The stalls reach ~400ms occasionally,
     * which is a visible outlier and still not an alert.
     */
    latency: {
      // `npm test` sets ORDER_LATENCY=false. The suite places a few hundred orders and
      // has no interest in what they cost; leaving it on would spend seconds of every run
      // on sleeps and would make the runtime depend on the hour the suite happens to run
      // at. The timing model itself is tested directly, in test/daypart.test.js.
      enabled: bool(process.env.ORDER_LATENCY, false),
      dayShape: bool(process.env.ORDER_LATENCY_DAY_SHAPE, true),
      baseMs: num(process.env.ORDER_LATENCY_BASE_MS, 5),
      congestion: float(process.env.ORDER_LATENCY_CONGESTION, 0.6),
      sigma: float(process.env.ORDER_LATENCY_SIGMA, 0.45),
      stallProbability: float(process.env.ORDER_LATENCY_STALL_PROBABILITY, 0.008),
      stallMinMs: num(process.env.ORDER_LATENCY_STALL_MIN_MS, 80),
      stallMaxMs: num(process.env.ORDER_LATENCY_STALL_MAX_MS, 350),
      // Hard ceiling. Well under the alert floor, and well under anything a browser or
      // the load generator's 15s request timeout would notice.
      maxMs: num(process.env.ORDER_LATENCY_MAX_MS, 500),
    },
  },

  db: {
    url: process.env.DATABASE_URL ?? 'postgres://headsup:headsup@localhost:5432/headsup',
    poolMax: num(process.env.DB_POOL_MAX, 10),
    connectionTimeoutMs: num(process.env.DB_CONNECTION_TIMEOUT_MS, 5000),
    // How long any single statement inside a fill may run. A fill holds the account's
    // row lock while it works, so this bounds how long one slow statement can hold up
    // every other order on that account. Generous: a fill is a handful of indexed
    // statements against small tables, so anything near this is waiting, not working.
    fillStatementTimeoutMs: num(process.env.DB_FILL_STATEMENT_TIMEOUT_MS, 250),
    idleTimeoutMs: num(process.env.DB_IDLE_TIMEOUT_MS, 30_000),
    // How long to keep retrying the first connection. Compose waits for the
    // healthcheck, but a bare `docker run` or a restarting database needs slack.
    startupTimeoutMs: num(process.env.DB_STARTUP_TIMEOUT_MS, 30_000),
    migrateOnBoot: bool(process.env.DB_MIGRATE_ON_BOOT, true),
    // Seeds only when the universe is empty — never overwrites existing data.
    seedOnBoot: bool(process.env.DB_SEED_ON_BOOT, true),
  },

  logFormat: process.env.LOG_FORMAT ?? (process.env.NODE_ENV === 'production' ? 'combined' : 'dev'),
};

if (config.env === 'production' && config.auth.jwtSecret.startsWith('demo-secret')) {
  console.warn('[trading-api] JWT_SECRET is unset — using the built-in demo secret.');
}

module.exports = { config };
