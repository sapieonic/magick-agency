/**
 * Team performance: `GET /proxy/agency/team-performance` (docs/team-performance.md, rulings TP1–TP20).
 *
 * The first tab of Reports for a supervisor: how the whole team did over a window of local dates,
 * on one campaign or across every campaign of the account, as five tiles, the main outcome per
 * working day, what happened on the calls, and one row per agent. Every number is Compare agents'
 * number for the same agent, campaign and window (TP2, CP9): this read is Compare's sources for the
 * whole cohort, not new definitions.
 *
 * ── Rules every shape here follows ──────────────────────────────────────────
 * - **Access (TP3, CP3):** `agency.supervise` on the context account; an agent never reaches this
 *   route (`403`). Flag `agency_team_performance_enabled` off for the tenant or account: the route
 *   answers `403 feature_disabled`, the dialer gate's body shape, as the compare routes do. No
 *   account context: `400 account_scope_required`.
 * - **Windows are local calendar DATES, both ends inclusive,** in the request's `timezone`, under
 *   the reports' window rule ({@link teamWindowProblem}, which is `reportWindowProblem`): at most
 *   `REPORT_MAX_WINDOW_DAYS` days or exactly one calendar month, never past today in the zone. The
 *   server reads the half-open instant window `[local midnight of from, local midnight after to)`;
 *   a window that holds today runs to now (TP11).
 * - **Scope:** `campaign_id` names one campaign of the account; absent, every campaign of the
 *   account ("All campaigns", the page's default, TP7).
 * - **The cohort** is every agent with a row in the roster for the scope and window (who dialled
 *   in it, `rosterAttemptTotals`), a departed member kept and flagged (TP5). An agent whose only
 *   work in the window was soft-phone or inbound calls has no row (TP14).
 * - **Tiles and table agree; the charts are the whole team's (TP14):** `totals` are sums over
 *   `agents`, so an agent with no row is in no tile. `trend` and `outcomes` are the whole team's in
 *   the scope, whoever took the calls: the per-day promises count an agent with no row too, and the
 *   bars are the rollup's dialler conversations (the console labels them "whole team" and "Dialler
 *   calls only").
 * - **Rates are FRACTIONS in [0, 1]** on this wire (`0.27`, not `27`), and so are their intervals
 *   and medians. The console renders percentages.
 * - **Data, not words (TP17, CP12, AS15):** the server sends codes, counts and labels from the
 *   campaigns' own catalogs; the console writes every sentence.
 * - Refusals are `{ error, code, message }` with `code` an {@link AgencyTeamPerformanceErrorCode}
 *   (`../../errors`). A query that fails schema validation (a missing field, a malformed
 *   `campaign_id`) is the server's generic agency 400.
 * - Not a mobile vocabulary: `fixtures/agent/literals.json` does not change.
 */
import {
  AGENCY_TEAM_PERFORMANCE_ERROR_CODES,
  AGENCY_TEAM_PERFORMANCE_ERROR_STATUS,
  type AgencyTeamPerformanceErrorCode,
} from '../../errors';
import type { AgencyTileIcon } from '../../agency/tile-icons';
import type { AllListed } from '../../primitives';
import type {
  AgencyCompareFinding,
  AgencyCompareValue,
  CompareBuiltinMetricKey,
  CompareFindingCode,
} from './compare';
import { reportWindowProblem } from './reports';

export { AGENCY_TEAM_PERFORMANCE_ERROR_CODES, AGENCY_TEAM_PERFORMANCE_ERROR_STATUS };
export type { AgencyTeamPerformanceErrorCode };

// ─────────────────────────────────────────────────────────────────────────────
// Limits and the read's guards (docs/team-performance.md §4)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Team reads one tenant may run at once; past it `429 team_busy`. The server also has a
 * process-wide limit across tenants (a share of its database pool); past that the answer is the
 * same `team_busy`.
 */
export const TEAM_PERFORMANCE_TENANT_CONCURRENT_READS = 2;

/**
 * How long a `429 team_busy` asks the client to wait before it tries again, in whole seconds: its
 * `Retry-After` header and the body's `retry_after_seconds`.
 */
export const TEAM_PERFORMANCE_BUSY_RETRY_AFTER_SECONDS = 2;

/**
 * The whole read's budget, counted from before it takes a database connection (a read sends several
 * statements). Each statement runs under a `statement_timeout` of what is left of it, less a small
 * margin; the whole read's deadline is the server's backstop. Past either `503 team_timed_out`.
 * Longer than Compare's because the read covers the whole account's cohort and, on All campaigns,
 * every campaign.
 */
export const TEAM_PERFORMANCE_READ_TIMEOUT_MS = 8_000;

