-- Limit orders, at the schema level.
--
-- A limit order carries one promise: it will not fill at a worse price than the one
-- the customer named. This migration makes that promise something the database
-- enforces rather than something the fill path is trusted to remember.
--
-- The constraint below is the point of this file. Everything else here is columns.

ALTER TABLE orders DROP CONSTRAINT orders_type_check;
ALTER TABLE orders ADD CONSTRAINT orders_type_check
  CHECK (type IN ('MARKET', 'LIMIT'));

-- The price the customer named. Four decimals, the same precision quotes carry, so
-- a limit can name any price a quote can reach.
ALTER TABLE orders ADD COLUMN limit_price numeric(18,4)
  CONSTRAINT orders_limit_price_positive CHECK (limit_price > 0);

-- Exactly the LIMIT orders have one. A market order with a limit price would raise
-- the obvious question of whether it was honoured, and a limit order without one is
-- a market order wearing the wrong name.
ALTER TABLE orders ADD CONSTRAINT orders_limit_price_matches_type CHECK (
  (type = 'LIMIT') = (limit_price IS NOT NULL)
);

-- The promise itself. A filled buy limit cannot have paid more than its limit; a
-- filled sell limit cannot have taken less.
--
-- This duplicates a check the fill path already makes, deliberately. The fill path
-- is where the bug would be — a comparison inverted, a check moved outside the
-- transaction and racing the tape — and a duplicated check is only redundant while
-- both are right. This one fails the write rather than the account.
ALTER TABLE orders ADD CONSTRAINT orders_fill_respects_limit CHECK (
  status <> 'FILLED'
  OR type <> 'LIMIT'
  OR (side = 'BUY'  AND fill_price <= limit_price)
  OR (side = 'SELL' AND fill_price >= limit_price)
);
