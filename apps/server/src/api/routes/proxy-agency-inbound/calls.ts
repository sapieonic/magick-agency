/*
 * The answered inbound call's finish (docs/inbound.md §6; P2): read it, its notes, hang up, save
 * the outcome, Mark DNC; and the supervisor's queue tiles. Part of `proxy-agency-inbound.routes.ts`.
 *
 * `agency.inbound.read` (floored at `agent`): the agent the call was offered to or connected with
 * acts on it; a caller whose role holds `agency.supervise` acts on any of the account's, on
 * behalf. **Never behind `agency_inbound_enabled`** (the soft phone's rule for finishing work):
 * an agent the flag is switched off under mid-call can still hang up and save the outcome, and
 * each route acts only on a call the agent already took.
 *
 * Each validates its body (unknown keys stripped, the actor among them), sends the actor this
 * layer derived (`shared.ts`), and writes the audit rows from the internal handler's envelope:
 * `agency_inbound_call.hung_up` (only when this request hung it up), `.dispositioned` (with
 * `replay`), `.dnc_marked`, each with `on_behalf` when the call was another agent's and the
 * matched campaign as `campaign_id`; and `dnc_entry.created` when a mark or a suppress outcome
 * listed the number anew. Notes and numbers never go in `details`.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requirePermission } from '../../../rbac/rbac.middleware.js';
import { platformAuditLogger } from '../../../audit/platform/audit-logger.js';
import { resolvedUserAuditActor } from '../../../audit/platform/audit-actor.js';
import { callCore, type CoreCallResult } from '../../core-dispatch.js';
import { parseOr400 } from '../helpers/parse-or-400.js';
import type {
  InboundCallDispositionAudit,
  InboundCallDncAudit,
  InboundCallHangupAudit,
  InboundDncEntryAudit,
} from '../agency/inbound-answer.js';
import {
  actorQuery, inboundActorOrRefuse, inboundAuditTenancy, requireInboundEnabled, unwrapInboundAnswer, type InboundRequestActor,
} from './shared.js';

/** `notes: ''` clears them. */
const notesSchema = z.object({ notes: z.string().max(4000).optional() }).strip();
/** `callback_at` is checked by the runtime (`inbound_disposition_invalid` / `invalid_callback_at`). */
const dispositionSchema = z.object({
  code: z.string().min(1).max(64),
  notes: z.string().max(4000).optional(),
  callback_at: z.string().min(1).max(64).optional(),
}).strip();
/** The client never asserts the scope: the matched campaign's, else the call's account. */
const dncSchema = z.object({ reason: z.string().max(1000).optional() }).strip();
const emptyBody = z.object({}).strip();

/** The actor on an internal body: `agent_user_id`, and `on_behalf` only when supervising. */
function actorBody(actor: InboundRequestActor): { agent_user_id: string; on_behalf?: true } {
  return actor.supervise ? { agent_user_id: actor.userId, on_behalf: true } : { agent_user_id: actor.userId };
}

/** Forward a call action with the actor; each route passes its own literal path. */
function forward(
  request: FastifyRequest,
  actor: InboundRequestActor,
  call: { method: 'POST' | 'PATCH'; path: string; body: Record<string, unknown> },
): Promise<CoreCallResult> {
  return callCore({
    method: call.method, path: call.path, body: { ...call.body, ...actorBody(actor) },
    tenantId: request.tenantId!, accountId: request.accountId,
  });
}

/** The audit row's shared part (the actor is stated at each write): tenancy, the call it is filed under, the campaign. */
function auditBase(request: FastifyRequest, callId: string, campaignId: string | null) {
  return {
    ...inboundAuditTenancy(request),
    resource_type: 'agency_inbound_call' as const,
    resource_id: callId,
    ...(campaignId ? { campaign_id: campaignId } : {}),
  };
}

function onBehalf(flag: boolean): { on_behalf: true } | Record<string, never> {
  return flag ? { on_behalf: true } : {};
}

/** `dnc_entry.created` for a mark or a suppress outcome that listed the number anew (the DNC trail's own row). */
function logDncEntryCreated(
  request: FastifyRequest,
  actor: InboundRequestActor,
  facts: { entry: InboundDncEntryAudit | null; callId: string; campaignId: string | null; onBehalf: boolean; dispositionCode?: string },
): void {
  if (!facts.entry?.created) return;
  platformAuditLogger.log({
    ...inboundAuditTenancy(request),
    ...resolvedUserAuditActor(request, actor.userId),
    action: 'dnc_entry.created',
    resource_type: 'dnc_entry',
    resource_id: facts.entry.id,
    ...(facts.campaignId ? { campaign_id: facts.campaignId } : {}),
    details: {
      inbound_call_id: facts.callId,
      scope: facts.entry.scope,
      ...(facts.campaignId ? { campaign_id: facts.campaignId } : {}),
      ...(facts.dispositionCode ? { disposition_code: facts.dispositionCode } : {}),
      ...onBehalf(facts.onBehalf),
    },
  });
}

/** An audited route's answer: the refusal as it came, or the envelope's answer after `audit` ran. */
function sendAudited<TAudit>(
  request: FastifyRequest,
  reply: FastifyReply,
  result: CoreCallResult,
  route: string,
  audit: (audit: TAudit) => void,
): FastifyReply {
  if (result.status >= 400) return reply.code(result.status).send(result.body);
  const unwrapped = unwrapInboundAnswer<TAudit>(reply, result, route);
  if (!unwrapped) return reply;
  audit(unwrapped.audit);
  return reply.code(200).send(unwrapped.answer);
}

