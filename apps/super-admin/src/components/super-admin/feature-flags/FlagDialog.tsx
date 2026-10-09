import { useEffect, useId, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';
import styles from './featureFlags.module.css';

interface Props {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  /** `alertdialog` for destructive confirmations, `dialog` otherwise. */
  role?: 'dialog' | 'alertdialog';
  /** `modal` is the wider panel used by the bulk flow; `popover` is the default. */
  variant?: 'popover' | 'modal';
}

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])';

/**
 * Accessible modal shell shared by every feature-flag dialog. Provides the
 * labelled `dialog`/`alertdialog` semantics, Escape-to-close, a focus trap, and
 * focus restoration to the trigger — so keyboard and screen-reader users can
 * operate the destructive flag writes these dialogs gate.
 */
export function FlagDialog({ title, onClose, children, role = 'dialog', variant = 'popover' }: Props) {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  // Restore focus to whatever was focused before the dialog opened.
  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    // Only pull focus in if it isn't already inside (respects child autoFocus).
    if (panel && !panel.contains(document.activeElement)) {
      const first = panel.querySelector<HTMLElement>(FOCUSABLE);
      (first ?? panel).focus();
    }
    return () => previouslyFocused?.focus?.();
  }, []);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== 'Tab') return;
    const panel = panelRef.current;
    if (!panel) return;
    const items = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE));
    if (items.length === 0) return;
    const first = items[0]!;
    const last = items[items.length - 1]!;
    const active = document.activeElement;
    if (e.shiftKey && active === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  };

  return (
    <div className={styles.popoverOverlay} onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div
        ref={panelRef}
        role={role}
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={variant === 'modal' ? styles.modal : styles.popover}
        onKeyDown={onKeyDown}
      >
        <div className={styles.popoverHeader}>
          <span id={titleId}>{title}</span>
          <button className={styles.iconBtn} onClick={onClose} aria-label="Close"><X size={16} /></button>
        </div>
        {children}
      </div>
    </div>
  );
}
