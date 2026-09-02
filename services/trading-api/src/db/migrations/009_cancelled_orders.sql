-- Let an account take an order back.
--
-- An order that can wait indefinitely and cannot be withdrawn is not a feature, it
-- is a trap: the capacity it reserves is held for as long as it rests, and until now
-- the only way to release it was for the tape to arrive.
--
-- CANCELLED is the third terminal status, and the third constraint of the same
-- shape. FILLED carries evidence of a trade, REJECTED carries a reason, OPEN carries
-- neither and has not resolved. CANCELLED has resolved and still carries neither —
-- nothing happened, it simply stopped waiting.

ALTER TABLE orders DROP CONSTRAINT orders_status_check;
ALTER TABLE orders ADD CONSTRAINT orders_status_check
  CHECK (status IN ('FILLED', 'REJECTED', 'OPEN', 'CANCELLED'));

-- Only something that was waiting can be withdrawn, and withdrawing it leaves no
-- trace of a trade. `reject_code` stays null on purpose: a cancellation is a
-- customer changing their mind, not the venue refusing them, and folding the two
-- together would make "why was this refused" unanswerable for both.
ALTER TABLE orders ADD CONSTRAINT orders_cancelled_is_empty CHECK (
  status <> 'CANCELLED'
  OR (type = 'LIMIT'
      AND filled_quantity = 0
      AND fill_price IS NULL
      AND trade_id IS NULL
      AND reject_code IS NULL
      AND resolved_at IS NOT NULL)
);
