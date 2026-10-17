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
  };
}
