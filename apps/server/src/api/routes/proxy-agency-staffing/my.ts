/*
 * The agent's own staffing reads: `my-assignments`, `my-campaigns` and `my-assignment`,
 * with the one batched campaign-label read they share, and the unattributable-caller answer
 * every `my-*` route on this prefix gives (`resolveMyAgentId`, `replyMissingActor`, also
 * used by the performance plugin). Part of `proxy-agency-staffing.routes.ts`.
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { requirePermission } from '../../../rbac/rbac.middleware.js';
import { callCore } from '../../core-dispatch.js';
import { CAMPAIGN_SUMMARIES_MAX_IDS, stringField } from '../helpers/core-campaign.js';
import { createChildLogger } from '@magick-agency/observability';
import { agencyCampaignAgentRepository, HISTORY_LIMIT_MAX } from '@magick-agency/db/repositories/agency-campaign-agent.repository';
import { parseOr400 } from '../helpers/parse-or-400.js';

const log = createChildLogger({ component: 'proxy-agency-staffing' });

/**
 * How many DISTINCT campaigns one `/my-campaigns` page will name.
 *
 * The names come from ONE internal read for the whole page
 * ({@link resolveCampaignSummaries}), and this bounds the id list it carries: 200
 * rows can be 200 campaigns. Rows arrive newest-first, so the first
 * {@link SUMMARY_LOOKUP_MAX} distinct ids are the recent ones — the half of a
 * history anybody is actually looking at — and the rest report
 * `campaign_name: null`.
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
    message: 'An API key has no assignment. Sign in as the agent.',
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

/** The answer for a campaign the lookup could not name. */
const UNRESOLVED_SUMMARY: CampaignSummary = { name: null, status: null };

/**
 * Resolve the names and statuses of a page's campaigns in ONE internal read
 * (`GET /agency-campaigns/summaries`) per `CAMPAIGN_SUMMARIES_MAX_IDS` campaigns, the
 * handler's per-read ceiling. **Never rejects.**
 *
 * Every caller is enriching an answer it already has (assignments from
 * `agency_campaign_agents`), so a failure here must degrade the courtesy fields and
 * leave the answer standing — the rule `src/agency/agency-stats-enrichment.ts`
 * states: enrichment must never turn a 200 into a 500. A refusal, a campaign since
 * deleted, and an unexpected shape all land on `{ name: null, status: null }`,
 * which is indistinguishable to the client and correctly so: in all three cases
 * the id is the fact and the labels are unavailable. Concretely, any status ≥ 400
 * (403 `feature_disabled`, 400 for a missing account header) and a throw land
 * every id of that read on nulls; a campaign in another account, another tenant or since
 * deleted is simply absent from the handler's answer and lands on nulls alone —
 * the handler applies `requireOwned`'s tenant-AND-account rule to the whole set.
 *
 * Callers read the map with {@link summaryOf}, so an id the answer does not name
 * is the null pair rather than `undefined`.
 *
 * `status` is passed through rather than validated against an enum. The dialer
 * runtime owns the campaign lifecycle, and a second copy of its states here is a
 * copy that goes stale: a status added there would be mapped to `null` by a
 * mirror, telling the agent "unknown" about a campaign the server knows perfectly
 * well. The client renders an unrecognised status as itself
 * (`AgencyCampaignStatusBadge` does exactly this).
 */
async function resolveCampaignSummaries(
  request: FastifyRequest,
  campaignIds: readonly string[],
): Promise<Map<string, CampaignSummary>> {
  const summaries = new Map<string, CampaignSummary>();
  // No ids, no read: an agent nobody has staffed costs nothing. More ids than one
  // read may name are split into reads of at most `CAMPAIGN_SUMMARIES_MAX_IDS`, one
  // after another, each degrading on its own.
  for (let start = 0; start < campaignIds.length; start += CAMPAIGN_SUMMARIES_MAX_IDS) {
    await readCampaignSummaries(
      request,
      campaignIds.slice(start, start + CAMPAIGN_SUMMARIES_MAX_IDS),
      summaries,
    );
  }
  return summaries;
}

/**
 * One internal summaries read for at most `CAMPAIGN_SUMMARIES_MAX_IDS` ids, adding what
 * it names to `summaries`. **Never rejects**: a refusal or a throw leaves its ids unnamed.
 */
