import { ENDPOINTS } from '../config';
import { apiFetch } from './client';
import type { AgencyAttempt, AgencyAttemptFilters, AgencyKeysetPage } from '../types/agency-spine';
import type {
  AgencyAgentStats,
  AgencyGroupDimension,
  AgencyGroupPage,
  AgencyGroupSort,
  AgencyRosterOrder,
  AgencyRosterPage,
  AgencyRosterSort,
  AgencyStaffingHistory,
  AgencyStaffingHistoryEntry,
  AgencyStatsBucketWidth,
} from '../types/agency-stats';

/**
 * Per-agent numbers, through master's `/proxy/agency`.
 *
 * ── Two floors, and why the routes are paired rather than parameterised ─────
 * Every read here exists twice on master: a `my-` form floored at
 * `agency.station.connect` so a bare `agent` (hierarchy level 5) can call it,
 * and an `agents/:userId` twin floored at `agency.supervise`. The `my-` form
 * takes **no subject** — master scopes it to the caller server-side.
 *
 * That is not duplication to tidy up into one route with an optional
 * `agent_user_id`. An optional subject on the agent-floored route is a route
 * where the difference between "my numbers" and "somebody else's" is a parameter
 * the client controls, which is the same mistake `createSessionSchema` refuses
 * for `agent_user_id`: the server must own the answer to "whose data is this".
 * Keeping them apart means an agent literally cannot form the request.
 *
 * **cusui never reaches core.** These are master routes; a core route with no
 * master proxy is unreachable from a browser.
 *
 * **Every function takes `accountId` and must be given it.** `apiFetch` sends
 * `X-Account-Id` only when the fourth argument is present, and core requires it
 * on every authenticated route — so an omitted one does not degrade, it produces
 * `400 Missing required header: x-mgkvc-account` from core with nothing in the
 * message pointing back here. See the longer note in `agencyCampaigns.ts`.
 */

/*
  The five routes this module reads come from `ENDPOINTS.proxy.agency` rather than
  from a local `${API_BASE}/proxy/agency` constant. `ENDPOINTS` is the repo's
  single source of truth for URL construction — see `config.ts` — and a prefix
  rebuilt here is a second place for a path to be right.
*/

/** The range and bucketing for a stats read. */
export interface AgencyStatsQuery {
  /** ISO-8601 instant. Inclusive. */
  from: string;
  /** ISO-8601 instant. */
  to: string;
  bucket: AgencyStatsBucketWidth;
  /** Narrow to one campaign. Omitted means every campaign the agent worked. */
  campaign_id?: string;
}

function statsQuery(query: AgencyStatsQuery): string {
  const qs = new URLSearchParams({ from: query.from, to: query.to, bucket: query.bucket });
  // A blank campaign id is what a cleared "all campaigns" selector holds, and
  // sending it would read as a filter matching nothing rather than as no filter.
  if (query.campaign_id) qs.set('campaign_id', query.campaign_id);
  return `?${qs.toString()}`;
}

/**
 * The signed-in agent's own figures.
 *
 * Floored at `agency.station.connect`, so this is one of the very few reads an
 * `agent` can make at all — every permission that predates the Agency Dialer
 * floors at `viewer` (10) and an agent is level 5. That is exactly why the
 * performance page fetches this and nothing else: a page that also read, say,
 * the campaign list would 403 for the only role it was built for.
 */
export async function getMyStats(
  query: AgencyStatsQuery,
  tenantId?: string,
  accountId?: string,
): Promise<AgencyAgentStats> {
  return apiFetch<AgencyAgentStats>(
    `${ENDPOINTS.proxy.agency.myStats}${statsQuery(query)}`,
    {},
    tenantId,
    accountId,
  );
}

/**
 * The supervisor twin of {@link getMyStats}, for one named agent.
 *
 * **Callers must gate the affordance on `hasPermission(role,
 * 'agency.supervise')`** — the exact permission master floors this on. Any looser
 * check renders a panel whose first read 403s; any tighter one hides it from an
 * `account_admin` who holds it. Same rule `AgentFloor` and
 * `CampaignAgentAssignments` state in their own props.
 */
export async function getAgentStats(
  userId: string,
  query: AgencyStatsQuery,
  tenantId?: string,
  accountId?: string,
): Promise<AgencyAgentStats> {
  return apiFetch<AgencyAgentStats>(
    `${ENDPOINTS.proxy.agency.agentStats(userId)}${statsQuery(query)}`,
    {},
    tenantId,
    accountId,
  );
}

