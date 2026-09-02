-- Let a limit order wait for its price.
--
-- Until now a limit the market had not reached was refused. That made the previous
-- change complete on its own, and it is not what a limit order is for: the whole
-- point is to name a price and wait. So an order can now be OPEN — accepted,
-- unfilled, and still live.
--
-- OPEN is the first status that outlives the request that created it, which is why
-- this needs a constraint of its own. FILLED and REJECTED are both terminal and both
-- carry evidence; OPEN is defined by the absence of any. A row that claims to be
-- waiting while carrying a fill price is not a state, it is a bug that has already
-- happened.

ALTER TABLE orders DROP CONSTRAINT orders_status_check;
ALTER TABLE orders ADD CONSTRAINT orders_status_check
  CHECK (status IN ('FILLED', 'REJECTED', 'OPEN'));

-- Waiting means nothing has happened yet, and only a limit order can wait: a market
-- order that could not fill immediately has no price to wait for.
ALTER TABLE orders ADD CONSTRAINT orders_open_is_waiting CHECK (
  status <> 'OPEN'
  OR (type = 'LIMIT'
      AND filled_quantity = 0
      AND fill_price IS NULL
      AND trade_id IS NULL
      AND reject_code IS NULL
      AND resolved_at IS NULL)
);

-- The sweep runs on every market tick and asks the same question each time: which
-- open orders has the tape now reached. A partial index means that question is
-- answered against a handful of rows rather than the whole order history, and stays
-- that way however long the history gets.
CREATE INDEX orders_open_by_symbol_idx ON orders (symbol) WHERE status = 'OPEN';

-- And the reservation queries, which ask what an account has already committed.
CREATE INDEX orders_open_by_account_idx ON orders (account_id, side) WHERE status = 'OPEN';
