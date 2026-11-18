import { ErrorText } from '@magick-agency/web-ui/components/ErrorText';

interface FieldErrorProps {
  /** Stable id — pair with `fieldErrorId()` and the field's `aria-describedby`. */
  id: string;
  message: string | null | undefined;
  className?: string;
  /**
   * `false` for a finding the form shows as it is being edited: it is still linked to its
   * field by `aria-describedby`, so it is read with the field, but it is not announced as an
   * alert on every keystroke. Defaults to announcing, for an answer to a save.
   */
  announce?: boolean;
}

/**
 * Field-level validation error, announced via `role="alert"` and referenced by
 * the field's `aria-describedby`. Renders nothing when there's no message, so
 * the `aria-describedby` reference never dangles.
 */
export function FieldError({ id, message, className, announce = true }: FieldErrorProps) {
  if (!message) return null;
  return (
    <p id={id} role={announce ? 'alert' : undefined} className={className}>
      <ErrorText message={message} />
    </p>
  );
}
