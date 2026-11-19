import { describe, expect, it } from 'vitest';
import { ackOf } from '../../utils/agency/homeAcks';
import {
  AGENT_CHIPS,
  CHOOSING_OUTCOME_LABEL,
  agentChips,
  agentsWorking,
  agentsWorkingSub,
  answeredLine,
  attentionFor,
  boardIsPartial,
  lateCallbacksText,
  callbackRows,
  callbacksBadgeLabel,
  callsLiveText,
  campaignCards,
  floorLifecycleAction,
  groupCallingHours,
  lateCallbacks,
  lateCallbacksUnknown,
  callbacksSummary,
  listDone,
  liveFloorClock,
  msToNextMinute,
  readsFor,
  selectedCampaign,
  todayFor,
} from '../../utils/agency/liveFloor';
import { homeAttention, homeBadgeCount, homeRank, type HomeAttentionItem, type HomeCampaignRead, type HomeMissed } from '../../utils/agency/home';
import { AGENCY_FLOOR_STATE_LABELS } from '../../utils/agencyAgentFloor';
import type { AgencyHomeActiveStatus } from '@magick-agency/contracts/api/agency/home';
import { allocationFacts, campaign, settingsFacts, stats, STAFFED, todayFacts } from '../helpers/home';

/**
 * Live floor's rules (LF1): the campaign filter, the tiles, the grouped calling-hours row, the
 * campaign cards and the agents' chips. Each edge that decides what a supervisor reads is pinned.
 */

const NO_MISSED: HomeMissed = { available: false, count: null };
const fmt = (iso: string) => `at ${iso}`;

type ReadOver = Partial<HomeCampaignRead> & { status?: AgencyHomeActiveStatus; name?: string; overdue?: number };

function read(id: string, over: ReadOver = {}): HomeCampaignRead {
  return {
    campaign: campaign(id, over.status ?? 'running', over.name),
    stats: 'stats' in over ? (over.stats ?? null) : stats(),
    staffing: 'staffing' in over ? (over.staffing ?? null) : STAFFED,
    allocation: 'allocation' in over ? (over.allocation ?? null) : allocationFacts({ callbacks_overdue: over.overdue ?? 0 }),
    today: 'today' in over ? (over.today ?? null) : todayFacts(),
    settings: 'settings' in over ? (over.settings ?? null) : settingsFacts(),
    stale: over.stale ?? false,
  };
}

const DEFAULT_HOURS = settingsFacts({ calling_hours_default: true });

describe('the clock', () => {
  it('reads "Wed 18 Nov" and the time on the reader’s clock (UTC in this suite)', () => {
    const now = new Date('2026-11-18T14:15:30Z');
    expect(liveFloorClock(now)).toEqual({ date: 'Wed 18 Nov', time: '02:15 pm' });
  });

  it('ticks on the next minute, never a minute late', () => {
    expect(msToNextMinute(new Date('2026-11-18T14:15:30.250Z'))).toBe(29_750);
    expect(msToNextMinute(new Date('2026-11-18T14:15:00.000Z'))).toBe(60_000);
  });
});

