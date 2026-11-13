/*
 * Mode B's ring routes (IQ71; docs/inbound.md "Ringing an away phone"), the internal handlers
 * behind `/proxy/agency/inbound/calls/:id/ring/{answering,decline,accept}`
 * (`proxy-agency-inbound-ring.routes.ts`, which adds the per-IP rate limit on the token-only routes,
 * the agent's session and RBAC floor on `accept`, the tenancy, and the audit rows). Part of
 * `agency.routes.ts`, inside its authenticated scope.
 *
 *  - `answering` and `decline` carry only the offer token (native Android code posts them at the
 *    tap): the token is their only authority. An unknown, spent or expired token, a call this
 *    process does not hold, or a call of another tenant is the uniform 404 `ring_not_offered`.
 *  - `accept` names the agent (`agent_user_id`, the public layer's Bearer) and the station's
 *    device (`device_id`, OS3: it must be the device that holds the session's station, through
 *    `claimStationOrReply`); it answers the call and the station bootstrap to attach with.
 *
 * The offer token is never logged, audited or persisted: it reaches only the connector, which
 * compares it in constant time. The answers of `decline` and `accept` carry the audit facts in the
 * inbound envelope (`sendInboundAnswer`), which the public layer takes off.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  AGENCY_INBOUND_RING_DECLINE_REASONS,
  AGENCY_STATION_DEVICE_ID_PATTERN,
  type AgencyInboundRingAcceptResponse,
  type AgencyInboundRingAnsweringResponse,
  type AgencyInboundRingDeclineReason,
  type AgencyInboundRingDeclineResponse,
} from '@magick-agency/contracts/agency';
import { getAccountId, getTenantId } from '../../middleware/auth.middleware.js';
import type { AgencyRuntime } from '../../../agency/runtime.js';
import type { InboundConnector } from '../../../agency/inbound/inbound-connector.js';
import { agencyAgentSessionRepository } from '../../../db/repositories/agency.repository.js';
import { UUID_RE } from '../../../utils/uuid.js';
import { claimStationOrReply, mintStationTokenOr503 } from './helpers.js';
import { sendInboundAnswer, sendInboundRefusal } from './inbound-answer.js';

/** An offer token's shape: 128 bits, base64url (22 characters); anything else is refused before the connector. */
const OFFER_TOKEN_RE = /^[A-Za-z0-9_-]{16,64}$/;

/** `POST …/ring/decline`: what the public layer audits (ids only, never the token). */
export interface InboundRingDeclineAudit {
  call_id: string;
  session_id: string;
  /** The agent the ring was for: the token was theirs. Null when the connector no longer knew them. */
  agent_user_id: string | null;
  reason: AgencyInboundRingDeclineReason;
}

/** `POST …/ring/accept`: what the public layer audits (ids only, never the token). */
export interface InboundRingAcceptAudit {
  call_id: string;
  session_id: string;
  /** The campaign of the contact the caller matched (the audit row's `campaign_id`); null when none. */
  campaign_id: string | null;
  device_id: string;
}

function offerTokenOf(body: unknown): string | null {
  const t = (body as { offer_token?: unknown } | null)?.offer_token;
  return typeof t === 'string' && OFFER_TOKEN_RE.test(t) ? t : null;
}

