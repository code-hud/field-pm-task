# web

React client for the Heads Up Financial demo. Built with Vite, served by nginx, which also
reverse-proxies `/api/` so the browser only ever talks to one origin.

```bash
npm install
npm run dev            # :5273, proxies /api to localhost:4000
npm run build          # → dist/
```

```bash
docker build -t fpd/web:dev .
docker run --rm -p 8080:8080 -e TRADING_API_URL=http://host.docker.internal:4000 fpd/web:dev
```

## Runtime configuration

The API location is **not** baked into the bundle, so one image serves every environment:

- `TRADING_API_URL` — where nginx proxies `/api/` (server-side, container network).
- `API_BASE_URL` — what the browser calls. `/api` (default) goes through this nginx; an
  absolute URL makes the browser call the API directly, which needs that origin in the
  API's `CORS_ORIGINS`.

`nginx/40-app-config.sh` writes `API_BASE_URL` into `/config.js` at container start;
`public/config.js` holds the dev default.

## Layout

| Path | |
|---|---|
| `src/pages/` | Login, Portfolio, Markets, Instrument detail |
| `src/components/` | app shell, stat tiles, and the hand-built SVG charts |
| `src/context/` | auth session, light/dark theme |
| `src/hooks/useLiveQuery.js` | poll-with-refresh — holds the last render instead of flashing a skeleton |
| `src/api/client.js` | fetch wrapper, token handling, 401 → sign-out |
| `src/styles/tokens.css` | the validated chart palette and design tokens |

Charts are hand-written SVG rather than a charting library, so the mark specs, tooltip
layer, and table-view twins are exact. Every chart has a table view; the palette is
validated for colorblind separation and surface contrast in both light and dark mode.
