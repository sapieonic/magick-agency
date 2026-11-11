import { useId, useState } from 'react';
import { CheckCircle2, UserPlus } from 'lucide-react';
import { useTenant } from '../../contexts/TenantContext';
import {
  InviteHandoff,
  InviteRoleSelect,
  inviteHandoffTitle,
  useInviteSubmission,
  type InviteRole,
} from '../team/inviteForm';
import type { Account } from '../../types/auth';
import styles from './AccountsPage.module.css';

export interface NewAccountInviteProps {
  /** The account just created: the invite puts the invitee in it, and only it. */
  account: Account;
  /** The account the reader is in, by name; they stay there while they invite. */
  currentAccountName: string | null;
  /** "Later", or "Done" after the hand-off: the panel goes away. */
  onDismiss: () => void;
}

/**
 * What follows "New account": the next step, which is a person to run it.
 *
 * A new account has nobody in it but the tenant's admins, and the person who will run
 * it is usually somebody else. Inviting them from Team meant leaving this page and
 * picking the new account in a field that used to default to every account. Here the
 * account is FIXED to the one just made (there is no field for it), the role starts on
 * Supervisor, and the reader stays in the account they are in.
 *
 * The request, its analytics and the hand-off after it are Team's own
 * (`pages/team/inviteForm`), so the two places that invite say and do the same thing.
 */
export function NewAccountInvite({ account, currentAccountName, onDismiss }: NewAccountInviteProps) {
  const { tenantId } = useTenant();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<InviteRole>('account_admin');
  const { submitting, error, created, submit } = useInviteSubmission(tenantId);
  const headingId = useId();
  const emailId = useId();
  const roleId = useId();
  const accountFieldId = useId();
  const accountHintId = useId();

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    void submit({ email, role, accountId: account.id });
  };

  const stayIn = currentAccountName ? `You stay in ${currentAccountName}` : 'You stay in this account';

  return (
    <section className={styles.readyPanel} aria-labelledby={headingId} data-testid="new-account-ready">
      <div className={styles.readyHead}>
        <CheckCircle2 size={18} className={styles.readyIcon} aria-hidden="true" />
        <div>
          <h2 id={headingId} className={styles.readyTitle}>
            {created ? inviteHandoffTitle(created) : `${account.name} is ready`}
          </h2>
          {!created && (
            <p className={styles.readyLead}>
              Next, invite the person who’ll run it. {stayIn} while you do.
            </p>
          )}
        </div>
      </div>

      {created ? (
        <>
          <InviteHandoff created={created} />
          <div className={styles.readyActions}>
            <button type="button" className="btn-primary" onClick={onDismiss}>
              Done
            </button>
          </div>
        </>
      ) : (
        <form className={styles.readyForm} onSubmit={handleSubmit}>
          <div className={styles.readyFields}>
            <div className="form-group">
              <label htmlFor={emailId}>Email</label>
              <input
                id={emailId}
                type="email"
                placeholder="name@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoComplete="off"
              />
            </div>
            <div className="form-group">
              <label htmlFor={roleId}>Role</label>
              <InviteRoleSelect id={roleId} value={role} onChange={setRole} />
            </div>
            {/* Shown, not chosen: this invite is for the account just made. */}
            <div className="form-group">
              <label htmlFor={accountFieldId}>Account</label>
              <input id={accountFieldId} type="text" value={account.name} readOnly aria-describedby={accountHintId} />
            </div>
          </div>
          <p id={accountHintId} className={styles.hint}>
            They’ll join {account.name} only.
          </p>
          {error && <p className="error-text" role="alert">{error}</p>}
          <div className={styles.readyActions}>
            <button type="button" className="btn-secondary" onClick={onDismiss}>
              Later
            </button>
            <button type="submit" className="btn-primary" disabled={submitting || !email.trim()}>
              <UserPlus size={14} />
              {submitting ? 'Sending...' : 'Send invite'}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
