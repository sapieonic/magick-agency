import { useRef, useId, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { useDialogFocus } from '../hooks/useDialogFocus';
import styles from './Modal.module.css';

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  subtitle?: string;
  /** Body content. Callers supply a <form> here when needed. */
  children: ReactNode;
  /** Optional sticky footer area for action buttons. */
  footer?: ReactNode;
  /** Maps to max-width ~420 / ~560 / ~760px. Default 'md'. */
  size?: 'sm' | 'md' | 'lg';
  /** Whether clicking the overlay closes the modal. Default true. */
  closeOnOverlayClick?: boolean;
}

/**
 * Reusable accessible modal dialog. Shares ConfirmDialog's overlay and design
 * tokens, and its focus handling (`useDialogFocus`): initial focus goes to a
 * `[data-autofocus="true"]` control when the body marks one, else the first
 * focusable control. The body scrolls
 * independently; the optional footer is sticky at the bottom.
 */
export function Modal({
  open,
  onClose,
  title,
  subtitle,
  children,
  footer,
  size = 'md',
  closeOnOverlayClick = true,
}: ModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  // Focus in, Tab trapped, Escape closes, focus restored — `useDialogFocus`.
  // `onClose` is held in a ref there, so an inline `onClose={() => ...}` from the
  // caller never re-arms the autofocus timer mid-typing in a form.
  useDialogFocus({ open, dialogRef, onEscape: onClose });

  if (!open) return null;

  const handleOverlayClick = () => {
    if (closeOnOverlayClick) onClose();
  };

  return (
    <div
      className={styles.overlay}
      onClick={handleOverlayClick}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
    >
      <div
        className={`${styles.dialog} ${styles[size]}`}
        onClick={(e) => e.stopPropagation()}
        ref={dialogRef}
      >
        <div className={styles.header}>
          <div className={styles.headerText}>
            <h2 className={styles.title} id={titleId}>
              {title}
            </h2>
            {subtitle && <p className={styles.subtitle}>{subtitle}</p>}
          </div>
          <button
            type="button"
            className={styles.closeButton}
            onClick={onClose}
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>
        <div className={styles.body}>{children}</div>
        {footer && <div className={styles.footer}>{footer}</div>}
      </div>
    </div>
  );
}