/**
 * How long the server keeps an answer in its in-process cache, keyed by tenant, account, campaign
 * (or all), window and zone. An identical read already running is joined, not repeated.
 */
export const TEAM_PERFORMANCE_CACHE_TTL_MS = 30_000;

/** The working days the per-day chart shows when the window holds fewer local days than this (TP12). */
export const TEAM_TREND_WORKING_DAYS = 7;

/**
 * How far back, in local days counted from the window's `to` (itself included), the short
 * window's chart looks for its {@link TEAM_TREND_WORKING_DAYS} working days (TP12).
 */
export const TEAM_TREND_LOOKBACK_DAYS = 14;

/**
 * The most bars "What happened on the calls" draws one by one; the console folds the rest of
 * {@link AgencyTeamPerformance.outcomes} into one "Other outcomes" bar (TP13).
 */
export const TEAM_OUTCOME_BARS_MAX = 7;

// ─────────────────────────────────────────────────────────────────────────────
// Vocabularies
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What the scope's main outcome counts (TP8), the Live floor's rule:
 * - `promises`: some campaign in scope has a catalog entry with `requires_promise`. The count is
 *   promises recorded (CP2: every call type, by `dispositioned_at`, credited to the agent who took
 *   the call); the rate is Compare's `promises_rate`.
 * - `successes`: no campaign in scope records promises. The count is the roster's `successes`
 *   (`is_success` codes); the rate is Compare's `success_rate`.
 */
export type AgencyTeamMainOutcomeKind = 'promises' | 'successes';
export const AGENCY_TEAM_MAIN_OUTCOME_KINDS = ['promises', 'successes'] as const satisfies readonly AgencyTeamMainOutcomeKind[];

/**
 * The Compare metric each kind's rate is, so both sides take its unit, floor and finding rules
 * from `COMPARE_BUILTIN_METRICS` and name it in findings by that key.
 */
export const TEAM_MAIN_OUTCOME_METRIC = Object.freeze({
  promises: 'promises_rate',
  successes: 'success_rate',
} as const satisfies Record<AgencyTeamMainOutcomeKind, CompareBuiltinMetricKey>);

/**
 * Which days the per-day chart holds (TP12):
 * - `window`: the window holds {@link TEAM_TREND_WORKING_DAYS} local days or more; every working
 *   day of it;
 * - `last_working_days`: a shorter window; the last {@link TEAM_TREND_WORKING_DAYS} working days
 *   ending at `to`, looking back at most {@link TEAM_TREND_LOOKBACK_DAYS} local days.
 */
export type AgencyTeamTrendSpan = 'last_working_days' | 'window';
export const AGENCY_TEAM_TREND_SPANS = ['last_working_days', 'window'] as const satisfies readonly AgencyTeamTrendSpan[];

/** The finding codes this read can send (TP15): the cohort's rows only, no breaks, no `too_few_calls`. */
export const TEAM_FINDING_CODES = ['clear_gap', 'stands_out'] as const satisfies readonly CompareFindingCode[];

/**
 * The metrics this read's findings are about, by `AgencyCompareFinding.metric`: the scope's main
 * outcome rate ({@link TEAM_MAIN_OUTCOME_METRIC}) and the time to choose an outcome.
 */
export const TEAM_FINDING_METRICS = ['promises_rate', 'success_rate', 'choose_time'] as const satisfies readonly CompareBuiltinMetricKey[];

// ─────────────────────────────────────────────────────────────────────────────
// GET /proxy/agency/team-performance
// ─────────────────────────────────────────────────────────────────────────────

/** `GET /proxy/agency/team-performance?from=&to=&timezone=[&campaign_id=]`. */
export interface AgencyTeamPerformanceQuery {
  /** First local date, `YYYY-MM-DD`. */
  from: string;
  /** Last local date, `YYYY-MM-DD`, inclusive; not after today in `timezone`. */
  to: string;
  /** IANA zone the dates are in (the browser's). A legacy alias is answered as its current name. */
  timezone: string;
  /** One campaign of the account; absent: every campaign of the account. */
  campaign_id?: string;
}

/**
 * One agent of the cohort. Every figure is Compare's for the same agent, scope and window.
 */
