import { useState } from 'react';
import { updatePhoneNumber } from '../../../api/super-admin';
import type { PhoneNumber } from '@magick-agency/contracts/api/platform/super-admin';
import { Modal } from '@magick-agency/web-ui/components/Modal';
import { HelpTooltip } from '@magick-agency/web-ui/components/HelpTooltip';
import { ErrorText } from '@magick-agency/web-ui/components/ErrorText';
import { AdvancedSection } from '../../../components/common';
import styles from '../SAPhoneNumbersPage.module.css';

/**
 * Edit a number's label, notes and per-number routing cap. The form is seeded
 * from `phone` on mount, so the parent keys this by the number being edited:
 * every open starts from the row's current values with no stale error.
 */
export function PhoneNumberEditModal({ phone, onClose, onSaved }: {
  /** The number being edited; `null` renders the modal closed. */
  phone: PhoneNumber | null;
  onClose: () => void;
  /** Called after a successful save; the parent closes the modal and refetches. */
  onSaved: () => void;
}) {
  const [editForm, setEditForm] = useState(() => ({
    label: phone?.label ?? '',
    notes: phone?.notes ?? '',
    max_concurrent_calls: phone?.max_concurrent_calls ?? 1,
  }));
  const [editing, setEditing] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  const handleEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!phone) return;
    setEditing(true);
    setEditError(null);
    try {
      await updatePhoneNumber(phone.id, {
        label: editForm.label || undefined,
        notes: editForm.notes || undefined,
        max_concurrent_calls: editForm.max_concurrent_calls,
      });
      onSaved();
    } catch (err) {
      setEditError(err instanceof Error ? err.message : 'Failed to update phone number');
    } finally {
      setEditing(false);
    }
  };

  return (
    <Modal
      open={!!phone}
      onClose={onClose}
      title={phone ? `Edit ${phone.phone_number}` : 'Edit'}
      footer={
        <>
          <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
          <button type="submit" form="edit-phone-form" className="btn-primary" disabled={editing}>
            {editing ? 'Saving…' : 'Save changes'}
          </button>
        </>
      }
    >
      <form id="edit-phone-form" onSubmit={handleEdit} className={styles.form}>
        <div className={styles.field}>
          <label>Label</label>
          <input
            value={editForm.label}
            onChange={e => setEditForm(f => ({ ...f, label: e.target.value }))}
            placeholder="e.g. Primary, Collections"
            maxLength={255}
          />
        </div>

        <AdvancedSection label="Advanced settings" summary="Notes and concurrency">
          <div className={styles.field}>
            <label>Notes</label>
            <textarea
              value={editForm.notes}
              onChange={e => setEditForm(f => ({ ...f, notes: e.target.value }))}
              placeholder="Internal notes about this number"
              rows={3}
            />
          </div>
          <div className={styles.field}>
            <label>
              Per-number routing cap
              <HelpTooltip text="This number-level value is separate from provider procurement and is not summed into the account concurrency allocation." />
            </label>
            <input
              type="number"
              min={1}
              value={editForm.max_concurrent_calls}
              onChange={e => setEditForm(f => ({ ...f, max_concurrent_calls: parseInt(e.target.value) || 1 }))}
              required
            />
          </div>
        </AdvancedSection>

        {editError && <div className={styles.error}><ErrorText message={editError} /></div>}
      </form>
    </Modal>
  );
}
