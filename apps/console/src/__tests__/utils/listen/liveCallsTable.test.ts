import { describe, it, expect } from 'vitest';
import {
  DEFAULT_LIVE_CALL_SORT,
  LIVE_CALL_ENDED_LINGER_MS,
  NO_LIVE_CALL_FILTERS,
  filterLiveCalls,
  isLiveCallOverrun,
  listenTargetFor,
  liveCallFilterOptions,
  liveCallHref,
  liveCallPagePath,
  liveCallRowPagePath,
  mergeLiveCalls,
  nextLiveCallSort,
  pruneEndedLiveCalls,
  sortLiveCalls,
} from '../../../utils/listen/liveCallsTable';
import {
  LISTEN_AGENT_NOTICE,
  LISTEN_SESSION_NOTICE,
  campaignCellLabel,
  customerLabel,
  formatClock,
  inProgressLabel,
  listenRefusalMessage,
  listenedForLabel,
  notListenableCopy,
  shortName,
  updatedAgoLabel,
} from '../../../utils/listen/listenCopy';
import { liveCall } from '../../helpers/liveCalls';

/**
 * The live calls table's rules (`docs/listening.md` §9) and the words it and the bar say.
 */

const rows = (...calls: ReturnType<typeof liveCall>[]) => calls.map((call) => ({ call, endedAt: null }));

const A = liveCall({ call_id: 'a', agent_user_id: 'u-1', agent_name: 'Vikram Das', connected_at: '2026-11-16T10:03:00Z', origin: 'campaign', correlation_id: 'att-a', campaign_id: 'c-1', campaign_name: 'Renewals' });
const B = liveCall({ call_id: 'b', agent_user_id: 'u-2', agent_name: 'Arjun Nair', connected_at: '2026-11-16T10:01:00Z', origin: 'inbound', correlation_id: 'in-b', campaign_id: null, campaign_name: null, inbound_route_name: 'Support line' });
const C = liveCall({ call_id: 'c', agent_user_id: 'u-3', agent_name: 'sneha iyer', connected_at: '2026-11-16T10:02:00Z', origin: 'manual', correlation_id: 'man-c', campaign_id: null, campaign_name: null });

describe('sorting', () => {
  it('defaults to the longest on call first', () => {
    expect(sortLiveCalls(rows(A, B, C), DEFAULT_LIVE_CALL_SORT).map((r) => r.call.call_id)).toEqual(['b', 'c', 'a']);
  });

  it('flips its own column and starts another on its natural order', () => {
    expect(nextLiveCallSort(DEFAULT_LIVE_CALL_SORT, 'time')).toEqual({ key: 'time', dir: 'asc' });
    expect(nextLiveCallSort(DEFAULT_LIVE_CALL_SORT, 'agent')).toEqual({ key: 'agent', dir: 'asc' });
    expect(nextLiveCallSort({ key: 'agent', dir: 'asc' }, 'agent')).toEqual({ key: 'agent', dir: 'desc' });
    expect(nextLiveCallSort({ key: 'agent', dir: 'asc' }, 'time')).toEqual({ key: 'time', dir: 'desc' });
  });

  it('sorts agents by name, ignoring case, either way', () => {
    expect(sortLiveCalls(rows(A, B, C), { key: 'agent', dir: 'asc' }).map((r) => r.call.call_id)).toEqual(['b', 'c', 'a']);
    expect(sortLiveCalls(rows(A, B, C), { key: 'agent', dir: 'desc' }).map((r) => r.call.call_id)).toEqual(['a', 'c', 'b']);
    expect(sortLiveCalls(rows(A, B, C), { key: 'time', dir: 'asc' }).map((r) => r.call.call_id)).toEqual(['a', 'c', 'b']);
  });

  it('keeps equal rows in a stable order, so a poll does not reshuffle them', () => {
    const x = liveCall({ call_id: 'x', connected_at: '2026-11-16T10:00:00Z' });
    const y = liveCall({ call_id: 'y', connected_at: '2026-11-16T10:00:00Z' });
    expect(sortLiveCalls(rows(y, x), DEFAULT_LIVE_CALL_SORT).map((r) => r.call.call_id)).toEqual(['x', 'y']);
  });
});

