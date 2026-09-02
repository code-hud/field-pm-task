/**
 * The screener's lifetime tallies, per process. Counters reset on restart.
 */
function createScreeningStats() {
  let checks = 0;
  let allowed = 0;
  let denied = 0;
  let totalCostMs = 0;
  let slowestMs = 0;
  const objectionsByRule = new Map();

  return {
    record(decision, firedRuleNames, costMs) {
      checks += 1;
      if (decision.decision === 'ALLOW') allowed += 1;
      else denied += 1;
      totalCostMs += costMs;
      if (costMs > slowestMs) slowestMs = costMs;
      for (const name of firedRuleNames) {
        objectionsByRule.set(name, (objectionsByRule.get(name) || 0) + 1);
      }
    },

    snapshot(allRuleNames) {
      const perRule = {};
      // Every registered rule appears, including ones that never fired — a zero is a finding.
      for (const name of allRuleNames) perRule[name] = objectionsByRule.get(name) || 0;
      return {
        checks,
        allowed,
        denied,
        denyRate: checks === 0 ? 0 : round2((denied * 100) / checks),
        meanCostMs: checks === 0 ? 0 : round2(totalCostMs / checks),
        slowestMs: round2(slowestMs),
        objectionsByRule: perRule,
      };
    },
  };
}

const round2 = (n) => Math.round(n * 100) / 100;

module.exports = { createScreeningStats };
