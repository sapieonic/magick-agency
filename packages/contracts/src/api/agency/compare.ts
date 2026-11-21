/**
 * Compare agents: `POST /proxy/agency/compare/query`, `GET /proxy/agency/compare/options` and the
 * saved views `/proxy/agency/compare/views*` (docs/compare-agents.md, rulings CP1–CP18).
 *
 * A supervisor puts up to {@link COMPARE_PAGE_MAX_AGENTS} agents of ONE campaign (CP8) side by
 * side, against the rest of the campaign's agents (the COHORT), over a window of local dates, on up
 * to {@link COMPARE_MAX_METRICS} metrics. The server answers every figure with its numerator and
 * denominator, the cohort's band, and the findings: codes and numbers, never sentences (CP12; the
 * console writes the words, AS15).
 *
 * ── Rules every shape here follows ──────────────────────────────────────────
 * - **Access (CP3):** `agency.supervise` on the context account, then the campaign must be one of
 *   that account's; an agent never reaches these routes (`403`). Flag `agency_compare_enabled` off
 *   for the tenant or account: every route answers `403 feature_disabled`, the dialer gate's body
 *   shape, as the reports routes do.
 * - **Windows are local calendar DATES, both ends inclusive,** in the request's `timezone`, under
 *   the reports' window rule ({@link compareWindowProblem}, which is `reportWindowProblem`): at
 *   most `REPORT_MAX_WINDOW_DAYS` days or exactly one calendar month, never past today in the zone.
 *   The server reads the half-open instant window `[local midnight of from, local midnight after to)`.
 * - **The cohort** is every agent with a row in the roster scoped to the campaign and window
 *   (`readAccountRoster` with `campaign_id`: who dialled the campaign in the window, a revoked
 *   member included, CP8, CP9). A picked agent must be in it (`compare_agent_not_in_cohort`).
 * - **Rates are FRACTIONS in [0, 1]** on this wire (`0.194`, not `19.4`), and so are their
 *   intervals, percentiles, gaps ({@link CompareMetricDefinition.min_gap}) and pooled rates. The
 *   console renders percentages. The roster's own `*_pct` fields are not on this wire.
 * - **One definition per number (CP9):** every built-in metric takes its numerator, denominator
 *   and floor from a read that already serves a screen ({@link COMPARE_BUILTIN_METRICS} names it);
 *   an outcome set ({@link AgencyCompareOutcomeSetRef}) reads the Insights rollup's per-agent
 *   counts by code (`agency_insights_rollup_codes`), dialler conversations only, as Insights does.
 * - **Metrics are keyed by their id** ({@link compareMetricId}): the built-in key itself, or the
 *   canonical id of an outcome set. Every `Record<string, …>` below is keyed by those ids, exactly
 *   the ids of the request's `metrics` (and the trend's, on `trend`).
 * - Refusals are `{ error, code, message }` with `code` an {@link AgencyCompareErrorCode}
 *   (`../../errors`). A body that fails schema validation (a missing field, a wrong type, an
 *   empty or duplicated `agent_ids`, an empty `metrics`) is the server's generic 400.
 * - Wire codes are plain identifiers; console copy is simple Indian English with British spelling.
 */
import { AGENCY_COMPARE_ERROR_CODES, AGENCY_COMPARE_ERROR_STATUS, type AgencyCompareErrorCode } from '../../errors';
import { AGENCY_ROSTER_MIN_RATE_DENOMINATOR } from '../../agency/performance';
import type { AllListed } from '../../primitives';
import { reportWindowProblem } from './reports';

export { AGENCY_COMPARE_ERROR_CODES, AGENCY_COMPARE_ERROR_STATUS };
export type { AgencyCompareErrorCode };

// ─────────────────────────────────────────────────────────────────────────────
// Limits and the findings' thresholds (CP1, CP11, docs/compare-agents.md §6, §7)
// ─────────────────────────────────────────────────────────────────────────────

/** The most agents on the Compare page (CP1). The roster's tray keeps its own 4. */
export const COMPARE_PAGE_MAX_AGENTS = 3;

/** The most metrics one comparison (or saved view) shows. */
export const COMPARE_MAX_METRICS = 6;

/** The most outcome codes in one outcome set. */
export const COMPARE_OUTCOME_SET_MAX_CODES = 5;

/** The longest label a supervisor may give an outcome set, in characters, after trimming. */
export const COMPARE_OUTCOME_LABEL_MAX = 60;

/**
 * The fewest cohort agents that must clear a metric's floor (be `reportable` on it, the picked
 * agents included) before that metric yields any finding or `not_clear` entry at all (§6).
 */
export const COMPARE_MIN_RATED_COHORT = 6;

/** The most findings in one answer, all agents together. */
export const COMPARE_FINDINGS_MAX = 5;

/** The most findings about one agent. */
export const COMPARE_FINDINGS_PER_AGENT = 3;

/** The z of the two-sided 95% Wilson score interval every rate carries (CP11). */
export const COMPARE_INTERVAL_Z = 1.96;

/** A time is a `clear_gap` at this many times the cohort median or more (`choose_time`). */
export const COMPARE_TIME_RATIO_CLEAR = 1.5;

/** A time from this many times the cohort median up to {@link COMPARE_TIME_RATIO_CLEAR} goes to `not_clear`. */
export const COMPARE_TIME_RATIO_NOT_CLEAR = 1.25;

/** The fewest measured wrap-ups behind a time before it can be named: the roster's floor. */
export const COMPARE_TIME_MIN_CALLS = AGENCY_ROSTER_MIN_RATE_DENOMINATOR;

