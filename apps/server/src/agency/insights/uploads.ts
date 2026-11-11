/**
 * `GET …/insights/uploads`: the roster upload history, committed (non-dry-run) ingest jobs of any
 * status, newest first, at most `INSIGHTS_UPLOADS_LIMIT`. Part of `src/agency/insights/`
 * (docs/insights.md "API").
 *
 * `uploaded_by` is the job's `created_by` (the uploading user's id, `ingest.ts`), named from the
 * tenant's directory; a label that is not a user id is null. `duplicates` is the in-file breakdown
 * of `rejected` the job counts (accepted + rejected = rows read). `dedupe_columns` empty = phone.
 */
import type { AgencyInsightsUploads } from '@magick-agency/contracts/api/agency/insights';
import type { AgencyCampaignRecord } from '../../db/models/agency.model.js';
import { agencyInsightsReadRepository } from '../../db/repositories/agency.repository.js';
import { agentNamesOrNone } from '../agency-agent-identity.js';
import { actorOf, iso, userIdOf } from './shared.js';

function reasonCounts(raw: Record<string, unknown> | null): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw ?? {})) {
    const n = Number(v);
    if (Number.isFinite(n)) out[k] = n;
  }
  return out;
}

export async function computeUploads(campaign: Pick<AgencyCampaignRecord, 'id' | 'tenant_id'>): Promise<AgencyInsightsUploads> {
  const rows = await agencyInsightsReadRepository.listUploads(campaign.tenant_id, campaign.id);
  const names = await agentNamesOrNone(rows.map((r) => userIdOf(r.created_by)), campaign.tenant_id, 'insights');
  return {
    campaign_id: campaign.id,
    uploads: rows.map((r) => ({
      job_id: r.id,
      file_name: r.file_name,
      uploaded_by: actorOf(userIdOf(r.created_by), names),
      created_at: iso(r.created_at)!,
      finished_at: iso(r.finished_at),
      status: r.status,
      mode: r.mode,
      rows_read: r.rows_read,
      accepted: r.accepted,
      rejected: r.rejected,
      rejected_by_reason: reasonCounts(r.rejected_by_reason),
      duplicates: r.duplicates,
      dedupe_columns: r.dedupe_columns,
      has_rejected_export: r.has_rejected_export,
    })),
    generated_at: new Date().toISOString(),
  };
}
