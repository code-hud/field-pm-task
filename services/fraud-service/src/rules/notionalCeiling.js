const { config } = require('../config.js');
const { money } = require('../lib/format.js');

/**
 * A hard ceiling on a single trade, regardless of who placed it or what they usually do.
 * The only rule that needs no history — the floor under the others, and the one that
 * still applies to a brand-new account with no baseline.
 */
const limit = config.notionalCeiling.limit;

module.exports = {
  name: 'notional-ceiling',
  code: 'NOTIONAL_CEILING',
  evaluate(trade /* , history */) {
    if (trade.notional <= limit) return null;
    return `order value ${money(trade.notional)} is above the ${money(limit)} single-order limit`;
  },
};
