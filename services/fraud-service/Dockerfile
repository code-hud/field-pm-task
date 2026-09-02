FROM node:22-alpine

WORKDIR /app

# Dependencies first, so a source change does not re-install them.
COPY package.json ./
RUN npm install --no-audit --no-fund

COPY src ./src

EXPOSE 4100

# OpenTelemetry is enabled by NODE_OPTIONS + OTEL_* environment variables set in
# docker-compose.yml, so this image is the same whether or not it reports.
CMD ["node", "src/server.js"]
