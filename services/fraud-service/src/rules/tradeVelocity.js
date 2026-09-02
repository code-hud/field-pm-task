const { config } = require('../config.js');

/**
 * How fast the account is trading. A person reads a quote, decides, and clicks; something
 * placing a dozen orders a minute is a script, and a compromised session being drained
 * looks exactly like this. Counts screened trades, including ones that were denied — a
 * burst that gets refused should not reset the meter.
 */
const { windowMs, maxTrades } = config.velocity;

module.exports = {
  name: 'trade-velocity',
  code: 'TRADE_VELOCITY',
  evaluate(trade, history) {
    // The count is of PRIOR trades; this one is the (maxTrades + 1)th when it objects.
    const recent = history.countWithin(windowMs);
    if (recent < maxTrades) return null;
    return `${recent + 1} orders in the last ${Math.round(windowMs / 1000)} seconds is faster than this account may trade`;
  },
};
