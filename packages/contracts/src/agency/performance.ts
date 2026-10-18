/**
 * The performance reads: the campaign stats time series, the agent's own record, the
 * supervisor's roster and the grouped read.
 *
 * Part of the dialer contract; `../agency.ts` is the barrel and carries the
 * contract's header (freeze rules, vocabulary).
 */

import type { SortOrder, StatsBucketUnit } from '../primitives';
import type { AgencyAgentState } from './enums';

// ─── The campaign stats TIME SERIES (`GET /agency-campaigns/:id/stats/series`) ─
//
// `GET /:id/stats` is a campaign's numbers RIGHT NOW: lifetime counters, a live
// floor, a health strip. It cannot answer "is this campaign getting better or
// worse", because every counter on it is a single lifetime total — the same
// reason the `previous_hour` block was cut from that payload (see the note at the
// end of `AgencyCampaignStats`). This is the shape that can: one row per calendar
// bucket, over a caller-chosen window.

/**
 * One bucket of a campaign's series — {@link AgencyAgentStatsBucket} minus
 * `occupancy`.
 *
 * ── Derived from that type, never re-declared ─────────────────────────
 *
 * The console already has bucket helpers written against the agent record's
 * buckets — sparkline, delta, tooltip — and the whole point of this shape is that
 * they are reused rather than forked. An `Omit` is what makes that a compile-time
 * property instead of a claim: a sixth counter added to the agent's bucket appears
 * here automatically, and a RENAMED one is a build error at the repository that
 * fills this in. Two hand-maintained copies of five field names is exactly how the
 * client ends up with two nearly-identical helpers, one of which is wrong.
 *
 * (`AgencyAgentStatsBucket` is declared further down this file. Deliberate: this
 * section is about the campaign, and a type alias is hoisted, so placing the
 * campaign's contract with the campaign's other contracts costs nothing.)
 *
 * ── `occupancy` is the one field that is NOT carried, and it cannot be ──────
 *
 * `AgencyAgentOccupancy` is where ONE PERSON's time went, differenced from that
 * person's transition log. A campaign has a floor, not a person: summing six
 * agents' `shift_seconds` gives a number whose unit is agent-seconds and whose
 * only honest denominator is headcount × window — neither of which is on this
 * payload. Serving the sum under the same key the agent record uses would put a
 * number on the wire that the console's existing occupancy helper would render as
 * a percentage of the wrong thing. Omitted rather than zero-filled: an
 * all-zeros occupancy block is indistinguishable from "this floor never worked".
 */
export type AgencyCampaignStatsBucket = Omit<AgencyAgentStatsBucket, 'occupancy'>;

/**
 * `GET /api/v1/agency-campaigns/:id/stats/series?from=&to=&bucket=day|week|month`.
 * The public API layer proxies it at `/proxy/agency/campaigns/:campaignId/stats/series`.
 *
 * ── The window is HALF-OPEN `[from, to)` ────────────────────────────
 *
 * Same convention as {@link AgencyAgentStats}, and NOT the attempt spine's
 * inclusive `to`. A half-open window is the only shape that tiles: `[Mon, Tue)`
 * and `[Tue, Wed)` cover Tuesday exactly once, so two consecutive requests can be
 * concatenated without a day being counted twice. The spine's `to` is inclusive
 * because it is a "show me up to here" FILTER; this is an aggregate somebody will
 * add up. The difference is invisible in a URL, which is why it is written down on
 * both.
 *
 * Buckets are cut on `dialed_at`, so an attempt that was created and never placed
 * is in no bucket at all. That is deliberate: a dial that never happened is not a
 * dial, and the alternative (`created_at`) buckets an attempt into a day nothing
 * was dialled in.
 *
 * ── EVERY bucket in the range is present, zeros included ────────────────
 *
 * A weekend arrives as `attempts: 0`, never as an absent key. "We dialled nobody
 * that day" and "that day was not in the response" are different facts and only
 * the first one can be drawn: a chart fed a gappy series either draws a straight
 * line through the hole (inventing dials that did not happen) or shifts every
 * later point one column left. The calendar spine is generated in SQL and the
 * aggregate is LEFT JOINed onto it, so the zero-fill is a property of the
 * statement rather than something a consumer has to reconstruct.
 *
 * This is the one place this payload deliberately DIFFERS from
 * {@link AgencyAgentStats}, whose `buckets[]` carries only the labels that had
 * something in them. That read is a person's own record, where an empty day is
 * usually a day they did not work; this one is a campaign's trend line, where an
 * empty day is a data point.
 *
 * ── NO RATES ON THE WIRE ────────────────────────────────────
 *
 * There is no `connect_rate_pct` and no `success_rate_pct` on a bucket, and that
 * is a decision rather than an omission. Both numerator and denominator are on
 * every bucket, so the client derives whichever rate it is drawing — and it has
 * to, because a chart aggregating several buckets into one column needs
 * `Σnum / Σden`, not the average of the per-bucket rates, which is a different
 * (and wrong) number. Shipping the rate invites exactly that mistake. The
 * `null`-not-zero rule that governs every rate on this surface then lives in one
 * place — the client's own divide — instead of being re-decided per bucket here.
 */
