-- Keep a record of the order, not just the trade it became.
--
-- Today the two are the same thing: a market order is validated and filled in one
-- transaction, so `trades` answers every question anyone could ask about it. That
-- stops being true the moment an order can exist without having filled — a limit
-- order that has not been reached yet is a real thing the account owns, and there
-- is nowhere to put it.
--
-- So the order gets its own row. This one is a *lifecycle* record, not history:
-- unlike `trades`, a row here is expected to change as the order resolves. That
-- separation is deliberate and load-bearing. `trades` stays append-only and stays
-- the thing the equity curve and the ledger read, so nothing about an order's
-- lifecycle can rewrite what an account is worth on a past session.
--
-- One order, one trade. This venue has no partial fills — an order is filled in
-- full at a single price or not at all — so the link is a column rather than a
-- table. A world with partial fills needs `order_fills` and this constraint set
-- would have to change; it is written to fail loudly rather than quietly permit
-- half-recorded fills in the meantime.

CREATE TABLE orders (
  id              bigserial PRIMARY KEY,
  account_id      text        NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  symbol          text        NOT NULL REFERENCES instruments (symbol),
  side            text        NOT NULL CHECK (side IN ('BUY', 'SELL')),
  -- Only one type exists today. Widening this is a migration, on purpose: a new
  -- order type that reaches the fill path without anyone noticing is exactly the
  -- change that should not be able to happen quietly.
  type            text        NOT NULL CHECK (type IN ('MARKET')),
  quantity        bigint      NOT NULL CHECK (quantity > 0),
  status          text        NOT NULL CHECK (status IN ('FILLED')),
  filled_quantity bigint      NOT NULL DEFAULT 0 CHECK (filled_quantity >= 0),
  -- What it actually went off at. Null until something fills.
  fill_price      numeric(18,4) CHECK (fill_price > 0),
  -- The trade this became. ON DELETE RESTRICT rather than SET NULL: nothing deletes
  -- a trade, and if something ever tries, an order pointing at a fill that no longer
  -- exists is not an improvement over the delete failing.
  trade_id        bigint      REFERENCES trades (id) ON DELETE RESTRICT,
  placed_at       timestamptz NOT NULL DEFAULT now(),
  -- When it stopped being live. Same instant as `placed_at` for a market order,
  -- which is the honest answer rather than an omission.
  resolved_at     timestamptz,

  CONSTRAINT orders_filled_within_quantity CHECK (filled_quantity <= quantity),

  -- What FILLED is required to mean. All of it or none of it, at a price, pointing
  -- at the trade, with a time — so a half-written fill cannot be committed and read
  -- later as a complete one.
  CONSTRAINT orders_filled_is_complete CHECK (
    status <> 'FILLED'
    OR (filled_quantity = quantity
        AND fill_price IS NOT NULL
        AND trade_id IS NOT NULL
        AND resolved_at IS NOT NULL)
  ),

  -- One order per trade. Two orders claiming the same fill would double the account's
  -- apparent activity while the money moved once.
  CONSTRAINT orders_one_per_trade UNIQUE (trade_id)
);

-- The order list asks "this account's orders, newest first".
CREATE INDEX orders_account_placed_idx ON orders (account_id, placed_at DESC);

-- Backfill: every trade already made was an order that filled.
--
-- Unlike the closures in 004, this one is honest to reconstruct. A trade *is* the
-- record of a market order that filled in full at one price, and each of those facts
-- is on the row — nothing is being inferred. The `placed_at` is the fill time, which
-- for a market order is the same instant it was accepted.
INSERT INTO orders (account_id, symbol, side, type, quantity, status,
                    filled_quantity, fill_price, trade_id, placed_at, resolved_at)
SELECT t.account_id, t.symbol, t.side, 'MARKET', t.quantity, 'FILLED',
       t.quantity, t.price, t.id, t.executed_at, t.executed_at
FROM trades t;
