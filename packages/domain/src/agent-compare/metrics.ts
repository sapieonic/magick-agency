/**
 * ─── COMPARE AGENTS — RESOLVING METRICS AND BUILDING THEIR FIGURES ──────────
 *
 * A LEAF module: pure functions over contract types and the two sibling leaves. No I/O.
 *
 * The server resolves every requested ref against the campaign's CURRENT catalog with
 * {@link resolveCompareMetrics} (its refusal is `compare_metric_invalid`, or `compare_view_invalid`
 * for a saved view), turns each agent's counts into a value with {@link compareValue}, and the
 * cohort's into a band with {@link compareCohortMetric}. The console uses the same functions to
 * offer only what the server would accept, so the picker and the route cannot disagree.
 */
import type { AgencyDisposition } from '@magick-agency/contracts/agency';
import {
  COMPARE_BUILTIN_METRICS,
  COMPARE_OUTCOME_SET_DEFINITION,
  compareMetricId,
  compareMetricRefProblem,
  defaultOutcomeSetLabel,
  type AgencyCompareCohortMetric,
  type AgencyCompareMetricInfo,
  type AgencyCompareMetricRef,
  type AgencyCompareOutcomeCode,
  type AgencyCompareValue,
  type CompareMetricDefinition,
  type CompareMetricRefProblem,
} from '@magick-agency/contracts/api/agency/compare';
import { cohortPercentiles } from './percentiles';
import { wilsonInterval } from './wilson';

/** A campaign's `disposition_catalog` as the compare page reads it, in catalog order. */
export function compareOutcomeCodes(catalog: readonly AgencyDisposition[]): AgencyCompareOutcomeCode[] {
  return catalog.map((entry) => ({
    code: entry.code,
    label: entry.label,
    is_success: entry.is_success === true,
    requires_promise: entry.requires_promise === true,
  }));
}

/** The catalog records promises: `promises_rate` and `promised_amount` are offered (CP2). */
export function catalogRecordsPromises(codes: readonly AgencyCompareOutcomeCode[]): boolean {
  return codes.some((c) => c.requires_promise);
}

/** Why one ref cannot be compared on this campaign. */
export type CompareMetricResolveProblem =
  | CompareMetricRefProblem
  /** An outcome code is not in the campaign's current catalog. */
  | 'code_not_in_catalog'
  /** `promises_rate` or `promised_amount` on a catalog with no `requires_promise` entry. */
  | 'needs_promise_catalog';

/** Why a metric list (with its trend) cannot be compared on this campaign. */
export type CompareMetricsResolveProblem =
  | CompareMetricResolveProblem
  /** No metrics. */
  | 'metrics_empty'
  /** More than `COMPARE_MAX_METRICS` (the route answers `compare_too_many_metrics`; a view `compare_view_invalid`). */
  | 'metrics_too_many'
  /** Two refs with one id. */
  | 'duplicate_metric'
  /** The trend's metric is not `countable` (an outcome set or `promises_rate`). */
  | 'trend_not_countable';

export type CompareMetricResolution =
  | { ok: true; metric: AgencyCompareMetricInfo }
  | { ok: false; problem: CompareMetricResolveProblem };

/** One ref against the campaign's current outcome codes. */
export function resolveCompareMetric(
  ref: AgencyCompareMetricRef,
  codes: readonly AgencyCompareOutcomeCode[],
): CompareMetricResolution {
  const shape = compareMetricRefProblem(ref);
  if (shape !== null) return { ok: false, problem: shape };
  if (ref.kind === 'builtin') {
    const definition = COMPARE_BUILTIN_METRICS[ref.key];
    if (definition.needs_promise_catalog && !catalogRecordsPromises(codes)) return { ok: false, problem: 'needs_promise_catalog' };
    return {
      ok: true,
      metric: { id: compareMetricId(ref), ref, label: null, definition, flaggable: definition.better !== 'neutral' },
    };
  }
  const known = new Set(codes.map((c) => c.code));
  if (!ref.codes.every((code) => known.has(code))) return { ok: false, problem: 'code_not_in_catalog' };
  const definition: CompareMetricDefinition = { ...COMPARE_OUTCOME_SET_DEFINITION, better: ref.better };
  return {
    ok: true,
    metric: {
      id: compareMetricId(ref),
      ref,
      label: ref.label ?? defaultOutcomeSetLabel(ref.codes, codes),
      definition,
      flaggable: ref.better !== 'neutral',
    },
  };
}

