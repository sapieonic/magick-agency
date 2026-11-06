/**
 * CA6, on every unstaff path: when an agent's staffing on campaigns closes (a supervisor's
 * DELETE, an offboarding through the team routes, a super admin's membership change), their
 * `pending` contacts on each campaign whose `on_unstaff` is `return_to_pool` go back to the
 * pool (history reason `unstaffed`); on `keep` nothing moves. Contacts on a call never move.
 *
 * One audit row (`agency_contacts.unassigned_on_unstaff`) per campaign where the agent held
 * an open contact or one on a call, filed under the CAMPAIGN's account so the account's
 * supervisors see it: `moved`, `skipped_live`, and `kept: true` with `kept_open` on a `keep`
 * campaign. A campaign where they held nothing writes nothing (most campaigns never use
 * assignment, and an unstaff there is already audited as `agency_campaign_agent.unassigned`).
 *
 * The same statement releases the number dedicated to the agent on each of those campaigns,
 * whatever its `on_unstaff` (DN7): one `agency_campaign.agent_caller_id_cleared` row
 * (`cause: 'unstaff'`) per campaign where one was released, under the campaign's account, with
 * the same actor; nothing where none was set. A campaign the agent has been staffed on again
 * by the time it runs keeps its row (see `returnOnUnstaff`).
 *
 * Never throws: it follows a staffing change that has already committed, and a failure
 * leaves contacts with a former agent (visible on the progress screen, reassignable), never
 * a wrong permission. A dedication left behind by a failure is never used: it stopped counting
 * when the staffing closed (`EFFECTIVE_DEDICATION_SQL`, DN1), so it is not dialled, listed or
 * guarded, does not revive if the agent is staffed again, and is replaced by the next PUT or
 * deleted by the next unstaff's release.
 */
import { createChildLogger } from '@magick-agency/observability';
import { platformAuditLogger } from '../../audit/platform/audit-logger.js';
import type { AuditActorFields } from '../../audit/platform/audit-actor.js';
import { agencyAssignmentRepository, type UnstaffReturn } from '../../db/repositories/agency.repository.js';
import { auditAgentCallerIdCleared } from '../agent-caller-id-audit.js';

const log = createChildLogger({ component: 'agency-assignment-unstaff' });

export type UnstaffCause = 'unstaffed' | 'membership_removed' | 'role_changed_from_agent';

export async function returnContactsOnUnstaff(input: {
  tenantId: string;
  userId: string;
  campaignIds: readonly string[];
  /** The history rows' actor: the supervisor who unstaffed, or null (a membership change). */
  eventActorUserId: string | null;
  /** The audit rows' actor. */
  actor: AuditActorFields;
  cause: UnstaffCause;
  /** Extra audit details (e.g. `{ via: 'super_admin' }`). */
  details?: Record<string, unknown>;
}): Promise<UnstaffReturn[]> {
  const campaignIds = [...new Set(input.campaignIds)];
  if (campaignIds.length === 0) return [];
  let rows: UnstaffReturn[];
  try {
    rows = await agencyAssignmentRepository.returnOnUnstaff({
      tenantId: input.tenantId,
      userId: input.userId,
      campaignIds,
      actorUserId: input.eventActorUserId,
    });
  } catch (err) {
    log.error(
      { tenantId: input.tenantId, userId: input.userId, campaigns: campaignIds.length, cause: input.cause,
        err: err instanceof Error ? err.message : String(err) },
      'Could not return an unstaffed agent\'s contacts to the pool; the staffing change stands',
    );
    return [];
  }
  for (const r of rows) {
    if (r.released_caller_id !== null) {
      auditAgentCallerIdCleared(
        { tenantId: input.tenantId, accountId: r.account_id, actor: input.actor, campaignId: r.campaign_id,
          userId: input.userId, callerId: r.released_caller_id },
        'unstaff',
        { unstaff_cause: input.cause, ...(input.details ?? {}) },
      );
    }
    if (!r.held) continue;
    platformAuditLogger.log({
      tenant_id: input.tenantId,
      account_id: r.account_id,
      ...input.actor,
      action: 'agency_contacts.unassigned_on_unstaff',
      resource_type: 'agency_campaign',
      resource_id: r.campaign_id,
      campaign_id: r.campaign_id,
      details: {
        batch_id: r.batch_id,
        user_id: input.userId,
        on_unstaff: r.on_unstaff,
        moved: r.moved,
        skipped_live: r.skipped_live,
        kept: r.on_unstaff === 'keep',
        kept_open: r.kept,
        cause: input.cause,
        ...(input.details ?? {}),
      },
    });
  }
  if (rows.length > 0) {
    log.info(
      { tenantId: input.tenantId, userId: input.userId, cause: input.cause,
        moved: rows.reduce((s, r) => s + r.moved, 0), campaigns: rows.length,
        callerIdsReleased: rows.filter((r) => r.released_caller_id !== null).length },
      'Unstaffed agent\'s contacts handled per campaign on_unstaff',
    );
  }
  return rows;
}
