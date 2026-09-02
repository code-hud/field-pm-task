-- Make history immutable.
--
-- Before this migration a sale consumed lot rows: `DELETE FROM lots`. Everything
-- historical was reconstructed from the lots that existed *now*, so deleting one
-- silently rewrote the past — a measured sale of a single position moved 222 of 251
-- charted sessions, the largest by $2,559, and shrank the transaction ledger from 20
-- entries to 19. A brokerage whose past statements change when you trade is not one
-- anybody should believe.
--
-- The fix separates two things that were conflated:
--
--   trades  — what happened. Append-only, never updated or deleted. The equity
--             curve and the ledger read from here, so a past session's value is a
--             function of trades on or before that date and cannot move afterwards.
--   lots    — what is still held, for cost basis and FIFO. Rows are no longer
--             deleted; `closed_quantity` records how much of each has been sold.
--             This is mutable on purpose, but nothing historical reads it.

CREATE TABLE trades (
  id           bigserial PRIMARY KEY,
  account_id   text        NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  symbol       text        NOT NULL REFERENCES instruments (symbol),
  side         text        NOT NULL CHECK (side IN ('BUY', 'SELL')),
  quantity     bigint      NOT NULL CHECK (quantity > 0),
  price        numeric(18,4) NOT NULL CHECK (price > 0),
  -- Signed effect on cash: negative for a buy, positive for a sell. Stored rather
  -- than derived so the curve can sum one column instead of branching on side.
  cash_delta   numeric(18,2) NOT NULL,
  -- Proceeds minus the FIFO cost of the shares sold. Null on buys, where the
  -- concept does not apply — not zero, which would claim a flat trade.
  realized_pnl numeric(18,2),
  trade_date   date        NOT NULL,
  executed_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT trades_buy_has_no_realized_pnl
    CHECK ((side = 'BUY' AND realized_pnl IS NULL) OR side = 'SELL'),
  CONSTRAINT trades_cash_delta_sign
    CHECK ((side = 'BUY' AND cash_delta <= 0) OR (side = 'SELL' AND cash_delta >= 0))
);

-- The curve asks "everything this account traded on or before date D", once per
-- session in the window.
CREATE INDEX trades_account_date_idx ON trades (account_id, trade_date);

-- How much of a lot has been sold. Open quantity is `quantity - closed_quantity`;
-- `quantity` keeps its CHECK (> 0) and now means "opened", which never changes.
ALTER TABLE lots
  ADD COLUMN closed_quantity bigint NOT NULL DEFAULT 0
    CONSTRAINT lots_closed_quantity_non_negative CHECK (closed_quantity >= 0);

ALTER TABLE lots
  ADD CONSTRAINT lots_closed_within_opened CHECK (closed_quantity <= quantity);

-- Backfill: every existing lot is a purchase that really happened, so it becomes a
-- BUY trade dated when it opened. Without this the curve would read zero holdings
-- on a database that already has positions — including the deployed demo, where
-- migrations run on boot against live data.
--
-- What cannot be recovered is any sale made before this migration: those lots were
-- deleted, so there is no record left to turn into a SELL. Accounts touched by the
-- old sell path keep a history that is already wrong. Reseeding is the cure, and
-- the demo's data is regenerable by design.
INSERT INTO trades (account_id, symbol, side, quantity, price, cash_delta, trade_date, executed_at)
SELECT p.account_id,
       p.symbol,
       'BUY',
       l.quantity,
       l.price,
       -(l.quantity * l.price),
       l.trade_date,
       l.trade_date::timestamptz
FROM lots l
JOIN positions p ON p.id = l.position_id;
