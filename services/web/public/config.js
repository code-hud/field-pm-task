// Runtime config. This default is used in dev and is overwritten inside the
// container at startup by nginx/40-app-config.sh.
window.__APP_CONFIG__ = { apiBaseUrl: '/api' };
