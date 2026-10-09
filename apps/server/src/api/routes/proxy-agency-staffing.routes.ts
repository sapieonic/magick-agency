import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { sessionMiddleware } from '../../auth/session.middleware.js';
import { tenantContextMiddleware } from '../middleware/tenant-context.middleware.js';
import { requirePermission } from '../../rbac/rbac.middleware.js';
import { callCore } from '../core-dispatch.js';
import { createChildLogger } from '@magick-agency/observability';
import { platformAuditLogger } from '../../audit/platform/audit-logger.js';
import { requestAuditActor } from '../../audit/platform/audit-actor.js';
import { mapWithConcurrency } from '../../utils/concurrency.js';
import { membershipRepository } from '@magick-agency/db/repositories/membership.repository';
import {
  agencyCampaignAgentRepository,
  HISTORY_LIMIT_MAX,
  StaffingUpgradePendingError,
} from '@magick-agency/db/repositories/agency-campaign-agent.repository';
import { enrichAssignedAgents } from '../../agency/agency-agent-identity.js';

/*
 * Agent → campaign staffing, served at the console's paths under `/proxy/agency` (decision
 * B16). The rows are `agency_campaign_agents`, read and written here directly. The internal
 * handler instance's `GET /agency-campaigns/:id` (feature gate, then `requireOwned` on
 * tenant AND account) is reached in-process through `callCore` for two things: the
 * best-effort summary in `resolveCampaignSummary` and the ownership probe in
 * `assertCampaignInScope`. Audit rows go to `platformAuditLogger` (decision B7). There is no
 * capability gate; the RBAC floors are the gate.
 */

const log = createChildLogger({ component: 'proxy-agency-staffing' });

/**
 * How many campaign summaries `GET /my-assignments` resolves at once.
 *
 * Four, which is comfortably above the number of campaigns a supervisor realistically
 * staffs one agent onto while still bounding the burst if somebody staffs fifty. The
 * agent is blocked on all of them before their home renders, so latency matters more
 * here than throughput — and each one runs the internal handler's campaign read.
 */
const SUMMARY_CONCURRENCY = 4;

/**
 * How long one best-effort campaign summary may take, passed as `timeoutMs`.
 *
 * Inert in-process: `callCore` accepts `timeoutMs` and ignores it (there is no
 * transport to time out; `core-dispatch.ts`), and the handler behind it is one
 * indexed read. The bound it states is still the intent: a courtesy label on a
 * row this route already holds must never be able to hold an agent's own console
 * open; it degrades to `null`, which is the documented normal path here.
 */
const SUMMARY_TIMEOUT_MS = 6_000;

/**
 * How many DISTINCT campaigns one `/my-campaigns` page will name.
 *
 * The row cap alone does not bound the fan-out usefully: 200 rows can be 200
 * campaigns, which at {@link SUMMARY_CONCURRENCY} is 50 sequential waves of handler
 * reads with an agent's console blocked on all of them. Rows arrive
 * newest-first, so the first {@link SUMMARY_LOOKUP_MAX} distinct ids are the
 * recent ones — the half of a history anybody is actually looking at — and the
 * rest report `campaign_name: null`.
 *
 * That degradation is not a new contract: this route already documents nulls as
 * its NORMAL path rather than an edge case ("a history is in fact the surface
 * MOST likely to name campaigns since deleted"), and the ids are what the
 * response is built from. Trading an old row's caption for a bounded page is the
 * same trade the route already makes when a lookup fails.
 */
const SUMMARY_LOOKUP_MAX = 25;

/**
 * The optional window on `GET /my-campaigns`.
 *
 * `from`/`to` rather than a cursor, which is the shape `listAllForUser`'s own
 * docstring nominated: the question a staffing history answers is always about a
 * PERIOD ("was I on this campaign in March"), and a keyset cursor on a list a
 * console renders whole is machinery with no case behind it. It is what makes the
 * row ceiling honest — the rows past it are reachable by naming the period they
 * are in, rather than lost.
 *
 * Refused rather than coerced when unparseable. A silently-dropped `from` answers
 * with the wrong period under a 200, which is the same class of failure as the
 * dropped `phone` filter on the attempt spine: a control that appears to have
 * worked. Like every 4xx, the 400 passes `errorMaskHook` intact, `details` included.
 */
const myCampaignsQuerySchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});

