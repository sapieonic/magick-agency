import type { Role } from '../types/auth';
import type { InviteUnavailableStatus } from '../types/invite';
import type { AccountRole } from '../analytics/events';
import { getErrorMessage } from './errors';

/**
 * The agency invite page's pure half: the words it says and the small rules
 * behind them — role labels, the address comparison, Firebase failures as
 * sentences, the password assessment, and the five "cannot be used" screens.
 *
 * Moved out of `AgencyJoinPage` so each rule is unit-tested on its own; the page
 * and the `components/agency/join/` cards render what these return.
 */

/** Human labels for the roles an invite can carry. Rendered, never branched on. */
export const ROLE_LABELS: Record<Role, string> = {
  agent: 'Agent',
  viewer: 'Viewer',
  operator: 'Operator',
  account_admin: 'Account admin',
  tenant_admin: 'Workspace admin',
  tenant_owner: 'Workspace owner',
};

/** The role as copy. Falls back to the raw value so a role the server adds before this
 *  client knows about it renders as itself rather than as blank space. */
export function roleLabel(role: Role): string {
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
export function analyticsRole(role: Role): AccountRole | null {
  return role === 'tenant_owner' ? null : role;
}

/** Addresses are compared case-insensitively and trimmed. Gmail's dot and `+tag`
 *  equivalences are deliberately NOT normalised away: the server matches on the exact
 *  string, so treating `a.b@gmail.com` as the invited `ab@gmail.com` here would
 *  suppress a confirmation for a mismatch the backend still sees. */
export function sameAddress(a: string | null, b: string): boolean {
  return typeof a === 'string' && a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** Firebase throws `FirebaseError`, whose `code` is the only stable part of it —
 *  the message is localised and reworded between SDK releases. */
export function firebaseCode(err: unknown): string {
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
export function credentialMessage(err: unknown): string {
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
export interface PasswordAssessment {
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
export function assessPassword(password: string, email: string): PasswordAssessment {
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
export const STRENGTH_LABELS = ['Too short', 'Weak', 'Fair', 'Good', 'Strong'];

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
export const UNAVAILABLE_COPY: Record<
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
