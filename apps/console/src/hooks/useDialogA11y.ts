import { useId, useRef, type RefObject } from 'react';
import { useDialogFocus } from '@magick-agency/web-ui/hooks/useDialogFocus';

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
 * Accessible dialog behaviour for an overlay that owns its own markup: a stable
 * title id for `aria-labelledby`, plus the shared `useDialogFocus` — Escape to
 * close, Tab trapped, initial focus, focus restored on close. The same hook
 * `Modal` and `ConfirmDialog` use, so every overlay behaves the same way.
 *
 * Initial focus goes to a `[data-autofocus="true"]` control when one is marked
 * — e.g. a form's primary input — and to the first focusable control otherwise
 * (usually the close button, since it precedes the body in markup).
 */
export function useDialogA11y({ open, onClose }: UseDialogA11yOptions): UseDialogA11yResult {
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useDialogFocus({ open, dialogRef, onEscape: onClose });
  return { titleId, dialogRef };
}
