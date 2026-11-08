// Report run and subscription rows for the report pipeline's unit tests.
import type {
  ReportRunRecord,
  ReportSubscriptionRecord,
} from '../../../../src/db/repositories/agency.repository.js';

export const TENANT = '11111111-1111-4111-8111-111111111111';
export const ACCOUNT = '22222222-2222-4222-8222-222222222222';
export const OTHER_ACCOUNT = '33333333-3333-4333-8333-333333333333';
export const RUN = '44444444-4444-4444-8444-444444444444';
export const AGENT = '55555555-5555-4555-8555-555555555555';
export const SUPERVISOR = '66666666-6666-4666-8666-666666666666';
export const CAMPAIGN = '77777777-7777-4777-8777-777777777777';
export const SUBSCRIPTION = '88888888-8888-4888-8888-888888888888';

export function runRecord(over: Partial<ReportRunRecord> = {}): ReportRunRecord {
  return {
    id: RUN,
    tenant_id: TENANT,
    account_id: ACCOUNT,
    kind: 'agent',
    subject_id: AGENT,
    campaign_ids: null,
    range_from: new Date('2026-10-01T00:00:00Z'),
    range_to: new Date('2026-11-01T00:00:00Z'),
    local_from: '2026-10-01',
    local_to: '2026-10-31',
    timezone: 'UTC',
    formats: ['pdf', 'xlsx'],
    audience: 'supervisor',
    requested_by: SUPERVISOR,
    email_me: false,
    subscription_id: null,
    period_start: null,
    status: 'queued',
    claim_generation: 1,
    claimed_at: null,
    render_attempt: 0,
    sent_at: null,
    dataset_key: null,
    detail_files: [],
    files: [],
    truncated: false,
    renderer_version: null,
    error_code: null,
    error_message: null,
    notified_at: null,
    created_at: new Date('2026-11-01T09:00:00Z'),
    finished_at: null,
    expires_at: null,
    ...over,
  };
}

export function subscriptionRecord(over: Partial<ReportSubscriptionRecord> = {}): ReportSubscriptionRecord {
  return {
    id: SUBSCRIPTION,
    tenant_id: TENANT,
    account_id: ACCOUNT,
    kind: 'campaign',
    subject_id: CAMPAIGN,
    cadence: 'daily',
    send_local_time: '08:00',
    send_weekday: null,
    send_monthday: null,
    timezone: 'Europe/London',
    formats: ['pdf'],
    recipient_user_ids: [SUPERVISOR],
    enabled: true,
    next_run_at: new Date('2026-11-05T08:00:00Z'),
    created_by: SUPERVISOR,
    created_at: new Date('2026-10-01T00:00:00Z'),
    updated_at: new Date('2026-10-01T00:00:00Z'),
    last_run: null,
    ...over,
  };
}
