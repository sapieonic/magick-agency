/**
 * Per-AGENT numbers — the shapes the public API layer serves under `/proxy/agency/my-*` and
 * `/proxy/agency/agents/:userId/*`.
 *
 * ── Why these are not `AgencyCampaignStats` ─────────────────────────────────
 * `agency-campaign.ts` carries the SUPERVISOR payload: one campaign, every agent
 * on it, aggregated. Everything here is one PERSON across every campaign they
 * worked, bucketed over time. The two answer different questions and share no
 * field with the same meaning — `attempts_total` on a campaign counts dials the
 * pacing engine placed, `attempts` here counts dials that reached this agent —
 * so folding them into one type would produce a shape where half the fields are
 * always absent and the reader has to know which half.
 *
 * ── Two routes, one shape, and that is load-bearing ────────────────────────
 * `GET /agency/my-stats` (floored so a bare `agent` can call it, scoped
 * server-side to the caller) and `GET /agency/agents/:userId/stats` (the
 * supervisor twin, floored at `agency.supervise`) return the SAME body. So one
 * type serves both, and the panel that renders it cannot drift between the agent
 * looking at their own shift and the supervisor looking at theirs. The scoping
 * difference is entirely the public API layer's: this client never sends an agent id on the
 * `my-` routes, because a client that could name the subject of its own stats
 * read is a client that can ask for somebody else's.
 *
 * ── The rule that governs every field below ────────────────────────────────
 * **A `null` rate means NOT MEASURED YET. It never means zero.** This repo
 * already learned that from `abandonment_rate_24h_pct`: *"a health strip with no
 * diagnosis reads as nothing wrong when the truth is nothing measured"*. The same
 * sentence applies with more force here, because these numbers are read by the
 * person being measured — an agent shown `0.0%` conversion on their first
 * morning has been told they failed at something they have not yet done.
 *
 * `undefined` is the third state and is a different fact again: the payload did
 * not carry the field, so the answer is "didn't load", not "nothing to measure".
 * The rate fields are declared `number | null` because the contract promises
 * them; the pure helpers in `utils/agencyAgentPerformance.ts` nevertheless accept
 * `undefined` and render it as its own state, so a server mid-deploy degrades a
 * figure rather than crashing a render.
 */

/*
  `by_state` reuses the supervisor floor's own record type rather than
  re-declaring the six states. The dialer runtime seeds every state with a zero on both
  payloads, so the shape is genuinely the same one — and a second copy of an
  agent-state union is exactly the drift `AgencyAgentLiveState`'s own comment
  exists to prevent.
*/
import type { AgencyAgentsByState } from './agency-campaign';

/** Bucket width. `day` is the only one this console asks for — see below. */
export type AgencyStatsBucketWidth = 'day' | 'week' | 'month';

/**
 * Where an agent's shift went, in seconds per state.
 *
 * ── Absent, all-zero, and measured are THREE different things ───────────────
 * The dialer runtime computes this from its agent-state event log, which shipped after the
 * dialer did. A session that predates the log has no events, so the public API layer answers
 * with **zeros rather than nulls** — and a zeroed breakdown rendered as a chart
 * is a confident claim that an agent spent a shift doing nothing at all.
 *
 * That is the null-not-zero rule wearing a different costume, and it is why
 * `occupancyBreakdown` treats "every state is zero" as unmeasured rather than
 * trusting the shape. See its docstring for why the check is on the sum and not
 * on `shift_seconds` alone.
 */
export interface AgencyOccupancy {
  /**
   * The whole measured shift in seconds — the denominator, and it **excludes
   * `offline`**.
   *
   * The dialer runtime's rule, not a reading of it: `foldOccupancy` adds every state to
   * `by_state` and every state but `offline` to this total, because an agent who
   * logged out at 17:00 was not on shift at 18:00 and folding that in would make
   * every short shift look unoccupied. `offline` stays on the payload because
   * "logged out" and "no data" are different facts.
   *
   * So a breakdown of the shift is a breakdown of the OTHER five states.
   * `occupancyBreakdown` sums exactly those; summing all six would produce
   * shares diluted by signed-out time and a remainder that could never be
   * positive.
   *
   * Not necessarily equal to that sum either: the dialer runtime's event log can have gaps (a
   * browser closed mid-state, a session the reaper closed), so the states can
   * sum to less. The breakdown therefore renders shares of the **sum it can
   * see** and names the remainder rather than silently inflating a percentage.
   */
  shift_seconds: number;
  by_state: AgencyAgentsByState;
}

/**
 * One agent's figures over a range.
 *
 * `campaigns` is a COUNT of campaigns worked in the range, not a list — the list
 * is {@link AgencyAgentStats.by_campaign}, and duplicating it as a length would
 * give the screen two sources for one fact.
 */
export interface AgencyAgentStatsTotals {
  /** Dials that reached this agent. */
  attempts: number;
  /** Of those, the ones where a person was on the line. Always shown BESIDE
   *  {@link attempts} — see `AgentPerformancePanel` for why the two are never
   *  collapsed into one "calls" number. */
  connected: number;
  /** `connected / attempts`. `null` before the first dial — never `0`. */
  connect_rate_pct: number | null;
  /** Connected calls written up with a disposition the campaign counts as a win. */
  successes: number;
  /**
   * `successes / connected` — measured against CONNECTED calls, **not dials**.
   *
   * The denominator is the whole meaning of the number and the two readings are
   * far apart: 20% of conversations is a good day, 20% of dials is a fantasy. So
   * every label this reaches says which one it is. `null` before the first
   * connect.
   */
  success_rate_pct: number | null;
  talk_seconds: number;
  wrapup_seconds: number;
  /** Average handle time. `null` when no call has finished — never `0`. */
  aht_seconds: number | null;
  /** How many distinct campaigns this agent worked in the range. */
  campaigns: number;
  /** Absent on a public API layer that predates the event log; see {@link AgencyOccupancy}. */
  occupancy?: AgencyOccupancy | null;
}

