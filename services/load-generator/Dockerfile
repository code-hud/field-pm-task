# syntax=docker/dockerfile:1

# Load generator — a client, not a server. It publishes no port and holds no state;
# everything it needs is Node 22's built-in fetch.
#
# There is no dependency-install stage because there are no dependencies. The stage
# is kept as a named base anyway so that adding one later is an `npm ci` in the right
# place rather than a restructure, and so this reads like services/trading-api.
FROM node:22-alpine AS base
WORKDIR /app
COPY package.json ./

FROM node:22-alpine AS runtime
ENV NODE_ENV=production \
    LOADGEN_HEARTBEAT_FILE=/tmp/loadgen-heartbeat
WORKDIR /app

# dumb-init reaps zombies and forwards SIGTERM, without which `docker stop` would
# take the full grace period and the final summary would never be printed.
RUN apk add --no-cache dumb-init

COPY --from=base /app/package.json ./
COPY src ./src

USER node

# There is no endpoint to probe, so health is "did this process attempt any requests
# in the last few report windows". That stays true while the API is down and the
# users are backing off — which is the generator working, not failing — and goes
# false if the loop wedges.
HEALTHCHECK --interval=60s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "const {statSync}=require('node:fs');const f=process.env.LOADGEN_HEARTBEAT_FILE;const maxAge=3*(Number(process.env.LOADGEN_REPORT_INTERVAL_MS)||30000);process.exit(Date.now()-statSync(f).mtimeMs<maxAge?0:1)"

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "src/main.js"]
