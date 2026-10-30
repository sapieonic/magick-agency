import { useState } from 'react';
import { UserPlus } from 'lucide-react';
import { Modal } from '@magick-agency/web-ui/components/Modal';
import { inviteRequiresMatchingAddress } from '@magick-agency/contracts/rbac';
import { useTenant } from '../../contexts/TenantContext';
import { useGovernance } from '../../contexts/GovernanceContext';
import { useFeatureFlags } from '../../contexts/FeatureFlagsContext';
import { useAccounts } from '../../hooks/useAccounts';
import { inviteUser } from '../../api/users';
import { CopyableField } from '../../components/common/CopyableField';
import { trackSetupEvent } from '../../analytics/events';
import type { InviteUserInput, InviteUserResult } from '../../types/team';
import { INVITE_ROLES } from './teamRoles';
import { inviteSignInUrl, isInvitationLink } from './teamInvites';
import styles from './TeamPage.module.css';

function getInviteFailureReason(error: unknown): 'validation_error' | 'invite_error' | 'unknown_error' {
  const message = error instanceof Error ? error.message.toLowerCase() : '';
  if (message.includes('validation') || message.includes('invalid')) return 'validation_error';
  if (message.includes('invite') || message.includes('email')) return 'invite_error';
  return 'unknown_error';
}

/**
 * What the agent's agency-door link will actually do — which depends on two
 * entitlements this page does not otherwise care about.
 *
 * ── The claim that was not true ─────────────────────────────────────────────
 * The panel said flatly *"This link takes them straight to the dialer once
 * they've signed in"*. The sign-in page itself is ungated — it has to be, since
 * there is no tenant to resolve entitlements for before somebody has signed in —
 * but everything on the other side of it is: `/agency` and `/dialer` alike sit
 * behind `RequireCapability capability="agency"` **and** `RequireFlag
 * flag="agency_dialer_enabled"`, and with either one off the link lands the
 * invitee on an unavailable screen the moment they authenticate. So a
 * supervisor at a tenant whose dialer is not switched on was told, in the
 * product's own voice, that the link they were about to send would work — and the
 * person they sent it to hit a wall on their first ever sign-in.
 *
 * ── Why the copy branches instead of just hedging ──────────────────────────
 * "This may not work" said unconditionally is worse than either sentence: it is
 * useless where the dialer IS on, and it does not name what to do where it is
 * not. Both gates are already in this app's contexts, so the panel can simply
 * know. Where the answer is no, the sentence names the two things that have to be
 * turned on and who turns them on, because that is a request the supervisor may
 * be able to make and cannot make blind.
 *
 * ── Which way each gate fails, because they are not the same ───────────────
 * `GovernanceContext.isEnabled` is `map[capability] !== false`, i.e. it fails
 * **OPEN** — an unloaded or failed map reports every capability as present,
 * deliberately, because the server's 403 is the real enforcement (L2) and a missing
 * map must never blank the app. `useFeatureFlags` fails **CLOSED**. So the
 * composite is fail-closed, which is the right direction for a promise about a
 * link somebody is about to email: the pessimistic sentence names a remedy, and
 * the optimistic one is the one that can be wrong in front of an invitee.
 *
 * The loading window is treated as "not yet known" for the same reason. It
 * resolves in a moment and the supervisor is reading a modal they just opened.
 */
function AgentLinkNote() {
  const { isEnabled: capabilityEnabled, loading: governanceLoading } = useGovernance();
  const { isEnabled: flagEnabled, status: flagStatus } = useFeatureFlags();

  const settled = !governanceLoading && flagStatus !== 'loading';
  const dialerOn = settled
    && capabilityEnabled('agency')
    && flagEnabled('agency_dialer_enabled');

  if (dialerOn) {
    /* The agent's link is not the platform's front door, and the copy SAYS so
       rather than leaving the comment to explain it: a supervisor who sees an
       `/agency/login` path where they expected `/login` will otherwise wonder
       whether they copied the wrong thing, and naming the page is what pre-empts
       that support question. */
    return (
      <p className={styles.handoffNote} data-testid="agent-dialer-note">
        This link opens the dialer’s own sign-in page, so it takes them straight to
        the dialer once they’ve signed in. Assign them to a campaign and they’ll
        land on it.
      </p>
    );
  }

  return (
    <p className={styles.handoffNote} data-testid="agent-dialer-gated-note">
      This link points at the dialer, which isn’t switched on for this workspace —
      so they’ll sign in and be told it’s unavailable. Ask your administrator to
      enable the Agency Dialer before you send it.
    </p>
  );
}

