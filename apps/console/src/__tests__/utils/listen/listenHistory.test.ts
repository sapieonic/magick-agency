import { describe, it, expect } from 'vitest';
import {
  EMPTY_LISTEN_HISTORY_DRAFT,
  listenHistoryCallPath,
  listenHistoryCallType,
  listenHistoryCustomer,
  listenHistoryFilterCount,
  listenHistoryFilterOptions,
  listenHistoryHowEnded,
  listenHistoryQuery,
  listenHistoryRangeReversed,
} from '../../../utils/listen/listenHistory';
import { listenHistoryCountLabel, listenHistoryTruncatedNotice, listenedDurationLabel } from '../../../utils/listen/listenCopy';
import { AGENCY_LISTEN_END_REASONS } from '../../../types/live-calls';
import { AGENCY_LISTEN_END_REASON_LABELS } from '../../../types/listen-history';
import { historyEntry } from '../../helpers/listenHistory';
import type { TenantMember } from '../../../types/team';

/**
 * The Listening history page's rules, pure (`docs/listening.md` §12, LS19): the filters as the
 * route's query, each column's words, the link to the call, and the filter choices.
 */

function member(id: string, name: string, role: TenantMember['membership']['role'], accountId: string | null = null): TenantMember {
  return {
    membership: { id: `m-${id}`, tenant_id: 't-1', user_id: id, role, account_id: accountId, status: 'active' } as TenantMember['membership'],
    user: { id, email: `${id}@example.com`, display_name: name } as TenantMember['user'],
  };
}

describe('the filters as the query', () => {
  it('nothing chosen asks for everything', () => {
    expect(listenHistoryQuery(EMPTY_LISTEN_HISTORY_DRAFT)).toEqual({});
    expect(listenHistoryFilterCount(EMPTY_LISTEN_HISTORY_DRAFT)).toBe(0);
  });

  it('the supervisor and the agent by id; the dates as the local day’s start and the day after the last (exclusive)', () => {
    const draft = { supervisor: 'sup-1', agent: 'u-1', from: '2026-11-01', to: '2026-11-16' };
    expect(listenHistoryQuery(draft)).toEqual({
      listener_user_id: 'sup-1',
      agent_user_id: 'u-1',
      from: new Date('2026-11-01T00:00:00').toISOString(),
      to: new Date('2026-11-17T00:00:00').toISOString(),
    });
    expect(listenHistoryFilterCount(draft)).toBe(3);
  });

  it('a range the wrong way round is said so', () => {
    expect(listenHistoryRangeReversed({ ...EMPTY_LISTEN_HISTORY_DRAFT, from: '2026-11-16', to: '2026-11-01' })).toBe(true);
    expect(listenHistoryRangeReversed({ ...EMPTY_LISTEN_HISTORY_DRAFT, from: '2026-11-16', to: '2026-11-16' })).toBe(false);
    expect(listenHistoryRangeReversed({ ...EMPTY_LISTEN_HISTORY_DRAFT, from: '2026-11-16' })).toBe(false);
  });
});

describe('a row’s words', () => {
  it('the call type by origin', () => {
    expect(listenHistoryCallType(historyEntry())).toBe('Dialler');
    expect(listenHistoryCallType(historyEntry({ origin: 'manual' }))).toBe('Soft phone');
    expect(listenHistoryCallType(historyEntry({ origin: 'inbound', inbound_route_name: 'Support' }))).toBe('Inbound: Support');
    expect(listenHistoryCallType(historyEntry({ origin: 'inbound' }))).toBe('Inbound');
  });

  it('the customer: name and masked number, "Withheld", or nothing when the call’s row is gone', () => {
    expect(listenHistoryCustomer(historyEntry())).toEqual({ name: 'Rahul Mehta', number: '****4321' });
    expect(listenHistoryCustomer(historyEntry({ origin: 'inbound', customer_name: null, customer_phone_masked: null, customer_phone_withheld: true })))
      .toEqual({ name: 'Unknown caller', number: 'Withheld' });
    expect(listenHistoryCustomer(historyEntry({ customer_name: null, customer_phone_masked: null }))).toEqual({ name: 'No name', number: null });
  });

  it('how long and how it ended; an open visit is "Listening now"', () => {
    expect(listenedDurationLabel(historyEntry().listened_seconds, historyEntry().ended_at)).toBe('2m 10s');
    expect(listenHistoryHowEnded(historyEntry())).toBe('Stopped by the supervisor');
    const open = historyEntry({ ended_at: null, listened_seconds: null, end_reason: null });
    expect(listenedDurationLabel(open.listened_seconds, open.ended_at)).toBe('Listening now');
    expect(listenHistoryHowEnded(open)).toBe('Listening now');
  });

  it('every end reason has the contract’s words', () => {
    for (const reason of AGENCY_LISTEN_END_REASONS) {
      expect(listenHistoryHowEnded(historyEntry({ end_reason: reason }))).toBe(AGENCY_LISTEN_END_REASON_LABELS[reason]);
    }
    expect(listenHistoryHowEnded(historyEntry({ end_reason: 'access_unverified' }))).toBe('Access could not be checked');
  });
});

