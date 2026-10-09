import { describe, it, expect, vi } from 'vitest';

/**
 * `adoptFirebaseIdentity` — the one statement that binds a Firebase identity to
 * an existing `users` row (`src/auth/firebase-identity.ts`).
 *
 * ── Why these cases assert a STATEMENT rather than an outcome ──────────────
 * Every rule this function has lives in SQL: which rows the `WHERE` will match,
 * which columns `COALESCE` will leave alone. A unit test hands it a fake
 * `query`, and a fake `query` cannot evaluate a predicate — so an outcome
 * assertion here would only ever be an assertion about the fake. What a unit
 * test CAN do, and what these do, is pin the statement the database is asked to
 * run and the parameters it is given, which is the half that is ours to get
 * wrong. The behaviour of the predicate against real rows belongs to the
 * integration suite.
 *
 * Two of the rules are load-bearing security rather than hygiene, and both got
 * there by way of a defect:
 *
 *  1. **`onlyUnclaimedStub`** stops the invite claim from being a remote account
 *     takeover — and its first form was too narrow, refusing the rightful owner
 *     of an invitation sent to an address that already has a login here.
 *  2. **`adoptEmail`** stops a mismatched claim from leaving a row that keys
 *     under one person's address while naming another person's identity, which
 *     `POST /auth/session` path 2 would then hand to whoever presented the
 *     invited address.
 */

import {
  adoptFirebaseIdentity,
  isFirebaseUidCollision,
  PENDING_UID_PREFIX,
  UNIQUE_VIOLATION,
} from '../../../src/auth/firebase-identity.js';

const USER = 'user-1';
const IDENTITY = {
  uid: 'fb-claimant',
  name: 'New Agent',
  picture: 'https://x.test/a.png',
  email: 'personal@gmail.test',
};

/**
 * The `WHERE` clause's guard blocks, split apart.
 *
 * There are TWO of them and they refuse different things — `onlyUnclaimedStub`
 * ("is this row already somebody?") and `confineStubToTenantId` ("is it also
 * another workspace's pending member?") — so a test that counted `OR`s across
 * both at once would go green the moment either gained an arm the other lost.
 * Split on the exact indentation the statement is written at, which is what
 * makes each block addressable on its own.
 */
function predicateBlocks(sql: string): string[] {
  return sql
    .split('\n        AND (')
    .slice(1)
    .map((block) => block.slice(0, block.indexOf('\n        )')));
}

/** A `Queryable` that records what it was asked to run and answers one row. */
function recordingDb() {
  const query = vi.fn().mockResolvedValue({ rows: [{ id: USER }], rowCount: 1 });
  return {
    db: { query },
    sql: () => String(query.mock.calls[0]![0]),
    params: () => query.mock.calls[0]![1] as unknown[],
  };
}

describe('adoptFirebaseIdentity — the bind predicate', () => {
  it('is INERT unless the caller asks for it', async () => {
    /**
     * `POST /auth/session` path 2/3 adopts a row that already has a real uid on
     * purpose — a person re-registering under a new Firebase account, whose row
     * must follow them. Which of the two an adoption is allowed to be is the
     * CALLER's declaration, so the predicate short-circuits on a boolean the
     * caller passes rather than on anything this function infers.
     */
    const { db, sql, params } = recordingDb();

    await adoptFirebaseIdentity(db, USER, IDENTITY);

    expect(sql()).toContain('$6::boolean IS NOT TRUE');
    expect(params()[5]).toBe(false);
  });

  it('admits an unclaimed `pending_` stub', async () => {
    // The ordinary invited-a-new-address case: `POST /users/invite` wrote a stub
    // whose uid is `pending_<uuid>`, and nobody can sign in as it.
    const { db, sql, params } = recordingDb();

    await adoptFirebaseIdentity(db, USER, IDENTITY, null, { onlyUnclaimedStub: true });

    expect(sql()).toContain('starts_with(firebase_uid, $7)');
    expect(params()[5]).toBe(true);
    expect(params()[6]).toBe(PENDING_UID_PREFIX);
  });

  it('ALSO admits a row already carrying the incoming uid — the regression arm', async () => {
    /**
     * The case the stub-only predicate refused, and the most ordinary invite
     * there is after a brand-new address: *add an agent who already has a
     * login*.
     *
     * `POST /users/invite` reuses the existing `users` row when the address is
     * already known, writes a NEW membership against it, and `issueInvite` still
     * mails a join link. That invitee's `firebase_uid` is already real, so
     * `starts_with(firebase_uid, 'pending_')` alone failed, the claim rolled
     * back, and they were answered `409 identity_already_bound` — the sentence
     * written for an attacker — while holding the mail we had just sent them.
     *
     * The comparison is against `$1`, the SAME parameter the `SET` writes.
     * Nothing changes hands when they match, so the bind is idempotent rather
     * than refused; a second parameter here could be any value at all, which is
     * what would turn this arm back into the hole the predicate exists to close.
     */
    const { db, sql, params } = recordingDb();

    await adoptFirebaseIdentity(db, USER, IDENTITY, null, { onlyUnclaimedStub: true });

    expect(sql()).toContain('OR firebase_uid = $1');
    expect(params()[0]).toBe(IDENTITY.uid);
    expect(sql()).toContain('SET firebase_uid = $1');
  });

  it('refuses nothing except a row bound to a DIFFERENT identity', async () => {
    /**
     * Read as one clause, the three arms say exactly that: the caller did not
     * ask (arm 1), or the row is a stub (arm 2), or the row is already this
     * identity (arm 3). What is left over — a real uid that is somebody else's —
     * is the takeover case, and it is the whole of what the predicate declines.
     *
     * Asserted as a shape rather than a substring so a fourth arm cannot be
     * added silently: a new `OR` here widens what a token may bind, which is the
     * one change in this file that must never be made without reading
     * `AdoptIdentityOptions`.
     */
    const { db, sql } = recordingDb();

    await adoptFirebaseIdentity(db, USER, IDENTITY, null, { onlyUnclaimedStub: true });

    const [stubPredicate] = predicateBlocks(sql());
    expect(stubPredicate!.match(/\bOR\b/g)).toHaveLength(2);
  });
});

