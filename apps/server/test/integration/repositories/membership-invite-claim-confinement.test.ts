import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { getTestPool, closeTestPool, truncateAll } from '../../../../../packages/db/test/integration/setup/test-utils.js';
import { TEST_DB_URL } from '../../../../../packages/db/test/helpers/test-db.js';
import { initDbPool, closePool } from '@magick-agency/db';
import {
  insertTenant,
  insertUser,
  insertAccount,
  insertMembership,
  insertMembershipInvite,
} from '../../../../../packages/db/test/integration/setup/platform-factories.js';
import { PENDING_UID_PREFIX } from '../../../src/auth/firebase-identity.js';

// PORT NOTE (magick-agency): master mocked `src/db/connection.js` to hand back
// the test pool. Here the repositories (server-local and `@magick-agency/db`)
// share the package's pool singleton, so the suite initialises it against the
// agency test database instead (worker-common: `initDbPool`, not a mock).
initDbPool({ url: TEST_DB_URL, poolMin: 0, poolMax: 4 });

/*
 * PORT NOTE (magick-agency): master does not type-check its tests; agency's lint
 * does, and `DecodedFirebaseToken` types the optional claims as `string |
 * undefined`. The `null` claims master passes (a Firebase token with no name,
 * picture or email) are kept as `null` at runtime and only typed through this
 * constant, so every bind sees exactly the value master's suite sent.
 */
const NO_CLAIM = null as unknown as string;

const { membershipInviteRepository } = await import(
  '../../../src/db/repositories/membership-invite.repository.js'
);

/**
 * `claimWithIdentity` must not let a token minted in one tenant activate a
 * `users` row another tenant is waiting on.
 *
 * ── Why this file is an INTEGRATION test and could not be a unit one ────────
 * The whole guard is a `NOT EXISTS` against `memberships` inside the bind's
 * `WHERE`, evaluated in the same transaction as the conditional claim. A mocked
 * pool never parses SQL and never evaluates a predicate, so a unit test here
 * would assert the shape of a string — which is worth doing (and
 * `test/unit/auth/firebase-identity.test.ts` does it) but cannot tell you
 * whether the statement MATCHES the row it is supposed to refuse. Every claim
 * below is about real rows.
 *
 * ── The attack, reproduced ──────────────────────────────────────────────────
 * `POST /users/invite` reuses an existing `users` row whenever the address is
 * already known, so an attacker who owns any tenant (everybody does —
 * `auth.routes.ts` path 4) can invite a still-unclaimed address into their own
 * tenant as an `agent`, which is the one role that mints a token, and the 201
 * hands them the raw join link. Claiming it used to bind their Firebase uid onto
 * the victim's stub, and `buildSessionPayload` then returned every active
 * membership on that row — the victim tenant's `tenant_owner` included.
 */