/**
 * Agent → campaign STAFFING: who a supervisor has put on a campaign, and the one
 * question an agent's own console asks before it can render anything.
 *
 * ── Why this file exists, distinct from `proxy-agency-agent.routes.ts` ──────
 * That file is the agent's ACTIONS on the call currently on their station — join,
 * go available, hang up, disposition. This one is the supervisor's list of PEOPLE
 * plus the agent's own lookup of it. They share a prefix and a middleware stack
 * and nothing else: one is a thin wrapper over the internal handler, the other
 * owns its rows and calls the handler only to name a campaign and prove ownership.
 *
 * **"Staffing", not "agents", and the filename is part of the guard.**
 * `proxy-agency-agents.routes.ts` would be one character from its neighbour, in
 * the same directory, serving the same prefix, which is an edit landing in the
 * wrong file waiting to happen. `staffing` is also the word the design uses to
 * separate this concept from authorization (see the next paragraph), so the name
 * carries the distinction rather than merely avoiding a collision. Note it is
 * likewise NOT `roster`: that word already means CONTACTS throughout this
 * codebase (`src/agency/agency-roster.client.ts`, the whole ingest pipeline).
 *
 * ── Staffing is NOT authorization, and nothing here should ever make it so ──
 * An assignment decides where an agent is *sent by default*. It does not gate a
 * join: that is `agency.station.connect`, on the sibling file's `POST /sessions`,
 * and it stays the only gate — a supervisor covering a shift must be able to join
 * a campaign nobody assigned them to, which the RBAC comments in
 * `packages/contracts/src/rbac.ts` protect explicitly. If a future change makes
 * the join consult `agency_campaign_agents` before allowing it, that is a
 * behaviour change to argue for on its merits, not a tidy-up.
 *
 * ── The floors, and the one that is load-bearing ────────────────────────────
 * Three supervisory routes at `agency.supervise` (`account_admin`, 30) and three
 * `my-*` routes at `agency.station.connect` (`agent`, 5). **Every `my-*` route
 * must be reachable by a bare `agent`**, which is the whole reason they exist — an
 * `agent` inherits nothing that predates the agency feature, so they must not
 * depend on any `viewer`-floored permission. In particular they must NEVER be
 * gated on `proxy.contact_lists.read`, which is what the neighbouring campaign
 * reads use: an agent does not hold it, and gating on it would make the agent
 * landing page 403 for exactly the role it was built for. `test/unit/agency/
 * proxy-agency-staffing.routes.test.ts` pins all six floors against the matrix.
 *
 * The same rule governs the agent's own performance reads in
 * `proxy-agency-performance.routes.ts` — a separate plugin on this same prefix,
 * because those are thin wrappers over the internal handler's per-agent
 * endpoints where these rows are read directly.
 *
 * Names and emails come from the user records — see
 * `src/agency/agency-agent-identity.ts` for how names are resolved and why a
 * failed lookup degrades rather than 500s.
 */

/**
 * Best-effort extraction of a string field from the internal handler's response
 * body. The campaign response is passed through untyped, so this narrows
 * defensively rather than trusting the body.
 */
function extractStringField(body: unknown, field: string): string | undefined {
  if (body && typeof body === 'object' && field in body) {
    const value = (body as Record<string, unknown>)[field];
    return typeof value === 'string' ? value : undefined;
  }
  return undefined;
}

/**
 * Which person to staff. `campaign_id` is deliberately NOT a body field — it is
 * the URL's `:id`, so a body cannot name a campaign the caller did not address
 * and quietly assign into it.
 */
/**
 * The 400 every `my-*` route answers an unattributable caller with.
 *
 * A caller the session names no user for has no "my". The code is
 * `missing_actor`, the same code the internal handler answers for a missing
 * actor, so the console keys off one string whichever layer refused.
 *
 * Shared so the routes cannot drift into answering the same condition
 * differently, which is the failure mode a copied handler invites.
 *
 * **Exported** because `proxy-agency-performance.routes.ts` serves
 * `GET /my-stats` and `GET /my-attempts` on this same prefix and hits the
 * identical condition. Re-declaring it there would be another copy of one
 * sentence and one error code, and the console keys off that code — the same
 * reason `rewriteStationWsUrl` is exported from `proxy-agency-station.routes.ts`
 * and imported by the agent-actions plugin rather than duplicated.
 */
export function replyMissingActor(reply: FastifyReply) {
  return reply.code(400).send({
    error: 'Bad Request',
    code: 'missing_actor',
    message: 'A platform API key has no assignment. Sign in as the agent.',
  });
}

/**
 * The agent a `my-*` route is answering ABOUT, or `null` once it has replied 400.
 *
 * There are no platform API keys in v1 (`docs/decisions.md`, open question 5), so
 * `request.user` is always the Firebase-verified person. The user check still
 * refuses a request that names nobody: it is unattributable and must not
 * interpolate `undefined` into a handler path.
 *
 * Shared by both plugins on this prefix for the reason {@link replyMissingActor}
 * gives: five handlers hitting one condition must not answer it five ways, and
 * this is the shape a copied handler silently gets wrong.
 */
export function resolveMyAgentId(request: FastifyRequest, reply: FastifyReply): string | null {
  const userId = request.user?.id;
  if (!userId) {
    replyMissingActor(reply);
    return null;
  }
  return userId;
}

/** What a best-effort campaign lookup could resolve. Either field may be null. */
interface CampaignSummary {
  name: string | null;
  status: string | null;
}

