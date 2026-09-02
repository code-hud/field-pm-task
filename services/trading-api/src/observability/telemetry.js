/**
 * The application-facing helpers for the boundaries auto-instrumentation cannot see.
 *
 * OpenTelemetry itself is started before this module (and before Express and `pg`) by
 * `--require @opentelemetry/auto-instrumentations-node/register`, configured entirely from
 * OTEL_* environment variables — see docker-compose.yml. That gives us HTTP, Express and
 * `pg` spans for free. This file only exposes the three calls the app makes by hand:
 *
 *   - setContext: attach dimensions to the current span ("this account, this symbol")
 *   - setFailure: record a handled error the span would otherwise show as a success
 *   - wrapFlow:   open a span around work that has no HTTP entry point (the market tick)
 *
 * All three are no-ops when there is no active span, so the app runs unchanged with
 * telemetry switched off.
 */
const { trace, context, SpanStatusCode } = require('@opentelemetry/api');

const tracer = trace.getTracer('trading-api');

/** Attach dimensions to the active span. Values are coerced to attribute-safe scalars. */
function setContext(attributes) {
  const span = trace.getActiveSpan();
  if (!span || !attributes) return;
  for (const [key, value] of Object.entries(attributes)) {
    if (value == null) continue;
    span.setAttribute(`app.${key}`, typeof value === 'object' ? JSON.stringify(value) : value);
  }
}

/** Report a failure the code has already handled — invisible to the span otherwise. */
function setFailure(message) {
  const span = trace.getActiveSpan();
  if (!span) return;
  span.setStatus({ code: SpanStatusCode.ERROR, message: String(message) });
  span.recordException(new Error(String(message)));
}

/**
 * Wrap `fn` as a named span. Auto-instrumentation only opens a span at a recognised entry
 * point (an HTTP request); work started by setInterval has none, so without this the
 * market tick's duration and errors have nothing to attach to.
 */
function wrapFlow(name, fn) {
  return (...args) =>
    tracer.startActiveSpan(name, (span) => {
      try {
        const result = fn(...args);
        if (result && typeof result.then === 'function') {
          return result.finally(() => span.end());
        }
        span.end();
        return result;
      } catch (error) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: error?.message });
        span.recordException(error);
        span.end();
        throw error;
      }
    });
}

module.exports = { setContext, setFailure, wrapFlow, context };
