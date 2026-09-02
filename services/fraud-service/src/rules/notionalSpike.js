const { config } = require('../config.js');
const { money } = require('../lib/format.js');

/**
 * A trade far larger than THIS account's own normal — "unusual for this customer", which
 * is a better question than "large in absolute terms". Three guards keep it from being a
 * nuisance: a median baseline (one outlier must not raise the bar for the next), a minimum
 * history (a third trade is not a baseline), and an absolute floor (a 9x jump from $80 to
 * $700 is not worth blocking).
 */
const { minObservations, multiple, floor } = config.notionalSpike;

module.exports = {
  name: 'notional-spike',
  code: 'NOTIONAL_SPIKE',
  evaluate(trade, history) {
    if (history.size < minObservations) return null;
    if (trade.notional < floor) return null;

    const median = history.medianNotional();
    if (median == null || median <= 0) return null;

    const threshold = median * multiple;
    if (trade.notional <= threshold) return null;

    return `order value ${money(trade.notional)} is more than ${multiple}x this account's recent typical order of ${money(median)}`;
  },
};
