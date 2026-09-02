-- Record which lots a sale closed.
--
-- `trades.realized_pnl` says a sale made $412.60. It does not say what was sold:
-- which purchases were consumed, what each cost, or how long the shares were held.
-- Every question a tax lot statement or a per-symbol performance breakdown asks is
-- about those, and none of them can be answered after the fact — FIFO consumption
-- order is not recoverable from `lots.closed_quantity`, which is a running total
-- with no history of its own.
--
-- So the fill records it, one row per (sale, lot) pair, in the same transaction as
-- the trade. These rows follow the same rule `trades` does: written once, never
-- updated, never deleted. Anything that reads them is reading history.
--
-- They are redundant with `lots.closed_quantity` by construction. That is what the
-- constraints below are for rather than something to apologise for: a closure that
-- disagrees with the lot it claims to have closed is a bug, and the database is the
-- cheapest place to catch it.

CREATE TABLE lot_closures (
  id           bigserial PRIMARY KEY,
  -- The sale. ON DELETE CASCADE for schema tidiness only; nothing deletes a trade.
  trade_id     bigint      NOT NULL REFERENCES trades (id) ON DELETE CASCADE,
  -- The purchase whose shares were sold.
  lot_id       bigint      NOT NULL REFERENCES lots (id) ON DELETE CASCADE,
  -- Denormalised from the trade so the breakdown can aggregate without joining
  -- three tables to reach a symbol. Both are immutable on the parent rows, so
  -- there is nothing here that can go stale.
  account_id   text        NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  symbol       text        NOT NULL REFERENCES stocks (symbol),
  quantity     bigint      NOT NULL CHECK (quantity > 0),
  -- What the shares cost when bought, and what they fetched. Both at the lot's
  -- precision, so `quantity * (sale_price - cost_price)` reproduces the gain
  -- before rounding.
  cost_price   numeric(18,4) NOT NULL CHECK (cost_price > 0),
  sale_price   numeric(18,4) NOT NULL CHECK (sale_price > 0),
  opened_on    date        NOT NULL,
  closed_on    date        NOT NULL,
  -- Signed: a loss is a negative number, not an absolute value with a flag.
  realized_pnl numeric(18,2) NOT NULL,

  -- The FIFO loop takes each lot at most once per sale, so a second row for the
  -- same pair would mean the same shares were closed twice.
  CONSTRAINT lot_closures_one_row_per_lot_per_sale UNIQUE (trade_id, lot_id),
  -- Shares cannot be sold before they were bought. Guards a clock going backwards
  -- and a mis-joined lot alike.
  CONSTRAINT lot_closures_closed_on_or_after_open CHECK (closed_on >= opened_on)
);

-- The breakdown asks "everything this account closed, by symbol, newest first".
CREATE INDEX lot_closures_account_symbol_idx ON lot_closures (account_id, symbol, closed_on DESC);

-- No backfill, deliberately.
--
-- A SELL that happened before this migration consumed lots in an order that was
-- never written down, so there is no honest way to reconstruct which purchases it
-- closed. Inventing an attribution would be worse than admitting the gap: the
-- totals would look complete and be fiction.
--
-- What this means for readers: `trades.realized_pnl` remains the authority on how
-- much an account has realized, and stays complete for all time. `lot_closures`
-- explains the part of it that happened after this migration. Anything reporting
-- from the closures has to say how much realized P/L it could not attribute — see
-- the breakdown endpoint, which does.