/**
 * Resolve a campaign's name and status through the internal handler. **Never rejects.**
 *
 * Every caller is enriching an answer it already has (an assignment from
 * `agency_campaign_agents`), so a failure here must degrade the courtesy fields and
 * leave the answer standing — the rule `src/agency/agency-stats-enrichment.ts`
 * states: enrichment must never turn a 200 into a 500. A refusal, a campaign since
 * deleted, and an unexpected shape all land on `{ name: null, status: null }`,
 * which is indistinguishable to the client and correctly so: in all three cases
 * the id is the fact and the labels are unavailable. Concretely, any status ≥ 400
 * (403 `feature_disabled`, 404 for another account's or a deleted campaign, 400
 * for a missing account header) and a throw both land on nulls.
 *
 * That total-ness is also load-bearing for the plural route's `Promise.all` — one
 * rejection there would discard every sibling's successful lookup.
 *
 * `status` is passed through rather than validated against an enum. The dialer
 * runtime owns the campaign lifecycle, and a second copy of its states here is a
 * copy that goes stale: a status added there would be mapped to `null` by a
 * mirror, telling the agent "unknown" about a campaign the server knows perfectly
 * well. The client renders an unrecognised status as itself
 * (`AgencyCampaignStatusBadge` does exactly this).
 *
 * `recordCoreErrors` and `timeoutMs` are passed but `callCore` ignores both
 * in-process (`core-dispatch.ts`).
 */
async function resolveCampaignSummary(
  request: FastifyRequest,
  campaignId: string,
): Promise<CampaignSummary> {
  try {
    const result = await callCore({
      method: 'GET',
      path: `/agency-campaigns/${campaignId}`,
      tenantId: request.tenantId!,
      accountId: request.accountId,
      metricPath: '/agency-campaigns/:id',
      recordCoreErrors: false,
      // Ignored in-process — see {@link SUMMARY_TIMEOUT_MS}.
      timeoutMs: SUMMARY_TIMEOUT_MS,
    });
    if (result.status >= 400) return { name: null, status: null };
    return {
      name: extractStringField(result.body, 'name') ?? null,
      status: extractStringField(result.body, 'status') ?? null,
    };
  } catch (err) {
    log.warn(
      {
        tenantId: request.tenantId,
        campaignId,
        err: err instanceof Error ? err.message : String(err),
      },
      'agency campaign lookup failed; answering with null name and status',
    );
    return { name: null, status: null };
  }
}

const assignAgentSchema = z.object({
  user_id: z.string().uuid(),
});

/**
 * Path params, validated as strictly as the bodies are.
 *
 * ── Why a raw `:id` is not merely untidy ───────────────────────────────────
 * `campaign_id` and `user_id` are `UUID` columns. Handing Postgres
 * `'not-a-uuid'` raises `22P02 invalid_text_representation` from inside the
 * query, which propagates as a 500 — and `errorMaskHook` masks every 5xx, so the
 * caller gets "contact support and quote this request id" for a typo they could
 * have fixed themselves. Worse, it is noise in the 5xx rate for something that
 * is not a server fault at all.
 *
 * This is the established local pattern, not a new one:
 * `tenant-context.middleware.ts` maps `22P02` to a refusal rather than a 500 for
 * exactly this reason, and `user.repository.ts` filters non-UUID ids out in JS
 * before they reach `ANY($1::uuid[])` — including in `findIdentitiesInTenant`,
 * which this file calls.
 *
 * Two schemas rather than one shared shape, because `DELETE` names two different
 * things and a `details` payload saying "id" for a bad `:userId` sends the caller
 * to the wrong half of their URL.
 */
const campaignParamsSchema = z.object({
  id: z.string().uuid(),
});

const campaignAgentParamsSchema = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid(),
});

/**
 * Prove the caller may act on this campaign AT ALL, through the internal
 * handler's `GET /agency-campaigns/:id`, whose `requireOwned` compares
 * `tenant_id` AND `account_id` and answers 404 `campaign_not_found`.
 *
 * ── The hole this closes ───────────────────────────────────────────────────
 * Campaign ownership is `(tenant_id, account_id)` on the campaign row.
 * `agency_campaign_agents.tenant_id` scopes a query to the tenant and says
 * nothing about the ACCOUNT, so a tenant-scoped predicate alone lets an
 * `account_admin` of Account A name a campaign belonging to Account B in the
 * same tenant. On `GET` that leaks another account's staffing list *with names
 * and emails*; on `DELETE` it unstaffs their agents — a read/delete weaker than
 * the write it guards, which is backwards. All three routes go through this one
 * function.
 *
 * ── Why `requireOwned`, and not `agency_campaign_agents.account_id` ────────
 * That column is attribution, not authority: it records the account context the
 * assignment was MADE in, which is not the campaign's owning account, and a
 * tenant-level member (`account_id IS NULL`) writes NULL into it. Filtering on it
 * would be a second, weaker ownership mechanism sitting beside `requireOwned` —
 * and two mechanisms for one rule is how they disagree. One handler read keeps
 * exactly one definition of "may this caller act on this campaign".
 *
 * Returns true to proceed. On refusal it has already replied, so the caller must
 * `return` immediately.
 */