/** Breaks over their reason's limit in the window at which `over_break_limit` names an agent. */
export const COMPARE_BREAK_OVERRUNS_MIN = 2;

/**
 * The floor on `callbacks_kept_rate`: call-backs whose time has come and gone (kept on time, late
 * or missed). Lower than the roster's 20 because an agent books a handful of call-backs a week, so
 * 20 would withhold the metric from almost everyone; 8 keeps a two- or three-call-back agent out
 * of the band, and the Wilson interval (about ±30 points at 8) already keeps a thin rate from
 * being named.
 */
export const COMPARE_CALLBACKS_MIN_DENOMINATOR = 8;

/** A saved view's `name`: 1 to this many characters after trimming. */
export const COMPARE_VIEW_NAME_MAX = 80;

/** The most saved views one supervisor may own in one account (`409 compare_view_limit`). */
export const COMPARE_VIEWS_PER_USER_MAX = 50;

/** Compare reads (query and options) one tenant may run at once; past it `429 compare_busy` (§7). */
export const COMPARE_TENANT_CONCURRENT_READS = 2;

/**
 * How long a `429 compare_busy` asks the client to wait before it tries again, in whole seconds:
 * its `Retry-After` header and the body's `retry_after_seconds`. A read takes at most
 * {@link COMPARE_READ_TIMEOUT_MS}; most take well under a second.
 */
export const COMPARE_BUSY_RETRY_AFTER_SECONDS = 2;

/**
 * The read's `SET LOCAL statement_timeout`, and the deadline of the whole read (a read sends several
 * statements); past either `503 compare_timed_out` (§7).
 */
export const COMPARE_READ_TIMEOUT_MS = 3_000;

/**
 * How long the server keeps an answer in its in-process cache (§7), keyed by tenant, the
 * caller's membership scope, campaign, window, zone, agents, metric ids and trend id.
 */
export const COMPARE_CACHE_TTL_MS = 30_000;

/**
 * The outcome-code format the campaign catalog accepts (`validateDispositionCatalog`,
 * `apps/server/src/agency/agency-campaign-config.ts`): 1–50 lowercase letters, digits or
 * underscores. Codes are compared byte for byte, as everywhere else.
 */
export const COMPARE_OUTCOME_CODE_PATTERN = /^[a-z0-9_]{1,50}$/;

// ─────────────────────────────────────────────────────────────────────────────
// Vocabularies
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A lens: a starting set of metrics for a kind of campaign (§4). The lens's defaults depend on the
 * campaign's catalog and live in `@magick-agency/domain/agent-compare` (`compareLensDefaults`,
 * `compareStartingLens`). No Inbound lens until inbound calls are in the rollup (CP16).
 */
export type CompareLens = 'collections' | 'sales' | 'verification';
export const COMPARE_LENSES = ['collections', 'sales', 'verification'] as const satisfies readonly CompareLens[];

/** The built-in metrics (§3). Outcome sets are the other kind ({@link AgencyCompareOutcomeSetRef}). */
export type CompareBuiltinMetricKey =
  | 'calls_handled'
  | 'calls_per_hour'
  | 'connect_rate'
  | 'success_rate'
  | 'promises_rate'
  | 'promised_amount'
  | 'callbacks_booked'
  | 'callbacks_kept_rate'
  | 'avg_call'
  | 'choose_time'
  | 'no_outcome_rate'
  | 'breaks_over_limit';
export const COMPARE_BUILTIN_METRIC_KEYS = [
  'calls_handled',
  'calls_per_hour',
  'connect_rate',
  'success_rate',
  'promises_rate',
  'promised_amount',
  'callbacks_booked',
  'callbacks_kept_rate',
  'avg_call',
  'choose_time',
  'no_outcome_rate',
  'breaks_over_limit',
] as const satisfies readonly CompareBuiltinMetricKey[];

/**
 * What a value is:
 * - `count`: a whole number in the window (`value` = `numerator`, `denominator` null);
 * - `rate`: `numerator / denominator` as a fraction in [0, 1], with a Wilson interval;
 * - `seconds`: an average, `numerator` seconds over `denominator` calls;
 * - `per_hour`: `numerator` calls per hour of `denominator` logged-in SECONDS (`value` =
 *   `numerator / denominator * 3600`);
 * - `amount`: a sum of amounts with no currency (PT5; `value` = `numerator`, `denominator` null).
 */
export type CompareMetricUnit = 'count' | 'rate' | 'seconds' | 'per_hour' | 'amount';
export const COMPARE_METRIC_UNITS = ['count', 'rate', 'seconds', 'per_hour', 'amount'] as const satisfies readonly CompareMetricUnit[];

/** Which way is better. `neutral`: shown for context and never named in a finding (CP10). */
export type CompareMetricBetter = 'higher' | 'lower' | 'neutral';
export const COMPARE_METRIC_BETTER = ['higher', 'lower', 'neutral'] as const satisfies readonly CompareMetricBetter[];

/** The picker's groups (§2), in the picker's order. Outcome sets are `outcomes`. */
export type CompareMetricGroup = 'volume' | 'outcomes' | 'handling' | 'time_use';
export const COMPARE_METRIC_GROUPS = ['volume', 'outcomes', 'handling', 'time_use'] as const satisfies readonly CompareMetricGroup[];

