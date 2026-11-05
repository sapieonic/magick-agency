import { useState } from 'react';
import { Plus } from 'lucide-react';
import { Modal } from '@magick-agency/web-ui/components/Modal';
import { ErrorText } from '@magick-agency/web-ui/components/ErrorText';
import { ACCOUNT_NAME_MAX_LENGTH, type CreateAccountErrorCode } from '@magick-agency/contracts/api/platform/auth';
import { useTenant } from '../../contexts/TenantContext';
import { createAccount } from '../../api/accounts';
import { ApiError } from '../../api/client';
import { trackSetupEvent, type AccountCreateFailureReason } from '../../analytics/events';
import type { Account } from '../../types/auth';
import styles from './AccountsPage.module.css';

export interface CreateAccountModalProps {
  /** Dismissed without creating anything. */
  onClose: () => void;
  /** The account exists. The page refreshes its lists and closes the modal. */
  onCreated: (account: Account) => void;
}

/** The analytics reason for a refusal, from the server's `code` or status. */
function failureReason(err: unknown): AccountCreateFailureReason {
  if (!(err instanceof ApiError)) return 'unknown_error';
  const code = (err.details as { code?: CreateAccountErrorCode } | undefined)?.code;
  if (code === 'account_name_taken') return 'name_taken';
  if (code === 'tenant_wide_membership_required') return 'not_tenant_wide';
  if (err.statusCode === 400) return 'validation_error';
  return 'unknown_error';
}

/**
 * The name is the only input: the slug is the server's. A new account starts with no
 * call capacity (decision AA4): a super admin sets its limit, so the hint says so before
 * anyone builds a campaign there expecting it to dial.
 *
 * A refusal keeps the modal open with the server's sentence under the field: a name that
 * is taken (409) is fixed by typing another, which closing the modal would make the person
 * do from scratch.
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
      trackSetupEvent('account_create_failed', { reason: failureReason(err) });
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
            aria-describedby={error ? 'account-name-hint account-name-error' : 'account-name-hint'}
            aria-invalid={error ? true : undefined}
            data-autofocus="true"
          />
          <p id="account-name-hint" className={styles.hint}>
            Each account has its own campaigns, settings and call history. It can’t place calls
            until support sets its call limit.
          </p>
        </div>
        {error && (
          <p id="account-name-error" className="error-text" role="alert" data-testid="create-account-error">
            <ErrorText message={error} />
          </p>
        )}
        <div className={styles.modalFooter}>
          <button type="button" className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn-primary" disabled={submitting || !trimmed || !tenantId}>
            <Plus size={14} />
            {submitting ? 'Creating...' : 'Create account'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
