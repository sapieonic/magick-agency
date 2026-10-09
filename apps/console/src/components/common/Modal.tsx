import { useEffect, useCallback, useRef, useId, type ReactNode } from 'react';
import { X } from 'lucide-react';
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
 * Reusable accessible modal dialog. Shares ConfirmDialog's overlay / focus-trap /
 * escape / restore-focus pattern and the same design tokens. The body scrolls
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
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const titleId = useId();

  // Hold the latest onClose in a ref so the keydown handler can stay stable.
  // Otherwise an inline `onClose={() => ...}` from the caller would change
  // handleKeyDown's identity every render, re-running the open effect below and
  // re-arming the autofocus timer — which can steal focus mid-typing in forms.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      onCloseRef.current();
      return;
    }
    // Focus trap: cycle focus within dialog
    if (e.key === 'Tab' && dialogRef.current) {
      const focusable = dialogRef.current.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      if (focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (e.shiftKey) {
        if (document.activeElement === first) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    // Save the element that was focused before the dialog opened
    previousFocusRef.current = document.activeElement as HTMLElement | null;
    document.addEventListener('keydown', handleKeyDown);
    // Auto-focus the first focusable element when the dialog opens
    const timer = setTimeout(() => {
      const focusable = dialogRef.current?.querySelector<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      focusable?.focus();
    }, 50);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      clearTimeout(timer);
      // Restore focus to the element that triggered the dialog
      previousFocusRef.current?.focus();
    };
  }, [open, handleKeyDown]);

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