/**
 * What a finding says (§6). Stable for the appraisal record that may come later (CP4): a code's
 * meaning never changes; a new meaning is a new code.
 * - `clear_gap`: a rate whose 95% interval lies wholly on the worse side of the rest of the
 *   cohort's pooled rate by at least the metric's `min_gap`; or `choose_time` at
 *   {@link COMPARE_TIME_RATIO_CLEAR} times the cohort median or more.
 * - `stands_out`: a higher-is-better OUTCOME rate (`success_rate`, `promises_rate`, a `higher`
 *   outcome set) whose interval lies wholly above the rest's pooled rate by at least `min_gap`.
 * - `over_break_limit`: {@link COMPARE_BREAK_OVERRUNS_MIN} or more breaks over their limit.
 * - `too_few_calls`: a picked agent under the floor of a flaggable metric on screen; once per agent.
 */
export type CompareFindingCode = 'clear_gap' | 'stands_out' | 'over_break_limit' | 'too_few_calls';
export const COMPARE_FINDING_CODES = ['clear_gap', 'stands_out', 'over_break_limit', 'too_few_calls'] as const satisfies readonly CompareFindingCode[];

/**
 * The next step a finding offers, each a filtered view that exists (§6):
 * - `listen_recent`: the call log for the agent, recorded calls only (RC1); hidden without
 *   listening rights;
 * - `listen_outcome`: the call log for the agent and the finding's outcome codes (the outcome
 *   set's codes; for `success_rate` the catalog's success codes);
 * - `share_best_call`: the agent's recorded calls ending in the outcome, to pick one to share;
 * - `open_breaks`: the agent record's breaks;
 * - `message_outcome_tip`: a supervisor message to the agent (floor assist's Talk to agent);
 * - `late_callbacks`: Call-backs filtered to the agent, late and missed first.
 */
export type CompareNextStep =
  | 'listen_recent'
  | 'listen_outcome'
  | 'share_best_call'
  | 'open_breaks'
  | 'message_outcome_tip'
  | 'late_callbacks';
export const COMPARE_NEXT_STEPS = [
  'listen_recent',
  'listen_outcome',
  'share_best_call',
  'open_breaks',
  'message_outcome_tip',
  'late_callbacks',
] as const satisfies readonly CompareNextStep[];

// ─────────────────────────────────────────────────────────────────────────────
// The metric catalog (§3, CP9, CP10)
// ─────────────────────────────────────────────────────────────────────────────

/** How one metric is measured and judged. */
export interface CompareMetricDefinition {
  unit: CompareMetricUnit;
  better: CompareMetricBetter;
  group: CompareMetricGroup;
  /**
   * The smallest gap worth a rate finding, as a fraction (0.05 is five points). Set on the
   * directional rates only; null on every other metric (a time is judged by ratio, breaks by
   * count, a neutral metric never).
   */
  min_gap: number | null;
  /**
   * The floor: the value is `reportable` only when its `denominator` is at least this. Null: no
   * floor (counts, amounts, `calls_per_hour`), so the value is reportable whenever it is non-null.
   * A value under its floor is still served with its counts; it is drawn as words, never a bar,
   * and enters no percentile pool.
   */
  min_denominator: number | null;
  /**
   * Can be the per-day trend's metric (`trend`): the daily figure is the numerator counted per
   * local day. True for `promises_rate` (promises per day) and every outcome set.
   */
  countable: boolean;
  /**
   * Offered only when the campaign's current catalog has a `requires_promise` entry
   * ({@link AgencyCompareOptions.records_promises}); otherwise the metric is refused
   * `compare_metric_invalid`.
   */
  needs_promise_catalog: boolean;
}

/**
 * Every built-in metric's definition. Where each number comes from (the server's read must take
 * these and nothing else; the integration oracle holds them to the roster and the agent record):
 *
 * | Key | Numerator / denominator | Read |
 * |---|---|---|
 * | `calls_handled` | conversations | roster row `connected` |
 * | `calls_per_hour` | conversations / logged-in seconds (breaks inside, CP5) | roster `connected`, `shift_seconds` |
 * | `connect_rate` | human connects / placed first dials | roster (`connect_rate_pct`'s counts; floor = `rates_reportable`) |
 * | `success_rate` | successes / conversations | roster `successes`, `connected` (floor = `success_rate_reportable`) |
 * | `promises_rate` | promises recorded / conversations, dialler + soft phone + inbound (CP2) | the promise columns of 0041 on the three call tables, by the agent who took the call |
 * | `promised_amount` | sum of `promise_amount` on those promises | the same |
 * | `callbacks_booked` | call-backs the agent booked with a time in the window | `agentCallbackTiming` (`due_in_range`) scoped to the campaign |
 * | `callbacks_kept_rate` | kept on time / call-backs whose time has passed (on time + late + missed) | the same (IN4 classes) |
 * | `avg_call` | talk seconds / conversations | roster `talk_seconds`, `connected` |
 * | `choose_time` | measured wrap-up seconds / measured wrap-ups | roster `wrapup_seconds` over the count of the same attempts (`MEASURED_WRAPUP_ATTEMPT_SQL`; the read adds that count) |
 * | `no_outcome_rate` | conversations closed with no outcome / conversations (dialler) | rollup `no_outcome` facet by agent |
 * | `breaks_over_limit` | breaks that ended over their reason's limit | `break_overrun_seconds` (0060, AS12), reserved breaks never |
 */
