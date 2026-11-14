import type { CSSProperties, ReactNode } from 'react';
import styles from './PanelGrid.module.css';

/**
 * Sibling panels (or sibling tables inside one panel) side by side when each
 * still gets `min` pixels, stacked when it would not.
 *
 * On a wide screen a three-column table stretched across the whole content
 * width put its label and its number two thousand pixels apart; two such tables
 * beside each other halve that and use the space the second one sat under. On
 * a laptop or a phone they stack as before.
 */
export function PanelGrid({
  children,
  min = 520,
  testId,
}: {
  children: ReactNode;
  /** The narrowest a column may get before the grid stacks. */
  min?: number;
  testId?: string;
}) {
  return (
    <div className={styles.grid} style={{ '--panel-min': `${min}px` } as CSSProperties} data-testid={testId}>
      {children}
    </div>
  );
}
