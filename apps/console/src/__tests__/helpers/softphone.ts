import type {
  AgencyManualCall,
  AgencySoftphoneBootstrap,
  AgencySoftphoneCampaign,
} from '../../types/softphone';

/**
 * Fixtures for the soft phone's tests: one manual call (overridable), one
 * taggable campaign, and the bootstrap around them.
 */

export const CAMPAIGN: AgencySoftphoneCampaign = {
  campaign_id: 'camp-1',
  campaign_name: 'Home Loan Renewals',
  status: 'running',
  caller_ids: ['+912248901120', '+912248901121'],
  disposition_catalog: [
    { code: 'interested', label: 'Interested, renewing', is_success: true },
    { code: 'callback', label: 'Callback requested', requires_datetime: true },
    { code: 'documents', label: 'Needs documents', requires_note: true },
    { code: 'do_not_call', label: 'Do not call', suppress: true },
  ],
  calling_window: { start: '09:00', end: '20:00', days: [1, 2, 3, 4, 5], timezone: 'Asia/Kolkata' },
  calling_window_open: true,
  record_calls: true,
  analysis_profile: { id: 'prof-1', name: 'Renewals v3' },
  context_display: { hero: ['Name', 'Loan account'] },
};

export const BOOTSTRAP: AgencySoftphoneBootstrap = {
  softphone_enabled: true,
  call_campaign: null,
  taggable_campaigns: [CAMPAIGN],
  untagged: {
    caller_ids: ['+912248909999', '+912248908888'],
    default_caller_id: '+912248908888',
    disposition_catalog: [
      { code: 'resolved', label: 'Query resolved', is_success: true },
      { code: 'wrong_number', label: 'Wrong number' },
      { code: 'callback', label: 'Callback requested', requires_datetime: true },
    ],
    record_calls: false,
    analysis_profile: null,
  },
  call_fields: [
    { key: 'customer_name', label: 'Customer name', type: 'text', required: true },
    { key: 'reason', label: 'Reason for call', type: 'choice', options: ['Rate query', 'Documents'], required: true },
    { key: 'follow_up', label: 'Follow-up needed', type: 'boolean' },
  ],
  default_country_code: '+91',
  session: null,
  call: null,
};

export function manualCall(over: Partial<AgencyManualCall> = {}): AgencyManualCall {
  return {
    id: 'mc-1',
    session_id: 'sess-sp',
    agent_user_id: 'u-1',
    agent_name: null,
    destination_e164: '+919820461733',
    caller_id: '+912248908888',
    tag: null,
    contact: null,
    state: 'queued',
    outcome: null,
    end_reason: null,
    recording_requested: false,
    dnc_overridden: false,
    hours_overridden: false,
    requires_disposition: false,
    outcome_due_at: null,
    disposition_code: null,
    disposition_source: null,
    notes: null,
    callback_at: null,
    fields: {},
    dispositioned_by_user_id: null,
    dispositioned_at: null,
    dispositioned_on_behalf: false,
    webrtc_call_id: null,
    dialed_at: '2026-10-30T10:00:00.000Z',
    answered_at: null,
    bridged_at: null,
    ended_at: null,
    talk_seconds: null,
    settled_at: null,
    created_at: '2026-10-30T10:00:00.000Z',
    updated_at: '2026-10-30T10:00:00.000Z',
    ...over,
  };
}

/** The call one step on: `updated_at` moves with every state, as the server's does. */
export function step(call: AgencyManualCall, seconds: number, over: Partial<AgencyManualCall>): AgencyManualCall {
  const at = new Date(Date.parse(call.created_at) + seconds * 1000).toISOString();
  return { ...call, updated_at: at, ...over };
}
