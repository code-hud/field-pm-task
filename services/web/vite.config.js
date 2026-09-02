import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// In dev, Vite proxies /api to the trading API so the browser only ever talks to
// one origin — the same contract nginx provides in the container image.
export default defineConfig({
  plugins: [react()],
  server: {
    // Not Vite's default 5173: that port is a common target for SSH tunnels and
    // other local dev servers. strictPort makes a collision fail loudly rather
    // than silently drifting to 5174 — a printed URL that doesn't serve the app
    // is worse than a clear error.
    port: 5273,
    strictPort: true,
    proxy: {
      '/api': {
        target: process.env.TRADING_API_URL ?? 'http://localhost:4000',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
