import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { sessionMiddleware } from '../../auth/session.middleware.js';
import { tenantContextMiddleware } from '../middleware/tenant-context.middleware.js';
import { requirePermission } from '../../rbac/rbac.middleware.js';
import { callCore, type CoreCallRequest, type CoreCallResult } from '../core-dispatch.js';
import { resolveAgencyActor } from '../../agency/agency-actor.js';
import { agentNamesOrNone } from '../../agency/agency-agent-identity.js';
import { FLOOR_ASSIST_REFUSAL_MESSAGES, normaliseMessageText, senderNameForFrame } from '../../agency/floor-assist.js';
import { FLAGS, getFeatureFlagService } from '../../feature-flags/index.js';
import { accountOrRefuse } from './helpers/account-scope.js';
import { sendRefusal } from './helpers/refusal.js';

/*
 * Floor assist's public routes (the Live floor's Phase 3; LF4, LF5, LF11; contracts
 * `agency/floor-assist.ts`), at the console's paths under `/proxy/agency`, beside the agent's own
 * session routes. The public layer of B16: each runs the session and the tenant context (the hooks
 * below), its permission, the account scope (`400 account_scope_required`), then the floor assist
 * flag (`403 floor_assist_disabled`), in that order, then hands the request to the internal handler
 * (`agency/floor-assist.ts`, through `callCore`), which runs where the agent's station is.
 *
 *  - `POST /sessions/:id/help` and `DELETE /sessions/:id/help` (`agency.station.connect`, the floor
 *    of the agent's own session routes): Need help raised and cancelled on the CALLER's own session.
 *    The actor is the authenticated user (`resolveAgencyActor`; nothing a client sends names it),
 *    and the internal handler's `requireOwnedSession` answers anyone else's session (a colleague's,
 *    another account's, another tenant's) with the uniform 404, a supervisor's included: a
 *    supervisor does not raise help for an agent.
 *  - `POST /sessions/:id/messages` (`agency.supervise`): Talk to agent and Send reminder. Body
 *    `{ text }`, trimmed, 1 to 500 characters with no control character but tab and line break
 *    (`400 message_invalid`, LF17); the sender's name read here for the frame and cut to its length
 *    (`senderNameForFrame`), never refused. A session outside the caller's account is the uniform 404.
 *
 * Audit rows, frames and metrics are the runtime's (`agency/floor-assist.ts`), written once per
 * transition wherever it happens (a listen, the expiry sweep and a leave end requests too).
 */

/** What the routes read besides the request. Tests replace it. */
export interface FloorAssistRouteDeps {
  callCore(req: CoreCallRequest): Promise<CoreCallResult>;
  /** `agency_floor_assist_enabled` for the account; a read that throws fails the request (closed). */
  floorAssistEnabled(tenantId: string, accountId: string): Promise<boolean>;
  names(ids: Iterable<string | null>, tenantId: string): Promise<Map<string, string | null>>;
}

const defaultDeps: FloorAssistRouteDeps = {
  callCore,
  floorAssistEnabled: (tenantId, accountId) => getFeatureFlagService().isEnabled(FLAGS.agency_floor_assist_enabled, { tenantId, accountId }),
  names: (ids, tenantId) => agentNamesOrNone(ids, tenantId, 'floor assist'),
};

export interface ProxyAgencyFloorAssistOptions {
  deps?: FloorAssistRouteDeps;
}

/** The message body: `text` only (anything else a client sends is dropped). */
const messageSchema = z.object({ text: z.unknown() });

export async function proxyAgencyFloorAssistRoutes(app: FastifyInstance, opts: ProxyAgencyFloorAssistOptions = {}): Promise<void> {
  const deps = opts.deps ?? defaultDeps;
  app.addHook('preHandler', sessionMiddleware);
  app.addHook('preHandler', tenantContextMiddleware);

  /** The account, then the floor assist flag; null once it has replied. */
  async function scope(request: FastifyRequest, reply: FastifyReply): Promise<{ tenantId: string; accountId: string } | null> {
    // The tenant context middleware has lower-cased both ids.
    const accountId = accountOrRefuse(request.accountId, reply, 'Floor assist is one account\'s. Send X-Account-Id.');
    if (!accountId) return null;
    const tenantId = request.tenantId!;
    if (!(await deps.floorAssistEnabled(tenantId, accountId))) {
      void sendRefusal(reply, 403, 'floor_assist_disabled', FLOOR_ASSIST_REFUSAL_MESSAGES.floor_assist_disabled);
      return null;
    }
    return { tenantId, accountId };
  }

  /** Need help, raised or cancelled, on the caller's own session. */
  async function help(
    request: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply,
    call: { method: 'POST'; path: string },
  ): Promise<FastifyReply> {
    const scoped = await scope(request, reply);
    if (!scoped) return reply;
    const actor = resolveAgencyActor(request);
    if (!actor.ok) return reply.code(400).send({ error: 'Bad Request', code: actor.code, message: actor.message });
    const result = await deps.callCore({
      method: call.method,
      path: call.path,
      // The actor only: `requireOwnedSession` compares it with the session's agent. `on_behalf` is
      // sent as resolved and ignored there (no supervisor raises help for an agent).
      body: { ...actor.actor },
      ...scoped,
    });
    return reply.code(result.status).send(result.body);
  }

  // ── POST /sessions/:id/help ──────────────────────────────────────────────
  app.post<{ Params: { id: string } }>(
    '/sessions/:id/help',
    { preHandler: [requirePermission('agency.station.connect')] },
    (request, reply) => help(request, reply, { method: 'POST', path: `/agency/sessions/${request.params.id}/help` }),
  );

  // ── DELETE /sessions/:id/help ────────────────────────────────────────────
  app.delete<{ Params: { id: string } }>(
    '/sessions/:id/help',
    { preHandler: [requirePermission('agency.station.connect')] },
    // The public DELETE is an internal POST: `callCore` sends no body on a DELETE, and the actor rides in it.
    (request, reply) => help(request, reply, { method: 'POST', path: `/agency/sessions/${request.params.id}/help/cancel` }),
  );

  // ── POST /sessions/:id/messages ──────────────────────────────────────────
  app.post<{ Params: { id: string }; Body: unknown }>(
    '/sessions/:id/messages',
    { preHandler: [requirePermission('agency.supervise')] },
    async (request, reply) => {
      const me = request.user!.id;
      // The sender's name, read beside the account and flag checks; cut to the frame's length, never
      // a reason to refuse the message (LF17). A request refused below never waits for it.
      const fromNameRead = deps.names([me], request.tenantId!).then((names) => senderNameForFrame(names.get(me)));
      fromNameRead.catch(() => undefined);
      const scoped = await scope(request, reply);
      if (!scoped) return reply;
      const parsed = messageSchema.safeParse(request.body ?? {});
      const text = parsed.success ? normaliseMessageText(parsed.data.text) : null;
      if (text === null) return sendRefusal(reply, 400, 'message_invalid', FLOOR_ASSIST_REFUSAL_MESSAGES.message_invalid);
      const fromName = await fromNameRead;
      const result = await deps.callCore({
        method: 'POST',
        path: '/agency/supervisor-messages',
        // The session in the body: the internal route is owned by it (`body_session`).
        body: { session_id: request.params.id.toLowerCase(), text, sender_user_id: me, from_name: fromName },
        ...scoped,
      });
      return reply.code(result.status).send(result.body);
    },
  );
}
