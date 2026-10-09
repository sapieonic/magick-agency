/*
 * The agent's session and attempt routes, served at the console's paths under `/proxy/agency`
 * (decision B16). Each handler validates the body, applies its RBAC floor
 * (`agency.station.connect`, `agency.attempts.handle|dispose`, `agency.dnc.write` +
 * `agency.dnc.manage` for a tenant-wide mark, `agency.supervise`) and asserts the actor, then
 * runs the internal handler instance's body (`agency.routes.ts`, sessions and attempts)
 * in-process through `callCore` (`../core-dispatch.ts`) with the request's tenant and account.
 * These routes also rewrite `station_ws_url` and write the eight `platform_audit_log` rows
 * (`platformAuditLogger`, decision B7). `callCore` refuses a path-escaping path with a fixed 400.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { sessionMiddleware } from '../../auth/session.middleware.js';
import { tenantContextMiddleware } from '../middleware/tenant-context.middleware.js';
import { requirePermission } from '../../rbac/rbac.middleware.js';
import { callCore } from '../core-dispatch.js';
import { createChildLogger } from '@magick-agency/observability';
import { rewriteStationWsUrl } from './proxy-agency-station.routes.js';
import { rejectPathEscapingParams } from './helpers/path-params.js';
import { resolveAgencyActor, type AgencyActorFields } from '../../agency/agency-actor.js';
import { platformAuditLogger } from '../../audit/platform/audit-logger.js';
import { requestAuditActor, resolvedUserAuditActor } from '../../audit/platform/audit-actor.js';

const log = createChildLogger({ component: 'proxy-agency-agent' });

/**
 * Best-effort extraction of a string field from the internal handler's response
 * body for the audit trail. The response is passed through untyped, so this
 * narrows defensively rather than trusting the body, and a malformed/unexpected
 * response must never throw out of an audit call and take the request down
 * with it.
 */
function extractStringField(body: unknown, field: string): string | undefined {
  if (body && typeof body === 'object' && field in body) {
    const value = (body as Record<string, unknown>)[field];
    return typeof value === 'string' ? value : undefined;
  }
  return undefined;
}

function accountAudit(request: FastifyRequest): { tenant_id: string; account_id?: string } {
  return {
    tenant_id: request.tenantId!,
    ...(request.accountId ? { account_id: request.accountId } : {}),
  };
}

/**
 * Agent-native surfaces for the Agency Dialer: session lifecycle and the three
 * actions an agent takes on the call currently on their station.
 *
 * ── Why these exist rather than reusing the generic call routes ─────────────
 * Two independent reasons, and both matter.
 *
 * 1. **RBAC.** The role hierarchy puts `agent` at level 5, deliberately below
 *    every other permission floor, so an agent cannot reach a generic call
 *    route — by design, not by oversight. Every agent action therefore needs a
 *    surface floored at `agent`.
 * 2. **Ownership.** The internal handler verifies the caller **is the reserved
 *    agent for that attempt**, which a generic call route has no way to express.
 *
 * The internal handler owns the business rules; these routes add
 * only RBAC, the actor and the tenant/account context. Do not mirror the
 * disposition-catalog rules here — a second copy of a rule is a second copy
 * that goes stale.
 *
 * ── The 403 that must not be flattened ─────────────────────────────────────
 * The internal handler answers 403 `not_your_attempt` for a caller who is not
 * the reserved agent. `error-mask.middleware.ts` passes every 4xx through, so
 * the console sees that code rather than "contact support and quote this
 * request id", which on an agent's screen between live calls would be
 * indistinguishable from an outage.
 */

/**
 * Note what these schemas deliberately do NOT declare: `agent_user_id` and
 * `on_behalf`. Zod strips unknown keys, so a client that sends either — a stale
 * console, or an agent trying to file a disposition under a colleague's name —
 * has them dropped before the body reaches the internal handler, and the route
 * then attaches the pair it derived from the session itself. Attribution is
 * never client-supplied.
 */
