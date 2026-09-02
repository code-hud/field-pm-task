-- Let a client retry an order without placing it twice.
--
-- Today a caller that times out on POST /api/orders has no safe move. Retry and it
-- may buy twice; do not retry and it may not have bought at all. There is nginx and
-- Caddy in front of this API and a browser at the end of it, so the timeout is not
-- hypothetical — and every venue solves it the same way.
--
-- The key is the caller's, not ours. A server-generated one would have to be handed
-- back before the risky part, which is the part that might not answer.

ALTER TABLE orders ADD COLUMN client_order_id text
  CONSTRAINT orders_client_order_id_length
    CHECK (client_order_id IS NULL OR length(client_order_id) BETWEEN 1 AND 128);

-- Scoped to the account, so two customers picking the same key are two orders. A
-- global unique index would make one caller's naming collide with another's, which is
-- a cross-account interaction where there should be none.
--
-- Partial, because most orders have no key: every order placed before this migration,
-- and every order from a caller that does not send one. A plain UNIQUE would treat
-- those NULLs as distinct in Postgres and work by accident — the WHERE clause says the
-- intent out loud and keeps the index to the rows that need it.
CREATE UNIQUE INDEX orders_client_order_id_unique
  ON orders (account_id, client_order_id)
  WHERE client_order_id IS NOT NULL;

-- No backfill. An order placed before this existed was not named by anybody, and
-- inventing keys for them would create rows a retry could match against by accident.