describe('filters', () => {
  it('by type, agent and campaign, together', () => {
    const all = rows(A, B, C);
    expect(filterLiveCalls(all, NO_LIVE_CALL_FILTERS)).toHaveLength(3);
    expect(filterLiveCalls(all, { ...NO_LIVE_CALL_FILTERS, type: 'inbound' }).map((r) => r.call.call_id)).toEqual(['b']);
    expect(filterLiveCalls(all, { ...NO_LIVE_CALL_FILTERS, type: 'manual' }).map((r) => r.call.call_id)).toEqual(['c']);
    expect(filterLiveCalls(all, { ...NO_LIVE_CALL_FILTERS, agent: 'u-1' }).map((r) => r.call.call_id)).toEqual(['a']);
    expect(filterLiveCalls(all, { ...NO_LIVE_CALL_FILTERS, campaign: 'c-1', type: 'inbound' })).toEqual([]);
  });

  it('offers the agents and campaigns in the rows, by name', () => {
    expect(liveCallFilterOptions([A, B, C])).toEqual({
      agents: [
        { id: 'u-2', name: 'Arjun Nair' },
        { id: 'u-3', name: 'sneha iyer' },
        { id: 'u-1', name: 'Vikram Das' },
      ],
      campaigns: [{ id: 'c-1', name: 'Renewals' }],
    });
  });
});

describe('rows that end', () => {
  it('a call that leaves the list lingers as ended for 3 s, then goes', () => {
    const first = mergeLiveCalls([], [A, B], 1_000);
    const second = mergeLiveCalls(first, [A], 2_000);
    expect(second.map((r) => [r.call.call_id, r.endedAt])).toEqual([['a', null], ['b', 2_000]]);
    const third = mergeLiveCalls(second, [A], 2_000 + LIVE_CALL_ENDED_LINGER_MS - 1);
    expect(third.find((r) => r.call.call_id === 'b')?.endedAt).toBe(2_000);
    expect(mergeLiveCalls(third, [A], 2_000 + LIVE_CALL_ENDED_LINGER_MS).map((r) => r.call.call_id)).toEqual(['a']);
  });

  it('a call back in the list is live again', () => {
    const ended = mergeLiveCalls(mergeLiveCalls([], [A], 0), [], 100);
    expect(mergeLiveCalls(ended, [A], 200)).toEqual([{ call: A, endedAt: null }]);
  });

  it('prune drops ended rows on time between reads, and returns the same list when nothing went', () => {
    const list = mergeLiveCalls(mergeLiveCalls([], [A, B], 0), [A], 100);
    expect(pruneEndedLiveCalls(list, 100 + LIVE_CALL_ENDED_LINGER_MS - 1)).toBe(list);
    expect(pruneEndedLiveCalls(list, 100 + LIVE_CALL_ENDED_LINGER_MS).map((r) => r.call.call_id)).toEqual(['a']);
  });
});

describe('amber past twice the average handle time', () => {
  it('only past 2× AHT, and never when AHT is not known', () => {
    expect(isLiveCallOverrun(340_001, 170)).toBe(true);
    expect(isLiveCallOverrun(340_000, 170)).toBe(false);
    expect(isLiveCallOverrun(999_999, null)).toBe(false);
    expect(isLiveCallOverrun(999_999, 0)).toBe(false);
    expect(isLiveCallOverrun(null, 170)).toBe(false);
  });
});

describe('what a listen starts with', () => {
  it('the bar’s facts from the row, and the list’s clock', () => {
    expect(listenTargetFor(A, -250)).toEqual({
      callId: 'a',
      origin: 'campaign',
      correlationId: 'att-a',
      campaignId: 'c-1',
      campaignLabel: 'Renewals',
      agentName: 'Vikram Das',
      customerMasked: A.customer_phone_masked,
      connectedAt: A.connected_at,
      clockOffsetMs: -250,
    });
  });

  it('Open call: the attempt for a dialler call, the soft-phone call page for a soft-phone call', () => {
    expect(liveCallRowPagePath(A)).toBe('/agency/campaigns/c-1/attempts/att-a');
    expect(liveCallRowPagePath(C)).toBe('/agency/softphone/calls/man-c');
    // A soft-phone call tagged to a campaign is still the soft phone's page.
    expect(liveCallRowPagePath({ ...C, campaign_id: 'c-9' })).toBe('/agency/softphone/calls/man-c');
    expect(liveCallHref(listenTargetFor(A, 0))).toBe('/agency/campaigns/c-1/attempts/att-a');
    expect(liveCallHref(listenTargetFor(C, 0))).toBe('/agency/softphone/calls/man-c');
  });

  it('Open call: an inbound call has no page in the console, so the bar opens its live view', () => {
    expect(liveCallRowPagePath(B)).toBeNull();
    expect(liveCallRowPagePath({ ...B, campaign_id: 'c-1' })).toBeNull();
    expect(liveCallHref(listenTargetFor(B, 0))).toBe('/agency/live');
    expect(liveCallHref(listenTargetFor({ ...B, campaign_id: 'c-1' }, 0))).toBe('/agency/campaigns/c-1/calls/live');
  });

  it('Open call: no page without the ids it is keyed on', () => {
    expect(liveCallPagePath({ origin: 'campaign', campaignId: null, correlationId: 'att-a' })).toBeNull();
    expect(liveCallPagePath({ origin: 'campaign', campaignId: 'c-1', correlationId: '' })).toBeNull();
    expect(liveCallPagePath({ origin: 'manual', campaignId: null, correlationId: undefined })).toBeNull();
    expect(liveCallHref({ origin: 'manual', campaignId: null, correlationId: '' })).toBe('/agency/live');
  });
});

