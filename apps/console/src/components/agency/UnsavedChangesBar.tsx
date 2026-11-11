import { plural } from '../../utils/format/number';
import styles from './UnsavedChangesBar.module.css';

interface UnsavedChangesBarProps {
  /** How many settings differ from what is saved; the bar shows only above zero. */
  count: number;
  saving: boolean;
  /** Why Save cannot go yet (a field to fix), or why the last save did not; said in the bar. */
  note: string | null;
  /** Save is held back until the note's problem is fixed. */
  blocked: boolean;
  onDiscard: () => void;
  onSave: () => void;
}

/**
 * A form's Save, where the person is: a bar stuck to the bottom of the view while anything is
 * unsaved — "3 unsaved changes · Discard · Save changes" — and gone once it is saved or
 * discarded. The count is also said through a polite live region that stays on the page, so a
 * screen reader hears it appear and change without focus moving off the field being edited.
 */
export function UnsavedChangesBar({ count, saving, note, blocked, onDiscard, onSave }: UnsavedChangesBarProps) {
  const summary = count > 0 ? plural(count, 'unsaved change') : '';
  return (
    <>
      <p className="sr-only" role="status" aria-live="polite" data-testid="unsaved-changes-status">
        {summary}
      </p>
      {count > 0 && (
        <div className={styles.bar} role="region" aria-label="Unsaved changes" data-testid="unsaved-changes-bar">
          <div className={styles.copy}>
            <p className={styles.count} aria-hidden="true">{summary}</p>
            {note && <p className={styles.note}>{note}</p>}
          </div>
          <div className={styles.actions}>
            <button type="button" className="btn-secondary" onClick={onDiscard} disabled={saving}>
              Discard
            </button>
            <button type="button" className="btn-primary" onClick={onSave} disabled={saving || blocked}>
              {saving ? 'Saving…' : 'Save changes'}
            </button>
          </div>
        </div>
      )}
    </>
  );
}
