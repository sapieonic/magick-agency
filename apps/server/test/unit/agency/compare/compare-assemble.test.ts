import { describe, expect, it } from 'vitest';
import {
  COMPARE_BUILTIN_METRIC_KEYS,
  type AgencyCompareMetricInfo,
  type AgencyCompareMetricRef,
  type AgencyCompareOutcomeCode,
} from '@magick-agency/contracts/api/agency/compare';
import { resolveCompareMetrics } from '@magick-agency/domain/agent-compare';
import {
  assembleCompareResponse,
  daySplitOf,
  impossibleFigure,
  metricCounts,
  metricSources,
  trendOf,
  type CompareAgentSources,
} from '../../../../src/agency/compare/assemble.js';

/**
 * Compare agents' answer from the read's figures (docs/compare-agents.md §3, §6): each metric's
 * numerator and denominator, the day split, the trend, and the response around them.
 */

const CODES: AgencyCompareOutcomeCode[] = [
  { code: 'interested', label: 'Interested', is_success: true, requires_promise: false },
  { code: 'will_pay', label: 'Will pay', is_success: false, requires_promise: true },
  { code: 'refused', label: 'Refused', is_success: false, requires_promise: false },
];

function resolve(refs: AgencyCompareMetricRef[], trend: AgencyCompareMetricRef | null = null): { metrics: AgencyCompareMetricInfo[]; trend: AgencyCompareMetricInfo | null } {
  const r = resolveCompareMetrics(refs, trend, CODES, 6);
  if (!r.ok) throw new Error(r.problem);
  return r;
}
const b = (key: string) => ({ kind: 'builtin', key }) as AgencyCompareMetricRef;

function agent(id: string, o: Partial<Omit<CompareAgentSources, 'roster'>> & { roster?: Partial<CompareAgentSources['roster']> } = {}): CompareAgentSources {
  return {
    agent_user_id: id,
    roster: { connected: 40, successes: 16, talk_seconds: 2400, wrapup_seconds: 800, measured_wrapups: 40, human_connects: 36, first_dials: 60, ...o.roster },
    occupancy: o.occupancy ?? { shift_seconds: 28_800, by_state: { available: 20_000, reserved: 800.4, on_call: 4000, wrapup: 1000.3, break: 2999.3, offline: 500 } },
    rollup: o.rollup ?? new Map<string | null, number>([['interested', 16], ['will_pay', 8], ['refused', 10], [null, 3], ['no_disposition', 1], ['voicemail', 2]]),
    promises: o.promises ?? { promises: 9, amount: 12_345.5, other_conversations: 2 },
    callbacks: o.callbacks ?? { on_time: 5, late: 2, missed: 3, pending_future: 1, pending_due: 1 },
    break_overruns: o.break_overruns ?? 1,
  };
}

describe('metricCounts: one definition per number (the catalog table)', () => {
  const a = agent('a');
  const counts = (ref: AgencyCompareMetricRef) => metricCounts({ ref }, a);
  it.each([
    ['calls_handled', 40, null],
    ['calls_per_hour', 40, 28_800],
    ['connect_rate', 36, 60],
    ['success_rate', 16, 40],
    ['promises_rate', 9, 42],
    ['promised_amount', 12_345.5, null],
    ['callbacks_booked', 12, null],
    ['callbacks_kept_rate', 5, 10],
    ['avg_call', 2400, 40],
    ['choose_time', 800, 40],
    ['no_outcome_rate', 4, 40],
    ['breaks_over_limit', 1, null],
  ])('%s is %d over %s', (key, numerator, denominator) => {
    expect(counts(b(key))).toEqual({ numerator, denominator });
  });

  it('covers every built-in', () => {
    for (const key of COMPARE_BUILTIN_METRIC_KEYS) expect(() => counts(b(key))).not.toThrow();
  });

  it('an outcome set: conversations ending in any of its codes over every conversation; a null code is never in a set', () => {
    expect(counts({ kind: 'outcomes', codes: ['will_pay', 'refused'], better: 'lower' })).toEqual({ numerator: 18, denominator: 40 });
  });

  it('a source the read did not run is an error, never a zero', () => {
    expect(() => metricCounts({ ref: b('promises_rate') }, { ...a, promises: null })).toThrow(/promises source/);
    expect(() => metricCounts({ ref: b('calls_per_hour') }, { ...a, occupancy: null })).toThrow(/occupancy source/);
  });

  it('metricSources names exactly what each metric reads beyond the roster', () => {
    expect(metricSources({ ref: b('success_rate') })).toEqual([]);
    expect(metricSources({ ref: b('calls_per_hour') })).toEqual(['occupancy']);
    expect(metricSources({ ref: b('promised_amount') })).toEqual(['promises']);
    expect(metricSources({ ref: b('callbacks_kept_rate') })).toEqual(['callbacks']);
    expect(metricSources({ ref: b('no_outcome_rate') })).toEqual(['rollup']);
    expect(metricSources({ ref: b('breaks_over_limit') })).toEqual(['breaks']);
    expect(metricSources({ ref: { kind: 'outcomes', codes: ['refused'], better: 'neutral' } })).toEqual(['rollup']);
  });
});

