import type { AgencyListenHistoryEntry } from '../../types/listen-history';

/**
 * One entry of the account's Listening history for the tests: Anita Kapoor listened to Priya
 * Sharma's dialler call (attempt `att-1`) for 2m 10s and stopped.
 */
export function historyEntry(over: Partial<AgencyListenHistoryEntry> = {}): AgencyListenHistoryEntry {
  return {
    id: 'l-1',
    listen_ids: ['l-1'],
    call_id: 'call-1',
    origin: 'campaign',
    correlation_id: 'att-1',
    campaign_id: 'camp-1',
    campaign_name: 'Renewals',
    inbound_route_name: null,
    listener_user_id: 'sup-1',
    listener_name: 'Anita Kapoor',
    agent_user_id: 'u-1',
    agent_name: 'Priya Sharma',
    customer_name: 'Rahul Mehta',
    customer_phone_masked: '****4321',
    customer_phone_withheld: false,
    started_at: '2026-11-16T10:00:00.000Z',
    ended_at: '2026-11-16T10:02:10.000Z',
    listened_seconds: 130,
    end_reason: 'listener_stopped',
    ...over,
  };
}
