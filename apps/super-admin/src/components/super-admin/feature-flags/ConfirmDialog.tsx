import type { ReactNode } from 'react';
import { FlagDialog } from './FlagDialog';
import styles from './featureFlags.module.css';

interface Props {
  title: string;
  body: ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  onClose: () => void;
  danger?: boolean;
}

/**
 * Confirm gate shown before a destructive flag change (turning off a capability
 * that is currently live). Used when disabling at any scope so admins see the
 * blast radius before it lands.
 */
export function ConfirmDialog({ title, body, confirmLabel, onConfirm, onClose, danger = true }: Props) {
  return (
    <FlagDialog title={title} onClose={onClose} role="alertdialog">
      <p className={styles.confirmBody}>{body}</p>
      <div className={styles.popoverActions}>
        <button className="btn-secondary" onClick={onClose}>Cancel</button>
        <button className={danger ? 'btn-danger' : 'btn-primary'} onClick={onConfirm}>
          {confirmLabel}
        </button>
      </div>
    </FlagDialog>
  );
}
