import { useState, useCallback } from 'react';
import styles from './PageDescription.module.css';

const STORAGE_PREFIX = 'pageDescCollapsed:';

interface PageDescriptionProps {
  /** Unique key for localStorage persistence (e.g. "calls", "schedules") */
  pageKey: string;
  /** The description text. Can include line breaks via \n. */
  description: string;
  /** Optional list of tips shown as bullet points below the description. */
  tips?: string[];
  /*
   * Decision B17: there are no `docsSlug` / `docsLabel` props or "Read the full
   * guide" link, because Magick Agency has no docs site.
   */
}

export function PageDescription({ pageKey, description, tips }: PageDescriptionProps) {
  const storageKey = `${STORAGE_PREFIX}${pageKey}`;

  const [collapsed, setCollapsed] = useState(() => {
    try {
      // If user has explicitly set a preference for this page, respect it
      const stored = localStorage.getItem(storageKey);
      if (stored !== null) return stored === '1';
      // If user has dismissed the getting started checklist, default to collapsed
      // (they're past onboarding and likely don't need guides expanded)
      if (localStorage.getItem('gettingStartedDismissed') === 'true') return true;
      return false;
    } catch {
      return false;
    }
  });

  const toggle = useCallback(() => {
    setCollapsed(prev => {
      const next = !prev;
      try {
        if (next) {
          localStorage.setItem(storageKey, '1');
        } else {
          localStorage.removeItem(storageKey);
        }
      } catch { /* quota */ }
      return next;
    });
  }, [storageKey]);

  return (
    <div className={`${styles.container} ${collapsed ? styles.collapsed : ''}`}>
      <button
        type="button"
        className={styles.toggle}
        onClick={toggle}
        aria-expanded={!collapsed}
        aria-label={collapsed ? 'Show page guide' : 'Hide page guide'}
      >
        {/* Lightbulb icon */}
        <svg
          className={styles.icon}
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5" />
          <path d="M9 18h6" />
          <path d="M10 22h4" />
        </svg>
        {collapsed ? (
          <span className={styles.collapsedLabel}>Show page guide</span>
        ) : (
          <span className={styles.expandedLabel}>Page guide</span>
        )}
        <svg
          className={`${styles.chevron} ${collapsed ? '' : styles.chevronOpen}`}
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {!collapsed && (
        <div className={styles.body}>
          <p className={styles.text}>{description}</p>
          {tips && tips.length > 0 && (
            <ul className={styles.tips}>
              {tips.map((tip, i) => (
                <li key={i} className={styles.tip}>{tip}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