export interface AgencyTeamAgentRow {
  agent_user_id: string;
  /** Null when the user no longer resolves. */
  agent_name: string | null;
  /** No longer an active member of the account; kept, because they did the work (TP5). The console writes "(left)". */
  departed: boolean;
  /** Dialler conversations: the roster's `connected` (Compare's `calls_handled`). */
  calls_handled: number;
  /**
   * The main outcome as Compare's figure ({@link TEAM_MAIN_OUTCOME_METRIC} of the scope's kind):
   * `numerator` is the count (promises, or successes), `denominator` the calls it is over, `value`
   * the rate as a fraction. For `promises` the denominator is Compare's: `calls_handled` plus the
   * agent's soft-phone conversations and answered inbound calls in scope, so it can exceed
   * `calls_handled`; for `successes` it is `calls_handled`. Under the floor (20) not `reportable`:
   * words, no bar. A rate whose count exceeds its calls is withheld (`counts_disagree`), as Compare.
   */
  main: AgencyCompareValue;
  /** Seconds talking on dialler conversations, the roster's `talk_seconds`. */
  talk_seconds: number;
  /** `talk_seconds / calls_handled`; null when `calls_handled` is 0. */
  avg_call_seconds: number | null;
  /** Seconds in measured wrap-ups, the roster's `wrapup_seconds`. */
  wrapup_seconds: number;
  /** Wrap-ups with a measured time (`MEASURED_WRAPUP_ATTEMPT_SQL`). */
  measured_wrapups: number;
  /** Compare's `choose_time`: `wrapup_seconds / measured_wrapups`, reportable from `COMPARE_TIME_MIN_CALLS` measured wrap-ups. */
  choose: AgencyCompareValue;
  /** Seconds on break in the window, from the roster's occupancy fold (breaks inside the shift, CP5). */
  break_seconds: number;
  /** Logged-in seconds in the window, breaks included (CP5), the roster's `shift_seconds`. */
  shift_seconds: number;
}

/** The scope's main outcome (TP8). */
export interface AgencyTeamMainOutcome {
  kind: AgencyTeamMainOutcomeKind;
  /**
   * The outcome codes it counts across the scope's campaigns, sorted, distinct: the
   * `requires_promise` codes for `promises`, the `is_success` codes for `successes`. The per-day
   * chart of `successes` counts these codes in the rollup.
   */
  codes: string[];
  /**
   * The one catalog label those codes carry, when they carry exactly one distinct label ("Will
   * pay"); else null, and the console writes "Will pay" (promises) or "Successes" (successes).
   * Columns and the sort pill read "{label} rate".
   */
  label: string | null;
}

/**
 * Call-backs booked by cohort agents with `callback_at` in the window, dialler-booked only (TP10),
 * in the timing classes of IN4 (`callbackClassSql`), each counted once.
 */
export interface AgencyTeamCallbacks {
  /** Call-backs whose time has come: `on_time + late + missed + pending_due`. 0: "No call-backs due yet". */
  due: number;
  /** Dialled no later than `callback_at` + `AGENCY_INSIGHTS_CALLBACK_ON_TIME_MINUTES` (an early dial counts). */
  on_time: number;
  /** Dialled after that. */
  late: number;
  /** Never dialled, and the contact has closed or the campaign has ended. */
  missed: number;
  /** Not dialled yet, its time passed, still open (overdue). */
  pending_due: number;
  /** Not dialled yet, its time still ahead (only in a window that holds now); not in `due`. */
  upcoming: number;
}

/**
 * The campaigns' allowed time to choose an outcome (`wrapup_seconds`, default 30), over the
 * scope's campaigns with calls in the window.
 */
export interface AgencyTeamWrapupAllowed {
  /**
   * The one value they share: seconds, `0` for no time limit. Null when they differ (`varies`) or
   * no campaign had calls.
   */
  seconds: number | null;
  /** True when campaigns with calls allow different times: "allowed time differs by campaign". */
  varies: boolean;
}

/**
 * The team's own figures: sums over EVERY cohort row, thin ones included (ratios of sums), and
 * nothing else: an agent with no row is in no total (TP14), so the tiles always agree with the table.
 */
export interface AgencyTeamTotals {
  /** Cohort rows ("by N agents"). */
  agents: number;
  /** Σ `calls_handled`. */
  calls_handled: number;
  /**
   * The main outcome over the sums, by the same rule as a row's `main` (the floor on the summed
   * denominator): `numerator` the team's count, `value` the pooled rate.
   */
  main: AgencyCompareValue;
  /**
   * `promises` only: the soft-phone conversations and answered inbound calls inside `main`'s
   * denominator (the console's "counts N soft-phone and inbound calls"); 0 otherwise.
   */
  other_conversations: number;
  /** Σ `talk_seconds` / Σ `calls_handled`; null when no calls. */
  avg_call_seconds: number | null;
  /** Σ `wrapup_seconds` / Σ `measured_wrapups`; null when none measured. */
  choose_seconds: number | null;
  wrapup_allowed: AgencyTeamWrapupAllowed;
  callbacks: AgencyTeamCallbacks;
}

/**
 * The cohort medians the table's ticks are drawn at: `percentile_cont(0.5)` (`cohortPercentiles`),
 * each null when no row qualifies.
 */
