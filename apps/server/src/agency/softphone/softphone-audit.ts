/**
 * The switch audit (SP7, docs/softphone.md §4.2, §6): `agency_session.softphone_started`
 * and `agency_session.softphone_ended` in `platform_audit_log`, written through these two
 * functions and nowhere else, so every way onto and off the `soft_phone` break of a
 * CAMPAIGN session records itself in one shape.
 *
 * - **Started**: the switch route, applied at once or queued (`queued`); and the queued
 *   switch actually applying when `releaseAgent` takes it off the break queue at the end
 *   of a call or wrap-up, or when pacing hands a reserved agent back (`queued: true,
 *   applied: true`, the `system` actor: nobody pressed anything at that instant).
 *   An idempotent re-switch while already on the soft phone (or with the switch already
 *   queued) writes nothing.
 * - **Ended**, with `via`: the return route (`return`), the campaign `available` route
 *   (`available`), a break with another reason (`break`, with `break_reason`), the
 *   supervisor's force-available (`force_available`); and a queued switch WITHDRAWN
 *   before it applied (`withdrawn: true`) by the return route (`return`) or by the
 *   station's ✕, `break/cancel` (`break_cancel`).
 *
 * The caller states the actor: the route's resolved user, or `SYSTEM_AUDIT_ACTOR`.
 */
import type { AgencyAgentState } from '@magick-agency/contracts/agency';
import { platformAuditLogger } from '../../audit/platform/audit-logger.js';
import type { AuditActorFields } from '../../audit/platform/audit-actor.js';

/** Which control took the session off the `soft_phone` break (or withdrew the queued switch). */
export type SoftphoneEndedVia = 'return' | 'available' | 'break' | 'force_available' | 'break_cancel';

interface SoftphoneSwitchAuditBase {
  tenantId: string;
  accountId: string | null;
  sessionId: string;
  campaignId: string;
  actor: AuditActorFields;
  /** The session's state when it happened. */
  fromState: AgencyAgentState | null;
}

export function auditSoftphoneStarted(
  input: SoftphoneSwitchAuditBase & { queued: boolean; applied?: boolean },
): void {
  platformAuditLogger.log({
    ...input.actor,
    tenant_id: input.tenantId,
    ...(input.accountId ? { account_id: input.accountId } : {}),
    action: 'agency_session.softphone_started',
    resource_type: 'agency_session',
    resource_id: input.sessionId,
    campaign_id: input.campaignId,
    details: {
      campaign_id: input.campaignId,
      from_state: input.fromState,
      queued: input.queued,
      ...(input.applied ? { applied: true } : {}),
    },
  });
}

export function auditSoftphoneEnded(
  input: SoftphoneSwitchAuditBase & { via: SoftphoneEndedVia; withdrawn: boolean; breakReason?: string },
): void {
  platformAuditLogger.log({
    ...input.actor,
    tenant_id: input.tenantId,
    ...(input.accountId ? { account_id: input.accountId } : {}),
    action: 'agency_session.softphone_ended',
    resource_type: 'agency_session',
    resource_id: input.sessionId,
    campaign_id: input.campaignId,
    details: {
      campaign_id: input.campaignId,
      from_state: input.fromState,
      withdrawn: input.withdrawn,
      via: input.via,
      ...(input.breakReason ? { break_reason: input.breakReason } : {}),
    },
  });
}
