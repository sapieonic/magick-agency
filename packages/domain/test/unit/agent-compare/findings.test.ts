import { describe, expect, it } from 'vitest';
import {
  COMPARE_BUILTIN_METRICS,
  COMPARE_OUTCOME_SET_DEFINITION,
  compareMetricId,
  type AgencyCompareMetricRef,
  type CompareBuiltinMetricKey,
  type CompareMetricBetter,
} from '@magick-agency/contracts/api/agency/compare';
import {
  compareFindings,
  type CompareAgentFigure,
  type CompareFindingsMetric,
} from '../../../src/agent-compare/findings';

// ── Builders ────────────────────────────────────────────────────────────────

/** A figure with a denominator: a rate (hits / calls) or a time (seconds / wrap-ups). */
const fig = (id: string, numerator: number, denominator: number, floor = 20): CompareAgentFigure => ({
  agent_user_id: id,
  numerator,
  denominator,
  value: denominator > 0 ? numerator / denominator : null,
  reportable: denominator > 0 && denominator >= floor,
});
/** A count (breaks over their limit): no denominator, no floor. */
const count = (id: string, n: number): CompareAgentFigure => ({ agent_user_id: id, numerator: n, denominator: null, value: n, reportable: true });
/** The rest of the cohort, `o0`, `o1`, … */
const rest = (pairs: Array<[number, number]>, floor = 20) => pairs.map(([k, n], i) => fig(`o${i}`, k, n, floor));

const builtin = (key: CompareBuiltinMetricKey): CompareFindingsMetric['metric'] => {
  const ref: AgencyCompareMetricRef = { kind: 'builtin', key };
  return { id: compareMetricId(ref), ref, definition: COMPARE_BUILTIN_METRICS[key] };
};
const outcomes = (codes: string[], better: CompareMetricBetter): CompareFindingsMetric['metric'] => {
  const ref: AgencyCompareMetricRef = { kind: 'outcomes', codes, better };
  return { id: compareMetricId(ref), ref, definition: { ...COMPARE_OUTCOME_SET_DEFINITION, better } };
};
const on = (metric: CompareFindingsMetric['metric'], cohort: CompareAgentFigure[]): CompareFindingsMetric => ({ metric, cohort });

const SUCCESS = builtin('success_rate');
const NO_OUTCOME = builtin('no_outcome_rate');
const KEPT = builtin('callbacks_kept_rate');
const CHOOSE = builtin('choose_time');
const BREAKS = builtin('breaks_over_limit');
const CONNECT = builtin('connect_rate');
const WILL_PAY = outcomes(['will_pay'], 'higher');
const REFUSED = outcomes(['refused'], 'lower');
const NEUTRAL_SET = outcomes(['wrong_number'], 'neutral');

/** The rest of the Priya cohort, first window: 86 of 308 across five agents, all over the floor. */
const REST_86_OF_308: Array<[number, number]> = [[17, 60], [17, 62], [17, 62], [17, 62], [18, 62]];
/** The rest of the Priya cohort, longer window: 561 of 2005 across five agents. */
const REST_561_OF_2005: Array<[number, number]> = [[112, 401], [112, 401], [112, 401], [112, 401], [113, 401]];
/** Five agents at 23% (230 of 1000 each), the rest of a cohort for the "gap too small" cases. */
const REST_AT_23: Array<[number, number]> = Array.from({ length: 5 }, () => [230, 1000] as [number, number]);
/** Six agents at 23%: a cohort that is rated without the picked agent (who may be under the floor). */
const REST6_AT_23: Array<[number, number]> = Array.from({ length: 6 }, () => [230, 1000] as [number, number]);
/** Five agents, 60 seconds a wrap-up on 50 wrap-ups each. */
const REST_TIMES = rest(Array.from({ length: 5 }, () => [3000, 50] as [number, number]));

const sum = (pairs: Array<[number, number]>) => pairs.reduce(([a, b], [k, n]) => [a + k, b + n], [0, 0]);

