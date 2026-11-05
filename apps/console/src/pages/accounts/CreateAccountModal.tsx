import { useState } from 'react';
import { Plus } from 'lucide-react';
import { Modal } from '@magick-agency/web-ui/components/Modal';
import { ACCOUNT_NAME_MAX_LENGTH } from '@magick-agency/contracts/api/platform/auth';
import { useTenant } from '../../contexts/TenantContext';
import { createAccount } from '../../api/accounts';
import type { Account } from '../../types/auth';
import styles from './AccountsPage.module.css';

export interface CreateAccountModalProps {
  /** Dismissed without creating anything. */
  onClose: () => void;
  /** The account exists. The page refreshes its lists and closes the modal. */
  onCreated: (account: Account) => void;
}

/**
 * The name is the only input: the slug is the server's, and a new account starts
 * on the platform defaults (recording and call analysis off, up to 5 calls at
 * once), which a super admin changes.
 *
 * A refusal keeps the modal open with the server's sentence under the field: a
 * name that is taken (409) is fixed by typing another, which closing the modal
 * would make the person do from scratch.
 */
export function CreateAccountModal({ onClose, onCreated }: CreateAccountModalProps) {
  const { tenantId } = useTenant();
  const [name, setName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmed = name.trim();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!tenantId || !trimmed || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const account = await createAccount(tenantId, trimmed);
      onCreated(account);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the account.');
      setSubmitting(false);
    }
  };

  return (
    <Modal open size="sm" onClose={onClose} title="New account">
      <form onSubmit={handleSubmit}>
        <div className="form-group">
          <label htmlFor="account-name">Account name</label>
          <input
            id="account-name"
            type="text"
            placeholder="e.g. Renewals team"
            value={name}
            maxLength={ACCOUNT_NAME_MAX_LENGTH}
            onChange={(e) => {
              setName(e.target.value);
              if (error) setError(null);
            }}
            required
            autoComplete="off"
            data-autofocus="true"
          />
          <p className={styles.hint}>
            Each account has its own campaigns, settings and call history. It starts with
            recording and call analysis off.
          </p>
        </div>
        {error && (
          <p className="error-text" role="alert" data-testid="create-account-error">
            {error}
          </p>
        )}
        <div className={styles.modalFooter}>
          <button type="button" className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn-primary" disabled={submitting || !trimmed}>
            <Plus size={14} />
            {submitting ? 'Creating…' : 'Create account'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
