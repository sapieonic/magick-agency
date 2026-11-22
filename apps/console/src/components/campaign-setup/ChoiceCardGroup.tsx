import { useId, type CSSProperties, type ReactNode } from 'react';
import styles from './ChoiceCardGroup.module.css';

export interface ChoiceCardOption<V extends string = string> {
  value: V;
  title: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  /** Right-aligned muted text beside the title, e.g. an agent's languages or a tag. */
  aside?: ReactNode;
  disabled?: boolean;
  /** Shown on the card, and read with it, while the option is disabled. */
  disabledReason?: string;
}

type Single<V extends string> = { multiple?: false; value: V | null; onChange: (v: V) => void };
type Multi<V extends string> = { multiple: true; value: readonly V[]; onChange: (v: V[]) => void };

export type ChoiceCardGroupProps<V extends string = string> = (Single<V> | Multi<V>) & {
  options: readonly ChoiceCardOption<V>[];
  /** The group's name: a fieldset legend, visually hidden with `hideLegend`. */
  legend: ReactNode;
  hideLegend?: boolean;
  /** The inputs' `name`; one is made up when left out. */
  name?: string;
  /** `auto` fills the row with as many cards as fit. Narrow containers drop to two, then one. */
  columns?: 1 | 2 | 3 | 4 | 5 | 'auto';
  size?: 'md' | 'lg';
  /** `control` (default) shows the radio or tick box on the card; `none` keeps it for keyboards only. */
  indicator?: 'control' | 'none';
  disabled?: boolean;
  describedBy?: string;
  testId?: string;
};

/**
 * Large selectable cards over real radio or checkbox inputs: each card is the input's label, so
 * a click anywhere on it, the arrow keys (radios) and Space (tick boxes) all work, and a screen
 * reader hears a radio group or a set of tick boxes. The input's name is the card's title; the
 * description, aside and disabled reason are read as its description.
 *
 * In multi mode `onChange` gets the new selection in the options' order.
 */
export function ChoiceCardGroup<V extends string = string>(props: ChoiceCardGroupProps<V>) {
  const {
    options,
    legend,
    hideLegend = false,
    name,
    columns = 'auto',
    size = 'md',
    indicator = 'control',
    disabled = false,
    describedBy,
    testId,
  } = props;
  const uid = useId();
  const groupName = name ?? `choice-${uid}`;

  const isChecked = (v: V): boolean => (props.multiple ? props.value.includes(v) : props.value === v);

  function change(v: V, checked: boolean) {
    if (props.multiple) {
      const selected = new Set<V>(props.value);
      if (checked) selected.add(v);
      else selected.delete(v);
      props.onChange(options.map((o) => o.value).filter((x) => selected.has(x)));
    } else if (checked) {
      props.onChange(v);
    }
  }

  const gridStyle =
    columns === 'auto' ? undefined : ({ '--choice-columns': String(columns) } as CSSProperties);

  return (
    <fieldset
      className={styles.root}
      disabled={disabled}
      aria-describedby={describedBy}
      data-testid={testId}
    >
      <legend className={hideLegend ? 'sr-only' : styles.legend}>{legend}</legend>
      <div className={styles.grid} data-columns={columns} style={gridStyle}>
        {options.map((option, index) => {
          const checked = isChecked(option.value);
          const optionDisabled = disabled || (option.disabled ?? false);
          const base = `${uid}-${index}`;
          const reason = option.disabled && option.disabledReason ? option.disabledReason : null;
          const described = [
            option.aside != null ? `${base}-aside` : null,
            option.description != null ? `${base}-description` : null,
            reason ? `${base}-reason` : null,
          ]
            .filter(Boolean)
            .join(' ');
          return (
            <label
              key={option.value}
              className={styles.card}
              data-size={size}
              data-selected={checked || undefined}
              data-disabled={optionDisabled || undefined}
            >
              <input
                type={props.multiple ? 'checkbox' : 'radio'}
                className={indicator === 'none' ? 'sr-only' : styles.control}
                name={groupName}
                value={option.value}
                checked={checked}
                disabled={option.disabled}
                aria-labelledby={`${base}-title`}
                aria-describedby={described || undefined}
                onChange={(e) => change(option.value, e.target.checked)}
              />
              {option.icon != null ? (
                <span className={styles.icon} aria-hidden="true">
                  {option.icon}
                </span>
              ) : null}
              <span className={styles.body}>
                <span className={styles.titleRow}>
                  <span className={styles.title} id={`${base}-title`}>
                    {option.title}
                  </span>
                  {option.aside != null ? (
                    <span className={styles.aside} id={`${base}-aside`}>
                      {option.aside}
                    </span>
                  ) : null}
                </span>
                {option.description != null ? (
                  <span className={styles.description} id={`${base}-description`}>
                    {option.description}
                  </span>
                ) : null}
                {reason ? (
                  <span className={styles.reason} id={`${base}-reason`}>
                    {reason}
                  </span>
                ) : null}
              </span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