/**
 * The window and shaping for a ROSTER read.
 *
 * ── Every parameter is whitelisted upstream, so a typo is a 400 ────────────
 * Master answers an unknown query param with a 400 rather than dropping it
 * silently (`forwardAllowedQuery` + `unknownQueryParamsError`), which is the
 * behaviour this client wants: a filter that vanishes on the way to the server is
 * a screen showing the wrong rows under the right controls. So the fields here
 * are exactly the accepted set and nothing is spread in from a caller's object.
 *
 * **There is no `agent_user_id`.** The subject of this route is the whole roster;
 * one named person is `getAgentStats`. See `ENDPOINTS.proxy.agency.agentsStats`.
 */
export interface AgencyRosterQuery {
  /** ISO-8601 instant. The window is half-open: `[from, to)`. */
  from: string;
  to: string;
  /** Narrow every row to one campaign. Omitted means every campaign in scope. */
  campaign_id?: string;
  /** Server-side. Defaults to `successes` upstream; sent explicitly so the echo can be trusted. */
  sort?: AgencyRosterSort;
  order?: AgencyRosterOrder;
  /** 1..200 upstream, default 100. A clamp is applied server-side and echoed back. */
  limit?: number;
  /**
   * Include agents who are no longer members of the tenant.
   *
   * **Master-only — core never sees it.** Core cannot know who departed (no user
   * table, design D3), so it returns them all and master drops them, reporting
   * how many in `inactive_omitted`. Sent only when true: `include_inactive=false`
   * is the default and an explicit `false` is one more thing for the whitelist to
   * agree about for no gain.
   */
  include_inactive?: boolean;
}

function rosterQuery(query: AgencyRosterQuery): string {
  const qs = new URLSearchParams({ from: query.from, to: query.to });
  // Same rule as `statsQuery`: a blank campaign id is what a cleared "all
  // campaigns" selector holds, and sending it would read as a filter matching
  // nothing rather than as no filter at all.
  if (query.campaign_id) qs.set('campaign_id', query.campaign_id);
  if (query.sort) qs.set('sort', query.sort);
  if (query.order) qs.set('order', query.order);
  if (query.limit !== undefined) qs.set('limit', String(query.limit));
  if (query.include_inactive) qs.set('include_inactive', 'true');
  return `?${qs.toString()}`;
}

/**
 * The whole floor over one window, ranked — **one request, not one per agent**.
 *
 * ── Why this route exists beside {@link getAgentStats} ─────────────────────
 * The supervisor surface used to answer "how did Ravi do" and had no way to ask
 * "who should I be asking about". Fanning {@link getAgentStats} out over a member
 * list would have been N requests for a screen, and — worse — it could not answer
 * the question anyway: a rate is unreadable without the cohort beside it, and
 * only the server can compute a percentile over agents this client has not
 * fetched.
 *
 * Floored at `agency.supervise`, master's exact floor on both per-agent twins, so
 * callers gate the affordance on `hasPermission(role, 'agency.supervise')` — a
 * looser check renders a table whose first read 403s, a tighter one hides it from
 * an `account_admin`, the role it floors at.
 *
 * `accountId` is not optional in practice: the account is a REQUIRED predicate on
 * this route rather than a filter, because a tenant-wide roster is a different
 * question and must not be reachable by omitting a parameter. `apiFetch` sends
 * `X-Account-Id` only when it is given one — see the note at the top of this file.
 */
export async function getAgencyRoster(
  query: AgencyRosterQuery,
  tenantId?: string,
  accountId?: string,
): Promise<AgencyRosterPage> {
  return apiFetch<AgencyRosterPage>(
    `${ENDPOINTS.proxy.agency.agentsStats}${rosterQuery(query)}`,
    {},
    tenantId,
    accountId,
  );
}

/**
 * The window, the cut and the shaping for a GROUPED read.
 *
 * Same whitelist discipline as {@link AgencyRosterQuery}: master answers an
 * unknown query param with a 400 rather than dropping it, so the fields here are
 * exactly the accepted set and nothing is spread in from a caller's object.
 *
 * **There is no `agent_user_id` here either.** Core has no user table, so it
 * cannot validate tenancy on a caller-supplied id and master's `memberships` is
 * the only place that boundary can exist. Narrowing to one person is
 * {@link getAgentStats}'s job.
 */
