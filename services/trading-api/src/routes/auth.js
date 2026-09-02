const { Router } = require('express');

const { login } = require('../auth/authService.js');
const { requireAuth } = require('../middleware/requireAuth.js');

const authRouter = Router();

authRouter.post('/login', async (req, res, next) => {
  try {
    const { username, password } = req.body ?? {};
    res.json(await login({ username, password }));
  } catch (error) {
    next(error);
  }
});

// Tokens are stateless, so logout is a client-side concern; the endpoint exists so
// the frontend has one call to make and the demo shows the full round trip.
authRouter.post('/logout', requireAuth, (_req, res) => res.json({ ok: true }));

authRouter.get('/me', requireAuth, (req, res) => res.json({ user: req.user }));

module.exports = { authRouter };