export const COMPARE_BUILTIN_METRICS: Readonly<Record<CompareBuiltinMetricKey, CompareMetricDefinition>> = Object.freeze({
  calls_handled: { unit: 'count', better: 'neutral', group: 'volume', min_gap: null, min_denominator: null, countable: false, needs_promise_catalog: false },
  calls_per_hour: { unit: 'per_hour', better: 'neutral', group: 'volume', min_gap: null, min_denominator: null, countable: false, needs_promise_catalog: false },
  connect_rate: { unit: 'rate', better: 'neutral', group: 'volume', min_gap: null, min_denominator: AGENCY_ROSTER_MIN_RATE_DENOMINATOR, countable: false, needs_promise_catalog: false },
  success_rate: { unit: 'rate', better: 'higher', group: 'outcomes', min_gap: 0.05, min_denominator: AGENCY_ROSTER_MIN_RATE_DENOMINATOR, countable: false, needs_promise_catalog: false },
  promises_rate: { unit: 'rate', better: 'higher', group: 'outcomes', min_gap: 0.05, min_denominator: AGENCY_ROSTER_MIN_RATE_DENOMINATOR, countable: true, needs_promise_catalog: true },
  promised_amount: { unit: 'amount', better: 'neutral', group: 'outcomes', min_gap: null, min_denominator: null, countable: false, needs_promise_catalog: true },
  callbacks_booked: { unit: 'count', better: 'neutral', group: 'outcomes', min_gap: null, min_denominator: null, countable: false, needs_promise_catalog: false },
  callbacks_kept_rate: { unit: 'rate', better: 'higher', group: 'outcomes', min_gap: 0.12, min_denominator: COMPARE_CALLBACKS_MIN_DENOMINATOR, countable: false, needs_promise_catalog: false },
  avg_call: { unit: 'seconds', better: 'neutral', group: 'handling', min_gap: null, min_denominator: AGENCY_ROSTER_MIN_RATE_DENOMINATOR, countable: false, needs_promise_catalog: false },
  choose_time: { unit: 'seconds', better: 'lower', group: 'handling', min_gap: null, min_denominator: COMPARE_TIME_MIN_CALLS, countable: false, needs_promise_catalog: false },
  no_outcome_rate: { unit: 'rate', better: 'lower', group: 'handling', min_gap: 0.04, min_denominator: AGENCY_ROSTER_MIN_RATE_DENOMINATOR, countable: false, needs_promise_catalog: false },
  breaks_over_limit: { unit: 'count', better: 'lower', group: 'time_use', min_gap: null, min_denominator: null, countable: false, needs_promise_catalog: false },
} satisfies Record<CompareBuiltinMetricKey, CompareMetricDefinition>);

/**
 * The definition every outcome set shares, apart from `better`, which the supervisor chooses
 * (CP17, CP18): numerator = the agent's dialler conversations on the campaign whose outcome code is
 * in the set; denominator = the agent's dialler conversations on the campaign (both from
 * `agency_insights_rollup_codes`, summed over the agent's rows in the window). Floor on the
 * denominator: the roster's, `AGENCY_ROSTER_MIN_RATE_DENOMINATOR` (20). Countable: the trend counts the
 * conversations ending in the set per local day.
 */
export const COMPARE_OUTCOME_SET_DEFINITION: Readonly<Omit<CompareMetricDefinition, 'better'>> = Object.freeze({
  unit: 'rate',
  group: 'outcomes',
  min_gap: 0.05,
  min_denominator: AGENCY_ROSTER_MIN_RATE_DENOMINATOR,
  countable: true,
  needs_promise_catalog: false,
} satisfies Omit<CompareMetricDefinition, 'better'>);

// ─────────────────────────────────────────────────────────────────────────────
// Metric references and their ids
// ─────────────────────────────────────────────────────────────────────────────

/** A built-in metric. */
export interface AgencyCompareBuiltinRef {
  kind: 'builtin';
  key: CompareBuiltinMetricKey;
}

/**
 * An outcome set (CP17): the share of the agent's conversations ending in ANY of `codes`, outcome
 * codes of the campaign's current `disposition_catalog`, chosen by the supervisor.
 *
 * `codes`: 1 to {@link COMPARE_OUTCOME_SET_MAX_CODES}, distinct, each matching
 * {@link COMPARE_OUTCOME_CODE_PATTERN}; order does not matter (the id sorts them).
 * `better`: the supervisor's choice (CP18); the picker starts from {@link defaultOutcomeSetBetter}.
 * A `neutral` set is shown and never named; a directional one is judged like any rate.
 * `label`: the supervisor's name for it, 1 to {@link COMPARE_OUTCOME_LABEL_MAX} characters,
 * trimmed; absent means the codes' catalog labels joined ({@link defaultOutcomeSetLabel}). The
 * label is display only: it is not part of the id.
 */
export interface AgencyCompareOutcomeSetRef {
  kind: 'outcomes';
  codes: string[];
  better: CompareMetricBetter;
  label?: string;
}

/** What the request, a saved view and the response name a metric by. */
export type AgencyCompareMetricRef = AgencyCompareBuiltinRef | AgencyCompareOutcomeSetRef;

/** The prefix of an outcome set's id. A built-in key never contains `:`. */
export const COMPARE_OUTCOME_SET_ID_PREFIX = 'outcomes';

/**
 * The canonical id of a metric: the built-in key itself (`success_rate`), or for an outcome set
 * `outcomes:<better>:<code>,<code>…` with the codes sorted and deduplicated
 * (`outcomes:higher:part_paid,will_pay`). Two refs that mean the same metric have the same id
 * whatever their code order or label, so the id keys the response's maps, the server's cache and
 * the page's URL. Every character is URL-safe in a query value once encoded (`:` and `,`).
 */
export function compareMetricId(ref: AgencyCompareMetricRef): string {
  if (ref.kind === 'builtin') return ref.key;
  const codes = [...new Set(ref.codes)].sort();
  return `${COMPARE_OUTCOME_SET_ID_PREFIX}:${ref.better}:${codes.join(',')}`;
}

