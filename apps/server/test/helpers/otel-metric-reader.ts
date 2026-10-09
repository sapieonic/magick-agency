import { metrics } from '@opentelemetry/api';
import {
  AggregationTemporality,
  InstrumentType,
  MeterProvider,
  MetricReader,
  type AggregationTemporalitySelector,
  type MetricReaderOptions,
} from '@opentelemetry/sdk-metrics';
import type { MetricData } from '@opentelemetry/sdk-metrics';

/**
 * A test-only OpenTelemetry metric reader: the server starts no OTel SDK yet, so the
 * suites install this reader on a fresh MeterProvider and read metrics through the SDK's
 * real aggregation. Gauges use DELTA temporality so each collection sees the latest value.
 * `@opentelemetry/sdk-metrics` is an `apps/server` devDependency for this helper.
 */
const GAUGE_INSTRUMENT_TYPES: ReadonlySet<InstrumentType> = new Set([
  InstrumentType.OBSERVABLE_GAUGE,
  InstrumentType.GAUGE,
]);

export function freshGaugeTemporality(base: AggregationTemporalitySelector): AggregationTemporalitySelector {
  return instrumentType => (GAUGE_INSTRUMENT_TYPES.has(instrumentType)
    ? AggregationTemporality.DELTA
    : base(instrumentType));
}

export class ScrapeMetricReader extends MetricReader {
  constructor(options?: MetricReaderOptions) {
    // Same gauge rule as the OTLP path (`withFreshGauges`), so a reading that
    // expired there has expired here too.
    super({
      aggregationTemporalitySelector: freshGaugeTemporality(() => AggregationTemporality.CUMULATIVE),
      ...options,
    });
  }
  protected async onForceFlush(): Promise<void> {}
  protected async onShutdown(): Promise<void> {}
}


/**
 * A real OTel meter provider for suites that need to READ a metric's value back
 * — what an OTLP export (or the `:9090` scrape) would actually carry — rather
 * than assert on a stand-in instrument's calls.
 *
 * `src/utils/metrics.ts` creates its instruments from the GLOBAL meter at module
 * load, so this must run before that module is imported. Call it from a
 * `vi.hoisted` block, which Vitest runs ahead of the (rewritten) imports:
 *
 *   const { reader } = await vi.hoisted(async () => {
 *     const { installMetricReader } = await import('../../helpers/otel-metric-reader.js');
 *     return { reader: installMetricReader() };
 *   });
 *
 * The reader is the production `ScrapeMetricReader`, so a suite sees the same
 * aggregation the service exports: cumulative counters and histograms, and
 * gauges that report only what their callbacks observe in THIS collection (a
 * removed or expired label set is absent, not frozen at its last value).
 */
export function installMetricReader(): ScrapeMetricReader {
  // A fork can host several files; start from a clean global.
  metrics.disable();
  const reader = new ScrapeMetricReader();
  metrics.setGlobalMeterProvider(new MeterProvider({ readers: [reader] }));
  installed = reader;
  return reader;
}

let installed: ScrapeMetricReader | null = null;

/**
 * The reader {@link installMetricReader} installed for this file, for shared
 * helpers (e.g. a scenario harness) that read metrics on a suite's behalf.
 * Throws when none was installed: without one `metrics.ts` is bound to the
 * no-op meter and every read would silently come back empty.
 */
export function installedMetricReader(): ScrapeMetricReader {
  if (!installed) throw new Error('installMetricReader() was not called before src/utils/metrics.ts loaded');
  return installed;
}

/** One collected series: its attributes and its value (a number, or a histogram's count/sum). */
export interface CollectedPoint {
  attributes: Record<string, unknown>;
  value: number;
  count?: number;
  sum?: number;
}

/** Collect `reader` and return every data point of metric `name` (empty when absent). */
export async function collectMetric(reader: ScrapeMetricReader, name: string): Promise<CollectedPoint[]> {
  const { resourceMetrics } = await reader.collect();
  const metric: MetricData | undefined = resourceMetrics.scopeMetrics
    .flatMap((s) => s.metrics)
    .find((m) => m.descriptor.name === name);
  if (!metric) return [];
  return metric.dataPoints.map((p) => {
    const raw = p.value as number | { count: number; sum?: number };
    return typeof raw === 'number'
      ? { attributes: { ...p.attributes }, value: raw }
      : { attributes: { ...p.attributes }, value: raw.count, count: raw.count, sum: raw.sum };
  });
}

/**
 * The value of the one series of `name` whose attributes equal `attributes`
 * exactly, or `null` when that series is absent. For a histogram the value is
 * its observation count.
 */
export async function metricValue(
  reader: ScrapeMetricReader,
  name: string,
  attributes: Record<string, unknown> = {},
): Promise<number | null> {
  const want = JSON.stringify(Object.entries(attributes).sort());
  const point = (await collectMetric(reader, name))
    .find((p) => JSON.stringify(Object.entries(p.attributes).sort()) === want);
  return point ? point.value : null;
}