const dispositionSchema = z.object({
  disposition_code: z.string().min(1).max(50),
  notes: z.string().max(4000).optional(),
  callback_at: z.string().datetime().optional(),
});

/**
 * Notes are a wholesale replacement and an empty string clears them, so `min(1)`
 * would make "clear my notes" unexpressible. The 4000 ceiling matches the notes
 * field on the disposition body — one limit for one column.
 */
const notesSchema = z.object({
  notes: z.string().max(4000),
});

const dncSchema = z.object({
  reason: z.string().max(1000).optional(),
  disposition_code: z.string().min(1).max(50).optional(),
  /**
   * How far this suppression reaches. **This field must not be stripped.** If
   * the schema declared only `reason` and `disposition_code`, Zod's default
   * strip would delete the `scope` the browser sent, the handler would forward
   * `parsed.data` without it, and the request would answer 200 — a silent scope
   * error on a terminal compliance write, which is the exact failure class
   * campaign-scoped DNC exists to prevent. Nothing would observe it, because
   * every step is internally consistent: the browser sends a field, the route
   * answers 200, the internal handler writes the scope it defaults to.
   *
   * **Absent means `'campaign'`** — the narrower, safer scope — and that
   * direction is deliberate rather than incidental. A console built before this
   * field existed sends no `scope`, and the cost of guessing wrong has to fall
   * on the recoverable side: a campaign-scoped mark that should have been
   * tenant-wide under-blocks one campaign and is fixed by marking again, while
   * the reverse silently suppresses a number across every campaign in the
   * tenant and is not reversible by the agent who caused it.
   *
   * Absent is forwarded to the internal handler as absent, not normalised to
   * `'campaign'` here. The handler owns the default; a second copy of it in this
   * route is a second copy that goes stale, and the two would then disagree
   * without either side erroring.
   */
  scope: z.enum(['campaign', 'tenant']).optional(),
});

/**
 * The second, higher floor the tenant-wide arm of mark-DNC carries. Hoisted
 * because `requirePermission` is a factory and this one is not attached to a
 * route — see the escalation gate in the `/attempts/:id/dnc` handler for why it
 * cannot be a `preHandler`.
 */
const requireDncManage = requirePermission('agency.dnc.manage');

/**
 * What the **browser** may say. `agent_user_id` is deliberately absent: which
 * agent is joining is the server's fact, taken from the authenticated session below,
 * not something a client gets to assert — a browser that could name the agent
 * could go available as a colleague.
 */
const createSessionSchema = z.object({
  campaign_id: z.string().uuid(),
  session_id: z.string().uuid().optional(),
});

const breakSchema = z.object({
  reason: z.string().min(1).max(50),
});

/** Free text, recorded on the internal handler's audit event for the override. */
const forceAvailableSchema = z.object({
  reason: z.string().max(1000).optional(),
});

/**
 * Decision Q8: the actor for a SESSION route. station-token / available / break /
 * break-cancel / leave / force-available all send the same pair the attempt actions
 * do (`resolveAgencyActor`: the authenticated user, plus `on_behalf` only for
 * `agency.supervise`), so the internal handler's `requireOwnedSession` refuses a
 * caller who is not the session's agent unless the route lets a supervisor act.
 * Without it, that check could only compare tenant + account and an agent could act
 * on a colleague's session. Spread LAST into the body, so nothing a client sent can
 * name the actor (the zod schemas strip it anyway).
 */
function sessionActorOrRefuse(
  request: FastifyRequest,
  reply: FastifyReply,
): AgencyActorFields | null {
  const actor = resolveAgencyActor(request);
  if (!actor.ok) {
    void reply.code(400).send({ error: 'Bad Request', code: actor.code, message: actor.message });
    return null;
  }
  return actor.actor;
}

