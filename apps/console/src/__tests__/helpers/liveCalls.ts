import type { AgencyLiveCall } from '../../types/live-calls';

/** A call in progress for the live calls tests: a dialler call, recorded, listenable, nobody listening. */
export function liveCall(over: Partial<AgencyLiveCall> = {}): AgencyLiveCall {
  return {
    call_id: 'call-1',
    origin: 'campaign',
    campaign_id: 'camp-1',
    campaign_name: 'Renewals · Nov',
    inbound_route_name: null,
    agent_user_id: 'u-agent',
    agent_name: 'Priya Sharma',
    agent_session_id: 's-1',
    client_kind: 'web',
    customer_name: 'Rahul Mehta',
    customer_phone_masked: '****4321',
    connected_at: '2026-11-16T10:00:00Z',
    recording: true,
    listenable: true,
    not_listenable_reason: null,
    listeners: [],
    ...over,
  };
}
