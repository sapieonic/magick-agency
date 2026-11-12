import { useState } from 'react';
import { UserPlus } from 'lucide-react';
import { Modal } from '@magick-agency/web-ui/components/Modal';
import { useAuth } from '../../contexts/AuthContext';
import { useTenant } from '../../contexts/TenantContext';
import { useAccounts } from '../../hooks/useAccounts';
import {
  InviteHandoff,
  InviteRoleSelect,
  inviteHandoffTitle,
  useInviteSubmission,
  type InviteRole,
} from './inviteForm';
import {
  ALL_ACCOUNTS,
  inviteAccountId,
  inviterScope,
  type InviteAccountChoice,
} from './inviteScope';
import styles from './TeamPage.module.css';

export interface InviteModalProps {
  /** Dismiss without having created anything. */
  onClose: () => void;
  /** The supervisor is finished with the hand-off panel: close it. */
  onInvited: () => void;
  /** An invite was created — refresh the member list, but leave the modal open. */
  onCreated: () => void;
}

export function InviteModal({ onClose, onInvited, onCreated }: InviteModalProps) {
  const { memberships } = useAuth();
  const { tenantId, accountId: currentAccountId, accounts: myAccounts } = useTenant();
  const { accounts } = useAccounts();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<InviteRole>('viewer');
  /**
   * The inviter's own account when they are held to it (the server refuses any other),
   * so there is one answer and it is filled in. Otherwise nothing: the inviter picks an
   * account, or "All accounts", on purpose (`inviteScope.ts` says why there is no
   * default). When the page cannot tell which account the server holds them to, the
   * field offers nothing and says why.
   *
   * Derived on every render, not seeded once: memberships and the account in view can
   * resolve while the modal is open, and a choice seeded before then would name no
   * option (or one the server refuses).
   */
  const scope = inviterScope(memberships, tenantId, currentAccountId);
  const scopedTo = scope.kind === 'account' ? scope.accountId : null;
  const scopeUnknown = scope.kind === 'unknown';
  const [pickedAccount, setPickedAccount] = useState<InviteAccountChoice>('');
  const accountChoice: InviteAccountChoice = scopedTo ?? (scopeUnknown ? '' : pickedAccount);
  /* A scoped inviter's one account is offered even before (or without) the tenant's list,
     named from the switcher's list, so the select never shows a value with no option. */
  const offeredAccounts = scopeUnknown ? [] : scopedTo
    ? [{
      id: scopedTo,
      name: accounts.find((a) => a.id === scopedTo)?.name
        ?? myAccounts?.find((a) => a.id === scopedTo)?.name
        ?? 'Your account',
    }]
    : accounts;
  /**
   * The invite that succeeded, which swaps the form for the hand-off panel.
   *
   * The modal deliberately does NOT close on success. Closing was right while
   * "Send Invite" was believed to send something; now that the supervisor may be
   * the delivery mechanism, dismissing the one screen that tells them so — and
   * carries the address and the link — would lose the whole point.
   */
  const { submitting, error, created, submit } = useInviteSubmission(tenantId, onCreated);

  const chosenAccountId = inviteAccountId(accountChoice);
  const accountChosen = chosenAccountId !== null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    // Never sent without an explicit account: an absent `account_id` is every account.
    if (chosenAccountId === null) return;
    void submit({ email, role, accountId: chosenAccountId });
  };

  if (created) {
    return (
      /* Overlay click, Escape and the close button all finish the hand-off. */
      <Modal open size="sm" onClose={onInvited} title={inviteHandoffTitle(created)}>
        <InviteHandoff created={created} />
        <div className={styles.modalFooter}>
          <button type="button" className="btn-primary" onClick={onInvited} data-autofocus="true">
            Done
          </button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal open size="sm" onClose={onClose} title="Invite team member">
      <form onSubmit={handleSubmit}>
        <div className="form-group">
          <label htmlFor="invite-email">Email</label>
          <input
            id="invite-email"
            type="email"
            placeholder="user@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            data-autofocus="true"
          />
        </div>
        <div className="form-group">
          <label htmlFor="invite-role">Role</label>
          <InviteRoleSelect id="invite-role" value={role} onChange={setRole} />
        </div>
        <div className="form-group">
          <label htmlFor="invite-account">Account</label>
          <select
            id="invite-account"
            value={accountChoice}
            onChange={(e) => setPickedAccount(e.target.value)}
            required
            disabled={scopeUnknown}
            aria-describedby="invite-account-hint"
          >
            {!scopedTo && (
              <option value="" disabled>
                Choose an account
              </option>
            )}
            {offeredAccounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
            {scope.kind === 'tenant' && <option value={ALL_ACCOUNTS}>All accounts (whole organisation)</option>}
          </select>
          <p id="invite-account-hint" className={styles.fieldHint}>
            {scopeUnknown
              ? 'Your access covers particular accounts rather than the whole organisation, and this invite can’t tell which one it may use. Ask an admin with access to the whole organisation to send it.'
              : scopedTo
              ? 'You can invite people to your own account only.'
              : 'The account they’ll work in. Choose “All accounts” only for someone who should reach every account.'}
          </p>
        </div>
        {error && <p className="error-text">{error}</p>}
        <div className={styles.modalFooter}>
          <button type="button" className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          {/* "Send invite", the same words as the new-account invite on Accounts: the server
              emails every invite it can, and the panel that follows says plainly when it
              could not, with the link to pass on. */}
          <button
            type="submit"
            className="btn-primary"
            disabled={submitting || !email.trim() || !accountChosen}
          >
            <UserPlus size={14} />
            {submitting ? 'Sending...' : 'Send invite'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
