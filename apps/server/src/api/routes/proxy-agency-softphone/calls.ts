/*
 * The soft phone's call actions: place, details, hang up, outcome, mark DNC
 * (docs/softphone.md §4.1, §6). Part of `proxy-agency-softphone.routes.ts`.
 *
 * Each validates its body (unknown keys stripped, the actor among them), sends the actor
 * the route derived (`shared.ts`), and writes its `platform_audit_log` rows from the
 * internal handler's envelope: the real actor, `on_behalf` when the call was another
 * agent's, and for a placed call the DNC / calling-hours override with the agent's note.
 * Free text an agent typed about a customer (notes, field values) never goes in `details`;
 * the override notes do, because the override IS the audited act (SP1, SP2).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requirePermission } from '../../../rbac/rbac.middleware.js';
import { platformAuditLogger } from '../../../audit/platform/audit-logger.js';
import { resolvedUserAuditActor } from '../../../audit/platform/audit-actor.js';
import { callCore } from '../../core-dispatch.js';
import { parseOr400 } from '../helpers/parse-or-400.js';
import type {
  SoftphoneCallActAudit,
  SoftphoneDispositionAudit,
  SoftphoneDncAudit,
  SoftphonePlaceAudit,
} from '../agency/softphone-answer.js';
import {
  actorBody,
  requireSoftphoneEnabled,
  sendCoreRefusal,
  softphoneActorOrRefuse,
  softphoneAuditTenancy,
  unwrapCoreAnswer,
  type SoftphoneRequestActor,
} from './shared.js';

/**
 * A call-field value: the runtime validates it against the field set in force
 * (`fields_invalid` with a path per key), so the edge bounds only the shape and size.
 */
const fieldValue = z.union([z.string().max(2000), z.number().finite(), z.boolean(), z.null()]);
const fieldsSchema = z.record(z.string().min(1).max(100), fieldValue)
  .refine((v) => Object.keys(v).length <= 50, 'At most 50 call fields.');

/**
 * `AgencyManualCallCreateRequest` without the actor. The override notes' 10–500 rule is
 * the runtime's (`override_note_invalid`, with its own copy); the edge only stops a
 * megabyte reaching it.
 */
const placeSchema = z.object({
  session_id: z.string().uuid(),
  to: z.string().trim().min(1).max(40),
  caller_id: z.string().trim().min(1).max(20).optional(),
  campaign_id: z.string().uuid().nullable().optional(),
  fields: fieldsSchema.optional(),
  overrides: z.object({
    dnc_note: z.string().max(2000).optional(),
    hours_note: z.string().max(2000).optional(),
  }).strip().optional(),
}).strip();

/** `notes: ''` clears them; `fields` replaces the stored values wholesale. */
const detailsSchema = z.object({
  fields: fieldsSchema.optional(),
  notes: z.string().max(4000).optional(),
}).strip();

/** `callback_at` is checked by the runtime (`disposition_invalid` / `invalid_callback_at`). */
const dispositionSchema = z.object({
  code: z.string().min(1).max(50),
  notes: z.string().max(4000).optional(),
  callback_at: z.string().min(1).max(64).optional(),
  fields: fieldsSchema.optional(),
}).strip();

/** The client never asserts the scope: campaign when tagged, else tenant (§6). */
const dncSchema = z.object({ reason: z.string().max(1000).optional() }).strip();

const emptyBody = z.object({}).strip();

/** Forward a call action; answers the internal handler's result. */
async function forwardCall(
  request: FastifyRequest,
  actor: SoftphoneRequestActor,
  call: { method: 'POST' | 'PATCH'; path: string; body: Record<string, unknown> },
) {
  return callCore({
    method: call.method,
    path: call.path,
    body: { ...call.body, ...actorBody(actor) },
    tenantId: request.tenantId!,
    accountId: request.accountId,
  });
}

function onBehalf(audit: SoftphoneCallActAudit): { on_behalf: true } | Record<string, never> {
  return audit.on_behalf ? { on_behalf: true } : {};
}

