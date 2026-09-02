const { AuthError, verifyToken } = require('../auth/authService.js');
const { setContext } = require('../observability/telemetry.js');

/** Attaches `req.user` from the Bearer token, or fails with 401. */
async function requireAuth(req, _res, next) {
  const header = req.get('authorization') ?? '';
  const [scheme, token] = header.split(' ');

  if (scheme?.toLowerCase() !== 'bearer' || !token) {
    return next(new AuthError('Missing bearer token.', { code: 'token_missing' }));
  }

  try {
    req.user = await verifyToken(token);
    // The only point in the request where the account is known. Portfolios are
    // generated per username and vary a lot in size, so "which user" is usually the
    // first question asked of a slow authenticated request.
    setContext({ username: req.user.username });
    return next();
  } catch (error) {
    return next(error);
  }
}

module.exports = { requireAuth };
