/*
 * The answered inbound call's internal handlers (docs/inbound.md §6; P2), on the internal handler
 * instance under `/api/v1/agency` (decision B16): read the call, its notes, hang up, the outcome,
 * Mark DNC; and the supervisor's queue tiles. Part of `agency.routes.ts`, inside its authenticated
 * scope.
 *
 * The public routes (`../proxy-agency-inbound/calls.ts`) own RBAC, the actor (and its
 * `supervise`, from the role), body validation and the audit rows; these handlers own the runtime
 * calls (`AgencyRuntime.inboundCalls`, `agency/inbound/inbound-disposition.ts`) and the refusal
 * mapping (`./inbound-answer.ts`). Never behind `agency_inbound_enabled`: an agent the flag is
 * switched off under can still finish a call they took (the soft phone's rule).
 *
 * The actor arrives as the soft phone's does: on a body `agent_user_id` + `on_behalf`
 * (`on_behalf` = the caller holds `agency.supervise`), on a GET `?actor_user_id=` +
 * `?supervise=true`. Every read and write names the request's tenant and account.
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { AgencyRuntime } from '../../../agency/runtime.js';
import type { InboundCallService } from '../../../agency/inbound/inbound-disposition.js';
import {
  sendInboundAnswer,
  sendInboundRefusal,
  type InboundCallDispositionAudit,
  type InboundCallDncAudit,
  type InboundCallHangupAudit,
} from './inbound-answer.js';
import { bodyActor, queryActor } from './inbound.js';

export async function registerInboundCallRoutes(sub: FastifyInstance, runtime: AgencyRuntime | null): Promise<void> {
  /** The runtime's call service, or (a routing-only app, no runtime) the call cannot be found. */
  const serviceOr404 = (reply: FastifyReply): InboundCallService | null => {
    const service = runtime?.inboundCalls;
    if (service) return service;
    void sendInboundRefusal(reply, { code: 'inbound_call_not_found' });
    return null;
  };

  // ── GET /inbound/queue — the supervisor's queue tiles ─────────────────────
  // `agency.supervise` is the public layer's; this answers the account's tiles to anyone it lets in.
  sub.get('/inbound/queue', async (request, reply) => {
    const actor = queryActor(request, reply);
    if (!actor) return reply;
    if (!actor.supervise) {
      return reply.code(403).send({ error: 'Forbidden', message: 'Insufficient permissions. Required: agency.supervise' });
    }
    const tiles = runtime ? await runtime.inboundCalls.queueTiles(actor.tenantId, actor.accountId) : [];
    return reply.send({ tiles });
  });

  // ── GET /inbound/calls/:id — the panel row ────────────────────────────────
  sub.get<{ Params: { id: string } }>('/inbound/calls/:id', async (request, reply) => {
    const actor = queryActor(request, reply);
    if (!actor) return reply;
    const service = serviceOr404(reply);
    if (!service) return reply;
    const found = await service.get(actor, request.params.id);
    if (!found.ok) return sendInboundRefusal(reply, found.refusal);
    return reply.send({ call: found.call });
  });

  // ── PATCH /inbound/calls/:id — the notes, last write wins ─────────────────
  sub.patch<{ Params: { id: string } }>('/inbound/calls/:id', async (request, reply) => {
    const actor = bodyActor(request, reply);
    if (!actor) return reply;
    const service = serviceOr404(reply);
    if (!service) return reply;
    const body = request.body as { notes?: unknown };
    if (body.notes !== undefined && typeof body.notes !== 'string') {
      return reply.code(400).send({ error: 'Validation failed', details: { notes: 'must be a string' } });
    }
    if (body.notes === undefined) {
      const found = await service.get(actor, request.params.id);
      if (!found.ok) return sendInboundRefusal(reply, found.refusal);
      return reply.send({ call: found.call });
    }
    const updated = await service.updateNotes(actor, request.params.id, body.notes);
    if (!updated.ok) return sendInboundRefusal(reply, updated.refusal);
    return reply.send({ call: updated.call });
  });

  // ── POST /inbound/calls/:id/hangup ────────────────────────────────────────
  sub.post<{ Params: { id: string } }>('/inbound/calls/:id/hangup', async (request, reply) => {
    const actor = bodyActor(request, reply);
    if (!actor) return reply;
    const service = serviceOr404(reply);
    if (!service) return reply;
    const hung = await service.hangup(actor, request.params.id);
    if (!hung.ok) return sendInboundRefusal(reply, hung.refusal);
    const audit: InboundCallHangupAudit = {
      call_id: hung.call.id, on_behalf: hung.onBehalf, campaign_id: hung.call.match?.campaign_id ?? null, hung_up: hung.hungUp,
    };
    return sendInboundAnswer(reply, 200, { call: hung.call }, audit);
  });

  // ── POST /inbound/calls/:id/disposition — the outcome ─────────────────────
  sub.post<{ Params: { id: string } }>('/inbound/calls/:id/disposition', async (request, reply) => {
    const actor = bodyActor(request, reply);
    if (!actor) return reply;
    const service = serviceOr404(reply);
    if (!service) return reply;
    const body = request.body as { code?: unknown; notes?: unknown; callback_at?: unknown };
    if (typeof body.code !== 'string') return reply.code(400).send({ error: 'Validation failed', details: { code: 'required' } });
    const saved = await service.submitDisposition(actor, request.params.id, {
      code: body.code,
      ...(typeof body.notes === 'string' ? { notes: body.notes } : {}),
      ...(typeof body.callback_at === 'string' ? { callbackAt: body.callback_at } : {}),
    });
    if (!saved.ok) return sendInboundRefusal(reply, saved.refusal);
    const campaignId = saved.response.call.match?.campaign_id ?? null;
    const audit: InboundCallDispositionAudit = {
      call_id: saved.response.call.id,
      on_behalf: saved.onBehalf,
      campaign_id: campaignId,
      disposition_code: saved.response.call.disposition_code ?? body.code,
      replay: saved.replay,
      dnc_entry: saved.dncEntry ? { ...saved.dncEntry, scope: campaignId ? 'campaign' : 'account' } : null,
    };
    return sendInboundAnswer(reply, 200, saved.response, audit);
  });

  // ── POST /inbound/calls/:id/dnc — mark the caller's number Do Not Call ────
  sub.post<{ Params: { id: string } }>('/inbound/calls/:id/dnc', async (request, reply) => {
    const actor = bodyActor(request, reply);
    if (!actor) return reply;
    const service = serviceOr404(reply);
    if (!service) return reply;
    const body = request.body as { reason?: unknown };
    const marked = await service.markDnc(actor, request.params.id, typeof body.reason === 'string' ? { reason: body.reason } : {});
    if (!marked.ok) return sendInboundRefusal(reply, marked.refusal);
    const found = await service.get(actor, request.params.id);
    const audit: InboundCallDncAudit = {
      call_id: marked.response.call_id,
      on_behalf: marked.onBehalf,
      campaign_id: found.ok ? found.call.match?.campaign_id ?? null : null,
      scope: marked.response.scope,
      dnc_recorded: marked.response.dnc_recorded,
      dnc_entry: marked.dncEntry ? { ...marked.dncEntry, scope: marked.response.scope } : null,
    };
    return sendInboundAnswer(reply, 200, marked.response, audit);
  });
}
