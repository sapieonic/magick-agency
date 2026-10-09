import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { getTestPool, closeTestPool, truncateAll } from '../../../../../packages/db/test/integration/setup/test-utils.js';
import { TEST_DB_URL } from '../../../../../packages/db/test/helpers/test-db.js';
import { initDbPool, closePool } from '@magick-agency/db';
import {
  insertTenant,
  insertUser,
  insertMembership,
  insertMembershipInvite,
} from '../../../../../packages/db/test/integration/setup/platform-factories.js';
import { PENDING_UID_PREFIX } from '../../../src/auth/firebase-identity.js';

// The repositories (server-local and `@magick-agency/db`)
// share the package's pool singleton, so the suite initialises it against the
// agency test database instead (worker-common: `initDbPool`, not a mock).
initDbPool({ url: TEST_DB_URL, poolMin: 0, poolMax: 4 });

/*
 * The lint type-checks tests, and `DecodedFirebaseToken` types the optional claims as `string |
 * undefined`. The `null` claims (a Firebase token with no name,
 * picture or email) are kept as `null` at runtime and only typed through this
 * constant, so every bind sees exactly the value a real token with no claim yields.
 */
const NO_CLAIM = null as unknown as string;

const { membershipInviteRepository } = await import(
  '../../../src/db/repositories/membership-invite.repository.js'
);
const { userRepository } = await import('@magick-agency/db/repositories/user.repository');
const { membershipRepository } = await import(
  '@magick-agency/db/repositories/membership.repository'
);
const { adoptFirebaseIdentity } = await import('../../../src/auth/firebase-identity.js');

/**
 * `users.email_unverified` — the flag that stops an address nobody proved from
 * being reused as an identity.
 *
 * ── The hole, restated as the cases below walk it ──────────────────────────
 * `POST /invites/:token/claim` accepts an UNVERIFIED Firebase email on purpose:
 * the token was mailed to the invited inbox, so possession of it is meant to
 * prove the same thing one step earlier. That reasoning fails when the inviter
 * and the claimant are the same person, because `POST /users/invite` returns
 * the raw join link in its own 201 body. So an attacker registers an unverified
 * email/password account for `victim@corp.test` (Firebase mints a token for any
 * address; it is simply `email_verified: false`), invites that address into
 * their OWN tenant as an `agent`, claims their own link, and the row now reads
 * `email = victim@corp.test` with their uid on it.
 *
 * Neither guard on the claim path can see that: the row is a fresh stub in one
 * tenant, so `onlyUnclaimedStub` and `confineStubToTenantId` both pass honestly.
 * The payoff lands later, at the three places that resolve an address to a row
 * and then attach authority to it.
 *
 * ── Why this file is an integration test ──────────────────────────────────
 * Every claim here is a real `UPDATE ... WHERE` against real rows, and the
 * reuse rule is a real predicate. A mocked pool would assert the shape of a
 * string and could not tell you whether the statement MATCHES the row it is
 * supposed to skip.
 */
