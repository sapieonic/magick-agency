import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { createChildLogger } from '@magick-agency/observability';
import { SOFTPHONE_BREAK_REASON, type AgencyHelpResponse, type AgencySupervisorMessageResponse } from '@magick-agency/contracts/agency';
import type { AgencyRuntime } from '../../../agency/runtime.js';
import { FLOOR_ASSIST_REFUSAL_MESSAGES, normaliseMessageText, senderNameForFrame } from '../../../agency/floor-assist.js';
import type { AgencyAgentSessionRecord } from '../../../db/models/agency.model.js';
import {
  agencyAgentSessionRepository,
  agencyFloorAssistRepository,
  agencyManualCallRepository,
} from '../../../db/repositories/agency.repository.js';
import { getAccountId, getTenantId } from '../../middleware/auth.middleware.js';
import { sendRefusal } from '../helpers/refusal.js';
import { requireOwnedSession } from './helpers.js';

const log = createChildLogger({ component: 'agency-floor-assist-routes' });

/*
 * Floor assist's internal handlers (LF4, LF5; `agency/floor-assist.ts`), on the internal instance
 * behind `callCore` (B16). The public layer (`proxy-agency-floor-assist.routes.ts`) has run the
 * session, the tenant context, the permission, the account scope, the floor assist flag and the
 * actor (and, for a message, the text and the sender's name). Every one is owned by the session
 * (`session_param`, `api/core-owners.ts`): it runs in the process holding the agent's station,
 * which knows the agent's call and wrap-up, and whether a station that can receive a message is
 * attached.
 *
 *  - `POST /sessions/:id/help`: the caller's own live session (`requireOwnedSession`: anyone
 *    else's is the uniform 404, a session that has ended `409 session_ended`), on a call or in
 *    wrap-up (`409 help_not_on_call`); raises the request, or answers the one already open.
 *  - `POST /sessions/:id/help/cancel` (the public `DELETE /sessions/:id/help`; `callCore` sends no
 *    body on a DELETE, and the actor rides in the body): cancels the open request, if any.
 *  - `POST /supervisor-messages` (the public `POST /sessions/:id/messages`; owner `body_session`,
 *    the body's `session_id`): a session of the caller's account (anyone else's is the uniform 404)
 *    whose station here can receive it; `409 agent_not_live` otherwise. Not under `/sessions/:id`,
 *    as the listen grant is not: those internal routes are the session's own agent's actions (Q8,
 *    `requireOwnedSession`), and a message is a supervisor's on someone else's session.
 */

/** Whether the session's agent is on a call or finishing one: what Need help needs (LF4). */
async function onCallOrWrapup(runtime: AgencyRuntime, session: AgencyAgentSessionRecord): Promise<boolean> {
  const lease = await runtime.agents.get(session.id);
  // The lease is the authority; the row's mirror when Redis could not answer.
  const state = lease?.state ?? session.state;
  if (state === 'on_call' || state === 'wrapup') return true;
  // A soft-phone call: the session stays on the `soft_phone` break through it (docs/softphone.md §2).
  if (lease?.manualCallId || runtime.softphone.hasLiveCall(session.id)) return true;
  if (runtime.inbound?.findCallForSession(session.id)?.phase === 'connected') return true;
  if (session.kind === 'softphone' || (state === 'break' && session.break_reason === SOFTPHONE_BREAK_REASON)) {
    // Its call ended and owes its outcome: the soft phone's wrap-up.
    return (await agencyManualCallRepository.findUnsettledForSession(session.id)) !== null;
  }
  return false;
}

const messageBodySchema = z.object({
  session_id: z.string().uuid(),
  text: z.string(),
  sender_user_id: z.string().uuid(),
  // The public layer read it on the server and cut it already; cut again here, never refused (LF17).
  from_name: z.string().nullable().transform((name) => senderNameForFrame(name)),
}).strict();

const SESSION_NOT_FOUND = { error: 'Not Found', message: 'Session not found' } as const;

export async function registerFloorAssistRoutes(sub: FastifyInstance, runtime: AgencyRuntime): Promise<void> {
  // ── POST /sessions/:id/help ──────────────────────────────────────────────
  sub.post('/sessions/:id/help', async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const session = await requireOwnedSession(request, reply);
    if (!session) return reply;
    if (!(await onCallOrWrapup(runtime, session))) {
      return sendRefusal(reply, 409, 'help_not_on_call', FLOOR_ASSIST_REFUSAL_MESSAGES.help_not_on_call);
    }
    // The call it is raised on, for the floor's card and its Listen; null in wrap-up. Never fails the raise.
    const callId = await agencyFloorAssistRepository.liveCallIdForSession(session.id, session.tenant_id).catch((err: unknown) => {
      log.warn({ err, sessionId: session.id }, 'Could not read the call Need help was raised on; raising it without one');
      return null;
    });
    const out = await runtime.floorAssist.raise(session, callId);
    if (!out.help) {
      // The session left between the ownership check and the raise.
      return reply.code(409).send({ error: 'Session Ended', code: 'session_ended', message: 'This session has ended. Start a new one.' });
    }
    const body: AgencyHelpResponse = { session_id: session.id, help: out.help };
    return reply.send(body);
  });

  // ── POST /sessions/:id/help/cancel (the public DELETE) ───────────────────
  sub.post('/sessions/:id/help/cancel', async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const session = await requireOwnedSession(request, reply);
    if (!session) return reply;
    await runtime.floorAssist.cancel(session);
    const body: AgencyHelpResponse = { session_id: session.id, help: null };
    return reply.send(body);
  });

  // ── POST /supervisor-messages (the public POST /sessions/:id/messages) ─────
  sub.post('/supervisor-messages', async (request: FastifyRequest<{ Body: unknown }>, reply: FastifyReply) => {
    const parsed = messageBodySchema.safeParse(request.body);
    const text = parsed.success ? normaliseMessageText(parsed.data.text) : null;
    if (!parsed.success || text === null) {
      return sendRefusal(reply, 400, 'message_invalid', FLOOR_ASSIST_REFUSAL_MESSAGES.message_invalid);
    }
    const session = await agencyAgentSessionRepository.findById(parsed.data.session_id.toLowerCase());
    // Another account's or tenant's session is the same 404 as one that does not exist.
    if (!session || session.tenant_id !== getTenantId(request) || session.account_id !== getAccountId(request)) {
      return reply.code(404).send(SESSION_NOT_FOUND);
    }
    if (session.left_at) {
      return sendRefusal(reply, 409, 'agent_not_live', FLOOR_ASSIST_REFUSAL_MESSAGES.agent_not_live);
    }
    const out = await runtime.floorAssist.sendMessage({
      session, senderUserId: parsed.data.sender_user_id, fromName: parsed.data.from_name, text,
    });
    if (!out.ok) return sendRefusal(reply, 409, out.code, FLOOR_ASSIST_REFUSAL_MESSAGES[out.code]);
    const body: AgencySupervisorMessageResponse = {
      id: out.id, session_id: session.id, sent_at: out.sent_at.toISOString(), delivered: true,
    };
    return reply.code(201).send(body);
  });
}
