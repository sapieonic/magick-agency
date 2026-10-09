import { useState, useCallback, type ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';
import styles from './AdvancedSection.module.css';

interface AdvancedSectionProps {
  /** Heading shown on the disclosure row. */
  label?: string;
  /** Muted reassurance text shown to the right when collapsed. */
  summary?: string;
  /** Whether the section starts open. Defaults to closed. */
  defaultOpen?: boolean;
  /**
   * Number of settings inside that differ from their default. When > 0 a small
   * "N changed" chip appears so nothing surprising is silently buried.
   */
  badgeCount?: number;
  children: ReactNode;
  /** Fires once per open/close, e.g. for analytics. */
  onToggle?: (open: boolean) => void;
}

/**
 * A collapsible disclosure for power-user controls that should not crowd the
 * primary path (retry config, voice overrides, developer tools, etc.). Safe
 * defaults are assumed to already be applied, so the section reassures the user
 * they can skip it. Keyboard- and screen-reader-accessible via a real button
 * with `aria-expanded`.
 */
export function AdvancedSection({
  label = 'Advanced options',
  summary = 'Safe defaults are already set — you can skip this.',
  defaultOpen = false,
  badgeCount,
  children,
  onToggle,
}: AdvancedSectionProps) {
  const [open, setOpen] = useState(defaultOpen);

  const toggle = useCallback(() => {
    setOpen((prev) => {
      const next = !prev;
      onToggle?.(next);
      return next;
    });
  }, [onToggle]);

  const hasChanges = typeof badgeCount === 'number' && badgeCount > 0;

  return (
    <div className={`${styles.root} ${open ? styles.open : ''}`}>
      <button
        type="button"
        className={styles.header}
        aria-expanded={open}
        onClick={toggle}
      >
        <ChevronRight size={16} className={styles.chevron} aria-hidden="true" />
        <span className={styles.label}>{label}</span>
        {hasChanges && (
          <span className={styles.badge}>{badgeCount} changed</span>
        )}
        {!open && <span className={styles.summary}>{summary}</span>}
      </button>
      {open && <div className={styles.body}>{children}</div>}
    </div>
  );
}