/**
 * One bucket of the series.
 *
 * ── `bucket_start` is cut in each CAMPAIGN'S timezone, not the reader's ─────
 * The dialer runtime buckets an attempt by the campaign's own timezone, because that is the
 * timezone the campaign's calling window is enforced in. Every attempt lands in
 * exactly one bucket, so the buckets still sum to the totals exactly — but for
 * an agent working campaigns in two timezones a "day" is not one contiguous
 * 24-hour window.
 *
 * That is a real property of the data and not a rounding error, so the chart
 * **says so in words** (`BUCKET_TIMEZONE_NOTE`). It is the kind of thing a
 * reader otherwise files as a bug in the totals.
 */
export interface AgencyAgentStatsBucket {
  /**
   * `YYYY-MM-DD` — a calendar DAY, not an ISO-8601 instant.
   *
   * It carries no time and no offset, and that is deliberate on the dialer runtime's side
   * rather than an omission: the label is formatted in SQL (`bucketStartSql`)
   * precisely so no zone attaches to it, because node-pg parses a bare
   * `timestamp` into a LOCAL-time `Date` and would put the server's zone back on
   * a value the query went to some trouble to remove. For a `week` bucket it is
   * the Monday, for `month` the 1st.
   *
   * **Never hand it to `new Date()` directly.** A date-only string is the one
   * literal JS parses as UTC midnight, and every reader of the result works in
   * local time — which rendered every label a day early everywhere west of
   * Greenwich. `bucketSeries` parses the components onto the reader's own
   * calendar; see `bucketDay` in `utils/agencyAgentPerformance.ts`.
   */
  bucket_start: string;
  attempts: number;
  connected: number;
  successes: number;
  talk_seconds: number;
  wrapup_seconds: number;
  occupancy?: AgencyOccupancy | null;
}

/**
 * One campaign's slice of the range.
 *
 * **There is no `campaign_name` here, and that is the public API layer's contract rather than
 * an omission to work around.** The name has to be resolved by the caller from a
 * list it already holds — `GET /agency/my-campaigns` for an agent, the campaign
 * list for a supervisor — and an id with no match renders as an id, never as a
 * blank row. Inventing a fallback name would be a client asserting a fact the
 * server declined to.
 */
export interface AgencyAgentStatsByCampaign {
  campaign_id: string;
  attempts: number;
  connected: number;
  successes: number;
  talk_seconds: number;
  wrapup_seconds: number;
}

/** `GET /agency/my-stats` and `GET /agency/agents/:userId/stats`. */
export interface AgencyAgentStats {
  agent_user_id: string;
  bucket: AgencyStatsBucketWidth;
  /** The range actually served, echoed back. */
  from: string;
  to: string;
  totals: AgencyAgentStatsTotals;
  /**
   * The series, oldest first.
   *
   * `[]` is a real answer — "nothing happened in this range" — and is a
   * different screen from a failed read. A range with a single bucket is also
   * ordinary (a one-day range), and the chart declines to draw itself rather
   * than rendering a one-column bar chart, which is a stat tile wearing axes.
   */
  buckets: AgencyAgentStatsBucket[];
  by_campaign: AgencyAgentStatsByCampaign[];
}

/**
 * `GET /agency/my-campaigns` — the agent's full staffing history, **including
 * assignments that have ended**.
 *
 * ── Why this is not `GET /agency/my-assignments` ────────────────────────────
 * That route answers "where may I go right now", and it is right that it hides
 * an ended assignment: a campaign an agent was taken off is not a station they
 * can enter, and offering it would be an affordance that 403s. This one answers
 * "what have I worked", which is the question the numbers on the performance
 * page raise — a per-campaign breakdown naming a campaign the agent is no longer
 * staffed on is otherwise a row with no explanation.
 *
 * So the two coexist deliberately and neither is a superset of the other in the
 * sense that matters: `my-assignments` is the entry list, this is the history.
 */
export interface AgencyStaffingHistoryEntry {
  campaign_id: string;
  /**
   * Nullable for the same reason it is on `AgencyMyAssignment`: the public API layer resolves
   * it through a best-effort call to the dialer runtime, which can be down or can have deleted
   * the campaign. Rendered through a stand-in, never as an empty cell.
   */
  campaign_name: string | null;
  /**
   * The dialer runtime's lifecycle value, forwarded unchanged by the public API layer.
   *
   * **A status this build does not recognise must still render.** That is what
   * lets the dialer runtime add a lifecycle state without this client mirroring it, and
   * `AgencyCampaignStatusBadge` deliberately prints an unknown status as-is —
   * keep that property when rendering these rows.
   */
  campaign_status: string | null;
  assigned_at: string;
  /** `null` while the assignment is current. */
  unassigned_at: string | null;
  /**
   * The public API layer's own answer to "is this assignment current".
   *
   * Read this rather than re-deriving it from `unassigned_at === null`: the public API layer
   * owns the staffing table and can end an assignment in ways this client has no
   * business modelling, and two sources for one boolean is two answers.
   */
  active: boolean;
}