describe('the campaign filter', () => {
  const reads = [read('c1'), read('c2', { status: 'paused' })];

  it('names a campaign on the board, and nothing for one that is not (stopped elsewhere)', () => {
    expect(selectedCampaign('c2', reads)?.id).toBe('c2');
    expect(selectedCampaign('gone', reads)).toBeNull();
    expect(selectedCampaign(null, reads)).toBeNull();
  });

  it('narrows the reads to the picked campaign, or keeps them all', () => {
    expect(readsFor(reads, 'c1').map((r) => r.campaign.id)).toEqual(['c1']);
    expect(readsFor(reads, null).map((r) => r.campaign.id)).toEqual(['c1', 'c2']);
  });

  it('shows the picked campaign’s rows, and counts what needs the reader elsewhere (never information)', () => {
    const items = homeAttention(
      [read('c1', { overdue: 2 }), read('c2', { overdue: 1, settings: DEFAULT_HOURS })],
      { available: true, count: { open: 3, open_capped: false, has_rows: true } },
      fmt,
    );
    const { open, elsewhere } = attentionFor(items, 'c1');
    expect(open.map((i) => i.id)).toEqual(['callbacks-overdue:c1']);
    // c2's late callbacks and the account's missed calls; not c2's calling hours (information).
    expect(elsewhere).toBe(2);
    expect(attentionFor(items, null)).toEqual({ open: groupCallingHours(items), acknowledged: [], elsewhere: 0 });
    // A row the reader put aside is not something the filter hides from them.
    const c2 = items.find((i) => i.id === 'callbacks-overdue:c2')!;
    expect(attentionFor(items, 'c1', { [c2.id]: ackOf(c2) }).elsewhere).toBe(1);
    // Until it gets worse.
    expect(attentionFor(items, 'c1', { [c2.id]: { ...ackOf(c2), count: 0 } }).elsewhere).toBe(2);
    // The picked campaign's calling hours are the grouped row, put aside under the campaign's own id.
    const picked = attentionFor(items, 'c2');
    expect(picked.open.map((i) => i.id)).toEqual(['callbacks-overdue:c2', 'calling-hours-default']);
    expect(picked.elsewhere).toBe(2);
    const grouped = picked.open[1]!;
    expect(grouped.parts!.map((i) => i.id)).toEqual(['calling-hours-default:c2']);
    const acks = Object.fromEntries(grouped.parts!.map((part) => [part.id, ackOf(part)]));
    const aside = attentionFor(items, 'c2', acks);
    expect(aside.open.map((i) => i.id)).toEqual(['callbacks-overdue:c2']);
    expect(aside.acknowledged.map((i) => i.id)).toEqual(['calling-hours-default']);
  });
});

describe('"Got it" on the grouped calling-hours row', () => {
  const items = homeAttention(
    [read('c1', { name: 'Q4', settings: DEFAULT_HOURS }), read('c2', { name: 'Gold', settings: DEFAULT_HOURS }), read('c3', { name: 'Card', settings: DEFAULT_HOURS })],
    NO_MISSED,
    fmt,
  );
  const ackParts = (row: HomeAttentionItem) =>
    Object.fromEntries(row.parts!.map((part) => [part.id, ackOf(part)]));

  it('holds per campaign: given with one campaign picked, the row comes back without it when the filter is cleared', () => {
    const picked = attentionFor(items, 'c1').open[0]!;
    const acks = ackParts(picked);
    expect(Object.keys(acks)).toEqual(['calling-hours-default:c1']);
    const all = attentionFor(items, null, acks);
    expect(all.open).toHaveLength(1);
    expect(all.open[0]).toMatchObject({ id: 'calling-hours-default', count: 2, title: '2 campaigns still use the default calling hours' });
    expect(all.open[0]!.review!.map((c) => c.id)).toEqual(['c2', 'c3']);
    // What was put aside is listed as such, for the campaign it was given for.
    expect(all.acknowledged.map((i) => i.review!.map((c) => c.id))).toEqual([['c1']]);
  });

  it('is put aside while every campaign it covers is, and a campaign newly on the default hours brings it back', () => {
    const acks = ackParts(attentionFor(items, null).open[0]!);
    expect(attentionFor(items, null, acks).open).toEqual([]);
    expect(attentionFor(items, 'c2', acks).open).toEqual([]);
    const more = homeAttention(
      [read('c1', { settings: DEFAULT_HOURS }), read('c2', { settings: DEFAULT_HOURS }), read('c3', { settings: DEFAULT_HOURS }), read('c4', { name: 'New', settings: DEFAULT_HOURS })],
      NO_MISSED,
      fmt,
    );
    const back = attentionFor(more, null, acks);
    expect(back.open.map((i) => i.review!.map((c) => c.name))).toEqual([['New']]);
  });

  it('ignores an acknowledgement stored under the grouped id before acks were held per campaign', () => {
    const stale = { 'calling-hours-default': { kind: 'calling-hours-default', tone: 'info' as const, count: 5 } };
    expect(attentionFor(items, null, stale).open.map((i) => i.id)).toEqual(['calling-hours-default']);
  });
});

