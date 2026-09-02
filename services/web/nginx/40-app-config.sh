#!/bin/sh
# Writes the browser-facing runtime config before nginx starts, so the same image
# can point at any trading-api without a rebuild.
set -eu

target="/usr/share/nginx/html/config.js"
api_base_url="${API_BASE_URL:-/api}"

cat > "$target" <<EOF
window.__APP_CONFIG__ = { apiBaseUrl: "${api_base_url}" };
EOF

echo "[web] runtime config: apiBaseUrl=${api_base_url}"
