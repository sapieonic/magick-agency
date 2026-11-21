import { useId, type ReactNode } from 'react';
import styles from './Compare.module.css';

/** One of Compare agents' cards: a section named by its own heading, with an optional note beside it. */
export function CompareCard({
  title,
  sub,
  headClassName = styles.cardHead,
  children,
}: {
  title: string;
  /** Beside the title, muted; none when null or absent. */
  sub?: ReactNode;
  /** The heading row's layout: the agent picker's spaces its note further out. */
  headClassName?: string;
  children: ReactNode;
}) {
  const titleId = useId();
  return (
    <section className={styles.card} aria-labelledby={titleId}>
      <div className={headClassName}>
        <h2 className={styles.cardTitle} id={titleId}>
          {title}
        </h2>
        {sub ? <span className={styles.cardSub}>{sub}</span> : null}
      </div>
      {children}
    </section>
  );
}
