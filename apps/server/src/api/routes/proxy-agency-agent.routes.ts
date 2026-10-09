/*
 * PORT NOTE (magick-agency, Phase 8): master `src/api/routes/proxy-agency-agent.routes.ts`@a1f0756a,
 * served at the console's paths under `/proxy/agency` (decision B16). Changed, and only these:
 *  - hop collapse: every `proxyToCore({...})` is `callCore({...})` (`../core-dispatch.ts`) with
 *    the same options minus `coreApiKey`, and the `resolveCoreApiKey` lines are gone. Core's
 *    handler bodies (`agency.routes.ts`, sessions and attempts) run in-process with the tenant
 *    and account from lane A's context;
 *  - governance: `requireCapability('agency')` is deleted (plan §3.2);
 *  - `auditLogger` → `platformAuditLogger` (B7); imports.
 * Validation, RBAC floors (`agency.station.connect`, `agency.attempts.handle|dispose`,
 * `agency.dnc.write` + `agency.dnc.manage` for a tenant-wide mark, `agency.supervise`), the
 * actor assertion, the `station_ws_url` rewrite and the eight audit rows are master's. Comments
 * that mention `proxyToCore`'s parse check or the API key are master's record; the traversal
 * refusal is `callCore`'s now (same check, same 400).
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
 * Best-effort extraction of a string field from core's response body for the
 * audit trail (`MAG-70`). Core's response shapes are not mirrored here (master
 * forwards verbatim — see the file header), so this narrows defensively rather
 * than trusting the body, and a malformed/unexpected response must never throw
 * out of an audit call and take the request down with it.
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
 * 1. **RBAC.** D6 puts `agent` at hierarchy level 5, deliberately below every
 *    permission floor that predates the feature. `POST /proxy/webrtc-call/:id/end`
 *    floors at `operator` (20), so an agent cannot reach it — by design, not by
 *    oversight. Every agent action therefore needs a surface floored at `agent`.
 * 2. **Ownership.** Core can verify the caller **is the reserved agent for that
 *    attempt**, which `/webrtc-call/:id/end` has no way to express. That is
 *    strictly better than reusing the generic route would have been, so the
 *    RBAC constraint pushed us somewhere we should have gone anyway.
 *
 * Core owns all validation and all business rules; master forwards verbatim and
 * adds only the two gates it owns (capability + RBAC) plus tenant/account
 * header translation. Do not mirror core's disposition-catalog rules here — a
 * second copy of a rule is a second copy that goes stale.
 *
 * ── The 403 that must not be flattened ─────────────────────────────────────
 * Core answers 403 `not_your_attempt` for a caller who is not the reserved
 * agent. That code is allow-listed in `error-mask.middleware.ts`; without that
 * entry the global mask turns it into "contact support and quote this request
 * id", which on an agent's screen between live calls is indistinguishable from
 * an outage. The whole `AgencyActionErrorCode` union is now allow-listed from
 * one place — `src/agency/agency-action-errors.ts` — so mirroring a code core
 * adds is a one-line change there rather than an edit to the mask.
 */

/**
 * Note what these schemas deliberately do NOT declare: `agent_user_id` and
 * `on_behalf`. Zod strips unknown keys, so a client that sends either — a stale
 * console, or an agent trying to file a disposition under a colleague's name —
 * has them dropped before the body reaches core, and master then attaches the
 * pair it derived from the session itself. Attribution is never client-supplied.
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
   * How far this suppression reaches. **This field must not be stripped**, and
   * for one release it was: the schema declared only `reason` and
   * `disposition_code`, so Zod's default strip deleted the `scope` the browser
   * sent, the handler forwarded `parsed.data` without it, and the request
   * answered 200 — a silent scope error on a terminal compliance write, which
   * is the exact failure class campaign-scoped DNC exists to prevent. Nothing
   * observed it because every party was internally consistent: the browser sent
   * a field, master answered 200, core wrote the scope it defaults to.
   *
   * **Absent means `'campaign'`** — the narrower, safer scope — and that
   * direction is deliberate rather than incidental. A console built before this
   * field existed sends no `scope`, and the cost of guessing wrong has to fall
   * on the recoverable side: a campaign-scoped mark that should have been
   * tenant-wide under-blocks one campaign and is fixed by marking again, while
   * the reverse silently suppresses a number across every campaign in the
   * tenant and is not reversible by the agent who caused it.
   *
   * Absent is forwarded to core as absent, not normalised to `'campaign'` here.
   * Core owns the default; a second copy of it in master is a second copy that
   * goes stale, and the two would then disagree without either side erroring.
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
 * agent is joining is master's fact, taken from the authenticated session below,
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

/** Free text, recorded on core's audit event for the override. */
const forceAvailableSchema = z.object({
  reason: z.string().max(1000).optional(),
});

