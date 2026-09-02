# Field PM Task — Trading Platform

A small but realistic trading platform, instrumented with **OpenTelemetry** and reporting
to a local **Jaeger** that starts with the stack. You'll run it locally, watch its traffic,
and reason about what the data does and doesn't tell you. Full instructions are in the
assignment you were sent — this file is just how to get it running.

## Architecture

```
  load-generator ──HTTP──▶ trading-api ──HTTP──▶ fraud-service
   (synthetic users)      (Node/Express)        (Node/Express, in-memory)
                                │
                                │ SQL (pg)
                                ▼
                            Postgres

  trading-api and fraud-service export traces (OTLP) ──▶ Jaeger (local, :16686)
                                                     └──▶ Honeycomb (optional, with a key)
```

- **trading-api** — auth, portfolios, orders, and a simulated market. Owns the Postgres database.
- **fraud-service** — screens every order before the API fills it. Owns no data.
- **postgres** — the trading API's private store.
- **load-generator** — virtual users that browse and trade, so there's always traffic.

## Setup

You need **Docker** — that's it to start.

```bash
make up            # full stack + UI at http://localhost:8080
# or: docker compose up --build
```

The database migrates and seeds itself on first boot (~30–60s).

**Jaeger (always on, no signup):** open **http://localhost:16686**, pick the `trading-api`
service and **Find Traces**. Click a trace for the waterfall — the HTTP request, its call to
`fraud-service`, and the `pg` query spans underneath.

**Honeycomb (optional second view):** sign up free at https://www.honeycomb.io (Gmail
works), create an ingest key, then:

```bash
cp .env.example .env
# set HONEYCOMB_API_KEY in .env, then:
docker compose up -d
```

The same traces now appear in Honeycomb too. Jaeger keeps working either way.

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
| Jaeger (traces) | http://localhost:16686 |
| trading-api | http://localhost:4000 (`/health`) |
| fraud-service | http://localhost:4100 (`/health`, `/fraud/stats`) |
| Postgres | localhost:5432 (`headsup` / `headsup`) |

## Notes

- Sign in to the UI with any username; the portfolio is generated from it.
- **Real tickers, invented prices.** Everything about the market is simulated.
- Each service is instrumented with OpenTelemetry auto-instrumentation (HTTP, Express,
  `pg`). The wiring is in `docker-compose.yml` (the `OTEL_*` variables) and `otel.js` in
  each service — nothing in the app code turns telemetry on.
- Traces always go to the bundled Jaeger, and *also* to Honeycomb when `HONEYCOMB_API_KEY`
  is set in `.env`. The fan-out lives in each service's `otel.js`.