describe('users.email_unverified — an address nobody proved is never an identity', () => {
  const VICTIM_EMAIL = 'victim@corp.test';
  let attackerTenant: any;
  let victimTenant: any;

  beforeEach(async () => {
    await truncateAll();
    attackerTenant = await insertTenant({ name: 'Attacker Co' });
    victimTenant = await insertTenant({ name: 'Victim Corp' });
  });

  afterAll(async () => {
    await closePool();
    await closeTestPool();
  });

  /** The stub `POST /users/invite` writes for an address it does not know. */
  async function insertStub(email: string) {
    return insertUser({
      firebase_uid: `${PENDING_UID_PREFIX}${randomUUID()}`,
      email,
      display_name: null,
    });
  }

  /**
   * The attacker's self-invite, claimed with an unverified Firebase account
   * bearing the victim's address. Returns the poisoned row.
   */
  async function poisonAddress(email: string) {
    const stub = await insertStub(email);
    const membership = await insertMembership({
      user_id: stub.id,
      tenant_id: attackerTenant.id,
      role: 'agent',
    });
    const invite = await insertMembershipInvite({
      membership_id: membership.id,
      tenant_id: membership.tenant_id,
      email,
      role: 'agent',
    });

    const claimed = await membershipInviteRepository.claimWithIdentity({
      inviteId: invite.id,
      userId: stub.id,
      tenantId: invite.tenant_id,
      identity: {
        uid: 'fb-attacker',
        name: NO_CLAIM,
        picture: NO_CLAIM,
        email,
        // Firebase issues a token for any address; only the inbox proves it.
        email_verified: false,
      },
    });
    expect(claimed.ok).toBe(true);
    return stub;
  }

  it('FLAGS the row an unverified claim binds, and leaves it signing in normally', async () => {
    const stub = await poisonAddress(VICTIM_EMAIL);

    const { rows } = await getTestPool().query(
      'SELECT firebase_uid, email, email_unverified, status FROM users WHERE id = $1',
      [stub.id],
    );
    expect(rows[0]).toMatchObject({
      firebase_uid: 'fb-attacker',
      email: VICTIM_EMAIL,
      email_unverified: true,
      // Not a punishment for the account — only a bar on reuse by address.
      status: 'active',
    });
  });

  it('REFUSES to reuse it on invite — the payoff step', async () => {
    /**
     * The honest admin of another workspace invites the real customer. Before
     * the flag this returned the attacker's row and the membership was written
     * onto it.
     */
    await poisonAddress(VICTIM_EMAIL);

    expect(await userRepository.findByProvenEmail(VICTIM_EMAIL)).toBeNull();
  });

  it('REFUSES it on both super-admin lookups, including tenant-create ownership', async () => {
    /**
     * The worst instance: `POST /super-admin/tenants` resolves `owner_email` and
     * writes `tenant_owner`.
     *
     * This test used to run a hand-copied SELECT from its own body, which is why
     * it proved nothing: a mutation dropping `AND email_unverified = false` from
     * EITHER super-admin route failed zero tests anywhere, because the only test
     * watching them was asserting against a third copy of the statement. Both
     * routes now call `findByProvenEmail` with their provisioning transaction's
     * client, so this exercises the statement they actually run — on a real
     * client, because the client parameter is the part that was added for them
     * and a pool-only assertion would not cover it.
     */
    await poisonAddress(VICTIM_EMAIL);

    const client = await getTestPool().connect();
    try {
      await client.query('BEGIN');
      expect(await userRepository.findByProvenEmail(VICTIM_EMAIL, client)).toBeNull();
      await client.query('COMMIT');
    } finally {
      client.release();
    }
  });

  it('sees rows written earlier in the SAME transaction — the client parameter is real', async () => {
    /**
     * The super-admin routes look up and then INSERT inside one transaction, so
     * the lookup has to run on their client rather than on the pool. If it ran
     * on the pool it would be outside their transaction: uncommitted rows would
     * be invisible and, worse, the lookup would not be serialised against their
     * own writes. Asserted by making the row visible only inside the tx.
     */
    const client = await getTestPool().connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO users (firebase_uid, email, display_name)
         VALUES ($1, $2, $3)`,
        [`${PENDING_UID_PREFIX}${randomUUID()}`, 'in-flight@corp.test', null],
      );

      // Visible on the transaction's own client...
      expect(await userRepository.findByProvenEmail('in-flight@corp.test', client)).not.toBeNull();
      // ...and not from outside it, which is what proves the client was used.
      expect(await userRepository.findByProvenEmail('in-flight@corp.test')).toBeNull();

      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });

  it('still reuses an ORDINARY row — the multi-tenant invite this rule must not break', async () => {
    /**
     * One person invited by two workspaces is one person. Every row that is not
     * the product of an unverified claim is reusable exactly as before, which is
     * what the column's `DEFAULT false` buys with no backfill.
     */
    const stub = await insertStub('ordinary@corp.test');

    const found = await userRepository.findByProvenEmail('ordinary@corp.test');

    expect(found?.id).toBe(stub.id);
  });

  it('does NOT flag a claim whose Firebase address IS verified', async () => {
    const email = 'real-agent@corp.test';
    const stub = await insertStub(email);
    const membership = await insertMembership({
      user_id: stub.id,
      tenant_id: attackerTenant.id,
      role: 'agent',
    });
    const invite = await insertMembershipInvite({
      membership_id: membership.id,
      tenant_id: membership.tenant_id,
      email,
      role: 'agent',
    });

    const claimed = await membershipInviteRepository.claimWithIdentity({
      inviteId: invite.id,
      userId: stub.id,
      tenantId: invite.tenant_id,
      identity: {
        uid: 'fb-real-agent',
        name: NO_CLAIM,
        picture: NO_CLAIM,
        // A mismatched address still binds — the token is the authority — and
        // because Firebase verified it, it is adopted and the row stays clean.
        email: 'personal@gmail.test',
        email_verified: true,
      },
    });

    expect(claimed.ok).toBe(true);
    const { rows } = await getTestPool().query(
      'SELECT email, email_unverified FROM users WHERE id = $1',
      [stub.id],
    );
    expect(rows[0]).toMatchObject({ email: 'personal@gmail.test', email_unverified: false });
  });

  it('keeps the INVITED address on an unverified claim rather than adopting one nobody proved', async () => {
    /**
     * The mismatched-and-unverified shape. `adoptEmail` must not write
     * `made-up@evil.test` onto the row: that would plant a second unproven
     * address, and the row is already flagged, so nothing is gained by moving
     * it. The invited address stays, which is also what the audit row records.
     */
    const email = 'agent@work.com';
    const stub = await insertStub(email);
    const membership = await insertMembership({
      user_id: stub.id,
      tenant_id: attackerTenant.id,
      role: 'agent',
    });
    const invite = await insertMembershipInvite({
      membership_id: membership.id,
      tenant_id: membership.tenant_id,
      email,
      role: 'agent',
    });

    await membershipInviteRepository.claimWithIdentity({
      inviteId: invite.id,
      userId: stub.id,
      tenantId: invite.tenant_id,
      identity: {
        uid: 'fb-unverified',
        name: NO_CLAIM,
        picture: NO_CLAIM,
        email: 'made-up@evil.test',
        email_verified: false,
      },
    });

    const { rows } = await getTestPool().query(
      'SELECT email, email_unverified FROM users WHERE id = $1',
      [stub.id],
    );
    expect(rows[0]).toMatchObject({ email, email_unverified: true });
  });

  it('CLEARS the flag when the rightful owner signs in with a verified token', async () => {
    /**
     * `POST /auth/session` path 2 finds the row BY a verified address
     * (`sessionLinkEmail` refuses anything else) and adopts it unconditionally —
     * so the person who actually controls the inbox takes the row back and the
     * flag is repaired on the way in. That self-heal is why `findByEmail` does
     * NOT filter the flag and `findByProvenEmail` does.
     */
    const stub = await poisonAddress(VICTIM_EMAIL);

    const adopted = await adoptFirebaseIdentity(
      getTestPool(),
      stub.id,
      { uid: 'fb-the-real-victim', name: NO_CLAIM, picture: NO_CLAIM, email: VICTIM_EMAIL, email_verified: true },
      null,
    );

    expect(adopted?.firebase_uid).toBe('fb-the-real-victim');
    expect(adopted?.email_unverified).toBe(false);
    expect(await userRepository.findByProvenEmail(VICTIM_EMAIL)).not.toBeNull();
  });

  it('prefers the CLEAN row when a flagged one and a fresh stub share an address', async () => {
    /**
     * The state the refusal above creates: the attacker's flagged row, plus the
     * fresh stub an honest invite wrote beside it. `users.email` has never been
     * unique, so path 2's lookup had always been "whichever row Postgres hands
     * back first" — which is now a choice between a trap and the intended row,
     * and must not be left to the planner.
     */
    await poisonAddress(VICTIM_EMAIL);
    const cleanStub = await insertStub(VICTIM_EMAIL);

    expect((await userRepository.findByEmail(VICTIM_EMAIL))?.id).toBe(cleanStub.id);
  });

  it('prefers the CLEAN row in the OTHER insert order too — not a heap-order accident', async () => {
    /**
     * The case above inserts the flagged row first, so it passes against an
     * `ORDER BY`-less query purely because Postgres returned heap order: it was
     * asserting a planner accident in the shape of the fix. Inserting the clean
     * stub FIRST is the order that actually needs the ORDER BY, and the two
     * together pin it whichever way the rows land.
     */
    const cleanStub = await insertStub(VICTIM_EMAIL);
    await poisonAddress(VICTIM_EMAIL);

    expect((await userRepository.findByEmail(VICTIM_EMAIL))?.id).toBe(cleanStub.id);
  });

  describe('clearing the flag — the repair that was documented and unreachable', () => {
    /**
     * The flag's original design said it clears "the moment somebody proves the
     * address", through `adoptFirebaseIdentity` on `/auth/session` path 2. For
     * the population that actually gets flagged that was false: the claim binds
     * the claimant's OWN `firebase_uid` onto the row, so every later sign-in of
     * theirs resolves at path 1 and never adopts. The flag was permanent, and
     * because `firebase_uid` is UNIQUE a second workspace's invite then wrote a
     * duplicate stub that could never be bound at all.
     */

    it('clears when the bound identity proves the row address', async () => {
      const poisoned = await poisonAddress(VICTIM_EMAIL);

      const repaired = await userRepository.clearEmailUnverifiedIfProven(
        poisoned.id,
        VICTIM_EMAIL,
      );

      expect(repaired?.email_unverified).toBe(false);
      // And the row is reusable by address again, which is the point.
      expect((await userRepository.findByProvenEmail(VICTIM_EMAIL))?.id).toBe(poisoned.id);
    });

    it('REFUSES to clear on a different address — the predicate is in the statement', async () => {
      const poisoned = await poisonAddress(VICTIM_EMAIL);

      const repaired = await userRepository.clearEmailUnverifiedIfProven(
        poisoned.id,
        'someone-else@corp.test',
      );

      expect(repaired).toBeNull();
      expect(await userRepository.findByProvenEmail(VICTIM_EMAIL)).toBeNull();
    });

    it('matches case and surrounding space, because a stored spelling is not a claim', async () => {
      const poisoned = await poisonAddress(VICTIM_EMAIL);

      const repaired = await userRepository.clearEmailUnverifiedIfProven(
        poisoned.id,
        `  ${VICTIM_EMAIL.toUpperCase()} `,
      );

      expect(repaired?.email_unverified).toBe(false);
    });

    it('is a no-op on a row that was never flagged', async () => {
      const ordinary = await insertUser({
        firebase_uid: 'fb-ordinary',
        email: 'ordinary@corp.test',
        display_name: 'Ordinary',
      });

      expect(
        await userRepository.clearEmailUnverifiedIfProven(ordinary.id, 'ordinary@corp.test'),
      ).toBeNull();
    });

    it('unblocks the second workspace: reuse resolves to the repaired row, not a duplicate', async () => {
      /**
       * The end-to-end shape of the regression. Before the repair existed, the
       * honest agent below was permanently unreachable by address, so the
       * second workspace's invite wrote a duplicate stub whose claim then died
       * on `23505` (`firebase_uid` is UNIQUE) for an `agent`, and which no
       * other role could activate at all.
       */
      const agent = await poisonAddress(VICTIM_EMAIL);
      expect(await userRepository.findByProvenEmail(VICTIM_EMAIL)).toBeNull();

      await userRepository.clearEmailUnverifiedIfProven(agent.id, VICTIM_EMAIL);

      const reused = await userRepository.findByProvenEmail(VICTIM_EMAIL);
      expect(reused?.id).toBe(agent.id);
      expect(reused?.firebase_uid).toBe('fb-attacker');
    });
  });

  describe('resolveByProvenEmail — a miss is two different answers', () => {
    it('reports `none` for an address nothing keys under', async () => {
      expect(await userRepository.resolveByProvenEmail('nobody@corp.test'))
        .toEqual({ status: 'none' });
    });

    it('reports `found` with the unflagged row when one exists', async () => {
      const clean = await insertStub(VICTIM_EMAIL);
      const resolved = await userRepository.resolveByProvenEmail(VICTIM_EMAIL);
      expect(resolved).toMatchObject({ status: 'found' });
      expect(resolved.status === 'found' && resolved.user.id).toBe(clean.id);
    });

    it('reports `unproven_conflict` when EVERY row for the address is flagged', async () => {
      /**
       * The state that used to produce an unclaimable row. A flagged row is
       * always BOUND, so writing a fresh stub beside it gives the same identity
       * a second `users` row — and `firebase_uid` is UNIQUE, so the one person
       * who would claim the new invitation collides with their own existing row
       * and is told `identity_in_use` forever.
       */
      await poisonAddress(VICTIM_EMAIL);
      expect(await userRepository.resolveByProvenEmail(VICTIM_EMAIL))
        .toEqual({ status: 'unproven_conflict' });
    });

    it('prefers the clean row over a flagged one sharing the address', async () => {
      await poisonAddress(VICTIM_EMAIL);
      const clean = await insertStub(VICTIM_EMAIL);
      const resolved = await userRepository.resolveByProvenEmail(VICTIM_EMAIL);
      expect(resolved.status === 'found' && resolved.user.id).toBe(clean.id);
    });

    it('refuses to lock without a transaction, rather than locking nothing', async () => {
      // A `FOR UPDATE` on a pooled connection with no transaction is released
      // immediately; silently doing that would be a guard that only looks real.
      await expect(
        userRepository.resolveByProvenEmail(VICTIM_EMAIL, { lock: true }),
      ).rejects.toThrow(/transaction client/);
    });
  });

  describe('the membership write refuses a row flagged underneath it', () => {
    /**
     * The interleaving the lookup alone cannot close: the address resolves to a
     * clean stub, a concurrent claim binds an identity to it and flags it, and
     * the membership then lands on a row that is now somebody else's. Simulated
     * here by flagging between the two steps, which is exactly the state that
     * race produces.
     */
    it('writes nothing when `create` runs against a row that just got flagged', async () => {
      const stub = await insertStub(VICTIM_EMAIL);
      const resolved = await userRepository.resolveByProvenEmail(VICTIM_EMAIL);
      expect(resolved.status).toBe('found');

      await getTestPool().query(
        'UPDATE users SET email_unverified = true WHERE id = $1',
        [stub.id],
      );

      const membership = await membershipRepository.create({
        user_id: stub.id,
        tenant_id: victimTenant.id,
        account_id: null,
        role: 'agent',
      }, { requireProvenEmail: VICTIM_EMAIL });

      expect(membership).toBeNull();
      const { rows } = await getTestPool().query(
        'SELECT id FROM memberships WHERE user_id = $1',
        [stub.id],
      );
      expect(rows).toHaveLength(0);
    });

    it('still writes normally against a proven row', async () => {
      const stub = await insertStub(VICTIM_EMAIL);
      const membership = await membershipRepository.create({
        user_id: stub.id,
        tenant_id: victimTenant.id,
        account_id: null,
        role: 'agent',
      }, { requireProvenEmail: VICTIM_EMAIL });
      expect(membership).not.toBeNull();
    });

    it('abandons a reactivate against a flagged row', async () => {
      const poisoned = await poisonAddress(VICTIM_EMAIL);
      const leftover = await insertMembership({
        user_id: poisoned.id,
        tenant_id: victimTenant.id,
        role: 'viewer',
      });
      await getTestPool().query(
        `UPDATE memberships SET status = 'revoked' WHERE id = $1`,
        [leftover.id],
      );

      expect(
        await membershipRepository.reactivateWithRole(
          leftover.id, 'agent', victimTenant.id, { requireProvenEmail: VICTIM_EMAIL },
        ),
      ).toBeNull();

      const { rows } = await getTestPool().query(
        'SELECT status FROM memberships WHERE id = $1',
        [leftover.id],
      );
      expect(rows[0].status).toBe('revoked');
    });
  });

  /*
   * Not covered: backfilling rows bound by a historical claim ("history is not safe
   * to default"). The squashed baseline (`packages/db/migrations/0001_baseline.sql`)
   * creates `users.email_unverified` with no backfill, because a fresh database has
   * no historical rows. Historical rows arrive at cutover, which must copy the flag
   * as-is rather than default it.
   */

  it('flags a PHONE-AUTH claim too, which has no address to prove and so stays flagged', async () => {
    /**
     * A claim carrying no email at all still binds an identity that can sign in
     * as a row keyed under an address it never proved — the same trap by a
     * different door, so it is flagged. The consequence is deliberate and worth
     * pinning rather than discovering: such a row can never be repaired
     * (`clearEmailUnverifiedIfProven` needs an address the identity proves) and
     * therefore stays out of the by-address reuse paths for good.
     */
    const stub = await insertStub(VICTIM_EMAIL);
    const membership = await insertMembership({
      user_id: stub.id,
      tenant_id: attackerTenant.id,
      role: 'agent',
    });
    const invite = await insertMembershipInvite({
      membership_id: membership.id,
      tenant_id: membership.tenant_id,
      email: VICTIM_EMAIL,
      role: 'agent',
    });

    const claimed = await membershipInviteRepository.claimWithIdentity({
      inviteId: invite.id,
      userId: stub.id,
      tenantId: invite.tenant_id,
      identity: { uid: 'fb-phone', name: NO_CLAIM, picture: NO_CLAIM, email: NO_CLAIM },
    });

    expect(claimed.ok).toBe(true);

    const { rows } = await getTestPool().query(
      'SELECT email, email_unverified FROM users WHERE id = $1',
      [stub.id],
    );
    // The invited address is untouched — there was none on the token to adopt —
    // and the row is flagged all the same, so reuse refuses it.
    expect(rows[0]).toMatchObject({ email: VICTIM_EMAIL, email_unverified: true });
    expect(await userRepository.findByProvenEmail(VICTIM_EMAIL)).toBeNull();

    /**
     * And it stays that way. The repository method clears on a proven address
     * and does not itself know who proved it — the gate is at the caller, and
     * `/auth/session` path 1 only reaches it when the token carries
     * `email_verified === true` AND an address. A phone-auth token carries
     * neither, so this row has no route to the repair at all.
     */
  });

  /**
   * ── The VERIFIED mismatched claim, which the flag cannot see ─────────────
   *
   * Every case above turns on `email_unverified`, and the claim path has a
   * second arm the flag says nothing about. A claim may carry a verified
   * address that DIFFERS from the invited one — that is deliberate, the token
   * is the authority — and `adoptEmail`'s proven branch then REWRITES
   * `users.email` to the claimant's own address and sets the flag to `false`.
   *
   * So the row `POST /users/invite` resolved as the victim's can become the
   * claimant's, keyed under the claimant's address, with the flag clear. A race
   * guard that rechecks only the flag sees a perfectly clean row and attaches
   * the membership to it — the original takeover, reached through the one arm
   * the flag was never going to cover. The guard's predicate is therefore the
   * ADDRESS the caller resolved by, plus the flag.
   */
  describe('a VERIFIED claim that rewrites the address mid-invite', () => {
    const ATTACKER_EMAIL = 'attacker@evil.test';

    /**
     * The interleaving, run in the order it actually occurs: the invite route
     * resolves the address and captures the row id, and the claim commits in
     * the gap before the membership write. Returns what the invite route is
     * holding when it reaches that write.
     */
    async function inviteResolvesThenClaimRebinds() {
      const stub = await insertStub(VICTIM_EMAIL);

      // 1. The honest invite resolves the address. This is the row it will write to.
      const resolved = await userRepository.resolveByProvenEmail(VICTIM_EMAIL);
      expect(resolved.status).toBe('found');
      const targetId = resolved.status === 'found' ? resolved.user.id : '';
      expect(targetId).toBe(stub.id);

      // 2. In the gap, a claim on that same stub binds a VERIFIED identity of its own.
      const membership = await insertMembership({
        user_id: stub.id,
        tenant_id: attackerTenant.id,
        role: 'agent',
      });
      const invite = await insertMembershipInvite({
        membership_id: membership.id,
        tenant_id: membership.tenant_id,
        email: VICTIM_EMAIL,
        role: 'agent',
      });
      const claimed = await membershipInviteRepository.claimWithIdentity({
        inviteId: invite.id,
        userId: stub.id,
        tenantId: invite.tenant_id,
        identity: {
          uid: 'fb-attacker-verified',
          name: NO_CLAIM,
          picture: NO_CLAIM,
          email: ATTACKER_EMAIL,
          email_verified: true,
        },
      });
      expect(claimed.ok).toBe(true);

      return { targetId };
    }

    it('leaves the row CLEAN, which is exactly why a flag-only recheck missed it', async () => {
      const { targetId } = await inviteResolvesThenClaimRebinds();

      const { rows } = await getTestPool().query(
        'SELECT email, email_unverified, firebase_uid FROM users WHERE id = $1',
        [targetId],
      );
      /**
       * Asserted so the next reader can see the premise rather than take it on
       * trust: the row is now the claimant's, under the claimant's address, and
       * `email_unverified` is FALSE. Nothing about this row is suspicious to a
       * predicate that only reads the flag.
       */
      expect(rows[0]).toMatchObject({
        email: ATTACKER_EMAIL,
        email_unverified: false,
        firebase_uid: 'fb-attacker-verified',
      });
    });

    it('writes NO membership — create refuses the row that stopped answering to the address', async () => {
      const { targetId } = await inviteResolvesThenClaimRebinds();

      const membership = await membershipRepository.create(
        {
          user_id: targetId,
          tenant_id: victimTenant.id,
          role: 'tenant_admin',
        },
        { requireProvenEmail: VICTIM_EMAIL },
      );

      expect(membership).toBeNull();
      const { rows } = await getTestPool().query(
        'SELECT count(*)::int AS n FROM memberships WHERE user_id = $1 AND tenant_id = $2',
        [targetId, victimTenant.id],
      );
      expect(rows[0].n).toBe(0);
    });

    it('writes NO membership on the reactivate path either', async () => {
      const { targetId } = await inviteResolvesThenClaimRebinds();

      /**
       * The leftover-membership branch: a departed member of the victim
       * workspace is being re-added. Same resolve-then-write shape, same gap.
       */
      const leftover = await insertMembership({
        user_id: targetId,
        tenant_id: victimTenant.id,
        role: 'viewer',
        status: 'revoked',
      });

      const reactivated = await membershipRepository.reactivateWithRole(
        leftover.id,
        'tenant_admin',
        victimTenant.id,
        { requireProvenEmail: VICTIM_EMAIL },
      );

      expect(reactivated).toBeNull();
      const { rows } = await getTestPool().query(
        'SELECT status, role FROM memberships WHERE id = $1',
        [leftover.id],
      );
      expect(rows[0]).toMatchObject({ status: 'revoked', role: 'viewer' });
    });

    it('still writes when the row DID keep the address — the guard is not simply off', async () => {
      /**
       * The counterpart that makes the three refusals above mean something. An
       * ordinary invite, nothing racing it, must still land.
       */
      const stub = await insertStub(VICTIM_EMAIL);

      const membership = await membershipRepository.create(
        {
          user_id: stub.id,
          tenant_id: victimTenant.id,
          role: 'tenant_admin',
        },
        { requireProvenEmail: VICTIM_EMAIL },
      );

      expect(membership).not.toBeNull();
      expect(membership).toMatchObject({ user_id: stub.id, role: 'tenant_admin' });
    });
  });

  /**
   * ── Re-binding a row that is ALREADY this identity must not flag it ───────
   *
   * `adoptFirebaseIdentity`'s stub predicate admits two shapes: activating a
   * `pending_` stub, and re-binding a row whose `firebase_uid` already equals
   * the incoming uid. They mean opposite things for this column. The first keys
   * a row under an address the identity has not proven; the second changes
   * nothing and hands nothing over — it is the ordinary second-workspace claim
   * by somebody who already has an account here.
   *
   * Flagging both was a way to REVOKE an established proof with one unverified
   * claim. The phone-auth form was unrecoverable: no address on the token means
   * `clearEmailUnverifiedIfProven` can never run, so a single claim would have
   * removed that person's proven address from `POST /users/invite` and both
   * super-admin provisioning routes for good.
   */
  describe('a second claim by an identity the row already belongs to', () => {
    const PROVEN_EMAIL = 'real.person@corp.test';

    /** Somebody with a real account here, address proven, invited elsewhere. */
    async function existingAccountClaimsASecondInvite(identity: {
      uid: string;
      email: string; // a `null` claim is passed as NO_CLAIM (see top)
      email_verified?: boolean;
    }) {
      const user = await insertUser({
        firebase_uid: 'fb-real-person',
        email: PROVEN_EMAIL,
        email_unverified: false,
      });
      const membership = await insertMembership({
        user_id: user.id,
        tenant_id: victimTenant.id,
        role: 'agent',
      });
      const invite = await insertMembershipInvite({
        membership_id: membership.id,
        tenant_id: membership.tenant_id,
        email: PROVEN_EMAIL,
        role: 'agent',
      });

      const claimed = await membershipInviteRepository.claimWithIdentity({
        inviteId: invite.id,
        userId: user.id,
        tenantId: invite.tenant_id,
        identity: { name: NO_CLAIM, picture: NO_CLAIM, ...identity },
      });
      expect(claimed.ok).toBe(true);

      const { rows } = await getTestPool().query(
        'SELECT email, email_unverified FROM users WHERE id = $1',
        [user.id],
      );
      return rows[0];
    }

    it('does not flag on a PHONE-AUTH claim — the form that could never be undone', async () => {
      const row = await existingAccountClaimsASecondInvite({ uid: 'fb-real-person', email: NO_CLAIM });

      expect(row).toMatchObject({ email: PROVEN_EMAIL, email_unverified: false });
      // Still reusable by address, which is the whole point of not flagging it.
      expect(await userRepository.findByProvenEmail(PROVEN_EMAIL)).not.toBeNull();
    });

    it('does not flag on an UNVERIFIED email claim either', async () => {
      const row = await existingAccountClaimsASecondInvite({
        uid: 'fb-real-person',
        email: PROVEN_EMAIL,
        email_verified: false,
      });

      expect(row).toMatchObject({ email: PROVEN_EMAIL, email_unverified: false });
      expect(await userRepository.findByProvenEmail(PROVEN_EMAIL)).not.toBeNull();
    });

    it('DOES still flag when the same statement is activating a stub', async () => {
      /**
       * The counterpart, and the case the flag exists for. Narrowing the
       * flag to stub activation must not narrow it out of existence.
       */
      const stub = await poisonAddress(VICTIM_EMAIL);

      const { rows } = await getTestPool().query(
        'SELECT email_unverified FROM users WHERE id = $1',
        [stub.id],
      );
      expect(rows[0].email_unverified).toBe(true);
    });
  });
});
