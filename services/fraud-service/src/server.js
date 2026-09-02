const express = require('express');
const { trace } = require('@opentelemetry/api');

const { config } = require('./config.js');
const { logger } = require('./lib/logger.js');
const { createActivityLog } = require('./history/accountActivityLog.js');
const { createCheckLedger } = require('./check/checkLedger.js');
const { createDecisionLog } = require('./audit/decisionLog.js');
const { createScreeningStats } = require('./audit/screeningStats.js');
const { createFraudCheckService } = require('./check/fraudCheckService.js');

const startedAt = Date.now();
const uptimeSeconds = () => Math.round((Date.now() - startedAt) / 1000);

// --- wiring ----------------------------------------------------------------
const activity = createActivityLog();
const ledger = createCheckLedger();
const decisions = createDecisionLog();
const stats = createScreeningStats();
const checks = createFraudCheckService({ activity, ledger, decisions, stats, logger });

logger.info(`${checks.ruleNames().length} fraud rule(s) registered: ${checks.ruleNames().join(', ')}`);

// --- request validation ----------------------------------------------------
function validate(body) {
  const errors = [];
  const s = (v) => (typeof v === 'string' ? v.trim() : '');
  if (!s(body?.accountId)) errors.push('accountId is required');
  if (!s(body?.symbol)) errors.push('symbol is required');
  if (body?.side !== 'BUY' && body?.side !== 'SELL') errors.push('side must be BUY or SELL');
  const q = body?.quantity;
  if (!Number.isInteger(q) || q < 1 || q > 1_000_000) errors.push('quantity must be an integer between 1 and 1000000');
  const p = body?.price;
  if (typeof p !== 'number' || !Number.isFinite(p) || p <= 0) errors.push('price must be a number greater than 0');
  if (body?.checkKey != null && String(body.checkKey).length > 128) errors.push('checkKey must be at most 128 characters');
  return errors;
}

// --- app -------------------------------------------------------------------
const app = express();
app.use(express.json({ limit: '64kb' }));

/**
 * Screens one intended trade. Always 200 with a decision in the body, including a denial:
 * the HTTP status describes whether screening happened, not what it concluded.
 */
app.post('/fraud/checks', (req, res) => {
  const errors = validate(req.body);
  if (errors.length > 0) {
    return res.status(400).json({ error: { code: 'invalid_request', message: errors.join('; ') } });
  }

  const decision = checks.evaluate({
    accountId: req.body.accountId,
    symbol: req.body.symbol,
    side: req.body.side,
    quantity: req.body.quantity,
    price: req.body.price,
    checkKey: req.body.checkKey,
  });

  // Enrich the auto-instrumented HTTP span so "which accounts and symbols get denied" is a
  // question the traces can answer without a log search.
  const span = trace.getActiveSpan();
  if (span) {
    span.setAttribute('fraud.decision', decision.decision);
    span.setAttribute('fraud.symbol', req.body.symbol);
    span.setAttribute('fraud.side', req.body.side);
    if (decision.codes.length > 0) span.setAttribute('fraud.reason_codes', decision.codes.join(','));
  }

  res.json(decision);
});

/** What is currently enforced. */
app.get('/fraud/rules', (_req, res) => res.json({ rules: checks.ruleNames() }));

/** Lifetime tallies and what the screener is holding. */
app.get('/fraud/stats', (_req, res) => {
  res.json({
    uptimeSeconds: uptimeSeconds(),
    screening: stats.snapshot(checks.ruleNames()),
    holding: {
      accountsTracked: activity.accountsTracked(),
      decisionsHeld: decisions.size(),
      decisionsCapacity: decisions.capacity,
      dedupeKeys: ledger.size(),
    },
    note: 'Counters are per-process and reset on restart.',
  });
});

/** The most recent decisions, newest first. */
app.get('/fraud/decisions', (req, res) => {
  const limit = Number.parseInt(req.query.limit ?? '50', 10) || 50;
  res.json({
    enabled: decisions.enabled,
    held: decisions.size(),
    capacity: decisions.capacity,
    offeredSinceStart: decisions.offered(),
    decisions: decisions.recent(limit),
  });
});

app.get('/health', (_req, res) => res.json({ status: 'ok', service: config.serviceName, uptimeSeconds: uptimeSeconds() }));
app.get('/ready', (_req, res) => res.json({ status: 'ready', service: config.serviceName, rules: checks.ruleNames() }));

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  logger.error('unhandled error:', err?.message ?? err);
  res.status(500).json({ error: { code: 'internal_error', message: 'screening failed' } });
});

// --- lifecycle -------------------------------------------------------------
const server = app.listen(config.port, '0.0.0.0', () => {
  logger.info(`fraud-service listening on :${config.port}`);
});

function shutdown(signal) {
  logger.info(`${signal} received, shutting down`);
  server.close(() => process.exit(0));
  // Force-exit if connections do not drain promptly.
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

module.exports = { app };
