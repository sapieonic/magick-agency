import { useCallback, useEffect, useId, useRef, type RefObject } from 'react';

const FOCUSABLE_SELECTOR =
  'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';
/** Opt-in marker for the control that should receive focus when the dialog opens, if not the first focusable one. */
const AUTOFOCUS_SELECTOR = '[data-autofocus="true"]';

interface UseDialogA11yOptions {
  open: boolean;
  onClose: () => void;
}

interface UseDialogA11yResult {
  /** Unique id for the visible heading — wire to aria-labelledby on the dialog root. */
  titleId: string;
  /** Attach to the dialog's outer content element (the one containing the heading and all focusable controls). */
  dialogRef: RefObject<HTMLDivElement>;
}

/**
 * Accessible dialog behavior for ad-hoc modal overlays that can't use the shared
 * Modal component: a stable title id for aria-labelledby, Escape-to-close, Tab
 * focus trapping, initial autofocus, and focus restore on close. Mirrors
 * components/common/Modal.tsx so every custom overlay behaves the same way.
 *
 * Initial focus goes to the first focusable control by default (usually the
 * close button, since it precedes the body in markup). Mark a more useful
 * target — e.g. a form's primary input — with `data-autofocus="true"` to
 * prefer it instead.
 */
export function useDialogA11y({ open, onClose }: UseDialogA11yOptions): UseDialogA11yResult {
  const dialogRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const titleId = useId();

  // Hold the latest onClose in a ref so handleKeyDown stays stable across renders.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      onCloseRef.current();
      return;
    }
    if (e.key === 'Tab' && dialogRef.current) {
      const focusable = dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
      if (focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (e.shiftKey) {
        if (document.activeElement === first) {
          e.preventDefault();
          last.focus();
        }
      } else if (document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    previousFocusRef.current = document.activeElement as HTMLElement | null;
    document.addEventListener('keydown', handleKeyDown);
    const timer = setTimeout(() => {
      const dialog = dialogRef.current;
      const preferred = dialog?.querySelector<HTMLElement>(AUTOFOCUS_SELECTOR);
      const target = preferred ?? dialog?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
      target?.focus();
    }, 50);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      clearTimeout(timer);
      previousFocusRef.current?.focus();
    };
  }, [open, handleKeyDown]);

  return { titleId, dialogRef };
}
