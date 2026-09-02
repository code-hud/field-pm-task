# syntax=docker/dockerfile:1

# Web client — built to static assets, then served by nginx. The API location is a
# runtime setting (not baked into the bundle), so one image can be pointed at any
# trading-api deployment.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY index.html vite.config.js ./
COPY public ./public
COPY src ./src
RUN npm run build

FROM nginxinc/nginx-unprivileged:1.27-alpine AS runtime

# TRADING_API_URL: where nginx proxies /api/ (server-side, container network).
# API_BASE_URL: what the browser calls. Leave it as /api to go through this nginx;
# set an absolute URL to have the browser talk to the API directly instead.
ENV TRADING_API_URL=http://trading-api:4000 \
    API_BASE_URL=/api \
    NGINX_PORT=8080

COPY --chown=101:101 --from=build /app/dist /usr/share/nginx/html
# The base image's entrypoint runs envsubst over /etc/nginx/templates/*.template
# and any /docker-entrypoint.d/*.sh before nginx starts.
COPY nginx/default.conf.template /etc/nginx/templates/default.conf.template
COPY --chmod=755 nginx/40-app-config.sh /docker-entrypoint.d/40-app-config.sh

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=3s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://127.0.0.1:8080/healthz || exit 1
