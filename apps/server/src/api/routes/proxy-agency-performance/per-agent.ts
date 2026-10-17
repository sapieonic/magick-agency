/*
 * The per-agent pairs: `my-stats` with `agents/:userId/stats`, and `my-attempts` with
 * `agents/:userId/attempts`. Each `my-*` route and its supervisory twin share one query
 * whitelist and live in this one file, so a change to the shape of the answer cannot land on
 * one half and miss the other (see `proxy-agency-performance.routes.ts`).
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { requirePermission } from '../../../rbac/rbac.middleware.js';
import { callCore, forwardCore } from '../../core-dispatch.js';
import { membershipRepository } from '@magick-agency/db/repositories/membership.repository';
import { forwardAllowedQuery, unknownQueryParamsError, enrichAttemptAgentNames } from '../../../agency/agency-spine.js';
import { enrichAgentStatsIdentity, resolveAgentNames } from '../../../agency/agency-agent-identity.js';
import { resolveMyAgentId } from '../proxy-agency-staffing.routes.js';
import { parseOr400 } from '../helpers/parse-or-400.js';
import { warnNameLookup } from './shared.js';

/**
 * What the internal handler's `GET /agency-agents/:agentUserId/stats` accepts, and
 * therefore all this route forwards.
 *
 * A whitelist rather than `request.query` wholesale, for the reason
 * `agency-spine.ts` gives at length: forwarding everything means this layer cannot
 * say what its own API accepts, and any param the handler later gives a meaning to
 * becomes reachable without anyone deciding it should be.
 *
 * **`agent_user_id` is absent from BOTH lists on purpose, and its absence is the
 * security property, not the documentation of one.** The subject of these reads is
 * decided by the path segment this route builds, and on the `my-*` routes that segment
 * comes from the session. A param that could name a different agent would be an
 * authorization decision taken from the query string.
 */
const AGENT_STATS_QUERY_PARAMS = ['from', 'to', 'bucket', 'campaign_id'] as const;

/**
 * The internal handler's attempt filters for one agent, plus paging.
 *
 * `cursor`/`limit` are included here — unlike on the spine's CSV drain, where
 * the route sets them itself and a caller-supplied one would fight it. There is
 * no export on this surface, so there is nothing to fight.
 *
 * **`contact_id` and `phone` are on this list because the handler APPLIES them.**
 * `parseAgentAttemptFilters` (`agency/agent-record.ts`) delegates to the
 * campaign spine's `parseAttemptFilters` — its own docstring says the vocabulary
 * is "IMPORTED, not forked" — and `listForAgent` puts both into the statement
 * (`a.contact_id = …` and `phoneCondition(…)`). The campaign-spine whitelist
 * (`ATTEMPT_QUERY_PARAMS` in `agency-spine.ts`) carries both too. Omitting them
 * here would not refuse the filter, which would at least be visible: it would
 * make `forwardAllowedQuery` drop the key silently, so a `?phone=` search would
 * answer **200 with the agent's whole unfiltered history** — a search control
 * that looks like it matched everything rather than one that failed. The console
 * sends `phone`, so this is what makes that control real.
 */
const AGENT_ATTEMPT_QUERY_PARAMS = [
  'outcome', 'state', 'disposition_code', 'campaign_id', 'contact_id', 'phone',
  'from', 'to', 'cursor', 'limit',
] as const;

/**
 * The supervisory routes' path param, validated as strictly as a body.
 *
 * A raw `:userId` reaches a `UUID` column in `memberships` and raises Postgres
 * `22P02` from inside the query, which propagates as a 500 — and `errorMaskHook`
 * masks every 5xx, so a typo comes back as "contact support and quote this request
 * id" and lands in the 5xx rate as though it were a server fault. Same reasoning,
 * and the same local pattern, as `campaignAgentParamsSchema` in
 * `proxy-agency-staffing.routes.ts`.
 */
const agentParamsSchema = z.object({
  userId: z.string().uuid(),
});

