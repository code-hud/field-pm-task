/**
 * OpenTelemetry bootstrap, preloaded via `node --require ./otel.js` (see docker-compose.yml).
 * Must load before Express and pg so their auto-instrumentation is in place.
 *
 * Traces fan out to two backends so a candidate can use either or both:
 *   - Jaeger, always on (local, no account) — JAEGER_OTLP_ENDPOINT
 *   - Honeycomb, only when HONEYCOMB_API_KEY is set (sign up, paste the key in .env)
 *
 * Service name comes from OTEL_SERVICE_NAME. Express middleware spans are suppressed so a
 * trace is just the HTTP request and the database queries under it.
 */
const { NodeSDK } = require('@opentelemetry/sdk-node');
const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');
const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-proto');
const { BatchSpanProcessor } = require('@opentelemetry/sdk-trace-base');

const spanProcessors = [];

// Always: local Jaeger.
const jaegerEndpoint = process.env.JAEGER_OTLP_ENDPOINT || 'http://jaeger:4318';
spanProcessors.push(new BatchSpanProcessor(new OTLPTraceExporter({ url: `${jaegerEndpoint}/v1/traces` })));

// Optional: Honeycomb, when a key is configured.
const honeycombKey = process.env.HONEYCOMB_API_KEY;
if (honeycombKey) {
  const honeycombEndpoint = process.env.HONEYCOMB_OTLP_ENDPOINT || 'https://api.honeycomb.io';
  spanProcessors.push(
    new BatchSpanProcessor(
      new OTLPTraceExporter({
        url: `${honeycombEndpoint}/v1/traces`,
        headers: { 'x-honeycomb-team': honeycombKey },
      }),
    ),
  );
  console.log('[otel] exporting traces to Jaeger and Honeycomb');
} else {
  console.log('[otel] exporting traces to Jaeger (set HONEYCOMB_API_KEY to also send to Honeycomb)');
}

const sdk = new NodeSDK({
  spanProcessors,
  instrumentations: [
    getNodeAutoInstrumentations({
      // Express emits a span per middleware layer (cors, json, logger…), each with route
      // "/". That turns one request into a dozen noise spans — drop them.
      '@opentelemetry/instrumentation-express': { ignoreLayersType: ['middleware'] },
      // Filesystem spans are extremely high-volume and irrelevant here.
      '@opentelemetry/instrumentation-fs': { enabled: false },
    }),
  ],
});

sdk.start();

process.on('SIGTERM', () => {
  sdk.shutdown().finally(() => process.exit(0));
});
