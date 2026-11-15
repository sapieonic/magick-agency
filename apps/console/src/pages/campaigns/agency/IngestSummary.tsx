import type { ReactNode } from 'react';
import {
  buildIngestSummary,
  checkComparison,
  formatCount,
  terminalNotice,
} from '../../../utils/agencyIngestSummary';
import { formatSpineTimestamp } from '../../../utils/agencySpineCopy';
import type { AgencyIngestJob } from '../../../types/agency-campaign';
import styles from './IngestSummary.module.css';

/**
 * The ingest summary — the screen an operator reconciles against their own
 * spreadsheet, for a check (`dry_run`: what the import will do) and for an import
 * (what it did).
 *
 * **The tiles add up.** `imported + already in this campaign + rejected = rows`
 * (IM3); duplicates and Do Not Call rows are breakdowns *of* rejected and are
 * rendered as such. The arithmetic and its justification live in
 * `utils/agencyIngestSummary.ts`.
 *
 * Every group of rows is reviewable: the rejected ones on screen (the first 20, with
 * a reason that says how to fix each) and as a download in the file's own columns, the
 * skipped ones as a download, the imported ones on the campaign's Contacts page.
 */

export interface IngestSummaryProps {
  job: AgencyIngestJob;
  /** The check this import was started from, to say so when the two disagree (IM2). */
  checkJob?: AgencyIngestJob | null;
  /** Re-enter the column mapping — the fix for a high rejection rate. */
  onBackToMapping?: () => void;
  onDownloadRejected?: () => void;
  onDownloadSkipped?: () => void;
  downloading?: boolean;
  downloadError?: string | null;
  /** The next steps (the review's Import button, Upload a corrected file), under the numbers. */
  children?: ReactNode;
}

export interface ReviewNextStepsProps {
  check: AgencyIngestJob;
  importing: boolean;
  /**
   * An import of this check failed or was stopped, and the check is still valid: the
   * button imports it again (IM2), the rows that landed being skipped (IM3).
   */
  retry?: boolean;
  /** Why Import cannot be pressed yet (the builder's campaign basics), or null. */
  blockReason?: string | null;
  onImport: () => void;
  onChangeMapping?: () => void;
  onUploadCorrected: () => void;
}

/**
 * The review's next steps, once a check has finished (IM2): **Import N contacts**,
 * which imports the very file and mapping that were checked; or go back and correct
 * the file (or the mapping) and check again. With nothing new to import the button
 * says so rather than offering to import nothing.
 */
export function ReviewNextSteps({
  check,
  importing,
  retry = false,
  blockReason = null,
  onImport,
  onChangeMapping,
  onUploadCorrected,
}: ReviewNextStepsProps) {
  const ready = check.accepted;
  return (
    <div className={styles.nextSteps} data-testid="review-next-steps">
      <button
        type="button"
        className="btn-primary"
        disabled={ready === 0 || importing || blockReason !== null}
        onClick={onImport}
      >
        {importing
          ? 'Starting the import…'
          : ready === 0
            ? 'Nothing new to import'
            : retry
              ? 'Import again'
              : `Import ${formatCount(ready)} ${ready === 1 ? 'contact' : 'contacts'}`}
      </button>
      <button type="button" className="btn-secondary" onClick={onUploadCorrected} disabled={importing}>
        Upload a corrected file
      </button>
      {onChangeMapping ? (
        <button type="button" className="btn-secondary" onClick={onChangeMapping} disabled={importing}>
          Change the column mapping
        </button>
      ) : null}
      <p className={styles.nextStepsNote}>
        {blockReason ?? (retry
          ? 'The import did not finish. Importing again reads the same checked file with the same mapping; any rows that did land are skipped, never added twice.'
          : check.rejected > 0
            ? 'Importing now adds the ready rows and leaves the rejected ones out. You can fix those later and upload them again: anything already imported is skipped, never added twice.'
            : 'Nothing was imported by the check. The import reads the same file again, with this mapping, so the campaign gets what you see here unless it changes in between.')}
      </p>
      {check.check_expires_at ? (
        <p className={styles.nextStepsNote} data-testid="check-expires">
          This check can be imported until {formatSpineTimestamp(check.check_expires_at)}. After that, check the file again.
        </p>
      ) : null}
    </div>
  );
}