describe('adoptFirebaseIdentity — the tenant-confinement predicate', () => {
  const TENANT = '11111111-1111-1111-1111-111111111111';

  it('is INERT unless the caller names a tenant', async () => {
    /**
     * `POST /auth/session` path 2/3 has no invite and no single tenant to
     * confine to — it is authorised by a VERIFIED address, which is exactly the
     * proof that entitles it to activate a stub every workspace is waiting on.
     * So the block short-circuits on a `NULL` the caller passes.
     */
    const { db, sql, params } = recordingDb();

    await adoptFirebaseIdentity(db, USER, IDENTITY);

    expect(sql()).toContain('$9::uuid IS NULL');
    expect(params()[8]).toBeNull();
  });

  it('refuses a stub carrying an ACTIVE membership in any other tenant', async () => {
    /**
     * The takeover `onlyUnclaimedStub` cannot see. `POST /users/invite` REUSES
     * a `users` row whenever the address is already known, so a `pending_` stub
     * can be several workspaces' pending invitee at once — a super-admin
     * provisioned owner among them — and an `agent` invite into the attacker's
     * OWN tenant hands them a live token for it. The stub test passes, because
     * nobody has signed in as the row; what is wrong is the memberships hanging
     * off it. See `AdoptIdentityOptions.confineStubToTenantId`.
     */
    const { db, sql, params } = recordingDb();

    await adoptFirebaseIdentity(db, USER, IDENTITY, null, { confineStubToTenantId: TENANT });

    const [, confinement] = predicateBlocks(sql());
    expect(confinement).toContain('FROM memberships m');
    expect(confinement).toContain('m.user_id = users.id');
    expect(confinement).toContain('m.tenant_id <> $9::uuid');
    expect(params()[8]).toBe(TENANT);
  });

  it('counts only ACTIVE memberships', async () => {
    /**
     * `findAllByUserId` and `tenantRepository.listByUserId` are both
     * status-filtered, so a revoked membership elsewhere confers nothing and
     * must not block a legitimate claim — an agent whose previous workspace
     * offboarded them would otherwise be refused for no gain.
     */
    const { db, sql } = recordingDb();

    await adoptFirebaseIdentity(db, USER, IDENTITY, null, { confineStubToTenantId: TENANT });

    expect(predicateBlocks(sql())[1]).toContain("m.status = 'active'");
  });

  it('exempts a row that is ALREADY the incoming identity, against the same `$1`', async () => {
    /**
     * Their own row, their own memberships, in every workspace they hold one —
     * the ordinary "invite somebody who already has a login here" case.
     * Narrowing that would hide a person's other workspaces from them, or
     * answer a conflict to the very person the mail was addressed to.
     *
     * Against `$1`, the SAME parameter the `SET` writes, for the reason the stub
     * predicate's third arm is: a second parameter here could hold any value at
     * all, which is what turns an exemption back into a hole.
     */
    const { db, sql } = recordingDb();

    await adoptFirebaseIdentity(db, USER, IDENTITY, null, { confineStubToTenantId: TENANT });

    expect(predicateBlocks(sql())[1]).toContain('OR firebase_uid = $1');
  });

  it('refuses nothing else — three arms, and a fourth would widen what a token binds', async () => {
    // Same shape assertion, and the same reason, as the stub predicate's: an
    // added `OR` here lets a claim reach a workspace its token does not name.
    const { db, sql } = recordingDb();

    await adoptFirebaseIdentity(db, USER, IDENTITY, null, { confineStubToTenantId: TENANT });

    expect(predicateBlocks(sql())[1]!.match(/\bOR\b/g)).toHaveLength(2);
  });

  it('is INDEPENDENT of `onlyUnclaimedStub` — two blocks, both ANDed', async () => {
    /**
     * They close different halves and neither implies the other, so they are two
     * conjuncts rather than one widened clause. Collapsing them would make each
     * refusal reachable only when the other also fired, which is the opposite of
     * what an AND of two guards means.
     */
    const { db, sql } = recordingDb();

    await adoptFirebaseIdentity(db, USER, IDENTITY, null, {
      onlyUnclaimedStub: true,
      confineStubToTenantId: TENANT,
    });

    expect(predicateBlocks(sql())).toHaveLength(2);
  });
});

