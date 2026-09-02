-- Heads Up Financial — initial schema.
--
-- Two halves that meet only at `symbol`:
--   reference + market data (instruments, daily_bars, intraday_bars, quotes)
--   customer data          (accounts, positions, lots, dividends)
--
-- Prices and money are `numeric` — exact decimal, no float rounding in a ledger.
-- Share counts and volumes are bigint.

-- ---------------------------------------------------------------- market data

CREATE TABLE instruments (
  symbol              text PRIMARY KEY,
  name                text        NOT NULL,
  sector              text        NOT NULL,
  currency            text        NOT NULL DEFAULT 'USD',
  exchange            text        NOT NULL DEFAULT 'DEMO',
  base_price          numeric(18,4) NOT NULL CHECK (base_price > 0),
  volatility          numeric(6,4)  NOT NULL CHECK (volatility > 0),
  avg_volume          bigint      NOT NULL CHECK (avg_volume > 0),
  market_cap_b        numeric(12,2) NOT NULL,
  beta                numeric(6,2)  NOT NULL,
  -- Null is meaningful: a company with no earnings has no P/E.
  pe_ratio            numeric(8,2),
  dividend_yield      numeric(6,4)  NOT NULL DEFAULT 0,
  -- Rolled up from daily_bars at seed time so the quote read stays a single scan.
  fifty_two_week_high numeric(18,4),
  fifty_two_week_low  numeric(18,4)
);

CREATE INDEX instruments_sector_idx ON instruments (sector);

-- One row per symbol per trading session. The equity curve joins against this.
CREATE TABLE daily_bars (
  symbol       text        NOT NULL REFERENCES instruments (symbol) ON DELETE CASCADE,
  session_date date        NOT NULL,
  open         numeric(18,4) NOT NULL,
  high         numeric(18,4) NOT NULL,
  low          numeric(18,4) NOT NULL,
  close        numeric(18,4) NOT NULL,
  volume       bigint      NOT NULL,
  PRIMARY KEY (symbol, session_date)
);

-- Supports "every session in this window", which drives the equity curve.
CREATE INDEX daily_bars_session_date_idx ON daily_bars (session_date);

-- Current session only, one row per minute. `minute` is minutes since the 09:30 ET
-- open, so 0..389 for a regular session.
CREATE TABLE intraday_bars (
  symbol       text     NOT NULL REFERENCES instruments (symbol) ON DELETE CASCADE,
  session_date date     NOT NULL,
  minute       smallint NOT NULL CHECK (minute >= 0),
  open         numeric(18,4) NOT NULL,
  high         numeric(18,4) NOT NULL,
  low          numeric(18,4) NOT NULL,
  close        numeric(18,4) NOT NULL,
  volume       bigint   NOT NULL DEFAULT 0,
  PRIMARY KEY (symbol, session_date, minute)
);

-- The live tape: exactly one row per instrument, rewritten by the tick loop.
CREATE TABLE quotes (
  symbol         text PRIMARY KEY REFERENCES instruments (symbol) ON DELETE CASCADE,
  price          numeric(18,4) NOT NULL CHECK (price > 0),
  open           numeric(18,4) NOT NULL,
  previous_close numeric(18,4) NOT NULL CHECK (previous_close > 0),
  day_high       numeric(18,4) NOT NULL,
  day_low        numeric(18,4) NOT NULL,
  volume         bigint      NOT NULL DEFAULT 0,
  session_date   date        NOT NULL,
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- customers

CREATE TABLE accounts (
  id             text PRIMARY KEY,
  -- Case-insensitive: the same person typing "Dan" or "dan" gets one account.
  username       text        NOT NULL,
  username_key   text        NOT NULL UNIQUE,
  display_name   text        NOT NULL,
  email          text        NOT NULL,
  account_number text        NOT NULL,
  account_type   text        NOT NULL,
  risk_profile   text        NOT NULL,
  advisor        text        NOT NULL,
  member_since   date        NOT NULL,
  base_currency  text        NOT NULL DEFAULT 'USD',
  cash           numeric(18,2) NOT NULL DEFAULT 0,
  -- What was deposited to open the account, before any buying.
  funded_amount  numeric(18,2) NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE positions (
  id         bigserial PRIMARY KEY,
  account_id text NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  symbol     text NOT NULL REFERENCES instruments (symbol),
  opened_at  date NOT NULL,
  UNIQUE (account_id, symbol)
);

CREATE INDEX positions_account_idx ON positions (account_id);

-- Individual buys. Quantity and average cost are derived from these, never stored
-- alongside them — one source of truth, so they cannot disagree.
CREATE TABLE lots (
  id          bigserial PRIMARY KEY,
  position_id bigint      NOT NULL REFERENCES positions (id) ON DELETE CASCADE,
  trade_date  date        NOT NULL,
  quantity    bigint      NOT NULL CHECK (quantity > 0),
  price       numeric(18,4) NOT NULL CHECK (price > 0)
);

CREATE INDEX lots_position_idx ON lots (position_id);
-- The equity curve filters lots by "opened on or before this session".
CREATE INDEX lots_trade_date_idx ON lots (trade_date);

CREATE TABLE dividends (
  id         bigserial PRIMARY KEY,
  account_id text NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  symbol     text NOT NULL REFERENCES instruments (symbol),
  pay_date   date NOT NULL,
  amount     numeric(18,2) NOT NULL CHECK (amount > 0)
);

CREATE INDEX dividends_account_date_idx ON dividends (account_id, pay_date);
