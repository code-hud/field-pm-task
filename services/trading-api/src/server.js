const { createApp } = require('./app.js');
const { config } = require('./config/index.js');
const { migrate } = require('./db/migrate.js');
const { closePool, waitForDatabase } = require('./db/pool.js');
const { marketDataIsSeeded, seed } = require('./db/seed.js');
const { marketTicker } = require('./market/ticker.js');

/**
 * Boot order matters: the database has to be reachable and migrated before the
 * listener opens, or the first requests hit missing tables.
 *
 * This is a function rather than a run of top-level `await` because the package is
 * CommonJS — see the note in the Dockerfile about `--require`. The listener is
 * assigned to the outer `server` so the signal handlers below can reach it.
 */
let server;

async function main() {
  await waitForDatabase();

  if (config.db.migrateOnBoot) {
    await migrate();
  }

  // Seeding on boot only fills an *empty* database, so restarting a demo never
  // clobbers data. `npm run seed -- --reset` is the explicit way to start over.
  if (config.db.seedOnBoot && !(await marketDataIsSeeded())) {
    console.log(`[${config.serviceName}] empty database — seeding a fresh market.`);
    await seed({ reset: false, force: false, quiet: false, accounts: [], marketSeed: config.market.seed });
  }

  // Exactly one replica drives the simulation; the rest serve reads. See ticker.js.
  await marketTicker.start();

  server = createApp().listen(config.port, config.host, () => {
    console.log(
      `[${config.serviceName}] listening on http://${config.host}:${config.port} ` +
        `(env=${config.env}, writer=${marketTicker.isLeader}, tick=${config.market.tickIntervalMs}ms)`,
    );
  });
}

/** Containers get SIGTERM; drain in-flight requests, then release the database. */
let shuttingDown = false;
const shutdown = (signal) => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[${config.serviceName}] ${signal} received — shutting down.`);

  const forced = setTimeout(() => {
    console.error(`[${config.serviceName}] shutdown timed out — exiting hard.`);
    process.exit(1);
  }, 10_000);
  forced.unref();

  // A signal can arrive while boot is still running, before the listener exists.
  // There is nothing to drain in that case, so release the database and go.
  if (!server) {
    marketTicker
      .stop()
      .catch(() => {})
      .then(() => closePool().catch(() => {}))
      .then(() => process.exit(0));
    return;
  }

  server.close(async () => {
    // Releasing the advisory lock lets another replica take over immediately,
    // instead of waiting for this Postgres session to be reaped.
    await marketTicker.stop();
    await closePool().catch(() => {});
    clearTimeout(forced);
    process.exit(0);
  });

  // `server.close()` stops accepting new connections but waits for existing ones
  // to end on their own. Polling clients and the nginx proxy hold keep-alive
  // sockets open, so without this the callback above never runs and every
  // shutdown hits the force-exit — leaving the writer lock held.
  server.closeIdleConnections();
  setTimeout(() => server.closeAllConnections(), 2000).unref();
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Top-level `await` used to make a failed boot an unhandled rejection, which exits
// non-zero with a stack. Keep that: a container that cannot reach its database must
// die loudly rather than sit there listening to nothing.
main().catch((error) => {
  console.error(`[${config.serviceName}] failed to start:`, error);
  process.exit(1);
});
