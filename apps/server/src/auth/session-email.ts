import type { DecodedFirebaseToken } from './firebase.js';

/**
 * Whether `POST /auth/session` may use the token's email to FIND or CREATE a
 * platform user.
 *
 * ── Why this exists, and why it is not `decoded.email` ──────────────────────
 * Path 1 (lookup by `firebase_uid`) is identity. Paths 2/3 (lookup by email,
 * then `adoptFirebaseIdentity`) and path 4 (INSERT a new `users` row carrying
 * that address) are not: they take a string off the token and treat it as
 * "this person owns that inbox". Firebase email/password issues an ID token
 * **before** the inbox is verified (`email_verified: false`), so anyone can
 * mint a token for `owner@customer.com` without ever seeing that mailbox.
 *
 * Super-admin tenant create and `POST /users/invite` write `pending_*` stubs
 * keyed on exactly that column. Binding on an unverified address is therefore
 * account takeover of every not-yet-activated owner and every outstanding
 * invite — including `tenant_owner`.
 *
 * ── Fail closed, and do not fall through ───────────────────────────────────
 * `email_verified !== true` (missing, false, or a non-boolean) is unverified.
 * The route must REFUSE that token on a UID miss rather than treat the email
 * as absent and continue: falling through to path 4 would plant the unverified
 * address on a new `users` row, and `users.email` is not unique, so a later
 * verified owner hitting path 2 is a coin-flip between the stub and the
 * attacker's planted row.
 *
 * Path 1 does not consult this. An already-linked user may keep signing in
 * while their Firebase email is unverified.
 *
 * A token with no email (phone auth) is `none`, not unverified: there is no
 * inbox claim to prove.
 *
 * The invite-claim route does **not** use this, and it is the one place where
 * an unverified token still binds: requiring verification as well would block
 * the email/password account created on the join page seconds earlier, which is
 * the ordinary shape of an agent's first sign-in.
 *
 * What it does NOT do any more is trust that token's ADDRESS. "Possession of a
 * token delivered to the invited inbox" is evidence only while the inviter is
 * somebody else, and `POST /users/invite` returns the raw join link to the
 * inviter — so an unverified claim writes nothing to `users.email` and marks the
 * row `email_unverified`, which is what stops this column being an identity for
 * the by-address reuse paths. See `AdoptIdentityOptions.adoptEmail` and
 * migration 073.
 */

export const EMAIL_UNVERIFIED_CODE = 'email_unverified';

export type SessionLinkEmail =
  | { status: 'none' }
  | { status: 'verified'; email: string }
  | { status: 'unverified' };

export function sessionLinkEmail(decoded: DecodedFirebaseToken): SessionLinkEmail {
  const raw = decoded.email;
  if (typeof raw !== 'string') return { status: 'none' };
  const email = raw.trim();
  if (!email) return { status: 'none' };
  if (decoded.email_verified === true) return { status: 'verified', email };
  return { status: 'unverified' };
}
