import { describe, it, expect } from 'vitest';
import { compareMetricId } from '@magick-agency/contracts/api/agency/compare';
import {
  EMPTY_SLOTS,
  compareStateFromParams,
  compareStateToParams,
  keepAgents,
  longerWindow,
  metricParam,
  parseMetricParam,
  parseSlots,
  pickedAgents,
  toggleAgent,
  windowDates,
  windowError,
  type CompareUrlState,
} from '../../utils/agency/compare/compareUrl';
import { REFUSED_LOWER, WILL_PAY } from '../helpers/compare';

/**
 * Compare agents' URL (`docs/compare-agents.md` §2): campaign, window, agents in their colour
 * slots, lens, metrics and trend survive a round trip, so a link reproduces the comparison; a
 * stale or hand-edited link degrades to what this build knows; a colour follows the person.
 */

/** An id sorts a set's codes, so a set read back from a link has them sorted (order never matters). */
const WILL_PAY_SORTED = { ...WILL_PAY, codes: ['part_paid', 'will_pay'] };

const FULL: CompareUrlState = {
  campaignId: 'camp-1',
  window: 'custom',
  from: '2026-11-01',
  to: '2026-11-14',
  slots: [null, 'u-ravi', 'u-priya'],
  lens: 'collections',
  metrics: [{ kind: 'builtin', key: 'calls_handled' }, WILL_PAY_SORTED, REFUSED_LOWER],
  trend: WILL_PAY_SORTED,
  viewId: 'view-1',
};

describe('the round trip', () => {
  it('reads back every field it writes', () => {
    const params = compareStateToParams(FULL);
    expect(compareStateFromParams(new URLSearchParams(params.toString()))).toEqual(FULL);
  });

  it('writes a readable query in a fixed order, keeping a free slot in place', () => {
    const qs = compareStateToParams(FULL).toString();
    expect(qs).toBe(
      'campaign=camp-1&when=custom&from=2026-11-01&to=2026-11-14&agents=%2Cu-ravi%2Cu-priya&lens=collections' +
        '&m=calls_handled&m=outcomes%3Ahigher%3Apart_paid%2Cwill_pay%7EWill+pay&m=outcomes%3Alower%3Arefused' +
        '&trend=outcomes%3Ahigher%3Apart_paid%2Cwill_pay%7EWill+pay&view=view-1',
    );
  });

  it('leaves the defaults out: the last 7 days, no agents, the lens’s metrics', () => {
    const state = compareStateFromParams(new URLSearchParams('campaign=c'));
    expect(state).toEqual({
      campaignId: 'c',
      window: 'last_7_days',
      from: null,
      to: null,
      slots: [...EMPTY_SLOTS],
      lens: null,
      metrics: null,
      trend: undefined,
      viewId: null,
    });
    expect(compareStateToParams(state).toString()).toBe('campaign=c');
  });

  it('says "no trend" apart from "the default trend"', () => {
    expect(compareStateFromParams(new URLSearchParams('trend=none')).trend).toBeNull();
    expect(compareStateFromParams(new URLSearchParams('')).trend).toBeUndefined();
    expect(compareStateToParams({ ...FULL, trend: null }).get('trend')).toBe('none');
  });

  it('round-trips each window preset', () => {
    for (const window of ['today', 'this_week', 'last_7_days', 'last_30_days'] as const) {
      const state = compareStateFromParams(compareStateToParams({ ...FULL, window, from: null, to: null }));
      expect(state.window).toBe(window);
      expect(state.from).toBeNull();
    }
  });
});

describe('reading is an allow-list', () => {
  it('drops an unknown lens, window, metric id or malformed date', () => {
    const state = compareStateFromParams(
      new URLSearchParams('lens=inbound&when=forever&m=made_up&m=outcomes:higher:will_pay,part_paid&m=calls_handled&from=yesterday'),
    );
    expect(state.lens).toBeNull();
    expect(state.window).toBe('last_7_days');
    // Unsorted codes are not a canonical id: dropped, not reordered.
    expect(state.metrics?.map(compareMetricId)).toEqual(['calls_handled']);
    expect(state.from).toBeNull();
  });

  it('keeps at most six metrics and each id once', () => {
    const ids = ['calls_handled', 'calls_handled', 'success_rate', 'avg_call', 'choose_time', 'no_outcome_rate', 'connect_rate', 'calls_per_hour'];
    const state = compareStateFromParams(new URLSearchParams(ids.map((id) => `m=${id}`).join('&')));
    expect(state.metrics?.map(compareMetricId)).toEqual(['calls_handled', 'success_rate', 'avg_call', 'choose_time', 'no_outcome_rate', 'connect_rate']);
  });

  it('reads no metrics as null, so the page uses its defaults', () => {
    expect(compareStateFromParams(new URLSearchParams('m=nope')).metrics).toBeNull();
  });

  it('drops a label the contract would refuse but keeps the set', () => {
    expect(parseMetricParam('outcomes:lower:refused~' + 'x'.repeat(61))).toEqual({ kind: 'outcomes', codes: ['refused'], better: 'lower' });
    expect(parseMetricParam('outcomes:lower:refused~Refused')).toEqual({ ...REFUSED_LOWER, label: 'Refused' });
    expect(parseMetricParam('success_rate~Nice')).toEqual({ kind: 'builtin', key: 'success_rate' });
    expect(metricParam({ kind: 'builtin', key: 'avg_call' })).toBe('avg_call');
  });

  it('reads at most three agents, distinct, free slots kept', () => {
    expect(parseSlots('a,a,b')).toEqual(['a', null, 'b']);
    expect(parseSlots('a,b,c,d')).toEqual(['a', 'b', 'c']);
    expect(parseSlots(',,c')).toEqual([null, null, 'c']);
    expect(parseSlots(null)).toEqual([null, null, null]);
  });
});

