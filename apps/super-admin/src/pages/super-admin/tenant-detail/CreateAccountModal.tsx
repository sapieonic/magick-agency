import { useState } from 'react';
import { Modal } from '@magick-agency/web-ui/components/Modal';
import { ErrorText } from '@magick-agency/web-ui/components/ErrorText';
import { ACCOUNT_NAME_MAX_LENGTH, type Account } from '@magick-agency/contracts/api/platform/auth';
import { createTenantAccount } from '../../../api/super-admin';
import styles from '../SATenantDetailPage.module.css';

/**
 * Add an account to a tenant (`POST /super-admin/tenants/:id/accounts`). The name
 * is the only input; the server derives the slug and refuses a name the tenant
 * already has (409), which keeps the modal open so the name can be changed.
 * The new account starts on the platform defaults: set its limits on the Service
 * tab.
 */
export function CreateAccountModal({ tenantId, tenantName, onClose, onCreated }: {
  tenantId: string;
  tenantName: string;
  onClose: () => void;
  onCreated: (account: Account) => void;
}) {
  const [name, setName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const trimmed = name.trim();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!trimmed || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      onCreated(await createTenantAccount(tenantId, trimmed));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create account');
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={`New account in ${tenantName}`}
      footer={
        <>
          <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
          <button type="submit" form="create-account-form" className="btn-primary" disabled={submitting || !trimmed}>
            {submitting ? 'Creating...' : 'Create account'}
          </button>
        </>
      }
    >
      <form id="create-account-form" onSubmit={handleSubmit} className={styles.form}>
        <div className={styles.field}>
          <label htmlFor="create-account-name">Account name</label>
          <input
            id="create-account-name"
            type="text"
            value={name}
            maxLength={ACCOUNT_NAME_MAX_LENGTH}
            onChange={e => { setName(e.target.value); if (error) setError(null); }}
            required
            autoComplete="off"
            aria-describedby={error ? 'create-account-hint create-account-error' : 'create-account-hint'}
            aria-invalid={error ? true : undefined}
            data-autofocus="true"
          />
        </div>
        <p id="create-account-hint" className={styles.hint}>
          Starts with recording and call analysis off and the default concurrency. Change them on
          the Service tab. (An account a tenant admin creates starts with no call capacity until
          you set it there.)
        </p>
        {error && (
          <div id="create-account-error" className={styles.error} role="alert" data-testid="sa-create-account-error">
            <ErrorText message={error} />
          </div>
        )}
      </form>
    </Modal>
  );
}
