/**
 * What an account did BEFORE the trade being screened — an immutable snapshot, taken
 * before the current trade is recorded.
 *
 * That ordering is the point of this existing: a rule asking "is this trade unusual for
 * this account" must ask it of a set that excludes the trade. Passing a snapshot makes
 * the alternative impossible rather than merely discouraged.
 *
 * Observations are oldest first, already trimmed to the retention window. `now` is the
 * evaluation instant (ms epoch), so a rule can express a window without being handed a clock.
 */
function accountHistory(observations, now) {
  const obs = observations.slice(); // defensive copy — a snapshot is a value, not a view

  return {
    now,
    observations: obs,
    size: obs.length,
    isEmpty: obs.length === 0,

    /** How many trades were screened within `windowMs` of now. */
    countWithin(windowMs) {
      const cutoff = now - windowMs;
      let count = 0;
      for (const o of obs) if (o.at > cutoff) count += 1;
      return count;
    },

    /**
     * The account's typical trade size, as a MEDIAN rather than a mean — one huge trade
     * must not drag the baseline far enough that the next outlier looks ordinary.
     * Returns null when there is no history to take one from.
     */
    medianNotional() {
      if (obs.length === 0) return null;
      const sorted = obs.map((o) => o.notional).sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      if (sorted.length % 2 === 1) return sorted[mid];
      return round2((sorted[mid - 1] + sorted[mid]) / 2);
    },

    /** The most recent trade on `symbol`, if this account has traded it. */
    latestOn(symbol) {
      let latest = null;
      for (const o of obs) if (o.symbol === symbol) latest = o; // oldest first, so last wins
      return latest;
    },
  };
}

const round2 = (n) => Math.round(n * 100) / 100;

module.exports = { accountHistory };