/**
 * Prove the named agent belongs to THIS tenant before reading anything about
 * them.
 *
 * ── Why this is needed at all ─────────────────────────────────────────────
 * `requirePermission` proves the caller's ROLE and never looks at the target row
 * — a target-row check is always the route's own job. The internal handler's
 * per-agent reads treat `agent_user_id` as an opaque id with no tenant check of
 * their own over that column (`agency_agent_sessions.agent_user_id` has no FK).
 * So the handler CANNOT refuse a foreign agent id here — it would happily return
 * that person's attempts and talk time, scoped to the campaigns of the caller's
 * tenant but keyed on a user who belongs to another tenant. The check against
 * `memberships` is made here, and it must be.
 *
 * ── 404, never 403 ────────────────────────────────────────────────────────
 * A user id in another tenant and one that does not exist answer identically:
 * anything else is a user-id oracle. This mirrors the
 * membership check on `POST /campaigns/:id/agents` exactly, including the wording,
 * so a console sees one response for one condition.
 *
 * ── ANY membership row, including a revoked one ────────────────────────────
 * `findAnyByUserAndTenant`, not `findByUserAndTenant`. The active-only lookup is
 * right for an authorization decision and wrong for this one: offboarding sets
 * `status = 'revoked'`, so asked that way a DEPARTED agent's record answered "not
 * a member of this workspace" — the dispute case this whole surface is justified
 * by, since a supervisor reads somebody's numbers after they leave rather than
 * while they are still on the roster. Staffing rows outlive the membership by
 * design (unassigning closes rather than deletes, so "who was staffed here in
 * March" stays answerable) and the numbers behind them would otherwise be
 * unreachable.
 *
 * That widens WHO can be read and not WHAT: the tenant predicate is in the same
 * statement, so a user who was never in this tenant is refused. The precedent,
 * with the same reasoning, is `userRepository.findDisplayNamesInTenant` — which
 * already resolves a revoked member's NAME onto these very payloads, so refusing
 * the numbers while naming the person would be two halves of one surface
 * disagreeing.
 *
 * Returns true to proceed; on refusal it has already replied and the caller must
 * `return` immediately.
 */
async function assertAgentInTenant(
  request: FastifyRequest,
  reply: FastifyReply,
  userId: string,
): Promise<boolean> {
  const memberships = await membershipRepository.findAnyByUserAndTenant(userId, request.tenantId!);
  if (memberships.length === 0) {
    reply.code(404).send({
      error: 'Not Found',
      message: 'That user is not a member of this workspace.',
    });
    return false;
  }
  return true;
}

/**
 * Registered by `proxyAgencyPerformanceRoutes` on its own instance, after its session and
 * tenant-context hooks.
 */
