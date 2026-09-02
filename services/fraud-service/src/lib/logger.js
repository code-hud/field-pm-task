const { config } = require('../config.js');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[config.logLevel] ?? LEVELS.info;
const tag = `[${config.serviceName}]`;

const at = (level, method) => (...args) => {
  if (LEVELS[level] >= threshold) console[method](tag, ...args);
};

module.exports = {
  logger: {
    debug: at('debug', 'log'),
    info: at('info', 'log'),
    warn: at('warn', 'warn'),
    error: at('error', 'error'),
  },
};