describe('claimWithIdentity — a claim may activate only the tenant its token names', () => {
  let victimTenant: any;
  let attackerTenant: any;

  beforeEach(async () => {
    await truncateAll();
    victimTenant = await insertTenant({ name: 'Victim Corp' });
    attackerTenant = await insertTenant({ name: 'Attacker Co' });
  });

  afterAll(async () => {
    await closePool();
    await closeTestPool();
  });

  /** The unclaimed stub `POST /users/invite` and super-admin tenant-create write. */
  async function insertStub(email: string) {
    return insertUser({
      firebase_uid: `${PENDING_UID_PREFIX}${randomUUID()}`,
      email,
      display_name: null,
    });
  }

  /** An outstanding `agent` invite against a membership, as `issueInvite` writes it. */
  async function outstandingInvite(membership: any, email: string) {
    return insertMembershipInvite({
      membership_id: membership.id,
      tenant_id: membership.tenant_id,
      email,
      role: 'agent',
    });
  }

  it('REFUSES the attacker: a stub carrying the victim tenant\'s owner membership', async () => {
    const email = 'victim@corp.test';
    // 1. A super admin provisions the victim's workspace. Nobody has signed in,
    //    so the owner is a `pending_` stub.
    const stub = await insertStub(email);
    await insertMembership({
      user_id: stub.id,
      tenant_id: victimTenant.id,
      role: 'tenant_owner',
    });

    // 2. The attacker invites that same address into THEIR tenant as an agent.
    //    `findByEmail` reuse aims the membership at the victim's row.
    const attackerMembership = await insertMembership({
      user_id: stub.id,
      tenant_id: attackerTenant.id,
      role: 'agent',
    });
    const invite = await outstandingInvite(attackerMembership, email);

    // 3. The attacker claims with a Firebase identity that has never been used
    //    here — the one shape `identity_in_use` does not already refuse.
    const result = await membershipInviteRepository.claimWithIdentity({
      inviteId: invite.id,
      userId: stub.id,
      tenantId: invite.tenant_id,
      identity: { uid: 'fb-attacker-fresh', name: NO_CLAIM, picture: NO_CLAIM, email: 'attacker@evil.test' },
    });

    expect(result).toEqual({ ok: false, reason: 'cross_tenant_identity' });

    const pool = getTestPool();
    // The row is untouched: still a stub, still the invited address, so the
    // victim's own sign-in still finds and activates it.
    const { rows: users } = await pool.query(
      'SELECT firebase_uid, email FROM users WHERE id = $1',
      [stub.id],
    );
    expect(users[0].firebase_uid.startsWith(PENDING_UID_PREFIX)).toBe(true);
    expect(users[0].email).toBe(email);

    // And the invitation is left OUTSTANDING rather than burned — otherwise an
    // attacker could deny a real invitee their invitation by claiming at it.
    const { rows: invites } = await pool.query(
      'SELECT claimed_at, revoked_at, claimed_by_user_id FROM membership_invites WHERE id = $1',
      [invite.id],
    );
    expect(invites[0].claimed_at).toBeNull();
    expect(invites[0].revoked_at).toBeNull();
    expect(invites[0].claimed_by_user_id).toBeNull();
  });

  it('REFUSES it the other way round too: the attacker\'s stub, provisioned onto afterwards', async () => {
    /**
     * The two memberships can be written in EITHER order, which is why the guard
     * cannot live at invite time: here the attacker's invite comes first, and
     * the super admin provisions the victim tenant onto the same address later.
     * At invite time there was nothing to see.
     */
    const email = 'future-owner@corp.test';
    const stub = await insertStub(email);
    const attackerMembership = await insertMembership({
      user_id: stub.id,
      tenant_id: attackerTenant.id,
      role: 'agent',
    });
    const invite = await outstandingInvite(attackerMembership, email);

    await insertMembership({
      user_id: stub.id,
      tenant_id: victimTenant.id,
      role: 'tenant_owner',
    });

    const result = await membershipInviteRepository.claimWithIdentity({
      inviteId: invite.id,
      userId: stub.id,
      tenantId: invite.tenant_id,
      identity: { uid: 'fb-attacker-fresh-2', name: NO_CLAIM, picture: NO_CLAIM, email: NO_CLAIM },
    });

    expect(result).toEqual({ ok: false, reason: 'cross_tenant_identity' });
  });

  it('ALLOWS the honest invite: a stub confined to the inviting tenant', async () => {
    const email = 'new-agent@corp.test';
    const stub = await insertStub(email);
    const membership = await insertMembership({
      user_id: stub.id,
      tenant_id: attackerTenant.id,
      role: 'agent',
    });
    const invite = await outstandingInvite(membership, email);

    const result = await membershipInviteRepository.claimWithIdentity({
      inviteId: invite.id,
      userId: stub.id,
      tenantId: invite.tenant_id,
      identity: { uid: 'fb-real-agent', name: 'New Agent', picture: NO_CLAIM, email },
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.user.firebase_uid).toBe('fb-real-agent');
  });

  it('ALLOWS a second membership in the SAME tenant — a re-invite into another account', async () => {
    const email = 'two-hats@corp.test';
    const stub = await insertStub(email);
    // Account-scoped, because `idx_memberships_user_tenant_level` permits only
    // one TENANT-level row per (user, tenant) — which is the shape a real
    // second invite into the same workspace takes anyway.
    const account = await insertAccount({ tenant_id: attackerTenant.id });
    await insertMembership({
      user_id: stub.id,
      tenant_id: attackerTenant.id,
      account_id: account.id,
      role: 'viewer',
    });
    const membership = await insertMembership({
      user_id: stub.id,
      tenant_id: attackerTenant.id,
      role: 'agent',
    });
    const invite = await outstandingInvite(membership, email);

    const result = await membershipInviteRepository.claimWithIdentity({
      inviteId: invite.id,
      userId: stub.id,
      tenantId: invite.tenant_id,
      identity: { uid: 'fb-two-hats', name: NO_CLAIM, picture: NO_CLAIM, email },
    });

    expect(result.ok).toBe(true);
  });

  it('IGNORES a revoked foreign membership — it confers nothing, so it must block nothing', async () => {
    /**
     * `findAllByUserId` and `tenantRepository.listByUserId` are both
     * status-filtered, so a revoked membership in another tenant cannot reach a
     * session. Blocking on it would refuse an agent whose previous workspace
     * offboarded them, for no gain.
     */
    const email = 'moved-on@corp.test';
    const stub = await insertStub(email);
    await insertMembership({
      user_id: stub.id,
      tenant_id: victimTenant.id,
      role: 'tenant_owner',
      status: 'revoked',
    });
    const membership = await insertMembership({
      user_id: stub.id,
      tenant_id: attackerTenant.id,
      role: 'agent',
    });
    const invite = await outstandingInvite(membership, email);

    const result = await membershipInviteRepository.claimWithIdentity({
      inviteId: invite.id,
      userId: stub.id,
      tenantId: invite.tenant_id,
      identity: { uid: 'fb-moved-on', name: NO_CLAIM, picture: NO_CLAIM, email },
    });

    expect(result.ok).toBe(true);
  });

  it('ALLOWS an already-bound user claiming with their OWN identity, foreign memberships and all', async () => {
    /**
     * The ordinary "add an agent who already has a MagickVoice login" invite:
     * `POST /users/invite` reuses their real row, which legitimately holds
     * memberships in every workspace they belong to. Nothing changes hands, so
     * the confinement must not fire — refusing here would answer a conflict to
     * the very person the mail was addressed to.
     */
    const email = 'consultant@corp.test';
    const existing = await insertUser({ firebase_uid: 'fb-consultant', email });
    await insertMembership({
      user_id: existing.id,
      tenant_id: victimTenant.id,
      role: 'account_admin',
    });
    const membership = await insertMembership({
      user_id: existing.id,
      tenant_id: attackerTenant.id,
      role: 'agent',
    });
    const invite = await outstandingInvite(membership, email);

    const result = await membershipInviteRepository.claimWithIdentity({
      inviteId: invite.id,
      userId: existing.id,
      tenantId: invite.tenant_id,
      identity: { uid: 'fb-consultant', name: NO_CLAIM, picture: NO_CLAIM, email },
    });

    expect(result.ok).toBe(true);
  });

  it('still reports identity_already_bound ahead of confinement when the row is somebody else\'s', async () => {
    /**
     * Both predicates fail on a row that is bound to a different identity AND
     * carries a foreign membership. `identity_already_bound` is the more
     * actionable answer ("sign in with the other account"), and a row that is
     * already somebody's is no longer a stub to confine.
     */
    const email = 'taken@corp.test';
    const existing = await insertUser({ firebase_uid: 'fb-real-owner', email });
    await insertMembership({
      user_id: existing.id,
      tenant_id: victimTenant.id,
      role: 'tenant_owner',
    });
    const membership = await insertMembership({
      user_id: existing.id,
      tenant_id: attackerTenant.id,
      role: 'agent',
    });
    const invite = await outstandingInvite(membership, email);

    const result = await membershipInviteRepository.claimWithIdentity({
      inviteId: invite.id,
      userId: existing.id,
      tenantId: invite.tenant_id,
      identity: { uid: 'fb-somebody-else', name: NO_CLAIM, picture: NO_CLAIM, email: 'other@evil.test' },
    });

    expect(result).toEqual({ ok: false, reason: 'identity_already_bound' });
  });
});
