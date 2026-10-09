/**
 * PORT NOTE (magick-agency): ported from core `src/utils/otel-sdk-config.ts`@4850d1d9. Changed:
 * the local `:9090` scrape section (`:303-457`: `ScrapeMetricReader`, `LastExportedMetrics`,
 * `scrapeErrorComment`, `renderPrometheusScrape`, `renderLastExportScrape`) is deleted, and with
 * it `withFreshGauges`' `lastExport` argument (`:286-291`), because this app exports over OTLP
 * only (Manas, 2026-10-09; `PORTING.md` "OpenTelemetry SDK"). The default `service.name` is
 * `SERVICE_NAME` (`:120`). Everything else is verbatim, comments included: where they name
 * `:9090` or `src/utils/metrics.ts` they describe core, whose metric names this app keeps.
 *
 * The pure pieces of the OTel SDK configuration in `src/instrumentation.ts`,
 * pulled out so they can be tested without starting an SDK.
 *
 * ⚠️ Import-free with respect to the application on purpose. `instrumentation.ts`
 * is the FIRST import in `src/index.ts` and reads `process.env` directly — it
 * must never pull in `src/config/index.js`, whose module body can
 * `process.exit(1)`. Only OTel libraries and Node built-ins are imported here.
 * (Agency: plus `@magick-agency/observability/service`, a constant with no imports.)
 *
 * Grafana Cloud (fed by the OTLP exporter configured from this) is the only
 * billed and alertable metrics path, and it enforces a per-instance active-series
 * cap (15 000, hit on 2026-09-22). Every choice below is a series-count choice.
 */
import { getHeapStatistics } from 'node:v8';
import type { Meter } from '@opentelemetry/api';
import {
  AggregationTemporality, AggregationType, InstrumentType,
} from '@opentelemetry/sdk-metrics';
import type {
  AggregationTemporalitySelector, PushMetricExporter, ViewOptions,
} from '@opentelemetry/sdk-metrics';
import {
  ATTR_SERVICE_INSTANCE_ID,
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
  SEMRESATTRS_DEPLOYMENT_ENVIRONMENT,
} from '@opentelemetry/semantic-conventions';
// PORT NOTE (magick-agency): the subpath, not the package index, which loads the
// logger and the meter (`meter.ts` calls `metrics.getMeter` at module load) and
// must not run before `instrumentation.ts` has installed the meter provider.
import { SERVICE_NAME } from '@magick-agency/observability/service';

type Env = Record<string, string | undefined>;

// ── Export interval ─────────────────────────────────────────────────────────

/**
 * 60s, not the 30s this used to be. Grafana Cloud bills data points per minute
 * above 1 DPM per series, so a 30s interval made every series ~2× billable for
 * no operator benefit: the tightest range any alert rule uses is `[5m]` (five
 * samples at 60s) and the dashboard uses `[$__rate_interval]`. One sample a
 * minute would empty a `$__rate_interval` panel at the datasource's default 15s
 * scrape interval, so every Prometheus target in the committed dashboard pins a
 * `1m` Min step, which makes the dashboard self-sufficient at this interval.
 * Setting the datasource's "Scrape interval" to ≥ 60s as well is belt-and-braces
 * only (it covers ad-hoc Explore queries and panels added later without the
 * step) — see `grafana/README.md`.
 *
 * The shutdown path is unaffected: `sdk.shutdown()` forces a final collect +
 * export regardless of the interval, which is what carries the single sample of
 * a shutdown-only counter (`webhook_fanout_abandoned_total`) off the box.
 */
export const DEFAULT_METRICS_EXPORT_INTERVAL_MS = 60_000;

/**
 * Largest delay `setInterval` honours (2^31 - 1 ms). Above it Node warns and
 * clamps the delay to 1ms, so the reader would export in a busy loop.
 */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

/**
 * `OTEL_METRICS_EXPORT_INTERVAL_MS`, falling back to the default for anything
 * that is not a positive finite number no larger than {@link MAX_TIMER_DELAY_MS}.
 * The old `Number(x) || 30_000` let a negative value through, and
 * `PeriodicExportingMetricReader` THROWS on one — at module load of the
 * process's first import, i.e. the service never starts.
 */
