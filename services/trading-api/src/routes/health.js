const { Router } = require('express');

const { config } = require('../config/index.js');
const { pool } = require('../db/pool.js');
const { marketTicker } = require('../market/ticker.js');

const healthRouter = Router();

/** Liveness — is the process up. Deliberately does not touch the database: a
 *  database blip should not get the container killed and restarted. */
healthRouter.get('/health', (_req, res) =>
  res.json({
    status: 'ok',
    service: config.serviceName,
    version: config.version,
    uptimeSeconds: Math.round(process.uptime()),
  }),
);

/** Readiness — can this replica actually serve: database reachable and seeded. */
healthRouter.get('/ready', async (_req, res) => {
  try {
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM quotes');
    const ready = rows[0].n > 0;
    res.status(ready ? 200 : 503).json({
      status: ready ? 'ready' : 'empty',
      database: 'up',
      instruments: rows[0].n,
      marketWriter: marketTicker.isLeader,
      ticks: marketTicker.tickCount,
    });
  } catch (error) {
    res.status(503).json({ status: 'unavailable', database: 'down', error: error.message });
  }
});

module.exports = { healthRouter };