export interface AgencyGroupQuery {
  /** ISO-8601 instant. Half-open `[from, to)`, capped at 92 days upstream. */
  from: string;
  to: string;
  /**
   * One or two dimensions — **a tuple, so a third is unrepresentable**.
   *
   * Upstream answers 3+ with a 400 `too_many_dimensions`, because the row count is
   * the product of the dimensions' cardinalities and a third turns a bounded read
   * into an unbounded one for no named screen. Typing the cap here means this
   * client cannot form that request at all, rather than discovering it as a 400.
   *
   * Order does not matter: the server canonicalises it and echoes it back, so
   * `agent,campaign` and `campaign,agent` are one read and cache the same.
   */
  group_by:
    | readonly [AgencyGroupDimension]
    | readonly [AgencyGroupDimension, AgencyGroupDimension];
  /**
   * Narrow every group to one campaign. Omitted means every campaign in scope.
   *
   * **Not optional in practice when a TIME dimension is grouped.** The read
   * refuses (400 `timezone_ambiguous`) unless the zone is unambiguous, which holds
   * when either `campaign` is one of the dimensions or exactly one `campaign_id`
   * is filtered — buckets are cut in the campaign's own zone, so "the 18:00
   * column" across campaigns in different zones is not one thing. There is
   * deliberately no implicit UTC fallback: it would put an Asia/Kolkata campaign's
   * real connect peak six hours from where it happened, and the only visible
   * symptom would be a rostering decision that is quietly wrong.
   */
  campaign_id?: string;
  /** Defaults to `key` upstream. Sent explicitly so the echo can be trusted. */
  sort?: AgencyGroupSort;
  order?: AgencyRosterOrder;
  /** 1..1000 upstream, default 200, applied in SQL. Clamped server-side and echoed back. */
  limit?: number;
  /**
   * Include agents who are no longer members of the tenant.
   *
   * **Master-only, and meaningful only when `agent` is one of the dimensions** —
   * nothing is dropped from a row that belongs to no person. Sent only when true:
   * master accepts `true|false|1|0` and 400s on anything else, and an explicit
   * `false` is one more thing for the whitelist to agree about for no gain.
   */
  include_inactive?: boolean;
}

function groupQuery(query: AgencyGroupQuery): string {
  const qs = new URLSearchParams({
    from: query.from,
    to: query.to,
    // Comma-separated, which is what both services parse. The tuple type above is
    // what keeps this to one or two entries.
    group_by: query.group_by.join(','),
  });
  // Same rule as the two query builders above: a blank campaign id is what a
  // cleared selector holds, and sending it would read as a filter matching nothing
  // rather than as no filter at all.
  if (query.campaign_id) qs.set('campaign_id', query.campaign_id);
  if (query.sort) qs.set('sort', query.sort);
  if (query.order) qs.set('order', query.order);
  if (query.limit !== undefined) qs.set('limit', String(query.limit));
  if (query.include_inactive) qs.set('include_inactive', 'true');
  return `?${qs.toString()}`;
}

/**
 * One grouped aggregate over agency dial attempts — the read behind "who drove
 * this campaign".
 *
 * ── Why it is not {@link getAgencyRoster} with a parameter ─────────────────
 * The roster's rows are keyed on `agent_user_id` and its payload is frozen; a
 * campaign- or hour-grouped row is a different shape, and `group_by` on the roster
 * would make one frozen payload polymorphic. The two reads also differ in what
 * they can carry: this one has **no benchmark and no occupancy**, so it cannot be
 * asked "is this person unusual" — comparison stays on the roster.
 *
 * Floored at `agency.supervise` with the account as a REQUIRED predicate (master
 * answers `400 account_scope_required` before it even resolves the tenant's core
 * key), so callers gate the affordance on `hasPermission(role,
 * 'agency.supervise')` and must pass `accountId` — `apiFetch` sends
 * `X-Account-Id` only when it is given one.
 */
export async function getAgencyGroupedStats(
  query: AgencyGroupQuery,
  tenantId?: string,
  accountId?: string,
): Promise<AgencyGroupPage> {
  return apiFetch<AgencyGroupPage>(
    `${ENDPOINTS.proxy.agency.agentsGroupedStats}${groupQuery(query)}`,
    {},
    tenantId,
    accountId,
  );
}