export function resolveMetricsExportIntervalMs(raw: string | undefined): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 && n <= MAX_TIMER_DELAY_MS ? n : DEFAULT_METRICS_EXPORT_INTERVAL_MS;
}

/** `PeriodicExportingMetricReader`'s own default export timeout. */
const DEFAULT_METRICS_EXPORT_TIMEOUT_MS = 30_000;

/**
 * The export timeout to pair with `intervalMs`: the reader's 30s default, capped
 * at the interval. The reader requires `timeout <= interval` — it clamps an
 * implicit default today but THROWS when both are passed and disagree — so the
 * wiring passes both, explicitly compatible, and a sub-30s override never
 * depends on which of those two SDK paths it lands on.
 */
export function resolveMetricsExportTimeoutMs(intervalMs: number): number {
  return Math.min(intervalMs, DEFAULT_METRICS_EXPORT_TIMEOUT_MS);
}

// ── Resource ────────────────────────────────────────────────────────────────

/**
 * The resource attributes set in code. Note what they are NOT: the final
 * resource. `NodeSDK` merges the detected resource (env/process/host detectors,
 * since `OTEL_NODE_RESOURCE_DETECTORS` is unset) OVER this one, so anything in
 * the standard `OTEL_RESOURCE_ATTRIBUTES` / `OTEL_SERVICE_NAME` still wins —
 * including a `service.instance.id` put there, which applies whether or not
 * `OTEL_SERVICE_INSTANCE_ID_ENABLED` is set (that is the operator's explicit
 * choice, and the standard OTel contract).
 *
 * **`service.instance.id` is rollout-gated (`OTEL_SERVICE_INSTANCE_ID_ENABLED`,
 * default off).** Without it every replica writes the SAME series in Grafana
 * Cloud: `host.name` from the host detector lands only on `target_info`, while
 * `instance` is derived from `service.instance.id`. For gauges that is a
 * last-writer-wins value (read with `max()`/`sum()` it means nothing per
 * replica); for cumulative counters exported from >1 replica the interleaved
 * values make `rate()` read constant resets. Setting it fixes both, and
 * multiplies every OTel series by the replica count — so it is enabled only
 * after the cardinality cuts land and headroom is verified (runbook in
 * `docs/architecture/call-orchestration.md`).
 *
 * The value is `OTEL_SERVICE_INSTANCE_ID` when set, else `os.hostname()`.
 * Hostname rather than a random UUID (the SDK's `serviceinstance` detector)
 * because an id is a series identity and every new one mints a fresh copy of
 * every series, which stays "active" against the cap until it ages out: a UUID
 * churns on EVERY process start — crash restarts, `docker compose restart` —
 * while a container hostname survives those and changes only when the
 * container is recreated (a deploy). Operators who want zero churn pin a stable
 * per-replica name (`core-1`, `core-2`) via `OTEL_SERVICE_INSTANCE_ID`. The
 * trade-off accepted: two processes sharing a hostname (host networking,
 * `hostname:` pinned identically) would collapse again — pin distinct ids there.
 */
export function buildResourceAttributes(
  env: Env,
  opts: { version: string; hostname: () => string },
): Record<string, string> {
  const attrs: Record<string, string> = {
    // PORT NOTE (magick-agency): core `src/utils/otel-sdk-config.ts:120`@4850d1d9 defaulted to
    // 'voice-ai-orchestrator'. Same default as the logger's OTLP transport.
    [ATTR_SERVICE_NAME]: env['OTEL_SERVICE_NAME'] || SERVICE_NAME,
    [ATTR_SERVICE_VERSION]: opts.version,
    [SEMRESATTRS_DEPLOYMENT_ENVIRONMENT]: env['OTEL_ENVIRONMENT'] || env['NODE_ENV'] || 'development',
  };
  if (env['OTEL_SERVICE_INSTANCE_ID_ENABLED'] === 'true') {
    const id = env['OTEL_SERVICE_INSTANCE_ID']?.trim() || opts.hostname().trim();
    if (id) attrs[ATTR_SERVICE_INSTANCE_ID] = id;
  }
  return attrs;
}

