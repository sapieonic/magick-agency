/**
 * The four ways `src/utils/metrics.ts` declares a metric. Each is ONE OTel
 * instrument — the one Grafana Cloud receives over OTLP and the local `:9090`
 * scrape renders — behind a small typed surface.
 *
 * Why a surface at all rather than the raw instrument:
 *
 * - **Label keys are part of the declaration.** `counter<'provider' | 'reason'>(…)`
 *   makes the attribute keys a compile-time contract at every write, the job
 *   prom-client's `labelNames` used to do, and it is what
 *   `test/unit/utils/metrics-otlp-contract.test.ts` audits against the
 *   committed OTLP snapshot. A raw OTel instrument takes any `Attributes`.
 * - **A gauge is a value, not a callback.** OTel only offers observable gauges
 *   for "last value", so every settable gauge needs state beside it; {@link gauge}
 *   owns that state instead of each metric growing its own `Map` + setter.
 *
 * The method names (`inc` / `observe` / `set`) are the historical ones, kept
 * because ~200 suites and every call site already speak them; they are thin
 * forwards to `add` / `record` / an observed value, with no validation on the
 * hot path.
 *
 * ⚠️ Type-only imports: this module must add nothing to the runtime graph, so
 * suites that mock `@opentelemetry/api` to capture instruments keep working.
 */
import type { Attributes, Meter } from '@opentelemetry/api';

/** Attribute values for a metric declared with label keys `L`. */
export type LabelValues<L extends string> = Partial<Record<L, string | number>>;

/**
 * `T`, provided it names no key outside `L`.
 *
 * `LabelValues<L>` alone only rejects an undeclared key in a FRESH object
 * literal — TypeScript's excess-property check does not apply to a variable,
 * so `const labels = { provider, tenant_id }; m.inc(labels)` compiled, and a
 * tenant id became a Grafana Cloud label. Every write signature takes its
 * labels as `ExactLabels<L, T>` with `T` inferred from the argument, which maps
 * each extra key to `never` and fails however the object was built. Pinned by
 * `test/unit/utils/metric-instruments-types.test.ts`.
 */
export type ExactLabels<L extends string, T> = T & Record<Exclude<keyof T, L>, never>;

/** OTel instrument options, exactly as each instrument is created with them. */
export interface InstrumentOptions {
  description: string;
  unit?: string;
}

export interface CounterMetric<L extends string = never> {
  inc(value?: number): void;
  inc<T extends LabelValues<L>>(labels: ExactLabels<L, T>, value?: number): void;
}

export interface HistogramMetric<L extends string = never> {
  observe(value: number): void;
  observe<T extends LabelValues<L>>(labels: ExactLabels<L, T>, value: number): void;
}

export interface GaugeMetric<L extends string = never> {
  set(value: number): void;
  set<T extends LabelValues<L>>(labels: ExactLabels<L, T>, value: number): void;
  /** Stop reporting every label set. */
  reset(): void;
}

/** What a {@link observableGauge} callback reports through, once per label set. */
export type GaugeObserver<L extends string> =
  <T extends LabelValues<L>>(value: number, labels?: ExactLabels<L, T>) => void;

/** A monotonic counter. `inc(labels, 0)` records the label set at zero. */
export function counter<L extends string = never>(
  meter: Meter,
  name: string,
  options: InstrumentOptions,
): CounterMetric<L> {
  const instrument = meter.createCounter(name, options);
  return {
    inc(labelsOrValue?: LabelValues<L> | number, value?: number): void {
      if (typeof labelsOrValue === 'object') instrument.add(value ?? 1, labelsOrValue as Attributes);
      else instrument.add(labelsOrValue ?? 1);
    },
  };
}

/**
 * A histogram with explicit bucket boundaries. They are not optional: without
 * them the SDK's defaults (`[0, 5, 10, … 10000]`, tuned for milliseconds) apply
 * while these metrics record seconds, which made every `histogram_quantile()`
 * over the OTLP series meaningless.
 */
export function histogram<L extends string = never>(
  meter: Meter,
  name: string,
  options: InstrumentOptions & { buckets: number[] },
): HistogramMetric<L> {
  const { buckets, ...rest } = options;
  const instrument = meter.createHistogram(name, { ...rest, advice: { explicitBucketBoundaries: buckets } });
  return {
    observe(labelsOrValue: LabelValues<L> | number, value?: number): void {
      if (typeof labelsOrValue === 'object') instrument.record(value as number, labelsOrValue as Attributes);
      else instrument.record(labelsOrValue);
    },
  };
}

/**
 * A last-value gauge: `set` stores, and each collection observes every stored
 * label set. Absolute `set` semantics on purpose — an UpDownCounter's `add(-1)`
 * walks negative when a teardown lands on a replica that never counted the
 * `+1`, which is how the active-call gauges used to drift.
 *
 * `initial` makes an UNLABELLED gauge report that value before the first `set`
 * (the active-call gauges read 0 from boot rather than absent). Without it a
 * gauge is absent until set, and after `reset()` every label set is absent
 * again from the next collection — the meter provider exports gauges with delta temporality
 * precisely so an unobserved set is not re-exported frozen
 * (`freshGaugeTemporality` in `otel-sdk-config.ts`).
 */
export function gauge<L extends string = never>(
  meter: Meter,
  name: string,
  options: InstrumentOptions,
  initial?: number,
): GaugeMetric<L> {
  const values = new Map<string, { attributes: Attributes | undefined; value: number }>();
  if (initial !== undefined) values.set('', { attributes: undefined, value: initial });
  meter.createObservableGauge(name, options).addCallback((result) => {
    for (const { attributes, value } of values.values()) {
      if (attributes) result.observe(value, attributes);
      else result.observe(value);
    }
  });
  return {
    set(labelsOrValue: LabelValues<L> | number, value?: number): void {
      if (typeof labelsOrValue === 'object') {
        values.set(labelKey(labelsOrValue), { attributes: { ...labelsOrValue } as Attributes, value: value as number });
      } else {
        values.set('', { attributes: undefined, value: labelsOrValue });
      }
    },
    reset(): void {
      values.clear();
    },
  };
}

/**
 * An observable gauge whose value is computed at collection time — for sources
 * that have no event to push from (a semaphore's queue, an LRU's size) or whose
 * readings expire. `observe` is called once per label set to report.
 */
export function observableGauge<L extends string = never>(
  meter: Meter,
  name: string,
  options: InstrumentOptions,
  callback: (observe: GaugeObserver<L>) => void,
): void {
  meter.createObservableGauge(name, options).addCallback((result) => {
    callback((value, labels) => {
      if (labels) result.observe(value, labels as Attributes);
      else result.observe(value);
    });
  });
}

/** Order-independent identity of a label set (`{a,b}` and `{b,a}` are one series). */
function labelKey(labels: Record<string, unknown>): string {
  return Object.keys(labels).sort().map(k => `${k}=${String(labels[k])}`).join('\u0000');
}
