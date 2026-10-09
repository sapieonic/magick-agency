import type { PoolClient } from 'pg';
import { getPool } from '@magick-agency/db';
// The `23505` predicate, matched on the CONSTRAINT NAME. A leaf module (see its
// header) so the catch arms below can ask the question without dragging config
// into the graph of every test that exercises them.
import { isUniqueViolation } from '@magick-agency/db/pg-errors';
import { createChildLogger } from '@magick-agency/observability';
import type {
  AgencyAgentSessionRecord,
  AgencyCallAttemptRecord,
  AgencyCampaignConfigColumns,
  AgencyCampaignDependent,
  AgencyCampaignRecord,
  AgencyContactInput,
  AgencyContactRecord,
  AgencyLapsedWrapupRow,
} from '../models/agency.model.js';
import { AGENCY_ATTEMPT_LIVE_STATES, AGENCY_CAMPAIGN_TERMINAL_STATUSES } from '../models/agency.model.js';
// The supervisor read surface's cursor. `KEYSET_AT_SQL` is projected
// alongside every paged row so the cursor carries `created_at` at its true
// MICROSECOND precision — see that module for why a millisecond round-trip
// silently drops rows.
import { keysetAtSql, encodeKeysetCursor, type AgencyKeysetPosition } from '@magick-agency/domain/keyset-cursor';
import type { AgencyAttemptFilters, AgencyContactFilters, PhoneFilter } from '../../agency/spine-filters.js';
import { RETRY_NO_OUTCOME } from '../../agency/spine-filters.js';
// A LEAF module by design — see its header. Importing the predicate from the
// metrics module instead would give this repository a dependency on the thing it
// exists to independently audit.
import {
  ABANDONED_ATTEMPT_PREDICATE_SQL,
  ABANDONMENT_WINDOW_HOURS,
  abandonmentRatePct,
  type AgencyAbandonmentWindowRow,
} from '@magick-agency/domain/abandonment-predicate';
// The route/repository split of the stats payload, imported rather than restated
// as a second `Omit<..., 'campaign_id' | 'status' | ...>` literal: two copies of
// "who produces what" is how one producer quietly stops owning a field.
import { AGENCY_STATS_ROUTE_FIELDS } from '@magick-agency/contracts/agency';
import type {
  AgencyCampaignLineage,
  AgencyRetryPreview,
  AgencyRetrySelector,
} from '@magick-agency/contracts/agency';
// The shared retry bounds. A leaf module, imported rather
// than restated, so the number the API publishes as `max_seed_rows` and the number
// the transaction refuses on are the same token.
import { PRIOR_ATTEMPT_LIMIT, RETRY_MAX_SEED_ROWS } from '@magick-agency/domain/retry-campaign-bounds';
// The roster's rate-reportability floor. Imported rather than restated because it
// is a SHARED number: the console renders "not enough calls" from the same
// threshold, and a second copy here is how these percentiles come to exclude a
// row the console still labels reportable.
import { AGENCY_ROSTER_MIN_RATE_DENOMINATOR } from '@magick-agency/contracts/agency';
// The window the strip's copy names, imported so the SQL and the sentence agree.
import { RECENT_FAILURE_WINDOW_MINUTES } from '../../agency/campaign-health.js';
// THE null-not-zero rate rule, in one place. Imported rather than re-expressed at
// each of the five call sites below — see the module for why a `0` on an empty
// denominator is the failure this exists to prevent.
import { ratePct, ratio } from '@magick-agency/domain/rates';
// What counts as a conversion, as SQL. A leaf module for the same reason
// `ABANDONED_ATTEMPT_PREDICATE_SQL` is one: the campaign roll-up and the agent
// record must count the SAME thing, and two spellings of a JSONB predicate is how
// two screens come to disagree about how many sales there were.
import { successDispositionSql } from '@magick-agency/domain/success-disposition';
// The agent record's parsed window, its bucket vocabulary and the ONE spelling of
// a bucket boundary. `bucketStartSql` is shared by both aggregates below so the
// attempt buckets and the occupancy buckets cannot be cut differently.
// The roster read adds its own three: the ranking rule (nulls last both ways,
// `agent_user_id` as the tiebreaker), the percentile rule, and the parsed params.
// All three are pure and live there so they can be exercised without a pool — see
// `roster()` for why the ranking cannot happen in SQL at all.
import {
  bucketStartSql,
  bucketTruncSql,
  foldOccupancy,
  groupedPageHasSingleZone,
  rosterPercentiles,
  sortRosterRows,
  zeroOccupancy,
  type AgentAttemptFilters,
  type AgentGroupedParams,
  type AgentRosterParams,
  type AgentStatsParams,
} from '../../agency/agent-record.js';
import type {
  AgencyAgentLiveState,
  AgencyAgentOccupancy,
  AgencyAgentsByState,
  AgencyAgentState,
  AgencyAgentStats,
  AgencyAgentStatsBucket,
  AgencyAgentCampaignRow,
  AgencyAbandonReason,
  AgencyAttemptOutcome,
  AgencyAttemptState,
  AgencyCampaignActor,
  AgencyCampaignStats,
  AgencyCampaignStatsBucket,
  AgencyCampaignStatsSeries,
  AgencySupervisorAgentRow,
  AgencyAttemptRow,
  AgencyContactRow,
  AgencyContactDetail,
  AgencyGroupDimension,
  AgencyGroupKey,
  AgencyGroupPage,
  AgencyGroupRow,
  AgencyGroupSort,
  AgencyKeysetPage,
  AgencyRosterAgentRow,
  AgencyRosterBenchmark,
  AgencyRosterPage,
} from '@magick-agency/contracts/agency';
// The compliance ceiling the supervisor gauge is drawn against, imported rather
// than re-declared: the abandonment auto-pause fires on the same number, and two
// copies of a regulatory threshold is how a dashboard comes to draw one line while
// the guardrail enforces another.
import { DEFAULT_ABANDONMENT_CEILING_PCT } from '../../agency/campaign-config.js';
// THE single definition of "the same number", imported rather than re-expressed.
// `DncRegistry.check` runs this on both sides of its comparison and
// `markDnc` runs it before storing; `suppressByPhone` below must agree
// with both to the byte or it suppresses a different set of rows than the mark
// claims to have suppressed. See its own header for why a second, SQL-shaped copy
// of this rule was deliberately not written.
import { normalizeE164 } from '../../agency/dnc-registry.js';
// The campaign trend line's parsed window. Its own module rather than
// `agent-record.ts` because that one is the AGENT's record; see its header for
// what it imports rather than re-declares (the bucket vocabulary, the 92-day cap,
// the date rules).
import type { CampaignSeriesParams } from '../../agency/campaign-series.js';
// The reaper's auto-stamp for a wrap-up nobody wrote up. Imported rather than
// respelled: the supervisor dashboard's third connect bucket is defined as "NULL or this",
// and a local copy would drift from the reaper that writes it — putting every
// abandoned write-up back into the human column, which is the defect the bucket
// exists to remove. Safe to import: `disposition.ts` has type-only imports.
import { AUTO_DISPOSITION_CODE } from '../../agency/disposition.js';

const log = createChildLogger({ component: 'agency-repository' });

/** Result of applying one roster-ingest chunk. */
export interface AgencyIngestResult {
  accepted: number;
  duplicate_chunk: boolean;
  total_contacts: number;
  /**
   * Rows this chunk carried that the roster already held **exactly** — same
   * phone, same `context`, same `timezone` — and which were therefore discarded.
   *
   * Since migration 083 the identity is the row's CONTENT, not its position in
   * the file (see 083's header for why job-id namespacing is the wrong key).
   * That makes this number mean something narrower and more useful than it did:
   * not "this campaign is already populated" but "you sent us these exact people
   * again". A top-up carrying genuinely new rows now reports zero here.
   *
   * Reported rather than silently absorbed because `accepted: 0` otherwise has
   * two completely different meanings to an operator — "this chunk held no valid
   * rows" and "every row you sent was already on the roster" — and the ingest
   * job cannot tell them which if all it receives is a zero.
   *
   * Note this is **not** the same signal as `duplicate_chunk`, which means the
   * whole chunk was replayed under the same idempotency key (a retry, and
   * success). This one is a *different* job carrying rows we already hold — the
   * shape a re-upload after a server restart takes (the ingest job mints a fresh
   * job id on every run), and the case the row-level index carries alone.
   */
  rejected_duplicate_rows: number;
  /**
   * The `source_row_number`s of the discarded rows, capped — enough for the
   * ingest summary to name them without an unbounded payload on a 1M-row
   * campaign. When `rejected_duplicate_rows` exceeds the cap, this is a sample, not
   * the set. Rows carrying no row number are counted above but cannot be named
   * here.
   */
  duplicate_source_rows: number[];
  /**
   * Set (and only ever `true`) when this is a REPLAY of a chunk applied before
   * migration 084, whose rejection counts were therefore never recorded.
   *
   * **`rejected_duplicate_rows: 0` alongside this flag means "unknown", not
   * "none".** That reading matters: a replay that reported a confident zero
   * would make the operator's ingest summary undercount what the original
   * application refused. It can never overcount.
   *
   * Absent on every other response — every fresh application, and every replay of
   * a chunk applied from 084 onward, where the recorded number (including a
   * recorded 0) is exact. Absence therefore means "these counts are trustworthy",
   * which is the fail-safe default: a reader that ignores the flag never
   * mistrusts good counts.
   *
   * Deliberately a separate boolean rather than making `rejected_duplicate_rows`
   * nullable — the ingest job (`agency-ingest.service.ts`) sums that field as a
   * number into the summary the console renders, so widening its type would
   * break both. This adds surface instead of changing it.
   */
  rejection_counts_unavailable?: boolean;
}

/**
 * How many colliding row numbers to name back. A sample, not the set.
 *
 * Bounds what is STORED as well as what is returned (migration 084): the sample is
 * persisted on the chunk marker so a replay can reproduce it, and an unbounded
 * array on a table holding one row per 500-row chunk of every roster ever uploaded
 * is not something to write down.
 */
const MAX_REPORTED_DUPLICATE_ROWS = 20;

/**
 * "This roster row's number, digits only" — the PREFILTER for
 * {@link AgencyContactRepository.suppressByPhone}, and nothing more.
 *
 * ⚠️ It is **not** a normalizer and must never be used as one. Every string
 * `normalizeE164` accepts is made of digits plus characters this drops, so a row
 * that normalizes to a given number always survives this filter — the converse
 * does not hold (`1a4155550100` passes here and is `null` there), which is why the
 * exact decision stays in TypeScript. Being deliberately looser is what makes it
 * safe: a prefilter that could reject a real match would be a fail-open.
 *
 * A literal fragment with no interpolated input, and it must stay byte-identical
 * to the expression indexed by `idx_agency_contacts_campaign_phone_digits`
 * (migration 087) — Postgres matches expression indexes structurally, so a stray
 * space or a `'[^\d]'` spelling costs the index and turns an agent's button press
 * into a scan of every contact in the campaign, silently.
 */
const CONTACT_PHONE_DIGITS_SQL = "regexp_replace(phone_e164, '[^0-9]', '', 'g')";


/**
 * The wrap-up resolutions that are evidence of how long wrap-up TAKES.
 *
 * `disposition_submitted` (the agent finished and said so), `auto_return` (the
 * agent used the whole window — the one that says the allotment is too short) and
 * `agent_returned` (the agent finished early and went available without a
 * disposition, the fastest wrap-ups there are). `forced`, `agent_left` and
 * `campaign_stopped` are excluded: each measures a supervisor's patience, an
 * agent vanishing or a campaign ending, and all three move the average toward
 * "shorten the allotment" — the opposite of what those events mean. Migration
 * 088's header is the long form of this.
 */
const WRAPUP_MEASURED_RESOLUTIONS_SQL =
  "wrapup_resolution IN ('disposition_submitted','auto_return','agent_returned')";

/**
 * The RESOLVED campaign timezone, spelled once for the three statements that cut
 * something in it.
 *
 * Never `c.default_timezone` raw. That column is `VARCHAR(64)` with no constraint,
 * populated from customer-facing config, so it can hold anything — and
 * `some_ts AT TIME ZONE 'Mars/Olympus'` raises `22023 invalid_parameter_value`,
 * which nothing maps to a status. One campaign with a typo would therefore take out
 * every OTHER campaign's numbers in the same statement. The
 * {@link AGENCY_RESOLVED_ZONE_JOIN_SQL} that every caller carries turns that into a
 * per-row fallback: a zone Postgres will not resolve yields NULL, and this COALESCE
 * buckets those rows in UTC.
 *
 * `pg_timezone_names` carries zone NAMES, not the abbreviations in
 * `pg_timezone_abbrevs`, so a bare `IST` falls back to UTC — deliberately as strict
 * as `calling-hours.ts`'s `isUsableTimezone`, which refuses the same input.
 *
 * Shared rather than re-spelled at each site for the same reason
 * {@link AGENCY_ATTEMPT_METRICS_SQL} is: the per-agent record's buckets, its
 * occupancy intervals and the grouped read's time dimensions must fall on the SAME
 * boundaries, and three copies of one fallback is how one of them comes to bucket
 * an unresolvable zone somewhere else.
 */
const AGENCY_RESOLVED_ZONE_SQL = "COALESCE(z.name, 'UTC')";

/**
 * The join that RESOLVES that zone, in one spelling for the three statements that
 * carry it — and it is a LATERAL with `LIMIT 1` rather than a plain equi-join.
 *
 * ── Why LATERAL, when a plain LEFT JOIN read more simply ────────────────────
 *
 * The three call sites put this join inside an AGGREGATE's FROM clause, so its
 * cardinality is not a presentation detail: if `lower(z.name) = lower(...)` ever
 * matched TWO rows of `pg_timezone_names` for one campaign, that campaign's
 * attempts would be duplicated and every counter selected beside it —
 * {@link AGENCY_ATTEMPT_METRICS_SQL}'s five, and the roster's `campaigns` — would
 * double. Nothing in `pg_timezone_names` declares `lower(name)` unique; it is a
 * view over tzdata, whose contents change with the platform's zone files, so the
 * property is an assumption about data we do not own rather than a constraint we
 * enforce. No case-colliding pair is known in shipped tzdata and no failure could
 * be constructed — but `rosterAttemptTotals` has a byte-identical FROM and WHERE
 * clause EXCEPT this join, and the whole reason the metric expressions are shared
 * is that a supervisor subtracting the roster from the grouped read must get zero.
 * That property should not rest on an unasserted uniqueness claim.
 *
 * `LEFT JOIN LATERAL (… LIMIT 1) z ON true` removes the assumption outright: at
 * most one row, by construction, whatever tzdata holds. It preserves both
 * properties the plain join was carrying — a zone Postgres cannot resolve still
 * yields NULL for {@link AGENCY_RESOLVED_ZONE_SQL} to COALESCE to UTC, so one
 * campaign's typo still cannot raise `22023` and take out every other campaign's
 * numbers in the same statement.
 *
 * ⚠️ Which row `LIMIT 1` keeps is unordered, and that is deliberate rather than
 * overlooked: the only way two rows can match is a pair of names differing in case
 * alone, which are the same zone, so either row resolves to the same offsets. An
 * `ORDER BY` would be picking between two spellings of one answer.
 *
 * ✅ **EXECUTED.** No longer a claim about text: this join runs against Postgres 16
 * in `agent-stats-timezone-buckets.test.ts` (per-campaign bucketing, DST days, and
 * the unresolvable-zone fallback) and in `agent-grouped-read.test.ts` (the grouped
 * read's time dimensions, and `resolved_timezone` reading the join back out). The
 * uniqueness assumption the lateral removes was also checked directly —
 * `SELECT lower(name), count(*) FROM pg_timezone_names GROUP BY 1 HAVING count(*) > 1`
 * returns no rows on this platform's tzdata — which is evidence that no collision
 * exists today, not that none can, so the lateral stays.
 */
const AGENCY_RESOLVED_ZONE_JOIN_SQL =
  'LEFT JOIN LATERAL (SELECT z.name FROM pg_timezone_names z'
  + ' WHERE lower(z.name) = lower(c.default_timezone) LIMIT 1) z ON true';

/**
 * The FIVE metric expressions every agency attempts aggregate selects, in ONE
 * spelling.
 *
 * ── Why this is a frozen string and not a function taking aliases ────────────
 *
 * The property being protected is that a supervisor's roster line, an agent's own
 * scorecard and a grouped cell all report the SAME five numbers for the same
 * attempts — so a supervisor who subtracts one from the other gets zero. That
 * property is byte-equality of the emitted SQL, and a builder taking `attempt` /
 * `catalog` aliases could be called with different ones and emit two different
 * texts, i.e. it would hand back exactly the freedom this exists to remove. All
 * three call sites alias `agency_call_attempts` as `a` and `agency_campaigns` as
 * `c` — the joins are identical because the metrics are only defined over that
 * join — so there is nothing left to parameterise.
 *
 * Interpolated at column 14 in all three statements, which is why the
 * continuation lines carry their own indentation and the last line has no
 * trailing comma: a caller with further columns appends one.
 *
 * ── What each expression is, and the trap it avoids ─────────────────────────
 *
 * `attempts` / `connected` are plain counts; `successes` goes through
 * {@link successDispositionSql} so the campaign roll-up and every agent read
 * count the same conversion. The two durations are the ones with history, and both
 * comments below are load-bearing rather than decorative — see migration 088 and
 * the reaper.
 *
 * ⚠️ Every column is cast `::text`. That is not cosmetic: node-pg returns `bigint`
 * and `numeric` as strings anyway, and the cast makes the `::text` → `Number()`
 * hop explicit at both ends. A caller that wants to ORDER BY one of these has to
 * cast it back to `numeric` — text ordering would rank `'9'` above `'400'`.
 */
const AGENCY_ATTEMPT_METRICS_SQL = `COUNT(*)::text AS attempts,
              COUNT(*) FILTER (WHERE a.bridged_at IS NOT NULL)::text AS connected,
              COUNT(*) FILTER (WHERE a.bridged_at IS NOT NULL
                AND ${successDispositionSql({ attempt: 'a', catalog: 'c.disposition_catalog' })})::text
                AS successes,
              -- The AGENT's leg: ended_at - bridged_at, never the persisted
              -- talk_seconds column (anchored on the carrier's answer, and nonzero
              -- even when no agent bridged -- an abandoned attempt settles carrying
              -- the apology clip's talk time). Orphans are excluded: the reaper
              -- stamps ended_at at SWEEP time, so one crashed conversation would
              -- contribute its whole time-until-sweep to whichever group it lands
              -- in -- an agent's day, their roster line, or a grouped cell.
              COALESCE(SUM(EXTRACT(EPOCH FROM (a.ended_at - a.bridged_at))) FILTER (
                WHERE a.bridged_at IS NOT NULL
                  AND a.ended_at IS NOT NULL
                  AND a.outcome IS DISTINCT FROM 'orphaned'), 0)::text AS talk_seconds,
              -- MEASURED wrap-up, never the wrapup_seconds allotment copied from
              -- the campaign at wrap-up entry (migration 088: averaging that hands
              -- the operator their own setting back as if it were evidence), and
              -- only the three resolutions that are evidence of how long wrap-up
              -- takes.
              COALESCE(SUM(EXTRACT(EPOCH FROM (a.wrapup_ended_at - a.wrapup_started_at))) FILTER (
                WHERE a.wrapup_started_at IS NOT NULL
                  AND a.wrapup_ended_at IS NOT NULL
                  AND ${WRAPUP_MEASURED_RESOLUTIONS_SQL.replace('wrapup_resolution', 'a.wrapup_resolution')}), 0)::text
                AS wrapup_seconds`;

/**
 * A machine connect is an agent who sat through an answering machine, and the
 * only signal for it is the agent's own write-up: AMD is out of scope, so
 * nothing else in the system knows. Kept as one constant because the count, its
 * complement (`human_connects`) and both AHT variants must all agree on the same
 * code — a second spelling would put a voicemail in the human column and in the
 * AHT it is excluded from at the same time.
 */
const VOICEMAIL_DISPOSITION_CODE = 'voicemail';

/**
 * Does this row have enough CONNECTS behind it to quote a rate whose denominator is
 * `connected`?
 *
 * ── One spelling, because three places need exactly this comparison ─────────
 *
 * `success_rate_pct` divides by `connected` and so does `aht_seconds`, where
 * `rates_reportable` floors `attempts`. Those are different denominators, and the
 * gap between them is the whole reason this exists: a row with 400 dials and one
 * connect clears the `attempts` floor and still carries a 100% conversion built
 * from a single conversation. The three call sites are
 * {@link AgencyRosterAgentRow.success_rate_reportable},
 * {@link AgencyGroupRow.success_rate_reportable}, and `rosterBenchmark`'s
 * `success_rate` and `aht` percentile pools — which must agree, because the flag on
 * the wire is what a console uses to decide whether to print the same number the
 * pools decided was too thin to rank.
 *
 * Named rather than restated inline at each site: four textually identical copies of
 * `row.connected >= CONSTANT` are four things to change when the threshold is
 * argued about, and the one that gets missed makes the payload disagree with the
 * benchmark beside it while both claim to honour "the" minimum.
 *
 * ⚠️ This IMPLIES `rates_reportable`. `connected <= attempts` always — a connect is
 * an attempt that bridged — and `rates_reportable` IS `attempts >= ` the same
 * constant, so this predicate is strictly stronger and never true where that flag
 * is false. That is what lets a consumer gate on the stronger flag ALONE, and it is
 * why the percentile pools' `rated` prefilter is (harmlessly) redundant for these
 * two metrics.
 */
const hasRateDenominator = (row: { connected: number }): boolean =>
  row.connected >= AGENCY_ROSTER_MIN_RATE_DENOMINATOR;

/**
 * A `TIMESTAMPTZ` as an ISO instant, degrading to the epoch rather than throwing.
 *
 * `state_since` is `NOT NULL`, so the fallback is unreachable through the schema —
 * but `new Date(undefined).toISOString()` throws a `RangeError`, and the whole
 * supervisor dashboard 500ing because one roster row carried an unexpected value
 * is a far worse outcome than one agent tile being wrong. The epoch is chosen over
 * `now()` deliberately: it renders as an implausibly long time-in-state and sorts
 * to the TOP of the console's risk ordering, so the bad row is the first thing the
 * supervisor sees instead of the one that looks freshest.
 */
const isoOrEpoch = (value: Date | string): string => {
  const at = value instanceof Date ? value : new Date(value);
  return Number.isNaN(at.getTime()) ? new Date(0).toISOString() : at.toISOString();
};

/** Every live state at zero. See {@link AgencyAgentsByState}. */
const zeroAgentsByState = (): AgencyAgentsByState => ({
  offline: 0,
  available: 0,
  reserved: 0,
  on_call: 0,
  wrapup: 0,
  break: 0,
});

// ─── Supervisor read surface — shared paging machinery ────────────

/**
 * Positional-parameter accumulator.
 *
 * The two list reads below build their WHERE clause from an optional filter set,
 * so parameter numbering cannot be written by hand without the numbers and the
 * values drifting apart the first time a filter is inserted in the middle. This
 * makes `$n` and the value one operation.
 */
function params(): { values: unknown[]; add: (value: unknown) => string } {
  const values: unknown[] = [];
  return {
    values,
    add(value: unknown): string {
      values.push(value);
      return `$${values.length}`;
    },
  };
}

/**
 * The phone predicate, in whichever of its two forms the caller meant.
 *
 * ── Both forms compare DIGITS, not the stored string ────────────────────────
 * `phone_e164` is `VARCHAR(20)` with no format constraint, and the roster is
 * built from customer CSVs — `+91 98765 43210` and `+919876543210` are the same
 * number and both occur. Comparing the raw column would answer "no such
 * contact" for a number that is plainly there, on a route someone reaches from a
 * complaint holding the number in whatever shape they were given it.
 *
 * The expression is `CONTACT_PHONE_DIGITS_SQL`, reused rather than respelled so
 * it stays byte-identical to `idx_agency_contacts_campaign_phone_digits`
 * (migration 087) — Postgres matches expression indexes structurally, so a
 * different spelling of the same regex silently costs the index. With the
 * campaign predicate that makes the EXACT form an index scan.
 *
 * The SUFFIX form — "the last four digits", the useful partial shape, since
 * every stored value begins with a country code — is served by migration 095's
 * `idx_agency_contacts_phone_suffix`, which indexes the REVERSED digits: a
 * suffix search on a string is a prefix search on its reverse. Written naively
 * as `LIKE '%1234'` it was a 289ms parallel sequential scan of a 1M-row
 * campaign; through that index it is 1.0ms.
 *
 * `alias` is the table holding `phone_e164` — `agency_contacts` in both reads,
 * reached through a join on the attempts side. Aliasing does not affect index
 * matching: the planner compares parsed expressions, not text.
 */
function phoneCondition(
  filter: PhoneFilter,
  alias: string,
  p: ReturnType<typeof params>,
): string {
  const digits = CONTACT_PHONE_DIGITS_SQL.replace('phone_e164', `${alias}.phone_e164`);
  // Re-stripped here, not trusted from the caller. `parsePhoneFilter` already
  // does it, but this is the only place a `%` or `_` could become a LIKE
  // wildcard, and the consequence is not an error — it is a filter that matches
  // MORE than it says. `LIKE '%%'` returns the whole campaign under a chip
  // reading "phone: %", which is a wider answer presented as a narrower one.
  //
  // ⚠️ A digit-less term is refused HERE as a backstop only. The route path can
  // no longer reach this branch — `parsePhoneFilter` reports `'unusable'` and
  // the route answers 400 — and that ordering matters: this function is only
  // called once a filter object EXISTS, so a parser that folded "unusable" into
  // "absent" would drop the predicate entirely and never arrive here at all.
  // The guard reads like the protection and the parser is where it lives.
  const term = filter.value.replace(/\D/g, '');
  if (term.length === 0) return 'FALSE';
  if (filter.mode === 'exact') {
    // The `+` was stripped by the parser; the indexed expression holds digits only.
    return `${digits} = ${p.add(term)}`;
  }
  // A suffix search on the number is a PREFIX search on its reverse, which is
  // what `idx_agency_contacts_phone_suffix` (migration 095) indexes. Written as
  // `LIKE 'x%'` rather than a hand-rolled range so the planner does the
  // `~>=~ / ~<~` rewrite itself — getting the upper bound wrong by hand is a
  // silently short result set. The literal `%` is appended in SQL, so the
  // parameter carries no wildcard and a `%` typed into the search box is data.
  return `reverse(${digits}) LIKE ${p.add(reverseString(term))} || '%'`;
}

/** Reverse a string of digits — the search term, to match the reversed column. */
function reverseString(value: string): string {
  return value.split('').reverse().join('');
}

/**
 * ─── THE ONE PLACE A CONTACT FILTER BECOMES SQL ─────────────────────────────
 *
 * Two callers, and they must never disagree:
 *
 *  - {@link AgencyContactRepository.listForCampaign} — the supervisor's Contacts
 *    tab, which is where a retry selection is authored.
 *  - {@link retrySelectionConditions} — the predicate that seeds a retry
 *    campaign's roster, and the predicate that counts it for the preview.
 *
 * **This is the same single-definition rule `ABANDONED_ATTEMPT_PREDICATE_SQL`
 * exists for, applied to a filter instead of a fact.** The supervisor narrows the
 * contacts list until it shows the rows they mean, presses "Retry these
 * contacts", and the filter they were looking at becomes the selector. If the
 * list's SQL and the seeding SQL were written twice, "the rows I was looking at"
 * and "the rows that got seeded" would eventually be different sets — and the
 * failure is silent, because both counts look plausible and neither is obviously
 * the wrong one.
 *
 * Note what is NOT here: `phone`, `from` and `to`. They are contact filters and
 * `listForCampaign` appends them itself, because they are also the three the
 * retry selector deliberately refuses (a phone is a lookup, not a cohort;
 * `created_at` is when the row was ingested). Folding them in would let a future
 * caller of this function acquire them by accident, which is precisely the
 * "wider set than the one the operator chose" this whole surface guards against.
 *
 * `alias` is the table holding the columns, so the same conditions can be used
 * inside a `SELECT … FROM agency_contacts c` and inside an `INSERT … SELECT`.
 */
function contactFilterConditions(
  filters: AgencyContactFilters,
  alias: string,
  p: ReturnType<typeof params>,
): string[] {
  const conditions: string[] = [];
  if (filters.states?.length) {
    conditions.push(`${alias}.state = ANY(${p.add(filters.states)}::varchar[])`);
  }
  if (filters.suppressedReasons?.length) {
    conditions.push(`${alias}.suppressed_reason = ANY(${p.add(filters.suppressedReasons)}::varchar[])`);
  }
  if (filters.lastOutcomes?.length) {
    conditions.push(`${alias}.last_outcome = ANY(${p.add(filters.lastOutcomes)}::varchar[])`);
  }
  if (filters.lastDispositions?.length) {
    conditions.push(`${alias}.last_disposition = ANY(${p.add(filters.lastDispositions)}::varchar[])`);
  }
  return conditions;
}

/**
 * The never-retried suppression exclusion, as SQL. **Unconditional, and not driven by the selector.**
 *
 * `suppressed_reason` has four values. Two of them are never retried, whatever a
 * selector says:
 *
 *  - `dnc` — a customer's recorded request not to be contacted. Not an operator
 *    choice, so it is excluded by the query rather than by an unchecked checkbox.
 *  - `invalid` — "a bad number does not become good" is the settled rule
 *    (`DEFAULT_RETRY_POLICY.invalid`), and `resolveRetryDecision` routes
 *    `invalid` to `suppressed` BEFORE it reads any policy. Seeding those numbers
 *    into a fresh campaign is exactly the config circumvention that rule exists
 *    to prevent.
 *
 * `parseRetrySelector` already refuses a selector that NAMES either value — but
 * that refusal is the explanation, not the enforcement, and the two are different
 * things. A selector of `state: ['suppressed']` names neither and matches both,
 * which is why this arm cannot be conditional on what the selector said.
 *
 * ⚠️ **Scope, stated plainly:** the DNC list is checked at DIAL time, from
 * `dnc_entries` (decision B8), per attempt (`pre-dial-gates.ts`), so a number suppressed AFTER this roster was
 * seeded is still refused. This exclusion is about INTENT, not enforcement — it
 * stops the platform writing a roster row that says "we intend to call this
 * person", which is a different and worse artefact than a call that gets stopped.
 *
 * A literal array rather than a bound parameter: the values are this rule, not
 * input, and inlining them keeps the predicate readable in a log'd query plan.
 */
function neverSeededSuppressionSql(alias: string): string {
  // ── The `COALESCE` is NULL-safety, not defensive padding ──────────────────
  //
  // ⚠️ The obvious spelling — `${alias}.suppressed_reason = ANY('{dnc,invalid}')`
  // — is WRONG here, and it shipped. Callers use this predicate NEGATED
  // (`NOT (...)`), and `suppressed_reason` is nullable with no default
  // (073:34), so it is NULL for every contact that was never suppressed —
  // which is nearly the whole retryable roster.
  //
  // Three-valued logic then does this: `NULL = ANY(...)` is NULL, `NOT NULL` is
  // NULL, and `WHERE NULL` REJECTS the row. Measured on Postgres 16 against six
  // rows (two NULL, two suppressed for retryable reasons, one `dnc`, one
  // `invalid`): the bare form returned 2 rows, this form returns 4.
  //
  // What that cost: every ordinary retry previewed `matched: 0` and the create
  // answered `409 retry_selection_empty`, telling the supervisor to widen a
  // selection that was already as wide as it goes. The feature did not work at
  // all, and the whole suite stayed green — because the tests assert this
  // function's OUTPUT STRING rather than its meaning.
  //
  // `IS NOT DISTINCT FROM ANY(...)` reads better and is NOT valid Postgres
  // (`42601 syntax error at or near "ANY"`, confirmed against a real server).
  // `COALESCE` to a sentinel the column can never legally hold works in BOTH
  // senses this helper is used in: negated for the seed's `WHERE`, and positive
  // for the preview's `excluded` FILTERs. `claimDialable` reaches for the same
  // NULL-safety one table over (`IS DISTINCT FROM 'dnc'`) — that is the house
  // rule for this column, and this function departed from it.
  //
  // Pinned against a real database by `test/integration/agency/
  // agency-retry-seeding.test.ts`. A text assertion cannot see this class
  // of defect; do not "simplify" it back under one.
  return `COALESCE(${alias}.suppressed_reason, '') = ANY('{dnc,invalid}')`;
}

/**
 * The retry selector as a WHERE clause, over the PARENT's roster.
 *
 * ONE builder, used by the preview's count and by the commit's `INSERT … SELECT`.
 * The preview promising a count the commit does not deliver is the class of
 * defect this shares its rule with — see {@link contactFilterConditions} and
 * `ABANDONED_ATTEMPT_PREDICATE_SQL`'s header.
 *
 * Does NOT include the parent's `campaign_id`; each caller adds it, because the
 * preview and the seeding statement bind it in different positions and one of
 * them also has to bind the CHILD's id.
 */
function retrySelectionConditions(
  selector: AgencyRetrySelector,
  alias: string,
  p: ReturnType<typeof params>,
): string[] {
  // `__none__` is a MEMBER of the outcome dimension, not a dimension of its own
  // — `RETRY_OUTCOME_SELECTABLES`' docstring carries the argument. Split it out
  // before delegating, so the shared contact-filter builder (which serves the
  // shipped contacts list and must not change meaning) keeps seeing a plain
  // enum list.
  const named = (selector.last_outcome ?? []).filter((o) => o !== RETRY_NO_OUTCOME);
  const wantsNoOutcome = (selector.last_outcome ?? []).includes(RETRY_NO_OUTCOME);

  const conditions = contactFilterConditions({
    ...(selector.state ? { states: selector.state } : {}),
    ...(named.length ? { lastOutcomes: named } : {}),
    ...(selector.last_disposition ? { lastDispositions: selector.last_disposition } : {}),
    ...(selector.suppressed_reason ? { suppressedReasons: selector.suppressed_reason } : {}),
  }, alias, p);

  // OR *within* the dimension, which is what the algebra already promises for
  // every other key. The delegate has just pushed the named-outcome term, so it
  // is popped and rebuilt as one parenthesised disjunct rather than ANDed beside
  // it: `(no_answer OR no outcome)`, never `no_answer AND no outcome` — the
  // latter is the empty set, and was the shipped default.
  if (wantsNoOutcome) {
    const namedTerm = named.length ? conditions.pop() : null;
    conditions.push(
      namedTerm
        ? `(${namedTerm} OR ${alias}.last_outcome IS NULL)`
        : `${alias}.last_outcome IS NULL`,
    );
  }

  // The two dimensions that are NOT contact filters. `pending`
  // contacts on a campaign that was stopped mid-run are the single most obvious
  // retry there is, and no combination of the closed vocabularies expresses
  // "nobody ever dialled these".
  //
  // `false` is the symmetric opposite rather than a no-op — see
  // `AgencyRetrySelector.never_attempted` for why a present-but-unconstraining
  // key is the dangerous reading.
  if (selector.never_attempted === true) conditions.push(`${alias}.attempt_count = 0`);
  if (selector.never_attempted === false) conditions.push(`${alias}.attempt_count > 0`);
  if (selector.attempt_count_gte !== undefined) {
    conditions.push(`${alias}.attempt_count >= ${p.add(selector.attempt_count_gte)}`);
  }
  if (selector.attempt_count_lte !== undefined) {
    conditions.push(`${alias}.attempt_count <= ${p.add(selector.attempt_count_lte)}`);
  }

  // ── Never the contact we are calling RIGHT NOW ────────────────────────────
  //
  // Unconditional, like the suppression exclude above and for the same reason: it
  // is a property of the row, not a dimension the operator chose.
  //
  // `claimDialable` flips `state → in_flight` when an attempt starts;
  // `chargeAttempt` writes `last_outcome` and bumps `attempt_count` only when
  // the call settles. A contact whose FIRST attempt is ringing at this instant
  // is therefore `in_flight` / `last_outcome IS NULL` / `attempt_count = 0` —
  // which satisfies `__none__` (a member of the default selector) and
  // `never_attempted: true` alike. Both of those name no state, so refusing
  // `state: ['in_flight']` at parse time does not reach them; only this does.
  //
  // The same snapshot, one state later: when the campaign owes a wrap-up
  // (`requiresDisposition('connected', catalog)`), the `bridged` handler parks
  // the contact in `connected` WHILE THE CALL IS STILL LIVE and does not write
  // `last_outcome` — that lands in the `ended` handler. Mid-conversation the
  // first-attempt row is therefore `connected` / `last_outcome IS NULL` /
  // `attempt_count = 0`, which is the same `__none__` / `never_attempted`
  // match as ringing.
  //
  // A later attempt is the same live call with a DIFFERENT contact snapshot.
  // `chargeAttempt` retains the prior outcome and returns the row to `pending`;
  // `claimDialable` flips only `state`. After a retryable `no_answer`, a
  // bridged second attempt is `connected` / `last_outcome = 'no_answer'` /
  // `attempt_count = 1` — which satisfies the default selector's `no_answer`
  // member, and which a `last_outcome IS NULL` conjunct cannot see.
  // `RETRY_SELECTABLE_STATES` *allows* `connected` because post-settle wrap-up
  // (`connected` + ended attempt) is a real cohort. The discriminator is
  // therefore the live attempt row, the same predicate as
  // `uq_agency_attempt_live` (`state <> 'ended'`). Without it: pause a
  // disposition-catalog campaign, retry "everyone we did not reach", start the
  // child, and the numbers the parent's agents are talking to — first attempt
  // or later — are dialled a second time. Pause still does not hang up a
  // bridged call.
  //
  // Without the `in_flight` term: pause a campaign that is going badly, retry
  // "everyone we did not reach", start the child, and the numbers still
  // ringing on the parent are dialled a second time. `uq_agency_campaign_running`
  // does not bite — it refuses a second RUNNING campaign, and a paused parent
  // is not running, while pause does not cancel attempts already in flight.
  // The contact-state term stays: `claimDialable` flips `in_flight` before the
  // attempt row exists, and a NULL-outcome first ring matches `__none__` in
  // that window. The EXISTS covers every later state that still has a live
  // attempt, including `connected` after a prior outcome.
  //
  // Pinned against a real database, not against this string: the unit suite
  // asserts SQL TEXT and cannot see that `IS NULL` and `= 0` are both true of a
  // live first dial. That is exactly how the NULL-unsafe suppression predicate
  // survived a green suite.
  conditions.push(`${alias}.state <> 'in_flight'`);
  conditions.push(
    `NOT EXISTS (SELECT 1 FROM agency_call_attempts rla`
    + ` WHERE rla.contact_id = ${alias}.id AND rla.state <> 'ended')`,
  );
  return conditions;
}

/**
 * The keyset predicate, as a row-wise comparison.
 *
 * `(created_at, id) < ($a, $b)` rather than the expanded
 * `created_at < $a OR (created_at = $a AND id < $b)`: the row-wise form is what
 * Postgres can drive straight off a `(campaign_id, created_at DESC, id DESC)`
 * index as a single range scan. The expanded form makes the planner choose
 * between two branches and typically degenerates into a scan-and-filter over
 * every tie — and ties are ordinary here, because ingest and the attempt
 * batcher both insert in batches inside one transaction where `now()` is fixed.
 *
 * The cursor's timestamp is passed as text and cast, not as a `Date`: a `Date`
 * holds milliseconds and this column holds microseconds. See `keyset-cursor.ts`.
 */
function keysetCondition(
  position: AgencyKeysetPosition,
  alias: string,
  p: ReturnType<typeof params>,
): string {
  return `(${alias}.created_at, ${alias}.id) < (${p.add(position.at)}::timestamptz, ${p.add(position.id)}::uuid)`;
}

/**
 * Turn `limit + 1` fetched rows into a page.
 *
 * Fetching one extra row is how `next_cursor` is decided without a second query
 * and without a `COUNT`: if the extra row exists there is more to read, and the
 * cursor is minted from the LAST row that is actually returned — never from the
 * extra one, which is not on this page and whose position would skip it.
 */
function toKeysetPage<TRaw extends { cursor_at: string; id: string }, TRow>(
  raw: TRaw[],
  limit: number,
  project: (row: TRaw) => TRow,
): AgencyKeysetPage<TRow> {
  const hasMore = raw.length > limit;
  const page = hasMore ? raw.slice(0, limit) : raw;
  const last = page[page.length - 1];
  return {
    rows: page.map(project),
    next_cursor: hasMore && last ? encodeKeysetCursor({ at: last.cursor_at, id: last.id }) : null,
    limit,
  };
}

/** `Date | null` → ISO string | null, for the wire shapes. */
function iso(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

/**
 * `agency_call_attempts` row (joined to its contact and session) → the wire shape.
 *
 * Shared by the campaign-scoped and agent-scoped spines. Extracted when the second
 * one arrived rather than copied: the projection is twenty-three fields, and two
 * copies means the next field is added to one of them.
 */
function projectAttemptRow(row: AgencyCallAttemptRecord & {
  phone_e164: string; agent_user_id: string | null;
}): AgencyAttemptRow {
  return {
    id: row.id,
    campaign_id: row.campaign_id,
    contact_id: row.contact_id,
    attempt_number: row.attempt_number,
    phone_e164: row.phone_e164,
    caller_id: row.caller_id,
    agent_user_id: row.agent_user_id,
    reserved_agent_id: row.reserved_agent_id,
    state: row.state,
    outcome: row.outcome,
    disposition_code: row.disposition_code,
    // Included deliberately — see the privacy note on `AgencyAttemptRow`.
    notes: row.notes,
    callback_at: iso(row.callback_at),
    dispositioned_by_user_id: row.dispositioned_by_user_id,
    dispositioned_at: iso(row.dispositioned_at),
    dispositioned_on_behalf: row.dispositioned_on_behalf,
    webrtc_call_id: row.webrtc_call_id,
    dialed_at: iso(row.dialed_at),
    answered_at: iso(row.answered_at),
    bridged_at: iso(row.bridged_at),
    ended_at: iso(row.ended_at),
    talk_seconds: row.talk_seconds,
    wrapup_seconds: row.wrapup_seconds,
    created_at: iso(row.created_at) ?? '',
  };
}

/** `agency_contacts` row → the wire shape, minus `context`. */
function projectContactRow(row: AgencyContactRecord): AgencyContactRow {
  return {
    id: row.id,
    phone_e164: row.phone_e164,
    state: row.state,
    attempt_count: row.attempt_count,
    our_fault_attempts: row.our_fault_attempts,
    last_outcome: row.last_outcome,
    last_disposition: row.last_disposition,
    next_attempt_at: iso(row.next_attempt_at) ?? '',
    suppressed_reason: row.suppressed_reason,
    timezone: row.timezone,
    csv_line_number: row.csv_line_number,
    created_at: iso(row.created_at) ?? '',
    updated_at: iso(row.updated_at) ?? '',
  };
}

export class AgencyCampaignRepository {
  async findById(id: string): Promise<AgencyCampaignRecord | null> {
    const { rows } = await getPool().query<AgencyCampaignRecord>(
      'SELECT * FROM agency_campaigns WHERE id = $1',
      [id],
    );
    return rows[0] ?? null;
  }

  async create(input: {
    tenant_id: string; account_id: string; name: string; caller_ids: string[];
    telephony_provider?: string;
    calling_window_start?: string; calling_window_end?: string;
    calling_days?: number[]; default_timezone?: string;
    wrapup_seconds?: number; wrapup_auto_return?: boolean;
    retry_policy?: unknown; disposition_catalog?: unknown; context_display?: unknown;
    break_reasons?: unknown;
    record_calls?: boolean; analysis_profile_id?: string | null; created_by?: string | null;
    abandon_announcement_id?: string | null;
    abandonment_ceiling_pct?: number;
  }): Promise<AgencyCampaignRecord> {
    // ── Every placeholder inside a COALESCE must carry its column's type ───────
    //
    // A bare `$n` in `VALUES (...)` gets its type from the target column, which is
    // why `$1`/`$4`/`$6`/`$18`/`$20` need no help. A `$n` inside `COALESCE(...)`
    // does NOT: COALESCE resolves its own result type from its arguments alone,
    // and an untyped placeholder beside an untyped quoted literal makes both
    // `text`. Postgres then refuses to assign `text` to any column it has no
    // assignment cast to — which is exactly the 42804 that made campaign creation
    // fail outright in 1.73.1 on `calling_window_start`:
    //
    //   column "calling_window_start" is of type time without time zone
    //   but expression is of type text
    //
    // `calling_window_end` (TIME) and `calling_days` (SMALLINT[]) are the same
    // defect; the error only ever named the first column Postgres reached. The
    // other COALESCEd parameters are safe for a reason, not by luck: `$5`/`$10`
    // target VARCHAR (text→varchar is assignment-castable), `$11`/`$12`/`$17` sit
    // beside `30`/`true`/`false` which are already-typed literals that pull the
    // placeholder to integer/boolean, and `$13`–`$16` carry an explicit `::jsonb`
    // on the whole expression. `update()` is unaffected throughout: it writes
    // `col = $n`, so the column supplies the type.
    //
    // NOTE (drift): the defaults below duplicate migration 072's column defaults,
    // and `CAMPAIGN_CONFIG_COLUMN_DEFAULTS` in `src/agency/campaign-config.ts`
    // duplicates them a third time. Omitting the NULL columns from the INSERT
    // entirely and letting the DB defaults apply would collapse this copy — a
    // worthwhile follow-up, deliberately not bundled into a production hotfix.
    // If you change a default here, change it in migration 072 too.
    const { rows } = await getPool().query<AgencyCampaignRecord>(
      `INSERT INTO agency_campaigns
         (tenant_id, account_id, name, caller_ids, telephony_provider,
          calling_window_start, calling_window_end, calling_days, default_timezone,
          wrapup_seconds, wrapup_auto_return, retry_policy, disposition_catalog,
          context_display, break_reasons, record_calls, analysis_profile_id, created_by,
          abandon_announcement_id, abandonment_ceiling_pct)
       VALUES ($1,$2,$3,$4,COALESCE($5,'voicelink'),
               COALESCE($6::time,'09:00'),COALESCE($7::time,'20:00'),COALESCE($8::smallint[],'{1,2,3,4,5}'),COALESCE($9,'UTC'),
               COALESCE($10,30),COALESCE($11,true),COALESCE($12,'{}')::jsonb,COALESCE($13,'[]')::jsonb,
               COALESCE($14,'{}')::jsonb,COALESCE($15,'[]')::jsonb,COALESCE($16,false),$17,$18,
               $19, $20)
       RETURNING *`,
      [
        input.tenant_id, input.account_id, input.name, input.caller_ids,
        input.telephony_provider ?? null,
        input.calling_window_start ?? null, input.calling_window_end ?? null,
        input.calling_days ?? null, input.default_timezone ?? null,
        input.wrapup_seconds ?? null, input.wrapup_auto_return ?? null,
        input.retry_policy ? JSON.stringify(input.retry_policy) : null,
        input.disposition_catalog ? JSON.stringify(input.disposition_catalog) : null,
        input.context_display ? JSON.stringify(input.context_display) : null,
        input.break_reasons ? JSON.stringify(input.break_reasons) : null,
        input.record_calls ?? null, input.analysis_profile_id ?? null, input.created_by ?? null,
        input.abandon_announcement_id ?? null,
        // NOT a SQL COALESCE to a literal, unlike its neighbours above: the
        // column's DEFAULT and this fallback are the SAME constant, so the
        // default is applied from the one exported value rather than restated as
        // a third copy in SQL. `?? `, not `||`, so an explicit 0 would still
        // reach the CHECK and be refused rather than silently become 3.
        input.abandonment_ceiling_pct ?? DEFAULT_ABANDONMENT_CEILING_PCT,
      ],
    );
    return rows[0]!;
  }

  /**
   * What a retry selector would seed, without seeding it
   * (`GET /agency-campaigns/:id/retry/preview`). Writes nothing.
   *
   * ── One statement, and every number in it measured over one snapshot ───────
   *
   * The buckets, the matched total and the two exclusion counts all come from a
   * single scan of the parent's roster. Split across three queries they would be
   * read at three instants — and the parent may still be RUNNING while a
   * supervisor previews a retry of it, so `matched` could disagree with the sum
   * of its own buckets by however many contacts the pacing leader dispositioned
   * in between. A breakdown that does not add up to its own total is worse than a
   * slightly stale one: the reader cannot tell which of the two numbers to
   * believe.
   *
   * ── Why the exclusions are counted rather than simply not matched ──────────
   *
   * `excluded` is the never-retried suppressed rows the selector DID match. A supervisor who selects
   * "everything suppressed" and is handed 40 instead of 300 will report it as a
   * bug unless they are told the other 260 were DNC and invalid. So the
   * suppression arm is evaluated as a projection (`FILTER (WHERE …)`) rather than
   * as a predicate, and only the seedable rows feed the buckets.
   *
   * `__none__` is the literal bucket key for a NULL value, on BOTH maps. A
   * contact that was never dialled has no `last_outcome` and a contact dialled
   * without a write-up has no `last_disposition`; dropping those rows would make
   * the maps stop summing to `matched`, which is the property that makes the
   * breakdown readable at all.
   *
   * ── `seedable` is DEDUPED BY FINGERPRINT, because the commit is ────────────
   *
   * The seeding `INSERT` carries `ON CONFLICT (campaign_id, row_fingerprint) DO
   * NOTHING`, so a parent holding two byte-identical rows (same phone, context
   * and timezone — legal, the fingerprint index is per-campaign) seeds ONE. A
   * plain `COUNT(*)` here would promise the supervisor the pre-collapse number
   * and then hand them a shorter roster, and worse, the commit's own cap check
   * would 409 `retry_selection_too_large` on a selection that would have fitted:
   * 100,040 duplicated rows refuse a retry that seeds 50,020.
   *
   * `DISTINCT ON (fingerprint)` makes `matched` exactly what the INSERT writes,
   * and — because the buckets are computed from this same CTE — keeps them
   * summing to it. Deduping by counting (`COUNT(DISTINCT …)`) would break that
   * sum, since two rows sharing a fingerprint can hold different outcomes.
   * Which of the two survives is arbitrary here and arbitrary in the INSERT
   * (`DO NOTHING` keeps whichever row Postgres reaches first), so neither is
   * more correct than the other.
   *
   * `duplicates_collapsed` on the create response still reports the difference:
   * this makes the PROMISE accurate, that explains a roster that is shorter
   * than the parent's matching rows.
   */
  async retryPreview(parentId: string, selector: AgencyRetrySelector): Promise<AgencyRetryPreview | null> {
    const p = params();
    const parent = p.add(parentId);
    // THE shared builder — the same conditions the commit's INSERT will run. See
    // `retrySelectionConditions`.
    const conditions = [`c.campaign_id = ${parent}`, ...retrySelectionConditions(selector, 'c', p)];

    const { rows } = await getPool().query<{
      matched: string;
      dnc: string;
      invalid: string;
      by_last_outcome: Record<string, string> | null;
      by_last_disposition: Record<string, string> | null;
      parent_contacts_total: string | null;
      retry_generation: number | null;
    }>(
      `
      WITH selected AS (
        SELECT c.last_outcome, c.last_disposition, c.suppressed_reason,
               agency_contact_row_fingerprint(c.phone_e164, c.context, c.timezone) AS fingerprint
          FROM agency_contacts c
         WHERE ${conditions.join(' AND ')}
      ),
      seedable AS (
        SELECT DISTINCT ON (fingerprint) * FROM selected
         WHERE NOT (${neverSeededSuppressionSql('selected')})
         ORDER BY fingerprint
      )
      SELECT
        (SELECT COUNT(*)::text FROM seedable) AS matched,
        (SELECT COUNT(*)::text FROM selected WHERE suppressed_reason = 'dnc')     AS dnc,
        (SELECT COUNT(*)::text FROM selected WHERE suppressed_reason = 'invalid') AS invalid,
        -- COALESCE'd to '{}' so an empty selection serves two empty objects rather
        -- than two nulls: the console renders a breakdown either way, and a null
        -- there is a branch every consumer has to remember.
        (SELECT COALESCE(jsonb_object_agg(k, n), '{}'::jsonb) FROM (
           SELECT COALESCE(last_outcome, '__none__') AS k, COUNT(*)::text AS n
             FROM seedable GROUP BY 1) o)                                          AS by_last_outcome,
        (SELECT COALESCE(jsonb_object_agg(k, n), '{}'::jsonb) FROM (
           SELECT COALESCE(last_disposition, '__none__') AS k, COUNT(*)::text AS n
             FROM seedable GROUP BY 1) d)                                          AS by_last_disposition,
        cam.contacts_total::text AS parent_contacts_total,
        cam.retry_generation     AS retry_generation
        FROM agency_campaigns cam
       WHERE cam.id = ${parent}
      `,
      p.values,
    );

    const row = rows[0];
    // The campaign vanished between the route's ownership check and this read.
    // `null` rather than a zeroed preview, so the route answers 404 the same way
    // every other campaign read does — a preview of 0 contacts on a campaign that
    // no longer exists reads as "there is nobody left to retry".
    if (!row) return null;

    const counts = (raw: Record<string, string> | null): Record<string, number> =>
      Object.fromEntries(Object.entries(raw ?? {}).map(([k, v]) => [k, Number(v)]));

    return {
      matched: Number(row.matched),
      by_last_outcome: counts(row.by_last_outcome),
      by_last_disposition: counts(row.by_last_disposition),
      excluded: { dnc: Number(row.dnc), invalid: Number(row.invalid) },
      parent_contacts_total: Number(row.parent_contacts_total ?? 0),
      // The CHILD's generation, which is what the console is about to create.
      retry_generation: (row.retry_generation ?? 0) + 1,
      max_seed_rows: RETRY_MAX_SEED_ROWS,
    };
  }

  /**
   * Create a retry campaign and seed its roster from the parent — **all of it, or
   * none of it.**
   *
   * ── Why one transaction, and what it is protecting ────────────────────────
   *
   * The child campaign row, its contacts and its `contacts_total` commit
   * together. A half-seeded retry campaign is the worst outcome available: it
   * looks startable and dials a subset nobody chose. There is also no campaign
   * delete route in either service, so a bad partial result is not something the
   * supervisor can clean up.
   *
   * Shape follows `applyIngestChunk` — `connect`/`BEGIN`/`ROLLBACK` on any throw/
   * `release` in `finally` — because it is the same guarantee over the same
   * table and a second spelling of it is how one of them acquires a leak.
   *
   * ── The counts are taken INSIDE the transaction ───────────────────────────
   *
   * `matched` decides both 409s, and it is read under the same snapshot that
   * seeds. Reading it outside would leave a window in which the parent's pacing
   * leader disposition a contact out of (or into) the selection between the
   * decision and the INSERT — so the refusal would be about a set that no longer
   * existed, and `contacts_seeded` could exceed a cap that had just been checked.
   *
   * ── The two refusals, and why they are refusals ───────────────────────────
   *
   *  - `empty` — the selector matched nothing seedable. Nothing is created,
   *    because the alternative is a campaign the supervisor cannot start
   *    (`/start` answers `409 campaign_roster_empty`) and cannot delete. The
   *    refusal has to happen at the moment a human is present to be told, which is
   *    the argument `rosterRejected`'s own docstring makes.
   *  - `too_large` — over `RETRY_MAX_SEED_ROWS`. NOT truncated: seeding the first
   *    100 000 of 300 000 would produce exactly the "dials a subset nobody chose"
   *    campaign the single transaction exists to prevent.
   *
   * Returned as a discriminated union rather than thrown. Both are ordinary
   * answers to a well-formed request, and the route turns each into its own `409`
   * code; an exception would make the caller distinguish them by message.
   */
  async retryFromCampaign(input: {
    parent: AgencyCampaignRecord;
    name: string;
    selector: AgencyRetrySelector;
    /**
     * The MERGED, already-validated config columns: the parent's values with the
     * request's `config_overrides` applied on top.
     *
     * Merged by the ROUTE, not here, because the route is where the merged result
     * has to be run through `validateAgencyCampaignConfig` /
     * `abandonAnnouncementRejected` / `analysisProfileRejected` — a retry must
     * refuse every body `POST /` would refuse, and a config assembled below this
     * line would reach the table without meeting any of them.
     */
    config: AgencyCampaignConfigColumns;
    createdBy: string | null;
    /**
     * The caller's idempotency key, or `null` for an unkeyed create.
     *
     * Minted by the console when the retry dialog opens and passed through
     * unchanged by the route (migration 115's header has the argument): a key
     * minted per request, anywhere downstream, is a different value on the second
     * attempt and protects nothing.
     *
     * `null` means no replay protection: the route accepts a body with no
     * `idempotency_key` and creates the retry unkeyed.
     */
    idempotencyKey: string | null;
  }): Promise<
    | {
        status: 'created';
        campaign: AgencyCampaignRecord;
        contacts_seeded: number;
        /**
         * How many matched rows the seed COLLAPSED rather than copied.
         *
         * `matched - contacts_seeded`, and it is normally 0. The seed's
         * `ON CONFLICT (campaign_id, row_fingerprint) DO NOTHING` exists because a
         * parent may legitimately hold two byte-identical roster rows — the
         * fingerprint index is per-campaign — and the child collapses them to one.
         *
         * Reported rather than left to be noticed, because the preview's `matched`
         * is a PROMISE about this commit: a supervisor shown 812 and then handed a
         * campaign of 809 has no way to tell a duplicate collapse from rows lost to
         * a bug, and the difference decides whether they escalate.
         */
        duplicates_collapsed: number;
        excluded: { dnc: number; invalid: number };
      }
    /**
     * This exact key already created a campaign. **Nothing was created now**, and
     * the campaign returned is the ORIGINAL — which is what makes this idempotent
     * rather than merely a duplicate guard: the client that lost a 201 and pressed
     * the button again gets the campaign it already made, and can navigate to it.
     */
    | { status: 'replayed'; campaign: AgencyCampaignRecord }
    | { status: 'empty'; excluded: { dnc: number; invalid: number } }
    | { status: 'too_large'; matched: number }
  > {
    const pool = getPool();

    // ── Fast path: this key has already been spent ────────────────────────────
    //
    // Checked BEFORE the transaction so an ordinary retry-after-a-lost-response
    // costs one indexed SELECT rather than a connection, a BEGIN, a scan of the
    // parent's roster and a rolled-back INSERT. It is NOT the guarantee — two
    // requests racing both miss it — which is what the 23505 arm below is for.
    if (input.idempotencyKey) {
      const prior = await this.findByRetryIdempotencyKey(
        input.parent.tenant_id, input.parent.account_id, input.idempotencyKey,
      );
      if (prior) return { status: 'replayed', campaign: prior };
    }

    const client: PoolClient = await pool.connect();
    try {
      // ── REPEATABLE READ, not the default ─────────────────────────────────────
      //
      // The count that decides `empty` / `too_large` and the `INSERT … SELECT`
      // that seeds the roster are two statements over the parent's contacts, and
      // under READ COMMITTED each takes its OWN snapshot. The parent may still be
      // `running` — the design explicitly supports authoring a retry against a
      // live campaign — so its pacing leader is mutating exactly the rows being
      // counted, and the two statements could legitimately disagree:
      //
      //   * rows leave the cohort between them ⇒ `matched > 0` passes the empty
      //     check, the INSERT writes 0 rows, and the route answers 201 with
      //     `contacts_seeded: 0` — a draft campaign that cannot be started
      //     (`409 campaign_roster_empty`) and that no service can delete;
      //   * rows enter it ⇒ the seed can exceed `RETRY_MAX_SEED_ROWS`, the cap
      //     that was just checked.
      //
      // One snapshot for the whole transaction makes the decision and the write
      // agree by construction. Nothing here UPDATEs a row another writer might
      // have changed — the child campaign and its contacts are rows this
      // transaction creates — so there is no serialization-failure retry to
      // write: `40001` is unreachable on this path.
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');

      const countParams = params();
      const countConditions = [
        `c.campaign_id = ${countParams.add(input.parent.id)}`,
        ...retrySelectionConditions(input.selector, 'c', countParams),
      ];
      // `matched` counts DISTINCT FINGERPRINTS, not rows — see `retryPreview`'s
      // header for the argument. This is the number the `INSERT … ON CONFLICT`
      // below will actually write, so the cap and the empty check decide on the
      // roster that will exist rather than on the one the selector touched.
      // `matched_rows` is the pre-collapse count, kept only to report
      // `duplicates_collapsed`.
      const counted = await client.query<{
        matched: string; matched_rows: string; dnc: string; invalid: string;
      }>(
        `SELECT
           COUNT(DISTINCT agency_contact_row_fingerprint(c.phone_e164, c.context, c.timezone))
             FILTER (WHERE NOT (${neverSeededSuppressionSql('c')}))::text            AS matched,
           COUNT(*) FILTER (WHERE NOT (${neverSeededSuppressionSql('c')}))::text     AS matched_rows,
           COUNT(*) FILTER (WHERE c.suppressed_reason = 'dnc')::text                 AS dnc,
           COUNT(*) FILTER (WHERE c.suppressed_reason = 'invalid')::text             AS invalid
           FROM agency_contacts c
          WHERE ${countConditions.join(' AND ')}`,
        countParams.values,
      );
      const matched = Number(counted.rows[0]?.matched ?? 0);
      const matchedRows = Number(counted.rows[0]?.matched_rows ?? 0);
      const excluded = {
        dnc: Number(counted.rows[0]?.dnc ?? 0),
        invalid: Number(counted.rows[0]?.invalid ?? 0),
      };

      if (matched === 0) {
        await client.query('ROLLBACK');
        return { status: 'empty', excluded };
      }
      if (matched > RETRY_MAX_SEED_ROWS) {
        await client.query('ROLLBACK');
        return { status: 'too_large', matched };
      }

      // ── The child row ────────────────────────────────────────────────────
      //
      // Every placeholder is BARE — no COALESCE anywhere — and that is deliberate
      // rather than incidental. A bare `$n` in `VALUES (...)` takes its type from
      // the target column; a `$n` inside `COALESCE(...)` does not, which is the
      // 42804 that once made `POST /agency-campaigns` fail outright (see
      // `create()`'s header and `campaign-insert-param-types.test.ts`). There is
      // nothing to default here: the parent row supplies a value for every column,
      // so the defaults `create()` restates in SQL have no work to do and the
      // whole class of defect is absent rather than avoided.
      //
      // ── What is NOT copied, and why each one ────────────────────────────
      //
      // `status` (the child starts `draft` — creation and starting stay
      // separate verbs, and it side-steps `uq_agency_campaign_running` at creation
      // time rather than failing the create for a reason that has nothing to do
      // with the retry), `started_at`, `ended_at`, `completed_at`,
      // `contacts_total`, `last_transition_by_*`, `pause_reason`, `paused_at`,
      // `pause_abandonment_rate_pct`. Every one of them describes THE PARENT'S
      // RUN. "Copy the config columns" applied naively would carry a stale
      // auto-pause record onto a campaign that has never dialled.
      //
      // `status` is omitted from the column list entirely rather than written as
      // `'draft'`: 072's DEFAULT is `draft`, and naming it here would be a second
      // copy of that default with nothing keeping the two in step.
      const created = await client.query<AgencyCampaignRecord>(
        `INSERT INTO agency_campaigns
           (tenant_id, account_id, name, caller_ids, telephony_provider,
            calling_window_start, calling_window_end, calling_days, default_timezone,
            wrapup_seconds, wrapup_auto_return, retry_policy, disposition_catalog,
            context_display, break_reasons, record_calls, analysis_profile_id, created_by,
            abandon_announcement_id, abandonment_ceiling_pct,
            parent_campaign_id, root_campaign_id, retry_generation, retry_selector,
            retry_idempotency_key)
         VALUES ($1,$2,$3,$4,$5,
                 $6,$7,$8,$9,
                 $10,$11,$12::jsonb,$13::jsonb,
                 $14::jsonb,$15::jsonb,$16,$17,$18,
                 $19,$20,
                 $21,$22,$23,$24::jsonb,
                 $25)
         RETURNING *`,
        [
          input.parent.tenant_id, input.parent.account_id, input.name,
          input.config.caller_ids, input.config.telephony_provider,
          input.config.calling_window_start, input.config.calling_window_end,
          input.config.calling_days, input.config.default_timezone,
          input.config.wrapup_seconds, input.config.wrapup_auto_return,
          JSON.stringify(input.config.retry_policy ?? {}),
          JSON.stringify(input.config.disposition_catalog ?? []),
          JSON.stringify(input.config.context_display ?? {}),
          JSON.stringify(input.config.break_reasons ?? []),
          input.config.record_calls, input.config.analysis_profile_id, input.createdBy,
          input.config.abandon_announcement_id, input.config.abandonment_ceiling_pct,
          input.parent.id,
          // The chain head. A generation-0 parent carries NULL here (migration 111
          // deliberately does not stamp itself), so the child of a first retry gets
          // the parent's own id and every deeper generation inherits it unchanged.
          input.parent.root_campaign_id ?? input.parent.id,
          input.parent.retry_generation + 1,
          // The selector as a RECORD, never re-executed. Stored normalised
          // (see `parseRetrySelector`) so the agent's banner can be rendered from
          // it without re-parsing against a catalog it was not validated against.
          JSON.stringify(input.selector),
          // Migration 115. NULL for an unkeyed caller, which the partial unique
          // index treats as no constraint at all.
          input.idempotencyKey,
        ],
      );
      const campaign = created.rows[0]!;

      // ── The roster, in ONE statement ─────────────────────────────────────
      //
      // ⚠️ `source_row_number` IS DELIBERATELY NOT IN THIS COLUMN LIST, for the
      // same reason it is absent from `applyIngestChunk`'s (085): 073's
      // `uq_agency_contacts_source_row` is still live and partial on
      // `source_row_number IS NOT NULL`, so a row that stores NULL sits outside it.
      // Writing it here would make two seeded rows that happened to share a CSV
      // line number collide on an index this INSERT does not name — a 23505 that
      // aborts the whole transaction rather than being swallowed. `csv_line_number`
      // carries the provenance instead, and it is unindexed.
      //
      // `row_fingerprint` is recomputed by the SAME SQL function the ingest path
      // uses, from the copied values, so "the same roster row" has ONE definition
      // across both seeding paths. `ON CONFLICT` names that index rather than being
      // bare, so only a content collision is swallowed and a genuine constraint
      // problem still throws — and the collision it swallows is real: a parent may
      // legitimately hold two byte-identical rows (the fingerprint index is
      // per-campaign, and a pre-083 row carries NULL and sits outside it), which
      // would otherwise 23505 the transaction.
      //
      // ── The omitted columns are the retry reset ─────────────────────────
      //
      // `state`, `attempt_count`, `our_fault_attempts`, `next_attempt_at`,
      // `last_outcome`, `last_disposition` and `suppressed_reason` are all absent
      // and take their column defaults — `pending`, `0`, `0`, `now()`, NULL, NULL,
      // NULL. A retry campaign is a FRESH ALLOWANCE, which is the whole point of a
      // supervisor authoring one.
      //
      // ⚠️ That includes `our_fault_attempts`, which is bounded by
      // `OUR_FAULT_REDIAL_BOUND` — a regulated repeat-dial limit no campaign config
      // can raise — and which therefore DOES reset per retry campaign. Three retry
      // campaigns is nine our-fault redials on one number. The bound exists to stop
      // one broken agent workstation redialling without limit inside a single run,
      // which a supervisor deliberately authoring a second campaign is not; but it
      // is now technically reachable, and it is left as an open compliance
      // decision rather than quietly settled here. Do not "fix" it by carrying the
      // counter across — that is a decision about a regulation nobody has
      // established, not an implementation detail.
      //
      // `root_contact_id` is passed through explicitly, which is what makes a
      // generation-3 contact still point at generation 0; migration 112's trigger
      // only fires when the column arrives NULL, so it leaves these rows alone.
      const seedParams = params();
      const childId = seedParams.add(campaign.id);
      const seedConditions = [
        `c.campaign_id = ${seedParams.add(input.parent.id)}`,
        ...retrySelectionConditions(input.selector, 'c', seedParams),
        `NOT (${neverSeededSuppressionSql('c')})`,
      ];
      const seeded = await client.query(
        `INSERT INTO agency_contacts
           (campaign_id, tenant_id, account_id, phone_e164, context, timezone,
            csv_line_number, row_fingerprint, source_contact_id, root_contact_id)
         SELECT ${childId}, c.tenant_id, c.account_id, c.phone_e164, c.context, c.timezone,
                c.csv_line_number,
                agency_contact_row_fingerprint(c.phone_e164, c.context, c.timezone),
                c.id,
                c.root_contact_id
           FROM agency_contacts c
          WHERE ${seedConditions.join(' AND ')}
         ON CONFLICT (campaign_id, row_fingerprint) WHERE row_fingerprint IS NOT NULL
           DO NOTHING`,
        seedParams.values,
      );

      // Recomputed by COUNT rather than set to `seeded.rowCount`, matching
      // `applyIngestChunk`: the column's meaning is "how many rows are on this
      // roster", and deriving it from the same statement that wrote them is how it
      // stays true if a later path ever adds rows too.
      const seededRows = seeded.rowCount ?? 0;

      const totalled = await client.query<AgencyCampaignRecord>(
        `UPDATE agency_campaigns
            SET contacts_total = (SELECT COUNT(*) FROM agency_contacts WHERE campaign_id = $1),
                updated_at = now()
          WHERE id = $1
        RETURNING *`,
        [campaign.id],
      );

      await client.query('COMMIT');
      return {
        status: 'created',
        // The row AFTER the `contacts_total` write, not `created.rows[0]` — that one
        // still says 0, and it is what the route serialises straight back to the
        // console as the new campaign. `RETURNING *` rather than a second SELECT so
        // there is no window in which the two could disagree.
        campaign: totalled.rows[0] ?? campaign,
        contacts_seeded: seededRows,
        // Under REPEATABLE READ both numbers come from ONE snapshot, so this is a
        // real count of collapsed duplicates and never a race between two reads.
        // `Math.max(…, 0)` is belt and braces: negative would mean the seed wrote
        // rows the count did not match, which is a defect rather than a number to
        // publish.
        duplicates_collapsed: Math.max(matchedRows - seededRows, 0),
        excluded,
      };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => { /* connection already broken */ });

      // ── The race the fast path cannot close ─────────────────────────────────
      //
      // Two requests carrying one key can both miss the pre-check and reach the
      // INSERT; the unique index lets exactly one through and answers the other
      // `23505`. That loser has created NOTHING (the whole transaction is rolled
      // back above), so the correct answer is the winner's campaign — the same
      // answer the fast path gives, arrived at a few milliseconds later.
      //
      // Matched on the CONSTRAINT NAME, never on the message text: another unique
      // index on this table (a future one, or `uq_agency_campaign_running` if the
      // shape of this statement ever changes) must not be silently reported as a
      // successful replay of somebody else's campaign.
      if (input.idempotencyKey && isUniqueViolation(err, 'uq_agency_campaign_retry_idempotency')) {
        const winner = await this.findByRetryIdempotencyKey(
          input.parent.tenant_id, input.parent.account_id, input.idempotencyKey,
        );
        // The row must exist — we just collided with it — but a `null` here would
        // mean the winner was deleted between the collision and this read, and
        // inventing a campaign to return would be worse than surfacing the error.
        if (winner) return { status: 'replayed', campaign: winner };
      }
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * The campaign a spent retry idempotency key already created, if any.
   *
   * Scoped to tenant AND account, matching the index's scope (migration 115).
   * Both halves matter and for different reasons: a key from another tenant is a
   * different intent that happens to collide, and a key from a sibling ACCOUNT is
   * a different customer's desk — answering it with this row would hand that
   * account's caller IDs, name and selector to a caller who may not read them,
   * and would refuse them a retry of their own. The caller passes the PARENT's
   * tenant and account, and the parent reached this call through `requireOwned`,
   * so those are the authenticated caller's own scope rather than a hint.
   */
  async findByRetryIdempotencyKey(
    tenantId: string,
    accountId: string,
    key: string,
  ): Promise<AgencyCampaignRecord | null> {
    const { rows } = await getPool().query<AgencyCampaignRecord>(
      `SELECT * FROM agency_campaigns
        WHERE tenant_id = $1 AND account_id = $2 AND retry_idempotency_key = $3`,
      [tenantId, accountId, key],
    );
    return rows[0] ?? null;
  }

  /**
   * Every pass of one campaign — `GET /agency-campaigns/:id/lineage`.
   *
   * ── `COALESCE(root_campaign_id, id)`, on BOTH sides ───────────────────────
   *
   * Migration 111 deliberately leaves `root_campaign_id` NULL on a generation-0
   * campaign (stamping it would need a trigger on `agency_campaigns` or a backfill
   * that restamps `updated_at` on every row, and unlike the contacts case this
   * read is not on the dial hot path). So the chain head is
   * `COALESCE(root_campaign_id, id)` — for the campaign the caller named AND for
   * every candidate row — and spelling it only on one side silently returns a
   * chain of one for every parent.
   *
   * ── A campaign in no chain answers with ITSELF, not a 404 ─────────────────
   *
   * `COALESCE(root, id) = own id` matches the row itself, so the ordinary case
   * falls out of the same query with no branch. The supervisor's header renders
   * this strip unconditionally; a 404 would make the console branch on a
   * distinction the payload already carries in its length.
   *
   * Tenant- and account-scoped like every other campaign read, and the scoping is
   * what bounds the scan: there is no index on `root_campaign_id` (111's header
   * says why — an account holds campaigns in the hundreds and an expression
   * comparison would not use one anyway).
   */
  async campaignLineage(
    tenantId: string,
    accountId: string,
    campaignId: string,
  ): Promise<AgencyCampaignLineage | null> {
    const { rows } = await getPool().query<{
      id: string;
      name: string;
      status: AgencyCampaignRecord['status'];
      retry_generation: number;
      parent_campaign_id: string | null;
      contacts_total: number;
      created_at: Date;
      started_at: Date | null;
      ended_at: Date | null;
      root_campaign_id: string;
    }>(
      `WITH anchor AS (
         SELECT COALESCE(root_campaign_id, id) AS root
           FROM agency_campaigns
          WHERE id = $1 AND tenant_id = $2 AND account_id = $3
       )
       SELECT c.id, c.name, c.status, c.retry_generation, c.parent_campaign_id,
              c.contacts_total, c.created_at, c.started_at, c.ended_at,
              a.root AS root_campaign_id
         FROM agency_campaigns c, anchor a
        WHERE COALESCE(c.root_campaign_id, c.id) = a.root
          AND c.tenant_id = $2 AND c.account_id = $3
        ORDER BY c.retry_generation, c.created_at`,
      [campaignId, tenantId, accountId],
    );

    // Empty means the anchor matched nothing — the campaign was deleted between
    // the route's ownership check and this read. It cannot mean "a campaign with
    // no chain", because such a campaign is its own chain of one.
    const root = rows[0]?.root_campaign_id;
    if (!root) return null;

    return {
      root_campaign_id: root,
      campaigns: rows.map((row) => ({
        id: row.id,
        name: row.name,
        status: row.status,
        retry_generation: row.retry_generation,
        parent_campaign_id: row.parent_campaign_id,
        contacts_total: row.contacts_total,
        created_at: iso(row.created_at) ?? '',
        started_at: iso(row.started_at),
        ended_at: iso(row.ended_at),
      })),
    };
  }

  async list(tenantId: string, accountId: string, limit: number, offset: number): Promise<{ rows: AgencyCampaignRecord[]; total: number }> {
    const pool = getPool();
    const [list, count] = await Promise.all([
      pool.query<AgencyCampaignRecord>(
        `SELECT * FROM agency_campaigns WHERE tenant_id = $1 AND account_id = $2
          ORDER BY created_at DESC, id DESC LIMIT $3 OFFSET $4`,
        [tenantId, accountId, limit, offset],
      ),
      pool.query<{ n: string }>(
        'SELECT COUNT(*)::text AS n FROM agency_campaigns WHERE tenant_id = $1 AND account_id = $2',
        [tenantId, accountId],
      ),
    ]);
    return { rows: list.rows, total: Number(count.rows[0]?.n ?? 0) };
  }

  /**
   * Patch mutable configuration. Deliberately cannot write `status` — lifecycle is
   * {@link transitionStatus} only, so a config edit can never race the pacing
   * leader's `running → completed` / `stopping → stopped` transitions.
   */
  async update(id: string, patch: Record<string, unknown>): Promise<AgencyCampaignRecord | null> {
    const allowed = new Set([
      'name', 'caller_ids', 'telephony_provider',
      'calling_window_start', 'calling_window_end', 'calling_days', 'default_timezone',
      'wrapup_seconds', 'wrapup_auto_return', 'retry_policy', 'disposition_catalog',
      'break_reasons',
      'context_display', 'record_calls', 'analysis_profile_id',
      // The abandonment ceiling is an operator setting, so it is
      // patchable on a live campaign. NOT nullable — the column is NOT NULL with
      // a DEFAULT, so "unset it" means "put it back to the default", which the
      // caller expresses by sending the default rather than by sending null.
      'abandonment_ceiling_pct',
      // The abandon announcement. Patchable, and `null` legitimately clears it back to
      // "hang up without an apology" — so this key must survive `v === undefined`
      // filtering below, which it does, and must not be defaulted anywhere.
      'abandon_announcement_id',
    ]);
    const json = new Set(['retry_policy', 'disposition_catalog', 'context_display']);
    const sets: string[] = [];
    const values: unknown[] = [id];
    for (const [k, v] of Object.entries(patch)) {
      if (!allowed.has(k) || v === undefined) continue;
      values.push(json.has(k) ? JSON.stringify(v) : v);
      sets.push(`${k} = $${values.length}${json.has(k) ? '::jsonb' : ''}`);
    }
    if (sets.length === 0) return this.findById(id);
    const { rows } = await getPool().query<AgencyCampaignRecord>(
      `UPDATE agency_campaigns SET ${sets.join(', ')}, updated_at = now() WHERE id = $1 RETURNING *`,
      values,
    );
    return rows[0] ?? null;
  }

  /**
   * Supervisor dashboard payload. Two round trips: every scalar aggregate in one
   * statement, plus the agent roster.
   *
   * **Typed against the contract on purpose.** This returned
   * `Record<string, number>` while `AgencyCampaignStats` declared three fields as
   * REQUIRED that no line here produced — `abandoned_24h`, `answered_24h` and
   * `abandonment_rate_24h_pct`. An index signature satisfies every field name, so
   * the compiler cheerfully agreed the contract was met and every consumer read
   * `undefined` off a field typed non-optional. The abandonment auto-pause is
   * specified against `abandonment_rate_24h_pct`, and `undefined > ceiling` is
   * `false` — the guardrail would have read as present in review and never fired.
   * The `Omit` is what makes a future required field a compile error here instead:
   * the route supplies `campaign_id`/`status`, this method owes the rest.
   *
   * The 24h numbers are derived **from `agency_call_attempts`, not from the
   * metric counters**: a
   * metric counter is process-local, so a regulatory window cannot be rebuilt
   * from a replica that started five minutes ago, and the counter under-reports by
   * construction (see `isAbandonedAttempt`'s header). This reads the same
   * `ABANDONED_ATTEMPT_PREDICATE_SQL` and `ABANDONMENT_WINDOW_HOURS` the audited
   * window gauge reads, imported rather than restated, so the dashboard figure and
   * the gauge cannot drift into disagreeing.
   *
   * Both 24h subqueries resolve `now()` to the same statement timestamp, so the
   * numerator can never be read against a later window than its denominator. That
   * is why every scalar aggregate — the 24h pair, the flow metrics and all six
   * `previous_hour` windows — stays in ONE statement rather than being split for
   * readability: `now()` re-resolves per statement, and a numerator measured
   * against a window one tick later than its denominator is how a rate briefly
   * exceeds 100% and trips a guardrail on arithmetic alone.
   *
   * The roster is the deliberate second statement. It is
   * set-returning and there is no honest way to fold rows into a list of scalars;
   * it also carries no rate whose halves could disagree.
   */
  async stats(
    campaignId: string,
  ): Promise<
    // `agents` is overridden rather than omitted: the repository produces the whole
    // roster, but one FIELD of each row (`connected`) is the route's, because it is
    // a Redis read. See `AGENCY_AGENT_ROUTE_FIELDS`.
    Omit<AgencyCampaignStats, (typeof AGENCY_STATS_ROUTE_FIELDS)[number] | 'agents'>
    & { agents: AgencySupervisorAgentRow[] }
  > {
    const { rows } = await getPool().query<Record<string, string>>(
      `SELECT
         (SELECT COUNT(*) FROM agency_contacts WHERE campaign_id = $1)::text AS contacts_total,
         (SELECT COUNT(*) FROM agency_contacts WHERE campaign_id = $1 AND state = 'pending')::text AS contacts_pending,
         (SELECT COUNT(*) FROM agency_contacts WHERE campaign_id = $1 AND state = 'in_flight')::text AS contacts_in_flight,
         (SELECT COUNT(*) FROM agency_contacts WHERE campaign_id = $1 AND state = 'completed')::text AS contacts_completed,
         (SELECT COUNT(*) FROM agency_contacts WHERE campaign_id = $1 AND state = 'suppressed')::text AS contacts_suppressed,
         (SELECT COUNT(*) FROM agency_contacts WHERE campaign_id = $1 AND state = 'exhausted')::text AS contacts_exhausted,
         (SELECT COUNT(*) FROM agency_contacts WHERE campaign_id = $1 AND state = 'pending' AND next_attempt_at > now())::text AS retries_pending,
         (SELECT COUNT(*) FROM agency_call_attempts WHERE campaign_id = $1 AND state <> 'ended')::text AS attempts_live,
         (SELECT COUNT(*) FROM agency_call_attempts WHERE campaign_id = $1)::text AS attempts_total,
         (SELECT COUNT(*) FROM agency_call_attempts WHERE campaign_id = $1 AND outcome = 'connected')::text AS attempts_connected,
         -- Dials that were NOT a contact's first.
         --
         -- A different question from retries_pending two lines up, and the pair
         -- is the one most likely to be read as one number: that counts contacts
         -- whose next_attempt_at is still in the future — work QUEUED — while
         -- this counts dials already PLACED. A campaign that worked its whole
         -- retry budget has retries_pending: 0 and a large attempts_retried,
         -- and reporting only the first makes it look like a campaign that reached
         -- everybody first time.
         --
         -- attempt_number is the attempts table's own counter, derived at insert
         -- from MAX(attempt_number) over the contact's rows, NOT
         -- from agency_contacts.attempt_count — the two were decoupled on
         -- purpose, and the consequence here is that an OUR-FAULT redial (a dropped
         -- station socket, a reaper requeue) is counted even though it never spent
         -- the customer's allowance. That is the honest reading of "dials that were
         -- not the first": the number was called again, whoever's fault it was.
         --
         -- dialed_at IS NOT NULL is what makes "PLACED" true, and it is not
         -- defensive: attempts are INSERTed in state 'queued' with dialed_at NULL
         -- (AgencyAttemptRepository.create), so an un-placed retry row exists by
         -- construction for the whole gap between reservation and dial — and for good
         -- on a campaign paused or stopped in that gap. Without the gate a paused
         -- campaign holding 50 queued second attempts reports attempts_retried: 50
         -- having redialled nobody. Same gate the series aggregate uses on the same
         -- table, and for the same reason it gives (see statsSeries): a dial that
         -- never happened is not a dial.
         (SELECT COUNT(*) FROM agency_call_attempts
            WHERE campaign_id = $1
              AND attempt_number > 1
              AND dialed_at IS NOT NULL)::text AS attempts_retried,
         (SELECT COUNT(*) FROM agency_agent_sessions WHERE campaign_id = $1 AND left_at IS NULL)::text AS agents_live,
         (SELECT COUNT(*) FROM agency_call_attempts
            WHERE campaign_id = $1
              AND state = 'ended'
              AND answered_at IS NOT NULL
              AND answered_at > now() - ($2 || ' hours')::interval)::text AS answered_24h,
         (SELECT COUNT(*) FROM agency_call_attempts
            WHERE campaign_id = $1
              AND answered_at > now() - ($2 || ' hours')::interval
              AND (${ABANDONED_ATTEMPT_PREDICATE_SQL}))::text AS abandoned_24h,

         -- ── Flow, over the campaign's lifetime ─────────────────────────────
         --
         -- bridged_at IS NOT NULL is the denominator gate throughout, NOT
         -- outcome = 'connected'. bridged_at is the instant media actually
         -- joined the two parties, and it is the same gate disposition.ts uses
         -- to decide whether there was a conversation to write up; outcome is a
         -- classification that can be absent, late, or say connected about a
         -- call no agent ever heard.
         --
         -- Three buckets, not two. IS DISTINCT FROM 'voicemail' is true of NULL,
         -- so a two-way split books every never-written-up call as a HUMAN connect
         -- at full duration — and that population is not small: the reaper stamps
         -- no_disposition on every lapsed wrap-up, which skews toward exactly the
         -- voicemails an agent walked away from rather than classify. The split
         -- exists so voicemail time cannot inflate the human numbers; a two-way
         -- version would have moved only the ones an agent bothered to label.
         (SELECT COUNT(*) FROM agency_call_attempts
            WHERE campaign_id = $1
              AND bridged_at IS NOT NULL
              AND disposition_code IS NOT NULL
              AND disposition_code <> $3
              AND disposition_code <> $4)::text AS human_connects,
         (SELECT COUNT(*) FROM agency_call_attempts
            WHERE campaign_id = $1
              AND bridged_at IS NOT NULL
              AND (disposition_code IS NULL OR disposition_code = $4))::text AS unclassified_connects,
         (SELECT COUNT(*) FROM agency_call_attempts
            WHERE campaign_id = $1
              AND bridged_at IS NOT NULL
              AND disposition_code = $3)::text AS machine_connects,

         -- Conversions -- the is_success flag. It is on every catalog entry,
         -- and its only other reader is a type check in the config validator:
         -- without this count the operator's answer would be confirmed as a
         -- boolean and then thrown away.
         --
         -- See successDispositionSql for the two shape decisions the predicate
         -- rests on: EXISTS rather than a JOIN (which would double-count a
         -- catalog carrying a duplicate code), and a jsonb comparison rather
         -- than a boolean cast (the cast raises 22P02 on a non-boolean value,
         -- and nothing maps that to a status -- the whole stats payload would
         -- 500 on one bad character in one operator's config).
         --
         -- bridged_at IS NOT NULL is the gate, like every other flow metric
         -- here: outcome = 'connected' is a classification that can be absent,
         -- late, or say connected about a call no agent ever heard.
         (SELECT COUNT(*) FROM agency_call_attempts a
            JOIN agency_campaigns c ON c.id = a.campaign_id
            WHERE a.campaign_id = $1
              AND a.bridged_at IS NOT NULL
              AND ${successDispositionSql({ attempt: 'a', catalog: 'c.disposition_catalog' })})::text
           AS attempts_success,
         -- Does this campaign offer the code at all? An agent cannot submit one
         -- the catalog does not carry, so without it machine_connects is
         -- structurally 0 and measures nothing — which the console has to say
         -- rather than render as a confident zero.
         (SELECT EXISTS (
            SELECT 1 FROM agency_campaigns c, LATERAL jsonb_array_elements(c.disposition_catalog) e
             WHERE c.id = $1 AND e->>'code' = $3))::text AS machine_connects_available,

         -- AHT is ended_at - bridged_at: the AGENT's leg. Deliberately not the
         -- persisted talk_seconds, which is anchored on answered_at (the
         -- carrier's answer) and is nonzero even when no agent ever bridged —
         -- an abandoned attempt settles carrying the apology clip's talk time.
         -- Averaging that would fold ring-to-bridge latency and
         -- abandoned calls into the one number whose purpose is agent work.
         -- outcome <> 'orphaned' on both: the reaper settles a crash-orphaned
         -- attempt with ended_at = now() AT SWEEP TIME, so a conversation whose
         -- replica died contributes its whole time-until-sweep — minutes, or
         -- hours — to the average. One orphan moves the tile visibly on a
         -- low-volume campaign, and the outcome column already names them.
         (SELECT AVG(EXTRACT(EPOCH FROM (ended_at - bridged_at))) FROM agency_call_attempts
            WHERE campaign_id = $1
              AND state = 'ended'
              AND bridged_at IS NOT NULL
              AND outcome IS DISTINCT FROM 'orphaned'
              AND disposition_code IS DISTINCT FROM $3)::text AS aht_seconds,
         (SELECT AVG(EXTRACT(EPOCH FROM (ended_at - bridged_at))) FROM agency_call_attempts
            WHERE campaign_id = $1
              AND state = 'ended'
              AND bridged_at IS NOT NULL
              AND outcome IS DISTINCT FROM 'orphaned')::text AS aht_seconds_including_machine,

         -- Measured wrap-up, never the configured allotment. wrapup_seconds is
         -- what was OWED, copied from the campaign at wrap-up entry, so averaging
         -- it hands the operator their own setting back as if it were evidence.
         (SELECT AVG(EXTRACT(EPOCH FROM (wrapup_ended_at - wrapup_started_at))) FROM agency_call_attempts
            WHERE campaign_id = $1
              AND wrapup_started_at IS NOT NULL
              AND wrapup_ended_at IS NOT NULL
              AND ${WRAPUP_MEASURED_RESOLUTIONS_SQL})::text AS avg_wrapup_seconds,
         -- The campaign's own ceiling. A subquery rather than a
         -- join because every other line here is one, and the row is already in
         -- cache from the route's ownership check a moment earlier.
         (SELECT abandonment_ceiling_pct FROM agency_campaigns
            WHERE id = $1)::text AS abandonment_ceiling_pct`,

      [campaignId, ABANDONMENT_WINDOW_HOURS, VOICEMAIL_DISPOSITION_CODE, AUTO_DISPOSITION_CODE],
    );
    const row = rows[0] ?? {};
    const num = (key: string): number => Number(row[key] ?? 0);
    /**
     * `null`, never `0`, for an average with nothing behind it.
     *
     * `AVG` over an empty set is SQL NULL, and the whole point of the distinction
     * is that "no wrap-up has concluded yet" and "wrap-ups take no time" are
     * different facts. `num()` would flatten both to a plausible `0` — a tile
     * reading `AHT 0s` on a campaign that has not connected anyone.
     */
    const avg = (key: string): number | null => {
      const raw = row[key];
      return raw === undefined || raw === null ? null : Number(raw);
    };

    const answered24h = num('answered_24h');
    const abandoned24h = num('abandoned_24h');
    const humanConnects = num('human_connects');
    const machineConnects = num('machine_connects');
    const unclassifiedConnects = num('unclassified_connects');
    const attemptsTotal = num('attempts_total');
    const attemptsSuccess = num('attempts_success');
    /**
     * The conversion rate's denominator: every BRIDGED attempt.
     *
     * Summed from the three connect buckets rather than read as a fourth
     * `COUNT(*) … WHERE bridged_at IS NOT NULL`. The three are disjoint and
     * exhaustive over bridged attempts by construction (`code <> voicemail AND
     * code <> no_disposition` / `code = voicemail` / `code IS NULL OR code =
     * no_disposition`), so this IS that count — and deriving it makes the payload
     * internally consistent by arithmetic instead of by two subqueries agreeing.
     * Same reasoning as `agents_by_state`, which is tallied from the roster rather
     * than read as its own `GROUP BY`: a second observation of the same rows can
     * only ever introduce a window in which they disagree.
     *
     * It is deliberately NOT `attempts_total`. A dial that rang out had no
     * conversation to convert, so counting it against the script would turn the
     * conversion rate into a measure of list quality.
     */
    const attemptsBridged = humanConnects + machineConnects + unclassifiedConnects;

    const agents = await this.supervisorAgents(campaignId);

    return {
      contacts_total: num('contacts_total'),
      contacts_pending: num('contacts_pending'),
      contacts_in_flight: num('contacts_in_flight'),
      contacts_completed: num('contacts_completed'),
      contacts_suppressed: num('contacts_suppressed'),
      contacts_exhausted: num('contacts_exhausted'),
      retries_pending: num('retries_pending'),
      attempts_live: num('attempts_live'),
      attempts_total: attemptsTotal,
      attempts_connected: num('attempts_connected'),
      // ALWAYS emitted, even though the contract types it optional: omitting it
      // would make "absent" ambiguous with "zero redials" — and
      // `campaign-stats-contract.test.ts`
      // asserts the produced key set against the field roster, so a conditional
      // spread here would red that suite rather than shipping quietly.
      attempts_retried: num('attempts_retried'),
      agents_live: num('agents_live'),
      abandoned_24h: abandoned24h,
      answered_24h: answered24h,
      // `null`, never `0`, when nothing has been answered — the single definition,
      // imported. "No calls answered yet" and "no calls abandoned" are different
      // facts, and rendering the first as a reassuring 0.0% is how a guardrail gets
      // trusted before it has measured anything.
      abandonment_rate_24h_pct: abandonmentRatePct({ answered: answered24h, abandoned: abandoned24h }),

      // ── The supervisor dashboard ──────────────────────────────────────────
      agents,
      // Tallied from the roster rather than read as its own `GROUP BY`, so the
      // breakdown and the floor beside it are the same observation of the same
      // rows — the two have identical predicates, and a second statement could
      // only ever introduce a window in which they disagree. Seeded with all six
      // states because a missing key is indistinguishable from zero to a consumer,
      // and the console renders all six.
      agents_by_state: agents.reduce<AgencyAgentsByState>((acc, agent) => {
        // Guarded rather than blind. Migration 074's CHECK and the union agree
        // today; if a seventh state is ever added to one and not the other, an
        // invented key here is one the console's exhaustive switch cannot render,
        // and the six it does promise would all still be present — so nothing
        // would look wrong. Dropping the unknown loses a count; inventing a key
        // loses the contract.
        // `Object.hasOwn`, not `in`: `in` walks the prototype chain, so a state
        // literally named `constructor` or `toString` would pass the guard and
        // then do `Object.prototype.toString + 1` → a NaN own-property on the
        // payload. Unreachable through migration 074's CHECK, but the guard did
        // not do what its comment claimed.
        if (Object.hasOwn(acc, agent.state)) acc[agent.state] += 1;
        return acc;
      }, zeroAgentsByState()),

      human_connects: humanConnects,
      machine_connects: machineConnects,
      unclassified_connects: unclassifiedConnects,
      machine_connects_available: row['machine_connects_available'] === 'true',
      connect_rate_pct: ratePct(humanConnects, attemptsTotal),
      attempts_success: attemptsSuccess,
      // `null`, never `0`, when nothing has bridged — the same imported helper
      // `abandonment_rate_24h_pct` uses, and the same distinction: "nothing has
      // converted yet" and "nothing has been dispositioned yet" are different
      // facts, and rendering the second as 0.0% is how a metric gets trusted
      // before it has measured anything.
      success_rate_pct: ratePct(attemptsSuccess, attemptsBridged),
      aht_seconds: avg('aht_seconds'),
      aht_seconds_including_machine: avg('aht_seconds_including_machine'),
      avg_wrapup_seconds: avg('avg_wrapup_seconds'),
      // The CAMPAIGN's ceiling, not the constant.
      // Serving the constant here while the guardrail fired on the column would
      // draw the dashboard's threshold in a different place from the line that
      // actually pauses the campaign — the exact drift
      // `DEFAULT_ABANDONMENT_CEILING_PCT`'s own doc comment warns about. The
      // fallback covers only a campaign row that vanished between the two reads.
      abandonment_ceiling_pct: row['abandonment_ceiling_pct'] === undefined
        || row['abandonment_ceiling_pct'] === null
        ? DEFAULT_ABANDONMENT_CEILING_PCT
        : Number(row['abandonment_ceiling_pct']),
    };
  }

  /**
   * The floor, one row per LIVE agent session on this campaign.
   *
   * Unsorted on purpose: the console orders by RISK — longest in `wrapup`, longest
   * on a break, idle longest — and those rules change with the UI, so a server-side
   * `ORDER BY` would be a second opinion the console has to undo.
   *
   * `state_since` is served as the raw instant rather than a computed duration for
   * the same reason: a tile ticks live, so a server-rendered "8m 41s" is wrong the
   * moment it arrives.
   */
  private async supervisorAgents(campaignId: string): Promise<AgencySupervisorAgentRow[]> {
    const { rows } = await getPool().query<{
      session_id: string;
      agent_user_id: string;
      state: AgencyAgentLiveState;
      state_since: Date | string;
      break_reason: string | null;
      calls_handled: string;
    }>(
      // `calls_handled` counts by `reserved_agent_id`, which is a SESSION id
      // (migration 079), so this is the attempts handled in THIS session — what
      // the floor shows, and what makes an agent who rejoined after a shift start
      // from zero rather than inheriting the morning's count.
      //
      // A LEFT JOIN so an agent who has handled nothing is still on the floor:
      // an inner join would silently hide exactly the agent a supervisor is
      // looking for.
      `SELECT s.id AS session_id,
              s.agent_user_id,
              s.state,
              s.state_since,
              -- Only while they are actually on a break. The column keeps the last
              -- reason after they return, and a stale "Lunch" beside an available
              -- agent reads as a live fact.
              CASE WHEN s.state = 'break' THEN s.break_reason END AS break_reason,
              COUNT(a.id)::text AS calls_handled
         FROM agency_agent_sessions s
         LEFT JOIN agency_call_attempts a
                ON a.reserved_agent_id = s.id
               AND a.bridged_at IS NOT NULL
        WHERE s.campaign_id = $1
          AND s.left_at IS NULL
        GROUP BY s.id, s.agent_user_id, s.state, s.state_since, s.break_reason`,
      [campaignId],
    );

    return rows.map((r) => ({
      // Already in the `GROUP BY`; it was one projection short of the wire, and the
      // omission would have surfaced as an unwireable button in the console rather than
      // as anything failing here.
      session_id: r.session_id,
      agent_user_id: r.agent_user_id,
      state: r.state,
      state_since: isoOrEpoch(r.state_since),
      break_reason: r.break_reason ?? null,
      calls_handled: Number(r.calls_handled ?? 0),
    }));
  }

  /**
   * ── THE CAMPAIGN'S TREND LINE ─────────────────────────────────────────────
   *
   * `GET /api/v1/agency-campaigns/:id/stats/series`. One row per calendar bucket
   * over `[from, to)`, cut in the campaign's own timezone, **gap-free**.
   *
   * Returns `null` for a campaign that is not in scope — which the route has
   * already checked, so in practice it means the campaign was deleted between
   * `requireOwned` and this statement. The route answers 404 either way.
   *
   * ── ONE STATEMENT, and the reason is the echoed `timezone` ─────────────────
   *
   * The spine, the aggregate and the resolved zone are all in this statement, not
   * three. `groupedStats` needs a `REPEATABLE READ` transaction to keep its
   * `resolved_timezone` honest precisely because it reads the zone in a SECOND
   * statement: on the pool, two connections are two READ COMMITTED snapshots, and
   * a `default_timezone` UPDATE committing between them makes the response report
   * a zone the buckets were never cut in. Folding everything into one statement
   * removes the failure rather than fencing it — there is no second snapshot to
   * disagree with — and it needs no client, no transaction and no isolation level.
   *
   * ── The zone is RESOLVED, and echoing the raw column would BE the bug ──────
   *
   * `AGENCY_RESOLVED_ZONE_SQL` through `AGENCY_RESOLVED_ZONE_JOIN_SQL`, the same
   * two constants every other zoned agency read carries. `default_timezone` is
   * `VARCHAR(64)` with no constraint and comes from customer-facing config, so
   * `AT TIME ZONE 'Asia/Kolkata_typo'` would raise `22023 invalid_parameter_value`
   * — which nothing maps to a status. The LATERAL join turns that into a UTC
   * fallback, and the consequence is that the STORED value and the zone the
   * buckets were actually cut in differ exactly when the stored value is garbage.
   * So `SELECT c.default_timezone` here would hand the console a broken zone name
   * to print over columns that are in fact UTC, on precisely the campaign whose
   * zone is broken. Same rule, same reason, as `resolvedCampaignZone`.
   *
   * This read is scoped to ONE campaign, so there is no per-row zone derivation
   * and none of the "a day is not 24 hours when an agent works two zones" cost the
   * agent record accepts: one campaign, one zone, every bucket contiguous.
   *
   * ── THE ZERO-FILL IS THE POINT, and it lives in SQL ────────────────────────
   *
   * `spine` is `generate_series` over the window, and `agg` is LEFT JOINed onto
   * it. A weekend therefore arrives as `attempts: 0`, never as an absent key.
   *
   * This is the one place this read deliberately DIFFERS from the per-agent
   * record, whose `buckets[]` carries only labels that had something in them (a
   * `Map` keyed on whatever the GROUP BY returned). That read is a person's own
   * record, where a missing day is usually a day they did not work. This is a
   * campaign's trend line, where a missing day is a data point: fed a gappy
   * series, a chart either draws a straight line through the hole — inventing
   * dials that did not happen — or shifts every later point one column left. "We
   * dialled nobody" and "that day was not in the response" are different facts
   * and only the first can be drawn.
   *
   * In SQL rather than filled in TypeScript because the spine has to be generated
   * in the CAMPAIGN's zone to know which labels exist: a DST day is 23 or 25 hours
   * long, and walking the range with a 24-hour step in JS would skip or duplicate
   * a label twice a year. `generate_series` over bare local timestamps steps
   * calendar units, which is the arithmetic that gets that right.
   *
   * ── The upper bound: `to - 1 microsecond` ──────────────────────────────────
   *
   * The window is half-open, so the last bucket is the one containing the greatest
   * instant STRICTLY BEFORE `to`. Generating up to `date_trunc(unit, to)` would
   * emit one bucket too many whenever `to` lands exactly on a boundary — which is
   * the ordinary case, since a console asks for whole days — and that extra bucket
   * is always all-zeros, i.e. it would render as a day the campaign did nothing on
   * a chart whose axis had not reached it. A microsecond is Postgres's own
   * timestamp resolution, so `to - interval '1 microsecond'` is exactly the
   * greatest representable instant inside the window; it is not an epsilon fudge.
   *
   * ── Both labels come from `bucketStartSql` — the SAME expression ───────────
   *
   * The spine's label and the aggregate's label are produced by one helper, which
   * is what makes the LEFT JOIN's `=` a total match rather than a coincidence of
   * two `to_char` spellings. `generate_series` yields a BARE local timestamp, so
   * the spine converts it back through `AT TIME ZONE` before handing it to
   * `bucketStartSql` (which truncates in a zone) — exactly the round-trip
   * `occupancyBuckets` performs on its own series, for exactly this reason. The
   * round trip is label-stable across DST: a nonexistent or ambiguous local
   * midnight resolves to an instant inside the same calendar day, so it truncates
   * back to the same label.
   *
   * ── The counters are `AGENCY_ATTEMPT_METRICS_SQL`, unmodified ──────────────
   *
   * The same frozen string the per-agent record, the roster and the grouped read
   * select — so a supervisor comparing a campaign's series against an agent's
   * buckets is comparing the same definition of a connect, a success, a talk
   * second and a measured wrap-up second. It also settles what these buckets sum
   * to on `AgencyCampaignStats`, which is worth being exact about because two of
   * the pairings are NOT the obvious ones:
   *
   *   * `attempts` sums to `attempts_total` RESTRICTED to attempts with a
   *     `dialed_at` in the window. `attempts_total` is a bare `COUNT(*)` with no
   *     date filter, so it also counts rows that were created and never placed;
   *     those are in no bucket, deliberately — a dial that never happened is not a
   *     dial.
   *   * `connected` sums to `human_connects + machine_connects +
   *     unclassified_connects` — every BRIDGED attempt — and **not** to
   *     `attempts_connected`, which is `outcome = 'connected'`, a classification
   *     that can be absent, late, or say connected about a call no agent ever
   *     heard. `bridged_at IS NOT NULL` is the gate every flow metric on that
   *     payload uses, and it is the one this shares.
   *   * `successes` sums to `attempts_success`: the same `successDispositionSql`
   *     predicate behind the same `bridged_at` gate.
   *   * `talk_seconds`/`wrapup_seconds` are SUMS and have no lifetime counterpart
   *     to equal — `aht_seconds` and `avg_wrapup_seconds` are averages over
   *     narrower predicates (`state = 'ended'`, voicemail excluded from the first).
   *     Documented rather than reconciled: they answer a different question.
   *
   * Bucketed on `dialed_at` and nothing else, the same choice and the same reasons
   * as `attemptBuckets` and `hourlyBuckets`: `created_at` precedes the dial by a
   * dispatch hop (so it can bucket an attempt into a day nothing was dialled in)
   * and `ended_at` pushes a call straddling midnight into the later day while
   * leaving a live one in no day at all.
   *
   * ── The scope is a predicate on the CAMPAIGN row, in both halves ───────────
   *
   * `c.tenant_id`/`c.account_id` in `camp` AND in `agg`. Redundant, because the
   * route ran `requireOwned` first and `agg` filters on the same campaign id — and
   * kept, because it is the WHERE clause that separates two accounts' campaign
   * data, and a caller reaching this method without the route's check (a future
   * route, a test) must not get an answer for someone else's campaign.
   */
  async statsSeries(
    scope: { tenantId: string; accountId: string },
    campaignId: string,
    p: CampaignSeriesParams,
  ): Promise<AgencyCampaignStatsSeries | null> {
    const zone = AGENCY_RESOLVED_ZONE_SQL;
    // Bound in the SAME ORDER as `attemptBuckets`/`occupancyBuckets`: the subject
    // selector first, then `from`, `to`, tenant, account. Those statements say the
    // same thing about themselves, and for the same reason -- these are ~5 nearly
    // identical parameter lists and a future editor will diff or copy between
    // them, so binding one value at a different position is a trap that survives
    // review and shows up as a window nobody asked for.
    const values: unknown[] = [campaignId, p.from, p.to, scope.tenantId, scope.accountId];

    const { rows } = await getPool().query<{
      bucket_start: string; timezone: string;
      attempts: string; connected: string; successes: string;
      talk_seconds: string; wrapup_seconds: string;
    }>(
      `WITH camp AS (
         -- At most one row: the primary key, plus the scope predicate. The zone is
         -- resolved here and carried down, so the label expression, the spine and
         -- the echoed field are all the same value from the same snapshot.
         SELECT ${zone} AS zone
           FROM agency_campaigns c
           ${AGENCY_RESOLVED_ZONE_JOIN_SQL}
          WHERE c.id = $1::uuid
            AND c.tenant_id = $4
            AND c.account_id = $5
       ), spine AS (
         -- THE CALENDAR, independent of whether anything was dialled on it.
         --
         -- generate_series over BARE local timestamps: date_trunc(unit, ts AT TIME
         -- ZONE tz) drops the zone, and adding interval '1 day' to a bare
         -- timestamp is exactly +24h of wall clock with no DST arithmetic, so the
         -- boundaries stay at 00:00 local through a transition. Stepping in real
         -- instants instead would drift by an hour twice a year and eventually
         -- relabel a bucket.
         --
         -- The upper bound is to minus one microsecond -- Postgres's own
         -- timestamp resolution -- because the window is half-open: generating up
         -- to date_trunc(unit, to) emits an extra all-zero bucket every time to
         -- lands on a boundary, which is the ordinary case.
         --
         -- The subtraction is PARENTHESISED, and that is not style: AT TIME ZONE
         -- binds tighter than -, so an unbracketed expression parses as
         -- $3 - (interval AT TIME ZONE zone) -- applying a zone to an interval,
         -- which is an error rather than a wrong answer, but only at run time.
         --
         -- The label round-trips the bare series value back through AT TIME ZONE
         -- so it can go through bucketStartSql, the SAME expression the aggregate
         -- labels with -- which is what makes the LEFT JOIN's = a total match
         -- rather than a coincidence of two to_char spellings. It reads as a
         -- double conversion because it is one: bare -> instant -> bare, a no-op
         -- by construction, and it is exactly what occupancyBuckets does to its
         -- own generate_series for the same reason.
         SELECT ${bucketStartSql(p.bucket, '(gs AT TIME ZONE camp.zone)', 'camp.zone')} AS bucket_start,
                camp.zone
           FROM camp,
                generate_series(
                  ${bucketTruncSql(p.bucket, '$2::timestamptz', 'camp.zone')},
                  ${bucketTruncSql(p.bucket, "($3::timestamptz - interval '1 microsecond')", 'camp.zone')},
                  interval '1 ${p.bucket}') gs
       ), agg AS (
         SELECT ${bucketStartSql(p.bucket, 'a.dialed_at', zone)} AS bucket_start,
              ${AGENCY_ATTEMPT_METRICS_SQL}
           FROM agency_call_attempts a
           JOIN agency_campaigns c ON c.id = a.campaign_id
           ${AGENCY_RESOLVED_ZONE_JOIN_SQL}
          WHERE a.campaign_id = $1::uuid
            AND c.tenant_id = $4
            AND c.account_id = $5
            AND a.dialed_at IS NOT NULL
            AND a.dialed_at >= $2
            AND a.dialed_at < $3
          GROUP BY 1
       )
       SELECT sp.bucket_start,
              sp.zone AS timezone,
              -- COALESCE on the TEXT, because AGENCY_ATTEMPT_METRICS_SQL casts
              -- every column ::text (pg returns int8/numeric as strings anyway and
              -- the cast makes the ::text -> Number() hop explicit at both ends).
              -- A '0' here is a real zero and the mapper's Number() turns it into
              -- one; the alternative -- mapping a SQL NULL in TypeScript -- would
              -- put the zero-fill in two places, and the SQL half would still be
              -- needed for the labels.
              COALESCE(g.attempts, '0')       AS attempts,
              COALESCE(g.connected, '0')      AS connected,
              COALESCE(g.successes, '0')      AS successes,
              COALESCE(g.talk_seconds, '0')   AS talk_seconds,
              COALESCE(g.wrapup_seconds, '0') AS wrapup_seconds
         FROM spine sp
         LEFT JOIN agg g ON g.bucket_start = sp.bucket_start
        ORDER BY sp.bucket_start`,
      values,
    );

    // No spine rows means `camp` matched nothing -- the campaign is not in this
    // account, or was deleted since the route's ownership check. It CANNOT mean an
    // empty window: `parseCampaignSeriesQuery` refuses `from >= to`, so every
    // accepted window generates at least one bucket. Returning an empty `buckets`
    // array here would report "this campaign dialled nobody" about a campaign that
    // does not exist.
    const zoneEchoed = rows[0]?.timezone;
    if (zoneEchoed === undefined) return null;

    const buckets: AgencyCampaignStatsBucket[] = rows.map((r) => ({
      bucket_start: r.bucket_start,
      attempts: Number(r.attempts),
      connected: Number(r.connected),
      successes: Number(r.successes),
      talk_seconds: Number(r.talk_seconds),
      wrapup_seconds: Number(r.wrapup_seconds),
    }));

    return {
      campaign_id: campaignId,
      bucket: p.bucket,
      timezone: zoneEchoed,
      buckets,
    };
  }

  /** Campaigns the pacing supervisor should be leading. */
  async findActive(): Promise<AgencyCampaignRecord[]> {
    const { rows } = await getPool().query<AgencyCampaignRecord>(
      "SELECT * FROM agency_campaigns WHERE status IN ('running','stopping') ORDER BY started_at",
    );
    return rows;
  }

  /**
   * Move a campaign to a new status. Returns the updated row, or null when the
   * `from` guard did not match — which is how the pacing leader's exclusive claim
   * on `running → completed` / `stopping → stopped` is enforced (exactly one
   * writer, no race with the supervisor's controls).
   *
   * ── The lifecycle stamps are DERIVED FROM `to`, not passed in (migration 108) ─
   *
   * `started_at` and `ended_at`/`completed_at` used to arrive as a `patch` the
   * caller assembled, and that is what made `started_at` wrong: the routes passed
   * `{ started_at: new Date() }` on `/resume` as well as `/start`, and the UPDATE
   * said `COALESCE($n, started_at)` — new value FIRST — so every resume overwrote
   * the original. A campaign that began at 09:00, paused for lunch and resumed at
   * 14:05 reported 14:05, and any elapsed-time reading of it was short by the
   * morning.
   *
   * Both are now computed here from the TARGET STATUS. That is not tidying: it
   * moves the invariant from "what four call sites remember to pass" to a property
   * of the single statement that moves a status, so a fifth transition route
   * cannot reintroduce the bug by forgetting a parameter — there is no parameter
   * to forget.
   *
   *   * `started_at` — FIRST-WRITE-WINS (`COALESCE(started_at, now())`), and only
   *     on the way INTO `running`. A resume finds a value and keeps it.
   *   * `ended_at` — first-write-wins on the way into a terminal status. Terminal
   *     is absorbing (no `from` list anywhere names `completed`/`stopped`), so the
   *     COALESCE is belt-and-braces rather than load-bearing; it costs nothing and
   *     it means a future re-open cannot silently restamp an end that happened.
   *   * `completed_at` — the LEGACY spelling of `ended_at`, written from the SAME
   *     `CASE` so the two cannot drift. See migration 108 for why it is retained
   *     rather than dropped, and why its name is wrong for a `stopped` campaign.
   *
   * `now()` rather than a JS `Date`: it is the statement timestamp, so these
   * stamps and `updated_at` are the same instant by construction instead of two
   * clocks that agree approximately.
   *
   * ── `last_transition_by_*` is written UNCONDITIONALLY ───────────────────────
   *
   * Same rule as the pause metadata below, and for the same reason: the columns
   * answer "who caused the CURRENT status", so every transition has an opinion
   * about them and "leave whatever was there" is wrong for all of them. An
   * absent `patch.last_transition_by` therefore writes NULL — which is what makes
   * `running → completed` CLEAR the supervisor who started the campaign, rather
   * than leaving them attributed to a completion the list's exhaustion caused.
   *
   * The ONE exception is `stopping → stopped`, which INHERITS the actor already on
   * the row: `stopped` is reachable only from `stopping`, and `stopping` only from
   * an operator pressing Stop, so the cause of a stopped campaign is that
   * operator. The inline comment on the CASE has the full argument.
   */
  async transitionStatus(
    id: string,
    from: readonly string[],
    to: string,
    patch: { last_transition_by?: AgencyCampaignActor | null } = {},
  ): Promise<AgencyCampaignRecord | null> {
    // Pause metadata is written UNCONDITIONALLY, never COALESCE'd, because every
    // transition has an opinion about it and "leave whatever was there" is wrong
    // for all of them. A resume that preserved `pause_reason`
    // would leave a running campaign claiming to be paused for a breach, and the
    // health strip's top-priority diagnosis reads exactly that field. Moving to
    // `paused` is a supervisor action by construction — the guardrail's own
    // pause goes through `pauseForAbandonment`, not here — so this is the one
    // place `'supervisor'` is written, and every other target clears the lot.
    const pausing = to === 'paused';
    const { rows } = await getPool().query<AgencyCampaignRecord>(
      `UPDATE agency_campaigns
          -- The cast on the assignment is LOAD-BEARING, not decoration.
          -- $3 is used twice over: as the value assigned to status (VARCHAR(20) in
          -- the baseline schema, so Postgres deduces character varying) and in the five untyped
          -- literal comparisons below, which deduce text. Without the cast the two
          -- deductions collide and the statement does not PARSE --
          -- 42P08 inconsistent types deduced for parameter $3, raised before any row
          -- is touched, i.e. every lifecycle route 500s and maybeFinalize throws on
          -- every tick. Casting the COMPARISONS to ::text instead does NOT work: it
          -- pins the parameter to text and the assignment becomes the conflicting side.
          SET status = $3::varchar,
              started_at = CASE WHEN $3 = 'running'
                                THEN COALESCE(started_at, now())
                                ELSE started_at END,
              ended_at = CASE WHEN $3 IN ('completed','stopped')
                              THEN COALESCE(ended_at, now())
                              ELSE ended_at END,
              -- The legacy spelling, from the SAME condition rather than a second
              -- one — two CASEs is how the pair comes to disagree on a status
              -- someone adds to one list and not the other (migration 108).
              completed_at = CASE WHEN $3 IN ('completed','stopped')
                                  THEN COALESCE(completed_at, now())
                                  ELSE completed_at END,
              -- Written UNCONDITIONALLY -- except for the ONE transition whose
              -- cause is on the row already.
              --
              -- stopping -> stopped is performed by the pacing leader, so it has
              -- no HTTP actor and the unconditional write would store NULL. But
              -- stopped is reachable ONLY from stopping, and stopping is
              -- reachable only from an operator pressing Stop -- so the cause of a
              -- stopped campaign IS whoever set it stopping, and that actor is
              -- sitting in these very columns. Clearing it would lose the single
              -- most useful attribution on this payload ("who stopped this
              -- campaign") to a bookkeeping transition, and it would report the
              -- stop as automatic, which is exactly what NULL is documented to
              -- deny.
              --
              -- running -> completed is the opposite case and correctly clears:
              -- nobody completed the campaign, the list ran out.
              --
              -- Expressed here rather than by having the leader read the row and
              -- re-pass the actor, for the same reason the timestamps above are
              -- derived from $3: the whole lifecycle-stamp policy stays in the
              -- one statement that moves a status, so no call site can get it
              -- wrong by omission. An actor passed FOR stopped is therefore
              -- ignored; there is no caller that can supply one.
              last_transition_by_user_id = CASE WHEN $3 = 'stopped'
                                                THEN last_transition_by_user_id
                                                ELSE $4 END,
              last_transition_by_name = CASE WHEN $3 = 'stopped'
                                             THEN last_transition_by_name
                                             ELSE $5 END,
              pause_reason = $6,
              paused_at = $7,
              pause_abandonment_rate_pct = NULL,
              updated_at = now()
        WHERE id = $1 AND status = ANY($2::varchar[])
      RETURNING *`,
      [
        id, from, to,
        patch.last_transition_by?.user_id ?? null,
        patch.last_transition_by?.name ?? null,
        pausing ? 'supervisor' : null,
        pausing ? new Date() : null,
      ],
    );
    return rows[0] ?? null;
  }

  /**
   * The SQL half of the supervisor dashboard's health strip.
   *
   * Separate from {@link stats} on purpose. `stats()` is the numbers a supervisor
   * reads; this is the evidence behind a *diagnosis*, it is only consulted when the
   * strip is being rendered, and keeping it out of `stats()` means the ~13-subquery
   * payload does not grow another five for a feature the caller may not want.
   *
   * **Pending contacts are grouped BY TIMEZONE rather than evaluated per row.**
   * Calling-hours is a TypeScript rule (`callingWindowState`), and re-expressing it
   * in SQL would be a second definition of a compliance rule — the exact mistake
   * `ABANDONED_ATTEMPT_PREDICATE_SQL` exists to prevent. Grouping is exact and
   * cheap: a roster has a handful of distinct timezones however many contacts it
   * has, so the caller evaluates the real rule a few times instead of a million.
   */
  async healthInputs(campaignId: string): Promise<{
    pendingByTimezone: Array<{ timezone: string | null; count: number }>;
    nextRetryAt: Date | null;
    lastDialAt: Date | null;
    recent: { attempts: number; failed: number };
    onBreakByReason: Record<string, number>;
  }> {
    const pool = getPool();
    const [tz, retry, dial, recent, breaks] = await Promise.all([
      // **Every pending contact, NOT only the ones due right now** — and this is
      // the whole correctness of the calling-hours diagnosis.
      //
      // The pre-dial gate DEFERS an out-of-hours contact by writing its next
      // window-open instant to `next_attempt_at` (`unclaim(contact.id,
      // gate.deferUntil)`). So a `next_attempt_at <= now()` filter here measured
      // exactly the contacts the gate had not got to yet: after one pacing pass the
      // due set is empty, the count falls to zero and the strip goes silent — the
      // overnight "0 in flight and no reason given" case it exists to explain.
      //
      // It also has to match `contacts_pending`'s population, because the assembler
      // compares the two ("is EVERYTHING waiting shut out?"). `contacts_pending` is
      // a bare `state = 'pending'` count, so a due-only numerator against it meant
      // one scheduled retry anywhere on the roster suppressed the diagnosis, before
      // deferral even entered into it. Both counts are now the same set.
      //
      // Grouping stays the point: the calling-hours rule itself is evaluated in
      // TypeScript, once per distinct timezone, never restated in SQL.
      pool.query<{ timezone: string | null; n: string }>(
        `SELECT timezone, COUNT(*)::text AS n FROM agency_contacts
          WHERE campaign_id = $1 AND state = 'pending'
          GROUP BY timezone`,
        [campaignId],
      ),
      pool.query<{ next_attempt_at: Date | null }>(
        `SELECT MIN(next_attempt_at) AS next_attempt_at FROM agency_contacts
          WHERE campaign_id = $1 AND state = 'pending' AND next_attempt_at > now()`,
        [campaignId],
      ),
      pool.query<{ dialed_at: Date | null }>(
        `SELECT MAX(dialed_at) AS dialed_at FROM agency_call_attempts WHERE campaign_id = $1`,
        [campaignId],
      ),
      // Only `failed` counts as a failure. `no_answer` and `busy` are ORDINARY
      // outcomes on a cold list — counting them would put "38% of dials failed —
      // possible carrier problem" on every healthy campaign, and a strip that
      // cries wolf on its lowest-priority diagnosis is one supervisors learn to
      // ignore. `invalid` is a data-quality fact about the roster, not the
      // carrier, and `orphaned`/`agent_disconnected` are our own faults, which
      // deserve their own diagnosis rather than being laundered as a carrier hint.
      pool.query<{ attempts: string; failed: string }>(
        `SELECT COUNT(*)::text AS attempts,
                COUNT(*) FILTER (WHERE outcome = 'failed')::text AS failed
           FROM agency_call_attempts
          WHERE campaign_id = $1
            AND dialed_at > now() - ($2 || ' minutes')::interval`,
        [campaignId, RECENT_FAILURE_WINDOW_MINUTES],
      ),
      pool.query<{ break_reason: string | null; n: string }>(
        `SELECT break_reason, COUNT(*)::text AS n FROM agency_agent_sessions
          WHERE campaign_id = $1 AND left_at IS NULL AND state = 'break'
          GROUP BY break_reason`,
        [campaignId],
      ),
    ]);

    const onBreakByReason: Record<string, number> = {};
    for (const r of breaks.rows) onBreakByReason[r.break_reason ?? 'unspecified'] = Number(r.n);

    return {
      pendingByTimezone: tz.rows.map((r) => ({ timezone: r.timezone, count: Number(r.n) })),
      nextRetryAt: retry.rows[0]?.next_attempt_at ?? null,
      lastDialAt: dial.rows[0]?.dialed_at ?? null,
      recent: {
        attempts: Number(recent.rows[0]?.attempts ?? 0),
        failed: Number(recent.rows[0]?.failed ?? 0),
      },
      onBreakByReason,
    };
  }

  /**
   * Pause a campaign because its rolling rate crossed its ceiling.
   *
   * **A conditional claim, not a read-then-write.** The abandonment refresh is a
   * per-replica `setInterval`, so every replica evaluates the same breach in the
   * same window and would otherwise each pause it, each write an audit row and
   * each raise an alert for one event. `status = 'running'` in the WHERE makes
   * exactly one of them win; the losers get zero rows and stay silent. Same idiom
   * as `transitionStatus` and `claimTerminal`.
   *
   * It also means a campaign a supervisor paused a millisecond earlier is not
   * re-paused with a different reason, and a `stopping`/`completed` campaign is
   * never dragged back to `paused`.
   *
   * `measuredPct` is stored rather than re-read later — see the column comment.
   */
  async pauseForAbandonment(
    campaignId: string,
    measuredPct: number,
  ): Promise<AgencyCampaignRecord | null> {
    const { rows } = await getPool().query<AgencyCampaignRecord>(
      `UPDATE agency_campaigns
          SET status = 'paused',
              pause_reason = 'abandonment_ceiling',
              paused_at = now(),
              pause_abandonment_rate_pct = $2,
              -- CLEARED, not left alone (migration 108). This is the one
              -- transition with no human behind it at all, so
              -- last_transition_by must read null — "we do not know who", the
              -- documented meaning. Preserving whatever was there would leave the
              -- supervisor who STARTED the campaign attributed to a pause the
              -- guardrail imposed on them, which is worse than an absent actor:
              -- it is a confident wrong answer on the row a console renders
              -- beside "paused: abandonment ceiling breached". Same reason
              -- transitionStatus writes the pair unconditionally.
              last_transition_by_user_id = NULL,
              last_transition_by_name = NULL,
              updated_at = now()
        WHERE id = $1 AND status = 'running'
      RETURNING *`,
      [campaignId, measuredPct],
    );
    return rows[0] ?? null;
  }

  /**
   * A campaign is complete when nothing is outstanding — no pending contact, none
   * in flight, none connected-but-undispositioned. Note this is genuinely
   * different from "list exhausted": `next_attempt_at` can be hours out, so the
   * supervisor dashboard shows *contacts remaining* and *retries pending*
   * separately.
   */
  async countOutstanding(campaignId: string): Promise<number> {
    const { rows } = await getPool().query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM agency_contacts
        WHERE campaign_id = $1 AND state IN ('pending','in_flight','connected')`,
      [campaignId],
    );
    return Number(rows[0]?.n ?? 0);
  }

  /**
   * The roster gate's two numbers, in one round trip (`total`, and how much of it
   * is still dialable).
   *
   * **Both are needed, because they are different operator problems.** A campaign
   * with `total = 0` was never populated and the fix is to upload a roster; a
   * campaign with `total > 0` and `dialable = 0` has been run to the end and the fix
   * is a fresh list. Reporting only "no contacts" for both sends the second operator
   * looking for an upload that already succeeded.
   *
   * `dialable` matches {@link countOutstanding}'s predicate rather than
   * `claimDialable`'s: a contact whose `next_attempt_at` is hours out is scheduled
   * work, not exhausted work, and refusing to start a campaign that is entirely in
   * retry backoff would be wrong.
   */
  async rosterCounts(campaignId: string): Promise<{ total: number; dialable: number }> {
    const { rows } = await getPool().query<{ total: string; dialable: string }>(
      `SELECT COUNT(*)::text AS total,
              COUNT(*) FILTER (WHERE state IN ('pending','in_flight','connected'))::text AS dialable
         FROM agency_contacts WHERE campaign_id = $1`,
      [campaignId],
    );
    return { total: Number(rows[0]?.total ?? 0), dialable: Number(rows[0]?.dialable ?? 0) };
  }

  /**
   * Campaigns that would break if this analysis profile stopped being usable —
   * the read half of the reference check that lets a live campaign veto removing
   * the profile it depends on.
   *
   * `agency_campaigns.analysis_profile_id` is **live configuration**: the pacing
   * engine passes it into `createBridgedCall` on every dial, which stamps it onto
   * that leg, and the end-of-call gate then resolves it with the UNSCOPED
   * `callAnalysisProfileRepository.findById`. So a profile deactivated under a
   * live campaign does not fail loudly — it keeps being resolved, and the
   * campaign goes on analysing against a definition its operator believes is
   * retired. That is the failure this predicate exists to refuse, and it is why
   * the check cannot live on the read side instead: by the time that gate runs,
   * "gone" and "retired but still resolvable" look nothing alike.
   *
   * Contrast `agency_calls.analysis_profile_id`, which carries no dependency worth
   * guarding. Note the reason carefully, because the column's own comment in the
   * baseline gets it wrong: that column IS re-read at run time —
   * `bridge-analysis-hooks.ts` resolves a profile from it at end of call. What makes it safe is that it is read exactly once, minutes after
   * intake, through the UNSCOPED `findById`, which ignores `is_active` — so a
   * concurrent retire cannot break it. The call snapshots the pre-edit version,
   * which is precisely what provenance wants.
   *
   * So the load-bearing fact is `findById`'s indifference to `is_active`, not
   * "never re-read". Anyone tightening `findById` to `is_active = true` — an
   * obvious-looking hardening — breaks BOTH referrers at once, and would be
   * reassured by the wrong version of this sentence.
   *
   * Scoped to the profile's own tenant/account on purpose. Both writers of the
   * column preflight ownership (`preflightAnalysisProfile`), so a cross-tenant
   * reference should not exist — and if one ever did, naming another tenant's
   * campaign in a refusal body would be a worse bug than the one being reported.
   *
   * **No foreign key, and this is not a stand-in for one.** The link is un-FK'd on
   * purpose — migration 072 declares `analysis_profile_id UUID` with no
   * `REFERENCES`, following the posture migration 076 set for this whole
   * subsystem — so the check is advisory by construction: a campaign committed
   * between this read and the caller's write is invisible to it. A lock has been
   * proposed for it more than once in review, so the reasons not to take one are
   * recorded here rather than re-argued each time.
   *
   * *The cost.* Closing the window means every writer of
   * `agency_campaigns.analysis_profile_id` — the campaign POST and PATCH in
   * `agency-campaigns.routes.ts` today, and every future one — taking a row lock on
   * `call_analysis_profiles` inside its own write. That is the coupling the
   * un-FK'd link exists to avoid, bought back by hand and in the harder-to-see
   * direction: a campaign write blocking on a lock held by a profile edit.
   *
   * *The size.* The window is the gap from this read to the mutation committing —
   * one round trip for the `retire`/`edit` path, two when the caller also takes the
   * inheritance count (`agencyDependencyRejected` reads both before answering).
   *
   * *What losing it actually costs, per dependency class, because the two differ
   * and an earlier version of this paragraph flattened them:*
   *
   * - **A campaign that NAMES the profile** keeps measuring exactly what it was
   *   measuring. The pacing engine stamps `analysis_profile_id` onto each leg and
   *   the end-of-call gate resolves it with the UNSCOPED `findById`, which ignores
   *   `is_active`, so the retired row still resolves in full. Nothing is corrupted
   *   and nothing is silently emptied; the guard's value here is telling the
   *   operator, not preventing a loss.
   * - **A campaign created inside the window that names NOTHING** inherits the
   *   account default that is being retired, and there is now no active default to
   *   inherit: `findDefault` filters on `is_active`, so its snapshot collapses to
   *   `{ custom_dimensions: [] }` (see
   *   {@link countLiveCampaignsInheritingAccountDefault}). That is a real
   *   degradation, and it is not what the sentence above claims. What makes it
   *   still not worth a lock is that **no lock can buy the invariant**: creating an
   *   inheriting campaign in an account with no active default is permitted, and
   *   produces the identical empty snapshot with no race involved at all. The guard
   *   protects campaigns that already exist from having the rug pulled; it never
   *   promised every future campaign a resolvable definition, and serialising these
   *   two writes would not deliver one.
   *
   * So: advisory, and losing the race lands on the behaviour that shipped before
   * this guard existed rather than on corruption. If the inheriting hole is ever
   * worth closing, the instrument is an invariant on the campaign write ("an
   * inheriting campaign requires an active account default"), not a lock on a
   * profile row from an agency route.
   *
   * **Unbounded on purpose, and bounded where it escapes.** There is no `LIMIT`
   * here because both things the caller builds from these rows have to be complete
   * to be true: the count it reports, and the status breakdown it groups. A `LIMIT`
   * would make "40 agency campaigns (1 running, 39 draft)" read "20 agency
   * campaigns (1 running, 19 draft)" — a refusal that understates itself, which is
   * worse than a long list. The list that leaves the process IS capped, at the
   * route, with the true total beside it (`DEPENDENT_SAMPLE_LIMIT` in
   * `call-analysis-profiles.routes.ts`). What remains unbounded is one
   * `{uuid, status}` row per live campaign, held briefly, on a refusal path that
   * runs only when someone edits or retires a profile. If an account ever makes
   * that hurt, the fix is to aggregate the census in SQL — `COUNT(*)` plus a
   * `GROUP BY status` plus a capped id list — not to `LIMIT` this query and let the
   * count lie.
   */
  async findLiveDependentsOnAnalysisProfile(
    profileId: string,
    tenantId: string,
    accountId: string,
  ): Promise<AgencyCampaignDependent[]> {
    const { rows } = await getPool().query<AgencyCampaignDependent>(
      `SELECT id, status
         FROM agency_campaigns
        WHERE analysis_profile_id = $1
          AND tenant_id = $2
          AND account_id = $3
          AND NOT (status = ANY($4))
        ORDER BY created_at ASC`,
      [profileId, tenantId, accountId, [...AGENCY_CAMPAIGN_TERMINAL_STATUSES]],
    );
    return rows;
  }

  /**
   * Live campaigns that name NO profile, and therefore depend on whichever one is
   * the account default.
   *
   * ── Why this is a second, separate question ────────────────────────────────
   * `analysis_profile_id` on a campaign is OPT-IN — migration 072 gives it no
   * default, so `NULL` is the ordinary case. And the end-of-call gate resolves
   * `explicit id → account default → none` (`webrtc-bridge-manager.ts`). So a
   * campaign with a NULL reference is not a campaign with no dependency; it is a
   * campaign depending on the account default, which the predicate above cannot
   * see because there is no id in the row to match on.
   *
   * That hole was the worse half of the two. In the matched case the retired row
   * still resolves through the unscoped `findById`, so the campaign carries on
   * measuring the same things; here, retiring the default leaves `findDefault`
   * (active + `is_default`) with nothing to return and the snapshot collapses to
   * `{ custom_dimensions: [] }` — analysis continuing with no context and no
   * dimensions, silently. The guard was refusing the benign path and permitting
   * the destructive one.
   *
   * ── Loss is refused; CHANGE is not ────────────────────────────────────────
   * The rule here is deliberately weaker than the one above, and the difference is
   * what the campaign actually asked for. A campaign naming a version named THAT
   * version, so replacing it silently changes what it measures and is refused. A
   * campaign naming nothing asked for "whatever the account default is" — so a new
   * default, or an edit to the current one, is inside what it requested and is
   * allowed. Only an operation that leaves the account with NO active default is
   * refused, because that is the one outcome the campaign cannot have meant.
   *
   * Concretely: `DELETE` of the default is refused, and a `PUT` that sets
   * `is_default: false` on it is refused. A `PUT` that carries the flag forward is
   * not — the successor is active and default, so the inheritance still resolves.
   * Nor is `POST` with `is_default: true`, which demotes the old default while
   * leaving it active: that is the documented way to change defaults, and refusing
   * it would make a first agency campaign permanently freeze the account's default.
   *
   * A COUNT rather than rows: the caller needs to know that inheritors exist and
   * how many, and unlike the matched case there is no per-row remedy to point at.
   *
   * ── This count is where the advisory window actually bites ────────────────
   * Read the race note on {@link findLiveDependentsOnAnalysisProfile} with this
   * method in mind: a campaign naming a profile survives a lost race intact, but
   * one created inside the window naming NOTHING lands on an account with no
   * active default and analyses against `{ custom_dimensions: [] }`. Recorded here
   * too because a reader arriving at the destructive half should not have to find
   * the note on the benign one — and because the reason it is still not a lock is
   * specific to THIS class: the same empty snapshot is reachable with no race at
   * all, by creating an inheriting campaign in an account that has no default.
   */
  async countLiveCampaignsInheritingAccountDefault(
    tenantId: string,
    accountId: string,
  ): Promise<number> {
    const { rows } = await getPool().query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
         FROM agency_campaigns
        WHERE analysis_profile_id IS NULL
          AND tenant_id = $1
          AND account_id = $2
          AND NOT (status = ANY($3))`,
      [tenantId, accountId, [...AGENCY_CAMPAIGN_TERMINAL_STATUSES]],
    );
    return Number(rows[0]?.count ?? 0);
  }
}

export class AgencyContactRepository {
  /**
   * Claim up to `limit` dialable contacts for this tick.
   *
   * `FOR UPDATE SKIP LOCKED` is the correctness mechanism, not an optimisation:
   * with it, even a split-brain window — GC pause, partition, clock skew — cannot
   * hand the same contact to two leaders. The Redis leader lease is only the
   * efficiency mechanism that stops us doing the work twice.
   *
   * The first three terms are exactly what `idx_agency_contacts_dialable` serves,
   * which is why anything not dialable right now must not satisfy them.
   *
   * ── The fourth term, and why it is NOT in the index ──────────────────────
   *
   * `suppressed_reason IS DISTINCT FROM 'dnc'` is DEFENCE IN DEPTH on a
   * compliance-terminal action. The real fix is in {@link markState}, which
   * refuses to move a DNC suppression at all; this term is what makes a future
   * path that finds a way around that guard still unable to dial the number.
   * Two properties, deliberately, because they fail independently — a `pending`
   * row is only harmful if something claims it.
   *
   * ⚠️ `IS DISTINCT FROM`, never `<> 'dnc'`. The column is NULL for the entire
   * roster, `NULL <> 'dnc'` is NULL, and a NULL conjunct is not TRUE — the
   * campaign would claim nothing and stall looking exactly like an empty list.
   *
   * **The index is deliberately left alone, and the plan is unaffected.** An
   * extra conjunct never disqualifies a partial index: Postgres still uses
   * `idx_agency_contacts_dialable` for `campaign_id`/`state`/`next_attempt_at`
   * and applies this one as a filter on the tuples it returns. Narrowing the
   * index's own predicate to match would mean `DROP INDEX` + `CREATE INDEX`
   * under `ACCESS EXCLUSIVE` inside the startup migration transaction (087
   * records why `CONCURRENTLY` is not available here) — blocking THE hot dialing
   * query on up to 1M rows — to remove a handful of rows from an index. The rows
   * this term excludes are ones the `markState` guard makes impossible to create
   * going forward, so the selectivity won back is ~zero and the lock is not.
   *
   * That does mean the predicate is no longer *identical* to the index's, which
   * is a real weakening of the rule that the claim's predicate IS the index's.
   * The rule that still holds,
   * and the one to check a future term against: every term must either be served
   * by the index or be cheap to evaluate on an already-narrowed row set. A term
   * that is neither belongs in the index, migration cost and all.
   */
  async claimDialable(campaignId: string, limit: number): Promise<AgencyContactRecord[]> {
    if (limit <= 0) return [];
    const { rows } = await getPool().query<AgencyContactRecord>(
      `UPDATE agency_contacts SET state = 'in_flight', updated_at = now()
        WHERE id IN (
          SELECT id FROM agency_contacts
           WHERE campaign_id = $1 AND state = 'pending' AND next_attempt_at <= now()
             AND suppressed_reason IS DISTINCT FROM 'dnc'
           ORDER BY next_attempt_at
             FOR UPDATE SKIP LOCKED
           LIMIT $2
        )
      RETURNING *`,
      [campaignId, limit],
    );
    return rows;
  }

  /**
   * Return a claimed contact to the pool.
   *
   * `nextAttemptAt` must move the clock forward for any condition that has NOT
   * cleared. A contact returned with `now()` because it was outside its
   * calling window is re-claimed on the very next tick, and a campaign whose
   * contacts are all out of hours spins at 4 claims/second all night burning agent
   * reservations on calls it will never place.
   */
  async unclaim(contactId: string, nextAttemptAt: Date): Promise<void> {
    await getPool().query(
      `UPDATE agency_contacts
          SET state = 'pending', next_attempt_at = $2, updated_at = now()
        WHERE id = $1 AND state = 'in_flight'`,
      [contactId, nextAttemptAt],
    );
  }

  /**
   * Charge one attempt against a contact's retry budget and report the new total.
   *
   * Exists because the outcome policy needs the **post-bump** count and `markState`
   * bumps inside its own `UPDATE`, returning nothing — so a caller that both bumps
   * and decides had no way to learn the number it was deciding on. Reading the row
   * first and adding one in TypeScript would be a read-then-write race with anything
   * else touching the contact; letting Postgres do the arithmetic and return the
   * result cannot be raced.
   *
   * **Deliberately does not set `state`.** The caller writes the state afterwards,
   * from the decision this count produces. The contact is `in_flight` in between,
   * which is safe by construction: `claimDialable` only ever claims `pending`, so
   * nothing can pick it up, and a crash in the gap leaves exactly the stuck
   * `in_flight` row the reaper's periodic sweep already exists to requeue.
   */
  async chargeAttempt(contactId: string, outcome: string | null): Promise<number> {
    const { rows } = await getPool().query<{ attempt_count: number }>(
      `UPDATE agency_contacts
          SET attempt_count = attempt_count + 1,
              last_outcome  = COALESCE($2, last_outcome),
              updated_at    = now()
        WHERE id = $1
        RETURNING attempt_count`,
      [contactId, outcome],
    );
    return rows[0]?.attempt_count ?? 0;
  }

  /**
   * Charge one OUR-FAULT redial and report the new total.
   *
   * The deliberate omission is `attempt_count`. This is the whole point: an
   * agent's socket dropping before the call bridged, or our own replica dying
   * mid-attempt, must not spend the CUSTOMER's retry allowance — with
   * `max_attempts: 3`, three of our faults would otherwise retire someone whose
   * phone was never even answered.
   *
   * Mirrors {@link chargeAttempt}'s shape for the same reason it exists: the
   * bound is evaluated on the POST-bump count, and reading the row first then
   * adding one in TypeScript would be a read-then-write race. Postgres does the
   * arithmetic and returns the result, which cannot be raced.
   *
   * Like `chargeAttempt`, deliberately does not set `state` — the caller writes
   * it from the decision this count produces.
   */
  async chargeOurFaultAttempt(contactId: string, outcome: string | null): Promise<number> {
    const { rows } = await getPool().query<{ our_fault_attempts: number }>(
      `UPDATE agency_contacts
          SET our_fault_attempts = our_fault_attempts + 1,
              last_outcome       = COALESCE($2, last_outcome),
              updated_at         = now()
        WHERE id = $1
        RETURNING our_fault_attempts`,
      [contactId, outcome],
    );
    return rows[0]?.our_fault_attempts ?? 0;
  }

  /**
   * Write a contact's state, with **one transition the database refuses**: a row
   * carrying `suppressed_reason = 'dnc'` stays `suppressed`, whatever was asked.
   *
   * ── The defect this closes ────────────────────────────────────────────────
   *
   * An agent presses mark-DNC mid-call; {@link suppressByPhone} writes
   * `suppressed`/`dnc`. The call then ends on an AGENT-SIDE path — the station
   * socket drops after the bridge, or this replica dies and the reaper writes
   * `orphaned` — and that path calls this method with the outcome policy's answer.
   * `DEFAULT_RETRY_POLICY` carries `agent_disconnected: { 5min, ×3 }` and
   * `orphaned: { 0min, ×3 }`, so `resolveRetryDecision` and
   * `resolveOurFaultRedial` both answer `pending`; `claimDialable` used to gate on
   * `state = 'pending'` alone. The roster then hands the customer who said "stop
   * calling me" back to the same campaign's dialer inside five minutes, with
   * `dnc_recorded: true` and every dashboard green.
   *
   * The dial-time check also refuses that number: `markDnc` writes a
   * campaign-scoped `dnc_entries` row in the mark's own transaction (decision B8),
   * and `DncRegistry.check` widens by scope, so the pre-dial gate suppresses the
   * contact before a dial. This guard is the roster-side half and must hold on its
   * own: without it the contact row says `pending` for a number the list refuses,
   * and every reader of the roster sees a dialable contact.
   *
   * ── Why the guard is keyed on the REASON ──────────────────────────────────
   *
   * Not on the TARGET state being `pending`: the `bridged` handler writes
   * `'connected'`, and `agency-dialer.ts` records at that site that its write can
   * land AFTER the `ended` handler's because lifecycle listeners are
   * fire-and-forget. A target-keyed guard lets `connected` launder the row out of
   * `suppressed`, after which nothing is guarded at all.
   *
   * Not on the current STATE being `suppressed`: `invalid` (the pre-dial gate,
   * `resolveRetryDecision`) and ingest suppression are data-quality states other
   * subsystems may legitimately move, and freezing them is a behaviour change
   * nobody asked for and a way to strand contacts.
   *
   * `suppressed_reason = 'dnc'` is exactly the compliance-terminal predicate, and
   * the reason itself is frozen the same way as the state. A plain
   * `COALESCE($7, suppressed_reason)` means "the caller's value, else keep what
   * is there" — the same argument-order trap {@link suppressByPhone} documents —
   * so a later caller that PASSES a reason overwrites `dnc`. The `invalid`
   * outcome path does (`resolveRetryDecision` returns `suppressedReason:
   * 'invalid'`, and `agency-dialer.ts` forwards it). After that both this CASE
   * freeze and `claimDialable`'s `IS DISTINCT FROM 'dnc'` filter no longer apply,
   * and a following `pending` write puts the number back on the roster.
   *
   * The ELSE branch keeps the ordinary COALESCE so a first write of `dnc` (the
   * `do_not_call` disposition) still lands, and so an `invalid` reason on a row
   * that is not DNC is still writable. {@link suppressByPhone} is the mark itself
   * and does not go through this method.
   *
   * ── Why a rewrite, not a `WHERE` ──────────────────────────────────────────
   *
   * `WHERE … AND suppressed_reason IS DISTINCT FROM 'dnc'` would refuse the whole
   * UPDATE. Mark-DNC on a live call is supported and the agent's write-up arrives
   * AFTERWARDS through the disposition route, which reaches this method carrying
   * `last_disposition`; refusing the row would silently drop the record of what
   * was said. So the STATE and the retry instant are frozen and every
   * record-keeping column still lands.
   *
   * `THEN 'suppressed'` rather than `THEN state` is also deliberate: a row left
   * `pending` + `dnc` by a pre-fix build — those exist in production, written by
   * exactly the path above — self-heals the next time anything touches it, and a
   * pre-dial gate that wants to suppress such a row is not itself refused.
   *
   * `next_attempt_at` is frozen for the reason `agency.routes.ts` already records
   * for the losing disposition arm: inert for dialing, but "suppressed, next call
   * Wednesday" is the precedence contradicting itself in a field a console and a
   * compliance export both read.
   *
   * ── Every caller, and the decision about each ─────────────────────────────
   *
   * The guard is HERE and not at the call sites because one of them (`reaper.ts`'s
   * orphan requeue) hardcodes `'pending'` rather than taking a decision, and a
   * rule spelled nine times is a rule with eight chances to be forgotten. The
   * enumeration is recorded so a future reader can check a new caller against it
   * rather than re-deriving which ones mattered:
   *
   *   * `agency-dialer.ts` outcome branch — `resolveRetryDecision` ⇒ `'pending'`
   *     for any retryable outcome under its cap. **THE reported defect.** Guarded.
   *   * `agency-dialer.ts` our-fault branch — `resolveOurFaultRedial` ⇒ `'pending'`
   *     for `agent_disconnected` under the bound. The second half of the same
   *     defect, and the likelier one: it is the agent-side drop the report names.
   *     Guarded.
   *   * `agency-dialer.ts` `bridged` / `connected` writes — `'connected'`. Not
   *     `pending`, but its own comment records that this write can land AFTER the
   *     `ended` handler's, which would launder the row out of `suppressed` and
   *     leave the NEXT write unguarded. Guarded, and the reason the key is the
   *     reason rather than the target state.
   *   * `reaper.ts` lapsed-wrap-up sweep — `resolveRetryDecision` ⇒ `'pending'`.
   *     Guarded.
   *   * `reaper.ts` our-fault-bounded retire — terminal states only. Guarded
   *     anyway; `suppressed` is at least as terminal as what it asked for.
   *   * `reaper.ts` orphan requeue — literal `'pending'`. Guarded.
   *   * `agency.routes.ts` disposition — a disposition decision, which can be
   *     `'pending'` (a callback). Guarded on the state; `last_disposition` still
   *     lands, deliberately.
   *   * `pacing-engine.ts` pre-dial gate — `'suppressed'`. A no-op under the
   *     guard, which is correct, and the `THEN 'suppressed'` branch means it can
   *     still park a legacy `pending` + `dnc` row where it belongs.
   *   * {@link unclaim} — writes `'pending'` but is already
   *     `WHERE state = 'in_flight'`, which a suppressed row cannot satisfy. No
   *     change, and it is the one caller that needed none.
   *   * {@link suppressByPhone} — writes the DNC suppression itself and must not
   *     be guarded by it.
   *   * `applyIngestChunk` — INSERTs new rows at the `pending` column default. Out
   *     of scope by construction: a re-uploaded roster row is a NEW contact with
   *     no reason to freeze, and the dial-time read of `dnc_entries` is what
   *     covers a re-upload.
   */
  async markState(
    contactId: string,
    state: string,
    patch: {
      last_outcome?: string | null;
      last_disposition?: string | null;
      next_attempt_at?: Date | null;
      suppressed_reason?: string | null;
      bump_attempt?: boolean;
    } = {},
  ): Promise<boolean> {
    // The CASE expressions read the row's PRE-update `suppressed_reason`, which is
    // what makes the DNC write itself (`suppressed_reason = 'dnc'` arriving in
    // `$7` on a row that has none yet) take the ELSE branch and land normally.
    // The reason column is frozen the same way: COALESCE($7, col) would let a
    // later non-null $7 (the `invalid` outcome) strip `dnc` and un-key the guard.
    const { rows } = await getPool().query<{ state: string; suppressed_reason: string | null }>(
      `UPDATE agency_contacts
          SET state = CASE WHEN suppressed_reason = 'dnc' THEN 'suppressed' ELSE $2 END,
              attempt_count = attempt_count + $3,
              last_outcome = COALESCE($4, last_outcome),
              last_disposition = COALESCE($5, last_disposition),
              next_attempt_at = CASE WHEN suppressed_reason = 'dnc' THEN next_attempt_at ELSE COALESCE($6, next_attempt_at) END,
              suppressed_reason = CASE WHEN suppressed_reason = 'dnc' THEN suppressed_reason ELSE COALESCE($7, suppressed_reason) END,
              updated_at = now()
        WHERE id = $1
      RETURNING state, suppressed_reason`,
      [
        contactId,
        state,
        patch.bump_attempt ? 1 : 0,
        patch.last_outcome ?? null,
        patch.last_disposition ?? null,
        patch.next_attempt_at ?? null,
        patch.suppressed_reason ?? null,
      ],
    );

    // Postgres decided; this only reports. `RETURNING` is what makes the refusal
    // observable at all — without it the guard is a statement that quietly does
    // less than its caller believes, which is the shape of the defect it closes.
    // `warn` rather than `error`: the guard doing its job is not a fault, but an
    // outcome path repeatedly bouncing off a DNC row is something an operator
    // wants to be able to see.
    const landed = rows[0];
    if (landed && landed.state !== state) {
      log.warn(
        {
          contactId,
          requestedState: state,
          state: landed.state,
          suppressedReason: landed.suppressed_reason,
        },
        'Refused a state transition on a DNC-suppressed contact — the row stays suppressed',
      );
    }

    /**
     * ── Whether the requested state actually LANDED ──────────────────────────
     *
     * Returned as of 2026-09-11, because resolving `void` made this function
     * indistinguishable from success to every caller, and one of them was using
     * "the await did not reject" as proof of a durable retirement.
     *
     * Two ways this resolves without the requested state landing, and neither
     * throws:
     *
     * 1. **The DNC guard refused it.** The `CASE` above keeps a `dnc`-suppressed
     *    row `suppressed` and the statement still succeeds — that is the whole
     *    design, and the warn above is the only trace.
     * 2. **No row matched** (`rows[0]` undefined) — a contact id that is not
     *    there. `UPDATE … WHERE id = $1` affecting zero rows is not an error.
     *
     * Callers that only care about "best-effort bookkeeping" can keep ignoring
     * this, which is why the change is additive rather than a thrown error. But
     * a caller drawing a CONCLUSION from the write — incrementing a counter that
     * asserts a person was permanently retired, say — must gate on it. See
     * `agency_our_fault_retirement_total`'s two producers.
     */
    return landed !== undefined && landed.state === state;
  }

  /**
   * Suppress EVERY roster row in this campaign that carries this number — not
   * just the one an attempt points at.
   *
   * ── Why this exists, and what breaks without it ──────────────────────────
   *
   * `markState(attempt.contact_id, …)` takes ONE row off this campaign's
   * roster. The `dnc_entries` row `markDnc` writes in the same transaction
   * (decision B8) stops the dial-time check passing the number for the whole
   * campaign, but it does not touch the roster: a second row with the same number
   * would stay `pending`, and every reader of the roster would count it dialable.
   *
   * That second row is not hypothetical. Migration 073 refuses a
   * `UNIQUE (campaign_id, phone_e164)` **on purpose** — "two people on one
   * household landline, two contacts behind one company switchboard, a shared
   * family mobile" are legitimate rows and dropping one is data loss — so one
   * campaign holding the same number twice is a supported, common state. Suppress
   * only the dialled row and the duplicate stays `pending`: the roster goes on
   * offering a customer who said "stop calling me" to the same campaign, with
   * every dashboard green, and only the dial-time check stands between that row
   * and a call.
   *
   * DNC is a property of the NUMBER, never of the roster row, which is why every
   * row matching it goes. That is no broader than the mark itself: the
   * campaign-scoped `dnc_entries` row already blocks the number across this
   * whole campaign.
   *
   * ── Matching: `normalizeE164`, in TypeScript, deliberately ────────────────
   *
   * `phone_e164` is stored **as the roster gave it** — `applyIngestChunk` inserts
   * the ingest's string unchanged and there is no normalizing trigger or CHECK on
   * the column, which is exactly why `markDnc` normalizes before storing and why
   * the pre-dial gate normalizes before checking. So this cannot compare
   * `phone_e164 = $x`; `+1 (415) 555-0100` and `+14155550100` are the same number
   * and different strings.
   *
   * The comparison therefore runs {@link normalizeE164} itself, on both sides, in
   * TypeScript. Re-expressing that function in SQL was written and thrown away:
   * its whitespace class is JavaScript's `\s` (which includes NBSP and friends — a
   * thing spreadsheet exports really do put in phone columns) while Postgres'
   * `[[:space:]]` generally does not, so a SQL twin would silently skip a row the
   * one true function considers a match. That is a fail-OPEN, in the same shape
   * the registry's header warns about, produced by an optimisation.
   *
   * What SQL does instead is a strictly LOOSER prefilter — "same digits, ignoring
   * every non-digit" — which is a provable superset of what `normalizeE164` can
   * match (anything it normalizes contains only digits, `+`, spaces, `-`, `(`,
   * `)`), and is index-backed by `idx_agency_contacts_campaign_phone_digits`
   * (migration 087). The narrow, exact decision stays in TypeScript. Keep the
   * expression below byte-identical to that index's or the plan silently degrades
   * to a scan.
   *
   * ── The SELECT is `FOR UPDATE`, in one transaction with the UPDATE ────────
   *
   * An unlocked SELECT then a second UPDATE lets {@link claimDialable} take a
   * duplicate BETWEEN the two. The tick already holds that contact in memory,
   * and its pre-dial check reads `dnc_entries` as committed, so a check that runs
   * before the mark's transaction commits does not see the new row — that press
   * still places the call. That is the duplicate-row hole this lock closes.
   *
   * `FOR UPDATE` (not `SKIP LOCKED`) holds every candidate until the UPDATE
   * commits. `claimDialable` uses `SKIP LOCKED`, so it skips a row we hold
   * rather than waiting, and cannot take it. We wait if a claim is already in
   * flight, then suppress the now-`in_flight` row; that one call may still
   * complete (the tick has it in memory — a known residual), but
   * {@link markState} then refuses to resurrect it.
   *
   * ── `next_attempt_at` is NOT touched, and that is the invariant ──────────
   *
   * {@link markState} COALESCEs it, so a contact that already had a retry instant
   * KEEPS it; this method preserves that by leaving the column out of the SET list
   * entirely (identical semantics, `COALESCE(NULL, next_attempt_at)`). It is inert
   * — `claimDialable` gates on `state = 'pending'` — but it means the STATE is what
   * takes a contact off the roster and the STATE is what a test here must assert.
   * Clearing the column is not a compliance write's job.
   *
   * @param reason value for `suppressed_reason`. Written unconditionally to
   *   `alwaysContactId`'s row — the agent marked THAT row, and an explicit mark
   *   outranks whatever it was suppressed for before. On every other matched row it
   *   is written only if that row has no reason yet, so a contact the pre-dial gate
   *   suppressed as `invalid` is not relabelled `dnc`: nobody at that number asked
   *   not to be called, and a compliance reason on a data-quality row is a claim the
   *   system cannot support. ⚠️ NOT `COALESCE($n, col)` on a required argument —
   *   see the argument-order note on the UPDATE; `reason` is required, so that
   *   shape is inert here and relabels everything.
   * @param opts.alwaysContactId the row the agent actually marked. Suppressed
   *   unconditionally, **including when the phone does not normalize at all** —
   *   an unusable number is a data problem and the customer in front of the agent
   *   must still leave the roster (the guarantee `POST /attempts/:id/dnc` has
   *   always made, and the one a naive by-phone rewrite quietly drops).
   * @param opts.lastDisposition written to `alwaysContactId`'s row ONLY. A
   *   disposition is a statement about one call with one person; stamping it onto
   *   the housemate's row because they share a landline would be inventing a
   *   record of a conversation that never happened.
   * @returns the ids actually suppressed, for the route's log line. Never trust it
   *   as the proof of the write — assert the rows.
   */
  async suppressByPhone(
    campaignId: string,
    phoneE164: string,
    reason: string,
    opts: { alwaysContactId?: string | undefined; lastDisposition?: string | undefined } = {},
    /**
     * Join the CALLER's transaction instead of opening one (decision B8): the agent's DNC
     * mark writes `dnc_entries`, the roster suppression and the optional disposition in ONE
     * transaction (`POST /attempts/:id/dnc`). The caller owns BEGIN / COMMIT / ROLLBACK and
     * release; the SELECT … FOR UPDATE then UPDATE run on its client, so the row locks are
     * held until its COMMIT. Omitted, this method opens its own transaction.
     */
    deps: { client?: PoolClient } = {},
  ): Promise<string[]> {
    const pool = getPool();
    const target = normalizeE164(phoneE164);
    const ids = new Set<string>();
    if (opts.alwaysContactId) ids.add(opts.alwaysContactId);

    const write = async (db: Pick<PoolClient, 'query'>): Promise<string[]> => {
      // ── ⚠️ COALESCE ARGUMENT ORDER: which side may be NULL is the whole meaning ──
      //
      // `COALESCE($n, col)` means "the caller's value, or keep what is there" and is
      // correct ONLY where `$n` can actually be NULL. Every other such write in this
      // file feeds one from an OPTIONAL patch field (`patch.x ?? null`) or an
      // explicitly nullable parameter, so NULL genuinely means "not supplied".
      //
      // `reason` is a REQUIRED `string`. It is never NULL, so `COALESCE($3, …)` here
      // was an inert guard that always selected `$3` — every swept row was relabelled
      // `'dnc'`, including one the pre-dial gate had suppressed as `'invalid'`. That
      // puts a compliance claim on a data-quality row: nobody asked not to be called,
      // and the only surviving evidence of why the row left the roster is overwritten.
      // The idiom was copied from `markState`, where the parameter really is optional;
      // carried into a required-argument method it does nothing at all, silently, and
      // a unit tier with a mocked pool cannot see it (integration T-DNC6 did).
      //
      // So the direction is reversed for the SWEPT rows — `COALESCE(col, $3)`, "keep
      // an existing reason, else record this one" — while the MARKED row is written
      // unconditionally. That asymmetry is deliberate and mirrors `last_disposition`
      // immediately below, so the two columns read as one pattern:
      //
      //   * the marked row is the one the agent explicitly acted on, and an explicit
      //     DNC mark is the strongest statement the system has about it. It must not
      //     be at the mercy of a stale value — and this is reachable, not theoretical:
      //     the disposition route writes `suppressed_reason` on this same contact
      //     (`agency.routes.ts`, `markState` with `decision.suppressedReason`), and
      //     mark-DNC on an already-dispositioned attempt is explicitly supported. A
      //     plain `COALESCE(col, $3)` would drop the agent's DNC on that path;
      //   * a swept row is a DIFFERENT PERSON who merely shares the number, so
      //     whatever it was already suppressed for stands.
      const { rows } = await db.query<{ id: string }>(
        `UPDATE agency_contacts
            SET state = 'suppressed',
                suppressed_reason = CASE WHEN id = $4::uuid
                                         THEN $3
                                         ELSE COALESCE(suppressed_reason, $3) END,
                last_disposition = CASE WHEN id = $4::uuid
                                        THEN COALESCE($5, last_disposition)
                                        ELSE last_disposition END,
                updated_at = now()
          WHERE campaign_id = $1 AND id = ANY($2::uuid[])
          RETURNING id`,
        // `campaign_id` is re-asserted rather than trusted from the id list: the
        // scope of this write is one campaign, and that must be true of the marked
        // row too, not only of the ones this method looked up itself.
        [
          campaignId,
          [...ids],
          reason,
          opts.alwaysContactId ?? null,
          opts.lastDisposition ?? null,
        ],
      );
      return rows.map((r) => r.id);
    };

    if (!target) {
      log.error(
        { campaignId, contactId: opts.alwaysContactId ?? null },
        'Contact phone is not usable E.164 — only the marked row could be suppressed, '
        + 'any duplicate of it in this campaign stays dialable',
      );
      if (ids.size === 0) return [];
      return write(deps.client ?? pool);
    }

    // One transaction, SELECT FOR UPDATE then UPDATE: claimDialable uses
    // SKIP LOCKED, so a duplicate we hold cannot be taken between the two.
    const own = !deps.client;
    const client: PoolClient = deps.client ?? await pool.connect();
    try {
      if (own) await client.query('BEGIN');
      const { rows } = await client.query<{ id: string; phone_e164: string }>(
        `SELECT id, phone_e164 FROM agency_contacts
          WHERE campaign_id = $1
            AND (${CONTACT_PHONE_DIGITS_SQL} = $2
                 OR ($3::uuid IS NOT NULL AND id = $3::uuid))
          FOR UPDATE`,
        // The target's digits, i.e. the normalized form minus its leading '+'.
        // `$3` re-locks the marked row even when its stored string would not
        // survive the prefilter, so the guarantee `alwaysContactId` makes is
        // held for the same duration as the sweep.
        [campaignId, target.slice(1), opts.alwaysContactId ?? null],
      );
      for (const row of rows) {
        // The prefilter is a superset; THIS is the decision, and it is the same
        // function every other side of this comparison runs. The marked row is
        // already in `ids` and is not re-decided here.
        if (normalizeE164(row.phone_e164) === target) ids.add(row.id);
      }
      if (ids.size === 0) {
        if (own) await client.query('ROLLBACK');
        return [];
      }
      const updated = await write(client);
      if (own) await client.query('COMMIT');
      return updated;
    } catch (err) {
      if (own) await client.query('ROLLBACK').catch(() => { /* connection already broken */ });
      throw err;
    } finally {
      if (own) client.release();
    }
  }


  /**
   * One campaign's roster, newest first, keyset-paginated.
   *
   * ── `context` is deliberately absent from this projection ───────────────────
   * Columns the operator marked `Ignore` at ingest never reach the stored JSONB
   * at all (`agency-csv-ingest.ts` drops them before the row is written), so
   * the exclusion marking a column `Ignore` promises *is* enforced at ingest
   * rather than at render. But `context_display.hidden` is a render
   * rule, and this list has a wider audience than the agent screen that rule was
   * written for — and it feeds a CSV export, which is a materially larger
   * exposure than one drawer. So the bulk read simply does not carry it: the
   * columns are served by {@link findDetailScoped}, one contact at a time, where
   * a client can apply `hidden` the way the console does.
   *
   * ── Plan ────────────────────────────────────────────────────────────────────
   * Needs `idx_agency_contacts_reporting (campaign_id, created_at DESC, id DESC)`
   * from migration 095. Every pre-existing index on this table is built for the
   * DIAL path — `idx_agency_contacts_dialable` is partial on `state = 'pending'`,
   * i.e. it excludes most of what a supervisor reads — so without 095 this is a
   * sequential scan plus a sort of up to a million rows on a route someone pages
   * through.
   */
  async listForCampaign(input: {
    campaignId: string;
    filters: AgencyContactFilters;
    after?: AgencyKeysetPosition;
    limit: number;
  }): Promise<AgencyKeysetPage<AgencyContactRow>> {
    const p = params();
    const f = input.filters;
    // The four vocabulary dimensions come from the SHARED builder, because this
    // list is where a retry selection is authored and the seeding statement has to
    // mean the same thing by them — see `contactFilterConditions`. The three below
    // are this route's own: they are deliberately not retry-selector dimensions.
    const conditions = [
      `c.campaign_id = ${p.add(input.campaignId)}`,
      ...contactFilterConditions(f, 'c', p),
    ];

    if (f.phone) conditions.push(phoneCondition(f.phone, 'c', p));
    if (f.from) conditions.push(`c.created_at >= ${p.add(f.from)}`);
    if (f.to) conditions.push(`c.created_at <= ${p.add(f.to)}`);
    if (input.after) conditions.push(keysetCondition(input.after, 'c', p));

    const sql = `
      SELECT c.id, c.phone_e164, c.state, c.attempt_count, c.our_fault_attempts,
             c.last_outcome, c.last_disposition, c.next_attempt_at,
             c.suppressed_reason, c.timezone, c.csv_line_number,
             c.created_at, c.updated_at,
             ${keysetAtSql('c.created_at')} AS cursor_at
        FROM agency_contacts c
       WHERE ${conditions.join(' AND ')}
       ORDER BY c.created_at DESC, c.id DESC
       LIMIT ${p.add(input.limit + 1)}`;

    const { rows } = await getPool().query<AgencyContactRecord & { cursor_at: string }>(sql, p.values);
    return toKeysetPage(rows, input.limit, projectContactRow);
  }

  /**
   * One contact, scoped to a campaign the caller has already been proven to own
   * — the drill-down's row, and the only read that carries `context`.
   *
   * `campaignId` is a predicate rather than a post-hoc check because the route
   * proves ownership of the CAMPAIGN, not of the contact: without it, any
   * contact id in the tenant (or outside it) would resolve through a route
   * authorised against a campaign the caller does own.
   */
  async findDetailScoped(campaignId: string, contactId: string): Promise<AgencyContactDetail | null> {
    const { rows } = await getPool().query<AgencyContactRecord>(
      `SELECT * FROM agency_contacts WHERE id = $1::uuid AND campaign_id = $2`,
      [contactId, campaignId],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      ...projectContactRow(row),
      // Unfiltered. Every value is untrusted display text; the client applies
      // `context_display.hidden` before rendering. See the class note above.
      context: row.context ?? {},
    };
  }

  async findById(id: string): Promise<AgencyContactRecord | null> {
    const { rows } = await getPool().query<AgencyContactRecord>(
      'SELECT * FROM agency_contacts WHERE id = $1',
      [id],
    );
    return rows[0] ?? null;
  }

  /**
   * Apply one roster-ingest chunk, all-or-nothing.
   *
   * The chunk marker and its rows commit in ONE transaction, so partial
   * application is impossible rather than merely detectable — which is what lets
   * a replay be a single cheap conflict on `uq_agency_ingest_chunk` instead of 500
   * per-row upserts.
   *
   * `uq_agency_contacts_row_fingerprint` (083) sits beneath it, and is not merely
   * defence in depth: the ingest job gets a fresh job id on every run
   * (`AgencyIngestJobRepository.create` is an unconditional INSERT), so a
   * re-upload after a restart cannot conflict on the chunk marker at all and the row-level
   * guard is the only thing stopping the rows that already landed from landing
   * twice. It keys on row CONTENT rather than on the file position 073 used —
   * see 083 for why that distinction is what makes topping up a live campaign
   * possible without giving that guard away.
   */
  async applyIngestChunk(params: {
    campaignId: string;
    tenantId: string;
    accountId: string;
    ingestJobId: string;
    chunkIndex: number;
    chunkCount: number | null;
    idempotencyKey: string;
    contacts: AgencyContactInput[];
  }): Promise<AgencyIngestResult> {
    const pool = getPool();
    const client: PoolClient = await pool.connect();
    try {
      await client.query('BEGIN');

      const marker = await client.query<{ id: string }>(
        `INSERT INTO agency_ingest_chunks
           (campaign_id, ingest_job_id, chunk_index, idempotency_key, chunk_count, row_count)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (campaign_id, idempotency_key) DO NOTHING
         RETURNING id`,
        [
          params.campaignId, params.ingestJobId, params.chunkIndex,
          params.idempotencyKey, params.chunkCount, params.contacts.length,
        ],
      );

      // Conflict ⇒ this chunk already landed. Roll back and say so explicitly —
      // the ingest job treats it as success and needs the signal to avoid
      // double-counting.
      //
      // **The rollback semantics below are load-bearing and unchanged.** Nothing is
      // re-applied here; the transactional idempotency 077 established is the whole
      // point. What changed is only what the replay can SAY: it reads back the
      // counts the ORIGINAL application recorded (084), so a replay answers what
      // the original answered. It has no counts of its own — it rolls back before
      // the per-row loop — so without the recorded ones it could only return a
      // confident zero, and the ingest summary would undercount every row the
      // original refused.
      if (marker.rowCount === 0) {
        await client.query('ROLLBACK');
        // Read AFTER the rollback and on the pool, matching `countForCampaign`
        // below: the marker was committed by the original transaction, so this is
        // an ordinary read and keeping it outside the aborted one avoids any
        // suggestion that the replay path still holds a transaction open.
        const recorded = await this.recordedRejections(params.campaignId, params.idempotencyKey, client);
        return {
          accepted: 0,
          duplicate_chunk: true,
          total_contacts: await this.countForCampaign(params.campaignId, client),
          rejected_duplicate_rows: recorded.rejected ?? 0,
          duplicate_source_rows: recorded.sourceRows ?? [],
          // NULL ⇒ applied before 084, so the zeros above are "unknown", not
          // "none". Never invented as a number; the flag is how the response says
          // it does not know.
          ...(recorded.rejected === null ? { rejection_counts_unavailable: true } : {}),
        };
      }

      let accepted = 0;
      const duplicateRows: number[] = [];
      let rejectedDuplicateRows = 0;
      for (const c of params.contacts) {
        // The conflict target is NAMED, not bare. A bare `ON CONFLICT DO NOTHING`
        // absorbs *every* constraint violation — so a genuine data problem (a bad
        // FK, a CHECK the ingest should have caught) was indistinguishable from a
        // replayed row, and both surfaced as a silent decrement of `accepted`.
        // Naming the index means only the row-idempotency collision is swallowed
        // and anything else throws, which is what we want it to do.
        //
        // The target is `row_fingerprint` (083), not `source_row_number` (073):
        // the row number is the position in ONE file, so a second file's rows
        // 2..N collided with the first's and a top-up could never land. The
        // fingerprint is computed **in SQL from these same bound parameters**,
        // by the same function 083's backfill used, so there is exactly one
        // definition of "the same roster row" and no chance of this insert and
        // that backfill disagreeing about it.
        //
        // ── `source_row_number` IS DELIBERATELY NOT IN THIS COLUMN LIST (085) ──
        //
        // Naming the fingerprint index is not enough on its own: 073's
        // `uq_agency_contacts_source_row` is STILL in the schema, so writing the
        // column would make a top-up file's row 2 collide with the first file's
        // row 2, and that 23505 is not swallowed because the conflict target names
        // a different index. The top-up arms of `agency-ingest-idempotency.test.ts`
        // fail on exactly that constraint if the column comes back.
        //
        // That index is PARTIAL on `source_row_number IS NOT NULL`, so a row that
        // stores NULL sits outside it. Leaving the column out of this list is what
        // makes top-up work. The CSV line
        // number is not lost — it moves to `csv_line_number` (085), which is
        // unindexed provenance and can never reinstate the collision.
        //
        // Do not "tidy" the column back in. It reads like restoring a dropped
        // field and it re-breaks top-up the moment two files share a line number.
        const res = await client.query(
          `INSERT INTO agency_contacts
             (campaign_id, tenant_id, account_id, phone_e164, context, csv_line_number, timezone,
              row_fingerprint)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7,
                   agency_contact_row_fingerprint($4, $5::jsonb, $7))
           ON CONFLICT (campaign_id, row_fingerprint) WHERE row_fingerprint IS NOT NULL
             DO NOTHING`,
          [
            params.campaignId, params.tenantId, params.accountId, c.phone_e164,
            // `$6` is the INPUT's `source_row_number` (the ingest's field name,
            // unchanged) stored into `csv_line_number`. The input contract does not
            // move just because the column did.
            JSON.stringify(c.context ?? {}), c.source_row_number ?? null, c.timezone ?? null,
          ],
        );
        if (res.rowCount === 0) {
          rejectedDuplicateRows++;
          // Reported from the INPUT row, never from a stored value — which is why
          // 085 moving the column changes nothing about what the operator is told.
          if (c.source_row_number != null && duplicateRows.length < MAX_REPORTED_DUPLICATE_ROWS) {
            duplicateRows.push(c.source_row_number);
          }
        } else {
          accepted += res.rowCount ?? 0;
        }
      }

      // Record what this chunk refused, in the SAME transaction that refused it
      // (084). It cannot be recomputed later: a row rejected by
      // `uq_agency_contacts_row_fingerprint` leaves nothing behind — the surviving
      // contact is the one that was already there and is byte-identical to the one
      // we dropped — so if the number is not written down here it is gone, and the
      // replay path has nothing truthful to answer with.
      //
      // An UPDATE rather than folding these into the marker INSERT above, because
      // the INSERT has to happen FIRST: it is the conflict on that insert which
      // detects the replay, and it has to do so before we spend 500 round trips
      // inserting rows. Same transaction either way, so the marker and its counts
      // are still all-or-nothing.
      await client.query(
        `UPDATE agency_ingest_chunks
            SET rejected_duplicate_rows = $2,
                duplicate_source_rows   = $3::integer[]
          WHERE id = $1`,
        [marker.rows[0]!.id, rejectedDuplicateRows, duplicateRows],
      );

      await client.query(
        `UPDATE agency_campaigns
            SET contacts_total = (SELECT COUNT(*) FROM agency_contacts WHERE campaign_id = $1),
                updated_at = now()
          WHERE id = $1`,
        [params.campaignId],
      );

      await client.query('COMMIT');
      return {
        accepted,
        duplicate_chunk: false,
        total_contacts: await this.countForCampaign(params.campaignId, client),
        rejected_duplicate_rows: rejectedDuplicateRows,
        duplicate_source_rows: duplicateRows,
      };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => { /* connection already broken */ });
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * What a previously-applied chunk recorded that it refused (084).
   *
   * `rejected: null` is the honest "never recorded" — a chunk applied before 084 —
   * and is reported as `rejection_counts_unavailable` rather than as a zero. A
   * chunk applied since records a real number, so a recorded `0` genuinely means
   * "this chunk refused nothing".
   *
   * `sourceRows` is a capped sample (`MAX_REPORTED_DUPLICATE_ROWS`), matching the
   * API field of the same name. `node-pg` decodes `INTEGER[]` to `number[]`.
   */
  private async recordedRejections(
    campaignId: string,
    idempotencyKey: string,
    /**
     * Run on the caller's ALREADY-HELD client rather than checking out a second
     * connection. `applyIngestChunk` calls this while still holding `client`, and a
     * checkout-while-holding is a classic pool deadlock: with `DB_POOL_MAX` at N,
     * N concurrent chunks each holding one connection and requesting another wait
     * on each other forever. The transaction has been rolled back by then, so this
     * is an ordinary read on an idle connection.
     */
    executor: Pick<PoolClient, 'query'> = getPool(),
  ): Promise<{ rejected: number | null; sourceRows: number[] | null }> {
    const { rows } = await executor.query<{
      rejected_duplicate_rows: number | null;
      duplicate_source_rows: number[] | null;
    }>(
      `SELECT rejected_duplicate_rows, duplicate_source_rows
         FROM agency_ingest_chunks
        WHERE campaign_id = $1 AND idempotency_key = $2`,
      [campaignId, idempotencyKey],
    );
    const row = rows[0];
    // A missing row here should be unreachable — we are on this path precisely
    // because the unique index refused our insert — but it is treated as "not
    // recorded" rather than as zero for the same reason NULL is: an invented
    // number is the defect being fixed.
    if (!row) return { rejected: null, sourceRows: null };
    // `?? null` normalizes an absent column to the same "not recorded" as a NULL
    // one. Postgres returns `null` for a NULL `INTEGER`, so this is belt-and-braces
    // — but the two must not diverge, because `undefined` slipping through would
    // reach the `=== null` test below as "recorded" and reinstate the confident zero.
    return {
      rejected: row.rejected_duplicate_rows ?? null,
      sourceRows: row.duplicate_source_rows ?? null,
    };
  }

  async countForCampaign(
    campaignId: string,
    /** See `recordedRejections` — avoids a second checkout while a client is held. */
    executor: Pick<PoolClient, 'query'> = getPool(),
  ): Promise<number> {
    const { rows } = await executor.query<{ n: string }>(
      'SELECT COUNT(*)::text AS n FROM agency_contacts WHERE campaign_id = $1',
      [campaignId],
    );
    return Number(rows[0]?.n ?? 0);
  }

  /** Chunk indexes the ingest job sent that never landed — lets it re-send just the gap. */
  async missingChunks(campaignId: string, ingestJobId: string, chunkCount: number): Promise<number[]> {
    const { rows } = await getPool().query<{ chunk_index: number }>(
      'SELECT chunk_index FROM agency_ingest_chunks WHERE campaign_id = $1 AND ingest_job_id = $2',
      [campaignId, ingestJobId],
    );
    const seen = new Set(rows.map((r) => r.chunk_index));
    const missing: number[] = [];
    for (let i = 0; i < chunkCount; i++) if (!seen.has(i)) missing.push(i);
    return missing;
  }
}

export class AgencyAttemptRepository {
  /**
   * Create the attempt row for a claimed contact.
   *
   * Returns null when a unique index refuses it. The caller must treat null as
   * "someone else has this contact" and move on, never as an error to retry.
   *
   * ── `attempt_number` is DERIVED HERE, and never supplied by the caller ───────
   * It comes from `MAX(attempt_number)` over this contact's own attempt rows,
   * computed inside the INSERT. **The caller cannot pass it** — that is the point,
   * not an inconvenience.
   *
   * It used to be `contact.attempt_count + 1`, and that made a reaper-recovered
   * contact **permanently undialable for the life of the campaign**. `attempt_count`
   * was doing two unrelated jobs — retry-budget accounting *and* unique-number
   * generation — and they diverge the moment an attempt row exists that was never
   * counted. The reaper requeues without bumping the count (correctly: see below),
   * so the orphaned row already held the number the next derivation produced,
   * `uq_agency_attempt_number` is total rather than partial and does not care the
   * prior attempt ended, and the insert failed 23505 on every tick forever.
   *
   * **What made it invisible is worth remembering.** The contact went back to
   * `pending`, so nothing was stranded, no error surfaced, and the campaign was not
   * wedged — it simply never finished. The only signal was this method's own
   * `log.warn` about the duplicate-dial backstop, which is *exactly what a
   * correctly working backstop logs*. An operator reading it concluded the system
   * was protecting them. The two cases are now logged distinctly (below).
   *
   * Deriving from the attempts table instead separates the two concerns for good:
   * `attempt_count` stays purely the retry budget, and the number sequence stays
   * unique per contact across all history, which the retry policy reads.
   * Two concurrent inserts can still both read the same MAX — but that is now a
   * genuine, self-correcting race caught by the index and retried on the next tick,
   * rather than a permanent wedge, and `uq_agency_attempt_live` already makes two
   * live attempts per contact impossible.
   */
  async create(params: {
    campaignId: string;
    contactId: string;
    tenantId: string;
    accountId: string;
    callerId: string;
    reservedAgentId: string;
  }): Promise<AgencyCallAttemptRecord | null> {
    try {
      const { rows } = await getPool().query<AgencyCallAttemptRecord>(
        `INSERT INTO agency_call_attempts
           (campaign_id, contact_id, tenant_id, account_id, attempt_number, caller_id, reserved_agent_id, state)
         SELECT $1, $2, $3, $4,
                COALESCE(MAX(attempt_number), 0) + 1,
                $5, $6, 'queued'
           FROM agency_call_attempts
          WHERE contact_id = $2
         RETURNING *`,
        [
          params.campaignId, params.contactId, params.tenantId, params.accountId,
          params.callerId, params.reservedAgentId,
        ],
      );
      return rows[0] ?? null;
    } catch (err) {
      // 23505 = unique_violation. Both indexes mean "move on", but they mean very
      // different things operationally and MUST NOT share a log line — that
      // conflation is what once hid the attempt-numbering wedge. A live-attempt refusal
      // is a correctness backstop doing its job and is expected under contention;
      // an attempt-number refusal is a lost race that should be vanishingly rare,
      // and a *steady stream* of them means numbers are colliding systematically.
      // Alert on the second, never on the first.
      const e = err as { code?: string; constraint?: string };
      if (e.code === '23505') {
        if (e.constraint === 'uq_agency_attempt_number') {
          log.warn(
            { contactId: params.contactId, constraint: e.constraint },
            'Attempt-number collision — lost a concurrent insert race; retrying next tick',
          );
        } else {
          log.warn(
            { contactId: params.contactId, constraint: e.constraint },
            'Duplicate-dial backstop refused an attempt',
          );
        }
        return null;
      }
      throw err;
    }
  }

  async setState(
    id: string,
    state: AgencyAttemptState,
    patch: {
      webrtc_call_id?: string | null;
      outcome?: AgencyAttemptOutcome | null;
      dialed_at?: Date;
      answered_at?: Date;
      bridged_at?: Date;
      ended_at?: Date;
      talk_seconds?: number;
      /** The wrap-up window owed on this attempt. Duration, not a
       *  deadline: with `ended_at` it says what was owed and from when, which is
       *  what lets the `no_disposition` sweep finish a wrap-up whose in-process
       *  timer died with its process. */
      wrapup_seconds?: number;
      /** When wrap-up actually began. Stamped by `WrapupManager`, deliberately never
       *  inferred from `ended_at` — two writers that agree today are still two
       *  writers (migration 088). */
      wrapup_started_at?: Date;
      /** When wrap-up actually ended. */
      wrapup_ended_at?: Date;
      /** How it ended — a `WrapupResolution`. Migration 088 CHECKs the values, and
       *  `stats()`'s `avg_wrapup_seconds` averages only the ones that measure the
       *  work rather than an interruption. */
      wrapup_resolution?: string;
      /**
       * WHY this attempt reached no agent (migration 119). Diagnosis only — the
       * compliance numerator keys on `ABANDONED_ATTEMPT_PREDICATE_SQL`, never on
       * this column, and NULL means "not an abandoned attempt" rather than
       * "cause unknown".
       */
      abandon_reason?: AgencyAbandonReason | null;
      /**
       * Advance `state` **only** if the row is currently one of these.
       *
       * The timestamp patch still lands either way — that is the whole point.
       * `answered` and `bridged` are emitted back-to-back by the bridge and their
       * handlers run concurrently (lifecycle listeners are invoked fire-and-forget),
       * so the two UPDATEs race and the loser wins the `state` column: a live,
       * bridged conversation could sit in the row as `answered` forever. Guarding
       * the whole statement instead would drop `answered_at` on that path, and
       * `answered_at` is the abandonment predicate's only input.
       *
       * Omit for an unconditional write — every caller that owns the transition
       * outright (dialing, ended, the sweeps) should.
       */
      only_from?: AgencyAttemptState[];
    } = {},
  ): Promise<AgencyCallAttemptRecord | null> {
    const { rows } = await getPool().query<AgencyCallAttemptRecord>(
      `UPDATE agency_call_attempts
          SET state = CASE
                        WHEN $11::text[] IS NULL OR state = ANY($11::text[]) THEN $2
                        ELSE state
                      END,
              webrtc_call_id = COALESCE($3, webrtc_call_id),
              outcome = COALESCE($4, outcome),
              dialed_at = COALESCE($5, dialed_at),
              answered_at = COALESCE($6, answered_at),
              bridged_at = COALESCE($7, bridged_at),
              ended_at = COALESCE($8, ended_at),
              talk_seconds = COALESCE($9, talk_seconds),
              wrapup_seconds = COALESCE($10, wrapup_seconds),
              wrapup_started_at = COALESCE($12, wrapup_started_at),
              wrapup_ended_at = COALESCE($13, wrapup_ended_at),
              wrapup_resolution = COALESCE($14, wrapup_resolution),
              abandon_reason = COALESCE($15, abandon_reason),
              updated_at = now()
        WHERE id = $1
      RETURNING *`,
      [
        id, state, patch.webrtc_call_id ?? null, patch.outcome ?? null,
        patch.dialed_at ?? null, patch.answered_at ?? null, patch.bridged_at ?? null,
        patch.ended_at ?? null, patch.talk_seconds ?? null,
        patch.wrapup_seconds ?? null,
        patch.only_from ?? null,
        // Appended rather than slotted in beside the other timestamps: `$11` is
        // read as `$11::text[]` in the CASE above, so renumbering to keep the
        // parameters tidy would silently rebind the state guard.
        patch.wrapup_started_at ?? null,
        patch.wrapup_ended_at ?? null,
        patch.wrapup_resolution ?? null,
        patch.abandon_reason ?? null,
      ],
    );
    return rows[0] ?? null;
  }

  /**
   * Record the media leg's id WITHOUT touching `state`.
   *
   * Separate from {@link setState} on purpose. The call id only exists once
   * `createBridgedCall` resolves, and by then the carrier may already have
   * answered — `onBridgeLifecycle` writes `bridged` from inside the dial. A
   * combined write would put `dialing` back over it and the row would read
   * `dialing` for the whole of a live conversation.
   *
   * A guarded "only if not already advanced" update would also close it, but this
   * removes the race rather than narrowing it: there is no state to lose, so no
   * ordering to get wrong. The attempt is already `dialing` from before the dial;
   * this write only ever had the id to contribute.
   */
  async attachWebrtcCall(attemptId: string, webrtcCallId: string): Promise<void> {
    await getPool().query(
      'UPDATE agency_call_attempts SET webrtc_call_id = $2, updated_at = now() WHERE id = $1',
      [attemptId, webrtcCallId],
    );
  }

  async findById(id: string): Promise<AgencyCallAttemptRecord | null> {
    const { rows } = await getPool().query<AgencyCallAttemptRecord>(
      'SELECT * FROM agency_call_attempts WHERE id = $1',
      [id],
    );
    return rows[0] ?? null;
  }

  /**
   * Record a disposition, idempotently on the code.
   *
   * **One guarded statement, and that is the whole design.** The predicate
   * `disposition_code IS NULL OR disposition_code = $2` makes first-write and
   * same-code replay the same successful path, and a different code a no-op that
   * writes nothing — atomically, so two submissions racing cannot interleave a
   * read with a write and let the second quietly overwrite the first. A
   * read-then-write in the route would look identical in every test and lose a
   * conversation record under a double-click.
   *
   * `null` therefore means one of exactly two things — no such attempt, or a
   * *different* code is already recorded — which the caller separates with a
   * follow-up read. That extra read only happens on the refusal path, so the
   * common case stays a single round trip.
   *
   * `notes` and `callback_at` are last-write-wins on a replay rather than
   * COALESCEd: an agent correcting their own note has to be able to shorten or
   * clear it, and COALESCE would make an empty string un-writable.
   */
  async recordDisposition(params: {
    attemptId: string;
    dispositionCode: string;
    notes: string | null;
    callbackAt: Date | null;
    actorUserId: string;
    onBehalf: boolean;
  },
  /**
   * Run on the caller's client (decision B8) so the DNC route's optional disposition
   * commits or rolls back with its `dnc_entries` row. Omitted: the pool.
   */
  deps: { client?: Pick<PoolClient, 'query'> } = {},
  ): Promise<AgencyCallAttemptRecord | null> {
    const { rows } = await (deps.client ?? getPool()).query<AgencyCallAttemptRecord>(
      `UPDATE agency_call_attempts
          SET disposition_code = $2,
              notes = COALESCE($3, notes),
              callback_at = $4,
              dispositioned_by_user_id = $5,
              dispositioned_on_behalf = $6,
              dispositioned_at = now(),
              updated_at = now()
        WHERE id = $1
          AND (disposition_code IS NULL OR disposition_code = $2)
      RETURNING *`,
      [
        params.attemptId, params.dispositionCode, params.notes,
        params.callbackAt, params.actorUserId, params.onBehalf,
      ],
    );
    return rows[0] ?? null;
  }

  /**
   * Save notes without dispositioning. Last write wins; `''` clears.
   *
   * Deliberately separate from {@link recordDisposition} because the two happen
   * at different times: agents type while the customer is still talking, and a
   * call that ends before they pick a code must not discard what they wrote.
   */
  async saveNotes(attemptId: string, notes: string): Promise<AgencyCallAttemptRecord | null> {
    const { rows } = await getPool().query<AgencyCallAttemptRecord>(
      'UPDATE agency_call_attempts SET notes = $2, updated_at = now() WHERE id = $1 RETURNING *',
      [attemptId, notes],
    );
    return rows[0] ?? null;
  }

  async findByWebrtcCallId(callId: string): Promise<AgencyCallAttemptRecord | null> {
    const { rows } = await getPool().query<AgencyCallAttemptRecord>(
      'SELECT * FROM agency_call_attempts WHERE webrtc_call_id = $1 AND state <> \'ended\' LIMIT 1',
      [callId],
    );
    return rows[0] ?? null;
  }

  /**
   * ALL non-terminal attempts, not just pre-answer ones. A bridged call still
   * holds an account concurrency slot, so excluding `answered`/`bridged` would
   * make the tick reserve agents and claim contacts only to be refused by the
   * guard, every tick, forever, whenever agents outnumber the account limit.
   */
  async countLive(campaignId: string): Promise<number> {
    const { rows } = await getPool().query<{ n: string }>(
      "SELECT COUNT(*)::text AS n FROM agency_call_attempts WHERE campaign_id = $1 AND state <> 'ended'",
      [campaignId],
    );
    return Number(rows[0]?.n ?? 0);
  }


  /**
   * One campaign's attempts, newest first, keyset-paginated — the supervisor
   * read of the audit spine.
   *
   * ── What this must NOT be ───────────────────────────────────────────────────
   * A list of CALLS (`agency_calls`) cannot answer the question this route exists
   * for: being a CALL list, it structurally cannot show an attempt that never produced a call
   * — a `queued` attempt the reaper ended as `orphaned`, an `abandoned` one that
   * rang and found no agent, a `failed` dial. Those are precisely the rows a
   * compliance question is about.
   *
   * So the FROM clause is `agency_call_attempts`, and `agency_calls` is not
   * joined at all — not even to enrich. `webrtc_call_id` is emitted as an id for
   * the client to resolve separately, because migration 075 made it deliberately
   * un-FK'd so the attempt row outlives a purged call, and any join to that table
   * would silently drop exactly the attempts whose history was purged.
   *
   * ── The agent join is LEFT, and that is not defensive ────────────────────────
   * `reserved_agent_id` is NULL on every attempt that failed before an agent was
   * on it, and `agency_agent_sessions` rows are per-shift. An inner join here
   * drops every never-reserved attempt — which is the "naive join drops the rows
   * you came for" trap in one line of SQL.
   *
   * The contact join is inner, and can be: `contact_id` is `NOT NULL REFERENCES
   * agency_contacts(id) ON DELETE CASCADE`, so an attempt without a contact row
   * cannot exist.
   *
   * ── The join carries `c.campaign_id = a.campaign_id`, and that is a PLAN fix ─
   * It is redundant for correctness — an attempt's contact is always on the
   * attempt's own campaign. It is load-bearing for the phone filter: both phone
   * indexes on `agency_contacts` are keyed `(campaign_id, <expr>)`, so without
   * it the leading column is unbound and neither can be used. A `?phone=`
   * filter then fell back to a **parallel sequential scan of the tenant's
   * contacts** — measured 153ms (exact) and 181ms (suffix) on 400k rows,
   * against 0.29ms with the predicate present. That is the sequential-scan shape
   * migration 095 exists to remove, reappearing on the one route the
   * migration's own header does not describe. Do not "simplify" it away.
   *
   * ── Plan ────────────────────────────────────────────────────────────────────
   * Driven by `idx_agency_attempts_keyset (campaign_id, created_at DESC,
   * id DESC)` (migration 095). Every filter here is a predicate applied to rows
   * that index has already produced in order, so the `LIMIT` stops the scan
   * early instead of sorting the campaign.
   *
   * ⚠️ **NOT** 075's `idx_agency_attempts_reporting`, and the difference is not
   * academic. That index is `(campaign_id, created_at DESC)` with no `id`, so it
   * cannot serve the row-wise `(created_at, id) < ($1, $2)` comparison: Postgres
   * degrades to reading the whole `created_at` tie group and sorting it, on
   * every page. It looks like exactly the index a keyset on
   * `(created_at DESC, id)` wants, and it is not — ties here are the
   * normal case, because the attempt batcher and roster ingest both insert
   * inside one transaction where `now()` is fixed. See migration 095's header
   * for the measured plan.
   */
  async listForCampaign(input: {
    campaignId: string;
    filters: AgencyAttemptFilters;
    after?: AgencyKeysetPosition;
    limit: number;
  }): Promise<AgencyKeysetPage<AgencyAttemptRow>> {
    const p = params();
    const conditions = [`a.campaign_id = ${p.add(input.campaignId)}`];
    const f = input.filters;

    if (f.states?.length) conditions.push(`a.state = ANY(${p.add(f.states)}::varchar[])`);
    if (f.outcomes?.length) conditions.push(`a.outcome = ANY(${p.add(f.outcomes)}::varchar[])`);
    if (f.dispositionCodes?.length) {
      conditions.push(`a.disposition_code = ANY(${p.add(f.dispositionCodes)}::varchar[])`);
    }
    // Through the session, because the attempt row holds a SESSION id and a
    // session id is meaningless to the person reading this page.
    //
    // ── Written as a subquery on `reserved_agent_id`, NOT as `s.agent_user_id
    //    = $n` on the LEFT-joined side ────────────────────────────────────────
    // Both are correct; they plan very differently. Filtering on the joined
    // column makes the agent's identity a join condition, and the planner
    // materialises the whole session table per outer row — measured 6.3ms
    // against 3.7ms for this form on a 1M-attempt campaign, and 590ms against
    // 343ms in the no-match case below.
    //
    // The filter is campaign-scoped as well as agent-scoped so that an agent
    // who has worked several campaigns matches only their sessions on THIS one.
    // Sessions are per-shift, so this is a handful of ids.
    if (f.agentUserId) {
      conditions.push(
        `a.reserved_agent_id = ANY(ARRAY(
           SELECT id FROM agency_agent_sessions
            WHERE campaign_id = ${p.add(input.campaignId)} AND agent_user_id = ${p.add(f.agentUserId)}))`,
      );
    }
    if (f.contactId) conditions.push(`a.contact_id = ${p.add(f.contactId)}::uuid`);
    if (f.phone) conditions.push(phoneCondition(f.phone, 'c', p));
    // Bound on `created_at`, the same column the index and the keyset order by —
    // NOT on `dialed_at`, which is NULL on an attempt that never left the
    // building and would drop those rows from a date-filtered view.
    if (f.from) conditions.push(`a.created_at >= ${p.add(f.from)}`);
    if (f.to) conditions.push(`a.created_at <= ${p.add(f.to)}`);
    if (input.after) conditions.push(keysetCondition(input.after, 'a', p));

    const sql = `
      SELECT a.id, a.campaign_id, a.contact_id, a.attempt_number, c.phone_e164, a.caller_id,
             s.agent_user_id, a.reserved_agent_id, a.state, a.outcome,
             a.disposition_code, a.notes, a.callback_at,
             a.dispositioned_by_user_id, a.dispositioned_at, a.dispositioned_on_behalf,
             a.webrtc_call_id, a.dialed_at, a.answered_at, a.bridged_at, a.ended_at,
             a.talk_seconds, a.wrapup_seconds, a.created_at,
             ${keysetAtSql('a.created_at')} AS cursor_at
        FROM agency_call_attempts a
        JOIN agency_contacts c
          ON c.id = a.contact_id AND c.campaign_id = a.campaign_id
        LEFT JOIN agency_agent_sessions s ON s.id = a.reserved_agent_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY a.created_at DESC, a.id DESC
       LIMIT ${p.add(input.limit + 1)}`;

    const { rows } = await getPool().query<AgencyCallAttemptRecord & {
      phone_e164: string; agent_user_id: string | null; cursor_at: string;
    }>(sql, p.values);

    return toKeysetPage(rows, input.limit, projectAttemptRow);
  }

  /**
   * One attempt, campaign-scoped, in the same shape the list serves.
   *
   * Campaign-scoped rather than by id alone, so the campaign's own ownership check
   * is what authorises the read: the route has already proved the caller owns the
   * campaign, and passing the campaign id here means an attempt id from a
   * different campaign — or a different tenant — cannot be substituted in the
   * path. Returning null for that case makes it a 404, which is also the honest
   * answer (that attempt is not on this campaign).
   *
   * Reuses `projectAttemptRow` and the list's projection deliberately: a detail
   * view whose fields drift from the list it was opened from is how a reader comes
   * to distrust both.
   */
  async findForCampaign(campaignId: string, attemptId: string): Promise<AgencyAttemptRow | null> {
    const { rows } = await getPool().query<AgencyCallAttemptRecord & {
      phone_e164: string; agent_user_id: string | null;
    }>(
      `SELECT a.id, a.campaign_id, a.contact_id, a.attempt_number, c.phone_e164, a.caller_id,
              s.agent_user_id, a.reserved_agent_id, a.state, a.outcome,
              a.disposition_code, a.notes, a.callback_at,
              a.dispositioned_by_user_id, a.dispositioned_at, a.dispositioned_on_behalf,
              a.webrtc_call_id, a.dialed_at, a.answered_at, a.bridged_at, a.ended_at,
              a.talk_seconds, a.wrapup_seconds, a.created_at
         FROM agency_call_attempts a
         JOIN agency_contacts c
           ON c.id = a.contact_id AND c.campaign_id = a.campaign_id
         LEFT JOIN agency_agent_sessions s ON s.id = a.reserved_agent_id
        WHERE a.id = $1 AND a.campaign_id = $2`,
      [attemptId, campaignId],
    );
    const row = rows[0];
    return row ? projectAttemptRow(row) : null;
  }

  /**
   * The agent-scoped attempt spine — one PERSON's dials, across every campaign.
   *
   * ── Why this cannot be a filter on `listForCampaign` ────────────────────────
   *
   * That method is campaign-scoped by construction: `campaign_id = $1` is its
   * first condition, its index is keyed on `campaign_id`, and its agent filter is
   * a subquery over the sessions of THAT campaign. An agent who works three
   * campaigns has three sessions and their record is spread across three of those
   * queries, which the caller would then have to merge and re-page by hand — and
   * a keyset cursor cannot be merged across result sets, because it names a
   * position in one ordering. Cross-campaign is a different read, so it is a
   * different method.
   *
   * ── The join is INNER on the session, which is the OPPOSITE of the campaign
   *    spine's LEFT — and both are right ───────────────────────────────────────
   *
   * There, LEFT is load-bearing: `reserved_agent_id` is NULL on every attempt
   * that failed before an agent was on it, and an inner join would drop exactly
   * those rows — the "naive join drops the rows you came for" trap. Here the
   * filter IS the agent, so an attempt with no reserved agent is not this
   * person's work by definition and the inner join is the predicate rather than
   * an accident of it. Note the consequence: this list can never show an attempt
   * that was never reserved, so it is not a substitute for the campaign spine
   * when the question is "what did we dial".
   *
   * ── The attempt points at a SESSION, not at a person ────────────────────────
   *
   * `reserved_agent_id` is an `agency_agent_sessions.id` (migration 075/079), and
   * `agent_user_id` — the app's `users.id`, opaque to the dialer tables (no FK) —
   * lives on the session. Sessions are per shift, so one person's history is a set of session
   * ids that grows every day they work. That two-hop join is why an agent's own
   * record needs its own route rather than a query parameter.
   *
   * ── Plan, stated honestly ───────────────────────────────────────────────────
   *
   * The campaign spine is driven end-to-end by `idx_agency_attempts_keyset`
   * (campaign_id, created_at DESC, id DESC) — the ORDER BY comes free and the
   * LIMIT stops the scan. Nothing gives that here: the leading column of every
   * attempt index is either `campaign_id` or `reserved_agent_id`, and this query
   * filters on a SET of session ids and orders by `created_at`. So the planner
   * drives from the session join and sorts what it gathers.
   *
   * Not even migration 104's `idx_agency_attempts_agent_dialed` — the index the
   * sibling `/stats` route exists on. It is partial (`WHERE dialed_at IS NOT
   * NULL`) and this query carries no predicate implying that, deliberately (see
   * the `created_at` bound below: an attempt that never dialled must still be
   * listed), so the planner cannot use it without dropping rows. Migration 104's
   * header states the same thing from the other side.
   *
   * That is accepted rather than indexed away, and the bound is what makes it
   * acceptable: the row set is one person's attempts, not a campaign's — a full
   * shift is hundreds of dials, a year is tens of thousands. The index that would
   * make this a single range scan is `(reserved_agent_id, created_at DESC, id
   * DESC)`, and it is deliberately NOT added: `agency_call_attempts` is written on
   * every dial, migration 090's header measures what a fourth overlapping index
   * costs that write path, and nobody has measured how deep anyone actually pages
   * this. Add it when a plan on production volume says so, not on this reasoning.
   */
  async listForAgent(input: {
    tenantId: string;
    accountId: string;
    agentUserId: string;
    filters: AgentAttemptFilters;
    after?: AgencyKeysetPosition;
    limit: number;
  }): Promise<AgencyKeysetPage<AgencyAttemptRow>> {
    const p = params();
    const f = input.filters;
    // The PATH's agent, never `filters.agentUserId`. The query parameter is part
    // of the imported filter vocabulary and is ignored here on purpose — see
    // `parseAgentAttemptFilters`.
    //
    // ── The tenant/account scope is NOT optional, and it is on the SESSION ────
    //
    // `agent_user_id` is the app's `users.id` and is opaque here: the dialer
    // tables cannot tell whose it is, cannot tell a real one from a guess, and
    // this read has no route by which the caller proves they own it. Every other read on this surface is
    // scoped by resolving a CAMPAIGN the caller owns first (`requireOwned`); this
    // one has no campaign in its path, so the scope has to be a predicate. Without
    // it, any authenticated tenant could read any other tenant's agent by
    // supplying their user id — the whole cross-campaign history, phone numbers
    // and dispositions included.
    //
    // Scoped on the session rather than on the attempt because the session is what
    // makes the attempt this person's work; both rows are stamped from the same
    // campaign, so they cannot disagree.
    const conditions = [
      `s.agent_user_id = ${p.add(input.agentUserId)}`,
      `s.tenant_id = ${p.add(input.tenantId)}`,
      `s.account_id = ${p.add(input.accountId)}`,
    ];

    if (f.campaignId) conditions.push(`a.campaign_id = ${p.add(f.campaignId)}::uuid`);
    if (f.states?.length) conditions.push(`a.state = ANY(${p.add(f.states)}::varchar[])`);
    if (f.outcomes?.length) conditions.push(`a.outcome = ANY(${p.add(f.outcomes)}::varchar[])`);
    if (f.dispositionCodes?.length) {
      conditions.push(`a.disposition_code = ANY(${p.add(f.dispositionCodes)}::varchar[])`);
    }
    if (f.contactId) conditions.push(`a.contact_id = ${p.add(f.contactId)}::uuid`);
    if (f.phone) conditions.push(phoneCondition(f.phone, 'c', p));
    // Bound on `created_at`, the column the keyset orders by — the same choice
    // `listForCampaign` makes, and for the same reason: `dialed_at` is NULL on an
    // attempt that never left the building, so bounding on it would drop those
    // rows from a date-filtered view. Note this is the opposite of the STATS
    // endpoint, which buckets on `dialed_at` precisely because it is aggregating
    // dials rather than listing attempts; the two are different questions and the
    // divergence is deliberate.
    if (f.from) conditions.push(`a.created_at >= ${p.add(f.from)}`);
    if (f.to) conditions.push(`a.created_at <= ${p.add(f.to)}`);
    if (input.after) conditions.push(keysetCondition(input.after, 'a', p));

    const sql = `
      SELECT a.id, a.campaign_id, a.contact_id, a.attempt_number, c.phone_e164, a.caller_id,
             s.agent_user_id, a.reserved_agent_id, a.state, a.outcome,
             a.disposition_code, a.notes, a.callback_at,
             a.dispositioned_by_user_id, a.dispositioned_at, a.dispositioned_on_behalf,
             a.webrtc_call_id, a.dialed_at, a.answered_at, a.bridged_at, a.ended_at,
             a.talk_seconds, a.wrapup_seconds, a.created_at,
             ${keysetAtSql('a.created_at')} AS cursor_at
        FROM agency_call_attempts a
        JOIN agency_contacts c
          ON c.id = a.contact_id AND c.campaign_id = a.campaign_id
        JOIN agency_agent_sessions s ON s.id = a.reserved_agent_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY a.created_at DESC, a.id DESC
       LIMIT ${p.add(input.limit + 1)}`;

    const { rows } = await getPool().query<AgencyCallAttemptRecord & {
      phone_e164: string; agent_user_id: string | null; cursor_at: string;
    }>(sql, p.values);

    return toKeysetPage(rows, input.limit, projectAttemptRow);
  }

  /**
   * Prior attempts on a contact's whole RETRY LINEAGE, newest first — the agent
   * panel's history block.
   *
   * ── This replaces a per-contact-row read, and the widening is the feature ──
   *
   * It used to be `WHERE contact_id = $1`, which is one campaign's worth of
   * history. Retry campaigns COPY contacts rather than sharing them (every
   * piece of per-campaign state lives on the row, and sharing one would make
   * `uq_agency_attempt_live` a cross-campaign lock), so "we called this person
   * twice last month" lives on a DIFFERENT row from the one being dialled now.
   * Keying on `root_contact_id` is what buys that history back, and the
   * denormalised root (migration 112) is what keeps it ONE indexed equality
   * instead of a recursive walk — see below for why that matters here
   * specifically.
   *
   * ── `ORDER BY` moved off `attempt_number`, and that is load-bearing ────────
   *
   * `attempt_number` is per contact ROW and **resets in every retry campaign**
   * (a retry is a fresh allowance, which is the point of authoring one).
   * Ordering by it interleaves two passes into nonsense: the parent's attempt 3
   * would sort above the child's attempt 1 even though the child's is more
   * recent. `ended_at DESC NULLS LAST` orders by when the dial actually finished,
   * and `NULLS LAST` keeps an attempt that never ended (reaped, orphaned) at the
   * bottom rather than at the top, where a NULL would otherwise sort first under
   * `DESC`. `attempt_number DESC` remains only as a deterministic tiebreaker for
   * two attempts that ended in the same microsecond.
   *
   * ── `campaign_name` joins the row because the agent needs it ───────────────
   *
   * "Attempt 2" means nothing once attempts come from two campaigns. The console
   * groups by campaign — this one first, then ancestors — which it cannot do from
   * an id it has no name for and no route to resolve.
   *
   * `c.campaign_id` is selected alongside `a.*` as the wire contract writes it;
   * the two hold the same value by construction (an attempt row carries the
   * campaign of its contact), and the join to `agency_contacts` is there for the
   * lineage predicate rather than for that column.
   *
   * ── ⚠️ THIS RUNS ON THE DIAL HOT PATH ─────────────────────────────────────
   *
   * `agency-dialer.ts#executeDial` calls it synchronously, BEFORE the dial, and
   * the pacing leader evaluates a campaign 4×/second. Three properties are not
   * negotiable and each has a test:
   *
   *   1. The caller's `try/catch` stays — history is nice-to-have and its absence
   *      must never cost the customer a call. A lineage query is a bigger thing
   *      to fail than a single-table read, which makes that guard more important
   *      rather than less.
   *   2. `PRIOR_ATTEMPT_LIMIT` stays. It is a display bound AND the bound on what
   *      this read can cost.
   *   3. Nothing may be added between the caller's `reserved` send and its dial.
   *
   * If this ever becomes slow enough to matter the answer is
   * `idx_agency_contacts_root` (migration 114) or dropping the campaign join —
   * never moving the send.
   *
   * @param rootContactId `agency_contacts.root_contact_id`, i.e. the head of the
   *   chain. Passing a plain `contact_id` for a contact that IS the head is the
   *   same value; passing it for a copied contact silently narrows the read to
   *   nothing, which is why the caller reads the column rather than reusing the id.
   */
  async findPriorForContactLineage(
    rootContactId: string,
    excludeAttemptId: string,
  ): Promise<Array<AgencyCallAttemptRecord & { campaign_name: string }>> {
    const { rows } = await getPool().query<AgencyCallAttemptRecord & { campaign_name: string }>(
      `SELECT a.*, c.campaign_id, cam.name AS campaign_name
         FROM agency_call_attempts a
         JOIN agency_contacts  c   ON c.id  = a.contact_id
         JOIN agency_campaigns cam ON cam.id = c.campaign_id
        WHERE c.root_contact_id = $1 AND a.id <> $2
        ORDER BY a.ended_at DESC NULLS LAST, a.attempt_number DESC
        LIMIT ${PRIOR_ATTEMPT_LIMIT}`,
      [rootContactId, excludeAttemptId],
    );
    return rows;
  }

  /**
   * The **startup** reaper's sweep, and only that.
   *
   * ⚠️ **Do not call this from a running process.** The justification below holds
   * at boot and nowhere else: it is "any non-terminal attempt is dead *because
   * this process has just started and no other process could own it*", not "any
   * non-terminal attempt is dead". The periodic sweep was once found calling
   * this with an age cutoff, which quietly reinterpreted a boot-only argument as
   * a general one and reaped live conversations — see `sweepOnce` in
   * `src/agency/reaper.ts` for what that cost and what replaced it.
   *
   * The parameter is retained (and the only caller passes `null`) because
   * narrowing it away would silently change the startup semantics; a live sweep
   * wants {@link findNonTerminalOlderThan} + {@link reapByIds} instead, which can
   * exclude the attempts something still owns.
   *
   * Returns the reaped rows so their contacts can be returned to the roster.
   */
  async reapNonTerminal(olderThan: Date | null): Promise<AgencyCallAttemptRecord[]> {
    const { rows } = await getPool().query<AgencyCallAttemptRecord>(
      `UPDATE agency_call_attempts
          SET state = 'ended', outcome = 'orphaned', ended_at = now(), updated_at = now()
        WHERE state = ANY($1::varchar[])
          AND ($2::timestamptz IS NULL OR created_at < $2)
      RETURNING *`,
      [AGENCY_ATTEMPT_LIVE_STATES as unknown as string[], olderThan],
    );
    return rows;
  }

  /**
   * Non-terminal attempts older than a cutoff — **candidates** for the periodic
   * sweep, not a verdict on any of them.
   *
   * Read-only on purpose. Deciding whether one of these is genuinely leaked needs
   * two liveness questions the database cannot answer — this replica's in-process
   * attempt map, and the Redis station-ownership key that says whether *some*
   * replica still holds the agent — so the decision cannot be a WHERE clause.
   */
  async findNonTerminalOlderThan(olderThan: Date): Promise<AgencyCallAttemptRecord[]> {
    const { rows } = await getPool().query<AgencyCallAttemptRecord>(
      `SELECT * FROM agency_call_attempts
        WHERE state = ANY($1::varchar[])
          AND created_at < $2
        ORDER BY created_at`,
      [AGENCY_ATTEMPT_LIVE_STATES as unknown as string[], olderThan],
    );
    return rows;
  }

  /**
   * Reap exactly these attempts, if they are *still* non-terminal.
   *
   * **The `state = ANY(live)` guard is the whole point and must not be dropped.**
   * It closes the window between the sweep's SELECT and this UPDATE: an attempt
   * that settled normally in between is already terminal, so this writes nothing
   * to it. Without the guard the sweep would overwrite a real outcome with
   * `orphaned` and return a contact whose call had in fact just connected —
   * the exactly-one-writer rule, enforced in SQL rather than hoped for.
   */
  async reapByIds(attemptIds: string[]): Promise<AgencyCallAttemptRecord[]> {
    if (attemptIds.length === 0) return [];
    const { rows } = await getPool().query<AgencyCallAttemptRecord>(
      `UPDATE agency_call_attempts
          SET state = 'ended', outcome = 'orphaned', ended_at = now(), updated_at = now()
        WHERE id = ANY($1::uuid[])
          AND state = ANY($2::varchar[])
      RETURNING *`,
      [attemptIds, AGENCY_ATTEMPT_LIVE_STATES as unknown as string[]],
    );
    return rows;
  }

  /**
   * Conversations whose wrap-up lapsed with nothing written up.
   *
   * Every clause is load-bearing:
   * - `state='ended'` + `outcome='connected'` + `bridged_at IS NOT NULL` — there
   *   was a real conversation. `bridged_at` rather than the outcome alone for the
   *   same reason `dispositionRefusal` keys on it: the outcome is a
   *   classification that can be absent or late, `bridged_at` is the instant
   *   media joined the two parties.
   * - `disposition_code IS NULL` — the agent did not write it up. A row that has
   *   one must never be revisited; that is a record of what was said to a
   *   customer.
   * - `contacts.state = 'connected'` — the contact is still parked waiting for
   *   that write-up. This is the actual harm being repaired, and joining on it
   *   means a contact some other path already released is left alone.
   * - the `ended_at + wrapup_seconds + grace` clock — `wrapup_seconds` is the
   *   window the campaign promised the agent, per row, because it is read off the
   *   attempt rather than off today's campaign config (an operator shortening it
   *   mid-shift must not retroactively expire wrap-ups that were owed longer).
   *
   * The campaign's `disposition_catalog` rides along because the caller must ask
   * `requiresDisposition` before stamping anything — a campaign that never owed a
   * disposition must not be given one.
   */
  async findLapsedWrapups(graceSeconds: number, limit = 500): Promise<AgencyLapsedWrapupRow[]> {
    const { rows } = await getPool().query<AgencyLapsedWrapupRow>(
      `SELECT a.*,
              c.disposition_catalog AS campaign_disposition_catalog,
              c.retry_policy        AS campaign_retry_policy,
              -- The contact's retry BUDGET, not the attempt's own
              -- attempt_number. The two are deliberately decoupled,
              -- and the policy is evaluated against the budget. This path does NOT
              -- bump it (the attempt was counted when it ended), so the stored value
              -- is already the post-attempt count the policy is defined on.
              ct.attempt_count      AS contact_attempt_count
         FROM agency_call_attempts a
         JOIN agency_contacts  ct ON ct.id = a.contact_id
         JOIN agency_campaigns  c ON c.id  = a.campaign_id
        WHERE a.state = 'ended'
          AND a.outcome = 'connected'
          AND a.bridged_at IS NOT NULL
          AND a.disposition_code IS NULL
          AND a.ended_at IS NOT NULL
          AND ct.state = 'connected'
          AND a.ended_at + make_interval(secs => COALESCE(a.wrapup_seconds, 0) + $1) < now()
        ORDER BY a.ended_at
        LIMIT $2`,
      [graceSeconds, limit],
    );
    return rows;
  }

  /**
   * Stamp the auto-close, if nothing has been written up in the meantime.
   *
   * `disposition_code IS NULL` is the same guarded-UPDATE discipline
   * `recordDisposition` uses, and here it is what makes the sweep lose a race it
   * should lose: an agent submitting their real disposition between this sweep's
   * SELECT and this write keeps it, and the sweep writes nothing.
   *
   * `dispositioned_by_user_id` is deliberately left NULL — nobody recorded this,
   * which is the entire meaning of the code being written. Attributing it to the
   * reserved agent would put their name on an admission they did not make.
   */
  async recordAutoDisposition(attemptId: string, code: string): Promise<AgencyCallAttemptRecord | null> {
    const { rows } = await getPool().query<AgencyCallAttemptRecord>(
      `UPDATE agency_call_attempts
          SET disposition_code = $2,
              dispositioned_at = now(),
              updated_at = now()
        WHERE id = $1
          AND disposition_code IS NULL
      RETURNING *`,
      [attemptId, code],
    );
    return rows[0] ?? null;
  }
}

/**
 * What a join attempt learned, in the same shape as `ReservationResult` in
 * `src/agency/agent-state-machine.ts`.
 *
 * A discriminated result rather than a thrown error, and for the same reason the
 * reservation CAS returns `'lost'`: an agent who is still live on another
 * campaign is a NORMAL, expected outcome of a join — a supervisor reassigned
 * them mid-shift and they have not left their old station — not an exceptional
 * one. Throwing would push a routine 409 through the same channel as a dead
 * database, and every caller would have to unwrap it by inspecting an error
 * message.
 *
 * The conflicting `session` rides along on the failure because the caller cannot
 * usefully report the refusal without it: "you are still joined to a campaign"
 * with no name is not actionable, and re-reading the row in the route would open
 * the very window this result closes.
 */
export type AgencyAgentJoinResult =
  | { ok: true; session: AgencyAgentSessionRecord }
  | { ok: false; reason: 'other_campaign'; session: AgencyAgentSessionRecord };

/**
 * How many times `joinOrRehydrate` re-attempts its upsert when the row blocking
 * it disappears mid-call. See the loop for why this is not 1 and not unbounded.
 */
const JOIN_UPSERT_ATTEMPTS = 3;

/**
 * One state transition, as the UPDATE that performed it saw both sides.
 *
 * Every write below projects this shape, which is what makes the event log
 * exhaustive **by construction** rather than by anyone remembering: the four
 * methods on this class are the only writers of `agency_agent_sessions.state`
 * anywhere in the server (verified by grep, not by assumption — the callers are the
 * three session routes, the dialer's bridge and release paths, the wrap-up
 * manager, the two presence paths in `runtime.ts`, and the startup reaper), so a
 * transition that reaches the database and not the log is not reachable without
 * adding a fifth writer.
 *
 * `from_state` is read in the SAME statement as the write — see each method for
 * the `FROM (SELECT …)` idiom — because reading it first would open a window in
 * which another replica moved the agent, and the log would then record a
 * transition that never happened.
 */
interface AgencySessionTransitionRow {
  session_id: string;
  tenant_id: string;
  account_id: string;
  campaign_id: string;
  agent_user_id: string;
  /** NULL when the session row was just created — there is no prior state. */
  from_state: AgencyAgentState | null;
  to_state: AgencyAgentState;
  from_break_reason: string | null;
  break_reason: string | null;
  /**
   * When the MUTATION happened — `clock_timestamp()` projected by the UPDATE
   * itself, never the moment the log INSERT later runs. See
   * {@link AgencyAgentSessionRepository.recordTransitions} for why the difference
   * is not cosmetic.
   */
  at: Date;
}

export class AgencyAgentSessionRepository {
  /**
   * Append the transition log rows for a write that just happened.
   *
   * ── THIS MUST NEVER FAIL A STATE TRANSITION, and that is why it is a second
   *    statement rather than a CTE on the first one ──────────────────────────
   *
   * Folding the INSERT into the UPDATE would be atomic and tempting, and it would
   * be wrong: any failure of the insert — the table absent because migration 105
   * has not run on this database yet, the `to_state` CHECK refusing a seventh
   * state someone added to migration 074 and not here, a disk full — would roll
   * back the transition itself. The consequences are not symmetric. **A dropped
   * event costs one occupancy row; a thrown error mid-transition takes an agent
   * off the floor or wedges a live call** — `releaseAgent` would not return them
   * to the pool, `enter` would not put them in wrap-up, `leave` would strand a
   * session that the tenant-unique index then blocks them from re-joining.
   *
   * So: separate statement, everything caught, logged at warn, and the caller
   * continues. The log line carries the states, because a swallowed CHECK
   * violation naming the offending state is the ONLY way the vocabulary drift
   * described in migration 105's header becomes discoverable.
   *
   * Awaited rather than fired and forgotten: an unawaited promise here would be
   * an unhandled rejection on a path that must not have one, and would make the
   * ordering of the log untestable. It is one INSERT on paths that already await
   * an UPDATE, and it is never on the pre-wire half of the bridge path — the
   * dialer sends the `bridged` frame to the agent BEFORE it mirrors any state, on
   * purpose.
   *
   * A transition that moved nothing writes nothing: a `setState` to the state the
   * session is already in (a double-click on Available, a release into a pool the
   * agent is already in) would otherwise log a zero-length interval, which sums
   * correctly and reads as noise. A `break → break` with a DIFFERENT reason is a
   * real transition and is kept, which is why the comparison includes the reason.
   *
   * ── `at` is CARRIED from the mutation, never defaulted by this INSERT ───────
   *
   * Migration 105 gives `at` a `DEFAULT now()`, and leaning on it would stamp the
   * event when THIS statement runs rather than when the state actually changed.
   * Being a second statement is what makes that gap exist at all (see above), and
   * the gap is not merely a small skew: two transitions on one session racing from
   * two replicas take the row lock in one order and reach this INSERT in whatever
   * order the two round trips happen to complete. Inverted, `lead(at) OVER
   * (PARTITION BY session_id ORDER BY at)` differences the wrong pairs — every
   * state after the inversion is attributed to the wrong interval, and the
   * durations are wrong by the gap between the two events. The log would say the
   * agent went to `wrapup` and then back `on_call` when they did the opposite.
   *
   * So each row carries the timestamp its own UPDATE projected, and the log is
   * ordered by the mutations rather than by the writes that record them.
   * `clock_timestamp()` rather than `now()` at the source, because `now()` is the
   * TRANSACTION's start instant: the loser of a row-lock race can have begun its
   * transaction first and still perform its UPDATE second, so `now()` can order
   * two racing transitions opposite to the order the database applied them.
   * `clock_timestamp()` is read after the row is locked and updated, so it cannot.
   * It is deliberately a hair later than the same statement's `state_since =
   * now()`; the two answer different questions and only `at` has to sort.
   */
  private async recordTransitions(rows: AgencySessionTransitionRow[]): Promise<void> {
    const moved = rows.filter((r) =>
      r.from_state !== r.to_state || (r.from_break_reason ?? null) !== (r.break_reason ?? null));
    if (moved.length === 0) return;
    try {
      // One statement for the whole batch via UNNEST — `markAllOffline` can move
      // the entire floor at boot, and a query per agent would make the startup
      // reaper's cost scale with the roster on a path that runs before the pacing
      // supervisor is allowed to start.
      await getPool().query(
        `INSERT INTO agency_agent_session_events
           (session_id, tenant_id, account_id, campaign_id, agent_user_id,
            from_state, to_state, break_reason, at)
         SELECT * FROM UNNEST(
           $1::uuid[], $2::uuid[], $3::uuid[], $4::uuid[], $5::uuid[],
           $6::varchar[], $7::varchar[], $8::varchar[], $9::timestamptz[])`,
        [
          moved.map((r) => r.session_id),
          moved.map((r) => r.tenant_id),
          moved.map((r) => r.account_id),
          moved.map((r) => r.campaign_id),
          moved.map((r) => r.agent_user_id),
          moved.map((r) => r.from_state),
          moved.map((r) => r.to_state),
          // Only carried into `break`. The session column keeps the last reason
          // after the agent returns, so copying it onto an `available` event would
          // label an interval with a reason that belongs to a different one.
          moved.map((r) => (r.to_state === 'break' ? r.break_reason : null)),
          // The mutation's own instant — see the header. Never omitted to let
          // migration 105's DEFAULT now() fill it in.
          moved.map((r) => r.at),
        ],
      );
    } catch (err) {
      log.warn(
        {
          err,
          sessions: moved.map((r) => r.session_id),
          transitions: moved.map((r) => `${r.from_state ?? 'new'}->${r.to_state}`),
        },
        'Could not record agent state transition events — occupancy will under-report this interval',
      );
    }
  }

  async findById(id: string): Promise<AgencyAgentSessionRecord | null> {
    const { rows } = await getPool().query<AgencyAgentSessionRecord>(
      'SELECT * FROM agency_agent_sessions WHERE id = $1',
      [id],
    );
    return rows[0] ?? null;
  }

  /**
   * Join, or REHYDRATE an existing live session.
   *
   * A returning agent must resume their row rather than get a new one — the unique
   * index allows exactly one live session per (tenant, agent) since migration 092
   * — and must land in `break`, never `available`, so the engine cannot dial into a
   * pool that has not demonstrably re-attached. The agent clicks once to go
   * available.
   *
   * ── Why the uniqueness is per TENANT and what that makes reachable (092) ───
   * 074 allowed one live session per (campaign, agent), so one human could hold
   * two live sessions on two campaigns. The reservation CAS key is
   * `agency:agent:{sessionId}:state` — per session — so those two sessions are two
   * independently reservable agents attached to one pair of ears, and both pacing
   * ticks can bridge a customer at once. 092 makes the database refuse the second
   * session, which is why this method can now FAIL rather than always returning a
   * row.
   *
   * ── Why this is one statement and never check-then-insert ──────────────────
   * A `SELECT` for an existing live session followed by an `INSERT` has a window
   * between them, and that window is precisely the double-join this exists to
   * prevent — two console tabs, or a reconnect racing a fresh join, both read
   * "nothing live" and both insert. The arbiter index does the checking, inside
   * the same statement as the write.
   *
   * ── Why `DO UPDATE … WHERE campaign_id = EXCLUDED.campaign_id` ─────────────
   * The conflict has two meanings and they must not be collapsed:
   *   * same campaign  ⇒ this is a REHYDRATE. Update and return the row.
   *   * other campaign ⇒ this is the refusal. The `WHERE` makes the DO UPDATE
   *     match nothing, so `RETURNING` yields zero rows — **and, critically, the
   *     other campaign's row is left exactly as it was.** An unconditional DO
   *     UPDATE would stamp this replica's `owner_replica` onto a session live on
   *     another campaign, i.e. quietly hijack the ownership of an agent who may
   *     be mid-conversation, and only then report a conflict.
   */
  async joinOrRehydrate(params: {
    tenantId: string;
    accountId: string;
    campaignId: string;
    agentUserId: string;
    replicaId: string;
  }): Promise<AgencyAgentJoinResult> {
    for (let attempt = 0; attempt < JOIN_UPSERT_ATTEMPTS; attempt++) {
      // ── The `prev` CTE is how a join gets logged (migration 105) ───────────
      //
      // The upsert has two outcomes and the transition log needs to tell them
      // apart: a fresh INSERT is the session's FIRST transition, which the log
      // records with `from_state = NULL`; a rehydrate is `offline → break` (or no
      // transition at all, when the agent's session was already live in a working
      // state and only `owner_replica`/`last_heartbeat` move).
      //
      // `RETURNING` on an `ON CONFLICT DO UPDATE` yields the NEW row, so it cannot
      // answer that on its own. All CTEs of one statement see the same snapshot,
      // so `prev` reads the row as it was before the upsert; the outer LEFT JOIN
      // then makes `from_state IS NULL` mean exactly "this row did not exist",
      // which is the same thing migration 105 uses NULL to mean. The `xmax = 0`
      // inserted-vs-updated trick would answer the narrower question and still
      // leave the previous state unknown.
      //
      // `prev` is keyed on the same predicate as the arbiter index — the agent's
      // one live session in the tenant (092) — not on the proposed row, because
      // the conflicting row may be on a different campaign.
      const { rows } = await getPool().query<AgencyAgentSessionRecord & {
        from_state: AgencyAgentState | null;
        from_break_reason: string | null;
        at: Date;
      }>(
        `WITH prev AS (
           SELECT id, state, break_reason FROM agency_agent_sessions
            WHERE tenant_id = $1 AND agent_user_id = $4 AND left_at IS NULL
         ), upserted AS (
           INSERT INTO agency_agent_sessions
             (tenant_id, account_id, campaign_id, agent_user_id, state, owner_replica, last_heartbeat)
           VALUES ($1, $2, $3, $4, 'break', $5, now())
           ON CONFLICT (tenant_id, agent_user_id) WHERE left_at IS NULL
           DO UPDATE SET owner_replica = EXCLUDED.owner_replica,
                         last_heartbeat = now(),
                         state = CASE WHEN agency_agent_sessions.state = 'offline'
                                      THEN 'break' ELSE agency_agent_sessions.state END,
                         updated_at = now()
             WHERE agency_agent_sessions.campaign_id = EXCLUDED.campaign_id
           RETURNING *
         )
         SELECT upserted.*, prev.state AS from_state, prev.break_reason AS from_break_reason,
                clock_timestamp() AS at
           FROM upserted LEFT JOIN prev ON prev.id = upserted.id`,
        [params.tenantId, params.accountId, params.campaignId, params.agentUserId, params.replicaId],
      );
      const row = rows[0];
      if (row) {
        // Destructured rather than passed through: the two log-only columns must
        // not ride along on `AgencyAgentSessionRecord`, which is spread into the
        // bootstrap payload — an extra field on the wire is a contract nobody
        // agreed to and one that the console would start depending on.
        // `at` is destructured out for the same reason the two `from_*` columns
        // are: `AgencyAgentSessionRecord` is spread into the bootstrap payload,
        // and a log-only column riding along becomes a contract nobody agreed to.
        const { from_state, from_break_reason, at, ...session } = row;
        await this.recordTransitions([{
          session_id: session.id,
          tenant_id: session.tenant_id,
          account_id: session.account_id,
          campaign_id: session.campaign_id,
          agent_user_id: session.agent_user_id,
          from_state,
          from_break_reason,
          to_state: session.state,
          break_reason: session.break_reason,
          at,
        }]);
        return { ok: true, session };
      }

      // Zero rows means the DO UPDATE's WHERE refused: something live exists for
      // this agent and it is not the row we proposed. Read it, so the refusal can
      // name the campaign the agent has to leave.
      //
      // This read is NOT synchronised with the upsert, and both branches below
      // exist because of that gap rather than in spite of it.
      const blocker = await this.findLiveForAgent(params.tenantId, params.agentUserId);

      if (blocker && blocker.campaign_id !== params.campaignId) {
        return { ok: false, reason: 'other_campaign', session: blocker };
      }

      // Two ways to arrive here, and both mean "the obstacle is gone, try again":
      //
      //  * no blocker at all — the other session left between the upsert and this
      //    read (the agent clicked Leave on the old campaign at exactly the wrong
      //    moment);
      //  * a blocker on the REQUESTED campaign — a concurrent join for the same
      //    agent landed here in the same gap, so this is a rehydrate, not a
      //    conflict. Returning `other_campaign` for it would tell the agent to
      //    leave the station they are trying to reach: an instruction that cannot
      //    be followed, on the only error path the 1:1 rule makes reachable. The
      //    `ok:true` path carries an equivalent mismatch assertion in the route,
      //    and that one is documented as unreachable — this is the reachable half
      //    and it was the half with no guard.
      //
      // Bounded rather than `while (true)` because the loop's exit depends on
      // another actor: an agent flapping join/leave could otherwise hold this
      // request open indefinitely. Three passes cannot be reached by anything but
      // a pathological client, and exhausting them is a real anomaly worth
      // surfacing — the one case here that IS exceptional, hence the throw.
    }
    // No tenant or agent id in the message. Fastify serialises an uncaught error's
    // `message` into the 500 body, so anything interpolated here is returned to
    // whoever made the request; the identifiers belong in the log line the caller
    // writes, not on the wire.
    throw new Error(
      `joinOrRehydrate could not settle after ${JOIN_UPSERT_ATTEMPTS} attempts: ` +
      `the agent's live session kept changing between the upsert and the read`,
    );
  }

  /**
   * The agent's one live session anywhere in the tenant, if any.
   *
   * `LIMIT 1` is a formality, not a choice between candidates: `uq_agency_agent_live_tenant`
   * (092) permits at most one row to satisfy this predicate. It is written this
   * way so a future reader does not have to reason about which row they get.
   */
  async findLiveForAgent(tenantId: string, agentUserId: string): Promise<AgencyAgentSessionRecord | null> {
    const { rows } = await getPool().query<AgencyAgentSessionRecord>(
      `SELECT * FROM agency_agent_sessions
        WHERE tenant_id = $1 AND agent_user_id = $2 AND left_at IS NULL
        LIMIT 1`,
      [tenantId, agentUserId],
    );
    return rows[0] ?? null;
  }

  /**
   * The one mirror write. Every agent-initiated move, every dialer release, the
   * wrap-up entry and both presence paths land here.
   *
   * ── The locking CTE is how the transition log learns `from_state` ──────────
   *
   * `prev` is read in the same statement as the write, so `prev.state` is the
   * state the agent is leaving and `s.state` the one they are entering with no
   * window in between. A `SELECT` before the `UPDATE` would have that window, and
   * another replica moving the agent inside it would make the log record a
   * transition that never happened. It is also why this is not two round trips on
   * the dial path.
   *
   * ── Why `FOR UPDATE`, and not a plain subquery ─────────────────────────────
   *
   * This was `FROM (SELECT … WHERE id = $1) prev`, on the reasoning that a
   * subquery sees the statement's own snapshot and therefore the pre-UPDATE row.
   * That is true, and it is the bug: under READ COMMITTED the snapshot is taken
   * when the statement STARTS. A second writer that blocks on the first's row
   * lock re-checks its WHERE against the updated row when it unblocks
   * (EvalPlanQual) but does NOT re-evaluate the joined subquery — so `prev` is
   * the value from before the wait. Two concurrent moves on one session logged
   * `offline → on_call` and `offline → wrapup`: the second event names a state
   * the agent had already left, which is exactly the "transition that never
   * happened" the paragraph above set out to prevent.
   *
   * A locking clause behaves differently, and that is the whole fix: `FOR UPDATE`
   * waits on the lock and then follows the update chain to the newest committed
   * version of the row, so `prev` is what the previous writer left behind. The
   * single-statement property is unchanged.
   *
   * `state_since` still restamps exactly as before; the log is additive.
   */
  async setState(id: string, state: AgencyAgentState, breakReason?: string | null): Promise<void> {
    const { rows } = await getPool().query<AgencySessionTransitionRow>(
      `WITH prev AS (
         SELECT id, state, break_reason FROM agency_agent_sessions WHERE id = $1 FOR UPDATE
       )
       UPDATE agency_agent_sessions s
          SET state = $2, break_reason = $3, state_since = now(), updated_at = now()
         FROM prev
        WHERE s.id = prev.id
       RETURNING s.id AS session_id, s.tenant_id, s.account_id, s.campaign_id, s.agent_user_id,
                 prev.state AS from_state, prev.break_reason AS from_break_reason,
                 s.state AS to_state, s.break_reason,
                 -- The transition's own instant, projected by the statement that
                 -- performed it. recordTransitions inserts it verbatim rather than
                 -- letting migration 105's DEFAULT now() stamp the log write.
                 clock_timestamp() AS at`,
      [id, state, breakReason ?? null],
    );
    await this.recordTransitions(rows);
  }

  async heartbeat(id: string): Promise<void> {
    await getPool().query(
      'UPDATE agency_agent_sessions SET last_heartbeat = now(), updated_at = now() WHERE id = $1',
      [id],
    );
  }

  /**
   * Leave the station. Logged like any other transition — the `offline` event is
   * what closes the agent's last interval, so an unlogged leave would leave that
   * interval open and running to `min(now, bucket_end)` forever.
   *
   * `left_at IS NULL` on the UPDATE, so a repeated leave writes nothing and
   * therefore logs nothing: zero rows returned, zero events.
   */
  async leave(id: string): Promise<void> {
    const { rows } = await getPool().query<AgencySessionTransitionRow>(
      `WITH prev AS (
         SELECT id, state, break_reason FROM agency_agent_sessions WHERE id = $1 FOR UPDATE
       )
       UPDATE agency_agent_sessions s
          SET state = 'offline', left_at = now(), updated_at = now()
         FROM prev
        WHERE s.id = prev.id AND s.left_at IS NULL
       RETURNING s.id AS session_id, s.tenant_id, s.account_id, s.campaign_id, s.agent_user_id,
                 prev.state AS from_state, prev.break_reason AS from_break_reason,
                 s.state AS to_state, s.break_reason,
                 -- The transition's own instant, projected by the statement that
                 -- performed it. recordTransitions inserts it verbatim rather than
                 -- letting migration 105's DEFAULT now() stamp the log write.
                 clock_timestamp() AS at`,
      [id],
    );
    await this.recordTransitions(rows);
  }

  /** Live sessions on a campaign, whatever their state. */
  async findLiveForCampaign(campaignId: string): Promise<AgencyAgentSessionRecord[]> {
    const { rows } = await getPool().query<AgencyAgentSessionRecord>(
      'SELECT * FROM agency_agent_sessions WHERE campaign_id = $1 AND left_at IS NULL',
      [campaignId],
    );
    return rows;
  }

  /**
   * Every session → offline. The startup reaper's agent half.
   *
   * Logged, and this one matters more than it looks: it is the transition that
   * closes every interval the CRASHED process left open. Without it, an agent who
   * was `on_call` when the replica died would have an interval running from that
   * moment to `min(now, bucket_end)` — the whole outage attributed to their
   * on-call time — and the next thing they do would start a second one. The
   * event's `at` is the reap, so the outage is charged to `offline` from the reap
   * onward and to whatever they were doing up to it. The span between the crash
   * and the reap is still mis-attributed to the pre-crash state; that is
   * irreducible without a heartbeat-derived end, and it is bounded by the boot
   * time of one replica.
   *
   * The bulk `FROM (SELECT …)` self-join is the same idiom as `setState`, applied
   * per row: the subquery is the pre-update snapshot of exactly the rows the
   * UPDATE will touch, joined back on `id`. Returning the rows rather than
   * `rowCount` also makes the count the length of what was actually written.
   */
  async markAllOffline(): Promise<number> {
    const { rows } = await getPool().query<AgencySessionTransitionRow>(
      `WITH prev AS (
         SELECT id, state, break_reason FROM agency_agent_sessions
          WHERE left_at IS NULL AND state <> 'offline' FOR UPDATE
       )
       UPDATE agency_agent_sessions s
          SET state = 'offline', updated_at = now()
         FROM prev
        WHERE s.id = prev.id
       RETURNING s.id AS session_id, s.tenant_id, s.account_id, s.campaign_id, s.agent_user_id,
                 prev.state AS from_state, prev.break_reason AS from_break_reason,
                 s.state AS to_state, s.break_reason,
                 -- Per row, so a sweep of the whole floor does not collapse to a
                 -- single instant. See recordTransitions for why not now().
                 clock_timestamp() AS at`,
    );
    await this.recordTransitions(rows);
    return rows.length;
  }
}

/**
 * The rolling abandonment window.
 *
 * Its own class because it is the one reader whose whole purpose is to be an
 * INDEPENDENT audit of the Prometheus counters — it touches nothing in process,
 * derives everything from raw columns, and must stay that way. See
 * `src/agency/abandonment-metrics.ts` for why that independence is load-bearing.
 */
export class AgencyAbandonmentRepository {
  /**
   * Answered and abandoned counts per campaign over the rolling window.
   *
   * One grouped aggregate rather than a query per campaign: this runs on a timer
   * against a table that grows for the life of the account, and N+1 over campaigns
   * would scale with the thing most likely to grow.
   *
   * The window is bounded on `answered_at`, not `created_at`: the regulatory
   * question is "of the calls a customer picked up in the last 24 hours, how many
   * reached nobody", so an attempt that was placed yesterday and answered ten
   * minutes ago belongs in this window.
   */
  async window24h(): Promise<AgencyAbandonmentWindowRow[]> {
    const { rows } = await getPool().query<{
      tenant_id: string; campaign_id: string; answered: string; abandoned: string;
      status: string | null; ceiling_pct: number | null;
    }>(
      `SELECT a.tenant_id,
              a.campaign_id,
              COUNT(*)::text AS answered,
              COUNT(*) FILTER (WHERE ${ABANDONED_ATTEMPT_PREDICATE_SQL})::text AS abandoned,
              c.status,
              c.abandonment_ceiling_pct AS ceiling_pct
         FROM agency_call_attempts a
         LEFT JOIN agency_campaigns c ON c.id = a.campaign_id
        WHERE a.state = 'ended'
          AND a.answered_at IS NOT NULL
          AND a.answered_at > now() - ($1 || ' hours')::interval
        GROUP BY a.tenant_id, a.campaign_id, c.status, c.abandonment_ceiling_pct`,
      [ABANDONMENT_WINDOW_HOURS],
    );
    return rows.map((r) => ({
      tenant_id: r.tenant_id,
      campaign_id: r.campaign_id,
      answered: Number(r.answered),
      abandoned: Number(r.abandoned),
      status: r.status,
      ceiling_pct: r.ceiling_pct,
    }));
  }

}

/**
 * One row of the live-concurrency read: how many attempts a campaign is holding
 * in one non-terminal state, right now.
 *
 * `state` is deliberately typed `string` and NOT `AgencyAttemptState`, even
 * though `ck_agency_attempt_state` (migration 075) does constrain the column to
 * exactly that union. Typing it would make the CHECK constraint the definition of
 * a **Prometheus label vocabulary**, and the house rule is that label values are
 * bounded by *source code*, never by anything outside it — a migration can widen
 * that constraint in a commit that touches no TypeScript, and the assertion would
 * go on typechecking while the metric store minted a new permanent series.
 * Narrowing therefore happens once, in the publisher, against
 * `AGENCY_ATTEMPT_LIVE_STATES`; typing it here would let a reader assume that had
 * already happened.
 */
export interface AgencyLiveAttemptStateRow {
  tenant_id: string;
  campaign_id: string;
  state: string;
  live: number;
}

/**
 * The dialer's live-concurrency read — attempts in flight, split by state.
 *
 * It feeds `agency_live_attempts_current` (published by
 * `live-concurrency-metrics.ts`), the dialer's "how many calls are up" number,
 * derived from the attempts table rather than from any in-process map.
 *
 * Its own class for the same reason `AgencyAbandonmentRepository` has one — it
 * exists solely to be read by a metrics publisher on a timer, touches nothing in
 * process, and derives everything from raw columns. Nothing on the dial path may
 * come to depend on it, because a metrics read that acquires a caller is a
 * metrics read that can fail a call.
 *
 * ── Not tenant-scoped, deliberately ────────────────────────────────────────
 * Every `/api/v1/*` read is scoped by both headers; this is not one. It is the
 * same fleet-wide operator read as `window24h()` — a replica publishes what it
 * can see of the whole floor, and Prometheus labels the result per tenant.
 */
export class AgencyLiveConcurrencyRepository {
  /**
   * Non-terminal attempts per `(tenant, campaign, state)`.
   *
   * **One grouped aggregate, never a query per campaign.** Campaigns are created
   * per roster upload and are unbounded over an account's life, so an N+1 here
   * would scale with the thing most likely to grow — and it would do so on a
   * timer, which is how a metrics poller becomes the reason the database is busy.
   *
   * `state <> 'ended'` is written as a **literal, not a bound parameter**, and
   * that is load-bearing twice over:
   *
   * 1. It matches `uq_agency_attempt_live`'s partial-index predicate
   *    (`ON agency_call_attempts (contact_id) WHERE state <> 'ended'`,
   *    migration 075) *byte for byte*, which is what lets the planner prove the
   *    index covers the query. Bound as `$1` the predicate is opaque at plan
   *    time and this degrades to a scan of a table that grows for the life of
   *    the account. So the cost of this read is bounded by **live concurrency**
   *    (tens of rows) rather than by history.
   * 2. It sidesteps the `42P08` parameter-typing trap this codebase has shipped
   *    twice (`transitionStatus`, `claimTerminal`): a statement with no
   *    parameters cannot have a `$n` deduced into conflicting types, and a
   *    mocked pool never parses SQL, so a unit test could not have caught it.
   *
   * It is also the **same predicate `AgencyAttemptRepository.countLive` uses** for
   * the pacing tick's `occupied` term. That is the point of matching it rather
   * than listing the five live states: the gauge and the tick then cannot
   * disagree about what "in flight" means, so the published family reconciles
   * with the number the tick subtracted from the account limit. Two definitions of
   * occupancy — one an operator reads, one the dialer acts on — would drift apart.
   *
   * ⚠️ Reconciling it in PromQL means `sum by (state)` ACROSS STATES and then
   * `max` ACROSS REPLICAS, in that order — never a bare `sum()`. This query is
   * fleet-wide and unleadered, so every replica publishes the identical series and
   * a bare `sum()` returns R times the truth. An earlier version of this
   * paragraph said `sum(agency_live_attempts_current)` *is* occupancy, which is
   * true of one replica's samples and false of the metric anyone actually queries.
   * See the aggregator note on the gauge in
   * `@magick-agency/observability/metrics/agency`.
   *
   * No `ORDER BY`: the consumer publishes a set of gauge samples, so ordering
   * would buy nothing and cost a sort on every tick.
   */
  async liveByState(): Promise<AgencyLiveAttemptStateRow[]> {
    const { rows } = await getPool().query<{
      tenant_id: string; campaign_id: string; state: string; live: string;
    }>(
      `SELECT tenant_id,
              campaign_id,
              state,
              COUNT(*)::text AS live
         FROM agency_call_attempts
        WHERE state <> 'ended'
        GROUP BY tenant_id, campaign_id, state`,
    );
    // `::text` because pg hands `int8` back as a string; parsed here rather than
    // in the publisher so a gauge can never be `set` to a string.
    return rows.map((r) => ({
      tenant_id: r.tenant_id,
      campaign_id: r.campaign_id,
      state: r.state,
      live: Number(r.live),
    }));
  }
}

/**
 * Every group dimension's SQL, as the inverted `Record` — and this object IS the
 * injection answer for `group_by`.
 *
 * `sort`, `order`, `group_by` and `limit` all arrive as free text. `limit` is a
 * bound parameter; the other three resolve through a `Record` lookup keyed on a
 * union member that {@link parseGroupedStatsQuery} has already validated, to a
 * fragment written here in source. So no caller-supplied character can reach the
 * statement even if the vocabulary check were removed — the lookup would simply
 * miss.
 *
 * `Record<AgencyGroupDimension, …>` rather than a `switch`: a seventh dimension
 * added to the union is a missing required key here, i.e. a build error naming it,
 * where a `switch` with a `default` would compile and silently group by whatever
 * the fallback picked.
 *
 * ── Three fragments per dimension, and the split is load-bearing ───────────
 *
 * `select` is the CTE's expression, in its NATURAL type. `project` is the outer
 * select item, which is where a numeric dimension is cast to text. They are not
 * one fragment because the ORDER BY reads `g.<alias>` — the CTE's column, at the
 * CTE's type — and **a text-typed hour sorts `'10'` before `'9'`**. Casting inside
 * the CTE would therefore make `sort=key` on an hour-of-day series silently
 * mis-order the x-axis, and with the slice now in SQL it would also change WHICH
 * hours a `limit` returns. Keeping the cast at the outer boundary makes the
 * ordering numeric because the column is.
 *
 * The cast still has to happen, though, and `::int::text` is deliberate on both
 * halves: node-pg hands `numeric` back as a STRING and `int4` back as a JS number,
 * so `EXTRACT`'s `numeric` would give this row mapper two conventions in one row.
 * `::int` states that the value is integral (a day-of-week is not `3.0`), and
 * `::text` puts every column on this statement through the same `Number()` hop as
 * the counters — which is also the only way a fixture that types them as strings,
 * the way node-pg actually returns them, exercises the mapping at all.
 *
 * `day` reuses {@link bucketStartSql}, not a second `to_char(date_trunc(...))`:
 * the contract says a `day` key has the same format as the per-agent record's
 * `bucket_start`, and sharing the expression is what makes that true rather than
 * claimed. It also inherits that function's reason for formatting in SQL — node-pg
 * parses a bare `timestamp` into a LOCAL-time `Date`, putting the server's zone
 * back on a value the query removed it from. It sorts correctly as text because
 * `YYYY-MM-DD` is lexicographically chronological, which is half of why that
 * format was chosen.
 */
const GROUP_DIMENSION_SQL: Record<
  AgencyGroupDimension,
  { select: string; alias: string; project: string }
> = {
  agent: { select: 's.agent_user_id', alias: 'agent_user_id', project: 'g.agent_user_id' },
  campaign: { select: 'a.campaign_id', alias: 'campaign_id', project: 'g.campaign_id' },
  // NULL is a real key value here, not a gap — an attempt with no disposition
  // submitted is the number a supervisor came for. `GROUP BY` puts every NULL in
  // one group, which is exactly the wanted behaviour and is NOT true of a join.
  // It is also the ONLY dimension that can be null, which is what the explicit
  // NULLS LAST in every ORDER BY is there for.
  disposition: {
    select: 'a.disposition_code', alias: 'disposition_code', project: 'g.disposition_code',
  },
  day: {
    select: bucketStartSql('day', 'a.dialed_at', AGENCY_RESOLVED_ZONE_SQL),
    // NOT `day`: that is an SQL keyword. Non-reserved, so `AS day` is legal -- but
    // the tree has no precedent for aliasing a keyword and `day_start` costs nothing
    // while matching the per-agent read's own `bucket_start`. The wire key is still
    // `day`; GROUP_KEY_READERS maps it. (Written when this statement had never run
    // against Postgres; it now does, in `agent-grouped-read.test.ts`, which groups
    // by this dimension -- the alias is kept on the two reasons that survive rather
    // than on the one that expired.)
    alias: 'day_start',
    project: 'g.day_start',
  },
  // 0 = Sunday .. 6 = Saturday, which is `EXTRACT(DOW)`'s own numbering and the
  // reason the contract types this as a NUMBER: restating it as a day name invites
  // an off-by-one against ISO's 1=Monday, and the name is a locale decision the
  // console owns.
  day_of_week: {
    select: `EXTRACT(DOW FROM (a.dialed_at AT TIME ZONE ${AGENCY_RESOLVED_ZONE_SQL}))::int`,
    alias: 'day_of_week',
    project: 'g.day_of_week::text AS day_of_week',
  },
  hour_of_day: {
    select: `EXTRACT(HOUR FROM (a.dialed_at AT TIME ZONE ${AGENCY_RESOLVED_ZONE_SQL}))::int`,
    alias: 'hour_of_day',
    project: 'g.hour_of_day::text AS hour_of_day',
  },
};

/**
 * The ORDER BY term for each METRIC sort key. `key` is absent on purpose — it is
 * the grouped dimensions themselves, assembled from
 * {@link GROUP_DIMENSION_SQL} at the call site, so it has no fixed text.
 *
 * ── Two things every entry here has to get right ────────────────────────────
 *
 *  1. **`::numeric`, always.** The shared metric builder casts every counter to
 *     `::text`, so ordering them as they arrive would rank `'9'` above `'400'` —
 *     a silently wrong "top 200 by attempts" that no type checker can see.
 *  2. **`NULLIF(<denominator>, 0)`, never a bare division.** Postgres raises
 *     `22012 division_by_zero` on `x / 0`, which nothing maps to a status, so a
 *     single group that connected nobody would 500 the whole page under
 *     `?sort=success_rate_pct`. `NULLIF` makes it NULL, which the explicit
 *     `NULLS LAST` then files where the contract says an unranked row goes.
 *
 * ⚠️ **These expressions ORDER the rows; they do not PRODUCE the served rates.**
 * The payload's `connect_rate_pct` / `success_rate_pct` / `aht_seconds` come from
 * {@link ratePct} / {@link ratio} in {@link groupRowFromSql}, like every other rate
 * on this surface. Two reasons the numbers are not read off these columns instead:
 * a Postgres `numeric` division round-tripped through text can differ in its last
 * digits from the JS float division the roster and the per-agent record use, so the
 * same data would report two slightly different rates on two adjacent screens; and
 * the null-on-empty-denominator rule would then have two implementations. What
 * these must agree with the helpers on is only the ORDER — which holds because
 * `x/d` and `100·x/d` rank identically for positive `d`, and both are null on
 * exactly `d = 0`.
 */
const GROUP_SORT_ORDER_SQL: Record<Exclude<AgencyGroupSort, 'key'>, string> = {
  attempts: 'g.attempts::numeric',
  connected: 'g.connected::numeric',
  successes: 'g.successes::numeric',
  connect_rate_pct: 'g.connected::numeric / NULLIF(g.attempts::numeric, 0)',
  success_rate_pct: 'g.successes::numeric / NULLIF(g.connected::numeric, 0)',
  aht_seconds:
    '(g.talk_seconds::numeric + g.wrapup_seconds::numeric) / NULLIF(g.connected::numeric, 0)',
};

/**
 * One row as the grouped statement returns it: every column a string, and the key
 * columns present only when their dimension was grouped.
 *
 * Optional on the type rather than asserted, because the statement genuinely does
 * not select them — a mapper that read `row.day` on an agent-grouped read must be
 * a compile error, not an `undefined` that becomes the string `"undefined"` in a
 * key.
 */
interface AgencyGroupRawRow {
  agent_user_id?: string;
  campaign_id?: string;
  disposition_code?: string | null;
  day_start?: string;
  day_of_week?: string;
  hour_of_day?: string;
  attempts: string;
  connected: string;
  successes: string;
  talk_seconds: string;
  wrapup_seconds: string;
  total_groups: string;
}

/**
 * How each dimension is read back onto the key, as the inverted `Record` for the
 * third time — and the three objects are separate deliberately.
 *
 * {@link AGENCY_GROUP_DIMENSIONS} guards the 400, {@link GROUP_DIMENSION_SQL}
 * builds the statement, and this reads the answer. They guard three different
 * failures, and a dimension present in one and missing from another is a build
 * error whichever one was forgotten.
 *
 * ⚠️ `disposition` assigns UNCONDITIONALLY, including when the value is `null`.
 * That is the grouped-stats contract's null-key rule expressed in one line: `null` is a real key value
 * — the un-dispositioned group — so the member must be PRESENT and null, never
 * absent. `?? null` also normalises a missing column to `null` rather than letting
 * `undefined` reach a JSON payload, where it would vanish and make the group look
 * un-grouped.
 */
const GROUP_KEY_READERS: Record<
  AgencyGroupDimension,
  (row: AgencyGroupRawRow, key: AgencyGroupKey) => void
> = {
  agent: (row, key) => { key.agent_user_id = row.agent_user_id ?? ''; },
  campaign: (row, key) => { key.campaign_id = row.campaign_id ?? ''; },
  disposition: (row, key) => { key.disposition_code = row.disposition_code ?? null; },
  day: (row, key) => { key.day = row.day_start ?? ''; },
  // `?? '0'`, and NOT a bare `Number(...)`. The contract types both of these
  // `number`, `Number(undefined)` is `NaN`, and `JSON.stringify` turns `NaN` into
  // `null` -- so a missing column would ship a null on a non-nullable field and be
  // invisible on the wire, which is the same failure the readers above spend their
  // `?? ''` on. The fallback is unreachable (the column is selected iff the
  // dimension is grouped, and the three Records above are what keep that true), and
  // that unreachability is what makes 0 an acceptable choice even though 0 is also a
  // REAL value for both -- Sunday, and midnight. A legal in-range value a console
  // can render beats a null the type says cannot happen; if this ever fires, the
  // bug is a missing Record entry, not the payload.
  day_of_week: (row, key) => { key.day_of_week = Number(row.day_of_week ?? '0'); },
  hour_of_day: (row, key) => { key.hour_of_day = Number(row.hour_of_day ?? '0'); },
};

/**
 * One SQL row → one {@link AgencyGroupRow}.
 *
 * A free function rather than an inline `map` body for the same reason
 * `rosterBenchmark` is one: it is pure, it issues no statement, and the rules it
 * carries — which key members exist, and that every rate comes from the shared
 * helper — are the two things a reviewer needs to check without reading SQL.
 *
 * The key is assembled by walking `groupBy` rather than by inspecting which
 * columns the row happens to have, so `AgencyGroupPage.group_by` and the key's
 * members cannot disagree: the echoed list IS the list that built the key.
 *
 * Every rate goes through {@link ratePct} / {@link ratio}. A hand-rolled
 * `n / d * 100` here would answer `NaN` on a zero denominator, `NaN` serialises to
 * `null` in JSON, and the bug would be invisible on the wire until a consumer did
 * arithmetic with it.
 */
function groupRowFromSql(row: AgencyGroupRawRow, groupBy: readonly AgencyGroupDimension[]): AgencyGroupRow {
  const key: AgencyGroupKey = {};
  for (const dimension of groupBy) GROUP_KEY_READERS[dimension](row, key);

  const attempts = Number(row.attempts);
  const connected = Number(row.connected);
  const successes = Number(row.successes);
  const talkSeconds = Number(row.talk_seconds);
  const wrapupSeconds = Number(row.wrapup_seconds);

  return {
    key,
    attempts,
    connected,
    successes,
    talk_seconds: talkSeconds,
    wrapup_seconds: wrapupSeconds,
    // `null`, never `0`, on a zero denominator — the imported rule, unchanged.
    //
    // Note that `attempts` is >= 1 on every row this statement can emit (`COUNT(*)`
    // over an all-INNER `GROUP BY` filtered on `dialed_at IS NOT NULL` cannot
    // produce a group with no rows), so `connect_rate_pct` is never actually null
    // here. It goes through the helper anyway: the rule belongs to one function
    // rather than to a reachability argument that a later `LEFT JOIN` would quietly
    // invalidate.
    connect_rate_pct: ratePct(connected, attempts),
    // The denominator is CONNECTED, not attempts: a call that never bridged had no
    // conversation to convert. This one IS reachably null — a group that connected
    // nobody is an ordinary row.
    success_rate_pct: ratePct(successes, connected),
    aht_seconds: ratio(talkSeconds + wrapupSeconds, connected),
    // The SERVER decides whether these rates may be quoted as numbers, because a
    // consumer recomputing the threshold from the exported constant would disagree
    // with this line the moment the threshold is tuned. Same constant as the roster
    // row, not a second one holding the same value.
    //
    // `attempts` — the row's headline denominator — so one bool covers the one rate
    // built on it, and the reading holds whatever was grouped: enough dials behind
    // this cell to quote a connect rate for it, whether the cell is a person, a
    // campaign, a disposition or one weekday-hour of a heatmap.
    rates_reportable: attempts >= AGENCY_ROSTER_MIN_RATE_DENOMINATOR,
    // The SECOND flag, and it is not a nicety: `attempts >= 20` says nothing about
    // `connected`, so a row of 20 dials with ONE connect and one conversion is
    // `rates_reportable` and carries `success_rate_pct: 100` — which is the exact
    // number, beside a named person on the contribution screen, that the first flag
    // was added to stop a console printing. One threshold on one denominator could
    // not cover two denominators; this is the per-metric floor the house rule asks
    // for, from the same constant and the same predicate the roster's percentile
    // pools use.
    success_rate_reportable: hasRateDenominator({ connected }),
  };
}

/**
 * The agent's own record (`GET /api/v1/agency-agents/:agentUserId/stats`).
 *
 * Its own class for the same reason `AgencyAbandonmentRepository` has one: the
 * question it answers is not a campaign's. Every other read here starts from a
 * campaign id; this one starts from a PERSON, joins to their sessions, and only
 * then reaches attempts and campaigns — so its predicates, its indexes and its
 * grouping have nothing in common with the supervisor dashboard's.
 *
 * ── Two round trips, on purpose ─────────────────────────────────────────────
 *
 * `campaignStats` keeps every scalar aggregate in ONE statement because its
 * numerator and denominator both resolve `now()` and a rate built from two
 * statements can exceed 100% on arithmetic alone. That hazard does not exist
 * here: both reads are bounded by the SAME caller-supplied `[from, to)` window,
 * not by `now()`, so they cannot disagree about which window they measured. The
 * one place `now()` does appear — closing an open final interval — is in the
 * occupancy read alone and has no counterpart in the other.
 *
 * What they do not share is shape: one aggregates ATTEMPTS by (bucket,
 * campaign), the other aggregates INTERVALS by (bucket, state) from a different
 * table with a window function and a lateral series. There is no honest single
 * statement, and they are issued in parallel.
 *
 * ── Every counter in `totals` is the SUM of the buckets, computed here ───────
 *
 * Not read as a second aggregate with the grouping removed. The buckets, the
 * per-campaign rows and the totals are three foldings of one row set, so they
 * cannot disagree — the same reasoning `agents_by_state` uses when it tallies the
 * roster it already fetched rather than issuing its own `GROUP BY`. It also makes
 * the "cross-campaign totals sum exactly" property of the per-campaign-timezone
 * bucketing (see `AgencyAgentStats`) structural rather than a claim.
 */
export class AgencyAgentStatsRepository {
  /**
   * `scope` is the caller's tenant and account, and it is a REQUIRED predicate
   * rather than a filter.
   *
   * There is no campaign in this route's path, so there is nothing to run
   * `requireOwned` against: `agent_user_id` is the app's `users.id`, opaque to
   * the dialer tables, which cannot tell a real one from a guess. Both reads below therefore
   * scope on `agency_agent_sessions` — which carries the tenant and account
   * stamped from the campaign — so an agent id from another tenant resolves to no
   * sessions, no attempts and no events, i.e. an empty record rather than someone
   * else's.
   */
  async stats(
    scope: { tenantId: string; accountId: string; agentUserId: string },
    params: AgentStatsParams,
  ): Promise<AgencyAgentStats> {
    const [attemptRows, occupancyRows] = await Promise.all([
      this.attemptBuckets(scope, params),
      // ── Occupancy degrades ALONE; the rest of the record does not ─────────
      //
      // The two reads answer different questions and only one of them depends on
      // migration 105. An occupancy-specific failure — the events table absent
      // because 105 has not run on this database yet, the same drift the write
      // path already swallows — must not discard attempt totals that were read
      // successfully: the caller asked "what did I do", and answering it with a
      // 500 because a second statement about where their time went could not run
      // is strictly worse than answering it with the occupancy block at zero.
      //
      // This is the read-side counterpart of `recordTransitions`, which is
      // deliberately best-effort for the mirror-image reason (a dropped event
      // costs one occupancy row; a thrown error mid-transition takes an agent off
      // the floor). Both sides of the log are therefore non-fatal, and the warn
      // log is the only symptom either produces.
      //
      // ⚠️ The degraded value is `[]`, which `foldOccupancy` turns into
      // `zeroOccupancy()` — all six states present at zero. That is the only shape
      // available: `AgencyAgentOccupancy` documents `by_state` as "all six states,
      // always present", so there is no way to say "not measured" on this payload
      // and the degraded record is INDISTINGUISHABLE from an agent who has no
      // events at all (a session predating 105). Making the two distinguishable is
      // a contract change, not a catch block; until then the log line below is the
      // only place the difference exists.
      this.occupancyBuckets(scope, params).catch((err: unknown) => {
        log.warn(
          {
            err,
            agentUserId: scope.agentUserId,
            from: params.from.toISOString(),
            to: params.to.toISOString(),
          },
          'Agent occupancy read failed — serving the record with occupancy at zero',
        );
        return [] as { bucket_start: string; state: string; seconds: number }[];
      }),
    ]);
    const agentUserId = scope.agentUserId;

    /** One accumulator per bucket label, built from BOTH reads. */
    interface BucketAcc {
      attempts: number; connected: number; successes: number;
      talk: number; wrapup: number;
      occupancy: { state: string; seconds: number }[];
    }
    const emptyBucket = (): BucketAcc =>
      ({ attempts: 0, connected: 0, successes: 0, talk: 0, wrapup: 0, occupancy: [] });
    const buckets = new Map<string, BucketAcc>();
    const bucketFor = (label: string): BucketAcc => {
      const existing = buckets.get(label);
      if (existing) return existing;
      const fresh = emptyBucket();
      buckets.set(label, fresh);
      return fresh;
    };

    const campaigns = new Map<string, AgencyAgentCampaignRow>();

    for (const row of attemptRows) {
      const bucket = bucketFor(row.bucket_start);
      bucket.attempts += row.attempts;
      bucket.connected += row.connected;
      bucket.successes += row.successes;
      bucket.talk += row.talk_seconds;
      bucket.wrapup += row.wrapup_seconds;

      const campaign = campaigns.get(row.campaign_id) ?? {
        campaign_id: row.campaign_id,
        attempts: 0, connected: 0, successes: 0, talk_seconds: 0, wrapup_seconds: 0,
      };
      campaign.attempts += row.attempts;
      campaign.connected += row.connected;
      campaign.successes += row.successes;
      campaign.talk_seconds += row.talk_seconds;
      campaign.wrapup_seconds += row.wrapup_seconds;
      campaigns.set(row.campaign_id, campaign);
    }

    // A bucket that carries occupancy and no attempts is created here rather than
    // skipped: an agent who was on the floor and never dialled is one of the more
    // useful rows on this payload, and dropping it would make the record look like
    // they were not at work.
    for (const row of occupancyRows) {
      bucketFor(row.bucket_start).occupancy.push({ state: row.state, seconds: row.seconds });
    }

    // Lexicographic on `YYYY-MM-DD` IS chronological, which is half the reason the
    // label is formatted that way (the other half is that node-pg would parse a
    // bare timestamp into a local-time Date — see `bucketStartSql`).
    const labels = [...buckets.keys()].sort();

    const wireBuckets: AgencyAgentStatsBucket[] = labels.map((label) => {
      const acc = buckets.get(label) as BucketAcc;
      return {
        bucket_start: label,
        attempts: acc.attempts,
        connected: acc.connected,
        successes: acc.successes,
        talk_seconds: acc.talk,
        wrapup_seconds: acc.wrapup,
        occupancy: foldOccupancy(acc.occupancy),
      };
    });

    const totals = wireBuckets.reduce(
      (acc, bucket) => {
        acc.attempts += bucket.attempts;
        acc.connected += bucket.connected;
        acc.successes += bucket.successes;
        acc.talk += bucket.talk_seconds;
        acc.wrapup += bucket.wrapup_seconds;
        return acc;
      },
      { attempts: 0, connected: 0, successes: 0, talk: 0, wrapup: 0 },
    );
    // Folded from every occupancy row in one pass rather than by adding the
    // buckets' `shift_seconds` together — same rows, same answer, and it keeps the
    // "unknown state" and "negative interval" guards in exactly one place.
    const occupancy: AgencyAgentOccupancy = foldOccupancy(occupancyRows);

    return {
      agent_user_id: agentUserId,
      bucket: params.bucket,
      from: params.from.toISOString(),
      to: params.to.toISOString(),
      totals: {
        attempts: totals.attempts,
        connected: totals.connected,
        // `null`, never `0`, on a zero denominator — the imported rule. Nothing
        // dialled is not a 0% connect rate.
        connect_rate_pct: ratePct(totals.connected, totals.attempts),
        successes: totals.successes,
        // The denominator is CONNECTED, not attempts: a call that never bridged
        // had no conversation to convert.
        success_rate_pct: ratePct(totals.successes, totals.connected),
        talk_seconds: totals.talk,
        wrapup_seconds: totals.wrapup,
        // Talk PLUS wrap-up over connected calls — deliberately a different
        // definition from `AgencyCampaignStats.aht_seconds` (talk only, voicemail
        // excluded). See the field's doc comment; the denominator is on the
        // payload so the number is always reproducible by the reader.
        aht_seconds: ratio(totals.talk + totals.wrapup, totals.connected),
        campaigns: campaigns.size,
        occupancy,
      },
      buckets: wireBuckets,
      by_campaign: [...campaigns.values()],
    };
  }

  /**
   * Attempts per (bucket, campaign) over `[from, to)` on `dialed_at`.
   *
   * ── The bucket is cut in the CAMPAIGN's timezone, per row ───────────────────
   *
   * `bucketStartSql` interpolates the validated unit and the resolved zone; the
   * product argument for having no `tz` parameter is on `AgencyAgentStats`. The
   * mechanical point here is that `c.default_timezone` comes off the attempt's own
   * campaign, so a cross-campaign query cuts each attempt in its own zone and
   * every attempt still lands in exactly one bucket.
   *
   * ── The zone is RESOLVED, never used raw ───────────────────────────────────
   *
   * `default_timezone` is `VARCHAR(64)` with no constraint and is populated from
   * customer-facing config, so it can hold anything. `some_ts AT TIME ZONE
   * 'Mars/Olympus'` raises `22023 invalid_parameter_value`, which nothing maps to
   * a status — so ONE campaign with a typo would 500 the whole record, including
   * every other campaign's numbers. The LEFT JOIN to `pg_timezone_names` turns
   * that into a fallback: a zone Postgres will not resolve yields NULL and the
   * COALESCE buckets those rows in UTC.
   *
   * That is the same shape as `calling-hours.ts`, which caches a per-zone
   * `Intl.DateTimeFormat` and returns null for one it cannot construct rather than
   * letting a `RangeError` out of the pacing tick — and it is deliberately as
   * strict: `pg_timezone_names` carries zone NAMES, not the abbreviations in
   * `pg_timezone_abbrevs`, so a bare `IST` falls back to UTC exactly as
   * `isUsableTimezone` refuses it. The join is once per statement over a ~1,200
   * row view, not once per attempt.
   *
   * It is also LATERAL and `LIMIT 1`, and that is about CARDINALITY rather than cost
   * — the join sits inside an aggregate's FROM, so two matching zone rows for one
   * campaign would double every counter for that campaign's attempts. See
   * {@link AGENCY_RESOLVED_ZONE_JOIN_SQL}, which is the single spelling all three
   * statements carrying this join interpolate.
   *
   * Bucketed on `dialed_at` and nothing else: `created_at` precedes the dial by a
   * dispatch hop (so it can bucket an attempt into a day nothing was dialled in)
   * and `ended_at` pushes a call straddling midnight into the later day while
   * leaving a live one in no day at all. `hourlyBuckets` states both, and this
   * follows it — including formatting the label in SQL, because node-pg parses a
   * bare `timestamp` into a LOCAL-time `Date` and would put the server's zone back
   * on the way out.
   */
  private async attemptBuckets(
    scope: { tenantId: string; accountId: string; agentUserId: string },
    p: AgentStatsParams,
  ): Promise<{
    bucket_start: string; campaign_id: string;
    attempts: number; connected: number; successes: number;
    talk_seconds: number; wrapup_seconds: number;
  }[]> {
    const zone = AGENCY_RESOLVED_ZONE_SQL;
    const values: unknown[] = [scope.agentUserId, p.from, p.to, scope.tenantId, scope.accountId];
    let campaignFilter = '';
    if (p.campaignId) {
      values.push(p.campaignId);
      campaignFilter = `\n          AND a.campaign_id = $${values.length}::uuid`;
    }

    const { rows } = await getPool().query<{
      bucket_start: string; campaign_id: string;
      attempts: string; connected: string; successes: string;
      talk_seconds: string; wrapup_seconds: string;
    }>(
      `SELECT ${bucketStartSql(p.bucket, 'a.dialed_at', zone)} AS bucket_start,
              a.campaign_id,
              ${AGENCY_ATTEMPT_METRICS_SQL}
         FROM agency_call_attempts a
         JOIN agency_agent_sessions s ON s.id = a.reserved_agent_id
         JOIN agency_campaigns c ON c.id = a.campaign_id
         ${AGENCY_RESOLVED_ZONE_JOIN_SQL}
        WHERE s.agent_user_id = $1
          AND s.tenant_id = $4
          AND s.account_id = $5
          AND a.dialed_at IS NOT NULL
          AND a.dialed_at >= $2
          AND a.dialed_at < $3${campaignFilter}
        GROUP BY 1, a.campaign_id
        ORDER BY 1, a.campaign_id`,
      values,
    );

    return rows.map((r) => ({
      bucket_start: r.bucket_start,
      campaign_id: r.campaign_id,
      attempts: Number(r.attempts),
      connected: Number(r.connected),
      successes: Number(r.successes),
      talk_seconds: Number(r.talk_seconds),
      wrapup_seconds: Number(r.wrapup_seconds),
    }));
  }

  /**
   * Seconds per (bucket, state), from the transition log (migration 105).
   *
   * ── How an interval is built ────────────────────────────────────────────────
   *
   * The log records instants, not durations: an event says "this agent entered
   * `wrapup` at 14:02:11". The duration is therefore the gap to the NEXT event on
   * the same session, which is `lead(at) OVER (PARTITION BY session_id ORDER BY
   * at)`.
   *
   * Three clips make that safe at the edges:
   *
   *  1. **An OPEN final interval** — the newest event of a session, with nothing
   *     after it — is the agent's current state, and it has no end. It runs to
   *     `LEAST(now(), to)`: to the query's own upper bound if the window is
   *     historical, and to `now()` if it reaches into the present. Without this the
   *     current state contributes nothing at all, so the state an agent has been in
   *     all afternoon would be the one the record does not mention.
   *  2. **The event that CARRIES IN.** The state at `from` is set by the last event
   *     BEFORE `from`, which is not in the window. `carried` fetches exactly that
   *     one row per session (`DISTINCT ON … ORDER BY at DESC, id DESC`) and
   *     `GREATEST(at, from)` clips its interval to the window's start. Without it,
   *     an agent who went `available` at 08:55 and made their first call at 09:30
   *     would show 35 minutes of nothing in a window starting at 09:00 — and every
   *     occupancy figure would be low by however long the agent had been in their
   *     state.
   *
   *     **That clip is why `sess` is bounded to sessions overlapping the window,
   *     and the two are one mechanism rather than two.** `carried` fetches one row
   *     per session, so the read is bounded by the window only if the SESSION SET
   *     is — and per-session is per-shift. Left unbounded, every session the agent
   *     has ever closed still has a terminal event before `from`, and each one
   *     therefore carries in an interval with no successor inside the window, i.e.
   *     one that runs the window's full width. Sixty past shifts read as sixty
   *     full-window intervals: `by_state.offline` scaling with tenure rather than
   *     with the window, and `shift_seconds` inflated too for any session abandoned
   *     in a non-`offline` state. The `joined_at`/`left_at` overlap predicate is
   *     what makes “bounded by the window” true of the whole read.
   *  3. **Bucket splitting.** An interval that spans midnight belongs to two
   *     buckets, so it is CROSS JOINed to the buckets it covers and clipped to each
   *     (`LEAST(ended, bucket_end) - GREATEST(started, bucket_start)`). Attributing
   *     the whole interval to the bucket its START falls in would be the easy
   *     version and would put a night shift's whole occupancy on the first day.
   *
   * The bucket series is generated per interval from the same truncation
   * `bucketStartSql` uses, converted back through the campaign's zone so a DST day
   * is measured as the 23 or 25 hours it actually was.
   *
   * ── A session with no events reads as zero, and that is the honest answer ────
   *
   * Sessions that predate migration 105 have no rows here, so they contribute no
   * intervals and every state comes back 0 — see `zeroOccupancy`. The alternative
   * would be reconstructing time-in-state from `agency_agent_sessions.state_since`,
   * which is a snapshot every transition overwrites: it would attribute an agent's
   * ENTIRE history to whichever state they happen to be in now. Occupancy is
   * meaningful from this migration forward and silent before it.
   *
   * `offline` is measured and returned but excluded from `shift_seconds`
   * (`foldOccupancy`), so a session that ended hours ago cannot dilute occupancy
   * merely by having its final `offline` interval run to the end of the window.
   */
  private async occupancyBuckets(
    scope: { tenantId: string; accountId: string; agentUserId: string },
    p: AgentStatsParams,
  ): Promise<{
    bucket_start: string; state: string; seconds: number;
  }[]> {
    const values: unknown[] = [scope.agentUserId, p.from, p.to, scope.tenantId, scope.accountId];
    let campaignFilter = '';
    if (p.campaignId) {
      values.push(p.campaignId);
      campaignFilter = `\n            AND s.campaign_id = $${values.length}::uuid`;
    }
    // The clipped overlap of one interval with one bucket. Named because it is
    // needed twice — in the SUM and in the HAVING that drops a zero-width bucket
    // (the series is inclusive of the bucket containing `ended`, so an interval
    // ending exactly on a boundary generates one bucket it does not occupy).
    const overlap =
      'EXTRACT(EPOCH FROM (LEAST(i.ended, b.bucket_end) - GREATEST(i.started, b.bucket_start)))';
    const zone = AGENCY_RESOLVED_ZONE_SQL;

    const { rows } = await getPool().query<{
      bucket_start: string; state: string; seconds: string;
    }>(
      `WITH sess AS (
         -- The agent's sessions that OVERLAP the window, never all of them. A
         -- session's life is [joined_at, left_at), the window is [$2, $3), and two
         -- half-open intervals overlap iff each starts before the other ends.
         --
         -- Unbounded, this CTE is what makes the whole read scale with the agent's
         -- TENURE rather than with the window: every closed session the agent has
         -- ever had still has a terminal event before $2, so carried hands each one
         -- a carried-in interval that, having no successor inside the window, runs
         -- the full width of it. Sixty past shifts become sixty full-window offline
         -- intervals -- about 42 days of "offline" inside a 24-hour bucket -- and a
         -- session abandoned in a non-offline state inflates shift_seconds by the
         -- same construction.
         SELECT s.id, s.left_at, ${zone} AS zone
           FROM agency_agent_sessions s
           JOIN agency_campaigns c ON c.id = s.campaign_id
           ${AGENCY_RESOLVED_ZONE_JOIN_SQL}
          WHERE s.agent_user_id = $1
            AND s.tenant_id = $4
            AND s.account_id = $5
            AND s.joined_at < $3
            AND (s.left_at IS NULL OR s.left_at > $2)${campaignFilter}
       ), in_window AS (
         -- e.agent_user_id = $1 is the denormalised copy migration 105 exists to
         -- carry, and it is what makes idx_agency_session_events_agent
         -- (agent_user_id, at) usable: without it the planner has no predicate on
         -- the index's leading column, so the range on at cannot be driven from it.
         -- The join to sess stays -- it is what carries the campaign's zone and
         -- applies the tenant/account scope.
         -- e.id rides along for the lead() tiebreak in intervals, for the same
         -- reason carried's ORDER BY carries it: at alone is not unique.
         SELECT e.session_id, e.to_state, e.at, e.id
           FROM agency_agent_session_events e
           JOIN sess ON sess.id = e.session_id
          WHERE e.agent_user_id = $1
            AND e.at >= $2 AND e.at < $3
       ), carried AS (
         -- e.id DESC breaks a tie on at. DISTINCT ON returns whichever row the
         -- executor reached first among rows equal on the ORDER BY, so two events
         -- on one session sharing a timestamp make the state carried into the
         -- window non-reproducible between two runs of the same query -- one run
         -- reports the agent went on break at 08:55, the next reports available.
         -- Ties are real in rows already in the table: before at was carried from
         -- the mutation, the batch INSERT took migration 105's DEFAULT now(), which
         -- is the transaction timestamp and therefore identical for every row of a
         -- markAllOffline sweep of the whole floor.
         SELECT DISTINCT ON (e.session_id) e.session_id, e.to_state, e.at, e.id
           FROM agency_agent_session_events e
           JOIN sess ON sess.id = e.session_id
          WHERE e.agent_user_id = $1
            AND e.at < $2
          ORDER BY e.session_id, e.at DESC, e.id DESC
       ), events AS (
         SELECT * FROM in_window
         UNION ALL
         SELECT * FROM carried
       ), intervals AS (
         -- Three clips on the close, and the third is not decoration.
         --
         -- lead() gives the next event on the same SESSION; its absence means the
         -- newest event, i.e. the state the agent is in now, which has no end.
         -- now() closes that, $3 closes it again for a historical window -- and
         -- sess.left_at closes it for a session that ENDED. leave() sets left_at
         -- and writes the closing offline event in the same call, but that write is
         -- the best-effort one recordTransitions swallows with a warn: drop it and
         -- a session closed at 11:30 in state available credits every remaining
         -- second of the window to available, inflating shift_seconds and
         -- deflating the occupancy read that divides by it. left_at is the one
         -- clip whose source is the sessions table rather than the log, so it
         -- survives exactly the failure the other two cannot see.
         --
         -- LEAST already ignores NULLs, so the COALESCE is for the reader: a live
         -- session has no left_at and must not be clipped at all, and 'infinity'
         -- says that rather than leaving it to a function's null semantics.
         --
         -- ev.id breaks a tie on ev.at, the same tie carried breaks above and for
         -- the same reason -- markAllOffline's batch INSERT shares one transaction
         -- timestamp across the whole floor. Where two tied events are followed by
         -- a third, lead() without the tiebreak leaves it undefined WHICH of the
         -- tied states keeps the surviving interval, so two reads of one window can
         -- attribute the same seconds to different states. id is a random uuid, so
         -- the order it imposes on a tie is arbitrary -- but it is TOTAL and it is
         -- STABLE, which is the whole ask: tied events have no chronology to
         -- recover, and the failure being fixed is a number that moves between
         -- reads, not a number that is wrong.
         SELECT ev.to_state AS state,
                sess.zone,
                GREATEST(ev.at, $2::timestamptz) AS started,
                LEAST(
                  COALESCE(lead(ev.at) OVER (PARTITION BY ev.session_id ORDER BY ev.at, ev.id), now()),
                  $3::timestamptz,
                  -- The left_at clip applies to every state EXCEPT offline, and
                  -- that exception is the point of the clip rather than a
                  -- softening of it.
                  --
                  -- What the clip defends is shift_seconds, which foldOccupancy
                  -- sums over the NON-offline states only. A session closed in
                  -- 'available' -- because leave()'s closing write is the
                  -- best-effort one recordTransitions swallows with a warn --
                  -- would credit every remaining second of the window to
                  -- 'available' and inflate the shift. That failure is a failure
                  -- of a SHIFT state, by construction.
                  --
                  -- offline cannot commit it. It is excluded from the shift, so
                  -- extending it past left_at adds nothing to the denominator
                  -- occupancy divides by. And extending it is the DOCUMENTED
                  -- contract on this method: "a session that ended hours ago
                  -- cannot dilute occupancy merely by having its final offline
                  -- interval run to the end of the window" -- a sentence that is
                  -- only true of a read where that interval DOES run to the
                  -- window's end.
                  --
                  -- Clipping offline too made by_state.offline 0 for every
                  -- properly closed session, because leave() writes the offline
                  -- event AT left_at: the interval then starts and ends on one
                  -- instant. agent-occupancy-window.test.ts pins the 12:00 to
                  -- 24:00 tail and is what caught it. A unit test over a mocked
                  -- pool never could -- the bug was in what the SQL MEANS, not in
                  -- what it says.
                  CASE
                    WHEN ev.to_state = 'offline' THEN 'infinity'::timestamptz
                    ELSE COALESCE(sess.left_at, 'infinity'::timestamptz)
                  END
                ) AS ended
           FROM events ev
           JOIN sess ON sess.id = ev.session_id
       )
       SELECT ${bucketStartSql(p.bucket, 'b.bucket_start', 'i.zone')} AS bucket_start,
              i.state,
              SUM(${overlap})::text AS seconds
         FROM intervals i
         CROSS JOIN LATERAL (
           SELECT (gs AT TIME ZONE i.zone) AS bucket_start,
                  ((gs + interval '1 ${p.bucket}') AT TIME ZONE i.zone) AS bucket_end
             FROM generate_series(
                    ${bucketTruncSql(p.bucket, 'i.started', 'i.zone')},
                    ${bucketTruncSql(p.bucket, 'i.ended', 'i.zone')},
                    interval '1 ${p.bucket}') gs
         ) b
        WHERE i.ended > i.started
        GROUP BY 1, i.state
       HAVING SUM(${overlap}) > 0
        ORDER BY 1, i.state`,
      values,
    );

    return rows.map((r) => ({
      bucket_start: r.bucket_start,
      state: r.state,
      seconds: Number(r.seconds),
    }));
  }

  /**
   * ── THE ROSTER: every agent's performance in ONE read ─────────────────────
   *
   * `GET /api/v1/agency-agents/stats`. This is {@link stats} grouped one level
   * UP — per agent instead of per bucket — over the same half-open window, the
   * same two-hop join and the same scope predicate. There is no bucket on this
   * route, so there is no `date_trunc`, no `generate_series`, and **no campaign
   * timezone to resolve**: the `pg_timezone_names` LEFT JOIN both statements above
   * carry exists only to keep an unresolvable zone from raising `22023` inside a
   * bucket expression, and with no bucket expression there is nothing to protect.
   *
   * ── Scope, again, and for the same reason ─────────────────────────────────
   *
   * `tenant_id` AND `account_id` on `agency_agent_sessions` in EVERY statement.
   * There is no path parameter here at all, so there is even less to run an
   * ownership check against than on the per-agent record — the only thing
   * separating one account's floor from another's is the pair of predicates below.
   * A tenant-wide roster is a separate future mode; it must not be reachable by
   * omitting a parameter, which is why `accountId` is a required field of `scope`
   * rather than an optional filter on `params`.
   *
   * ── TWO READS, SEQUENTIAL — the one place this diverges from `stats()` ────
   *
   * `stats()` issues its two statements in parallel because both are bounded by
   * one agent id it already holds. This one cannot, and the reason is an index:
   * `idx_agency_session_events_agent` is `(agent_user_id, at)`, and migration
   * 105's own header states that **the index is only reachable because the reader
   * predicates on `agent_user_id`** — `session_id` is deliberately not indexed at
   * all. A roster-shaped occupancy read has no single agent, so issued in parallel
   * it would range on `e.at` with nothing on the index's leading column and drive
   * the join from an unindexed `session_id`: a sequential scan of the table
   * written on every state transition.
   *
   * So the attempts aggregate runs FIRST and its agent ids are bound into the
   * occupancy read as an array. That restores the exact predicate the index needs,
   * costs one round trip in series instead of two in parallel, and needs no new
   * index on a hot table. It also stops the occupancy read fetching agents the
   * roster is about to discard — see the row-set note below — and it lets the
   * second statement be skipped outright when nobody dialled.
   *
   * ── OCCUPANCY DEGRADES ALONE ─────────────────────────────────────────────
   *
   * Identical precedent to `stats()`, and the sequential order does not weaken it:
   * an occupancy-read failure is caught, warned, and serves the roster with every
   * agent's `shift_seconds`/`break_seconds` at 0 and `occupancy_pct` at `null`.
   * The supervisor asked who dialled what; answering with a 500 because a second
   * statement about where the floor's time went could not run discards numbers
   * that were already in hand. The mirror case is deliberately NOT caught: if the
   * attempts read fails there is no roster to serve.
   *
   * ── The row set is ATTEMPTS-driven, which is a correctness property ────────
   *
   * One row per agent who DIALLED in the window — the cohort
   * `AgencyRosterBenchmark` defines. An agent with occupancy and no dials gets no
   * line, unlike the per-agent record which deliberately emits their empty bucket.
   * Beyond matching the frozen cohort definition, this is what makes the degrade
   * above safe: if occupancy could ADD rows, a failed events-table read would
   * silently DELETE agents from the page, which is far worse than serving their
   * occupancy as zero. The row set must not change shape when a subsidiary read
   * fails.
   *
   * ── Why the ranking and the percentiles are NOT in SQL ────────────────────
   *
   * This is the design decision most likely to be read as laziness, so it is
   * derived rather than asserted. It is forced, in two steps:
   *
   *  1. `benchmark.occupancy_pct`'s percentiles are quantiles of
   *     `(talk + wrapup) / shift_seconds` **over the whole cohort**. `talk` and
   *     `wrapup` come from the attempts statement and `shift_seconds` from the
   *     occupancy statement, so that metric exists in neither one alone. Any
   *     `LIMIT` applied inside the attempts statement therefore destroys an input
   *     the benchmark needs — the limited page carries talk/wrapup for its own
   *     rows only.
   *  2. So the attempts statement must return the whole post-scope, pre-`limit`
   *     cohort, and `limit` can only be applied after the merge. Once the slice is
   *     out of SQL, so is the `ORDER BY` it slices: sorting in SQL and slicing in
   *     TypeScript would be two spellings of one comparator that must agree
   *     exactly on nulls and on the tiebreaker, and one of them would eventually
   *     be edited alone.
   *
   * The cohort is bounded by an account's HEADCOUNT (one row per agent, and
   * `limit`'s ceiling is 200), not by call volume, so the rows the aggregate
   * returns are cheap to carry. The upside is that `sort` and `order` never reach
   * a query at all: {@link sortRosterRows} is the single comparator, and the
   * injection surface for the two params that arrive as free text is zero rather
   * than merely well-guarded.
   *
   * `total_agents` is that same pre-`limit`, post-scope count, so the console can
   * say "showing 100 of 137" rather than implying the floor is the page.
   */
  async roster(
    scope: { tenantId: string; accountId: string },
    params: AgentRosterParams,
  ): Promise<AgencyRosterPage> {
    const attemptRows = await this.rosterAttemptTotals(scope, params);
    const agentIds = attemptRows.map((row) => row.agent_user_id);

    // Skipped rather than issued with an empty array: nobody dialled, so there is
    // no row for an occupancy figure to attach to, and `= ANY('{}')` is a
    // statement whose answer is known.
    const occupancyRows = agentIds.length === 0
      ? []
      : await this.rosterOccupancyTotals(scope, params, agentIds).catch((err: unknown) => {
        // Same catch, same warning, same reasoning as `stats()`: the realistic
        // failure is migration 105 not having run on this database yet, which is
        // the drift the WRITE path already swallows in `recordTransitions`. Both
        // sides of the transition log are non-fatal and the warn line is the only
        // symptom either produces.
        log.warn(
          {
            err,
            tenantId: scope.tenantId,
            accountId: scope.accountId,
            agents: agentIds.length,
            from: params.from.toISOString(),
            to: params.to.toISOString(),
          },
          'Agent roster occupancy read failed — serving the roster with occupancy at zero',
        );
        return [] as { agent_user_id: string; state: string; seconds: number }[];
      });

    // Folded through `foldOccupancy` per agent rather than summed here, so the
    // unknown-state drop, the negative-interval clamp and the "shift excludes
    // offline" rule keep exactly one definition across both read surfaces.
    const byAgent = new Map<string, { state: string; seconds: number }[]>();
    for (const row of occupancyRows) {
      const existing = byAgent.get(row.agent_user_id);
      if (existing) existing.push(row);
      else byAgent.set(row.agent_user_id, [row]);
    }

    const rows: AgencyRosterAgentRow[] = attemptRows.map((row) => {
      const occupancy = byAgent.has(row.agent_user_id)
        ? foldOccupancy(byAgent.get(row.agent_user_id) as { state: string; seconds: number }[])
        : zeroOccupancy();
      const handled = row.talk_seconds + row.wrapup_seconds;
      return {
        agent_user_id: row.agent_user_id,
        attempts: row.attempts,
        connected: row.connected,
        successes: row.successes,
        talk_seconds: row.talk_seconds,
        wrapup_seconds: row.wrapup_seconds,
        // `null`, never `0`, on a zero denominator — the imported rule, and the
        // same helper every other rate on this surface uses. Nothing dialled is
        // not a 0% connect rate.
        connect_rate_pct: ratePct(row.connected, row.attempts),
        // The denominator is CONNECTED, not attempts: a call that never bridged
        // had no conversation to convert, so charging it here would make an
        // agent's conversion a function of the list's answer rate.
        success_rate_pct: ratePct(row.successes, row.connected),
        aht_seconds: ratio(handled, row.connected),
        campaigns: row.campaigns,
        shift_seconds: occupancy.shift_seconds,
        break_seconds: occupancy.by_state.break,
        // This route PICKS a denominator where `AgencyAgentOccupancy` deliberately
        // does not, because a roster column has to be one number. Break time is
        // INCLUDED; `shift_seconds - break_seconds` is the other reading and both
        // parts are on the row, so nothing is lost. `null` — never 0 — on a zero
        // shift, which is also what a degraded occupancy read produces.
        //
        // ── And `null` when the numerator EXCEEDS the denominator ───────────
        //
        // Nothing constrains this ratio to <= 1, because its two halves are
        // measured on two INDEPENDENT tables: the numerator (talk + wrapup) on
        // `agency_call_attempts`, which every settled attempt writes
        // transactionally, and the denominator on `agency_agent_session_events`,
        // whose writes are BEST-EFFORT — `recordTransitions` swallows a failed
        // INSERT with a warn and no rethrow. A dropped transition shortens the
        // shift while the calls it contained stay counted, so the ratio can pass
        // 100% by an arbitrary factor; 716% has been observed on a real read.
        //
        // NOT clamped to 100. A clamp hands the reader a plausible number computed
        // from an inconsistency, and "fully occupied" is a claim this data cannot
        // support. `null` is the value this column already documents for
        // "unmeasured", and reusing it drops the row from the percentile pools for
        // free — they filter nulls — which is the half that actually matters: an
        // impossible value left in the pool drags `occupancy_pct.p75` upward and
        // every other agent is then flagged against a cohort containing it, and
        // the same row ranks #1 under `?sort=occupancy_pct&order=desc`.
        //
        // `>=` rather than `>` so the equal case — including 0/0 — still goes
        // through `ratePct`, which is what keeps the zero-shift null a property of
        // one helper rather than of two branches.
        occupancy_pct: occupancy.shift_seconds >= handled
          ? ratePct(handled, occupancy.shift_seconds)
          : null,
        last_dialed_at: row.last_dialed_at,
        // The row's HEADLINE denominator. A row that fails this contributes to no
        // percentile pool, which is what makes the flag usable as the single gate
        // its contract doc promises. The rates are still served either way.
        rates_reportable: row.attempts >= AGENCY_ROSTER_MIN_RATE_DENOMINATOR,
        // The CONNECTED floor, from the same predicate the `success_rate` and `aht`
        // pools are admitted by — so a console gating on this flag withholds
        // exactly the rows the benchmark refused to rank, rather than a set that
        // agrees with it by coincidence.
        success_rate_reportable: hasRateDenominator(row),
      };
    });

    return {
      from: params.from.toISOString(),
      to: params.to.toISOString(),
      campaign_id: params.campaignId ?? null,
      sort: params.sort,
      order: params.order,
      limit: params.limit,
      // PRE-`limit`, post-scope. Taken from `rows` rather than from a third
      // `COUNT(*)` statement, which is what makes it structurally equal to
      // `benchmark.agents` instead of a number two reads have to keep agreeing on.
      total_agents: rows.length,
      rows: sortRosterRows(rows, params.sort, params.order).slice(0, params.limit),
      // Computed over EVERY row, before the slice. A benchmark drawn from the page
      // would move when the caller changed `limit` — a different number under the
      // same name, which is the failure its own doc comment names about
      // `include_inactive`.
      benchmark: rosterBenchmark(rows),
    };
  }

  /**
   * One row per agent who dialled, over `[from, to)` on `dialed_at`.
   *
   * `stats()`'s `attemptBuckets` with the bucket removed and the agent id moved
   * from a predicate into the `GROUP BY`. Every column definition is the same,
   * character for character, and for the reasons stated there — the AGENT's leg for talk time
   * rather than the persisted column, orphans excluded because the reaper stamps
   * `ended_at` at sweep time, MEASURED wrap-up rather than the campaign's
   * allotment — because the roster and the per-agent record are read side by side
   * and a supervisor will subtract one from the other.
   *
   * ── The index this drives, and why it is the BILLING one ──────────────────
   *
   * Not `idx_agency_attempts_agent_dialed` (migration 104). That index is
   * `(reserved_agent_id, dialed_at DESC) WHERE dialed_at IS NOT NULL` and its
   * leading column is a session id this statement has no predicate on — the whole
   * point of a roster is that it does not name an agent. What fits exactly is
   * `idx_agency_attempts_billing` (migration 081):
   * `(dialed_at, campaign_id) WHERE dialed_at IS NOT NULL`, whose own comment says
   * `dialed_at` MUST lead because the billing sweep "is a time range across all
   * campaigns and has no campaign_id to filter on". That is this statement's shape
   * too, and `?campaign_id=` narrows on the index's second column when supplied.
   * The sessions and campaigns then join by primary key.
   *
   * So the roster's attempt aggregate needs no new index, and 104 stays what its
   * header says it is: the single-agent read's index, not this one's.
   */
  private async rosterAttemptTotals(
    scope: { tenantId: string; accountId: string },
    p: AgentRosterParams,
  ): Promise<{
    agent_user_id: string;
    attempts: number; connected: number; successes: number;
    talk_seconds: number; wrapup_seconds: number;
    campaigns: number; last_dialed_at: string | null;
  }[]> {
    const values: unknown[] = [p.from, p.to, scope.tenantId, scope.accountId];
    let campaignFilter = '';
    if (p.campaignId) {
      values.push(p.campaignId);
      campaignFilter = `\n          AND a.campaign_id = $${values.length}::uuid`;
    }

    const { rows } = await getPool().query<{
      agent_user_id: string;
      attempts: string; connected: string; successes: string;
      talk_seconds: string; wrapup_seconds: string;
      campaigns: string; last_dialed_at: string | null;
    }>(
      `SELECT s.agent_user_id,
              ${AGENCY_ATTEMPT_METRICS_SQL},
              -- Distinct CAMPAIGNS dialled, not sessions joined: a session is per
              -- shift, so an agent who worked one campaign across three days would
              -- otherwise read as three campaigns.
              COUNT(DISTINCT a.campaign_id)::text AS campaigns,
              -- Formatted in SQL for the same reason every other instant on this
              -- surface is: node-pg's parsing of a bare timestamp reintroduces the
              -- server's zone. Never NULL in practice -- the WHERE clause requires
              -- dialed_at -- but typed nullable rather than asserted.
              to_char(MAX(a.dialed_at) AT TIME ZONE 'UTC',
                      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS last_dialed_at
         FROM agency_call_attempts a
         JOIN agency_agent_sessions s ON s.id = a.reserved_agent_id
         JOIN agency_campaigns c ON c.id = a.campaign_id
        WHERE s.tenant_id = $3
          AND s.account_id = $4
          AND a.dialed_at IS NOT NULL
          AND a.dialed_at >= $1
          AND a.dialed_at < $2${campaignFilter}
        GROUP BY s.agent_user_id
        ORDER BY s.agent_user_id`,
      values,
    );

    return rows.map((r) => ({
      agent_user_id: r.agent_user_id,
      attempts: Number(r.attempts),
      connected: Number(r.connected),
      successes: Number(r.successes),
      talk_seconds: Number(r.talk_seconds),
      wrapup_seconds: Number(r.wrapup_seconds),
      campaigns: Number(r.campaigns),
      last_dialed_at: r.last_dialed_at,
    }));
  }

  /**
   * ── GET /api/v1/agency-agents/grouped-stats — ONE GENERAL GROUPED AGGREGATE ─
   *
   * `rosterAttemptTotals`' row set, regrouped by one or two CALLER-CHOSEN
   * dimensions instead of by agent. The five metric expressions are the shared
   * {@link AGENCY_ATTEMPT_METRICS_SQL} — the same string this file's two other
   * attempts aggregates interpolate — which is what makes a grouped cell, a roster
   * line and an agent's own scorecard agree on the same attempts.
   *
   * Precisely: that row set TIMES its matching `pg_timezone_names` rows, because
   * this statement carries a join `rosterAttemptTotals` does not
   * ({@link AGENCY_RESOLVED_ZONE_JOIN_SQL}). The two are the same row set only
   * because that join is LATERAL and `LIMIT 1`, so the multiplier is exactly one for
   * every campaign — matched or not. That is the whole reason it is written as a
   * lateral: without it, "regrouped" would be a claim about tzdata's contents rather
   * than about this statement.
   *
   * ⚠️ And "that row set" holds EXACTLY when `agent` is grouped. Where it is not,
   * this read is deliberately WIDER than the roster's: the session join goes LEFT,
   * so attempts that never reached an agent are counted too. That is stated here as
   * well as at the join because a reader arriving from `rosterAttemptTotals` will
   * otherwise subtract one from the other and expect zero. See the join for why the
   * two questions differ.
   *
   * ── ONE aggregate statement, and `limit` is pushed DOWN into it ────────────
   *
   * The opposite of `roster()`, and the difference is worth stating because the
   * two reads sit next to each other. The roster CANNOT carry a `LIMIT`: its
   * benchmark's occupancy percentiles need per-agent talk+wrapup from one statement
   * and shift_seconds from another, for the WHOLE cohort, so a limit inside either
   * destroys an input the payload needs — and a test pins the absence. This read
   * has no benchmark and no aggregate over the rows the page omits, so nothing
   * outside the page depends on them, and the limit belongs where the rows are:
   * in SQL, so a 400-group matrix costs 200 rows over the wire instead of 400.
   *
   * `total_groups` is the one thing that DOES need the pre-limit count, and it
   * comes from `COUNT(*) OVER ()` in the outer select rather than from a second
   * `COUNT(*)` statement. Window functions are evaluated before `LIMIT`, so the
   * number is the pre-limit group count by construction — where two statements
   * would be two scans that could disagree if a write landed between them.
   *
   * ⚠️ And that window has a COST worth naming, because it partly offsets the
   * paragraph above. An EMPTY partition (`OVER ()`) cannot emit its first row until
   * it has seen the last one, so the plan MATERIALISES all `total_groups` rows —
   * spilling to disk past `work_mem` — even when `limit` is 1. Two dimensions over
   * a 92-day window can be tens of thousands of groups, and the server sets no
   * `statement_timeout` anywhere, so nothing cuts that short. Pushing the slice down
   * still wins on what crosses the WIRE, which is what it was for; it does not make
   * the read cheap, and the window cap is the only thing bounding it.
   *
   * ── The ORDER BY is TOTAL, which is what makes `limit` reproducible ────────
   *
   * Every ORDER BY here ends with the full grouped key ascending. The key is unique
   * per row by definition of `GROUP BY`, so the ordering has no ties at all — and
   * with the slice now in SQL, a partial order would mean two identical requests
   * returning DIFFERENT rows rather than merely the same rows in a different order.
   * `NULLS LAST` is spelled explicitly in both directions (Postgres defaults it
   * last only under `ASC`), so an unranked row is never on the first page of a
   * ranked question — the same rule, and the same words, as {@link sortRosterRows}.
   *
   * ── `sort` / `order` / `group_by` / `limit` still interpolate NOTHING ──────
   *
   * Unlike the roster, this read's ordering and slicing DO happen in SQL — so the
   * injection answer cannot be "they never reach a statement". It is instead that
   * every one of them resolves through a TypeScript `Record` lookup keyed on a
   * validated union member to a static fragment written in this file:
   * {@link GROUP_DIMENSION_SQL}, {@link GROUP_SORT_ORDER_SQL}. No caller-supplied
   * character reaches the statement; `limit` is a bound parameter like every value.
   *
   * ── The zone apparatus is reused unchanged, and joined UNCONDITIONALLY ─────
   *
   * {@link AGENCY_RESOLVED_ZONE_JOIN_SQL} with {@link AGENCY_RESOLVED_ZONE_SQL},
   * exactly as `attemptBuckets` has it and for exactly the reason stated there:
   * `default_timezone` is `VARCHAR(64)` with no constraint, `ts AT TIME ZONE
   * 'Mars/Olympus'` raises `22023 invalid_parameter_value`, and nothing maps that to
   * a status — so ONE campaign with a typo would take out every other campaign's
   * numbers in the same statement. The LEFT JOIN turns that into a per-row fallback
   * to UTC, and the LATERAL `LIMIT 1` is what keeps it from being able to FAN OUT —
   * read that constant, because the cardinality is what this statement's numbers
   * rest on, not merely its cost.
   *
   * Joined even when no time dimension is grouped, for two reasons and only the
   * second is about cost. The FIRST: making the FROM clause depend on `group_by`
   * means a future dimension whose expression reads `z.name` with no `z` in scope —
   * a runtime `42P01` on a statement that type-checks, discovered by whoever asked
   * the new question first. The SECOND: one join against a ~1,200-row view, once per
   * statement, which is cheap enough that the first reason wins uncontested.
   *
   * Whether a time dimension may be grouped AT ALL is decided in
   * {@link parseGroupedStatsQuery}: across campaigns in different
   * zones "the 18:00 row" is not one thing, so it is refused rather than answered
   * in UTC. That refusal is a product rule and lives with the other parsing rules;
   * by the time this method runs, the zone is already unambiguous.
   *
   * ── No new index ──────────────────────────────────────────────────────────
   *
   * The driving predicate is the half-open window on `dialed_at` plus an optional
   * `campaign_id`, with the sessions and campaigns joined by primary key — which is
   * `idx_agency_attempts_billing` (migration 081), `(dialed_at, campaign_id) WHERE
   * dialed_at IS NOT NULL`, leading on exactly the column this scan is driven from.
   * Same argument as `rosterAttemptTotals`, and the same conclusion: nothing here
   * wants an index that does not exist. Grouping columns do not want indexes anyway
   * — the aggregate has to visit every qualifying row whatever it groups by.
   */
  async groupedStats(
    scope: { tenantId: string; accountId: string },
    p: AgentGroupedParams,
  ): Promise<AgencyGroupPage> {
    // Bound in the SAME ORDER as `rosterAttemptTotals`: from, to, tenant, account,
    // then the optional campaign. That statement and this one share their whole
    // FROM clause and their whole WHERE clause, so a future editor will diff or
    // copy between them — and a swapped from/to survives review, because an
    // inverted window is an empty result rather than an error. `limit` goes last
    // because it is the only parameter that belongs to the page rather than to the
    // rows.
    const values: unknown[] = [p.from, p.to, scope.tenantId, scope.accountId];
    let campaignFilter = '';
    if (p.campaignId) {
      values.push(p.campaignId);
      campaignFilter = `\n          AND a.campaign_id = $${values.length}::uuid`;
    }

    // Every fragment below comes from a `Record` keyed on a validated union member.
    // `p.groupBy` is already canonical and deduplicated (`parseGroupedStatsQuery`),
    // so the ordinals, the select list and the key mapper walk the same list in the
    // same order — which is what makes the echoed `group_by` describe the row shape.
    const dimensions = p.groupBy.map((dimension) => GROUP_DIMENSION_SQL[dimension]);
    const innerSelect = dimensions
      .map((dimension) => `${dimension.select} AS ${dimension.alias}`)
      .join(',\n              ');
    // Ordinals rather than repeating the expressions: `date_trunc(...)` in a GROUP
    // BY has to be spelled identically to the select-list copy or Postgres treats
    // them as different expressions, and one spelling cannot drift from itself.
    const groupOrdinals = dimensions.map((_dimension, index) => index + 1).join(', ');
    // `project`, not `g.<alias>`: a numeric dimension is cast to text HERE and not
    // in the CTE, so the ORDER BY below still reads an integer column. See
    // GROUP_DIMENSION_SQL — a text-typed hour sorts '10' before '9'.
    const outerSelect = dimensions.map((dimension) => dimension.project).join(', ');

    const direction = p.order === 'asc' ? 'ASC' : 'DESC';
    // The key, ascending, terminates EVERY ordering — see the header. Under
    // `sort=key` it IS the ordering and takes the caller's direction; under a metric
    // sort it is the tiebreak and stays ascending, so flipping an unrelated column's
    // direction cannot reshuffle a stable page.
    const keyOrder = (keyDirection: string): string => dimensions
      .map((dimension) => `g.${dimension.alias} ${keyDirection} NULLS LAST`)
      .join(', ');
    const orderBy = p.sort === 'key'
      ? keyOrder(direction)
      : `${GROUP_SORT_ORDER_SQL[p.sort]} ${direction} NULLS LAST, ${keyOrder('ASC')}`;

    values.push(p.limit);
    const limitPlaceholder = `$${values.length}`;

    // ── The SECOND statement, and why there is one at all ────────────────────
    //
    // `resolved_timezone` is the zone this page's buckets were ACTUALLY cut in, and
    // it exists only when there IS one zone: a zoned dimension grouped AND the read
    // filtered to one campaign (`groupedPageHasSingleZone`, which carries the
    // derivation). A `campaign,hour_of_day` read with no filter spans every
    // campaign in the account, each row cut in its own zone, and reports `null`.
    //
    // It is read from `agency_campaigns` rather than off the CTE's rows, and that
    // is the whole reason it cannot ride the statement above: a zoned read whose
    // window holds NO attempts returns zero rows, so a zone taken off the rows
    // would be `null` on precisely the page that most needs its axis labelled — an
    // empty heatmap is still a heatmap, and an unlabelled hour axis re-introduces
    // "the 18:00 column is not a fact until a zone is named" at the presentation
    // layer.
    //
    // ⚠️ A deliberate, narrow exception to this read's one-statement rule, and
    // it is not in tension with the reason this read refuses occupancy: occupancy
    // scans `agency_agent_session_events`, whose `session_id` is indexed
    // by nothing, against a row count that is a PRODUCT of cardinalities. This is a
    // primary-key lookup of one campaign row plus a lateral against a ~1,200-row
    // view, at most once per request, and only on the single-campaign zoned read —
    // the reads that refusal protects do not issue it at all.
    const zoneCampaignId = groupedPageHasSingleZone(p) ? p.campaignId : undefined;

    // ── The session join is LEFT unless `agent` is what is being ATTRIBUTED ────
    //
    // `agency_call_attempts.reserved_agent_id` is NULLABLE (migration 075) and it is
    // NULL on every attempt that failed before an agent was ever on it. An INNER
    // join therefore DROPS those attempts, and on a campaign-shaped read
    // (`hour_of_day`, `campaign`, `disposition`, `day`, with no `agent`) dropping
    // them is wrong three ways: it understates the very hour a supervisor is about
    // to move staffing to, it disagrees with the billing sweep (which selects on
    // `dialed_at IS NOT NULL` and joins no session at all), and it disagrees with
    // the campaign attempt spine, which LEFT joins the session ON PURPOSE and says
    // so. "When do dials connect" includes a dial that never reached an agent: that
    // dial is a real attempt, with a real outcome, in a real hour.
    //
    // When `agent` IS grouped the join stays INNER, and that is not an
    // inconsistency. There the join IS the attribution mechanism —
    // `s.agent_user_id` is the KEY — and an attempt with no session belongs to no
    // agent and therefore to no group. A LEFT join there would emit a `null`-keyed
    // row: a person-shaped group that is not a person, on a payload whose key is
    // documented as an agent id.
    //
    // ⚠️ So the two readings deliberately do NOT reconcile: an hour-grouped total
    // can exceed the sum of the agent-grouped rows over the same window, and the
    // difference is exactly the unreserved attempts. That is the same asymmetry
    // `inactive_omitted` documents in `agency-agent-identity.ts`, one layer down, and it is a
    // property of the QUESTION rather than a defect of the statement.
    //
    // ── Which is why the scope predicate now sits on the ATTEMPT ───────────────
    //
    // It read `s.tenant_id = $3 AND s.account_id = $4`, which cannot survive a LEFT
    // join: the NULL side fails it, so every unreserved attempt would be dropped by
    // the WHERE clause instead of by the join, and the fix above would be silently
    // undone. The scope is therefore a predicate on `a` — which is where it belongs
    // anyway. The attempt is the row being counted, `a.tenant_id`/`a.account_id` are
    // `NOT NULL` (migration 075), and that is the column pair the billing sweep
    // scopes on. The session's own scope is not lost: it moves into the JOIN
    // condition, so a session in another account cannot attribute this account's
    // attempt under EITHER join word — it drops the row where `agent` is grouped,
    // exactly as before, and reads as unattributed where it is not.
    //
    // ── And the LEFT join costs nothing, which is checkable rather than assumed ─
    //
    // `s.id` is the primary key, so the join is at most one row per attempt: the
    // LEFT join cannot fan out and cannot double a counter, which matters here for
    // the same reason it does on the zone lateral. Better than that, `s` is not
    // SELECTED at all on the reads that take the LEFT join — `agent` is the only
    // dimension that reads it — so Postgres's join-removal rewrite drops the join
    // outright. Verified on this statement's real shape against Postgres 16: the
    // plan for an `hour_of_day` read contains no `agency_agent_sessions` node at
    // all. So the LEFT join is not a cost traded for correctness; it is free, and
    // keeping it (rather than emitting no session join at all) is what stops a
    // future dimension that reads `s` from meeting a `42P01` at runtime on a
    // statement that type-checks.
    //
    // One spelling of the ON clause, one varying word. The alternative — two whole
    // join clauses — is how the tenant predicate comes to be present on one of them.
    const sessionJoin = `${p.groupBy.includes('agent') ? 'JOIN' : 'LEFT JOIN'} agency_agent_sessions s ON s.id = a.reserved_agent_id
          AND s.tenant_id = $3
          AND s.account_id = $4`;

    // ── ONE CLIENT, ONE TRANSACTION, ONE SNAPSHOT ─────────────────────────────
    //
    // The two statements were issued in PARALLEL on the pool, which is two
    // connections and therefore two READ COMMITTED snapshots taken at two instants.
    // A `default_timezone` UPDATE committing between them is all it takes for the
    // zone this page REPORTS to differ from the zone its buckets were CUT in — the
    // one thing this field exists to rule out. Nor is it a hypothetical race over a
    // never-touched column: `default_timezone` is customer-facing config, and an
    // operator correcting a typo'd zone is PRECISELY the moment the two reads
    // disagree — which is also the moment the stored value and the resolved value
    // differ, i.e. the case the whole apparatus was built for.
    //
    // So both reads go on one client inside one `REPEATABLE READ` transaction. That
    // isolation level takes its snapshot at the FIRST statement and holds it for the
    // rest of the transaction, so the zone lookup necessarily reads the same
    // `agency_campaigns` row the grouped statement bucketed with, whatever commits
    // in between. `READ ONLY` is spelled out because both statements are reads and a
    // transaction that cannot write cannot be turned into one by a later edit.
    //
    // ⚠️ The grouped statement goes FIRST, and that is load-bearing twice: it is the
    // statement that TAKES the snapshot (so the zone can never be read from BEFORE
    // the buckets were cut), and every `sql()`/`params()` assertion in
    // `agent-grouped-repository.test.ts` reads the first non-control statement.
    //
    // The transaction is opened only when there IS a second statement to hold inside
    // it. A lone statement is one snapshot by construction, and wrapping it would
    // add a BEGIN and a COMMIT round trip to every contribution and trend read on
    // this surface — the ~all of them that report no zone — for a guarantee they
    // already have. Both branches issue the identical text with the identical
    // values, built once here, so they cannot drift in what they ASK; they differ
    // only in whether a companion read is held to the same snapshot.
    const groupedSql = `WITH grouped AS (
       SELECT ${innerSelect},
              ${AGENCY_ATTEMPT_METRICS_SQL}
         FROM agency_call_attempts a
         ${sessionJoin}
         JOIN agency_campaigns c ON c.id = a.campaign_id
         ${AGENCY_RESOLVED_ZONE_JOIN_SQL}
        WHERE a.tenant_id = $3
          AND a.account_id = $4
          AND a.dialed_at IS NOT NULL
          AND a.dialed_at >= $1
          AND a.dialed_at < $2${campaignFilter}
        GROUP BY ${groupOrdinals}
     )
     SELECT ${outerSelect},
            g.attempts, g.connected, g.successes, g.talk_seconds, g.wrapup_seconds,
            -- PRE-limit by construction: a window function is evaluated before
            -- LIMIT, so this counts the groups the CTE produced rather than the
            -- rows that survived the slice. A second COUNT(*) statement would be a
            -- second scan that could disagree with this one.
            COUNT(*) OVER ()::text AS total_groups
       FROM grouped g
      ORDER BY ${orderBy}
      LIMIT ${limitPlaceholder}`;

    let rows: AgencyGroupRawRow[];
    let resolvedTimezone: string | null = null;
    if (zoneCampaignId === undefined) {
      ({ rows } = await getPool().query<AgencyGroupRawRow>(groupedSql, values));
    } else {
      const client: PoolClient = await getPool().connect();
      try {
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ, READ ONLY');
        ({ rows } = await client.query<AgencyGroupRawRow>(groupedSql, values));
        resolvedTimezone = await this.resolvedCampaignZone(scope, zoneCampaignId, client);
        await client.query('COMMIT');
      } catch (err) {
        // Nothing to undo — the transaction is READ ONLY — so this releases the
        // snapshot rather than reverting anything. Swallowed because a connection
        // that is already broken must not mask the error that broke it.
        await client.query('ROLLBACK').catch(() => { /* connection already broken */ });
        throw err;
      } finally {
        client.release();
      }
    }

    return {
      from: p.from.toISOString(),
      to: p.to.toISOString(),
      campaign_id: p.campaignId ?? null,
      // Echoed in CANONICAL order, which is the order the request was
      // canonicalised into rather than the order it was spelled in.
      group_by: [...p.groupBy],
      resolved_timezone: resolvedTimezone,
      sort: p.sort,
      order: p.order,
      limit: p.limit,
      // 0 on an empty result rather than from a nullish read: with no rows there is
      // no window-function value to carry the count, and "no groups" is exactly 0.
      total_groups: rows.length === 0 ? 0 : Number(rows[0]?.total_groups ?? 0),
      rows: rows.map((row) => groupRowFromSql(row, p.groupBy)),
    };
  }

  /**
   * ONE campaign's RESOLVED zone — the value `COALESCE(z.name, 'UTC')` produces,
   * not the value stored in the column.
   *
   * ── Reading the column back would BE the bug ────────────────────────────────
   *
   * `agency_campaigns.default_timezone` is `VARCHAR(64)` with no constraint,
   * populated from customer-facing config, and the join that resolves it is LEFT
   * (and LATERAL, and `LIMIT 1`) precisely so an unresolvable value cannot raise
   * `22023 invalid_parameter_value` and take out every other campaign's numbers in
   * the same statement. The consequence is that the stored value and the zone the
   * buckets were actually cut in differ **exactly when the stored value is
   * garbage** — so `SELECT c.default_timezone` here would hand a console
   * `Asia/Calcutta_typo` to print over columns that are in fact UTC, on precisely
   * the campaign whose zone is broken. This selects
   * {@link AGENCY_RESOLVED_ZONE_SQL} through {@link AGENCY_RESOLVED_ZONE_JOIN_SQL}
   * — the same two constants `groupedStats` cuts its buckets with, so the reported
   * zone and the zone used cannot drift.
   *
   * ── It takes the CLIENT, and the parameter is required for a reason ────────
   *
   * `client`, not `getPool()`. This statement and the grouped statement have to see
   * the SAME `agency_campaigns` row, and on the pool they would not: two
   * connections are two READ COMMITTED snapshots, so a `default_timezone` UPDATE
   * committing between them makes this method report a zone the buckets were never
   * cut in — the exact confusion the field exists to remove. The caller holds both
   * on one client in one `REPEATABLE READ` transaction; see `groupedStats`.
   *
   * Required rather than defaulted to the pool, and it is the only reason this
   * parameter is not optional: a default would let a future caller — or a
   * refactor of this one — reintroduce the two-snapshot read by omission, in
   * silence, on a method whose whole contract is that it agrees with a statement
   * somewhere else. A missing argument is a build error that names the call site.
   *
   * ── The scope is a predicate here too ──────────────────────────────────────
   *
   * `tenant_id` and `account_id`, not a bare primary-key lookup: `campaign_id`
   * arrives from the caller and a UUID from another account must not resolve to
   * that account's configuration, however small the leak. It also settles the
   * degenerate case honestly — a `campaign_id` naming no campaign IN SCOPE matches
   * no row, and `null` is then the right answer, because a filter that selected no
   * campaign did not select "exactly one" and the page it produced (necessarily
   * empty) was cut in no zone at all.
   *
   * A matched row can never yield SQL NULL: the COALESCE guarantees a value. So the
   * `?? null` maps ONLY "no such campaign in this account", and never a row whose
   * zone failed to resolve — that row returns `'UTC'`, which is what the buckets
   * actually used.
   */
  private async resolvedCampaignZone(
    scope: { tenantId: string; accountId: string },
    campaignId: string,
    client: PoolClient,
  ): Promise<string | null> {
    const { rows } = await client.query<{ resolved_timezone: string }>(
      `SELECT ${AGENCY_RESOLVED_ZONE_SQL} AS resolved_timezone
         FROM agency_campaigns c
         ${AGENCY_RESOLVED_ZONE_JOIN_SQL}
        WHERE c.id = $1::uuid
          AND c.tenant_id = $2
          AND c.account_id = $3`,
      [campaignId, scope.tenantId, scope.accountId],
    );
    return rows[0]?.resolved_timezone ?? null;
  }

  /**
   * Seconds per (agent, state) over the window, for a KNOWN set of agents.
   *
   * `stats()`'s `occupancyBuckets` with the bucket machinery removed and the
   * single agent id widened to an array. The interval clips it documents at length
   * are all still here and still load-bearing — the open final interval running to
   * `LEAST(now(), to, left_at)`, the event that CARRIES IN from before `from`, and
   * the `sess` CTE bounded to sessions overlapping the window (which is what keeps
   * `carried` from handing every closed session in an agent's tenure a full-window
   * interval). Read that method's header for why each exists; nothing about them
   * changes when the read covers a floor instead of a person, and the two
   * statements are kept BYTE-COMPARABLE on all of it — same clips, same tiebreaks,
   * same parameter positions — because they must agree and a divergence between
   * them is worse than either bug alone.
   *
   * What DOES go away is bucket splitting. With no buckets there is no
   * `generate_series`, no `CROSS JOIN LATERAL`, and no campaign timezone —
   * `bucketTruncSql` is the only thing that ever needed the zone, and the
   * `pg_timezone_names` LEFT JOIN existed only to stop an unresolvable one raising
   * `22023` inside it. A duration is zone-independent, so the whole apparatus
   * drops out rather than being carried along unused.
   *
   * ── `agent_user_id = ANY($1)` is not a filter, it is the driving predicate ──
   *
   * It appears on BOTH event reads, exactly as `stats()` carries `= $1` on both,
   * and for the identical reason spelled out in migration 105's header:
   * `idx_agency_session_events_agent` is `(agent_user_id, at)` and `session_id` is
   * deliberately not indexed, so without a predicate on the leading column the
   * planner has nothing to drive the range on `at` from. The ids come from the
   * attempts aggregate, which is why the two reads are sequential here where the
   * per-agent record runs them in parallel.
   *
   * It also carries the scope a second time over: the ids are already the output
   * of a tenant-and-account-scoped statement, and `sess` re-applies both
   * predicates anyway. That is deliberate belt-and-braces on a surface where the
   * WHERE clause is the only thing separating two accounts' floors — an
   * `agent_user_id` is opaque to the dialer tables and could legitimately collide across
   * tenants.
   */
  private async rosterOccupancyTotals(
    scope: { tenantId: string; accountId: string },
    p: AgentRosterParams,
    agentUserIds: readonly string[],
  ): Promise<{ agent_user_id: string; state: string; seconds: number }[]> {
    // Bound in the SAME ORDER as `occupancyBuckets`: the agent selector first,
    // then from, to, tenant, account. The two statements are ~90% identical text
    // and a future editor will diff or copy between them, so binding the same five
    // values at different positions is a trap -- a swapped from/to survives review
    // because `WHERE i.ended > i.started` absorbs an inverted window as an empty
    // result rather than as an error. One convention across both: the selector, if
    // the statement has one, is $1.
    const values: unknown[] = [[...agentUserIds], p.from, p.to, scope.tenantId, scope.accountId];
    let campaignFilter = '';
    if (p.campaignId) {
      values.push(p.campaignId);
      campaignFilter = `\n            AND s.campaign_id = $${values.length}::uuid`;
    }

    const { rows } = await getPool().query<{
      agent_user_id: string; state: string; seconds: string;
    }>(
      `WITH sess AS (
         -- The sessions that OVERLAP the window, never all of them. A session's
         -- life is [joined_at, left_at), the window is [$2, $3), and two half-open
         -- intervals overlap iff each starts before the other ends.
         --
         -- Unbounded, this CTE is what would make the read scale with TENURE
         -- rather than with the window: every closed session still has a terminal
         -- event before $2, so carried hands each one an interval that, having no
         -- successor inside the window, runs the window's full width. Sixty past
         -- shifts become sixty full-window offline intervals per agent.
         SELECT s.id, s.agent_user_id, s.left_at
           FROM agency_agent_sessions s
          WHERE s.tenant_id = $4
            AND s.account_id = $5
            AND s.agent_user_id = ANY($1::uuid[])
            AND s.joined_at < $3
            AND (s.left_at IS NULL OR s.left_at > $2)${campaignFilter}
       ), in_window AS (
         -- e.agent_user_id = ANY($1) is the denormalised copy migration 105 exists
         -- to carry, and it is what makes idx_agency_session_events_agent
         -- (agent_user_id, at) usable: without a predicate on the leading column
         -- the range on at cannot be driven from it, and session_id is indexed by
         -- nothing at all. The join to sess stays -- it is what applies the
         -- tenant/account scope and the optional campaign narrowing.
         --
         -- e.id rides along for the lead() tiebreak in intervals, for the same
         -- reason carried's ORDER BY carries it: at alone is not unique.
         SELECT e.session_id, e.to_state, e.at, e.id
           FROM agency_agent_session_events e
           JOIN sess ON sess.id = e.session_id
          WHERE e.agent_user_id = ANY($1::uuid[])
            AND e.at >= $2 AND e.at < $3
       ), carried AS (
         -- The state at $2 is set by the last event BEFORE $2, which is not in the
         -- window. Exactly one row per session, clipped to the window's start
         -- below. Without it an agent who went available at 08:55 and first dialled
         -- at 09:30 shows 35 minutes of nothing in a window starting at 09:00.
         --
         -- e.id DESC breaks a tie on at, and ties are real in rows already in the
         -- table: before at was carried from the mutation, the batch INSERT took
         -- migration 105's DEFAULT now() -- the transaction timestamp, identical
         -- for every row of a markAllOffline sweep of the whole floor. Without the
         -- tiebreak DISTINCT ON returns whichever row the executor reached first,
         -- so the carried-in state is not reproducible between two runs.
         SELECT DISTINCT ON (e.session_id) e.session_id, e.to_state, e.at, e.id
           FROM agency_agent_session_events e
           JOIN sess ON sess.id = e.session_id
          WHERE e.agent_user_id = ANY($1::uuid[])
            AND e.at < $2
          ORDER BY e.session_id, e.at DESC, e.id DESC
       ), events AS (
         SELECT * FROM in_window
         UNION ALL
         SELECT * FROM carried
       ), intervals AS (
         -- The log records instants, so a duration is the gap to the next event on
         -- the same SESSION. Three clips on that close, and the third is not
         -- decoration.
         --
         -- An open final interval -- the newest event, with nothing after it -- is
         -- the agent's current state and has no end: now() closes it, and $3
         -- closes it again to the window's own upper bound when the window is
         -- historical. Without those the state an agent has been in all afternoon
         -- is the one the roster does not mention.
         --
         -- sess.left_at closes it for a session that ENDED. leave() sets left_at
         -- and writes the closing offline event in the same call, but that write is
         -- the best-effort one recordTransitions swallows with a warn: drop it and
         -- a session closed at 11:30 in state available credits every remaining
         -- second of the window to available -- inflating shift_seconds, deflating
         -- that agent's occupancy_pct, and dragging the cohort percentiles down
         -- with it. left_at is the one clip whose source is the sessions table
         -- rather than the log, so it survives exactly the failure the other two
         -- cannot see.
         --
         -- LEAST already ignores NULLs, so the COALESCE is for the reader: a live
         -- session has no left_at and must not be clipped at all, and 'infinity'
         -- says that rather than leaving it to a function's null semantics.
         --
         -- ev.id breaks a tie on ev.at, the same tie carried breaks above and for
         -- the same reason. Where two tied events are followed by a third, lead()
         -- without the tiebreak leaves it undefined WHICH of the tied states keeps
         -- the surviving interval, so two reads of one window can attribute the
         -- same seconds to different states. id is a random uuid, so the order it
         -- imposes on a tie is arbitrary -- but it is TOTAL and it is STABLE, which
         -- is the whole ask: tied events have no chronology to recover, and the
         -- failure being fixed is a number that moves between reads.
         SELECT sess.agent_user_id,
                ev.to_state AS state,
                GREATEST(ev.at, $2::timestamptz) AS started,
                LEAST(
                  COALESCE(lead(ev.at) OVER (PARTITION BY ev.session_id ORDER BY ev.at, ev.id), now()),
                  $3::timestamptz,
                  -- offline is exempt from the left_at clip, for the reason set out
                  -- at length in occupancyBuckets: the clip exists to stop a SHIFT
                  -- state surviving a swallowed closing write and inflating
                  -- shift_seconds, and offline is excluded from the shift. Both
                  -- reads must agree on this -- the roster's shift_seconds and the
                  -- per-agent record's buckets are one measurement asked at two
                  -- altitudes, and a supervisor comparing them is entitled to one
                  -- answer.
                  CASE
                    WHEN ev.to_state = 'offline' THEN 'infinity'::timestamptz
                    ELSE COALESCE(sess.left_at, 'infinity'::timestamptz)
                  END
                ) AS ended
           FROM events ev
           JOIN sess ON sess.id = ev.session_id
       )
       SELECT i.agent_user_id,
              i.state,
              SUM(EXTRACT(EPOCH FROM (i.ended - i.started)))::text AS seconds
         FROM intervals i
        WHERE i.ended > i.started
        GROUP BY i.agent_user_id, i.state
        ORDER BY i.agent_user_id, i.state`,
      values,
    );

    return rows.map((r) => ({
      agent_user_id: r.agent_user_id,
      state: r.state,
      seconds: Number(r.seconds),
    }));
  }
}

/**
 * The cohort the roster's rows are read against.
 *
 * A free function rather than a method because it is a pure fold over rows the
 * repository has already produced — it issues no statement, and computing it from
 * the rows rather than from a third aggregate is what makes `benchmark.agents` and
 * `AgencyRosterPage.total_agents` the same number by construction instead of two
 * counts that have to keep agreeing.
 *
 * ── Pooled rates and percentiles are DIFFERENT numbers, both on the payload ──
 *
 * `connect_rate_pct` here is the floor's actual rate: total connected over total
 * attempts. `connect_rate.median` is the middle AGENT's rate. They diverge exactly
 * when agents differ in volume, which is always, and a consumer handed one cannot
 * derive the other — so both are served.
 *
 * The pooled rates are computed over EVERY row, thin ones included; the
 * percentiles are not. That is not an inconsistency. A pooled rate is a ratio of
 * two sums, so a row contributes in proportion to its own size — eleven calls move
 * it by eleven calls' worth. A median is a ratio of ratios, where those same
 * eleven calls cast one full vote alongside an agent's four hundred. The asymmetry
 * is the whole reason `AGENCY_ROSTER_MIN_RATE_DENOMINATOR` gates one and not the
 * other.
 *
 * ── Which rows enter each percentile pool ─────────────────────────────────────
 *
 * `rates_reportable` is the row-level gate and a row that fails it enters NONE of
 * the three pools — that is what makes the flag mean what its contract comment
 * promises. On top of it:
 *
 *   * `success_rate` additionally requires `connected >=` the threshold, because
 *     that rate's own denominator is `connected`. 400 dials with three connects is
 *     a reportable row whose 33% conversion is three calls of evidence. That extra
 *     floor is `hasRateDenominator`, the same predicate the row's own
 *     `success_rate_reportable` is set from, so the flag on the wire and the pool
 *     admission cannot disagree. Note it makes the `rated` prefilter REDUNDANT for
 *     this pool and for `aht`: `connected <= attempts` always, so `connected >= 20`
 *     already implies `attempts >= 20`. The prefilter is kept anyway — it costs
 *     nothing and it states the rule that governs all three pools — but a reader
 *     hunting for the case where the two floors disagree will not find one.
 *   * `occupancy_pct` takes every reportable row with a non-null value. Its
 *     denominator is a DURATION and the threshold counts CALLS, so the same
 *     integer cannot gate it; the exclusion that matters there is the `null` a zero
 *     `shift_seconds` already produces — which is also what a degraded occupancy
 *     read produces, so a failed events-table read empties this pool rather than
 *     filling it with zeros.
 *
 * A `null` rate is never passed through in any pool. `rosterPercentiles` ranks
 * numbers, and JavaScript sorts `null` as 0 — one agent who connected nobody would
 * otherwise sit at the bottom of the distribution as a hard 0% and drag p25 down
 * with them, which is the exact false reading the null exists to prevent.
 */
function rosterBenchmark(rows: readonly AgencyRosterAgentRow[]): AgencyRosterBenchmark {
  const pooled = rows.reduce(
    (acc, row) => {
      acc.attempts += row.attempts;
      acc.connected += row.connected;
      acc.successes += row.successes;
      acc.talk += row.talk_seconds;
      acc.wrapup += row.wrapup_seconds;
      // Pooled in the SAME reduce as the counters, over the SAME rows, rather than
      // in a second pass — which is what makes it impossible for the cohort's
      // shift to describe a different agent set from the cohort's talk time. Both
      // are 0 when the occupancy read degraded, exactly as every row's is.
      acc.shift += row.shift_seconds;
      acc.break_ += row.break_seconds;
      return acc;
    },
    { attempts: 0, connected: 0, successes: 0, talk: 0, wrapup: 0, shift: 0, break_: 0 },
  );

  const rated = rows.filter((row) => row.rates_reportable);
  /** Non-null values of one metric, over the rows that qualified for its pool. */
  const pool = (
    qualifies: (row: AgencyRosterAgentRow) => boolean,
    read: (row: AgencyRosterAgentRow) => number | null,
  ): number[] => rated
    .filter(qualifies)
    .map(read)
    .filter((value): value is number => value !== null);

  return {
    agents: rows.length,
    agents_rated: rated.length,
    attempts: pooled.attempts,
    connected: pooled.connected,
    successes: pooled.successes,
    talk_seconds: pooled.talk,
    wrapup_seconds: pooled.wrapup,
    connect_rate_pct: ratePct(pooled.connected, pooled.attempts),
    success_rate_pct: ratePct(pooled.successes, pooled.connected),
    aht_seconds: ratio(pooled.talk + pooled.wrapup, pooled.connected),
    // `rates_reportable` IS `attempts >= threshold`, so the pool needs no further
    // predicate: connect_rate's denominator is exactly the one the flag gates.
    connect_rate: rosterPercentiles(pool(() => true, (row) => row.connect_rate_pct)),
    // `hasRateDenominator`, the SAME function object both of these are handed and
    // the same one that sets the row's `success_rate_reportable` — not two copies
    // of one comparison that happen to agree today. `aht_seconds` divides by
    // `connected` exactly as `success_rate_pct` does, so the two pools take the
    // same floor, and passing the predicate rather than restating it is what makes
    // them unable to drift when the threshold is next argued about.
    success_rate: rosterPercentiles(pool(hasRateDenominator, (row) => row.success_rate_pct)),
    occupancy_pct: rosterPercentiles(pool(() => true, (row) => row.occupancy_pct)),
    shift_seconds: pooled.shift,
    break_seconds: pooled.break_,
    aht: rosterPercentiles(pool(hasRateDenominator, (row) => row.aht_seconds)),
  };
}

export const agencyCampaignRepository = new AgencyCampaignRepository();
export const agencyAbandonmentRepository = new AgencyAbandonmentRepository();
export const agencyLiveConcurrencyRepository = new AgencyLiveConcurrencyRepository();
export const agencyContactRepository = new AgencyContactRepository();
export const agencyAttemptRepository = new AgencyAttemptRepository();
export const agencyAgentSessionRepository = new AgencyAgentSessionRepository();
export const agencyAgentStatsRepository = new AgencyAgentStatsRepository();
