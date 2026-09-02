/**
 * The API's half of the fraud screening boundary.
 *
 * Every fill is screened by the fraud service before it is written. This module is the
 * only thing in the API that knows that service exists, and it is deliberately the only
 * place two policies live:
 *
 *   1. **When screening happens.** Before the transaction, never inside it. A fill holds
 *      a row lock on the account, and an HTTP call made under that lock would put the
 *      fraud service's latency — and its timeouts — inside a database transaction, where
 *      one slow check would block every other order on the same account.
 *
 *   2. **What an unanswerable check means.** A denial is a decision; an unreachable
 *      service is an absence of one, and the two must not be conflated. The default is to
 *      fail open: screening is a control on top of a platform that already refuses
 *      overdrafts and short sales, and taking order entry down because a subsidiary
 *      service is restarting would be a self-inflicted outage. That is a *demo's*
 *      trade-off stated out loud rather than a universal one — a venue with a regulatory
 *      obligation to screen would set FRAUD_FAIL_OPEN=false and reject instead.
 *
 * Whichever way that setting goes, a skipped check is never silent: it logs and it is
 * recorded on the span as a handled failure, because a fail-open that nobody can see is
 * indistinguishable from a screening service that was never called.
 */
const { randomUUID } = require('node:crypto');

const axios = require('axios');

const { config } = require('../config/index.js');
const { ApiError } = require('../middleware/errors.js');
const { setContext, setFailure } = require('../observability/telemetry.js');

const CHECK_PATH = '/fraud/checks';

/**
 * How many times to ask before treating the check as unanswerable.
 *
 * Three, with no delay between them. The fraud service is a container on the same host,
 * so a failed attempt is a process that is restarting rather than a network that is
 * congested — there is nothing for a backoff to wait for, and waiting would only add
 * latency to an order that is about to be filled anyway.
 */
const CHECK_ATTEMPTS = 3;

/** True when a fraud service is configured. False in tests, in CI, and in bare `make dev-api`. */
const fraudScreeningEnabled = () => config.fraud.url !== '';

/**
 * Screens one intended trade, and returns only if it may be filled.
 *
 * @param {{accountId: string, symbol: string, side: 'BUY'|'SELL', quantity: number, price: number}} trade
 *   The fill that is about to be attempted. `price` is the current quote, read outside
 *   the transaction — indicative, since the tape can move before the fill; the fill
 *   re-reads it authoritatively. Screening at the fourth decimal place would be a bad
 *   rule, so the difference does not matter to the decision.
 * @throws {ApiError} 422 `fraud_rejected` when the service denies the trade, or 503
 *   `fraud_check_unavailable` when it cannot be reached and fail-open is off.
 */
async function screenTrade(trade) {
  if (!fraudScreeningEnabled()) return;

  let decision;
  try {
    // One name for this screening decision, held across every attempt below. Minted
    // here unless the caller supplied one — an order carrying an Idempotency-Key
    // derives its screening key from that, so a retry of a *failed* attempt is
    // screened under the same name the first one used. It is what lets the fraud service tell a retry from a second trade — and it
    // has to be minted *outside* the retry loop, which is the whole point: a key per
    // attempt would be three keys for one decision and would dedupe nothing.
    //
    // Why it matters: that service records the trade in its history window before it
    // answers, and its velocity rule counts attempts on purpose. So a check it completed
    // but this client could not read used to be recorded once per attempt, and one order
    // could consume three of the ten slots in its own account's window — making the
    // screener deny the order it had already allowed. See CheckLedger there.
    decision = await requestDecision({ ...trade, checkKey: trade.checkKey ?? randomUUID() });
  } catch (error) {
    return unavailable(error, trade);
  }

  if (decision.decision === 'DENY') {
    // Dimension rather than a log line: this is the interesting minority of orders, and
    // tagging the span makes "which accounts and symbols get denied" a question the traces can
    // answer without a log search.
    setContext({ fraudDecision: 'DENY' });
    throw new ApiError(`Trade blocked by fraud screening: ${decision.reasons.join('; ')}`, {
      status: 422,
      code: 'fraud_rejected',
    });
  }

  setContext({ fraudDecision: 'ALLOW' });
}

/**
 * Asks for a decision, retrying an attempt that could not produce one.
 *
 * A screening service that was briefly restarting used to cost the order its check
 * entirely — the deploy of the fraud service is measured in seconds, and every order
 * placed inside that window filled unscreened. Retrying covers the restart, which is the
 * failure this service actually has.
 *
 * Every attempt gets its own timeout, so a check that cannot be answered still gives up
 * within a bounded time rather than hanging the order.
 */
async function requestDecision(trade) {
  let lastError;

  for (let attempt = 1; attempt <= CHECK_ATTEMPTS; attempt += 1) {
    try {
      return await attemptDecision(trade);
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError;
}

async function attemptDecision(trade) {
  // The OpenTelemetry HTTP instrumentation captures this outbound call and injects the
  // trace context into the request headers, so the fraud service's work appears as a
  // child span of the order — the screening hop is visible end to end in one trace.
  const response = await axios.post(
    new URL(CHECK_PATH, config.fraud.url).toString(),
    {
      accountId: String(trade.accountId),
      symbol: trade.symbol,
      side: trade.side,
      quantity: trade.quantity,
      price: trade.price,
      // Unchanged across the retries above. Omitted rather than sent as null when absent,
      // so a service that does not know the field is unaffected by it.
      ...(trade.checkKey ? { checkKey: trade.checkKey } : {}),
    },
    {
      timeout: config.fraud.timeoutMs,
      headers: { 'content-type': 'application/json' },
      // Treat every non-2xx as a thrown error, which is what the retry loop above
      // and the fail-open policy below are both written against.
      validateStatus: (status) => status >= 200 && status < 300,
    },
  );

  const decision = response.data;

  // A body the API cannot read is not a decision. Being strict here is what keeps a
  // deployment mismatch — a renamed field, a changed enum — out of the fill path: it
  // becomes a visible unavailability rather than a check silently treated as an allow.
  if (decision?.decision !== 'ALLOW' && decision?.decision !== 'DENY') {
    throw new Error(`fraud service returned no usable decision: ${JSON.stringify(decision)?.slice(0, 200)}`);
  }
  if (decision.decision === 'DENY' && !(Array.isArray(decision.reasons) && decision.reasons.length > 0)) {
    throw new Error('fraud service denied a trade without giving a reason');
  }

  return decision;
}

/** The check could not be made. Report it, then apply the configured policy. */
function unavailable(error, trade) {
  const reason = error?.name === 'TimeoutError' ? `timed out after ${config.fraud.timeoutMs}ms` : error?.message;

  setContext({ fraudDecision: 'UNAVAILABLE' });
  // Reported explicitly: the API is about to handle this and return a normal 201, so
  // without this the flow looks like an ordinary successful order and the outage is
  // invisible to everything except this log line.
  setFailure(`fraud screening unavailable: ${reason}`);
  console.warn(
    `[${config.serviceName}] fraud screening unavailable (${reason}) — ` +
      `${config.fraud.failOpen ? 'allowing' : 'rejecting'} ${trade.side} ${trade.quantity} ${trade.symbol}`,
  );

  if (!config.fraud.failOpen) {
    throw new ApiError('Fraud screening is unavailable, so this trade cannot be accepted right now.', {
      status: 503,
      code: 'fraud_check_unavailable',
    });
  }
}

module.exports = { screenTrade, fraudScreeningEnabled };
