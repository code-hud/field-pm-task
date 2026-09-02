/**
 * One trade this service has screened for an account, as remembered afterwards.
 *
 * Smaller than the trade itself: price and quantity are dropped and only the notional
 * is kept, because every backward-looking rule compares money rather than share counts.
 *
 * An observation records that a trade was *screened*, not that it was filled — the API
 * screens before it writes, and a denied trade never becomes a fill. So velocity measured
 * here is the rate a client is *attempting* to trade, which is the right thing to measure.
 */
function tradeObservation({ at, symbol, side, notional }) {
  return {
    at, // ms epoch
    symbol,
    side,
    notional,
    /** True when this trade is the other direction on the same stock. */
    isReversalOf(trade) {
      return this.symbol === trade.symbol && this.side !== trade.side;
    },
  };
}

module.exports = { tradeObservation };