async function assertCampaignInScope(
  request: FastifyRequest,
  reply: FastifyReply,
  campaignId: string,
): Promise<boolean> {
  // The internal handler's `GET /agency-campaigns/:id`, in-process. What it can answer, and
  // where each lands below: 200 (owned) → proceed; 404 `campaign_not_found` (unknown, or
  // `requireOwned`'s tenant/account mismatch) → this route's 404; 403 `feature_disabled`
  // (`agency_dialer_enabled` off) and 400 (no `x-mgkvc-account`: a tenant-level caller
  // with no `X-Account-Id`) → passed through as-is; a handler fault → its 500, passed through.
  const campaign = await callCore({
    method: 'GET',
    path: `/agency-campaigns/${campaignId}`,
    tenantId: request.tenantId!,
    accountId: request.accountId,
    metricPath: '/agency-campaigns/:id',
  });

  if (campaign.status === 404) {
    // `code` is carried explicitly and it is not decoration: a bare
    // `{ error, message }` gives the console nothing to branch on for a campaign
    // that simply does not exist. Same reason the roster-clear route carries it.
    //
    // A campaign in another account and one that does not exist answer
    // identically, which is the non-oracle property RBAC refusals must keep —
    // and it is `requireOwned`'s 404, so this route does not even learn which it
    // was.
    reply.code(404).send({
      error: 'Not Found',
      code: 'campaign_not_found',
      message: 'Campaign not found.',
    });
    return false;
  }
  if (campaign.status >= 400) {
    // Anything else — the handler refusing or faulting — is passed through as-is
    // rather than collapsed into a 404. This route could not PROVE the campaign
    // is missing, and answering "not found" for "we could not ask" is the
    // confident-wrong answer this codebase keeps having to un-learn.
    reply.code(campaign.status).send(campaign.body);
    return false;
  }
  return true;
}

export async function proxyAgencyStaffingRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', sessionMiddleware);
  app.addHook('preHandler', tenantContextMiddleware);
  // No capability gate: the app is the agency product, so the section-level `agency` gate
  // is always on. The RBAC floors below are the gate.

