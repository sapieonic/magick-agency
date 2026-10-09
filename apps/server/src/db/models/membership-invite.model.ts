import type { MembershipRole } from '@magick-agency/db/models/membership.model';

/**
 * One row of `membership_invites` — a token that binds a
 * Firebase identity to a membership that already exists.
 *
 * ── Why the row carries `email` and `role` rather than joining for them ─────
 * They describe the invitation AS SENT. `GET /invites/:token` renders them to an
 * unauthenticated recipient ("this invitation is for you@example.com, as an
 * Agent"), and a join would silently rewrite the page somebody is reading to
 * match a role change made after the mail left. The membership is the live fact;
 * this row is the record of what was offered.
 *
 * ── `email` is NOT the claim key, and that is the whole point ───────────────
 * The claim resolves the user through `membership_id → memberships.user_id`.
 * `users.email` carries only a non-unique index,
 * so an email lookup can return the wrong row — and matching on the address is
 * exactly the mechanism whose failure this table exists to remove. The invited address survives here as something to SHOW and
 * to AUDIT against, never to resolve by.
 */
export interface MembershipInviteRecord {
  id: string;
  membership_id: string;
  tenant_id: string;
  /** The address the invitation was issued for. See the interface docstring. */
  email: string;
  role: MembershipRole;
  /** `sha256(token)` hex. The raw token is never stored — see `invite-token.ts`. */
  token_hash: string;
  expires_at: Date;
  /** NULL while outstanding. Set once, by the conditional UPDATE in `claim`. */
  claimed_at: Date | null;
  /**
   * Who claimed it, which need not be who it was addressed to: the token is the
   * authority, so a claim from a different Firebase address still binds and the
   * mismatch is recorded in `platform_audit_log` instead of refused.
   */
  claimed_by_user_id: string | null;
  /** Set when a resend supersedes this token. Rows are revoked, never deleted. */
  revoked_at: Date | null;
  invited_by: string | null;
  created_at: Date;
}

export interface CreateMembershipInviteInput {
  membership_id: string;
  tenant_id: string;
  email: string;
  role: MembershipRole;
  /** Already hashed by the caller. This layer never sees a raw token. */
  token_hash: string;
  expires_at: Date;
  invited_by?: string | null;
}

/**
 * Why a claim did not land, when it did not.
 *
 * A discriminated result rather than a thrown error or a bare `null`, for the
 * reason every result union in this service gives: the caller maps each arm onto
 * a different HTTP answer, and collapsing them would make "somebody else already
 * used this link" indistinguishable from "this Firebase account belongs to a
 * different person here" — two 409s that need two different sentences.
 */