export interface AgencyCampaignStatsSeries {
  /** Echoed from the path. */
  campaign_id: string;
  /** Echoed so a consumer never infers the grouping from the labels. */
  bucket: AgencyStatsBucketUnit;
  /**
   * The IANA zone the buckets were actually cut in — the campaign's own
   * `default_timezone`, RESOLVED.
   *
   * **Resolved, not the stored column.** `default_timezone` is `VARCHAR(64)` with
   * no constraint and comes from customer-facing config, and the query resolves it
   * through `pg_timezone_names` with a UTC fallback precisely so an unparseable
   * value cannot raise `22023` and 500 the read. The two differ exactly when the
   * stored value is garbage — i.e. echoing the column would hand the console
   * `Asia/Kolkata_typo` to print over columns that are in fact UTC, on the one
   * campaign whose zone is broken. Same rule, same reason, as
   * `AgencyGroupPage.resolved_timezone`.
   */
  timezone: string;
  /**
   * Ascending by `bucket_start`, gap-free, and NEVER empty: the parser refuses
   * `from >= to`, so every accepted window contains at least one bucket.
   *
   * ⚠️ The FIRST and LAST buckets can be partial, and this is the payload's one
   * real sharp edge. The window bounds are instants and the buckets are calendar
   * days in the campaign's zone, so `from=2026-08-11` (which parses as
   * `2026-08-11T00:00:00Z`) on an `Asia/Kolkata` campaign starts the series at
   * 05:30 local — the `2026-08-11` bucket then holds 18.5 hours of that day, not
   * 24. Reinterpreting a date-only bound as local midnight was the alternative and
   * is worse: it would make the same URL mean a different window per campaign, and
   * it needs a second date-parsing rule beside `parseFilterDate`'s. A caller who
   * needs whole local days sends zone-aware instants
   * (`from=2026-08-10T18:30:00Z`).
   *
   * ⚠️ At `bucket=week` and `bucket=month` the SAME truncation makes the partial
   * edges much larger, and the label does not say so. A bucket is labelled with
   * its truncated START — `date_trunc('month', …)`, formatted `YYYY-MM-DD` — so a
   * bound anywhere inside a period is labelled with the period's first day while
   * holding only the part of it inside the window: `from=2026-05-11&bucket=month`
   * emits a bucket labelled `2026-05-01` containing 21 days of May (verified by
   * execution), and `bucket=week` does the same to a week from its ISO Monday. A
   * consumer reading `2026-05-01` as "May" therefore reads a two-thirds month as a
   * whole one, and comparing it against the next bucket (a full June) reads as a
   * jump in volume that is really a jump in bucket width.
   *
   * Not clipped, not relabelled and not dropped, for the reason above plus one
   * more: the label is `bucketStartSql`, the single expression the spine and the
   * aggregate both label with, and a "clipped" label would have to be a second
   * spelling of it. So the rule for a caller drawing week or month columns is the
   * same as for days, only it matters more: align `from`/`to` with period
   * boundaries in the campaign's zone, or expect the first and last columns to be
   * short.
   */
  buckets: AgencyCampaignStatsBucket[];
}

// ─── The agent's own record (`GET /agency-agents/:agentUserId/stats`) ────────
//
// A per-PERSON, cross-campaign read. Everything above is per campaign: the
// supervisor dashboard answers "how is this campaign doing", and the attempt
// spine answers "what happened to this contact". Neither can answer "what did I
// do this week" — the attempt row points at a SESSION (`reserved_agent_id`), and
// a session is per shift per campaign, so the person is two joins away from
// their own work. That two-hop join is the whole reason this is its own surface
// rather than a filter on an existing one.

/** How the record's buckets are cut. There is deliberately no `hour` and no `year`. */
export type AgencyStatsBucketUnit = StatsBucketUnit;

/**
 * Where an agent's time went, in seconds, derived from
 * `agency_agent_session_events`.
 *
 * **Only as good as the recorded events.** A session with
 * no events has an honest answer of every field at zero — never a
 * duration reconstructed from `agency_agent_sessions.state_since`, which is a
 * snapshot every transition overwrites and would therefore attribute an agent's
 * entire history to whatever state they happen to be in now.
 *
 * ⚠️ **`by_state.reserved` is structurally 0 today, and that is not a bug in this
 * payload.** `reserved` is the only agent state deliberately NOT mirrored to
 * `agency_agent_sessions` (see `pacing-engine.ts`'s `dialUpTo`: a mirror there is
 * write-only, restamps the risk-ordering anchor, and costs a round trip per
 * reserved agent per 250ms tick) — so no transition into it is logged and its
 * time is folded into the preceding `available` interval. The key is present
 * because the state is part of {@link AgencyAgentState} and a consumer's
 * exhaustive switch needs it; treat a non-zero value as evidence that mirroring
 * changed, not as a rounding artefact. The state is sub-second-to-15s transient,
 * so the fold costs `available` a small over-count and nothing else.
 */
export interface AgencyAgentOccupancy {
  /**
   * Every second the agent was logged in — i.e. the sum of `by_state` EXCLUDING
   * `offline`.
   *
   * The denominator for occupancy (`by_state.on_call / shift_seconds`), left
   * undivided on purpose: contact centres disagree about whether break time
   * belongs in it, and both readings are computable from this payload
   * (`shift_seconds - by_state.break` is the other one). Picking one silently is
   * how two screens come to disagree about "occupancy".
   */
  shift_seconds: number;
  /**
   * All six states, always present. Zero and absent are indistinguishable to a
   * consumer.
   *
   * ⚠️ The consequence, recorded because it is the shape's one real cost: every
   * value at zero has THREE causes and this payload cannot separate them — the
   * agent has no events (a session with no recorded transitions), the agent has events
   * but none inside the window, or the occupancy read itself failed and the record
   * was served without it (see `AgencyAgentStatsRepository.stats`, which warns).
   * Separating them needs a fourth state on the wire — a nullable block, or an
   * explicit "not measured" — which is a contract change every consumer would have
   * to render, not something a caller can infer. Until one is made, the log line
   * is where the third case lives.
   */
  by_state: Record<AgencyAgentState, number>;
}

/** One bucket of the agent's record. */
export interface AgencyAgentStatsBucket {
  /**
   * `YYYY-MM-DD`, the bucket's first day **in the campaign's own timezone**.
   *
   * A date rather than an instant, and formatted in SQL rather than serialised
   * from a `Date` — see `bucketStartSql`. For `week` it is the Monday (Postgres
   * `date_trunc('week', …)`, which matches the ISO-8601 reading `calling_days`
   * already pins); for `month`, the 1st.
   */
  bucket_start: string;
  attempts: number;
  connected: number;
  successes: number;
  talk_seconds: number;
  wrapup_seconds: number;
  occupancy: AgencyAgentOccupancy;
}

/** The agent's work on one campaign over the whole window. */
export interface AgencyAgentCampaignRow {
  campaign_id: string;
  attempts: number;
  connected: number;
  successes: number;
  talk_seconds: number;
  wrapup_seconds: number;
}

