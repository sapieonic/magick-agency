import type { ReportFormat } from '@magick-agency/contracts/api/agency/reports';
import { REPORT_FORMATS } from '@magick-agency/contracts/api/agency/reports';
import { REPORT_FORMAT_LABELS } from '../../../utils/reports/reportCopy';
import styles from './Reports.module.css';

export interface ReportFormatFieldsProps {
  formats: Record<ReportFormat, boolean>;
  onChange: (format: ReportFormat, checked: boolean) => void;
  /** The message to show under the boxes (none chosen, after a submit attempt), or null. */
  error: string | null;
  errorId: string;
  errorTestId: string;
}

/** The PDF and Excel boxes the export and the scheduled-report dialogs both ask for. */
export function ReportFormatFields({ formats, onChange, error, errorId, errorTestId }: ReportFormatFieldsProps) {
  return (
    <fieldset className={styles.fieldset} aria-describedby={error ? errorId : undefined}>
      <legend className={styles.legend}>Formats</legend>
      <div className={styles.checkRow}>
        {REPORT_FORMATS.map((format) => (
          <label key={format} className={styles.checkOption}>
            <input type="checkbox" checked={formats[format]} onChange={(e) => onChange(format, e.target.checked)} />
            {REPORT_FORMAT_LABELS[format]}
          </label>
        ))}
      </div>
      {error ? (
        <p id={errorId} className={styles.inlineError} role="alert" data-testid={errorTestId}>
          {error}
        </p>
      ) : null}
    </fieldset>
  );
}