export async function registerInboundRingRoutes(sub: FastifyInstance, runtime: AgencyRuntime | null): Promise<void> {
  /**
   * The connector holding call `:id` for this request's tenant, or the uniform 404 (no runtime, no
   * connector, a malformed id, a call not held here, another tenant's).
   */
  const ringingOr404 = (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply): { connector: InboundConnector; callId: string } | null => {
    const connector = runtime?.inbound ?? null;
    const callId = request.params.id;
    const tenancy = connector && UUID_RE.test(callId) ? connector.ringTenancy(callId.toLowerCase()) : null;
    if (!connector || !tenancy || tenancy.tenantId !== getTenantId(request) || tenancy.accountId !== getAccountId(request)) {
      void sendInboundRefusal(reply, { code: 'ring_not_offered' });
      return null;
    }
    return { connector, callId: callId.toLowerCase() };
  };

  // ── POST /inbound/calls/:id/ring/answering — the agent tapped Answer (token only) ──────
  sub.post<{ Params: { id: string } }>('/inbound/calls/:id/ring/answering', async (request, reply) => {
    const ringing = ringingOr404(request, reply);
    if (!ringing) return reply;
    const token = offerTokenOf(request.body);
    if (!token) return sendInboundRefusal(reply, { code: 'ring_not_offered' });
    const answered = await ringing.connector.ringAnswering(ringing.callId, token);
    if (!answered.ok) return sendInboundRefusal(reply, { code: answered.code });
    const body: AgencyInboundRingAnsweringResponse = { call_id: answered.callId, accept_by: answered.acceptBy.toISOString() };
    return reply.send(body);
  });

  // ── POST /inbound/calls/:id/ring/decline — the phone declined (token only; until accept, N4) ──
  sub.post<{ Params: { id: string } }>('/inbound/calls/:id/ring/decline', async (request, reply) => {
    const ringing = ringingOr404(request, reply);
    if (!ringing) return reply;
    const token = offerTokenOf(request.body);
    if (!token) return sendInboundRefusal(reply, { code: 'ring_not_offered' });
    const reason = (request.body as { reason?: unknown }).reason;
    if (typeof reason !== 'string' || !(AGENCY_INBOUND_RING_DECLINE_REASONS as readonly string[]).includes(reason)) {
      return reply.code(400).send({ error: 'Validation failed', details: { reason: `one of ${AGENCY_INBOUND_RING_DECLINE_REASONS.join(', ')}` } });
    }
    const declined = await ringing.connector.ringDecline(ringing.callId, token, reason as AgencyInboundRingDeclineReason);
    if (!declined.ok) return sendInboundRefusal(reply, { code: declined.code });
    const body: AgencyInboundRingDeclineResponse = { call_id: declined.callId, ring_result: reason as AgencyInboundRingDeclineReason };
    const audit: InboundRingDeclineAudit = {
      call_id: declined.callId, session_id: declined.sessionId, agent_user_id: declined.agentUserId, reason: reason as AgencyInboundRingDeclineReason,
    };
    return sendInboundAnswer(reply, 200, body, audit);
  });

  // ── POST /inbound/calls/:id/ring/accept — take the call (the agent's Bearer, the device) ──
  sub.post<{ Params: { id: string } }>('/inbound/calls/:id/ring/accept', async (request, reply) => {
    const ringing = ringingOr404(request, reply);
    if (!ringing || !runtime) return reply;
    const body = (request.body ?? {}) as { agent_user_id?: unknown; device_id?: unknown };
    const agentUserId = typeof body.agent_user_id === 'string' && UUID_RE.test(body.agent_user_id) ? body.agent_user_id : null;
    if (!agentUserId) {
      return reply.code(400).send({ error: 'Bad Request', code: 'missing_actor', message: 'Sign in as the agent the call rings for.' });
    }
    const deviceId = typeof body.device_id === 'string' && AGENCY_STATION_DEVICE_ID_PATTERN.test(body.device_id) ? body.device_id : null;
    if (!deviceId) return reply.code(400).send({ error: 'Validation failed', details: { device_id: 'required: the station device id' } });
    const token = offerTokenOf(request.body);
    if (!token) return sendInboundRefusal(reply, { code: 'ring_not_offered' });
    const { connector, callId } = ringing;
    // Whose ring it is, before anything is written: another agent's is the uniform 404.
    const peeked = connector.ringPeek(callId, token);
    if (!peeked.ok) return sendInboundRefusal(reply, { code: peeked.code });
    if (peeked.agentUserId !== agentUserId) return sendInboundRefusal(reply, { code: 'ring_not_offered' });
    const session = await agencyAgentSessionRepository.findById(peeked.sessionId);
    if (!session || session.left_at || session.agent_user_id !== agentUserId || !session.campaign_id) {
      return sendInboundRefusal(reply, { code: 'ring_not_offered' });
    }
    // OS3: only the device that holds the session's station takes the call; a reconnect never
    // moves the station (`station_on_other_device` otherwise).
    if (!await claimStationOrReply(reply, session, { deviceId, takeOver: false }, {
      reconnect: true,
      onGone: () => sendInboundRefusal(reply, { code: 'ring_not_offered' }),
    })) return reply;
    const accepted = await connector.ringAccept(callId, token, { agentUserId, deviceId });
    if (!accepted.ok) return sendInboundRefusal(reply, { code: accepted.code });
    const minted = await mintStationTokenOr503(runtime, accepted.sessionId, reply);
    if (!minted) return reply;
    const answer: AgencyInboundRingAcceptResponse = {
      call: accepted.call,
      session_id: accepted.sessionId,
      campaign_id: session.campaign_id,
      station_ws_url: `/api/v1/agency/station/${accepted.sessionId}?token=${minted.token}`,
      station_token_expires_at: minted.expiresAt.toISOString(),
    };
    const audit: InboundRingAcceptAudit = {
      call_id: callId, session_id: accepted.sessionId, campaign_id: accepted.call.match?.campaign_id ?? null, device_id: deviceId,
    };
    return sendInboundAnswer(reply, 200, answer, audit);
  });
}