/**
 * `GET /proxy/agency/my-campaigns` — the response body.
 *
 * **The key is `assignments`, not `campaigns`.** An earlier revision of this file
 * called it `campaigns`, which type-checked perfectly and failed silently at
 * runtime: the public API layer sends `{ assignments: [...] }`, so the reader below found
 * `undefined`, fell through to `?? []`, and every agent's staffing history
 * rendered as "you have never been staffed on anything" — no error, no empty
 * state distinguishable from the real one, nothing in the console.
 *
 * The name is the public API layer's to choose and it already chose: the sibling route
 * `/my-assignments` on this same prefix returns `{ assignments }`, and
 * `AgencyMyAssignments` in `agency-campaign.ts` mirrors it. A second noun for the
 * same concept on one prefix is how the next reader gets this wrong again.
 *
 * The rows ARE campaigns, which is what made `campaigns` a tempting name. They
 * are campaigns the agent was *assigned to*, and the assignment — with its
 * `assigned_at`, `unassigned_at` and `active` — is the subject of every row.
 */
export interface AgencyStaffingHistory {
  assignments: AgencyStaffingHistoryEntry[];
}

// ─── The ROSTER read ─────────────────────────────────────────────────────────
//
// Everything above is ONE PERSON over a range. What follows is the whole floor
// over a range: `GET /proxy/agency/agents/stats`, the public API layer's proxy of the dialer runtime's
// `GET /api/v1/agency-agents/stats`.
//
// ── Why the roster is not a list of the shapes above ────────────────────────
// A roster row is deliberately NOT `AgencyAgentStats`. That shape carries
// `buckets[]` and `by_campaign[]` — two foldings of one person's row set — and a
// roster of a hundred agents each carrying two nested tables is a payload nobody
// can render and a query nobody can afford. A roster row is one LINE: the totals,
// flattened, plus the two things a line needs that a per-agent read does not —
// whether its rates may be quoted at all, and what the rest of the floor did.
//
// ── The roster contract, and the one place the console's copy differs ───────────
// These match the frozen contract in `../../agency` field for field. The
// difference is the public API layer's, and it is additive in exactly two places: `agent_name`
// on every row (the dialer runtime has no user table — decision D3 — and can only ever serve a
// uuid), and `inactive_omitted` at the top level (the dialer runtime cannot know who is still a
// member). So {@link AgencyRosterAgentRow} is the dialer runtime's row unchanged,
// {@link AgencyRosterAgentRowWithName} is what reaches a browser, and
// {@link AgencyRosterPage} is the public API layer's envelope — which is the only one this
// client can ever receive, because the console never reaches the dialer runtime.

/**
 * Minimum denominator before a rate is REPORTABLE.
 *
 * ── Mirrored, and deliberately almost never read here ───────────────────────
 * The server decides. Every row carries {@link AgencyRosterAgentRow.rates_reportable},
 * and the whole reason that flag exists is so one threshold is applied in one
 * place rather than three consumers each re-deriving it from a constant they
 * happen to hold. A client that compared `attempts` to this number would be a
 * second answer to "may this rate be quoted", and the two would disagree the
 * moment the dialer runtime tuned the threshold or changed which denominator it counts.
 *
 * It is mirrored anyway because the console has to SAY the threshold out loud —
 * "fewer than 20 calls" in a footnote is a sentence, and a sentence built from a
 * magic number in a component is the one that goes stale silently. Read it to
 * explain the flag; never to compute it.
 */
export const AGENCY_ROSTER_MIN_RATE_DENOMINATOR = 20;

/**
 * What the roster may be ordered by — server-side, always.
 *
 * Sorting is a request parameter rather than a client-side array sort, and that
 * is not a performance choice: `limit` truncates the roster to the top N *of the
 * chosen order*, so re-sorting the returned rows locally would re-rank a page
 * that was already selected by a different question. "Slowest handle time" over
 * the hundred agents with the most successes is not the answer to "slowest handle
 * time".
 *
 * Nulls sort LAST in both directions on the four nullable metrics — the dialer runtime's rule,
 * stated here because it is the thing a reader assumes wrongly: a row with no
 * measurable rate is not the best row and it is not the worst row, it is not
 * ranked. `agent_user_id` is the tiebreaker on every sort, so repeated reads and
 * paging are deterministic.
 */
export type AgencyRosterSort =
  | 'attempts'
  | 'connected'
  | 'connect_rate_pct'
  | 'successes'
  | 'success_rate_pct'
  | 'aht_seconds'
  | 'talk_seconds'
  | 'occupancy_pct'
  | 'agent_user_id';

/** Sort direction. `desc` is the default, because the roster's default sort is a ranking. */
export type AgencyRosterOrder = 'asc' | 'desc';

/**
 * One agent's line on the roster — the dialer runtime's row, unchanged.
 *
 * The null-not-zero rule that governs this whole file governs every rate here,
 * and it bites hardest on a roster: a table is scanned rather than read, so a
 * `0%` in a column of real percentages is indistinguishable from a bad shift.
 */
export interface AgencyRosterAgentRow {
  /** The public API layer's user id. Opaque to the dialer runtime (D3) and opaque to this client. */
  agent_user_id: string;
  attempts: number;
  connected: number;
  successes: number;
  talk_seconds: number;
  wrapup_seconds: number;

  /** `null` on a zero denominator — nothing dialled is NOT a 0% connect rate. */
  connect_rate_pct: number | null;
  /** Denominator is `connected`, **not `attempts`** — see {@link AgencyAgentStatsTotals.success_rate_pct}. */
  success_rate_pct: number | null;
  /** `(talk + wrapup) / connected`. Same definition as {@link AgencyAgentStatsTotals.aht_seconds}. */
  aht_seconds: number | null;