describe('daySplitOf', () => {
  it('whole seconds summing to the rounded shift, reserved folded into waiting', () => {
    const split = daySplitOf(agent('a').occupancy);
    expect(split.on_call + split.choosing + split.break + split.waiting).toBe(split.shift_seconds);
    expect(split.shift_seconds).toBe(28_800);
    expect(split.on_call).toBe(4000);
    expect(split.waiting).toBeGreaterThanOrEqual(20_800);
  });
  it('all zero with no occupancy', () => {
    expect(daySplitOf(null)).toEqual({ on_call: 0, choosing: 0, break: 0, waiting: 0, shift_seconds: 0 });
  });
});

describe('trendOf', () => {
  const dates = ['2026-11-01', '2026-11-02', '2026-11-03'];
  const loggedIn = new Map<string, Set<string>>([
    ['a', new Set(dates)],
    ['b', new Set(['2026-11-01', '2026-11-03'])],
    ['c', new Set(['2026-11-01'])],
  ]);
  const counts = new Map<string, Map<string, number>>([
    ['a', new Map([['2026-11-01', 3], ['2026-11-03', 1]])],
    ['b', new Map([['2026-11-01', 5], ['2026-11-02', 9]])],
    ['c', new Map([['2026-11-01', 1]])],
  ]);
  const t = trendOf('m', ['a', 'b'], ['a', 'b', 'c'], { dates, counts, loggedIn });

  it('a count on a logged-in day (0 is a real zero); a count with no campaign session is a worked day; null on a day off with none', () => {
    // b's 9 on the 2nd: promises taken on the soft phone or an inbound call, no campaign session that day.
    expect(t.agents).toEqual([
      { agent_user_id: 'a', counts: [3, 0, 1] },
      { agent_user_id: 'b', counts: [5, 9, 0] },
    ]);
    expect(trendOf('m', ['c'], ['c'], { dates, counts, loggedIn }).agents).toEqual([{ agent_user_id: 'c', counts: [1, null, null] }]);
  });
  it('the cohort median over who worked that day (a count counts as working it); null when nobody did', () => {
    expect(t.cohort_median).toEqual([3, 4.5, 0.5]);
    expect(trendOf('m', [], ['c'], { dates, counts, loggedIn }).cohort_median).toEqual([1, null, null]);
  });
});