/** The window totals. Every counter here is the exact sum of the buckets. */
export interface AgencyAgentStatsTotals {
  /**
   * Every attempt the agent was reserved for, dialled inside the window.
   *
   * Reported beside {@link connected} rather than instead of it — that is a
   * product decision, not a redundancy. An agent's dial count and their connect
   * count answer different questions (how hard did the dialer work them, versus
   * how many conversations did they get), the gap between them is the list's
   * quality rather than the agent's, and collapsing them would make a bad roster
   * read as a bad agent.
   */
  attempts: number;
  /** `bridged_at IS NOT NULL` — media actually joined the agent to a person. */
  connected: number;
  /** `connected / attempts`, or `null` when nothing was dialled. */
  connect_rate_pct: number | null;
  /** Connected attempts whose disposition maps to an `is_success` catalog entry. */
  successes: number;
  /**
   * `successes / connected`, or `null` when nothing connected.
   *
   * **The denominator is `connected`, NOT `attempts`.** A call that never bridged
   * had no conversation to convert, so charging it against the agent would make
   * their conversion rate a function of the roster's answer rate. Same rule, and
   * the same shared helper, as every other rate here: `null` on a zero
   * denominator, never `0`.
   */
  success_rate_pct: number | null;
  /**
   * Summed `ended_at - bridged_at` over connected attempts — the AGENT's leg.
   *
   * Deliberately not the persisted `talk_seconds` column, which is anchored on
   * the carrier's answer and is nonzero even when no agent ever bridged (an
   * abandoned attempt settles carrying the apology clip's talk time). Attempts
   * with `outcome = 'orphaned'` are excluded: the reaper stamps `ended_at` at
   * SWEEP time, so a conversation whose replica died would contribute its whole
   * time-until-sweep — minutes, or hours — to one agent's day.
   */
  talk_seconds: number;
  /**
   * Summed measured wrap-up (`wrapup_ended_at - wrapup_started_at`), over the
   * three resolutions that are evidence of how long wrap-up TAKES.
   *
   * Never the `wrapup_seconds` column, which is the allotment copied from the
   * campaign at wrap-up entry — averaging that hands the operator their own
   * setting back as if it were measurement.
   */
  wrapup_seconds: number;
  /**
   * `(talk_seconds + wrapup_seconds) / connected`, or `null` when nothing
   * connected.
   *
   * ⚠️ **This is NOT the same definition as {@link AgencyCampaignStats.aht_seconds},
   * which is talk only and excludes voicemail-dispositioned attempts.** The
   * difference is deliberate and it is the one number on this payload most likely
   * to be assumed identical: on an agent's own record the wrap-up is part of the
   * handle (it is time they cannot take another call in), and a talk-only average
   * is already derivable as `talk_seconds / connected` from the two fields beside
   * it. The denominator is `connected` — the field on this payload — so a reader
   * can always reproduce the number; the numerators exclude orphans and unmeasured
   * wrap-ups, so this runs slightly LOW where those exist, which is the safer
   * direction than an AHT inflated by a reaper sweep interval.
   */
  aht_seconds: number | null;
  /** Distinct campaigns the agent was reserved on inside the window. */
  campaigns: number;
  occupancy: AgencyAgentOccupancy;
}

/**
 * `GET /api/v1/agency-agents/:agentUserId/stats`.
 *
 * ── The bucketing rule, because a reader's first thought will be "bug" ──────
 *
 * Buckets are cut in **each campaign's own `default_timezone`, derived per
 * attempt** — not per query, not in UTC, and there is deliberately no `tz`
 * parameter. So an attempt dialled at 23:30 IST on a campaign configured
 * `Asia/Kolkata` lands in that day's bucket even though it is 18:00 UTC, and an
 * attempt on a `America/New_York` campaign an hour later lands in the PREVIOUS
 * day's bucket.
 *
 * The consequence that looks wrong: a "day" is not one contiguous 24-hour window
 * when an agent works campaigns in different zones — two buckets labelled the
 * same date can cover overlapping wall-clock instants. That is accepted, because
 * the alternative is worse in the direction that actually matters. Cutting in one
 * chosen zone makes every attempt's bucket depend on a parameter the reader
 * supplied, so the same call appears in different days depending on who is
 * looking; and for an agent's own record "the day it was for that call" is the
 * right reading — it is the day the customer was in, the day the campaign's
 * calling window was drawn against, and the day the agent's shift was rostered
 * to.
 *
 * The property it buys is exact summation: because the zone comes off the
 * attempt's own campaign, **every attempt lands in exactly one bucket**, so
 * `totals`, `buckets[]` and `by_campaign[]` are three foldings of one row set
 * with no double-counting and no gaps. `totals` is computed BY summing the
 * buckets rather than by a second aggregate, so that property is structural
 * rather than something two queries have to agree about.
 *
 * Buckets are cut on `dialed_at` — never `created_at` (which precedes the dial by
 * a dispatch hop, so it can bucket an attempt into a day nothing was dialled in)
 * and never `ended_at` (which pushes a call straddling midnight into the later
 * day and leaves a still-live one in no day at all). Same choice, same reasons,
 * as `hourlyBuckets`.
 *
 * A bucket with occupancy but no attempts is emitted, and is one of the more
 * useful rows here: it is an agent who was on the floor and never dialled.
 */
export interface AgencyAgentStats {
  /** Echoed back — the public API layer's user id, opaque to the dialer runtime. */
  agent_user_id: string;
  /** Echoed so a consumer never has to infer the grouping from the labels. */
  bucket: AgencyStatsBucketUnit;
  /** The window as requested: `from` inclusive, `to` EXCLUSIVE, both ISO-8601 UTC. */
  from: string;
  to: string;
  totals: AgencyAgentStatsTotals;
  /** Ascending by `bucket_start`. Empty when the agent did nothing in the window. */
  buckets: AgencyAgentStatsBucket[];
  /** Unsorted; the console orders these. Sums to `totals` on every counter. */
  by_campaign: AgencyAgentCampaignRow[];
}

// ─── The supervisor's ROSTER (`GET /agency-agents/stats`) ────────────────────
//
// FROZEN AT PHASE 01, and frozen harder than the shapes above it, because the
// product decision behind it is "live query now, nightly rollup in phase 02":
// phase 02 swaps the data source underneath a console already built against this
// payload, so the payload IS the contract from the moment phase 01 ships.
// Anything wanted later must be shaped now or arrive as an additive optional
// field.
//
// ── Why this is a route and not a loop over the per-agent record ─────────────
//
// `AgencyAgentStats` answers "what did THIS person do", and a supervisor's first
// question is never that — it is "who is my floor and how do they compare".
// Fanning the per-agent read out over thirty agents costs sixty statements, and
// worse, it cannot produce the one thing that makes any single number readable:
// the cohort it sits in. A median has to be computed over the whole floor at
// once, so it has to be one read.
//
// ── What is deliberately NOT here ───────────────────────────────────────────
//
//   * **No composite "agent score".** Deferred past phase 02 by explicit
//     decision. A single ranked number invites exactly the reading the
//     `rates_reportable` flag below exists to prevent.
//   * **No `agent_user_id` filter.** The subject of this route is the WHOLE
//     roster; narrowing to named agents is phase 02's compare surface. A filter
//     here would make `benchmark` mean something different per request under the
//     same name.
//   * **No date buckets.** This is one window, one row per agent. The per-agent
//     record is where a trend lives, and its per-campaign-timezone bucketing
//     rule (see `AgencyAgentStats`) therefore does not apply to anything here —
//     there is no bucket to cut, so there is no zone to resolve.
//   * **No polling / wallboard semantics.** A windowed historical read.
//
// ── `account_id` is a PREDICATE, and a tenant-wide roster is not reachable ───
//
// The dialer runtime scopes every statement on `agency_agent_sessions.tenant_id` AND
// `.account_id`. A tenant-wide roster is a separate future mode with its own
// route; it must be impossible to obtain one by omitting a parameter, which is
// why neither is a filter with a default.

