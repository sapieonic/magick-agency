/*
 * The four lifecycle controls (start, pause, resume, stop) and the actor resolution
 * they and the retry create share. Part of `proxy-agency-campaigns.routes.ts`.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { requirePermission } from '../../../rbac/rbac.middleware.js';
import { callCore } from '../../core-dispatch.js';
import { createChildLogger } from '@magick-agency/observability';
import { platformAuditLogger } from '../../../audit/platform/audit-logger.js';
import { requestAuditActor } from '../../../audit/platform/audit-actor.js';
import { resolveAgentNames } from '../../../agency/agency-agent-identity.js';
import {
  TRANSITION_ACTOR_LOOKUP_TIMEOUT_MS,
  type AgencyCampaignTransitionRequest,
} from '../../../agency/agency-campaign-wire.js';
import { stringField } from '../helpers/core-campaign.js';

const log = createChildLogger({ component: 'proxy-agency-campaigns' });

/**
 * The actor name lookup timed out — distinct from every value that lookup can
 * legitimately resolve to.
 *
 * A symbol rather than `null` or `undefined`, because both are real answers from
 * `resolveAgentNames` ("this tenant has no name for that id"), and a timeout that
 * arrived spelled as one of them would be indistinguishable from a resolved miss
 * in the log — which is the only place the difference is visible, the response
 * being identical by design. See {@link TRANSITION_ACTOR_LOOKUP_TIMEOUT_MS}.
 */
const LOOKUP_TIMED_OUT = Symbol('agency-transition-actor-lookup-timeout');

/**
 * The bounded, never-throwing name lookup the actor resolvers share.
 *
 * Extracted from `resolveTransitionActor` when the retry create needed the
 * same thing, and extracted rather than copied for the reason
 * {@link resolveAgentNames}'s own docstring gives: a byte-identical local copy
 * of the lookup has already been left behind once in this plugin, and the whole
 * point of that binding is that "turn a user id into something a human reads"
 * has one answer in this repository. Two resolvers reaching for two lookups is
 * how one of them starts reporting an email where the other reports a display
 * name — on two audit surfaces describing the same person.
 *
 * Everything the transition path documented above about failure holds here
 * unchanged: a rejection and an expiry take the SAME branch, are logged
 * separately only so Grafana can tell a slow database from a broken one, and
 * both resolve to `null`. A name is an improvement on the id, never a
 * precondition.
 */
export async function resolveActorDisplayName(
  request: FastifyRequest,
  userId: string,
): Promise<string | null> {
  let name: string | null = null;
  let timer: NodeJS.Timeout | undefined;
  try {
    // One id, so this is the single-row case of the page lookup rather than a
    // second method. A miss (a user outside this tenant, a soft-deleted one)
    // is simply absent from the map and resolves to null.
    const lookup = resolveAgentNames([userId], request.tenantId!);
    // A lookup that LOSES the race can still reject afterwards, and an
    // unhandled rejection takes the process down under Node's default. This
    // second handler does not swallow it from the race below — each `then`
    // chain settles independently — so a rejection that arrives in time is
    // still caught and logged there.
    lookup.catch(() => undefined);
    // Raced rather than awaited, and the timeout is not a failure mode of its
    // own: a `pg` query has no `AbortSignal`, and this repo configures no
    // statement timeout, so an unbounded await is a hung pool holding the off
    // button. See {@link TRANSITION_ACTOR_LOOKUP_TIMEOUT_MS}.
    const names = await Promise.race([
      lookup,
      new Promise<typeof LOOKUP_TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(LOOKUP_TIMED_OUT), TRANSITION_ACTOR_LOOKUP_TIMEOUT_MS);
      }),
    ]);
    if (names === LOOKUP_TIMED_OUT) {
      // Deliberately the same outcome as the catch below, and it is logged
      // separately only so the cause is legible in Grafana: a slow database and
      // a broken one need different fixes and produce the same response.
      log.warn(
        { tenantId: request.tenantId, timeoutMs: TRANSITION_ACTOR_LOOKUP_TIMEOUT_MS },
        'agency campaign actor: name resolution timed out; attributing by id alone',
      );
    } else {
      name = names.get(userId) ?? null;
    }
  } catch (err) {
    // Logged, never rethrown: the action is the fact and the name is a label
    // on it. An id-only actor still attributes it.
    log.warn(
      {
        tenantId: request.tenantId,
        err: err instanceof Error ? err.message : String(err),
      },
      'agency campaign actor: name resolution failed; attributing by id alone',
    );
  } finally {
    // Cleared on every path, including the one where the lookup won: a live
    // timer per transition would hold the event loop open for two seconds after
    // the response, and in the suites it keeps the process alive past the test.
    if (timer) clearTimeout(timer);
  }

  return name;
}

