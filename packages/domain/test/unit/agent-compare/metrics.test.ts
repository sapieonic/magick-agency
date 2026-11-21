import { describe, expect, it } from 'vitest';
import {
  COMPARE_BUILTIN_METRICS,
  COMPARE_MAX_METRICS,
  COMPARE_OUTCOME_SET_DEFINITION,
  type AgencyCompareMetricRef,
  type AgencyCompareOutcomeCode,
} from '@magick-agency/contracts/api/agency/compare';
import {
  catalogRecordsPromises,
  compareCohortMetric,
  compareOutcomeCodes,
  compareValue,
  resolveCompareMetric,
  resolveCompareMetrics,
} from '../../../src/agent-compare/metrics';

const CODES: AgencyCompareOutcomeCode[] = [
  { code: 'promise_to_pay', label: 'Promise to pay', is_success: true, requires_promise: true },
  { code: 'paid', label: 'Paid', is_success: true, requires_promise: false },
  { code: 'refused', label: 'Refused', is_success: false, requires_promise: false },
];
const NO_PROMISE = CODES.filter((c) => !c.requires_promise);
const builtin = (key: string) => ({ kind: 'builtin', key }) as AgencyCompareMetricRef;
const set = (codes: string[], better: 'higher' | 'lower' | 'neutral' = 'higher', label?: string): AgencyCompareMetricRef =>
  ({ kind: 'outcomes', codes, better, ...(label !== undefined ? { label } : {}) });

describe('compareOutcomeCodes', () => {
  it('reads the catalog in order, absent flags as false', () => {
    expect(compareOutcomeCodes([
      { code: 'sale', label: 'Sale', is_success: true },
      { code: 'ptp', label: 'Promise', requires_promise: true },
      { code: 'no', label: 'No' },
    ])).toEqual([
      { code: 'sale', label: 'Sale', is_success: true, requires_promise: false },
      { code: 'ptp', label: 'Promise', is_success: false, requires_promise: true },
      { code: 'no', label: 'No', is_success: false, requires_promise: false },
    ]);
    expect(catalogRecordsPromises(CODES)).toBe(true);
    expect(catalogRecordsPromises(NO_PROMISE)).toBe(false);
  });
});

describe('resolveCompareMetric', () => {
  it('a built-in: no label, its definition, flaggable unless neutral', () => {
    const r = resolveCompareMetric(builtin('success_rate'), CODES);
    expect(r).toEqual({ ok: true, metric: { id: 'success_rate', ref: builtin('success_rate'), label: null, definition: COMPARE_BUILTIN_METRICS.success_rate, flaggable: true } });
    const n = resolveCompareMetric(builtin('avg_call'), CODES);
    expect(n.ok && n.metric.flaggable).toBe(false);
  });

  it('an outcome set: the shared definition with the chosen direction, the given or default label', () => {
    const r = resolveCompareMetric(set(['refused'], 'lower', 'Said no'), CODES);
    expect(r).toEqual({
      ok: true,
      metric: {
        id: 'outcomes:lower:refused', ref: set(['refused'], 'lower', 'Said no'), label: 'Said no',
        definition: { ...COMPARE_OUTCOME_SET_DEFINITION, better: 'lower' }, flaggable: true,
      },
    });
    const d = resolveCompareMetric(set(['paid', 'promise_to_pay'], 'neutral'), CODES);
    expect(d.ok && d.metric.label).toBe('Paid or Promise to pay');
    expect(d.ok && d.metric.flaggable).toBe(false);
  });

  it.each([
    [builtin('promises_rate'), NO_PROMISE, 'needs_promise_catalog'],
    [builtin('promised_amount'), NO_PROMISE, 'needs_promise_catalog'],
    [set(['gone']), CODES, 'code_not_in_catalog'],
    [set(['Paid']), CODES, 'code_malformed'],
    [builtin('revenue'), CODES, 'key_unknown'],
  ] as const)('%j → %s', (ref, codes, problem) => {
    expect(resolveCompareMetric(ref, codes)).toEqual({ ok: false, problem });
  });

  it('the promise metrics resolve on a catalog that records promises', () => {
    expect(resolveCompareMetric(builtin('promises_rate'), CODES).ok).toBe(true);
  });
});