describe('the fixtures add up', () => {
  it('as their names say', () => {
    expect(sum(REST_86_OF_308)).toEqual([86, 308]);
    expect(sum(REST_561_OF_2005)).toEqual([561, 2005]);
  });
});

// ── Rates ───────────────────────────────────────────────────────────────────

describe('clear_gap on a rate (the agent\'s interval against the REST of the cohort)', () => {
  it('Priya, 5 of 29 against the rest\'s 86 of 308: an 11-point gap chance can still explain → not clear', () => {
    const r = compareFindings({ picked: ['priya'], metrics: [on(SUCCESS, [fig('priya', 5, 29), ...rest(REST_86_OF_308)])] });
    expect(r.findings).toEqual([]);
    expect(r.not_clear).toHaveLength(1);
    const [entry] = r.not_clear;
    expect(entry).toMatchObject({ code: 'clear_gap', agent_user_id: 'priya', metric: 'success_rate', count: 29, next_step: null, ratio: null });
    expect(entry!.value).toBeCloseTo(5 / 29, 12);
    expect(entry!.baseline).toBeCloseTo(86 / 308, 12);
    // The interval reaches the rest's rate: that is why it is not clear.
    expect(entry!.interval![1]).toBeGreaterThan(86 / 308);
  });

  it('Priya over a longer window, 38 of 196 against 561 of 2005: the interval clears the rest → clear_gap', () => {
    const r = compareFindings({ picked: ['priya'], metrics: [on(SUCCESS, [fig('priya', 38, 196), ...rest(REST_561_OF_2005)])] });
    expect(r.not_clear).toEqual([]);
    expect(r.findings).toHaveLength(1);
    const [f] = r.findings;
    expect(f).toMatchObject({ code: 'clear_gap', agent_user_id: 'priya', metric: 'success_rate', count: 196, next_step: 'listen_recent' });
    expect(f!.baseline).toBeCloseTo(561 / 2005, 12);
    expect(f!.interval![1]).toBeLessThan(561 / 2005);
    expect(f!.interval![1]).toBeCloseTo(0.25489, 4);
  });

  it('the agent is left out of the baseline: including them would pull it towards them', () => {
    // 60 of 400 against five agents at 23%: with the agent pooled in, the baseline would be
    // (1150 + 60) / (5000 + 400) = 22.4%, not 23%.
    const r = compareFindings({ picked: ['a'], metrics: [on(SUCCESS, [fig('a', 60, 400), ...rest(REST_AT_23)])] });
    expect(r.findings[0]!.baseline).toBe(0.23);
  });

  it('the rest\'s pooled rate counts thin agents too (a ratio of two sums), though they are not rated', () => {
    const thin = fig('thin', 0, 10);
    expect(thin.reportable).toBe(false);
    const r = compareFindings({ picked: ['a'], metrics: [on(SUCCESS, [fig('a', 60, 400), ...rest(REST_AT_23), thin])] });
    expect(r.findings[0]!.baseline).toBeCloseTo(1150 / 5010, 12);
  });

  it('a gap under the smallest gap goes nowhere, however sure the interval is', () => {
    // 2000 of 10000 = 20% against 23%: three points, interval [19.2%, 20.8%] wholly below.
    const r = compareFindings({ picked: ['a'], metrics: [on(SUCCESS, [fig('a', 2000, 10000), ...rest(REST_AT_23)])] });
    expect(r).toEqual({ findings: [], not_clear: [] });
  });

  it('a gap of exactly the smallest gap counts (floating point does not lose it)', () => {
    // 18% of 10000 against 23%: 0.23 − 0.18 is 0.05000000000000002; 25% vs 30% gives 0.04999999999999999.
    const rest30 = rest(Array.from({ length: 5 }, () => [300, 1000] as [number, number]));
    const r = compareFindings({ picked: ['a'], metrics: [on(SUCCESS, [fig('a', 2500, 10000), ...rest30])] });
    expect(r.findings.map((f) => f.code)).toEqual(['clear_gap']);
  });

  it('a lower-is-better rate is worse when HIGHER: no outcome chosen → message_outcome_tip', () => {
    const r = compareFindings({ picked: ['a'], metrics: [on(NO_OUTCOME, [fig('a', 120, 400), ...rest(REST_AT_23)])] });
    expect(r.findings).toMatchObject([{ code: 'clear_gap', metric: 'no_outcome_rate', next_step: 'message_outcome_tip' }]);
    expect(r.findings[0]!.interval![0]).toBeGreaterThan(0.23);
    // Low on a lower-is-better rate is never named (and is not praise: stands_out is for outcome rates).
    expect(compareFindings({ picked: ['a'], metrics: [on(NO_OUTCOME, [fig('a', 20, 400), ...rest(REST_AT_23)])] }))
      .toEqual({ findings: [], not_clear: [] });
  });

  it('next steps by metric: a lower outcome set → listen_outcome, a higher one → listen_recent, call-backs kept → late_callbacks', () => {
    const low = (m: CompareFindingsMetric['metric']) =>
      compareFindings({ picked: ['a'], metrics: [on(m, [fig('a', 40, 400, m.definition.min_denominator ?? 0), ...rest(REST_AT_23)])] }).findings[0]?.next_step;
    const high = (m: CompareFindingsMetric['metric']) =>
      compareFindings({ picked: ['a'], metrics: [on(m, [fig('a', 140, 400), ...rest(REST_AT_23)])] }).findings[0]?.next_step;
    expect(high(REFUSED)).toBe('listen_outcome');
    expect(low(WILL_PAY)).toBe('listen_recent');
    expect(low(KEPT)).toBe('late_callbacks');
  });
});