describe('the default calling hours, grouped', () => {
  it('makes one information row of every campaign on the default hours, whose Review lists each to its settings', () => {
    const items = homeAttention(
      [read('c1', { name: 'Q4', settings: DEFAULT_HOURS, overdue: 1 }), read('c2', { name: 'Gold', settings: DEFAULT_HOURS }), read('c3', { name: 'Card', settings: DEFAULT_HOURS })],
      NO_MISSED,
      fmt,
    );
    const grouped = groupCallingHours(items);
    expect(grouped.map((i) => i.id)).toEqual(['callbacks-overdue:c1', 'calling-hours-default']);
    const row = grouped[1]!;
    expect(row).toMatchObject({
      tone: 'info',
      campaign: null,
      title: '3 campaigns still use the default calling hours',
      action: 'Review',
      kind: 'calling-hours-default',
      count: 3,
      ackable: true,
    });
    expect(homeRank(row)).toBe('info');
    expect(homeBadgeCount([row])).toBe(0);
    expect(row.detail).toBe(items.find((i) => i.id === 'calling-hours-default:c1')!.detail);
    expect(row.review).toEqual([
      { id: 'c1', name: 'Q4', to: '/agency/campaigns/c1/settings#calling-hours' },
      { id: 'c2', name: 'Gold', to: '/agency/campaigns/c2/settings#calling-hours' },
      { id: 'c3', name: 'Card', to: '/agency/campaigns/c3/settings#calling-hours' },
    ]);
    // Information either way: the badge counts the same before and after.
    expect(homeBadgeCount(grouped)).toBe(homeBadgeCount(items));
  });

  it('says one campaign in the singular, and leaves a list without such rows as it was', () => {
    const one = groupCallingHours(homeAttention([read('c1', { settings: DEFAULT_HOURS })], NO_MISSED, fmt));
    expect(one.map((i) => i.title)).toEqual(['1 campaign still uses the default calling hours']);
    const none = homeAttention([read('c1', { overdue: 2 })], NO_MISSED, fmt);
    expect(groupCallingHours(none)).toEqual(none);
  });

  it('is stale when any campaign it stands for is', () => {
    const items = homeAttention([read('c1', { settings: DEFAULT_HOURS }), read('c2', { settings: DEFAULT_HOURS, stale: true })], NO_MISSED, fmt);
    expect(groupCallingHours(items)[0]!.stale).toBe(true);
  });
});

describe('the tiles', () => {
  it('agents working sums each campaign’s agents on the floor (one station per agent), with no denominator yet', () => {
    const figure = agentsWorking([read('c1', { stats: stats({ agents_live: 4 }) }), read('c2', { stats: stats({ agents_live: 5 }) }), read('c3', { stats: null })]);
    expect(figure).toEqual({ working: 9, assigned: null });
    expect(agentsWorkingSub(figure)).toBe('on the floor now');
    // Phase 2's floor read supplies the denominator.
    expect(agentsWorkingSub({ working: 9, assigned: 10 })).toBe('of 10 assigned');
  });

  it('late callbacks sums the campaigns whose allocation is known, and is a dash (null) when none is', () => {
    expect(lateCallbacks([read('c1', { overdue: 3 }), read('c2', { overdue: 1 }), read('c3', { allocation: null })])).toBe(4);
    expect(lateCallbacks([read('c1', { allocation: null })])).toBeNull();
    expect(lateCallbacks([])).toBeNull();
  });

  it('customers reached is a share of dials, withheld under 25 dials, and never called the connect rate', () => {
    expect(answeredLine({ conversations: 0, dials: 0 })).toBe('No dials yet today');
    expect(answeredLine({ conversations: 10, dials: 24 })).toBe('Too few dials yet for a share');
    expect(answeredLine({ conversations: 7, dials: 25 })).toBe('28% of dials answered');
    expect(answeredLine({ conversations: 360, dials: 1284 })).toBe('28% of dials answered');
  });

  it('takes a picked campaign’s row of the grouped read, and zeros for one that has not dialled', () => {
    const totals = { dials: 10, conversations: 4, successes: 1, talkSeconds: 60, campaigns: 2 };
    const c1 = { dials: 7, conversations: 3, successes: 1, talkSeconds: 40, campaigns: 1 };
    expect(todayFor(totals, { c1 }, null)).toBe(totals);
    expect(todayFor(totals, { c1 }, 'c1')).toBe(c1);
    expect(todayFor(totals, { c1 }, 'c2')).toEqual({ dials: 0, conversations: 0, successes: 0, talkSeconds: 0, campaigns: 0 });
  });
});

