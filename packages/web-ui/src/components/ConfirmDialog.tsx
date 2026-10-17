import { useEffect, useCallback, useRef } from 'react';
import styles from './ConfirmDialog.module.css';

/**
 * Constant rather than `useId`, to match `confirm-dialog-title` immediately
 * below it — this is a modal, so two are never open at once.
 */
const SECONDARY_HINT_ID = 'confirm-dialog-secondary-hint';

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  danger?: boolean;
  disabled?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  /**
   * A second, distinct action beside Cancel/Confirm — for an escalation the
   * agent must reach deliberately rather than land on as the default choice
   * (e.g. mark-DNC's tenant-wide "Never call again", beside the campaign-scoped
   * default). Omitted entirely unless a caller passes both `secondaryLabel` and
   * `onSecondary`, so every existing two-button dialog is unchanged.
   */
  secondaryLabel?: string;
  /**
   * Rendered above the secondary button only, so its weight cannot be missed —
   * and wired to that button with `aria-describedby`, so the "this one is
   * different and permanent" signal is not carried by colour and a border alone.
   */
  secondaryHint?: string;
  secondaryDisabled?: boolean;
  onSecondary?: () => void;
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = 'Confirm',
  danger = false,
  disabled = false,
  onConfirm,
  onCancel,
  secondaryLabel,
  secondaryHint,
  secondaryDisabled = false,
  onSecondary,
}: ConfirmDialogProps) {
  const showSecondary = Boolean(secondaryLabel && onSecondary);
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onCancel();
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
    },
    [onCancel],
  );

  useEffect(() => {
    if (!open) return;
    // Save the element that was focused before the dialog opened
    previousFocusRef.current = document.activeElement as HTMLElement | null;
    document.addEventListener('keydown', handleKeyDown);
    // Auto-focus the cancel button when dialog opens. Addressed by ref rather
    // than `querySelector('button')`: that only ever meant "Cancel" because
    // Cancel happened to be first in the DOM, so any future reordering of the
    // footer would silently move the default focus onto an action button.
    const timer = setTimeout(() => {
      cancelRef.current?.focus();
    }, 50);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      clearTimeout(timer);
      // Restore focus to the element that triggered the dialog
      previousFocusRef.current?.focus();
    };
  }, [open, handleKeyDown]);

  if (!open) return null;

  return (
    <div className={styles.overlay} onClick={onCancel} role="dialog" aria-modal="true" aria-labelledby="confirm-dialog-title">
      <div className={styles.dialog} onClick={(e) => e.stopPropagation()} ref={dialogRef}>
        <div className={styles.header}>
          <h2 className={styles.title} id="confirm-dialog-title">{title}</h2>
        </div>
        <div className={styles.body}>
          <p className={styles.message}>{message}</p>
          {showSecondary && secondaryHint ? (
            <p
              className={styles.secondaryHint}
              id={SECONDARY_HINT_ID}
              data-testid="confirm-secondary-hint"
            >
              {secondaryHint}
            </p>
          ) : null}
        </div>
        {/*
          ── Footer order is a safety property, not a layout preference ────────
          The trap below wraps first ⇄ last, and focus opens on Cancel (first).
          So one Shift+Tab from the default focus lands on whatever is LAST, and
          Enter fires it with no further confirmation. While the escalation sat
          last, that reflex hit the irreversible workspace-wide action; before
          the escalation existed it hit the ordinary confirm. Keeping the primary
          confirm last restores that, and the escalation — which a caller only
          ever passes for a deliberate, harder-to-reach action — sits between the
          two, reachable only by tabbing onto it on purpose.

          With three focusable buttons and focus opening on Cancel, SOME action
          is one keystroke away in each direction; there is no arrangement that
          avoids it. This picks which one, and the wrap-around is the reflex.
        */}
        <div className={styles.footer}>
          <button
            type="button"
            className={styles.cancelButton}
            onClick={onCancel}
            ref={cancelRef}
          >
            Cancel
          </button>
          {showSecondary ? (
            <button
              type="button"
              className={`${styles.confirmButton} ${styles.confirmDanger}`}
              onClick={onSecondary}
              disabled={secondaryDisabled}
              // The hint is the only place the escalation's scope and
              // permanence are stated. Unwired, it reached sighted users through
              // colour and a border and reached assistive tech not at all.
              {...(secondaryHint ? { 'aria-describedby': SECONDARY_HINT_ID } : {})}
            >
              {secondaryLabel}
            </button>
          ) : null}
          <button
            type="button"
            className={`${styles.confirmButton} ${danger ? styles.confirmDanger : styles.confirmDefault}`}
            onClick={onConfirm}
            disabled={disabled}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
