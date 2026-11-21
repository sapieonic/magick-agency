import { describe, it, expect } from 'vitest';
import {
  COMPARE_BUILTIN_METRICS,
  COMPARE_BUILTIN_METRIC_KEYS,
  COMPARE_FINDING_CODES,
  COMPARE_NEXT_STEPS,
  type AgencyCompareFinding,
  type AgencyCompareMetricRef,
  type AgencyCompareResponse,
  type CompareBuiltinMetricKey,
} from '@magick-agency/contracts/api/agency/compare';
import {
  FINDING_BADGES,
  agentCallsLink,
  agentName,
  emptyFindingsNote,
  findingAction,
  findingCopy,
  firstName,
  neutralNote,
  notClearFoot,
  notClearLine,
  ratioDown,
  possessive,
  rangeBeside,
  type FindingContext,
} from '../../utils/agency/compare/compareFindingsCopy';
import { CODES, REFUSED_LOWER, WILL_PAY, compareResponse, finding, metricInfo } from '../helpers/compare';
import { ONE_DAY_COLLECTIONS } from '../helpers/compareRecorded';

/**
 * "What stands out" in the console's words (`docs/compare-agents.md` §6, CP12, AS15): a sentence
 * for every finding code on every unit it can come on, its reason, a next step that opens a page
 * that exists (the listening ones only for a reader with listening rights), the Not clear yet
 * lines, and why the list is empty when it is. Coaching tone: no verdict and no cause.
 */

const builtin = (key: CompareBuiltinMetricKey): AgencyCompareMetricRef => ({ kind: 'builtin', key });

/** An answer whose only metric is `ref`, and whose only finding is `f`. */
function on(ref: AgencyCompareMetricRef, f: Partial<AgencyCompareFinding> & Pick<AgencyCompareFinding, 'code'>): {
  response: AgencyCompareResponse;
  f: AgencyCompareFinding;
} {
  const info = metricInfo(ref);
  const fnd = finding({ metric: info.id, ...f });
  const base = compareResponse();
  return {
    response: {
      ...base,
      metrics: [info],
      trend_metric: null,
      trend: null,
      findings: [fnd],
      cohort: { agents: 9, per_metric: { [info.id]: { p25: 0.2, median: 0.28, p75: 0.3, pooled: 0.28, agents_rated: 8 } } },
      agents: base.agents.map((a) => ({ ...a, values: { [info.id]: { value: 0.17, numerator: 5, denominator: 29, reportable: true, interval: [0.08, 0.35] } } })),
    },
    f: fnd,
  };
}

const ctx = (response: AgencyCompareResponse, canListen = true): FindingContext => ({ response, codes: CODES, timezone: 'Asia/Kolkata', canListen });
const sentence = (r: AgencyCompareResponse, f: AgencyCompareFinding, canListen = true) => {
  const c = findingCopy(f, ctx(r, canListen));
  return `${c.name}${c.rest}`;
};

