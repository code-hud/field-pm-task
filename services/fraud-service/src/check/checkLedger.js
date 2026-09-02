const { config } = require('../config.js');

/**
 * Screens a trade once, however many times the caller asks.
 *
 * This exists because of a real defect, not a hypothetical: the trading API retries a
 * check up to three times on any thrown error, and this service records the trade in its
 * history window before it answers. So a check completed but whose response the caller
 * could not read (a timeout, a reset) used to be recorded once per attempt — and
 * trade-velocity counts attempts on purpose, so one order could consume three of the ten
 * slots in its own velocity window and get the account refused.
 *
 * The screening work here is synchronous, so this is a completed-decision cache keyed by
 * the caller's `checkKey`, with a TTL and a bound. A retry that arrives within the TTL
 * gets the first attempt's decision back without re-screening — and therefore without
 * recording the trade a second time.
 *
 * What this does not cover: two replicas. Retries can land on different instances and this
 * ledger is per-process, the same limitation the in-memory history store has.
 */
function createCheckLedger() {
  const { enabled, ttlMs, maxKeys } = config.dedupe;
  /** @type {Map<string, {decision: object, startedAt: number}>} */
  const entries = new Map();

  const expired = (entry, now) => entry.startedAt + ttlMs < now;

  return {
    /**
     * Runs `work` for this key, or returns what a previous call for the same key produced.
     * A missing or blank key means no deduplication — the caller has not asked for it, and
     * inventing one from the trade's fields would collapse two genuinely separate orders.
     */
    screenOnce(key, now, work) {
      if (!enabled || !key) return work();

      const found = entries.get(key);
      if (found && !expired(found, now)) {
        entries.delete(key); // access-order bump
        entries.set(key, found);
        return found.decision;
      }

      const decision = work(); // throws propagate; a failed check does not poison the key
      entries.set(key, { decision, startedAt: now });
      while (entries.size > maxKeys) entries.delete(entries.keys().next().value);
      return decision;
    },

    size() {
      return entries.size;
    },
    clear() {
      entries.clear();
    },
  };
}

module.exports = { createCheckLedger };