/** Minimum denominator before a rate is reportable. See AgencyRosterAgentRow
 * and AgencyGroupRow — the two rows that gate on it, from this one value, and each
 * on BOTH denominators: `attempts` for `rates_reportable`, `connected` for
 * `success_rate_reportable`. One number, four comparisons, no second threshold. */
export const AGENCY_ROSTER_MIN_RATE_DENOMINATOR = 20;

/**
 * What the roster may be ordered by, server-side.
 *
 * Every member except `agent_user_id` is a metric on {@link AgencyRosterAgentRow},
 * and four of them (`connect_rate_pct`, `success_rate_pct`, `aht_seconds`,
 * `occupancy_pct`) are NULLABLE — which is the whole reason the ordering rule has
 * to be stated rather than left to the database's default:
 *
 * **Nulls sort LAST in both directions.** A row with no measurable rate is not
 * the best row and it is not the worst row; it is not ranked. Postgres would
 * otherwise put NULLs first under `DESC` and hand a supervisor a page of agents
 * who dialled nobody at the top of "best connect rate".
 *
 * `agent_user_id` is the tiebreaker on EVERY sort — including the sorts where
 * ties are common (`successes` is a small integer, and a floor of thirty agents
 * will have several on 4). Without it two reads of the same window can return the
 * same rows in a different order, which reads as data changing under the reader.
 */
export type AgencyRosterSort =
  | 'attempts' | 'connected' | 'connect_rate_pct'
  | 'successes' | 'success_rate_pct' | 'aht_seconds'
  | 'talk_seconds' | 'occupancy_pct' | 'agent_user_id';

/**
 * One agent's line on the roster.
 *
 * Every rate on this row travels with its own denominator, and that is a rule
 * rather than a convenience: a rate whose denominator is not on the same object
 * cannot be checked, and an uncheckable rate is the one a supervisor acts on.
 */
export interface AgencyRosterAgentRow {
  /** the public API layer's user id, opaque to the dialer runtime. The dialer runtime has no user table and can only ever serve a UUID; the public API layer adds the name. */
  agent_user_id: string;
  attempts: number;
  connected: number;
  successes: number;
  talk_seconds: number;
  wrapup_seconds: number;

  /** null on a zero denominator — nothing dialled is NOT a 0% connect rate. */
  connect_rate_pct: number | null;
  /** Denominator is `connected`, not `attempts`. */
  success_rate_pct: number | null;
  /** (talk + wrapup) / connected. Same definition as AgencyAgentStatsTotals. */
  aht_seconds: number | null;

  /** Distinct campaigns this agent dialled inside the window. */
  campaigns: number;

  /**
   * Sum of by_state EXCLUDING offline, same definition as
   * AgencyAgentOccupancy.shift_seconds. 0 when occupancy is unmeasured.
   */
  shift_seconds: number;
  /** Break seconds, so the other occupancy reading stays derivable. */
  break_seconds: number;
  /**
   * (talk + wrapup) / shift_seconds, as a percentage.
   *
   * This route PICKS a denominator where AgencyAgentOccupancy deliberately does
   * not, because a roster column has to be one number. Break time is INCLUDED in
   * the denominator; `shift_seconds - break_seconds` gives the other reading and
   * both parts are on this row so it stays computable.
   *
   * null — never 0 — when shift_seconds is 0, which is also what an unmeasured
   * occupancy read produces. Zero and unmeasured are indistinguishable here for
   * the same reason they are on AgencyAgentOccupancy.
   *
   * ⚠️ There are THREE ways to arrive at `shift_seconds: 0` and this payload
   * separates none of them, exactly as `AgencyAgentOccupancy.by_state` does not:
   * the agent's sessions have no recorded transition events; the
   * agent has events but none inside the window; or **the occupancy read itself
   * failed and the roster was served without it** (the repository catches and
   * warns rather than 500ing the attempt totals — see
   * `AgencyAgentStatsRepository.roster`). The log line is the only place the third
   * case exists. Separating them needs a fourth state on the wire, which is a
   * contract change every consumer has to render.
   */
  occupancy_pct: number | null;

  /** Most recent dial inside the window, ISO instant. null if none. */
  last_dialed_at: string | null;

  /**
   * True when this row's rates cleared AGENCY_ROSTER_MIN_RATE_DENOMINATOR and
   * therefore contributed to `benchmark`'s percentiles.
   *
   * The rates are STILL SERVED when this is false — the caller gets the number
   * and the denominator and decides. What this flag exists for is so every
   * consumer applies ONE threshold rather than three, and so the console can
   * render "not enough calls" instead of a flattering number computed from
   * eleven calls.
   *
   * ── Which denominator, stated because the flag is one bool over three rates ─
   *
   * `attempts` — the row's headline denominator, the count of dials the whole
   * line is built from. A row that fails it contributes to NO percentile pool,
   * which is what makes the flag usable as the single gate its name promises.
   *
   * Two refinements sit on top of it inside `benchmark`, and only ONE of them is
   * expressible as a flag:
   *
   *   * The `success_rate` and `aht` pools additionally require `connected >=` the
   *     same threshold, because those metrics' own denominator is `connected`. An
   *     agent with 400 dials and three connects is reportable — 400 dials is a real
   *     day — and their 33% conversion is still three calls of evidence, which is
   *     precisely the noise the threshold exists to keep out of a median. That
   *     refinement IS on the wire, as `success_rate_reportable` below.
   *   * The `occupancy_pct` pool takes every reportable row with a measurable
   *     occupancy. Its denominator is a DURATION, so the same integer cannot gate
   *     it — "20" means twenty calls, not twenty seconds — and the exclusion that
   *     actually matters there is the null on `shift_seconds: 0`. There is
   *     deliberately no flag for it: a second threshold in SECONDS would be a
   *     number nobody has argued for, and the `null` already says "unmeasured".
   */
  rates_reportable: boolean;

