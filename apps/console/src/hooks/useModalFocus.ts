import { useEffect, useRef, type RefObject } from 'react';

/** What a Tab cycle considers reachable. Same list `Modal` uses. */
const FOCUSABLE =
  'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

/**
 * The three things a modal owes a keyboard user, as one hook.
 *
 *  1. **Move focus in** when it opens. Otherwise focus stays on the trigger
 *     behind the overlay, and the first Tab walks the page underneath rather
 *     than reaching the dialog.
 *  2. **Trap Tab** inside it while it is open, so the page behind an
 *     `aria-modal="true"` element is not silently reachable — which makes the
 *     `aria-modal` claim false for exactly the users who depend on it.
 *  3. **Restore focus** to the trigger on close, so the next keystroke goes
 *     where the user left off instead of to `<body>`.
 *
 * `Modal` (`components/common/Modal.tsx`) has implemented this inline since long
 * before this hook existed; it is deliberately left alone rather than migrated
 * in a feature branch, since every dialog in the product depends on its exact
 * timing. New dialogs that cannot use `Modal` — because they own their own
 * overlay and layout — take this instead of a third copy.
 *
 * The initial focus is deferred a tick, matching `Modal`: the dialog's first
 * render may not have laid out its content yet, and focusing a node that is
 * about to be replaced silently does nothing.
 *
 * @param open whether the dialog is mounted and visible
 * @param dialogRef the dialog panel — NOT the overlay, or the trap would count
 *   the overlay itself as focusable
 */
export function useModalFocus(open: boolean, dialogRef: RefObject<HTMLElement | null>): void {
  const previousFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    previousFocusRef.current = document.activeElement as HTMLElement | null;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Tab' || !dialogRef.current) return;
      const focusable = dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE);
      if (focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      // Only the two edges are intercepted. Everything in between is the
      // browser's own order, which is the one the user expects and the one that
      // stays correct as the dialog's content changes.
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown);
    const timer = setTimeout(() => {
      dialogRef.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
    }, 50);

    return () => {
      document.removeEventListener('keydown', onKeyDown);
      clearTimeout(timer);
      // Guarded: the trigger can have unmounted while the dialog was open (a
      // row that was filtered away), and `focus()` on a detached node is a
      // no-op rather than an error — but the optional chain also covers the
      // case where nothing was focused when the dialog opened.
      previousFocusRef.current?.focus();
    };
  }, [open, dialogRef]);
}
