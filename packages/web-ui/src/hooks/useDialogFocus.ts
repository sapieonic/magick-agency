import { useEffect, useRef, type RefObject } from 'react';

/** What a Tab cycle considers reachable inside a dialog. */
export const FOCUSABLE_SELECTOR =
  'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

/** Opt-in marker for the control that should take focus when a dialog opens. */
export const AUTOFOCUS_SELECTOR = '[data-autofocus="true"]';

/**
 * Keep a Tab keypress inside `container`: from the last focusable control Tab
 * wraps to the first, and from the first Shift+Tab wraps to the last.
 *
 * Only the two edges are intercepted. Everything in between is the browser's own
 * order, which is the one the user expects and the one that stays correct as the
 * container's content changes. Returns whether the event was a Tab (handled or
 * not), so a caller's own key handler can stop there.
 */
export function trapTab(event: KeyboardEvent, container: HTMLElement | null): boolean {
  if (event.key !== 'Tab') return false;
  if (!container) return true;
  const focusable = container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
  if (focusable.length === 0) return true;
  const first = focusable[0]!;
  const last = focusable[focusable.length - 1]!;
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
  return true;
}

export interface DialogFocusOptions {
  /** Whether the dialog is mounted and visible. */
  open: boolean;
  /** The dialog panel — NOT the overlay, or the trap would count the overlay itself. */
  dialogRef: RefObject<HTMLElement | null>;
  /** Called on Escape. Omit for a dialog Escape does not close. */
  onEscape?: () => void;
  /**
   * The control to focus on open. Otherwise the first `[data-autofocus="true"]`
   * inside the dialog, otherwise its first focusable control.
   */
  initialFocusRef?: RefObject<HTMLElement | null>;
}

/**
 * What a modal owes a keyboard user — the ONE implementation of it.
 *
 *  1. **Move focus in** when it opens. Otherwise focus stays on the trigger
 *     behind the overlay, and the first Tab walks the page underneath.
 *  2. **Trap Tab** inside it while it is open ({@link trapTab}), so the page
 *     behind an `aria-modal="true"` element is not silently reachable — which
 *     makes the `aria-modal` claim false for exactly the users who depend on it.
 *  3. **Escape** calls `onEscape`, when given.
 *  4. **Restore focus** to the trigger on close, so the next keystroke goes where
 *     the user left off instead of to `<body>`.
 *
 * `Modal`, `ConfirmDialog` and the console's `useDialogA11y` / `useModalFocus`
 * each carried a copy of this, and they had drifted on initial focus and on
 * whether a caller's inline `onClose` re-armed the open effect (re-saving the
 * "previous" focus and re-focusing the dialog mid-typing).
 *
 * `onEscape` is held in a ref, so an inline callback never re-runs the open
 * effect. The initial focus is deferred a tick: the dialog's first render may
 * not have laid out its content yet, and focusing a node that is about to be
 * replaced silently does nothing.
 */
export function useDialogFocus({ open, dialogRef, onEscape, initialFocusRef }: DialogFocusOptions): void {
  const onEscapeRef = useRef(onEscape);
  useEffect(() => {
    onEscapeRef.current = onEscape;
  });

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onEscapeRef.current?.();
        return;
      }
      trapTab(event, dialogRef.current);
    };
    document.addEventListener('keydown', onKeyDown);

    const timer = setTimeout(() => {
      const dialog = dialogRef.current;
      const target = initialFocusRef?.current
        ?? dialog?.querySelector<HTMLElement>(AUTOFOCUS_SELECTOR)
        ?? dialog?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
      target?.focus();
    }, 50);

    return () => {
      document.removeEventListener('keydown', onKeyDown);
      clearTimeout(timer);
      // The trigger can have unmounted while the dialog was open (a row that was
      // filtered away); `focus()` on a detached node is a no-op, not an error.
      previous?.focus();
    };
  }, [open, dialogRef, initialFocusRef]);
}
