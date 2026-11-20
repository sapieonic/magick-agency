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
const NO_QUIET_FIELDS: ReadonlySet<string> = new Set();

export interface ConfigFieldErrors {
  /** The ids of these fields' errors, for `aria-describedby`, or `undefined` when none has one. */
  describedBy: (...fields: string[]) => string | undefined;
  /** The error for this field, rendered with its id — or nothing. */
  render: (field: string) => ReactNode;
  /** The error's text for this field, or `null`: for a field that has to know when a new one arrives. */
  message: (field: string) => string | null;
}

/**
 * `quiet`: fields whose message is the form's own live finding rather than an answer to a
 * save. They render without `role="alert"` (see `FieldError`'s `announce`).
 */
export function useConfigFieldErrors(
  fieldErrors: Record<string, string>,
  quiet: ReadonlySet<string> = NO_QUIET_FIELDS,
): ConfigFieldErrors {
  const idBase = useId();
  // Every other character spelled as its code, so two fields never share an id ("a b", "a-b").
  const errorId = (field: string) => `${idBase}-${field.replace(/[^A-Za-z0-9_]/g, (c) => `-${c.codePointAt(0)!.toString(16)}-`)}`;
  const message = (field: string) => fieldErrors[field] ?? null;
  return {
    describedBy: (...fields) => {
      const ids = fields.filter((field) => message(field) !== null).map(errorId);
      return ids.length > 0 ? ids.join(' ') : undefined;
    },
    render: (field) => (
      <FieldError id={errorId(field)} message={message(field)} className="error-text" announce={!quiet.has(field)} />
    ),
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
  // The form's own live findings first: they are what holds Save. A server refusal is kept
  // until the next save and can sit on a field that has since been fixed.
  const first = container.querySelector<HTMLElement>('.error-text[id][data-live]')
    ?? container.querySelector<HTMLElement>(FIELD_ERROR_SELECTOR);
  if (!first) return false;
  const described = first.matches('[aria-invalid="true"]')
    ? first
    : first.id
      ? Array.from(container.querySelectorAll<HTMLElement>('[aria-describedby]')).find((element) =>
        (element.getAttribute('aria-describedby') ?? '').split(/\s+/).includes(first.id),
      )
      : undefined;
  // A group (`fieldset`) cannot take focus itself: its first control does.
  const control = described && !described.matches(FOCUSABLE)
    ? described.querySelector<HTMLElement>(FOCUSABLE) ?? undefined
    : described;
  (control ?? first).scrollIntoView?.({ block: 'center', behavior: 'smooth' });
  control?.focus({ preventScroll: true });
  return true;
}

/**
 * What marks a field as wrong: a control marked invalid, a `FieldError` from
 * `useConfigFieldErrors`, or a page's own error markup flagged `data-field-error`.
 */
const FIELD_ERROR_SELECTOR = '[aria-invalid="true"], .error-text[id], [data-field-error]';
const FOCUSABLE = 'input:not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled])';
