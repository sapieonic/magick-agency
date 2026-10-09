/**
 * The OTel SDK configuration's pure pieces, run against the REAL SDK.
 *
 * Views are the one thing here that cannot be checked by reading them: whether
 * an allow-listed instrument survives a drop list depends on the SDK's view
 * matching (single `*`, no negation) and its storage reuse when several views
 * match (first registered wins). So every view assertion below builds a real
 * `MeterProvider` with `buildMetricViews()` and asserts on what it would EXPORT.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  AggregationTemporality, InMemoryMetricExporter, InstrumentType,
  MeterProvider, MetricReader, PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics';
import type { PushMetricExporter } from '@opentelemetry/sdk-metrics';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-proto';
import type { Meter } from '@opentelemetry/api';
import { resourceFromAttributes, detectResources, envDetector } from '@opentelemetry/resources';
import { RuntimeNodeInstrumentation } from '@opentelemetry/instrumentation-runtime-node';
import {
  DEFAULT_METRICS_EXPORT_INTERVAL_MS,
  DROPPED_METRIC_PATTERNS,
  OTEL_SHUTDOWN_TIMEOUT_MS,
  HEAP_USED_METRIC,
  RUNTIME_METRIC_ALLOW_LIST,
  buildMetricViews,
  buildResourceAttributes,
  freshGaugeTemporality,
  registerHeapUsedGauge,
  resolveMetricsExportIntervalMs,
  resolveMetricsExportTimeoutMs,
  withFreshGauges,
  withTimeout,
} from '../../../src/utils/otel-sdk-config.js';

class CollectingReader extends MetricReader {
  protected async onShutdown(): Promise<void> {}
  protected async onForceFlush(): Promise<void> {}
}

function makeProvider(): { provider: MeterProvider; reader: CollectingReader; meter: Meter } {
  const reader = new CollectingReader();
  const provider = new MeterProvider({ views: buildMetricViews(), readers: [reader] });
  return { provider, reader, meter: provider.getMeter('test') };
}

async function exportedNames(reader: CollectingReader): Promise<Map<string, number>> {
  const { resourceMetrics } = await reader.collect();
  const out = new Map<string, number>();
  for (const scope of resourceMetrics.scopeMetrics) {
    for (const m of scope.metrics) {
      out.set(m.descriptor.name, m.dataPoints.length);
    }
  }
  return out;
}

describe('resolveMetricsExportIntervalMs', () => {
  it('defaults to 60s (Grafana Cloud bills DPM above 1/min/series)', () => {
    expect(DEFAULT_METRICS_EXPORT_INTERVAL_MS).toBe(60_000);
    expect(resolveMetricsExportIntervalMs(undefined)).toBe(60_000);
    expect(resolveMetricsExportIntervalMs('')).toBe(60_000);
  });

  it('honours a positive override', () => {
    expect(resolveMetricsExportIntervalMs('30000')).toBe(30_000);
    expect(resolveMetricsExportIntervalMs('120000')).toBe(120_000);
  });

  it('falls back on values PeriodicExportingMetricReader would throw on at startup', () => {
    // The reader throws on <= 0; this runs at module load of the first import,
    // so a throw there is a service that never starts.
    expect(resolveMetricsExportIntervalMs('-5')).toBe(60_000);
    expect(resolveMetricsExportIntervalMs('0')).toBe(60_000);
    expect(resolveMetricsExportIntervalMs('abc')).toBe(60_000);
    expect(resolveMetricsExportIntervalMs('Infinity')).toBe(60_000);
  });

  it('falls back above the setInterval ceiling, where Node clamps the delay to 1ms', () => {
    // A busy export loop, not a slow one.
    expect(resolveMetricsExportIntervalMs('2147483647')).toBe(2_147_483_647);
    expect(resolveMetricsExportIntervalMs('2147483648')).toBe(60_000);
    expect(resolveMetricsExportIntervalMs('1e12')).toBe(60_000);
  });
});

describe('resolveMetricsExportTimeoutMs', () => {
  const stubExporter: PushMetricExporter = {
    export: (_metrics, done) => done({ code: 0 }),
    forceFlush: async () => {},
    shutdown: async () => {},
  };

  it("is the reader's 30s default, capped at the interval", () => {
    expect(resolveMetricsExportTimeoutMs(60_000)).toBe(30_000);
    expect(resolveMetricsExportTimeoutMs(1_000)).toBe(1_000);
  });

  it('never makes the real reader throw, for any interval the resolver returns', async () => {
    // Both options passed explicitly is the SDK path that throws when
    // timeout > interval, so this pins the wiring in instrumentation.ts.
    for (const raw of ['1000', '29999', '30000', undefined, '2147483647']) {
      const exportIntervalMillis = resolveMetricsExportIntervalMs(raw);
      const reader = new PeriodicExportingMetricReader({
        exporter: stubExporter,
        exportIntervalMillis,
        exportTimeoutMillis: resolveMetricsExportTimeoutMs(exportIntervalMillis),
      });
      await reader.shutdown();
    }
    expect(() => new PeriodicExportingMetricReader({
      exporter: stubExporter, exportIntervalMillis: 1_000, exportTimeoutMillis: 30_000,
    })).toThrow(/exportIntervalMillis must be greater than or equal to exportTimeoutMillis/);
  });
});

describe('buildResourceAttributes', () => {
  const version = '9.9.9';
  const hostname = () => 'agency-host-abc';

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('sets NO service.instance.id by default — rollout-gated, it multiplies every series by R', () => {
    const attrs = buildResourceAttributes({ OTEL_SERVICE_INSTANCE_ID: 'agency-1' }, { version, hostname });
    expect(attrs).not.toHaveProperty('service.instance.id');
    expect(attrs).toEqual({
      'service.name': 'magick-agency',
      'service.version': '9.9.9',
      'deployment.environment': 'development',
    });
  });

  it('only the exact string "true" enables it (same convention as OTEL_ENABLED)', () => {
    for (const v of ['1', 'yes', 'TRUE', 'false', '']) {
      expect(buildResourceAttributes({ OTEL_SERVICE_INSTANCE_ID_ENABLED: v }, { version, hostname }))
        .not.toHaveProperty('service.instance.id');
    }
  });

  it('when enabled, prefers OTEL_SERVICE_INSTANCE_ID, else the hostname', () => {
    expect(buildResourceAttributes(
      { OTEL_SERVICE_INSTANCE_ID_ENABLED: 'true', OTEL_SERVICE_INSTANCE_ID: ' agency-1 ' },
      { version, hostname },
    )['service.instance.id']).toBe('agency-1');
    expect(buildResourceAttributes(
      { OTEL_SERVICE_INSTANCE_ID_ENABLED: 'true', OTEL_SERVICE_INSTANCE_ID: '   ' },
      { version, hostname },
    )['service.instance.id']).toBe('agency-host-abc');
    expect(buildResourceAttributes(
      { OTEL_SERVICE_INSTANCE_ID_ENABLED: 'true' },
      { version, hostname },
    )['service.instance.id']).toBe('agency-host-abc');
  });

  it('omits the attribute rather than exporting an empty identity', () => {
    expect(buildResourceAttributes(
      { OTEL_SERVICE_INSTANCE_ID_ENABLED: 'true' },
      { version, hostname: () => '' },
    )).not.toHaveProperty('service.instance.id');
  });

  it('keeps the existing service.name / deployment.environment precedence', () => {
    const attrs = buildResourceAttributes(
      { OTEL_SERVICE_NAME: 'svc', OTEL_ENVIRONMENT: 'prod', NODE_ENV: 'production' },
      { version, hostname },
    );
    expect(attrs['service.name']).toBe('svc');
    expect(attrs['deployment.environment']).toBe('prod');
    expect(buildResourceAttributes({ NODE_ENV: 'production' }, { version, hostname })['deployment.environment'])
      .toBe('production');
  });

  it('standard OTEL_RESOURCE_ATTRIBUTES still overrides, the way NodeSDK merges it', () => {
    // NodeSDK does `resource.merge(detectResources(...))`, so the env detector's
    // attributes win over what code sets. Pinned because the docs promise it.
    vi.stubEnv('OTEL_RESOURCE_ATTRIBUTES', 'service.instance.id=from-env');
    const merged = resourceFromAttributes(buildResourceAttributes(
      { OTEL_SERVICE_INSTANCE_ID_ENABLED: 'true', OTEL_SERVICE_INSTANCE_ID: 'from-code' },
      { version, hostname },
    )).merge(detectResources({ detectors: [envDetector] }));
    expect(merged.attributes['service.instance.id']).toBe('from-env');
  });
});

describe('buildMetricViews — what leaves the process', () => {
  it('no drop pattern matches an allow-listed runtime instrument (they must match NO view)', async () => {
    // Registered as SYNC gauges on purpose: if a drop view also matched, the
    // SDK would build two streams and — depending on registration order —
    // drop the instrument or double-record it.
    const { reader, meter } = makeProvider();
    for (const name of RUNTIME_METRIC_ALLOW_LIST) meter.createGauge(name).record(1);
    const names = await exportedNames(reader);
    expect([...names.keys()].sort()).toEqual([...RUNTIME_METRIC_ALLOW_LIST].sort());
  });

  it('exports exactly the allow-list from the REAL runtime-node instrumentation', async () => {
    // The guard against a runtime-node upgrade adding an instrument: the
    // nodejs.* family is enumerated in the drop list, so a new name would leak
    // and fail here instead.
    const { provider, reader } = makeProvider();
    const runtime = new RuntimeNodeInstrumentation();
    runtime.setMeterProvider(provider);
    try {
      // The event-loop delay gauges report only once the histogram holds ≥5
      // samples (10ms resolution). Poll rather than sleep a fixed amount.
      let names = new Map<string, number>();
      for (let i = 0; i < 50; i++) {
        await new Promise(r => setTimeout(r, 50));
        names = await exportedNames(reader);
        if (names.has('nodejs.eventloop.delay.p99')) break;
      }
      expect([...names.keys()].sort()).toEqual([...RUNTIME_METRIC_ALLOW_LIST].sort());
      // One series each — no attributes.
      for (const n of RUNTIME_METRIC_ALLOW_LIST) expect(names.get(n)).toBe(1);
    } finally {
      runtime.disable();
    }
  });

  it('drops every metric the enabled auto-instrumentations create', async () => {
    const { reader, meter } = makeProvider();
    const autoInstrumentationMetrics = [
      // instrumentation-http (old + stable semconv) and instrumentation-undici
      'http.server.duration', 'http.client.duration',
      'http.server.request.duration', 'http.client.request.duration',
      // instrumentation-pg
      'db.client.operation.duration', 'db.client.connection.count',
      'db.client.connection.pending_requests',
      // instrumentation-openai — leaked before gen_ai.* was dropped
      'gen_ai.client.token.usage', 'gen_ai.client.operation.duration',
      // runtime-node non-allow-listed
      'v8js.gc.duration', 'v8js.memory.heap.used', 'v8js.memory.heap.limit',
      'v8js.memory.heap.space.available_size', 'v8js.memory.heap.space.physical_size',
      'nodejs.eventloop.time', 'nodejs.eventloop.delay.p50',
      // SDK self-metrics (OTEL_NODE_EXPERIMENTAL_SDK_METRICS)
      'otel.sdk.span.started', 'otel.sdk.span.live',
    ];
    for (const name of autoInstrumentationMetrics) meter.createHistogram(name).record(1, { a: 'b' });
    meter.createCounter('calls_total').add(1);

    const names = await exportedNames(reader);
    expect([...names.keys()]).toEqual(['calls_total']);
  });

  it('drops none of OUR metrics (source audit of packages/observability/src/metrics)', async () => {
    // Metrics are declared per module area in `packages/observability/src/metrics/*.ts`, so every
    // file is read. The canary is 30 (40 declarations today).
    const dir = resolve(process.cwd(), '../../packages/observability/src/metrics');
    const source = readdirSync(dir).filter((f) => f.endsWith('.ts'))
      .map((f) => readFileSync(resolve(dir, f), 'utf8')).join('\n');
    // Every metric is declared once through a facade in metric-instruments.ts.
    const ours = [...source.matchAll(/\b(?:counter|histogram|gauge|observableGauge)(?:<[^>]*>)?\(\s*meter,\s*'([^']+)'/g)]
      .map(m => m[1]!);
    // Canary: a regex that silently stopped matching would pass vacuously.
    expect(ours.length).toBeGreaterThan(30);

    const { reader, meter } = makeProvider();
    const unique = [...new Set(ours)];
    for (const name of unique) meter.createCounter(name).add(1);
    const names = await exportedNames(reader);
    expect([...names.keys()].sort()).toEqual(unique.sort());
  });

  it('the heap gauge is one series, unmatched by any drop pattern', async () => {
    const { reader, meter } = makeProvider();
    registerHeapUsedGauge(meter);
    const { resourceMetrics } = await reader.collect();
    const metrics = resourceMetrics.scopeMetrics.flatMap(s => s.metrics);
    expect(metrics.map(m => m.descriptor.name)).toEqual([HEAP_USED_METRIC]);
    expect(metrics[0]!.dataPoints).toHaveLength(1);
    expect(metrics[0]!.dataPoints[0]!.value as number).toBeGreaterThan(0);
  });

  it('keeps the wildcard families that have nothing allow-listed', () => {
    for (const p of ['http.server.*', 'http.client.*', 'db.client.*', 'gen_ai.*', 'v8js.*', 'process.*']) {
      expect(DROPPED_METRIC_PATTERNS).toContain(p);
    }
    // …and never a nodejs.* catch-all, which would swallow the allow-list.
    expect(DROPPED_METRIC_PATTERNS).not.toContain('nodejs.*');
  });
});

describe('fresh gauges — an unobserved attribute set stops being exported', () => {
  it('selects DELTA for gauges and defers to the base selector for everything else', () => {
    const select = freshGaugeTemporality(() => AggregationTemporality.CUMULATIVE);
    expect(select(InstrumentType.OBSERVABLE_GAUGE)).toBe(AggregationTemporality.DELTA);
    expect(select(InstrumentType.GAUGE)).toBe(AggregationTemporality.DELTA);
    for (const t of [InstrumentType.COUNTER, InstrumentType.HISTOGRAM, InstrumentType.UP_DOWN_COUNTER,
      InstrumentType.OBSERVABLE_COUNTER, InstrumentType.OBSERVABLE_UP_DOWN_COUNTER]) {
      expect(select(t)).toBe(AggregationTemporality.CUMULATIVE);
    }
  });

  it('keeps the real OTLP exporter\'s own choice for sums and histograms', () => {
    const exporter = withFreshGauges(new OTLPMetricExporter({ url: 'http://127.0.0.1:1/v1/metrics' }));
    expect(exporter.selectAggregationTemporality!(InstrumentType.COUNTER)).toBe(AggregationTemporality.CUMULATIVE);
    expect(exporter.selectAggregationTemporality!(InstrumentType.HISTOGRAM)).toBe(AggregationTemporality.CUMULATIVE);
    expect(exporter.selectAggregationTemporality!(InstrumentType.OBSERVABLE_GAUGE)).toBe(AggregationTemporality.DELTA);
    void exporter.shutdown();
  });

  it('through the periodic OTLP reader: a removed gauge entry is gone from the next export, counters stay cumulative', async () => {
    // What the SDK does WITHOUT the wrapper is the defect: the cumulative merge
    // re-exports the removed entry with its last value on every export forever.
    const inner = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    const reader = new PeriodicExportingMetricReader({ exporter: withFreshGauges(inner), exportIntervalMillis: 3_600_000 });
    const provider = new MeterProvider({ readers: [reader] });
    const meter = provider.getMeter('test');
    const backlog = new Map([['ai_voice', 5], ['static', 2]]);
    let parked: number | null = 7;
    meter.createObservableGauge('calls_queued_current').addCallback(r => {
      for (const [call_type, v] of backlog) r.observe(v, { call_type });
    });
    meter.createObservableGauge('group_concurrency_parked_current').addCallback(r => {
      if (parked !== null) r.observe(parked);
    });
    const counter = meter.createCounter('calls_total');
    counter.add(2);

    const lastExport = async () => {
      inner.reset();
      await reader.forceFlush();
      const [rm] = inner.getMetrics().slice(-1);
      return new Map(rm!.scopeMetrics.flatMap(s => s.metrics).map(m => [
        m.descriptor.name,
        m.dataPoints.map(d => ({ attrs: d.attributes, value: d.value })),
      ]));
    };

    let exported = await lastExport();
    expect(exported.get('calls_queued_current')).toHaveLength(2);
    expect(exported.get('group_concurrency_parked_current')).toEqual([{ attrs: {}, value: 7 }]);

    backlog.delete('static');
    parked = null;
    counter.add(1);
    exported = await lastExport();

    expect(exported.get('calls_queued_current')).toEqual([{ attrs: { call_type: 'ai_voice' }, value: 5 }]);
    expect(exported.has('group_concurrency_parked_current')).toBe(false);
    expect(exported.get('calls_total')).toEqual([{ attrs: {}, value: 3 }]);
    await provider.shutdown();
  });
});

describe('src/instrumentation.ts wiring (source audit)', () => {
  const src = readFileSync(resolve(process.cwd(), 'src/instrumentation.ts'), 'utf8');

  it('uses the tested builders rather than inline copies', () => {
    expect(src).toContain('views: buildMetricViews()');
    expect(src).toContain("resolveMetricsExportIntervalMs(process.env['OTEL_METRICS_EXPORT_INTERVAL_MS'])");
    expect(src).toContain('resourceFromAttributes(resourceAttributes)');
    expect(src).toMatch(/registerHeapUsedGauge\(/);
  });

  it('exporting path has exactly ONE metric reader', () => {
    // A second reader doubles the storage work of every add() and leaks when
    // nothing reads it.
    expect(src).toContain('metricReaders: [otlpReader]');
    expect(src).toContain('exporter: withFreshGauges(metricExporter)');
    expect(src).not.toMatch(/PrometheusExporter/);
  });

  it('enables runtime-node (its non-allow-listed instruments are dropped by views)', () => {
    expect(src).toContain("'@opentelemetry/instrumentation-runtime-node': { enabled: true }");
  });

  it('never imports src/config — it is the first import and config can process.exit(1)', () => {
    expect(src).not.toMatch(/from '\.\/config/);
    const helper = readFileSync(resolve(process.cwd(), 'src/utils/otel-sdk-config.ts'), 'utf8');
    expect(helper).not.toMatch(/from '\.\.?\//);
  });

  describe('startup and shutdown wiring', () => {
    it('installs no meter provider with export off, so every instrument stays a no-op as before', () => {
      // OTLP only: the one provider is NodeSDK's, inside the exporting branch.
      expect(src).not.toMatch(/setGlobalMeterProvider|new MeterProvider\(/);
      expect(src).toMatch(/if \(otelEnabled && otlpEndpoint && otelServiceNamed\) \{\n\s+\/\/ Force HTTP\/protobuf/);
      expect(src).toContain("const otelEnabled = process.env['OTEL_ENABLED'] === 'true';");
    });

    it('starts nothing without OTEL_SERVICE_NAME: the fallback is the production name Grafana alerts on', () => {
      // Manas, 2026-10-09. `buildResourceAttributes` still falls back to SERVICE_NAME, so the gate is what keeps an unnamed process out of production's series.
      expect(src).toContain("const otelServiceNamed = Boolean(process.env['OTEL_SERVICE_NAME']);");
      const gates = src.match(/^if \(otelEnabled && otlpEndpoint[^)]*\) \{$/gm) ?? [];
      expect(gates).toEqual([
        'if (otelEnabled && otlpEndpoint && otelServiceNamed) {',
        'if (otelEnabled && otlpEndpoint && otelServiceNamed) {',
      ]);
      expect(src).toContain('OTEL_SERVICE_NAME is not set — skipping');
      expect(buildResourceAttributes({}, { version: '0', hostname: () => 'h' })['service.name']).toBe('magick-agency');
    });

    it('loads .env before anything reads process.env', () => {
      const firstImport = src.match(/^import .*$/m)?.[0];
      expect(firstImport).toBe("import 'dotenv/config';");
    });

    it('reaches the observability package only through import-free subpaths', () => {
      // The package index loads `meter.ts`, whose `metrics.getMeter` would run before the SDK
      // exists and bind every metric to the no-op provider for the life of the process.
      for (const file of [src, readFileSync(resolve(process.cwd(), 'src/utils/otel-sdk-config.ts'), 'utf8')]) {
        expect(file).not.toMatch(/from '@magick-agency\/observability'/);
      }
      expect(src).toContain("from '@magick-agency/observability/version'");
      for (const sub of ['service', 'version']) {
        const leaf = readFileSync(resolve(process.cwd(), `../../packages/observability/src/${sub}.ts`), 'utf8');
        expect(leaf).not.toMatch(/^import /m);
      }
    });

    it('src/index.ts imports it first and flushes it as the last shutdown step', () => {
      const index = readFileSync(resolve(process.cwd(), 'src/index.ts'), 'utf8');
      expect(index.match(/^import .*$/m)?.[0]).toBe("import { shutdownOtelSdk } from './instrumentation.js';");
      const flush = index.indexOf('await shutdownOtelSdk();');
      expect(flush).toBeGreaterThan(index.indexOf('await closePool();'));
      expect(flush).toBeGreaterThan(index.lastIndexOf('await stop()'));
      expect(flush).toBeLessThan(index.indexOf('process.exit(0);'));
      // In a `finally`, so a rejected step above cannot skip it.
      expect(index.slice(index.lastIndexOf('} finally {', flush) + '} finally {'.length, flush)).not.toMatch(/[{}]/);
      // And a failed boot flushes before exiting.
      expect(index).toMatch(/logger\.fatal\(\{ err \}, 'boot failed'\);[^]*?await shutdownOtelSdk\(\);\s+process\.exit\(1\);/);
    });

    it('bounds the final flush, so an unreachable collector cannot hold shutdown for 30s', async () => {
      // `sdk.shutdown()` waits out the metric reader's export timeout before rejecting
      // (30s at the default interval), past a 10s/30s stop grace period.
      expect(OTEL_SHUTDOWN_TIMEOUT_MS).toBeLessThan(resolveMetricsExportTimeoutMs(DEFAULT_METRICS_EXPORT_INTERVAL_MS));
      expect(src).toMatch(/await withTimeout\(sdk\.shutdown\(\), OTEL_SHUTDOWN_TIMEOUT_MS, /);

      await expect(withTimeout(Promise.resolve('flushed'), 50, 'x')).resolves.toBe('flushed');
      await expect(withTimeout(Promise.reject(new Error('export failed')), 50, 'x')).rejects.toThrow('export failed');
      const started = Date.now();
      await expect(withTimeout(new Promise(() => {}), 50, 'OTel SDK shutdown'))
        .rejects.toThrow('OTel SDK shutdown timed out after 50ms');
      expect(Date.now() - started).toBeLessThan(1_000);
    });
  });
});