/**
   * GET /proxy/agency/my-assignments — "which campaigns am I staffed on?"
   *
   * The entry point for the whole agent experience. An `agent` inherits no
   * navigation of their own, so this is how their landing page learns what to
   * offer: one assignment and it sends them straight in, several and it asks.
   *
   * ── Plural, because staffing is per-campaign ──────────────────────────────
   * The singular route below is what this replaces, and the reason is not
   * ergonomics. An agent may hold one active assignment per CAMPAIGN
   * (`uq_agency_campaign_agent_active_campaign`), so several at once, and a
   * singular wire shape could only ever report one of them. This is the shape
   * that can say so.
   *
   * Being LIVE on one campaign at a time is the dialer runtime's session index
   * (`uq_agency_agent_live_tenant`), not this table: a second concurrent join
   * answers a typed 409 the console renders. This route reports what an agent
   * MAY work, not what they are on.
   *
   * ── `200 { assignments: [] }`, where the singular route answers 204 ────────
   * A deliberate divergence rather than an oversight. "Nobody has staffed me" is
   * an absence of ASSIGNMENTS, and for a collection the empty array *is* the
   * representation of that absence — a client rendering "you're not assigned yet"
   * from `assignments.length === 0` needs no second code path, whereas the
   * singular route's 204 forced one and is exactly the branch a client can forget.
   *
   * ── Campaign summaries are best-effort, the assignments are not ────────────
   * The assignments come from `agency_campaign_agents` and are the answer. Each
   * NAME and STATUS is a courtesy read through the internal handler, so a
   * refusal, a campaign since deleted, or an unexpected shape degrades those two
   * to `null` and leaves the ids — and therefore every link on the landing page —
   * working. Same
   * rule `src/agency/agency-stats-enrichment.ts` states: enrichment must never
   * turn a 200 into a 500.
   *
   * The lookups run concurrently and each is independently guarded, so one
   * campaign's failure cannot null out its siblings. `mapWithConcurrency` carries
   * `Promise.all` failure semantics — it rejects on the first rejection — which is
   * safe here ONLY because {@link resolveCampaignSummary} never rejects. If that
   * totality is ever broken, this route starts 500ing on a single unreachable
   * campaign and needs a settled variant instead.
   *
   * ── The fan-out is CAPPED, not merely expected to be small ────────────────
   * "Bounded by how many campaigns a supervisor has staffed one person onto — a
   * handful in practice" is a convention, not a constraint: nothing limits how
   * many active assignments an agent holds, so the fan-out is however many rows
   * exist, on a route an agent's home calls on every sign-in and every return
   * from a station.
   *
   * So it is limited explicitly. Each summary runs the internal handler's
   * campaign read, and the agent is waiting on all of them before their own page can
   * render — an unbounded burst is felt by the person least able to do anything
   * about it. Still not paginated: an agent must see every assignment to choose
   * from them, and a page cursor on a list of that size would be complexity with no
   * case behind it.
   */
  app.get('/my-assignments', {
    preHandler: requirePermission('agency.station.connect'),
  }, async (request, reply) => {
    const userId = resolveMyAgentId(request, reply);
    if (userId === null) return reply;

    const assignments = await agencyCampaignAgentRepository.listActiveForUser(
      request.tenantId!,
      userId,
    );

    const summaries = await mapWithConcurrency(assignments, SUMMARY_CONCURRENCY, (assignment) =>
      resolveCampaignSummary(request, assignment.campaign_id),
    );

    return reply.code(200).send({
      assignments: assignments.map((assignment, index) => ({
        campaign_id: assignment.campaign_id,
        // Both always present, even when unresolved — a sometimes-absent key is a
        // different defect and a client cannot tell it from one it forgot to read.
        campaign_name: summaries[index]!.name,
        // What the landing page needs to say "this one isn't taking calls right
        // now" BEFORE the agent clicks into a station that would refuse them.
        campaign_status: summaries[index]!.status,
        assigned_at: assignment.assigned_at,
      })),
    });
  });

  /**
   * GET /proxy/agency/my-campaigns — "where have I ever been staffed?"
   *
   * The agent's own staffing HISTORY: every row `agency_campaign_agents` holds for
   * them in this tenant, **closed rows included**.
   *
   * ── This route is the reason the rows are closed rather than deleted ────────
   * Unassigning sets `unassigned_at` rather than deleting the row, because *"who
   * was staffed on this campaign in March" is a question supervisors and disputes
   * actually ask, and a delete cannot answer it.* This route is what asks it:
   * every other reader on the table filters `unassigned_at IS NULL`
   * (`listActiveForUser` is the only one an agent can reach). A promise a schema
   * makes and no code keeps is worse than not making it: the next person to need
   * the answer concludes it was never recorded.
   *
   * The repository read is a separate method (`listAllForUser`) rather than a flag on
   * `listActiveForUser`, because every existing caller of that one wants
   * active-only and would be wrong with more — the landing-page picker must not
   * offer a campaign the agent was taken off. See its docstring.
   *
   * ── Distinct from `/my-assignments`, and deliberately not folded into it ────
   * `/my-assignments` answers "what may I work RIGHT NOW" and feeds the picker; it
   * must stay active-only or the picker offers dead campaigns. This answers "what
   * have I worked", feeds a history panel, and is newest-first. One route with an
   * `?include_closed=` flag would make the picker's correctness depend on a query
   * param a client can forget, on the one route an agent hits on every sign-in.
   *
   * ── `active` is a field, not something the client derives ──────────────────
   * `unassigned_at === null` is the same test, and it is exactly the sort of
   * derivation two clients implement differently (`!row.unassigned_at` treats an
   * empty string as active). The server already knows the answer; sending it costs a
   * boolean and removes a decision from every consumer. Both keys are present on
   * every row regardless.
   *
   * ── Same floor as `/my-assignments`: `agency.station.connect` ──────────────
   * And for the same load-bearing reason spelled out in this file's header — an
   * `agent` is hierarchy level 5 and inherits nothing that predates the agency
   * feature, so a `viewer`-floored gate such as `proxy.contact_lists.read` would
   * 403 the exact role the route exists for. Pinned in this plugin's own
   * `test/unit/agency/proxy-agency-staffing.routes.test.ts` route table, and
   * against `PERMISSION_MATRIX` alongside the performance plugin's `my-*` routes in
   * `test/unit/agency/proxy-agency-my-surfaces.routes.test.ts` — every `my-*` floor
   * on this prefix asserted in one place, since they must all agree.
   *
   * ── Labels are best-effort; the assignments are not ────────────────────────
   * Identical rule to `/my-assignments`: the rows come from `agency_campaign_agents`
   * and are the answer, while `campaign_name`/`campaign_status` are courtesy reads
   * that degrade to `null` on a refusal or a deleted campaign. A history is in fact
   * the surface MOST likely to name campaigns since deleted, so this degradation
   * is the normal path here rather than an edge
   * case — which is precisely why the ids are what the response is built from.
   *
   * The lookups are deduplicated by campaign id before the fan-out. A history
   * repeats campaigns by construction (staffed in March, unstaffed in April,
   * staffed again in June is three rows and one campaign), so resolving per ROW
   * would spend three identical handler reads to print the same name three
   * times.
   *
   * ── BOUNDED in three places ────────────────────────────────────────────────
   * Unlike `/my-assignments`, whose rows are the ACTIVE ones and therefore self-
   * limiting, this reads closed rows too — so its size only ever grows. Every
   * reassignment adds a row, every offboarding adds one per campaign (in a single
   * statement, via `closeAllForUser`), and nothing ever removes one: that is the
   * closed-not-deleted choice above. It is reached by an `agent`, the
   * lowest-privileged role on the platform, on their own console.
   *
   *  1. **Rows** — `listAllForUser` takes a hard `LIMIT` (`HISTORY_LIMIT_MAX`)
   *     that no query parameter can raise, plus the optional `from`/`to` window
   *     below, which is the shape its own docstring nominated for exactly this.
   *  2. **Fan-out** — at most `SUMMARY_LOOKUP_MAX` DISTINCT campaigns are named.
   *     The row cap alone does not bound this: 200 rows can be 200 campaigns, and
   *     at `SUMMARY_CONCURRENCY` that is 50 sequential waves with the agent
   *     waiting on all of them. Rows are newest-first, so the campaigns that get
   *     a name are the recent ones and the rest report `null` — this route's own
   *     documented normal path, not a new contract.
   *  3. **Each lookup** — `SUMMARY_TIMEOUT_MS`, inert in-process (see the
   *     constant).
   *
   * The response SHAPE is fixed: `{ assignments: [...] }`, every key on every
   * row — the console reads that key, and a change to it would render every
   * agent's history empty. Truncation is
   * reported in a HEADER (`X-Staffing-Truncated`), following
   * `X-Activity-Truncated` on the campaign activity export, so a body a client
   * already parses cannot change under it.
   */
  app.get('/my-campaigns', {
    preHandler: requirePermission('agency.station.connect'),
  }, async (request, reply) => {
    const userId = resolveMyAgentId(request, reply);
    if (userId === null) return reply;

    const query = myCampaignsQuerySchema.safeParse(request.query ?? {});
    if (!query.success) {
      return reply.code(400).send({ error: 'Validation Error', details: query.error.flatten() });
    }

    const assignments = await agencyCampaignAgentRepository.listAllForUser(
      request.tenantId!,
      userId,
      {
        ...(query.data.from ? { from: new Date(query.data.from) } : {}),
        ...(query.data.to ? { to: new Date(query.data.to) } : {}),
      },
    );

    // Newest-first, so `slice` keeps the recent campaigns — the ones a history
    // panel is actually showing. Beyond it the id is still the answer and the
    // caption is `null`, which is what this route degrades to anyway.
    const campaignIds = [...new Set(assignments.map((a) => a.campaign_id))]
      .slice(0, SUMMARY_LOOKUP_MAX);
    const resolved = await mapWithConcurrency(campaignIds, SUMMARY_CONCURRENCY, (campaignId) =>
      resolveCampaignSummary(request, campaignId),
    );
    const summaries = new Map(campaignIds.map((id, index) => [id, resolved[index]!]));

    if (assignments.length >= HISTORY_LIMIT_MAX) {
      // A full page is not proof there is more, but it is the only signal the
      // ceiling can give without a second COUNT — and reporting "possibly
      // truncated" is the safe direction. `Narrow the window with ?from=/?to=`
      // is the remedy, and it is the one the header exists to prompt.
      reply.header('X-Staffing-Truncated', 'true');
    }

    return reply.code(200).send({
      assignments: assignments.map((assignment) => ({
        campaign_id: assignment.campaign_id,
        campaign_name: summaries.get(assignment.campaign_id)?.name ?? null,
        campaign_status: summaries.get(assignment.campaign_id)?.status ?? null,
        assigned_at: assignment.assigned_at,
        // `null` while the assignment stands. Kept as the raw timestamp rather
        // than folded into `active` alone: "when did I come off this campaign" is
        // the actual question a dispute asks, and it is not recoverable from a
        // boolean.
        unassigned_at: assignment.unassigned_at,
        active: assignment.unassigned_at === null,
      })),
    });
  });

  /**
   * GET /proxy/agency/my-assignment — the singular predecessor. **Deprecated.**
   *
   * Kept for any console that still calls it: a browser tab loaded before the
   * plural route existed knows only this one, for as long as it stays open.
   * Removing it in the same release as its replacement would 404 those agents
   * mid-shift.
   *
   * It answers with the OLDEST active assignment (see
   * `findActiveForUser`) — the one that has been stable longest, so a stale
   * console keeps being sent where it was being sent yesterday rather than
   * following staffing edits it has no UI to explain. It cannot report the others,
   * which is the whole reason it is deprecated and not merely aliased.
   *
   * Its 204-for-none contract is preserved exactly; see the plural route above for
   * why the replacement deliberately does not copy it.
   *
   * Remove once no deployed client calls it.
   */
  app.get('/my-assignment', {
    preHandler: requirePermission('agency.station.connect'),
  }, async (request, reply) => {
    const userId = resolveMyAgentId(request, reply);
    if (userId === null) return reply;

    const assignment = await agencyCampaignAgentRepository.findActiveForUser(
      request.tenantId!,
      userId,
    );
    if (!assignment) return reply.code(204).send();

    const summary = await resolveCampaignSummary(
      request,
      assignment.campaign_id,
    );

    return reply.code(200).send({
      campaign_id: assignment.campaign_id,
      campaign_name: summary.name,
    });
  });

  /**
   * GET /proxy/agency/campaigns/:id/agents — the campaign's roster of PEOPLE.
   *
   * Note the word: `roster` already means CONTACTS everywhere else in this
   * codebase (`src/agency/agency-roster.client.ts`, the ingest pipeline), so it
   * is not used for this surface anywhere it could be read as the other thing.
   * This is *staffing*, and it is also not `AgentFloor` — that is live session
   * state polled from the dialer's stats, and the two must stay visibly distinct.
   *
   * ── The campaign is proved before anything is read ────────────────────────
   * This route returns NAMES AND EMAILS, so it is the most sensitive of the
   * three: a tenant-only predicate would let an `account_admin` read another
   * account's staffing. `assertCampaignInScope` runs first — see its docstring
   * for why ownership cannot be decided from `agency_campaign_agents`' own
   * columns. An unknown campaign and one in another account are
   * indistinguishable (both 404), which keeps the non-oracle property while
   * enforcing the boundary.
   */
  app.get<{ Params: { id: string } }>('/campaigns/:id/agents', {
    preHandler: requirePermission('agency.supervise'),
  }, async (request, reply) => {
    const params = campaignParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: 'Validation Error', details: params.error.flatten() });
    }
    if (!(await assertCampaignInScope(request, reply, params.data.id))) return reply;

    const assignments = await agencyCampaignAgentRepository.listActiveForCampaign(
      params.data.id,
      request.tenantId!,
    );
    const agents = await enrichAssignedAgents(assignments, request.tenantId!);
    return reply.code(200).send({ agents });
  });

  /**
   * POST /proxy/agency/campaigns/:id/agents — staff someone onto this campaign.
   *
   * ── Assigning someone already staffed elsewhere ADDS; it does not MOVE ─────
   * One active assignment per person per CAMPAIGN, enforced by the partial unique
   * index `uq_agency_campaign_agent_active_campaign` and by
   * `agencyCampaignAgentRepository.assign`, never by a check-then-write here: a
   * read and a write that can disagree is not a rule.
   *
   * Staffing someone onto an afternoon campaign must not silently close their
   * morning row — an ordinary handover would destroy a supervisor's earlier
   * decision with nothing said. Staffing is not occupancy: an agent may be SENT
   * to several campaigns and can only WORK one, and the second half is the dialer
   * runtime's business, not this table's.
   *
   * ── One LIVE campaign at a time is the dialer runtime's to enforce ─────────
   * The live-session index is `(tenant_id, agent_user_id)`
   * (`uq_agency_agent_live_tenant`), so a second concurrent join is refused with
   * a typed 409 naming the campaign they are on, and the console tells them to
   * leave that station first. Nothing here touches a live session: yanking
   * somebody off a call to satisfy a staffing edit is worse than the 409.
   *
   * Read the other way, this is why per-campaign staffing is safe: a row in this
   * table grants nothing, so it cannot put anybody on a second call.
   *
   * ── Two 404s, and neither is a 403 ─────────────────────────────────────────
   * A `user_id` with no membership in this tenant, and a campaign the caller does
   * not own, both answer 404. A 403 on the first would confirm the user id exists
   * somewhere, which is exactly the existence oracle RBAC refusals must not be.
   */
  app.post<{ Params: { id: string } }>('/campaigns/:id/agents', {
    preHandler: requirePermission('agency.supervise'),
  }, async (request, reply) => {
    const params = campaignParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: 'Validation Error', details: params.error.flatten() });
    }
    const parsed = assignAgentSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Validation Error', details: parsed.error.flatten() });
    }

    // Membership first: it is a local read, and `requirePermission` proves the
    // CALLER's role and never looks at the target row — so the tenant predicate
    // on the target has to be made explicitly, here.
    const memberships = await membershipRepository.findByUserAndTenant(
      parsed.data.user_id,
      request.tenantId!,
    );
    if (memberships.length === 0) {
      return reply.code(404).send({
        error: 'Not Found',
        message: 'That user is not a member of this workspace.',
      });
    }

    // Then the campaign — the same gate the other two routes use, so ownership
    // has one definition. An assignment pointing at a campaign this caller may
    // not act on is a row nobody should be able to create.
    if (!(await assertCampaignInScope(request, reply, params.data.id))) return reply;

    let assignment;
    try {
      assignment = await agencyCampaignAgentRepository.assign({
        tenant_id: request.tenantId!,
        account_id: request.accountId ?? null,
        campaign_id: params.data.id,
        user_id: parsed.data.user_id,
        assigned_by: request.user?.id ?? null,
      });
    } catch (err) {
      /**
       * The database still enforces one active assignment per person per
       * TENANT rather than per campaign (`StaffingUpgradePendingError`; not
       * expected on a database built from the baseline). A 409 rather than a 500: the request is
       * well-formed and the conflict is a real, temporary state of the deployment,
       * so the supervisor gets a sentence they can act on instead of "contact
       * support and quote this request id".
       *
       * `409` also matches how the rest of this feature reports a state conflict —
       * the join answers 409 `session_on_other_campaign` for the sibling case — so the
       * console's existing conflict handling shape applies.
       */
      if (err instanceof StaffingUpgradePendingError) {
        log.error(
          {
            tenantId: request.tenantId,
            userId: parsed.data.user_id,
            currentCampaignId: err.currentCampaignId,
            requestedCampaignId: err.requestedCampaignId,
          },
          'Staffing refused: migration 064 has not been applied on this database',
        );
        return reply.code(409).send({
          error: 'Conflict',
          code: err.code,
          message:
            'That agent is already assigned to another campaign, and this workspace has not ' +
            'finished upgrading to multiple assignments yet. Unassign them from the other ' +
            'campaign, or try again after the next deployment.',
        });
      }
      throw err;
    }

    log.info(
      {
        tenantId: request.tenantId,
        campaignId: params.data.id,
        userId: parsed.data.user_id,
        actingUserId: request.user?.id,
      },
      'Agent assigned to agency campaign',
    );

    // Audited through the SAME path the campaign lifecycle actions use
    // (`platformAuditLogger.log`, buffered) — staffing decides who talks to customers, so
    // "who put them there" is the same class of fact as "who started the
    // campaign". No PII in `details`: ids only, never the name or email the read
    // path resolves.
    platformAuditLogger.log({
      tenant_id: request.tenantId!,
      ...(request.accountId ? { account_id: request.accountId } : {}),
      ...requestAuditActor(request),
      action: 'agency_campaign_agent.assigned',
      resource_type: 'agency_campaign_agent',
      resource_id: assignment.id,
      campaign_id: params.data.id,
      details: { campaign_id: params.data.id, user_id: parsed.data.user_id },
    });

    return reply.code(201).send({
      // The assignment row's own id, additive to the contract's three fields.
      // It is what the audit row above references (`resource_id`), so without it
      // on the wire there is no way to get from a supervisor's report of a bad
      // assignment to the audit entry that recorded it — the client would be
      // holding the only two facts (`campaign_id`, `user_id`) that the audit row
      // relegates to `details`.
      //
      // A fresh assignment and a no-op re-assign return different ids for the same
      // request shape (the first mints a row, the second returns the existing one),
      // which is the honest reading: they are different rows because they are
      // different events.
      id: assignment.id,
      user_id: assignment.user_id,
      campaign_id: assignment.campaign_id,
      assigned_at: assignment.assigned_at,
    });
  });

  /**
   * DELETE /proxy/agency/campaigns/:id/agents/:userId — unstaff someone.
   *
   * ── 204 whether or not a row was closed — DO NOT "fix" this into a 404 ─────
   * Idempotent on purpose, and this is the paragraph that exists to stop the
   * obvious-looking correction. The contract specifies `204` and lists 404 only
   * for an unknown campaign or a non-member user; the tempting extra 404 is "no
   * active assignment to remove", and it is wrong on both of the grounds that
   * decide it:
   *
   *  - **It is not an error.** The requested state is "this person is not staffed
   *    on this campaign", and after a no-op that state HOLDS. Reporting failure
   *    for a request whose goal is satisfied is a lie the supervisor has to go
   *    and investigate.
   *  - **It is reachable without anyone doing anything wrong.** A double-click, a
   *    retry after a lost response, or two supervisors tidying the same list all
   *    produce a second DELETE. A 404 there turns ordinary concurrency into an
   *    incident.
   *
   * It also does not leak: 204 for "nothing to remove" and 204 for "removed" are
   * indistinguishable, which is the same non-oracle property the 404s on the
   * sibling POST route are chosen for.
   *
   * The AUDIT row is the thing that stays conditional — written only when a row
   * actually closed — so the trail records acts rather than requests. That is
   * where the distinction belongs: in the record, not in the status code.
   *
   * ── It DOES prove the campaign first ──────────────────────────────────────
   * Skipping `assertCampaignInScope` so the way OUT of a staffing decision never
   * depends on the ownership read would be an availability argument, and it
   * loses to a security one: without the gate, the UPDATE's
   * `(tenant_id, campaign_id, user_id)` predicate scopes to the TENANT and not
   * the ACCOUNT, so an `account_admin` of one account could unstaff another
   * account's agents. A delete surface weaker than the write surface guarding the
   * same rows is backwards, and the availability cost is bounded and honest: if
   * the ownership read refuses or faults, the unassign answers with that status
   * rather than being silently applied to a campaign the caller may not touch.
   */
  app.delete<{ Params: { id: string; userId: string } }>('/campaigns/:id/agents/:userId', {
    preHandler: requirePermission('agency.supervise'),
  }, async (request, reply) => {
    const params = campaignAgentParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: 'Validation Error', details: params.error.flatten() });
    }
    if (!(await assertCampaignInScope(request, reply, params.data.id))) return reply;

    const removedId = await agencyCampaignAgentRepository.unassign(
      request.tenantId!,
      params.data.id,
      params.data.userId,
    );

    if (removedId) {
      log.info(
        {
          tenantId: request.tenantId,
          campaignId: params.data.id,
          userId: params.data.userId,
          actingUserId: request.user?.id,
        },
        'Agent unassigned from agency campaign',
      );
      platformAuditLogger.log({
        tenant_id: request.tenantId!,
        ...(request.accountId ? { account_id: request.accountId } : {}),
        ...requestAuditActor(request),
        action: 'agency_campaign_agent.unassigned',
        resource_type: 'agency_campaign_agent',
        resource_id: removedId,
        campaign_id: params.data.id,
        details: { campaign_id: params.data.id, user_id: params.data.userId },
      });
    }

    return reply.code(204).send();
  });
}
