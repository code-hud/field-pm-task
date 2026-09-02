# syntax=docker/dockerfile:1

# Trading API — self-contained image. Its only runtime dependency is Postgres, reached
# over the network, so the image itself carries no database or cache.
FROM node:22-alpine

WORKDIR /app

# dumb-init reaps zombies and forwards SIGTERM so the graceful shutdown in server.js runs.
RUN apk add --no-cache dumb-init

# Dependencies first, so a source change does not re-install them.
COPY package.json ./
RUN npm install --no-audit --no-fund

COPY src ./src

EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# OpenTelemetry is enabled by NODE_OPTIONS + OTEL_* environment variables set in
# docker-compose.yml (the auto-instrumentations register hook must load before Express and
# pg). With those unset the API runs exactly the same, just without reporting.
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "src/server.js"]