export async function registerPerAgentPerformanceRoutes(app: FastifyInstance): Promise<void> {
  /**
   * GET /proxy/agency/my-stats — the agent's own scorecard.
   *
   * A passthrough of the internal handler's per-agent stats for `request.user.id`:
   * `{ agent_user_id, bucket, from, to, totals: { attempts, connected,
   * connect_rate_pct, successes, success_rate_pct, talk_seconds, wrapup_seconds,
   * aht_seconds, campaigns, occupancy }, buckets: [...], by_campaign: [...] }`.
   *
   * This route reshapes nothing. The handler owns the arithmetic — the rates, the
   * AHT, the occupancy split — and a second definition of "connect rate" living in
   * this layer is a second definition that drifts from the one the supervisor's
   * dashboard shows. The only facts this route adds are the gate and the actor,
   * and both are applied before the call rather than to its result.
   *
   * ── Why an agent may read their own numbers at all ───────────────────────
   * Not a concession: an agent whose pay or shift depends on a success rate cannot
   * check it, dispute it or improve it if the only surface that shows it is floored
   * two levels above them. The read is scoped to themselves by construction, so it
   * grants no visibility of a colleague.
   */
  app.get('/my-stats', {
    preHandler: requirePermission('agency.station.connect'),
  }, async (request, reply) => {
    // A request that names no user has no "my", so it is refused rather than
    // answered for an arbitrary agent — shared with the staffing plugin's `my-*`
    // routes so one condition has one answer. See {@link resolveMyAgentId}.
    const userId = resolveMyAgentId(request, reply);
    if (userId === null) return reply;

    // Refused before `callCore`: an unknown param never reaches the handler.
    const forwarded = forwardAllowedQuery(request.query, AGENT_STATS_QUERY_PARAMS);
    if (!forwarded.ok) return reply.code(400).send(unknownQueryParamsError(forwarded.unknown));

    return forwardCore(request, reply, {
      method: 'GET',
      // The subject comes from the SESSION and is interpolated here. Nothing a
      // client sends can reach this segment.
      path: `/agency-agents/${userId}/stats`,
      query: forwarded.query,
    });
  });

  /**
   * GET /proxy/agency/my-attempts — the agent's own call history.
   *
   * The internal handler's keyset page, passed through as-is: `{ rows, next_cursor, limit }`. Same
   * actor rule as `/my-stats` — the path segment is `request.user.id` — and the
   * same whitelist, which is what keeps a client-supplied `agent_user_id` off the
   * wire.
   *
   * Not name-enriched, unlike the supervisory twin: every row belongs to the
   * caller, so `agent_name` would be their own name repeated once per row, bought
   * with a database read on a route a console pages through.
   */
  app.get('/my-attempts', {
    preHandler: requirePermission('agency.station.connect'),
  }, async (request, reply) => {
    const userId = resolveMyAgentId(request, reply);
    if (userId === null) return reply;

    const forwarded = forwardAllowedQuery(request.query, AGENT_ATTEMPT_QUERY_PARAMS);
    if (!forwarded.ok) return reply.code(400).send(unknownQueryParamsError(forwarded.unknown));

    return forwardCore(request, reply, {
      method: 'GET',
      path: `/agency-agents/${userId}/attempts`,
      query: forwarded.query,
    });
  });

  /**
   * GET /proxy/agency/agents/:userId/stats — a supervisor reads one agent.
   *
   * The supervisory twin of `/my-stats`. Same handler endpoint, same response shape,
   * two differences and both are deliberate:
   *
   *  1. **`agency.supervise` (`account_admin`, 30).** An `agent` cannot reach it,
   *     which is what stops this being a peer-surveillance surface — an agent
   *     reading a colleague's numbers has no operational case and the product does
   *     not offer it.
   *  2. **The subject is tenant-checked.** See {@link assertAgentInTenant}: the
   *     handler treats `agent_user_id` as an opaque id and cannot refuse a foreign
   *     one, so the `memberships` check here is the only place this boundary exists.
   *
   * `agent_name` is added on the way out. A supervisor comparing two agents needs
   * a name; the handler serves only the id.
   */
  app.get<{ Params: { userId: string } }>('/agents/:userId/stats', {
    preHandler: requirePermission('agency.supervise'),
  }, async (request, reply) => {
    const params = parseOr400(agentParamsSchema, request.params, reply, 'agency');
    if (!params) return reply;
    if (!(await assertAgentInTenant(request, reply, params.data.userId))) return reply;

    const forwarded = forwardAllowedQuery(request.query, AGENT_STATS_QUERY_PARAMS);
    if (!forwarded.ok) return reply.code(400).send(unknownQueryParamsError(forwarded.unknown));

    const result = await callCore({
      method: 'GET',
      path: `/agency-agents/${params.data.userId}/stats`,
      query: forwarded.query,
      tenantId: request.tenantId!,
      accountId: request.accountId,
    });
    // Non-2xx bodies pass through untouched, exactly as the handler wrote them.
    const body = result.status >= 200 && result.status < 300
      ? await enrichAgentStatsIdentity(
        result.body,
        request.tenantId!,
        resolveAgentNames,
        warnNameLookup(request, 'agents/:userId/stats'),
      )
      : result.body;
    return reply.code(result.status).send(body);
  });

  /**
   * GET /proxy/agency/agents/:userId/attempts — a supervisor reads one agent's
   * call history.
   *
   * The supervisory twin of `/my-attempts`, gated and tenant-checked exactly as
   * the stats twin above.
   *
   * Enriched through `enrichAttemptAgentNames` — the SAME helper the campaign
   * spine's `/campaigns/:id/attempts` uses, on the same wire shape
   * (`{ rows: [{ agent_user_id, … }] }`), rather than a second implementation of
   * one transform. The row page here is one agent's rather than one campaign's, so
   * every row resolves to the same person; that makes the shared helper's
   * one-query-per-page rule trivially satisfied rather than differently
   * implemented.
   */
  app.get<{ Params: { userId: string } }>('/agents/:userId/attempts', {
    preHandler: requirePermission('agency.supervise'),
  }, async (request, reply) => {
    const params = parseOr400(agentParamsSchema, request.params, reply, 'agency');
    if (!params) return reply;
    if (!(await assertAgentInTenant(request, reply, params.data.userId))) return reply;

    const forwarded = forwardAllowedQuery(request.query, AGENT_ATTEMPT_QUERY_PARAMS);
    if (!forwarded.ok) return reply.code(400).send(unknownQueryParamsError(forwarded.unknown));

    const result = await callCore({
      method: 'GET',
      path: `/agency-agents/${params.data.userId}/attempts`,
      query: forwarded.query,
      tenantId: request.tenantId!,
      accountId: request.accountId,
    });
    const body = result.status >= 200 && result.status < 300
      ? await enrichAttemptAgentNames(
        result.body,
        request.tenantId!,
        resolveAgentNames,
        warnNameLookup(request, 'agents/:userId/attempts'),
      )
      : result.body;
    return reply.code(result.status).send(body);
  });
}
