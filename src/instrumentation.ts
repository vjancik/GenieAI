import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { PinoInstrumentation } from '@opentelemetry/instrumentation-pino';
import { ConsoleMetricExporter, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { ConsoleSpanExporter } from '@opentelemetry/sdk-trace-node';

// Check if auto-instrumentation is enabled
const isAutoEnabled = !['false', '0'].includes((process.env.NODE_AUTO_INSTRUMENTATION ?? 'true').toLowerCase());

// biome-ignore lint/suspicious/noExplicitAny: OTel instrumentations are complex types that are hard to type here
const instrumentations: any[] = [];

if (isAutoEnabled) {
	instrumentations.push(getNodeAutoInstrumentations());
}

instrumentations.push(
	new PinoInstrumentation({
		logHook: (_span, record) => {
			record['resource.service.name'] = process.env.OTEL_SERVICE_NAME ?? 'genie-ai-bot';
		},
	}),
);

const sdk = new NodeSDK({
	traceExporter: process.env.OTEL_EXPORTER_OTLP_ENDPOINT ? new OTLPTraceExporter() : new ConsoleSpanExporter(),
	metricReader: new PeriodicExportingMetricReader({
		exporter: process.env.OTEL_EXPORTER_OTLP_ENDPOINT ? new OTLPMetricExporter() : new ConsoleMetricExporter(),
	}),
	instrumentations,
});

// Graceful shutdown
process.on('SIGTERM', () => {
	sdk
		.shutdown()
		.then(() => console.log('Tracing terminated'))
		.catch((error) => console.log('Error terminating tracing', error))
		.finally(() => process.exit(0));
});

sdk.start();
console.log('OpenTelemetry SDK started');
