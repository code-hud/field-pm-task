const pg = require('pg');

const { config } = require('../config/index.js');

const { Pool, types } = pg;

/**
 * Money and prices are `numeric` in the schema — exact decimal, which is the right
 * choice for a ledger. node-postgres hands `numeric` back as a string to avoid
 * silently losing precision, but every consumer here (JSON responses, arithmetic on
 * quantities × prices) wants a number, so parse at the boundary.
 *
 * The values in this demo are far inside the range where a float64 is exact to the
 * cent. A system moving real money would keep these as strings and do the
 * arithmetic in integer minor units or a decimal library.
 */
const NUMERIC_OID = 1700;
const INT8_OID = 20;
types.setTypeParser(NUMERIC_OID, (value) => (value === null ? null : Number.parseFloat(value)));
// Share counts and volumes are bigint but never approach 2^53.
types.setTypeParser(INT8_OID, (value) => (value === null ? null : Number.parseInt(value, 10)));
// DATE — keep the calendar date as written, with no timezone shifting.
types.setTypeParser(1082, (value) => value);

const pool = new Pool({
  connectionString: config.db.url,
  max: config.db.poolMax,
  connectionTimeoutMillis: config.db.connectionTimeoutMs,
  idleTimeoutMillis: config.db.idleTimeoutMs,
  application_name: config.serviceName,
});

// An idle client erroring (database restarted, network blip) must not take the
// process down — the pool discards it and the next query gets a fresh one.
pool.on('error', (error) => {
  console.error(`[${config.serviceName}] idle database client error:`, error.message);
});

const query = (text, params) => pool.query(text, params);

/**
 * Postgres errors that mean "you lost a race", rather than "what you asked for is
 * impossible": a serialization failure and a deadlock. Both are retryable by definition
 * — the transaction was rolled back cleanly and the same work attempted again will
 * usually succeed, because the transaction it raced with has now finished.
 */
const RETRYABLE_CODES = new Set([
  '40001', // serialization_failure
  '40P01', // deadlock_detected
  '57014', // query_canceled — a statement that hit its timeout
]);

const TRANSACTION_ATTEMPTS = 3;
const RETRY_DELAY_MS = 25;

/**
 * Runs `fn` inside a transaction, rolling back on any throw, and retrying the throws
 * that are races rather than refusals.
 *
 * A fill locks the account row and touches three tables. Two orders on the same account
 * can deadlock, and the loser currently surfaces as a 500 to a customer whose order was
 * perfectly valid — the definition of an error worth retrying rather than reporting.
 *
 * The client is released explicitly rather than in a `finally`: the next attempt asks the
 * pool for one, so the previous attempt's client has to be back before it does, and a
 * `finally` would also release the client while the caller's own error is still on its
 * way out of this function.
 */
async function transaction(fn) {
  let lastError;

  for (let attempt = 1; attempt <= TRANSACTION_ATTEMPTS; attempt += 1) {
    const client = await pool.connect();

    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      client.release();
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});

      // Not a race — a refusal, or a bug. The caller's error is the interesting one and
      // retrying it would only make the client wait for the same answer three times.
      if (!RETRYABLE_CODES.has(error?.code)) {
        client.release();
        throw error;
      }

      lastError = error;
      await sleep(RETRY_DELAY_MS * attempt);
    }
  }

  throw lastError;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Blocks until the database answers, or the startup budget runs out. Compose gates
 * on the postgres healthcheck, but nothing guarantees that outside compose.
 */
async function waitForDatabase({ timeoutMs = config.db.startupTimeoutMs } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  let attempt = 0;

  while (Date.now() < deadline) {
    try {
      await pool.query('SELECT 1');
      if (attempt > 0) console.log(`[${config.serviceName}] database reachable after ${attempt} retries.`);
      return;
    } catch (error) {
      lastError = error;
      attempt += 1;
      await sleep(Math.min(250 * attempt, 2000));
    }
  }

  throw new Error(`Database unreachable after ${timeoutMs}ms: ${lastError?.message}`);
}

const closePool = () => pool.end();

module.exports = { transaction, waitForDatabase, pool, query, closePool };
