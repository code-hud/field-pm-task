const { config } = require('../config.js');

/**
 * A bounded window of the service's most recent decisions, for GET /fraud/decisions.
 * Nothing here changes what gets refused — only what can be asked afterwards.
 */
function createDecisionLog() {
  const { enabled, maxDecisions } = config.audit;
  const buffer = [];
  let offered = 0;

  return {
    enabled,
    capacity: maxDecisions,

    record(record) {
      if (!enabled) return;
      offered += 1;
      buffer.push(record);
      if (buffer.length > maxDecisions) buffer.shift();
    },

    /** Most recent first. */
    recent(limit) {
      const n = Math.min(Math.max(limit, 0), buffer.length);
      return buffer.slice(buffer.length - n).reverse();
    },

    size() {
      return buffer.length;
    },
    offered() {
      return offered;
    },
    clear() {
      buffer.length = 0;
      offered = 0;
    },
  };
}

module.exports = { createDecisionLog };
