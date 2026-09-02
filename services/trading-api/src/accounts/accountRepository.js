/**
 * Accounts are created on first sign-in, not pre-registered — any username works,
 * and the account it maps to is generated deterministically from that username.
 * The seed script calls the same code path, so a pre-seeded account and one created
 * by signing in are identical.
 */
const { buildUser } = require('../auth/authService.js');
const { query } = require('../db/pool.js');
const { seedAccount } = require('../db/seed.js');

const toUser = (row) => ({
  id: row.id,
  username: row.username,
  displayName: row.display_name,
  email: row.email,
  accountNumber: row.account_number,
  accountType: row.account_type,
  riskProfile: row.risk_profile,
  advisor: row.advisor,
  memberSince: row.member_since,
});

async function findAccount(username) {
  const { rows } = await query('SELECT * FROM accounts WHERE username_key = $1', [
    username.trim().toLowerCase(),
  ]);
  return rows[0] ? toUser(rows[0]) : null;
}

async function findAccountById(id) {
  const { rows } = await query('SELECT * FROM accounts WHERE id = $1', [id]);
  return rows[0] ? toUser(rows[0]) : null;
}

/**
 * Returns the account for `username`, creating it with a full generated portfolio
 * if this is the first time we have seen it. `seedAccount` is idempotent and
 * conflict-safe, so two simultaneous first logins cannot double-create.
 */
async function findOrCreateAccount(username) {
  const existing = await findAccount(username);
  if (existing) return existing;

  await seedAccount(username);

  const created = await findAccount(username);
  // A race lost to another request still ends with the account present; if it is
  // somehow not, fall back to the generated identity so login does not 500.
  return created ?? buildUser(username);
}

module.exports = { findAccount, findAccountById, findOrCreateAccount };
