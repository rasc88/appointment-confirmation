import { context, metrics as metricsApi, propagation, trace } from '@opentelemetry/api';
import { logs as logsApi } from '@opentelemetry/api-logs';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-proto';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-proto';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { logs, metrics, NodeSDK, resources, tracing } from '@opentelemetry/sdk-node';
import { setTimeout as delay } from 'node:timers/promises';
import { deploymentAttributes, zeroResponseFailures } from './metrics.js';

const metricExportIntervalMs = 60_000;
const shutdownTimeoutMs = 5_000;

let sdk: NodeSDK | undefined;

/** No resource detection, so only these and the SDK's own `telemetry.sdk.*` attributes are exported. */
function buildResource() {
  const { environment, version } = deploymentAttributes();
  return resources.defaultResource().merge(
    resources.resourceFromAttributes({
      'service.name': process.env.OTEL_SERVICE_NAME || 'appointment-confirmation',
      'service.version': version,
      'deployment.environment': environment,
      'deployment.environment.name': environment,
    }),
  );
}

/**
 * Starts the SDK only when `OTEL_EXPORTER_OTLP_ENDPOINT` is set and not empty (decision 36). The exporters read the
 * endpoint and `OTEL_EXPORTER_OTLP_HEADERS` themselves. Returns whether it started.
 */
export function startTelemetry() {
  if (!process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
    return false;
  }
  sdk = new NodeSDK({
    autoDetectResources: false,
    resource: buildResource(),
    spanProcessors: [new tracing.BatchSpanProcessor(new OTLPTraceExporter())],
    metricReaders: [
      new metrics.PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter(),
        exportIntervalMillis: metricExportIntervalMs,
      }),
    ],
    logRecordProcessors: [new logs.BatchLogRecordProcessor({ exporter: new OTLPLogExporter() })],
  });
  sdk.start();
  zeroResponseFailures();
  return true;
}

/** Flushes what is buffered, then unregisters the SDK so telemetry is off again. */
export async function shutdownTelemetry() {
  await sdk?.shutdown();
  sdk = undefined;
  trace.disable();
  metricsApi.disable();
  logsApi.disable();
  context.disable();
  propagation.disable();
}

/** Waits at most 5 seconds, so a `docker compose stop` loses no buffered telemetry but never hangs. */
async function shutdownAndExit() {
  await Promise.race([shutdownTelemetry().catch(() => undefined), delay(shutdownTimeoutMs)]);
  process.exit(0);
}

if (startTelemetry()) {
  process.once('SIGTERM', shutdownAndExit);
  process.once('SIGINT', shutdownAndExit);
}