  /**
   * True when this row cleared AGENCY_ROSTER_MIN_RATE_DENOMINATOR on **`connected`**
   * — the floor under the two metrics that divide by it, `success_rate_pct` and
   * `aht_seconds`.
   *
   * ── Why one flag was not enough ─────────────────────────────────────────────
   *
   * `rates_reportable` floors `attempts`. `success_rate_pct` divides by `connected`.
   * So 20 dials, ONE connect and one conversion is a reportable row carrying
   * `success_rate_pct: 100` — a 100% conversion built from a single conversation,
   * printed beside a named person, which is the exact reading the first flag was
   * added to prevent. The house rule is a minimum volume PER METRIC, and one
   * threshold on one denominator cannot express two denominators.
   *
   * ── It IMPLIES `rates_reportable`, so gating on it alone is correct ─────────
   *
   * `connected <= attempts` always — a connect is an attempt that bridged — and
   * `rates_reportable` IS `attempts >= 20`, so `connected >= 20` is strictly
   * stronger and can never be true where `rates_reportable` is false. A consumer
   * rendering `success_rate_pct` or `aht_seconds` therefore needs to read only this
   * flag; it does not have to AND the two. The converse does not hold, which is why
   * both are served: `connect_rate_pct` is gated by `rates_reportable` alone and
   * must stay quotable on a row that connected almost nobody, because that row's
   * connect rate is precisely the finding.
   *
   * Same constant, same comparison, and the same predicate the `success_rate` and
   * `aht` percentile pools admit rows by — so a console that withholds on this flag
   * withholds exactly the rows the benchmark refused to rank.
   */
  success_rate_reportable: boolean;
}

/**
 * p25 / median / p75 for one metric across the cohort.
 *
 * Linear-interpolated between the two neighbouring rows (the `percentile_cont`
 * reading, not `percentile_disc`), so a floor of four agents still produces a
 * median rather than snapping to one agent's number. All three are null together
 * when no row qualified — never 0, for the same reason no rate is ever 0 on an
 * empty denominator.
 */
export interface AgencyRosterPercentiles {
  p25: number | null;
  median: number | null;
  p75: number | null;
}

/**
 * The cohort the rows were drawn from — what makes a single agent's number
 * readable.
 *
 * ── Which agents are in it ────────────────────────────────────────────────
 * Every agent who dialled in the window and scope, INCLUDING one whose
 * membership was later revoked: the cohort is "the floor that week", and a
 * supervisor comparing against it wants the floor as it actually was. This is
 * deliberately NOT affected by the public API layer's `include_inactive`, which controls which
 * ROWS are returned, not what they are measured against. A benchmark that moved
 * when you toggled a row filter would be a different number under the same name.
 *
 * "Who DIALLED" is also what decides whether an agent gets a row at all, and the
 * consequence is worth naming: an agent who was on the floor all day and never
 * dialled has NO line here, though the per-agent record deliberately does emit
 * their empty bucket. Two reasons, and the second is the load-bearing one — the
 * cohort is defined above as the agents who dialled, so a row for someone who did
 * not would not belong to the benchmark it is displayed against; and the roster's
 * row set must not change shape when the occupancy read degrades. If occupancy
 * could ADD rows, a failed events-table read would silently delete agents from
 * the page, which is a far worse failure than serving their occupancy as zero.
 *
 * ── Percentiles exclude thin rows ─────────────────────────────────────────
 * Only rows with `rates_reportable: true` contribute. A new joiner's 11-call
 * rate is noise and would drag the median. `agents_rated` is that count;
 * `agents` is the total. When `agents_rated` is 0 every percentile is null.
 *
 * ── Pooled rates are NOT the median ───────────────────────────────────────
 * `connect_rate_pct` here is total connected / total attempts across the whole
 * cohort — the floor's actual rate. The median is in `connect_rate.median`.
 * They answer different questions and both are on the payload so neither has to
 * be recomputed by a consumer.
 *
 * The pooled rates are computed over EVERY row, thin ones included, and that is
 * not an inconsistency with the paragraph above. A pooled rate is a ratio of two
 * sums, so a thin row contributes proportionally to its own size — eleven calls
 * move it by eleven calls' worth. A median is a ratio of ratios, where the same
 * eleven calls count as one full vote. That asymmetry is the entire reason both
 * numbers are on this payload.
 */
export interface AgencyRosterBenchmark {
  agents: number;
  agents_rated: number;
  attempts: number;
  connected: number;
  successes: number;
  talk_seconds: number;
  wrapup_seconds: number;
  connect_rate_pct: number | null;
  success_rate_pct: number | null;
  aht_seconds: number | null;
  connect_rate: AgencyRosterPercentiles;
  success_rate: AgencyRosterPercentiles;
  occupancy_pct: AgencyRosterPercentiles;

  /**
   * Pooled shift and break seconds across the cohort — the two terms that make a
   * REAL team-row utilisation rate derivable, rather than a median labelled as one.
   *
   * ── The hole these close ────────────────────────────────────────────────────
   *
   * This object already carried pooled `talk_seconds` and `wrapup_seconds` — the
   * NUMERATOR of occupancy — and no pooled denominator, so the only cohort-wide
   * occupancy figure expressible was `occupancy_pct.median`. The console renders it
   * in the team row, honestly labelled as the median, because a pooled rate was not
   * derivable from the payload. With these two it is: pooled occupancy is
   * `(talk_seconds + wrapup_seconds) / shift_seconds`, and the break-excluding
   * reading is `… / (shift_seconds - break_seconds)` — the same two readings, and
   * the same refusal to pre-divide, as {@link AgencyAgentOccupancy}.
   *
   * ── Why they are POOLED here and must not be derived from `rows` ───────────
   *
   * A consumer summing the visible rows would get a number that MOVES when
   * the public API layer's `include_inactive` toggle moves, because that toggle removes rows.
   * This object's own contract (above) forbids exactly that: the benchmark is the
   * floor as it actually was, and a benchmark that changed when you flipped a row
   * filter would be a different number under the same name.
   *
   * Pooled over the SAME agent set as `attempts` / `connected` / `talk_seconds` —
   * every row, thin ones included — so these cannot disagree with the fields
   * beside them.
   *
   * ⚠️ `shift_seconds: 0` inherits every ambiguity the per-row field has: no
   * transition events, none in the window, or a FAILED occupancy read served
   * degraded. When it is 0 the derived pooled occupancy is `null` by the same
   * null-not-zero rule, not `0`.
   */
  shift_seconds: number;
  break_seconds: number;

