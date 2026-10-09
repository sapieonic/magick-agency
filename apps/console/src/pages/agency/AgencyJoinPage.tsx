import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Mail, KeyRound, Headset, ListChecks } from 'lucide-react';
import { useAuth, type InviteCredential } from '../../contexts/AuthContext';
import { getInvite, InviteIdentityInUseError, InviteUnavailableError } from '../../api/invites';
import type { AgencyInvite, InviteUnavailableStatus } from '../../types/invite';
import type { Role } from '../../types/auth';
import { AGENCY_LOGIN_PATH } from '../../utils/returnPath';
import { getErrorMessage } from '../../utils/errors';
import { formatDate } from '../../utils/format';
import {
  type AccountRole,
  trackAgencyInviteAddressMismatch,
  trackAgencyInviteClaimAttempted,
  trackAgencyInviteClaimFailed,
  trackAgencyInviteClaimSucceeded,
  trackAgencyInviteViewed,
} from '../../analytics/events';
import { LoadingSpinner } from '../../components/common/LoadingSpinner';
import { brand } from '../../brand';
import styles from './AgencyJoinPage.module.css';

/**
 * Where an emailed agency invite lands: `/agency/join/:token`.
 *
 * ── The defect this page removes ───────────────────────────────────────────
 * `POST /auth/session` provisions a BRAND-NEW TENANT for an address the server does
 * not recognise (the unknown-address path of the session route), and an invited
 * agent's membership is activated by matching the address they sign in with
 * against the stub row their supervisor's invite wrote. Those two facts together
 * are the whole problem: an agent who signed up, or who picked a Google account
 * on a slightly different address, landed in a private empty tenant of their own
 * while the membership waiting for them sat unclaimed — silently, with nothing
 * told to either of them. `/agency/login` answers that by having no signup at
 * all, which closes the hazard and leaves an invited agent with no Google account
 * with no way in whatsoever. This page is that way in.
 *
 * What changes is where the authority lives. The server now mints a single-use token,
 * emails it, and exposes a claim endpoint where the TOKEN is what authorizes the
 * membership. The address the agent ends up signing in with therefore no longer
 * has to match the address the invite was sent to — so the match that was failing
 * silently is no longer load-bearing, and the two places it used to fail are the
 * two interactions this page is built around:
 *
 *  1. **Email + password.** The invited address is pre-filled and READ-ONLY. It is
 *     the one value that must not drift, and locking it removes an entire class of
 *     typo failure at the exact moment somebody is typing an address for the first
 *     time. See {@link CredentialForm}.
 *  2. **Google, on a different address.** Allowed — a personal Gmail is a real
 *     answer — but never silently. {@link AddressMismatch} is the confirmation
 *     step, and it is the single most valuable interaction on the page: today this
 *     exact case produces a stray empty tenant and nobody is told.
 *
 * ── Why this route is fully public ─────────────────────────────────────────
 * No `RequireAuth`, no `RequireCapability`, no `RequireFlag`, and each absence is
 * deliberate rather than an oversight — see the route's own commentary in
 * `App.tsx`. The short version: the visitor has no account yet, so there is no
 * session to authenticate and no tenant to resolve entitlements against, and each
 * of those gates would turn the invite link into a redirect to a sign-in page for
 * an account that does not exist.
 *
 * ── Scope: `agent` ─────────────────────────────────────────────────────────
 * The invite's `role` is rendered, never branched on. Every invite this flow was
 * built for is an agent joining a calling floor, and a workspace variant would be
 * a second product on one URL — the copy, the destination and the three steps
 * below are all specific to a station.
 */

/**
 * Where a claimed invite lands.
 *
 * `/dialer` rather than `/agency`, which is where `AgencyLoginPage` sends people:
 * that page serves both personas and defers to `AgencyHomeRedirect` to work out
 * which one signed in. Here there is no ambiguity — the invite says `agent`, and
 * `AgencyHomeRedirect` would resolve an agent to `/dialer` anyway. Going straight
 * there spares a newly-created account one redirect through a persona check whose
 * answer this page already has in its hands.
 */
const DESTINATION = '/dialer';

/** Human labels for the roles an invite can carry. Rendered, never branched on. */
const ROLE_LABELS: Record<Role, string> = {
  agent: 'Agent',
  viewer: 'Viewer',
  operator: 'Operator',
  account_admin: 'Account admin',
  tenant_admin: 'Workspace admin',
  tenant_owner: 'Workspace owner',
};

/** The role as copy. Falls back to the raw value so a role the server adds before this
 *  client knows about it renders as itself rather than as blank space. */
function roleLabel(role: Role): string {
  return ROLE_LABELS[role] ?? role;
}

/**
 * The role as the analytics catalog spells it.
 *
 * `Role` carries `tenant_owner` and `AccountRole` deliberately does not — an
 * invite cannot grant ownership of a workspace — so the narrowing happens here
 * rather than by widening the analytics enum to a role no event can carry. `null`
 * for that impossible case, which reads in the funnel as "an invite we could not
 * classify" and is the honest answer if the server ever sends one.
 */
function analyticsRole(role: Role): AccountRole | null {
  return role === 'tenant_owner' ? null : role;
}

/**
 * What happens after they finish, in order.
 *
 * Numbered because it genuinely is a sequence — each step is unreachable until
 * the one above it is done — and because the thing an invited agent is most
 * uncertain about at this moment is not what to type, it is what they are about
 * to be dropped into.
 */
const NEXT_STEPS = [
  {
    icon: KeyRound,
    title: 'Set up your sign-in',
    desc: 'A Google account or a password — whichever you will still have in six months.',
  },
  {
    icon: Headset,
    title: 'Your station opens',
    desc: 'One screen with the call, the customer’s details, and the outcomes you record.',
  },
  {
    icon: ListChecks,
    title: 'The campaigns you are staffed on appear',
    desc: 'Your supervisor decides which lists you work; they show up here as they are assigned.',
  },
];

/** The state of the invite lookup. Kept as one value so no render can show a
 *  half-resolved page — a skeleton and an outcome are never both true. */
