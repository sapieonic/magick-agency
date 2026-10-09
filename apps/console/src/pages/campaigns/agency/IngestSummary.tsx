import {
  buildIngestSummary,
  formatCount,
  terminalNotice,
} from '../../../utils/agencyIngestSummary';
import type { AgencyIngestJob } from '../../../types/agency-campaign';
import styles from './IngestSummary.module.css';

/**
 * The ingest summary — the screen an operator reconciles against their
 * own spreadsheet.
 *
 * **Three counters, not four.** `accepted + rejected = rows_read`; duplicates
 * and DNC suppressions are breakdowns *of* rejected and are rendered as such.
 * The arithmetic and its justification live in `utils/agencyIngestSummary.ts`.
 */

export interface IngestSummaryProps {
  job: AgencyIngestJob;
  /** Re-enter the column mapping — the fix for a high rejection rate. */
  onBackToMapping?: () => void;
  onDownloadRejected?: () => void;
  downloading?: boolean;
  downloadError?: string | null;
}

export function IngestSummary({
  job,
  onBackToMapping,
  onDownloadRejected,
  downloading = false,
  downloadError = null,
}: IngestSummaryProps) {
  const summary = buildIngestSummary(job);
  const notice = terminalNotice(job);

  return (
    <div className={styles.summary} data-testid="ingest-summary">
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

      {/* Breakdowns of `rejected`. Labelled as such so they are never added in. */}
      <ul className={styles.breakdowns}>
        <li>
          <strong>{formatCount(summary.duplicates)}</strong> duplicate
          {summary.duplicates === 1 ? '' : 's'} — a number that already appeared earlier in the
          file. Counted in the rejected total.
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

          {job.rejected_truncated ? (
            <p className={styles.truncated}>
              The download holds the first {formatCount(job.rejected_row_count)} rejected rows.
            </p>
          ) : null}

          {downloadError ? <p className={styles.downloadError}>{downloadError}</p> : null}
        </section>
      ) : null}
    </div>
  );
}
