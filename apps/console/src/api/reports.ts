import { API_BASE } from '../config';
import { apiFetch, ApiError } from './client';
import { errorCode } from '../utils/agencyErrors';
import { getErrorMessage } from '@magick-agency/web-ui/errors';
import {
  AGENCY_REPORT_ERROR_CODES,
  type AgencyCreateReportRequest,
  type AgencyCreateReportSubscriptionRequest,
  type AgencyReportDownload,
  type AgencyReportErrorCode,
  type AgencyReportRun,
  type AgencyReportRunListQuery,
  type AgencyReportRunPage,
  type AgencyReportSubscription,
  type AgencyReportSubscriptionList,
  type AgencyUpdateReportSubscriptionRequest,
  type ReportFormat,
} from '@magick-agency/contracts/api/agency/reports';

/**
 * Reports (`docs/reports.md`): ask for a run, poll it until it is ready, then ask
 * for a short-lived download URL per format; subscriptions turn into runs on a
 * schedule. One function per route of the fixed surface:
 *
 *   POST   /proxy/agency/reports                          → 202 run
 *   GET    /proxy/agency/reports                          → page of runs
 *   GET    /proxy/agency/reports/:id                      → run
 *   GET    /proxy/agency/reports/:id/files/:format        → download (5-minute URL)
 *   POST   /proxy/agency/reports/:id/retry                → 202 a NEW run
 *   GET    /proxy/agency/report-subscriptions             → list
 *   POST   /proxy/agency/report-subscriptions             → 201 subscription
 *   PATCH  /proxy/agency/report-subscriptions/:id         → subscription
 *   DELETE /proxy/agency/report-subscriptions/:id         → 204
 *   POST   /proxy/agency/report-subscriptions/:id/run-now → 202 run
 *
 * Every route is account-scoped (the account header) and gated by the
 * `agency_reports_enabled` flag: off, each answers the dialer gate's
 * `403 feature_disabled`. Refusals are `ApiError`s whose body is
 * `{ error, code, message }`; {@link reportErrorMessage} turns one into the
 * words the console shows (the server's `message` is English fallback copy and is
 * never shown for a known code).
 */

const AGENCY_BASE = `${API_BASE}/proxy/agency`;
const REPORTS = `${AGENCY_BASE}/reports`;
const SUBSCRIPTIONS = `${AGENCY_BASE}/report-subscriptions`;

const enc = encodeURIComponent;

// ─── Runs ──────────────────────────────────────────────────────────────────

/** Queue an ad hoc run. Answers `202` with the run, usually `queued`. */
export function createReport(
  request: AgencyCreateReportRequest,
  tenantId?: string,
  accountId?: string,
): Promise<AgencyReportRun> {
  return apiFetch<AgencyReportRun>(REPORTS, { method: 'POST', body: JSON.stringify(request) }, tenantId, accountId);
}

/** The query string of a history page; absent and empty values are left out. */
export function reportRunListQueryString(query: AgencyReportRunListQuery): string {
  const qs = new URLSearchParams();
  if (query.cursor) qs.set('cursor', query.cursor);
  if (query.limit !== undefined) qs.set('limit', String(query.limit));
  if (query.kind) qs.set('kind', query.kind);
  if (query.subject_id) qs.set('subject_id', query.subject_id);
  if (query.subscription_id) qs.set('subscription_id', query.subscription_id);
  const text = qs.toString();
  return text ? `?${text}` : '';
}

/**
 * One page of runs, newest first. A supervisor reads the account's runs; anyone
 * else only the runs they requested (the server filters, the console never asks for
 * somebody else's).
 */
export function listReports(
  query: AgencyReportRunListQuery,
  tenantId?: string,
  accountId?: string,
): Promise<AgencyReportRunPage> {
  return apiFetch<AgencyReportRunPage>(`${REPORTS}${reportRunListQueryString(query)}`, {}, tenantId, accountId);
}

/** One run, as polled by the run page and the history rows still in flight. */
export function getReport(runId: string, tenantId?: string, accountId?: string): Promise<AgencyReportRun> {
  return apiFetch<AgencyReportRun>(`${REPORTS}/${enc(runId)}`, {}, tenantId, accountId);
}

/** A presigned URL for one file of a `ready` run, valid for five minutes. */
export function getReportDownload(
  runId: string,
  format: ReportFormat,
  tenantId?: string,
  accountId?: string,
): Promise<AgencyReportDownload> {
  return apiFetch<AgencyReportDownload>(`${REPORTS}/${enc(runId)}/files/${enc(format)}`, {}, tenantId, accountId);
}

/**
 * Fetch a file's URL and send the browser to it. The URL carries
 * `Content-Disposition: attachment`, so the page stays where it is and the file
 * downloads. Fetched on each press rather than kept: the URL expires in five
 * minutes, and the server re-checks access and audits every download.
 */
export async function downloadReportFile(
  runId: string,
  format: ReportFormat,
  tenantId?: string,
  accountId?: string,
): Promise<AgencyReportDownload> {
  const download = await getReportDownload(runId, format, tenantId, accountId);
  window.location.assign(download.url);
  return download;
}