/**
 * The ref an id names, or null when the id is not one {@link compareMetricId} can produce for a
 * valid ref (an unknown key, a bad direction, an empty, oversized, unsorted or duplicated code
 * list, a malformed code). The parsed outcome set has no `label`.
 */
export function parseCompareMetricId(id: string): AgencyCompareMetricRef | null {
  if ((COMPARE_BUILTIN_METRIC_KEYS as readonly string[]).includes(id)) {
    return { kind: 'builtin', key: id as CompareBuiltinMetricKey };
  }
  const parts = id.split(':');
  if (parts.length !== 3 || parts[0] !== COMPARE_OUTCOME_SET_ID_PREFIX) return null;
  const better = parts[1] as CompareMetricBetter;
  if (!(COMPARE_METRIC_BETTER as readonly string[]).includes(better)) return null;
  const codes = (parts[2] as string).split(',');
  const ref: AgencyCompareOutcomeSetRef = { kind: 'outcomes', codes, better };
  if (compareMetricRefProblem(ref) !== null) return null;
  // Canonical only: sorted (and, through the validator, distinct), so an id round-trips.
  return compareMetricId(ref) === id ? ref : null;
}

/** Why a metric ref is malformed, before any catalog is consulted. */
export type CompareMetricRefProblem =
  | 'kind_invalid'
  | 'key_unknown'
  | 'codes_empty'
  | 'codes_too_many'
  | 'codes_duplicate'
  | 'code_malformed'
  | 'better_invalid'
  | 'label_invalid';
export const COMPARE_METRIC_REF_PROBLEMS = [
  'kind_invalid',
  'key_unknown',
  'codes_empty',
  'codes_too_many',
  'codes_duplicate',
  'code_malformed',
  'better_invalid',
  'label_invalid',
] as const satisfies readonly CompareMetricRefProblem[];

/**
 * The shape rule for one ref (null when it holds), shared by the console's picker and the server's
 * validation (which answers any problem `compare_metric_invalid`, or `compare_view_invalid` on a
 * view). Takes `unknown` fields so the server can run it on a parsed body. It does NOT check the
 * codes against a catalog: see `resolveCompareMetric` in `@magick-agency/domain/agent-compare`.
 */
export function compareMetricRefProblem(ref: AgencyCompareMetricRef): CompareMetricRefProblem | null {
  const r = ref as { kind?: unknown; key?: unknown; codes?: unknown; better?: unknown; label?: unknown };
  if (r.kind === 'builtin') {
    return typeof r.key === 'string' && (COMPARE_BUILTIN_METRIC_KEYS as readonly string[]).includes(r.key) ? null : 'key_unknown';
  }
  if (r.kind !== 'outcomes') return 'kind_invalid';
  if (!Array.isArray(r.codes) || r.codes.length === 0) return 'codes_empty';
  if (r.codes.length > COMPARE_OUTCOME_SET_MAX_CODES) return 'codes_too_many';
  for (const code of r.codes) {
    if (typeof code !== 'string' || !COMPARE_OUTCOME_CODE_PATTERN.test(code)) return 'code_malformed';
  }
  if (new Set(r.codes).size !== r.codes.length) return 'codes_duplicate';
  if (typeof r.better !== 'string' || !(COMPARE_METRIC_BETTER as readonly string[]).includes(r.better)) return 'better_invalid';
  if (r.label !== undefined) {
    if (typeof r.label !== 'string') return 'label_invalid';
    const trimmed = r.label.trim();
    if (trimmed.length === 0 || trimmed.length > COMPARE_OUTCOME_LABEL_MAX || trimmed !== r.label) return 'label_invalid';
  }
  return null;
}

/** One entry of a campaign's outcome catalog as the compare page reads it. */
export interface AgencyCompareOutcomeCode {
  code: string;
  label: string;
  /** The catalog entry's `is_success` (false when absent). */
  is_success: boolean;
  /** The catalog entry's `requires_promise` (false when absent). */
  requires_promise: boolean;
}

/**
 * The direction an outcome set starts with in the picker (CP18): `higher` when every chosen code
 * is a success code of the catalog, else `neutral`. The catalog has no refusal category, so
 * `lower` is never inferred: only the supervisor sets it. A code missing from `catalog` counts as
 * not a success.
 */
export function defaultOutcomeSetBetter(codes: readonly string[], catalog: readonly AgencyCompareOutcomeCode[]): CompareMetricBetter {
  if (codes.length === 0) return 'neutral';
  const success = new Set(catalog.filter((c) => c.is_success).map((c) => c.code));
  return codes.every((code) => success.has(code)) ? 'higher' : 'neutral';
}

/**
 * The label an outcome set shows when the supervisor gave none: the codes' catalog labels in the
 * order given, joined "A, B or C" (a code missing from the catalog shows as itself). Console copy
 * (AS15), computed the same way on the server so the response's `label` agrees with the picker.
 */
