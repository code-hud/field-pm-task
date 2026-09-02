const { Router } = require('express');

const { ApiError } = require('../middleware/errors.js');
const { requireAuth } = require('../middleware/requireAuth.js');
const {
  getAllocation,
  getEquityCurve,
  getPortfolio,
  getTransactions,
} = require('../portfolio/portfolioService.js');
const { getRealizedBreakdown } = require('../portfolio/realizedService.js');

const portfolioRouter = Router();

const EQUITY_RANGES = new Set(['1M', '3M', '6M', '1Y', 'ALL']);

portfolioRouter.use(requireAuth);

portfolioRouter.get('/', async (req, res, next) => {
  try {
    const portfolio = await getPortfolio(req.user);
    if (!portfolio) {
      throw new ApiError('No account found for this session.', { status: 404, code: 'account_missing' });
    }
    res.json(portfolio);
  } catch (error) {
    next(error);
  }
});

portfolioRouter.get('/allocation', async (req, res, next) => {
  try {
    res.json(await getAllocation(req.user));
  } catch (error) {
    next(error);
  }
});

portfolioRouter.get('/history', async (req, res, next) => {
  try {
    const range = String(req.query.range ?? '3M').toUpperCase();
    if (!EQUITY_RANGES.has(range)) {
      throw new ApiError(`Unsupported range "${range}". Supported: ${[...EQUITY_RANGES].join(', ')}`, {
        status: 400,
        code: 'invalid_range',
      });
    }
    res.json(await getEquityCurve(req.user, range));
  } catch (error) {
    next(error);
  }
});

/**
 * What the account has realized, and on what.
 *
 * No range parameter, unlike /history. Realized P/L is cumulative by nature — it is the
 * money already taken — and a windowed version would report a total that shrinks as
 * time passes, which is not a thing an account's realized gains do.
 */
portfolioRouter.get('/realized', async (req, res, next) => {
  try {
    res.json(await getRealizedBreakdown(req.user));
  } catch (error) {
    next(error);
  }
});

portfolioRouter.get('/transactions', async (req, res, next) => {
  try {
    const parsed = Number.parseInt(req.query.limit ?? '', 10);
    const limit = Number.isFinite(parsed) ? Math.min(Math.max(parsed, 1), 200) : 50;
    res.json(await getTransactions(req.user, { limit }));
  } catch (error) {
    next(error);
  }
});

module.exports = { portfolioRouter };
