/**
 * PORT NOTE (magick-agency): ported from core `src/instrumentation.ts`@4850d1d9. Changed:
 *  - `.env` is loaded first, as master's `src/instrumentation.ts:1-2`@a1f0756a does. Core's
 *    `src/index.ts` imported nothing that loaded it ahead of this file; here `.env` is loaded by
 *    `config/index.ts`, which runs after it, so without this line an `OTEL_ENABLED` set in `.env`
 *    would reach the config block but not the SDK.
 *  - OTLP export only (Manas, 2026-10-09): the `:9090` scrape is not ported, so the pull-only
 *    meter provider core installed with export off (`:229-244`), both scrape renderers
 *    (`:223`, `:243`), the `LastExportedMetrics` snapshot (`:125-129`) and their imports
 *    (`:9`, `:12-13`, `:17-18`, `:23`) are deleted. With export off no provider is installed and
 *    every instrument stays the OTel API's no-op, as before this file existed.
 *  - The HTTP instrumentation gets master's invite-token redaction hook
 *    (`src/utils/otel-instrumentations.ts:132-134`@a1f0756a): this app serves master's
 *    `/invites/:token` routes, which core never had. The hook also scrubs credential query
 *    values, which neither source did on spans (`src/utils/redact-url.ts`).
 * Comments are otherwise core's, verbatim: the `sdkRef` story below is about core's billing
 * counter (`webhook_fanout_abandoned_total`), which this app does not have; the ordering rule it
 * argues for holds here unchanged.
 *  - `APP_VERSION` and `SERVICE_NAME` come from `@magick-agency/observability` subpaths, and the
 *    heap gauge's meter is named after `SERVICE_NAME` (core: 'voice-ai-orchestrator.runtime').
 * `PORTING.md` "OpenTelemetry SDK" has the row.
 */
// dotenv must load BEFORE we read env vars — this file runs before config/index.ts
import 'dotenv/config';
import { hostname } from 'node:os';
import { diag, DiagConsoleLogger, DiagLogLevel, metrics } from '@opentelemetry/api';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-proto';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { PinoInstrumentation } from '@opentelemetry/instrumentation-pino';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
// Subpaths, not the package index: the index loads the logger and `meter.ts`, whose
// `metrics.getMeter` would bind every metric to the no-op provider before the SDK below exists.
import { APP_VERSION } from '@magick-agency/observability/version';
import { SERVICE_NAME } from '@magick-agency/observability/service';
import {
  buildMetricViews,
  buildResourceAttributes,
  registerHeapUsedGauge,
  resolveMetricsExportIntervalMs,
  resolveMetricsExportTimeoutMs,
  withFreshGauges,
} from './utils/otel-sdk-config.js';
// Imports nothing (see its header), so it cannot pull the app graph in ahead of the SDK.
import { redactedRequestSpanAttributes } from './utils/redact-url.js';

const otlpEndpoint = process.env['OTEL_EXPORTER_OTLP_ENDPOINT'];
const otelEnabled = process.env['OTEL_ENABLED'] === 'true';

/**
 * The live SDK, so the application's own shutdown sequence can flush it LAST.
 *
 * ⚠️ This module deliberately registers **no signal handlers of its own**, and
 * that is a correctness requirement rather than tidiness. It is the first import
 * in `src/index.ts`, so a `process.on('SIGTERM', …)` here runs BEFORE the app's
 * shutdown handler — Node dispatches signal listeners in registration order —
 * and `sdk.shutdown()` is fire-and-forget from Node's point of view. The metric
 * reader was therefore shut down while the app was still on its first teardown
 * step, ~90s before `drainSettlementFanout` writes
 * `webhook_fanout_abandoned_total`: the one counter that says a customer's
 * credit release was dropped was recorded into a provider that had already
 * stopped exporting, and the process then `process.exit(0)`ed with no flush at
 * all. Every sample of it was lost, on every shutdown.
 *
 * The app owns the ordering instead, via {@link shutdownOtelSdk}, which it calls
 * after the last thing that writes a metric or a span.
 */
let sdkRef: { shutdown: () => Promise<void> } | null = null;

/**
 * Flush pending spans/metrics/logs and shut the SDK down. Idempotent, never
 * throws, and a no-op when OTel is disabled (the common case in dev and in every
 * test), so callers need no `if`.
 */
export async function shutdownOtelSdk(): Promise<void> {
  const sdk = sdkRef;
  if (!sdk) return;
  sdkRef = null;
  try {
    await sdk.shutdown();
  } catch (err) {
    console.error('[otel] SDK shutdown failed', err);
  }
}

