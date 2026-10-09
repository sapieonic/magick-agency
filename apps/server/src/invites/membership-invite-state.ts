import { PENDING_UID_PREFIX } from '../auth/firebase-identity.js';

/**
 * Has this member actually turned up, or is the invitation still outstanding?
 *
 * Exactly two values, and the pair is a settled product decision rather than a
 * first cut. `expired` and `not_sent` were both considered and declined: a
 * supervisor's next action is the same for all three of them (press Resend), so
 * a third value would split one column into distinctions the Team page has no
 * different answer to. The states that DO differ are already served, per-token,
 * by `GET /invites/:token`'s four-value `InviteStatus` — which the recipient
 * reads, not the supervisor.
 */
export type MembershipInviteState = 'active' | 'pending';

/**
 * Everything {@link deriveMembershipInviteState} is allowed to look at: one
 * fact.
 *
 * A named record rather than a bare `string | null` parameter so the call site
 * says which fact it is passing, and so a future signal can be added without
 * re-typing every caller. It is deliberately NOT the `(membership, user,
 * invites)` triple an earlier draft took — see the function's docstring for why
 * the invite rows were removed rather than merely unused.
 */
export interface MembershipInviteStateInput {
  /**
   * `users.firebase_uid` for the member, or `null` when the user row is missing.
   *
   * NEVER put this on the wire. It is an input to the decision and nothing else:
   * a `pending_<uuid>` stub names a row whose owner has never signed in, and
   * neither it nor the real uid may reach the browser.
   */
  firebaseUid: string | null;
}

/**
 * `pending` iff the member has no real Firebase identity yet. One rule, every
 * role.
 *
 * The question this answers is **"has this person completed Firebase sign-in"**
 * — a fact about the USER, rendered once per membership row because that is the
 * shape the Team page renders. `POST /users/invite` mints a stub `users` row
 * with `firebase_uid = pending_<uuid>` for an address this server has never seen, and
 * the only things that ever replace that stub are the two adoption paths in
 * `adoptFirebaseIdentity` — so the prefix is a complete and exact record of
 * "nobody has signed in as this row yet".
 *
 * ── Why this is NOT derived from `membership_invites.claimed_at` ───────────
 * An earlier version of this function had two arms: for a token role (`agent`)
 * it read whether any `membership_invites` row for the membership had ever been
 * claimed, and for every other role it read the stub prefix. That design is
 * wrong and must not come back. Do not reintroduce per-membership acceptance
 * tracking here without first re-reading this list.
 *
 * The claim signal labels genuinely working agents `pending` **forever** in four
 * reachable cases, because in each of them a real, signed-in person holds an
 * `agent` membership that no claim will ever be recorded against:
 *
 *  1. **Every `agent` membership with no invite row** (one that was not created
 *     through an invite). There is no invite row to claim and none will
 *     appear, so all of them would be labelled `pending` and left there.
 *  2. **`PUT /users/:id/role` re-roles an existing member to `agent`**
 *     (`user.validator.ts` accepts it). No invite is issued on that path, so a
 *     colleague of six months would flip to `pending` the moment their role
 *     changed, and stay there.
 *  3. **Super-admin creates the membership directly**
 *     (`super-admin.routes.ts`). That route writes no `membership_invites` row
 *     on any path.
 *  4. **The invitee ignores the emailed link and just signs in.** Nothing
 *     requires them to use the token: `POST /auth/session` adopts the stub by
 *     verified email (path 2) or matches an existing uid (path 1), and neither
 *     touches `membership_invites`. The invite row sits unclaimed forever behind
 *     a person who is on the floor taking calls.
 *
 * And the signal buys nothing in exchange, because it is strictly redundant:
 * **claiming an invite ALWAYS binds a real `firebase_uid`.**
 * `POST /invites/:token/claim` marks the row claimed and binds the identity in
 * one transaction, so "ever claimed" cannot be true while the uid is still a
 * stub. Every case the claim arm got right, the stub check already got right —
 * it only added the four ways above to get it wrong.
 *
 * ── The remaining limitation, which is the field's own definition ──────────
 * `POST /users/invite` reuses the existing `users` row when the address is
 * already known, so inviting somebody who ALREADY has a login reads `active`
 * from the moment the membership is written — before they have opened this
 * workspace. Under the field's meaning ("pending vs signed up") that is the
 * correct answer, not a defect: they have signed up. What this field does
 * NOT tell a supervisor is whether that person has ever opened, accepted, or
 * used THIS workspace. It is an identity fact, not an engagement fact, and no
 * amount of reading `membership_invites` would make it an engagement fact
 * either — see case 4 above, where the person is working and the invite is
 * unclaimed.
 *
 * ── No user row ⇒ `pending` ────────────────────────────────────────────────
 * **Not reachable today, and the arm is still here on purpose.**
 * `memberships.user_id` is `NOT NULL REFERENCES users(id) ON DELETE CASCADE`
 * so a membership cannot outlive its user — hard-deleting the
 * user takes the membership with it. The read that feeds this is a LEFT JOIN
 * rather than an inner one specifically so a relaxed FK would surface a member
 * with no identity instead of silently dropping them from their own tenant's
 * Team page, and the route has always carried the `user: null` shape. A member
 * with no identity row has certainly not signed in, so `pending` is both the
 * conservative answer and the literally correct one.
 */
export function deriveMembershipInviteState(
  input: MembershipInviteStateInput,
): MembershipInviteState {
  if (input.firebaseUid === null) return 'pending';

  return input.firebaseUid.startsWith(PENDING_UID_PREFIX) ? 'pending' : 'active';
}
