/**
 * The download file name of a rendered report, built once here so the server's
 * `Content-Disposition`, the download response's `filename` and the email agree.
 */
import type { ReportFormat, ReportKind } from '../api/agency/reports';

/** The first part of each kind's file name. */
export const REPORT_FILE_NAME_PREFIXES = {
  agent: 'agent-review',
  campaign: 'campaign-report',
  account: 'account-report',
} as const satisfies Record<ReportKind, string>;

/** The longest subject slug kept in a file name. */
export const REPORT_FILE_NAME_SUBJECT_MAX = 48;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A safe ASCII slug of a display name: accents stripped, lower case, every run of other
 * characters one `-`, no leading or trailing `-`, at most {@link REPORT_FILE_NAME_SUBJECT_MAX}
 * characters. `report` when nothing is left (a name written only in another script).
 */
export function reportSubjectSlug(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, REPORT_FILE_NAME_SUBJECT_MAX)
    .replace(/-+$/, '');
  return slug === '' ? 'report' : slug;
}

/**
 * `agent-review_priya-s_2026-10-09_2026-11-07.pdf`: prefix, subject slug, the window's first
 * and last local days (`YYYY-MM-DD`, as on the run's range), extension. Throws a `RangeError`
 * on a date that is not `YYYY-MM-DD` (a caller bug, not user input).
 */
export function reportFileName(
  kind: ReportKind,
  subjectName: string,
  from: string,
  to: string,
  format: ReportFormat,
): string {
  if (!DATE_RE.test(from) || !DATE_RE.test(to)) {
    throw new RangeError(`reportFileName: from and to must be YYYY-MM-DD, got ${from} and ${to}`);
  }
  return `${REPORT_FILE_NAME_PREFIXES[kind]}_${reportSubjectSlug(subjectName)}_${from}_${to}.${format}`;
}
