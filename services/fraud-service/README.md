# fraud-service

Screens every order the trading API is about to fill. A Node/Express port of the demo's
original Java screener — same four rules, same HTTP contract, same in-memory design.

It owns no database and calls nothing (including back into the API), so it can be
restarted at any time. The trading API screens each order *before* the fill, over HTTP; an
unreachable screener is a logged fail-open, not an error.

## Endpoint

`POST /fraud/checks`

```json
{ "accountId": "…", "symbol": "AAPL", "side": "BUY", "quantity": 100, "price": 190.25, "checkKey": "optional" }
```

Always answers `200` with a decision — the status says whether screening *happened*, not
what it *concluded*:

```json
{ "decision": "ALLOW", "reasons": [], "codes": [], "checkId": "…", "evaluatedAt": "…" }
```

A denial carries one reason and one code per rule that fired.

Other endpoints: `GET /fraud/rules`, `GET /fraud/stats`, `GET /fraud/decisions`,
`GET /health`, `GET /ready`.

## Rules (evaluated in this order, all of them, every time)

| Rule | Code | Fires when |
|---|---|---|
| notional-ceiling | `NOTIONAL_CEILING` | a single order exceeds the absolute limit |
| trade-velocity | `TRADE_VELOCITY` | too many screened orders in the rolling window |
| notional-spike | `NOTIONAL_SPIKE` | an order far larger than this account's own median |
| rapid-reversal | `RAPID_REVERSAL` | the opposite side on the same symbol within seconds |

Thresholds live in `src/config.js` and are all overridable by environment variable.

## Notes

- The screener keeps a **bounded, in-memory** window of recent trades per account. A
  restart forgets it; the backward-looking rules stand down until it is rebuilt. One
  replica is the supported configuration.
- A `checkKey` deduplicates a retried check so a lost response is not screened twice
  (which would double-count the account's velocity). See `src/check/checkLedger.js`.
- Unlike the original, there is **no simulated latency** — a check costs only the few
  in-memory comparisons it actually runs.
