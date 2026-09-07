# Trading Platform

Everything runs locally with Docker.

## Run it

```bash
docker compose up --build
```

The database sets itself up on first boot (~30–60s). Then:

- **App:** http://localhost:8080 — sign in with any username.
- **Traces:** http://localhost:16686

Hitting trouble with setup or machine resources? **Contact us** — don't lose time on it.

## Handy commands

```bash
make up            # start everything
make up-headless   # start without the web UI
make logs          # tail logs
make psql          # a psql shell on the database
make reset         # wipe the database and start fresh
make down          # stop
```
