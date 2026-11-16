import type { ReactNode } from 'react';
import { LabelWithHint } from '@magick-agency/web-ui/components/HelpTooltip';
import styles from './Kpi.module.css';

/**
 * One figure: label, value, and an optional line beneath. `filled` is the Insights panels' look;
 * `outlined` is Home's Today so far. `hint` sits beside the label (hover and click).
 */
export function Kpi({
  label,
  hint,
  value,
  sub,
  withheld,
  testId,
  look = 'filled',
}: {
  label: string;
  /** Extra words for the label, on hover and click. */
  hint?: string;
  value: ReactNode;
  sub?: ReactNode;
  /** The value is a "Not enough calls yet" or a dash, styled down. */
  withheld?: boolean;
  testId?: string;
  look?: 'filled' | 'outlined';
}) {
  return (
    <div className={`${styles.kpi} ${styles[look]}`} data-testid={testId}>
      <span className={styles.label}>
        {hint ? <LabelWithHint label={label} hint={hint} /> : label}
      </span>
      <span className={styles.value} data-withheld={String(Boolean(withheld))}>{value}</span>
      {sub ? <span className={styles.sub} data-part="sub">{sub}</span> : null}
    </div>
  );
}
