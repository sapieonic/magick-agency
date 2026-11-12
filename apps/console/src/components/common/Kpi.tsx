import type { ReactNode } from 'react';
import styles from './Kpi.module.css';

/**
 * One figure: label, value, and an optional line beneath. `filled` is the Insights panels' look;
 * `outlined` is Home's Today so far.
 */
export function Kpi({
  label,
  value,
  sub,
  withheld,
  testId,
  look = 'filled',
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  /** The value is a "Not enough calls yet" or a dash, styled down. */
  withheld?: boolean;
  testId?: string;
  look?: 'filled' | 'outlined';
}) {
  return (
    <div className={`${styles.kpi} ${styles[look]}`} data-testid={testId}>
      <span className={styles.label}>{label}</span>
      <span className={styles.value} data-withheld={String(Boolean(withheld))}>{value}</span>
      {sub ? <span className={styles.sub}>{sub}</span> : null}
    </div>
  );
}
