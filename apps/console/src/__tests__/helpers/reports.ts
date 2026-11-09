import type { AgencyReportRun, AgencyReportSubscription } from '@magick-agency/contracts/api/agency/reports';
import type { TenantMember } from '../../types/team';

/** Report wire fixtures, shaped as the contract (`packages/contracts/src/api/agency/reports.ts`). */

export function reportRun(over: Partial<AgencyReportRun> = {}): AgencyReportRun {
  const status = over.status ?? 'ready';
  return {
    id: 'run-1',
    kind: 'agent',
    subject: { id: 'agent-1', name: 'Priya S' },
    account_id: 'account-1',
    range: { from: '2026-10-09', to: '2026-11-07', timezone: 'Asia/Kolkata' },
    formats: ['pdf', 'xlsx'],
    audience: 'supervisor',
    status,
    requested_by: { user_id: 'sup-1', name: 'Asha Supervisor' },
    subscription_id: null,
    created_at: '2026-11-08T04:00:00.000Z',
    finished_at: status === 'ready' || status === 'failed' ? '2026-11-08T04:01:30.000Z' : null,
    expires_at: status === 'ready' ? '2027-02-06T04:01:30.000Z' : null,
    files:
      status === 'ready'
        ? [
            { format: 'pdf', bytes: 2_516_582 },
            { format: 'xlsx', bytes: 849_920 },
          ]
        : [],
    truncated: false,
    error: status === 'failed' ? { code: 'render_failed', message: 'Rendering failed' } : null,
    ...over,
  };
}

export function reportSubscription(over: Partial<AgencyReportSubscription> = {}): AgencyReportSubscription {
  return {
    id: 'sub-1',
    kind: 'campaign',
    subject: { id: 'camp-1', name: 'October dues' },
    account_id: 'account-1',
    cadence: 'weekly',
    send_local_time: '08:30',
    send_weekday: 1,
    send_monthday: null,
    timezone: 'Asia/Kolkata',
    formats: ['pdf', 'xlsx'],
    recipients: [
      { user_id: 'sup-1', name: 'Asha Supervisor' },
      { user_id: 'sup-2', name: 'Ravi Admin' },
    ],
    enabled: true,
    next_run_at: '2026-11-09T03:00:00.000Z',
    last_run: { id: 'run-9', status: 'ready', period_start: '2026-10-26' },
    created_by: { user_id: 'sup-1', name: 'Asha Supervisor' },
    created_at: '2026-10-01T00:00:00.000Z',
    ...over,
  };
}

let memberSeq = 0;

/** A tenant member on `accountId` (null for tenant-wide) with `role`. */
export function member(
  role: TenantMember['membership']['role'],
  name: string,
  over: { userId?: string; accountId?: string | null; status?: 'active' | 'inactive' | 'revoked' } = {},
): TenantMember {
  memberSeq += 1;
  const userId = over.userId ?? `user-${memberSeq}`;
  return {
    membership: {
      id: `m-${memberSeq}`,
      user_id: userId,
      tenant_id: 'tenant-1',
      account_id: over.accountId === undefined ? 'account-1' : over.accountId,
      role,
      status: over.status ?? 'active',
      invited_by: null,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
      invite_state: 'active',
    },
    user: {
      id: userId,
      firebase_uid: `fb-${userId}`,
      email: `${userId}@example.com`,
      display_name: name,
      avatar_url: null,
      status: 'active',
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    },
  };
}
