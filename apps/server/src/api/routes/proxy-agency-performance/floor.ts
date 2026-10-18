/*
 * The two whole-floor reads, the roster (`agents/stats`) and the grouped aggregate
 * (`agents/grouped-stats`), with the three facts they add over the handler's page in one
 * place (`scopeRowsToMembers`). Part of `proxy-agency-performance.routes.ts`.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { requirePermission } from '../../../rbac/rbac.middleware.js';
import { callCore } from '../../core-dispatch.js';
import { createChildLogger } from '@magick-agency/observability';
import { membershipRepository } from '@magick-agency/db/repositories/membership.repository';
import {
  forwardAllowedQuery,
  unknownQueryParamsError,
  enrichAttemptAgentNames,
  pageRows,
} from '../../../agency/agency-spine.js';
import {
  resolveAgentNames,
  filterRowsByMembership,
  groupedRowAgentId,
  groupedRowHasAgentKey,
  enrichGroupedRowAgentNames,
  type RosterAgentRowRef,
  type AgencyGroupRowRef,
} from '../../../agency/agency-agent-identity.js';
import { warnNameLookup } from './shared.js';

const log = createChildLogger({ component: 'proxy-agency-performance' });

/**
 * What the internal handler's `GET /agency-agents/stats` (the ROSTER read)
 * accepts, and therefore all this route forwards.
 *
 * `sort`, `order` and `limit` are the handler's because the ranking is: a roster
 * sorted in this route would be sorted AFTER `limit` had already thrown rows away, so
 * "the top 100 by success rate" would mean "100 arbitrary agents, sorted". Same
 * argument as the rates — the arithmetic lives where the data is.
 *
 * **`agent_user_id` is absent, and here its absence means something different
 * from the per-agent lists (`per-agent.ts`).** There it kept a caller from naming a
 * colleague; here the subject IS everybody in scope, so the param would be a
 * filter the handler does not implement. Left off the
 * list it is refused rather than dropped, which is the difference between a
 * client learning its filter does not exist and a client believing a full roster
 * is the two agents it asked about.
 */
const ROSTER_QUERY_PARAMS = ['from', 'to', 'campaign_id', 'sort', 'order', 'limit'] as const;

/**
 * What the internal handler's `GET /agency-agents/grouped-stats` (the GROUPED
 * read) accepts, and therefore all this route forwards.
 *
 * `group_by` is the only addition over {@link ROSTER_QUERY_PARAMS}, and this route
 * forwards it **unparsed**. The vocabulary, the two-dimension cap, the
 * canonicalisation of the order, the timezone rule that refuses a time dimension
 * across campaigns in different zones, and `group_by`'s required-ness are all the
 * handler's, because that is where the rows are grouped — a second parser in this
 * layer would be a second definition of the same enum, and the one that drifts is
 * the one no query ever exercises. This route's job on this param is to let it
 * through rather than to have an opinion about it, and the handler's 400
 * (`details` included) reaches the client because a non-2xx body is passed
 * through untouched and every 4xx passes the error mask.
 *
 * **`agent_user_id` is absent for the roster's reason, restated by the contract
 * for this route:** the handler treats `agent_user_id` as an opaque id it does
 * not tenancy-check, and `memberships`, checked here, is the only place that
 * boundary exists. Filtering the read down to one person is the
 * per-agent record's job, where the id is proved against this tenant first
 * ({@link assertAgentInTenant}). Off the list it is refused rather than dropped.
 */
const GROUPED_QUERY_PARAMS = [
  'from', 'to', 'campaign_id', 'group_by', 'sort', 'order', 'limit',
] as const;

