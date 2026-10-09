import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { sessionMiddleware } from '../../auth/session.middleware.js';
import { tenantContextMiddleware } from '../middleware/tenant-context.middleware.js';
import { requirePermission } from '../../rbac/rbac.middleware.js';
import { callCore } from '../core-dispatch.js';
import { createChildLogger } from '@magick-agency/observability';
import { membershipRepository } from '@magick-agency/db/repositories/membership.repository';
import {
  forwardAllowedQuery,
  unknownQueryParamsError,
  enrichAttemptAgentNames,
  pageRows,
} from '../../agency/agency-spine.js';
import {
  enrichAgentStatsIdentity,
  resolveAgentNames,
  filterRosterRowsByMembership,
  filterRowsByMembership,
  groupedRowAgentId,
  groupedRowHasAgentKey,
  enrichGroupedRowAgentNames,
  type RosterAgentRowRef,
  type AgencyGroupRowRef,
} from '../../agency/agency-agent-identity.js';
import { resolveMyAgentId } from './proxy-agency-staffing.routes.js';

const log = createChildLogger({ component: 'proxy-agency-performance' });

/*
 * PORT NOTE (magick-agency): master `src/api/routes/proxy-agency-performance.routes.ts`@a1f0756a,
 * served at the console's paths under `/proxy/agency` (decision B16). Changes, each listed in
 * PORTING.md "Phase 8 — performance":
 *  - hop collapse: every `proxyToCore({...})` is `callCore({...})` (`../core-dispatch.ts`) with the
 *    same options minus `coreApiKey`, and the `resolveCoreApiKey` lines are gone. Core's handler
 *    body (`agency-agents.routes.ts`, core's verbatim) runs in-process with the same tenant /
 *    account headers it read over HTTP. `metricPath` and `timeoutMs` are still passed (accepted
 *    and ignored by `callCore`: no proxy series, no transport to time out), so the call sites stay
 *    master's;
 *  - governance: `requireCapability('agency')` is deleted (the app IS agency, plan §3.2);
 *  - decision #5 (no platform API keys): the `isPlatformApiKeyCaller` refusal on `/agents/stats`
 *    and `/agents/grouped-stats` is deleted with the predicate (lane B2 deleted it from
 *    `agency-actor.ts`). `request.user` is always the Firebase-verified person here, so the guard
 *    had no branch left to take. `resolveMyAgentId` (the staffing plugin's, imported as master
 *    did) keeps its `request.user?.id` half.
 * The comments below that describe the error mask, undici and the API-key bypass are master's,
 * kept verbatim as the record of why each check exists; none of those mechanisms is present here.
 * Everything else — whitelists, `include_inactive`, the account predicate, the membership
 * filter, both omission counters, `assertAgentInTenant`'s 404 and the name enrichment — is
 * master's, byte for byte.
 */

/**
 * AGENT performance: an agent's own numbers, a supervisor's view of one agent's
 * numbers, and the supervisor's view of the whole roster.
 *
 * ── Why this is its own plugin on a shared prefix ──────────────────────────
 * Four of the six routes are two pairs, and the pairs differ only in whose id
 * goes in the path and which floor guards it. That symmetry is the whole point of
 * the file: the `my-*` and supervisory halves of one question live next to each
 * other so a change to the shape of the answer cannot land on one and miss the
 * other. The other two ask the same question about EVERYBODY at once —
 * `GET /agents/stats`, the roster (phase 01 of the supervisor console), and
 * `GET /agents/grouped-stats`, the general grouped aggregate (phase 02a) — and
 * they belong here for the same reason: they are the whole-floor siblings of
 * `/agents/:userId/stats`, and all of them must agree about the gate, the
 * tenancy check and the name lookup. The two whole-floor reads also share the
 * three facts master owns over core's page — the account predicate, the
 * departed-agent filter and the two omission counters — which is precisely the
 * code a split across two files would let drift.
 *
 * It is NOT in `proxy-agency-staffing.routes.ts` (which serves `/my-assignments`
 * and `/my-campaigns` on this same prefix) because that file is **master-native**:
 * its rows are master's, its degradation story is about courtesy labels on an
 * answer already in hand. These six are thin proxies to core, where the numbers
 * are the answer and master owns only the gate, the actor and one name lookup. It
 * is not in `proxy-agency-campaigns.routes.ts` either: that file is keyed on a
 * CAMPAIGN and asks core to prove ownership of one. These are keyed on a PERSON,
 * whose scoping is a membership row master holds itself.
 *
 * ── The floor is the critical detail, and it is the one that gets this wrong ──
 * `agency.station.connect` (`agent`, hierarchy level 5) on both `my-*` routes.
 * Design D6 puts `agent` BELOW `viewer`, so an `agent` holds exactly the four
 * `agency.*` permissions and nothing that predates the feature. The obvious-looking
 * gate for a stats read is `proxy.contact_lists.read` — it is what the neighbouring
 * campaign stats route uses — and it floors at `viewer` (10). Using it here would
 * 403 the only role these two routes exist for, while reading as entirely
 * reasonable in review. `proxy-agency-staffing.routes.ts` states this rule for its
 * own `my-*` routes; it applies here verbatim, and
 * `test/unit/agency/proxy-agency-my-surfaces.routes.test.ts` pins all four floors
 * against `PERMISSION_MATRIX` rather than trusting inspection.
 *
 * Both whole-floor reads floor at `agency.supervise` like the supervisory pair,
 * and the temptation there runs the other way: a whole-floor read looks like an
 * "analytics" surface, and `proxy.analytics.read` / `proxy.stats.read` both floor
 * at `viewer` — which would hand every viewer in the tenant a per-person
 * scorecard for the entire roster. `agency.supervise` stays at `account_admin`
 * (a locked product decision: no new role, no matrix change, no migration), and
 * `proxy-agency-roster.routes.test.ts` / `proxy-agency-grouped-stats.routes.test.ts`
 * pin that floor against `PERMISSION_MATRIX` too.
 *
 * ── The agent id is SERVER-SIDE on the `my-*` routes. Always. ──────────────
 * `request.user.id` and nothing else. There is no param, no query key and no body
 * field through which a caller can name another agent, and the whitelists below
 * are the mechanism rather than a convention: `forwardAllowedQuery` copies only
 * the named params and REFUSES anything else, so an `?agent_user_id=` a client
 * appends is a **400** — the request is never built at all, let alone sent to core
 * with the param ignored. Stronger than the drop it replaced, and deliberately so:
 * "dropped" is the word this whole change exists to stop using, because a silently
 * discarded param is a request that succeeded while doing something other than
 * what was asked. That is the same discipline the agent-action schemas use
 * (`proxy-agency-agent.routes.ts`: "a browser that could name the agent could go
 * available as a colleague"), and it matters more here, because reading another
 * agent's dispositions and talk time is a peer-surveillance surface the product
 * deliberately does not offer.
 *
 * A supervisor reading a named agent is the SUPERVISORY pair, floored at
 * `agency.supervise` (`account_admin`, 30) and tenant-scoped below.
 *
 * ── Identity is master's, on the supervisory pair only ────────────────────
 * Core has no user table (design D3), so it can only ever serve a UUID. Master is
 * the only service that can turn that into a person, exactly as it does for the
 * agent floor and the attempt spine. The `my-*` pair is deliberately NOT enriched:
 * the caller is the subject, they know their own name, and a database read on a
 * route a console polls is cost with no answer attached. Both halves keep the
 * degrade-never-500 rule — a failed lookup yields `agent_name: null`, never a 500.
 */