// ── Views: what leaves the process ──────────────────────────────────────────

/**
 * The Node runtime-health allow-list: the ONLY instruments of
 * `@opentelemetry/instrumentation-runtime-node` that are exported. One series
 * each (no attributes). Before this, Grafana Cloud had no event-loop or heap
 * signal at all — prom-client's `collectDefaultMetrics` has one, but only on the
 * unscraped `:9090`.
 *
 * - `nodejs.eventloop.delay.p99` / `.max` — the collector RESETS its histogram
 *   on every collection, so each is "over the last export interval" (60s by
 *   default): p99 for sustained lag, max for the single long block a p99 hides
 *   (a synchronous stall is dead air on every live call on the replica).
 * - `nodejs.eventloop.utilization` — saturation, 0..1, also per interval.
 *
 * In Grafana Cloud these read `nodejs_eventloop_delay_p99_seconds`,
 * `nodejs_eventloop_delay_max_seconds` and `nodejs_eventloop_utilization_ratio`.
 */
export const RUNTIME_METRIC_ALLOW_LIST = [
  'nodejs.eventloop.delay.p99',
  'nodejs.eventloop.delay.max',
  'nodejs.eventloop.utilization',
] as const;

/**
 * Heap used, as ONE series. Registered by us rather than allow-listed from
 * runtime-node, because runtime-node only offers `v8js.memory.heap.used` PER
 * HEAP SPACE (11 spaces on Node 22 → 11 series), and a view cannot sum it back:
 * dropping the `v8js.heap.space.name` attribute on an async instrument keeps the
 * LAST observation (`AsyncMetricStorage.record` does a map `set`), which would
 * silently export one space's size labelled as the total. Named after
 * prom-client's own default metric so a query written against the `:9090`
 * scrape reads the same in Grafana Cloud.
 */
export const HEAP_USED_METRIC = 'nodejs_heap_size_used_bytes';

/**
 * Instrument-name patterns whose metrics are DROPPED. Auto-instrumentations are
 * kept for TRACES; their metrics are high-cardinality histograms we do not use.
 *
 * ⚠️ How the allow-list survives this list is the part to get right. An
 * instrument matched by several views gets one stream PER view, and the SDK's
 * compatible-storage reuse then makes whichever view was registered FIRST win —
 * an implementation detail, and one that double-records a sync instrument. So
 * allow-listed names are exported by matching NO view at all (default
 * aggregation), and that is only possible if no pattern here matches them. The
 * view name filter supports a single `*` and no negation, so the `nodejs.*`
 * family is ENUMERATED instead of wildcarded; every other family has nothing
 * allow-listed and keeps its wildcard. `otel-sdk-config.test.ts` pins both
 * halves against the real SDK and the real runtime-node instrumentation, so a
 * runtime-node upgrade that adds an instrument fails the test rather than
 * leaking a series.
 *
 * Our own metrics are snake_case (`calls_total`) and `.` is literal in a
 * pattern, so none of these can match one — the test audits that too.
 */
export const DROPPED_METRIC_PATTERNS: readonly string[] = [
  // instrumentation-http (both semconv generations) and instrumentation-undici
  'http.server.*', 'http.client.*',
  // instrumentation-pg: operation duration + connection pool up/down counters
  'db.client.*',
  // instrumentation-openai: token-usage + operation-duration histograms per
  // model × operation × token type. This LEAKED before — `openai` is used by
  // the sarvam_openai pipeline, post-call analysis and KB embeddings, and the
  // build is CommonJS, so the instrumentation patches it.
  'gen_ai.*',
  'rpc.server.*', 'rpc.client.*',
  'dns.*',
  'net.*',
  'system.*',
  'process.*',
  // runtime-node heap-per-space + GC histogram (heap total is HEAP_USED_METRIC)
  'v8js.*',
  // SDK self-metrics (`otel.sdk.span.*`) — opt-in via
  // OTEL_NODE_EXPERIMENTAL_SDK_METRICS today; dropped so opting in for traces
  // cannot add series by surprise.
  'otel.*',
  // runtime-node's nodejs.* family minus RUNTIME_METRIC_ALLOW_LIST — enumerated,
  // see above. `nodejs.eventloop.time` is `{state=active|idle}`, redundant with
  // utilization.
  'nodejs.eventloop.delay.min',
  'nodejs.eventloop.delay.mean',
  'nodejs.eventloop.delay.stddev',
  'nodejs.eventloop.delay.p50',
  'nodejs.eventloop.delay.p90',
  'nodejs.eventloop.time',
];