/**
 * `include_inactive` is THIS ROUTE'S, and the internal handler must never see it.
 *
 * It decides which rows survive the membership filter here, and the handler's
 * reads do not consult `memberships` — it would have nothing to do with the param
 * but ignore it. Declared as `consumedByRoute` on
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
 * The handler's body plus this route's own two omission counters, for a path on
 * which nothing was filtered.
 *
 * ── Why this is a function and not two lines written twice ──────────────────
 * Neither `inactive_omitted` nor `unattributed_omitted` appears anywhere in the
 * handler's payload — this route adds both — so this route is the only thing that
 * can ever put them there, and a body served without them is a body no client can
 * read. The console COMPUTES with them:
 * `total_agents <= rows.length + inactive_omitted + unattributed_omitted` (and
 * its `total_groups` twin on the grouped read) is what decides whether a
 * truncation note renders, so with a key absent that arithmetic is `n <= NaN`,
 * which is `false` — and the note appears on a page that was never truncated. A
 * 200 whose body is outside the contract is not a degrade, it is a second bug
 * wearing one.
 *
 * The console reads both through `typeof` guards and treats an absent value as 0,
 * so a body missing one degrades rather than breaking. That is the client being
 * defensive about a field this route promises, not permission to omit it.
 *
 * Both reads, and both counters, go through this one function, because the
 * alternative is each of them separately remembering — and the second copy is
 * where a fix does not reach. Emitting `unattributed_omitted` on some paths only
 * would carry the same `NaN` hazard in a new field.
 *
 * The console's reconciliation sentence names what is missing and claims nothing
 * about the size of the gap between a campaign's own total and the visible agent
 * rows: this count is one reason the gap is not EXACTLY the departed agents' work
 * (`limit` truncating is another, and a departed member who booked nothing moves
 * no share at all). This route's job either way is to report the two numbers
 * separately and never fold an unattributable row into a count of former
 * members, because that would assert somebody left a team they were never on.
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
  // Spread LAST, so this route's own fields win over anything the handler sends under those
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
 * The three facts the two whole-floor reads (the roster and the grouped read) add over the
 * internal handler's page, in one place so the two cannot drift.
 *
 *  1. **ONE membership read for the whole page, never one per row** — and not wrapped in a
 *     try/catch, unlike the name lookup: a name is an improvement on an id, while this
 *     decides WHICH ROWS EXIST. Degrading it would mean either serving departed agents with
 *     `inactive_omitted: 0` — a payload that states, falsely, that nothing was hidden — or
 *     dropping everybody. Both are confident wrong answers. A database fault propagates.
 *  2. **The filter** (`filterRowsByMembership`), judged against THIS account, and its two
 *     counters. An id with no membership row of ANY status is the third state: dropped
 *     under either flag and never folded into `inactive_omitted` (reporting a stranger as
 *     a departed colleague is a different lie from hiding one). It is served as
 *     `unattributed_omitted` AND logged — the field lets a console account for the rows
 *     that vanished; the log line says an operator should find out why the handler's
 *     scope and `memberships` disagree. Reachable, not hypothetical: the handler scoping
 *     every statement on `tenant_id` AND `account_id` rules out a FOREIGN agent and says
 *     nothing about a FORMER one — attempt history is kept forever while a `memberships`
 *     row goes away with the user.
 *  3. **The body is SPREAD** with `rows` and the two counters on top — TWO numbers, never
 *     one, since a departure and an id with no membership at all are different facts —
 *     and only then named (`enrich`), so no name is looked up for a row that is not
 *     served. The enrichers degrade to `agent_name: null` with a warn, never a 500.
 */
async function scopeRowsToMembers<TRow>(
  request: FastifyRequest,
  params: {
    body: Record<string, unknown>;
    rows: readonly TRow[];
    agentIdOf: (row: TRow) => string | null;
    accountId: string;
    includeInactive: boolean;
    /** The read's name in its log line: `roster`, `grouped stats`. */
    surface: string;
    enrich: (scoped: unknown) => Promise<unknown>;
  },
): Promise<unknown> {
  const memberships = await membershipRepository.findAnyByUsersAndTenant(
    params.rows.map(params.agentIdOf).filter((id): id is string => id !== null),
    request.tenantId!,
  );
  const filtered = filterRowsByMembership(
    params.rows, memberships, params.accountId, params.includeInactive, params.agentIdOf,
  );

  if (filtered.unknownOmitted > 0) {
    log.warn(
      { tenantId: request.tenantId, accountId: params.accountId, unknownOmitted: filtered.unknownOmitted },
      `agency ${params.surface}: the internal handler returned agent ids with no membership in this tenant; rows dropped`,
    );
  }

  return params.enrich({
    ...params.body,
    rows: filtered.rows,
    inactive_omitted: filtered.inactiveOmitted,
    unattributed_omitted: filtered.unknownOmitted,
  });
}