describe('stands_out (praise, higher-is-better outcome rates only)', () => {
  it('an outcome set wholly above the rest by at least the gap → stands_out, share_best_call', () => {
    const r = compareFindings({ picked: ['a'], metrics: [on(WILL_PAY, [fig('a', 140, 400), ...rest(REST_AT_23)])] });
    expect(r.findings).toMatchObject([{ code: 'stands_out', metric: 'outcomes:higher:will_pay', next_step: 'share_best_call', baseline: 0.23, count: 400 }]);
    expect(r.findings[0]!.interval![0]).toBeGreaterThan(0.23);
    expect(r.not_clear).toEqual([]);
  });

  it('success_rate is praised too; call-backs kept (higher, not an outcome) is not', () => {
    expect(compareFindings({ picked: ['a'], metrics: [on(SUCCESS, [fig('a', 140, 400), ...rest(REST_AT_23)])] }).findings[0]?.code).toBe('stands_out');
    expect(compareFindings({ picked: ['a'], metrics: [on(KEPT, [fig('a', 140, 400), ...rest(REST_AT_23)])] }))
      .toEqual({ findings: [], not_clear: [] });
  });

  it('above but the interval reaches the rest: no praise, and it never goes to not_clear', () => {
    expect(compareFindings({ picked: ['a'], metrics: [on(WILL_PAY, [fig('a', 9, 25), ...rest(REST_AT_23)])] }))
      .toEqual({ findings: [], not_clear: [] });
  });
});

describe('neutral metrics are never named (CP10)', () => {
  it.each([[CONNECT], [NEUTRAL_SET]])('%j: a huge gap, nothing', (m) => {
    expect(compareFindings({ picked: ['a'], metrics: [on(m, [fig('a', 10, 400), ...rest(REST_AT_23)])] }))
      .toEqual({ findings: [], not_clear: [] });
  });

  it('nor do they earn too_few_calls', () => {
    expect(compareFindings({ picked: ['a'], metrics: [on(CONNECT, [fig('a', 1, 5), ...rest(REST6_AT_23)])] }).findings).toEqual([]);
    // The same agent on a flaggable metric, same cohort: too_few_calls.
    expect(compareFindings({ picked: ['a'], metrics: [on(SUCCESS, [fig('a', 1, 5), ...rest(REST6_AT_23)])] }).findings[0]?.code).toBe('too_few_calls');
  });
});

// ── Times ───────────────────────────────────────────────────────────────────