  /** Distinct campaigns this agent dialled inside the window. A count, not a list. */
  campaigns: number;

  /**
   * The measured shift in seconds — the sum of `by_state` EXCLUDING `offline`,
   * exactly {@link AgencyOccupancy.shift_seconds}'s definition. `0` when
   * occupancy is unmeasured, which is why {@link occupancy_pct} is the field to
   * read for "is this measurable at all".
   */
  shift_seconds: number;
  /** Break seconds, carried so the OTHER occupancy reading stays derivable. */
  break_seconds: number;
  /**
   * `(talk + wrapup) / shift_seconds`, as a percentage.
   *
   * This route PICKS a denominator where {@link AgencyOccupancy} deliberately
   * does not, because a roster column has to be one number. Break time is
   * INCLUDED in the denominator; `shift_seconds - break_seconds` gives the
   * stricter reading and both parts are on this row so it stays computable
   * without a second request.
   *
   * `null` — never `0` — when `shift_seconds` is 0, which is also what an
   * unmeasured occupancy read produces. Zero and unmeasured are indistinguishable
   * here for the same reason they are on {@link AgencyOccupancy}: the dialer runtime's
   * agent-state event log shipped after the dialer, so a session that predates it
   * has no events rather than zeroed ones.
   */
  occupancy_pct: number | null;

  /** Most recent dial inside the window, ISO instant. `null` if none. */
  last_dialed_at: string | null;

  /**
   * True when this row's rates cleared {@link AGENCY_ROSTER_MIN_RATE_DENOMINATOR}
   * and therefore contributed to {@link AgencyRosterBenchmark}'s percentiles.
   *
   * **The rates are STILL SERVED when this is false.** The caller gets the number
   * and the denominator and decides. What the flag exists for is so every
   * consumer applies ONE threshold rather than three — and so a console can
   * render "not enough calls" instead of a flattering number computed from eleven
   * of them.
   *
   * This client honours that literally: a row with `rates_reportable: false`
   * renders words, not a greyed-out percentage. A number rendered faintly is
   * still a number, and it is the one a supervisor will read aloud.
   *
   * ⚠️ **It gates on ATTEMPTS, so it is the wrong flag for the conversion
   * rate.** See {@link success_rate_reportable}.
   */
  rates_reportable: boolean;

  /**
   * True when this row has enough CONNECTS for its conversion rate to be quoted
   * — `rates_reportable` AND `connected >= AGENCY_ROSTER_MIN_RATE_DENOMINATOR`,
   * which is also the predicate `benchmark.success_rate` and `benchmark.aht`
   * pool over.
   *
   * ── Why {@link rates_reportable} could not do this job ────────────────────
   * It counts DIALS, and the conversion rate divides by CONNECTS. So 20 dials
   * with 1 connect and 1 conversion is `rates_reportable: true` and rendered
   * `100%` — beside a named person, on a screen a supervisor acts on. The house
   * rule is "a rate below a **per-metric** minimum volume renders as words", and
   * one flag over the wrong denominator cannot express a per-metric minimum.
   *
   * It is strictly stronger than `rates_reportable` (`connected <= attempts`
   * always), which is why the conversion rate gates on this ALONE: a row this
   * flag admits is a row the other one admits too. The connect rate keeps
   * `rates_reportable`, whose denominator really is `attempts`.
   *
   * Optional, and an absent value falls back to {@link rates_reportable} rather
   * than to `true` — the console and server deploy independently, so this console can
   * meet a service that predates the field, and the honest fallback is exactly
   * the behaviour that shipped before it (withhold on the dial threshold),
   * never a *wider* set of quoted rates than console showed yesterday.
   */
  success_rate_reportable?: boolean;
}

/**
 * A roster row as it reaches a browser.
 *
 * The public API layer resolves the name on the proxy hop, exactly as it already does on
 * `/agents/:userId/stats` — **one query for the whole page, not one lookup per
 * row** — and a failed lookup yields `null` and a logged warning rather than a
 * 500. So `null` here means *unresolvable* (a deleted user, an id from outside
 * the tenant), never "no name": render it through `agentDisplayName`, which turns
 * it into a marked-as-an-id fallback rather than a blank cell.
 */
export interface AgencyRosterAgentRowWithName extends AgencyRosterAgentRow {
  agent_name: string | null;
}

/** p25 / median / p75 for one metric across the cohort. All `null` when nothing was rated. */
export interface AgencyRosterPercentiles {
  p25: number | null;
  median: number | null;
  p75: number | null;
}

/**
 * The cohort the rows were drawn from — what makes a single agent's number
 * READABLE rather than merely present.
 *
 * ── Which agents are in it ─────────────────────────────────────────────────
 * Every agent who dialled in the window and scope, INCLUDING one whose
 * membership was later revoked: the cohort is "the floor that week", and a
 * supervisor comparing against it wants the floor as it actually was. It is
 * deliberately NOT affected by `include_inactive`, which controls which ROWS come
 * back, not what they are measured against. A benchmark that moved when you
 * toggled a row filter would be a different number under the same name.
 *
 * ── Percentiles exclude thin rows ──────────────────────────────────────────
 * Only rows with `rates_reportable: true` contribute. A new joiner's 11-call rate
 * is noise and would drag the median. {@link agents_rated} is that count;
 * {@link agents} is the total. When `agents_rated` is 0 every percentile is null.
 *
 * ── Pooled rates are NOT the median, and both are here on purpose ──────────
 * {@link connect_rate_pct} is total connected over total attempts across the
 * whole cohort — the floor's actual rate. The median is in
 * `connect_rate.median`. They answer different questions ("how did the floor do"
 * versus "what does a typical agent do"), they differ most exactly when one agent
 * dialled most of the calls, and both are on the payload so neither has to be
 * recomputed — or confused for the other — by a consumer.
 */