async function readCampaignSummaries(
  request: FastifyRequest,
  campaignIds: readonly string[],
  summaries: Map<string, CampaignSummary>,
): Promise<void> {
  try {
    const result = await callCore({
      method: 'GET',
      path: '/agency-campaigns/summaries',
      query: { ids: campaignIds.join(',') },
      tenantId: request.tenantId!,
      accountId: request.accountId,
    });
    if (result.status >= 400) return;
    const rows = (result.body as { campaigns?: unknown } | null)?.campaigns;
    if (!Array.isArray(rows)) return;
    for (const row of rows) {
      const id = stringField(row, 'id');
      if (!id) continue;
      summaries.set(id, {
        name: stringField(row, 'name'),
        status: stringField(row, 'status'),
      });
    }
  } catch (err) {
    log.warn(
      {
        tenantId: request.tenantId,
        campaigns: campaignIds.length,
        err: err instanceof Error ? err.message : String(err),
      },
      'agency campaign lookup failed; answering with null name and status',
    );
  }
}

/** One campaign's labels from {@link resolveCampaignSummaries}'s map; nulls when absent. */
function summaryOf(summaries: Map<string, CampaignSummary>, campaignId: string): CampaignSummary {
  return summaries.get(campaignId) ?? UNRESOLVED_SUMMARY;
}

/**
 * Registered by `proxyAgencyStaffingRoutes` on its own instance, after its session and
 * tenant-context hooks.
 */
export async function registerMyStaffingRoutes(app: FastifyInstance): Promise<void> {
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
   * Every campaign is named by ONE internal read ({@link resolveCampaignSummaries})
   * per hundred campaigns (the summaries handler's ceiling) — nothing limits how many
   * active assignments an agent may have, and this route is called on every sign-in
   * and every return from a station, so the cost must not grow with the rows. A
   * campaign a read cannot name nulls its own labels and nobody else's, and a
   * failed read nulls those it carried while the assignments stand. Still not paginated:
   * an agent must see every assignment to choose from them, and a page cursor on a
   * list of that size would be complexity with no case behind it.
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

    const summaries = await resolveCampaignSummaries(
      request,
      [...new Set(assignments.map((assignment) => assignment.campaign_id))],
    );

    return reply.code(200).send({
      assignments: assignments.map((assignment) => ({
        campaign_id: assignment.campaign_id,
        // Both always present, even when unresolved — a sometimes-absent key is a
        // different defect and a client cannot tell it from one it forgot to read.
        campaign_name: summaryOf(summaries, assignment.campaign_id).name,
        // What the landing page needs to say "this one isn't taking calls right
        // now" BEFORE the agent clicks into a station that would refuse them.
        campaign_status: summaryOf(summaries, assignment.campaign_id).status,
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
   * And for the same load-bearing reason spelled out in the plugin's header
   * (`proxy-agency-staffing.routes.ts`) — an `agent` is hierarchy level 5 and
   * inherits nothing that predates the agency feature, so a `viewer`-floored gate such as `proxy.contact_lists.read` would
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
   * The ids are deduplicated before the one read that names them. A history
   * repeats campaigns by construction (staffed in March, unstaffed in April,
   * staffed again in June is three rows and one campaign), so naming per ROW
   * would carry the same id three times to print the same name three times.
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
   *  2. **Names** — at most `SUMMARY_LOOKUP_MAX` DISTINCT campaigns are named, in
   *     one internal read. The row cap alone does not bound that read's id list:
   *     200 rows can be 200 campaigns. Rows are newest-first, so the campaigns
   *     that get a name are the recent ones and the rest report `null` — this
   *     route's own documented normal path, not a new contract.
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

    const query = parseOr400(myCampaignsQuerySchema, request.query ?? {}, reply, 'agency');
    if (!query) return reply;

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
    const summaries = await resolveCampaignSummaries(request, campaignIds);

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
        campaign_name: summaryOf(summaries, assignment.campaign_id).name,
        campaign_status: summaryOf(summaries, assignment.campaign_id).status,
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

    const summary = summaryOf(
      await resolveCampaignSummaries(request, [assignment.campaign_id]),
      assignment.campaign_id,
    );

    return reply.code(200).send({
      campaign_id: assignment.campaign_id,
      campaign_name: summary.name,
    });
  });
}
