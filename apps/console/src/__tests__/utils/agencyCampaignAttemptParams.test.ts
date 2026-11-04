import { describe, it, expect } from 'vitest';
import {
  campaignAttemptFilterChips,
  campaignAttemptFiltersFromParams,
  campaignAttemptFiltersToParams,
  isCampaignAttemptFiltered,
} from '../../utils/agencyCampaignAttemptParams';
import {
  rosterFilterGroupCount,
  rosterFiltersFromParams,
  rosterFiltersToParams,
  rosterLinkFilterChips,
} from '../../utils/agencyRosterFilters';
import { selectorFromContactFilters, droppedFilterNotice } from '../../utils/agencyRetrySelector';
import type { AgencyAttemptFilters } from '../../types/agency-spine';

/**
 * URL ⇄ filters for the two lists an Insights number opens (docs/insights.md, WS F), and the
 * removable chips that say what is applied.
 */

const EVERY: AgencyAttemptFilters = {
  outcome: ['connected', 'no_answer'],
  state: ['ended'],
  disposition_code: ['ptp'],
  contact_id: 'c-1',
  agent_user_id: 'u-1',
  caller_id: '+919000000001',
  phone: '98765',
  from: '2026-08-01T00:00:00.000Z',
  to: '2026-08-02T23:59:59.999Z',
  dialed_from: '2026-08-01T00:00:00.000Z',
  dialed_to: '2026-08-02T00:00:00.000Z',
  redial: '1',
  agent_manual: '0',
  agent_reopened: '1',
  placed: '1',
};

describe('the attempts list filters round-trip through the URL', () => {
  it('every key survives filters → URL → filters', () => {
    expect(campaignAttemptFiltersFromParams(campaignAttemptFiltersToParams(EVERY))).toEqual(EVERY);
  });

  it('repeats list values rather than comma-joining them', () => {
    const params = campaignAttemptFiltersToParams({ outcome: ['busy', 'failed'] });
    expect(params.getAll('outcome')).toEqual(['busy', 'failed']);
  });

  it('is an allow-list: an unknown key and a flag that is not 1 or 0 are dropped', () => {
    const read = campaignAttemptFiltersFromParams(new URLSearchParams('utm=x&redial=yes&placed=0&caller_id=%20'));
    expect(read).toEqual({ placed: '0' });
  });

  it('a cleared filter leaves the query string', () => {
    expect(campaignAttemptFiltersToParams({}).toString()).toBe('');
    expect(isCampaignAttemptFiltered({})).toBe(false);
    expect(isCampaignAttemptFiltered({ placed: '1' })).toBe(true);
    expect(isCampaignAttemptFiltered({ contact_id: 'c-1' })).toBe(true);
  });
});

describe('attempt filter chips', () => {
  const chips = campaignAttemptFilterChips(EVERY, {
    dispositionLabel: (code) => (code === 'ptp' ? 'Promise to pay' : null),
    agentName: () => 'Ravi Menon',
  });
  const labels = chips.map((c) => c.label);

  it('names every applied filter in words, one chip per list value and one per range', () => {
    expect(labels).toEqual(expect.arrayContaining([
      'One contact',
      'Outcome: Connected',
      'Outcome: No answer',
      'State: Ended',
      'Written up as: Promise to pay',
      'Agent: Ravi Menon',
      'Caller ID: +919000000001',
      'Phone: 98765',
      'Wrap-up redials',
      'Not dialled by hand',
      'Dials after a reopen',
      'Dials placed',
    ]));
    // Two ranges, two chips, worded so the dialled window is not read as the created dates.
    expect(labels.filter((l) => l.startsWith('Dialled from'))).toHaveLength(1);
    expect(labels.filter((l) => l.startsWith('Created'))).toHaveLength(1);
    expect(chips).toHaveLength(14);
  });

  it('removing a list value keeps the others; removing a range drops both ends', () => {
    const outcome = chips.find((c) => c.id === 'outcome:connected')!;
    expect(outcome.without.outcome).toEqual(['no_answer']);
    expect(outcome.without.redial).toBe('1');

    const dialled = chips.find((c) => c.id === 'dialed')!;
    expect(dialled.without).not.toHaveProperty('dialed_from');
    expect(dialled.without).not.toHaveProperty('dialed_to');
    // The created-at pickers are a different window and stay.
    expect(dialled.without.from).toBe(EVERY.from);

    const last = campaignAttemptFilterChips({ outcome: ['busy'] })[0]!;
    expect(last.without).toEqual({});
  });

  it('falls back to the id and the code when no name is known', () => {
    const bare = campaignAttemptFilterChips({ agent_user_id: 'u-9', disposition_code: ['x_code'] });
    expect(bare.map((c) => c.label)).toEqual(['Written up as: x_code', 'Agent: u-9']);
  });
});

describe('the roster reads waiting and attempted the same way', () => {
  it('round-trips both, and counts each as a filter group', () => {
    const filters = rosterFiltersFromParams(new URLSearchParams('state=pending&waiting=callback&attempted=1'));
    expect(filters).toEqual({ state: ['pending'], waiting: 'callback', attempted: '1' });
    expect(rosterFiltersFromParams(rosterFiltersToParams(filters))).toEqual(filters);
    expect(rosterFilterGroupCount(filters)).toBe(3);
  });

  it('drops a value it does not know', () => {
    expect(rosterFiltersFromParams(new URLSearchParams('waiting=soon&attempted=2'))).toEqual({});
  });

  it('shows both as removable chips, each removal leaving the rest', () => {
    const chips = rosterLinkFilterChips({ state: ['pending'], waiting: 'retry', attempted: '0' });
    expect(chips.map((c) => c.label)).toEqual(['Waiting: Waiting for retry time', 'Never attempted']);
    expect(chips[0]!.without).toEqual({ state: ['pending'], attempted: '0' });
    expect(chips[1]!.without).toEqual({ state: ['pending'], waiting: 'retry' });
  });

  it('a retry drops them loudly rather than sending a key the selector would refuse', () => {
    const { selector, dropped } = selectorFromContactFilters({ state: ['pending'], waiting: 'retry', attempted: '1' });
    expect(selector).toEqual({ state: ['pending'] });
    expect(dropped).toEqual(expect.arrayContaining(['waiting', 'attempted']));
    expect(droppedFilterNotice(dropped)).toMatch(/Waiting/);
  });
});