export interface AgencyRosterBenchmark {
  agents: number;
  agents_rated: number;
  attempts: number;
  connected: number;
  successes: number;
  talk_seconds: number;
  wrapup_seconds: number;
  /**
   * The cohort's POOLED shift, and the break inside it — additive
   * rather than a change to the frozen shape.
   *
   * ── What it closes ────────────────────────────────────────────────────────
   * The benchmark carried the cohort's `talk_seconds` and `wrapup_seconds` and no
   * pooled denominator, so the floor's own utilisation was not derivable and the
   * team row had to show the cohort MEDIAN with a label saying so. With this
   * field the pooled rate is `(talk + wrapup) / shift_seconds` — the same
   * definition, the same break-inclusive denominator and the same agent set as
   * the pooled rates beside it, so the two cannot disagree.
   *
   * ── Deriving it from the ROWS was rejected and stays rejected ─────────────
   * `rows` is what `include_inactive` moves; the benchmark deliberately is not.
   * A team figure summed from the visible rows would therefore change when the
   * reader revealed former members — a different number under the same name,
   * which is exactly what this interface's own contract forbids. A test pins it
   * by comparing the whole team row's `textContent` across the toggle.
   *
   * ── Absence is a real arrival, and it must DEGRADE ────────────────────────
   * The console and server deploy independently, so this console normally deploys last
   * and the field is present. It is nevertheless read through a `typeof` guard —
   * exactly as {@link AgencyRosterPage.inactive_omitted} is — because a
   * hand-mirrored type is a claim about the wire and not proof of it, and a
   * the public API layer mid-deploy must cost the team row its pooled figure rather than the
   * whole roster section. See `teamUtilisation` in `utils/agencyAgentRoster.ts`,
   * which falls back to the median stand-in that preceded this field.
   *
   * **Declared OPTIONAL, and that is what makes the guard load-bearing.** Every
   * additive field on this payload is read through `typeof`, and every one of
   * them was declared required — so the guard's else branch narrowed to `never`
   * and nothing mechanical stopped a later editor "simplifying" it away, which
   * would flip the documented absent-field behaviour from *degrade* to *break*.
   * `?:` is what makes `tsc` hold the guard in place. This deliberately departs
   * from {@link AgencyRosterPage.inactive_omitted}, which is declared required
   * and guarded by hand: the guards are identical, and only these declarations
   * oblige them.
   */
  shift_seconds?: number;
  /** The cohort's break seconds — the row-level field's reason ("so the other reading stays derivable"), pooled. Optional for {@link shift_seconds}'s reason. */
  break_seconds?: number;
  connect_rate_pct: number | null;
  success_rate_pct: number | null;
  aht_seconds: number | null;
  connect_rate: AgencyRosterPercentiles;
  success_rate: AgencyRosterPercentiles;
  /**
   * Handling time's distribution — D10's second additive field.
   *
   * The benchmark had handle time only as the pooled scalar {@link aht_seconds},
   * so AHT was the one metric with a team figure and no band beside it: a
   * supervisor could read the floor's average handle time with nothing saying
   * whether four minutes is ordinary on this campaign.
   *
   * ── Which rows are in this pool, stated once and correctly ────────────────
   * `rates_reportable` **AND `connected >= 20`** AND a non-null `aht_seconds` —
   * D10's ruling, and the SAME predicate `success_rate`'s pool uses rather than
   * a restatement of it. `aht_seconds` divides by `connected`, which is exactly
   * the denominator that second floor exists to protect.
   *
   * An earlier version of this comment said "gated exactly as `success_rate`'s
   * pool is — `rates_reportable` and a non-null value", and those two clauses
   * disagree: the gloss after the dash is how `occupancy_pct`'s pool is gated,
   * and the two differ for every row with `1 <= connected < 20`. Reading it and
   * gating an AHT comparison on `rates_reportable` alone would flag a
   * 400-dial/3-connect row against a band it was excluded from — the identical
   * defect already fixed for conversion rate, in `rosterFlag`.
   *
   * So this payload's four percentile blocks describe up to **three**
   * populations: `connect_rate` and `occupancy_pct` over every reportable row,
   * `success_rate` and `aht` over the reportable rows that also cleared the
   * connect floor. See `bandReadout` in `utils/agencyAgentRoster.ts`, which
   * enumerates all four.
   *
   * **Seconds, not percentages.** Rendered through the duration formatter, never
   * `agentPct`: a band reading `median 74%` for a 74-second handle time is the
   * one mistake this field makes available.
   *
   * Optional for {@link shift_seconds}'s reason — the `typeof`-shaped guard in
   * `ahtBandReadout` is the behaviour, and `?:` is what keeps it.
   */
  aht?: AgencyRosterPercentiles;
  occupancy_pct: AgencyRosterPercentiles;
}

/**
 * `GET /proxy/agency/agents/stats` — the roster read's whole response.
 *
 * Every parameter the server actually applied is echoed back, and the console
 * reads the echo rather than its own request state: a `limit` clamped upstream or
 * a `sort` the server defaulted would otherwise be described to the reader
 * incorrectly by the very screen that was truncated.
 */
