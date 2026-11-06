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
 * the same actor; nothing where none was set.
 *
 * Never throws: it follows a staffing change that has already committed, and a failure
 * leaves contacts with a former agent (visible on the progress screen, reassignable), never
 * a wrong permission. A dedication left behind by a failure is used only for contacts the
 * former agent still owns (DN2), and a supervisor can clear it.
 */
import { createChildLogger } from '@magick-agency/observability';
import { AGENCY_AGENT_CALLER_ID_AUDIT_ACTIONS } from '@magick-agency/contracts/api/agency/agent-caller-id';
import { platformAuditLogger } from '../../audit/platform/audit-logger.js';
import type { AuditActorFields } from '../../audit/platform/audit-actor.js';
import { agencyAssignmentRepository, type UnstaffReturn } from '../../db/repositories/agency.repository.js';

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
      platformAuditLogger.log({
        tenant_id: input.tenantId,
        account_id: r.account_id,
        ...input.actor,
        action: AGENCY_AGENT_CALLER_ID_AUDIT_ACTIONS.cleared,
        resource_type: 'agency_campaign',
        resource_id: r.campaign_id,
        campaign_id: r.campaign_id,
        details: {
          campaign_id: r.campaign_id,
          user_id: input.userId,
          caller_id: r.released_caller_id,
          cause: 'unstaff',
          unstaff_cause: input.cause,
          ...(input.details ?? {}),
        },
      });
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
