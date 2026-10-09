import { describe, it, expect } from 'vitest';
import { deriveMembershipInviteState } from '../../../src/invites/membership-invite-state.js';
import type { MembershipInviteStateInput } from '../../../src/invites/membership-invite-state.js';
import { PENDING_UID_PREFIX } from '../../../src/auth/firebase-identity.js';

/**
 * `deriveMembershipInviteState` — the rule behind `invite_state` on
 * `GET /tenants/:id/members` (`src/invites/membership-invite-state.ts`).
 *
 * ── Why this is a pure function with its own unit ──────────────────────────
 * The rule is short, but it is the definition of a field the Team page acts on,
 * and one of its cases (`null`, the missing user row) cannot be reached from
 * the database at all. Asserting any of it through the route means a Fastify
 * instance, a pool and a fixture per case; here it is one argument.
 *
 * ── What this file is guarding against ────────────────────────────────────
 * The previous design had a second arm: for `agent` it read whether a
 * `membership_invites` row had ever been claimed, and only for other roles did
 * it read the uid. That arm labelled four populations of genuinely working
 * agents `pending` forever (enumerated on the function). The guard against its
 * return is `role-invariance`, below — and role-invariance is now a property of
 * the SIGNATURE, so it is asserted there rather than faked with a `role` the
 * function cannot see.
 */

const REAL_UID = 'firebase-uid-abc123';
const STUB_UID = `${PENDING_UID_PREFIX}0f1e2d3c-4b5a-4968-8778-695a4b3c2d1e`;

describe('deriveMembershipInviteState', () => {
  it('is pending while the uid is a pending_ stub', () => {
    expect(deriveMembershipInviteState({ firebaseUid: STUB_UID })).toBe('pending');
  });

  it('is active once the uid is a real Firebase uid', () => {
    expect(deriveMembershipInviteState({ firebaseUid: REAL_UID })).toBe('active');
  });

  /**
   * `memberships.user_id` is `NOT NULL … ON DELETE CASCADE`, so this shape is
   * unreachable from the database today — deleting a user takes the membership
   * with it (pinned in `test/integration/api/tenant.routes.test.ts`). It is
   * covered HERE because this is the only place it can be reached at all, and
   * the route keeps the arm — reading through a LEFT JOIN, not an inner one —
   * so that relaxing that FK would surface a member with no identity rather
   * than silently dropping them off their tenant's Team page.
   */
  it('is pending when the user row is missing entirely', () => {
    expect(deriveMembershipInviteState({ firebaseUid: null })).toBe('pending');
  });

  /**
   * Only the PREFIX decides it — `startsWith`, never `includes`. A real Firebase
   * uid is an opaque string and nothing stops one containing the word.
   */
  it('does not treat a uid that merely contains the prefix as a stub', () => {
    expect(deriveMembershipInviteState({ firebaseUid: `abc${PENDING_UID_PREFIX}def` }))
      .toBe('active');
  });

  /**
   * ── Role-invariance: the regression guard for the design this replaced ────
   *
   * The answer must not vary by role, and the enforcement is structural: the
   * role is not an input, so there is no runtime call that could distinguish
   * `agent` from `viewer`. Passing six roles to a function that takes none
   * would assert nothing at all, so the invariant is pinned where it can
   * actually break — the input type.
   *
   * This line fails `npx tsc --noEmit -p tsconfig.test.json` the moment
   * `MembershipInviteStateInput` grows a `role`, an `everClaimedInvite`, or any
   * other per-membership signal, whether required or optional. That is the
   * change that would reintroduce the defect; the four agent populations it
   * mislabels are listed on the function.
   *
   * The behavioural half of this guard cannot live here, because it needs a
   * real membership row with a real role: `test/integration/api/tenant.routes
   * .test.ts` asserts that an `agent` with no invite row and a real uid reads
   * `active`.
   */
  it('takes the uid and nothing else — no role, no per-membership signal', () => {
    // The type-level half: `keyof` must not widen past the one field. An added
    // `role`/`everClaimedInvite` — required OR optional — reds this assignment.
    type OnlyKey = 'firebaseUid';
    const soleKey: OnlyKey = 'firebaseUid' as keyof MembershipInviteStateInput;

    // The runtime half, so the case is visible in the suite's counts rather
    // than only in `tsc`.
    const input = { firebaseUid: REAL_UID } satisfies MembershipInviteStateInput;
    expect(Object.keys(input)).toEqual([soleKey]);
    expect(deriveMembershipInviteState(input)).toBe('active');
  });

  it('only ever answers with the two documented values', () => {
    for (const firebaseUid of [REAL_UID, STUB_UID, '', PENDING_UID_PREFIX, null]) {
      expect(['active', 'pending']).toContain(deriveMembershipInviteState({ firebaseUid }));
    }
  });
});
