import { useId, useState } from 'react';
import { FlagDialog } from './FlagDialog';
import { parseStrictInteger } from '../../../utils/strictInteger';
import styles from './featureFlags.module.css';

interface Props {
  /** Header copy, e.g. `Set Pre-warm ring delay (ms)`. */
  title: string;
  /** Optional short caption above the value input (units, guidance). */
  hint?: string;
  /** Prefilled value (as-string; empty means blank). */
  initialValue?: string;
  /** Inclusive lower bound enforced client-side; server re-validates. */
  min?: number;
  /** Inclusive upper bound enforced client-side; server re-validates. */
  max?: number;
  /** Increment for the number input's spinner/keyboard steppers. */
  step?: number;
  busy?: boolean;
  /** Called with the parsed integer, trimmed reason, and raw datetime-local expiry. */
  onSubmit: (value: number, reason: string, expiresAt: string) => void;
  onClose: () => void;
}

/**
 * Captures an integer value + audit reason (+ optional expiry) before committing
 * a numeric feature-flag override. The reason threads into the audit log
 * server-side. Client-side bounds mirror the flag registry's `validate` fn
 * (e.g. `prewarm_ring_delay_ms`: 0..30000); server rejects out-of-range with
 * 422 as a defense-in-depth. Enter submits when the form is valid.
 */
export function NumberFlagDialog({
  title,
  hint,
  initialValue = '',
  min,
  max,
  step = 1,
  busy,
  onSubmit,
  onClose,
}: Props) {
  const [value, setValue] = useState(initialValue);
  const [reason, setReason] = useState('');
  const [expiresAt, setExpiresAt] = useState('');

  const valueId = useId();
  const valueErrorId = useId();
  const reasonId = useId();
  const expiryId = useId();

  const parsed = parseStrictInteger(value);
  // Distinguish "not entered yet" (empty) from "entered but invalid" so we don't
  // yell at the user before they've typed anything.
  const isEmpty = value.trim() === '';
  const isInvalidShape = !isEmpty && parsed === null;
  const inBounds =
    parsed !== null &&
    (min === undefined || parsed >= min) &&
    (max === undefined || parsed <= max);
  const reasonValid = reason.trim().length > 0;
  const valid = inBounds && reasonValid;

  const valueError = isEmpty
    ? null
    : isInvalidShape
      ? 'Must be a whole number'
      : min !== undefined && parsed! < min
        ? `Must be ≥ ${min}`
        : max !== undefined && parsed! > max
          ? `Must be ≤ ${max}`
          : null;

  const submit = () => {
    if (!valid || busy || parsed === null) return;
    onSubmit(parsed, reason.trim(), expiresAt);
  };

  return (
    <FlagDialog title={title} onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <label className={styles.fieldLabel} htmlFor={valueId}>
          Value{min !== undefined && max !== undefined ? ` (${min}..${max})` : ''}
        </label>
        <input
          id={valueId}
          className={styles.input}
          type="number"
          inputMode="numeric"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={hint}
          aria-invalid={valueError !== null}
          aria-describedby={valueError ? valueErrorId : undefined}
          autoFocus
        />
        {valueError && (
          <div className={styles.error} id={valueErrorId} role="alert">
            {valueError}
          </div>
        )}

        <label className={styles.fieldLabel} htmlFor={reasonId}>Reason (required)</label>
        <input
          id={reasonId}
          className={styles.input}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Why is this changing? (shown in the audit log)"
        />

        <label className={styles.fieldLabel} htmlFor={expiryId}>Expires (optional)</label>
        <input
          id={expiryId}
          type="datetime-local"
          className={styles.input}
          value={expiresAt}
          onChange={(e) => setExpiresAt(e.target.value)}
        />

        <div className={styles.popoverActions}>
          <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
          <button
            type="submit"
            className="btn-primary"
            disabled={!valid || busy}
          >
            Save override
          </button>
        </div>
      </form>
    </FlagDialog>
  );
}
