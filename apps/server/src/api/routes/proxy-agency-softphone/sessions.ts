/*
 * The soft phone's session routes: open the caller's soft-phone session, and switch a
 * campaign session to the soft phone and back (docs/softphone.md §2, §4.2). Part of
 * `proxy-agency-softphone.routes.ts`.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requirePermission } from '../../../rbac/rbac.middleware.js';
import { platformAuditLogger } from '../../../audit/platform/audit-logger.js';
import { resolvedUserAuditActor } from '../../../audit/platform/audit-actor.js';
import { callCore } from '../../core-dispatch.js';
import { parseOr400 } from '../helpers/parse-or-400.js';
import { stringField } from '../helpers/core-campaign.js';
import { rewriteStationWsUrl } from '../proxy-agency-station.routes.js';
import type { SoftphoneSwitchAudit } from '../agency/softphone-answer.js';
import { auditSoftphoneEnded, auditSoftphoneStarted } from '../../../agency/softphone/softphone-audit.js';
import {
  actorBody,
  requireSoftphoneEnabled,
  sendCoreRefusal,
  softphoneActorOrRefuse,
  softphoneAuditTenancy,
  unwrapCoreAnswer,
} from './shared.js';

/** No body: anything a client sends is stripped, the actor included. */
const emptyBody = z.object({}).strip();

export async function registerSoftphoneSessionRoutes(app: FastifyInstance): Promise<void> {
  const dial = [requirePermission('agency.softphone.dial'), requireSoftphoneEnabled];
  // The return to the campaign finishes work, so the flag never refuses it (`shared.ts`).
  const finish = [requirePermission('agency.softphone.dial')];

  /**
   * POST /proxy/agency/softphone/sessions — open (201) or rehydrate (200) the caller's
   * soft-phone session. 409 `session_on_campaign` (with the campaign session's id,
   * campaign and state) when the agent is live on a campaign: the remedy is the switch
   * on that session, never a second one. `station_ws_url` is rewritten onto
   * `/proxy/agency/station` as the campaign join's is.
   */
  app.post('/softphone/sessions', { preHandler: dial }, async (request, reply) => {
    if (!parseOr400(emptyBody, request.body ?? {}, reply, 'agency')) return reply;
    const actor = softphoneActorOrRefuse(request, reply);
    if (!actor) return reply;
    const result = await callCore({
      method: 'POST',
      path: '/agency/softphone/sessions',
      // Only the agent: nobody opens a soft-phone session for someone else.
      body: { agent_user_id: actor.agent_user_id },
      tenantId: request.tenantId!,
      accountId: request.accountId,
    });
    if (result.status >= 400) return sendCoreRefusal(request, reply, result);
    const body = result.body as Record<string, unknown>;
    if (typeof body['station_ws_url'] === 'string') body['station_ws_url'] = rewriteStationWsUrl(body['station_ws_url']);
    const sessionId = stringField(body, 'session_id');
    platformAuditLogger.log({
      ...softphoneAuditTenancy(request),
      ...resolvedUserAuditActor(request, actor.agent_user_id),
      action: 'agency_session.joined',
      resource_type: 'agency_session',
      ...(sessionId ? { resource_id: sessionId } : {}),
      details: { kind: 'softphone', created: result.status === 201 },
    });
    return reply.code(result.status).send(body);
  });

  /**
   * POST /proxy/agency/sessions/:id/softphone — break from the campaign onto the soft
   * phone (SP7). Queued like any break while the agent is reserved, on a call or in
   * wrap-up (`pending_state: 'break'`, `break_reason: 'soft_phone'`). The agent's own
   * session only (`session_not_found` otherwise); 409 `wrong_session_kind` on a
   * soft-phone session.
   */
  app.post<{ Params: { id: string } }>('/sessions/:id/softphone', { preHandler: dial }, async (request, reply) => {
    if (!parseOr400(emptyBody, request.body ?? {}, reply, 'agency')) return reply;
    const actor = softphoneActorOrRefuse(request, reply);
    if (!actor) return reply;
    const result = await callCore({
      method: 'POST',
      path: `/agency/sessions/${request.params.id}/softphone`,
      body: actorBody(actor),
      tenantId: request.tenantId!,
      accountId: request.accountId,
    });
    if (result.status >= 400) return sendCoreRefusal(request, reply, result);
    const unwrapped = unwrapCoreAnswer<SoftphoneSwitchAudit>(reply, result, 'POST /sessions/:id/softphone');
    if (!unwrapped) return reply;
    const { audit } = unwrapped;
    // An idempotent repeat (already on the soft phone, or already queued) changed
    // nothing: its first press is the row.
    if (!audit.unchanged) {
      auditSoftphoneStarted({
        tenantId: request.tenantId!,
        accountId: request.accountId ?? null,
        sessionId: request.params.id,
        campaignId: audit.campaign_id,
        actor: resolvedUserAuditActor(request, actor.agent_user_id),
        fromState: audit.from_state,
        queued: audit.queued,
      });
    }
    return reply.send(unwrapped.answer);
  });

  /**
   * POST /proxy/agency/sessions/:id/softphone/return — back to the campaign (`available`),
   * or withdraw a switch still queued. 409 `manual_call_live` (with the call) while a
   * manual call is live or awaiting its outcome; `not_on_softphone`; `wrong_session_kind`.
   */
  app.post<{ Params: { id: string } }>('/sessions/:id/softphone/return', { preHandler: finish }, async (request, reply) => {
    if (!parseOr400(emptyBody, request.body ?? {}, reply, 'agency')) return reply;
    const actor = softphoneActorOrRefuse(request, reply);
    if (!actor) return reply;
    const result = await callCore({
      method: 'POST',
      path: `/agency/sessions/${request.params.id}/softphone/return`,
      body: actorBody(actor),
      tenantId: request.tenantId!,
      accountId: request.accountId,
    });
    if (result.status >= 400) return sendCoreRefusal(request, reply, result);
    const unwrapped = unwrapCoreAnswer<SoftphoneSwitchAudit>(reply, result, 'POST /sessions/:id/softphone/return');
    if (!unwrapped) return reply;
    const { audit } = unwrapped;
    auditSoftphoneEnded({
      tenantId: request.tenantId!,
      accountId: request.accountId ?? null,
      sessionId: request.params.id,
      campaignId: audit.campaign_id,
      actor: resolvedUserAuditActor(request, actor.agent_user_id),
      fromState: audit.from_state,
      via: 'return',
      withdrawn: audit.withdrawn,
    });
    return reply.send(unwrapped.answer);
  });
}
