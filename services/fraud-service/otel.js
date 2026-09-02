/**
 * OpenTelemetry bootstrap, preloaded via `node --require ./otel.js` (see docker-compose.yml).
 * Must load before Express so its auto-instrumentation is in place.
 *
 * Traces are exported over OTLP; the endpoint/protocol come from OTEL_* env vars, and the
 * service name from OTEL_SERVICE_NAME. Middleware spans are suppressed, so one screening
 * request is a clean trace rather than a stack of "/" middleware layers.
 */
const { NodeSDK } = require('@opentelemetry/sdk-node');
const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');
const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-proto');

const sdk = new NodeSDK({
  traceExporter: new OTLPTraceExporter(),
  instrumentations: [
    getNodeAutoInstrumentations({
      '@opentelemetry/instrumentation-express': { ignoreLayersType: ['middleware'] },
      '@opentelemetry/instrumentation-fs': { enabled: false },
    }),
  ],
});

sdk.start();

process.on('SIGTERM', () => {
  sdk.shutdown().finally(() => process.exit(0));
});
