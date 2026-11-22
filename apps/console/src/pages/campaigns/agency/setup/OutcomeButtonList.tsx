import { Fragment } from 'react';
import { ArrowDown, ArrowUp, Plus } from 'lucide-react';
import type { AgencyDispositionEntry } from '../../../../types/agency-campaign';
import type { CatalogEdit } from '../../../../utils/agencyCampaignConfigForm';
import { outcomeIcon } from '../../../../utils/agency/stationTiles';
import { ruleSummary, withRule } from '../../../../utils/campaignSetup/outcomeRule';
import { StationTileIcon } from '../../../../components/agency/station/stationIcons';
import type { ConfigFieldErrors } from '../configFieldErrors';
import { OutcomeRuleEditor, rowEditorFields } from './OutcomeRuleEditor';
import styles from './PurposeButtonsStep.module.css';

/**
 * "Buttons agents will see after each call" (CS3): one row per button in number-key order, each
 * with its key, its picture on the station's tint, its name and a grey line saying what it does.
 * Edit opens the row's sentence in place. Every change is a `CatalogEdit` (`editCatalog`'s rules:
 * a new button's code follows its name, a built-in cannot be removed), applied by the step.
 */
export function OutcomeButtonList({
  dispositions,
  onEdit,
  errors,
  findingRows,
  expanded,
  onExpand,
  focusNameOf,
  onMoreOptions,
}: {
  dispositions: readonly AgencyDispositionEntry[];
  onEdit: (edit: CatalogEdit) => void;
  /** The step's errors for this list (its own ids). */
  errors: ConfigFieldErrors;
  /** Rows with any finding, here or under Advanced: each is marked "Needs fixing". */
  findingRows: ReadonlySet<number>;
  /** The row open for editing, or `null`. */
  expanded: number | null;
  onExpand: (index: number | null) => void;
  /** The row whose name takes focus as its editor opens (a button just added). */
  focusNameOf: number | null;
  onMoreOptions: (index: number) => void;
}) {
  return (
    <>
      <ol className={styles.rows} data-testid="button-rows">
        {dispositions.map((entry, index) => {
          const open = expanded === index;
          const name = entry.label.trim();
          const named = name || `Button ${index + 1}`;
          const editorId = `button-editor-${index}`;
          const needsFixing = findingRows.has(index);
          return (
            // Keyed by position, as the full editor is: a code follows its label while it is typed.
            <li
              key={index}
              className={styles.row}
              data-open={open || undefined}
              data-invalid={needsFixing || undefined}
              data-testid={`button-row-${index}`}
            >
              <div className={styles.rowHead}>
                <kbd className={styles.key} title={`Agents press ${index + 1} for this button`}>
                  <span className="sr-only">Key </span>
                  {index + 1}
                </kbd>
                <span className={styles.iconCircle} data-icon={outcomeIcon(entry)} aria-hidden="true">
                  <StationTileIcon icon={outcomeIcon(entry)} size={18} />
                </span>
                <span className={styles.rowText}>
                  <span className={name ? styles.rowLabel : `${styles.rowLabel} ${styles.rowLabelEmpty}`}>
                    {name || 'No name yet'}
                  </span>
                  <span className={styles.rowSummary} data-testid={`button-summary-${index}`}>{ruleSummary(entry)}</span>
                  {needsFixing ? <span className={styles.rowFix} data-testid={`button-fix-${index}`}>Needs fixing</span> : null}
                </span>
                <span className={styles.rowActions}>
                  <button
                    type="button"
                    className={styles.iconBtn}
                    onClick={() => onEdit({ type: 'move', index, delta: -1 })}
                    disabled={index === 0}
                    aria-label={`Move the ${named} button up`}
                    title="Move up. The order is the number key."
                  >
                    <ArrowUp size={14} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className={styles.iconBtn}
                    onClick={() => onEdit({ type: 'move', index, delta: 1 })}
                    disabled={index === dispositions.length - 1}
                    aria-label={`Move the ${named} button down`}
                    title="Move down. The order is the number key."
                  >
                    <ArrowDown size={14} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className={`btn-secondary ${styles.editBtn}`}
                    onClick={() => onExpand(open ? null : index)}
                    aria-expanded={open}
                    aria-controls={open ? editorId : undefined}
                    // Closed, the row's findings are named by no field: Edit carries them, so
                    // "Show me" and "Go to" (`focusFirstFieldError`) land here, the way to the fix.
                    aria-describedby={open ? undefined : errors.describedBy(...rowEditorFields(index))}
                    aria-label={`${open ? 'Close' : 'Edit'} ${named}`}
                    data-testid={`button-edit-${index}`}
                  >
                    {open ? 'Close' : 'Edit'}
                  </button>
                </span>
              </div>
              {open ? (
                <div id={editorId}>
                  <OutcomeRuleEditor
                    entry={entry}
                    index={index}
                    onRename={(label) => onEdit({ type: 'rename', index, label })}
                    onIcon={(icon) => onEdit({ type: 'update', index, patch: { icon } })}
                    onRule={(rule) => {
                      const next = withRule(entry, rule);
                      if (next !== entry) onEdit({ type: 'update', index, patch: patchFor(entry, next) });
                    }}
                    onRemove={() => onEdit({ type: 'remove', index })}
                    onMoreOptions={() => onMoreOptions(index)}
                    errors={errors}
                    focusName={focusNameOf === index}
                  />
                </div>
              ) : null}
              {/* The row's findings, open or not, so a refused save is seen without opening it. */}
              <div className={styles.rowErrors}>
                {rowEditorFields(index).map((field) => <Fragment key={field}>{errors.render(field)}</Fragment>)}
              </div>
            </li>
          );
        })}
      </ol>
      <button
        type="button"
        className={styles.addBtn}
        onClick={() => onEdit({ type: 'add' })}
        data-testid="button-add"
      >
        <Plus size={14} aria-hidden="true" /> Add a button
      </button>
    </>
  );
}

/**
 * The `update` patch that turns `entry` into `next`: every changed key, and every removed one as
 * `undefined` (which `editCatalog` merges over the entry and the wire leaves out).
 */
export function patchFor(entry: AgencyDispositionEntry, next: AgencyDispositionEntry): Partial<AgencyDispositionEntry> {
  const patch: Record<string, unknown> = {};
  const before = entry as unknown as Record<string, unknown>;
  const after = next as unknown as Record<string, unknown>;
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (before[key] !== after[key]) patch[key] = after[key];
  }
  return patch as Partial<AgencyDispositionEntry>;
}
