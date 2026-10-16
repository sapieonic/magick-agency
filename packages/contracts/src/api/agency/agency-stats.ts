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
import type * as Core from '../../agency';
import type { SortOrder } from '../../primitives';
import type { AgencyAgentsByState } from './agency-campaign';
// Identical in the dialer contract, so re-exported rather than copied (`CONTRACT-DIFF.md` §3).
import type {
  AgencyAgentCampaignRow,
  AgencyGroupDimension,
  AgencyGroupKey,
  AgencyGroupSort,
  AgencyRosterPercentiles,
  AgencyRosterSort,
  AgencyStatsBucketUnit,
} from '../../agency';
import {
  AGENCY_ROSTER_MIN_RATE_DENOMINATOR,
} from '../../agency';

export type {
  AgencyGroupDimension,
  AgencyGroupKey,
  AgencyGroupSort,
  AgencyRosterPercentiles,
  AgencyRosterSort,
};
export {
  AGENCY_ROSTER_MIN_RATE_DENOMINATOR,
};

/** Bucket width: the console's name for the dialer contract's `AgencyStatsBucketUnit`. */
export type AgencyStatsBucketWidth = AgencyStatsBucketUnit;

/**
 * One campaign's slice of the range: the console's name for the dialer
 * contract's `AgencyAgentCampaignRow`. There is no `campaign_name`: the caller
 * resolves it from a list it already holds, and an id with no match renders as
 * an id, never as a blank row.
 */
export type AgencyAgentStatsByCampaign = AgencyAgentCampaignRow;

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
export type AgencyOccupancy = Core.AgencyAgentOccupancy;

/**
 * One agent's figures over a range.
 *
 * `campaigns` is a COUNT of campaigns worked in the range, not a list — the list
 * is {@link AgencyAgentStats.by_campaign}, and duplicating it as a length would
 * give the screen two sources for one fact.
 */
export interface AgencyAgentStatsTotals extends Omit<Core.AgencyAgentStatsTotals, 'occupancy'> {
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
export interface AgencyAgentStatsBucket extends Omit<Core.AgencyAgentStatsBucket, 'occupancy'> {
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
  occupancy?: AgencyOccupancy | null;
}

/** `GET /agency/my-stats` and `GET /agency/agents/:userId/stats`. */
export interface AgencyAgentStats extends Omit<Core.AgencyAgentStats, 'totals' | 'buckets'> {
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
// on every row (the dialer runtime has no user table and can only ever serve a
// uuid), and `inactive_omitted` at the top level (the dialer runtime cannot know who is still a
// member). So {@link AgencyRosterAgentRow} is the dialer runtime's row unchanged,
// {@link AgencyRosterAgentRowWithName} is what reaches a browser, and
// {@link AgencyRosterPage} is the public API layer's envelope — which is the only one this
// client can ever receive, because the console never reaches the dialer runtime.

/** Sort direction. `desc` is the default, because the roster's default sort is a ranking. */
export type AgencyRosterOrder = SortOrder;

/**
 * One agent's line on the roster — the dialer runtime's row, unchanged.
 *
 * The null-not-zero rule that governs this whole file governs every rate here,
 * and it bites hardest on a roster: a table is scanned rather than read, so a
 * `0%` in a column of real percentages is indistinguishable from a bad shift.
 */
export interface AgencyRosterAgentRow extends Omit<Core.AgencyRosterAgentRow, 'success_rate_reportable'> {
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
export interface AgencyRosterBenchmark
  extends Omit<Core.AgencyRosterBenchmark, 'shift_seconds' | 'break_seconds' | 'aht'> {
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
  /**
   * Handling time's distribution — an additive field.
   *
   * The benchmark had handle time only as the pooled scalar {@link aht_seconds},
   * so AHT was the one metric with a team figure and no band beside it: a
   * supervisor could read the floor's average handle time with nothing saying
   * whether four minutes is ordinary on this campaign.
   *
   * ── Which rows are in this pool, stated once and correctly ────────────────
   * `rates_reportable` **AND `connected >= 20`** AND a non-null `aht_seconds` —
   * The SAME predicate `success_rate`'s pool uses rather than
   * a restatement of it. `aht_seconds` divides by `connected`, which is exactly
   * the denominator that second floor exists to protect.
   *
   * Do not read this as "gated exactly as `success_rate`'s
   * pool is — `rates_reportable` and a non-null value": those two clauses
   * disagree, since the gloss after the dash is how `occupancy_pct`'s pool is gated,
   * and the two differ for every row with `1 <= connected < 20`. Gating an AHT comparison on `rates_reportable` alone would flag a
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
}

/**
 * `GET /proxy/agency/agents/stats` — the roster read's whole response.
 *
 * Every parameter the server actually applied is echoed back, and the console
 * reads the echo rather than its own request state: a `limit` clamped upstream or
 * a `sort` the server defaulted would otherwise be described to the reader
 * incorrectly by the very screen that was truncated.
 */
export interface AgencyRosterPage extends Omit<Core.AgencyRosterPage, 'rows' | 'benchmark'> {
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
   * The third state: an id with no membership row of any status ("never in this
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
 * One group's figures — the same eight metrics the roster carries, and no more.
 *
 * The rates obey this file's rule: **`null` on a zero denominator, never `0`**.
 * `0` is measured-and-zero; `null` is no denominator. And {@link rates_reportable}
 * says whether a non-null rate may be QUOTED, which is a third thing again.
 */
export interface AgencyGroupRow
  extends Omit<Core.AgencyGroupRow, 'rates_reportable' | 'success_rate_reportable'> {
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
 * `GET /proxy/agency/agents/grouped-stats` — the grouped read's whole response.
 *
 * Every parameter the server actually applied is echoed back, including
 * {@link group_by} in a CANONICAL order (the vocabulary's own order, whatever
 * order the request used), and the console reads the echo rather than its own
 * request state.
 */
export interface AgencyGroupPage extends Omit<Core.AgencyGroupPage, 'rows' | 'resolved_timezone'> {
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
   * The third state, and never part of {@link inactive_omitted}.
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
   * for an hour axis. Two zones on one screen is the defect this rule exists to prevent,
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
