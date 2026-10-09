/**
 * ─── AGENCY DIALER — THE AGENT'S OWN RECORD, PARSED AND BUCKETED ────────────
 *
 * Everything `GET /api/v1/agency-agents/:agentUserId/stats` needs that is neither
 * SQL nor a Fastify handler: the bucket vocabulary, the query parsing, the ONE
 * spelling of the bucket expression both aggregates use, and the fold from
 * (state, seconds) rows to an occupancy block.
 *
 * A near-leaf module — types from `contracts.ts`, and the three parsing
 * primitives from `spine-filters.ts`, imported rather than re-spelled so this
 * surface cannot end up with a second opinion about what an ISO date is. It
 * exists apart from the routes so the rules can be exercised without a Fastify
 * instance, and apart from the repository so the SQL builder receives a shape it
 * can trust.
 */

import type {
  AgencyAgentState,
  AgencyAgentOccupancy,
  AgencyGroupDimension,
  AgencyGroupSort,
  AgencyRosterAgentRow,
  AgencyRosterPercentiles,
  AgencyRosterSort,
  AgencyStatsBucketUnit,
} from '@magick-agency/contracts/agency';
import {
  parseAttemptFilters,
  parseFilterDate,
  singleParam,
  validateEnum,
  vocabulary,
  type AgencyAttemptFilters,
  type FilterIssue,
  type FilterParse,
} from './spine-filters.js';

/**
 * The bucket units, as the inverted `Record` check rather than
 * `satisfies readonly AgencyStatsBucketUnit[]`.
 *
 * Same reasoning as `ATTEMPT_STATES` and friends, restated because it is the one
 * thing about this file most likely to be "simplified": `satisfies` checks that
 * every element of the array is a member of the union and says NOTHING about
 * whether every member of the union appears in the array. So adding a `quarter`
 * to the union and forgetting it here would compile — and the failure is that a
 * caller asking for a real, declared bucket unit gets a 400 calling it unknown.
 * `Record<TUnion, true>` inverts the check: a missing member is a missing required
 * key, i.e. a build error that names it.
 */
export const AGENT_STATS_BUCKETS = vocabulary<AgencyStatsBucketUnit>({
  day: true, week: true, month: true,
});

/**
 * The widest window this endpoint will aggregate, in days.
 *
 * Bounded because the response size is `buckets × 1` and the occupancy read
 * differences every event in the window: `bucket=day` over five years is ~1,800
 * bucket objects and every transition the agent has ever made, assembled in
 * memory for a page nobody scrolls. 366 days is a full year including a leap one
 * — the longest range a "my record" screen has any use for — and the refusal
 * names the cap, so a caller that wants more knows to page by year rather than
 * discovering an empty answer.
 */
export const AGENT_STATS_MAX_WINDOW_DAYS = 366;

const MS_PER_DAY = 86_400_000;

