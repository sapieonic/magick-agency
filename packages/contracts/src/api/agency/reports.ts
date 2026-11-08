/**
 * Reports: `GET|POST /proxy/agency/reports*` and `/proxy/agency/report-subscriptions*`
 * (docs/reports.md, decisions RP1–RP16).
 *
 * A report is a PDF and/or an Excel workbook about one SUBJECT over one WINDOW, built outside
 * the request: the console asks for a run, polls it until `ready`, then asks for a short-lived
 * download URL per format. Subscriptions turn into runs on a schedule. The dataset a run is
 * rendered from, and the render protocol, are in `../../reports/` (`@magick-agency/contracts/reports`);
 * this file is only what the console sends and reads.
 *
 * ── Rules every shape here follows ──────────────────────────────────────────
 * - **Windows are local calendar DATES, both ends inclusive.** `from` and `to` are `YYYY-MM-DD`
 *   in `timezone`: `from=2026-10-01&to=2026-10-31` is October, 31 days, whatever the zone's clock
 *   changes did. The server turns them into the half-open instant window
 *   `[local midnight of from, local midnight after to)` it reads with (the stored window, capped
 *   by {@link REPORT_MAX_STORED_WINDOW_MS}). A window is at most {@link REPORT_MAX_WINDOW_DAYS}
 *   local days, or exactly one local calendar month (RP2; {@link reportWindowProblem}).
 * - **Zone (RP3):** a `campaign` report is always cut in the campaign's own `default_timezone`
 *   (the request's `timezone` is ignored, and the run echoes the zone used); `agent` and
 *   `account` reports in the IANA zone the request names (the console defaults it to the
 *   browser's).
 * - **Audience (RP5):** `supervisor` for every run a supervisor creates; `self` for an agent's
 *   own review requested without `agency.supervise` (no floor benchmark, no call-analysis
 *   block, no recording column, phone numbers masked to the last four digits, RP7). The server
 *   decides the audience from the caller; the request never names it.
 * - Access: docs/reports.md "Who may run what". Flag `agency_reports_enabled` off: every route
 *   answers `403 feature_disabled`, the dialer gate's body shape.
 * - Refusals are `{ error, code, message }` with `code` an {@link AgencyReportErrorCode}
 *   (`../../errors`). A body that fails schema validation is the server's generic 400.
 * - Wire codes are plain identifiers; console copy is British English.
 */
import { AGENCY_REPORT_ERROR_CODES, type AgencyReportErrorCode } from '../../errors';
import type { AllListed } from '../../primitives';

export { AGENCY_REPORT_ERROR_CODES };
export type { AgencyReportErrorCode };

