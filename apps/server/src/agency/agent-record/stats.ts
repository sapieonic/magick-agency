/**
 * The agent's own record (`GET /api/v1/agency-agents/:agentUserId/stats` and its
 * attempts list): the bucket vocabulary, the query parsing, the bucket SQL and the
 * occupancy fold. Split out of `agent-record.ts`, which re-exports
 * everything here — import from that path.
 */
import type {
  AgencyAgentState,
  AgencyAgentOccupancy,
  AgencyStatsBucketUnit,
} from '@magick-agency/contracts/agency';
import {
  parseAttemptFilters,
  parseCampaignIdParam,
  parseRequiredWindow,
  singleEnum,
  singleParam,
  validateEnum,
  vocabulary,
  type AgencyAttemptFilters,
  type FilterIssue,
  type FilterParse,
} from '../spine-filters.js';

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

  // Refused rather than silently emptied, exactly as `checkRange` does on the
  // spine: `from >= to` matches nothing, and "nothing" on a record page reads as
  // a fact about the agent rather than about the request. Equality is refused too
  // — a half-open window of zero width has no buckets and no honest answer.
  const { from, to } = parseRequiredWindow(query, AGENT_STATS_MAX_WINDOW_DAYS, issues);

  // Defaulted rather than required: `day` is what a record page opens on, and
  // unlike the window there is no way to be wrong about which grouping you got
  // (it is echoed on the response).
  //
  // An unknown one echoes the valid set (`validateEnum`'s message), the way the
  // break route's `unknown_break_reason` does: a client holding a stale vocabulary
  // recovers in one round trip instead of guessing.
  const bucket: AgencyStatsBucketUnit =
    singleEnum('bucket', singleParam(query['bucket']), AGENT_STATS_BUCKETS, issues) ?? 'day';

  // Same guard, same reason, as the spine's `?contact_id=`.
  const campaignId = parseCampaignIdParam(query, issues);

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

  const campaignId = parseCampaignIdParam(query, issues);
  if (issues.length > 0 || !parsed.ok) {
    return { ok: false, issues: issues.length > 0 ? issues : [{ param: 'campaign_id', message: 'must be a campaign id' }] };
  }

  return {
    ok: true,
    filters: { ...parsed.filters, ...(campaignId ? { campaignId } : {}) },
  };
}