describe('the words', () => {
  it('Campaign column: the campaign, "Soft phone", or "Inbound: <route>"', () => {
    expect(campaignCellLabel(A)).toBe('Renewals');
    expect(campaignCellLabel(B)).toBe('Inbound: Support line');
    expect(campaignCellLabel({ ...B, inbound_route_name: null })).toBe('Inbound');
    expect(campaignCellLabel(C)).toBe('Soft phone');
    expect(campaignCellLabel({ ...C, campaign_name: 'Tagged' })).toBe('Tagged');
  });

  it('customer: the name, or "Unknown caller"', () => {
    expect(customerLabel({ customer_name: 'Rahul Mehta' })).toBe('Rahul Mehta');
    expect(customerLabel({ customer_name: null })).toBe('Unknown caller');
    expect(customerLabel({ customer_name: '  ' })).toBe('Unknown caller');
  });

  it('clocks as mm:ss, then h:mm:ss, never negative', () => {
    expect(formatClock(0)).toBe('00:00');
    expect(formatClock(372_900)).toBe('06:12');
    expect(formatClock(3_725_000)).toBe('1:02:05');
    expect(formatClock(-5)).toBe('00:00');
    expect(formatClock(null)).toBe('00:00');
  });

  it('the header, the bar and the reasons', () => {
    expect(inProgressLabel(5)).toBe('5 in progress');
    expect(updatedAgoLabel(2.7)).toBe('Updated 2 s ago');
    expect(updatedAgoLabel(-1)).toBe('Updated 0 s ago');
    expect(listenedForLabel(130_000)).toBe('Call ended · you listened for 02:10');
    expect(shortName('Priya Sharma')).toBe('Priya S.');
    expect(shortName('Priya Rani Sharma')).toBe('Priya S.');
    expect(shortName('Priya')).toBe('Priya');
    expect(notListenableCopy('listen_recording_off')).toBe('Listening is turned off for unrecorded calls');
    // Count-neutral: the per-call cap is configurable (AGENCY_LISTEN_MAX_PER_CALL, 1–5).
    expect(notListenableCopy('listen_limit_call')).toBe('This call has reached its listening limit');
    expect(notListenableCopy('listen_own_call')).toBe('You are on this call');
    expect(notListenableCopy(null)).toBe('You cannot listen to this call');
  });

  it('the notices are the locked words (LS2, LS6)', () => {
    expect(LISTEN_AGENT_NOTICE).toBe('Calls may be listened to by a supervisor for quality and training.');
    expect(LISTEN_SESSION_NOTICE).toBe('This session is logged. Do not record or share what you hear.');
  });

  it('a refused grant says its code, else what the status means', () => {
    expect(listenRefusalMessage({ status: 409, code: 'listen_limit_call' })).toBe('That call has reached its listening limit.');
    expect(listenRefusalMessage({ status: 404, code: 'listen_call_not_live' })).toBe('That call has ended.');
    expect(listenRefusalMessage({ status: 403, code: 'feature_disabled' })).toBe('Listening is turned off for this account.');
    expect(listenRefusalMessage({ status: 403, code: 'insufficient_permissions' })).toBe('You do not have access to listen to calls.');
    expect(listenRefusalMessage({ status: null, code: null })).toBe('Could not start listening. Check your connection and try again.');
    expect(listenRefusalMessage({ status: 500, code: null })).toBe('Could not start listening. Try again.');
    // The grant's own 503s keep their code; a bare 503 (from in front of the server) still reads as unavailable.
    expect(listenRefusalMessage({ status: 503, code: 'listen_unavailable' })).toBe('Listening is not available right now. Try again.');
    expect(listenRefusalMessage({ status: 503, code: null })).toBe('Listening is not available right now. Try again.');
    expect(listenRefusalMessage({ status: 503, code: 'worker_unavailable' })).toBe('Listening is not available right now. Try again.');
    expect(listenRefusalMessage({ status: 503, code: 'listen_limit_server' })).toBe('Listening is busy right now. Try again in a minute.');
  });
});