  /**
   * Handling-time percentiles, which this object previously had only as the pooled
   * scalar `aht_seconds`.
   *
   * The pooled scalar is seconds-per-connected-call across the whole floor, so it
   * is dominated by the highest-volume agent; `aht.median` is the middle AGENT's
   * handling time. Exactly the same asymmetry as `connect_rate_pct` versus
   * `connect_rate.median`, and it is the reason both are served rather than one.
   *
   * ── The pool gate is `success_rate`'s, not `connect_rate`'s ────────────────
   *
   * `aht_seconds` divides by `connected`, the same denominator `success_rate_pct`
   * divides by — so it takes the same two-part gate: `rates_reportable` (the row's
   * headline `attempts` floor) AND `connected >=`
   * AGENCY_ROSTER_MIN_RATE_DENOMINATOR. A row with 400 dials and three connects is
   * a reportable row whose average handling time is three calls of evidence, which
   * is precisely the noise a median must not carry. Rows whose `aht_seconds` is
   * `null` (nothing connected) are excluded on top, as in every other pool — a null
   * ranked as 0 would put "no calls" at the fastest end of the distribution.
   *
   * That two-part gate is what `AgencyRosterAgentRow.success_rate_reportable` puts
   * on the wire, from the same predicate — so the rows a console withholds are the
   * rows this pool refused, rather than a set that agrees with it by coincidence.
   */
  aht: AgencyRosterPercentiles;
}

/**
 * The roster read's whole response — `GET /api/v1/agency-agents/stats`.
 *
 * ── Every request parameter is echoed, on purpose ───────────────────────────
 *
 * `from`, `to`, `campaign_id`, `sort`, `order` and `limit` all come back. The
 * window is echoed for the same reason the per-agent record echoes it: a caller
 * must never have to infer which window they were served. `sort`/`order`/`limit`
 * are echoed because they are applied SERVER-side — a console that sorted
 * locally would be sorting one page of a ranked list, which is a different and
 * wrong answer — so the response is the only place the applied ordering exists.
 *
 * ── `total_agents` is pre-`limit` and post-scope ────────────────────────────
 *
 * So the console can say "showing 100 of 137" rather than implying the floor is
 * whatever fitted on the page. `benchmark.agents` is the same number by
 * construction; it is repeated inside `benchmark` because a consumer rendering a
 * comparison should not have to reach outside the object it is comparing against.
 */
export interface AgencyRosterPage {
  from: string;
  to: string;
  campaign_id: string | null;
  sort: AgencyRosterSort;
  order: SortOrder;
  limit: number;
  /** Agents matching scope+window before `limit`. */
  total_agents: number;
  rows: AgencyRosterAgentRow[];
  benchmark: AgencyRosterBenchmark;
}

// ─── THE GROUPED READ (`GET /api/v1/agency-agents/grouped-stats`, phase 02a) ──
//
// One general aggregate over agency dial attempts, so the console can answer "who
// drove this campaign", "which hours connect" and "how does this agent's week
// trend" without a route per question.
//
// ── Why it is a NEW route and not `group_by` on the roster ───────────────────
//
// The roster payload is frozen (phase 02c swaps its data source under a console
// already built against it). Adding `group_by` there would make `rows`
// polymorphic: `AgencyRosterAgentRow` is keyed on `agent_user_id`, and a
// campaign-grouped or hour-grouped row is not that shape. A polymorphic frozen
// payload is the worst of both — a consumer can neither rely on the shape nor be
// told when it changes.
//
// ── What this read deliberately does NOT carry ──────────────────────────────
//
//   * **No occupancy.** It comes from `agency_agent_session_events` in a second
//     statement over a table whose `session_id` is indexed by nothing; the roster
//     gets away with that only because its row count is bounded by HEADCOUNT,
//     while this read's cardinality is a PRODUCT of its dimensions'. There is a
//     second, independent reason that would stand even if the cost were free:
//     occupancy cannot be attributed to a `disposition` or an `hour_of_day`
//     without inventing an apportionment rule. Occupancy stays on the roster and
//     the per-agent record.
//   * **No benchmark.** {@link AgencyRosterBenchmark} is a statement about a
//     cohort of PEOPLE — "the middle half of the floor". A cohort of dispositions
//     or of hours is not a peer group, and a median over them would be a number
//     with no meaning that a console would nonetheless render. Comparison stays on
//     the roster.
//   * **No `agent_user_id` filter**. Same reason as the roster:
//     the dialer runtime has no user table, `agent_user_id` is an opaque string to it, so
//     the dialer runtime cannot validate tenancy on a caller-supplied id — the public API layer's `memberships`
//     is the only place that boundary can exist. Filtering to a person is the
//     per-agent record's job.

/**
 * What a grouped row may be keyed by.
 *
 * `group_by` takes ONE or TWO of these, comma-separated, no duplicates. Three or
 * more is a 400 (`too_many_dimensions`), and that cap is a bound rather than a
 * preference: the row count is the PRODUCT of the dimensions' cardinalities, so a
 * third dimension turns a bounded read into an unbounded one — and every screen in
 * scope needs at most two (`agent`+`campaign` for contribution,
 * `day_of_week`+`hour_of_day` for best hours, `agent`+`day` for a trend).
 *
 * **Order does not matter and is canonicalised** to the declaration order here, so
 * `agent,campaign` and `campaign,agent` are the same read, echo the same
 * `group_by`, and cache the same. ROW order is set by `sort`, never by the
 * request's spelling of `group_by`.
 */
export type AgencyGroupDimension =
  | 'agent' | 'campaign' | 'disposition'
  | 'day' | 'day_of_week' | 'hour_of_day';

/**
 * The row's key — one object, never a union.
 *
 * A member is present if and only if its dimension is in `group_by`, and
 * {@link AgencyGroupPage.group_by} is what says which. One shape rather than a
 * discriminated union because the discriminant already exists at the top level,
 * and a union of 21 combinations is a shape no consumer would narrow correctly.
 */