export type CompareMetricsResolution =
  | { ok: true; metrics: AgencyCompareMetricInfo[]; trend: AgencyCompareMetricInfo | null }
  | {
      ok: false;
      problem: CompareMetricsResolveProblem;
      /** Which ref failed: its index in `metrics`, or `'trend'`; null for a list-level problem. */
      at: number | 'trend' | null;
    };

/**
 * A request's (or a view's) metrics and trend against the campaign's current outcome codes. The
 * first problem found wins, list-level problems first, then each metric in order, then the trend.
 */
export function resolveCompareMetrics(
  refs: readonly AgencyCompareMetricRef[],
  trend: AgencyCompareMetricRef | null | undefined,
  codes: readonly AgencyCompareOutcomeCode[],
  maxMetrics: number,
): CompareMetricsResolution {
  if (refs.length === 0) return { ok: false, problem: 'metrics_empty', at: null };
  if (refs.length > maxMetrics) return { ok: false, problem: 'metrics_too_many', at: null };
  const metrics: AgencyCompareMetricInfo[] = [];
  const seen = new Set<string>();
  for (const [i, ref] of refs.entries()) {
    const r = resolveCompareMetric(ref, codes);
    if (!r.ok) return { ok: false, problem: r.problem, at: i };
    if (seen.has(r.metric.id)) return { ok: false, problem: 'duplicate_metric', at: i };
    seen.add(r.metric.id);
    metrics.push(r.metric);
  }
  if (trend === null || trend === undefined) return { ok: true, metrics, trend: null };
  const t = resolveCompareMetric(trend, codes);
  if (!t.ok) return { ok: false, problem: t.problem, at: 'trend' };
  if (!t.metric.definition.countable) return { ok: false, problem: 'trend_not_countable', at: 'trend' };
  return { ok: true, metrics, trend: t.metric };
}

/**
 * One agent's figure for a metric, from its two counts (see {@link AgencyCompareValue} for what
 * `numerator` and `denominator` are per unit). A zero denominator gives a null value, never 0.
 * For `count` and `amount` the denominator is ignored and served as null.
 */
export function compareValue(definition: CompareMetricDefinition, numerator: number, denominator: number | null): AgencyCompareValue {
  if (definition.unit === 'count' || definition.unit === 'amount') {
    return { value: numerator, numerator, denominator: null, reportable: true, interval: null };
  }
  const den = denominator ?? 0;
  const value = den > 0 ? (definition.unit === 'per_hour' ? (numerator / den) * 3600 : numerator / den) : null;
  const reportable = value !== null && (definition.min_denominator === null || den >= definition.min_denominator);
  const interval = definition.unit === 'rate' ? wilsonInterval(numerator, den) : null;
  return { value, numerator, denominator: denominator ?? 0, reportable, interval };
}

/**
 * The cohort's band and pooled figure for one metric over EVERY cohort agent's value (picked ones
 * included). Percentiles take only reportable, non-null values; `pooled` sums every agent's counts,
 * thin ones included (the roster's rule: a ratio of two sums weighs each agent by their calls).
 */
export function compareCohortMetric(
  definition: CompareMetricDefinition,
  values: readonly AgencyCompareValue[],
): AgencyCompareCohortMetric {
  const rated = values.filter((v) => v.reportable && v.value !== null).map((v) => v.value as number);
  let pooled: number | null = null;
  if (definition.unit !== 'count' && definition.unit !== 'amount') {
    const num = values.reduce((sum, v) => sum + v.numerator, 0);
    const den = values.reduce((sum, v) => sum + (v.denominator ?? 0), 0);
    pooled = den > 0 ? (definition.unit === 'per_hour' ? (num / den) * 3600 : num / den) : null;
  }
  return { ...cohortPercentiles(rated), pooled, agents_rated: rated.length };
}