describe('a sentence for every code and unit', () => {
  it('has a badge for every finding code', () => {
    for (const code of COMPARE_FINDING_CODES) expect(FINDING_BADGES[code].label, code).toMatch(/\S/);
  });

  it('clear_gap on a higher-is-better rate: the agent’s rate against the rest of the team', () => {
    const { response, f } = on(builtin('success_rate'), { code: 'clear_gap' });
    expect(sentence(response, f)).toBe('Priya M’s success rate is 17% (rest of the team 28%).');
    expect(findingCopy(f, ctx(response)).why).toBe(
      '5 of 29. Its likely range, 8% to 35%, sits wholly below the rest of the team’s 28%, so chance does not explain it.',
    );
  });

  it('clear_gap on an outcome set says the set’s name', () => {
    const { response, f } = on(WILL_PAY, { code: 'clear_gap' });
    expect(sentence(response, f)).toBe('Priya M’s share of calls ending in Will pay is 17% (rest of the team 28%).');
  });

  it('clear_gap on a lower-is-better rate: its range sits above', () => {
    const { response, f } = on(REFUSED_LOWER, { code: 'clear_gap', value: 0.31, baseline: 0.18, interval: [0.22, 0.42] });
    expect(sentence(response, f)).toBe('Priya M’s share of calls ending in refused is 31% (rest of the team 18%).');
    expect(findingCopy(f, ctx(response)).why).toMatch(/sits wholly above the rest of the team’s 18%/);
    const noOutcome = on(builtin('no_outcome_rate'), { code: 'clear_gap', value: 0.12, baseline: 0.04, interval: [0.06, 0.2] });
    expect(sentence(noOutcome.response, noOutcome.f)).toBe('Priya M’s share of calls with no outcome chosen is 12% (rest of the team 4%).');
  });

  it('clear_gap on call-backs kept and promises', () => {
    const kept = on(builtin('callbacks_kept_rate'), { code: 'clear_gap', value: 0.5, baseline: 0.8, count: 12 });
    expect(sentence(kept.response, kept.f)).toBe('Priya M’s call-backs kept on time is 50% (rest of the team 80%).');
    const promises = on(builtin('promises_rate'), { code: 'clear_gap' });
    expect(sentence(promises.response, promises.f)).toBe('Priya M’s share of calls with a promise is 17% (rest of the team 28%).');
  });

  it('clear_gap on time to choose an outcome: seconds in words, the median, the ratio', () => {
    const { response, f } = on(builtin('choose_time'), { code: 'clear_gap', value: 35, baseline: 19, ratio: 35 / 19, interval: null, count: 29 });
    expect(sentence(response, f)).toBe('Priya M takes 35s to choose an outcome (team median 19s).');
    expect(findingCopy(f, ctx(response)).why).toBe('1.8 times the team median, over 29 wrap-ups. A time is named only from 1.5 times the median.');
  });

  it('asks about the outcome buttons only when the same agent is also low on an outcome rate (§6)', () => {
    const response = compareResponse();
    const [low, slow] = response.findings as [AgencyCompareFinding, AgencyCompareFinding];
    expect(sentence(response, slow)).toBe(
      'Priya M takes 35s to choose an outcome (team median 19s). Worth asking whether the outcome buttons are clear to them.',
    );
    const alone = { ...response, findings: [slow] };
    expect(sentence(alone, slow)).not.toMatch(/outcome buttons/);
    const otherAgent = { ...response, findings: [{ ...low, agent_user_id: 'u-ravi' }, slow] };
    expect(sentence(otherAgent, slow)).not.toMatch(/outcome buttons/);
  });

  it('stands_out: a high outcome rate, said plainly', () => {
    const { response, f } = on(WILL_PAY, { code: 'stands_out', agent_user_id: 'u-lak', value: 0.32, baseline: 0.24, interval: [0.27, 0.38], count: 196 });
    expect(sentence(response, f)).toBe('Lakshmi P has a high share of calls ending in Will pay here (32%; rest of the team 24%).');
    expect(findingCopy(f, ctx(response)).why).toMatch(/sits wholly above the rest of the team’s 24%/);
  });

  it('over_break_limit: a count against the campaign’s own limits', () => {
    const { response, f } = on(builtin('breaks_over_limit'), { code: 'over_break_limit', value: 2, baseline: null, interval: null, count: null });
    expect(sentence(response, f)).toBe('Priya M went over the break limit 2 times in this window.');
    expect(findingCopy(f, ctx(response)).why).toMatch(/campaign’s own break limits, not against other agents/);
    const once = { ...f, value: 1 };
    expect(sentence(response, once)).toBe('Priya M went over the break limit once in this window.');
  });

  it('too_few_calls: the agent’s denominator and the floor, in the metric’s own words', () => {
    const { response, f } = on(builtin('success_rate'), { code: 'too_few_calls', agent_user_id: 'u-priya', value: 12, baseline: 20, interval: null, count: 12 });
    expect(sentence(response, f)).toBe('Priya M has 12 calls here, too few to compare success rate fairly.');
    expect(findingCopy(f, ctx(response)).why).toBe(
      'A rate is compared only from 20 calls, the roster’s own floor, so a few lucky or unlucky calls never name anyone.',
    );
    const kept = on(builtin('callbacks_kept_rate'), { code: 'too_few_calls', value: 3, baseline: 8, count: 3, interval: null });
    expect(sentence(kept.response, kept.f)).toBe('Priya M has 3 call-backs due here, too few to compare call-backs kept on time fairly.');
    expect(findingCopy(kept.f, ctx(kept.response)).why).toBe(
      'Call-backs kept on time are compared only from 8 call-backs due. Agents book only a handful a week, so this floor is lower than the roster’s 20, and a few lucky or unlucky ones still never name anyone.',
    );
    const noneDue = on(builtin('callbacks_kept_rate'), { code: 'too_few_calls', value: 0, baseline: 8, count: 0, interval: null });
    expect(sentence(noneDue.response, noneDue.f)).toBe('Priya M has no call-backs due yet here, so call-backs kept on time can’t be compared.');
    expect(findingCopy(noneDue.f, ctx(noneDue.response)).why).toMatch(/^None of their call-backs has come due in this window, so there is nothing to keep on time yet\. Call-backs kept on time are compared only from 8 call-backs due\./);
    const time = on(builtin('choose_time'), { code: 'too_few_calls', value: 9, baseline: 20, count: 9, interval: null });
    expect(sentence(time.response, time.f)).toBe('Priya M has 9 wrap-ups here, too few to compare time to choose outcome fairly.');
    expect(findingCopy(time.f, ctx(time.response)).why).toBe(
      'A time to choose an outcome is compared only from 20 wrap-ups, so a few slow or quick ones never name anyone.',
    );
  });

  it('too_few_calls: every flaggable metric with a floor gets its own true reason, and never claims hidden counts are shown', () => {
    const refs: AgencyCompareMetricRef[] = [
      ...COMPARE_BUILTIN_METRIC_KEYS.filter((k) => COMPARE_BUILTIN_METRICS[k].better !== 'neutral' && COMPARE_BUILTIN_METRICS[k].min_denominator !== null).map(builtin),
      WILL_PAY,
      REFUSED_LOWER,
    ];
    expect(refs.map((r) => (r.kind === 'builtin' ? r.key : 'set'))).toEqual(
      expect.arrayContaining(['success_rate', 'promises_rate', 'callbacks_kept_rate', 'choose_time', 'no_outcome_rate', 'set']),
    );
    for (const ref of refs) {
      const info = metricInfo(ref);
      const floor = info.definition.min_denominator!;
      const { response, f } = on(ref, { code: 'too_few_calls', value: 3, baseline: floor, count: 3, interval: null });
      const c = findingCopy(f, ctx(response));
      const name = ref.kind === 'builtin' ? ref.key : info.id;
      expect(c.rest, name).not.toMatch(/counts are still shown/);
      expect(c.why, name).toContain(`only from ${floor} `);
      // "The roster's own floor" only where the floor is the roster's, and on a rate.
      const roster = info.definition.unit === 'rate' && floor === 20;
      expect(/roster’s own floor/.test(c.why), name).toBe(roster);
      // A time is never called a rate.
      if (info.definition.unit === 'seconds') expect(c.why, name).not.toMatch(/\brate\b/);
    }
  });

  it('keeps an outcome set’s label as the supervisor wrote it inside a sentence', () => {
    const ptp = { kind: 'outcomes' as const, codes: ['will_pay'], better: 'higher' as const, label: 'PTP' };
    const thin = on(ptp, { code: 'too_few_calls', value: 3, baseline: 20, count: 3, interval: null });
    expect(sentence(thin.response, thin.f)).toBe('Priya M has 3 calls here, too few to compare PTP fairly.');
    const f = finding({ code: 'clear_gap', metric: metricInfo(ptp).id });
    expect(notClearLine(f, { response: thin.response })).toMatch(/^Priya M: PTP 17%/);
  });

  it('never states a cause or a verdict, and spells the British way', () => {
    const texts: string[] = [];
    const cases: Array<[AgencyCompareMetricRef, Partial<AgencyCompareFinding> & Pick<AgencyCompareFinding, 'code'>]> = [
      [builtin('success_rate'), { code: 'clear_gap' }],
      [WILL_PAY, { code: 'stands_out' }],
      [builtin('choose_time'), { code: 'clear_gap', value: 35, baseline: 19, ratio: 1.8 }],
      [builtin('breaks_over_limit'), { code: 'over_break_limit', value: 3 }],
      [builtin('success_rate'), { code: 'too_few_calls', value: 12, baseline: 20, count: 12 }],
    ];
    for (const [ref, f] of cases) {
      const x = on(ref, f);
      const c = findingCopy(x.f, ctx(x.response));
      texts.push(c.rest, c.why, c.action?.label ?? '');
    }
    const all = texts.join(' ');
    expect(all).not.toMatch(/underperform|lazy|tired|poor|bad|fail|appraisal|warning/i);
    expect(all).not.toMatch(/\b(color|behavior|organization|canceled|dialed)\b/i);
  });
});