export interface AgencyGroupKey {
  /** the public API layer's user id, opaque to the dialer runtime. the public API layer adds `agent_name` beside it. */
  agent_user_id?: string;
  campaign_id?: string;
  /**
   * The attempt's submitted disposition — **and `null` is a REAL key value here,
   * not a gap.**
   *
   * `agency_call_attempts.disposition_code` is `VARCHAR(50)` NULL, and an attempt
   * with no disposition submitted is precisely the number a supervisor came to this
   * screen for. Folding null into an "other" bucket, or dropping the group, hides
   * un-dispositioned work — so it is emitted as `null` and the console names it.
   *
   * Present (possibly `null`) if and only if `disposition` is grouped, which is
   * what keeps "absent because not grouped" distinguishable from "grouped, and this
   * group is the un-dispositioned one".
   */
  disposition_code?: string | null;
  /** `YYYY-MM-DD` in the resolved zone. Same format, same spelling, as `bucket_start`. */
  day?: string;
  /**
   * 0 = Sunday … 6 = Saturday, matching Postgres `EXTRACT(DOW …)`.
   *
   * A NUMBER, not a name: a locale-dependent day name in a payload is a formatting
   * decision that belongs in the console, and 0=Sunday is the value the SQL already
   * produces — restating it as a string invites an off-by-one against ISO's
   * 1=Monday.
   */
  day_of_week?: number;
  /** 0–23 in the resolved zone. */
  hour_of_day?: number;
}

/**
 * One grouped cell: the same EIGHT metrics as a roster row, the flag that says
 * whether they may be quoted as numbers, and nothing else.
 *
 * The five counters come from the one shared metric-expression builder every
 * agency attempts aggregate selects, so a grouped cell, a roster line and an
 * agent's own scorecard report the same numbers for the same attempts — which is
 * what lets a supervisor subtract one from another and get zero.
 *
 * **Rates are `null`, never `0`, on a zero denominator.** House rule, unchanged: a
 * `0` means measured-and-zero and a `null` means there was no denominator. A single
 * read that breaks it is how a supervisor comes to read "0% conversion" off a group
 * that connected nobody.
 *
 * ⚠️ `attempts` is ALWAYS >= 1 on a served row, and `connect_rate_pct` therefore
 * never `null`. It is derived rather than asserted: `attempts` is `COUNT(*)` over a
 * `GROUP BY` whose joins are all INNER and whose WHERE requires
 * `dialed_at IS NOT NULL`, with no `HAVING`, no `ROLLUP`/`GROUPING SETS` and no
 * outer join that could manufacture a null-extended row — so a group exists only
 * because at least one attempt satisfied the predicate. The type keeps the `null`
 * because the shared helper produces it and because this row must stay shaped like
 * a roster row; no consumer should carry a branch for it.
 * `success_rate_pct` and `aht_seconds` DO reach `null`, whenever the group
 * connected nobody.
 */
export interface AgencyGroupRow {
  key: AgencyGroupKey;
  attempts: number;
  connected: number;
  successes: number;
  talk_seconds: number;
  wrapup_seconds: number;
  /** connected / attempts. */
  connect_rate_pct: number | null;
  /** successes / CONNECTED — a call that never bridged had no conversation to convert. */
  success_rate_pct: number | null;
  /** (talk + wrapup) / connected. Same definition as AgencyRosterAgentRow.aht_seconds. */
  aht_seconds: number | null;
  /**
   * `attempts >= AGENCY_ROSTER_MIN_RATE_DENOMINATOR` — enough volume to quote this
   * row's rates as NUMBERS.
   *
   * The rates are served either way; what this gates is how they read. The house
   * rule is that a rate under the minimum denominator renders as WORDS, because a
   * greyed-out number still gets read as a number — and without a flag on the wire
   * a 100% conversion over a single connect prints beside a named person on the
   * contribution screen. It is the SERVER's threshold on purpose: a consumer
   * recomputing it from the exported constant would disagree the moment the
   * threshold is tuned, which is why that constant exists to EXPLAIN this flag
   * ("fewer than 20 dials") and never to derive it.
   *
   * ── It means the same thing on every grouping ────────────────────────────────
   *
   * The roster's flag is a statement about a PERSON; this one is a statement about
   * a ROW, and the row is whatever was grouped — one agent on one campaign, a whole
   * campaign, a disposition, or one weekday-hour cell. "Enough dials behind this
   * cell to quote a rate for it" holds for all of them, so no per-dimension reading
   * has to be carried. It matters most where the cells are smallest: a best-hours
   * heatmap cell with three dials must not show 33%.
   *
   * The same constant as the roster, deliberately not a second threshold with the
   * same value — one number tuned in one place, or the two reads disagree about
   * which rows are quotable while both claim to be honouring "the" minimum.
   *
   * ⚠️ The denominator is `attempts`, the row's HEADLINE count, which floors
   * `connect_rate_pct` and nothing else. `success_rate_pct` and `aht_seconds` divide
   * by `connected`, which can be far smaller, and their floor is
   * `success_rate_reportable` below — a SECOND flag rather than a footnote, because
   * a row of 20 dials and one converted connect is reportable on this one and still
   * carries `success_rate_pct: 100`.
   */
  rates_reportable: boolean;

  /**
   * `connected >= AGENCY_ROSTER_MIN_RATE_DENOMINATOR` — enough CONNECTS to quote
   * this row's `success_rate_pct` and `aht_seconds` as numbers.
   *
   * The per-metric half of the same house rule. `rates_reportable` floors
   * `attempts`, which is the right denominator for `connect_rate_pct` and the wrong
   * one for the other two: 20 dials with one connect and one conversion clears it
   * while carrying a 100% conversion rate off a single conversation — the exact
   * number, beside a named person on the contribution screen, that the first flag
   * exists to keep out of a console. It earns even more on 02b's heatmap, where a
   * cell holding twenty dials and two connects is common.
   *
   * ── It IMPLIES `rates_reportable`, so a consumer may gate on it ALONE ───────
   *
   * `connected <= attempts` always — a connect is an attempt that bridged — and
   * `rates_reportable` IS `attempts >= 20`, so this predicate is strictly stronger
   * and is never true where that flag is false. Rendering `success_rate_pct` or
   * `aht_seconds` therefore needs this flag and not the conjunction. The converse is
   * false, which is why both ride: a row that dialled 400 and connected nobody is
   * quotable on its connect rate and has no conversion rate at all.
   *
   * Same constant and same predicate as the roster's `success_rate_reportable` and
   * as the `success_rate`/`aht` percentile pools it gates there, deliberately not a
   * third threshold holding the same value.
   */
  success_rate_reportable: boolean;
}

/**
 * What a grouped read may be ordered by.
 *
 * `key` is the DEFAULT, and that is a product decision rather than an arbitrary
 * one: a grouped read is most often a series or a matrix, and key order is the only
 * order in which either reads correctly — an hour-of-day series sorted by
 * `successes` is not a series. A metric sort is for the contribution question ("who
 * drove it": `sort=successes&order=desc`).
 *
 * `key` orders by the grouped dimensions in canonical order
 * ({@link AgencyGroupDimension}), with `disposition_code: null` LAST in both
 * directions. A metric sort puts `null` last in both directions too, tie-broken by
 * the key ascending — the same rule the roster uses, so the two reads order
 * identically and a null row is never on the first page of a ranked question.
 *
 * Because the full key is always in the ORDER BY, the ordering is TOTAL: `limit`
 * therefore selects a reproducible set of rows rather than whichever ones the
 * executor reached first.
 */