describe('adoptFirebaseIdentity — what the bind writes', () => {
  it('takes the identity’s own email ONLY under `adoptEmail`', async () => {
    /**
     * Off by default because path 2/3 found the row BY that address and has
     * nothing to write. On for the claim, where the address the person actually
     * signed in with is the only one that may key the row. Path 2 now also
     * requires `email_verified`, so this is the remaining *verified*-token
     * case: leaving the invited address there makes the row two people at
     * once, and a later verified token for that address takes the membership.
     */
    const off = recordingDb();
    await adoptFirebaseIdentity(off.db, USER, IDENTITY);
    expect(off.sql()).toContain('email = COALESCE($8::text, email)');
    expect(off.params()[7]).toBeNull();

    // `email_verified` is required for the write — see the verification case
    // below, for why an unproven address may not key a row.
    const on = recordingDb();
    await adoptFirebaseIdentity(on.db, USER, { ...IDENTITY, email_verified: true }, null, { adoptEmail: true });
    expect(on.params()[7]).toBe('personal@gmail.test');
  });

  it('adopts only a VERIFIED address, and FLAGS the row when it is not', async () => {
    /**
     * The claim accepts an unverified Firebase email on purpose — the token was
     * mailed to the invited inbox. But `POST /users/invite` hands the raw join
     * link back to the INVITER, so when the inviter and the claimant are the
     * same person the token proves nothing, and adopting that address writes an
     * unproven string onto a row that can now sign in. `users.email` is the
     * reuse key for `POST /users/invite` and both super-admin provisioning
     * lookups, so such a row is a trap laid under somebody else's address.
     */
    const unverified = recordingDb();
    await adoptFirebaseIdentity(
      unverified.db,
      USER,
      { ...IDENTITY, email_verified: false },
      null,
      { adoptEmail: true },
    );
    // Nothing adopted…
    expect(unverified.params()[7]).toBeNull();
    // …and the row is marked as carrying an address nobody proved.
    expect(unverified.params()[9]).toBe(true);
    /**
     * `true` is a REQUEST to flag, and the statement honours it only while it is
     * ACTIVATING a stub. Asserted on the SQL because the narrowing lives there:
     * the predicate above admits a second shape — re-binding a row whose
     * `firebase_uid` is already this identity — where nothing changes hands and
     * an established proof must survive. An unconditional write (this was
     * `COALESCE($10::boolean, email_unverified)`) let one unverified claim
     * revoke that proof, and a phone-auth claim could never restore it.
     */
    expect(unverified.sql()).toContain('WHEN $10::boolean = false THEN false');
    expect(unverified.sql()).toContain('WHEN starts_with(firebase_uid, $7) THEN true');
    expect(unverified.sql()).not.toContain('email_unverified = COALESCE($10::boolean');

    const verified = recordingDb();
    await adoptFirebaseIdentity(
      verified.db,
      USER,
      { ...IDENTITY, email_verified: true },
      null,
      { adoptEmail: true },
    );
    expect(verified.params()[7]).toBe('personal@gmail.test');
    expect(verified.params()[9]).toBe(false);
  });

  it('CLEARS the flag for a caller that found the row by a verified address', async () => {
    /**
     * `POST /auth/session` path 2/3 passes no `adoptEmail` — it found the row BY
     * the address and has nothing to write — but it is the one path that PROVES
     * one, so it is also the repair: the person who actually controls the inbox
     * signs in, adopts the row, and the flag an earlier unverified claim set
     * goes with it. That is why `findByEmail` does not filter the flag while
     * `findByProvenEmail` does.
     */
    const { db, params } = recordingDb();

    await adoptFirebaseIdentity(db, USER, { ...IDENTITY, email_verified: true });

    expect(params()[9]).toBe(false);
  });

  it('leaves the flag ALONE for an adoption that proves nothing and claims nothing', async () => {
    // A phone-auth identity carries no address, and a caller that did not ask to
    // adopt one is not making a statement about this column. `NULL` means "leave
    // it", so neither a flag nor a clearance is invented from an absence.
    const { db, params } = recordingDb();

    await adoptFirebaseIdentity(db, USER, { ...IDENTITY, email: undefined, email_verified: undefined });

    expect(params()[9]).toBeNull();
  });

  it('leaves the address alone when the identity carries none', async () => {
    // A phone-auth identity has no email, and an empty string is not an address
    // either. `NULL` means "leave the column" — blanking a real address would be
    // the worse half of the defect `adoptEmail` exists to close.
    for (const email of [undefined, '']) {
      const { db, params } = recordingDb();
      await adoptFirebaseIdentity(
        db, USER, { ...IDENTITY, email, email_verified: true }, null, { adoptEmail: true },
      );
      expect(params()[7]).toBeNull();
    }
  });

  it('fills a display name and avatar only when ABSENT, and never clears them', async () => {
    // `COALESCE` on the EXISTING value, not on the incoming one: a person who
    // has set a display name in this product must not have it overwritten by
    // whatever their Google profile says this week.
    const { db, sql } = recordingDb();

    await adoptFirebaseIdentity(db, USER, IDENTITY);

    expect(sql()).toContain('display_name = COALESCE(display_name, $2)');
    expect(sql()).toContain('avatar_url = COALESCE(avatar_url, $3)');
  });

  it('moves a phone number only off the signup placeholder', async () => {
    // `'0000000000'` is what path 4 writes when no number is supplied, so it
    // means "unset" rather than a real value.
    const { db, sql, params } = recordingDb();

    await adoptFirebaseIdentity(db, USER, IDENTITY, '+15550001111');

    expect(sql()).toContain("phone_number = '0000000000'");
    expect(params()[4]).toBe('+15550001111');
  });

  it('returns the updated row, and null when the statement matched nothing', async () => {
    // `RETURNING *` rather than a follow-up SELECT: same row, one fewer round
    // trip, and no window in which a re-read could disagree with the write. The
    // `null` is what the claim path turns into `identity_already_bound`.
    const matched = { query: vi.fn().mockResolvedValue({ rows: [{ id: USER }], rowCount: 1 }) };
    const refused = { query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }) };

    await expect(adoptFirebaseIdentity(matched, USER, IDENTITY)).resolves.toMatchObject({ id: USER });
    await expect(adoptFirebaseIdentity(refused, USER, IDENTITY)).resolves.toBeNull();
  });
});

describe('isFirebaseUidCollision', () => {
  it('matches the SQLSTATE AND the constraint, so a token_hash clash is not mistaken for it', () => {
    // The claim path writes `membership_invites` and `users` in one transaction,
    // and `token_hash` is UNIQUE too — a blanket `code === '23505'` would report
    // a hash collision as "that Google account already belongs to somebody
    // here", a sentence that sends the reader somewhere else entirely.
    expect(isFirebaseUidCollision({ code: UNIQUE_VIOLATION, constraint: 'users_firebase_uid_key' })).toBe(true);
    expect(isFirebaseUidCollision({ code: UNIQUE_VIOLATION, constraint: 'membership_invites_token_hash_key' })).toBe(false);
    expect(isFirebaseUidCollision({ code: '23503' })).toBe(false);
    expect(isFirebaseUidCollision(null)).toBe(false);
  });

  it('falls back to YES when the driver supplies no constraint name', () => {
    // node-pg populates the field in practice, so the fallback is for a wrapper
    // that does not forward it — and there the identity collision is vastly the
    // more likely of the two, since the other candidate needs a sha256 collision
    // on 32 random bytes.
    expect(isFirebaseUidCollision({ code: UNIQUE_VIOLATION })).toBe(true);
  });
});
