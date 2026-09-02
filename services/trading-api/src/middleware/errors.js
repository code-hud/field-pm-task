const { config } = require('../config/index.js');

class ApiError extends Error {
  constructor(message, { status = 400, code = 'bad_request' } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

const notFound = (req, _res, next) =>
  next(new ApiError(`No route for ${req.method} ${req.originalUrl}`, { status: 404, code: 'not_found' }));

/* eslint-disable-next-line no-unused-vars -- Express identifies error handlers by arity. */
function errorHandler(error, req, res, next) {
  const status = Number.isInteger(error?.status) ? error.status : 500;

  if (status >= 500) {
    console.error(`[${config.serviceName}] ${req.method} ${req.originalUrl} failed`, error);
  }

  res.status(status).json({
    error: {
      code: error?.code ?? 'internal_error',
      message: status >= 500 && config.env === 'production' ? 'Internal server error.' : error.message,
    },
  });
}

module.exports = { ApiError, errorHandler, notFound };
