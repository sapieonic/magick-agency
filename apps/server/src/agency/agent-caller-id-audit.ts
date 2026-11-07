/**
 * The dedicated caller ID audit rows (DN10): `agency_campaign.agent_caller_id_set` and
 * `_cleared`, filed on the campaign under its account, with ids and the number only. One
 * envelope for the PUT, the DELETE and the release on unstaff.
 */
import {
  AGENCY_AGENT_CALLER_ID_AUDIT_ACTIONS,
  type AgencyAgentCallerIdClearCause,
} from '@magick-agency/contracts/api/agency/agent-caller-id';
import { platformAuditLogger } from '../audit/platform/audit-logger.js';
import type { AuditActorFields } from '../audit/platform/audit-actor.js';

interface AgentCallerIdAuditScope {
  tenantId: string;
  /** The campaign's account. */
  accountId: string;
  actor: AuditActorFields;
  campaignId: string;
  userId: string;
  callerId: string;
}

function auditAgentCallerId(
  action: (typeof AGENCY_AGENT_CALLER_ID_AUDIT_ACTIONS)[keyof typeof AGENCY_AGENT_CALLER_ID_AUDIT_ACTIONS],
  scope: AgentCallerIdAuditScope,
  extra: Record<string, unknown>,
): void {
  const { actor } = scope;
  platformAuditLogger.log({
    tenant_id: scope.tenantId,
    account_id: scope.accountId,
    ...actor,
    action,
    resource_type: 'agency_campaign',
    resource_id: scope.campaignId,
    campaign_id: scope.campaignId,
    details: { campaign_id: scope.campaignId, user_id: scope.userId, caller_id: scope.callerId, ...extra },
  });
}

/** A number dedicated (or replaced): `previous_caller_id` is the one it replaced, or null. */
export function auditAgentCallerIdSet(scope: AgentCallerIdAuditScope, previousCallerId: string | null): void {
  auditAgentCallerId(AGENCY_AGENT_CALLER_ID_AUDIT_ACTIONS.set, scope, { previous_caller_id: previousCallerId });
}

/** A number released, by a supervisor or by the agent's unstaff (with its extra details). */
export function auditAgentCallerIdCleared(
  scope: AgentCallerIdAuditScope,
  cause: AgencyAgentCallerIdClearCause,
  extra: Record<string, unknown> = {},
): void {
  auditAgentCallerId(AGENCY_AGENT_CALLER_ID_AUDIT_ACTIONS.cleared, scope, { cause, ...extra });
}
