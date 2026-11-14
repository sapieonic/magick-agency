import { Children, Fragment, isValidElement, type ReactNode } from 'react';
import styles from './StatGrid.module.css';

/**
 * A row of figures (`Kpi` tiles) that always splits into even rows.
 *
 * `auto-fit` with a fixed tile floor, which every Insights panel used, filled
 * rows greedily: six tiles at a laptop's width came out as five and one, seven
 * as five and two, with the stranded tile alone beside a blank row. Here the
 * column count follows from how many tiles there are and how much room the grid
 * itself has (a container query, so a grid inside a narrow card reflows on its
 * own, not with the window): every tile on one row when they fit at a readable
 * width, otherwise an even split (seven as four and three, six as three and
 * three), and two abreast on a phone, where an odd last tile takes the whole row.
 */
export function StatGrid({
  children,
  testId,
  label,
}: {
  children: ReactNode;
  testId?: string;
  /** Names the group for assistive tech, when the panel heading does not already. */
  label?: string;
}) {
  const count = countTiles(children);
  return (
    <div className={styles.container}>
      <div
        className={styles.grid}
        data-count={count}
        data-odd={count % 2 === 1 ? 'true' : undefined}
        data-testid={testId}
        role={label ? 'group' : undefined}
        aria-label={label}
      >
        {children}
      </div>
    </div>
  );
}

/**
 * The tiles that will reach the DOM: a tile behind a condition that rendered
 * nothing is not one, and the tiles inside a fragment (`{cond ? <>…</> : …}`) are
 * each one, as the grid lays them out.
 */
export function countTiles(children: ReactNode): number {
  let n = 0;
  Children.forEach(children, (child) => {
    if (child === null || child === undefined || typeof child === 'boolean') return;
    if (isValidElement<{ children?: ReactNode }>(child) && child.type === Fragment) {
      n += countTiles(child.props.children);
      return;
    }
    n += 1;
  });
  return n;
}