/** A completed invite, and everything the hand-off panel needs to describe it. */
interface CreatedInvite {
  email: string;
  role: InviteUserInput['role'];
  /**
   * What the server said about it.
   *
   * Retained rather than discarded because two of its fields decide what the
   * panel is allowed to claim: `invite_email.sent` decides whether the hand-off
   * is shown at all, and `sign_in_url` is a better link than the one derived from
   * `window.location.origin` whenever the server has one. See {@link
   * InviteUserResult}.
   */
  result: InviteUserResult;
}

export interface InviteModalProps {
  /** Dismiss without having created anything. */
  onClose: () => void;
  /** The supervisor is finished with the hand-off panel: close it. */
  onInvited: () => void;
  /** An invite was created — refresh the member list, but leave the modal open. */
  onCreated: () => void;
}

export function InviteModal({ onClose, onInvited, onCreated }: InviteModalProps) {
  const { tenantId } = useTenant();
  const { accounts } = useAccounts();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<InviteUserInput['role']>('viewer');
  const [accountId, setAccountId] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * The invite that succeeded, which swaps the form for the hand-off panel.
   *
   * The modal deliberately does NOT close on success any more. Closing was right
   * while "Send Invite" was believed to send something; now that the supervisor is
   * the delivery mechanism, dismissing the one screen that tells them so — and
   * carries the address and the link — would lose the whole point of this change.
   */
  const [created, setCreated] = useState<CreatedInvite | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!tenantId || !email.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      const invitedEmail = email.trim();
      const result = await inviteUser(tenantId, {
        email: invitedEmail,
        role,
        account_id: accountId || undefined,
      });
      trackSetupEvent('team_invite_sent', {
        role,
        account_scoped: Boolean(accountId),
      });
      /* The member list is refreshed NOW rather than on dismiss, so the new
         pending row is already there when the supervisor closes the panel. */
      onCreated();
      /*
        `result ?? {}` because `apiFetch` returns `undefined` for a 204 and this
        route's body is not something the panel should crash on: an absent one is
        read exactly like an older server's — no `invite_email`, so the hand-off
        stands. A `.` into an undefined body inside a render would take the whole
        page down AFTER the membership had been written, which is the one moment
        the supervisor most needs to be told what happened.
      */
      setCreated({ email: invitedEmail, role, result: result ?? {} });
    } catch (err) {
      trackSetupEvent('team_invite_failed', {
        role,
        account_scoped: Boolean(accountId),
        reason: getInviteFailureReason(err),
      });
      setError(err instanceof Error ? err.message : 'Failed to send invite');
    } finally {
      setSubmitting(false);
    }
  };

  if (created) {
    /**
     * Whether the server actually told them.
     *
     * An absent `invite_email` is an older server, and is read as "not sent" —
     * which is both the current truth and the safe direction to be wrong in: a
     * hand-off nobody needed, rather than a hidden hand-off somebody did.
     */
    const emailed = created.result.invite_email?.sent === true;
    /**
     * The server's link when it has one, ours otherwise.
     *
     * Both compute the same product rule (the agency door for an `agent` and
     * `/login` for every other role) from different inputs: the server from its configured
     * `CONSOLE_BASE_URL`, this client from `window.location.origin`. The server's is
     * preferred because the origin in the browser is whatever deployment the
     * supervisor happens to be on — a preview build would otherwise hand out a
     * preview link. `null` is the answer when the server has no base URL configured,
     * and the local derivation is then the only one that exists.
     */
    const signInUrl = created.result.sign_in_url ?? inviteSignInUrl(created.role, window.location.origin);
    /**
     * Whether that link is the invitation itself or only a sign-in page.
     *
     * Every role's invitation is a token link now (`/agency/join/:token` for an
     * agent, `/join/:token` for anybody else), and a token link does not care
     * which address they sign in with — the join page confirms a different one
     * rather than refusing it. A sign-in door (the local fallback, or an older
     * server's link) still finds them BY address. The panel's advice is about
     * which of the two this is, so it reads the link rather than the role. See
     * `isInvitationLink`.
     */
    const tokenLink = isInvitationLink(signInUrl);
    /**
     * Whether THIS role's invitation can only be accepted at the invited address
     * — `account_admin` and above, by the rule the claim enforces (decision B25,
     * `inviteRequiresMatchingAddress`, shared with the server). For those the
     * "any address will do" reading below is false, and the supervisor is the
     * one person who can tell the invitee before they try with the wrong account.
     */
    const exactAddress = inviteRequiresMatchingAddress(created.role);

    return (
      /* Overlay click, Escape and the close button all finish the hand-off. */
      <Modal open size="sm" onClose={onInvited} title={emailed ? 'Invite sent' : 'Now send them the link'}>
        {emailed ? (
          /*
            The server emailed them. The hand-off is not shown at all — telling a
            supervisor to send a link that has already been sent produces a
            second, confusing message to the invitee, and an instruction the
            product knows to be unnecessary reads as one it cannot be trusted
            about elsewhere.

            The address is still shown, because it is where the mail went and a
            typo is the one failure the supervisor can still fix. What is NOT said
            any more for most roles is "they have to sign in with this exact
            address": a mailed invitation is a token link for every role, and below
            `account_admin` the join page lets them confirm a different address
            rather than refusing it — so that sentence would send somebody with only
            a personal account away believing they could not join. From
            `account_admin` up it is TRUE again (`exactAddress`), and it is said.
          */
          <>
            <p className={styles.handoffLead} data-testid="invite-emailed">
              We’ve emailed <strong>{created.email}</strong> a link to join. It works
              once, and they set up their own sign-in from it.
              {exactAddress && ' They have to accept it signed in as this exact address.'}
            </p>
            <CopyableField label="Their email" value={created.email} mono />
          </>
        ) : (
          <>
            {/* Stated first and without hedging. A supervisor who reads nothing
                else on this panel has to leave knowing the invite is sitting
                still until they act. */}
            <p className={styles.handoffLead} data-testid="invite-handoff">
              <strong>{created.email}</strong> can now join, but we didn’t email them —
              send them the link yourself.{' '}
              {tokenLink
                ? `It works once, so send it only to them.${
                  exactAddress ? ' They have to accept it signed in as this exact address.' : ''}`
                : 'They have to sign in with this exact address for the invite to find them.'}
            </p>
            <CopyableField label="Their email" value={created.email} mono />
            <CopyableField label={tokenLink ? 'Invitation link' : 'Sign-in link'} value={signInUrl} mono />
            {created.role === 'agent' && <AgentLinkNote />}
          </>
        )}
        <div className={styles.modalFooter}>
          <button type="button" className="btn-primary" onClick={onInvited} data-autofocus="true">
            Done
          </button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal open size="sm" onClose={onClose} title="Invite Team Member">
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
          <select
            id="invite-role"
            value={role}
            onChange={(e) => setRole(e.target.value as InviteUserInput['role'])}
          >
            {INVITE_ROLES.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </select>
        </div>
        <div className="form-group">
          <label htmlFor="invite-account">Account (optional)</label>
          <select
            id="invite-account"
            value={accountId}
            onChange={(e) => setAccountId(e.target.value)}
          >
            <option value="">Tenant-level</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </div>
        {error && <p className="error-text">{error}</p>}
        <div className={styles.modalFooter}>
          <button type="button" className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          {/* "Create", not "Send". This button writes a membership; it does not
              deliver anything, and saying "Send" is what left supervisors
              believing an email had gone out. The panel that follows explains
              who does the sending. */}
          <button type="submit" className="btn-primary" disabled={submitting || !email.trim()}>
            <UserPlus size={14} />
            {submitting ? 'Creating...' : 'Create Invite'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
