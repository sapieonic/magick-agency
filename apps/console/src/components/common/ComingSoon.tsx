import { useId, type ReactNode } from 'react';
import styles from './ComingSoon.module.css';

/** The words every coming-soon control carries, on screen and to a screen reader. */
export const COMING_SOON = 'Coming soon';

/**
 * The console's one "Coming soon" mark: a small badge beside a control or a heading for something
 * that is planned and has nothing behind it yet. `id` lets a control name it as its description.
 */
export function ComingSoonBadge({ id }: { id?: string }) {
  return (
    <span id={id} className={styles.badge} data-testid="coming-soon">
      {COMING_SOON}
    </span>
  );
}

/** The tooltip and description: what it will do, always ending in "Coming soon." */
export function comingSoonWords(tooltip?: string): string {
  if (!tooltip) return COMING_SOON;
  return tooltip.includes(COMING_SOON) ? tooltip : `${tooltip} ${COMING_SOON}.`;
}

/**
 * A control that will exist and does nothing yet: a real `<button disabled>` (never a link that
 * goes nowhere), with the badge beside it. Its accessible description is the badge's words, or the
 * tooltip's (what it will do, then "Coming soon."). The tooltip sits on the wrapper, because a
 * disabled button gets no pointer events in some browsers. Disabled, it is out of the tab order, so it
 * never shifts a keyboard path or takes a shortcut.
 */
export function ComingSoonButton({
  children,
  tooltip,
  className,
  testId,
}: {
  children: ReactNode;
  /** One sentence on what it will do; "Coming soon." is added when it does not say so. */
  tooltip?: string;
  /** The button's own look (`btn-secondary`, a page's class). */
  className?: string;
  testId?: string;
}) {
  const badgeId = useId();
  const tipId = useId();
  const said = comingSoonWords(tooltip);
  return (
    <span className={styles.wrap} title={said} data-testid={testId}>
      <button
        type="button"
        className={className}
        disabled
        aria-describedby={tooltip ? tipId : badgeId}
      >
        {children}
      </button>
      <ComingSoonBadge id={badgeId} />
      {tooltip ? <span id={tipId} className="sr-only">{said}</span> : null}
    </span>
  );
}