/**
 * Q8 (Manas, 2026-10-09): the actor for a SESSION route. Master sent none on
 * station-token / available / break / break-cancel / leave / force-available, so
 * core's `requireOwnedSession` could only check tenant + account and an agent could
 * act on a colleague's session. It now receives the same pair the attempt actions
 * do (`resolveAgencyActor`: the authenticated user, plus `on_behalf` only for
 * `agency.supervise`) and refuses a caller who is not the session's agent unless the
 * route lets a supervisor act. Spread LAST into the body, so nothing a client sent
 * can name the actor (the zod schemas strip it anyway).
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
  // Entitlement gate. Composes (AND) with core's `agency_dialer_enabled` flag
  // and with the RBAC floors below — a capability alone reaches nothing.
  // PORT NOTE (magick-agency): master's `requireCapability('agency')` is deleted — there is
  // no governance, and the section-level `agency` gate is always on because the app IS
  // agency (plan §3.2). Core's `agency_dialer_enabled` flag and the RBAC floors remain.
  /*
   * Every `:id` here — a session id or an attempt id — is interpolated into a
   * core path, and find-my-way hands the handler a percent-DECODED param.
   *
   * ── Stated honestly: on THIS plugin the hook is defence in depth ──────────
   *
   * The dot-segment family is already refused by `proxyToCore`'s parse check
   * (`src/proxy/safe-core-path.ts`). What that check allows is a bare extra
   * slash — which on the sibling campaigns plugin is a real escalation, because
   * its `GET /campaigns/:id` puts the param in the LAST segment. Here every route
   * appends its own action after the param (`/available`, `/leave`,
   * `/station-token`, `/hangup`, `/disposition`, `/notes`, `/dnc`), so extra
   * segments land in the middle and produce a 404 rather than a different core
   * surface. No exploit is known through these routes today.
   *
   * It is registered anyway, and the reason is the shape of the risk rather than
   * a current bug: the floor here is `agency.station.connect`, which sits at
   * **agent (level 5)** — the lowest floor in the service — and every one of
   * these routes is a POST. A route added later that ends in its param, or a core
   * action renamed so a param's suffix stops being unique, turns "no known
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
   * The response's `station_ws_url` is rewritten onto master's proxy prefix:
   * core mints it pointing at itself, but the browser can only reach master.
   * The query string (which carries core's session token) is preserved
   * verbatim — master neither mints nor validates it.
   */
  app.post('/sessions', {
    preHandler: requirePermission('agency.station.connect'),
  }, async (request, reply) => {
    const parsed = createSessionSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Validation Error', details: parsed.error.flatten() });
    }

    // `MAG-118`. Core's `POST /agency/sessions` requires `agent_user_id` and this
    // handler forwarded `parsed.data`, which never carried one — so every join
    // 400'd and no agent could reach a campaign. Refusing here rather than at core
    // spends no proxy round trip and hands the console the same error shape the
    // disposition and notes handlers produce.
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
   * Session state transitions. Phase 1 implements `available` and `leave`;
   * `break` is proxied now because its request shape is frozen, so cusui can
   * build the menu once rather than twice.
   */
  // Written out per action rather than generated from a loop. A loop reads
  // tidier, but it makes the `path` a doubly-interpolated template literal,
  // which the metric-template guard normalises to `/agency/sessions/:id/:id` —
  // one shared, meaningless series for two different operations. Three near-
  // identical handlers are a small price for a metric label that means
  // something.
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
   * Contract v2 made the station token **single-use and ~2 minutes**, rather
   * than a shift-length bearer sitting in a query string, so a reconnect needs
   * a new one. Deliberately cheap and separate from bootstrap: a reconnect
   * needs a token, not the whole campaign config again.
   *
   * Its `station_ws_url` gets the same rewrite as bootstrap's — core mints it
   * pointing at itself and the browser can only reach master.
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
   * `agency.supervise`, which under D6 an `agent` (level 5) cannot reach.
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
   * The comment here used to describe the station socket's `hangup` control
   * frame as an equivalent — it was never implemented, and neither was core's
   * route, so this proxy 404'd and the agent's hang-up button did nothing on
   * either path (`MAG-112`). The frame is now withdrawn in core's contract.
   *
   * Attributed like disposition and notes, and for the same reason: core checks
   * the caller **is** the reserved agent, and it cannot do that without an actor.
   * This previously proxied with no body at all, so the ownership rule core's
   * contract promised could never run — any tenant member holding
   * `agency.attempts.handle`, which is every agent, could have hung up any other
   * agent's live call.
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
      // is stuck on is a real action, and `on_behalf` is what lets core allow it
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
   * catalog and are enforced by CORE, not here. The schema above only bounds
   * shape and size; conditional requirements live where the catalog lives.
   *
   * Carries `AgencyActorFields` (`AD-P2-M-01`). Master attributes the action and
   * asserts whether the caller supervises; core decides whether that is allowed
   * against the attempt's reserved agent. See `src/agency/agency-actor.ts` for
   * why the check has to be split across the two services.
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
      // agent who took the call is the audit case this flag exists for, and
      // core records it on the attempt but master's logs are where an operator
      // looks first.
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
   * before they choose a code must not discard what they wrote. Core accepts it
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
   * Core suppresses the contact immediately, then forwards to master's
   * `POST /internal/agency/dnc` (`internal-agency.routes.ts`), which owns
   * `dnc_entries`.
   *
   * ── The write is no longer unconditionally tenant-wide ─────────────────────
   * This comment used to say it was, and gave a reason: tenant-wide is exactly
   * the scope core's flat `dnc:{tenantId}` Redis set can express, so the
   * mid-campaign agent path needed no narrower scoping. The reason was true
   * about the Redis set and wrong about the requirement — an agent marking a
   * number on one campaign was suppressing it across every campaign in the
   * tenant, in the over-block direction, with nothing on any screen saying so.
   * `scope` (above) is how the caller now says which they meant, and the
   * tenant-wide arm carries its own permission floor (see the handler).
   *
   * **This comment was aspirational until `AD-P3-M-03`.** It claimed a callback
   * for the whole of Phase 2 while no endpoint in master could receive one — as
   * did core's own contract (`contracts.ts:830`). Both described the mechanism;
   * neither was evidence it existed. It does now, and the sentence above names the
   * file so the next reader can check rather than trust.
   *
   * Master cannot short-circuit this by writing the row from core's response
   * instead: `phone_e164` is in that response, but `dnc_recorded` is core's field
   * and core can only populate it by asking master first.
   *
   * ── This handler DOES call `resolveAgencyActor` as of `MAG-107` ───────────
   * It did not until now, and the reason was good at the time: core's
   * `AgencyDncRequest` declared only `reason?`/`disposition_code?`, with no
   * field for an actor to land in, so sending one would have been inventing a
   * name the ratified contract did not carry — a guess that today is silently
   * dropped and tomorrow collides with whatever core actually declares.
   *
   * `MAG-106` closed that: `AgencyDncRequest extends AgencyActorFields`, so
   * `agent_user_id`/`on_behalf` are now the contract's own names and master can
   * populate them without inventing anything. `dnc_entries.added_by` is the
   * compliance record of **who suppressed this number**, and it landed NULL on
   * every write this route produced.
   *
   * The actor is still master's fact, never the browser's — same rule as every
   * sibling. Note what this deliberately does NOT do: core does not refuse a
   * plain mark-DNC from someone who is not the reserved agent (only the
   * disposition arm checks ownership), because a supervisor suppressing a number
   * mid-shift is a real action. Recording the authenticated caller is the honest
   * answer either way; it is *deriving* an actor we were not told that §1.2
   * refused, not recording the one we were.
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
     * `parsed.data.scope` makes the value checked and the value sent to core
     * the same value; that identity is the entire property being bought, and a
     * preHandler cannot have it.
     *
     * `requirePermission` is reused rather than reimplemented against
     * `hasPermission` so this refusal is identical to every other
     * `agency.dnc.manage` 403 on the DNC surface, and so the platform-API-key
     * waiver in `rbac.middleware.ts` keeps exactly one definition. It answers
     * the request itself, hence `reply.sent`. The 403 is returned before any
     * core call, which is what keeps `error-mask.middleware.ts` passing it
     * through instead of flattening it to "contact support".
     *
     * Enforced here and not left to the console: `magick-comms-cusui` hides the
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
          // defaulted to `'campaign'` — the whole defect was master claiming to
          // know a scope it had actually dropped, and a log line that fills the
          // blank in cannot distinguish "asked for campaign" from "said
          // nothing". Core's response is the record of where the row landed.
          scope: parsed.data.scope,
        },
        'Agent marked contact do-not-call',
      );

      // Compliance audit row (`MAG-70`). Deliberately NO phone number in
      // `details` — core's response carries `phone_e164`, but that is PII and
      // the ticket requires recording only that a suppression happened and its
      // scope. `entry_id` is included when core's (untyped, forwarded-verbatim)
      // response happens to carry one.
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
