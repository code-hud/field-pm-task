-- Record the orders that did not fill, and why.
--
-- "Why didn't my order go through" is the question an order history exists to
-- answer, and until now nothing anywhere could. A refusal throws, the fill's
-- transaction rolls back, and the only trace is a 4xx that reached one browser
-- and a log line nobody will read.
--
-- The awkward part, and the reason this is its own migration rather than part of
-- 005: the record has to survive the rollback that is the whole point of the
-- refusal. A row written inside the fill's transaction disappears with it. So the
-- rejection is written afterwards, on a different connection, once the failure has
-- already happened — see `recordRejection` in `src/orders/orderService.js` for what
-- that costs and what it must never be allowed to do.

ALTER TABLE orders DROP CONSTRAINT orders_status_check;
ALTER TABLE orders ADD CONSTRAINT orders_status_check
  CHECK (status IN ('FILLED', 'REJECTED'));

-- The machine-readable reason, and the one a person reads. Both, because they are
-- different jobs: the code is what an order list groups and filters on and is
-- promised not to move, and the message is what makes a single row make sense on
-- its own — "holding 3 NVDA, tried to sell 5" is not derivable from
-- `insufficient_shares`.
ALTER TABLE orders ADD COLUMN reject_code   text;
ALTER TABLE orders ADD COLUMN reject_reason text;

-- What REJECTED is required to mean: nothing filled, no price, no trade, a code,
-- and a time. The mirror of `orders_filled_is_complete`, and for the same reason —
-- a rejected order carrying a fill price would be read as one that traded.
ALTER TABLE orders ADD CONSTRAINT orders_rejected_is_empty CHECK (
  status <> 'REJECTED'
  OR (filled_quantity = 0
      AND fill_price IS NULL
      AND trade_id IS NULL
      AND reject_code IS NOT NULL
      AND resolved_at IS NOT NULL)
);

-- And the other direction: a filled order has no business carrying a refusal.
ALTER TABLE orders ADD CONSTRAINT orders_filled_has_no_reject_code CHECK (
  status <> 'FILLED' OR reject_code IS NULL
);

-- No backfill. Refused orders before this migration left no record of any kind —
-- not a partial one, not a wrong one, none. There is nothing to convert.
