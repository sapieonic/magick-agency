import { X } from 'lucide-react';
import styles from './SpineListLayout.module.css';

export interface AppliedChip {
  id: string;
  label: string;
}

interface AppliedFilterChipsProps {
  chips: readonly AppliedChip[];
  onRemove: (id: string) => void;
  /** Prefix for the chips' test ids (`<prefix>-<chip id>`). */
  testIdPrefix: string;
}

/**
 * The filters applied to a list, each removable on its own.
 *
 * A list opened from an Insights number arrives already narrowed, often by a filter the form
 * has no control for (a dialled window, a caller ID, a waiting bucket). Without these the
 * supervisor would read a narrowed list as the whole campaign. Each chip is a real button
 * with an accessible name ("Remove filter: …"), so it is reachable by keyboard and by
 * `getByRole`. Renders nothing when no filter is applied.
 */
export function AppliedFilterChips({ chips, onRemove, testIdPrefix }: AppliedFilterChipsProps) {
  if (chips.length === 0) return null;
  return (
    <ul className={styles.appliedChips} aria-label="Applied filters" data-testid={`${testIdPrefix}-applied`}>
      {chips.map((chip) => (
        <li key={chip.id} className={styles.appliedChip} data-testid={`${testIdPrefix}-chip-${chip.id}`}>
          <span>{chip.label}</span>
          <button
            type="button"
            className={styles.appliedChipRemove}
            onClick={() => onRemove(chip.id)}
            aria-label={`Remove filter: ${chip.label}`}
          >
            <X size={12} aria-hidden="true" />
          </button>
        </li>
      ))}
    </ul>
  );
}
