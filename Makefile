# Thin wrapper over docker compose. `make help` lists everything.
.DEFAULT_GOAL := help
COMPOSE := docker compose

.PHONY: help up up-headless down logs ps seed reset psql loadgen-logs

help: ## Show this help
	@grep -E '^[a-zA-Z0-9_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}'

up: ## Start the whole stack + UI (build if needed), http://localhost:8080
	$(COMPOSE) up -d --build

up-headless: ## Start everything except the web UI
	$(COMPOSE) up -d --build --scale web=0

down: ## Stop the stack (keeps the database volume)
	$(COMPOSE) down

reset: ## Stop and wipe the database volume, then start fresh (re-seeds)
	$(COMPOSE) down -v
	$(COMPOSE) up -d --build

logs: ## Tail logs for every service
	$(COMPOSE) logs -f

ps: ## Show stack status
	$(COMPOSE) ps

loadgen-logs: ## Tail the load generator's traffic summaries
	$(COMPOSE) logs -f load-generator

psql: ## Open a psql shell on the demo database
	$(COMPOSE) exec postgres psql -U headsup -d headsup

seed: ## Re-run the seed explicitly (safe; only fills an empty database)
	$(COMPOSE) exec trading-api node src/db/seed.js
