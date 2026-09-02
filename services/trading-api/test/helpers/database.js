/**
 * Test database lifecycle.
 *
 * The suite needs a real Postgres — these tests exist to check SQL, so a fake
 * would verify nothing. It creates its own throwaway database, seeds it, and drops
 * it at the end, so running tests can never touch the demo data you are looking at
 * in the browser.
 *
 * Point it at a server with TEST_DATABASE_URL (or DATABASE_URL); `make test` starts
 * the compose postgres if it isn't already up.
 */
const pg = require('pg');

const BASE_URL =
  process.env.TEST_DATABASE_URL ??
  process.env.DATABASE_URL ??
  'postgres://headsup:headsup@localhost:5432/headsup';

/** A unique name per run, so parallel runs and leftovers never collide. */
const testDatabaseName = () =>
  `headsup_test_${process.pid}_${Date.now().toString(36)}`.toLowerCase().slice(0, 60);

const adminUrl = (url) => {
  const parsed = new URL(url);
  // Connect to the always-present maintenance database to issue CREATE/DROP.
  parsed.pathname = '/postgres';
  return parsed.toString();
};

const withDatabase = (url, name) => {
  const parsed = new URL(url);
  parsed.pathname = `/${name}`;
  return parsed.toString();
};

async function createTestDatabase() {
  const name = testDatabaseName();
  const admin = new pg.Client({ connectionString: adminUrl(BASE_URL) });

  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();

  const url = withDatabase(BASE_URL, name);
  // The app reads config at import time, so this must be set before importing it.
  process.env.DATABASE_URL = url;
  return { name, url };
}

async function dropTestDatabase(name) {
  const admin = new pg.Client({ connectionString: adminUrl(BASE_URL) });
  await admin.connect();
  // Terminate stragglers first, or DROP blocks on any lingering session.
  await admin.query(
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
     WHERE datname = $1 AND pid <> pg_backend_pid()`,
    [name],
  );
  await admin.query(`DROP DATABASE IF EXISTS ${name}`);
  await admin.end();
}

/** True if a Postgres server is reachable at all — used to fail with a clear message. */
async function databaseIsReachable() {
  const client = new pg.Client({ connectionString: adminUrl(BASE_URL), connectionTimeoutMillis: 2000 });
  try {
    await client.connect();
    await client.end();
    return true;
  } catch {
    return false;
  }
}

const baseUrlForMessages = () => {
  try {
    const parsed = new URL(BASE_URL);
    if (parsed.password) parsed.password = '***';
    return parsed.toString();
  } catch {
    return BASE_URL;
  }
};

module.exports = { createTestDatabase, dropTestDatabase, databaseIsReachable, baseUrlForMessages };
