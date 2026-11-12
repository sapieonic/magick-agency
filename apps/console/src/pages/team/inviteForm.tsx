import { useState } from 'react';
import { inviteRequiresMatchingAddress } from '@magick-agency/contracts/rbac';
import { useGovernance } from '../../contexts/GovernanceContext';
import { useFeatureFlags } from '../../contexts/FeatureFlagsContext';
import { dialerOn } from '../../utils/consoleNav';
import { inviteUser } from '../../api/users';
import { CopyableField } from '../../components/common/CopyableField';
import { trackSetupEvent } from '../../analytics/events';
import type { InviteUserInput, InviteUserResult } from '../../types/team';
import { INVITE_ROLES, getRoleDescription } from './teamRoles';
import { inviteSignInUrl, isInvitationLink } from './teamInvites';
import styles from './TeamPage.module.css';

/**
 * The invite's shared half: the request and its analytics, the role picker and the
 * hand-off that follows. Two places invite somebody: Team's `InviteModal` and the
 * Accounts page's "invite the person who'll run it" card after a new account
 * (`pages/accounts/NewAccountInvite`). Each owns its own account field (a choice on
 * Team, fixed on Accounts); everything else is here, so a fix reaches both.
 */

export type InviteRole = InviteUserInput['role'];

function getInviteFailureReason(error: unknown): 'validation_error' | 'invite_error' | 'unknown_error' {
  const message = error instanceof Error ? error.message.toLowerCase() : '';
  if (message.includes('validation') || message.includes('invalid')) return 'validation_error';
  if (message.includes('invite') || message.includes('email')) return 'invite_error';
  return 'unknown_error';
}

/** A completed invite, and everything the hand-off needs to describe it. */
export interface CreatedInvite {
  email: string;
  role: InviteRole;
  /**
   * What the server said about it.
   *
   * Retained rather than discarded because two of its fields decide what the
   * hand-off is allowed to claim: `invite_email.sent` decides whether the hand-off
   * is shown at all, and `sign_in_url` is a better link than the one derived from
   * `window.location.origin` whenever the server has one. See {@link
   * InviteUserResult}.
   */
  result: InviteUserResult;
}

export interface InviteRequest {
  email: string;
  role: InviteRole;
  /** The account to put them in; `undefined` for every account (a tenant-wide seat). */
  accountId: string | undefined;
}

/**
 * Send an invite, track it, and hold what came back.
 *
 * `onCreated` runs as soon as the membership exists (Team refreshes its list then,
 * so the pending row is there when the hand-off is dismissed).
 */
export function useInviteSubmission(tenantId: string | null, onCreated?: () => void) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreatedInvite | null>(null);

  const submit = async ({ email, role, accountId }: InviteRequest): Promise<void> => {
    const invitedEmail = email.trim();
    if (!tenantId || !invitedEmail || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await inviteUser(tenantId, { email: invitedEmail, role, account_id: accountId });
      trackSetupEvent('team_invite_sent', { role, account_scoped: Boolean(accountId) });
      onCreated?.();
      /*
        `result ?? {}` because `apiFetch` returns `undefined` for a 204 and this
        route's body is not something the hand-off should crash on: an absent one is
        read exactly like an older server's — no `invite_email`, so the hand-off
        stands. A `.` into an undefined body inside a render would take the whole
        page down AFTER the membership had been written, which is the one moment
        the inviter most needs to be told what happened.
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

  return { submitting, error, created, submit };
}

/**
 * The Role select, offering the roles an invite may carry (`INVITE_ROLES`), with what the role
 * picked can do written under it (`ROLE_DESCRIPTIONS`).
 */
export function InviteRoleSelect({
  id,
  value,
  onChange,
}: {
  id: string;
  value: InviteRole;
  onChange: (role: InviteRole) => void;
}) {
  const hintId = `${id}-description`;
  return (
    <>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value as InviteRole)} aria-describedby={hintId}>
        {INVITE_ROLES.map((r) => (
          <option key={r.value} value={r.value}>
            {r.label}
          </option>
        ))}
      </select>
      <p id={hintId} className={styles.fieldHint} data-testid="invite-role-description">
        {getRoleDescription(value)}
      </p>
    </>
  );
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
  const dialerReady = settled && dialerOn({ isFlagEnabled: flagEnabled, isCapabilityEnabled: capabilityEnabled });

  if (dialerReady) {
    /* The agent's link is not the platform's front door, and the copy SAYS so
       rather than leaving the comment to explain it: a supervisor who sees an
       `/agency/login` path where they expected `/login` will otherwise wonder
       whether they copied the wrong thing, and naming the page is what pre-empts
       that support question. */
    return (
      <p className={styles.handoffNote} data-testid="agent-dialer-note">
        This link opens the dialler’s own sign-in page, so it takes them straight to
        the dialler once they’ve signed in. Assign them to a campaign and they’ll
        land on it.
      </p>
    );
  }

  return (
    <p className={styles.handoffNote} data-testid="agent-dialer-gated-note">
      This link points at the dialler, which isn’t switched on for this organisation —
      so they’ll sign in and be told it’s unavailable. Ask your administrator to
      enable the Agency Dialer before you send it.
    </p>
  );
}