export type AgencyGroupSort =
  | 'key' | 'attempts' | 'connected' | 'successes'
  | 'connect_rate_pct' | 'success_rate_pct' | 'aht_seconds';

/**
 * The grouped read's whole response — `GET /api/v1/agency-agents/grouped-stats`.
 *
 * ── `total_groups`, `rows.length` and `inactive_omitted` are THREE independent
 * facts, and no "showing X of Y" fraction is derivable from them ─────────────
 *
 * The roster's rule (no "showing X of Y" fraction) applies here unchanged, because the mechanism is the
 * same: the dialer runtime applies `limit`, and only then does the public API layer drop rows whose agent has
 * no active membership. The public API layer therefore cannot produce a post-filter population
 * count — that would need the filter applied before the limit, i.e. the public API layer shipping
 * every active agent id to the dialer runtime on a GET. So a default read can legitimately return
 * 190 rows with `total_groups: 400` and `inactive_omitted: 10`. They are rendered
 * as separate true statements: a population readout, a truncation notice only when
 * `total_groups > rows.length + inactive_omitted`, and a hidden-members notice only
 * when `inactive_omitted > 0`.
 *
 * ── A time dimension REQUIRES an unambiguous zone, or the read is refused ────
 *
 * Buckets are cut in the CAMPAIGN's own `default_timezone` (resolved through
 * `pg_timezone_names`, falling back to UTC — see
 * `AgencyAgentStatsRepository.attemptBuckets` for why that LEFT JOIN exists at
 * all). So across campaigns in different zones, "the 18:00 column" is not one
 * thing. `day`, `day_of_week` and `hour_of_day` are therefore accepted only when
 * `campaign` is also grouped (each row then carries its own campaign's zone) or
 * exactly one `campaign_id` is filtered (one zone for the whole read); otherwise
 * **400 `timezone_ambiguous`**, naming both remedies.
 *
 * There is deliberately no implicit UTC fallback and no `tz` parameter in this
 * phase. Silently bucketing an account whose campaigns run in `Asia/Kolkata` as UTC
 * puts the real 18:00 connect peak in the 12:00 column, and the only visible
 * symptom is a rostering decision that is quietly wrong — exactly the failure a
 * best-hours screen exists to prevent. A `tz` parameter stays additive for later,
 * if a cross-campaign single-zone view is ever asked for.
 *
 * Which zone a page's buckets ended up in is reported by {@link
 * AgencyGroupPage.resolved_timezone} — but only when it is ONE zone, which is the
 * `campaign_id` remedy and not the `group_by=campaign` one. Read that field's note
 * before labelling anything with it.
 *
 * ⚠️ **The reconciliation asymmetry the public API layer's layer creates, which a console must
 * not present without saying so.** A campaign-grouped total INCLUDES a departed
 * agent's attempts, because the row is an aggregate over everyone who dialled and
 * there is nothing to drop. An agent-grouped view of the same campaign EXCLUDES
 * them by default. The two therefore do not reconcile, and the difference is
 * exactly the departed agents' work. Neither number is wrong; showing them adjacent
 * without a note is.
 */
export interface AgencyGroupPage {
  from: string;
  to: string;
  campaign_id: string | null;
  /** Canonical order, echoed — never the order the request spelled it in. */
  group_by: AgencyGroupDimension[];
  /**
   * The ONE zone this page's time buckets were ACTUALLY cut in, or `null` when the
   * page has no single zone.
   *
   * A `string` if and only if **both** a zoned dimension is grouped (`day`,
   * `day_of_week`, `hour_of_day`) **and** `campaign_id` filtered exactly one
   * campaign. `null` otherwise — and that `null` carries ONE meaning, *this page
   * has no single zone*. Whether nothing zoned was grouped, or the read spans
   * campaigns whose zones may differ, the answer to "which one zone is this page
   * in" is the same, and both causes want the identical client behaviour: **do not
   * label an axis with a single zone.**
   *
   * The second half of that condition is the half that is easy to get wrong. A
   * time dimension is legal two ways (filtering to a campaign, or grouping by
   * `campaign`), and only the first narrows the read to one zone: `group_by=campaign,hour_of_day` with no
   * `campaign_id` is a legal 200 spanning every campaign in the account, each row
   * correctly cut in its own campaign's zone. That page has N zones and no single
   * label, so it reports `null`.
   *
   * ── Why a consumer cannot derive this, and must not try ────────────────────
   *
   * The value is `COALESCE(z.name, 'UTC')` — what the SQL actually used — read back
   * out of the same `pg_timezone_names` join the buckets were cut with, and NOT
   * `agency_campaigns.default_timezone`. That column is `VARCHAR(64)` with no
   * constraint, and the join is LEFT precisely so an unresolvable zone cannot raise
   * `22023 invalid_parameter_value` and take out every other campaign's numbers in
   * the same statement. So the STORED value and the zone the buckets were cut in
   * differ **exactly when the stored value is garbage** — which is the whole reason
   * this field exists. A console labelling its hour axis from the campaign record
   * would print `Asia/Calcutta_typo` over columns that are in fact UTC, on
   * precisely the campaign whose zone is broken, and confidently wrong beats blank.
   *
   * ⚠️ **Never substituted.** Not UTC, not the stored `default_timezone`, and not
   * the reader's own zone — `Intl.DateTimeFormat().resolvedOptions().timeZone` is
   * the correct zone for a window-bounds caption, whose bounds ARE cut from a local
   * `Date`, and the wrong one for this axis. Two zones on one screen, and mixing
   * them is the defect this field exists to prevent. `null` or absent means the
   * axis goes unlabelled and says so.
   *
   * Row-level zones are deliberately NOT served. The cross-campaign
   * `campaign,hour_of_day` read genuinely has one zone per row and no page-level
   * label, but no named surface renders it; when one is specified, the field
   * belongs on the row beside `campaign_id`. This paragraph is the record of why
   * the gap is a decision rather than an oversight.
   */
  resolved_timezone: string | null;
  sort: AgencyGroupSort;
  order: SortOrder;
  limit: number;
  /** Groups matching scope+window BEFORE `limit`. */
  total_groups: number;
  rows: AgencyGroupRow[];
}