export type ClaimInviteResult =
  /** The invite is spent and the identity is bound. `user` is the updated row. */
  | { ok: true; user: ClaimedUserRow }
  /**
   * The conditional UPDATE matched nothing because the invite was already
   * CLAIMED. The loser of a concurrent double-claim lands here, which is what
   * makes exactly one winner a property of the statement rather than of the
   * timing.
   *
   * Distinct from `revoked` below, and the split is the whole reason
   * {@link MembershipInviteRepository.markClaimed} re-reads the row rather than
   * answering from the row count alone: the two predicates in that `WHERE` fail
   * for different reasons and the person holding the link needs different advice
   * for each.
   */
  | { ok: false; reason: 'already_claimed' }
  /**
   * The conditional UPDATE matched nothing because the invite was REVOKED —
   * in practice a `POST /invites/resend` that landed between this route's read
   * and this write.
   *
   * Reported separately because collapsing it into `already_claimed` tells the
   * recipient *"this invitation has already been used. Sign in to continue"* —
   * advice that is wrong in both halves for somebody whose link was superseded
   * and who has a working one sitting in their inbox. It also files the outcome
   * under `invite_claims_total{result="already_claimed"}`, hiding resend churn
   * inside what looks like double-click noise.
   */
  | { ok: false; reason: 'revoked' }
  /**
   * The conditional UPDATE matched nothing because the invite had EXPIRED by the
   * time it ran.
   *
   * The route reads `expires_at` too, and refuses an already-expired link before
   * it verifies anything — but that check sits above an outbound Firebase call
   * and a membership read, so a TTL lapsing inside that window used to bind
   * anyway. `expires_at > NOW()` is in the statement for the same reason
   * `claimed_at IS NULL` is: the election has to be decided by the row as it is
   * at write time, not as it was read.
   *
   * Reported separately rather than folded into `already_claimed` because the
   * remedy differs — "ask whoever invited you to send a new one" is actionable,
   * "sign in to continue" is advice to somebody who has no account yet — and
   * because `invite_claims_total{result="expired"}` is a product signal that the
   * configured TTL is shorter than a customer's onboarding actually takes.
   */
  | { ok: false; reason: 'expired' }
  /**
   * `decoded.uid` is already bound to a DIFFERENT `users` row, so binding it
   * here would violate `users.firebase_uid`'s unique constraint.
   *
   * Reachable, not theoretical: the claim deliberately accepts a Firebase
   * address that differs from the invited one (the token is the authority), and
   * that other address may already have an account on this platform. Answered
   * rather than 500'd, because a `23505` reaching `errorMaskHook` becomes
   * "contact support and quote this request id" for a state the person can
   * actually resolve — sign in with the other identity, or ask for a resend.
   */
  | { ok: false; reason: 'identity_in_use' }
  /**
   * The membership's `users` row is already bound to a real Firebase account
   * OTHER than the one claiming, so this claim would REBIND an account somebody
   * else can already sign in as.
   *
   * "Other than the one claiming" is the whole of the near-side reading, and it
   * is why this arm is narrower than it was: an invitee who ALREADY has a login
   * here — the ordinary "add an agent who works with us elsewhere" invite, where
   * `POST /users/invite` reuses their existing `users` row — claims with their
   * own uid, matches the bind predicate's third arm, and is signed in. Refusing
   * them was a regression this arm used to cause; see
   * {@link AdoptIdentityOptions}. What remains here is the far-side reading
   * alone, which is why it is refused in the UPDATE's `WHERE` rather than
   * reported afterwards: it is where an account-takeover attempt lands, because
   * `POST /users/invite` aims a membership at an EXISTING user row whenever the
   * invited address is already known.
   *
   * Distinct from `identity_in_use`, which is the mirror image: there the
   * INCOMING identity already belongs elsewhere; here the TARGET row is already
   * spoken for. Two 409s, two different remedies.
   */
  | { ok: false; reason: 'identity_already_bound' }
  /**
   * The membership's `users` row is a STUB that carries active memberships in
   * another tenant, so activating it would hand the token's holder access to a
   * workspace the invitation says nothing about.
   *
   * Not a variant of `identity_already_bound` — there the row is somebody's
   * already, and the claimant is simply not them. Here the row is nobody's yet,
   * which is exactly why `onlyUnclaimedStub` waves it through: the stub test
   * asks whether anybody has signed in as this row, and the answer is honestly
   * no. What makes it unsafe is that `POST /users/invite` (and super-admin
   * tenant-create) REUSE a `users` row whenever the address is already known, so
   * one stub can be several workspaces' pending invitee at once and a token for
   * any of them would activate all of them. See
   * {@link AdoptIdentityOptions.confineStubToTenantId} for the full chain.
   *
   * The invitation is left OUTSTANDING, as on the other two identity arms: on
   * the honest reading (two workspaces invited the same address before either
   * sign-in) nothing needs spending, and on the hostile one burning the link
   * would let an attacker deny a real invitee their invitation. The remedy is
   * the ordinary one — sign in with the invited address at
   * `POST /auth/session`, which requires a VERIFIED Firebase email and is
   * therefore entitled to activate the shared stub across every tenant waiting
   * on it.
   *
   * Counted apart from every other refusal because it is the signature of the
   * takeover attempt rather than of ordinary use: a burst of these in one tenant
   * is worth alerting on in a way `expired` and `already_claimed` never are.
   */
  | { ok: false; reason: 'cross_tenant_identity' };

/**
 * The subset of `users` the claim writes and the session response needs back.
 *
 * Typed as its own row rather than `UserRecord` because the claim's `RETURNING`
 * is the authority on what changed, and widening it to the full record would
 * invite a reader to assume columns this statement does not touch are fresh.
 */
export interface ClaimedUserRow {
  id: string;
  firebase_uid: string;
  email: string;
  phone_number: string;
  display_name: string | null;
  avatar_url: string | null;
  status: 'active' | 'inactive' | 'deleted';
  /**
   * TRUE when this claim bound an identity that did not prove the address the
   * row carries — which is every claim arriving without
   * `email_verified === true`. The row signs in normally; it is barred from
   * being REUSED by address. See `AdoptIdentityOptions.adoptEmail`.
   */
  email_unverified: boolean;
  created_at: Date;
  updated_at: Date;
}
