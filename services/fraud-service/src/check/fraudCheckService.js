const { randomUUID } = require('node:crypto');

const { rules } = require('../rules/index.js');
const { tradeCheck } = require('./tradeCheck.js');
const { allow, deny } = require('./fraudDecision.js');
const { tradeObservation } = require('../history/tradeObservation.js');

/**
 * Runs every rule against one trade and reduces the objections to a single decision.
 *
 * The order of the three steps is the contract the stateful rules depend on: history is
 * snapshotted first (so no rule compares this trade against a set containing it), the
 * rules run against that fixed snapshot, and the trade is recorded last — whatever the
 * decision, including denials, because the attempt rate is what velocity screening measures.
 */
function createFraudCheckService({ activity, ledger, decisions, stats, logger }) {
  const ruleNames = () => rules.map((r) => r.name);

  /** The screening itself. One call per decision, guaranteed by the ledger. */
  function screen(request) {
    const startedAt = performance.now();
    const trade = tradeCheck(request);
    const checkId = randomUUID();
    const at = Date.now();

    const history = activity.snapshot(trade.accountId, at);

    const reasons = [];
    const codes = [];
    const firedNames = [];
    for (const rule of rules) {
      const reason = rule.evaluate(trade, history);
      if (reason) {
        reasons.push(`${rule.name}: ${reason}`);
        codes.push(rule.code);
        firedNames.push(rule.name);
      }
    }

    activity.record(trade.accountId, tradeObservation({ at, symbol: trade.symbol, side: trade.side, notional: trade.notional }));

    const costMs = performance.now() - startedAt;
    const decision = reasons.length === 0 ? allow(checkId, at) : deny(reasons, codes, checkId, at);

    decisions.record({
      checkId,
      at: new Date(at).toISOString(),
      accountId: trade.accountId,
      symbol: trade.symbol,
      side: trade.side,
      quantity: trade.quantity,
      notional: trade.notional,
      decision: decision.decision,
      reasons: decision.reasons,
      codes: decision.codes,
    });
    stats.record(decision, firedNames, costMs);

    if (decision.decision === 'ALLOW') {
      logger.debug(`allow ${checkId} ${trade.side} ${trade.symbol} ${trade.quantity}x notional ${trade.notional} account ${trade.accountId}`);
    } else {
      logger.warn(`deny ${checkId} ${trade.side} ${trade.symbol} ${trade.quantity}x notional ${trade.notional} account ${trade.accountId} — ${codes} ${reasons}`);
    }

    return decision;
  }

  return {
    ruleNames,
    /** Screens one trade. Deduplicated by checkKey — see checkLedger.js. */
    evaluate(request) {
      return ledger.screenOnce(request.checkKey, Date.now(), () => screen(request));
    },
  };
}

module.exports = { createFraudCheckService };
