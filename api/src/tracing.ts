import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
import { ParentBasedSampler, TraceIdRatioBasedSampler } from '@opentelemetry/sdk-trace-base';
import { IORedisInstrumentation } from '@opentelemetry/instrumentation-ioredis';
import { config } from './config';

const enabled = process.env.OTEL_ENABLED !== 'false';
const sampleRatio = parseFloat(process.env.OTEL_TRACE_SAMPLE_RATIO || '0.1');
const otlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://localhost:4318/v1/traces';

let sdk: NodeSDK | undefined;

export function initTracing(): void {
  if (!enabled || process.env.NODE_ENV === 'test') return;

  const exporter = new OTLPTraceExporter({ url: otlpEndpoint });

  sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: config.logging.serviceName,
      [ATTR_SERVICE_VERSION]: config.logging.version,
      'deployment.environment': config.logging.environment,
    }),
    traceExporter: exporter,
    sampler: new ParentBasedSampler({
      root: new TraceIdRatioBasedSampler(sampleRatio),
    }),
    instrumentations: [
      getNodeAutoInstrumentations({
        '@opentelemetry/instrumentation-fs': { enabled: false },
        '@opentelemetry/instrumentation-http': { enabled: true },
        '@opentelemetry/instrumentation-express': { enabled: true },
      }),
      new IORedisInstrumentation(),
    ],
  });

  sdk.start();
}

export async function shutdownTracing(): Promise<void> {
  if (sdk) {
    await sdk.shutdown();
  }
}
