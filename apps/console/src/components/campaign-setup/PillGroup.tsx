import { useId, type ReactNode } from 'react';
import styles from './PillGroup.module.css';

export interface PillOption<V extends string = string> {
  value: V;
  label: ReactNode;
  /** The name read out when the label is short ("M" for Monday). */
  ariaLabel?: string;
  disabled?: boolean;
}

type Single<V extends string> = { multiple?: false; value: V | null; onChange: (v: V) => void };
type Multi<V extends string> = { multiple: true; value: readonly V[]; onChange: (v: V[]) => void };

export type PillGroupProps<V extends string = string> = (Single<V> | Multi<V>) & {
  options: readonly PillOption<V>[];
  legend: ReactNode;
  hideLegend?: boolean;
  size?: 'sm' | 'md';
  /** The radios' `name` in single mode; one is made up when left out. */
  name?: string;
  disabled?: boolean;
  describedBy?: string;
  testId?: string;
};

/**
 * A row of pill toggles inside a fieldset.
 *
 * - multi (`multiple: true`): `<button aria-pressed>` per pill, each toggled on its own (days of
 *   the week). `onChange` gets the new selection in the options' order.
 * - single: real radio inputs, visually hidden under pill labels, so the group is a radio group
 *   with native arrow-key movement (hour presets).
 */
export function PillGroup<V extends string = string>(props: PillGroupProps<V>) {
  const { options, legend, hideLegend = false, size = 'md', name, disabled = false, describedBy, testId } = props;
  const uid = useId();

  function toggle(v: V) {
    if (!props.multiple) return;
    const selected = new Set<V>(props.value);
    if (selected.has(v)) selected.delete(v);
    else selected.add(v);
    props.onChange(options.map((o) => o.value).filter((x) => selected.has(x)));
  }

  return (
    <fieldset className={styles.root} disabled={disabled} aria-describedby={describedBy} data-testid={testId}>
      <legend className={hideLegend ? 'sr-only' : styles.legend}>{legend}</legend>
      <div className={styles.row}>
        {options.map((option) => {
          if (props.multiple) {
            const pressed = props.value.includes(option.value);
            return (
              <button
                key={option.value}
                type="button"
                className={styles.pill}
                data-size={size}
                data-selected={pressed || undefined}
                aria-pressed={pressed}
                aria-label={option.ariaLabel}
                disabled={option.disabled}
                onClick={() => toggle(option.value)}
              >
                {option.label}
              </button>
            );
          }
          const checked = props.value === option.value;
          const single = props;
          return (
            <label
              key={option.value}
              className={styles.pill}
              data-size={size}
              data-selected={checked || undefined}
              data-disabled={disabled || option.disabled || undefined}
            >
              <input
                type="radio"
                className="sr-only"
                name={name ?? `pills-${uid}`}
                value={option.value}
                checked={checked}
                disabled={option.disabled}
                aria-label={option.ariaLabel}
                onChange={(e) => {
                  if (e.target.checked) single.onChange(option.value);
                }}
              />
              {option.label}
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