describe('clear_gap on time to choose an outcome', () => {
  // Cohort median with the agent included: six values, five at 60 and the agent's.
  it.each([
    // [agent seconds per wrap-up, findings, not clear]
    [96, ['clear_gap'], []], // 96 / 60 = 1.6
    [90, ['clear_gap'], []], // exactly 1.5
    [78, [], ['clear_gap']], // 1.3
    [75, [], ['clear_gap']], // exactly 1.25
    [72, [], []], // 1.2
    [30, [], []], // faster is never named
  ])('%i s against a 60 s median', (seconds, findings, notClear) => {
    const r = compareFindings({ picked: ['a'], metrics: [on(CHOOSE, [fig('a', seconds * 40, 40), ...REST_TIMES])] });
    expect(r.findings.map((f) => f.code)).toEqual(findings);
    expect(r.not_clear.map((f) => f.code)).toEqual(notClear);
  });

  it('carries the median, the ratio and the wrap-ups; the step is the outcome tip', () => {
    const [f] = compareFindings({ picked: ['a'], metrics: [on(CHOOSE, [fig('a', 96 * 40, 40), ...REST_TIMES])] }).findings;
    expect(f).toEqual({
      code: 'clear_gap', agent_user_id: 'a', metric: 'choose_time', value: 96, baseline: 60, interval: null, ratio: 1.6, count: 40,
      next_step: 'message_outcome_tip',
    });
  });

  it('under 20 wrap-ups: never named for the time, too_few_calls instead', () => {
    const r = compareFindings({ picked: ['a'], metrics: [on(CHOOSE, [fig('a', 200 * 19, 19), ...REST_TIMES, fig('o5', 3000, 50)])] });
    expect(r.findings).toEqual([
      { code: 'too_few_calls', agent_user_id: 'a', metric: 'choose_time', value: 19, baseline: 20, interval: null, ratio: null, count: 19, next_step: null },
    ]);
  });
});

// ── Breaks ──────────────────────────────────────────────────────────────────

describe('over_break_limit', () => {
  const cohort = (n: number) => [count('a', n), ...Array.from({ length: 5 }, (_, i) => count(`o${i}`, 0))];
  it.each([[0, []], [1, []], [2, ['over_break_limit']], [5, ['over_break_limit']]])('%i breaks over → %j', (n, codes) => {
    const r = compareFindings({ picked: ['a'], metrics: [on(BREAKS, cohort(n))] });
    expect(r.findings.map((f) => f.code)).toEqual(codes);
    expect(r.not_clear).toEqual([]);
  });

  it('carries the count, no baseline, opens the breaks', () => {
    expect(compareFindings({ picked: ['a'], metrics: [on(BREAKS, cohort(3))] }).findings).toEqual([
      { code: 'over_break_limit', agent_user_id: 'a', metric: 'breaks_over_limit', value: 3, baseline: null, interval: null, ratio: null, count: null, next_step: 'open_breaks' },
    ]);
  });

  it('only when the breaks metric is on screen', () => {
    expect(compareFindings({ picked: ['a'], metrics: [] })).toEqual({ findings: [], not_clear: [] });
  });
});

// ── Guards ──────────────────────────────────────────────────────────────────

