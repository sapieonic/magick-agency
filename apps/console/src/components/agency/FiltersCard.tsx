import type { ReactNode } from 'react';
import { Filter } from 'lucide-react';
import styles from './SpineListLayout.module.css';

interface FiltersCardProps {
  /** Filter groups currently APPLIED (not merely drafted) — drives the badge. */
  activeCount?: number;
  children: ReactNode;
}

/**
 * The bordered, elevated panel every agency spine list's filters live in, with
 * the "Filters" header and "N active" badge shared across Attempts, Contacts,
 * and Activity. Callers supply the fieldsets/fields/footer as children.
 *
 * ── Why it is a NAMED group and not a bare div ──────────────────────────────
 * The "Filters" heading is a visual one only: read linearly, the controls inside
 * are a run of unlabelled-in-context fields, and the card's own header is just
 * text that happens to sit above them. Naming the region is what ties them
 * together — and it is what keeps a field called "Campaign" here distinguishable
 * from a field called "Campaign" elsewhere on the same screen, which the
 * supervisor's per-agent view genuinely has: one scopes the FIGURES, this one
 * filters the LIST. Two identically named controls with no containing name is a
 * screen nobody can navigate by name.
 *
 * `role="group"` rather than `region`: this is a set of related controls, not a
 * landmark, and adding it to the landmark rota of every spine list would make
 * the page's landmark list mostly filter cards.
 */
export function FiltersCard({ activeCount = 0, children }: FiltersCardProps) {
  return (
    <div className={styles.filters} role="group" aria-label="Filters">
      <div className={styles.filtersHeader}>
        <span className={styles.filtersTitle}>
          <Filter size={14} aria-hidden="true" />
          Filters
        </span>
        {activeCount > 0 && (
          <span className={styles.filtersBadge}>{activeCount} active</span>
        )}
      </div>
      {children}
    </div>
  );
}