/** Registered by `proxyAgencyCampaignsRoutes` on its own instance, after its hooks. */
export async function registerCampaignLifecycleRoutes(app: FastifyInstance): Promise<void> {
  // ── Lifecycle ─────────────────────────────────────────────────────────────

  /**
   * Who pressed the control, for the internal handler's optional transition body.
   *
   * ── Why the body is sent ──────────────────────────────────────────────────
   * The dialer runtime stores `last_transition_by: { user_id, name } | null` on
   * the campaign row and reads it from an OPTIONAL request body. With no body it
   * stores `null` — the same value it writes for a genuinely automatic transition
   * (the abandonment auto-pause, the leader's finalization). So a
   * supervisor-initiated transition must send one, or the field would mean "the
   * caller did not say" rather than "nobody did it". The handler resolves no
   * names itself; it stores the name it is handed.
   *
   * ── The identity comes from the SESSION. Never from the body. ─────────────
   * `request.user.id`, populated by `sessionMiddleware`. There is no param, query
   * key or body field through which a caller can name the actor, and that is the
   * security property rather than the documentation of one: `last_transition_by`
   * is an ATTRIBUTION field on an audit surface, so a caller-supplied actor is a
   * forged one — a supervisor could stop a campaign in a colleague's name. The
   * inbound body is not forwarded at all (these routes never read it), so the
   * refusal needs no filtering step: the body the handler receives is built here
   * from facts the session authenticated.
   *
   * The platform audit row for each of the four handlers below states its actor
   * through `requestAuditActor`, like every other audited call site, so the two
   * trails agree on who performed the transition.
   *
   * Note this deliberately does NOT refuse the transition when there is no
   * actor, unlike the agency `my-*` routes' 400 `missing_actor`: refusing the off
   * button for want of attribution is the wrong trade.
   *
   * ── Absent beats a placeholder, and a name is best-effort ─────────────────
   * With no id there is no body: the handler then stores `null`. Nothing here may
   * spell that as `'system'`, `''` or `'unknown'` — the handler reads all three
   * as a real actor, and `''` is worse still because `readTransitionActor` trims
   * it back to `null` after the id has already been accepted. The NAME is
   * separate: a lookup that fails yields an id-only actor (`actor_name` omitted,
   * which the handler stores as `name: null`) rather than failing the transition. Same rule as every other
   * enrichment on this feature — a name is an improvement on the id, never a
   * precondition — and it matters more here, because the alternative is losing
   * the off button to a database blip.
   *
   * A lookup that HANGS is the same failure in the latency direction and needs
   * its own answer, because a starved pool or a lock queue does not reject: the
   * await is bounded by {@link TRANSITION_ACTOR_LOOKUP_TIMEOUT_MS} and expiry
   * takes the identical branch — logged, id-only, transition unaffected. Without
   * the bound the try/catch below reads as complete cover and is not.
   *
   * ── One name lookup for the whole repository ──────────────────────────────
   * `resolveAgentNames`, the binding the spine reads (`spine.ts`) already use. Its
   * docstring calls itself "the only declaration of the lookup in the
   * repository" after a byte-identical local copy was left behind once, so a
   * second one here would re-open exactly that. It also keeps the name this route
   * SENDS the handler in step with the name the campaign activity trail DISPLAYS
   * for the same person: the trail's own `resolveDisplayNames` goes through a different
   * repository method (`findIdentitiesInTenant`, which it also needs the role
   * from) but folds it by the same rule — trimmed `display_name`, else the email.
   *
   * The internal handler truncates an over-long name and drops an over-long id;
   * this route implements neither ceiling on purpose — see
   * {@link AgencyCampaignTransitionRequest}.
   */
  const resolveTransitionActor = async (
    request: FastifyRequest,
  ): Promise<AgencyCampaignTransitionRequest | undefined> => {
    // `sessionMiddleware` has no API-key branch, so `request.user` is always the
    // Firebase-verified person.
    const userId = request.user?.id;
    if (!userId) return undefined;

    const name = await resolveActorDisplayName(request, userId);

    // `actor_name` is OMITTED rather than sent empty when there is no name.
    return { actor_user_id: userId, ...(name ? { actor_name: name } : {}) };
  };

  /**
   * The body the four lifecycle controls share: resolve the actor, then run the
   * internal handler's transition with it.
   *
   * The actor is resolved BEFORE `callCore`, and its failure never reaches the
   * caller: `undefined` means the transition goes out unattributed. The body is
   * spread, so a request with no resolvable actor carries NO body at all rather
   * than an empty object — the shape the handler's `actorPatch` answers with `{}`.
   */
  async function runTransition(
    request: FastifyRequest<{ Params: { id: string } }>,
    call: { method: 'POST'; path: string },
  ) {
    const actor = await resolveTransitionActor(request);
    return callCore({
      ...call,
      ...(actor ? { body: actor } : {}),
      tenantId: request.tenantId!,
      accountId: request.accountId,
    });
  }

  /**
   * A lifecycle control's platform audit row, everything but its actor and action —
   * each route states those inline, so every audited write names its own actor
   * derivation (`audit-actor-call-sites.test.ts`).
   *
   * `status` is the handler's body read defensively: on a lifecycle action the body
   * IS the updated campaign, but this layer keeps no campaign schema, so a malformed
   * response must never throw out of an audit call and take the request down.
   */
  function transitionAuditRow(
    request: FastifyRequest<{ Params: { id: string } }>,
    result: { body: unknown },
  ) {
    const status = stringField(result.body, 'status');
    return {
      tenant_id: request.tenantId!,
      ...(request.accountId ? { account_id: request.accountId } : {}),
      resource_type: 'agency_campaign' as const,
      resource_id: request.params.id,
      campaign_id: request.params.id,
      details: { campaign_id: request.params.id, ...(status ? { status } : {}) },
    };
  }

  // Four routes rather than a loop or a table: each internal path is a `path:`
  // LITERAL at its own call site, which `test/unit/api/core-dispatch.test.ts`
  // resolves against the internal route table — any indirection (a lookup table,
  // a `.replace()`, a loop variable) would hide the route from it. The shared body
  // is `runTransition`; the audit row's action stays at each route.
  app.post<{ Params: { id: string } }>('/campaigns/:id/start', {
    preHandler: requirePermission('agency.supervise'),
  }, async (request, reply) => {
    const result = await runTransition(request, {
      method: 'POST',
      path: `/agency-campaigns/${request.params.id}/start`,
    });
    if (result.status < 400) {
      platformAuditLogger.log({
        ...transitionAuditRow(request, result),
        ...requestAuditActor(request),
        action: 'agency_campaign.started',
      });
    }
    return reply.code(result.status).send(result.body);
  });

  app.post<{ Params: { id: string } }>('/campaigns/:id/pause', {
    preHandler: requirePermission('agency.supervise'),
  }, async (request, reply) => {
    const result = await runTransition(request, {
      method: 'POST',
      path: `/agency-campaigns/${request.params.id}/pause`,
    });
    if (result.status < 400) {
      platformAuditLogger.log({
        ...transitionAuditRow(request, result),
        ...requestAuditActor(request),
        action: 'agency_campaign.paused',
      });
    }
    return reply.code(result.status).send(result.body);
  });

  app.post<{ Params: { id: string } }>('/campaigns/:id/resume', {
    preHandler: requirePermission('agency.supervise'),
  }, async (request, reply) => {
    const result = await runTransition(request, {
      method: 'POST',
      path: `/agency-campaigns/${request.params.id}/resume`,
    });
    if (result.status < 400) {
      platformAuditLogger.log({
        ...transitionAuditRow(request, result),
        ...requestAuditActor(request),
        action: 'agency_campaign.resumed',
      });
    }
    return reply.code(result.status).send(result.body);
  });

  /**
   * Stop.
   *
   * **A 200 here means "accepted and draining", NOT "stopped".** `stop` sets the
   * campaign to `stopping`; the pacing leader drains in-flight attempts and
   * writes `stopping → stopped` on its next idle tick, because
   * `running → completed` and `stopping → stopped` have exactly one writer by
   * design, so a supervisor's control cannot race finalization.
   *
   * The UI must therefore poll for the terminal state and must not assert it
   * from this response — a dashboard that flips to "Stopped" on the 200 is
   * lying for as long as the drain takes, while calls are still connected.
   */
  app.post<{ Params: { id: string } }>('/campaigns/:id/stop', {
    preHandler: requirePermission('agency.supervise'),
  }, async (request, reply) => {
    const result = await runTransition(request, {
      method: 'POST',
      path: `/agency-campaigns/${request.params.id}/stop`,
    });
    if (result.status < 400) {
      // A 200 here means "accepted and draining" (see the doc comment above),
      // not "stopped" — `status` in `details` is therefore whatever the handler
      // returned at this instant (typically still `running`/`stopping`), not a
      // fabricated terminal state.
      platformAuditLogger.log({
        ...transitionAuditRow(request, result),
        ...requestAuditActor(request),
        action: 'agency_campaign.stopped',
      });
    }
    return reply.code(result.status).send(result.body);
  });
}
