import { ErrorText } from './ErrorText';

interface FieldErrorProps {
  /** Stable id — pair with `fieldErrorId()` and the field's `aria-describedby`. */
  id: string;
  message: string | null | undefined;
  className?: string;
}

/**
 * Field-level validation error, announced via `role="alert"` and referenced by
 * the field's `aria-describedby`. Renders nothing when there's no message, so
 * the `aria-describedby` reference never dangles.
 */
export function FieldError({ id, message, className }: FieldErrorProps) {
  if (!message) return null;
  return (
    <p id={id} role="alert" className={className}>
      <ErrorText message={message} />
    </p>
  );
}
