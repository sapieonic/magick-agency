import type { AgencyCallLogTypeFilter } from '../../types/agency-call-log';
import { formatCount } from '../../utils/format/number';
import styles from './CallTypeChips.module.css';

export interface CallTypeChip {
  id: AgencyCallLogTypeFilter;
  label: string;
  /** The number beside the word, or null: none to show. */
  count: number | null;
  /** Owed work, not a type: To follow up. */
  warning?: boolean;
}

/**
 * The type chips over a list of calls: the campaign Call log's and All calls' ("All · Dialler ·
 * Soft phone · Inbound · To follow up", each with its count) and My calls' (To follow up first,
 * with what the agent still owes). Not a filter in the card: choosing one keeps every filter.
 *
 * Test ids are `<prefix>-types` on the group and `<prefix>-type-<id>` on a chip.
 */
export function CallTypeChips({ chips, selected, onChoose, label, testIdPrefix, badgesOnly = false }: {
  chips: readonly CallTypeChip[];
  selected: AgencyCallLogTypeFilter;
  onChoose: (id: AgencyCallLogTypeFilter) => void;
  /** The group's accessible name. */
  label: string;
  testIdPrefix: string;
  /**
   * The counts are badges of owed work (My calls): one is shown only above 0, and carries the
   * test id `<prefix>-count-<id>`. Otherwise every count the server sent is shown, 0 included.
   */
  badgesOnly?: boolean;
}) {
  return (
    <div className={styles.typeChips} role="group" aria-label={label} data-testid={`${testIdPrefix}-types`}>
      {chips.map((chip) => (
        <button
          key={chip.id}
          type="button"
          className={styles.typeChip}
          aria-pressed={selected === chip.id}
          onClick={() => onChoose(chip.id)}
          data-testid={`${testIdPrefix}-type-${chip.id}`}
          data-warning={chip.warning ? '' : undefined}
        >
          {chip.id !== 'all' && !chip.warning && <span className={styles.typeSwatch} data-type={chip.id} aria-hidden="true" />}
          {chip.label}
          {chip.count !== null && (!badgesOnly || chip.count > 0) && (
            <span className={styles.typeCount} data-testid={badgesOnly ? `${testIdPrefix}-count-${chip.id}` : undefined}>
              {formatCount(chip.count)}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}
