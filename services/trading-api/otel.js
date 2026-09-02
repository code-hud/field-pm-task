/**
 * OpenTelemetry bootstrap, preloaded via `node --require ./otel.js` (see docker-compose.yml).
 * Must load before Express and pg so their auto-instrumentation is in place.
 *
 * Traces are exported over OTLP; the endpoint/protocol come from OTEL_* env vars, and the
 * service name from OTEL_SERVICE_NAME. Middleware spans are suppressed, so one request is a
 * clean trace — the HTTP span and the database queries under it, not a dozen "/" layers.
 */
const { NodeSDK } = require('@opentelemetry/sdk-node');
const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');
const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-proto');

const sdk = new NodeSDK({
  traceExporter: new OTLPTraceExporter(),
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