/**
 * Registered by `proxyAgencyPerformanceRoutes` on its own instance, after its session and
 * tenant-context hooks.
 */
export async function registerFloorPerformanceRoutes(app: FastifyInstance): Promise<void> {
  /**
   * GET /proxy/agency/agents/stats — a supervisor reads the whole roster.
   *
   * One row per agent who dialled in the window, plus the cohort `benchmark` that
   * makes a single row readable. A live query, with the response shape a frozen
   * contract so a precomputed rollup can replace the query under the same payload
   * — which is why this route adds exactly three things to it (`agent_name` per
   * row, `inactive_omitted` and `unattributed_omitted` at the top level) and
   * reshapes nothing else. All three are ADDITIONS, which is the one kind of change the
   * freeze permits — a consumer built against the payload cannot break on a key
   * it does not read.
   *
   * ── Route precedence, and why it is asserted rather than reasoned about ────
   * This path has one fewer segment than `/agents/:userId/stats` (`per-agent.ts`), so
   * Fastify's radix router cannot confuse them — a static child and a parametric
   * child at different depths. That is a true statement about the router and a
   * useless one about this repository: an assertion passes vacuously when the
   * route it names does not exist. So the test file asserts both handlers by the
   * path they build for the internal handler (`/agency-agents/stats` versus
   * `/agency-agents/<uuid>/stats`), which is the only evidence that distinguishes
   * "the router matched the right one" from "the router matched something".
   *
   * ── The account scope is a PREDICATE, not a filter ────────────────────────
   * `request.accountId` is required, and its absence is a 400 rather than a
   * tenant-wide read. A locked product decision: a tenant-wide roster is a
   * deliberate future mode with its own gate, and it must not be reachable by
   * leaving a header off.
   *
   * **This is defence in depth, not the only thing standing in the way — the
   * read would not otherwise "silently widen to every account in the tenant".**
   * `callCore` sends `x-mgkvc-account` only when the request has one, but the
   * internal handler's `authMiddleware` requires the header on every
   * authenticated route and answers **400 `Missing required header:
   * x-mgkvc-account`** before any handler runs
   * (`src/api/middleware/auth.middleware.ts`). An unscoped request is refused
   * either way; what it is refused WITH is the difference.
   *
   * So the check earns its place: the caller gets a named
   * `account_scope_required` it can act on instead of a header complaint, and
   * no handler work is spent on a request that cannot succeed.
   *
   * The four sibling routes (`per-agent.ts`) are keyed on ONE agent, so they forward
   * `request.accountId` when it is there and carry no check of their own — the
   * subject is already narrowed to one person, and the handler's header
   * requirement is what answers an unscoped one. This route's subject is
   * "everyone", and only the account narrows it, which is why the better message
   * is worth spending a branch on here and not there.
   *
   * ── Departed agents: the handler does not know, so this route decides ─────
   * The internal handler returns every agent who dialled, including one whose
   * membership was revoked in April, because its roster read treats
   * `agent_user_id` as an opaque id and never consults `memberships`. This route
   * drops those rows by default and
   * keeps them under `?include_inactive=true`, reporting the count either way as
   * `inactive_omitted` so a short list is never silently short. See
   * {@link filterRosterRowsByMembership} for the three-state logic and
   * `membershipRepository.findAnyByUsersAndTenant` for why the read is one query
   * for the page rather than one per row.
   *
   * **"Still here" is answered against THIS ACCOUNT**, which is why `accountId`
   * is passed to the filter and not only to the handler. The read is scoped to one
   * account by the predicate above, so an agent revoked from it is a departure
   * from this page even while they are active on an account this supervisor
   * cannot see; a tenant-level membership (`account_id IS NULL`) reaches every
   * account and counts.
   *
   * **The `benchmark` is not recomputed and not touched, under either flag.** Its
   * cohort is the floor as it actually was that week, revoked members included;
   * a number that moved when a supervisor ticked a row filter would be a
   * different number under the same name. The body is SPREAD, so the benchmark
   * the handler computed is the benchmark served, byte for byte.
   */
  app.get('/agents/stats', {
    preHandler: requirePermission('agency.supervise'),
  }, async (request, reply) => {
    // Captured before the guard rather than re-read after it: the checks below
    // and `callCore` are separated by `await`s, and a narrowing on
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

    // Refused before `callCore`: an unknown param never reaches the handler.
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
        // Every 4xx passes `errorMaskHook` as written, so `details` is here for
        // the client: it is the field-level feedback `unknownQueryParamsError`
        // also carries.
        details: { include_inactive: ['expected true, false, 1 or 0'] },
        message: 'include_inactive must be one of: true, false, 1, 0.',
      });
    }

    const result = await callCore({
      method: 'GET',
      path: '/agency-agents/stats',
      // `include_inactive` is NOT in here: it is declared route-only above and
      // `forwardAllowedQuery` copies only the forward list.
      query: forwarded.query,
      tenantId: request.tenantId!,
      accountId,
    });

    // Non-2xx bodies pass through untouched, exactly as the handler wrote them —
    // no filtering, no counter grafted on, and no database round trip spent on a
    // request that failed.
    if (result.status < 200 || result.status >= 300) {
      return reply.code(result.status).send(result.body);
    }

    /**
     * The membership filter runs whenever there is a row array to walk, and the
     * ONLY thing that can send it down the unfiltered path is the absence of one.
     *
     * ── ⚠️ Not gated on `asSpinePage` ────────────────────────────────────────
     * `asSpinePage` is the CURSOR-page narrowing: it refuses a body whose
     * `next_cursor` is not a string and whose `limit` is not a NUMBER. `limit` is
     * a query param, so `'50'` is the shape it has on the wire — and a handler
     * that echoes the caller's own `?limit=50` back as a string would produce a
     * body served **unfiltered, with `inactive_omitted: 0`**. That is the
     * realistic shape, not a hypothetical one: a departed agent's row on the
     * page, and a payload stating that nothing was hidden — the exact
     * 200-that-lies this whole surface's comment budget goes on making impossible.
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
        'agency roster: the internal handler\'s body carries no row array; serving it unfiltered',
      );
      // Unfiltered, but NOT without the counters. Nothing was dropped on this
      // path, for either reason, so `0`/`0` are the truthful values rather than
      // filler — and neither field can be omitted merely because the body was
      // unrecognised. See {@link withOmissionCounters} for what a body without
      // them does to a client, and why both reads share one function for this.
      return reply.code(result.status).send(withOmissionCounters(result.body, 0, 0));
    }

    // ONE membership read for the page, the departed-agent filter, both counters and
    // the names — `scopeRowsToMembers`, shared with the grouped read below. Not
    // wrapped in a try/catch, unlike the name lookup inside it: a genuine database
    // fault propagates, exactly as it does through {@link assertAgentInTenant} on the
    // sibling route. `accountId` is handed to the filter, not just to the handler:
    // "still on the roster" is a question about THIS account, and a membership active
    // on another one is not an answer to it. See `filterRowsByMembership`.
    //
    // The spread keeps `benchmark`, `total_agents`, `from`/`to`, `sort`/`order` and
    // anything the handler adds next untouched. `total_agents` stays the handler's
    // pre-`limit`, post-scope count on purpose: it answers "how many agents dialled in
    // this window", which is what the benchmark is computed over, and the two counters
    // are the separate facts about what this route hid.
    const body = await scopeRowsToMembers(request, {
      body: result.body as Record<string, unknown>,
      rows,
      agentIdOf: (row) => row.agent_user_id,
      accountId,
      includeInactive,
      surface: 'roster',
      // The SAME helper the campaign spine and `/agents/:userId/attempts` use, on the
      // same wire shape (`{ rows: [{ agent_user_id, … }] }`), rather than a second
      // implementation of one transform.
      enrich: (scoped) => enrichAttemptAgentNames(
        scoped,
        request.tenantId!,
        resolveAgentNames,
        warnNameLookup(request, 'agents/stats'),
      ),
    });
    return reply.code(result.status).send(body);
  });

  /**
   * GET /proxy/agency/agents/grouped-stats — one grouped aggregate over agency
   * dial attempts.
   *
   * One read answers "who drove this campaign", "which hours connect" and "how
   * does this agent's week trend", because the grouping is a parameter rather
   * than a route. Rows are `{ key, attempts, connected, successes, talk_seconds,
   * wrapup_seconds, connect_rate_pct, success_rate_pct, aht_seconds }` and `key`
   * carries a member for each grouped dimension and no others.
   *
   * ── Why this is a SIBLING of the roster and not a `group_by` on it ─────────
   * The roster's payload is frozen (so a precomputed rollup can replace its live
   * query under a console already built against it), and `AgencyRosterAgentRow` is keyed on
   * `agent_user_id` — a campaign-grouped or hour-grouped row is not that shape.
   * Adding `group_by` there would make a frozen payload's `rows` polymorphic,
   * which is the worst of both. So: a new route, the same plugin, the same gate,
   * the same three route-side facts.
   *
   * ── This route owns exactly what it owns on the roster, and nothing more ───
   * The account predicate, the query whitelist, the departed-agent filter and
   * `agent_name`. Every number, every rate, the `total_groups` count, the
   * grouping vocabulary, the two-dimension cap, the row order and the timezone
   * rule are the handler's — see {@link GROUPED_QUERY_PARAMS} for why this route
   * forwards `group_by` without parsing it.
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
   * path and the degrade path (`0` on both, truthfully). This route adds both,
   * so a body without them is a body no client can read — see
   * {@link withOmissionCounters}.
   *
   * `unattributed_omitted` is what keeps the reconciliation warning above
   * ARITHMETICALLY true rather than merely narrated. The gap between a
   * campaign-grouped total and the visible agent rows is the departed agents'
   * work only if nothing ELSE was dropped, and an id with no membership row of
   * any status drops rows too — one row per campaign for a single unaccountable
   * id on an `agent,campaign` page. Withheld, it would make the console's one
   * quantitative claim false with no way for a client to know.
   */
  app.get('/agents/grouped-stats', {
    preHandler: requirePermission('agency.supervise'),
  }, async (request, reply) => {
    // Captured before the guard rather than re-read after it, for the roster's
    // reason: the checks and `callCore` are separated by `await`s.
    const accountId = request.accountId;
    if (!accountId) {
      return reply.code(400).send({
        error: 'Bad Request',
        code: 'account_scope_required',
        message: 'This read is scoped to one account. Send X-Account-Id.',
      });
    }

    // Refused before `callCore`: an unknown param never reaches the handler.
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
      // `include_inactive` is not in here: it is declared route-only above and
      // `forwardAllowedQuery` copies only the forward list.
      query: forwarded.query,
      tenantId: request.tenantId!,
      accountId,
    });

    // Non-2xx bodies pass through untouched, exactly as the handler wrote them.
    // Its own refusals are the interesting ones here — `too_many_dimensions`, an
    // unknown dimension, `timezone_ambiguous`, the 92-day window cap — and each
    // carries `details` that must survive.
    if (result.status < 200 || result.status >= 300) {
      return reply.code(result.status).send(result.body);
    }

    // {@link pageRows} and NOT `asSpinePage`, for the reason spelled out on the
    // roster's twin above: `asSpinePage` refuses a body over `next_cursor` and a
    // non-numeric `limit`, and a handler echoing the caller's `?limit=50` back as
    // the string `'50'` would take this branch — serving an agent-grouped page
    // unfiltered under `inactive_omitted: 0`. The only body that cannot be
    // filtered is one with no row array, which is exactly what this asks.
    const rows = pageRows<AgencyGroupRowRef & Record<string, unknown>>(result.body);
    if (!rows) {
      log.warn(
        { tenantId: request.tenantId, accountId },
        'agency grouped stats: the internal handler\'s body carries no row array; serving it unfiltered',
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
     * grouped" are the same fact, and this is the form of it this route can
     * actually verify. Re-parsing the caller's `group_by` would fork the handler's
     * vocabulary and canonicalisation into a second parser; trusting its echoed `group_by`
     * would make the membership filter depend on a field no row is keyed to.
     *
     * ── ⚠️ Not `groupedRowAgentId(row) !== null`, which is a different test ───
     * That asks whether the id is USABLE, and it answers "not agent-grouped" for
     * a page whose only agent keys are empty strings, nulls or numbers. Such a
     * page would take the pass-through branch below and be served unfiltered with
     * both counters at 0 — every row about a person nobody can account for, under
     * a payload claiming nothing was hidden. Shape decides the BRANCH;
     * {@link groupedRowAgentId} decides each ROW, and a key that is present but
     * unusable is the third state (dropped, counted in `unattributed_omitted`)
     * rather than a reason to skip the filter.
     *
     * An empty page is not agent-grouped by this test, and that is the right
     * answer rather than a gap: there is no row to filter, no name to look up
     * and nothing omitted, so both branches agree on the payload and this one
     * spends no database read reaching it.
     */
    const agentGrouped = rows.some(groupedRowHasAgentKey);

    if (!agentGrouped) {
      // Rows pass through exactly as the handler grouped them, and BOTH counters are 0
      // as true statements about this page rather than placeholders — a row that
      // is not about a person cannot have a person filtered out of it, and no
      // membership was read to be unable to account for one. The departed
      // agents' attempts are inside these aggregates by design; see the
      // reconciliation warning in the docstring above.
      return reply.code(result.status).send(withOmissionCounters(result.body, 0, 0));
    }

    // The roster's `scopeRowsToMembers`, for the same three facts. The ids are
    // collected one per row and NOT de-duplicated here, because
    // `findAnyByUsersAndTenant` already does it (`[...new Set(userIds)]`) and one of
    // those is better than two — on this read an `agent,campaign` page repeats each
    // agent once per campaign, so duplicates are the norm. `accountId` for the
    // roster's reason: active on ANOTHER account is not "still on this floor".
    //
    // An unattributable id costs more here than on the roster: an `agent,campaign`
    // page emits one row per campaign for the same agent, so ONE unaccountable id
    // drops N rows — and `unattributed_omitted` is what makes the reconciliation gap
    // above quantifiable rather than just narrated. The spread keeps `from`/`to`,
    // `campaign_id`, the echoed `group_by`, `sort`/`order`/`limit`, `total_groups`
    // and anything the handler adds next; `total_groups` stays the handler's
    // pre-`limit`, post-scope count of groups, so it, `rows.length` and the two
    // counters are independent facts and no "showing X of Y" fraction is derivable.
    const body = await scopeRowsToMembers(request, {
      body: result.body as Record<string, unknown>,
      rows,
      agentIdOf: groupedRowAgentId,
      accountId,
      includeInactive,
      surface: 'grouped stats',
      enrich: (scoped) => enrichGroupedRowAgentNames(
        scoped,
        request.tenantId!,
        resolveAgentNames,
        warnNameLookup(request, 'agents/grouped-stats'),
      ),
    });
    return reply.code(result.status).send(body);
  });
}