describe('the campaign cards', () => {
  it('says calls live, never "of N lines"', () => {
    expect(callsLiveText(stats({ attempts_live: 4 }))).toBe('4 calls live');
    expect(callsLiveText(stats({ attempts_live: 1 }))).toBe('1 call live');
    expect(callsLiveText(null)).toBeNull();
  });

  it('shows how much of the list is done by the Active cards’ rule, in customers', () => {
    expect(listDone(stats({ contacts_total: 1240, contacts_completed: 500, contacts_suppressed: 20, contacts_exhausted: 40 }))).toEqual({
      known: true, percent: (560 / 1240) * 100, label: '45%', caption: '560 of 1,240 customers',
    });
    expect(listDone(stats({ contacts_total: 0, contacts_completed: 0, contacts_suppressed: 0, contacts_exhausted: 0 }))).toMatchObject({
      known: false, percent: null, caption: 'No contacts have been added to this campaign yet.',
    });
    // More worked than exist: the ring's own refusal, not "160%".
    expect(listDone(stats({ contacts_total: 10, contacts_completed: 16, contacts_suppressed: 0, contacts_exhausted: 0 })).known).toBe(false);
    expect(listDone(null).known).toBe(false);
  });

  it('offers Pause on a running campaign and Resume on a paused one, as the header does, and nothing while stopping', () => {
    expect(floorLifecycleAction('running')).toBe('pause');
    expect(floorLifecycleAction('paused')).toBe('resume');
    expect(floorLifecycleAction('stopping')).toBeNull();
    expect(floorLifecycleAction('stopped')).toBeNull();
  });

  it('carries the top stall’s headline and the stale mark', () => {
    const [card] = campaignCards(
      [read('c1', { status: 'paused', stale: true, stats: stats({ stall: { code: 'auto_paused_carrier', reason: 'carrier_auth', paused_at: '2026-11-11T08:00:00Z' } }) })],
      fmt,
    );
    expect(card).toMatchObject({ action: 'resume', stale: true, to: '/agency/campaigns/c1' });
    expect(card!.stall).toMatch(/Paused automatically/);
  });
});

describe('the agents', () => {
  it('counts each state across the shown campaigns, a call being connected as on a call', () => {
    const chips = agentChips([
      read('c1', { stats: stats({ agents_live: 6, agents_by_state: { offline: 1, available: 2, reserved: 1, on_call: 2, wrapup: 1, break: 0 } }) }),
      read('c2', { stats: stats({ agents_live: 3, agents_by_state: { offline: 0, available: 0, reserved: 0, on_call: 1, wrapup: 0, break: 2 } }) }),
    ]);
    expect(chips).toEqual({ total: 9, counts: { on_call: 4, available: 2, wrapup: 1, break: 2 }, partial: false });
  });

  it('says the chips are partial when a campaign’s states are not known', () => {
    expect(agentChips([read('c1', { stats: null })]).partial).toBe(true);
    expect(agentChips([read('c1', { stats: stats({ agents_live: 2, agents_by_state: undefined }) })]).partial).toBe(true);
    expect(agentChips([read('c1', { stats: stats({ agents_live: 0, agents_by_state: undefined }) })]).partial).toBe(false);
  });

  it('calls wrap-up "Choosing outcome" on Live floor only: the campaign floor keeps its words', () => {
    expect(AGENT_CHIPS.map((c) => c.label)).toEqual(['On a call', 'Ready', 'Choosing outcome', 'Break']);
    expect(CHOOSING_OUTCOME_LABEL).toBe('Choosing outcome');
    expect(AGENCY_FLOOR_STATE_LABELS.wrapup).not.toBe(CHOOSING_OUTCOME_LABEL);
  });
});

