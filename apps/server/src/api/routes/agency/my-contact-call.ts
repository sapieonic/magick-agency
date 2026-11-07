/*
 * The agent's dial of one of their own contacts (`POST /sessions/:id/my-contact-call`), the
 * internal half of `POST /proxy/agency/my-contacts/:contactId/call` (contact assignment, CA7).
 * Part of `agency.routes.ts`. The flow is `agency/my-contact-call.ts`; this is the edge.
 *
 * On the session's path (`session_param` in `api/core-owners.ts`) because the dial runs where
 * the agent's station is: with media workers, the worker holding the socket, whose dispatcher
 * and dialer own the call, as for the wrap-up redial.
 *
 * The public route has already checked the assignment flag, the campaign's scope and the
 * caller's staffing, and validated the body; this checks the `agency_dialer_enabled` kill
 * switch (`403 feature_disabled`), re-checks what the dialer runtime alone can (the session
 * is the caller's live, available session on the campaign) and refuses in the
 * agent-retry vocabulary (`AgencyAgentRetryErrorResponse`), which the public route passes on.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AgencyAgentRetryErrorCode } from '@magick-agency/contracts/api/agency/assignment';
import type { AgencyRuntime } from '../../../agency/runtime.js';
import {
  MY_CONTACT_CALL_MESSAGES,
  startMyContactCall,
  type MyContactCallRefusal,
} from '../../../agency/my-contact-call.js';
import { getAccountId, getTenantId } from '../../middleware/auth.middleware.js';
import { UUID_RE } from '../../../utils/uuid.js';
import { getFeatureFlagService, FLAGS } from '../../../feature-flags/index.js';
import { sendRefusal, VALIDATION_FAILED_TITLE } from '../helpers/refusal.js';
import { requireOwnedSession } from './helpers.js';

interface MyContactCallBody {
  campaign_id?: unknown;
  contact_id?: unknown;
  override_note?: unknown;
}

/** A refusal in the agent-retry vocabulary (`AgencyAgentRetryErrorResponse`). */
function refuse(
  reply: FastifyReply,
  status: MyContactCallRefusal['status'] | 403,
  code: AgencyAgentRetryErrorCode,
  message: string,
  details?: Record<string, unknown>,
): FastifyReply {
  return sendRefusal(reply, status, code, message, { details, badRequestTitle: VALIDATION_FAILED_TITLE });
}

export async function registerMyContactCallRoutes(sub: FastifyInstance, runtime: AgencyRuntime): Promise<void> {
  sub.post('/sessions/:id/my-contact-call', async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    // The session routes' shared guard first, as on every `/sessions/:id` route: no actor is
    // 400 `missing_actor`, another agent's (or a missing) session the not-found 404, a left one
    // `409 session_ended`. The public route answers those as `agent_not_available`.
    const session = await requireOwnedSession(request, reply);
    if (!session) return reply;
    // The kill switch, re-read on every dial as pacing re-reads it each tick: an account whose
    // dialer was turned off stops dialling even while a campaign row still says `running`, and
    // a dial placed for it cannot be un-dialled.
    if (!(await getFeatureFlagService().isEnabled(FLAGS.agency_dialer_enabled, {
      tenantId: getTenantId(request), accountId: getAccountId(request),
    }))) {
      return refuse(reply, 403, 'feature_disabled', MY_CONTACT_CALL_MESSAGES.feature_disabled);
    }
    const body = (request.body ?? {}) as MyContactCallBody;
    // Validated at the edge: a non-UUID reaching a `uuid` cast is a 22P02, not an answer.
    if (typeof body.contact_id !== 'string' || !UUID_RE.test(body.contact_id)) {
      return refuse(reply, 404, 'contact_not_found', MY_CONTACT_CALL_MESSAGES.contact_not_found);
    }
    if (typeof body.campaign_id !== 'string' || !UUID_RE.test(body.campaign_id)) {
      return refuse(reply, 409, 'agent_not_available', MY_CONTACT_CALL_MESSAGES.agent_not_available);
    }
    const result = await startMyContactCall(
      {
        agents: runtime.agents,
        breaks: runtime.breaks,
        stations: runtime.stations,
        dnc: runtime.dnc,
        dispatcher: runtime.dispatcher,
        dialer: runtime.dialer,
        callerIds: runtime.dedications,
      },
      {
        tenantId: getTenantId(request),
        accountId: getAccountId(request),
        session,
        actorUserId: session.agent_user_id,
        campaignId: body.campaign_id,
        contactId: body.contact_id,
        overrideNote: typeof body.override_note === 'string' ? body.override_note : null,
      },
    );
    if (!result.ok) return refuse(reply, result.status, result.code, result.message, result.details);
    // `basis` rides along for the public route's audit row; the console reads the contract fields.
    return reply.send({ ...result.response, basis: result.basis });
  });
}
