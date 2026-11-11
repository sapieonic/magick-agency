/**
 * The roster upload's activity rows (IN8), in `platform_audit_log`, written through these
 * functions and nowhere else so every upload records itself in one shape:
 *
 * - `agency_campaign.roster_upload_started`: a COMMITTED upload job was created (never a
 *   dry run: a preview writes no roster). The uploader is the actor; `details` carry the
 *   job, the file name, the mode and the duplicate rule (`dedupe_columns`, the key's
 *   columns in order; null = phone, or none when `dedupe_phones` is false). Rows written
 *   before 0031 carry a single `dedupe_column` instead.
 * - `agency_campaign.roster_upload_completed` / `agency_campaign.roster_upload_failed`:
 *   the job reached a terminal state, read back from the job row once the run has ended,
 *   so every terminal branch of the ingest is covered by one write; a job the stale-job
 *   reaper fails (`reapStaleJobs`, its run gone with a restart) is written by the reap from
 *   the rows it failed (`error_code: 'interrupted'`). `failed` also covers
 *   `cancelled` (`details.status` says which). The `system` actor: the background run, not
 *   a person, ended it; the started row names who began it.
 * - `agency_campaign.roster_cleared`: the roster-clear route retired the roster (or could
 *   not confirm whether it had).
 *
 * Every write is best effort and never throws: the import has already happened (or not),
 * and an audit failure must not change that or the answer the operator gets.
 */
import { createChildLogger } from '@magick-agency/observability';
import { platformAuditLogger } from '../audit/platform/audit-logger.js';
import { SYSTEM_AUDIT_ACTOR, type AuditActorFields } from '../audit/platform/audit-actor.js';
import type { AgencyIngestJobRecord } from './agency-ingest-job.repository.js';

const log = createChildLogger({ component: 'agency-ingest-audit' });

/** The started row. A dry run, or a job with no campaign, writes nothing. */
export function auditRosterUploadStarted(job: AgencyIngestJobRecord, actor: AuditActorFields): void {
  if (job.dry_run || !job.campaign_id) return;
  platformAuditLogger.log({
    ...actor,
    tenant_id: job.tenant_id,
    ...(job.account_id ? { account_id: job.account_id } : {}),
    action: 'agency_campaign.roster_upload_started',
    resource_type: 'agency_campaign',
    resource_id: job.campaign_id,
    campaign_id: job.campaign_id,
    details: {
      campaign_id: job.campaign_id,
      job_id: job.id,
      file_name: job.file_name,
      mode: job.mode ?? 'append',
      dedupe_columns: job.dedupe_columns?.length ? job.dedupe_columns : null,
      dedupe_phones: job.dedupe_phones,
    },
  });
}

/**
 * The terminal row, from the job as it ended. Nothing for a dry run, a job with no
 * campaign, or one not yet terminal (which cannot happen once `run` has returned, but a
 * row claiming an end that did not happen would be worse than none).
 */
export function auditRosterUploadEnded(job: AgencyIngestJobRecord): void {
  try {
    writeRosterUploadEnded(job);
  } catch (err) {
    log.warn({ err, jobId: job.id }, 'Could not record the roster upload outcome in the activity log');
  }
}

function writeRosterUploadEnded(job: AgencyIngestJobRecord): void {
  if (job.dry_run || !job.campaign_id) return;
  if (job.status !== 'completed' && job.status !== 'failed' && job.status !== 'cancelled') return;
  platformAuditLogger.log({
    ...SYSTEM_AUDIT_ACTOR,
    tenant_id: job.tenant_id,
    ...(job.account_id ? { account_id: job.account_id } : {}),
    action: job.status === 'completed'
      ? 'agency_campaign.roster_upload_completed'
      : 'agency_campaign.roster_upload_failed',
    resource_type: 'agency_campaign',
    resource_id: job.campaign_id,
    campaign_id: job.campaign_id,
    details: {
      campaign_id: job.campaign_id,
      job_id: job.id,
      file_name: job.file_name,
      mode: job.mode ?? 'append',
      status: job.status,
      // accepted + rejected = rows_read; duplicates is a breakdown of rejected.
      rows_read: Number(job.rows_read),
      accepted: Number(job.accepted),
      rejected: Number(job.rejected),
      duplicates: Number(job.duplicates),
      ...(job.error_code ? { error_code: job.error_code } : {}),
      ...(job.replace_superseded_contacts !== null && job.replace_superseded_contacts !== undefined
        ? { replace_superseded_contacts: Number(job.replace_superseded_contacts) }
        : {}),
    },
  });
}

/** Read the job back after its run ended and write the terminal row. Never throws. */
export async function auditRosterUploadEndedById(
  read: () => Promise<AgencyIngestJobRecord | null>,
  jobId: string,
): Promise<void> {
  try {
    const job = await read();
    if (job) auditRosterUploadEnded(job);
  } catch (err) {
    log.warn({ err, jobId }, 'Could not record the roster upload outcome in the activity log');
  }
}

/** The roster-clear route's row: `cleared` is the count retired, null when unconfirmed. */
export function auditRosterCleared(input: {
  tenantId: string;
  accountId: string | null;
  campaignId: string;
  actor: AuditActorFields;
  rosterState: 'cleared' | 'unconfirmed';
  cleared: number | null;
  alreadyApplied?: boolean;
}): void {
  platformAuditLogger.log({
    ...input.actor,
    tenant_id: input.tenantId,
    ...(input.accountId ? { account_id: input.accountId } : {}),
    action: 'agency_campaign.roster_cleared',
    resource_type: 'agency_campaign',
    resource_id: input.campaignId,
    campaign_id: input.campaignId,
    details: {
      campaign_id: input.campaignId,
      roster_state: input.rosterState,
      cleared: input.cleared,
      ...(input.alreadyApplied ? { already_applied: true } : {}),
    },
  });
}
