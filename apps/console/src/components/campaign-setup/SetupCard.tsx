import { useId, type ReactNode, type Ref } from 'react';
import styles from './SetupCard.module.css';

export interface SetupCardProps {
  title?: ReactNode;
  helper?: ReactNode;
  headingLevel?: 2 | 3;
  /** Right of the heading, e.g. "Change columns". */
  actions?: ReactNode;
  children: ReactNode;
  id?: string;
  testId?: string;
  /** The heading takes `tabIndex={-1}`, so a step change can move focus to it. */
  headingRef?: Ref<HTMLHeadingElement>;
}

/** The white panel a step's content sits in; a `<section>` named by its heading. */
export function SetupCard({
  title,
  helper,
  headingLevel = 2,
  actions,
  children,
  id,
  testId,
  headingRef,
}: SetupCardProps) {
  const uid = useId();
  const headingId = `${uid}-heading`;
  const Heading = headingLevel === 3 ? 'h3' : 'h2';
  const hasHeader = title != null || helper != null || actions != null;
  return (
    <section
      className={styles.card}
      id={id}
      data-testid={testId}
      aria-labelledby={title != null ? headingId : undefined}
    >
      {hasHeader ? (
        <header className={styles.header}>
          <div className={styles.headText}>
            {title != null ? (
              <Heading className={styles.title} id={headingId} ref={headingRef} tabIndex={-1}>
                {title}
              </Heading>
            ) : null}
            {helper != null ? <p className={styles.helper}>{helper}</p> : null}
          </div>
          {actions != null ? <div className={styles.actions}>{actions}</div> : null}
        </header>
      ) : null}
      <div className={styles.body}>{children}</div>
    </section>
  );
}

export interface SetupSectionProps {
  title?: ReactNode;
  helper?: ReactNode;
  headingLevel?: 3 | 4;
  actions?: ReactNode;
  children: ReactNode;
  id?: string;
  testId?: string;
}

/** A titled block inside a SetupCard ("When to call", "If they don't pick up"). */
export function SetupSection({
  title,
  helper,
  headingLevel = 3,
  actions,
  children,
  id,
  testId,
}: SetupSectionProps) {
  const uid = useId();
  const headingId = `${uid}-heading`;
  const Heading = headingLevel === 4 ? 'h4' : 'h3';
  const hasHeader = title != null || helper != null || actions != null;
  return (
    <section
      className={styles.section}
      id={id}
      data-testid={testId}
      aria-labelledby={title != null ? headingId : undefined}
    >
      {hasHeader ? (
        <div className={styles.sectionHeader}>
          <div className={styles.headText}>
            {title != null ? (
              <Heading className={styles.sectionTitle} id={headingId}>
                {title}
              </Heading>
            ) : null}
            {helper != null ? <p className={styles.sectionHelper}>{helper}</p> : null}
          </div>
          {actions != null ? <div className={styles.actions}>{actions}</div> : null}
        </div>
      ) : null}
      {children}
    </section>
  );
}

export interface SetupColumnsProps {
  children: ReactNode;
  /** `even` (default): two equal columns; `main-aside`: a wider first column (buttons beside the preview). */
  split?: 'even' | 'main-aside';
  testId?: string;
}

/**
 * Two columns when there is room (its own width at least 760px, about a 1000px window beside the
 * sidebar), one below. Each child is a column.
 */
export function SetupColumns({ children, split = 'even', testId }: SetupColumnsProps) {
  return (
    <div className={styles.columnsOuter} data-testid={testId}>
      <div className={styles.columns} data-split={split}>
        {children}
      </div>
    </div>
  );
}
