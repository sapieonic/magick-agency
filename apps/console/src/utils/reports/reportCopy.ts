import type {
  AgencyReportRange,
  AgencyReportSubscription,
  ReportCadence,
  ReportFailureCode,
  ReportFormat,
  ReportKind,
  ReportRunStatus,
} from '@magick-agency/contracts/api/agency/reports';
import { REPORT_PENDING_STATUSES } from '@magick-agency/contracts/api/agency/reports';
import { dateFormatter } from '../format/date';

/** The words of the reports pages and the export dialog (`docs/reports.md`). British English. */

export const REPORT_KIND_LABELS: Record<ReportKind, string> = {
  agent: 'Agent review',
  campaign: 'Campaign report',
  account: 'Account report',
};

export const REPORT_FORMAT_LABELS: Record<ReportFormat, string> = {
  pdf: 'PDF',
  xlsx: 'Excel',
};

export const REPORT_CADENCE_LABELS: Record<ReportCadence, string> = {
  daily: 'Daily',
  weekly: 'Weekly',
  monthly: 'Monthly',
};

/** ISO weekday, Monday 1 … Sunday 7. */
export const ISO_WEEKDAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'] as const;

/** The run is still being prepared (queued, assembling or rendering). */
export function isPendingStatus(status: ReportRunStatus): boolean {
  return (REPORT_PENDING_STATUSES as readonly string[]).includes(status);
}

export const REPORT_STATUS_META: Record<ReportRunStatus, { label: string; color: string; tooltip: string }> = {
  queued: { label: 'Preparing…', color: 'var(--info)', tooltip: 'Waiting its turn to be prepared.' },
  assembling: { label: 'Preparing…', color: 'var(--info)', tooltip: 'Gathering the figures.' },
  rendering: { label: 'Preparing…', color: 'var(--info)', tooltip: 'Building the files.' },
  ready: { label: 'Ready', color: 'var(--success)', tooltip: 'The files are ready to download.' },
  failed: { label: 'Failed', color: 'var(--danger)', tooltip: 'The report could not be prepared.' },
  expired: { label: 'Expired', color: 'var(--text-muted)', tooltip: 'The files have been deleted. Run it again for new ones.' },
};

/** Why a run failed, keyed by the wire code (the server's `message` is fallback copy only). */
export const REPORT_FAILURE_MESSAGES: Record<ReportFailureCode, string> = {
  assembly_failed: 'We couldn’t gather the figures for this report. Run it again in a few minutes.',
  subject_unavailable: 'The agent, campaign or account this report is about is no longer available.',
  subject_changed: 'The campaign’s time zone changed while this report was being prepared. Run it again; scheduled reports use the new zone from the next one.',
  dataset_unreadable: 'The report’s figures couldn’t be read when building the files. Run it again.',
  dataset_version_unsupported: 'The report was prepared by a different version of the service. Run it again.',
  render_failed: 'Building the files failed. Run it again.',
  upload_failed: 'The files couldn’t be saved. Run it again.',
  render_timed_out: 'Building the files took too long and was stopped. Run it again.',
};

export function failureMessage(error: { code: ReportFailureCode; message: string } | null): string {
  if (!error) return 'The report could not be prepared. Run it again.';
  return REPORT_FAILURE_MESSAGES[error.code] ?? error.message;
}

const SUBJECT_FALLBACK: Record<ReportKind, string> = {
  agent: 'An agent no longer on the team',
  campaign: 'A deleted campaign',
  account: 'This account',
};

/** A subject's name, or a stand-in that says why it has none. */
export function subjectLabel(kind: ReportKind, subject: { name: string | null }): string {
  return subject.name ?? SUBJECT_FALLBACK[kind];
}

const DAY_FORMAT: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short', timeZone: 'UTC' };
const DAY_YEAR_FORMAT: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' };

/** A `YYYY-MM-DD` date as `9 Oct` or `9 Oct 2026`: a calendar date, so formatted in UTC, never shifted. */
export function formatReportDay(day: string, withYear = true): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  if (!y || !m || !d) return day;
  return dateFormatter(withYear ? DAY_YEAR_FORMAT : DAY_FORMAT).format(new Date(Date.UTC(y, m - 1, d)));
}

/** `9 Oct – 7 Nov 2026`, `28 Dec 2025 – 3 Jan 2026`, or one day: `7 Nov 2026`. */
export function formatReportWindow(range: Pick<AgencyReportRange, 'from' | 'to'>): string {
  if (range.from === range.to) return formatReportDay(range.to);
  const sameYear = range.from.slice(0, 4) === range.to.slice(0, 4);
  return `${formatReportDay(range.from, !sameYear)} – ${formatReportDay(range.to)}`;
}

const WHEN: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' };

/** An instant on the reader's clock: `5 Nov 2026, 11:20 am`. */
export function formatReportWhen(iso: string | null): string {
  if (!iso) return '—';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : dateFormatter(WHEN).format(date);
}

/** `1st`, `2nd`, `3rd`, `4th` … `21st`, `28th`. */
export function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

/** `Daily at 08:30 (Asia/Kolkata)`, `Weekly on Monday at 08:30 (…)`, `Monthly on the 1st at 08:30 (…)`. */
export function cadenceDescription(
  sub: Pick<AgencyReportSubscription, 'cadence' | 'send_local_time' | 'send_weekday' | 'send_monthday' | 'timezone'>,
): string {
  const at = `at ${sub.send_local_time} (${sub.timezone})`;
  switch (sub.cadence) {
    case 'daily':
      return `Daily ${at}`;
    case 'weekly': {
      const day = sub.send_weekday !== null ? ISO_WEEKDAY_NAMES[sub.send_weekday - 1] : undefined;
      return day ? `Weekly on ${day} ${at}` : `Weekly ${at}`;
    }
    case 'monthly':
      return sub.send_monthday !== null ? `Monthly on the ${ordinal(sub.send_monthday)} ${at}` : `Monthly ${at}`;
  }
}

/** What each cadence's run covers, said under the cadence picker. */
export const CADENCE_PERIOD_NOTES: Record<ReportCadence, string> = {
  daily: 'Each report covers the previous day.',
  weekly: 'Each report covers the seven days before the day it is sent.',
  monthly: 'Each report covers the previous calendar month.',
};

/** `2.4 MB`, `830 KB`. */
export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** What the agent's own review leaves out (RP5), said in the dialog and on the run page. */
export const SELF_REVIEW_NOTE =
  'Your own review shows your figures only. It does not include comparisons with the rest of the floor or call analysis.';