type Lookup =
  | { phase: 'loading' }
  | { phase: 'invite'; invite: AgencyInvite }
  | { phase: 'unavailable'; status: InviteUnavailableStatus }
  | { phase: 'unreachable'; message: string };

/** Which async action is in flight. One value, so nothing can double-submit:
 *  every control on the page is disabled while this is non-null. */
type Pending = null | 'google' | 'create' | 'sign_in' | 'confirm' | 'decline';

/** Addresses are compared case-insensitively and trimmed. Gmail's dot and `+tag`
 *  equivalences are deliberately NOT normalised away: the server matches on the exact
 *  string, so treating `a.b@gmail.com` as the invited `ab@gmail.com` here would
 *  suppress a confirmation for a mismatch the backend still sees. */
function sameAddress(a: string | null, b: string): boolean {
  return typeof a === 'string' && a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** Firebase throws `FirebaseError`, whose `code` is the only stable part of it —
 *  the message is localised and reworded between SDK releases. */
function firebaseCode(err: unknown): string {
  if (typeof err === 'object' && err !== null && 'code' in err) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return '';
}

/**
 * A Firebase failure as something worth reading.
 *
 * Firebase's own messages are written for developers ("Firebase: Error
 * (auth/wrong-password)."), and this page is read by somebody who has never seen
 * the product. Anything unrecognised falls through to the raw message rather than
 * a generic apology: an unknown failure the user can quote is more useful than a
 * known-looking one they cannot.
 */
function credentialMessage(err: unknown): string {
  switch (firebaseCode(err)) {
    case 'auth/wrong-password':
    case 'auth/invalid-credential':
      return 'That password does not match this address. Try again, or use Google instead.';
    case 'auth/user-not-found':
      return 'That address has no password yet. Create one below.';
    case 'auth/too-many-requests':
      return 'Too many attempts. Wait a minute and try again.';
    case 'auth/popup-closed-by-user':
    case 'auth/cancelled-popup-request':
      return 'The Google window closed before you finished. Try again.';
    case 'auth/popup-blocked':
      return 'Your browser blocked the Google window. Allow pop-ups for this site, or create a password instead.';
    case 'auth/network-request-failed':
      return 'We could not reach the network. Check your connection and try again.';
    case 'auth/weak-password':
      return 'That password is too easy to guess. Make it longer.';
    default:
      return getErrorMessage(err, 'That did not work. Try again.');
  }
}

/** How a password is doing, as something to show WHILE it is typed. */
interface PasswordAssessment {
  /** 0–4, for the meter. */
  score: number;
  /** The reason it cannot be submitted, or `null` when it can. */
  blocker: string | null;
  /** Advice. Never a reason to refuse — only ever how to do better. */
  hint: string;
}

/**
 * Assess a password as it is typed.
 *
 * ── Why the page has a rule of its own instead of letting Firebase answer ──
 * Firebase's floor is six characters and it reports a violation only after a
 * round trip, as `auth/weak-password` — which on this page means an agent who has
 * chosen a password, pressed the button, waited, and been refused with no idea
 * what would have worked. The floor here is eight, stated up front and enforced
 * before the network, so the refusal cannot arrive as a surprise; everything above
 * the floor is advice rather than a gate, because a page that argues with somebody
 * about their password is a page they leave.
 *
 * The address rule is the one non-length blocker and it is worth the exception:
 * the local part is pre-filled, on screen, and unchangeable, so "the bit before
 * the @, twice" is the single likeliest password anybody types here.
 */
function assessPassword(password: string, email: string): PasswordAssessment {
  const local = email.split('@')[0] ?? '';

  if (password.length === 0) {
    return { score: 0, blocker: 'Choose a password.', hint: 'At least 8 characters.' };
  }
  if (password.length < 8) {
    return {
      score: 0,
      blocker: `At least 8 characters — ${8 - password.length} to go.`,
      hint: 'At least 8 characters.',
    };
  }
  if (local.length >= 3 && password.toLowerCase().includes(local.toLowerCase())) {
    return {
      score: 1,
      blocker: 'That contains your own address. Pick something unrelated to it.',
      hint: 'Pick something unrelated to your address.',
    };
  }

  const score =
    (password.length >= 12 ? 1 : 0) +
    (/[a-z]/.test(password) && /[A-Z]/.test(password) ? 1 : 0) +
    (/\d/.test(password) ? 1 : 0) +
    (/[^A-Za-z0-9]/.test(password) ? 1 : 0);

  const hint =
    score >= 3
      ? 'Strong enough. You will not be asked for it again on this device.'
      : password.length < 12
        ? 'Longer is the easiest way to make this stronger — try three unrelated words.'
        : 'Add a number or a symbol to make this stronger.';

  return { score: Math.max(score, 1), blocker: null, hint };
}

/** The meter's four rungs, in the order they light up. */
const STRENGTH_LABELS = ['Too short', 'Weak', 'Fair', 'Good', 'Strong'];

// ── Screens ────────────────────────────────────────────────────────────────

/**
 * The invite cannot be used, and each reason gets its own words and its own way
 * out.
 *
 * ── Why four screens and not one "invalid link" ────────────────────────────
 * The recipient can act on exactly one of these on their own. Collapsing them
 * into a generic refusal costs the other three their next step: an expired invite
 * needs a resend and the person who can send it is named in the copy, a claimed
 * one means they already did this and belong at the sign-in page, a revoked one is
 * a decision somebody made and a resend request would be answered with "no", and a
 * not-found one is overwhelmingly a link an email client wrapped across two lines
 * — which is fixable by the recipient alone, in ten seconds, if anybody tells them
 * that is what happened.
 *
 * `identity_already_bound` is the server's fifth, added after this page was first
 * written. It means the invited user row already has a real account behind it —
 * they were invited, and then signed in by some other route before opening the
 * link. The server refuses to rebind the row and leaves the invitation outstanding,
 * so the honest reading is not "your invitation is broken" but "you are already
 * set up": the account exists, at that address, and the sign-in page is the whole
 * remedy. Told as its own screen rather than folded into `claimed`, because the
 * two differ in the one detail that decides what to do when signing in does not
 * work — `claimed` means this link was used, this one means it never had to be.
 */
const UNAVAILABLE_COPY: Record<
  InviteUnavailableStatus,
  { title: string; body: string; action: 'sign_in' | 'none' }
> = {
  expired: {
    title: 'This invitation has expired',
    body: 'Invitations are only good for a few days. Ask your supervisor to send a new one — it will arrive at the same address and work the same way.',
    action: 'none',
  },
  claimed: {
    title: 'This invitation has already been used',
    body: 'The workspace is set up and waiting for you. Sign in with the account you created and your station will open.',
    action: 'sign_in',
  },
  revoked: {
    title: 'This invitation is no longer valid',
    body: 'It was withdrawn before it was used. Your supervisor will know why, and can send a new one if it was withdrawn by mistake.',
    action: 'none',
  },
  not_found: {
    title: 'We cannot find that invitation',
    body: 'Links like this are long, and email programs often break them across two lines. Go back to the message and copy the whole link, or ask your supervisor to send it again.',
    action: 'none',
  },
  identity_already_bound: {
    title: 'You are already set up',
    body: 'This address already has an account, so there is nothing left to accept. Sign in and your station will open. If signing in does not work, ask your supervisor to send a new invitation.',
    action: 'sign_in',
  },
};

function Unavailable({ status }: { status: InviteUnavailableStatus }) {
  const copy = UNAVAILABLE_COPY[status];
  const heading = useRef<HTMLHeadingElement>(null);

  /*
    Focus moves to the heading, for the reason {@link AddressMismatch} does the
    same: this screen routinely REPLACES the card mid-claim — a supervisor
    revoked the invitation while the form was open, or a second tab won the race
    — so the button somebody just pressed disappears, focus falls to `<body>`,
    and a screen-reader user is told nothing at all about a page that changed
    completely under them. The heading is where the outcome is; it is also the
    top of the only content there is, so doing it on a cold load costs nothing.
  */
  useEffect(() => { heading.current?.focus(); }, []);

  return (
    <div className={styles.card}>
      <div className={styles.wordmark}>{brand.name}</div>
      <p className={styles.eyebrow}>Agency Dialer</p>
      <h1 className={styles.outcomeTitle} tabIndex={-1} ref={heading}>{copy.title}</h1>
      <p className={styles.outcomeBody}>{copy.body}</p>
      {copy.action === 'sign_in' && (
        <Link to={AGENCY_LOGIN_PATH} className="btn-primary" style={{ width: '100%' }}>
          Go to sign in
        </Link>
      )}
    </div>
  );
}

/**
 * The lookup itself failed — a network blip, or the server being unreachable.
 *
 * Separate from the four above because it is the only one that may resolve by
 * itself, which is exactly what makes a retry button the right control and a
 * "contact your supervisor" the wrong one. Telling somebody to chase a colleague
 * over a five-second outage is how a working invite becomes a support ticket.
 */
function Unreachable({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className={styles.card}>
      <div className={styles.wordmark}>{brand.name}</div>
      <p className={styles.eyebrow}>Agency Dialer</p>
      <h1 className={styles.outcomeTitle}>We could not open your invitation</h1>
      <p className={styles.outcomeBody}>
        The link looks fine — we just could not reach us to read it. This is usually
        the connection rather than the invitation.
      </p>
      <p className={styles.errorText} role="alert">{message}</p>
      {/*
        No busy state on this button, and that is not an omission: `load()` puts
        the page back into `loading`, so pressing it replaces this whole screen
        with the skeleton. A disabled "Trying again…" would be a state that can
        never be seen.
      */}
      <button type="button" className="btn-primary" onClick={onRetry} style={{ width: '100%' }}>
        Try again
      </button>
    </div>
  );
}

/**
 * The Google account signed in with is not the address the invite was sent to.
 *
 * ── Why this stops the flow instead of proceeding ──────────────────────────
 * Because today, this exact case is how agency onboarding fails in silence. An
 * agent invited at `priya@acme.com` presses Continue with Google, the browser
 * hands over the personal account it is already signed into, and `POST
 * /auth/session` provisions a tenant for THAT address — leaving the agent as the
 * owner of an empty workspace, the real membership unclaimed, and neither of them
 * told anything at all. The claim endpoint means linking the two accounts is now
 * a legitimate answer rather than an accident, so the page does not refuse it. It
 * refuses to do it QUIETLY: the two addresses are shown side by side, the sentence
 * names what will happen, and nothing is claimed until somebody says yes.
 *
 * ── The decline is a sign-out, not a state reset ───────────────────────────
 * "Use a different account" drops the Firebase credential as well as this screen.
 * Without it the wrong Google account stays the browser's current user, and the
 * next popup re-selects it without asking — so the escape hatch would return them
 * to the same screen and read as a page that does not work.
 */
function AddressMismatch({
  signedInAs,
  invitedAs,
  onConfirm,
  onDecline,
  pending,
}: {
  signedInAs: string;
  invitedAs: string;
  onConfirm: () => void;
  onDecline: () => void;
  pending: Pending;
}) {
  const heading = useRef<HTMLHeadingElement>(null);

  /*
    Focus moves to the heading when this replaces the options, not to a button.
    The heading is where the question is; landing on "Continue" would put a screen
    reader user on an answer before they had been asked, and this is the one
    decision on the page that must not be made by reflex.
  */
  useEffect(() => { heading.current?.focus(); }, []);

  return (
    <div className={styles.mismatch}>
      <h2 className={styles.mismatchTitle} tabIndex={-1} ref={heading}>
        That is a different address
      </h2>
      <p className={styles.mismatchBody}>
        You signed in as <strong className={styles.strong}>{signedInAs}</strong>. This
        invitation was sent to <strong className={styles.strong}>{invitedAs}</strong>.
      </p>
      <p className={styles.mismatchBody}>
        You can use this Google account anyway — it will become how you sign in, and
        the invitation will still be claimed. Only do it if the account is yours.
      </p>
      <div className={styles.mismatchActions}>
        <button
          type="button"
          className="btn-primary"
          onClick={onConfirm}
          disabled={pending !== null}
        >
          {pending === 'confirm' ? 'Linking…' : 'Use this account'}
        </button>
        <button
          type="button"
          className="btn-secondary"
          onClick={onDecline}
          disabled={pending !== null}
        >
          {pending === 'decline' ? 'Signing out…' : 'Use a different account'}
        </button>
      </div>
    </div>
  );
}

/**
 * A `<Link>` off this page that must not be taken while a claim is in flight.
 *
 * ── The race it closes ─────────────────────────────────────────────────────
 * `pending` disables every BUTTON on the card, which is what stops a double
 * claim — but the two links out of here were never part of that, and they are
 * reachable at exactly the wrong moment. Confirm the address mismatch, and while
 * `claimInvite` is in flight press "Sign in instead": this page unmounts, its
 * cleanup signs out, and that sign-out races the `adoptSession` that has just
 * bound the membership. The agent ends up signed out, on a door telling them to
 * use an account they were signed out of, holding an invitation that is already
 * spent — the one failure on this page that cannot be retried, because the token
 * is single-use.
 *
 * `aria-disabled` plus a suppressed default rather than removing the link.
 * Removal moves focus to `<body>` mid-action and takes the affordance away
 * without saying why; this keeps it in the document and in the tab order,
 * announced as unavailable, and it comes back the moment the claim settles —
 * which for a refused claim is immediately, because that is when the visitor
 * most needs it.
 *
 * Its `onClick` is what actually refuses, not the styling: `pointer-events` would
 * leave a keyboard Enter working, and this is a `<Link>`, so the default it must
 * suppress is a router navigation rather than a form submit.
 */
function GuardedLink({
  to,
  disabled,
  className,
  children,
}: {
  to: string;
  disabled: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <Link
      to={to}
      className={className}
      aria-disabled={disabled || undefined}
      onClick={(e) => { if (disabled) e.preventDefault(); }}
    >
      {children}
    </Link>
  );
}

/**
 * The email + password half, revealed under the Google button.
 *
 * ── The address field is read-only, and that is the design ─────────────────
 * It is pre-filled from the invite and cannot be edited. The invited address is
 * the one value on this page that must not drift, and an editable field here would
 * reintroduce — one keystroke at a time — the very mismatch the token was minted
 * to make survivable. `readOnly` rather than `disabled` on purpose: a disabled
 * input is skipped by keyboard navigation and read as unavailable, when what is
 * true is the opposite — it is the most important value on the screen and it is
 * settled.
 */
function CredentialForm({
  invite,
  password,
  onPasswordChange,
  assessment,
  existing,
  pending,
  onSubmit,
}: {
  invite: AgencyInvite;
  password: string;
  onPasswordChange: (value: string) => void;
  assessment: PasswordAssessment;
  existing: boolean;
  pending: Pending;
  onSubmit: (e: React.FormEvent) => void;
}) {
  const field = useRef<HTMLInputElement>(null);

  /*
    Focus lands in the password box the moment this reveals, and again when the
    form flips to "you already have a password" — both are moments where the page
    changed under somebody and the next thing to do is type. Without it a keyboard
    user has to tab back past the Google button to reach the only field that just
    appeared.
  */
  useEffect(() => { field.current?.focus(); }, [existing]);

  return (
    <form className={styles.form} onSubmit={onSubmit}>
      <div className={styles.field}>
        <label htmlFor="join-email">Your address</label>
        <input
          id="join-email"
          type="email"
          value={invite.email}
          readOnly
          aria-describedby="join-email-note"
          className={styles.readOnlyInput}
        />
        <p id="join-email-note" className={styles.fieldNote}>
          This is the address the invitation was sent to, so it cannot be changed here.
        </p>
      </div>

      <div className={styles.field}>
        <label htmlFor="join-password">
          {existing ? 'Your password' : 'Choose a password'}
        </label>
        <input
          id="join-password"
          ref={field}
          type="password"
          value={password}
          onChange={(e) => onPasswordChange(e.target.value)}
          autoComplete={existing ? 'current-password' : 'new-password'}
          aria-describedby="join-password-note"
          required
        />
        {existing ? (
          <p id="join-password-note" className={styles.fieldNote}>
            This address already has a password on {brand.name}. Enter it and we will
            add this workspace to it.
          </p>
        ) : (
          <div id="join-password-note" className={styles.strength}>
            {/*
              A meter and a sentence, updated as they type. The whole reason this
              exists is that the alternative — Firebase answering `auth/weak-password`
              after a round trip — tells somebody their password is wrong without
              ever telling them what would be right.
            */}
            <div className={styles.strengthTrack} aria-hidden="true">
              <span
                className={styles.strengthFill}
                data-score={assessment.score}
                style={{ width: `${(assessment.score / 4) * 100}%` }}
              />
            </div>
            <p className={styles.strengthText}>
              {password.length > 0 && (
                <span className={styles.strengthLabel} data-score={assessment.score}>
                  {STRENGTH_LABELS[assessment.score]}
                </span>
              )}
              {assessment.blocker && password.length > 0 ? assessment.blocker : assessment.hint}
            </p>
          </div>
        )}
      </div>

      <button
        type="submit"
        className="btn-primary"
        disabled={pending !== null}
        style={{ width: '100%' }}
      >
        {pending === 'create' || pending === 'sign_in'
          ? 'Joining…'
          : existing
            ? 'Sign in and join'
            : 'Create my sign-in'}
      </button>
    </form>
  );
}

// ── The page ───────────────────────────────────────────────────────────────

export default function AgencyJoinPage() {
  const { token = '' } = useParams<{ token: string }>();
  const navigate = useNavigate();
  const { establishInviteCredential, claimInvite, logout } = useAuth();

  const [lookup, setLookup] = useState<Lookup>({ phase: 'loading' });
  const [showPassword, setShowPassword] = useState(false);
  const [existing, setExisting] = useState(false);
  const [password, setPassword] = useState('');
  const [pending, setPending] = useState<Pending>(null);
  const [error, setError] = useState<string | null>(null);
  /**
   * The way onward from the error, when the error has one.
   *
   * Only `identity_in_use` sets it today: the server refuses that claim because the
   * Google account already belongs to a different user row here, and its advice
   * — "sign in with it directly" — is a page this app has and had no link to.
   * Kept beside `error` rather than folded into the message so the remedy is a
   * control rather than a sentence describing one.
   */
  const [errorAction, setErrorAction] = useState<'sign_in' | null>(null);
  const [mismatch, setMismatch] = useState<InviteCredential | null>(null);

  /** Clear both halves of the alert. Every action that can fail starts here. */
  const clearError = useCallback(() => {
    setError(null);
    setErrorAction(null);
  }, []);

  /**
   * The three facts the cleanup below needs, none of which anything renders from:
   * whether this page is still on screen, whether a Firebase credential exists
   * that no claim has spent, and whether a claim has been SENT.
   *
   * ── `claimSent`, not `claimed`, and it goes up BEFORE the await ───────────
   * It used to be assigned after `await claimInvite(token)` returned, which left
   * a window where the request was in flight and this page believed nothing had
   * been claimed. Anything unmounting in that window — the two `<Link>`s, a
   * back-navigation, a phone switching apps — ran the sign-out below against a
   * claim that was landing, so `logout()` raced the `adoptSession` that had just
   * bound the membership. What that leaves is a signed-out agent whose invitation
   * is already spent, on a door telling them to use an account they were just
   * signed out of, holding a token they cannot use twice. So the flag goes up
   * when the claim is issued and comes back down only if it is REFUSED, which is
   * the one case where the credential is still ours to clean up.
   *
   * See {@link AuthContextValue.claimInvite} for why the claim is what ends the
   * join.
   */
  const mounted = useRef(true);
  const liveCredential = useRef(false);
  const claimSent = useRef(false);

  /**
   * Drop a credential that arrived after the visitor had already gone.
   *
   * This page's continuations outlive it: `establishInviteCredential` opens a
   * popup somebody can walk away from, and the promise resolves either way. A
   * credential landing on a page nobody is looking at has no claim coming, so it
   * is precisely the orphan the whole flow is about — and on the mismatched-
   * address path it would otherwise be left signed into Firebase with no page
   * left to clean it up.
   *
   * A failed sign-out is not silently fine, but it is not this page's problem
   * either: `AuthContext` keeps the join marker standing whenever `signOut`
   * rejects, so the credential stays suppressed everywhere and the next load in
   * this tab drops it. That backstop is what makes catching here honest rather
   * than a swallow.
   */
  const dropStrandedCredential = useCallback(() => {
    liveCredential.current = false;
    void logout().catch(() => { /* the marker outlives it — see `AuthContext` */ });
  }, [logout]);

  /**
   * Leaving the page with an unclaimed credential SIGNS OUT.
   *
   * ── The two ways off this page that used to strand one ────────────────────
   * "Sign in instead" in the panel beside the card, and "Go to sign in" on a
   * terminal screen, are ordinary `<Link>`s: nothing stopped somebody taking
   * either while signed into Firebase as an account that had just failed the
   * address check. The credential outlives the page (Firebase persists it in
   * localStorage), the suppression that keeps the provider from syncing it does
   * not survive a full page load, and `POST /auth/session` provisions a tenant
   * for an address the server does not recognise — so walking away from the mismatch
   * screen produced the stray empty tenant this page exists to abolish, one
   * navigation later.
   *
   * This is the same act as the mismatch screen's "Use a different account",
   * applied to every other way out. `logout()` also clears the join marker, so
   * the tab is left in a state where the next page load is an ordinary one.
   *
   * Deliberately NOT run once a claim has been SENT — that credential is being
   * bound to a real membership — nor when nothing was ever established, which is
   * what makes it safe under StrictMode's mount/unmount/mount in development.
   *
   * ── `mounted` is what the continuations read ──────────────────────────────
   * A cleanup can only act on what exists when it runs, so on its own it misses
   * the entire window before it: leaving while `establishInviteCredential` is
   * still pending escapes it, and the promise then carries on into a claim and a
   * `navigate('/dialer')` for somebody who is no longer here. So every
   * continuation on this page checks this ref, and the ones that receive a
   * credential hand it to {@link dropStrandedCredential}. Assigned on mount
   * rather than only initialised, because StrictMode mounts, cleans up and mounts
   * again against the same refs.
   */
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (claimSent.current || !liveCredential.current) return;
      dropStrandedCredential();
    };
  }, [dropStrandedCredential]);

  /**
   * The lookup, and the guard that keeps a superseded one from landing.
   *
   * ── Why this is a counter and not a closed-over `alive` flag ───────────────
   * It was one, and the flag did not guard the case its own docstring claimed.
   * Each call to `load` created its own `alive`, and the ONLY thing that ever
   * flipped one was the effect's cleanup — while `load` is also passed to
   * `Unreachable` as `onRetry`, where the returned disposer is dropped on the
   * floor. So the first request's flag stayed `true` for the life of the page: a
   * slow first answer landing after a newer one overwrote it, which is exactly
   * the sentence the flag was there to make false. It turns a resolved invitation
   * into "We could not open your invitation" and fires `agency_invite_viewed`
   * twice for one visit.
   *
   * A ref shared by every invocation fixes it because the question is not "was MY
   * request cancelled" but "is my answer still the newest" — one fact, so one
   * place to keep it. Each call takes a sequence number and only the current one
   * may write. That also covers what the old comment was right about: StrictMode
   * mounts the effect twice in development, and the second load supersedes the
   * first rather than both landing.
   */
  const lookupSeq = useRef(0);

  const load = useCallback(() => {
    const seq = ++lookupSeq.current;
    setLookup({ phase: 'loading' });
    void getInvite(token)
      .then((result) => {
        if (seq !== lookupSeq.current) return;
        if (result.status === 'pending') {
          setLookup({ phase: 'invite', invite: result.invite });
          trackAgencyInviteViewed({
            status: 'pending',
            role: analyticsRole(result.invite.role),
            has_inviter: result.invite.inviter_name !== null,
          });
          return;
        }
        setLookup({ phase: 'unavailable', status: result.status });
        trackAgencyInviteViewed({ status: result.status, role: null, has_inviter: false });
      })
      .catch((err: unknown) => {
        if (seq !== lookupSeq.current) return;
        setLookup({
          phase: 'unreachable',
          message: getErrorMessage(err, 'We could not read that invitation.'),
        });
        trackAgencyInviteViewed({ status: 'unreachable', role: null, has_inviter: false });
      });
  }, [token]);

  useEffect(() => {
    load();
    // Unmounting supersedes whatever is still in flight, so a late answer cannot
    // set state on a page that is gone — and a remount (StrictMode, or a changed
    // token) starts from a number no in-flight request holds.
    return () => { lookupSeq.current += 1; };
  }, [load]);

  /**
   * Claim, then leave — with `replace`, which is load-bearing rather than tidy.
   *
   * The token in the URL is spent the instant this succeeds. Pushing onto the
   * history stack would leave it one back-navigation away, and a browser's back
   * button after a successful join is an ordinary thing to press: the agent would
   * land on "This invitation has already been used" moments after it worked, on a
   * screen whose only affordance is a link to a sign-in page they no longer need.
   */
  const finishClaim = useCallback(
    async (method: 'create' | 'sign_in' | 'google', matched: boolean) => {
      /*
        Recorded BEFORE the request, not after the answer. From this line on, the
        unmount cleanup must read this as a join being finished rather than as an
        abandoned credential: the claim may already have bound the membership, and
        signing out from underneath it is the race described where these refs are
        declared. Put back down if — and only if — the server refuses, because then
        nothing was spent and the credential is ours to clean up again.
      */
      claimSent.current = true;
      try {
        await claimInvite(token);
      } catch (err) {
        claimSent.current = false;
        /*
          Refused, and nobody is here to be told: the cleanup has already run and
          declined to act, so this is the last chance to drop the credential
          rather than leave it signed into Firebase.
        */
        if (!mounted.current) dropStrandedCredential();
        throw err;
      }
      trackAgencyInviteClaimSucceeded({ method, address_matched: matched });
      /*
        The claim landed on a page the visitor has left. It is a real session and
        it stays — but navigating somebody who has gone elsewhere would be this
        page reaching out of its own life to move them.
      */
      if (!mounted.current) return;
      navigate(DESTINATION, { replace: true });
    },
    [claimInvite, dropStrandedCredential, navigate, token],
  );

  /** Turn a thrown value into the right screen. An invite that went terminal
   *  between the lookup and the claim is a state change, not an error under a
   *  form — the form can no longer succeed, so it stops being shown. */
  const handleFailure = useCallback(
    (err: unknown, method: 'create' | 'sign_in' | 'google') => {
      if (err instanceof InviteUnavailableError) {
        trackAgencyInviteClaimFailed({ method, reason: 'invite_unavailable' });
        setLookup({ phase: 'unavailable', status: err.status });
        return;
      }
      /*
        The server's `identity_in_use`: the account they signed in with already
        belongs to a different user row here. The INVITATION is untouched and
        another account still claims it, so this is a message under the options
        rather than a terminal screen — and it is the one failure on this page
        whose remedy is somewhere else, so it carries a link there. Without it a
        visitor was told to "sign in with it directly" on a page with nothing to
        press.
      */
      if (err instanceof InviteIdentityInUseError) {
        trackAgencyInviteClaimFailed({ method, reason: 'identity_in_use' });
        setError(err.message);
        setErrorAction('sign_in');
        return;
      }
      const code = firebaseCode(err);
      trackAgencyInviteClaimFailed({
        method,
        reason: code.startsWith('auth/') ? 'credential_error' : 'claim_error',
      });
      setError(credentialMessage(err));
      setErrorAction(null);
    },
    [],
  );

  const invite = lookup.phase === 'invite' ? lookup.invite : null;
  const assessment = assessPassword(password, invite?.email ?? '');

  const handleGoogle = async () => {
    if (!invite) return;
    clearError();
    setPending('google');
    trackAgencyInviteClaimAttempted({ method: 'google' });
    try {
      const credential = await establishInviteCredential({ method: 'google' });
      liveCredential.current = true;
      /*
        The popup is a place people walk away from — a phone switching apps, a
        back-navigation, the "Sign in instead" link taken while it was open — and
        this promise resolves regardless. Nothing here can claim any more, so the
        credential that just arrived is dropped rather than left signed in behind
        a page that no longer exists.
      */
      if (!mounted.current) {
        dropStrandedCredential();
        return;
      }
      if (!sameAddress(credential.email, invite.email)) {
        /*
          Stop here. Everything up to this point is identical to the flow that
          silently produced a stray tenant; the difference is that this branch
          exists at all, so the claim waits for an answer.
        */
        trackAgencyInviteAddressMismatch({ outcome: 'shown' });
        setMismatch(credential);
        return;
      }
      await finishClaim('google', true);
    } catch (err) {
      // Nothing was established, or the claim was refused after the visitor left:
      // `finishClaim` has already dealt with the credential, and there is no
      // longer a card to render a message in.
      if (!mounted.current) return;
      handleFailure(err, 'google');
    } finally {
      if (mounted.current) setPending(null);
    }
  };

  const handleMismatchConfirm = async () => {
    if (!mismatch) return;
    clearError();
    setPending('confirm');
    trackAgencyInviteAddressMismatch({ outcome: 'confirmed' });
    try {
      await finishClaim('google', false);
    } catch (err) {
      /*
        The confirmation STAYS on screen, and that is the fix rather than an
        omission. Clearing it here tore down `AddressMismatch` — and with it "Use
        a different account", the only control on the page that signs out — so a
        refused claim returned the visitor to the two options while Firebase still
        held the colliding account, where pressing Continue with Google
        re-selected it and failed identically. A loop with no exit, on the server's
        commonest claim conflict (`identity_in_use`, which is REACHABLE precisely
        because this page allows a mismatched address).

        Nothing needs clearing on the other branch either: an
        `InviteUnavailableError` replaces the whole card with that status's
        screen, which renders above this state and never reads it.
      */
      if (!mounted.current) return;
      handleFailure(err, 'google');
    } finally {
      if (mounted.current) setPending(null);
    }
  };

  const handleMismatchDecline = async () => {
    clearError();
    setPending('decline');
    trackAgencyInviteAddressMismatch({ outcome: 'declined' });
    trackAgencyInviteClaimFailed({ method: 'google', reason: 'mismatch_declined' });
    try {
      /*
        The credential goes, not just the screen. Leaving the wrong Google account
        as the browser's current user means the next popup re-selects it without
        asking, and the way out lands them back where they started.
      */
      await logout();
    } catch {
      /* Signing out is best-effort; the screen must clear either way, or the only
         escape from the confirmation depends on the network. */
    }
    liveCredential.current = false;
    if (!mounted.current) return;
    setMismatch(null);
    setPending(null);
  };

  const handleCredentialSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!invite) return;
    clearError();
    const method = existing ? 'sign_in' : 'create';
    trackAgencyInviteClaimAttempted({ method });

    /*
      The strength rule applies only to a password being CREATED. Applied to a
      sign-in it would lock somebody out of a workspace over a password they
      already have and cannot change from here — a rule about future passwords
      enforced against a past one.
    */
    if (method === 'create' && assessment.blocker) {
      trackAgencyInviteClaimFailed({ method, reason: 'weak_password' });
      setError(assessment.blocker);
      return;
    }

    setPending(method);
    try {
      await establishInviteCredential({
        method,
        email: invite.email,
        password,
      });
      liveCredential.current = true;
      // Same as the Google path: a credential that lands after the visitor has
      // gone has no claim coming, so it is dropped rather than stranded.
      if (!mounted.current) {
        dropStrandedCredential();
        return;
      }
      /*
        `matched` is unconditionally true on this path: the address came from the
        read-only field, which came from the invite. That is the whole value of
        locking it.
      */
      await finishClaim(method, true);
    } catch (err) {
      if (!mounted.current) return;
      if (firebaseCode(err) === 'auth/email-already-in-use') {
        /*
          Not a failure — an agent invited to a SECOND workspace, who already has
          a credential from the first. The form becomes a sign-in rather than a
          create, and the claim then attaches this membership to the account they
          already have. Reported to analytics all the same: it is a stumble in the
          flow, and how often it happens is how much of the floor works across
          more than one agency.
        */
        trackAgencyInviteClaimFailed({ method, reason: 'email_in_use' });
        setExisting(true);
        setPassword('');
        setError('That address already has a password. Enter it and we will add this workspace to it.');
      } else {
        handleFailure(err, method);
      }
    } finally {
      if (mounted.current) setPending(null);
    }
  };

  if (lookup.phase === 'loading') {
    return (
      <div className={styles.page}>
        <div className={styles.glow} />
        {/*
          A skeleton in the card's own shape rather than a bare spinner, and never
          a flash of the wrong state: the invitation and all five outcomes render
          in the same box, so anything that guessed before the answer arrived would
          be visibly replaced a moment later. The one thing this can honestly say
          before the lookup returns is that it is an invitation.
        */}
        <div className={styles.card} aria-busy="true">
          <div className={styles.wordmark}>{brand.name}</div>
          <p className={styles.eyebrow}>Agency Dialer</p>
          <div className={styles.skeleton}>
            <span className={styles.skelLine} style={{ width: '82%' }} />
            <span className={styles.skelLine} style={{ width: '64%' }} />
            <span className={styles.skelBlock} />
            <span className={styles.skelButton} />
          </div>
          <div className={styles.skeletonStatus}>
            <LoadingSpinner size="sm" />
            <span>Opening your invitation…</span>
          </div>
        </div>
      </div>
    );
  }

  if (lookup.phase === 'unavailable') {
    return (
      <div className={styles.page}>
        <div className={styles.glow} />
        <Unavailable status={lookup.status} />
      </div>
    );
  }

  if (lookup.phase === 'unreachable') {
    return (
      <div className={styles.page}>
        <div className={styles.glow} />
        <Unreachable message={lookup.message} onRetry={load} />
      </div>
    );
  }

  const { invite: pendingInvite } = lookup;

  return (
    <div className={styles.page}>
      <div className={styles.glow} />

      <div className={styles.layout}>
        {/*
          `ph-no-capture` — a security control on this card, not a preference.

          ── What was leaving the browser ────────────────────────────────────
          Autocapture, rage clicks and dead clicks are all on (`analytics/posthog.ts`),
          and posthog-js records the clicked element's own text. Everything this
          card renders is what the PII rule exists for: the invitee's address, the
          inviter's name, the workspace's name — and `capture_dead_clicks` means a
          click that does nothing at all, which on a page of static text is most of
          them, is captured too. The `before_send` redactor added alongside it
          removes invite TOKENS and nothing else; a name is not token-shaped, so
          `$elements[].$el_text` carried it out regardless.

          ── Why the class, and that it was checked rather than assumed ──────
          posthog-js walks the clicked element's ancestor chain, and a
          `ph-no-capture` anywhere in it sets `explicitNoCapture`, which makes the
          autocapture handler return before sending anything and reduces a dead
          click's properties to an empty bag. Read out of the build this repo pins
          rather than taken from the docs, and pinned in two places:
          `analytics/autocaptureOptOut.test.ts` watches the dependency, and this
          page's own suite watches that the PII is inside the marked subtree.

          It is not the only line of defence, because it is a dependency's
          behaviour: `analytics/redact.ts`'s `stripJoinPageElements` takes the
          element payload off any capture made on this route at the `before_send`
          boundary, which covers a click outside this card as well as a posthog-js
          that ever stops honouring the class.

          The whole card rather than the four PII elements inside it, because the
          rule "nothing on this card is capturable" survives somebody adding a
          fifth line to it and a per-element list does not. Nothing is lost from
          the funnel: every step of it is an explicit `agency_invite_*` event with
          PII-free properties, and those are `posthog.capture` calls that this
          class does not touch.
        */}
        <div className={`${styles.card} ph-no-capture`}>
          <div className={styles.wordmark}>{brand.name}</div>
          <p className={styles.eyebrow}>Agency Dialer</p>

          <h1 className={styles.title}>
            You have been added to {pendingInvite.product_name}
          </h1>
          {/*
            Two independent absences, each dropping its own clause rather than
            filling it. `inviter_name` is null for a system or API invite;
            `tenant_name` is null whenever the server's tenant lookup came back empty
            — it sends `tenant?.name ?? null` on purpose, refusing to substitute
            a raw tenant UUID for a name at an unauthenticated caller. Typed as a
            plain string, this rendered "You have been set up as Agent at ." with
            an empty `<strong>` mid-sentence, on the one page in the product that
            most has to not look like phishing. There is nothing honest to put
            there — inventing "your workspace" would be this client asserting
            something the server declined to say — so the sentence simply ends.
          */}
          <p className={styles.lede}>
            {pendingInvite.inviter_name ? (
              <>
                <strong className={styles.strong}>{pendingInvite.inviter_name}</strong> has
                set you up as {roleLabel(pendingInvite.role)}
                {pendingInvite.tenant_name ? (
                  <> at <strong className={styles.strong}>{pendingInvite.tenant_name}</strong></>
                ) : null}.
              </>
            ) : (
              <>
                You have been set up as {roleLabel(pendingInvite.role)}
                {pendingInvite.tenant_name ? (
                  <> at <strong className={styles.strong}>{pendingInvite.tenant_name}</strong></>
                ) : null}.
              </>
            )}
          </p>

          {/*
            The invited address, set apart rather than folded into the sentence
            above. It is the identity being claimed and the thing the whole flow
            has historically got wrong, so it is shown once, plainly, where nobody
            can skim past it — and it is the same value the read-only field below
            carries.
          */}
          <p className={styles.address}>
            <Mail size={15} aria-hidden="true" />
            <span>{pendingInvite.email}</span>
          </p>

          {mismatch ? (
            <AddressMismatch
              signedInAs={mismatch.email ?? 'that Google account'}
              invitedAs={pendingInvite.email}
              onConfirm={handleMismatchConfirm}
              onDecline={handleMismatchDecline}
              pending={pending}
            />
          ) : (
            <>
              {/*
                Two options, deliberately unequal. Google is the primary because it
                is the shorter road and the one that needs no new secret; the
                password path is the reason this page exists at all — an invited
                agent without a Google account had no way in before it — so it is
                one click away rather than hidden.
              */}
              <button
                type="button"
                className={styles.googleBtn}
                onClick={handleGoogle}
                disabled={pending !== null}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
                  <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"/>
                  <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                  <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
                  <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
                </svg>
                {pending === 'google' ? 'Waiting for Google…' : 'Continue with Google'}
              </button>

              {showPassword ? (
                <>
                  <div className={styles.divider}><span>or with a password</span></div>
                  <CredentialForm
                    invite={pendingInvite}
                    password={password}
                    onPasswordChange={setPassword}
                    assessment={assessment}
                    existing={existing}
                    pending={pending}
                    onSubmit={handleCredentialSubmit}
                  />
                </>
              ) : (
                <button
                  type="button"
                  className={styles.secondaryChoice}
                  onClick={() => setShowPassword(true)}
                  disabled={pending !== null}
                >
                  Create a password instead
                </button>
              )}
            </>
          )}

          {/*
            One alert slot for the whole card. `role="alert"` is an assertive live
            region, so a failure announces itself wherever focus happens to be —
            which on this page is routinely inside the password field, several
            elements above where the message renders.

            The link lives INSIDE the region so it is announced with the sentence
            that calls for it. It is the remedy for the server's `identity_in_use`
            refusal, whose own message ends "sign in with it directly" — advice
            this page previously gave with nothing to press.
          */}
          {error && (
            <div className={styles.errorText} role="alert">
              <span>{error}</span>
              {errorAction === 'sign_in' && (
                <>
                  <br />
                  <GuardedLink
                    to={AGENCY_LOGIN_PATH}
                    className={styles.errorLink}
                    disabled={pending !== null}
                  >
                    Go to sign in
                  </GuardedLink>
                </>
              )}
            </div>
          )}

          <p className={styles.expiry}>
            This invitation stops working on {formatDate(pendingInvite.expires_at)}.
          </p>
        </div>

        {/*
          The three steps sit BESIDE the card on a desktop and BELOW it on a phone
          — not hidden, which is what `/agency/login` does with its own left panel.
          The difference is what the panel carries: there it is a persona pitch a
          returning agent has read a hundred times, here it is the only answer to
          "what am I agreeing to?" on a page somebody sees exactly once, opened
          from an email on a phone as often as not.
        */}
        <aside className={styles.steps} aria-label="What happens next">
          <p className={styles.stepsHeading}>What happens next</p>
          <ol className={styles.stepList}>
            {NEXT_STEPS.map(({ icon: Icon, title, desc }, index) => (
              <li key={title} className={styles.step}>
                <span className={styles.stepMark} aria-hidden="true">
                  <Icon size={16} />
                  <span className={styles.stepNumber}>{index + 1}</span>
                </span>
                <span>
                  <span className={styles.stepTitle}>{title}</span>
                  <span className={styles.stepDesc}>{desc}</span>
                </span>
              </li>
            ))}
          </ol>
          <p className={styles.stepsFooter}>
            Already set up?{' '}
            <GuardedLink to={AGENCY_LOGIN_PATH} disabled={pending !== null}>
              Sign in instead
            </GuardedLink>
          </p>
        </aside>
      </div>
    </div>
  );
}
