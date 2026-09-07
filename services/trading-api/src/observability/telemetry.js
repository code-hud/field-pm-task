const { trace, context, SpanStatusCode } = require('@opentelemetry/api');

const tracer = trace.getTracer('trading-api');

function setContext(attributes) {
  const span = trace.getActiveSpan();
  if (!span || !attributes) return;
  for (const [key, value] of Object.entries(attributes)) {
    if (value == null) continue;
    span.setAttribute(`app.${key}`, typeof value === 'object' ? JSON.stringify(value) : value);
  }
}

function setFailure(message) {
  const span = trace.getActiveSpan();
  if (!span) return;
  span.setStatus({ code: SpanStatusCode.ERROR, message: String(message) });
  span.recordException(new Error(String(message)));
}

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
