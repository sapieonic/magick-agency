import { describe, expect, it } from 'vitest';
import {
  COMPARE_BUILTIN_METRICS,
  COMPARE_BUILTIN_METRIC_KEYS,
  COMPARE_CALLBACKS_MIN_DENOMINATOR,
  COMPARE_FINDING_CODES,
  COMPARE_LENSES,
  COMPARE_METRIC_BETTER,
  COMPARE_METRIC_GROUPS,
  COMPARE_METRIC_REF_PROBLEMS,
  COMPARE_METRIC_UNITS,
  COMPARE_NEXT_STEPS,
  COMPARE_OUTCOME_SET_DEFINITION,
  COMPARE_OUTCOME_SET_MAX_CODES,
  COMPARE_PAGE_MAX_AGENTS,
  COMPARE_TIME_MIN_CALLS,
  compareMetricId,
  compareMetricRefProblem,
  compareWindowProblem,
  defaultOutcomeSetBetter,
  defaultOutcomeSetLabel,
  parseCompareMetricId,
  type AgencyCompareMetricRef,
  type AgencyCompareOutcomeCode,
  type CompareBuiltinMetricKey,
  type CompareFindingCode,
  type CompareLens,
  type CompareMetricBetter,
  type CompareMetricGroup,
  type CompareMetricRefProblem,
  type CompareMetricUnit,
  type CompareNextStep,
} from '../src/api/agency/compare';
import { AGENCY_ROSTER_MIN_RATE_DENOMINATOR } from '../src/agency';
import { AgencyApi } from '../src/index';
import type { Equals } from './type-equals';

// ── Type-level: each list is exactly its union.
const _lenses: Equals<(typeof COMPARE_LENSES)[number], CompareLens> = true;
const _keys: Equals<(typeof COMPARE_BUILTIN_METRIC_KEYS)[number], CompareBuiltinMetricKey> = true;
const _units: Equals<(typeof COMPARE_METRIC_UNITS)[number], CompareMetricUnit> = true;
const _better: Equals<(typeof COMPARE_METRIC_BETTER)[number], CompareMetricBetter> = true;
const _groups: Equals<(typeof COMPARE_METRIC_GROUPS)[number], CompareMetricGroup> = true;
const _findings: Equals<(typeof COMPARE_FINDING_CODES)[number], CompareFindingCode> = true;
const _steps: Equals<(typeof COMPARE_NEXT_STEPS)[number], CompareNextStep> = true;
const _problems: Equals<(typeof COMPARE_METRIC_REF_PROBLEMS)[number], CompareMetricRefProblem> = true;
// Reached through the AgencyApi namespace like its siblings.
const _namespaced: Equals<AgencyApi.AgencyCompareMetricRef, AgencyCompareMetricRef> = true;
void [_lenses, _keys, _units, _better, _groups, _findings, _steps, _problems, _namespaced];

const CATALOG: AgencyCompareOutcomeCode[] = [
  { code: 'will_pay', label: 'Will pay', is_success: true, requires_promise: true },
  { code: 'part_paid', label: 'Part paid', is_success: true, requires_promise: false },
  { code: 'refused', label: 'Refused', is_success: false, requires_promise: false },
  { code: 'wrong_number', label: 'Wrong number', is_success: false, requires_promise: false },
];

describe('compare vocabularies (SNAPSHOT, written out by hand)', () => {
  it('lenses, keys, finding codes and next steps', () => {
    expect([...COMPARE_LENSES]).toEqual(['collections', 'sales', 'verification']);
    expect([...COMPARE_BUILTIN_METRIC_KEYS]).toEqual([
      'calls_handled', 'calls_per_hour', 'connect_rate', 'success_rate', 'promises_rate', 'promised_amount',
      'callbacks_booked', 'callbacks_kept_rate', 'avg_call', 'choose_time', 'no_outcome_rate', 'breaks_over_limit',
    ]);
    expect([...COMPARE_FINDING_CODES]).toEqual(['clear_gap', 'stands_out', 'over_break_limit', 'too_few_calls']);
    expect([...COMPARE_NEXT_STEPS]).toEqual([
      'listen_recent', 'listen_outcome', 'share_best_call', 'open_breaks', 'message_outcome_tip', 'late_callbacks',
    ]);
    expect(COMPARE_PAGE_MAX_AGENTS).toBe(3);
  });
});