export async function proxyAgencyAgentRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', sessionMiddleware);
  app.addHook('preHandler', tenantContextMiddleware);
  // No capability gate: the app is the agency product, so the section-level `agency` gate
  // is always on. The `agency_dialer_enabled` feature flag and the RBAC floors below are
  // the gates.
  /*
   * Every `:id` here — a session id or an attempt id — is interpolated into an
   * internal handler path, and find-my-way hands the handler a percent-DECODED param.
   *
   * ── Stated honestly: on THIS plugin the hook is defence in depth ──────────
   *
   * The dot-segment family is already refused by `callCore`'s `isUnsafeCorePath`
   * check (`src/proxy/safe-core-path.ts`). What that check allows is a bare extra
   * slash — which on the sibling campaigns plugin is a real escalation, because
   * its `GET /campaigns/:id` puts the param in the LAST segment. Here every route
   * appends its own action after the param (`/available`, `/leave`,
   * `/station-token`, `/hangup`, `/disposition`, `/notes`, `/dnc`), so extra
   * segments land in the middle and produce a 404 rather than a different
   * internal handler route. No exploit is known through these routes today.
   *
   * It is registered anyway, and the reason is the shape of the risk rather than
   * a current bug: the floor here is `agency.station.connect`, which sits at
   * **agent (level 5)** — the lowest floor in the service — and every one of
   * these routes is a POST. A route added later that ends in its param, or an
   * internal action renamed so a param's suffix stops being unique, turns "no known
   * exploit" into a WRITE aimed somewhere nobody granted. A plugin hook costs one
   * line and cannot be forgotten by the next route; the alternative is relying on
   * whoever adds it to notice.
   *
   * See `path-params.ts` for why this rejects rather than encodes, and why the
   * character class rather than a uuid check is what closes the hole without
   * changing behaviour for any request that was not already an exploit.
   */
  app.addHook('preHandler', rejectPathEscapingParams());

  /**
   * POST /proxy/agency/sessions — an agent joins a campaign.
   *
   * The response's `station_ws_url` is rewritten onto `/proxy/agency/station`:
   * the internal handler mints it as `/api/v1/agency/station/<id>`, which is not
   * a registered route; the console connects to the proxy path. The query string
   * (which carries the station token) is preserved as-is — this route neither
   * mints nor validates it.
   */
  app.post('/sessions', {
    preHandler: requirePermission('agency.station.connect'),
  }, async (request, reply) => {
    const parsed = createSessionSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Validation Error', details: parsed.error.flatten() });
    }

    // The internal handler's `POST /agency/sessions` requires `agent_user_id`, and
    // `parsed.data` never carries one — without it every join 400s and no agent can
    // reach a campaign. Refusing here when there is no actor hands the console the
    // same error shape the disposition and notes handlers produce.
    //
    // Only `agent_user_id` is threaded, never the whole actor: `on_behalf` answers
    // "may this user act on an attempt they did not take", and there is no
    // equivalent for joining — a supervisor cannot go available as someone else.
    const actor = resolveAgencyActor(request);
    if (!actor.ok) {
      return reply.code(400).send({ error: 'Bad Request', code: actor.code, message: actor.message });
    }

    const result = await callCore({
      method: 'POST',
      path: '/agency/sessions',
      body: { ...parsed.data, agent_user_id: actor.actor.agent_user_id },
      tenantId: request.tenantId!,
      accountId: request.accountId,
    });

    if (result.status < 400 && result.body && typeof result.body === 'object') {
      const body = result.body as Record<string, unknown>;
      if (typeof body['station_ws_url'] === 'string') {
        body['station_ws_url'] = rewriteStationWsUrl(body['station_ws_url']);
      }
      log.info(
        { tenantId: request.tenantId, campaignId: parsed.data.campaign_id },
        'Agency session created',
      );
    }
    if (result.status < 400) {
      const sessionId = extractStringField(result.body, 'session_id');
      platformAuditLogger.log({
        ...accountAudit(request),
        ...resolvedUserAuditActor(request, actor.actor.agent_user_id),
        action: 'agency_session.joined',
        resource_type: 'agency_session',
        ...(sessionId ? { resource_id: sessionId } : {}),
        campaign_id: parsed.data.campaign_id,
        details: { campaign_id: parsed.data.campaign_id },
      });
    }

    return reply.code(result.status).send(result.body);
  });

  /**
   * Session state transitions: `available`, `leave`, `station-token`, `break`,
   * `break/cancel`, and the supervisor's `force-available`.
   */
  app.post<{ Params: { id: string } }>('/sessions/:id/available', {
    preHandler: requirePermission('agency.station.connect'),
  }, async (request, reply) => {
    const actor = sessionActorOrRefuse(request, reply);
    if (!actor) return reply;
    const result = await callCore({
      method: 'POST',
      path: `/agency/sessions/${request.params.id}/available`,
      body: { ...actor },
      tenantId: request.tenantId!,
      accountId: request.accountId,
    });
    return reply.code(result.status).send(result.body);
  });

  app.post<{ Params: { id: string } }>('/sessions/:id/leave', {
    preHandler: requirePermission('agency.station.connect'),
  }, async (request, reply) => {
    const actor = sessionActorOrRefuse(request, reply);
    if (!actor) return reply;
    const result = await callCore({
      method: 'POST',
      path: `/agency/sessions/${request.params.id}/leave`,
      body: { ...actor },
      tenantId: request.tenantId!,
      accountId: request.accountId,
    });
    if (result.status < 400) {
      const campaignId = extractStringField(result.body, 'campaign_id');
      platformAuditLogger.log({
        ...accountAudit(request),
        ...requestAuditActor(request),
        action: 'agency_session.left',
        resource_type: 'agency_session',
        resource_id: request.params.id,
        ...(campaignId ? { campaign_id: campaignId, details: { campaign_id: campaignId } } : {}),
      });
    }
    return reply.code(result.status).send(result.body);
  });

  /**
   * POST /proxy/agency/sessions/:id/station-token — mint a fresh upgrade token.
   *
   * The station token is **single-use and lives ~2 minutes**, rather than
   * being a shift-length bearer sitting in a query string, so a reconnect needs
   * a new one. Deliberately cheap and separate from bootstrap: a reconnect
   * needs a token, not the whole campaign config again.
   *
   * Its `station_ws_url` gets the same rewrite as bootstrap's, onto
   * `/proxy/agency/station`, the path the console connects to.
   */
  app.post<{ Params: { id: string } }>('/sessions/:id/station-token', {
    preHandler: requirePermission('agency.station.connect'),
  }, async (request, reply) => {
    const actor = sessionActorOrRefuse(request, reply);
    if (!actor) return reply;
    const result = await callCore({
      method: 'POST',
      path: `/agency/sessions/${request.params.id}/station-token`,
      body: { ...actor },
      tenantId: request.tenantId!,
      accountId: request.accountId,
      metricPath: '/agency/sessions/:id/station-token',
    });

    if (result.status < 400 && result.body && typeof result.body === 'object') {
      const body = result.body as Record<string, unknown>;
      if (typeof body['station_ws_url'] === 'string') {
        body['station_ws_url'] = rewriteStationWsUrl(body['station_ws_url']);
      }
    }
    return reply.code(result.status).send(result.body);
  });

  app.post<{ Params: { id: string } }>('/sessions/:id/break', {
    preHandler: requirePermission('agency.station.connect'),
  }, async (request, reply) => {
    const parsed = breakSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Validation Error', details: parsed.error.flatten() });
    }
    const actor = sessionActorOrRefuse(request, reply);
    if (!actor) return reply;
    const result = await callCore({
      method: 'POST',
      path: `/agency/sessions/${request.params.id}/break`,
      body: { ...parsed.data, ...actor },
      tenantId: request.tenantId!,
      accountId: request.accountId,
      metricPath: '/agency/sessions/:id/break',
    });
    if (result.status < 400) {
      const campaignId = extractStringField(result.body, 'campaign_id');
      platformAuditLogger.log({
        ...accountAudit(request),
        ...requestAuditActor(request),
        action: 'agency_session.break_started',
        resource_type: 'agency_session',
        resource_id: request.params.id,
        ...(campaignId ? { campaign_id: campaignId } : {}),
        details: {
          reason: parsed.data.reason,
          ...(campaignId ? { campaign_id: campaignId } : {}),
        },
      });
    }
    return reply.code(result.status).send(result.body);
  });

  /**
   * POST /proxy/agency/sessions/:id/break/cancel — take back a **queued** break.
   *
   * A break requested while `on_call` is queued and applied at the end of
   * wrap-up, so there is a window — the rest of the conversation plus the
   * wrap-up — in which the agent has asked for a break and not yet got one.
   * `/available` operates on the current state and leaves `pending_state` alone,
   * so without this route changing your mind in that window is impossible and
   * the break lands anyway.
   *
   * Same `agency.station.connect` floor as the other session transitions: this
   * is the agent's own presence, not a supervisory act.
   */
  app.post<{ Params: { id: string } }>('/sessions/:id/break/cancel', {
    preHandler: requirePermission('agency.station.connect'),
  }, async (request, reply) => {
    const actor = sessionActorOrRefuse(request, reply);
    if (!actor) return reply;
    const result = await callCore({
      method: 'POST',
      path: `/agency/sessions/${request.params.id}/break/cancel`,
      body: { ...actor },
      tenantId: request.tenantId!,
      accountId: request.accountId,
      metricPath: '/agency/sessions/:id/break/cancel',
    });
    if (result.status < 400) {
      const campaignId = extractStringField(result.body, 'campaign_id');
      platformAuditLogger.log({
        ...accountAudit(request),
        ...requestAuditActor(request),
        action: 'agency_session.break_cancelled',
        resource_type: 'agency_session',
        resource_id: request.params.id,
        ...(campaignId ? { campaign_id: campaignId, details: { campaign_id: campaignId } } : {}),
      });
    }
    return reply.code(result.status).send(result.body);
  });

  /**
   * POST /proxy/agency/sessions/:id/force-available — supervisor override.
   *
   * ── Why this is a different route with a different floor ───────────────────
   * `POST /sessions/:id/available` **refuses while a disposition is
   * outstanding**. That refusal is the only thing making a required disposition
   * required: collapse "I'm ready" and "I'm done writing up" into one control
   * and an agent skips every disposition by clicking Available.
   *
   * So this override — the one route that CAN end a held wrap-up — is gated at
   * `agency.supervise`, which an `agent` (level 5) cannot reach.
   * **The person who benefits from skipping a disposition cannot call the route
   * that skips it.** Get this floor wrong and the hole re-opens while looking
   * exactly like a working feature, which is why it is asserted against the
   * permission matrix rather than by inspection.
   *
   * The attempt is left `no_disposition`, identical to what the reaper's sweep
   * would have written, so forced and swept returns produce one shape of data.
   */
  app.post<{ Params: { id: string } }>('/sessions/:id/force-available', {
    preHandler: requirePermission('agency.supervise'),
  }, async (request, reply) => {
    const parsed = forceAvailableSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Validation Error', details: parsed.error.flatten() });
    }

    const actor = sessionActorOrRefuse(request, reply);
    if (!actor) return reply;
    const result = await callCore({
      method: 'POST',
      path: `/agency/sessions/${request.params.id}/force-available`,
      body: { ...parsed.data, ...actor },
      tenantId: request.tenantId!,
      accountId: request.accountId,
      metricPath: '/agency/sessions/:id/force-available',
    });

    if (result.status < 400) {
      log.info(
        { tenantId: request.tenantId, sessionId: request.params.id, actingUserId: request.user?.id },
        'Supervisor forced an agent back to available',
      );
      const campaignId = extractStringField(result.body, 'campaign_id');
      platformAuditLogger.log({
        ...accountAudit(request),
        ...requestAuditActor(request),
        action: 'agency_session.force_available',
        resource_type: 'agency_session',
        resource_id: request.params.id,
        ...(campaignId ? { campaign_id: campaignId } : {}),
        details: {
          ...(parsed.data.reason ? { reason: parsed.data.reason } : {}),
          ...(campaignId ? { campaign_id: campaignId } : {}),
        },
      });
    }
    return reply.code(result.status).send(result.body);
  });

  /**
   * POST /proxy/agency/attempts/:id/hangup — the agent hangs up the live call.
   *
   * Floored at `agency.attempts.handle`. **This is the only hangup surface.**
   * The station socket acts only on `ping` and `media`; its `hangup` control
   * frame is withdrawn in the contract (`AgencyStationHangupFrame` is deprecated).
   *
   * Attributed like disposition and notes, and for the same reason: the internal
   * handler checks the caller **is** the reserved agent, and it cannot do that
   * without an actor. With no body the ownership rule could never run, and any
   * tenant member holding `agency.attempts.handle`, which is every agent, could
   * hang up any other agent's live call.
   */
  app.post<{ Params: { id: string } }>('/attempts/:id/hangup', {
    preHandler: requirePermission('agency.attempts.handle'),
  }, async (request, reply) => {
    const actor = resolveAgencyActor(request);
    if (!actor.ok) {
      return reply.code(400).send({ error: 'Bad Request', code: actor.code, message: actor.message });
    }

    const result = await callCore({
      method: 'POST',
      path: `/agency/attempts/${request.params.id}/hangup`,
      // The whole actor, unlike `/sessions`: a supervisor ending a call an agent
      // is stuck on is a real action, and `on_behalf` is what lets the handler allow it
      // without pretending the supervisor was the reserved agent.
      body: { ...actor.actor },
      tenantId: request.tenantId!,
      accountId: request.accountId,
      metricPath: '/agency/attempts/:id/hangup',
    });
    if (result.status < 400) {
      const campaignId = extractStringField(result.body, 'campaign_id');
      platformAuditLogger.log({
        ...accountAudit(request),
        ...resolvedUserAuditActor(request, actor.actor.agent_user_id),
        action: 'agency_attempt.hung_up',
        resource_type: 'agency_attempt',
        resource_id: request.params.id,
        ...(campaignId ? { campaign_id: campaignId } : {}),
        details: {
          ...(actor.actor.on_behalf ? { on_behalf: true } : {}),
          ...(campaignId ? { campaign_id: campaignId } : {}),
        },
      });
    }
    return reply.code(result.status).send(result.body);
  });

  /**
   * POST /proxy/agency/attempts/:id/disposition — outcome, notes, callback.
   *
   * `requires_note` / `requires_datetime` come from the campaign's disposition
   * catalog and are enforced by the internal handler, not here. The schema above only bounds
   * shape and size; conditional requirements live where the catalog lives.
   *
   * Carries `AgencyActorFields`. This route attributes the action and asserts
   * whether the caller supervises; the internal handler decides whether that is
   * allowed against the attempt's reserved agent. See `src/agency/agency-actor.ts`
   * for how the check is divided between the two.
   */
  app.post<{ Params: { id: string } }>('/attempts/:id/disposition', {
    preHandler: requirePermission('agency.attempts.dispose'),
  }, async (request, reply) => {
    const parsed = dispositionSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Validation Error', details: parsed.error.flatten() });
    }

    const actor = resolveAgencyActor(request);
    if (!actor.ok) {
      return reply.code(400).send({ error: 'Bad Request', code: actor.code, message: actor.message });
    }

    const result = await callCore({
      method: 'POST',
      path: `/agency/attempts/${request.params.id}/disposition`,
      body: { ...parsed.data, ...actor.actor },
      tenantId: request.tenantId!,
      accountId: request.accountId,
      metricPath: '/agency/attempts/:id/disposition',
    });

    if (result.status < 400 && actor.actor.on_behalf) {
      // Worth a line of its own: a disposition filed by someone other than the
      // agent who took the call is the audit case this flag exists for; the
      // internal handler records it on the attempt, but this log line is where
      // an operator looks first.
      log.info(
        { tenantId: request.tenantId, attemptId: request.params.id, actingUserId: actor.actor.agent_user_id },
        'Agency disposition submitted on behalf of the reserved agent',
      );
    }
    if (result.status < 400) {
      // `disposition_code` and `on_behalf` are operational values (a fixed
      // catalog code / a boolean), not customer content — `notes` is free text
      // an agent typed and is deliberately excluded from the audit trail.
      const campaignId = extractStringField(result.body, 'campaign_id');
      platformAuditLogger.log({
        ...accountAudit(request),
        ...resolvedUserAuditActor(request, actor.actor.agent_user_id),
        action: 'agency_disposition.created',
        resource_type: 'agency_disposition',
        resource_id: request.params.id,
        ...(campaignId ? { campaign_id: campaignId } : {}),
        details: {
          disposition_code: parsed.data.disposition_code,
          ...(campaignId ? { campaign_id: campaignId } : {}),
          ...(actor.actor.on_behalf ? { on_behalf: true } : {}),
        },
      });
    }
    return reply.code(result.status).send(result.body);
  });

  /**
   * POST /proxy/agency/attempts/:id/notes — save notes without dispositioning.
   *
   * Separate from the disposition submit because the two happen at different
   * times: agents type while the customer is still talking, and a call that ends
   * before they choose a code must not discard what they wrote. The internal handler accepts it
   * while the attempt is live *and* through wrap-up, and it is last-write-wins,
   * so a console autosave can fire on a timer without knowing which phase it is
   * in. It does **not** end wrap-up and does **not** satisfy
   * `requires_disposition`.
   *
   * Gated at `agency.attempts.dispose` rather than a permission of its own: notes
   * and the disposition are two halves of one record, and an agent who may write
   * the outcome may write the note that explains it.
   */
  app.post<{ Params: { id: string } }>('/attempts/:id/notes', {
    preHandler: requirePermission('agency.attempts.dispose'),
  }, async (request, reply) => {
    const parsed = notesSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Validation Error', details: parsed.error.flatten() });
    }

    const actor = resolveAgencyActor(request);
    if (!actor.ok) {
      return reply.code(400).send({ error: 'Bad Request', code: actor.code, message: actor.message });
    }

    const result = await callCore({
      method: 'POST',
      path: `/agency/attempts/${request.params.id}/notes`,
      body: { ...parsed.data, ...actor.actor },
      tenantId: request.tenantId!,
      accountId: request.accountId,
      metricPath: '/agency/attempts/:id/notes',
    });
    return reply.code(result.status).send(result.body);
  });

  /**
   * POST /proxy/agency/attempts/:id/dnc — mark the contact on the line as
   * Do Not Call.
   *
   * The internal handler suppresses the contact and writes the `dnc_entries`
   * row (`markDnc`, `agency/dnc-mark.ts`) in one transaction with the attempt's
   * bookkeeping (decision B8): a failed insert rolls the suppression back, and
   * `dnc_recorded: false` means the number was not usable E.164 and no row was
   * written.
   *
   * ── The write is not unconditionally tenant-wide ───────────────────────────
   * An agent marking a number on one campaign must not suppress it across every
   * campaign in the tenant, in the over-block direction, with nothing on any
   * screen saying so. `scope` (above) is how the caller says which they meant,
   * and the tenant-wide arm carries its own permission floor (see the handler).
   *
   * ── The actor ──────────────────────────────────────────────────────────────
   * `AgencyDncRequest extends AgencyActorFields`, so `agent_user_id`/`on_behalf`
   * are the contract's own names. `dnc_entries.added_by` is the compliance
   * record of **who suppressed this number**; without the actor it lands NULL.
   *
   * The actor is the server's fact, never the browser's — same rule as every
   * sibling. Note what this deliberately does NOT do: the internal handler does
   * not refuse a plain mark-DNC from someone who is not the reserved agent (only
   * the disposition arm checks ownership), because a supervisor suppressing a
   * number mid-shift is a real action. Recording the authenticated caller is the
   * honest answer either way.
   */
  app.post<{ Params: { id: string } }>('/attempts/:id/dnc', {
    preHandler: requirePermission('agency.dnc.write'),
  }, async (request, reply) => {
    const parsed = dncSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Validation Error', details: parsed.error.flatten() });
    }

    /**
     * ── The escalation gate ────────────────────────────────────────────────
     * `scope: 'tenant'` is the irreversible, workspace-wide suppression, so it
     * carries a second and higher floor: `agency.dnc.manage` (`account_admin`),
     * the same floor `DELETE /dnc/:id` uses in `dnc.routes.ts` for the other
     * direction of the same compliance list. The route's own
     * `agency.dnc.write` preHandler stays at `agent`, because the ordinary
     * campaign-scoped mark really is an agent's own action on their own line.
     *
     * **Why this is not a second `preHandler`.** A preHandler is chosen per
     * ROUTE; this floor is chosen per REQUEST, from a body field. Fastify does
     * run preHandlers after body parsing, so one *could* read `request.body` —
     * but it would be reading the RAW body and deciding a compliance
     * escalation from a value that has not been through `dncSchema` and so is
     * not necessarily the value this handler goes on to forward. Gating on
     * `parsed.data.scope` makes the value checked and the value passed to
     * `callCore` the same value; that identity is the entire property being bought, and a
     * preHandler cannot have it.
     *
     * `requirePermission` is reused rather than reimplemented against
     * `hasPermission` so this refusal is identical to every other
     * `agency.dnc.manage` 403 on the DNC surface, and so the permission check
     * in `rbac.middleware.ts` keeps exactly one definition. It answers
     * the request itself, hence `reply.sent`. The 403 is returned before
     * `callCore` runs, and like every 4xx it passes `error-mask.middleware.ts`
     * unmasked rather than being flattened to "contact support".
     *
     * Enforced here and not left to the console: the console hides the
     * escalation behind this same permission, and a hidden button is not
     * enforcement — the request is trivially craftable by anyone holding only
     * `agency.dnc.write`.
     */
    if (parsed.data.scope === 'tenant') {
      await requireDncManage(request, reply);
      if (reply.sent) return reply;
    }

    const actor = resolveAgencyActor(request);
    if (!actor.ok) {
      return reply.code(400).send({ error: 'Bad Request', code: actor.code, message: actor.message });
    }

    const result = await callCore({
      method: 'POST',
      path: `/agency/attempts/${request.params.id}/dnc`,
      body: { ...parsed.data, ...actor.actor },
      tenantId: request.tenantId!,
      accountId: request.accountId,
      metricPath: '/agency/attempts/:id/dnc',
    });

    if (result.status < 400) {
      log.info(
        {
          tenantId: request.tenantId,
          attemptId: request.params.id,
          // Logged as the caller sent it, `undefined` included, rather than
          // defaulted to `'campaign'` — a log line that fills the blank in
          // cannot distinguish "asked for campaign" from "said nothing". The
          // internal handler's response is the record of where the row landed.
          scope: parsed.data.scope,
        },
        'Agent marked contact do-not-call',
      );

      // Compliance audit row. Deliberately NO phone number in `details` — the
      // internal handler's response carries `phone_e164`, but that is PII, and
      // the row records only that a suppression happened and its scope.
      // `entry_id` is included when the (untyped, passed-through) response
      // happens to carry one.
      const entryId = extractStringField(result.body, 'entry_id');
      const campaignId = extractStringField(result.body, 'campaign_id');
      platformAuditLogger.log({
        ...accountAudit(request),
        ...resolvedUserAuditActor(request, actor.actor.agent_user_id),
        action: 'dnc_entry.created',
        resource_type: 'dnc_entry',
        ...(entryId ? { resource_id: entryId } : {}),
        ...(campaignId ? { campaign_id: campaignId } : {}),
        details: {
          attempt_id: request.params.id,
          scope: parsed.data.scope,
          ...(campaignId ? { campaign_id: campaignId } : {}),
          ...(actor.actor.on_behalf ? { on_behalf: true } : {}),
        },
      });
    }
    return reply.code(result.status).send(result.body);
  });
}