describe('a likely range beside the rest of the team', () => {
  it('never reads the same as the baseline it is said to sit wholly below or above', () => {
    // 27.96% is below 28.04%, but both round to 28%.
    const below = on(builtin('success_rate'), { code: 'clear_gap', value: 0.19, baseline: 0.2804, interval: [0.1449, 0.2796], count: 196 });
    expect(findingCopy(below.f, ctx(below.response)).why).toBe(
      '5 of 196. Its likely range, 14% to 27%, sits wholly below the rest of the team’s 28%, so chance does not explain it.',
    );
    expect(rangeBeside([0.1449, 0.2796], 0.2804, 'below')).toEqual({ range: '14% to 27%', base: '28%' });
    // Still the same after rounding towards the agent: one decimal.
    expect(rangeBeside([0.1, 0.273], 0.274, 'below')).toEqual({ range: '10.0% to 27.3%', base: '27.4%' });
    // Above: the low end is rounded up, away from the baseline.
    expect(rangeBeside([0.3204, 0.45], 0.3196, 'above')).toEqual({ range: '33% to 45%', base: '32%' });
    expect(rangeBeside([0.327, 0.45], 0.326, 'above')).toEqual({ range: '32.7% to 45.0%', base: '32.6%' });
    // A clear gap rounds as it always has.
    expect(rangeBeside([0.08, 0.2], 0.28, 'below')).toEqual({ range: '8% to 20%', base: '28%' });
    expect(rangeBeside([0.1, 0.29], 0.3, 'below')).toEqual({ range: '10% to 29%', base: '30%' });
  });
});

