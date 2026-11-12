import { ConfirmDialog } from '@magick-agency/web-ui/components/ConfirmDialog';
import type { UnsavedChangesGuard } from '../../hooks/useUnsavedChangesGuard';
import { plural } from '../../utils/format/number';
import styles from './UnsavedChangesBar.module.css';

interface UnsavedChangesBarProps {
  /** How many settings differ from what is saved; the bar shows only above zero. */
  count: number;
  saving: boolean;
  /**
   * Why Save is held back (a field to fix), or null when it may go. Save is disabled exactly
   * while this is set, so a held Save always says why.
   */
  blockedReason: string | null;
  /** Anything else worth saying beside the count, such as why the last save did not go. */
  note: string | null;
  onDiscard: () => void;
  onSave: () => void;
}

/**
 * A form's Save, where the person is: a bar stuck to the bottom of the view while anything is
 * unsaved — "3 unsaved changes · Discard · Save changes" — and gone once it is saved or
 * discarded. The count and the note are also said through a polite live region that stays on
 * the page, so a screen reader hears them appear and change without focus moving off the field
 * being edited: a save that fails, or a Save that a field holds back, is heard and not only seen.
 */
export function UnsavedChangesBar({ count, saving, blockedReason, note, onDiscard, onSave }: UnsavedChangesBarProps) {
  const summary = count > 0 ? plural(count, 'unsaved change') : '';
  const said = blockedReason ?? note;
  return (
    <>
      <p className="sr-only" role="status" aria-live="polite" data-testid="unsaved-changes-status">
        {summary && said ? `${summary}. ${said}` : summary}
      </p>
      {count > 0 && (
        <div className={styles.bar} role="region" aria-label="Unsaved changes" data-testid="unsaved-changes-bar">
          {/* Said through the live region above; hidden here so it is not read twice. */}
          <div className={styles.copy} aria-hidden="true">
            <p className={styles.count}>{summary}</p>
            {said && <p className={styles.note} data-testid="unsaved-changes-note">{said}</p>}
          </div>
          <div className={styles.actions}>
            <button type="button" className="btn-secondary" onClick={onDiscard} disabled={saving}>
              Discard
            </button>
            <button type="button" className="btn-primary" onClick={onSave} disabled={saving || blockedReason !== null}>
              {saving ? 'Saving…' : 'Save changes'}
            </button>
          </div>
        </div>
      )}
    </>
  );
}

/**
 * The question `useUnsavedChangesGuard` asks while a navigation away is held: "Leave without
 * saving?", with what would be lost (`message`). Leave carries the navigation out; Cancel stays.
 */
export function LeaveUnsavedDialog({ guard, message }: { guard: UnsavedChangesGuard; message: string }) {
  if (!guard.asking) return null;
  return (
    <ConfirmDialog
      open
      title="Leave without saving?"
      message={message}
      confirmLabel="Leave without saving"
      danger
      onConfirm={guard.leave}
      onCancel={guard.stay}
    />
  );
}
