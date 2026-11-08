import { useState } from 'react';
import { Download } from 'lucide-react';
import type { AgencyReportRun, ReportFormat } from '@magick-agency/contracts/api/agency/reports';
import { REPORT_FORMATS } from '@magick-agency/contracts/api/agency/reports';
import { useTenant } from '../../../contexts/TenantContext';
import { downloadReportFile, reportErrorMessage } from '../../../api/reports';
import { trackAgencyReportDownloaded } from '../../../analytics/events';
import { formatFileSize, REPORT_FORMAT_LABELS } from '../../../utils/reports/reportCopy';
import styles from './Reports.module.css';

/**
 * One button per file of a `ready` run. Each press asks the server for a fresh
 * five-minute URL (it re-checks access and audits the download) and sends the
 * browser to it; nothing is rendered for a run that is not ready.
 */
export function ReportDownloads({ run, compact = false }: { run: AgencyReportRun; compact?: boolean }) {
  const { tenantId, accountId } = useTenant();
  const [busy, setBusy] = useState<ReportFormat | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (run.status !== 'ready') return null;
  const files = REPORT_FORMATS.flatMap((format) => run.files.filter((f) => f.format === format));
  if (files.length === 0) return null;

  const download = async (format: ReportFormat) => {
    setBusy(format);
    setError(null);
    try {
      await downloadReportFile(run.id, format, tenantId ?? undefined, accountId ?? undefined);
      trackAgencyReportDownloaded({ kind: run.kind, format });
    } catch (err) {
      setError(reportErrorMessage(err, 'We couldn’t start the download. Try again.'));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className={styles.downloads}>
      {files.map((file) => {
        const label = REPORT_FORMAT_LABELS[file.format];
        const size = formatFileSize(file.bytes);
        return (
          <button
            key={file.format}
            type="button"
            className={`btn-secondary ${styles.downloadButton}`}
            onClick={() => void download(file.format)}
            disabled={busy !== null}
            aria-label={`Download ${label}`}
            data-testid={`report-download-${file.format}`}
          >
            <Download size={14} aria-hidden="true" />
            {busy === file.format ? 'Starting…' : compact ? label : `${label}${size ? ` (${size})` : ''}`}
          </button>
        );
      })}
      {error ? (
        <p className={styles.inlineError} role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export default ReportDownloads;
