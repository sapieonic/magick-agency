/**
 * The pacing leader's two owner sweeps, for one running `strict` or `preferred` campaign:
 *
 *  - {@link sweepUnstaffedOwners} (CA6's catch-up): with `on_unstaff = 'return_to_pool'`, a
 *    `pending` contact whose owner has no active staffing row on the campaign goes to the pool
 *    (one `agency_contacts.unassigned_on_unstaff` row per batch, the system actor);
 *  - {@link sweepCallbackFallback} (CA5), below.
 *
 * The callback grace/fallback (contact assignment, CA5): a due callback whose owner has no live session on the campaign waits
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
import { agencyAssignmentRepository, agencyContactRepository } from '../../db/repositories/agency.repository.js';
import { callbackCodes } from '../../db/repositories/agency/assignment-sql.js';
import { platformAuditLogger } from '../../audit/platform/audit-logger.js';
import { SYSTEM_AUDIT_ACTOR } from '../../audit/platform/audit-actor.js';
import type { PlatformAuditAction } from '../../audit/platform/catalog.js';
import { ownerModeOf } from './agent-queue.js';

const log = createChildLogger({ component: 'agency-callback-fallback' });

/** How often the leader sweeps one campaign. The grace is in minutes; this is its resolution. */
export const CALLBACK_FALLBACK_SWEEP_MS = 30_000;

/** The most callbacks one sweep moves; the rest go on the next sweep. */
export const CALLBACK_FALLBACK_BATCH_LIMIT = 1_000;

/**
 * Whether {@link sweepCallbackFallback} applies to this campaign: running, owner mode, and
 * `callback_fallback = 'pool'`.
 */
export function callbackFallbackApplies(campaign: AgencyCampaignRecord): boolean {
  return campaign.status === 'running' && ownerModeOf(campaign) !== null && campaign.callback_fallback === 'pool';
}

/**
 * Whether {@link sweepUnstaffedOwners} applies to this campaign: running, owner mode, and
 * `on_unstaff = 'return_to_pool'`.
 */
export function unstaffedOwnersSweepApplies(campaign: AgencyCampaignRecord): boolean {
  return campaign.status === 'running' && ownerModeOf(campaign) !== null && campaign.on_unstaff === 'return_to_pool';
}

/**
 * One owner sweep's batch: `move` takes contacts to the pool under a fresh batch id; when any
 * moved, the batch gets one `platform_audit_log` row (the system actor) whose `details` are the
 * batch id followed by `details(moved, perAgent)`. Returns how many moved.
 */
async function returnBatchToPool(
  campaign: AgencyCampaignRecord,
  action: PlatformAuditAction,
  move: (batchId: string) => Promise<readonly { fromUserId: string }[]>,
  details: (moved: number, perAgent: Record<string, number>) => Record<string, unknown>,
  message: string,
): Promise<number> {
  const batchId = randomUUID();
  const moves = await move(batchId);
  if (moves.length === 0) return 0;
  const perAgent: Record<string, number> = {};
  for (const m of moves) perAgent[m.fromUserId] = (perAgent[m.fromUserId] ?? 0) + 1;
  platformAuditLogger.log({
    ...SYSTEM_AUDIT_ACTOR,
    tenant_id: campaign.tenant_id,
    account_id: campaign.account_id,
    action,
    resource_type: 'agency_campaign',
    resource_id: campaign.id,
    campaign_id: campaign.id,
    details: { batch_id: batchId, ...details(moves.length, perAgent) },
  });
  log.info({ campaignId: campaign.id, batchId, moved: moves.length }, message);
  return moves.length;
}

/**
 * Sweep one campaign. Returns how many callbacks went to the pool (0 for a `pool` campaign,
 * `wait`, or a campaign that is not running).
 */
export async function sweepCallbackFallback(campaign: AgencyCampaignRecord): Promise<number> {
  if (!callbackFallbackApplies(campaign)) return 0;
  // No early return for a catalog with no callback codes: an inbound callback
  // (`callback_source`, docs/inbound.md §7) is a callback on any campaign, and falls back too.
  // Such a pick reads only the campaign's inbound callbacks (`idx_agency_contacts_inbound_callback`):
  // a probe of an empty index on a tenant with no inbound.
  const codes = callbackCodes(campaign.disposition_catalog);
  return returnBatchToPool(
    campaign,
    'agency_contacts.callback_fallback',
    (batchId) => agencyContactRepository.fallBackOverdueCallbacks({
      campaignId: campaign.id,
      graceMinutes: campaign.callback_owner_grace_minutes,
      callbackCodes: codes,
      batchId,
      limit: CALLBACK_FALLBACK_BATCH_LIMIT,
    }),
    (moved, perAgent) => ({ moved, grace_minutes: campaign.callback_owner_grace_minutes, per_agent: perAgent }),
    'Overdue callbacks whose owner is not on the campaign went to the pool',
  );
}

/** The most contacts one unstaffed-owner sweep moves; the rest go on the next sweep. */
export const UNSTAFFED_RETURN_BATCH_LIMIT = 1_000;

/**
 * CA6's catch-up, one campaign: a `pending` contact owned by an agent with no active staffing
 * row on the campaign goes to the pool (`AgencyAssignmentRepository.returnUnstaffedOwners`).
 * The unstaff itself moves only what is `pending` at that moment; this returns what was on a
 * call then and settled since, a callback booked by an unstaffed agent whose session was still
 * open, and anything the unstaff statement missed. Returns how many moved (0 for a `pool`
 * campaign, `keep`, or a campaign that is not running).
 */
export async function sweepUnstaffedOwners(campaign: AgencyCampaignRecord): Promise<number> {
  if (!unstaffedOwnersSweepApplies(campaign)) return 0;
  return returnBatchToPool(
    campaign,
    'agency_contacts.unassigned_on_unstaff',
    (batchId) => agencyAssignmentRepository.returnUnstaffedOwners({
      campaignId: campaign.id, batchId, limit: UNSTAFFED_RETURN_BATCH_LIMIT,
    }),
    (moved, perAgent) => ({ on_unstaff: 'return_to_pool', moved, per_agent: perAgent, cause: 'sweep' }),
    'Open contacts of agents no longer staffed on the campaign went to the pool',
  );
}
