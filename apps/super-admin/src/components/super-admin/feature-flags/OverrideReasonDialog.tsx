import { useId, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { FlagDialog } from './FlagDialog';
import styles from './featureFlags.module.css';

interface Props {
  /** Header copy, e.g. `Set Agency Dialer Enabled → On`. */
  title: string;
  /**
   * Shown above the reason field — the flag's `policy.warning`, passed only
   * when the write would turn a guarded flag ON, so it is read at the moment
   * of the decision rather than only in the table.
   */
  warning?: string;
  busy?: boolean;
  /** Called with the (trimmed) reason and the raw datetime-local expiry string. */
  onSubmit: (reason: string, expiresAt: string) => void;
  onClose: () => void;
}

/**
 * Captures the required audit reason (+ optional expiry) before committing an
 * explicit On/Off override at any scope. The reason threads into the audit log
 * server-side. Shared by the tenant tab and the global registry. Enter submits
 * when the reason is filled.
 */
export function OverrideReasonDialog({ title, warning, busy, onSubmit, onClose }: Props) {
  const [reason, setReason] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const reasonId = useId();
  const expiryId = useId();
  const warningId = useId();

  const trimmed = reason.trim();
  const submit = () => {
    if (!trimmed || busy) return;
    onSubmit(trimmed, expiresAt);
  };

  return (
    <FlagDialog title={title} onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        {warning && (
          <div id={warningId} className={styles.policyWarning} role="note">
            <AlertTriangle size={14} aria-hidden="true" />
            <span>{warning}</span>
          </div>
        )}
        <label className={styles.fieldLabel} htmlFor={reasonId}>Reason (required)</label>
        <input
          id={reasonId}
          className={styles.input}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          // The input takes focus, so point it at the warning or a screen
          // reader announces "Reason (required)" and never the warning.
          aria-describedby={warning ? warningId : undefined}
          placeholder="Why is this changing? (shown in the audit log)"
          autoFocus
        />
        <label className={styles.fieldLabel} htmlFor={expiryId}>Expires (optional)</label>
        <input
          id={expiryId}
          type="datetime-local"
          className={styles.input}
          value={expiresAt}
          onChange={(e) => setExpiresAt(e.target.value)}
        />
        <div className={styles.popoverActions}>
          <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
          <button
            type="submit"
            className="btn-primary"
            disabled={!trimmed || busy}
          >
            Save override
          </button>
        </div>
      </form>
    </FlagDialog>
  );
}