export function buildMetricViews(): ViewOptions[] {
  return DROPPED_METRIC_PATTERNS.map(pattern => ({
    instrumentName: pattern,
    aggregation: { type: AggregationType.DROP as const },
  }));
}

/** Registers {@link HEAP_USED_METRIC} on `meter`. Observed once per collection. */
export function registerHeapUsedGauge(meter: Meter): void {
  meter
    .createObservableGauge(HEAP_USED_METRIC, {
      description: 'V8 heap used, all spaces (same source as prom-client nodejs_heap_size_used_bytes)',
      unit: 'By',
    })
    .addCallback(result => {
      result.observe(getHeapStatistics().used_heap_size);
    });
}

// ── Gauges report only what their callbacks observe NOW ─────────────────────

const GAUGE_INSTRUMENT_TYPES: ReadonlySet<InstrumentType> = new Set([
  InstrumentType.OBSERVABLE_GAUGE,
  InstrumentType.GAUGE,
]);

/**
 * DELTA for gauges, `base` for everything else.
 *
 * Under the SDK's default CUMULATIVE temporality an observable gauge's attribute
 * set, once observed, is re-exported with its LAST value on every collection
 * forever — the cumulative merge keeps entries the current collection did not
 * observe (`TemporalMetricProcessor.merge`). Every "expires" design in
 * `src/utils/metrics.ts` depends on the opposite: the queued-backlog and
 * parked-group readings that stop being observed once stale, the abandonment
 * rate that is "absent, not zero" for a campaign with no answered calls, the DNC
 * `synced` series dropped after its TTL, a gauge entry removed when its label
 * set is gone. Under cumulative temporality all of those exported a frozen
 * reading instead — the exact failure their comments say they prevent (a
 * `max by` alert held firing by one dormant replica).
 *
 * A gauge data point carries no temporality on the wire (OTLP defines it for
 * sums and histograms only), so for gauges this changes nothing but WHICH
 * attribute sets are exported: exactly the ones observed in this collection.
 * Counters and histograms keep whatever `base` chooses (cumulative by default,
 * `OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE` still honoured).
 */
export function freshGaugeTemporality(base: AggregationTemporalitySelector): AggregationTemporalitySelector {
  return instrumentType => (GAUGE_INSTRUMENT_TYPES.has(instrumentType)
    ? AggregationTemporality.DELTA
    : base(instrumentType));
}

/**
 * `exporter`, with {@link freshGaugeTemporality} applied to the temporality it
 * asks its reader for. A wrapper rather than an option because the OTLP
 * exporter only offers the three whole-exporter presets
 * (cumulative/delta/lowmemory), none of which separates gauges.
 */
// PORT NOTE (magick-agency): core `src/utils/otel-sdk-config.ts:280-291`@4850d1d9 also took
// `lastExport` and recorded each batch for the `:9090` scrape, which is not ported.
export function withFreshGauges(exporter: PushMetricExporter): PushMetricExporter {
  const base: AggregationTemporalitySelector = exporter.selectAggregationTemporality
    ? exporter.selectAggregationTemporality.bind(exporter)
    : () => AggregationTemporality.CUMULATIVE;
  const wrapped: PushMetricExporter = {
    export: (metrics, resultCallback) => {
      exporter.export(metrics, resultCallback);
    },
    forceFlush: () => exporter.forceFlush(),
    shutdown: () => exporter.shutdown(),
    selectAggregationTemporality: freshGaugeTemporality(base),
  };
  if (exporter.selectAggregation) wrapped.selectAggregation = exporter.selectAggregation.bind(exporter);
  return wrapped;
}