/** "Run again": a NEW run with the same parameters. Answers `202` with it. */
export function retryReport(runId: string, tenantId?: string, accountId?: string): Promise<AgencyReportRun> {
  return apiFetch<AgencyReportRun>(`${REPORTS}/${enc(runId)}/retry`, { method: 'POST' }, tenantId, accountId);
}

// ─── Subscriptions (supervisors only) ───────────────────────────────────────

export function listReportSubscriptions(tenantId?: string, accountId?: string): Promise<AgencyReportSubscriptionList> {
  return apiFetch<AgencyReportSubscriptionList>(SUBSCRIPTIONS, {}, tenantId, accountId);
}

export function createReportSubscription(
  request: AgencyCreateReportSubscriptionRequest,
  tenantId?: string,
  accountId?: string,
): Promise<AgencyReportSubscription> {
  return apiFetch<AgencyReportSubscription>(
    SUBSCRIPTIONS,
    { method: 'POST', body: JSON.stringify(request) },
    tenantId,
    accountId,
  );
}

/** Any subset of the schedule, formats, recipients and `enabled` (pause and resume). */
export function updateReportSubscription(
  subscriptionId: string,
  patch: AgencyUpdateReportSubscriptionRequest,
  tenantId?: string,
  accountId?: string,
): Promise<AgencyReportSubscription> {
  return apiFetch<AgencyReportSubscription>(
    `${SUBSCRIPTIONS}/${enc(subscriptionId)}`,
    { method: 'PATCH', body: JSON.stringify(patch) },
    tenantId,
    accountId,
  );
}

/** Remove a subscription. The runs it produced are kept. */
export function deleteReportSubscription(subscriptionId: string, tenantId?: string, accountId?: string): Promise<void> {
  return apiFetch<void>(`${SUBSCRIPTIONS}/${enc(subscriptionId)}`, { method: 'DELETE' }, tenantId, accountId);
}

/** Produce a run for the subscription's most recent period now. Answers `202` with the run. */
export function runReportSubscriptionNow(
  subscriptionId: string,
  tenantId?: string,
  accountId?: string,
): Promise<AgencyReportRun> {
  return apiFetch<AgencyReportRun>(
    `${SUBSCRIPTIONS}/${enc(subscriptionId)}/run-now`,
    { method: 'POST' },
    tenantId,
    accountId,
  );
}

// ─── Refusals, in the console's words ──────────────────────────────────────

/** The codes a report route can refuse with: the family's, plus the flag gate's. */
export type ReportRefusalCode = AgencyReportErrorCode | 'feature_disabled';

/**
 * What the console says for each refusal (British English). Keyed by the wire code,
 * so a code added to the contract fails to compile here until it has words.
 */
export const REPORT_ERROR_MESSAGES: Record<ReportRefusalCode, string> = {
  report_window_invalid:
    'Those dates don’t make a valid window. Choose a start date on or before the end date, and an end date no later than today.',
  report_window_too_long:
    'A report can cover at most 30 days, or exactly one calendar month. Choose a shorter window.',
  report_timezone_invalid: 'That time zone isn’t recognised. Choose another.',
  report_subject_not_found: 'That agent, campaign or account can’t be reported on from this account.',
  report_queue_full:
    'Your organisation already has the most reports being prepared at once. Try again when one of them is ready.',
  report_rate_limited: 'You’ve asked for several reports in the last minute. Wait a minute and try again.',
  report_not_found: 'This report doesn’t exist, or you don’t have access to it.',
  report_not_ready: 'This report isn’t ready to download yet.',
  report_expired: 'This report has expired and its files have been deleted. Run it again to get new files.',
  report_format_unavailable: 'This report wasn’t prepared in that format.',
  report_subscription_not_found: 'This scheduled report no longer exists. It may have been deleted.',
  report_subscription_invalid: 'The schedule isn’t complete. Check the day and time it should be sent.',
  report_recipient_invalid:
    'One of the recipients can’t receive this report. Recipients must be supervisors on this account, at most 20.',
  feature_disabled: 'Reports aren’t turned on for this account.',
};

const REPORT_CODES: ReadonlySet<string> = new Set<string>([...AGENCY_REPORT_ERROR_CODES, 'feature_disabled']);

/** The refusal code of an error from this client, when it is one of the family's (or the flag gate's). */
export function reportErrorCode(err: unknown): ReportRefusalCode | null {
  const code = errorCode(err);
  return code !== null && REPORT_CODES.has(code) ? (code as ReportRefusalCode) : null;
}

/**
 * Any error from this client, as the words to show: the family's copy for a known
 * code, a plain "try again" for a 403 without one (the caller may not run this),
 * otherwise the client's own message or `fallback`.
 */
export function reportErrorMessage(err: unknown, fallback: string): string {
  const code = reportErrorCode(err);
  if (code !== null) return REPORT_ERROR_MESSAGES[code];
  if (err instanceof ApiError && err.statusCode === 403) return 'You don’t have permission to do that.';
  return getErrorMessage(err, fallback);
}
