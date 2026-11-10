import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ auditLog: vi.fn() }));
vi.mock('../../../src/audit/platform/audit-logger.js', () => ({ platformAuditLogger: { log: mocks.auditLog } }));

const {
  auditRosterUploadEnded,
  auditRosterUploadEndedById,
  auditRosterUploadStarted,
} = await import('../../../src/agency/agency-ingest-audit.js');
type Job = Parameters<typeof auditRosterUploadEnded>[0];

/** The roster upload's activity rows (IN8). */
function job(over: Partial<Job> = {}): Job {
  return {
    id: 'job-1', tenant_id: 't-1', account_id: 'a-1', campaign_id: 'c-1',
    file_name: 'roster.csv', dry_run: false, mode: 'append', dedupe_phones: true, dedupe_columns: null,
    status: 'completed', rows_read: '10', accepted: '8', rejected: '2', duplicates: '1',
    error_code: null, replace_superseded_contacts: null,
    ...over,
  } as Job;
}

const actions = () => mocks.auditLog.mock.calls.map(([row]) => (row as { action: string }).action);

beforeEach(() => vi.clearAllMocks());

describe('roster upload rows', () => {
  it('a dry run, or a job with no campaign, writes neither row', () => {
    auditRosterUploadStarted(job({ dry_run: true }), { actor_type: 'human', user_id: 'u-1' });
    auditRosterUploadStarted(job({ campaign_id: null }), { actor_type: 'human', user_id: 'u-1' });
    auditRosterUploadEnded(job({ dry_run: true }));
    auditRosterUploadEnded(job({ campaign_id: null }));
    expect(mocks.auditLog).not.toHaveBeenCalled();
  });

  it('maps the terminal status to completed or failed, cancelled to failed', () => {
    auditRosterUploadEnded(job());
    auditRosterUploadEnded(job({ status: 'failed', error_code: 'dnc_unavailable' }));
    auditRosterUploadEnded(job({ status: 'cancelled' }));
    expect(actions()).toEqual([
      'agency_campaign.roster_upload_completed',
      'agency_campaign.roster_upload_failed',
      'agency_campaign.roster_upload_failed',
    ]);
    const cancelled = mocks.auditLog.mock.calls[2]![0] as { actor_type: string; details: Record<string, unknown> };
    expect(cancelled.actor_type).toBe('system');
    expect(cancelled.details).toMatchObject({ status: 'cancelled', rows_read: 10, accepted: 8, rejected: 2, duplicates: 1 });
    expect(cancelled.details).not.toHaveProperty('error_code');
  });

  it('a job that is not terminal writes nothing', () => {
    auditRosterUploadEnded(job({ status: 'running' }));
    expect(mocks.auditLog).not.toHaveBeenCalled();
  });

  it('carries how many contacts a replace retired', () => {
    auditRosterUploadEnded(job({ mode: 'replace', status: 'failed', replace_superseded_contacts: '42' }));
    expect((mocks.auditLog.mock.calls[0]![0] as { details: Record<string, unknown> }).details)
      .toMatchObject({ mode: 'replace', replace_superseded_contacts: 42 });
  });

  it('never throws when the read back fails', async () => {
    await expect(auditRosterUploadEndedById(async () => { throw new Error('db down'); }, 'job-1')).resolves.toBeUndefined();
    expect(mocks.auditLog).not.toHaveBeenCalled();
  });
});