describe('next steps link to pages that exist', () => {
  const window = { from: '2026-11-15', to: '2026-11-21', timezone: 'Asia/Kolkata' };

  it('opens the agent’s placed calls on the campaign, in the window, by local midnights', () => {
    expect(agentCallsLink('camp 1', 'u-priya', window)).toBe(
      '/agency/campaigns/camp%201/attempts?agent_user_id=u-priya&placed=1&dialed_from=2026-11-14T18%3A30%3A00.000Z&dialed_to=2026-11-21T18%3A30%3A00.000Z',
    );
    expect(agentCallsLink('c', 'u', window, ['will_pay', 'part_paid'])).toMatch(/^\/agency\/campaigns\/c\/attempts\?disposition_code=will_pay&disposition_code=part_paid&agent_user_id=u/);
  });

  it('has an action for every next step a supervisor with listening rights can take', () => {
    for (const step of COMPARE_NEXT_STEPS) {
      const ref = step === 'listen_outcome' ? REFUSED_LOWER : step === 'late_callbacks' ? builtin('callbacks_kept_rate') : WILL_PAY;
      const { response, f } = on(ref, { code: 'clear_gap', next_step: step });
      const action = findingAction(f, ctx(response));
      expect(action, step).not.toBeNull();
      expect(action!.to, step).toMatch(/^\/agency\//);
      expect(action!.label, step).toMatch(/\S/);
    }
  });

  it('narrows the call log to the set’s codes, success codes for the success rate, promise codes for promises', () => {
    const set = on(REFUSED_LOWER, { code: 'clear_gap', next_step: 'listen_outcome' });
    expect(findingAction(set.f, ctx(set.response))).toMatchObject({ label: 'Listen to Priya’s calls ending in refused' });
    expect(findingAction(set.f, ctx(set.response))!.to).toContain('disposition_code=refused&');
    const best = on(builtin('success_rate'), { code: 'stands_out', next_step: 'share_best_call' });
    expect(findingAction(best.f, ctx(best.response))!.to).toContain('disposition_code=will_pay&disposition_code=part_paid&');
    expect(findingAction(best.f, ctx(best.response))!.label).toBe('Find a call of Priya’s to share with the team');
  });

  it('hides the listening steps from a supervisor without listening rights (RC1), and keeps the others', () => {
    for (const step of ['listen_recent', 'listen_outcome', 'share_best_call'] as const) {
      const { response, f } = on(WILL_PAY, { code: 'clear_gap', next_step: step });
      expect(findingAction(f, ctx(response, false)), step).toBeNull();
    }
    const breaks = on(builtin('breaks_over_limit'), { code: 'over_break_limit', value: 2, next_step: 'open_breaks' });
    expect(findingAction(breaks.f, ctx(breaks.response, false))).toMatchObject({ to: '/agency/analytics?view=agents' });
    const tip = on(builtin('no_outcome_rate'), { code: 'clear_gap', next_step: 'message_outcome_tip' });
    expect(findingAction(tip.f, ctx(tip.response, false))).toMatchObject({ label: 'Talk to Priya from Live floor', to: '/agency/home' });
    const late = on(builtin('callbacks_kept_rate'), { code: 'clear_gap', next_step: 'late_callbacks' });
    expect(findingAction(late.f, ctx(late.response, false))).toMatchObject({ to: '/agency/callbacks?campaign=camp-1' });
  });

  it('offers nothing when the server sends no next step', () => {
    const { response, f } = on(WILL_PAY, { code: 'too_few_calls', next_step: null });
    expect(findingAction(f, ctx(response))).toBeNull();
  });
});

describe('Not clear yet, and the notes', () => {
  it('words a rate gap that could still be chance, with its range', () => {
    const { response } = on(WILL_PAY, { code: 'clear_gap' });
    const f = finding({ code: 'clear_gap', metric: metricInfo(WILL_PAY).id, value: 0.17, baseline: 0.28, interval: [0.08, 0.35], count: 29 });
    expect(notClearLine(f, { response })).toBe('Priya M: Will pay 17% on 29 calls (rest of the team 28%; likely range 8% to 35%). Could still be chance.');
    expect(notClearFoot({ ...response, not_clear: [f] })).toBe(
      'More calls narrow the likely range, so a longer window can show whether these gaps are real.',
    );
  });

  it('words a time gap by its ratio to the median, not as a range or chance', () => {
    const { response } = on(builtin('choose_time'), { code: 'clear_gap' });
    const f = finding({ code: 'clear_gap', metric: 'choose_time', value: 25, baseline: 19, interval: null, ratio: 1.3 });
    const line = notClearLine(f, { response });
    expect(line).toBe('Priya M: takes 25s to choose an outcome, 1.3 times the team median (19s). Named only from 1.5 times the median, so not yet.');
    expect(line).not.toMatch(/chance|likely range/);
    const foot = notClearFoot({ ...response, not_clear: [f] });
    expect(foot).toBe('A longer window shows whether the time stays this slow over more wrap-ups.');
    expect(foot).not.toMatch(/range/);
  });

  it('never words a time not clear yet as reaching the 1.5 line: its ratio is cut down to two decimals, never rounded up', () => {
    const { response } = on(builtin('choose_time'), { code: 'clear_gap' });
    for (const [ratio, shown] of [[1.45, '1.45'], [1.47, '1.47'], [1.499, '1.49'], [35 / 24, '1.45'], [1.3, '1.3'], [1.25, '1.25'], [1.4, '1.4'], [1.29, '1.29']] as const) {
      const f = finding({ code: 'clear_gap', metric: 'choose_time', value: 35, baseline: 24, interval: null, ratio });
      const line = notClearLine(f, { response });
      expect(line, String(ratio)).toContain(`, ${shown} times the team median`);
      expect(line, String(ratio)).not.toContain('1.5 times the team median');
    }
    expect(ratioDown(1.1)).toBe('1.1');
    expect(ratioDown(1.15)).toBe('1.15');
    expect(ratioDown(1.7)).toBe('1.7');
  });

  it('lists the metrics shown for context only', () => {
    expect(neutralNote(compareResponse())).toBe('Shown for context, never flagged: Calls handled.');
    expect(neutralNote({ metrics: [metricInfo(WILL_PAY)] })).toBeNull();
  });

  it('says why nothing is judged when the rated cohort is under six (§6)', () => {
    const response = compareResponse({ findings: [] });
    const thin = {
      ...response,
      cohort: {
        ...response.cohort,
        per_metric: Object.fromEntries(Object.entries(response.cohort.per_metric).map(([id, c]) => [id, { ...c, agents_rated: 4 }])),
      },
    };
    expect(emptyFindingsNote(thin)).toBe(
      'Nothing is judged yet: at least 6 agents on this campaign need enough calls in this window to compare fairly, and only 4 do. Check a longer window.',
    );
    expect(emptyFindingsNote(response)).toBe('Nothing clear stands out among these agents on these metrics.');
    expect(emptyFindingsNote({ ...response, metrics: [metricInfo(builtin('calls_handled'))] })).toMatch(/shown for context only/);
    expect(emptyFindingsNote(compareResponse())).toBeNull();
  });

  it('judges each metric on its own rated cohort: breaks, with no floor, never stand in for the rates and times (recorded one-day window)', () => {
    // As the server sent it: Will pay, time to choose and no outcome rate 0 agents (14 calls
    // each, the floor is 20); breaks over their limit rates all 8.
    expect(emptyFindingsNote(ONE_DAY_COLLECTIONS)).toBe(
      'Nothing clear stands out on breaks over their limit. Will pay, time to choose outcome and no outcome chosen are not judged yet: at least 6 agents on this campaign need enough calls in this window to compare fairly, and none does. Check a longer window.',
    );
    // With breaks off the page, nothing at all is judged.
    const noBreaks = { ...ONE_DAY_COLLECTIONS, metrics: ONE_DAY_COLLECTIONS.metrics.filter((m) => m.id !== 'breaks_over_limit') };
    expect(emptyFindingsNote(noBreaks)).toBe(
      'Nothing is judged yet: at least 6 agents on this campaign need enough calls in this window to compare fairly, and none does. Check a longer window.',
    );
    // One metric short, the others judged: it alone is named, and differing counts say "at most".
    const perMetric = { ...ONE_DAY_COLLECTIONS.cohort.per_metric };
    perMetric['outcomes:higher:will_pay'] = { ...perMetric['outcomes:higher:will_pay']!, agents_rated: 7 };
    perMetric['choose_time'] = { ...perMetric['choose_time']!, agents_rated: 7 };
    perMetric['no_outcome_rate'] = { ...perMetric['no_outcome_rate']!, agents_rated: 3 };
    expect(emptyFindingsNote({ ...ONE_DAY_COLLECTIONS, cohort: { ...ONE_DAY_COLLECTIONS.cohort, per_metric: perMetric } })).toBe(
      'Nothing clear stands out on Will pay, time to choose outcome and breaks over their limit. No outcome chosen is not judged yet: at least 6 agents on this campaign need enough calls in this window to compare fairly, and only 3 do. Check a longer window.',
    );
    perMetric['choose_time'] = { ...perMetric['choose_time']!, agents_rated: 2 };
    expect(emptyFindingsNote({ ...ONE_DAY_COLLECTIONS, cohort: { ...ONE_DAY_COLLECTIONS.cohort, per_metric: perMetric } })).toMatch(
      /^Nothing clear stands out on Will pay and breaks over their limit\. Time to choose outcome and no outcome chosen are not judged yet: .*and at most 3 do\. Check a longer window\.$/,
    );
  });
});

describe('names', () => {
  it('falls back to a marked id, and writes the possessive the British way', () => {
    expect(agentName({ agents: [] }, 'abcdef123')).toBe('Agent abcdef');
    expect(firstName('Priya M')).toBe('Priya');
    expect(possessive('Priya')).toBe('’s');
    expect(possessive('Lakshmi Das')).toBe('’');
  });
});
