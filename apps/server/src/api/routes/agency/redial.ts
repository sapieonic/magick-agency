/*
 * The wrap-up redial handler (`POST /sessions/:id/redial`). Part of `agency.routes.ts`.
 * The flow is `agency/wrapup-redial.ts`; this is the edge: the session's own agent, a
 * well-formed attempt id, and the refusal shape every agent action uses.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AgencyRedialRequest } from '@magick-agency/contracts/agency';
import type { AgencyRuntime } from '../../../agency/runtime.js';
import { startWrapupRedial } from '../../../agency/wrapup-redial.js';
import { isCampaignSession } from '../../../db/models/agency.model.js';
import { UUID_RE } from '../../../utils/uuid.js';
import { requireOwnedSession, sendActionError } from './helpers.js';

/**
 * Registered by `agencyRoutes` inside its authenticated scope (`sub`, the one carrying
 * `authMiddleware`), so every route here runs behind it.
 */
export async function registerRedialRoutes(sub: FastifyInstance, runtime: AgencyRuntime): Promise<void> {
  // ── POST /sessions/:id/redial — redial the customer from wrap-up ──────────
  //
  // The session's OWN agent only: `requireOwnedSession` without `supervisorMayAct`. A
  // redial puts a customer's voice in this session's headset, which no one but the
  // agent wearing it may decide.
  sub.post('/sessions/:id/redial', async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const session = await requireOwnedSession(request, reply);
    if (!session) return reply;
    if (!isCampaignSession(session)) {
      return sendActionError(reply, 409, 'redial_not_allowed', undefined, 'A soft-phone session has no campaign call to redial.');
    }
    const body = (request.body ?? {}) as Partial<AgencyRedialRequest>;
    // Validated at the edge: a non-UUID reaching the `uuid` cast is a 22P02, not a 400.
    if (typeof body.attempt_id !== 'string' || !UUID_RE.test(body.attempt_id)) {
      return sendActionError(reply, 400, 'redial_not_allowed', undefined, 'The request did not name the call to redial.');
    }
    const result = await startWrapupRedial(
      {
        agents: runtime.agents,
        wrapup: runtime.wrapup,
        stations: runtime.stations,
        dnc: runtime.dnc,
        dispatcher: runtime.dispatcher,
        dialer: runtime.dialer,
      },
      { sessionId: session.id, attemptId: body.attempt_id, actorUserId: session.agent_user_id },
    );
    if (!result.ok) return sendActionError(reply, result.status, result.code, undefined, result.message);
    return reply.send(result.response);
  });
}