/** The window and grouping one agent-stats read runs over. */
export interface AgentStatsParams {
  /** Inclusive lower bound on `dialed_at` / on the occupancy window. */
  from: Date;
  /** EXCLUSIVE upper bound — see {@link parseAgentStatsQuery}. */
  to: Date;
  bucket: AgencyStatsBucketUnit;
  /** Restrict to one campaign; omit for the agent's whole cross-campaign record. */
  campaignId?: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `?from=&to=&bucket=&campaign_id=` → {@link AgentStatsParams}, or the issues.
 *
 * ── `from` and `to` are REQUIRED, unlike everywhere else on this surface ────
 *
 * The attempt and contact spines treat both as optional filters, because their
 * default — the whole campaign, newest first — is bounded by a keyset page. This
 * endpoint has no page: it aggregates, so an absent bound means "every shift this
 * agent has ever worked, one bucket per day, in one payload". A defaulted window
 * would be worse than a refusal, because the caller cannot tell from the response
 * which window they got.
 *
 * ── `to` is EXCLUSIVE, and `from` is inclusive ──────────────────────────────
 *
 * A half-open window is the only shape that tiles: consecutive requests
 * `[Mon, Tue)` and `[Tue, Wed)` cover Tuesday exactly once. The attempt spine's
 * `to` is inclusive (`created_at <= $n`), which is right for a "show me up to
 * here" filter and wrong for an aggregate anyone might sum. Stated here because
 * the two live on adjacent routes and the difference is invisible in a URL.
 *
 * Date parsing itself is `parseFilterDate`, imported — the same rules, the same
 * refusals, the same reasons (a zone-less date-time means the SERVER's zone; a
 * rolled-forward `2026-02-30` returns a real result set for a window nobody
 * asked for). A second date parser on a second read surface is how one of them
 * silently starts accepting `17 Aug 2026`.
 */
export function parseAgentStatsQuery(query: Record<string, unknown>): FilterParse<AgentStatsParams> {
  const issues: FilterIssue[] = [];

  const fromRaw = singleParam(query['from']);
  const toRaw = singleParam(query['to']);
  if (fromRaw === undefined) issues.push({ param: 'from', message: 'is required' });
  if (toRaw === undefined) issues.push({ param: 'to', message: 'is required' });
  const from = parseFilterDate('from', fromRaw, issues);
  const to = parseFilterDate('to', toRaw, issues);

  // Refused rather than silently emptied, exactly as `checkRange` does on the
  // spine: `from >= to` matches nothing, and "nothing" on a record page reads as
  // a fact about the agent rather than about the request. Equality is refused too
  // — a half-open window of zero width has no buckets and no honest answer.
  if (from && to && from.getTime() >= to.getTime()) {
    issues.push({ param: 'from', message: '`from` must be earlier than `to` (the window is half-open)' });
  } else if (from && to && to.getTime() - from.getTime() > AGENT_STATS_MAX_WINDOW_DAYS * MS_PER_DAY) {
    issues.push({
      param: 'from',
      message: `the window must be at most ${AGENT_STATS_MAX_WINDOW_DAYS} days — request a narrower range`,
    });
  }

  // Defaulted rather than required: `day` is what a record page opens on, and
  // unlike the window there is no way to be wrong about which grouping you got
  // (it is echoed on the response).
  const bucketRaw = singleParam(query['bucket']);
  let bucket: AgencyStatsBucketUnit = 'day';
  if (bucketRaw !== undefined) {
    if (!(AGENT_STATS_BUCKETS as readonly string[]).includes(bucketRaw)) {
      // The valid set is echoed, the way `validateEnum` and the break route's
      // `unknown_break_reason` already do: a client holding a stale vocabulary
      // recovers in one round trip instead of guessing.
      issues.push({
        param: 'bucket',
        message: `unknown bucket: ${bucketRaw} — expected one of ${AGENT_STATS_BUCKETS.join(', ')}`,
      });
    } else {
      bucket = bucketRaw as AgencyStatsBucketUnit;
    }
  }

  // Shape-checked before it can reach a `::uuid` cast, which answers `22P02` and
  // surfaces as a 500 carrying the database's error text — a bad request that
  // reads as a broken service. Same guard, same reason, as the spine's
  // `?contact_id=`.
  const campaignId = singleParam(query['campaign_id']);
  if (campaignId !== undefined && !UUID_RE.test(campaignId)) {
    issues.push({ param: 'campaign_id', message: 'must be a campaign id' });
  }

  if (issues.length > 0 || !from || !to) {
    // `!from || !to` cannot be reached with an empty issue list — both are
    // required above — but the compiler cannot see that, and returning
    // `ok: true` with a fabricated date would be the worse way to satisfy it.
    return { ok: false, issues: issues.length > 0 ? issues : [{ param: 'from', message: 'is required' }] };
  }

  return {
    ok: true,
    filters: { from, to, bucket, ...(campaignId ? { campaignId } : {}) },
  };
}

/**
 * The ONE spelling of a bucket boundary. Both aggregates call this.
 *
 * ── The rule, stated where it is implemented ────────────────────────────────
 *
 * Buckets are cut in **each campaign's own `default_timezone`**, derived PER ROW.
 * There is deliberately no `tz` query parameter. See the endpoint's docstring in
 * `agency-agents.routes.ts` for the product argument; what matters here is the
 * mechanical consequence: because the zone comes off the row's own campaign, every
 * row lands in exactly one bucket, so cross-campaign totals sum exactly with no
 * double-counting and no gaps.
 *
 * ── Why `to_char` and not the truncated timestamp ──────────────────────────
 *
 * `date_trunc(unit, ts AT TIME ZONE tz)` yields a bare `timestamp` (no zone), and
 * **node-pg parses a bare `timestamp` into a LOCAL-time `Date`** — so returning it
 * would re-introduce the server's zone on the way out, after the query went to the
 * trouble of removing it. `hourlyBuckets` states both halves of this (that and the
 * dispatch-hop skew argument for bucketing on `dialed_at`) and formats in SQL for
 * the same reason; this follows it. The format is `YYYY-MM-DD` for all three units
 * — a bucket START is a date, and a `week`/`month` bucket labelled with a time
 * would invite a reader to treat the label as an instant.
 *
 * ── `unit` is interpolated, and that is safe here ONLY because ──────────────
 *
 * `date_trunc`'s first argument cannot be a parameter placeholder in a way the
 * planner will accept alongside a `GROUP BY` on the same expression, so the unit is
 * interpolated. It MUST come from {@link AGENT_STATS_BUCKETS} — i.e. from
 * `parseAgentStatsQuery`, which refuses anything else with a 400 — and never from
 * raw query input. The signature takes the union type rather than `string`
 * precisely so a caller cannot hand it an unvalidated value without the compiler
 * objecting.
 *
 * `tsExpr` and `tzExpr` are column expressions supplied by the repository
 * (`a.dialed_at`, and the resolved zone — see the repository for why the zone is
 * resolved through `pg_timezone_names` rather than used raw).
 */
export function bucketStartSql(unit: AgencyStatsBucketUnit, tsExpr: string, tzExpr: string): string {
  return `to_char(${bucketTruncSql(unit, tsExpr, tzExpr)}, 'YYYY-MM-DD')`;
}

/**
 * The bucket boundary as a bare LOCAL `timestamp`, before it is formatted.
 *
 * {@link bucketStartSql} is this plus a `to_char`. It is exposed separately
 * because the occupancy read needs the boundary as a value rather than a label:
 * it walks the buckets an interval spans with
 * `generate_series(trunc(started), trunc(ended), interval '1 <unit>')` and clips
 * the interval to each one. Both callers therefore truncate through this one
 * expression — a second spelling of the truncation would let the attempt buckets
 * and the occupancy buckets fall on different boundaries, and the symptom would
 * be an occupancy row attached to a bucket whose attempts are in the next one.
 *
 * Bare `timestamp` on purpose: converting back with `AT TIME ZONE <zone>` yields
 * the boundary's true instant including any DST shift, so a "day" that is 23 or
 * 25 hours long is measured as it actually was.
 */
export function bucketTruncSql(unit: AgencyStatsBucketUnit, tsExpr: string, tzExpr: string): string {
  return `date_trunc('${unit}', (${tsExpr} AT TIME ZONE ${tzExpr}))`;
}

/**
 * Every state at zero, and no shift.
 *
 * The shape a bucket with no events must take. **Zeros, never absent keys and
 * never an inference:** sessions that predate state-event recording have no events at all,
 * and the honest answer for them is "we recorded nothing", not a duration
 * reconstructed from `state_since` (which is a snapshot, so it would attribute the
 * agent's entire history to whatever state they happen to be in now). A missing
 * key is indistinguishable from zero to a consumer, and the console renders all
 * six states.
 */
export function zeroOccupancy(): AgencyAgentOccupancy {
  return {
    shift_seconds: 0,
    by_state: {
      available: 0,
      reserved: 0,
      on_call: 0,
      wrapup: 0,
      break: 0,
      offline: 0,
    },
  };
}

/**
 * Fold `(state, seconds)` rows into one occupancy block.
 *
 * `shift_seconds` is every non-`offline` second — the time the agent was logged
 * in and reachable, whatever they were doing. That makes occupancy
 * (`on_call / shift_seconds`) computable by the reader, and so is the
 * break-excluding variant some contact centres prefer (`shift_seconds -
 * by_state.break`), because both terms are on the payload. Deliberately NOT
 * pre-divided into a rate here: there are two defensible denominators and picking
 * one silently is how two screens come to disagree about "occupancy".
 *
 * `offline` is reported but excluded from the shift: an agent who logged out at
 * 17:00 was not on shift at 18:00, and folding that into the denominator would
 * make every short shift look unoccupied. It is still reported, because "logged
 * out" and "no data" are different facts and only one of them is a gap in the
 * record.
 *
 * Unknown states are **dropped, not invented**. The session-event CHECK and
 * `AgencyAgentState` agree today; if a seventh state is added to one and not the
 * other, an invented key here is one the console's exhaustive switch cannot
 * render, and all six promised keys would still be present — so nothing would
 * look wrong. Dropping loses a duration; inventing loses the contract. Same
 * choice, and the same `Object.hasOwn` rather than `in` (which walks the
 * prototype chain, so a state literally named `toString` would pass the guard and
 * then add a number to a function), as `agents_by_state`.
 */
export function foldOccupancy(rows: Iterable<{ state: string; seconds: number }>): AgencyAgentOccupancy {
  const occupancy = zeroOccupancy();
  for (const row of rows) {
    if (!Object.hasOwn(occupancy.by_state, row.state)) continue;
    const seconds = Number.isFinite(row.seconds) ? row.seconds : 0;
    // Negative would mean an interval that ended before it began — impossible
    // through the clipping the query does, and clamped rather than trusted
    // because one bad row would otherwise subtract from a total that is read as
    // a duration.
    const clamped = seconds > 0 ? seconds : 0;
    occupancy.by_state[row.state as AgencyAgentState] += clamped;
    if (row.state !== 'offline') occupancy.shift_seconds += clamped;
  }
  return occupancy;
}

/**
 * The agent-scoped attempt spine's filters: the campaign spine's set, plus
 * `campaign_id`.
 *
 * `campaignId` exists here and not on {@link AgencyAttemptFilters} because on the
 * campaign-scoped route it would be a second, contradictable source for a value
 * the path already fixes — `?campaign_id=` on `/agency-campaigns/:id/attempts`
 * can only agree with `:id` or be wrong. Cross-campaign is the whole point of the
 * agent route, so there it is a real filter.
 */
export interface AgentAttemptFilters extends AgencyAttemptFilters {
  campaignId?: string;
}

/**
 * `parseAttemptFilters` plus `campaign_id`.
 *
 * **The vocabulary is IMPORTED, not forked.** `state`, `outcome`,
 * `disposition_code`, `from`, `to`, `phone` and `contact_id` are parsed by the
 * same function the campaign spine uses, so `ATTEMPT_STATES` /
 * `ATTEMPT_OUTCOMES` have exactly one definition and the 400 that echoes them
 * says the same thing on both routes. A second parser here is how one surface
 * comes to accept an outcome the other calls unknown — which is the failure
 * `spine-filters.ts`'s own header describes.
 *
 * `?agent_user_id=` is parsed (it is part of the imported vocabulary) and then
 * IGNORED by the repository: the path parameter is the agent, and a query
 * parameter that silently narrowed or contradicted it would make the same URL
 * mean two things. Refusing it outright was the alternative; accepting and
 * ignoring keeps a client that sends both — the obvious thing for code generated
 * from the campaign route — working rather than 400ing on a redundancy.
 */
export function parseAgentAttemptFilters(
  query: Record<string, unknown>,
): FilterParse<AgentAttemptFilters> {
  const parsed = parseAttemptFilters(query);
  const issues: FilterIssue[] = parsed.ok ? [] : [...parsed.issues];

  const campaignId = singleParam(query['campaign_id']);
  if (campaignId !== undefined && !UUID_RE.test(campaignId)) {
    issues.push({ param: 'campaign_id', message: 'must be a campaign id' });
  }
  if (issues.length > 0 || !parsed.ok) {
    return { ok: false, issues: issues.length > 0 ? issues : [{ param: 'campaign_id', message: 'must be a campaign id' }] };
  }

  return {
    ok: true,
    filters: { ...parsed.filters, ...(campaignId ? { campaignId } : {}) },
  };
}

// ─── THE SUPERVISOR'S ROSTER (`GET /api/v1/agency-agents/stats`) ─────────────
//
// The same window and the same scope as the per-agent record, grouped ONE LEVEL
// UP: per agent instead of per bucket. So everything above about how a window is
// parsed applies unchanged, and everything about bucketing does not apply at all —
// there is no bucket on this route, therefore no `bucket` parameter, no
// `date_trunc`, and no campaign timezone to resolve.
//
// What is new is that the roster is RANKED, and ranking is why the three pure
// helpers at the bottom of this section live here rather than in the repository:
// the ordering rule (nulls last in both directions, `agent_user_id` as the
// tiebreaker) and the percentile rule (thin rows excluded) are product decisions
// that must be exercisable without a database, and they are the two rules a
// reader is most likely to assume are "just the default".

/**
 * What the roster may be ordered by, as the inverted `Record` check.
 *
 * Same argument as {@link AGENT_STATS_BUCKETS}, and it bites harder here: a tenth
 * sort key added to {@link AgencyRosterSort} and forgotten in this object is a
 * missing required key, i.e. a build error naming it — where `satisfies` would
 * compile and leave a real, declared sort key answering 400 "unknown sort".
 */
export const ROSTER_SORTS = vocabulary<AgencyRosterSort>({
  attempts: true, connected: true, connect_rate_pct: true, successes: true,
  success_rate_pct: true, aht_seconds: true, talk_seconds: true,
  occupancy_pct: true, agent_user_id: true,
});

/** The two directions. Spelled as a vocabulary so the 400 echoes them like every other. */
export const ROSTER_ORDERS = vocabulary<'asc' | 'desc'>({ asc: true, desc: true });

/**
 * `successes` descending — the roster's opening question, and deliberately not
 * `attempts`.
 *
 * A roster sorted by dial count ranks agents by how hard the DIALER worked them,
 * which is a fact about the pacing engine and the list rather than about them.
 * `successes` is the outcome the floor is run for. It is also a raw count rather
 * than a rate, so the default page cannot be topped by an agent with one connect
 * and one sale.
 */
export const ROSTER_DEFAULT_SORT: AgencyRosterSort = 'successes';
export const ROSTER_DEFAULT_ORDER = 'desc' as const;

/**
 * Page size. **Both bounds refuse rather than clamp** — see {@link parseRosterQuery}.
 *
 * 200 is above any real floor for one account, so the ceiling is a guard against
 * a generated client sending `limit=100000`, not a paging boundary anybody is
 * expected to hit.
 */
export const ROSTER_DEFAULT_LIMIT = 100;
export const ROSTER_MAX_LIMIT = 200;

/**
 * The widest window the roster will answer — **a quarter, not a year.**
 *
 * ── Why this is NOT {@link AGENT_STATS_MAX_WINDOW_DAYS} ─────────────────────
 *
 * The per-agent record's 366 is argued from PAYLOAD size (`buckets × 1`) and it
 * is the right cap for that read for a second reason it does not state: that read
 * is bounded to ONE `agent_user_id`, which is the predicate its occupancy index
 * is reachable through. This one names no agent. `rosterOccupancyTotals`'s
 * `in_window` CTE pulls every state transition for every agent in the ACCOUNT
 * over the window into a `lead()`, so the same 366 days costs ~N times as much in
 * a floor of N — a different question deserving a different bound, not the same
 * number kept for URL symmetry.
 *
 * ── And there is no wall clock behind it ────────────────────────────────────
 *
 * Neither statement may carry a `LIMIT` — the benchmark needs the whole
 * pre-`limit` cohort, and {@link AgencyRosterBenchmark}'s occupancy percentiles
 * need an input that exists in neither statement alone. The server sets no
 * `statement_timeout` and no `query_timeout` anywhere, so a read that runs long
 * holds a pool connection for as long as it takes — the same pool serving
 * authentication, the pacing tick and attempt writes. With no `LIMIT` to shed
 * rows and no timeout to cut the statement off, the WINDOW is the only bound
 * available, which is why it is set from cost rather than inherited.
 *
 * 92 days is a quarter, and it covers every period the console offers — today,
 * this week, this month, and the completed last-week / last-month ranges — with
 * room above the longest of them. A caller wanting a year pages by quarter, and
 * the refusal names the bound so they learn that rather than discovering it.
 */
export const ROSTER_MAX_WINDOW_DAYS = 92;

/** The window, scope-independent filters and ranking one roster read runs over. */
export interface AgentRosterParams {
  /** Inclusive lower bound on `dialed_at` / on the occupancy window. */
  from: Date;
  /** EXCLUSIVE upper bound, same half-open window as {@link AgentStatsParams}. */
  to: Date;
  /** Narrow every row to one campaign; omit for the whole cross-campaign floor. */
  campaignId?: string;
  sort: AgencyRosterSort;
  order: 'asc' | 'desc';
  limit: number;
}

/**
 * {@link validateEnum} for a param that carries exactly one value.
 *
 * The shared validator takes an array because the filters it was written for
 * repeat (`?outcome=a&outcome=b`). Wrapping is how a single-valued param reuses
 * its 400 — the same wording, the same echoed vocabulary — instead of growing a
 * second message for the identical mistake.
 *
 * ── What it does and does not catch, stated exactly ─────────────────────────
 *
 * The COMMA form is the case this covers: `?sort=a,b` arrives as the single
 * string `'a,b'`, which no vocabulary contains, so it refuses naming the whole
 * value rather than silently sorting by `a`. Two sort keys is not a request this
 * route can honour and it is told so.
 *
 * The REPEATED form is a different story and this does not reach it. `?sort=a&
 * sort=b` arrives as an array and {@link singleParam} takes `raw[0]`, so the
 * extra values are dropped before the vocabulary is consulted — house-wide
 * `singleParam` behaviour on every single-valued param here, not something this
 * wrapper introduces or could fix alone. It is not reachable from the browser:
 * the public API layer's `forwardAllowedQuery` comma-JOINS a repeated param, so the
 * same URL from the console arrives as `'a,b'` and lands in the case above as a 400.
 * Only a direct caller of the internal handler sees the drop, and it sees the
 * applied `sort` echoed on the response either way.
 */
function singleEnum<T extends string>(
  param: string,
  raw: string | undefined,
  allowed: readonly T[],
  issues: FilterIssue[],
): T | undefined {
  if (raw === undefined) return undefined;
  const validated = validateEnum<T>(param, [raw], allowed, issues);
  return validated?.[0];
}

/**
 * `?from=&to=&campaign_id=&sort=&order=&limit=` → {@link AgentRosterParams}.
 *
 * ── The window rules are IMPORTED, except the CAP ───────────────────────────
 *
 * `from`/`to` are required, half-open and parsed by `parseFilterDate` — every one
 * of those is the same rule as {@link parseAgentStatsQuery}, for the same reasons,
 * and the reasons are written out there.
 *
 * The cap is NOT the same. It is {@link ROSTER_MAX_WINDOW_DAYS} (92), not
 * {@link AGENT_STATS_MAX_WINDOW_DAYS} (366), and the argument for keeping them
 * identical — that two adjacent read surfaces accepting different windows is a
 * difference invisible in a URL — loses to the reason they differ: the per-agent
 * read is bounded to ONE `agent_user_id` and this one is the whole account, so the
 * occupancy read behind it differences every transition of every agent on the
 * floor rather than of one person. That is an ~N-fold cost difference in a floor
 * of N, and neither statement here may carry a `LIMIT` (the benchmark needs the
 * whole pre-`limit` cohort) while the server sets no `statement_timeout` anywhere. A
 * whole-floor read and a one-person read are visibly different questions; giving
 * them the same bound for URL symmetry would be dressing that up as consistency.
 * The refusal names the bound, so a caller wanting a year learns to page by
 * quarter rather than discovering it.
 *
 * ── `bucket` is NOT accepted, and neither is `agent_user_id` ─────────────────
 *
 * Not defaulted-and-ignored: both are 400s through the unknown-param check
 * the public API layer applies, because both would be a URL that reads as one question and is
 * answered as another. `agent_user_id` narrowed to named agents belongs to a
 * compare surface, and accepting it here would make `benchmark` mean something
 * different per request under the same name.
 *
 * ── `limit` REFUSES, where the attempt spine's `clampLimit` clamps ───────────
 *
 * `?limit=0`, `?limit=201` and `?limit=abc` are all 400s naming the bound. That
 * is a deliberate divergence from `clampLimit`, which silently pins the value,
 * and the two surfaces differ in a way that justifies it: the spine's `limit` is
 * a page size on a CURSOR-paged list, where a clamped value still returns the
 * next rows and the caller loses nothing but a round trip. The roster's `limit`
 * truncates a RANKED list and there is no cursor to continue with, so a silently
 * changed limit changes which agents are on the page — and `total_agents` is the
 * only hint, which a caller who did not know their limit moved will not read as
 * one. Same rule as everything else here: an invalid value is a 400 with details,
 * never a silent default.
 *
 * `sort` and `order` are DEFAULTED when absent and REFUSED when unknown. Absent
 * is unambiguous (the response echoes both, so a caller can always tell what they
 * got); a stale vocabulary is not, and a client asking for a sort this build does
 * not have must be told rather than handed a differently-ordered page that looks
 * like an answer.
 */
export function parseRosterQuery(query: Record<string, unknown>): FilterParse<AgentRosterParams> {
  const issues: FilterIssue[] = [];

  const fromRaw = singleParam(query['from']);
  const toRaw = singleParam(query['to']);
  if (fromRaw === undefined) issues.push({ param: 'from', message: 'is required' });
  if (toRaw === undefined) issues.push({ param: 'to', message: 'is required' });
  const from = parseFilterDate('from', fromRaw, issues);
  const to = parseFilterDate('to', toRaw, issues);

  // Refused rather than silently emptied, exactly as `parseAgentStatsQuery` does:
  // `from >= to` matches nothing, and an empty roster reads as a fact about the
  // floor rather than about the request.
  if (from && to && from.getTime() >= to.getTime()) {
    issues.push({ param: 'from', message: '`from` must be earlier than `to` (the window is half-open)' });
  } else if (from && to && to.getTime() - from.getTime() > ROSTER_MAX_WINDOW_DAYS * MS_PER_DAY) {
    // The ROSTER's cap, not the per-agent read's — see `ROSTER_MAX_WINDOW_DAYS`.
    // Same refusal shape as every other issue in this function, and it names the
    // bound so the caller can page rather than guess.
    issues.push({
      param: 'from',
      message: `the window must be at most ${ROSTER_MAX_WINDOW_DAYS} days — request a narrower range`,
    });
  }

  // Shape-checked before it can reach a `::uuid` cast, which answers `22P02` and
  // surfaces as a 500 carrying the database's error text — a bad request that
  // reads as a broken service. Same guard, same reason, as everywhere else here.
  const campaignId = singleParam(query['campaign_id']);
  if (campaignId !== undefined && !UUID_RE.test(campaignId)) {
    issues.push({ param: 'campaign_id', message: 'must be a campaign id' });
  }

  const sort = singleEnum('sort', singleParam(query['sort']), ROSTER_SORTS, issues);
  const order = singleEnum('order', singleParam(query['order']), ROSTER_ORDERS, issues);

  // Parsed through the raw string rather than `Number()` alone: `Number('1.5')` is
  // finite and `Math.floor` would accept it as 1, and `Number('')`/`Number(' ')`
  // are 0 — so a cleared form field would arrive as a refusal naming a bound the
  // caller never typed. `singleParam` has already turned blank into absent.
  const limitRaw = singleParam(query['limit']);
  let limit = ROSTER_DEFAULT_LIMIT;
  if (limitRaw !== undefined) {
    const parsed = Number(limitRaw);
    if (!/^\d+$/.test(limitRaw) || !Number.isSafeInteger(parsed)
      || parsed < 1 || parsed > ROSTER_MAX_LIMIT) {
      issues.push({
        param: 'limit',
        message: `must be a whole number between 1 and ${ROSTER_MAX_LIMIT}`,
      });
    } else {
      limit = parsed;
    }
  }

  if (issues.length > 0 || !from || !to) {
    // `!from || !to` cannot be reached with an empty issue list — both are
    // required above — but the compiler cannot see that, and returning `ok: true`
    // with a fabricated window would be the worse way to satisfy it.
    return { ok: false, issues: issues.length > 0 ? issues : [{ param: 'from', message: 'is required' }] };
  }

  return {
    ok: true,
    filters: {
      from,
      to,
      ...(campaignId ? { campaignId } : {}),
      sort: sort ?? ROSTER_DEFAULT_SORT,
      order: order ?? ROSTER_DEFAULT_ORDER,
      limit,
    },
  };
}

/**
 * p25 / median / p75 over an already-filtered set of values.
 *
 * ── The filtering is the CALLER's job, and that is the interesting half ──────
 *
 * This function ranks whatever it is handed. Which rows are handed to it — only
 * those whose denominator cleared `AGENCY_ROSTER_MIN_RATE_DENOMINATOR`, and never
 * a `null` rate — is the rule stated on `AgencyRosterBenchmark`, and it lives at
 * the call site because the qualifying denominator differs per metric while the
 * ranking does not. Passing a `null` through here would be the failure the whole
 * threshold exists to prevent: JavaScript sorts `null` as 0, so one agent who
 * connected nobody would sit at the bottom of the distribution as a hard 0% and
 * pull p25 down with them.
 *
 * ── `percentile_cont`, not `percentile_disc` ────────────────────────────────
 *
 * Linear interpolation between the two neighbouring values, which is what
 * Postgres's `percentile_cont` computes and what a reader means by "the median".
 * The discrete reading snaps to an actual row, and on a floor of four agents that
 * makes the median one named person's number — which invites reading the
 * benchmark as a comparison against THEM.
 *
 * Empty input yields all three `null`, never 0 — the same rule as every rate on
 * this surface, for the same reason: "nothing qualified" and "the cohort scores
 * zero" are different facts.
 */
export function rosterPercentiles(values: readonly number[]): AgencyRosterPercentiles {
  if (values.length === 0) return { p25: null, median: null, p75: null };
  const sorted = [...values].sort((a, b) => a - b);
  const at = (fraction: number): number => {
    // `(n - 1) * fraction` is the `percentile_cont` position: 0 for the first row,
    // n-1 for the last, so a single value returns itself for all three quantiles.
    const position = (sorted.length - 1) * fraction;
    const lower = Math.floor(position);
    const upper = Math.ceil(position);
    const low = sorted[lower] as number;
    const high = sorted[upper] as number;
    return low + (high - low) * (position - lower);
  };
  return { p25: at(0.25), median: at(0.5), p75: at(0.75) };
}

/**
 * The value each sort key reads, as the inverted `Record`.
 *
 * `Record<AgencyRosterSort, …>` rather than a `switch`: a tenth sort key added to
 * the union is a missing required key here — a build error that names it — where
 * a `switch` with a `default` would compile and silently rank the new key by
 * whatever the fallback picked. Same idiom, same reason, as {@link ROSTER_SORTS}
 * (which guards the 400) — the two are separate objects because they guard
 * separate failures, and a key present in one and absent from the other is a
 * build error either way.
 */
const ROSTER_SORT_VALUES: Record<
  AgencyRosterSort,
  (row: AgencyRosterAgentRow) => number | string | null
> = {
  attempts: (row) => row.attempts,
  connected: (row) => row.connected,
  connect_rate_pct: (row) => row.connect_rate_pct,
  successes: (row) => row.successes,
  success_rate_pct: (row) => row.success_rate_pct,
  aht_seconds: (row) => row.aht_seconds,
  talk_seconds: (row) => row.talk_seconds,
  occupancy_pct: (row) => row.occupancy_pct,
  agent_user_id: (row) => row.agent_user_id,
};

/**
 * Rank the roster. Returns a new array; the input is not mutated.
 *
 * ── NULLS LAST IN BOTH DIRECTIONS ───────────────────────────────────────────
 *
 * Four of the nine sort keys are nullable, and `null` on them means "no
 * measurable rate" — not zero, not worst, not best. **A null row is not ranked**,
 * so it goes to the end whichever direction was asked for. Both halves of that
 * are load-bearing and both are wrong under a naive comparator:
 *
 *   * Under `desc`, JavaScript's `b - a` on a `null` reads it as 0 and files an
 *     agent who connected nobody at the BOTTOM — plausible, and wrong, because it
 *     asserts a 0% connect rate the data does not support.
 *   * Under `asc` the same coercion puts them at the TOP of "worst connect rate",
 *     which is the same false claim promoted to the first thing a supervisor sees.
 *
 * This is the `ORDER BY … NULLS LAST` the frozen contract specifies, expressed in
 * TypeScript because the ranking cannot happen in SQL — see
 * `AgencyAgentStatsRepository.roster` for why (the occupancy metric arrives from
 * a second statement, and the benchmark needs the whole cohort before `limit`).
 * Being one comparator rather than a SQL fragment plus a fallback is what stops
 * the two from drifting, and it means `sort`/`order` never reach a query at all.
 *
 * ── `agent_user_id` is the tiebreaker on EVERY sort ─────────────────────────
 *
 * Ties are the normal case, not an edge: `successes` is a small integer and a
 * floor of thirty will have several agents on 4, and every null on a nullable key
 * ties with every other null. Without a total order two reads of the same window
 * return the same rows in a different order, which reads as data moving under the
 * reader, and `limit` then makes it worse — it changes WHICH agents are on the
 * page between two identical requests.
 *
 * The tiebreak is always ASCENDING, including under `order=desc`. It is there to
 * be deterministic rather than to be meaningful; reversing it with the direction
 * would be equally deterministic and would make a stable page appear to reshuffle
 * when the reader flipped an unrelated column. When `sort` IS `agent_user_id` the
 * primary comparison already honours `order`, and the tiebreak is unreachable
 * because the ids are unique.
 */
export function sortRosterRows(
  rows: readonly AgencyRosterAgentRow[],
  sort: AgencyRosterSort,
  order: 'asc' | 'desc',
): AgencyRosterAgentRow[] {
  const read = ROSTER_SORT_VALUES[sort];
  const direction = order === 'asc' ? 1 : -1;
  const tiebreak = (a: AgencyRosterAgentRow, b: AgencyRosterAgentRow): number =>
    (a.agent_user_id < b.agent_user_id ? -1 : a.agent_user_id > b.agent_user_id ? 1 : 0);

  return [...rows].sort((a, b) => {
    const left = read(a);
    const right = read(b);
    // Nulls last, direction-independent. Checked before the comparison rather
    // than folded into it, because there is no arithmetic on `null` that produces
    // "unranked" — every coercion produces a position.
    if (left === null || right === null) {
      if (left === null && right === null) return tiebreak(a, b);
      return left === null ? 1 : -1;
    }
    if (left < right) return -direction;
    if (left > right) return direction;
    return tiebreak(a, b);
  });
}


// ─── THE GROUPED READ (`GET /api/v1/agency-agents/grouped-stats`) ────────────
//
// The same window, the same scope and the same five metric expressions as the
// roster, grouped by one or two CALLER-CHOSEN dimensions instead of by agent. So
// everything above about how a window is parsed and refused applies unchanged, and
// the cap is literally the same constant.
//
// What is new, and it is the whole reason this parsing is here rather than in the
// route, is that the choice of dimension can make the read UNANSWERABLE — a time
// bucket across campaigns in different zones is not one column (see
// {@link parseGroupedStatsQuery}). That is a product rule, so it has to be
// exercisable without a Fastify instance and without a pool.

/**
 * The group vocabulary, as the inverted `Record` check — and its DECLARATION
 * ORDER is the canonical order.
 *
 * Two jobs, and the second is why the order matters: it guards the 400 that names
 * the valid set (same argument as {@link ROSTER_SORTS}), and `vocabulary()` reads
 * the keys back in declaration order, which is the order `group_by` is echoed in
 * and the order the key's dimensions are compared in. So `agent,campaign` and
 * `campaign,agent` canonicalise to the same list, are the same read, and cache the
 * same — rather than being two spellings that return the same rows in two orders.
 */
export const AGENCY_GROUP_DIMENSIONS = vocabulary<AgencyGroupDimension>({
  agent: true, campaign: true, disposition: true,
  day: true, day_of_week: true, hour_of_day: true,
});

/** What a grouped read may be ordered by. Same inverted-`Record` argument. */
export const GROUP_SORTS = vocabulary<AgencyGroupSort>({
  key: true, attempts: true, connected: true, successes: true,
  connect_rate_pct: true, success_rate_pct: true, aht_seconds: true,
});

/**
 * **Two dimensions, and it is a BOUND rather than a preference.**
 *
 * The row count is the PRODUCT of the grouped dimensions' cardinalities, so a
 * third dimension turns a bounded read into an unbounded one: agent × campaign ×
 * hour on a floor of 30 across 8 campaigns is 5,760 potential groups before a
 * fourth is even considered. Against that, every screen in scope needs at most two
 * — `agent`+`campaign` for contribution, `day_of_week`+`hour_of_day` for best
 * hours, `agent`+`day` for a trend. A third dimension is unbounded cost for no
 * named screen.
 */
export const GROUP_MAX_DIMENSIONS = 2;

/**
 * `key` ascending — and unlike the roster's `successes desc`, this default is
 * about READABILITY rather than about the opening question.
 *
 * A grouped read is most often a series (`hour_of_day`) or a matrix
 * (`agent`×`campaign`), and key order is the only order in which either reads
 * correctly: an hour-of-day series sorted by `successes` is not a series, it is a
 * league table whose x-axis has been shuffled. A metric sort is for the
 * contribution question, which the caller asks for explicitly.
 */
export const GROUP_DEFAULT_SORT: AgencyGroupSort = 'key';
export const GROUP_DEFAULT_ORDER = 'asc' as const;

/**
 * Page size. **Both bounds refuse rather than clamp**, same rule and same reason
 * as {@link ROSTER_MAX_LIMIT}.
 *
 * Higher than the roster's 200 because the row count here is a product rather
 * than a headcount: a `day`×`agent` matrix over a month on a floor of 30 is ~900
 * legitimate groups, and a ceiling below that would make a real screen
 * unrenderable. Still a ceiling, because `limit` is the ONLY bound on the response
 * size this read has — there is no cursor, and the window cap bounds cost rather
 * than cardinality.
 */
export const GROUP_DEFAULT_LIMIT = 200;
export const GROUP_MAX_LIMIT = 1000;

/**
 * Which dimensions are cut in a TIMEZONE, as the inverted `Record` rather than a
 * `['day', 'day_of_week', 'hour_of_day']` array.
 *
 * The same argument as every other vocabulary here, and it bites hardest on this
 * one: a seventh dimension added to {@link AgencyGroupDimension} is a missing
 * required key, i.e. a build error that forces a decision about whether it needs a
 * zone. An array would compile, and a new time dimension would then skip the
 * ambiguity refusal below entirely and silently bucket across zones — which is the
 * exact failure that refusal exists to prevent.
 */
const GROUP_DIMENSION_NEEDS_ZONE: Record<AgencyGroupDimension, boolean> = {
  agent: false, campaign: false, disposition: false,
  day: true, day_of_week: true, hour_of_day: true,
};

/**
 * Whether a grouping is cut in a timezone at all — the ONE `some` that both the zone rule's
 * refusal and `AgencyGroupPage.resolved_timezone` read.
 *
 * Shared rather than spelled at each site because the two rules have to agree: if
 * the refusal quantified over `some` while the zone field decided on `every`, a
 * page could be bucketed in a zone it then declined to name, or name a zone it
 * never cut anything in. One function over {@link GROUP_DIMENSION_NEEDS_ZONE}
 * makes that agreement structural instead of a claim two conditions keep making
 * separately — and a seventh dimension is still a missing required key on the
 * record, i.e. a build error that forces the decision.
 *
 * `some`, not `every`, and the two differ on exactly one shape: a pair holding one
 * zoned dimension beside a non-zoned one (`agent,day`). That page IS cut in a zone
 * — the zoned half needs one — so `every` would wave it through the refusal AND
 * report no zone for it. `agent-record.test.ts` asserts both halves.
 */
export function groupByIsZoned(groupBy: readonly AgencyGroupDimension[]): boolean {
  return groupBy.some((dimension) => GROUP_DIMENSION_NEEDS_ZONE[dimension]);
}

/**
 * The refusals this route answers with a `code`, beyond the generic validation
 * 400.
 *
 * Both are cases where the request is well-formed — every value is in its
 * vocabulary — and still cannot be answered, so a client needs to tell them apart
 * from a typo without parsing prose. `details` still carries the human message.
 */
export type AgencyGroupRefusal = 'too_many_dimensions' | 'timezone_ambiguous';

/** A {@link FilterIssue} that may carry one of those codes. */
export interface AgencyGroupIssue extends FilterIssue {
  code?: AgencyGroupRefusal;
}

export type AgencyGroupParse =
  | { ok: true; filters: AgentGroupedParams }
  | { ok: false; issues: AgencyGroupIssue[] };

/** The window, filters, grouping and ranking one grouped read runs over. */
export interface AgentGroupedParams {
  /** Inclusive lower bound on `dialed_at`. */
  from: Date;
  /** EXCLUSIVE upper bound, same half-open window as {@link AgentRosterParams}. */
  to: Date;
  /** Narrow every row to one campaign; also one of the two zone-rule remedies. */
  campaignId?: string;
  /**
   * 1..{@link GROUP_MAX_DIMENSIONS} dimensions, deduplicated and in the CANONICAL
   * order of {@link AGENCY_GROUP_DIMENSIONS} — never the order the request used.
   */
  groupBy: AgencyGroupDimension[];
  sort: AgencyGroupSort;
  order: 'asc' | 'desc';
  limit: number;
}

/**
 * Whether a grouped read has ONE zone for the WHOLE page — the predicate behind
 * `AgencyGroupPage.resolved_timezone`.
 *
 * True iff a zoned dimension is grouped AND the read is filtered to one campaign.
 * **Both halves, and the second is the one that is easy to lose.** The zone rule accepts a
 * time dimension on EITHER of two remedies and only one of them narrows the read
 * to a single zone: `group_by=campaign,hour_of_day` with no `campaign_id` is a
 * legal 200 spanning every campaign in the account — that remedy is the one the zone rule's
 * refusal message names FIRST, `campaign` plus one time dimension fits
 * {@link GROUP_MAX_DIMENSIONS} exactly, and each row is correctly cut in its own
 * campaign's zone. `agency_campaigns.default_timezone` is per campaign
 * (`VARCHAR(64) NOT NULL DEFAULT 'UTC'`) with no account-level
 * uniqueness, so those zones genuinely differ. N zones, no page-level label,
 * `null`.
 *
 * Dropping the `campaignId` half therefore does not merely widen the field: it
 * makes the page name ONE of several zones as though the whole matrix were cut in
 * it, which is the confidently-wrong hour axis the field exists to prevent.
 *
 * "Exactly one campaign" reduces to "a `campaign_id` is present" because the
 * house-wide `singleParam` takes `raw[0]`, so this surface accepts at most one.
 *
 * Pure, and here rather than in the repository, for this section's stated reason:
 * which questions this read can answer is a product rule, so it has to be
 * exercisable without a pool and without a Fastify instance.
 */
export function groupedPageHasSingleZone(
  p: Pick<AgentGroupedParams, 'groupBy' | 'campaignId'>,
): boolean {
  return p.campaignId !== undefined && groupByIsZoned(p.groupBy);
}

/**
 * `?from=&to=&campaign_id=&group_by=&sort=&order=&limit=` → {@link AgentGroupedParams}.
 *
 * ── The window rules and the CAP are both imported ──────────────────────────
 *
 * Required, half-open, `parseFilterDate`, and capped at
 * {@link ROSTER_MAX_WINDOW_DAYS} — the roster's own constant, deliberately reused
 * rather than a second 92 declared here. The cost argument is the same one, and
 * stronger: this read has no `LIMIT`-free requirement so the page IS bounded, but
 * the SCAN is not — the window is still the only thing bounding how many attempt
 * rows are aggregated, and the server sets no `statement_timeout` anywhere. Two caps
 * holding the same value would be two things to change and one of them would be
 * missed.
 *
 * ── `group_by` is REQUIRED, and 1 or 2 entries ───────────────────────────────
 *
 * Not defaulted. A grouped read with no grouping is the roster (by agent) or a
 * single-row total, and both of those already have routes; defaulting would make
 * the same URL mean a different question depending on which build answered it.
 *
 * The COMMA form is the request form: `?group_by=agent,campaign`. The REPEATED
 * form (`?group_by=agent&group_by=campaign`) arrives as an array and
 * {@link singleParam} takes `raw[0]`, so the second value is dropped before it is
 * seen — house-wide behaviour on every single-valued param on this surface, not
 * something introduced here, and not reachable from the browser because the public
 * API layer's `forwardAllowedQuery` comma-JOINS a repeated param into exactly the
 * form above. The applied `group_by` is echoed on the response either way, so a
 * direct caller of the internal handler can always see what it got.
 *
 * A duplicate (`agent,agent`) refuses rather than deduplicating silently: it
 * halves the dimensionality of the answer, and a caller who wrote it meant
 * something else.
 *
 * ── A TIME DIMENSION NEEDS AN UNAMBIGUOUS ZONE, OR THE READ IS REFUSED ───────
 *
 * This is the rule most likely to be read as over-strict, so it is derived here
 * rather than asserted. Buckets are cut in the CAMPAIGN's own `default_timezone`
 * (see `AgencyAgentStatsRepository.attemptBuckets` for the resolution apparatus
 * and for why the `pg_timezone_names` LEFT JOIN is load-bearing). So when a time
 * dimension is grouped across campaigns in different zones, "the 18:00 row" is not
 * one thing — it is several local 18:00s summed into one number that describes no
 * hour anywhere.
 *
 * The zone is unambiguous when EITHER `campaign` is also grouped (each row then
 * carries its own campaign's zone, and every attempt still lands in exactly one
 * bucket) OR exactly one `campaign_id` is filtered (one zone for the whole read).
 * Otherwise this refuses with `timezone_ambiguous`, naming BOTH remedies — a
 * refusal that names one remedy trains a caller to always use that one.
 *
 * **There is deliberately no implicit UTC fallback and no `tz` parameter here.** A
 * silent UTC bucketing of an account whose campaigns run in `Asia/Kolkata` puts the
 * real 18:00 connect peak in the 12:00 column, and the only visible symptom is a
 * rostering decision that is quietly wrong — which is the exact failure a
 * best-hours screen exists to prevent. Neither named consumer screen is affected:
 * best hours is per campaign, and contribution groups by campaign. A `tz` parameter
 * stays additive for later; adding surface now, for no named screen, buys a second
 * behaviour to keep correct.
 *
 * ── `sort`/`order`/`limit`, same rules as the roster ────────────────────────
 *
 * Defaulted when absent (both are echoed, so a caller can always tell what they
 * got) and REFUSED when unknown (a client holding a stale vocabulary must be told,
 * not handed a differently-ordered page that looks like an answer). `limit`
 * refuses outside 1..{@link GROUP_MAX_LIMIT} rather than clamping, because this
 * list has no cursor and a silently changed limit changes WHICH groups are on the
 * page.
 */
export function parseGroupedStatsQuery(query: Record<string, unknown>): AgencyGroupParse {
  const issues: AgencyGroupIssue[] = [];

  const fromRaw = singleParam(query['from']);
  const toRaw = singleParam(query['to']);
  if (fromRaw === undefined) issues.push({ param: 'from', message: 'is required' });
  if (toRaw === undefined) issues.push({ param: 'to', message: 'is required' });
  const from = parseFilterDate('from', fromRaw, issues);
  const to = parseFilterDate('to', toRaw, issues);

  // Refused rather than silently emptied, and capped on the ROSTER's constant —
  // see the docstring for why that is a reuse and not a coincidence.
  if (from && to && from.getTime() >= to.getTime()) {
    issues.push({ param: 'from', message: '`from` must be earlier than `to` (the window is half-open)' });
  } else if (from && to && to.getTime() - from.getTime() > ROSTER_MAX_WINDOW_DAYS * MS_PER_DAY) {
    issues.push({
      param: 'from',
      message: `the window must be at most ${ROSTER_MAX_WINDOW_DAYS} days — request a narrower range`,
    });
  }

  // Shape-checked before it can reach a `::uuid` cast, which answers `22P02` and
  // surfaces as a 500 carrying the database's error text.
  const campaignId = singleParam(query['campaign_id']);
  if (campaignId !== undefined && !UUID_RE.test(campaignId)) {
    issues.push({ param: 'campaign_id', message: 'must be a campaign id' });
  }

  const groupBy = parseGroupBy(singleParam(query['group_by']), issues);

  // The zone-rule refusal. Checked only once `group_by` itself parsed: reporting an
  // ambiguous zone for a dimension the caller misspelled would name the wrong
  // problem, and the misspelling is already an issue on the list.
  if (groupBy.length > 0
    && groupByIsZoned(groupBy)
    && !groupBy.includes('campaign')
    && campaignId === undefined) {
    issues.push({
      param: 'group_by',
      code: 'timezone_ambiguous',
      message: 'a time dimension (day, day_of_week, hour_of_day) is cut in the campaign\'s own '
        + 'timezone, so it is only unambiguous when campaigns are separated: either add '
        + '`campaign` to `group_by`, or filter to exactly one `campaign_id`',
    });
  }

  const sort = singleEnum('sort', singleParam(query['sort']), GROUP_SORTS, issues);
  const order = singleEnum('order', singleParam(query['order']), ROSTER_ORDERS, issues);

  // Parsed through the raw string rather than `Number()` alone, for the reasons
  // `parseRosterQuery` states: `Number('1.5')` is finite and would floor to 1, and
  // `Number('')` is 0 — so a cleared form field would refuse naming a bound the
  // caller never typed.
  const limitRaw = singleParam(query['limit']);
  let limit = GROUP_DEFAULT_LIMIT;
  if (limitRaw !== undefined) {
    const parsed = Number(limitRaw);
    if (!/^\d+$/.test(limitRaw) || !Number.isSafeInteger(parsed)
      || parsed < 1 || parsed > GROUP_MAX_LIMIT) {
      issues.push({
        param: 'limit',
        message: `must be a whole number between 1 and ${GROUP_MAX_LIMIT}`,
      });
    } else {
      limit = parsed;
    }
  }

  if (issues.length > 0 || !from || !to || groupBy.length === 0) {
    // The three guards after the length check cannot be reached with an empty issue
    // list — all three are required above — but the compiler cannot see that, and
    // returning `ok: true` with a fabricated window or an empty grouping would be
    // the worse way to satisfy it.
    return {
      ok: false,
      issues: issues.length > 0 ? issues : [{ param: 'from', message: 'is required' }],
    };
  }

  return {
    ok: true,
    filters: {
      from,
      to,
      ...(campaignId ? { campaignId } : {}),
      groupBy,
      sort: sort ?? GROUP_DEFAULT_SORT,
      order: order ?? GROUP_DEFAULT_ORDER,
      limit,
    },
  };
}

/**
 * `group_by` → the canonical, deduplicated dimension list, or `[]` plus issues.
 *
 * Split out so the three separate refusals — too many, unknown, repeated — are
 * readable as three rules rather than as one nested condition, and so the
 * canonicalisation happens in exactly one place.
 *
 * The count is checked BEFORE the vocabulary: `?group_by=a,b,c,d` with four typos
 * should be told it asked for too many dimensions, not handed four unknown-value
 * messages that all become moot once it drops two of them.
 */
function parseGroupBy(raw: string | undefined, issues: AgencyGroupIssue[]): AgencyGroupDimension[] {
  if (raw === undefined) {
    issues.push({
      param: 'group_by',
      message: `is required — expected one or two of ${AGENCY_GROUP_DIMENSIONS.join(', ')}`,
    });
    return [];
  }

  // Blank entries dropped rather than refused: `?group_by=agent,` is what string
  // concatenation in a client produces, and it plainly means one dimension.
  // `singleParam` has already turned an entirely blank value into `undefined`.
  const entries = raw.split(',').map((entry) => entry.trim()).filter((entry) => entry.length > 0);
  if (entries.length === 0) {
    issues.push({
      param: 'group_by',
      message: `is required — expected one or two of ${AGENCY_GROUP_DIMENSIONS.join(', ')}`,
    });
    return [];
  }
  if (entries.length > GROUP_MAX_DIMENSIONS) {
    issues.push({
      param: 'group_by',
      code: 'too_many_dimensions',
      message: `at most ${GROUP_MAX_DIMENSIONS} dimensions — the row count is the product of `
        + `their cardinalities, so a third makes the response unbounded; got ${entries.length}`,
    });
    return [];
  }

  const validated = validateEnum<AgencyGroupDimension>(
    'group_by', entries, AGENCY_GROUP_DIMENSIONS, issues,
  );
  if (!validated) return [];

  const unique = new Set(validated);
  if (unique.size !== validated.length) {
    // Refused rather than deduplicated: grouping by one dimension twice halves the
    // dimensionality of the answer, so a caller who wrote it meant something else
    // and silently answering the narrower question is the worse outcome.
    issues.push({ param: 'group_by', message: 'must not repeat a dimension' });
    return [];
  }

  // CANONICALISED here and nowhere else. Filtering the vocabulary rather than
  // sorting the input is what makes "canonical order" mean the declaration order
  // by construction instead of by a comparator that could disagree with it.
  return AGENCY_GROUP_DIMENSIONS.filter((dimension) => unique.has(dimension));
}
