import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AGENCY_INBOUND_RING_DECLINE_REASONS, AGENCY_STATION_DEVICE_ID_PATTERN } from '@magick-agency/contracts/agency';
import { sessionMiddleware } from '../../auth/session.middleware.js';
import { tenantContextMiddleware } from '../middleware/tenant-context.middleware.js';
import { requirePermission } from '../../rbac/rbac.middleware.js';
import { platformAuditLogger } from '../../audit/platform/audit-logger.js';
import { requestAuditActor, resolvedUserAuditActor } from '../../audit/platform/audit-actor.js';
import { callCore } from '../core-dispatch.js';
import { UUID_RE } from '../../utils/uuid.js';
import { parseOr400 } from './helpers/parse-or-400.js';
import { rejectPathEscapingParams } from './helpers/path-params.js';
import { inboundRefusalBody } from './agency/inbound-answer.js';
import type { InboundRingAcceptAudit, InboundRingDeclineAudit } from './agency/inbound-ring.js';
import { sendAudited } from './proxy-agency-inbound/shared.js';
import { rewriteStationWsUrl } from './proxy-agency-station.routes.js';

/*
 * Mode B's ring routes (IQ71; docs/inbound.md "Ringing an away phone"; the wire is
 * `@magick-agency/contracts/agency` "The ring routes"), served at
 * `/proxy/agency/inbound/calls/:id/ring/…` (decision B16), in a scope of their own because two of
 * them carry no Firebase session:
 *
 *  - `POST …/ring/answering {offer_token}` and `POST …/ring/decline {offer_token, reason}`: native
 *    Android code posts them at the tap, without Flutter or a Firebase token. The offer token is
 *    their only authority (128 bits, bound to the call and the session, compared in constant time,
 *    never logged, audited or persisted). Rate-limited per IP ({@link RING_TOKEN_RATE_LIMIT}). An
 *    unknown, spent or expired token, a malformed id or a call this process does not hold is the
 *    uniform 404 `ring_not_offered`, so a wrong token tells the caller nothing.
 *  - `POST …/ring/accept {offer_token, device_id}`: the agent's Firebase session, the tenant
 *    context and `agency.station.connect` (the agent floor), as the station token mint has; the
 *    `station_ws_url` it answers is rewritten onto `/proxy/agency/station` like the mint's.
 *
 * Each runs its internal handler (`agency/inbound-ring.ts`) through `callCore`, on the tenancy of
 * the call the connector holds (`ringTenancy`; the accept checks it against the request's tenant).
 * Audited: `agency_inbound_call.ring_declined` (the agent the ring was for; the token was theirs)
 * and `agency_inbound_call.ring_accepted`, both filed under the inbound call, ids only.
 */

/** The token-only routes' limit, per IP (a phone posts each once at a tap, retried once). */
export const RING_TOKEN_RATE_LIMIT = { max: 30, timeWindow: 60_000 } as const;

/** Where the connector holds a call (`InboundConnector.ringTenancy`); null for a call not held here. */
export type RingTenancyLookup = (callId: string) => { tenantId: string; accountId: string } | null;

const tokenOnlyLimit = {
  rateLimit: {
    ...RING_TOKEN_RATE_LIMIT,
    keyGenerator: (request: FastifyRequest) => `ring:${request.ip}`,
  },
} as const;

/** Bodies: unknown keys stripped. The token's shape is checked by the internal handler (uniform 404). */
const answeringSchema = z.object({ offer_token: z.string().min(1).max(128) }).strip();
const declineSchema = z.object({
  offer_token: z.string().min(1).max(128),
  reason: z.enum(AGENCY_INBOUND_RING_DECLINE_REASONS),
}).strip();
const acceptSchema = z.object({
  offer_token: z.string().min(1).max(128),
  device_id: z.string().regex(AGENCY_STATION_DEVICE_ID_PATTERN),
}).strip();

function notOffered(reply: FastifyReply): FastifyReply {
  const { status, body } = inboundRefusalBody({ code: 'ring_not_offered' });
  return reply.code(status).send(body);
}

