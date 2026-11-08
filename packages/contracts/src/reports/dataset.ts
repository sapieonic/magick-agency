/**
 * The report DATASET: everything a renderer needs to draw one report, assembled by the server
 * (RP1) and handed to the renderer as `dataset.json` plus gzipped NDJSON detail files. The
 * renderer reads nothing else: no database, no API, no clock but `generated_at`.
 *
 * ── Rules every dataset follows ─────────────────────────────────────────────
 * - **One opinion per number.** A block that a console screen already serves is that screen's
 *   wire object, reused verbatim (`AgencyInsightsSummary`, `…Activity`, `…Trends`, `…Health`,
 *   the roster row and benchmark, the agent record totals), filled by the same server read.
 *   A report figure therefore equals the screen figure for the same window, and the server's oracle
 *   tests (`report-datasets-oracle.test.ts`) hold them equal.
 * - **Blocks the screens do not serve** (the agent's day-by-day presence, the timeline, the
 *   account's per-campaign rows) carry their COUNTS, and where a rate is carried it says its
 *   numerator and denominator and is `null`, never 0, on a zero denominator. A renderer that
 *   needs a rate of summed rows recomputes it from summed counts, never by averaging rates.
 * - **Rate floors are served, not assumed (RP9):** each dataset's `floors` says the minimum
 *   denominator below which a rate renders as words ("Not enough calls"), as its source applies it.
 * - **Time:** instants are ISO-8601 UTC strings; dates are `YYYY-MM-DD` in `range.timezone`.
 *   Durations are whole seconds unless the field says otherwise.
 * - Copy (`label`, `text`, `notes`) is British English and final: the renderer prints it as is.
 */
import type { AgencyRosterBenchmark } from '../api/agency/agency-stats';
import type { ReportAudience, ReportKind } from '../api/agency/reports';

/**
 * The dataset format version. The renderer refuses any other with
 * `dataset_version_unsupported`. Bump it on any change a renderer of the previous version
 * would draw wrongly (a renamed or re-meant field); an additive optional field does not bump it.
 */
export const REPORT_DATASET_VERSION = 1;

/** The window a dataset covers. */
export interface ReportRange {
  /** `YYYY-MM-DD`, first local day (inclusive). */
  from: string;
  /** `YYYY-MM-DD`, last local day (inclusive). */
  to: string;
  /** IANA zone the days are cut in (RP3). */
  timezone: string;
  /** Local calendar days from `from` to `to` inclusive: the length of every `daily` array. */
  days: number;
  /** ISO instant of local midnight starting `from`: the read window's inclusive start. */
  start: string;
  /** ISO instant of local midnight after `to`: the read window's EXCLUSIVE end. */
  end: string;
}

/** One entry of the definitions page: what a figure means, in words. */
export interface ReportDefinition {
  /** Stable identifier, e.g. `connect_rate`, `occupancy`. Not copy. */
  key: string;
  /** The figure's name as printed, e.g. "Connect rate". */
  label: string;
  /** One or two sentences: numerator, denominator and any floor. */
  text: string;
}

/** A detail sheet's cell type: how the workbook formats the column. */
export type ReportDetailColumnType =
  | 'text'
  | 'int'
  | 'number'
  | 'percent'
  | 'duration_s'
  | 'datetime'
  | 'date'
  | 'bool';
export const REPORT_DETAIL_COLUMN_TYPES = [
  'text',
  'int',
  'number',
  'percent',
  'duration_s',
  'datetime',
  'date',
  'bool',
] as const satisfies readonly ReportDetailColumnType[];

/**
 * One column of a detail sheet. Cell values by type: `text` string; `int`, `number` number;
 * `percent` a number 0–100 (not a fraction); `duration_s` whole seconds; `datetime` an ISO
 * instant (the workbook shows it in `range.timezone`); `date` `YYYY-MM-DD`; `bool` boolean.
 * Any cell may be `null` (empty).
 */
export interface ReportDetailColumn {
  /** Stable identifier, e.g. `dialed_at`. */
  key: string;
  /** The header as printed. */
  label: string;
  type: ReportDetailColumnType;
}

/**
 * The row-level sheets a report can carry.
 * - `sessions`: one row per agent session (campaign or soft phone) that overlaps the window.
 * - `state_log`: one row per agent state interval (from the session event log), clipped to the window.
 * - `calls`: one row per call the agent was on: campaign attempts reserved to them and soft-phone calls.
 * - `attempts`: one row per placed dial of the campaign(s) in the window.
 */
export type ReportDetailSheet = 'sessions' | 'state_log' | 'calls' | 'attempts';
export const REPORT_DETAIL_SHEETS = ['sessions', 'state_log', 'calls', 'attempts'] as const satisfies readonly ReportDetailSheet[];

/** Which sheets each kind carries, in workbook order. A dataset carries exactly these. */
export const REPORT_DETAIL_SHEETS_BY_KIND: Readonly<Record<ReportKind, readonly ReportDetailSheet[]>> = Object.freeze({
  agent: ['sessions', 'state_log', 'calls'],
  campaign: ['attempts', 'sessions'],
  account: ['attempts'],
});

/**
 * One detail file: gzipped NDJSON in the dataset's bucket, one JSON ARRAY of cell values per
 * line, in `columns` order. No header line (the header is `columns`). Rows are in time order.
 * Audience rules apply to the columns themselves (RP5, RP7): a `self` file has no recording
 * column and its phone numbers are masked to the last four digits.
 */
export interface ReportDetailFile {
  sheet: ReportDetailSheet;
  /** The sheet's tab name as printed, e.g. "Calls". At most 31 characters (an Excel limit). */
  label: string;
  /** The object key in the dataset's bucket (`…/details-<sheet>.ndjson.gz`). */
  key: string;
  /** Data lines in the file. */
  rows: number;
  /**
   * The sheet stopped at `AGENCY_REPORTS_MAX_DETAIL_ROWS` rows (RP12); the renderer writes a
   * first row saying so. `rows` is then the cap, not the total.
   */
  truncated: boolean;
  columns: ReportDetailColumn[];
}

/**
 * A roster cohort to compare against: the agent review's (supervisor audience only, RP5) and the
 * account report's. Bands use the roster's floor (`floors.agent_rate_min_first_dials`).
 */
export interface ReportRosterBenchmark {
  /** The account roster read's `benchmark` for the window, verbatim. */
  cohort: AgencyRosterBenchmark;
  /**
   * Agents whose rates entered the percentile bands (`cohort.agents_rated`), printed as
   * "compared with N agents". When it is 0 every band is null and the report says so.
   */
  pool_size: number;
}

/** What every dataset carries, whatever its kind. */
export interface ReportDatasetBase {
  dataset_version: typeof REPORT_DATASET_VERSION;
  run_id: string;
  kind: ReportKind;
  audience: ReportAudience;
  /** When assembly read its data: the "as of" printed on the report. */
  generated_at: string;
  range: ReportRange;
  tenant: { id: string; name: string };
  /** The account the run belongs to; null only for a run not scoped to one account (none in v1). */
  account: { id: string; name: string } | null;
  /**
   * The subject: the agent (user id), the campaign or the account. `name` is the display name,
   * or the id when no name resolves, so it is never empty.
   */
  subject: { id: string; name: string };
  /** The definitions page, in print order: every figure the report shows that needs one. */
  definitions: ReportDefinition[];
  /** Sentences printed under the header: caveats about this run's data (unmeasured days, truncation, clamped sources). */
  notes: string[];
  /** In {@link REPORT_DETAIL_SHEETS_BY_KIND} order for the kind. */
  detail_files: ReportDetailFile[];
}