function campaignOf(campaignId: string | null): { campaign_id: string } | Record<string, never> {
  return campaignId ? { campaign_id: campaignId } : {};
}

export async function registerSoftphoneCallRoutes(app: FastifyInstance): Promise<void> {
  const dial = [requirePermission('agency.softphone.dial'), requireSoftphoneEnabled];

  /**
   * POST /proxy/agency/softphone/calls → 201 the call. The pre-dial refusals (§4.1 step 2)
   * come back with the contract status and their structured fields; `dnc_listed` and
   * `outside_calling_hours` are redialled with `overrides`.
   */
  app.post('/softphone/calls', { preHandler: dial }, async (request, reply) => {
    const parsed = parseOr400(placeSchema, request.body, reply, 'agency');
    if (!parsed) return reply;
    const actor = softphoneActorOrRefuse(request, reply);
    if (!actor) return reply;
    const result = await forwardCall(request, actor, { method: 'POST', path: '/agency/softphone/calls', body: parsed.data });
    if (result.status >= 400) return sendCoreRefusal(request, reply, result);
    const unwrapped = unwrapCoreAnswer<SoftphonePlaceAudit>(reply, result, 'POST /softphone/calls');
    if (!unwrapped) return reply;
    const { answer, audit } = unwrapped;
    const callId = (answer as { id?: unknown }).id;
    const resource = typeof callId === 'string' ? { resource_id: callId } : {};
    const about = { resource_type: 'agency_manual_call' as const, ...resource, ...campaignOf(audit.campaign_id) };
    platformAuditLogger.log({
      ...softphoneAuditTenancy(request),
      ...resolvedUserAuditActor(request, actor.agent_user_id),
      ...about,
      action: 'agency_manual_call.placed',
      details: {
        session_id: audit.session_id,
        ...campaignOf(audit.campaign_id),
        ...(audit.dnc_override ? { dnc_overridden: true } : {}),
        ...(audit.hours_override_note !== null ? { hours_overridden: true } : {}),
      },
    });
    if (audit.dnc_override) {
      platformAuditLogger.log({
        ...softphoneAuditTenancy(request),
        ...resolvedUserAuditActor(request, actor.agent_user_id),
        ...about,
        action: 'agency_manual_call.dnc_overridden',
        details: {
          note: audit.dnc_override.note,
          dnc_entry_id: audit.dnc_override.entry_id,
          ...campaignOf(audit.campaign_id),
        },
      });
    }
    if (audit.hours_override_note !== null) {
      platformAuditLogger.log({
        ...softphoneAuditTenancy(request),
        ...resolvedUserAuditActor(request, actor.agent_user_id),
        ...about,
        action: 'agency_manual_call.hours_overridden',
        details: { note: audit.hours_override_note, ...campaignOf(audit.campaign_id) },
      });
    }
    return reply.code(201).send(answer);
  });

  /** PATCH /proxy/agency/softphone/calls/:id — call details and notes (not audited: no outcome is saved). */
  app.patch<{ Params: { id: string } }>('/softphone/calls/:id', { preHandler: dial }, async (request, reply) => {
    const parsed = parseOr400(detailsSchema, request.body ?? {}, reply, 'agency');
    if (!parsed) return reply;
    const actor = softphoneActorOrRefuse(request, reply);
    if (!actor) return reply;
    const result = await forwardCall(request, actor, {
      method: 'PATCH', path: `/agency/softphone/calls/${request.params.id}`, body: parsed.data,
    });
    if (result.status >= 400) return sendCoreRefusal(request, reply, result);
    return reply.send(result.body);
  });

  /** POST /proxy/agency/softphone/calls/:id/hangup — idempotent once the call has ended. */
  app.post<{ Params: { id: string } }>('/softphone/calls/:id/hangup', { preHandler: dial }, async (request, reply) => {
    if (!parseOr400(emptyBody, request.body ?? {}, reply, 'agency')) return reply;
    const actor = softphoneActorOrRefuse(request, reply);
    if (!actor) return reply;
    const result = await forwardCall(request, actor, {
      method: 'POST', path: `/agency/softphone/calls/${request.params.id}/hangup`, body: {},
    });
    return sendAudited<SoftphoneCallActAudit>(request, reply, result, 'POST /softphone/calls/:id/hangup', (audit) => {
      platformAuditLogger.log({
        ...softphoneAuditTenancy(request),
        ...resolvedUserAuditActor(request, actor.agent_user_id),
        action: 'agency_manual_call.hung_up',
        resource_type: 'agency_manual_call',
        resource_id: request.params.id,
        ...campaignOf(audit.campaign_id),
        details: { ...campaignOf(audit.campaign_id), ...onBehalf(audit) },
      });
    });
  });

  /** POST /proxy/agency/softphone/calls/:id/disposition — the outcome; a supervisor may act on behalf. */
  app.post<{ Params: { id: string } }>('/softphone/calls/:id/disposition', { preHandler: dial }, async (request, reply) => {
    const parsed = parseOr400(dispositionSchema, request.body, reply, 'agency');
    if (!parsed) return reply;
    const actor = softphoneActorOrRefuse(request, reply);
    if (!actor) return reply;
    const result = await forwardCall(request, actor, {
      method: 'POST', path: `/agency/softphone/calls/${request.params.id}/disposition`, body: parsed.data,
    });
    return sendAudited<SoftphoneDispositionAudit>(request, reply, result, 'POST /softphone/calls/:id/disposition', (audit) => {
      platformAuditLogger.log({
        ...softphoneAuditTenancy(request),
        ...resolvedUserAuditActor(request, actor.agent_user_id),
        action: 'agency_manual_call.dispositioned',
        resource_type: 'agency_manual_call',
        resource_id: request.params.id,
        ...campaignOf(audit.campaign_id),
        details: {
          disposition_code: audit.disposition_code,
          ...campaignOf(audit.campaign_id),
          ...onBehalf(audit),
          ...(audit.replay ? { replay: true } : {}),
        },
      });
    });
  });

  /** POST /proxy/agency/softphone/calls/:id/dnc — campaign scope when tagged, else tenant. */
  app.post<{ Params: { id: string } }>('/softphone/calls/:id/dnc', { preHandler: dial }, async (request, reply) => {
    const parsed = parseOr400(dncSchema, request.body ?? {}, reply, 'agency');
    if (!parsed) return reply;
    const actor = softphoneActorOrRefuse(request, reply);
    if (!actor) return reply;
    const result = await forwardCall(request, actor, {
      method: 'POST', path: `/agency/softphone/calls/${request.params.id}/dnc`, body: parsed.data,
    });
    return sendAudited<SoftphoneDncAudit>(request, reply, result, 'POST /softphone/calls/:id/dnc', (audit) => {
      // No phone number in `details`: the row records that a suppression happened and
      // how far it reaches, not whom it suppressed (the `dnc_entry.created` rule).
      platformAuditLogger.log({
        ...softphoneAuditTenancy(request),
        ...resolvedUserAuditActor(request, actor.agent_user_id),
        action: 'agency_manual_call.dnc_marked',
        resource_type: 'agency_manual_call',
        resource_id: request.params.id,
        ...campaignOf(audit.campaign_id),
        details: {
          scope: audit.scope,
          dnc_recorded: audit.dnc_recorded,
          ...campaignOf(audit.campaign_id),
          ...onBehalf(audit),
        },
      });
    });
  });
}

/** The refusal as it came, or the envelope's answer after its audit row. */
function sendAudited<TAudit>(
  request: FastifyRequest,
  reply: FastifyReply,
  result: Awaited<ReturnType<typeof callCore>>,
  route: string,
  audit: (facts: TAudit) => void,
): FastifyReply {
  if (result.status >= 400) return sendCoreRefusal(request, reply, result);
  const unwrapped = unwrapCoreAnswer<TAudit>(reply, result, route);
  if (!unwrapped) return reply;
  audit(unwrapped.audit);
  return reply.code(result.status).send(unwrapped.answer);
}
