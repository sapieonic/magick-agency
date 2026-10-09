/**
 * Child-process probe for `test/unit/utils/redact-url.test.ts`: starts a NodeSDK with the real
 * `@opentelemetry/instrumentation-http` and `-undici` from `getNodeAutoInstrumentations`,
 * configured with the redaction settings `src/instrumentation.ts` passes, sends requests that
 * carry credentials through a local server, and prints every finished span's kind and URL
 * attributes as JSON on stdout.
 *
 * A separate process because the instrumentations patch `http` at `require` time and install
 * process-global providers; inside Vitest's worker neither is reliable. `node:http` is
 * required only after `sdk.start()`, for the same reason `instrumentation.ts` is imported first.
 *
 * Run: `node --import tsx test/helpers/span-redaction-probe.ts` from `apps/server`.
 */
import type { AddressInfo } from 'node:net';
import { NodeSDK, tracing } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import {
  OUTGOING_REDACTED_QUERY_PARAMS,
  redactedOutgoingSpanAttributes,
  redactedRequestSpanAttributes,
} from '../../src/utils/redact-url.js';

export const PROBE_SECRETS = ['SECRETINVITE1', 'SECRETQ2', 'SECRETENC3', 'SECRETAMZ4', 'SECRETHTTP5', 'SECRETMEDIA6'];

async function main(): Promise<void> {
  process.env['OTEL_METRICS_EXPORTER'] = 'none';
  process.env['OTEL_LOGS_EXPORTER'] = 'none';
  // Only the two under test; the rest would add spans this probe does not look at.
  process.env['OTEL_NODE_ENABLED_INSTRUMENTATIONS'] = 'http,undici';

  const exporter = new tracing.InMemorySpanExporter();
  const sdk = new NodeSDK({
    spanProcessors: [new tracing.SimpleSpanProcessor(exporter)],
    instrumentations: [
      getNodeAutoInstrumentations({
        // The same settings `src/instrumentation.ts` passes (its source audit pins them there).
        '@opentelemetry/instrumentation-http': {
          startIncomingSpanHook: redactedRequestSpanAttributes,
          redactedQueryParams: [...OUTGOING_REDACTED_QUERY_PARAMS],
        },
        '@opentelemetry/instrumentation-undici': {
          startSpanHook: redactedOutgoingSpanAttributes,
        },
      }),
    ],
  });
  sdk.start();

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const http = require('node:http') as typeof import('node:http');
  const server = http.createServer((req, res) => {
    req.resume();
    res.end('ok');
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  // Outgoing fetch (undici) → incoming server span, for each URL.
  for (const path of [
    `/invites/SECRETINVITE1/claim?next=%2Fagency`,
    `/api/v1/webhooks/voicelink/webrtc-status/c1?token=SECRETQ2&x=1`,
    `/x?%74oken=SECRETENC3&page=2`,
    `/recordings/r1?X-Amz-Signature=SECRETAMZ4&X-Amz-Expires=60`,
    `/media-stream/static/call-9/SECRETMEDIA6`,
    `/health`,
  ]) {
    await (await fetch(`${base}${path}`)).text();
  }
  // Outgoing `http` client span.
  await new Promise<void>((done, fail) => {
    http.get(`${base}/cb?token=SECRETHTTP5`, (res) => {
      res.resume();
      res.on('end', done);
    }).on('error', fail);
  });

  await new Promise<void>((done) => server.close(() => done()));
  // Server spans end on the response's `finish`; give the last one a tick. Read before
  // `sdk.shutdown()`, which empties the in-memory exporter.
  await new Promise((done) => setTimeout(done, 50));
  const finished = exporter.getFinishedSpans();
  await sdk.shutdown();
  const spans = finished.map((span) => ({
    kind: span.kind,
    instrumentation: span.instrumentationScope.name,
    attributes: Object.fromEntries(
      Object.entries(span.attributes).filter(([key]) => key.startsWith('url.') || key.startsWith('http.t') || key === 'http.url'),
    ),
  }));
  process.stdout.write(JSON.stringify(spans));
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
