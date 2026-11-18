import { useEffect, useId, useState, type ReactNode } from 'react';
import styles from './ComingSoon.module.css';

/** The words every coming-soon control carries, on screen and to a screen reader. */
const COMING_SOON = 'Coming soon';

/**
 * The console's one "Coming soon" mark: a small badge beside a control or a heading for something
 * that is planned and has nothing behind it yet.
 */
export function ComingSoonBadge() {
  return (
    <span className={styles.badge} data-testid="coming-soon">
      {COMING_SOON}
    </span>
  );
}

/** The tooltip and description: what it will do, always ending in "Coming soon." */
function comingSoonWords(tooltip?: string): string {
  if (!tooltip) return COMING_SOON;
  return tooltip.includes(COMING_SOON) ? tooltip : `${tooltip} ${COMING_SOON}.`;
}

/**
 * A control that will exist and does nothing yet. A real `<button>`, never a link that goes
 * nowhere, marked `aria-disabled="true"` rather than `disabled`: it stays focusable, so a keyboard
 * user can reach it and learn why it does nothing, and pressing it does nothing. Its explanation
 * ("what it will do. Coming soon.") is a tooltip shown on hover and on focus, and the button's
 * accessible description. Escape hides it whether the button is focused or only hovered (WCAG
 * 1.4.13: content on hover is dismissable without moving the pointer); it shows again once the
 * pointer leaves or focus moves on. A full button also carries the visible badge; a `compact`
 * icon button is marked by its dashed border instead.
 */
export function ComingSoonButton({
  children,
  tooltip,
  className,
  testId,
  compact = false,
  label,
}: {
  children: ReactNode;
  /** One sentence on what it will do; "Coming soon." is added when it does not say so. */
  tooltip?: string;
  /** The button's own look (`btn-secondary`, a page's class). */
  className?: string;
  testId?: string;
  /** An icon button in a tight row (an agent card's actions): no badge beside each one. */
  compact?: boolean;
  /** The accessible name, when the button shows only an icon. */
  label?: string;
}) {
  const tipId = useId();
  const said = comingSoonWords(tooltip);
  const [dismissed, setDismissed] = useState(false);
  const [hovered, setHovered] = useState(false);
  // Hovered but not focused, the button hears no key: the document does, for as long as the
  // pointer is over it.
  useEffect(() => {
    if (!hovered) return undefined;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setDismissed(true);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [hovered]);
  return (
    <span
      className={`${styles.wrap} ${compact ? styles.compact : ''}`}
      data-testid={testId}
      data-dismissed={dismissed ? 'true' : undefined}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => {
        setHovered(false);
        setDismissed(false);
      }}
    >
      <button
        type="button"
        className={className}
        aria-label={label}
        aria-disabled="true"
        aria-describedby={tipId}
        // Nothing behind it yet. `type="button"` submits no form; the press stops here, so no
        // parent's click handler (a card, a row) acts on it; and its default is prevented, so a
        // link or label around it does not follow it either.
        onClick={(e) => {
          e.stopPropagation();
          e.preventDefault();
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') setDismissed(true);
        }}
        onBlur={() => setDismissed(false)}
      >
        {children}
      </button>
      {compact ? null : <ComingSoonBadge />}
      <span id={tipId} role="tooltip" className={styles.tip}>{said}</span>
    </span>
  );
}