export interface AgencyRosterPage {
  from: string;
  to: string;
  /** `null` means every campaign in scope, not "no campaign". */
  campaign_id: string | null;
  sort: AgencyRosterSort;
  order: AgencyRosterOrder;
  limit: number;
  /**
   * Agents matching scope+window, counted by the dialer runtime **before** `limit` and before
   * the public API layer's departed-member filter. Also the population {@link benchmark} was
   * computed over.
   *
   * ── This is NOT the denominator of a "showing N of M" ──────────────────────
   * The two services apply their rules in an order that makes the fraction
   * uncomputable: the dialer runtime scopes, ranks and cuts to `limit`, and **the public API layer then filters
   * the page it was handed**, dropping departed members and reporting the count in
   * {@link inactive_omitted}. So `rows.length` is "the top `limit`, minus whichever
   * departed members happened to be inside it", and the public API layer never saw the agents
   * the dialer runtime cut.
   *
   * A default read can legitimately return 1 row with `total_agents: 3` and
   * `inactive_omitted: 1`. "Showing 1 of 3" is wrong; "showing 1 of 2" is not
   * derivable. The alternative — the public API layer shipping hundreds of agent ids to the dialer runtime on a
   * GET so the filter could run first — is not the trade made here.
   *
   * So the console states the three facts separately and never combines them. See
   * `truncationNote` and `rosterCountReadout` in `utils/agencyAgentRoster.ts`.
   */
  total_agents: number;
  rows: AgencyRosterAgentRowWithName[];
  benchmark: AgencyRosterBenchmark;
  /**
   * Rows the public API layer removed because the member is no longer active — `0` when
   * `include_inactive=true` was sent.
   *
   * The dialer runtime returns departed agents because it cannot know they departed (it has no
   * user table); the public API layer drops them. This count is what stops that from being a
   * silent edit: "2 former members hidden", with a way to see them, is honest,
   * and a roster that quietly omits the person a supervisor is looking for is
   * not.
   *
   * It does **not** affect {@link benchmark} or {@link total_agents} in either
   * state — the public API layer never recomputes them, so they are byte-identical whether or
   * not rows were dropped. A pinned team row that MOVED when the reader revealed
   * former members would be a bug: it would be a different number under the same
   * name, which is exactly what the benchmark's own doc comment forbids.
   */
  inactive_omitted: number;

  /**
   * Rows the public API layer dropped because it could not attribute them to a person at all —
   * R4's third state: an id with no membership row of any status ("never in this
   * tenant"), logged and dropped, deliberately never folded into
   * {@link inactive_omitted}.
   *
   * The console needs it for one reason: `total_agents` counts them, `rows`
   * does not, and neither does `inactive_omitted` — so
   * `total_agents <= rows.length + inactive_omitted` is false with nothing
   * truncated, and `truncationNote` told a supervisor the rest of their floor was
   * further down an order. Adding this count back before the comparison is what
   * makes the note say something true. See `truncationNote`.
   *
   * Optional and read through `typeof`: the public API layer invented it, so an absent value
   * means 0 and restores exactly today's behaviour rather than inventing a count.
   */
  unattributed_omitted?: number;
}

// ─── The GROUPED read ────────────────────────────────────────────────────────
//
// Everything above is either one person over a range or one row per PERSON. What
// follows is one general aggregate over agency dial attempts, grouped by up to two
// dimensions: `GET /proxy/agency/agents/grouped-stats`, the public API layer's proxy of the dialer runtime's
// `GET /api/v1/agency-agents/grouped-stats`.
//
// ── Why it is a second route rather than `group_by` on the roster ────────────
// The roster payload is frozen, and `AgencyRosterAgentRow` is keyed on
// `agent_user_id` — a campaign-grouped or hour-grouped row is not that shape. Adding
// `group_by` to the roster would make its `rows` polymorphic, which is the worst of
// both: a frozen payload whose members are present only sometimes, and a console
// that has to know which. So the roster answers "how does this person compare to the
// floor" and this route answers "how does this slice compare to that one", and
// neither has an arm for the other's question.
//
// ── What this read deliberately does NOT carry ──────────────────────────────
// No occupancy and no benchmark, and both absences are rulings rather than gaps.
// Occupancy comes from a second statement over the session-event log and cannot be
// attributed to a disposition or an hour without inventing an apportionment rule.
// A benchmark is a statement about a cohort of PEOPLE — a median over a cohort of
// dispositions or of hours would be a number with no meaning that a console would
// nonetheless render. **Comparison stays on the roster.**
//
// What it DOES carry, added after the console found the gap, is
// `rates_reportable` — see {@link AgencyGroupRow.rates_reportable}. Comparison
// stays on the roster; the answer to "may this rate be quoted" does not, because a
// console cannot derive it and must not invent it.

/**
 * The dimensions a grouped read may be cut by.
 *
 * `day_of_week` is a NUMBER on the wire (0 = Sunday … 6 = Saturday, matching
 * Postgres `EXTRACT(DOW …)`) rather than a name: a locale-dependent day name in a
 * payload is a formatting decision that belongs in the console, and restating
 * the dialer runtime's 0=Sunday as a string invites an off-by-one against ISO's 1=Monday.
 */
export type AgencyGroupDimension =
  | 'agent'
  | 'campaign'
  | 'disposition'
  | 'day'
  | 'day_of_week'
  | 'hour_of_day';

