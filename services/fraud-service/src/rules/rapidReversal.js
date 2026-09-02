const { config } = require('../config.js');

/**
 * Buying and selling the same instrument within seconds. Round-tripping that fast is not
 * investing — the benign version is a fat-fingered order being undone; the versions worth
 * catching are churning for commission and trading against yourself to print a price.
 * Flags the shape, not intent.
 */
const { windowMs } = config.rapidReversal;

module.exports = {
  name: 'rapid-reversal',
  code: 'RAPID_REVERSAL',
  evaluate(trade, history) {
    const cutoff = history.now - windowMs;
    const opposite = history.latestOn(trade.symbol);
    if (!opposite || !opposite.isReversalOf(trade) || opposite.at <= cutoff) return null;

    const secondsAgo = Math.floor((history.now - opposite.at) / 1000);
    const when = secondsAgo < 1 ? 'less than a second ago' : `${secondsAgo} seconds ago`;
    return `${trade.side} ${trade.symbol} reverses a ${opposite.side} on the same instrument ${when}`;
  },
};
