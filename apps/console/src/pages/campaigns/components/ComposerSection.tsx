import type { ReactNode } from 'react';
import { Check } from 'lucide-react';
import styles from './ComposerSection.module.css';

interface ComposerSectionProps {
  /**
   * 1-based step number shown in the badge, when the section is one of a
   * numbered sequence.
   *
   * **Optional, because not every consumer has a sequence.** A settings page
   * reuses these cards for their title, helper and framing, and a number there
   * belongs to a run of steps that does not exist on the page — which is how
   * `AgencyCampaignSettingsPage` came to open with a card badged "3" and
   * another badged "4", with no 1, 2 or 5 anywhere. Omit it and the badge is
   * not rendered at all.
   */
  step?: number;
  title: string;
  /** One-line helper that guides the user through the section. */
  helper: string;
  /** Marks the section as satisfied (badge turns into a check). */
  complete?: boolean;
  children: ReactNode;
}

/**
 * Layout primitive for a numbered, self-guided composer section: a step badge,
 * a title, a one-line helper, then the section body. Shared across all campaign
 * types so sections look identical regardless of type.
 */
export function ComposerSection({ step, title, helper, complete = false, children }: ComposerSectionProps) {
  // A tick still earns a badge on a numberless section — "satisfied" is a fact
  // about the section itself, unlike its position in a sequence.
  const badge = complete || step !== undefined;
  return (
    <section className={styles.section}>
      <header className={styles.header}>
        {badge && (
          <span className={`${styles.badge} ${complete ? styles.badgeComplete : ''}`} aria-hidden="true">
            {complete ? <Check size={14} /> : step}
          </span>
        )}
        <div className={styles.titles}>
          <h2 className={styles.title}>{title}</h2>
          <p className={styles.helper}>{helper}</p>
        </div>
      </header>
      <div className={styles.body}>{children}</div>
    </section>
  );
}