export async function proxyAgencyInboundRingRoutes(app: FastifyInstance, opts: { ringTenancy: RingTenancyLookup }): Promise<void> {
  app.addHook('preHandler', rejectPathEscapingParams());

  /** The tenancy of the ringing call `:id`, or the uniform 404. */
  const tenancyOr404 = (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const id = request.params.id;
    const tenancy = UUID_RE.test(id) ? opts.ringTenancy(id.toLowerCase()) : null;
    if (!tenancy) void notOffered(reply);
    return tenancy ? { ...tenancy, callId: id.toLowerCase() } : null;
  };

  /** POST /proxy/agency/inbound/calls/:id/ring/answering — `AgencyInboundRingAnsweringResponse`. */
  app.post<{ Params: { id: string } }>('/inbound/calls/:id/ring/answering', { config: tokenOnlyLimit }, async (request, reply) => {
    const parsed = answeringSchema.safeParse(request.body ?? {});
    if (!parsed.success) return notOffered(reply);
    const ringing = tenancyOr404(request, reply);
    if (!ringing) return reply;
    const result = await callCore({
      method: 'POST', path: `/agency/inbound/calls/${ringing.callId}/ring/answering`, body: parsed.data,
      tenantId: ringing.tenantId, accountId: ringing.accountId,
    });
    return reply.code(result.status).send(result.body);
  });

  /** POST /proxy/agency/inbound/calls/:id/ring/decline — `AgencyInboundRingDeclineResponse`. */
  app.post<{ Params: { id: string } }>('/inbound/calls/:id/ring/decline', { config: tokenOnlyLimit }, async (request, reply) => {
    const parsed = declineSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      // A body without a well-formed reason is the caller's mistake to see; a missing token is the uniform 404.
      if (!answeringSchema.safeParse(request.body ?? {}).success) return notOffered(reply);
      return reply.code(400).send({ error: 'Validation failed', details: { reason: `one of ${AGENCY_INBOUND_RING_DECLINE_REASONS.join(', ')}` } });
    }
    const ringing = tenancyOr404(request, reply);
    if (!ringing) return reply;
    const result = await callCore({
      method: 'POST', path: `/agency/inbound/calls/${ringing.callId}/ring/decline`, body: parsed.data,
      tenantId: ringing.tenantId, accountId: ringing.accountId,
    });
    return sendAudited<InboundRingDeclineAudit>(reply, result, 'POST /inbound/calls/:id/ring/decline', (audit) => {
      // The token was the agent's (the ring was theirs, on their phone): they are the actor.
      if (!audit.agent_user_id) return;
      platformAuditLogger.log({
        ...resolvedUserAuditActor(request, audit.agent_user_id),
        tenant_id: ringing.tenantId,
        account_id: ringing.accountId,
        action: 'agency_inbound_call.ring_declined',
        resource_type: 'agency_inbound_call',
        resource_id: audit.call_id,
        details: { session_id: audit.session_id, reason: audit.reason },
      });
    });
  });

  /** POST /proxy/agency/inbound/calls/:id/ring/accept — `AgencyInboundRingAcceptResponse`. */
  app.post<{ Params: { id: string } }>('/inbound/calls/:id/ring/accept', {
    preHandler: [sessionMiddleware, tenantContextMiddleware, requirePermission('agency.station.connect')],
  }, async (request, reply) => {
    const parsed = parseOr400(acceptSchema, request.body ?? {}, reply, 'agency');
    if (!parsed) return reply;
    const userId = request.user?.id;
    if (!userId) return reply.code(400).send({ error: 'Bad Request', code: 'missing_actor', message: 'Sign in as the agent the call rings for.' });
    const ringing = tenancyOr404(request, reply);
    if (!ringing) return reply;
    if (ringing.tenantId !== request.tenantId) return notOffered(reply);
    const result = await callCore({
      method: 'POST', path: `/agency/inbound/calls/${ringing.callId}/ring/accept`,
      body: { ...parsed.data, agent_user_id: userId },
      tenantId: ringing.tenantId, accountId: ringing.accountId,
    });
    return sendAudited<InboundRingAcceptAudit>(reply, result, 'POST /inbound/calls/:id/ring/accept', (audit) => {
      platformAuditLogger.log({
        ...requestAuditActor(request),
        tenant_id: ringing.tenantId,
        account_id: ringing.accountId,
        action: 'agency_inbound_call.ring_accepted',
        resource_type: 'agency_inbound_call',
        resource_id: audit.call_id,
        details: { session_id: audit.session_id, device_id: audit.device_id },
      });
    }, (answer) => {
      const body = answer as Record<string, unknown>;
      if (typeof body['station_ws_url'] === 'string') body['station_ws_url'] = rewriteStationWsUrl(body['station_ws_url']);
      return reply.code(200).send(body);
    });
  });
}