// Drop all auto-instrumentation metrics (http, db, gen_ai, rpc, …) to control
// Grafana Cloud series cardinality — auto-instrumentations are kept for TRACES
// only — except a tight Node runtime-health allow-list (≈4 series). The list,
// and why the allow-list must match NO drop view, live in
// `utils/otel-sdk-config.ts`, where they are testable without an SDK.
const resourceAttributes = buildResourceAttributes(process.env, { version: APP_VERSION, hostname });

// Only initialize OTel when explicitly enabled AND an endpoint is configured.
if (otelEnabled && otlpEndpoint) {
  console.log(`[otel] Initializing OpenTelemetry — endpoint: ${otlpEndpoint}`);
} else {
  if (otelEnabled && !otlpEndpoint) {
    console.warn('[otel] OTEL_ENABLED=true but OTEL_EXPORTER_OTLP_ENDPOINT is not set — skipping');
  }
}

if (otelEnabled && otlpEndpoint) {
  // Force HTTP/protobuf protocol — Grafana Cloud doesn't support gRPC.
  // This also controls the auto-configured log exporter inside NodeSDK.
  process.env['OTEL_EXPORTER_OTLP_PROTOCOL'] = 'http/protobuf';

  // Enable OTel diagnostic logging — set OTEL_LOG_LEVEL=debug for verbose export diagnostics
  const otelLogLevel = process.env['OTEL_LOG_LEVEL']?.toLowerCase();
  const diagLevel = otelLogLevel === 'debug' ? DiagLogLevel.DEBUG
    : otelLogLevel === 'verbose' ? DiagLogLevel.VERBOSE
    : otelLogLevel === 'info' ? DiagLogLevel.INFO
    : DiagLogLevel.WARN;
  diag.setLogger(new DiagConsoleLogger(), diagLevel);

  // Parse OTEL_EXPORTER_OTLP_HEADERS manually to pass explicitly to exporters.
  // The env var format is "key1=value1,key2=value2". Since base64 values contain '=',
  // we split each entry on the first '=' only.
  const rawHeaders = process.env['OTEL_EXPORTER_OTLP_HEADERS'] || '';
  const headers: Record<string, string> = {};
  for (const entry of rawHeaders.split(',')) {
    const eqIdx = entry.indexOf('=');
    if (eqIdx > 0) {
      headers[entry.substring(0, eqIdx).trim()] = entry.substring(eqIdx + 1).trim();
    }
  }
  if (Object.keys(headers).length > 0) {
    console.log(`[otel] Parsed ${Object.keys(headers).length} OTLP header(s): ${Object.keys(headers).join(', ')}`);
  } else {
    console.warn('[otel] WARNING: No OTEL_EXPORTER_OTLP_HEADERS found — exports will likely fail (401)');
  }

  const traceExporter = new OTLPTraceExporter({
    url: `${otlpEndpoint}/v1/traces`,
    headers,
  });

  const metricExporter = new OTLPMetricExporter({
    url: `${otlpEndpoint}/v1/metrics`,
    headers,
  });

  if (resourceAttributes['service.instance.id']) {
    console.log(`[otel] service.instance.id=${resourceAttributes['service.instance.id']}`);
  }

  const exportIntervalMillis = resolveMetricsExportIntervalMs(process.env['OTEL_METRICS_EXPORT_INTERVAL_MS']);
  const otlpReader = new PeriodicExportingMetricReader({
    // Gauges export only what their callbacks observe in this collection —
    // without it every expired / removed gauge reading was re-exported frozen
    // forever. See `freshGaugeTemporality`.
    exporter: withFreshGauges(metricExporter),
    // Default 60s: Grafana Cloud bills DPM above 1/min/series, so 30s was ~2×.
    exportIntervalMillis,
    // Never above the interval, so a sub-30s override cannot fail construction.
    exportTimeoutMillis: resolveMetricsExportTimeoutMs(exportIntervalMillis),
  });

  const sdk = new NodeSDK({
    // Code-set attributes; OTEL_RESOURCE_ATTRIBUTES / OTEL_SERVICE_NAME (env
    // detector) are merged over these by NodeSDK and still win.
    resource: resourceFromAttributes(resourceAttributes),

    traceExporter,

    // ONE reader. (Core's `:9090` served this reader's last export rather than
    // adding a second reader; the scrape is not ported.)
    metricReaders: [otlpReader],

    views: buildMetricViews(),

    instrumentations: [
      getNodeAutoInstrumentations({
        // Disable instrumentations that only generate metrics (no useful traces)
        '@opentelemetry/instrumentation-fs': { enabled: false },
        '@opentelemetry/instrumentation-dns': { enabled: false },
        '@opentelemetry/instrumentation-net': { enabled: false },

        // Metrics only — enabled for the event-loop allow-list in
        // RUNTIME_METRIC_ALLOW_LIST; every other instrument it creates is
        // dropped by a view. Default 10ms event-loop sampling resolution.
        '@opentelemetry/instrumentation-runtime-node': { enabled: true },

        // Disable instrumentations for libraries not used by this service
        '@opentelemetry/instrumentation-amqplib': { enabled: false },
        '@opentelemetry/instrumentation-aws-lambda': { enabled: false },
        '@opentelemetry/instrumentation-aws-sdk': { enabled: false },
        '@opentelemetry/instrumentation-bunyan': { enabled: false },
        '@opentelemetry/instrumentation-cassandra-driver': { enabled: false },
        '@opentelemetry/instrumentation-connect': { enabled: false },
        '@opentelemetry/instrumentation-cucumber': { enabled: false },
        '@opentelemetry/instrumentation-dataloader': { enabled: false },
        '@opentelemetry/instrumentation-express': { enabled: false },
        '@opentelemetry/instrumentation-graphql': { enabled: false },
        '@opentelemetry/instrumentation-grpc': { enabled: false },
        '@opentelemetry/instrumentation-hapi': { enabled: false },
        '@opentelemetry/instrumentation-kafkajs': { enabled: false },
        '@opentelemetry/instrumentation-knex': { enabled: false },
        '@opentelemetry/instrumentation-koa': { enabled: false },
        '@opentelemetry/instrumentation-lru-memoizer': { enabled: false },
        '@opentelemetry/instrumentation-memcached': { enabled: false },
        '@opentelemetry/instrumentation-mongodb': { enabled: false },
        '@opentelemetry/instrumentation-mongoose': { enabled: false },
        '@opentelemetry/instrumentation-mysql': { enabled: false },
        '@opentelemetry/instrumentation-mysql2': { enabled: false },
        '@opentelemetry/instrumentation-nestjs-core': { enabled: false },
        '@opentelemetry/instrumentation-oracledb': { enabled: false },
        '@opentelemetry/instrumentation-redis': { enabled: false },
        '@opentelemetry/instrumentation-restify': { enabled: false },
        '@opentelemetry/instrumentation-router': { enabled: false },
        '@opentelemetry/instrumentation-socket.io': { enabled: false },
        '@opentelemetry/instrumentation-tedious': { enabled: false },
        '@opentelemetry/instrumentation-winston': { enabled: false },
        '@opentelemetry/instrumentation-pino': { enabled: false },

        // Keep: http, pg, ioredis, undici, openai, generic-pool (traces only —
        // their metrics are dropped by the views above)

        // PORT NOTE (magick-agency): from master `src/utils/otel-instrumentations.ts:132-134`@a1f0756a.
        // The raw invite token is the path segment of `GET /invites/:token` and
        // `POST /invites/:token/claim`; this hook overwrites `http.url` / `http.target` /
        // `url.path` on those two routes' server spans. See `src/utils/redact-url.ts`.
        '@opentelemetry/instrumentation-http': {
          startIncomingSpanHook: redactedRequestSpanAttributes,
        },

        // pg: capture query text but not parameter values
        // PORT NOTE (magick-agency): the line above is core's and is WRONG. With
        // `enhancedDatabaseReporting` instrumentation-pg attaches every query's parameter values
        // (`db.postgresql.values`); query text is captured without it. Kept verbatim by ruling
        // (Manas, 2026-10-09): pg spans carry parameter values, as in core and master.
        '@opentelemetry/instrumentation-pg': {
          enhancedDatabaseReporting: true,
        },

        // ioredis: capture command name + key only (strip values for PII safety)
        '@opentelemetry/instrumentation-ioredis': {
          dbStatementSerializer: (cmdName: string, cmdArgs: Array<string | number | Buffer | unknown[]>) => {
            return `${cmdName} ${cmdArgs[0] != null ? String(cmdArgs[0]) : ''}`.trim();
          },
        },
      }),

      // Inject trace_id and span_id into all Pino log records
      new PinoInstrumentation(),
    ],
  });

  sdk.start();
  console.log('[otel] OpenTelemetry SDK started (traces, metrics, logs)');

  // Handed to the application's shutdown sequence rather than bound to SIGTERM
  // /SIGINT here. See `sdkRef` above for what that race cost.
  sdkRef = sdk;
}

// After the global meter provider exists. With export off there is none, so this
// registers on the API's no-op meter and records nothing.
registerHeapUsedGauge(metrics.getMeter(`${SERVICE_NAME}.runtime`));
