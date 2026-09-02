-- The universe grew from 25 invented issuers to the ~500 real S&P 500 tickers,
-- and the price simulation grew from independent random walks into a factor
-- model. Both need columns 001 did not have.
--
-- Everything here is nullable: 001 is already applied to a live database, and a
-- deploy runs migrations before the seeder repopulates. Rows written by the old
-- seeder stay valid until the next seed fills these in.

ALTER TABLE stocks
  -- GICS sub-industry. Reference data, like sector — the only other field on this
  -- table that describes a real company rather than an invented number.
  ADD COLUMN industry        text,
  -- Factor loadings. Derived from beta and volatility by simulation.js and stored
  -- here so the tick loop reads the same numbers the seeder generated history
  -- with, instead of recomputing them from a formula that could drift.
  ADD COLUMN sector_loading  numeric(6,4),
  ADD COLUMN idio_volatility numeric(6,4),
  -- Permanent per-name drift, annualized. Signed: about half the universe has a
  -- negative one, which is what makes a 1Y screen show losers.
  ADD COLUMN drift_annual    numeric(7,4);

-- The markets table is paged and searched now that it is 500 rows rather than 25.
-- Search is `symbol ILIKE $1 OR name ILIKE $1`, which no btree can serve, but the
-- sector filter and the name sort are both worth an index at this size.
CREATE INDEX IF NOT EXISTS stocks_name_idx ON stocks (name);