describe('the metric catalog', () => {
  it('directions follow CP10: neutral ones are never flagged', () => {
    const by = (better: CompareMetricBetter) =>
      COMPARE_BUILTIN_METRIC_KEYS.filter((k) => COMPARE_BUILTIN_METRICS[k].better === better);
    expect(by('neutral')).toEqual(['calls_handled', 'calls_per_hour', 'connect_rate', 'promised_amount', 'callbacks_booked', 'avg_call']);
    expect(by('higher')).toEqual(['success_rate', 'promises_rate', 'callbacks_kept_rate']);
    expect(by('lower')).toEqual(['choose_time', 'no_outcome_rate', 'breaks_over_limit']);
  });

  it('every directional rate has a smallest gap; nothing else does', () => {
    for (const key of COMPARE_BUILTIN_METRIC_KEYS) {
      const d = COMPARE_BUILTIN_METRICS[key];
      expect(d.min_gap !== null, key).toBe(d.unit === 'rate' && d.better !== 'neutral');
    }
    expect(COMPARE_BUILTIN_METRICS.success_rate.min_gap).toBe(0.05);
    expect(COMPARE_BUILTIN_METRICS.no_outcome_rate.min_gap).toBe(0.04);
    expect(COMPARE_BUILTIN_METRICS.callbacks_kept_rate.min_gap).toBe(0.12);
    expect(COMPARE_OUTCOME_SET_DEFINITION.min_gap).toBe(0.05);
  });

  it('rates use the roster floor (CP9), call-backs kept their own, counts none', () => {
    expect(COMPARE_BUILTIN_METRICS.success_rate.min_denominator).toBe(AGENCY_ROSTER_MIN_RATE_DENOMINATOR);
    expect(COMPARE_BUILTIN_METRICS.connect_rate.min_denominator).toBe(AGENCY_ROSTER_MIN_RATE_DENOMINATOR);
    expect(COMPARE_OUTCOME_SET_DEFINITION.min_denominator).toBe(AGENCY_ROSTER_MIN_RATE_DENOMINATOR);
    expect(COMPARE_TIME_MIN_CALLS).toBe(AGENCY_ROSTER_MIN_RATE_DENOMINATOR);
    expect(COMPARE_BUILTIN_METRICS.callbacks_kept_rate.min_denominator).toBe(COMPARE_CALLBACKS_MIN_DENOMINATOR);
    expect(COMPARE_CALLBACKS_MIN_DENOMINATOR).toBe(8);
    for (const key of ['calls_handled', 'callbacks_booked', 'promised_amount', 'breaks_over_limit'] as const) {
      expect(COMPARE_BUILTIN_METRICS[key].min_denominator, key).toBeNull();
    }
  });

  it('only promises_rate is countable among the built-ins; promise metrics need a promise catalog', () => {
    expect(COMPARE_BUILTIN_METRIC_KEYS.filter((k) => COMPARE_BUILTIN_METRICS[k].countable)).toEqual(['promises_rate']);
    expect(COMPARE_BUILTIN_METRIC_KEYS.filter((k) => COMPARE_BUILTIN_METRICS[k].needs_promise_catalog))
      .toEqual(['promises_rate', 'promised_amount']);
    expect(COMPARE_OUTCOME_SET_DEFINITION.countable).toBe(true);
    expect(Object.isFrozen(COMPARE_BUILTIN_METRICS)).toBe(true);
  });
});

describe('metric ids', () => {
  it('a built-in is its key', () => {
    expect(compareMetricId({ kind: 'builtin', key: 'choose_time' })).toBe('choose_time');
    expect(parseCompareMetricId('choose_time')).toEqual({ kind: 'builtin', key: 'choose_time' });
  });

  it('an outcome set sorts its codes; label and order do not change the id; direction does', () => {
    const a = compareMetricId({ kind: 'outcomes', codes: ['will_pay', 'part_paid'], better: 'higher', label: 'Paying' });
    const b = compareMetricId({ kind: 'outcomes', codes: ['part_paid', 'will_pay'], better: 'higher' });
    expect(a).toBe('outcomes:higher:part_paid,will_pay');
    expect(b).toBe(a);
    expect(compareMetricId({ kind: 'outcomes', codes: ['part_paid', 'will_pay'], better: 'neutral' })).not.toBe(a);
  });

  it('round-trips a canonical id and refuses anything else', () => {
    expect(parseCompareMetricId('outcomes:lower:refused')).toEqual({ kind: 'outcomes', codes: ['refused'], better: 'lower' });
    for (const bad of [
      'nonsense', '', 'outcomes', 'outcomes:higher:', 'outcomes:better:refused', 'outcomes:higher:will_pay,part_paid',
      'outcomes:higher:a,a', 'outcomes:higher:Refused', 'outcomes:higher:a,b,c,d,e,f', 'other:higher:a', 'outcomes:higher:a:b',
    ]) {
      expect(parseCompareMetricId(bad), bad).toBeNull();
    }
    const five = ['a', 'b', 'c', 'd', 'e'];
    expect(parseCompareMetricId(`outcomes:neutral:${five.join(',')}`)).toEqual({ kind: 'outcomes', codes: five, better: 'neutral' });
  });
});

