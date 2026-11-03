/*
 * The agent's dial of one of their own contacts (`POST /sessions/:id/my-contact-call`), the
 * internal half of `POST /proxy/agency/my-contacts/:contactId/call` (contact assignment, D7).
 * Part of `agency.routes.ts`. The flow is `agency/my-contact-call.ts`; this is the edge.
 *
 * On the session's path (`session_param` in `api/core-owners.ts`) because the dial runs where
 * the agent's station is: with media workers, the worker holding the socket, whose dispatcher
 * and dialer own the call, as for the wrap-up redial.
 *
 * The public route has already checked the flag, the campaign's scope and the caller's
 * staffing, and validated the body; this re-checks what the dialer runtime alone can (the
 * session is the caller's live, available session on the campaign) and refuses in the
 * agent-retry vocabulary (`AgencyAgentRetryErrorResponse`), which the public route passes on.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AgencyAgentRetryErrorResponse } from '@magick-agency/contracts/api/agency/assignment';
import type { AgencyRuntime } from '../../../agency/runtime.js';
import { MY_CONTACT_CALL_MESSAGES, startMyContactCall } from '../../../agency/my-contact-call.js';
import { getAccountId, getTenantId } from '../../middleware/auth.middleware.js';
import { UUID_RE } from '../../../utils/uuid.js';
import { requireOwnedSession } from './helpers.js';

interface MyContactCallBody {
  campaign_id?: unknown;
  contact_id?: unknown;
  override_note?: unknown;
}

function title(status: number): string {
  if (status === 400) return 'Validation failed';
  if (status === 403) return 'Forbidden';
  if (status === 404) return 'Not Found';
  if (status === 409) return 'Conflict';
  if (status === 502) return 'Bad Gateway';
  return 'Service Unavailable';
}

export async function registerMyContactCallRoutes(sub: FastifyInstance, runtime: AgencyRuntime): Promise<void> {
  sub.post('/sessions/:id/my-contact-call', async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    // The session routes' shared guard first, as on every `/sessions/:id` route: no actor is
    // 400 `missing_actor`, another agent's (or a missing) session the not-found 404, a left one
    // `409 session_ended`. The public route answers those as `agent_not_available`.
    const session = await requireOwnedSession(request, reply);
    if (!session) return reply;
    const body = (request.body ?? {}) as MyContactCallBody;
    // Validated at the edge: a non-UUID reaching a `uuid` cast is a 22P02, not an answer.
    if (typeof body.contact_id !== 'string' || !UUID_RE.test(body.contact_id)) {
      return reply.code(404).send({
        error: 'Not Found', code: 'contact_not_found', message: MY_CONTACT_CALL_MESSAGES.contact_not_found,
      } satisfies AgencyAgentRetryErrorResponse);
    }
    if (typeof body.campaign_id !== 'string' || !UUID_RE.test(body.campaign_id)) {
      return reply.code(409).send({
        error: 'Conflict', code: 'agent_not_available', message: MY_CONTACT_CALL_MESSAGES.agent_not_available,
      } satisfies AgencyAgentRetryErrorResponse);
    }
    const result = await startMyContactCall(
      {
        agents: runtime.agents,
        breaks: runtime.breaks,
        stations: runtime.stations,
        dnc: runtime.dnc,
        dispatcher: runtime.dispatcher,
        dialer: runtime.dialer,
      },
      {
        tenantId: getTenantId(request),
        accountId: getAccountId(request),
        sessionId: session.id,
        actorUserId: session.agent_user_id,
        campaignId: body.campaign_id,
        contactId: body.contact_id,
        overrideNote: typeof body.override_note === 'string' ? body.override_note : null,
      },
    );
    if (!result.ok) {
      const err: AgencyAgentRetryErrorResponse = {
        error: title(result.status),
        code: result.code,
        message: result.message,
        ...(result.details ? { details: result.details } : {}),
      };
      return reply.code(result.status).send(err);
    }
    // `basis` rides along for the public route's audit row; the console reads the contract fields.
    return reply.send({ ...result.response, basis: result.basis });
  });
}