describe('assembleCompareResponse', () => {
  const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
  // Six agents at 40% success, one (b) at 2 of 40: a clear gap the findings must name.
  const cohort = ids.map((id) => agent(id, id === 'b' ? { roster: { successes: 2 } } : {}));
  const { metrics, trend } = resolve([b('success_rate'), b('calls_handled'), { kind: 'outcomes', codes: ['will_pay'], better: 'higher', label: 'Pays' }], { kind: 'outcomes', codes: ['will_pay'], better: 'higher' });
  const res = assembleCompareResponse({
    campaignId: 'camp', from: '2026-11-01', to: '2026-11-03', timezone: 'Asia/Kolkata', asOf: new Date('2026-11-04T00:00:00Z'),
    metrics, trendMetric: trend, picked: ['b', 'a'], cohort, names: new Map([['a', 'Asha']]),
    trend: { dates: ['2026-11-01'], counts: new Map([['a', new Map([['2026-11-01', 2]])]]), loggedIn: new Map([['a', new Set(['2026-11-01'])]]) },
  });

  it('the picked agents in page order, every metric keyed by id, names or null', () => {
    expect(res.agents.map((a) => [a.agent_user_id, a.agent_name])).toEqual([['b', null], ['a', 'Asha']]);
    expect(Object.keys(res.agents[0]!.values)).toEqual(metrics.map((m) => m.id));
    expect(res.agents[0]!.values['success_rate']).toMatchObject({ value: 2 / 40, numerator: 2, denominator: 40, reportable: true });
    expect(res.agents[1]!.values['outcomes:higher:will_pay']).toMatchObject({ value: 8 / 40, reportable: true });
  });

  it('the cohort band over every cohort agent, the pooled rate a ratio of sums', () => {
    expect(res.cohort.agents).toBe(7);
    expect(res.cohort.per_metric['success_rate']).toMatchObject({ median: 0.4, agents_rated: 7 });
    expect(res.cohort.per_metric['success_rate']!.pooled).toBeCloseTo((6 * 16 + 2) / 280, 12);
    expect(res.cohort.per_metric['calls_handled']).toMatchObject({ pooled: null, median: 40 });
  });

  it('the findings over the whole cohort name the gap; the trend and the window echo back', () => {
    expect(res.findings).toEqual([expect.objectContaining({ code: 'clear_gap', agent_user_id: 'b', metric: 'success_rate', baseline: 0.4 })]);
    expect(res.trend).toMatchObject({ metric: 'outcomes:higher:will_pay', dates: ['2026-11-01'], agents: [{ agent_user_id: 'b', counts: [null] }, { agent_user_id: 'a', counts: [2] }] });
    expect(res).toMatchObject({ campaign_id: 'camp', from: '2026-11-01', to: '2026-11-03', timezone: 'Asia/Kolkata', as_of: '2026-11-04T00:00:00.000Z' });
    expect(res.metrics[2]!.label).toBe('Pays');
  });

  it('no trend asked: none served', () => {
    const r = assembleCompareResponse({
      campaignId: 'camp', from: 'x', to: 'y', timezone: 'UTC', asOf: new Date(0), metrics, trendMetric: null, picked: ['a'], cohort, names: new Map(), trend: null,
    });
    expect(r.trend).toBeNull();
    expect(r.trend_metric).toBeNull();
  });

  it('impossible counts are withheld: null, not reportable, out of the band, the pooled figure and the findings', () => {
    // Agent b recorded 30 promises over 25 conversations (promises by when written, calls by when dialled),
    // and logged 600 s of shift around 2,400 s of talk and 800 s of wrap-up.
    const odd = agent('b', { promises: { promises: 30, amount: 0, other_conversations: 0 }, roster: { connected: 25 }, occupancy: { shift_seconds: 600, by_state: { available: 600, reserved: 0, on_call: 0, wrapup: 0, break: 0, offline: 0 } } });
    const rest = ids.filter((x) => x !== 'b').map((x) => agent(x, { promises: { promises: 4, amount: 0, other_conversations: 0 } }));
    const m = resolve([b('promises_rate'), b('calls_per_hour')]);
    const r = assembleCompareResponse({
      campaignId: 'c', from: 'x', to: 'y', timezone: 'UTC', asOf: new Date(0), metrics: m.metrics, trendMetric: null,
      picked: ['b', 'a'], cohort: [odd, ...rest], names: new Map(), trend: null,
    });
    expect(r.agents[0]!.values['promises_rate']).toEqual({ value: null, numerator: 30, denominator: 25, reportable: false, interval: null, withheld: 'counts_disagree' });
    expect(r.agents[0]!.values['calls_per_hour']).toEqual({ value: null, numerator: 25, denominator: 600, reportable: false, interval: null, withheld: 'counts_disagree' });
    expect(r.agents[1]!.values['promises_rate']).toMatchObject({ value: 4 / 40, reportable: true });
    // Out of the band and the pooled rate: six agents at 4 of 40.
    expect(r.cohort.per_metric['promises_rate']).toMatchObject({ agents_rated: 6, median: 4 / 40 });
    expect(r.cohort.per_metric['promises_rate']!.pooled).toBeCloseTo(4 / 40, 12);
    expect(r.cohort.per_metric['calls_per_hour']!.agents_rated).toBe(6);
    // Never "too few calls", never a gap: the agent is not judged on a figure that cannot be right.
    expect(r.findings.filter((f) => f.agent_user_id === 'b')).toEqual([]);
  });

  it('impossibleFigure: a rate over 1, a shift shorter than the calls in it; nothing else', () => {
    const a = agent('a');
    const rate = resolve([b('success_rate')]).metrics[0]!;
    const perHour = resolve([b('calls_per_hour')]).metrics[0]!;
    const count = resolve([b('calls_handled')]).metrics[0]!;
    expect(impossibleFigure(rate, a, { numerator: 41, denominator: 40 })).toBe(true);
    expect(impossibleFigure(rate, a, { numerator: 40, denominator: 40 })).toBe(false);
    expect(impossibleFigure(perHour, a, { numerator: 40, denominator: 3199 })).toBe(true);
    expect(impossibleFigure(perHour, a, { numerator: 40, denominator: 3200 })).toBe(false);
    expect(impossibleFigure(count, a, { numerator: 1e9, denominator: null })).toBe(false);
  });

  it('a picked agent outside the cohort is a programming error', () => {
    expect(() => assembleCompareResponse({
      campaignId: 'c', from: 'x', to: 'y', timezone: 'UTC', asOf: new Date(0), metrics, trendMetric: null, picked: ['zz'], cohort, names: new Map(), trend: null,
    })).toThrow(/not in the cohort/);
  });
});
