const cors = require('cors');
const express = require('express');
const morgan = require('morgan');

const { config } = require('./config/index.js');
const { errorHandler, notFound } = require('./middleware/errors.js');
const { setContext, setFailure } = require('./observability/telemetry.js');
const { authRouter } = require('./routes/auth.js');
const { healthRouter } = require('./routes/health.js');
const { marketRouter } = require('./routes/market.js');
const { ordersRouter } = require('./routes/orders.js');
const { portfolioRouter } = require('./routes/portfolio.js');

/**
 * Attributes on the current trace, so a slow or failing sample reads as "this
 * symbol, this range" instead of an anonymous trace. `range=ALL` on the history
 * routes is a materially different query from `range=1M`, and they share an endpoint.
 *
 * This has to run *before* the router that answers the request: a middleware mounted
 * after one never runs, because handlers respond instead of calling next(), and by
 * the time the response finishes the flow has closed. The authenticated user is
 * tagged in requireAuth instead, which is the only place it is known.
 */
const tagFlow = (req, _res, next) => {
  const context = {};
  if (req.params?.symbol) context.symbol = String(req.params.symbol);
  if (typeof req.query?.range === 'string') context.range = req.query.range;
  if (Object.keys(context).length > 0) setContext(context);
  next();
};

/**
 * Express turns anything a handler throws into a JSON response, so the exception is
 * caught long before it reaches the tracer and the span is recorded as handled. Naming the
 * failure gives the error back its identity and a fingerprint to group on. Only 5xx:
 * a 401 or a 404 is the API working, not failing.
 */
/* eslint-disable-next-line no-unused-vars -- Express identifies error handlers by arity. */
const reportFailure = (error, req, res, next) => {
  const status = Number.isInteger(error?.status) ? error.status : 500;
  if (status >= 500) setFailure(`${error?.name ?? 'Error'}: ${error?.message ?? 'unknown'}`);
  next(error);
};

function createApp() {
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', true);
  app.use(morgan(config.logFormat));
  app.use(express.json({ limit: '64kb' }));
  app.use(
    cors({
      origin: config.corsOrigins.includes('*') ? true : config.corsOrigins,
      credentials: false,
    }),
  );

  // Probes live at the root so orchestrators don't need to know the API prefix.
  app.use('/', healthRouter);

  app.get('/api', (_req, res) =>
    res.json({
      service: config.serviceName,
      version: config.version,
      endpoints: [
        'POST /api/auth/login',
        'POST /api/auth/logout',
        'GET  /api/auth/me',
        'GET  /api/market/status',
        'GET  /api/market/stocks',
        'GET  /api/market/stocks/:symbol',
        'GET  /api/market/stocks/:symbol/history?range=1D|5D|1M|3M|1Y',
        'GET  /api/market/movers',
        'GET  /api/market/sectors',
        'GET  /api/portfolio',
        'GET  /api/portfolio/allocation',
        'GET  /api/portfolio/history?range=1M|3M|6M|1Y|ALL',
        'GET  /api/portfolio/transactions?limit=50',
        'POST /api/orders',
      ],
    }),
  );

  app.use(tagFlow);
  // A pattern on `app.use` populates req.params and still falls through, so the
  // symbol lands on the flow before the router that serves it runs.
  app.use('/api/market/stocks/:symbol', tagFlow);

  app.use('/api/auth', authRouter);
  app.use('/api/market', marketRouter);
  app.use('/api/orders', ordersRouter);
  app.use('/api/portfolio', portfolioRouter);

  app.use(notFound);
  app.use(reportFailure);
  app.use(errorHandler);

  return app;
}

module.exports = { createApp };
