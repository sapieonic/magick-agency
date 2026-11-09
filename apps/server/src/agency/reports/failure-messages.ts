/**
 * The copy a failed run shows (`AgencyReportRun.error.message`), one generic British-English
 * sentence per failure code. A failed run never stores or serves the text of whatever failed (a
 * renderer's exception, an SQL error, a path): that text is logged with the run id, and the
 * console keys its own copy off the code. Stored on the row by the run repository's two failing
 * writes (`markFailed`: the assembler, the tick's timeout; `applyRenderResult`: the render apply
 * path), which take the code only, and served from the code by the run view, so a row written
 * before this rule still never shows its stored text.
 */
import type { ReportFailureCode } from '@magick-agency/contracts/api/agency/reports';

export const REPORT_FAILURE_MESSAGES: Record<ReportFailureCode, string> = {
  assembly_failed: 'The report data could not be gathered.',
  subject_unavailable: 'The report subject is no longer available.',
  subject_changed: 'The campaign\'s time zone changed while this report was being prepared; run it again.',
  dataset_unreadable: 'The report data could not be read to build the files.',
  dataset_version_unsupported: 'The report data is in a version the file builder does not support.',
  render_failed: 'The report files could not be built.',
  upload_failed: 'The report files could not be saved.',
  render_timed_out: 'The report files were not produced in time.',
};

/** The copy for a stored failure code; a code this server does not know gets the render one. */
export function reportFailureMessage(code: string): string {
  return (REPORT_FAILURE_MESSAGES as Record<string, string>)[code] ?? REPORT_FAILURE_MESSAGES.render_failed;
}