// ─────────────────────────────────────────────────────────────────────────────
// Vocabularies
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What a report is about. `agent`: one agent's performance review across the account's
 * campaigns. `campaign`: one campaign (the Insights tab's numbers). `account`: every campaign
 * and agent of one account.
 */
export type ReportKind = 'agent' | 'campaign' | 'account';
export const REPORT_KINDS = ['agent', 'campaign', 'account'] as const satisfies readonly ReportKind[];

/** The files a run can produce. */
export type ReportFormat = 'pdf' | 'xlsx';
export const REPORT_FORMATS = ['pdf', 'xlsx'] as const satisfies readonly ReportFormat[];

/** Who the report was built for (RP5). Only an `agent` run can be `self`. */
export type ReportAudience = 'supervisor' | 'self';
export const REPORT_AUDIENCES = ['supervisor', 'self'] as const satisfies readonly ReportAudience[];

/**
 * A run's lifecycle: `queued` → `assembling` (the server builds the dataset) → `rendering`
 * (the renderer builds the files) → `ready` | `failed`; a `ready` run turns `expired` at
 * `expires_at` (RP8). `failed` and `expired` are final. A run that is re-sent to the renderer
 * (RP13) stays `rendering`.
 */
export type ReportRunStatus = 'queued' | 'assembling' | 'rendering' | 'ready' | 'failed' | 'expired';
export const REPORT_RUN_STATUSES = ['queued', 'assembling', 'rendering', 'ready', 'failed', 'expired'] as const satisfies readonly ReportRunStatus[];

/** The statuses that count against `AGENCY_REPORTS_TENANT_PENDING_LIMIT` (still in flight). */
export const REPORT_PENDING_STATUSES = ['queued', 'assembling', 'rendering'] as const satisfies readonly ReportRunStatus[];

/** How often a subscription sends (RP14). */
export type ReportCadence = 'daily' | 'weekly' | 'monthly';
export const REPORT_CADENCES = ['daily', 'weekly', 'monthly'] as const satisfies readonly ReportCadence[];

/**
 * Why a run failed (`AgencyReportRun.error.code`), also the renderer's callback vocabulary
 * (`ReportRenderCallback.error.code`, the subset {@link ReportRendererFailureCode}).
 *
 * - `assembly_failed`: the server could not build the dataset (a read failed).
 * - `subject_unavailable`: the subject is gone or out of reach by assembly time (a campaign
 *   deleted, an agent whose membership was removed for a `self` run).
 * - `dataset_unreadable`: the renderer could not read or parse the dataset or a detail file.
 * - `dataset_version_unsupported`: the dataset's `dataset_version` is not the renderer's.
 * - `render_failed`: building the PDF or the workbook threw.
 * - `upload_failed`: the renderer could not write a file to the bucket.
 * - `render_timed_out`: no callback after `AGENCY_REPORTS_MAX_ATTEMPTS` sends, each given
 *   `AGENCY_REPORTS_RENDER_TIMEOUT_MS` (RP13).
 */
export type ReportFailureCode =
  | 'assembly_failed'
  | 'subject_unavailable'
  | 'dataset_unreadable'
  | 'dataset_version_unsupported'
  | 'render_failed'
  | 'upload_failed'
  | 'render_timed_out';
export const REPORT_FAILURE_CODES = [
  'assembly_failed',
  'subject_unavailable',
  'dataset_unreadable',
  'dataset_version_unsupported',
  'render_failed',
  'upload_failed',
  'render_timed_out',
] as const satisfies readonly ReportFailureCode[];

/** The failure codes the renderer itself may report in its callback. */
export type ReportRendererFailureCode = Extract<
  ReportFailureCode,
  'dataset_unreadable' | 'dataset_version_unsupported' | 'render_failed' | 'upload_failed'
>;

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** The longest window in local calendar days, unless it is exactly one calendar month (RP2). */
export const REPORT_MAX_WINDOW_DAYS = 30;

/**
 * The longest STORED window, `to_instant − from_instant`, in milliseconds: 31 days plus one
 * hour (RP2). A month has at most 31 local days, and the autumn clock change adds an hour to
 * one of them, so October in Europe/London is 31 × 24 + 1 hours long. The database CHECK on
 * `report_runs` holds every row to this; the request rule ({@link reportWindowProblem}) is the
 * tighter, calendar one and always fits inside it.
 */
export const REPORT_MAX_STORED_WINDOW_MS = (31 * 24 + 1) * 60 * 60 * 1000;

/** How long a download URL ({@link AgencyReportDownload.url}) is valid, in seconds. */
export const REPORT_DOWNLOAD_URL_TTL_SECONDS = 300;

/** `GET /proxy/agency/reports` page size when `limit` is absent, and its ceiling. */
export const REPORT_RUN_PAGE_DEFAULT_LIMIT = 25;
export const REPORT_RUN_PAGE_MAX_LIMIT = 100;

/** The most recipients one subscription may name. */
export const REPORT_SUBSCRIPTION_MAX_RECIPIENTS = 20;

/** Each format's `Content-Type`, as the renderer writes it and the download serves it. */
export const REPORT_FORMAT_CONTENT_TYPES = {
  pdf: 'application/pdf',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
} as const satisfies Record<ReportFormat, string>;

// ─────────────────────────────────────────────────────────────────────────────
// Shared parts
// ─────────────────────────────────────────────────────────────────────────────

/** A user with a display name; `name` null when the user no longer resolves. */
export interface AgencyReportUser {
  user_id: string;
  name: string | null;
}

/**
 * What a run or subscription is about: the agent's user id, the campaign id or the account id
 * by `kind`, with its display name (null when it no longer resolves).
 */
export interface AgencyReportSubject {
  id: string;
  name: string | null;
}

/** A run's window as requested: local dates in `timezone`, both inclusive. */
export interface AgencyReportRange {
  /** `YYYY-MM-DD`, the first local day reported. */
  from: string;
  /** `YYYY-MM-DD`, the last local day reported (inclusive). */
  to: string;
  /** The IANA zone the days are cut in (for a campaign run, the campaign's, RP3). */
  timezone: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Runs
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One report run: `GET /proxy/agency/reports/:id`, a row of the history page, and the 202 body
 * of `POST /proxy/agency/reports`.
 */
export interface AgencyReportRun {
  id: string;
  kind: ReportKind;
  subject: AgencyReportSubject;
  /**
   * The account the run belongs to (the request's context account). Null is reserved for a
   * run not scoped to one account; v1 never creates one.
   */
  account_id: string | null;
  range: AgencyReportRange;
  /** The formats asked for, in {@link REPORT_FORMATS} order, never empty. */
  formats: ReportFormat[];
  audience: ReportAudience;
  status: ReportRunStatus;
  /** Who asked; null for a subscription's run. */
  requested_by: AgencyReportUser | null;
  /** The subscription that produced the run; null for an ad hoc run. */
  subscription_id: string | null;
  created_at: string;
  /** When it turned `ready` or `failed`; null before. */
  finished_at: string | null;
  /** When a `ready` run's files stop being downloadable (RP8); null until `ready`. */
  expires_at: string | null;
  /**
   * The files rendered, one per format, `bytes` as stored. Empty until `ready`; kept on an
   * `expired` run as a record (its downloads answer `report_expired`).
   */
  files: Array<{ format: ReportFormat; bytes: number }>;
  /** At least one detail sheet stopped at `AGENCY_REPORTS_MAX_DETAIL_ROWS` rows (RP12). */
  truncated: boolean;
  /** Set on `failed` only. `message` is English fallback copy; the console keys its copy off `code`. */
  error: { code: ReportFailureCode; message: string } | null;
}

/**
 * `POST /proxy/agency/reports`: queue an ad hoc run. 202 with the {@link AgencyReportRun}.
 *
 * Refusals: `report_window_invalid`, `report_window_too_long`, `report_timezone_invalid`,
 * `report_subject_not_found` (also an unknown or foreign id in `campaign_ids`),
 * `report_queue_full` (the tenant has `AGENCY_REPORTS_TENANT_PENDING_LIMIT` runs pending),
 * `report_rate_limited` (`AGENCY_REPORTS_USER_PER_MINUTE`); 403 when the caller may not run this
 * kind on this subject.
 */
export interface AgencyCreateReportRequest {
  kind: ReportKind;
  /** The agent's user id, the campaign id, or the account id (must be the context account). */
  subject_id: string;
  /** `YYYY-MM-DD`, first local day. */
  from: string;
  /** `YYYY-MM-DD`, last local day (inclusive), not after today in the zone. */
  to: string;
  /** IANA zone. Required for `agent` and `account`; ignored for `campaign` (RP3). */
  timezone?: string;
  /** Non-empty, no duplicates. */
  formats: ReportFormat[];
  /**
   * `account` only: the campaigns of the account to cover (default: every campaign of the
   * account with activity in the window). Must be absent for `agent` and `campaign`: the agent
   * review covers the agent's whole account, as the agent record and roster do.
   */
  campaign_ids?: string[];
  /** Email the requester when the run is ready (RP16). Default false. */
  email_me?: boolean;
}

/**
 * `GET /proxy/agency/reports` query. Newest first. A supervisor sees the account's runs; a
 * caller without `agency.supervise` sees only runs they requested.
 */
export interface AgencyReportRunListQuery {
  /** The previous page's `next_cursor`. */
  cursor?: string;
  /** Default {@link REPORT_RUN_PAGE_DEFAULT_LIMIT}, at most {@link REPORT_RUN_PAGE_MAX_LIMIT}. */
  limit?: number;
  kind?: ReportKind;
  subject_id?: string;
  subscription_id?: string;
}

/** One page of runs, newest first. */
export interface AgencyReportRunPage {
  runs: AgencyReportRun[];
  /** Opaque; null on the last page. */
  next_cursor: string | null;
}

/**
 * `GET /proxy/agency/reports/:id/files/:format`: a presigned URL for one file. Refusals:
 * `report_not_found`, `report_not_ready` (queued, assembling, rendering or failed),
 * `report_expired`, `report_format_unavailable` (the run has no file in that format).
 */
export interface AgencyReportDownload {
  /** Valid for {@link REPORT_DOWNLOAD_URL_TTL_SECONDS} seconds. */
  url: string;
  /** The file name the URL's `Content-Disposition` names (`reportFileName` in `../../reports`). */
  filename: string;
  /** When `url` stops working. */
  expires_at: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Subscriptions (supervisors only, RP5; recipients are tenant members, RP4)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A schedule that produces one run per period (RP14), always with the `supervisor` audience,
 * emailed to `recipients` as a console link (RP6).
 *
 * Periods, in `timezone`, for a run due at `send_local_time` on its day:
 * - `daily`: the previous local day;
 * - `weekly` (sent on `send_weekday`): the seven local days ending the day before;
 * - `monthly` (sent on `send_monthday`): the previous local calendar month.
 *
 * One run per `(subscription_id, period_start)`; after downtime only the most recent missed
 * period is sent. For a `campaign` subscription `timezone` is the campaign's (RP3).
 */
export interface AgencyReportSubscription {
  id: string;
  kind: ReportKind;
  subject: AgencyReportSubject;
  /** As on {@link AgencyReportRun.account_id}. */
  account_id: string | null;
  cadence: ReportCadence;
  /** `HH:MM`, 24-hour, local to `timezone`. */
  send_local_time: string;
  /** ISO weekday, Monday 1 … Sunday 7; set for `weekly` only, else null. */
  send_weekday: number | null;
  /** 1–28; set for `monthly` only, else null. */
  send_monthday: number | null;
  timezone: string;
  formats: ReportFormat[];
  recipients: AgencyReportUser[];
  enabled: boolean;
  /** The next send; null while disabled. */
  next_run_at: string | null;
  /** The newest run it produced; null before the first. `period_start` is `YYYY-MM-DD`. */
  last_run: { id: string; status: ReportRunStatus; period_start: string } | null;
  created_by: AgencyReportUser;
  created_at: string;
}

/** `GET /proxy/agency/report-subscriptions`: the account's subscriptions, newest first. */
export interface AgencyReportSubscriptionList {
  subscriptions: AgencyReportSubscription[];
}

/**
 * `POST /proxy/agency/report-subscriptions`. 201 with the {@link AgencyReportSubscription}.
 *
 * Refusals: `report_subscription_invalid` (a day field missing for its cadence or set for
 * another, a bad `send_local_time`), `report_timezone_invalid`, `report_subject_not_found`,
 * `report_recipient_invalid` (not a member of the tenant with `agency.supervise` on the account,
 * or more than {@link REPORT_SUBSCRIPTION_MAX_RECIPIENTS}).
 */
export interface AgencyCreateReportSubscriptionRequest {
  kind: ReportKind;
  subject_id: string;
  cadence: ReportCadence;
  send_local_time: string;
  /** Required for `weekly`, absent or null otherwise. */
  send_weekday?: number | null;
  /** Required for `monthly`, absent or null otherwise. */
  send_monthday?: number | null;
  /** IANA zone. Required for `agent` and `account`; ignored for `campaign` (RP3). */
  timezone?: string;
  formats: ReportFormat[];
  /** Non-empty, distinct user ids. */
  recipient_user_ids: string[];
  /** Default true. */
  enabled?: boolean;
}

/**
 * `PATCH /proxy/agency/report-subscriptions/:id`: any subset; `kind` and `subject` never change.
 * The day fields are validated against the resulting cadence. `DELETE` on the same path removes
 * it (runs it produced are kept). Refusals as create, plus `report_subscription_not_found`.
 */
export type AgencyUpdateReportSubscriptionRequest = Partial<
  Omit<AgencyCreateReportSubscriptionRequest, 'kind' | 'subject_id'>
>;

// ─────────────────────────────────────────────────────────────────────────────
// The window rule (RP2), shared by the console form and the server
// ─────────────────────────────────────────────────────────────────────────────

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Days since the epoch of a valid `YYYY-MM-DD`, else null. Calendar arithmetic only: no zone. */
function epochDay(date: string): number | null {
  const m = DATE_RE.exec(date);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const ms = Date.UTC(y, mo - 1, d);
  const back = new Date(ms);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null;
  return ms / 86_400_000;
}

/** Local calendar days in an inclusive `from`–`to` window, or null when either date is malformed. */
export function reportWindowDays(from: string, to: string): number | null {
  const a = epochDay(from);
  const b = epochDay(to);
  return a === null || b === null ? null : b - a + 1;
}

/**
 * The request window rule (RP2): null when `from`–`to` is acceptable, else the refusal code.
 * `report_window_invalid`: a malformed date, `to` before `from`, or `to` after `today` (the
 * caller's today in the report zone, `YYYY-MM-DD`; skipped when not given).
 * `report_window_too_long`: more than {@link REPORT_MAX_WINDOW_DAYS} days, unless the window is
 * exactly one calendar month (the 1st to that month's last day).
 */
export function reportWindowProblem(
  from: string,
  to: string,
  today?: string,
): Extract<AgencyReportErrorCode, 'report_window_invalid' | 'report_window_too_long'> | null {
  const days = reportWindowDays(from, to);
  if (days === null || days < 1) return 'report_window_invalid';
  if (today !== undefined) {
    const t = epochDay(today);
    const end = epochDay(to);
    if (t === null || end === null || end > t) return 'report_window_invalid';
  }
  if (days <= REPORT_MAX_WINDOW_DAYS) return null;
  // Exactly one calendar month: starts on the 1st, ends in the same month, and the day after
  // `to` is the next month's 1st.
  const dayAfterTo = new Date((epochDay(to)! + 1) * 86_400_000).toISOString().slice(0, 10);
  const wholeMonth = from.endsWith('-01') && from.slice(0, 7) === to.slice(0, 7) && dayAfterTo.endsWith('-01');
  return wholeMonth ? null : 'report_window_too_long';
}

const _kindsListed: AllListed<ReportKind, typeof REPORT_KINDS> = true;
const _formatsListed: AllListed<ReportFormat, typeof REPORT_FORMATS> = true;
const _audiencesListed: AllListed<ReportAudience, typeof REPORT_AUDIENCES> = true;
const _statusesListed: AllListed<ReportRunStatus, typeof REPORT_RUN_STATUSES> = true;
const _cadencesListed: AllListed<ReportCadence, typeof REPORT_CADENCES> = true;
const _failuresListed: AllListed<ReportFailureCode, typeof REPORT_FAILURE_CODES> = true;
void [_kindsListed, _formatsListed, _audiencesListed, _statusesListed, _cadencesListed, _failuresListed];
