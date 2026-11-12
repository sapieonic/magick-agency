import { describe, it, expect } from 'vitest';
import {
  campaignAttemptAgentOptions,
  campaignAttemptFilterChips,
  campaignAttemptFilterRefusal,
  campaignAttemptFiltersFromParams,
  campaignAttemptFiltersToParams,
  isCampaignAttemptFiltered,
  phoneFilterDraftError,
  phoneFilterUsable,
} from '../../utils/agencyCampaignAttemptParams';
import { ApiError } from '../../api/client';
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

describe('campaignAttemptAgentOptions', () => {
  const assigned = [
    { user_id: 'u-b', name: 'Priya', email: 'p@example.com' },
    { user_id: 'u-c', name: null, email: 'nameless@example.com' },
    { user_id: 'u-d', name: null, email: null },
  ];

  it('names each agent, falls back to the email, and leaves out one with neither', () => {
    expect(campaignAttemptAgentOptions(assigned, [])).toEqual([
      { id: 'u-c', name: 'nameless@example.com' },
      { id: 'u-b', name: 'Priya' },
    ]);
  });

  it('adds an agent named on a row who is no longer assigned, once', () => {
    const rows = [
      { agent_user_id: 'u-a', agent_name: 'Hari' },
      { agent_user_id: 'u-a', agent_name: 'Hari' },
      { agent_user_id: null, agent_name: null },
    ];
    expect(campaignAttemptAgentOptions(assigned, rows).map((o) => o.name)).toEqual(['Hari', 'nameless@example.com', 'Priya']);
  });

  it('keeps an applied id nobody knows, so the control shows what the URL applies', () => {
    expect(campaignAttemptAgentOptions([], [], 'hari')).toEqual([{ id: 'hari', name: 'hari' }]);
  });
});

describe('campaignAttemptFilterRefusal', () => {
  const refused = (...params: string[]) => new ApiError(400, {
    error: 'Validation failed', details: params.map((param) => ({ param, message: 'raw server text' })),
  });

  it('says which filter to change, in a sentence, never the server text', () => {
    expect(campaignAttemptFilterRefusal(refused('agent_user_id'))).toBe(
      'The agent filter does not match an agent. Pick one from the list. Change or remove it above to see the call log.',
    );
    expect(campaignAttemptFilterRefusal(refused('phone', 'from'))).toBe(
      'The phone number filter needs at least one digit. The date filter is not a date this list can use. '
        + 'Change or remove it above to see the call log.',
    );
    expect(campaignAttemptFilterRefusal(refused('something_new'))).toContain('One of the filters cannot be used.');
  });

  it('tells a range the wrong way round from a date it cannot read, by the server message', () => {
    // The server's words (`spine-filters.ts`): the same `param` as a bad date, no code.
    const issue = (param: string, message: string) => new ApiError(400, {
      error: 'Validation failed', details: [{ param, message }],
    });
    expect(campaignAttemptFilterRefusal(issue('from', '`from` must not be later than `to`'))).toBe(
      'The “From” date is after the “To” date, so nothing could match. Swap them to continue. '
        + 'Change or remove it above to see the call log.',
    );
    expect(campaignAttemptFilterRefusal(
      issue('dialed_from', '`dialed_from` must be earlier than `dialed_to` (the window is half-open)'),
    )).toContain('The dialled “From” date is after the dialled “To” date, so nothing could match.');
    // A date it cannot read keeps its own sentence.
    expect(campaignAttemptFilterRefusal(issue('from', 'is not a real date'))).toContain(
      'The date filter is not a date this list can use.',
    );
  });

  it('is null for anything that is not a refused filter, so Retry stays', () => {
    expect(campaignAttemptFilterRefusal(new ApiError(503, { message: 'down' }))).toBeNull();
    expect(campaignAttemptFilterRefusal(new ApiError(400, { message: 'bad' }))).toBeNull();
    expect(campaignAttemptFilterRefusal(new Error('network'))).toBeNull();
  });
});

describe('phoneFilterUsable', () => {
  it('needs a digit, as the server does; blank is no filter', () => {
    expect(phoneFilterUsable('')).toBe(true);
    expect(phoneFilterUsable('  ')).toBe(true);
    expect(phoneFilterUsable('98765')).toBe(true);
    expect(phoneFilterUsable('+91 (98)')).toBe(true);
    expect(phoneFilterUsable('abc!!')).toBe(false);
  });
});

describe('phoneFilterDraftError', () => {
  it('says nothing while a number is still being begun, until Apply is pressed', () => {
    for (const draft of ['+', ' + ', '(', '+ (', '-']) {
      expect(phoneFilterDraftError(draft, false)).toBeNull();
      expect(phoneFilterDraftError(draft, true)).toBe('Type at least one digit of the phone number.');
    }
  });

  it('says at once when the draft cannot become a number, and nothing once it has a digit', () => {
    expect(phoneFilterDraftError('abc', false)).toBe('Type at least one digit of the phone number.');
    expect(phoneFilterDraftError('+9', true)).toBeNull();
    expect(phoneFilterDraftError('', true)).toBeNull();
  });
});