describe('the rated-cohort guard: under 6 agents over the floor, a metric yields nothing at all', () => {
  it('a clear rate gap with five rated agents → nothing; with six → the finding', () => {
    const five = [fig('priya', 38, 196), ...rest(REST_561_OF_2005.slice(0, 4))];
    expect(compareFindings({ picked: ['priya'], metrics: [on(SUCCESS, five)] })).toEqual({ findings: [], not_clear: [] });
    const six = [fig('priya', 38, 196), ...rest(REST_561_OF_2005)];
    expect(compareFindings({ picked: ['priya'], metrics: [on(SUCCESS, six)] }).findings).toHaveLength(1);
  });

  it('thin agents in the cohort do not count toward the six', () => {
    const cohort = [fig('priya', 38, 196), ...rest(REST_561_OF_2005.slice(0, 4)), fig('thin1', 1, 10), fig('thin2', 2, 12)];
    expect(compareFindings({ picked: ['priya'], metrics: [on(SUCCESS, cohort)] })).toEqual({ findings: [], not_clear: [] });
  });

  it('a not-clear gap with five rated agents → nothing either', () => {
    const five = [fig('priya', 5, 29), ...rest(REST_86_OF_308.slice(0, 4))];
    expect(compareFindings({ picked: ['priya'], metrics: [on(SUCCESS, five)] })).toEqual({ findings: [], not_clear: [] });
  });

  it('a time, breaks and too_few_calls are held to it too', () => {
    const times = [fig('a', 96 * 40, 40), ...REST_TIMES.slice(0, 4)];
    expect(compareFindings({ picked: ['a'], metrics: [on(CHOOSE, times)] })).toEqual({ findings: [], not_clear: [] });
    const breaks = [count('a', 4), ...Array.from({ length: 4 }, (_, i) => count(`o${i}`, 0))];
    expect(compareFindings({ picked: ['a'], metrics: [on(BREAKS, breaks)] })).toEqual({ findings: [], not_clear: [] });
    const thinAgent = [fig('a', 1, 5), ...rest(REST_AT_23.slice(0, 4))];
    expect(compareFindings({ picked: ['a'], metrics: [on(SUCCESS, thinAgent)] })).toEqual({ findings: [], not_clear: [] });
  });
});

describe('too_few_calls', () => {
  it('once per agent, citing the first flaggable metric on screen they are under the floor of', () => {
    const r = compareFindings({
      picked: ['a'],
      metrics: [
        on(CONNECT, [fig('a', 1, 5), ...rest(REST6_AT_23)]), // neutral: skipped
        on(WILL_PAY, [fig('a', 1, 12), ...rest(REST6_AT_23)]),
        on(SUCCESS, [fig('a', 1, 12), ...rest(REST6_AT_23)]),
        on(KEPT, [fig('a', 1, 5, 8), ...rest(REST6_AT_23, 8)]),
      ],
    });
    expect(r.findings).toEqual([
      { code: 'too_few_calls', agent_user_id: 'a', metric: 'outcomes:higher:will_pay', value: 12, baseline: 20, interval: null, ratio: null, count: 12, next_step: null },
    ]);
  });

  it('the call-backs floor is its own (8)', () => {
    const r = compareFindings({ picked: ['a'], metrics: [on(KEPT, [fig('a', 1, 7, 8), ...rest(REST6_AT_23, 8)])] });
    expect(r.findings).toMatchObject([{ code: 'too_few_calls', value: 7, baseline: 8 }]);
  });
});