describe('a colour follows the person', () => {
  it('a pick takes the first free slot; removing one never moves the others', () => {
    let slots = toggleAgent([...EMPTY_SLOTS], 'a');
    slots = toggleAgent(slots, 'b');
    slots = toggleAgent(slots, 'c');
    expect(slots).toEqual(['a', 'b', 'c']);
    slots = toggleAgent(slots, 'a');
    expect(slots).toEqual([null, 'b', 'c']);
    expect(pickedAgents(slots)).toEqual(['b', 'c']);
    slots = toggleAgent(slots, 'd');
    expect(slots).toEqual(['d', 'b', 'c']);
  });

  it('a fourth pick changes nothing (CP1)', () => {
    expect(toggleAgent(['a', 'b', 'c'], 'd')).toEqual(['a', 'b', 'c']);
  });

  it('frees the slot of an agent outside the cohort, in place', () => {
    expect(keepAgents(['a', 'b', 'c'], new Set(['a', 'c']))).toEqual(['a', null, 'c']);
  });
});

describe('the window', () => {
  const today = '2026-11-21'; // a Saturday
  it('gives each preset its local dates', () => {
    expect(windowDates({ window: 'today', from: null, to: null }, today)).toEqual({ from: today, to: today });
    expect(windowDates({ window: 'this_week', from: null, to: null }, today)).toEqual({ from: '2026-11-16', to: today });
    expect(windowDates({ window: 'last_7_days', from: null, to: null }, today)).toEqual({ from: '2026-11-15', to: today });
    expect(windowDates({ window: 'last_30_days', from: null, to: null }, today)).toEqual({ from: '2026-10-23', to: today });
    expect(windowDates({ window: 'custom', from: '2026-11-01', to: null }, today)).toBeNull();
  });

  it('holds a custom window to the reports’ rule', () => {
    expect(windowError({ from: '2026-11-01', to: '2026-11-14' }, today)).toBeNull();
    expect(windowError({ from: '2026-10-01', to: '2026-10-31' }, today)).toBeNull();
    expect(windowError({ from: '2026-10-01', to: '2026-11-14' }, today)).toBe(
      'Choose at most 30 days, or exactly one calendar month, ending no later than today.',
    );
    // 31 days that are not one calendar month are refused, so the words never offer them.
    expect(windowError({ from: '2026-10-15', to: '2026-11-14' }, today)).not.toBeNull();
    expect(windowError({ from: '2026-10-15', to: '2026-11-14' }, today)).not.toMatch(/31/);
    expect(windowError({ from: '2026-11-20', to: '2026-11-22' }, today)).toMatch(/no later than today/);
    expect(windowError(null, today)).toBe('Choose a start and an end date.');
  });

  it('"Check a longer window" grows to 7 then 30 days, ending on the same day', () => {
    expect(longerWindow({ window: 'today', from: null, to: null }, today)).toEqual({ window: 'last_7_days', from: null, to: null });
    expect(longerWindow({ window: 'this_week', from: null, to: null }, today)).toEqual({ window: 'last_7_days', from: null, to: null });
    expect(longerWindow({ window: 'last_7_days', from: null, to: null }, today)).toEqual({ window: 'last_30_days', from: null, to: null });
    expect(longerWindow({ window: 'last_30_days', from: null, to: null }, today)).toBeNull();
    expect(longerWindow({ window: 'custom', from: '2026-11-01', to: '2026-11-07' }, today)).toEqual({
      window: 'custom',
      from: '2026-10-09',
      to: '2026-11-07',
    });
  });
});
