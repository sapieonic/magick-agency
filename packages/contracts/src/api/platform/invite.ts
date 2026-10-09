import type { Role } from './auth';

/**
 * The single-use invite an agency supervisor sends an agent, as the public
 * lookup and claim endpoints describe it.
 *
 * ── Why an invite needs its own token at all ───────────────────────────────
 * Until this existed, an invited agent's membership was activated by MATCHING
 * the address they signed in with against the stub row `POST /users/invite`
 * wrote. That match is the whole mechanism, and it fails silently in both
 * directions: `POST /auth/session` provisions a brand-new tenant for an address
 * master does not recognise, so an agent who signed up, or signed in with Google
 * on a slightly different address, landed in a private empty tenant of their own
 * while the membership their supervisor created sat unclaimed — and nothing told
 * either of them. `AgencyLoginPage`'s `UnrecognisedAccount` is what the browser
 * could do about that after the fact; it can only name the problem, because by
 * the time it renders master has already provisioned the stray tenant.
 *
 * The token closes it from the other end. On the claim endpoint the TOKEN is the
 * authority rather than the address, so the membership is claimed by whoever
 * holds the emailed link — which also means an invited agent with no Google
 * account has a way in for the first time.
 */
export interface AgencyInvite {
  /**
   * The address the invite was sent to.
   *
   * Rendered, and — on the email/password path — pre-filled into a READ-ONLY
   * field. The invited address is the one value that must not drift, and locking
   * it removes an entire class of typo failure at the exact moment somebody is
   * typing an address for the first time.
   */
  email: string;
  /** The RBAC role the membership carries. Scoped to `agent` today. */
  role: Role;
  /**
   * The workspace they are joining, by name — never its id.
   *
   * NULLABLE, and master means it: `invites.routes.ts` sends `tenant?.name ??
   * null` deliberately, so that a tenant lookup which returns nothing renders a
   * THINNER invitation rather than a broken one, and so that an unauthenticated
   * caller is never handed a raw tenant UUID as a substitute. Declared as a plain
   * `string` here, the page rendered "You have been set up as Agent at ." — an
   * empty `<strong>` mid-sentence, on the one page in the product that most has
   * to not look like phishing. The page drops the clause instead, the same way it
   * already branches on a missing {@link inviter_name}.
   */
  tenant_name: string | null;
  /** Who sent it. Null when master cannot name them (a system or API invite). */
  inviter_name: string | null;
  /**
   * What they are being added to, in the product's own words — e.g.
   * "Magick Agency Dialer". Rendered verbatim and never assembled here: it
   * is whitelabel-dependent and master owns the wording.
   */
  product_name: string;
  /** ISO 8601. Shown so a stale link is diagnosable before it is used. */
  expires_at: string;
}

/**
 * Why an invite cannot be used, as the endpoints report it.
 *
 * Distinct facts rather than one "invalid", because each has a different next
 * step and only some of them are the recipient's to take: an expired invite needs
 * a resend, a claimed one needs the sign-in page, a revoked one needs a
 * conversation with the supervisor, and a not-found one is usually a link that
 * an email client wrapped and truncated.
 *
 * ── `identity_already_bound` is master's fifth answer, and it is newer ─────
 * `POST /invites/:token/claim` answers 409 with it when the invited USER ROW
 * already has a real Firebase account behind it — normally somebody who was
 * invited and then signed in by some other route before opening the link. Master
 * refuses to rebind the row (it would be an account takeover primitive if the
 * invitation were sent to an address the claimant does not control) and leaves the
 * invitation outstanding.
 *
 * It is modelled here rather than left to fall through to a generic conflict for
 * the reason the other four are modelled: there IS a next step, and it is a
 * specific one — sign in at the agency door with the account that address already
 * has. A generic "something went wrong" would send somebody who is fully set up
 * back to their supervisor for a new invitation that cannot help them.
 *
 * NOTE the deliberately absent sixth: master also answers `identity_in_use`, when
 * the FIREBASE account being claimed with belongs to a different user row. That
 * is not an unavailable invitation — the invitation is untouched and can still be
 * claimed with another account — so it is a claim failure with its own error type
 * (`InviteIdentityInUseError`), not a member of this union. Adding it here would
 * tear down the page and hide the one control that resolves it.
 */
export type InviteUnavailableStatus =
  | 'claimed'
  | 'expired'
  | 'revoked'
  | 'not_found'
  | 'identity_already_bound';

/**
 * The answer to `GET /invites/:token`.
 *
 * Discriminated on `status` so the invite body is reachable only on the one
 * status that carries it — a shape where `invite` were optional would let a
 * terminal screen render half an invitation.
 */
export type InviteLookup =
  | { status: 'pending'; invite: AgencyInvite }
  | { status: InviteUnavailableStatus };