describe('resolveCompareMetrics', () => {
  it('resolves a list and a countable trend', () => {
    const r = resolveCompareMetrics([builtin('calls_handled'), set(['paid'])], builtin('promises_rate'), CODES, COMPARE_MAX_METRICS);
    expect(r.ok && r.metrics.map((m) => m.id)).toEqual(['calls_handled', 'outcomes:higher:paid']);
    expect(r.ok && r.trend?.id).toBe('promises_rate');
    const none = resolveCompareMetrics([builtin('calls_handled')], null, CODES, COMPARE_MAX_METRICS);
    expect(none.ok && none.trend).toBeNull();
  });

  it.each([
    [[], undefined, 'metrics_empty', null],
    [Array.from({ length: 7 }, () => builtin('calls_handled')), undefined, 'metrics_too_many', null],
    [[set(['paid', 'refused']), set(['refused', 'paid'], 'higher', 'Other label')], undefined, 'duplicate_metric', 1],
    [[builtin('calls_handled'), set(['gone'])], undefined, 'code_not_in_catalog', 1],
    [[builtin('calls_handled')], builtin('success_rate'), 'trend_not_countable', 'trend'],
    [[builtin('calls_handled')], set(['gone']), 'code_not_in_catalog', 'trend'],
  ] as const)('%#: %s', (refs, trend, problem, at) => {
    expect(resolveCompareMetrics(refs as AgencyCompareMetricRef[], trend, CODES, COMPARE_MAX_METRICS)).toEqual({ ok: false, problem, at });
  });

  it('the same set with another direction is another metric', () => {
    expect(resolveCompareMetrics([set(['paid'], 'higher'), set(['paid'], 'neutral')], null, CODES, COMPARE_MAX_METRICS).ok).toBe(true);
  });
});

describe('compareValue', () => {
  const rate = COMPARE_BUILTIN_METRICS.success_rate;
  it('a rate: a fraction, its interval, reportable at the floor', () => {
    const v = compareValue(rate, 5, 20);
    expect(v.value).toBe(0.25);
    expect(v.reportable).toBe(true);
    expect(v.interval?.[0]).toBeCloseTo(0.1119, 3);
    expect(compareValue(rate, 5, 19).reportable).toBe(false);
    expect(compareValue(rate, 5, 19).value).toBeCloseTo(5 / 19, 12);
  });

  it('a zero denominator is a null value, never 0, and not reportable', () => {
    expect(compareValue(rate, 0, 0)).toEqual({ value: null, numerator: 0, denominator: 0, reportable: false, interval: null });
    expect(compareValue(COMPARE_BUILTIN_METRICS.calls_per_hour, 0, 0).value).toBeNull();
  });

  it('counts and amounts are themselves, always reportable, no denominator', () => {
    expect(compareValue(COMPARE_BUILTIN_METRICS.calls_handled, 42, 999)).toEqual({ value: 42, numerator: 42, denominator: null, reportable: true, interval: null });
    expect(compareValue(COMPARE_BUILTIN_METRICS.promised_amount, 125000, null).value).toBe(125000);
  });

  it('per hour over logged-in seconds; seconds as an average with the roster floor', () => {
    const perHour = compareValue(COMPARE_BUILTIN_METRICS.calls_per_hour, 30, 7200);
    expect(perHour.value).toBe(15);
    expect(perHour.reportable).toBe(true);
    expect(perHour.interval).toBeNull();
    expect(compareValue(COMPARE_BUILTIN_METRICS.choose_time, 600, 20)).toMatchObject({ value: 30, reportable: true, interval: null });
    expect(compareValue(COMPARE_BUILTIN_METRICS.choose_time, 600, 19).reportable).toBe(false);
  });
});

describe('compareCohortMetric', () => {
  it('percentiles over reportable values only; pooled over every agent, thin ones included', () => {
    const def = COMPARE_BUILTIN_METRICS.success_rate;
    const values = [compareValue(def, 10, 40), compareValue(def, 10, 20), compareValue(def, 30, 60), compareValue(def, 3, 3)];
    const c = compareCohortMetric(def, values);
    expect(c.agents_rated).toBe(3);
    expect(c.median).toBe(0.5);
    expect(c.p25).toBeCloseTo(0.375, 12);
    expect(c.pooled).toBeCloseTo(53 / 123, 12);
  });

  it('counts have a band and no pooled figure; nothing rated is all null', () => {
    const def = COMPARE_BUILTIN_METRICS.calls_handled;
    expect(compareCohortMetric(def, [compareValue(def, 1, null), compareValue(def, 3, null)])).toEqual({ p25: 1.5, median: 2, p75: 2.5, pooled: null, agents_rated: 2 });
    expect(compareCohortMetric(COMPARE_BUILTIN_METRICS.success_rate, [])).toEqual({ p25: null, median: null, p75: null, pooled: null, agents_rated: 0 });
  });

  it('per hour pools calls over hours', () => {
    const def = COMPARE_BUILTIN_METRICS.calls_per_hour;
    expect(compareCohortMetric(def, [compareValue(def, 10, 3600), compareValue(def, 30, 7200)]).pooled).toBeCloseTo(40 / 3, 12);
  });
});
