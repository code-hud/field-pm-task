const { readdir, readFile } = require('node:fs/promises');
const { join } = require('node:path');

const { config } = require('../config/index.js');
const { pool, transaction } = require('./pool.js');

const MIGRATIONS_DIR = join(__dirname, 'migrations');

// Any 64-bit constant works; it just has to be the same in every process.
const MIGRATION_LOCK_ID = 918_273_645;

const log = (message) => console.log(`[${config.serviceName}] migrate: ${message}`);

async function ensureMigrationsTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}

const listMigrations = async () =>
  (await readdir(MIGRATIONS_DIR)).filter((file) => file.endsWith('.sql')).sort();

/**
 * Applies pending migrations in filename order, each in its own transaction.
 *
 * Guarded by a session-level advisory lock: several API replicas booting at once
 * would otherwise race to create the same tables. Losers block here, then find
 * nothing pending and continue.
 */
async function migrate() {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);
    await ensureMigrationsTable();

    const { rows } = await pool.query('SELECT version FROM schema_migrations');
    const applied = new Set(rows.map((row) => row.version));
    const files = await listMigrations();
    const pending = files.filter((file) => !applied.has(file));

    if (pending.length === 0) {
      log(`up to date (${applied.size} applied)`);
      return { applied: [] };
    }

    for (const file of pending) {
      const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
      await transaction(async (tx) => {
        await tx.query(sql);
        await tx.query('INSERT INTO schema_migrations (version) VALUES ($1)', [file]);
      });
      log(`applied ${file}`);
    }

    return { applied: pending };
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]).catch(() => {});
    client.release();
  }
}

/**
 * Drops everything this app owns. Used by `seed --reset`; deliberately not exposed
 * anywhere a request can reach it.
 */
async function dropAll() {
  await pool.query(`
    DROP TABLE IF EXISTS
      orders, lot_closures, trades, dividends, lots, positions, accounts,
      quotes, intraday_bars, daily_bars, instruments,
      schema_migrations
    CASCADE
  `);
  log('dropped all tables');
}

module.exports = { migrate, dropAll };