export interface AgencyTeamMedians {
  /** Over every row. */
  calls_handled: number | null;
  /** Over the rows whose `main` is `reportable` (a fraction). */
  main_rate: number | null;
  /** Over the rows with a non-null `avg_call_seconds`. */
  avg_call_seconds: number | null;
  /** Over the rows whose `choose` is `reportable`. */
  choose_seconds: number | null;
}

/**
 * One outcome of "What happened on the calls": dialler conversations in the window ending in it,
 * from the Insights rollup (`agency_insights_rollup_codes`, TP13).
 */
export interface AgencyTeamOutcomeBar {
  /** The outcome code; null for no outcome chosen (a null code and `no_disposition` together). */
  code: string | null;
  /**
   * The label in the scope's catalogs; when campaigns label one code differently, the label of
   * the campaign with the most conversations on it. Null for no outcome chosen and for a code in
   * no current catalog (the console shows the code).
   */
  label: string | null;
  /** The tile icon the same catalog entry carries; null when it has none. */
  icon: AgencyTileIcon | null;
  conversations: number;
}

/** The main outcome per working day (TP12). */
export interface AgencyTeamTrend {
  span: AgencyTeamTrendSpan;
  /**
   * The working days, `YYYY-MM-DD`, in order: local days with at least one dialler conversation in
   * scope (the rollup) or a count that is not zero. A day off is left out, not drawn as 0.
   */
  dates: string[];
  /**
   * The team's count per date, `dates.length` long: promises recorded that local day (every call
   * type, by whoever took the call, an agent with no row included: TP14), or conversations ending
   * in a success code (the rollup).
   */
  counts: number[];
}

/** `GET /proxy/agency/team-performance` 200. Sent with `Cache-Control: no-store`. */
export interface AgencyTeamPerformance {
  /** The request's campaign; null for All campaigns. */
  campaign_id: string | null;
  from: string;
  to: string;
  /** The zone the answer is in (a legacy alias answered as its current name). */
  timezone: string;
  /** When the figures were read (ISO instant). "Today, up to 2:15 PM" is written from it. */
  as_of: string;
  /**
   * How fresh the rollup behind `outcomes` and the successes trend is: the oldest of the scope's
   * campaigns' newest folded attempt change (ISO instant). Null when the rollup holds nothing for
   * the scope.
   */
  rollup_as_of: string | null;
  main_outcome: AgencyTeamMainOutcome;
  totals: AgencyTeamTotals;
  medians: AgencyTeamMedians;
  /**
   * Every outcome with a conversation in the window, most conversations first (ties by code,
   * no outcome chosen last among equals). The console draws the first
   * {@link TEAM_OUTCOME_BARS_MAX} and folds the rest into "Other outcomes".
   */
  outcomes: AgencyTeamOutcomeBar[];
  trend: AgencyTeamTrend;
  /** Every cohort row, in no particular order: the console sorts (TP16). */
  agents: AgencyTeamAgentRow[];
  /** One campaign is selected (`campaign_id !== null`): only then are agents compared (TP7, CP8). */
  comparable: boolean;
  /**
   * `compareFindings` over the main outcome rate and `choose_time`, every row picked, keeping only
   * {@link TEAM_FINDING_CODES}; `not_clear` is not sent. Always `[]` when not `comparable`.
   */
  findings: AgencyCompareFinding[];
}

/**
 * The team window rule: the reports' rule (RP2) answered with the team code. Null when acceptable,
 * else `team_window_invalid` (a malformed date, `to` before `from`, `to` after `today` when given,
 * or longer than the reports allow).
 */
export function teamWindowProblem(from: string, to: string, today?: string): Extract<AgencyTeamPerformanceErrorCode, 'team_window_invalid'> | null {
  return reportWindowProblem(from, to, today) === null ? null : 'team_window_invalid';
}

// ─────────────────────────────────────────────────────────────────────────────
// Refusal body
// ─────────────────────────────────────────────────────────────────────────────

/** The body of every team performance refusal. `message` is English fallback copy; the console keys off `code`. */
export interface AgencyTeamPerformanceErrorResponse {
  error: string;
  code: AgencyTeamPerformanceErrorCode;
  message: string;
  /**
   * `team_busy` only: seconds to wait before trying again ({@link TEAM_PERFORMANCE_BUSY_RETRY_AFTER_SECONDS}),
   * the same as the `Retry-After` header. Absent on every other refusal.
   */
  retry_after_seconds?: number;
}

const _kindsListed: AllListed<AgencyTeamMainOutcomeKind, typeof AGENCY_TEAM_MAIN_OUTCOME_KINDS> = true;
const _spansListed: AllListed<AgencyTeamTrendSpan, typeof AGENCY_TEAM_TREND_SPANS> = true;
void [_kindsListed, _spansListed];
