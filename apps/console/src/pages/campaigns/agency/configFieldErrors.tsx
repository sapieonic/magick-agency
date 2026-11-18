import { useId, type ReactNode } from 'react';
import { FieldError } from '../../../components/common/FieldError';

/**
 * The campaign config editors' field errors: each one with an id its field names
 * in `aria-describedby`, so a screen reader announces the reason with the field
 * rather than as a stray alert. A field references an error only while there is
 * one — `FieldError` renders nothing otherwise, and a dangling reference names
 * nothing.
 *
 * Keyed by body path (`calling_window_start`, `disposition_catalog[2].code`), so
 * a client finding and the server's `details` land on the same field.
 */
export interface ConfigFieldErrors {
  /** The ids of these fields' errors, for `aria-describedby`, or `undefined` when none has one. */
  describedBy: (...fields: string[]) => string | undefined;
  /** The error for this field, rendered with its id — or nothing. */
  render: (field: string) => ReactNode;
  /** The error's text for this field, or `null`: for a field that has to know when a new one arrives. */
  message: (field: string) => string | null;
}

export function useConfigFieldErrors(fieldErrors: Record<string, string>): ConfigFieldErrors {
  const idBase = useId();
  const errorId = (field: string) => `${idBase}-${field.replace(/[^A-Za-z0-9_-]/g, '-')}`;
  const message = (field: string) => fieldErrors[field] ?? null;
  return {
    describedBy: (...fields) => {
      const ids = fields.filter((field) => message(field) !== null).map(errorId);
      return ids.length > 0 ? ids.join(' ') : undefined;
    },
    render: (field) => <FieldError id={errorId(field)} message={message(field)} className="error-text" />,
    message,
  };
}

/**
 * Move focus to the first field on screen that has an error, and bring it into view.
 *
 * A finding renders as a `FieldError` (`.error-text`, with an id) that its control names in
 * `aria-describedby`, as `useConfigFieldErrors` wires it. The control takes focus, so a
 * keyboard user lands where the fix is typed. When no control names the error (a
 * section-level message), the message itself is scrolled to. A control marked
 * `aria-invalid` with its own error markup (a page's basics) counts too, whichever is
 * first on the page.
 */
export function focusFirstFieldError(container: HTMLElement): boolean {
  const first = container.querySelector<HTMLElement>('[aria-invalid="true"], .error-text[id]');
  if (!first) return false;
  const control = first.matches('[aria-invalid="true"]')
    ? first
    : Array.from(container.querySelectorAll<HTMLElement>('[aria-describedby]')).find((element) =>
      (element.getAttribute('aria-describedby') ?? '').split(/\s+/).includes(first.id),
    );
  const target = control ?? first;
  target.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
  if (control) control.focus({ preventScroll: true });
  return true;
}