/**
 * What one row is a group OF — one shape, not a union.
 *
 * A member is present if and only if its dimension is in `group_by`, and
 * {@link AgencyGroupPage.group_by} is what says which. That is why nothing here is
 * required: a reader that assumes `key.agent_user_id` must render whatever the
 * server sent, and an `agent`-less read is an ordinary request rather than a
 * violation.
 *
 * **`disposition_code: null` is a GROUP, not a gap.** An attempt with no
 * disposition submitted is precisely the number a supervisor is looking for on
 * that screen, so the dialer runtime emits it as `null` rather than folding it into an "other"
 * bucket, and the console names it. That is why the member is `string | null` and
 * "present" has to be tested against `group_by` rather than against `undefined`.
 */
export interface AgencyGroupKey {
  agent_user_id?: string;
  campaign_id?: string;
  /** `null` is a real key value — un-dispositioned work. Present (possibly null) iff grouped. */
  disposition_code?: string | null;
  /** `YYYY-MM-DD`, cut in the resolved campaign timezone. Same format as `bucket_start`. */
  day?: string;
  /** 0 = Sunday … 6 = Saturday. */
  day_of_week?: number;
  /** 0–23, in the resolved campaign timezone. */
  hour_of_day?: number;
}

/**
 * One group's figures — the same eight metrics the roster carries, and no more.
 *
 * The rates obey this file's rule: **`null` on a zero denominator, never `0`**.
 * `0` is measured-and-zero; `null` is no denominator. And {@link rates_reportable}
 * says whether a non-null rate may be QUOTED, which is a third thing again.
 */
export interface AgencyGroupRow {
  key: AgencyGroupKey;
  attempts: number;
  connected: number;
  successes: number;
  talk_seconds: number;
  wrapup_seconds: number;
  /** `connected / attempts`. */
  connect_rate_pct: number | null;
  /** `successes / connected` — the denominator is CONNECTS, not dials. */
  success_rate_pct: number | null;
  /** `(talk + wrapup) / connected`. */
  aht_seconds: number | null;
  /**
   * True when this group has enough volume for its rates to be quoted —
   * `attempts >= {@link AGENCY_ROSTER_MIN_RATE_DENOMINATOR}`, the roster's own
   * threshold and the same constant, not a second one with the same value.
   *
   * **Added to this read after the console found the gap.** The rates are still
   * served when it is `false`, exactly as on the roster: the server states the
   * fact and the consumer decides. This client honours it literally — a thin
   * row's connect and conversion rates render WORDS, because a 100% conversion
   * built from one connect printed beside a named person is the misreading the
   * flag exists to prevent, and greying the number out does not prevent it.
   *
   * It is well-defined on every grouping, which is why it belongs here rather
   * than only on the roster: a row is "enough volume to quote a rate for" whether
   * it is one agent on one campaign, a whole campaign, or one weekday-hour cell.
   *
   * The console and server deploy independently, so this console can meet a dialer runtime that
   * predates the field. Read it through a `typeof` guard and treat an absent
   * value as "do not withhold" — a screen that withholds every rate because a
   * field is missing is worse than the gap the field closed. Declared optional
   * so that guard is load-bearing to `tsc`: see
   * {@link AgencyRosterBenchmark.shift_seconds}.
   *
   * ⚠️ **Its denominator is `attempts`, so it is the wrong flag for the
   * conversion rate.** See {@link success_rate_reportable}.
   */
  rates_reportable?: boolean;

  /**
   * True when this group has enough CONNECTS for its conversion rate to be
   * quoted — `rates_reportable` AND `connected >= 20`, the same predicate
   * {@link AgencyRosterAgentRow.success_rate_reportable} carries, on every
   * grouping.
   *
   * The flag {@link rates_reportable} was added for did not do the job it was
   * added for: 20 dials, 1 connect and 1 conversion clears it and renders
   * `100%`. On the contribution screen that prints beside a named person under
   * the heading "who drove this campaign", which is precisely the finding the
   * house rule about per-metric minimum volume exists to suppress.
   *
   * Strictly stronger than `rates_reportable`, so the conversion rate gates on
   * this alone. Absent falls back to `rates_reportable` — the behaviour that
   * shipped before the field, never a wider set of quoted rates.
   */
  success_rate_reportable?: boolean;
}

/**
 * A grouped row as it reaches a browser.
 *
 * `agent_name` is the public API layer's addition and is present **only when `agent` is one of
 * the grouped dimensions** — the dialer runtime has no user table and can only ever serve a
 * uuid. `null` means unresolvable (a deleted user, an id from outside the tenant),
 * never "no name": render it through `agentDisplayName`, exactly as a roster row's
 * is. `undefined` means this read was not grouped by agent and the question does
 * not arise.
 */
export interface AgencyGroupRowWithName extends AgencyGroupRow {
  agent_name?: string | null;
}

/**
 * What a grouped read may be ordered by.
 *
 * `key` is the DEFAULT upstream, and it is the right default: a grouped read is
 * most often a series or a matrix and key order is the only order those read
 * correctly. A metric sort is for contribution — "who drove it" is
 * `sort=successes&order=desc`.
 *
 * Nulls sort LAST in both directions on the three nullable metrics, tie-broken by
 * key ascending — the roster's rule, so the two reads order identically.
 */
export type AgencyGroupSort =
  | 'key'
  | 'attempts'
  | 'connected'
  | 'successes'
  | 'connect_rate_pct'
  | 'success_rate_pct'
  | 'aht_seconds';

/**
 * `GET /proxy/agency/agents/grouped-stats` — the grouped read's whole response.
 *
 * Every parameter the server actually applied is echoed back, including
 * {@link group_by} in a CANONICAL order (the vocabulary's own order, whatever
 * order the request used), and the console reads the echo rather than its own
 * request state.
 */
