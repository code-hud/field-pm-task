const { config } = require('../config.js');
const { accountHistory } = require('./accountHistory.js');

/**
 * The in-memory store of recent screened trades per account, in this process.
 *
 * This service deliberately has no database — the trading API owns the ledger, and asking
 * it for history on the way into every fill would put a second network hop inside the
 * screening call it is already waiting on. So the screener keeps its own short, bounded
 * memory. Consequences: a restart forgets (the rules that need a baseline stand down until
 * one is rebuilt); a second replica would halve it; it is bounded, not complete.
 *
 * A JS Map preserves insertion order; we approximate access-order LRU by re-inserting a
 * key whenever it is touched, so eviction of the least-recently-used account is a single
 * step from the front.
 */
function createActivityLog() {
  const { retentionMs, maxAccounts, maxTradesPerAccount } = config.history;
  /** @type {Map<string, Array<import('./tradeObservation').tradeObservation>>} */
  const byAccount = new Map();

  const touch = (accountId, trades) => {
    byAccount.delete(accountId);
    byAccount.set(accountId, trades);
  };

  return {
    /**
     * What this account did before `now`, trimmed to the retention window. Never throws
     * for an unknown account — "no history" is the common case, not an error.
     */
    snapshot(accountId, now) {
      const trades = byAccount.get(accountId);
      if (!trades || trades.length === 0) return accountHistory([], now);

      const cutoff = now - retentionMs;
      const live = trades.filter((o) => o.at > cutoff);
      touch(accountId, trades); // a read counts as use
      return accountHistory(live, now);
    },

    /**
     * Remembers a screened trade, evicting whatever no longer fits. Called after the
     * decision, whatever it was — including denials, because the attempt rate is the thing
     * velocity screening exists to measure.
     */
    record(accountId, observation) {
      const cutoff = observation.at - retentionMs;
      let trades = byAccount.get(accountId);
      if (!trades) trades = [];
      trades.push(observation);

      // Oldest first, so expiry and the size cap are both a drop from the front.
      while (trades.length > 0 && trades[0].at <= cutoff) trades.shift();
      while (trades.length > maxTradesPerAccount) trades.shift();

      touch(accountId, trades);

      // Evict least-recently-used accounts beyond the cap.
      while (byAccount.size > maxAccounts) {
        const oldest = byAccount.keys().next().value;
        byAccount.delete(oldest);
      }
    },

    /** Accounts currently held. For diagnostics and GET /fraud/stats. */
    accountsTracked() {
      return byAccount.size;
    },

    /** Forgets everything. Used by tests that need a known starting state. */
    clear() {
      byAccount.clear();
    },
  };
}

module.exports = { createActivityLog };
