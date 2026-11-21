import { describe, it, expect } from 'vitest';
import {
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
  notClearLine,
  possessive,
  type FindingContext,
} from '../../utils/agency/compare/compareFindingsCopy';
import { CODES, REFUSED_LOWER, WILL_PAY, compareResponse, finding, metricInfo } from '../helpers/compare';

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
    expect(sentence(response, f)).toBe('Priya M has 12 calls here, too few to compare success rate fairly. The counts are still shown.');
    expect(findingCopy(f, ctx(response)).why).toBe(
      'A rate is compared only from 20 calls, the roster’s own floor, so a few lucky or unlucky calls never name anyone.',
    );
    const kept = on(builtin('callbacks_kept_rate'), { code: 'too_few_calls', value: 3, baseline: 8, count: 3, interval: null });
    expect(sentence(kept.response, kept.f)).toMatch(/has 3 call-backs due here/);
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
    expect(notClearLine(f, { response })).toBe('Priya M: will pay 17% on 29 calls (rest of the team 28%; likely range 8% to 35%). Could still be chance.');
  });

  it('words a time gap with the median', () => {
    const { response } = on(builtin('choose_time'), { code: 'clear_gap' });
    const f = finding({ code: 'clear_gap', metric: 'choose_time', value: 25, baseline: 19, interval: null, ratio: 1.3 });
    expect(notClearLine(f, { response })).toBe('Priya M: time to choose outcome 25s (team median 19s). Could still be chance.');
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
});

describe('names', () => {
  it('falls back to a marked id, and writes the possessive the British way', () => {
    expect(agentName({ agents: [] }, 'abcdef123')).toBe('Agent abcdef');
    expect(firstName('Priya M')).toBe('Priya');
    expect(possessive('Priya')).toBe('’s');
    expect(possessive('Lakshmi Das')).toBe('’');
  });
});