export interface AgencyGroupPage {
  from: string;
  to: string;
  /** `null` means every campaign in scope, not "no campaign". */
  campaign_id: string | null;
  /** Canonical order, echoed — `agent,campaign` and `campaign,agent` are one read. */
  group_by: AgencyGroupDimension[];
  sort: AgencyGroupSort;
  /** The same two words as the roster's, and deliberately the same type: one vocabulary. */
  order: AgencyRosterOrder;
  limit: number;
  /**
   * Groups matching scope+window, counted by the dialer runtime **before** `limit` and before
   * the public API layer's departed-member filter.
   *
   * ── Not the denominator of a "showing N of M" ─────────────────────────────
   * The same uncomputable fraction the roster's `total_agents` carries a note
   * about, for the same reason and in the same order: the dialer runtime scopes, groups and cuts
   * to `limit`, then the public API layer filters the page it was handed. `total_groups`,
   * `rows.length` and {@link inactive_omitted} are three independent true facts
   * and no fraction is derivable from them.
   */
  total_groups: number;
  rows: AgencyGroupRowWithName[];
  /**
   * Rows the public API layer removed because the agent is no longer an active member.
   *
   * **`0` is meaningful in two different ways here, and both are true.** When
   * `agent` is grouped it means nothing was dropped (or `include_inactive` was
   * sent). When `agent` is NOT grouped there was nothing to drop: a
   * campaign-grouped row is an aggregate over everyone who dialled and no row
   * belongs to a person. `include_inactive` is meaningful only when `agent` is
   * grouped.
   *
   * ⚠️ **That is the reconciliation trap, and a console must not present the two
   * silently.** A campaign-grouped total INCLUDES a departed agent's attempts; an
   * agent-grouped view of the same campaign EXCLUDES them by default. So the agent
   * rows do not add up to the campaign's own total. Neither number is wrong;
   * showing them adjacent without saying so is. See `contributionAsymmetryNote` in
   * `utils/agencyCampaignContribution.ts`.
   *
   * The contract calls the difference "exactly the departed agents' work", and the
   * console deliberately does not repeat that: {@link unattributed_omitted} is a
   * second cause of the same shortfall, `limit` is a third, and a departed member
   * who booked nothing moves no SHARE at all. The note names what is missing and
   * makes no quantitative claim about the size of the gap.
   *
   * Always emitted by the public API layer, including on the degrade path where it cannot
   * recognise the dialer runtime's body — a client's `n <= rows.length + undefined` is
   * `n <= NaN`, which is `false`, and the client then renders a truncation note on
   * an untruncated page. Read through a `typeof` guard all the same.
   */
  inactive_omitted: number;

  /**
   * Groups the public API layer dropped because it could not attribute them to a person —
   * R4's third state, and never part of {@link inactive_omitted}.
   *
   * Two consumers, both of them sentences that were false without it:
   * `contributionTruncationNote`, which compared `total_groups` against
   * `rows.length + inactive_omitted` and claimed truncation on a page nothing had
   * truncated; and `contributionAsymmetryNote`, which said the shortfall between
   * the rows and the campaign's own total was "exactly those members' work" when
   * these rows are a second, unnamed cause of it.
   *
   * Optional and `typeof`-guarded: absent means 0, which is today's behaviour.
   */
  unattributed_omitted?: number;

  /**
   * The zone the time buckets were ACTUALLY cut in.
   *
   * A `string` when any grouped dimension is zoned (`day`, `day_of_week`,
   * `hour_of_day`); `null` when none is, because there is then nothing to name.
   *
   * ── Why the client cannot derive it, and must not try ──────────────────────
   * The dialer runtime resolves the zone through `LEFT JOIN pg_timezone_names z ON lower(z.name)
   * = lower(c.default_timezone)` and uses `COALESCE(z.name, 'UTC')`. That join is a
   * LEFT join on purpose — an unresolvable `default_timezone` must not raise
   * `22023` and take out every other campaign's numbers in the same statement — so
   * `agency_campaigns.default_timezone` and the zone the buckets were cut in **can
   * differ**, and they differ precisely when the stored value is garbage. A console
   * labelling its hour axis from the campaign record would therefore print
   * `Asia/Calcutta_typo` over columns that are in fact UTC, on exactly the campaign
   * whose zone is broken. Confidently wrong beats blank; this field is what stops
   * it.
   *
   * ── The axis is labelled from THIS field or not at all ─────────────────────
   * ⚠️ It is **not** the reader's zone, and there is already a function that
   * returns that one: `windowRangeReadout` prints
   * `Intl.DateTimeFormat().resolvedOptions().timeZone`, which is correct for its
   * own caption (the window bounds really are cut from a local `Date`) and wrong
   * for an hour axis. Two zones on one screen is the defect E3 exists to prevent,
   * so everything that names or reasons about the heatmap's zone takes it as an
   * ARGUMENT — see `bestHoursZone` and `weekdayCoverage` in
   * `utils/agencyBestHours.ts`, neither of which may reach for `Intl`'s default.
   *
   * Absent means "a service that predates the field": the surface renders the
   * matrix with no hour-axis zone label and says the zone could not be read. It
   * never guesses, never falls back to UTC and never falls back to the browser.
   *
   * **Declared optional, and that is what makes the guard load-bearing** — the
   * same reason {@link AgencyRosterBenchmark.shift_seconds} is. `null` and
   * `undefined` are two different arrivals here (a read with no zoned dimension
   * versus a service that cannot answer), which is why the guard tests
   * `typeof === 'string'` rather than truthiness.
   */
  resolved_timezone?: string | null;
}