export function defaultOutcomeSetLabel(codes: readonly string[], catalog: readonly AgencyCompareOutcomeCode[]): string {
  const byCode = new Map(catalog.map((c) => [c.code, c.label] as const));
  const labels = codes.map((code) => byCode.get(code) ?? code);
  if (labels.length <= 1) return labels[0] ?? '';
  return `${labels.slice(0, -1).join(', ')} or ${labels[labels.length - 1]}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /proxy/agency/compare/query
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `POST /proxy/agency/compare/query` body. A POST because the metric refs are structured; it
 * changes nothing. Refusals, in the order the server checks them:
 * - `compare_campaign_required` (no `campaign_id`), `compare_campaign_not_found` (not a campaign of
 *   the context account);
 * - `compare_too_many_agents` (more than {@link COMPARE_PAGE_MAX_AGENTS});
 * - `compare_too_many_metrics` (more than {@link COMPARE_MAX_METRICS});
 * - `compare_metric_invalid`: a ref fails {@link compareMetricRefProblem}; two refs with one id; an
 *   outcome code not in the campaign's CURRENT catalog; a `needs_promise_catalog` metric on a
 *   campaign whose catalog has no `requires_promise` entry; a `trend` that is not `countable`;
 * - `compare_timezone_invalid` (not an IANA zone the server knows), `compare_window_invalid`
 *   ({@link compareWindowProblem});
 * - `compare_agent_not_in_cohort` (a picked agent has no row in the cohort);
 * - `compare_busy` (429), `compare_timed_out` (503).
 */
export interface AgencyCompareQuery {
  /** The one campaign compared (CP8). */
  campaign_id: string;
  /** 1 to {@link COMPARE_PAGE_MAX_AGENTS} distinct user ids, in the page's order (colours follow it). */
  agent_ids: string[];
  /** 1 to {@link COMPARE_MAX_METRICS} refs with distinct ids, in the page's order. */
  metrics: AgencyCompareMetricRef[];
  /**
   * The per-day series' metric: an outcome set or `promises_rate` (a `countable` metric). It need
   * not be among `metrics`. Absent or null: no `trend` in the answer.
   */
  trend?: AgencyCompareMetricRef | null;
  /** `YYYY-MM-DD`, the first local day. */
  from: string;
  /** `YYYY-MM-DD`, the last local day (inclusive), not after today in `timezone`. */
  to: string;
  /** IANA zone the days are cut in (the console sends the browser's). */
  timezone: string;
}

/** One agent's figure for one metric. Every figure travels with its counts (CP9). */
export interface AgencyCompareValue {
  /**
   * The figure in the metric's unit (a rate as a fraction). Null when the denominator is zero
   * (never 0, `ratePct`'s rule). Served under the floor too: `reportable` says whether to draw it.
   */
  value: number | null;
  /** `count` / `amount`: the figure itself; `rate`: the hits; `seconds`: total seconds; `per_hour`: calls. */
  numerator: number;
  /** `rate`: calls counted; `seconds`: calls averaged over; `per_hour`: logged-in seconds; null for `count` and `amount`. */
  denominator: number | null;
  /**
   * The value clears the metric's floor (`denominator >= min_denominator`; true when the metric
   * has none and `value` is non-null). A value that is not reportable is drawn as words ("Too few
   * to compare (12 calls; needs 20)"), never a bar, and is in no percentile pool.
   */
  reportable: boolean;
  /** `rate` only: the 95% Wilson score interval `[low, high]` (fractions); null otherwise or on a zero denominator. */
  interval: [number, number] | null;
}

/**
 * The cohort's figures for one metric. Percentiles are `percentile_cont` (linear interpolation)
 * over the REPORTABLE, non-null values of every cohort agent, picked agents included: the roster
 * benchmark's method (`cohortPercentiles` in `@magick-agency/domain/agent-compare`, which the
 * roster's `rosterPercentiles` delegates to). All three null when no agent qualifies.
 */
export interface AgencyCompareCohortMetric {
  p25: number | null;
  median: number | null;
  p75: number | null;
  /**
   * The cohort's own figure, from the sums over EVERY cohort agent, thin ones included (a ratio of
   * two sums, as the roster's pooled rates): `rate` sum of hits / sum of calls, `seconds` total
   * seconds / total calls, `per_hour` total calls per total logged-in hour. Null for `count` and
   * `amount` metrics, and on a zero denominator.
   */
  pooled: number | null;
  /** Cohort agents with a reportable value on this metric. Under {@link COMPARE_MIN_RATED_COHORT}: no finding on it. */
  agents_rated: number;
}

/**
 * One finding (or one `not_clear` entry). Codes and numbers only; the console writes the words.
 *
 * | `code` | `value` | `baseline` | `interval` | `ratio` | `count` |
 * |---|---|---|---|---|---|
 * | `clear_gap`, `stands_out` on a rate | the agent's rate | the rest of the cohort's pooled rate (agent left out) | the agent's Wilson interval | null | the agent's denominator |
 * | `clear_gap` on `choose_time` | the agent's seconds | the cohort median (agent included) | null | value / baseline | measured wrap-ups |
 * | `over_break_limit` | breaks over their limit | null | null | null | null |
 * | `too_few_calls` | the agent's denominator on `metric` | that metric's `min_denominator` | null | null | the agent's denominator |
 *
 * In `not_clear`, `code` is always `clear_gap` (the finding the gap would be) and `next_step` is
 * null: the console offers "Check a longer window".
 */
export interface AgencyCompareFinding {
  code: CompareFindingCode;
  agent_user_id: string;
  /** The metric's id ({@link compareMetricId}). For `too_few_calls`, the first flaggable metric on screen the agent is under the floor of. */
  metric: string;
  value: number;
  baseline: number | null;
  interval: [number, number] | null;
  ratio: number | null;
  count: number | null;
  next_step: CompareNextStep | null;
}

/** A metric of the answer as resolved against the campaign: what the console needs to draw and label it. */
export interface AgencyCompareMetricInfo {
  /** {@link compareMetricId} of `ref`. */
  id: string;
  /** The ref as requested (an outcome set's codes in the order sent, its label if sent). */
  ref: AgencyCompareMetricRef;
  /**
   * An outcome set's label: the supervisor's, else {@link defaultOutcomeSetLabel} over the current
   * catalog. Null for a built-in: the console has its own words for each key.
   */
  label: string | null;
  /** The metric's definition, with an outcome set's chosen `better` filled in. */
  definition: CompareMetricDefinition;
  /**
   * Can yield a finding: `better` is not neutral (CP10). Outcome sets and `promises_rate` count
   * as outcome rates for `stands_out`.
   */
  flaggable: boolean;
}

/**
 * Where a picked agent's logged-in time went (CP5: the shift includes breaks), in whole seconds,
 * from the agent review's presence fold (`reports/datasets/agent-presence.ts`) scoped to the
 * campaign. `waiting` is available plus reserved (drawn grey, never flagged).
 */
export interface AgencyCompareDaySplit {
  on_call: number;
  /** In wrap-up, choosing the outcome. */
  choosing: number;
  break: number;
  waiting: number;
  /** The sum of the four: the logged-in time, `calls_per_hour`'s denominator. */
  shift_seconds: number;
}

/** One picked agent's column. */
export interface AgencyCompareAgent {
  agent_user_id: string;
  /** Null when the user no longer resolves. */
  agent_name: string | null;
  /** Keyed by every metric id of the request, never fewer. */
  values: Record<string, AgencyCompareValue>;
  day_split: AgencyCompareDaySplit;
}

/**
 * The per-day series (§2 item 5): the trend metric's numerator per local day of the window
 * (conversations ending in the outcome set, or promises recorded, by the call's local day).
 */
export interface AgencyCompareTrend {
  /** The trend metric's id; {@link AgencyCompareResponse.trend_metric} describes it. */
  metric: string;
  /** Every local date of the window, `YYYY-MM-DD`, in order. */
  dates: string[];
  /**
   * One series per picked agent, in `agent_ids` order, each `dates.length` long: the count on a
   * local day the agent had logged-in time on the campaign (0 is a real zero), null on any other
   * day (before their first session, and days off), so the line breaks rather than dips.
   */
  agents: Array<{ agent_user_id: string; counts: Array<number | null> }>;
  /** Per date, the median count over the cohort agents with logged-in time on the campaign that day; null when none. */
  cohort_median: Array<number | null>;
}

/** `POST /proxy/agency/compare/query` 200. */
export interface AgencyCompareResponse {
  campaign_id: string;
  from: string;
  to: string;
  timezone: string;
  /** When the figures were read (ISO instant). Outcome sets and `no_outcome_rate` come from the Insights rollup, which can trail it by its refresh. */
  as_of: string;
  /** The request's metrics, resolved, in request order. */
  metrics: AgencyCompareMetricInfo[];
  /** The trend's metric, resolved; null when no trend was asked for. */
  trend_metric: AgencyCompareMetricInfo | null;
  /** The picked agents, in `agent_ids` order. */
  agents: AgencyCompareAgent[];
  cohort: {
    /** Every agent of the cohort (the roster's rows for the campaign and window), picked ones included. */
    agents: number;
    /** Keyed by every metric id of the request. */
    per_metric: Record<string, AgencyCompareCohortMetric>;
  };
  /** At most {@link COMPARE_FINDINGS_MAX}, at most {@link COMPARE_FINDINGS_PER_AGENT} per agent, in the order §6 sets. */
  findings: AgencyCompareFinding[];
  /** Worse-side gaps that could still be chance (§6). Never holds what overflowed `findings`. */
  not_clear: AgencyCompareFinding[];
  /** Null when the request had no `trend`. */
  trend: AgencyCompareTrend | null;
}

/**
 * The compare window rule: the reports' rule (RP2) answered with the compare code. Null when
 * acceptable, else `compare_window_invalid` (a malformed date, `to` before `from`, `to` after
 * `today` when given, or longer than the reports allow).
 */
export function compareWindowProblem(from: string, to: string, today?: string): Extract<AgencyCompareErrorCode, 'compare_window_invalid'> | null {
  return reportWindowProblem(from, to, today) === null ? null : 'compare_window_invalid';
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /proxy/agency/compare/options
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `GET /proxy/agency/compare/options?campaign_id=&from=&to=&timezone=`: what the filters and the
 * agent chips need. Refusals: `compare_campaign_required`, `compare_campaign_not_found`,
 * `compare_timezone_invalid`, `compare_window_invalid`, `compare_busy`, `compare_timed_out`.
 */
export interface AgencyCompareOptionsQuery {
  campaign_id: string;
  from: string;
  to: string;
  timezone: string;
}

/** One agent of the cohort, for the chips. */
export interface AgencyCompareCohortAgent {
  agent_user_id: string;
  /** Null when the user no longer resolves. */
  name: string | null;
  /** Conversations on the campaign in the window (the roster's `connected`). */
  calls: number;
  /** `calls >= AGENCY_ROSTER_MIN_RATE_DENOMINATOR` (`success_rate_reportable`); false shows "few calls". */
  reportable: boolean;
  /** The membership is active now (a revoked agent is still in the cohort, CP8, and shown as such). */
  active: boolean;
}

/** `GET /proxy/agency/compare/options` 200. */
export interface AgencyCompareOptions {
  campaign_id: string;
  campaign_name: string;
  /** The cohort, most calls first, then name, then id. */
  agents: AgencyCompareCohortAgent[];
  /** The campaign's CURRENT catalog, in catalog order: the codes an outcome set may name. */
  outcome_codes: AgencyCompareOutcomeCode[];
  /** The catalog has a `requires_promise` entry: `promises_rate` and `promised_amount` are offered. */
  records_promises: boolean;
  /** `compareStartingLens` over the catalog: `collections` when it records promises, else `sales`. */
  starting_lens: CompareLens;
  /** The campaign's default view ({@link AgencyCompareView.is_campaign_default}); null when none. */
  default_view: AgencyCompareView | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Saved views: /proxy/agency/compare/views*
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A saved comparison set-up (lens, metrics, trend), personal or shared with the account's
 * supervisors, optionally tied to a campaign and optionally that campaign's default. A view never
 * names agents or a window: those stay in the page's URL.
 *
 * Only the owner edits or deletes a view (another supervisor's gets `404 compare_view_not_found`,
 * uniform, as for a view they cannot see). A view's outcome sets name codes of its campaign's
 * catalog AS SAVED; a code since removed from the catalog (or, on a view with no campaign, a code
 * the campaign being compared does not have) makes the query refuse `compare_metric_invalid`, so
 * the console drops such a metric when it applies the view, and says so, rather than sending it.
 */
export interface AgencyCompareView {
  id: string;
  /** 1 to {@link COMPARE_VIEW_NAME_MAX} characters, trimmed. Not unique. */
  name: string;
  lens: CompareLens;
  /** 1 to {@link COMPARE_MAX_METRICS} refs with distinct ids. */
  metrics: AgencyCompareMetricRef[];
  /** A `countable` ref, or null. */
  trend: AgencyCompareMetricRef | null;
  /** The campaign it was made for; null for a view usable on any campaign. */
  campaign_id: string | null;
  /** Visible to every supervisor of the account (read-only to them). */
  shared: boolean;
  /**
   * The campaign's default view: the page opens a campaign on it. At most one per campaign; it
   * needs `campaign_id` and `shared`. Setting it on one view clears it on the campaign's other
   * view, whoever owns that one.
   */
  is_campaign_default: boolean;
  owner: { user_id: string; name: string | null };
  created_at: string;
  updated_at: string;
}

/**
 * `GET /proxy/agency/compare/views?campaign_id=`: the caller's own views and the account's shared
 * ones. With `campaign_id`, only views for that campaign and views with no campaign. Order: the
 * campaign's default first, then the caller's own, then the rest, each newest `updated_at` first.
 * Refusals: `compare_campaign_not_found` (a `campaign_id` not of the account).
 */
export interface AgencyCompareViewListQuery {
  campaign_id?: string;
}

/** `GET /proxy/agency/compare/views` 200. */
export interface AgencyCompareViewList {
  views: AgencyCompareView[];
}

/**
 * `POST /proxy/agency/compare/views`: 201 with the {@link AgencyCompareView}. Refusals:
 * `compare_view_invalid` (a name empty or too long after trimming; no metrics or more than
 * {@link COMPARE_MAX_METRICS}; a ref failing {@link compareMetricRefProblem} or two with one id; a
 * trend that is not `countable`; with `campaign_id`, an outcome code not in its current catalog or
 * a `needs_promise_catalog` metric on a catalog without promises; `is_campaign_default` without
 * `campaign_id` or without `shared`), `compare_campaign_not_found`, `compare_view_limit` (the
 * caller already owns {@link COMPARE_VIEWS_PER_USER_MAX} views in the account).
 */
export interface AgencyCreateCompareViewRequest {
  name: string;
  lens: CompareLens;
  metrics: AgencyCompareMetricRef[];
  /** Default null. */
  trend?: AgencyCompareMetricRef | null;
  /** Default null. */
  campaign_id?: string | null;
  /** Default false. */
  shared?: boolean;
  /** Default false. */
  is_campaign_default?: boolean;
}

/**
 * `PATCH /proxy/agency/compare/views/:id`: any subset of the create fields, validated as the
 * resulting view; 200 with the view. `DELETE` on the same path: 204. Refusals as create, plus
 * `compare_view_not_found` (no such view in the account, or not the caller's).
 */
export type AgencyUpdateCompareViewRequest = Partial<AgencyCreateCompareViewRequest>;

// ─────────────────────────────────────────────────────────────────────────────
// Refusal body
// ─────────────────────────────────────────────────────────────────────────────

/** The body of every compare refusal. `message` is English fallback copy; the console keys off `code`. */
export interface AgencyCompareErrorResponse {
  error: string;
  code: AgencyCompareErrorCode;
  message: string;
  /**
   * `compare_busy` only: seconds to wait before trying again ({@link COMPARE_BUSY_RETRY_AFTER_SECONDS}),
   * the same as the `Retry-After` header. Absent on every other refusal.
   */
  retry_after_seconds?: number;
}

const _lensesListed: AllListed<CompareLens, typeof COMPARE_LENSES> = true;
const _keysListed: AllListed<CompareBuiltinMetricKey, typeof COMPARE_BUILTIN_METRIC_KEYS> = true;
const _unitsListed: AllListed<CompareMetricUnit, typeof COMPARE_METRIC_UNITS> = true;
const _betterListed: AllListed<CompareMetricBetter, typeof COMPARE_METRIC_BETTER> = true;
const _groupsListed: AllListed<CompareMetricGroup, typeof COMPARE_METRIC_GROUPS> = true;
const _findingsListed: AllListed<CompareFindingCode, typeof COMPARE_FINDING_CODES> = true;
const _stepsListed: AllListed<CompareNextStep, typeof COMPARE_NEXT_STEPS> = true;
const _problemsListed: AllListed<CompareMetricRefProblem, typeof COMPARE_METRIC_REF_PROBLEMS> = true;
void [_lensesListed, _keysListed, _unitsListed, _betterListed, _groupsListed, _findingsListed, _stepsListed, _problemsListed];
