/**
 * OpenTelemetry bootstrap, preloaded via `node --require ./otel.js` (see docker-compose.yml).
 * Must load before Express and pg so their auto-instrumentation is in place.
 *
 * Traces are exported over OTLP to a local Jaeger (JAEGER_OTLP_ENDPOINT). Service name
 * comes from OTEL_SERVICE_NAME. Express middleware spans are suppressed so a trace is just
 * the HTTP request and the database queries under it.
 */
const { NodeSDK } = require('@opentelemetry/sdk-node');
const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');
const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-proto');

const jaegerEndpoint = process.env.JAEGER_OTLP_ENDPOINT || 'http://jaeger:4318';

const sdk = new NodeSDK({
  traceExporter: new OTLPTraceExporter({ url: `${jaegerEndpoint}/v1/traces` }),
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