/**
 * Filters → query string, matching `agencySpine.ts`'s conventions exactly:
 * multi-value filters as REPEATED params, and a blank value dropped rather than
 * sent.
 *
 * ── Repeats are for readability, NOT for surviving a comma ─────────────────
 * An earlier version of this comment claimed repeats meant a disposition code
 * containing a comma reached core intact. It does not, and nothing this client
 * writes can make it: master's `forwardAllowedQuery` receives the repeats as an
 * array and **joins them with a comma**, and core's `multiParam` then **splits
 * on one**. So a code like `Not interested, will call back` arrives at core as two
 * codes, matches no row, and the list comes back empty — a real limitation of the
 * platform's filter encoding rather than something the client is guarding
 * against. It is stated at the one place a reader would otherwise rely on the
 * false version.
 *
 * Repeats are still the right form: they are what both services accept, they are
 * what `agencySpine.ts` sends, and one convention across the two spines is worth
 * having. Making a comma survive is a core-then-master change (a different
 * separator, or a repeat-preserving forward), not a change here.
 */
function attemptQuery(
  filters: AgencyAttemptFilters & { campaign_id?: string },
  options: { cursor?: string; limit?: number },
): string {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) if (item !== '') qs.append(key, item);
    } else if (value !== '') {
      qs.set(key, value);
    }
  }
  if (options.cursor) qs.set('cursor', options.cursor);
  if (options.limit !== undefined) qs.set('limit', String(options.limit));
  const query = qs.toString();
  return query ? `?${query}` : '';
}

/**
 * The agent's own dial history, **across campaigns**.
 *
 * Distinct from `getCampaignAttempts` in one way that matters: that route is
 * one campaign's spine and is floored at `agency.supervise`, so an agent cannot
 * read even their own rows through it. This one is cross-campaign and scoped to
 * the caller, which is the only shape that answers "what did I do today" for
 * somebody working two campaigns in one shift.
 *
 * Rows are the same {@link AgencyAttempt} shape, so the spine's copy helpers and
 * outcome vocabulary apply unchanged.
 */
export async function getMyAttempts(
  filters: AgencyAttemptFilters & { campaign_id?: string } = {},
  options: { cursor?: string; limit?: number } = {},
  tenantId?: string,
  accountId?: string,
): Promise<AgencyKeysetPage<AgencyAttempt>> {
  return apiFetch<AgencyKeysetPage<AgencyAttempt>>(
    `${ENDPOINTS.proxy.agency.myAttempts}${attemptQuery(filters, options)}`,
    {},
    tenantId,
    accountId,
  );
}

/** The supervisor twin of {@link getMyAttempts}. Floored at `agency.supervise`. */
export async function getAgentAttempts(
  userId: string,
  filters: AgencyAttemptFilters & { campaign_id?: string } = {},
  options: { cursor?: string; limit?: number } = {},
  tenantId?: string,
  accountId?: string,
): Promise<AgencyKeysetPage<AgencyAttempt>> {
  return apiFetch<AgencyKeysetPage<AgencyAttempt>>(
    `${ENDPOINTS.proxy.agency.agentAttempts(userId)}${attemptQuery(filters, options)}`,
    {},
    tenantId,
    accountId,
  );
}

/**
 * Every campaign this agent has EVER been staffed on, ended assignments
 * included. An empty array is a steady state — nobody has staffed them yet — not
 * a failure.
 *
 * Not a replacement for `getMyAssignments`, and the difference is the point:
 * that one is the entry list (where may I go now), this is the history (what
 * have I worked). The performance page needs the history because
 * `by_campaign[]` carries ids and no names, and a breakdown row for a campaign
 * an agent was taken off would otherwise be an unexplained id.
 *
 * Both wire shapes are accepted for the same reason `listAgencyCampaigns`
 * accepts both: a bare array is what master's contract states, an
 * `{ campaigns: [] }` envelope is what its sibling staffing route uses, and
 * `.map` of `undefined` inside a render is a worse failure than tolerating
 * either.
 */
export async function getMyCampaigns(
  tenantId?: string,
  accountId?: string,
): Promise<AgencyStaffingHistoryEntry[]> {
  const body = await apiFetch<
    AgencyStaffingHistoryEntry[] | AgencyStaffingHistory | undefined
  >(ENDPOINTS.proxy.agency.myCampaigns, {}, tenantId, accountId);
  if (Array.isArray(body)) return body;
  return body?.assignments ?? [];
}