describe('compareMetricRefProblem', () => {
  const set = (o: Record<string, unknown>) => ({ kind: 'outcomes', codes: ['will_pay'], better: 'higher', ...o }) as AgencyCompareMetricRef;
  it.each([
    [{ kind: 'builtin', key: 'success_rate' }, null],
    [{ kind: 'builtin', key: 'sales' }, 'key_unknown'],
    [{ kind: 'formula', key: 'x' }, 'kind_invalid'],
    [set({}), null],
    [set({ codes: [] }), 'codes_empty'],
    [set({ codes: 'will_pay' }), 'codes_empty'],
    [set({ codes: Array.from({ length: COMPARE_OUTCOME_SET_MAX_CODES + 1 }, (_, i) => `c${i}`) }), 'codes_too_many'],
    [set({ codes: ['will_pay', 'will_pay'] }), 'codes_duplicate'],
    [set({ codes: ['Will_pay'] }), 'code_malformed'],
    [set({ codes: ['x'.repeat(51)] }), 'code_malformed'],
    [set({ codes: [3] }), 'code_malformed'],
    [set({ better: 'up' }), 'better_invalid'],
    [set({ label: '' }), 'label_invalid'],
    [set({ label: ' Paying' }), 'label_invalid'],
    [set({ label: 'x'.repeat(61) }), 'label_invalid'],
    [set({ label: 'x'.repeat(60) }), null],
  ] as Array<[AgencyCompareMetricRef, CompareMetricRefProblem | null]>)('%j → %s', (ref, problem) => {
    expect(compareMetricRefProblem(ref)).toBe(problem);
  });
});

describe('outcome set defaults (CP17, CP18)', () => {
  it('higher only when every code is a success; never lower', () => {
    expect(defaultOutcomeSetBetter(['will_pay', 'part_paid'], CATALOG)).toBe('higher');
    expect(defaultOutcomeSetBetter(['will_pay', 'refused'], CATALOG)).toBe('neutral');
    expect(defaultOutcomeSetBetter(['refused'], CATALOG)).toBe('neutral');
    expect(defaultOutcomeSetBetter(['gone'], CATALOG)).toBe('neutral');
    expect(defaultOutcomeSetBetter([], CATALOG)).toBe('neutral');
  });

  it('the label joins the catalog labels "A, B or C", a missing code as itself', () => {
    expect(defaultOutcomeSetLabel(['will_pay'], CATALOG)).toBe('Will pay');
    expect(defaultOutcomeSetLabel(['will_pay', 'part_paid'], CATALOG)).toBe('Will pay or Part paid');
    expect(defaultOutcomeSetLabel(['refused', 'wrong_number', 'gone'], CATALOG)).toBe('Refused, Wrong number or gone');
  });
});

describe('compareWindowProblem', () => {
  it('is the reports rule with the compare code', () => {
    expect(compareWindowProblem('2026-10-01', '2026-10-31')).toBeNull();
    expect(compareWindowProblem('2026-10-01', '2026-10-30')).toBeNull();
    expect(compareWindowProblem('2026-10-02', '2026-11-01')).toBe('compare_window_invalid');
    expect(compareWindowProblem('2026-10-02', '2026-10-01')).toBe('compare_window_invalid');
    expect(compareWindowProblem('2026-10-01', '2026-10-05', '2026-10-04')).toBe('compare_window_invalid');
    expect(compareWindowProblem('2026-13-01', '2026-13-02')).toBe('compare_window_invalid');
  });
});
