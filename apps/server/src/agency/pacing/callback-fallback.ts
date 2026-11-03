/**
 * The callback grace/fallback (contact assignment, D5), for one `strict` or `preferred`
 * campaign: a due callback whose owner has no live session on the campaign waits
 * `callback_owner_grace_minutes`; then, with `callback_fallback = 'pool'`, it loses its owner
 * (`AgencyContactRepository.fallBackOverdueCallbacks`: the move and one history row per contact
 * in one statement, under one batch id) and the batch gets one `platform_audit_log` row
 * (`agency_contacts.callback_fallback`, the system actor). `wait` moves nothing.
 *
 * In `preferred` mode a fallen-back callback is claimable by any agent from the pool; in
 * `strict` mode it is an unassigned open contact, never dialled until a supervisor assigns it
 * (and it holds the campaign open, as every open contact does).
 *
 * Run by the campaign's pacing leader ({@link PacingEngine}), throttled per campaign: the
 * leader is the one writer per campaign (its lease), it already holds the campaign row the
 * sweep reads, and a running owner-mode campaign is exactly what it leads.
 */
import { randomUUID } from 'node:crypto';
import { createChildLogger } from '@magick-agency/observability';
import type { AgencyCampaignRecord } from '../../db/models/agency.model.js';
import { agencyContactRepository } from '../../db/repositories/agency.repository.js';
import { callbackCodes } from '../../db/repositories/agency/assignment-sql.js';
import { platformAuditLogger } from '../../audit/platform/audit-logger.js';
import { SYSTEM_AUDIT_ACTOR } from '../../audit/platform/audit-actor.js';
import { ownerModeOf } from './agent-queue.js';

const log = createChildLogger({ component: 'agency-callback-fallback' });

/** How often the leader sweeps one campaign. The grace is in minutes; this is its resolution. */
export const CALLBACK_FALLBACK_SWEEP_MS = 30_000;

/** The most callbacks one sweep moves; the rest go on the next sweep. */
export const CALLBACK_FALLBACK_BATCH_LIMIT = 1_000;

/**
 * Sweep one campaign. Returns how many callbacks went to the pool (0 for a `pool` campaign,
 * `wait`, or a campaign that is not running).
 */
export async function sweepCallbackFallback(campaign: AgencyCampaignRecord): Promise<number> {
  if (campaign.status !== 'running' || !ownerModeOf(campaign) || campaign.callback_fallback !== 'pool') return 0;
  const codes = callbackCodes(campaign.disposition_catalog);
  if (codes.length === 0) return 0;
  const batchId = randomUUID();
  const moves = await agencyContactRepository.fallBackOverdueCallbacks({
    campaignId: campaign.id,
    graceMinutes: campaign.callback_owner_grace_minutes,
    callbackCodes: codes,
    batchId,
    limit: CALLBACK_FALLBACK_BATCH_LIMIT,
  });
  if (moves.length === 0) return 0;
  const perAgent: Record<string, number> = {};
  for (const m of moves) perAgent[m.fromUserId] = (perAgent[m.fromUserId] ?? 0) + 1;
  platformAuditLogger.log({
    ...SYSTEM_AUDIT_ACTOR,
    tenant_id: campaign.tenant_id,
    account_id: campaign.account_id,
    action: 'agency_contacts.callback_fallback',
    resource_type: 'agency_campaign',
    resource_id: campaign.id,
    campaign_id: campaign.id,
    details: {
      batch_id: batchId,
      moved: moves.length,
      grace_minutes: campaign.callback_owner_grace_minutes,
      per_agent: perAgent,
    },
  });
  log.info({ campaignId: campaign.id, batchId, moved: moves.length },
    'Overdue callbacks whose owner is not on the campaign went to the pool');
  return moves.length;
}
