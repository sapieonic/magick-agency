import { compareErrorMessage, isRetryableCompareError } from '../../../api/compare';
import styles from './Compare.module.css';

/** A Compare agents read that failed, in the console's words, with Try again when it can clear by itself. */
export function CompareReadError({ error, onRetry, fallback }: { error: unknown; onRetry: () => void; fallback: string }) {
  // Only a failure that can clear by itself is offered again (`isRetryableCompareError`); any
  // other refusal needs the reader to change something first.
  const canRetry = isRetryableCompareError(error);
  return (
    <div className={`${styles.note} ${styles.errorBox}`} role="alert" data-testid="compare-error">
      <p className={styles.emptyNote}>{compareErrorMessage(error, fallback)}</p>
      {canRetry ? (
        <button type="button" className={styles.linkButton} onClick={onRetry}>
          Try again
        </button>
      ) : null}
    </div>
  );
}