/**
 * What core's `GET /agency-agents/:agentUserId/stats` accepts, and therefore all
 * master forwards.
 *
 * A whitelist rather than `request.query` wholesale, for the reason
 * `agency-spine.ts` gives at length: forwarding everything means master cannot say
 * what its own API accepts, and any param core later gives a meaning to becomes
 * reachable through master without anyone deciding it should be.
 *
 * **`agent_user_id` is absent from BOTH lists on purpose, and its absence is the
 * security property, not the documentation of one.** The subject of these reads is
 * decided by the path segment master builds, and on the `my-*` routes that segment
 * comes from the session. A param that could name a different agent would be an
 * authorization decision taken from the query string.
 */
const AGENT_STATS_QUERY_PARAMS = ['from', 'to', 'bucket', 'campaign_id'] as const;

/**
 * Core's attempt filters for one agent, plus paging.
 *
 * `cursor`/`limit` are included here — unlike on the spine's CSV drain, where
 * master sets them itself and a caller-supplied one would fight it. There is no
 * export on this surface, so there is nothing to fight.
 *
 * **`contact_id` and `phone` are on this list because core APPLIES them here.**
 * Core's `parseAgentAttemptFilters` delegates to the campaign spine's
 * `parseAttemptFilters` — its own docstring says the vocabulary is "IMPORTED, not
 * forked" — and `listForAgent` puts both into the statement (`a.contact_id = …`
 * and `phoneCondition(…)`). Master's own campaign-spine whitelist
 * (`ATTEMPT_QUERY_PARAMS` in `agency-spine.ts`) already carries both. Omitting
 * them here did not refuse the filter, which would at least be visible: it made
 * `forwardAllowedQuery` drop the key silently, so a `?phone=` search answered
 * **200 with the agent's whole unfiltered history** — a search control that looks like it
 * matched everything rather than one that failed. The console sends `phone`, so
 * this is what makes that control real.
 */
const AGENT_ATTEMPT_QUERY_PARAMS = [
  'outcome', 'state', 'disposition_code', 'campaign_id', 'contact_id', 'phone',
  'from', 'to', 'cursor', 'limit',
] as const;

/**
 * What core's `GET /agency-agents/stats` (the ROSTER read) accepts, and therefore
 * all master forwards.
 *
 * `sort`, `order` and `limit` are core's because the ranking is core's: a roster
 * sorted in master would be sorted AFTER `limit` had already thrown rows away, so
 * "the top 100 by success rate" would mean "100 arbitrary agents, sorted". Same
 * argument as the rates — the arithmetic lives where the data is.
 *
 * **`agent_user_id` is absent, and here its absence means something different
 * from the per-agent lists above.** There it kept a caller from naming a
 * colleague; here the subject IS everybody in scope, so the param would be a
 * filter core does not implement (the compare surface is phase 02). Left off the
 * list it is refused rather than dropped, which is the difference between a
 * client learning its filter does not exist and a client believing a full roster
 * is the two agents it asked about.
 */
const ROSTER_QUERY_PARAMS = ['from', 'to', 'campaign_id', 'sort', 'order', 'limit'] as const;

/**
 * What core's `GET /agency-agents/grouped-stats` (the GROUPED read, phase 02a)
 * accepts, and therefore all master forwards.
 *
 * `group_by` is the only addition over {@link ROSTER_QUERY_PARAMS}, and master
 * forwards it **unparsed**. The vocabulary, the two-dimension cap, the
 * canonicalisation of the order, the timezone rule that refuses a time dimension
 * across campaigns in different zones, and `group_by`'s required-ness are all
 * core's, because core is where the rows are grouped — a second parser in this
 * hop would be a second definition of the same enum, and the one that drifts is
 * the one no query ever exercises. Master's job on this param is to let it
 * through rather than to have an opinion about it, and core's 400 (`details`
 * included) survives the error mask because master forwards a non-2xx body
 * untouched.
 *
 * **`agent_user_id` is absent for the roster's reason, restated by the contract
 * for this route:** core has no user table, so `agent_user_id` is an opaque
 * string it cannot tenancy-check, and master's `memberships` is the only place
 * that boundary can exist. Filtering the read down to one person is the
 * per-agent record's job, where the id is proved against this tenant first
 * ({@link assertAgentInTenant}). Off the list it is refused rather than dropped.
 */
const GROUPED_QUERY_PARAMS = [
  'from', 'to', 'campaign_id', 'group_by', 'sort', 'order', 'limit',
] as const;

/**
 * `include_inactive` is MASTER'S, and core must never see it.
 *
 * It decides which rows survive master's membership filter, and membership is a
 * fact only master holds — core has no user table (design D3) and would have
 * nothing to do with the param but ignore it. Declared as `consumedByRoute` on
 * {@link forwardAllowedQuery} rather than simply omitted: omission would make
 * strictness refuse every request that sends it (a 400 on the console's own
 * checkbox), while a bare omission from the FORWARD list with no declaration is
 * the silent drop this whole mechanism exists to stop.
 *
 * Shared by the roster and the grouped read rather than declared once per route:
 * it is one param with one meaning and one parser
 * ({@link parseIncludeInactive}), and a per-route copy is how the two reads come
 * to disagree about what `?include_inactive=1` means. It carries no `ROSTER_`
 * prefix for that reason.
 */
const MASTER_ONLY_QUERY_PARAMS = ['include_inactive'] as const;

/**
 * Wall-clock bound on the one core call this route makes.
 *
 * ── Why a bound at all: nothing else in the path has one ───────────────────
 * `proxyToCore` with no `timeoutMs` runs under undici's default 300s header
 * timeout, and core has **no `statement_timeout`** — nothing in its `src/db/` or
 * `src/config/` sets one — so neither end of this call is bounded by anything a
 * reader would recognise as a limit. The roster is the most expensive read on
 * this surface: an aggregate over every attempt in the window plus an occupancy
 * read that walks every agent state transition in it, two long statements in
 * series, with master's worker and its Fastify connection held behind both. The
 * neighbouring activity export took the same medicine for the same reason — see
 * `ACTIVITY_EXPORT_TIME_BUDGET_MS` in `src/agency/agency-activity.ts`, whose
 * docstring is the argument this constant is the second application of: a core
 * answering SLOWLY rather than failing is the case a row ceiling or a window cap
 * cannot bound.
 *
 * ── Why 30s, the export's number rather than the probe's ───────────────────
 * Chosen against the reader, exactly as the export's is: it sits inside the
 * browser's patience and well inside the 300s undici header timeout, so the read
 * gives up on its own terms rather than being cut off mid-response by a socket.
 * It is NOT shortened to `ACTIVITY_OWNERSHIP_PROBE_TIMEOUT_MS`'s 10s, because
 * that budget is deliberately short for the opposite reason — a probe has the
 * whole export still ahead of it, while this call IS the request. Core's window
 * cap on this route (92 days) bounds how much work a caller can ask for; this
 * bounds how long master will wait for it, and the two are not substitutes.
 *
 * ── How expiry reaches the client ─────────────────────────────────────────
 * `AbortSignal.timeout` makes `fetch` reject, `proxyToCore` logs and rethrows,
 * and the handler does not catch it — deliberately. It reaches Fastify's
 * `errorHandler` as a `TimeoutError` with no `statusCode`, so the client gets a
 * **500 that `errorMaskHook` has replaced with the generic support body**; the
 * DOMException's own message never leaves the process, and the full error is in
 * the log with the request id. That is the same outcome every unbounded core
 * call in master already produces on a network fault, so this constant changes
 * WHEN the answer arrives, not what it says — which is the point. Inventing a
 * 504 here would be a new convention on one route (master has none anywhere).
 */