/** Whether the server emailed the invitee. An absent `invite_email` is an older server: not sent. */
export function inviteWasEmailed(created: CreatedInvite): boolean {
  return created.result.invite_email?.sent === true;
}

/** The hand-off's title: what happened, or what the inviter has to do next. */
export function inviteHandoffTitle(created: CreatedInvite): string {
  return inviteWasEmailed(created) ? 'Invite sent' : 'Now send them the link';
}

/**
 * The hand-off after an invite: who was told, and if nobody was, the link to pass on.
 */
export function InviteHandoff({ created }: { created: CreatedInvite }) {
  /**
   * Whether the server actually told them.
   *
   * An absent `invite_email` is an older server, and is read as "not sent" —
   * which is both the current truth and the safe direction to be wrong in: a
   * hand-off nobody needed, rather than a hidden hand-off somebody did.
   */
  const emailed = inviteWasEmailed(created);
  /**
   * The server's link when it has one, ours otherwise.
   *
   * Both compute the same product rule (the agency door for an `agent` and
   * `/login` for every other role) from different inputs: the server from its configured
   * `CONSOLE_BASE_URL`, this client from `window.location.origin`. The server's is
   * preferred because the origin in the browser is whatever deployment the
   * inviter happens to be on — a preview build would otherwise hand out a
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
   * server's link) still finds them BY address. The advice is about which of the
   * two this is, so it reads the link rather than the role. See
   * `isInvitationLink`.
   */
  const tokenLink = isInvitationLink(signInUrl);
  /**
   * Whether THIS role's invitation can only be accepted at the invited address
   * — `account_admin` and above, by the rule the claim enforces (decision B25,
   * `inviteRequiresMatchingAddress`, shared with the server). For those the
   * "any address will do" reading below is false, and the inviter is the
   * one person who can tell the invitee before they try with the wrong account.
   */
  const exactAddress = inviteRequiresMatchingAddress(created.role);

  if (emailed) {
    /*
      The server emailed them. The hand-off is not shown at all — telling an
      inviter to send a link that has already been sent produces a second,
      confusing message to the invitee, and an instruction the product knows to
      be unnecessary reads as one it cannot be trusted about elsewhere.

      The address is still shown, because it is where the mail went and a typo is
      the one failure the inviter can still fix. What is NOT said any more for
      most roles is "they have to sign in with this exact address": a mailed
      invitation is a token link for every role, and below `account_admin` the
      join page lets them confirm a different address rather than refusing it —
      so that sentence would send somebody with only a personal account away
      believing they could not join. From `account_admin` up it is TRUE again
      (`exactAddress`), and it is said.
    */
    return (
      <>
        <p className={styles.handoffLead} data-testid="invite-emailed">
          We’ve emailed <strong>{created.email}</strong> a link to join. It works
          once, and they set up their own sign-in from it.
          {exactAddress && ' They have to accept it signed in as this exact address.'}
        </p>
        <CopyableField label="Their email" value={created.email} mono />
      </>
    );
  }

  return (
    <>
      {/* Stated first and without hedging. An inviter who reads nothing else here
          has to leave knowing the invite is sitting still until they act. */}
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
  );
}
