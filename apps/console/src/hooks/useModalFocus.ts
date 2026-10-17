import type { RefObject } from 'react';
import { useDialogFocus } from '@magick-agency/web-ui/hooks/useDialogFocus';

/**
 * Focus in on open, Tab trapped while open, focus restored on close — for a
 * dialog that owns its overlay and handles Escape itself (`AgencyRetryDialog`).
 *
 * A thin name over `useDialogFocus`, the one implementation `Modal`,
 * `ConfirmDialog` and `useDialogA11y` share; this one passes no `onEscape`.
 *
 * @param open whether the dialog is mounted and visible
 * @param dialogRef the dialog panel — NOT the overlay, or the trap would count
 *   the overlay itself as focusable
 */
export function useModalFocus(open: boolean, dialogRef: RefObject<HTMLElement | null>): void {
  useDialogFocus({ open, dialogRef });
}
