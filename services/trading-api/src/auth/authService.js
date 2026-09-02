const jwt = require('jsonwebtoken');

const { config } = require('../config/index.js');
const { createRng, hashString, pick, randomInt } = require('../lib/random.js');

const ACCOUNT_TYPES = ['Individual', 'Individual Margin', 'Roth IRA', 'Joint Taxable'];
const RISK_PROFILES = ['Conservative', 'Moderate', 'Growth', 'Aggressive Growth'];
const ADVISORS = ['R. Okonjo', 'M. Delacroix', 'S. Haverford', 'T. Lindqvist', 'A. Mensah'];

const USERNAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,63}$/;

class AuthError extends Error {
  constructor(message, { status = 401, code = 'unauthorized' } = {}) {
    super(message);
    this.name = 'AuthError';
    this.status = status;
    this.code = code;
  }
}

const titleCase = (word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();

/** "ada.lovelace" / "ada_lovelace" / "ada@demo.io" -> "Ada Lovelace" */
function displayNameFor(username) {
  const local = username.split('@')[0];
  const parts = local.split(/[._-]+/).filter(Boolean);
  return parts.map(titleCase).join(' ') || titleCase(local);
}

/**
 * Builds the account profile for a username. Deterministic: the same username
 * always resolves to the same account, so demos are repeatable.
 */
function buildUser(username) {
  const normalized = username.trim();
  const seed = hashString(normalized.toLowerCase());
  const rng = createRng(seed);

  const memberSince = new Date(Date.UTC(randomInt(rng, 2013, 2023), randomInt(rng, 0, 11), randomInt(rng, 1, 28)));

  return {
    id: `usr_${seed.toString(36)}`,
    username: normalized,
    displayName: displayNameFor(normalized),
    // .example is the reserved TLD — these addresses can never resolve or receive mail.
    email: normalized.includes('@') ? normalized : `${normalized.toLowerCase()}@headsupfinancial.example`,
    accountNumber: `DX-${String(seed % 100000).padStart(5, '0')}-${String(randomInt(rng, 100, 999))}`,
    accountType: pick(rng, ACCOUNT_TYPES),
    riskProfile: pick(rng, RISK_PROFILES),
    advisor: pick(rng, ADVISORS),
    memberSince: memberSince.toISOString().slice(0, 10),
  };
}

/**
 * Demo credentials policy: any username is valid, and the password only has to be
 * non-blank. Deliberately permissive — there are no stored credentials to check
 * against. The account itself is created on first sign-in.
 */
async function login({ username, password }) {
  if (typeof username !== 'string' || username.trim() === '') {
    throw new AuthError('Username is required.', { status: 400, code: 'username_required' });
  }
  if (typeof password !== 'string' || password.trim() === '') {
    throw new AuthError('Password is required.', { status: 400, code: 'password_required' });
  }
  if (!USERNAME_PATTERN.test(username.trim())) {
    throw new AuthError('Username may only contain letters, numbers, and . _ - @', {
      status: 400,
      code: 'username_invalid',
    });
  }

  // Imported lazily: accountRepository imports this module for buildUser, and a
  // static import both ways is a cycle.
  const { findOrCreateAccount } = require('../accounts/accountRepository.js');
  const user = await findOrCreateAccount(username.trim());

  const token = jwt.sign({ sub: user.id, username: user.username }, config.auth.jwtSecret, {
    expiresIn: config.auth.jwtExpiresIn,
    issuer: config.auth.issuer,
  });

  return { token, user, expiresIn: config.auth.jwtExpiresIn };
}

/**
 * Resolves the bearer token to the stored account. Reads the database rather than
 * regenerating the identity, so an account edited in the database is reflected.
 */
async function verifyToken(token) {
  let payload;
  try {
    payload = jwt.verify(token, config.auth.jwtSecret, { issuer: config.auth.issuer });
  } catch (error) {
    const expired = error?.name === 'TokenExpiredError';
    throw new AuthError(expired ? 'Session expired. Please sign in again.' : 'Invalid session token.', {
      code: expired ? 'token_expired' : 'token_invalid',
    });
  }

  const { findAccountById } = require('../accounts/accountRepository.js');
  const user = await findAccountById(payload.sub);

  // A valid token whose account is gone — the database was reset under a live
  // session. Treat it as expired so the client signs in again and re-creates it.
  if (!user) {
    throw new AuthError('Session no longer valid. Please sign in again.', { code: 'account_missing' });
  }

  return user;
}

module.exports = { AuthError, buildUser, login, verifyToken };
