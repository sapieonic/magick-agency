import { useId, type ReactNode } from 'react';
import styles from './SwitchRow.module.css';

export interface SwitchProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  id?: string;
  /** One of `ariaLabel` or `labelledBy` names the switch. */
  ariaLabel?: string;
  labelledBy?: string;
  describedBy?: string;
  testId?: string;
}

/** A green on/off switch: `<button role="switch" aria-checked>`. */
export function Switch({
  checked,
  onChange,
  disabled = false,
  id,
  ariaLabel,
  labelledBy,
  describedBy,
  testId,
}: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      id={id}
      className={styles.switch}
      aria-checked={checked}
      aria-label={ariaLabel}
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      disabled={disabled}
      data-testid={testId}
      onClick={() => onChange(!checked)}
    >
      <span className={styles.thumb} aria-hidden="true" />
    </button>
  );
}

/** Ids a custom `control` can use to name itself after the row. */
export interface SwitchRowControlIds {
  labelId: string;
  describedBy: string | undefined;
}

export interface SwitchRowProps {
  label: ReactNode;
  hint?: ReactNode;
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  /** Shown under the label, and read with the switch, while the row is disabled. */
  disabledReason?: ReactNode;
  /** The switch's id. */
  id?: string;
  /**
   * Replaces the switch (e.g. a SentenceSelect for "30 sec"). A function gets the row's label and
   * hint ids, so the control can be named by the row.
   */
  control?: ReactNode | ((ids: SwitchRowControlIds) => ReactNode);
  /** On the row; the switch gets `${testId}-switch`. */
  testId?: string;
}

/**
 * A setting as a row: label and hint on the left, the switch on the right. Stacked rows are
 * separated by a divider. Clicking the label flips the switch.
 */
export function SwitchRow({
  label,
  hint,
  checked,
  onChange,
  disabled = false,
  disabledReason,
  id,
  control,
  testId,
}: SwitchRowProps) {
  const uid = useId();
  const switchId = id ?? `${uid}-switch`;
  const labelId = `${uid}-label`;
  const hintId = hint != null ? `${uid}-hint` : null;
  const reasonId = disabled && disabledReason != null ? `${uid}-reason` : null;
  const describedBy = [hintId, reasonId].filter(Boolean).join(' ') || undefined;

  return (
    <div className={styles.row} data-disabled={disabled || undefined} data-testid={testId}>
      <div className={styles.text}>
        {control === undefined ? (
          <label className={styles.label} id={labelId} htmlFor={switchId}>
            {label}
          </label>
        ) : (
          <span className={styles.label} id={labelId}>
            {label}
          </span>
        )}
        {hintId ? (
          <span className={styles.hint} id={hintId}>
            {hint}
          </span>
        ) : null}
        {reasonId ? (
          <span className={styles.reason} id={reasonId}>
            {disabledReason}
          </span>
        ) : null}
      </div>
      <div className={styles.control}>
        {control === undefined ? (
          <Switch
            id={switchId}
            checked={checked}
            onChange={onChange}
            disabled={disabled}
            labelledBy={labelId}
            describedBy={describedBy}
            testId={testId ? `${testId}-switch` : undefined}
          />
        ) : typeof control === 'function' ? (
          control({ labelId, describedBy })
        ) : (
          control
        )}
      </div>
    </div>
  );
}