describe('the link to the call', () => {
  it('the attempt, the soft-phone call; an inbound call has none in the console', () => {
    expect(listenHistoryCallPath(historyEntry(), true)).toBe('/agency/campaigns/camp-1/attempts/att-1');
    expect(listenHistoryCallPath(historyEntry({ origin: 'manual', correlation_id: 'man-1', campaign_id: null }), true)).toBe('/agency/softphone/calls/man-1');
    expect(listenHistoryCallPath(historyEntry({ origin: 'inbound', correlation_id: 'in-1', campaign_id: null }), true)).toBeNull();
  });

  it('none for a soft-phone call while the soft phone is turned off: its page would only say it is unavailable', () => {
    expect(listenHistoryCallPath(historyEntry({ origin: 'manual', correlation_id: 'man-1', campaign_id: null }), false)).toBeNull();
    expect(listenHistoryCallPath(historyEntry(), false)).toBe('/agency/campaigns/camp-1/attempts/att-1');
  });

  it('none once the call’s row is gone (no number and not withheld), whatever its type', () => {
    expect(listenHistoryCallPath(historyEntry({ customer_phone_masked: null }), true)).toBeNull();
    // A withheld caller's call is still there.
    expect(listenHistoryCallPath(historyEntry({ origin: 'manual', correlation_id: 'man-1', customer_phone_masked: null, customer_phone_withheld: true }), true))
      .toBe('/agency/softphone/calls/man-1');
  });
});

describe('the filter choices', () => {
  const MEMBERS = [
    member('sup-1', 'Anita Kapoor', 'account_admin'),
    member('u-1', 'Priya Sharma', 'agent'),
    member('op-1', 'Omar Pillai', 'operator'),
  ];

  it('supervisors are the members who may listen; agents are every member; both by name', () => {
    const { supervisors, agents } = listenHistoryFilterOptions(MEMBERS, [], {}, 'a-1');
    expect(supervisors).toEqual([{ id: 'sup-1', name: 'Anita Kapoor' }]);
    expect(agents.map((a) => a.name)).toEqual(['Anita Kapoor', 'Omar Pillai', 'Priya Sharma']);
  });

  it('only people in this account: a seat in another account is not offered', () => {
    const { supervisors, agents } = listenHistoryFilterOptions(
      [...MEMBERS, member('sup-b', 'Bela Other', 'account_admin', 'a-2'), member('u-b', 'Bilal Other', 'agent', 'a-2'), member('sup-a', 'Asha Here', 'account_admin', 'a-1')],
      [],
      {},
      'a-1',
    );
    expect(supervisors.map((o) => o.name)).toEqual(['Anita Kapoor', 'Asha Here']);
    expect(agents.map((o) => o.name)).toEqual(['Anita Kapoor', 'Asha Here', 'Omar Pillai', 'Priya Sharma']);
  });

  it('adds the people in the rows (a former member included) and keeps the one chosen', () => {
    const { supervisors, agents } = listenHistoryFilterOptions(
      [],
      [historyEntry({ listener_user_id: 'sup-9', listener_name: 'Zoe Former', agent_user_id: 'u-9', agent_name: null })],
      { supervisor: { id: 'sup-2', name: 'Rohan Shah' } },
      'a-1',
    );
    expect(supervisors).toEqual([{ id: 'sup-2', name: 'Rohan Shah' }, { id: 'sup-9', name: 'Zoe Former' }]);
    expect(agents).toHaveLength(1);
    expect(agents[0]!.id).toBe('u-9');
  });
});

describe('the words around the table', () => {
  it('counts the listens shown', () => {
    expect(listenHistoryCountLabel(1, false)).toBe('Showing 1 listen');
    expect(listenHistoryCountLabel(1200, true)).toBe('Showing 1,200 listens — there are more');
  });

  it('says why an export was cut short and what to do', () => {
    expect(listenHistoryTruncatedNotice('row_limit', 10_000)).toBe('Only the newest 10,000 listens were exported. Narrow the date range and export again to get the rest.');
    expect(listenHistoryTruncatedNotice('deadline', 10_000)).toMatch(/^The export took too long and stopped early/);
    expect(listenHistoryTruncatedNotice(null, null)).toMatch(/server’s limit/);
  });
});
