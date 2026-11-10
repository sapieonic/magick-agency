import type { AgencyInboundCall, AgencyInboundQueueTile } from '../../types/inbound';

/**
 * Inbound call fixtures (P2): the panel's row as the `inbound_call` frame and the call routes
 * carry it, and the supervisor's queue tile. Overrides replace whole fields.
 */

export const OFFERED_AT = '2026-11-09T10:00:00.000Z';

export const MATCH: NonNullable<AgencyInboundCall['match']> = {
  contact_id: 'ct-1',
  campaign_id: 'camp-2',
  campaign_name: 'Card Renewals',
  contact_state: 'pending',
  context: { name: 'Asha Rao', policy_number: 'P-778', city: 'Pune' },
  context_display: { hero: ['name', 'policy_number'] },
  prior_attempts: [
    {
      attempt_number: 1,
      outcome: 'no_answer',
      disposition_code: null,
      notes: 'Asked to ring after six',
      ended_at: '2026-11-08T09:00:30.000Z',
      campaign_id: 'camp-2',
      campaign_name: 'Card Renewals',
      dialed_at: '2026-11-08T09:00:00.000Z',
    },
  ],
};

export const CATALOG: AgencyInboundCall['disposition_catalog'] = [
  { code: 'resolved', label: 'Resolved' },
  { code: 'callback', label: 'Call back', requires_datetime: true },
  { code: 'complaint', label: 'Complaint', requires_note: true },
];

export function inboundCall(over: Partial<AgencyInboundCall> = {}): AgencyInboundCall {
  return {
    id: 'ib-1',
    session_id: 'sess-1',
    state: 'offered',
    outcome: null,
    from_e164: '+919820461733',
    to_e164: '+912248908888',
    route: { id: 'r-1', name: 'Customer care' },
    caller_dnc: false,
    sticky: { reason: 'last_connected', is_you: true },
    match: MATCH,
    catalog_source: 'campaign',
    disposition_catalog: CATALOG,
    recording: true,
    waited_seconds: 42,
    offered_at: OFFERED_AT,
    connects_at: '2026-11-09T10:00:01.500Z',
    bridged_at: null,
    ended_at: null,
    talk_seconds: null,
    outcome_due_at: null,
    disposition_code: null,
    notes: null,
    callback_at: null,
    dispositioned_by_user_id: null,
    dispositioned_on_behalf: false,
    settled_at: null,
    ...over,
  };
}

/** The same call, connected at `at`. */
export function connected(over: Partial<AgencyInboundCall> = {}, at = '2026-11-09T10:00:01.500Z'): AgencyInboundCall {
  return inboundCall({ state: 'connected', connects_at: null, bridged_at: at, ...over });
}

/** The same call, ended after it was answered, owing its outcome. */
export function owing(over: Partial<AgencyInboundCall> = {}): AgencyInboundCall {
  return inboundCall({
    state: 'ended',
    outcome: 'answered',
    connects_at: null,
    bridged_at: '2026-11-09T10:00:01.500Z',
    ended_at: '2026-11-09T10:03:00.000Z',
    talk_seconds: 178,
    outcome_due_at: '2026-11-09T10:33:00.000Z',
    ...over,
  });
}

export function queueTile(over: Partial<AgencyInboundQueueTile> = {}): AgencyInboundQueueTile {
  return {
    route_id: 'r-1',
    route_name: 'Customer care',
    open_now: true,
    waiting: 2,
    longest_wait_seconds: 75,
    connected: 3,
    eligible_agents: 1,
    no_agents_available: false,
    ...over,
  };
}