export function IngestSummary({
  job,
  checkJob = null,
  onBackToMapping,
  onDownloadRejected,
  onDownloadSkipped,
  downloading = false,
  downloadError = null,
  children,
}: IngestSummaryProps) {
  const summary = buildIngestSummary(job);
  const notice = terminalNotice(job);
  const comparison = checkJob ? checkComparison(checkJob, job) : null;
  const sample = job.rejected_sample ?? [];

  return (
    <div className={styles.summary} data-testid="ingest-summary" data-kind={job.dry_run ? 'check' : 'import'}>
      {summary.highRejectionWarning ? (
        <div className={styles.warning} role="alert">
          <p className={styles.warningText}>{summary.highRejectionWarning}</p>
          {onBackToMapping ? (
            <button type="button" className="btn-secondary" onClick={onBackToMapping}>
              Check the column mapping
            </button>
          ) : null}
        </div>
      ) : null}

      {notice ? (
        <p className={styles.terminalNotice} role="status">
          {notice}
        </p>
      ) : null}

      <div className={styles.counters}>
        {summary.counters.map((counter) => (
          <div key={counter.key} className={styles.counter} data-counter={counter.key}>
            <span className={styles.value} data-testid={`count-${counter.key}`}>
              {formatCount(counter.value)}
            </span>
            <span className={styles.label}>{counter.label}</span>
          </div>
        ))}
      </div>

      {/*
        The identity, in words, under the tiles. An operator who cannot see it has
        to take it on trust, and this screen exists precisely so they do not.
      */}
      <p className={styles.reconciliation} data-testid="reconciliation">
        {summary.reconciliationLine}
      </p>

      {comparison ? (
        <p className={styles.comparison} role="status" data-testid="check-comparison">
          {comparison}
        </p>
      ) : null}

      {/* Breakdowns of `rejected`. Labelled as such so they are never added in. */}
      <ul className={styles.breakdowns}>
        {summary.skippedNotice ? (
          <li data-testid="skipped-notice">
            {summary.skippedNotice}
            {job.skipped_truncated
              ? ` The download holds the first ${formatCount(job.skipped_row_count)} skipped rows.`
              : null}
            {job.has_skipped_export && onDownloadSkipped ? (
              <>
                {' '}
                <button type="button" className={styles.linkButton} onClick={onDownloadSkipped} disabled={downloading}>
                  Download the skipped rows
                </button>
              </>
            ) : null}
          </li>
        ) : null}
        <li>
          <strong>{formatCount(summary.duplicates)}</strong> duplicate
          {summary.duplicates === 1 ? '' : 's'} within the file — {summary.duplicateMeaning} Counted in the rejected
          total.
        </li>
        {summary.dncNotice ? (
          <li data-testid="dnc-notice" className={styles.dnc}>
            {summary.dncNotice}
          </li>
        ) : null}
      </ul>

      {/*
        Outside the breakdown list above, on purpose. Everything in that list is
        a slice of `rejected`; this is a count taken on the far side of a network
        hop, of rows the server believed it had sent successfully. Putting it in the
        list would invite exactly the arithmetic it cannot support.
      */}
      {summary.coreRefusedNotice ? (
        <section className={styles.coreRefused} role="status" data-testid="core-refused">
          <p className={styles.coreRefusedText}>{summary.coreRefusedNotice}</p>
          {summary.coreRefusedSample ? (
            <p className={styles.coreRefusedSample} data-testid="core-refused-sample">
              {summary.coreRefusedSample}
            </p>
          ) : null}
        </section>
      ) : null}

      {summary.groups.length > 0 ? (
        <section className={styles.reasons}>
          <div className={styles.reasonsHeader}>
            <h3 className={styles.reasonsTitle}>Why rows were rejected</h3>
            {job.has_rejected_export && onDownloadRejected ? (
              <button
                type="button"
                className="btn-secondary"
                onClick={onDownloadRejected}
                disabled={downloading}
              >
                {downloading ? 'Preparing…' : 'Download rejected rows'}
              </button>
            ) : null}
          </div>

          <ul className={styles.reasonList}>
            {summary.groups.map((group) => (
              <li key={group.code} className={styles.reason}>
                <span className={styles.reasonCount}>{formatCount(group.count)}</span>
                <span className={styles.reasonLabel}>{group.label}</span>
              </li>
            ))}
          </ul>

          {sample.length > 0 ? (
            <div className={styles.sampleWrap}>
              <table className={styles.sample} data-testid="rejected-sample">
                <caption className={styles.sampleCaption}>
                  {sample.length < job.rejected
                    ? `The first ${formatCount(sample.length)} of ${formatCount(job.rejected)} rejected rows. The download has them all, in your own columns, with the reason beside each: fix them there and upload the file again.`
                    : 'The rejected rows. The download has them in your own columns, with the reason beside each: fix them there and upload the file again.'}
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Row</th>
                    <th scope="col">Phone</th>
                    <th scope="col">What to fix</th>
                  </tr>
                </thead>
                <tbody>
                  {sample.map((row) => (
                    <tr key={`${row.row_number}-${row.reason_code}`}>
                      <td className={styles.sampleRow}>{formatCount(row.row_number)}</td>
                      <td className={styles.sampleValue}>{row.raw_value || '—'}</td>
                      <td>{row.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}

          {job.rejected_truncated ? (
            <p className={styles.truncated}>
              The download holds the first {formatCount(job.rejected_row_count)} rejected rows.
            </p>
          ) : null}
        </section>
      ) : null}

      {downloadError ? <p className={styles.downloadError}>{downloadError}</p> : null}

      {children}
    </div>
  );
}