describe('the caps: 3 per agent, 5 in all, in the order of §6; overflow goes nowhere', () => {
  // Four directional metrics where agent `a` is clearly worse on each, plus breaks.
  const worse = (id: string, extra = 0): CompareFindingsMetric[] => [
    on(SUCCESS, [fig(id, 40 + extra, 400), ...rest(REST_AT_23)]),
    on(WILL_PAY, [fig(id, 50 + extra, 400), ...rest(REST_AT_23)]),
    on(NO_OUTCOME, [fig(id, 150 - extra, 400), ...rest(REST_AT_23)]),
    on(CHOOSE, [fig(id, 120 * 40, 40), ...REST_TIMES]),
    on(BREAKS, [count(id, 3), ...Array.from({ length: 5 }, (_, i) => count(`o${i}`, 0))]),
  ];

  it('one agent with five clear findings gets three: the rate gaps, largest first', () => {
    const r = compareFindings({ picked: ['a'], metrics: worse('a') });
    // Gaps in units of each metric's smallest gap: no outcome 14.5 / 4 = 3.6, success 13 / 5 = 2.6,
    // will pay 10.5 / 5 = 2.1.
    expect(r.findings.map((f) => [f.code, f.metric])).toEqual([
      ['clear_gap', 'no_outcome_rate'],
      ['clear_gap', 'success_rate'],
      ['clear_gap', 'outcomes:higher:will_pay'],
    ]);
    // The time and the breaks did not fit: dropped, not moved to not_clear.
    expect(r.not_clear).toEqual([]);
  });

  it('three agents: five in all, at most three each, classes in order, the larger gap first', () => {
    // `b` and `c` sit at the rest's 23% on the rates; they are slow (b 2×, c 1.67× the 60 s
    // median) and over their break limits (b twice, c four times).
    const extra = [
      [fig('b', 92, 400), fig('c', 92, 400)],
      [fig('b', 92, 400), fig('c', 92, 400)],
      [fig('b', 92, 400), fig('c', 92, 400)],
      [fig('b', 120 * 40, 40), fig('c', 100 * 40, 40)],
      [count('b', 2), count('c', 4)],
    ];
    const metrics = worse('a').map((m, i) => on(m.metric, [...m.cohort, ...extra[i]!]));
    const r = compareFindings({ picked: ['a', 'b', 'c'], metrics });
    expect(r.findings.map((f) => [f.agent_user_id, f.code, f.metric])).toEqual([
      ['a', 'clear_gap', 'no_outcome_rate'],
      ['a', 'clear_gap', 'success_rate'],
      ['a', 'clear_gap', 'outcomes:higher:will_pay'],
      // a's own time (2×) is a fourth for a: skipped. b's (2×) before c's (1.67×).
      ['b', 'clear_gap', 'choose_time'],
      ['c', 'clear_gap', 'choose_time'],
      // Every break finding overflowed: dropped.
    ]);
    expect(r.not_clear).toEqual([]);
  });

  it('praise comes after breaks and before too_few_calls', () => {
    const r = compareFindings({
      picked: ['a', 'b'],
      metrics: [
        on(WILL_PAY, [fig('a', 140, 400), fig('b', 1, 10), ...rest(REST_AT_23)]),
        on(BREAKS, [count('a', 0), count('b', 2), ...Array.from({ length: 5 }, (_, i) => count(`o${i}`, 0))]),
      ],
    });
    expect(r.findings.map((f) => [f.code, f.agent_user_id])).toEqual([
      ['over_break_limit', 'b'], ['stands_out', 'a'], ['too_few_calls', 'b'],
    ]);
  });
});

describe('max: the cap in all is the input\'s when given (Team performance passes Infinity, TP15)', () => {
  // Eight agents clearly worse on the rate than a 23% rest, each a clear gap of its own.
  const weak = Array.from({ length: 8 }, (_, i) => fig(`w${i}`, 40 + i, 400));
  const metrics = [on(SUCCESS, [...weak, ...rest(REST_AT_23)])];
  const picked = weak.map((f) => f.agent_user_id);

  it('default: five in all, as Compare has always capped them', () => {
    expect(compareFindings({ picked, metrics }).findings).toHaveLength(5);
    expect(compareFindings({ picked, metrics, max: undefined }).findings).toHaveLength(5);
  });

  it('Infinity: every clear gap, largest first; the per-agent cap still holds', () => {
    const r = compareFindings({ picked, metrics, max: Infinity });
    expect(r.findings.map((f) => f.agent_user_id)).toEqual(picked);
    expect(r.findings.every((f) => f.code === 'clear_gap')).toBe(true);
    const one = compareFindings({ picked: ['a'], metrics: [
      on(SUCCESS, [fig('a', 40, 400), ...rest(REST_AT_23)]),
      on(WILL_PAY, [fig('a', 50, 400), ...rest(REST_AT_23)]),
      on(NO_OUTCOME, [fig('a', 150, 400), ...rest(REST_AT_23)]),
      on(CHOOSE, [fig('a', 120 * 40, 40), ...REST_TIMES]),
    ], max: Infinity });
    expect(one.findings).toHaveLength(3);
  });
});

describe('inputs the read should never send', () => {
  it('a picked agent missing from the cohort is skipped, not invented', () => {
    expect(compareFindings({ picked: ['ghost'], metrics: [on(SUCCESS, rest(REST_AT_23.concat([[230, 1000]])))] }))
      .toEqual({ findings: [], not_clear: [] });
  });
});
