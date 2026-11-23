import type { ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import styles from './SentenceSelect.module.css';

export interface SentenceSelectOption<V extends string = string> {
  value: V;
  label: string;
  disabled?: boolean;
}

export interface SentenceSelectProps<V extends string = string> {
  value: V;
  onChange: (v: V) => void;
  options: readonly SentenceSelectOption<V>[];
  /** Required: the sentence around the chip is not its label. */
  ariaLabel: string;
  disabled?: boolean;
  invalid?: boolean;
  describedBy?: string;
  id?: string;
  testId?: string;
}

/**
 * A native `<select>` drawn as an accent chip with a small caret, to sit inside a line of prose
 * ("Try again *3 times*, every *2 hours*"). Native, so the phone's own picker opens on a tap.
 */
export function SentenceSelect<V extends string = string>({
  value,
  onChange,
  options,
  ariaLabel,
  disabled = false,
  invalid = false,
  describedBy,
  id,
  testId,
}: SentenceSelectProps<V>) {
  return (
    <span className={styles.wrap} data-invalid={invalid || undefined} data-disabled={disabled || undefined}>
      <select
        id={id}
        className={styles.chip}
        value={value}
        disabled={disabled}
        aria-label={ariaLabel}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        data-testid={testId}
        onChange={(e) => {
          const next = options.find((o) => o.value === e.target.value);
          if (next) onChange(next.value);
        }}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value} disabled={o.disabled}>
            {o.label}
          </option>
        ))}
      </select>
      <ChevronDown className={styles.caret} size={14} strokeWidth={2.5} aria-hidden="true" />
    </span>
  );
}

export interface SentenceProps {
  children: ReactNode;
  /** `p` (default) for a sentence that stands alone; `div` when it holds block content. */
  as?: 'p' | 'div';
  id?: string;
  testId?: string;
}

/** A line of prose that carries SentenceSelect chips and wraps them cleanly on a narrow screen. */
export function Sentence({ children, as = 'p', id, testId }: SentenceProps) {
  const Tag = as;
  return (
    <Tag className={styles.sentence} id={id} data-testid={testId}>
      {children}
    </Tag>
  );
}