export async function registerInboundCallRoutes(app: FastifyInstance): Promise<void> {
  const finish = [requirePermission('agency.inbound.read')];

  /**
   * GET /proxy/agency/inbound/queue — `{ tiles }` (`AgencyInboundQueueResponse`): `agency.supervise`
   * and `agency_inbound_enabled` (a console surface, unlike the finish routes).
   */
  app.get('/inbound/queue', { preHandler: [requirePermission('agency.supervise'), requireInboundEnabled] }, async (request, reply) => {
    const actor = inboundActorOrRefuse(request, reply);
    if (!actor) return reply;
    const result = await callCore({
      method: 'GET', path: '/agency/inbound/queue', query: actorQuery(actor),
      tenantId: request.tenantId!, accountId: request.accountId,
    });
    return reply.code(result.status).send(result.body);
  });

  /** GET /proxy/agency/inbound/calls/:id — `{ call }` (`AgencyInboundCallResponse`). */
  app.get<{ Params: { id: string } }>('/inbound/calls/:id', { preHandler: finish }, async (request, reply) => {
    const actor = inboundActorOrRefuse(request, reply);
    if (!actor) return reply;
    const result = await callCore({
      method: 'GET', path: `/agency/inbound/calls/${request.params.id}`, query: actorQuery(actor),
      tenantId: request.tenantId!, accountId: request.accountId,
    });
    return reply.code(result.status).send(result.body);
  });

  /** PATCH /proxy/agency/inbound/calls/:id — the notes, last write wins (not audited: no outcome is saved). */
  app.patch<{ Params: { id: string } }>('/inbound/calls/:id', { preHandler: finish }, async (request, reply) => {
    const parsed = parseOr400(notesSchema, request.body ?? {}, reply, 'agency');
    if (!parsed) return reply;
    const actor = inboundActorOrRefuse(request, reply);
    if (!actor) return reply;
    const result = await forward(request, actor, { method: 'PATCH', path: `/agency/inbound/calls/${request.params.id}`, body: parsed.data });
    return reply.code(result.status).send(result.body);
  });

  /** POST /proxy/agency/inbound/calls/:id/hangup — idempotent once the call has ended (and then not audited). */
  app.post<{ Params: { id: string } }>('/inbound/calls/:id/hangup', { preHandler: finish }, async (request, reply) => {
    if (!parseOr400(emptyBody, request.body ?? {}, reply, 'agency')) return reply;
    const actor = inboundActorOrRefuse(request, reply);
    if (!actor) return reply;
    const result = await forward(request, actor, { method: 'POST', path: `/agency/inbound/calls/${request.params.id}/hangup`, body: {} });
    return sendAudited<InboundCallHangupAudit>(request, reply, result, 'POST /inbound/calls/:id/hangup', (audit) => {
      if (!audit.hung_up) return;
      platformAuditLogger.log({
        ...auditBase(request, audit.call_id, audit.campaign_id),
        ...resolvedUserAuditActor(request, actor.userId),
        action: 'agency_inbound_call.hung_up',
        details: { ...onBehalf(audit.on_behalf) },
      });
    });
  });

  /** POST /proxy/agency/inbound/calls/:id/disposition — the outcome (`AgencyInboundCallDispositionResponse`). */
  app.post<{ Params: { id: string } }>('/inbound/calls/:id/disposition', { preHandler: finish }, async (request, reply) => {
    const parsed = parseOr400(dispositionSchema, request.body, reply, 'agency');
    if (!parsed) return reply;
    const actor = inboundActorOrRefuse(request, reply);
    if (!actor) return reply;
    const result = await forward(request, actor, { method: 'POST', path: `/agency/inbound/calls/${request.params.id}/disposition`, body: parsed.data });
    return sendAudited<InboundCallDispositionAudit>(request, reply, result, 'POST /inbound/calls/:id/disposition', (audit) => {
      platformAuditLogger.log({
        ...auditBase(request, audit.call_id, audit.campaign_id),
        ...resolvedUserAuditActor(request, actor.userId),
        action: 'agency_inbound_call.dispositioned',
        details: {
          disposition_code: audit.disposition_code,
          ...(audit.replay ? { replay: true } : {}),
          ...onBehalf(audit.on_behalf),
        },
      });
      logDncEntryCreated(request, actor, {
        entry: audit.dnc_entry, callId: audit.call_id, campaignId: audit.campaign_id,
        onBehalf: audit.on_behalf, dispositionCode: audit.disposition_code,
      });
    });
  });

  /** POST /proxy/agency/inbound/calls/:id/dnc — mark the caller's number Do Not Call (`AgencyInboundCallDncResponse`). */
  app.post<{ Params: { id: string } }>('/inbound/calls/:id/dnc', { preHandler: finish }, async (request, reply) => {
    const parsed = parseOr400(dncSchema, request.body ?? {}, reply, 'agency');
    if (!parsed) return reply;
    const actor = inboundActorOrRefuse(request, reply);
    if (!actor) return reply;
    const result = await forward(request, actor, { method: 'POST', path: `/agency/inbound/calls/${request.params.id}/dnc`, body: parsed.data });
    return sendAudited<InboundCallDncAudit>(request, reply, result, 'POST /inbound/calls/:id/dnc', (audit) => {
      platformAuditLogger.log({
        ...auditBase(request, audit.call_id, audit.campaign_id),
        ...resolvedUserAuditActor(request, actor.userId),
        action: 'agency_inbound_call.dnc_marked',
        details: { scope: audit.scope, dnc_recorded: audit.dnc_recorded, ...onBehalf(audit.on_behalf) },
      });
      logDncEntryCreated(request, actor, { entry: audit.dnc_entry, callId: audit.call_id, campaignId: audit.campaign_id, onBehalf: audit.on_behalf });
    });
  });
}
