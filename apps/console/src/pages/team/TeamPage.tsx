import { useState, useCallback, useMemo, useRef, useLayoutEffect, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import {
  Users,
  UserPlus,
  MoreVertical,
  ChevronDown,
  X,
  Shield,
  Trash2,
  Send,
} from 'lucide-react';
import { useTeam } from '../../hooks/useTeam';
import { useAccounts } from '../../hooks/useAccounts';
import { usePermission } from '../../hooks/usePermission';
import { useDialogA11y } from '../../hooks/useDialogA11y';
import { useTenant } from '../../contexts/TenantContext';
import { useGovernance } from '../../contexts/GovernanceContext';
import { useFeatureFlags } from '../../contexts/FeatureFlagsContext';
import { inviteUser, updateUserRole, removeUserMembership } from '../../api/users';
import { resendInvite } from '../../api/invites';
import { AGENCY_LOGIN_PATH, LOGIN_PATH } from '../../utils/returnPath';
import { CopyableField } from '../../components/common/CopyableField';
import { ROLES } from '../../config';
import { formatRelativeTime } from '../../utils/format';
import {
  PageHeader,
  PageDescription,
  LoadingSpinner,
  ErrorAlert,
  EmptyState,
  ConfirmDialog,
} from '../../components/common';
import type {
  InviteUserInput,
  InviteUserResult,
  ResendInviteResult,
  TenantMember,
  UpdateRoleInput,
} from '../../types/team';
import type { Role } from '../../types/auth';
import { trackSetupEvent } from '../../analytics/events';
import styles from './TeamPage.module.css';

/* ── Helpers ──────────────────────────────────── */

const ROLE_COLOR_MAP: Record<Role, string> = {
  tenant_owner: 'var(--accent)',
  tenant_admin: 'var(--info)',
  account_admin: 'var(--teal)',
  operator: 'var(--warning)',
  viewer: 'var(--text-muted)',
  agent: 'var(--text-muted)',
};

function getRoleLabel(role: Role): string {
  return ROLES.find((r) => r.value === role)?.label ?? role;
}

function getRoleColor(role: Role): string {
  return ROLE_COLOR_MAP[role] ?? 'var(--text-muted)';
}

/**
 * The Invite column's two values, styled the same way
 * `ROLE_COLOR_MAP` styles the Role column beside it — `--warning` for a state
 * that needs attention, `--success` for the settled one. Not `--ember`: ember
 * is reserved for what the platform is doing right now (a live call, a running
 * broadcast), and somebody who has not signed up for days is a static fact
 * about a row, not motion.
 */
const INVITE_BADGE_COLOR: Record<'active' | 'pending', string> = {
  pending: 'var(--warning)',
  active: 'var(--success)',
};

/**
 * Operator-facing copy. The wire enum (`'active' | 'pending'`) must never reach
 * the screen as-is, and `'active'` must not reach it in TRANSLATION either:
 * `Membership.status` is separately `'active' | 'inactive' | 'revoked'`, and
 * super-admin's own tenant-members table already renders a green **Active** for
 * that different fact (`SATenantDetailPage`'s `saStatusLabel`). A supervisor who
 * sees both screens would have had one word standing for two unrelated things.
 * **Joined** is the ticket's own alternative ("Pending vs Signed up (or
 * Joined)") and collides with nothing.
 */
const INVITE_BADGE_LABEL: Record<'active' | 'pending', string> = {
  pending: 'Pending',
  active: 'Joined',
};


/**
 * Whether the server has NOT told us this person has signed up — either it says
 * `'pending'`, or it says nothing at all.
 *
 * The twin of the badge's absent-field handling, and it resolves the other way
 * on purpose. This
 * one gates the Resend control, where an absent field defaulting to `'active'`
 * removes it: against a server that predates `invite_state`, Resend would
 * vanish for every agent in the product at once, silently, with nothing on
 * screen to say why. Resend is the only remedy for an expired or never-sent
 * invitation, and before this ticket it was offered to every agent regardless —
 * so `!== 'active'` is exactly the pre-change behaviour when the server is
 * silent, and a narrowing only once the server has something to say.
 *
 * Written as `!== 'active'` rather than `=== 'pending'` so a third literal
 * the server might add also keeps the control rather than removing it.
 */
export function inviteNotKnownJoined(member: TenantMember): boolean {
  return member.membership.invite_state !== 'active';
}

/**
 * The Invite cell: has this person signed up for Magick Agency yet.
 *
 * A component rather than repeated `invite_state` reads inline in
 * the table, so the state is resolved ONCE per row and the colour and the label
 * can never be read from two different resolutions of it.
 *
 * ── Accessible by construction, which is why there is no ARIA here ─────────
 * It reuses the `roleBadge` pill beside it unchanged — same class, same
 * `color-mix` background, a different colour/label pair — and the fact that
 * distinguishes the two states is the rendered WORD, not the colour. So it
 * survives grayscale, a colour-blind reader and a screen reader with no added
 * affordance. An `aria-label` here would only restate the visible text, which
 * is the kind of decoration that makes real labels harder to trust.
 */
function InviteStateBadge({ member }: { member: TenantMember }) {
  const state = member.membership.invite_state;

  /**
   * Absent — an older server, or a cached SPA outliving a rollback — renders a
   * neutral placeholder and NO badge.
   *
   * There is deliberately no display default, because every default is a
   * positive claim made on no evidence, and both directions are wrong in a way
   * this column exists to prevent. `'active'` would stamp a green "Joined" on
   * an invitee who may never have signed in — the precise sentence the ticket
   * was raised to stop the page getting wrong. `'pending'` would accuse
   * established members of never having joined. "We were not told" is a third
   * thing, and the cell says it rather than picking a side.
   *
   * Its twin `inviteNotKnownJoined` keeps defaulting, because a PREDICATE has
   * to answer something: see its docstring for why its direction differs.
   */
  if (state === undefined) {
    return <span className={styles.inviteUnknown} aria-label="Unknown">—</span>;
  }

  const color = INVITE_BADGE_COLOR[state];
  return (
    <span
      className={styles.roleBadge}
      style={{ color, backgroundColor: `color-mix(in srgb, ${color} 14%, transparent)` }}
    >
      {INVITE_BADGE_LABEL[state]}
    </span>
  );
}

/**
 * `agent` is offered here.
 *
 * It used to be display-metadata only — `ROLES` carried it so an existing
 * membership rendered as "Agent" rather than the raw string, and neither picker
 * listed it, on the reasoning that a role with no way into the product was not
 * worth handing out. That reason is spent: an `agent` now lands on their
 * assigned station when they sign in, so the role is usable by the person
 * holding it, and a supervisor staffing a dialer campaign has to be able to
 * create one without a support ticket.
 *
 * Last in both lists, and it is the only entry below `viewer`: the order runs
 * most-access to least, and `agent` (level 5) is not "a smaller viewer" but a
 * different job — it holds the four `agency.*` permissions and nothing else at
 * all. The server's validators already accept it on both routes.
 */
const INVITE_ROLES: Array<{ value: Role; label: string }> = [
  { value: 'account_admin', label: 'Account Admin' },
  { value: 'operator', label: 'Operator' },
  { value: 'viewer', label: 'Viewer' },
  { value: 'agent', label: 'Agent' },
];

const CHANGE_ROLES: Array<{ value: Role; label: string }> = [
  { value: 'tenant_admin', label: 'Admin' },
  { value: 'account_admin', label: 'Account Admin' },
  { value: 'operator', label: 'Operator' },
  { value: 'viewer', label: 'Viewer' },
  { value: 'agent', label: 'Agent' },
];

function getInviteFailureReason(error: unknown): 'validation_error' | 'invite_error' | 'unknown_error' {
  const message = error instanceof Error ? error.message.toLowerCase() : '';
  if (message.includes('validation') || message.includes('invalid')) return 'validation_error';
  if (message.includes('invite') || message.includes('email')) return 'invite_error';
  return 'unknown_error';
}

/**
 * The link an invited person has to open, which somebody has to send them.
 *
 * ── This panel is now conditional on what the server says ──────────────────────
 * Everything below was written while `POST /users/invite` returned nothing this
 * client read. It now returns `invite_email` and `sign_in_url`, the response is retained, and **the hand-off renders only on
 * `sent: false`**. So the paragraphs below describe the state the platform is in
 * today rather than a permanent one, and the panel stops claiming nobody was
 * emailed on the day a transport is wired up rather than needing this file
 * changed again. `sign_in_url` is preferred over the derivation below whenever
 * the server has one, because the browser's origin is whatever deployment the
 * supervisor happens to be on.
 *
 * ── Why this exists at all, and what has since changed ──────────────────────
 * `POST /users/invite` writes a membership plus, for a new address, a stub user
 * whose `firebase_uid` is `pending_<uuid>`. The server adopts that stub on the
 * invitee's first Firebase sign-in, matched **by email** — which used to be the
 * entire activation mechanism, and it required the invited person to
 * independently arrive at the app and sign in with the exact address typed here.
 *
 * **"Nothing sends that invite" is no longer true, and this comment used to say
 * it flatly.** The server had the transport all along (`notifications/mailjet.client.ts`,
 * already sending bulk-dispatch completion mail) and no transactional path wired
 * to it. It now has one: an `agent` invite mints a single-use token, mails a link
 * to `/agency/join/:token`, and the claim endpoint binds whatever identity the
 * invitee arrives with to the membership the TOKEN names — so the email match is
 * not what activates them any more, and an invited agent with no Google account
 * has a way in for the first time.
 *
 * That is why the panel branches instead of asserting: `invite_email.sent` is
 * the server's own answer for this invite, on this deployment, with this
 * configuration. Every other role still gets no token and no mail (see
 * `roleGetsTokenInvite`), and a server with no `platformEmail` block still
 * answers `not_configured` — both land on the hand-off below, which is the older
 * behaviour kept for exactly the cases that still need it rather than a claim
 * about the platform.
 *
 * Where mail did not go, the honest fix is unchanged: hand the supervisor the two
 * things they need to pass on themselves, and say plainly that passing them on is
 * now their job.
 *
 * ── The agency door for an agent, and why only for an agent ────────────────
 * An `agent` is hierarchy level 5 and inherits no navigation at all, so the app
 * shell is a page with nothing on it — and `/login`, which fronts that shell,
 * sells a product they will never open and offers a Sign Up tab that would put
 * them in a private empty tenant instead of the workspace they were invited to
 * (see `AGENCY_LOGIN_PATH` in `utils/returnPath.ts`). So their link is the agency
 * door, which lands them on their station by way of `AgencyHomeRedirect`.
 *
 * This replaces a `?next=%2Fdialer` on `/login`. The destination is no longer
 * pinned here because it no longer needs to be: the agency door defaults to
 * `/agency`, which resolves the persona from the RBAC role, so the landing rule
 * lives in one place instead of being copied into every link that points at
 * sign-in.
 *
 * Only an `agent`. A supervisor is `account_admin` or above and legitimately
 * administers in `/app` — team, credits, invoices, settings — so their invite
 * lands them on the shell that has all of that, and they reach the dialer from
 * its nav entry. Sending every `account_admin` invite to the agency door would be
 * wrong for the majority of tenants, which have no dialer at all. Supervisors are
 * first-class AT the agency door — it is ungated, and an already-signed-in visitor
 * is forwarded straight on rather than shown a form, so a bookmarked
 * `/agency/login` lands a supervisor on their campaigns by way of
 * `AgencyHomeRedirect` (see `AgencyLoginPage`'s signed-in branch, which is what
 * makes that true). The invite link simply is not where that is decided.
 *
 * `window.location.origin` is read at call time rather than at module load: this
 * file is imported by unit tests under jsdom, and a module-level read would freeze
 * whatever origin the first importer happened to have.
 */
export function inviteSignInUrl(role: InviteUserInput['role'], origin: string): string {
  return `${origin}${role === 'agent' ? AGENCY_LOGIN_PATH : LOGIN_PATH}`;
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

/* ── Invite Modal ─────────────────────────────── */

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

interface InviteModalProps {
  /** Dismiss without having created anything. */
  onClose: () => void;
  /** The supervisor is finished with the hand-off panel: close it. */
  onInvited: () => void;
  /** An invite was created — refresh the member list, but leave the modal open. */
  onCreated: () => void;
}

function InviteModal({ onClose, onInvited, onCreated }: InviteModalProps) {
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

  const { titleId, dialogRef } = useDialogA11y({ open: true, onClose });

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

    return (
      <div className={styles.overlay} onClick={onInvited} role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className={styles.modal} onClick={(e) => e.stopPropagation()} ref={dialogRef}>
          <div className={styles.modalHeader}>
            <h2 className={styles.modalTitle} id={titleId}>
              {emailed ? 'Invite sent' : 'Now send them the link'}
            </h2>
            <button type="button" className={styles.modalClose} onClick={onInvited} aria-label="Close">
              <X size={18} />
            </button>
          </div>
          <div className={styles.modalBody}>
            {emailed ? (
              /*
                The server emailed them. The hand-off is not shown at all — telling a
                supervisor to send a link that has already been sent produces a
                second, confusing message to the invitee, and an instruction the
                product knows to be unnecessary reads as one it cannot be trusted
                about elsewhere.

                The address is still shown, because sign-in is matched on it and
                a typo is the one failure the supervisor can still fix.
              */
              <>
                <p className={styles.handoffLead} data-testid="invite-emailed">
                  We’ve emailed <strong>{created.email}</strong> with a link to join. They
                  have to sign in with this exact address for the invite to find them.
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
                  send them the link yourself. They have to sign in with this exact
                  address for the invite to find them.
                </p>
                <CopyableField label="Their email" value={created.email} mono />
                <CopyableField label="Sign-in link" value={signInUrl} mono />
                {created.role === 'agent' && <AgentLinkNote />}
              </>
            )}
            <div className={styles.modalFooter}>
              <button type="button" className="btn-primary" onClick={onInvited} data-autofocus="true">
                Done
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.overlay} onClick={onClose} role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <div className={styles.modal} onClick={(e) => e.stopPropagation()} ref={dialogRef}>
        <div className={styles.modalHeader}>
          <h2 className={styles.modalTitle} id={titleId}>Invite Team Member</h2>
          <button type="button" className={styles.modalClose} onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </div>
        <form onSubmit={handleSubmit} className={styles.modalBody}>
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
      </div>
    </div>
  );
}

/* ── Resend an invitation ─────────────────────── */

/**
 * Whether this member's invitation can be re-issued.
 *
 * ── The one-way door this control closes ───────────────────────────────────
 * An invitation expires after seven days. The server's own copy on the join page
 * then tells the agent to "ask your supervisor to send a new one" — and until
 * this existed, the supervisor could not: `POST /users/invite` answers `409 User
 * already has a membership in this context` for the same address, so the only
 * remaining move was to delete the membership and rebuild it. `POST
 * /invites/resend` is the server's answer (it revokes any outstanding token and mints
 * a fresh one against the SAME membership), and this repo shipped no caller for
 * it, which made the dead end certain rather than possible.
 *
 * ── Why the predicate is now the role AND `invite_state`, not the role alone ─
 * It used to be the role alone, and the reason was that the members list had no
 * way to answer "has this person signed up?" at all: `GET /tenants/:id/members`
 * returned no `firebase_uid` — the field that distinguishes a `pending_<uuid>`
 * stub from an activated account — and guessing from a null `display_name`
 * would have been worse than not narrowing, since a real email/password user
 * who has signed up has one too. That gap is what `invite_state` closes: the server now answers the identity question itself, on
 * the same route, from the one rule it applies to every role — `pending` iff
 * the stored identity is still a placeholder stub, `active` otherwise.
 *
 * What that buys is narrower than it sounds, and the narrowness is why the
 * default matters. `invite_state` is a fact about the PERSON, not about this
 * workspace's invitation: somebody who already had a Magick Agency login reads
 * `active` from the moment they are invited here, so hiding Resend from them is
 * a judgement about who is likely to need it, not a statement that their
 * invitation was used. The server's `POST /invites/resend` has no refusal for an
 * already-joined membership — it would mint and mail a fresh link quite
 * happily — so this narrowing is the UI's own, and it is deliberately the only
 * place the identity signal is allowed to REMOVE a control.
 *
 * Hence `inviteNotKnownJoined` rather than `invite_state ===
 * 'pending'`: the two differ only on an absent field, and here that difference
 * is the whole control. A server that predates `invite_state` sends nothing,
 * and reading that as `'active'` would take Resend away from every agent in the
 * product at once — a silent, platform-wide regression on the only remedy for
 * an expired invitation, reachable by an ordinary rollback or by a browser
 * holding a cached SPA. Absent therefore means "still offer it", which is
 * exactly what shipped before this ticket.
 *
 * The role test is NOT made redundant by any of that and stays for its
 * original, unrelated reason: `roleGetsTokenInvite` in the server mints a token for
 * an `agent` and for nobody else, so a resend for any other role — signed up or
 * not — sends the same non-token mail a first invite would and cannot produce a
 * claimable link. `invite_state` answers "has this person signed up"; it says
 * nothing about whether resending *does* anything, which is what the role test
 * is for. Both conditions narrow different failure modes and neither
 * substitutes for the other.
 *
 * ── What is still imprecise ────────────────────────────────────────────────
 * Two things, and neither is knowable from this route. The members list is a
 * snapshot fetched on page load, so somebody who signs up between that fetch
 * and a supervisor pressing this button still reads `pending` here; and an
 * agent who has a login but has never opened THIS workspace reads `active`, so
 * the control is withheld from a person who may genuinely be waiting on a link.
 * The server's answer to the first is unchanged — the claim fails with
 * `identity_already_bound`, which the join page renders as "You are already set
 * up — sign in", one press from the fix. The second costs a supervisor a
 * support request rather than a broken invitation, which is the cheaper of the
 * two ways to be wrong here.
 */
export function invitationIsResendable(member: TenantMember): boolean {
  return (
    member.membership.role === 'agent'
    && member.membership.status === 'active'
    && inviteNotKnownJoined(member)
  );
}

/**
 * The resend itself: one confirmation, then the same hand-off the invite modal
 * gives.
 *
 * A confirmation rather than a bare menu item that fires, because a resend is not
 * idempotent from the recipient's side — the server revokes the outstanding token
 * first, so pressing this INVALIDATES a link that may be sitting unread in the
 * agent's inbox. A supervisor who meant to press "Change Role" must not discover
 * that by having broken the link they were about to be asked about.
 *
 * The outcome reads `invite_email.sent` exactly as {@link InviteModal} does, and
 * for the same reason: whether anybody was told is the server's answer, per
 * deployment, and the panel must not claim either way on its own.
 */
function ResendInviteModal({
  member,
  onClose,
  onResent,
}: {
  member: TenantMember;
  onClose: () => void;
  /** Refresh the list — the membership itself is untouched, but its invite is not. */
  onResent: () => void;
}) {
  const { tenantId } = useTenant();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ResendInviteResult | null>(null);

  const { titleId, dialogRef } = useDialogA11y({ open: true, onClose });

  const handleResend = async () => {
    if (!tenantId) return;
    setSubmitting(true);
    setError(null);
    try {
      const answer = await resendInvite(tenantId, member.membership.id);
      setResult(answer ?? {});
      onResent();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not send that invitation');
    } finally {
      setSubmitting(false);
    }
  };

  const emailed = result?.invite_email?.sent === true;

  return (
    <div className={styles.overlay} onClick={onClose} role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <div className={styles.modal} onClick={(e) => e.stopPropagation()} ref={dialogRef}>
        <div className={styles.modalHeader}>
          <h2 className={styles.modalTitle} id={titleId}>
            {result ? (emailed ? 'Invitation sent' : 'Now send them the link') : 'Resend invitation'}
          </h2>
          <button type="button" className={styles.modalClose} onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </div>
        <div className={styles.modalBody}>
          {result ? (
            <>
              {emailed ? (
                <p className={styles.handoffLead} data-testid="resend-emailed">
                  We’ve emailed <strong>{member.user.email}</strong> a new link. Any
                  earlier one has stopped working.
                </p>
              ) : (
                <p className={styles.handoffLead} data-testid="resend-handoff">
                  <strong>{member.user.email}</strong> has a new invitation, but we didn’t
                  email them — send them the link yourself. Any earlier one has stopped
                  working.
                </p>
              )}
              <CopyableField label="Their email" value={member.user.email} mono />
              {/*
                The server's link, and only the server's. There is no client-side
                derivation for this one: the useful link carries the freshly
                minted TOKEN, which only the server has ever seen. Where it answers
                `null` (no `CONSOLE_BASE_URL` configured) the honest thing is to say
                so rather than to substitute the sign-in page, which is a URL that
                looks like the invitation and claims nothing.
              */}
              {result.sign_in_url ? (
                <CopyableField label="Invitation link" value={result.sign_in_url} mono />
              ) : (
                <p className={styles.handoffNote} data-testid="resend-no-link">
                  We could not build the link to send. Ask your administrator to set the
                  app’s public address, then resend.
                </p>
              )}
            </>
          ) : (
            <>
              <p className={styles.handoffLead}>
                Send <strong>{member.user.email}</strong> a new invitation. Any earlier link
                stops working straight away, so only do this if they still need one.
              </p>
              {error && <p className="error-text">{error}</p>}
            </>
          )}
          <div className={styles.modalFooter}>
            {result ? (
              <button type="button" className="btn-primary" onClick={onClose} data-autofocus="true">
                Done
              </button>
            ) : (
              <>
                <button type="button" className="btn-secondary" onClick={onClose}>
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn-primary"
                  onClick={handleResend}
                  disabled={submitting}
                  data-autofocus="true"
                >
                  <Send size={14} />
                  {submitting ? 'Sending...' : 'Send invitation'}
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── Actions Dropdown ─────────────────────────── */

interface ActionsDropdownProps {
  member: TenantMember;
  currentRole: Role | undefined;
  onRoleChanged: () => void;
  onRemoveClick: (member: TenantMember) => void;
  onResendClick: (member: TenantMember) => void;
}

function ActionsDropdown({ member, currentRole, onRoleChanged, onRemoveClick, onResendClick }: ActionsDropdownProps) {
  const { tenantId } = useTenant();
  const canUpdateRole = usePermission('user.update_role');
  const canRemove = usePermission('user.remove');
  /* `user.invite` rather than a permission of its own: the server guards
     `POST /invites/resend` with exactly that, on the reasoning that re-issuing an
     invitation is the same act as issuing one. A menu item behind a looser check
     than the route would 403 on arrival. */
  const canResend = usePermission('user.invite') && invitationIsResendable(member);
  const [open, setOpen] = useState(false);
  const [roleMenuOpen, setRoleMenuOpen] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [menuStyle, setMenuStyle] = useState<CSSProperties>({});
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Mirrors the server's ROLE_HIERARCHY; `agent` is below `viewer` (Agency Dialer).
  const ROLE_LEVELS: Record<Role, number> = {
    agent: 5,
    viewer: 10,
    operator: 20,
    account_admin: 30,
    tenant_admin: 40,
    tenant_owner: 50,
  };

  const currentLevel = currentRole ? ROLE_LEVELS[currentRole] : 0;
  const memberLevel = ROLE_LEVELS[member.membership.role];
  const canActOn = currentLevel > memberLevel;

  const closeMenu = useCallback(() => {
    setOpen(false);
    setRoleMenuOpen(false);
  }, []);

  // Position the menu in the viewport (portaled) so table overflow cannot clip it.
  // Prefer below the trigger; flip above when there isn't enough room.
  const reposition = useCallback(() => {
    const btn = buttonRef.current;
    const menu = menuRef.current;
    if (!btn || !menu) return;

    const rect = btn.getBoundingClientRect();
    const menuHeight = menu.offsetHeight;
    const pad = 8;
    const gap = 4;
    const spaceBelow = window.innerHeight - rect.bottom - pad;
    const placeAbove = spaceBelow < menuHeight && rect.top - pad >= menuHeight + gap;
    const top = placeAbove ? rect.top - menuHeight - gap : rect.bottom + gap;
    const right = Math.max(pad, window.innerWidth - rect.right);

    setMenuStyle({
      position: 'fixed',
      top: `${Math.max(pad, top)}px`,
      right: `${right}px`,
      left: 'auto',
    });
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    reposition();
    const onReposition = () => reposition();
    window.addEventListener('resize', onReposition);
    // Capture scroll from nested overflow containers (table wrap, page content).
    window.addEventListener('scroll', onReposition, true);
    return () => {
      window.removeEventListener('resize', onReposition);
      window.removeEventListener('scroll', onReposition, true);
    };
  }, [open, roleMenuOpen, reposition]);

  const handleRoleChange = async (newRole: Role) => {
    if (!tenantId) return;
    setUpdating(true);
    try {
      await updateUserRole(tenantId, member.user.id, {
        role: newRole as UpdateRoleInput['role'],
      });
      onRoleChanged();
    } catch {
      // Silently fail — reload will show current state
    } finally {
      setUpdating(false);
      closeMenu();
    }
  };

  if (!canActOn || (!canUpdateRole && !canRemove && !canResend)) {
    return null;
  }

  return (
    <div className={styles.actionsWrap}>
      <button
        type="button"
        className={styles.actionsButton}
        ref={buttonRef}
        aria-label="Member actions"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => {
          if (open) closeMenu();
          else { setOpen(true); setRoleMenuOpen(false); }
        }}
        disabled={updating}
      >
        <MoreVertical size={16} />
      </button>
      {open && createPortal(
        <>
          <div className={styles.actionsBackdrop} onClick={closeMenu} />
          <div
            className={styles.actionsMenu}
            ref={menuRef}
            style={menuStyle}
            role="menu"
            aria-label="Member actions"
          >
            {canUpdateRole && (
              <div className={styles.actionsSubWrap}>
                <button
                  type="button"
                  className={styles.actionsItem}
                  role="menuitem"
                  onClick={() => setRoleMenuOpen(!roleMenuOpen)}
                >
                  <Shield size={14} />
                  Change Role
                  <ChevronDown size={12} className={styles.actionsChevron} />
                </button>
                {roleMenuOpen && (
                  <div className={styles.roleSubmenu}>
                    {CHANGE_ROLES.filter((r) => ROLE_LEVELS[r.value] < currentLevel && r.value !== member.membership.role).map((r) => (
                      <button
                        key={r.value}
                        type="button"
                        className={styles.roleOption}
                        role="menuitem"
                        onClick={() => handleRoleChange(r.value)}
                        disabled={updating}
                      >
                        <span
                          className={styles.roleOptionDot}
                          style={{ backgroundColor: getRoleColor(r.value) }}
                        />
                        {r.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
            {canResend && (
              /* Above Remove, and deliberately: deleting the membership was the
                 ONLY way out of an expired invitation before this existed, so the
                 recovery has to sit where the workaround was reached for. */
              <button
                type="button"
                className={styles.actionsItem}
                role="menuitem"
                onClick={() => { onResendClick(member); closeMenu(); }}
              >
                <Send size={14} />
                Resend Invite
              </button>
            )}
            {canRemove && (
              <button
                type="button"
                className={`${styles.actionsItem} ${styles.actionsItemDanger}`}
                role="menuitem"
                onClick={() => { onRemoveClick(member); closeMenu(); }}
              >
                <Trash2 size={14} />
                Remove
              </button>
            )}
          </div>
        </>,
        document.body,
      )}
    </div>
  );
}

/* ── Team Page ────────────────────────────────── */

export default function TeamPage() {
  const { tenantId, role } = useTenant();
  const { members, loading, error, reload } = useTeam();
  const canInvite = usePermission('user.invite');
  const [showInvite, setShowInvite] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState<TenantMember | null>(null);
  const [removing, setRemoving] = useState(false);
  /** The member whose invitation is being re-issued. See {@link ResendInviteModal}. */
  const [resendFor, setResendFor] = useState<TenantMember | null>(null);

  const handleInvited = useCallback(() => {
    setShowInvite(false);
    reload();
  }, [reload]);

  const handleRemove = useCallback(async () => {
    if (!tenantId || !confirmRemove) return;
    setRemoving(true);
    try {
      await removeUserMembership(tenantId, confirmRemove.user.id);
      setConfirmRemove(null);
      reload();
    } catch {
      // Error silenced — reload shows current state
    } finally {
      setRemoving(false);
    }
  }, [tenantId, confirmRemove, reload]);

  const sortedMembers = useMemo(() => {
    const ROLE_ORDER: Record<Role, number> = {
      tenant_owner: 0,
      tenant_admin: 1,
      account_admin: 2,
      operator: 3,
      viewer: 4,
      agent: 5,
    };
    return [...members].sort(
      (a, b) => (ROLE_ORDER[a.membership.role] ?? 9) - (ROLE_ORDER[b.membership.role] ?? 9),
    );
  }, [members]);

  if (error) {
    return (
      <div className={styles.page}>
        <PageHeader title="Team" badge={0} />
        <ErrorAlert message={error} onRetry={reload} />
      </div>
    );
  }

  if (loading) {
    return (
      <div className={styles.page}>
        <PageHeader title="Team" />
        <div className={styles.loadingWrap}>
          <LoadingSpinner size="lg" />
        </div>
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <PageHeader
        title="Team"
        badge={members.length}
        actions={
          canInvite ? (
            <button
              type="button"
              className="btn-primary"
              onClick={() => setShowInvite(true)}
            >
              <UserPlus size={14} />
              Invite Member
            </button>
          ) : undefined
        }
      />
      <PageDescription
        pageKey="team"
        description="Manage your team members and their access levels. Invite new users by email, assign roles to control what they can see and do, and remove members when needed."
        tips={[
          'Roles control access: Viewers can only see data, Operators can make calls, Admins can manage the account.',
          'Invited users will receive an email with instructions to join your workspace.',
        ]}
      />

      {members.length === 0 ? (
        <EmptyState
          icon={<Users size={32} />}
          title="No team members"
          description="Invite your team members to collaborate on this workspace."
          action={
            canInvite ? (
              <button
                type="button"
                className="btn-primary"
                onClick={() => setShowInvite(true)}
              >
                <UserPlus size={14} />
                Invite Member
              </button>
            ) : undefined
          }
        />
      ) : (
        <div className={styles.tableCard}>
          <div className={styles.tableWrap}>
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Email</th>
                  <th>Role</th>
                  {/* "Invite", never "Status": `membership.status` is a
                      different field with different values (`active` /
                      `inactive` / `revoked`), and super-admin's tenant-members
                      table already spends the word on it.

                      Sits beside Role, not beside the "Invited" DATE, so the
                      two headings that share a word-stem are not adjacent —
                      "Invite | Invited" side by side reads as one mistake. It
                      also groups the two facts about a person's access. */}
                  <th>Invite</th>
                  <th>Account</th>
                  {/* Renamed from "Joined": the value below has always been
                      `membership.created_at`, i.e. when the invite was WRITTEN,
                      not when the person signed up. A row for somebody who has
                      never signed in read "Joined 3 days ago" — the exact case
                      this ticket exists for — and the fix is the honest label,
                      not a different value; the Invite column beside it is what
                      actually says whether they have. */}
                  <th>Invited</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {sortedMembers.map((m) => (
                  <tr key={m.membership.id}>
                    <td>
                      <div className={styles.nameCell}>
                        <div className={styles.avatar}>
                          {(m.user.display_name ?? m.user.email).charAt(0).toUpperCase()}
                        </div>
                        <span className={styles.name}>
                          {m.user.display_name || m.user.email.split('@')[0]}
                        </span>
                      </div>
                    </td>
                    <td>
                      <span className={styles.email}>{m.user.email}</span>
                    </td>
                    <td>
                      <span
                        className={styles.roleBadge}
                        style={{
                          color: getRoleColor(m.membership.role),
                          backgroundColor: `color-mix(in srgb, ${getRoleColor(m.membership.role)} 14%, transparent)`,
                        }}
                      >
                        {getRoleLabel(m.membership.role)}
                      </span>
                    </td>
                    <td>
                      <InviteStateBadge member={m} />
                    </td>
                    <td>
                      <span className={styles.account}>
                        {m.membership.account_id ? m.membership.account_id.slice(0, 8) : 'Tenant-level'}
                      </span>
                    </td>
                    <td>
                      <span className={styles.invited}>
                        {formatRelativeTime(m.membership.created_at)}
                      </span>
                    </td>
                    <td>
                      <ActionsDropdown
                        member={m}
                        currentRole={role}
                        onRoleChanged={reload}
                        onRemoveClick={setConfirmRemove}
                        onResendClick={setResendFor}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {showInvite && (
        <InviteModal
          onClose={() => setShowInvite(false)}
          onInvited={handleInvited}
          onCreated={reload}
        />
      )}

      {resendFor && (
        <ResendInviteModal
          member={resendFor}
          onClose={() => setResendFor(null)}
          onResent={reload}
        />
      )}

      <ConfirmDialog
        open={!!confirmRemove}
        title="Remove Team Member"
        message={`Are you sure you want to remove ${confirmRemove?.user.display_name || confirmRemove?.user.email}? They will lose access to this workspace.`}
        confirmLabel={removing ? 'Removing...' : 'Remove'}
        danger
        onConfirm={handleRemove}
        onCancel={() => setConfirmRemove(null)}
      />
    </div>
  );
}