describe('the Callbacks page and badge', () => {
  it('lists every active campaign, most late first, one not known last', () => {
    const rows = callbackRows([
      read('a', { overdue: 1 }),
      read('b', { allocation: null }),
      read('c', { allocation: allocationFacts({ callbacks_overdue: 5, callbacks_overdue_absent_owner: 2 }) }),
      read('d'),
    ]);
    expect(rows.map((r) => [r.campaign.id, r.overdue, r.ownerAway])).toEqual([
      ['c', 5, 2],
      ['a', 1, 0],
      ['d', 0, 0],
      ['b', null, 0],
    ]);
  });

  it('is a lower bound past the board’s cap, in figures and in words', () => {
    expect(lateCallbacksText(4, false)).toBe('4');
    expect(lateCallbacksText(4, true)).toBe('4+');
    expect(lateCallbacksText(0, true)).toBe('0+');
    expect(lateCallbacksText(150, true)).toBe('99+');
    expect(callbacksBadgeLabel(4, false, true)).toBe('at least 4 callbacks overdue');
    expect(callbacksBadgeLabel(4, true, true)).toBe('at least 4 callbacks overdue (not up to date)');
    expect(boardIsPartial({ activeTotal: 30, reads: new Array(25) })).toBe(true);
    expect(boardIsPartial({ activeTotal: 25, reads: new Array(25) })).toBe(false);
  });

  it('counts the campaigns whose late callbacks are not known', () => {
    expect(lateCallbacksUnknown([read('a', { overdue: 1 }), read('b', { allocation: null }), read('c', { allocation: null })])).toBe(2);
    expect(lateCallbacksUnknown([read('a')])).toBe(0);
  });

  it('gives the Callbacks page an all-clear only when every campaign was read, all of them', () => {
    expect(callbacksSummary({ count: 0, capped: false, unknown: 0 })).toBe('No callback is late right now.');
    expect(callbacksSummary({ count: 5, capped: false, unknown: 0 })).toBe('5 callbacks late across the active campaigns.');
    // A campaign not known: never "no callback is late".
    expect(callbacksSummary({ count: 0, capped: false, unknown: 1 })).toBe('No late callbacks found, but 1 campaign’s callbacks aren’t known.');
    expect(callbacksSummary({ count: 3, capped: false, unknown: 2 })).toBe('At least 3 callbacks late. 2 campaigns’ callbacks aren’t known.');
    // Past the board's cap: never "at least 0".
    expect(callbacksSummary({ count: 0, capped: true, unknown: 0 })).toBe('No late callbacks found in the first 25 active campaigns.');
    expect(callbacksSummary({ count: 4, capped: true, unknown: 0 })).toBe('At least 4 callbacks late, in the first 25 active campaigns.');
    expect(callbacksSummary({ count: 0, capped: true, unknown: 1 })).toBe('No late callbacks found in the first 25 active campaigns, but 1 campaign’s callbacks aren’t known.');
    // None known at all.
    expect(callbacksSummary({ count: null, capped: false, unknown: 2 })).toBe('Late callbacks couldn’t be read for any campaign.');
    expect(callbacksSummary({ count: null, capped: false, unknown: 0 })).toBeNull();
  });

  it('says the count to a screen reader, and nothing at zero', () => {
    expect(callbacksBadgeLabel(1)).toBe('1 callback overdue');
    expect(callbacksBadgeLabel(4, true)).toBe('4 callbacks overdue (not up to date)');
    expect(callbacksBadgeLabel(120)).toBe('more than 99 callbacks overdue');
    expect(callbacksBadgeLabel(0)).toBeNull();
    expect(callbacksBadgeLabel(null)).toBeNull();
  });
});