export const ROSTER_CORE_TIME_BUDGET_MS = 30_000;

/**
 * `?include_inactive=` as a boolean, or `null` if it is not one.
 *
 * ── Why a garbage value is refused rather than read as false ────────────────
 * Same reasoning as the unknown-param refusal one function up.
 * `?include_inactive=yes` coerced to `false` answers 200 with the departed agents
 * hidden — the opposite of what was asked, with nothing on the wire saying so,
 * and `inactive_omitted` reporting the omission as though it had been requested.
 * A repeat (`?include_inactive=true&include_inactive=false`) arrives as an array
 * and is refused for the same reason: there is no defensible pick between two
 * contradictory instructions.
 *
 * A blank value is `false`, matching what `forwardAllowedQuery` does with a blank
 * on the forwarded params: `?include_inactive=` is what an unchecked box posts.
 */
function parseIncludeInactive(query: unknown): boolean | null {
  const raw = ((query ?? {}) as Record<string, unknown>)['include_inactive'];
  if (raw === undefined || raw === null) return false;
  if (typeof raw !== 'string') return null;
  const value = raw.trim().toLowerCase();
  if (value.length === 0 || value === 'false' || value === '0') return false;
  if (value === 'true' || value === '1') return true;
  return null;
}

/**
 * Core's body plus master's own two omission counters, for a path on which
 * master filtered nothing.
 *
 * ── Why this is a function and not two lines written twice ──────────────────
 * Neither `inactive_omitted` nor `unattributed_omitted` appears anywhere in
 * core's payload — master invented both — so master is the only thing that can
 * ever put them there, and a body served without them is a body no client can
 * read. The console COMPUTES with them:
 * `total_agents <= rows.length + inactive_omitted + unattributed_omitted` (and
 * its `total_groups` twin on the grouped read) is what decides whether a
 * truncation note renders, so with a key absent that arithmetic is `n <= NaN`,
 * which is `false` — and the note appeared on a page that had never been
 * truncated. A 200 whose body is outside the contract is not a degrade, it is a
 * second bug wearing one.
 *
 * The console reads both through `typeof` guards and treats an absent value as 0,
 * so a body missing one degrades rather than breaking. That is the client being
 * defensive about a field master promises, not permission to omit it: the guard
 * restores yesterday's behaviour, and yesterday's behaviour on the roster was the
 * bug above.
 *
 * A review found exactly that on the roster's degrade path. Both reads now go
 * through one function, because the alternative is each of them separately
 * remembering — and the second copy is where the fix does not reach.
 *
 * `unattributed_omitted` was added afterwards and put through this same helper
 * rather than learning that lesson a second time. It enters the same arithmetic
 * and carries the same `NaN` hazard, so emitting it on some paths only would be
 * the already-fixed bug in a new field.
 *
 * It also decided how the console words its reconciliation sentence. That
 * sentence used to say the gap between a campaign's own total and the visible
 * agent rows was EXACTLY the departed agents' work; this count is one of three
 * reasons that was false (`limit` truncating is another, and a departed member
 * who booked nothing moves no share at all), so the console now names what is
 * missing and claims nothing about the size of the gap. Master's job is unchanged
 * either way — report the two numbers separately and never fold an
 * unattributable row into a count of former members, because that would assert
 * somebody left a team they were never on.
 *
 * Only an OBJECT body can carry a key at all. A 200 whose body is a string, a
 * number or an array is not a page in any field, and wrapping one to make room
 * for a counter would invent a shape nobody declared — so those are returned by
 * reference, exactly as they arrived.
 */
