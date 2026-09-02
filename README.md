# Field PM Task — Trading Platform

A small but realistic trading platform, instrumented with **OpenTelemetry** and reporting
to **Honeycomb**. You'll run it locally, watch its traffic, and reason about what the data
does and doesn't tell you. Full instructions are in the assignment you were sent — this
file is just how to get it running.

## Architecture

```
  load-generator ──HTTP──▶ trading-api ──HTTP──▶ fraud-service
   (synthetic users)      (Node/Express)        (Node/Express, in-memory)
                                │
                                │ SQL (pg)
                                ▼
                            Postgres

  trading-api and fraud-service export traces + metrics (OTLP) ──▶ Honeycomb
```

- **trading-api** — auth, portfolios, orders, and a simulated market. Owns the Postgres database.
- **fraud-service** — screens every order before the API fills it. Owns no data.
- **postgres** — the trading API's private store.
- **load-generator** — virtual users that browse and trade, so there's always traffic.

## Setup

You need **Docker** and a free **Honeycomb** account.

1. Sign up at https://www.honeycomb.io (free tier; Gmail works) → **Account → API Keys**
   → create an **ingest key**.
2. Configure the stack:
   ```bash
   cp .env.example .env
   # edit .env: paste your key into OTEL_EXPORTER_OTLP_HEADERS (x-honeycomb-team=...)
   ```
3. Start it:
   ```bash
   make up            # full stack + UI at http://localhost:8080
   # or: docker compose up --build
   ```
   The database migrates and seeds itself on first boot (~30–60s).

Within a minute or two you should see `trading-api` and `fraud-service` in Honeycomb
(each service is its own dataset), with traces for the order flow.

Running low on resources or hitting setup trouble? **Contact us** — don't lose time on it.

## Handy commands

```bash
make up-headless     # everything except the web UI
make logs            # tail all services
make loadgen-logs    # watch the synthetic traffic
make psql            # a psql shell on the database
make reset           # wipe the database and re-seed
make down            # stop
```

## Ports

| Service | URL |
|---|---|
| Web UI | http://localhost:8080 |
| trading-api | http://localhost:4000 (`/health`) |
| fraud-service | http://localhost:4100 (`/health`, `/fraud/stats`) |
| Postgres | localhost:5432 (`headsup` / `headsup`) |

## Notes

- Sign in to the UI with any username; the portfolio is generated from it.
- **Real tickers, invented prices.** Everything about the market is simulated.
- Each service is instrumented with OpenTelemetry auto-instrumentation (HTTP, Express,
  `pg`). The wiring is in `docker-compose.yml` (the `OTEL_*` variables) — no code to read
  to see how telemetry is turned on.