function withOmissionCounters(
  body: unknown,
  inactiveOmitted: number,
  unattributedOmitted: number,
): unknown {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return body;
  // Spread LAST, so master's own fields win over anything core sends under those
  // names. Both are written even where both are `0`: the values are truthful at
  // every call site (this is used only where no row was dropped for EITHER
  // reason), and a key omitted because it happened to be zero is exactly the
  // absence a client cannot tell from a field it forgot to read.
  return {
    ...(body as Record<string, unknown>),
    inactive_omitted: inactiveOmitted,
    unattributed_omitted: unattributedOmitted,
  };
}

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
 * — the rule stated at the top of docs/reference/magick-master/CLAUDE.md's RBAC section, and the shape of two
 * separate cross-tenant defects already found in this service. `agent_user_id` is
 * an opaque string to core: it has no user table and no tenant check of its own
 * over that column (design D3, and `agency_agent_sessions.agent_user_id` has no
 * FK). So core CANNOT refuse a foreign agent id on master's behalf here — it would
 * happily return that person's attempts and talk time, scoped to the campaigns of
 * whichever tenant's key was used but keyed on a user who belongs to another
 * tenant. Master holds `memberships`, so master is the only service that can make
 * this check, and it must therefore make it.
 *
 * ── 404, never 403 ────────────────────────────────────────────────────────
 * A user id in another tenant and one that does not exist answer identically.
 * Rule 3 of the same section: anything else is a user-id oracle. This mirrors the
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
 * design (migration 060 closes rather than deletes, so "who was staffed here in
 * March" stays answerable) and the numbers behind them would have been
 * unreachable.
 *
 * That widens WHO can be read and not WHAT: the tenant predicate is unchanged and
 * still in the same statement, so a user who was never in this tenant is refused
 * exactly as before. The precedent, and the reasoning verbatim, is
 * `userRepository.findDisplayNamesInTenant` — which already resolves a revoked
 * member's NAME onto these very payloads, so refusing the numbers while naming
 * the person was two halves of one surface disagreeing.
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

/** Log-and-continue for a failed name lookup; see the module header. */
function warnNameLookup(request: FastifyRequest, surface: string) {
  return (err: unknown) => {
    log.warn(
      {
        tenantId: request.tenantId,
        surface,
        err: err instanceof Error ? err.message : String(err),
      },
      'agency agent performance: name resolution failed; emitting agent_name: null',
    );
  };
}

export async function proxyAgencyPerformanceRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', sessionMiddleware);
  app.addHook('preHandler', tenantContextMiddleware);
  // PORT NOTE (magick-agency): master's entitlement gate `requireCapability('agency')` is
  // deleted — there is no governance, and the section-level `agency` gate is always on because
  // the app IS agency (plan §3.2; lane A's `campaign-behavioral-settings.ts` header). The RBAC
  // floors below are unchanged.

  /**
   * GET /proxy/agency/my-stats — the agent's own scorecard.
   *
   * A verbatim passthrough of core's per-agent stats for `request.user.id`:
   * `{ agent_user_id, bucket, from, to, totals: { attempts, connected,
   * connect_rate_pct, successes, success_rate_pct, talk_seconds, wrapup_seconds,
   * aht_seconds, campaigns, occupancy }, buckets: [...], by_campaign: [...] }`.
   *
   * Master reshapes nothing. Core owns the arithmetic — the rates, the AHT, the
   * occupancy split — and a second definition of "connect rate" living in this
   * hop is a second definition that drifts from the one the supervisor's dashboard
   * shows. The only master-side facts on this surface are the gate and the actor,
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
    // A platform API key proves a TENANT and names no caller, and RBAC waves such
    // callers past entirely (`rbac.middleware.ts`). There is no "my" for a key, so
    // this is refused rather than answered for an arbitrary agent — shared with the
    // staffing plugin's `my-*` routes so one condition has one answer.
    //
    // The refusal keys on `apiKeyTenantId`, NOT on a missing `request.user`: the
    // API-key branch of `sessionMiddleware` loads the key's `created_by` into
    // `request.user`, so a key minted by a person authenticates carrying that
    // person and the obvious `if (!request.user?.id)` answered with THEIR
    // scorecard. See {@link resolveMyAgentId}.
    const userId = resolveMyAgentId(request, reply);
    if (userId === null) return reply;

    // Refused before the core call, so the 400 is not masked as a proxy error.
    const forwarded = forwardAllowedQuery(request.query, AGENT_STATS_QUERY_PARAMS);
    if (!forwarded.ok) return reply.code(400).send(unknownQueryParamsError(forwarded.unknown));

    const result = await callCore({
      method: 'GET',
      // The subject comes from the SESSION and is interpolated here. Nothing a
      // client sends can reach this segment.
      path: `/agency-agents/${userId}/stats`,
      query: forwarded.query,
      tenantId: request.tenantId!,
      accountId: request.accountId,
      metricPath: '/agency-agents/:id/stats',
    });
    return reply.code(result.status).send(result.body);
  });

  /**
   * GET /proxy/agency/my-attempts — the agent's own call history.
   *
   * Core's keyset page, forwarded verbatim: `{ rows, next_cursor, limit }`. Same
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

    const result = await callCore({
      method: 'GET',
      path: `/agency-agents/${userId}/attempts`,
      query: forwarded.query,
      tenantId: request.tenantId!,
      accountId: request.accountId,
      metricPath: '/agency-agents/:id/attempts',
    });
    return reply.code(result.status).send(result.body);
  });

  /**
   * GET /proxy/agency/agents/stats — a supervisor reads the whole roster.
   *
   * One row per agent who dialled in the window, plus the cohort `benchmark` that
   * makes a single row readable. Phase 01 of the supervisor console: a live query
   * now, a nightly rollup swapped in underneath the same payload in phase 02 —
   * which is why the response shape is a frozen contract from the moment this
   * ships and master adds exactly three things to it (`agent_name` per row,
   * `inactive_omitted` and `unattributed_omitted` at the top level) and reshapes
   * nothing else. All three are ADDITIONS, which is the one kind of change the
   * freeze permits — a consumer built against the payload cannot break on a key
   * it does not read.
   *
   * ── Route precedence, and why it is asserted rather than reasoned about ────
   * This path has one fewer segment than `/agents/:userId/stats` below, so
   * Fastify's radix router cannot confuse them — a static child and a parametric
   * child at different depths. That is a true statement about the router and a
   * useless one about this repository: MAG-106 was an assertion that passed
   * vacuously because the route it named did not exist. So the test file asserts
   * both handlers by the path they build for CORE (`/agency-agents/stats` versus
   * `/agency-agents/<uuid>/stats`), which is the only evidence that distinguishes
   * "the router matched the right one" from "the router matched something".
   *
   * ── The account scope is a PREDICATE, not a filter ────────────────────────
   * `request.accountId` is required, and its absence is a 400 rather than a
   * tenant-wide read. A locked product decision: a tenant-wide roster is a
   * deliberate future mode with its own gate, and it must not be reachable by
   * leaving a header off.
   *
   * **This is defence in depth, not the only thing standing in the way — an
   * earlier version of this comment claimed the read would otherwise "silently
   * widen to every account in the tenant", and that is false.** `proxyToCore`
   * does send `x-mgkvc-account` only when master has one, but core's
   * `authMiddleware` requires the header on every authenticated route and answers
   * **400 `Missing required header: x-mgkvc-account`** before any core handler
   * runs (`magic-voice-core/src/api/middleware/auth.middleware.ts`). An unscoped
   * request is refused either way; what it is refused WITH is the difference.
   *
   * So the check earns its place on two counts, neither of them "core would
   * answer": the caller gets a named `account_scope_required` it can act on
   * instead of core's header complaint, which `errorMaskHook` rewrites into
   * "contact support" (a core-forwarded 4xx carrying neither `details` nor an
   * allow-listed `code`); and no per-tenant key decryption and no S2S round trip
   * are spent on a request that cannot succeed.
   *
   * It used to claim a third — that it holds on the platform-API-key branch,
   * "where a key is the easiest way to reach a tenant-wide read". That is now
   * unreachable rather than untrue: the actor guard below refuses EVERY platform
   * key before this check is consulted, so no credential-authenticated request
   * ever gets as far as the account predicate on this route. The protection did
   * not weaken, it moved one line earlier and became total; but a comment that
   * credits this branch for it would send a reader looking for a case that cannot
   * be constructed.
   *
   * The four sibling routes above are keyed on ONE agent, so they forward
   * `request.accountId` when it is there and carry no check of their own — the
   * subject is already narrowed to a person master has tenant-checked, and core's
   * header requirement is what answers an unscoped one. This route's subject is
   * "everyone", and only the account narrows it, which is why the better message
   * is worth spending a branch on here and not there.
   *
   * ── Departed agents: core cannot know, so master decides ──────────────────
   * Core returns every agent who dialled, including one whose membership was
   * revoked in April, because `agent_user_id` is opaque to it (design D3) and
   * there is no user table behind it. Master drops those rows by default and
   * keeps them under `?include_inactive=true`, reporting the count either way as
   * `inactive_omitted` so a short list is never silently short. See
   * {@link filterRosterRowsByMembership} for the three-state logic and
   * `membershipRepository.findAnyByUsersAndTenant` for why the read is one query
   * for the page rather than one per row.
   *
   * **"Still here" is answered against THIS ACCOUNT**, which is why `accountId`
   * is passed to the filter and not only to core. The read is scoped to one
   * account by the predicate above, so an agent revoked from it is a departure
   * from this page even while they are active on an account this supervisor
   * cannot see; a tenant-level membership (`account_id IS NULL`) reaches every
   * account and counts.
   *
   * **The `benchmark` is not recomputed and not touched, under either flag.** Its
   * cohort is the floor as it actually was that week, revoked members included;
   * a number that moved when a supervisor ticked a row filter would be a
   * different number under the same name. The body is SPREAD, so the benchmark
   * core computed is the benchmark served, byte for byte.
   */
  app.get('/agents/stats', {
    preHandler: requirePermission('agency.supervise'),
  }, async (request, reply) => {
    /**
     * A credential does not get the floor's scorecard. Any credential.
     *
     * ── The door this closes is in `rbac.middleware.ts`, not here ───────────
     * `requirePermission` opens with `if (request.apiKeyTenantId && !request.user)
     * return;` — a userless platform API key is waved past BEFORE any permission
     * is looked at, on the stated grounds that "API keys have full tenant
     * access". So the `agency.supervise` floor above, which is correct and which
     * an `agent` genuinely cannot reach, is simply never evaluated on that
     * branch: one GET with a tenant-scoped system key and any account id in the
     * tenant returns every agent's dials, connects, conversions, talk time and
     * utilisation, ranked, with no role, no user and no audit subject.
     *
     * The rationale for refusing rather than inventing a role for it: a
     * credential that names nobody cannot hold a permission whose entire purpose
     * is authorising action on somebody ELSE's work. `agency.supervise` is not a
     * scope, it is a relationship — and there is no supervisor here to have one.
     *
     * ── ⚠️ Why EVERY key, including one that names its creator ──────────────
     * This guard was `request.apiKeyTenantId && !request.user?.id` — narrow on
     * purpose, on the argument that `sessionMiddleware` loads
     * `platform_api_keys.created_by` into `request.user`, so a creator-backed key
     * arrives carrying a real person whose real membership `requirePermission`
     * then holds to `account_admin`. Every clause of that is true and the
     * conclusion does not follow. **`created_by` is provenance of the credential,
     * not the identity of whoever is holding it now** — the correction
     * {@link resolveMyAgentId} and `resolveAgencyActor` already made for the
     * agent-facing surfaces. A key is a bearer token that gets pasted into CI, a
     * webhook receiver, a partner integration and a laptop's shell history; the
     * person who minted it is frequently an `account_admin`, and this route's
     * answer is the entire floor's ranked performance. So a leaked key would read
     * the whole floor **as its creator** — the read is performed with that
     * person's scope, on their colleagues' numbers, without them asking. (These
     * routes write no audit row at all, so 86d45t7rm's `actor_type` does not
     * soften this either way: the objection is to the READ happening, not to how
     * it would have been recorded.)
     *
     * That is a different bargain from the one the narrow condition was weighed
     * against. The cost of closing it fully is real and small: an integration
     * that legitimately wants this read must present a session. The cost of
     * leaving it open is a peer-surveillance surface reachable with a string.
     *
     * So the condition is now {@link isPlatformApiKeyCaller} — `apiKeyTenantId`,
     * which the API-key branch sets unconditionally and no other branch sets at
     * all — the SAME predicate the `my-*` routes use, for what turns out to be
     * the same reason rather than a different one.
     *
     * ── Why this route and not `rbac.middleware.ts` ─────────────────────────
     * The bypass is platform-wide — every proxy route in the service sits behind
     * it — so closing it centrally is a separate change with a regression surface
     * this review cannot bound.
     * This route is new, has no shipped caller, and is the worst thing reachable
     * through the bypass on this surface, so it is closed at the call site — the
     * same containment the `my-*` routes already practise with
     * {@link resolveMyAgentId}.
     *
     * The code is the `my-*` routes' `missing_actor` — one string for one
     * condition across this prefix, and already allow-listed in the error mask —
     * with a message true of THIS route. `replyMissingActor`'s own text ("has no
     * assignment. Sign in as the agent.") is about an agent's own surface and
     * would misdescribe a supervisory read, which is the only reason it is not
     * called directly.
     */
    // PORT NOTE (magick-agency): master's `if (isPlatformApiKeyCaller(request))` 400
    // `missing_actor` refusal is deleted with platform API keys (decision #5); the
    // predicate no longer exists (`agency-actor.ts`). Every caller here holds a session.

    // Captured before the guard rather than re-read after it: the checks below
    // and the core call are separated by `await`s, and a narrowing on
    // `request.accountId` that TypeScript keeps across them is a narrowing this
    // route's correctness should not rest on.
    const accountId = request.accountId;
    if (!accountId) {
      return reply.code(400).send({
        error: 'Bad Request',
        code: 'account_scope_required',
        message: 'This read is scoped to one account. Send X-Account-Id.',
      });
    }

    // Refused before the core call, so the 400 is not masked as a proxy error.
    const forwarded = forwardAllowedQuery(
      request.query,
      ROSTER_QUERY_PARAMS,
      MASTER_ONLY_QUERY_PARAMS,
    );
    if (!forwarded.ok) return reply.code(400).send(unknownQueryParamsError(forwarded.unknown));

    const includeInactive = parseIncludeInactive(request.query);
    if (includeInactive === null) {
      return reply.code(400).send({
        error: 'Validation failed',
        code: 'invalid_include_inactive',
        // What keeps this refusal readable is that it is raised BEFORE any core
        // call has recorded a status: `errorMaskHook` masks a 4xx only when
        // `sawCoreErrorStatus` says core answered that same status this request,
        // so a route's own 400 passes through whatever shape it has. `details` is
        // here for the client, not for the mask — it is the field-level feedback
        // `unknownQueryParamsError` also carries, and it would only become the
        // load-bearing thing if this refusal ever moved after the proxy call,
        // which is the invariant `errorMaskHook`'s own comment asks routes to
        // keep.
        details: { include_inactive: ['expected true, false, 1 or 0'] },
        message: 'include_inactive must be one of: true, false, 1, 0.',
      });
    }

    const result = await callCore({
      method: 'GET',
      path: '/agency-agents/stats',
      // `include_inactive` is NOT in here: it is declared master-only above and
      // `forwardAllowedQuery` copies only the forward list.
      query: forwarded.query,
      tenantId: request.tenantId!,
      accountId,
      metricPath: '/agency-agents/stats',
      // See ROSTER_CORE_TIME_BUDGET_MS. Without this the call inherits undici's
      // 300s header timeout and core has no statement_timeout behind it, so a
      // slow — not failed — core holds this worker for five minutes.
      timeoutMs: ROSTER_CORE_TIME_BUDGET_MS,
    });

    // Non-2xx bodies pass through untouched so an error reaches the error mask
    // exactly as core wrote it — no filtering, no counter grafted on, and no
    // database round trip spent on a request that failed.
    if (result.status < 200 || result.status >= 300) {
      return reply.code(result.status).send(result.body);
    }

    /**
     * The membership filter runs whenever there is a row array to walk, and the
     * ONLY thing that can send it down the unfiltered path is the absence of one.
     *
     * ── ⚠️ This was gated on `asSpinePage`, and that was a live bug ──────────
     * `asSpinePage` is the CURSOR-page narrowing: it refuses a body whose
     * `next_cursor` is not a string and whose `limit` is not a NUMBER. `limit` is
     * a query param, so `'50'` is the shape it has on the wire — and a core that
     * echoes the caller's own `?limit=50` back as a string produced a body that
     * this route then served **unfiltered, with `inactive_omitted: 0`**. Not a
     * shape "core cannot currently produce", as the comment here used to claim:
     * the realistic one. A departed agent's row on the page, and a payload
     * stating that nothing was hidden — the exact 200-that-lies this whole
     * surface's comment budget goes on making impossible.
     *
     * So the gate is {@link pageRows}, which asks the one question this branch is
     * about. A body with no `rows` array cannot be filtered by anything — there
     * is nothing to walk and nothing to count — and serving that untouched is the
     * same degrade the name enrichers make. A body WITH rows is filtered, whatever
     * its paging fields say, because the rows are what the filter is about.
     */
    const rows = pageRows<RosterAgentRowRef & Record<string, unknown>>(result.body);
    if (!rows) {
      log.warn(
        { tenantId: request.tenantId, accountId },
        'agency roster: core body carries no row array; serving it unfiltered',
      );
      // Unfiltered, but NOT without the counters. Master dropped nothing on this
      // path, for either reason, so `0`/`0` are the truthful values rather than
      // filler — and neither field can be omitted merely because the body was
      // unrecognised. See {@link withOmissionCounters} for what a body without
      // them does to a client, and why both reads share one function for this.
      return reply.code(result.status).send(withOmissionCounters(result.body, 0, 0));
    }

    /**
     * ONE membership read for the whole page, never one per row.
     *
     * Not wrapped in a try/catch, unlike the name lookup below, and the
     * difference is deliberate: a name is an improvement on an id, while this
     * decides WHICH ROWS EXIST. Degrading it would mean either serving departed
     * agents with `inactive_omitted: 0` — a payload that states, falsely, that
     * nothing was hidden — or dropping everybody. Both are confident wrong
     * answers, which is the outcome this feature's whole comment budget goes on
     * avoiding. A genuine database fault therefore propagates, exactly as it does
     * through {@link assertAgentInTenant} on the sibling route.
     */
    const memberships = await membershipRepository.findAnyByUsersAndTenant(
      rows.map((row) => row.agent_user_id),
      request.tenantId!,
    );
    // `accountId` is handed to the filter, not just to core: "still on the
    // roster" is a question about THIS account, and a membership active on
    // another one is not an answer to it. See `filterRowsByMembership`.
    const filtered = filterRosterRowsByMembership(rows, memberships, accountId, includeInactive);

    if (filtered.unknownOmitted > 0) {
      // Logged AND served, as `unattributed_omitted` below — two different jobs.
      // The field lets a console account for the rows that vanished; the log line
      // says an operator should find out why core's scope and master's
      // `memberships` disagree about who works in this account. It is never
      // folded into `inactive_omitted` (R4): reporting a stranger as a departed
      // colleague is a different lie from hiding one.
      //
      // Not the unreachable case an earlier comment here claimed. Core scoping
      // every roster statement on `tenant_id` AND `account_id` rules out a
      // FOREIGN agent and says nothing about a FORMER one — core keeps attempt
      // history forever while a `memberships` row goes away with the user.
      log.warn(
        { tenantId: request.tenantId, accountId, unknownOmitted: filtered.unknownOmitted },
        'agency roster: core returned agent ids with no membership in this tenant; rows dropped',
      );
    }

    const scoped = {
      // SPREAD, so `benchmark`, `total_agents`, `from`/`to`, `sort`/`order` and
      // anything core adds next arrive untouched. `total_agents` stays CORE's
      // pre-`limit`, post-scope count on purpose: it answers "how many agents
      // dialled in this window", which is what the benchmark is computed over,
      // and the two counters are the separate facts about what master hid.
      ...(result.body as Record<string, unknown>),
      rows: filtered.rows,
      // TWO numbers, never one. A departure and an id master cannot account for
      // are different facts about different rows (R4), and a console that has to
      // explain a short list needs to know which it is looking at.
      inactive_omitted: filtered.inactiveOmitted,
      unattributed_omitted: filtered.unknownOmitted,
    };

    /**
     * The SAME helper the campaign spine and `/agents/:userId/attempts` use, on
     * the same wire shape (`{ rows: [{ agent_user_id, … }] }`), rather than a
     * second implementation of one transform. It resolves the page's ids in one
     * query and degrades to `agent_name: null` with a warn — never a 500 — which
     * is the rule this whole plugin keeps.
     *
     * Run AFTER the filter, so no name is looked up for a row that is not served.
     */
    const body = await enrichAttemptAgentNames(
      scoped,
      request.tenantId!,
      resolveAgentNames,
      warnNameLookup(request, 'agents/stats'),
    );
    return reply.code(result.status).send(body);
  });

  /**
   * GET /proxy/agency/agents/grouped-stats — one grouped aggregate over agency
   * dial attempts (phase 02a of the supervisor console).
   *
   * One read answers "who drove this campaign", "which hours connect" and "how
   * does this agent's week trend", because the grouping is a parameter rather
   * than a route. Rows are `{ key, attempts, connected, successes, talk_seconds,
   * wrapup_seconds, connect_rate_pct, success_rate_pct, aht_seconds }` and `key`
   * carries a member for each grouped dimension and no others.
   *
   * ── Why this is a SIBLING of the roster and not a `group_by` on it ─────────
   * The roster's payload is frozen (phase 02c swaps a nightly rollup in under a
   * console already built against it), and `AgencyRosterAgentRow` is keyed on
   * `agent_user_id` — a campaign-grouped or hour-grouped row is not that shape.
   * Adding `group_by` there would make a frozen payload's `rows` polymorphic,
   * which is the worst of both. So: a new route, the same plugin, the same gate,
   * the same three master-side facts.
   *
   * ── Master owns exactly what it owns on the roster, and nothing more ───────
   * The account predicate, the query whitelist, the departed-agent filter and
   * `agent_name`. Every number, every rate, the `total_groups` count, the
   * grouping vocabulary, the two-dimension cap, the row order and the timezone
   * rule are core's — see {@link GROUPED_QUERY_PARAMS} for why master forwards
   * `group_by` without parsing it.
   *
   * ── The membership filter is CONDITIONAL here, and that creates a trap ────
   * Departed agents are dropped only when `agent` is one of the grouped
   * dimensions, because that is the only case in which a row is *about* a
   * person. A `campaign`-grouped row is an aggregate over everyone who dialled
   * that campaign, so there is no row to drop and nothing was omitted.
   *
   * ⚠️ **The two therefore do not reconcile, and neither number is wrong.** A
   * campaign-grouped total INCLUDES a departed agent's attempts; an
   * agent-grouped view of the same campaign EXCLUDES them by default, and the
   * difference is exactly the departed agents' work. Both are true answers to
   * different questions — what would be wrong is a console showing them adjacent
   * without saying so. This is counter-intuitive enough to look like a bug, so
   * `test/unit/agency/proxy-agency-grouped-stats.routes.test.ts` pins the
   * asymmetry on one fixture with both groupings, to stop it being "fixed".
   * `include_inactive` is meaningful only when `agent` is grouped; on any other
   * grouping it is accepted, changes nothing, and `inactive_omitted` is 0
   * because that is the truth rather than a fudge.
   *
   * ── BOTH omission counters are emitted on EVERY path ──────────────────────
   * `inactive_omitted` and `unattributed_omitted`, including the not-grouped
   * path and the degrade path (`0` on both, truthfully). They are master's own
   * inventions, so a body without them is a body no client can read — see
   * {@link withOmissionCounters}.
   *
   * `unattributed_omitted` is what keeps the reconciliation warning above
   * ARITHMETICALLY true rather than merely narrated. The gap between a
   * campaign-grouped total and the visible agent rows is the departed agents'
   * work only if nothing ELSE was dropped, and R4's third state drops rows too —
   * one row per campaign for a single unaccountable id on an `agent,campaign`
   * page. Withheld, it made the console's one quantitative claim false with no
   * way for a client to know.
   */
  app.get('/agents/grouped-stats', {
    preHandler: requirePermission('agency.supervise'),
  }, async (request, reply) => {
    // A credential does not get the floor's numbers broken out by person. The
    // condition, the code and the reasoning are the roster's verbatim —
    // `rbac.middleware.ts` waves a userless platform API key past before
    // `agency.supervise` is ever evaluated, and `agency.supervise` is a
    // relationship rather than a scope.
    //
    // `isPlatformApiKeyCaller`, i.e. EVERY key. This guard used to be the narrow
    // `apiKeyTenantId && !request.user?.id`, admitting a key that carries its
    // `created_by` on the grounds that `requirePermission` then makes a genuine
    // role decision about that person. It does — about a person who need not be
    // the holder. `created_by` is provenance of the credential, so a leaked key
    // read this whole surface AS its creator; see the roster's guard above for
    // the full argument, which applies here with the extra sting that
    // `group_by=agent` is precisely the per-person breakout.
    // PORT NOTE (magick-agency): master's `if (isPlatformApiKeyCaller(request))` 400
    // `missing_actor` refusal is deleted with platform API keys (decision #5); the
    // predicate no longer exists (`agency-actor.ts`). Every caller here holds a session.

    // Captured before the guard rather than re-read after it, for the roster's
    // reason: the checks and the core call are separated by `await`s.
    const accountId = request.accountId;
    if (!accountId) {
      return reply.code(400).send({
        error: 'Bad Request',
        code: 'account_scope_required',
        message: 'This read is scoped to one account. Send X-Account-Id.',
      });
    }

    // Refused before the core call, so the 400 is not masked as a proxy error —
    // and before `resolveCoreApiKey`, so no per-tenant core key is decrypted for
    // a request that cannot succeed.
    const forwarded = forwardAllowedQuery(
      request.query,
      GROUPED_QUERY_PARAMS,
      MASTER_ONLY_QUERY_PARAMS,
    );
    if (!forwarded.ok) return reply.code(400).send(unknownQueryParamsError(forwarded.unknown));

    const includeInactive = parseIncludeInactive(request.query);
    if (includeInactive === null) {
      return reply.code(400).send({
        error: 'Validation failed',
        code: 'invalid_include_inactive',
        details: { include_inactive: ['expected true, false, 1 or 0'] },
        message: 'include_inactive must be one of: true, false, 1, 0.',
      });
    }

    const result = await callCore({
      method: 'GET',
      path: '/agency-agents/grouped-stats',
      // `include_inactive` is not in here: it is declared master-only above and
      // `forwardAllowedQuery` copies only the forward list.
      query: forwarded.query,
      tenantId: request.tenantId!,
      accountId,
      metricPath: '/agency-agents/grouped-stats',
      // The roster's budget, for the roster's reason: core has no
      // `statement_timeout` anywhere, so without this the call inherits undici's
      // 300s header timeout and a SLOW core holds this worker for five minutes.
      // This read is if anything the more expensive of the two — its row count is
      // the product of the grouped dimensions' cardinalities — so a shared
      // constant is right and a second number with the same value would be two
      // things to change.
      timeoutMs: ROSTER_CORE_TIME_BUDGET_MS,
    });

    // Non-2xx bodies pass through untouched so an error reaches the error mask
    // exactly as core wrote it. Core's own refusals are the interesting ones
    // here — `too_many_dimensions`, an unknown dimension, `timezone_ambiguous`,
    // the 92-day window cap — and each carries `details` that must survive.
    if (result.status < 200 || result.status >= 300) {
      return reply.code(result.status).send(result.body);
    }

    // {@link pageRows} and NOT `asSpinePage`, for the reason spelled out on the
    // roster's twin above: `asSpinePage` refuses a body over `next_cursor` and a
    // non-numeric `limit`, and a core echoing the caller's `?limit=50` back as
    // the string `'50'` would take this branch — serving an agent-grouped page
    // unfiltered under `inactive_omitted: 0`. The only body that cannot be
    // filtered is one with no row array, which is exactly what this asks.
    const rows = pageRows<AgencyGroupRowRef & Record<string, unknown>>(result.body);
    if (!rows) {
      log.warn(
        { tenantId: request.tenantId, accountId },
        'agency grouped stats: core body carries no row array; serving it unfiltered',
      );
      // Unrecognised is not a licence to drop the counters: see the roster's
      // twin above and {@link withOmissionCounters}. Nothing was filtered here,
      // for either reason, so `0`/`0` are true.
      return reply.code(result.status).send(withOmissionCounters(result.body, 0, 0));
    }

    /**
     * Whether `agent` was grouped, read off the ROWS rather than off a param —
     * and off the row's KEY SHAPE rather than off the usability of its id.
     *
     * The contract puts a member in `key` if and only if its dimension is in
     * `group_by`, so "a row's key has an `agent_user_id` member" and "`agent` was
     * grouped" are the same fact, and this is the form of it master can actually
     * verify. Re-parsing the caller's `group_by` would fork core's vocabulary and
     * canonicalisation into a second parser; trusting core's echoed `group_by`
     * would make the membership filter depend on a field no row is keyed to.
     *
     * ── ⚠️ This was `groupedRowAgentId(row) !== null`, a different test ──────
     * That asks whether the id is USABLE, and it answers "not agent-grouped" for
     * a page whose only agent keys are empty strings, nulls or numbers. Such a
     * page took the pass-through branch below and was served unfiltered with both
     * counters at 0 — every row about a person master could not account for,
     * under a payload claiming nothing was hidden. Shape decides the BRANCH;
     * {@link groupedRowAgentId} decides each ROW, and a key that is present but
     * unusable is R4's third state (dropped, counted in
     * `unattributed_omitted`) rather than a reason to skip the filter.
     *
     * An empty page is not agent-grouped by this test, and that is the right
     * answer rather than a gap: there is no row to filter, no name to look up
     * and nothing omitted, so both branches agree on the payload and this one
     * spends no database read reaching it.
     */
    const agentGrouped = rows.some(groupedRowHasAgentKey);

    if (!agentGrouped) {
      // Rows pass through exactly as core grouped them, and BOTH counters are 0
      // as true statements about this page rather than placeholders — a row that
      // is not about a person cannot have a person filtered out of it, and no
      // membership was read to be unable to account for one. The departed
      // agents' attempts are inside these aggregates by design; see the
      // reconciliation warning in the docstring above.
      return reply.code(result.status).send(withOmissionCounters(result.body, 0, 0));
    }

    /**
     * ONE membership read for the whole page, never one per row, and NOT wrapped
     * in a try/catch — the same division as the roster, for the same reason. A
     * name is an improvement on an id; this decides WHICH ROWS EXIST, and
     * degrading it would mean serving departed agents under
     * `inactive_omitted: 0`, a payload that states falsely that nothing was
     * hidden. A genuine database fault therefore propagates (R3).
     *
     * The ids are collected one per row and NOT de-duplicated here, because
     * `findAnyByUsersAndTenant` already does it (`[...new Set(userIds)]`) and one
     * of those is better than two. That is worth saying on this route where it is
     * not on the roster: one row per agent makes duplicates impossible there,
     * while an `agent,campaign` page repeats each agent once per campaign, so
     * here they are the norm.
     */
    const memberships = await membershipRepository.findAnyByUsersAndTenant(
      rows
        .map((row) => groupedRowAgentId(row))
        .filter((id): id is string => id !== null),
      request.tenantId!,
    );
    // `accountId` for the roster's reason: active on ANOTHER account is not
    // "still on this floor". See `filterRowsByMembership`.
    const filtered = filterRowsByMembership(
      rows,
      memberships,
      accountId,
      includeInactive,
      groupedRowAgentId,
    );

    if (filtered.unknownOmitted > 0) {
      // R4's third state: an id with no membership row of ANY status is neither
      // active nor a departure, so it is dropped under either flag and never
      // folded into `inactive_omitted` — reporting a stranger as a departed
      // colleague is a different lie from hiding one. It IS served though, as its
      // own `unattributed_omitted` below, and logged as well: the field lets a
      // console account for the missing rows, the log line says an operator
      // should find out why they were missing.
      //
      // And it is reachable, unlike what an earlier comment here claimed. Core
      // scoping every statement on `tenant_id` AND `account_id` rules out a
      // FOREIGN agent, not a FORMER one — core keeps attempt history forever
      // while a `memberships` row goes away with the user. That costs more here
      // than on the roster: an `agent,campaign` page emits one row per campaign
      // for the same agent, so ONE unaccountable id drops N rows.
      log.warn(
        { tenantId: request.tenantId, accountId, unknownOmitted: filtered.unknownOmitted },
        'agency grouped stats: core returned agent ids with no membership in this tenant; rows dropped',
      );
    }

    const scoped = {
      // SPREAD, so `from`/`to`, `campaign_id`, the echoed `group_by`,
      // `sort`/`order`/`limit`, `total_groups` and anything core adds next arrive
      // untouched. `total_groups` stays CORE's pre-`limit`, post-scope count of
      // groups: R1 still binds, so it, `rows.length` and the two omission
      // counters are independent facts and no "showing X of Y" fraction is
      // derivable from them.
      ...(result.body as Record<string, unknown>),
      rows: filtered.rows,
      // TWO numbers, never one. A departure and an id master cannot account for
      // are different facts about different rows (R4) — and on THIS read the
      // second one is what makes the reconciliation gap above quantifiable
      // rather than just narrated.
      inactive_omitted: filtered.inactiveOmitted,
      unattributed_omitted: filtered.unknownOmitted,
    };

    // Run AFTER the filter, so no name is looked up for a row that is not
    // served. Degrades to `agent_name: null` with a warn — never a 500.
    const body = await enrichGroupedRowAgentNames(
      scoped,
      request.tenantId!,
      resolveAgentNames,
      warnNameLookup(request, 'agents/grouped-stats'),
    );
    return reply.code(result.status).send(body);
  });

  /**
   * GET /proxy/agency/agents/:userId/stats — a supervisor reads one agent.
   *
   * The supervisory twin of `/my-stats`. Same core endpoint, same response shape,
   * two differences and both are deliberate:
   *
   *  1. **`agency.supervise` (`account_admin`, 30).** An `agent` cannot reach it,
   *     which is what stops this being a peer-surveillance surface — an agent
   *     reading a colleague's numbers has no operational case and the product does
   *     not offer it.
   *  2. **The subject is tenant-checked.** See {@link assertAgentInTenant}: core
   *     treats `agent_user_id` as an opaque string and cannot refuse a foreign one,
   *     so master's `memberships` table is the only place this boundary exists.
   *
   * `agent_name` is added on the way out. A supervisor comparing two agents needs
   * a name; core can only ever serve the id.
   */
  /**
   * ── Why this route does NOT carry `/agents/stats`'s API-key refusal ────────
   * Its two siblings above (`/agents/stats`, `/agents/grouped-stats`) refuse every
   * platform API key. These two deliberately do not, and the difference is the
   * SUBJECT, not the credential:
   *
   *  - the roster and the grouped read answer for the WHOLE FLOOR, derived from
   *    whatever scope the caller happens to hold, so a leaked key is bulk peer
   *    surveillance, and the answer itself carries the whole floor's numbers;
   *  - these two answer for ONE agent NAMED IN THE PATH, already proved to be a
   *    member of this tenant by `assertAgentInTenant`. The subject comes from the
   *    request, not from the credential, so a key naming no caller is not
   *    ambiguous about who is being reported on — only about who is asking.
   *
   * `test/integration/api/agency-performance-access.test.ts` pins this as the
   * negative control for the whole file ("the key is not simply broken — it
   * reaches a SUPERVISORY route fine"), which is also what stops a broken key
   * fixture from satisfying every refusal assertion in that file while proving
   * nothing. A guard was added here once and that test is what caught it.
   *
   * The residual exposure is real and accepted: a key whose creator holds
   * `agency.supervise` reads any one agent's scorecard and attempt history. If
   * that is ever judged too much, the fix is to refuse the key here TOO and give
   * that integration test a different negative control — not to leave the two
   * halves of this file disagreeing silently.
   */
  app.get<{ Params: { userId: string } }>('/agents/:userId/stats', {
    preHandler: requirePermission('agency.supervise'),
  }, async (request, reply) => {
    const params = agentParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: 'Validation Error', details: params.error.flatten() });
    }
    if (!(await assertAgentInTenant(request, reply, params.data.userId))) return reply;

    const forwarded = forwardAllowedQuery(request.query, AGENT_STATS_QUERY_PARAMS);
    if (!forwarded.ok) return reply.code(400).send(unknownQueryParamsError(forwarded.unknown));

    const result = await callCore({
      method: 'GET',
      path: `/agency-agents/${params.data.userId}/stats`,
      query: forwarded.query,
      tenantId: request.tenantId!,
      accountId: request.accountId,
      metricPath: '/agency-agents/:id/stats',
    });
    // Non-2xx bodies pass through untouched so an error reaches the error mask
    // exactly as core wrote it.
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
  /**
   * ── Why this route does NOT carry `/agents/stats`'s API-key refusal ────────
   * Its two siblings above (`/agents/stats`, `/agents/grouped-stats`) refuse every
   * platform API key. These two deliberately do not, and the difference is the
   * SUBJECT, not the credential:
   *
   *  - the roster and the grouped read answer for the WHOLE FLOOR, derived from
   *    whatever scope the caller happens to hold, so a leaked key is bulk peer
   *    surveillance, and the answer itself carries the whole floor's numbers;
   *  - these two answer for ONE agent NAMED IN THE PATH, already proved to be a
   *    member of this tenant by `assertAgentInTenant`. The subject comes from the
   *    request, not from the credential, so a key naming no caller is not
   *    ambiguous about who is being reported on — only about who is asking.
   *
   * `test/integration/api/agency-performance-access.test.ts` pins this as the
   * negative control for the whole file ("the key is not simply broken — it
   * reaches a SUPERVISORY route fine"), which is also what stops a broken key
   * fixture from satisfying every refusal assertion in that file while proving
   * nothing. A guard was added here once and that test is what caught it.
   *
   * The residual exposure is real and accepted: a key whose creator holds
   * `agency.supervise` reads any one agent's scorecard and attempt history. If
   * that is ever judged too much, the fix is to refuse the key here TOO and give
   * that integration test a different negative control — not to leave the two
   * halves of this file disagreeing silently.
   */
  app.get<{ Params: { userId: string } }>('/agents/:userId/attempts', {
    preHandler: requirePermission('agency.supervise'),
  }, async (request, reply) => {
    const params = agentParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: 'Validation Error', details: params.error.flatten() });
    }
    if (!(await assertAgentInTenant(request, reply, params.data.userId))) return reply;

    const forwarded = forwardAllowedQuery(request.query, AGENT_ATTEMPT_QUERY_PARAMS);
    if (!forwarded.ok) return reply.code(400).send(unknownQueryParamsError(forwarded.unknown));

    const result = await callCore({
      method: 'GET',
      path: `/agency-agents/${params.data.userId}/attempts`,
      query: forwarded.query,
      tenantId: request.tenantId!,
      accountId: request.accountId,
      metricPath: '/agency-agents/:id/attempts',
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
