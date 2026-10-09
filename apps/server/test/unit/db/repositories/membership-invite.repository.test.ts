import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * `MembershipInviteRepository` (migration 069).
 *
 * ── What is asserted here, and what deliberately is not ────────────────────
 * The single-winner property of a concurrent double-claim is a property of
 * POSTGRES, not of this code: two transactions both running
 * `UPDATE … WHERE claimed_at IS NULL` serialise on the row lock, and under READ
 * COMMITTED the second re-evaluates its predicate against the first's committed
 * row and matches nothing. No unit test with a mocked pool can demonstrate that.
 *
 * What a unit test CAN do — and what these cases do — is pin the two things the
 * database guarantee depends on, both of which are ours to get wrong:
 *
 *  1. **The statement is a CONDITIONAL update, and the row count is the answer.**
 *     A read-then-write, or an unconditional UPDATE, would let both callers
 *     proceed. Asserted on the SQL and on the `rowCount` branch.
 *  2. **The claim and the identity bind commit TOGETHER.** Claim-then-bind as two
 *     statements leaves an invite spent with nobody bound when the bind fails;
 *     bind-then-claim lets the loser of a race overwrite the winner's identity.
 *     Asserted on the BEGIN/COMMIT/ROLLBACK sequence.
 *  3. **Issuing a token revokes the outstanding one in the SAME transaction.**
 *     Two autocommit statements let two concurrent resends both revoke before
 *     either inserted, leaving two live links. The transaction is not sufficient
 *     on its own — the loser's revoke is correct in its own snapshot — so
 *     migration 069's partial unique index is what refuses the second row, and
 *     what this file can pin is that its violation becomes a named error rather
 *     than an escaping `23505`.
 *
 * The end-to-end behaviour against a real database belongs in the integration
 * suite; the route-level behaviour is in
 * `test/unit/api/routes/invites.routes.test.ts`.
 */

const mocks = vi.hoisted(() => ({
  pool: { query: vi.fn(), connect: vi.fn() },
  client: { query: vi.fn(), release: vi.fn() },
}));

vi.mock('@magick-agency/db', () => ({ getPool: () => mocks.pool }));

import {
  LiveInviteConflictError,
  MembershipInviteRepository,
} from '../../../../src/db/repositories/membership-invite.repository.js';

const INVITE = 'invite-1';
const USER = 'user-1';
const IDENTITY = { uid: 'fb-new', name: 'New Agent', picture: 'https://x.test/a.png' };
/**
 * The INVITE's tenant, and the only workspace a claim may activate. Threaded
 * into every `claimWithIdentity` call below because the guard that keeps a token
 * from activating a stub another workspace is waiting on
 * (`AdoptIdentityOptions.confineStubToTenantId`) is inert without it.
 */
const TENANT = 'tenant-1';

/** The statements a client saw, in order, as bare SQL. */
function clientSql(): string[] {
  return mocks.client.query.mock.calls.map((call) => String(call[0]));
}

describe('MembershipInviteRepository', () => {
  let repo: MembershipInviteRepository;

  beforeEach(() => {
    vi.clearAllMocks();
    repo = new MembershipInviteRepository();
    mocks.pool.connect.mockResolvedValue(mocks.client);
    mocks.client.query.mockResolvedValue({ rows: [], rowCount: 1 });
  });

  describe('createSupersedingOutstanding', () => {
    const INPUT = {
      membership_id: 'm-1',
      tenant_id: 't-1',
      email: 'a@test.com',
      role: 'agent' as const,
      token_hash: 'deadbeef',
      expires_at: new Date('2026-01-08T00:00:00Z'),
      invited_by: 'inviter-1',
    };

    function insertReturns(row: Record<string, unknown> = { id: INVITE }) {
      mocks.client.query.mockImplementation(async (sql: string) => {
        if (String(sql).startsWith('INSERT INTO membership_invites')) {
          return { rows: [row], rowCount: 1 };
        }
        return { rows: [], rowCount: 1 };
      });
    }

    it('stores the HASH and the expiry, and never a raw token', async () => {
      // The row is a credential store. Anything replayable in it defeats the
      // point of hashing at all — see `invite-token.ts`.
      insertReturns();

      await repo.createSupersedingOutstanding(INPUT);

      const insert = mocks.client.query.mock.calls
        .find((call) => String(call[0]).startsWith('INSERT INTO membership_invites'))!;
      expect(String(insert[0])).toContain('token_hash');
      expect(insert[1]).toContain('deadbeef');
    });

    it('defaults invited_by to null rather than omitting the column', async () => {
      // `invited_by` is unconstrained (an invite record outlives the admin who
      // made it), so `undefined` reaching the driver would be a runtime error
      // rather than a NULL.
      insertReturns();

      await repo.createSupersedingOutstanding({
        membership_id: 'm-1', tenant_id: 't-1', email: 'a@test.com',
        role: 'agent', token_hash: 'h', expires_at: new Date(),
      });

      const insert = mocks.client.query.mock.calls
        .find((call) => String(call[0]).startsWith('INSERT INTO membership_invites'))!;
      expect(insert[1]).toContain(null);
    });

    it('revokes and inserts inside ONE transaction, revoke first', async () => {
      /**
       * The resend route used to revoke on its own connection and then call
       * `issueInvite` to insert. Two resends landing together could both revoke
       * before either inserted, and the invariant this path states — one live
       * token per membership — silently became two, with a stale link still
       * binding an identity.
       *
       * Order inside the transaction is the other half: minting first would
       * leave a window where two links both work, which is the exact thing a
       * resend exists to end.
       */
      insertReturns();

      await repo.createSupersedingOutstanding(INPUT);

      const sql = clientSql();
      expect(sql[0]).toBe('BEGIN');
      expect(sql[1]).toContain('UPDATE membership_invites');
      expect(sql[1]).toContain('SET revoked_at = NOW()');
      expect(sql[2]).toContain('INSERT INTO membership_invites');
      expect(sql[sql.length - 1]).toBe('COMMIT');
    });

    it('revokes rather than deletes, and only the outstanding ones', async () => {
      /**
       * Deleting would make an older link answer `not_found`, which reads to the
       * recipient as "this invitation never existed" — the one message that is
       * both wrong and unactionable. `revoked` lets the page say "a newer
       * invitation was sent".
       *
       * Claimed rows are left alone: a claimed invite has already done its whole
       * job, and revoking it would rewrite history.
       */
      insertReturns();

      await repo.createSupersedingOutstanding(INPUT);

      const revoke = clientSql().find((sql) => sql.includes('SET revoked_at = NOW()'))!;
      expect(revoke).not.toContain('DELETE');
      expect(revoke).toContain('claimed_at IS NULL');
      expect(revoke).toContain('revoked_at IS NULL');
    });

    it('puts the tenant boundary in the STATEMENT, not in a downstream if', async () => {
      /**
       * The tenant boundary belongs in the statement itself (the only tenant-route-reachable write here).
       * `POST /invites/resend` takes `membership_id` from a request body, and a
       * membership id travels in URLs, logs and support threads — so "the caller
       * knew the id" is never evidence they may act on it. The route does resolve
       * the membership tenant-scoped first, so this refuses nothing it lets
       * through today; it is here because a check in one place and a write in
       * another can drift.
       */
      insertReturns();

      await repo.createSupersedingOutstanding(INPUT);

      const revoke = mocks.client.query.mock.calls
        .find((call) => String(call[0]).includes('SET revoked_at = NOW()'))!;
      expect(String(revoke[0])).toContain('membership_id = $1');
      expect(String(revoke[0])).toContain('tenant_id = $2');
      expect(revoke[1]).toEqual(['m-1', 't-1']);
    });

    it('revokes EXPIRED rows too — "outstanding" is unclaimed and unrevoked', async () => {
      // A resend must revoke an expired token as well, or the old link outlives
      // the new one in the `token_hash` index — and holds the one live slot the
      // partial unique index allows.
      insertReturns();

      await repo.createSupersedingOutstanding(INPUT);

      const revoke = clientSql().find((sql) => sql.includes('SET revoked_at = NOW()'))!;
      expect(revoke).not.toContain('expires_at');
    });

    it('answers LiveInviteConflictError when the live-token index refuses the insert', async () => {
      /**
       * The transaction is not sufficient on its own and the index is what
       * actually holds: under READ COMMITTED the loser's revoke re-evaluates,
       * does not see the winner's freshly inserted row, and revokes nothing — so
       * both callers would insert. `uq_membership_invites_live` refuses the
       * second, and the refusal has to arrive as something the route can turn
       * into a sentence: an escaping `23505` is rewritten by `errorMaskHook` into
       * "contact support and quote this request id" for a state that needs no
       * support at all.
       */
      mocks.client.query.mockImplementation(async (sql: string) => {
        if (String(sql).startsWith('INSERT INTO membership_invites')) {
          throw Object.assign(new Error('duplicate key'), {
            code: '23505', constraint: 'uq_membership_invites_live',
          });
        }
        return { rows: [], rowCount: 1 };
      });

      await expect(repo.createSupersedingOutstanding(INPUT))
        .rejects.toBeInstanceOf(LiveInviteConflictError);
      expect(clientSql()).toContain('ROLLBACK');
      expect(clientSql()).not.toContain('COMMIT');
    });

    it('does NOT report a token_hash collision as a concurrent resend', async () => {
      /**
       * The same statement can raise `23505` from `token_hash`'s unique index,
       * and the two deserve opposite answers. A hash collision on 32 CSPRNG bytes
       * does not happen; if it somehow did, a 500 telling the supervisor to press
       * the button again is honest, because pressing it mints a different token.
       * "Somebody just resent this" would be a plausible sentence about something
       * that did not occur — so an unnamed or differently-named unique violation
       * propagates as the error it is.
       */
      mocks.client.query.mockImplementation(async (sql: string) => {
        if (String(sql).startsWith('INSERT INTO membership_invites')) {
          throw Object.assign(new Error('duplicate key'), {
            code: '23505', constraint: 'membership_invites_token_hash_key',
          });
        }
        return { rows: [], rowCount: 1 };
      });

      await expect(repo.createSupersedingOutstanding(INPUT))
        .rejects.not.toBeInstanceOf(LiveInviteConflictError);
    });

    it('always releases the client, and DESTROYS one whose rollback failed', async () => {
      // A leaked connection per failed resend exhausts the pool; a client that
      // may still hold an open transaction must never go back to it. Same guard,
      // for the same reason, as `claimWithIdentity`.
      mocks.client.query.mockImplementation(async (sql: string) => {
        if (String(sql) === 'ROLLBACK') throw new Error('rollback failed');
        if (String(sql).startsWith('INSERT INTO membership_invites')) throw new Error('boom');
        return { rows: [], rowCount: 1 };
      });

      await expect(repo.createSupersedingOutstanding(INPUT)).rejects.toThrow('boom');
      expect(mocks.client.release).toHaveBeenCalledWith(true);
    });
  });

  describe('findByTokenHash', () => {
    it('looks up by hash equality — the property no timing attack can reach', async () => {
      /**
       * The lookup MUST stay an equality match on the indexed hash. Fetching
       * candidate rows and comparing them in JavaScript is what would create the
       * comparison oracle `invite-token.ts` explains this design does not have.
       */
      mocks.pool.query.mockResolvedValue({ rows: [] });

      await repo.findByTokenHash('abc');

      const [sql, params] = mocks.pool.query.mock.calls[0]!;
      expect(sql).toContain('WHERE token_hash = $1');
      expect(params).toEqual(['abc']);
    });

    it('returns claimed, revoked and expired rows rather than filtering them', async () => {
      /**
       * Filtering here would collapse "this link was already used" into "no such
       * link", and those are two different messages to a person holding an email:
       * one says sign in, the other says ask for a new invitation.
       */
      mocks.pool.query.mockResolvedValue({ rows: [{ id: INVITE, claimed_at: new Date() }] });

      await expect(repo.findByTokenHash('abc')).resolves.toMatchObject({ id: INVITE });
      expect(String(mocks.pool.query.mock.calls[0]![0])).not.toContain('claimed_at IS NULL');
    });
  });

  describe('markClaimed', () => {
    it('is a CONDITIONAL update — this is what elects a single winner', async () => {
      /**
       * `WHERE claimed_at IS NULL AND revoked_at IS NULL`. Under READ COMMITTED
       * the second of two concurrent callers blocks on the row lock and then
       * re-evaluates this predicate against the first's committed row, matching
       * nothing. Drop the predicate — or split this into a SELECT and an
       * unconditional UPDATE — and both callers proceed.
       */
      const client = { query: vi.fn().mockResolvedValue({ rows: [], rowCount: 1 }) };

      await repo.markClaimed(INVITE, USER, client);

      const [sql, params] = client.query.mock.calls[0]!;
      expect(sql).toContain('claimed_at IS NULL');
      expect(sql).toContain('revoked_at IS NULL');
      expect(params).toEqual([INVITE, USER]);
    });

    it('has EXPIRY in the predicate, not only in the route above it', async () => {
      /**
       * `expires_at > NOW()`. The route checks expiry too, but that check sits
       * above `verifyIdToken` — an outbound call to Firebase — and above the
       * membership read, so a TTL lapsing inside that window used to bind
       * anyway. Expiry is the one of the three refusals that arrives with nobody
       * acting, which makes a JavaScript read taken two awaits earlier exactly
       * the wrong place to hold it.
       */
      const client = { query: vi.fn().mockResolvedValue({ rows: [], rowCount: 1 }) };

      await repo.markClaimed(INVITE, USER, client);

      expect(client.query.mock.calls[0]![0]).toContain('expires_at > NOW()');
    });

    it('reports EXPIRED when the row lapsed rather than being spent or revoked', async () => {
      // The three remedies differ — ask for a new one, sign in, check your inbox
      // — so the classifying re-read has to say which predicate failed. Reported
      // as `already_claimed`, an expired link tells somebody with no account to
      // "sign in to continue".
      mocks.client.query.mockImplementation(async (sql: string) => {
        if (String(sql).startsWith('UPDATE membership_invites')) return { rows: [], rowCount: 0 };
        if (String(sql).startsWith('SELECT claimed_at')) {
          return {
            rows: [{
              claimed_at: null,
              revoked_at: null,
              expires_at: new Date(Date.now() - 60_000),
            }],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 1 };
      });

      await expect(repo.markClaimed(INVITE, USER, mocks.client)).resolves.toEqual({
        ok: false,
        reason: 'expired',
      });
    });

    it('prefers REVOKED and CLAIMED over an expiry the row has also passed', async () => {
      // Same precedence as `inviteStatus`: a claimed invite eventually passes its
      // expiry too, and telling that person to ask for a new invitation instead
      // of to sign in is the wrong next step.
      mocks.client.query.mockImplementation(async (sql: string) => {
        if (String(sql).startsWith('UPDATE membership_invites')) return { rows: [], rowCount: 0 };
        if (String(sql).startsWith('SELECT claimed_at')) {
          return {
            rows: [{
              claimed_at: new Date(),
              revoked_at: null,
              expires_at: new Date(Date.now() - 60_000),
            }],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 1 };
      });

      await expect(repo.markClaimed(INVITE, USER, mocks.client)).resolves.toEqual({
        ok: false,
        reason: 'already_claimed',
      });
    });

    it('reports the row count as the outcome, not the absence of an error', async () => {
      const client = { query: vi.fn().mockResolvedValue({ rows: [], rowCount: 1 }) };
      await expect(repo.markClaimed(INVITE, USER, client)).resolves.toEqual({ ok: true });
    });

    it('treats a null rowCount as a loss, not a win', async () => {
      // `rowCount` is `number | null` in node-pg. `?? 0` rather than `!`, because
      // reading an unknown as a success would double-bind an identity.
      const client = { query: vi.fn().mockResolvedValue({ rows: [], rowCount: null }) };
      await expect(repo.markClaimed(INVITE, USER, client)).resolves.toEqual({
        ok: false,
        reason: 'already_claimed',
      });
    });

    it('runs ONLY on a supplied client, never on the pool', async () => {
      /**
       * `db` used to be optional and no caller ever omitted it. Spending the
       * invite outside `claimWithIdentity`'s transaction is exactly the
       * claim-without-bind split that method exists to forbid, so the pool
       * fallback was an untested path whose only use would have been a bug.
       */
      const client = { query: vi.fn().mockResolvedValue({ rows: [], rowCount: 1 }) };

      await repo.markClaimed(INVITE, USER, client);

      expect(client.query).toHaveBeenCalledTimes(1);
      expect(mocks.pool.query).not.toHaveBeenCalled();
    });

    it('reports REVOKED rather than already_claimed when a resend superseded the token', async () => {
      /**
       * The two halves of `claimed_at IS NULL AND revoked_at IS NULL` fail for
       * different reasons, and the person holding the link needs different advice
       * for each. Reported as one boolean, a superseded link was answered "this
       * invitation has already been used. Sign in to continue" — wrong in both
       * halves for somebody with no account yet and a working link in their
       * inbox — and counted as `invite_claims_total{result="already_claimed"}`.
       */
      mocks.client.query.mockImplementation(async (sql: string) => {
        if (String(sql).startsWith('UPDATE membership_invites')) return { rows: [], rowCount: 0 };
        if (String(sql).startsWith('SELECT claimed_at')) {
          return { rows: [{ claimed_at: null, revoked_at: new Date() }], rowCount: 1 };
        }
        return { rows: [], rowCount: 1 };
      });

      await expect(repo.markClaimed(INVITE, USER, mocks.client)).resolves.toEqual({
        ok: false,
        reason: 'revoked',
      });
    });

    it('reports already_claimed when the row was spent rather than revoked', async () => {
      mocks.client.query.mockImplementation(async (sql: string) => {
        if (String(sql).startsWith('UPDATE membership_invites')) return { rows: [], rowCount: 0 };
        if (String(sql).startsWith('SELECT claimed_at')) {
          return { rows: [{ claimed_at: new Date(), revoked_at: null }], rowCount: 1 };
        }
        return { rows: [], rowCount: 1 };
      });

      await expect(repo.markClaimed(INVITE, USER, mocks.client)).resolves.toEqual({
        ok: false,
        reason: 'already_claimed',
      });
    });

    it('prefers REVOKED when a row is somehow both', () => {
      // Same precedence as `inviteStatus` in the routes: revocation is the one
      // outcome with a live next step attached, so a page and the request its
      // button makes cannot disagree.
      mocks.client.query.mockImplementation(async (sql: string) => {
        if (String(sql).startsWith('UPDATE membership_invites')) return { rows: [], rowCount: 0 };
        if (String(sql).startsWith('SELECT claimed_at')) {
          return { rows: [{ claimed_at: new Date(), revoked_at: new Date() }], rowCount: 1 };
        }
        return { rows: [], rowCount: 1 };
      });

      return expect(repo.markClaimed(INVITE, USER, mocks.client)).resolves.toEqual({
        ok: false,
        reason: 'revoked',
      });
    });

    it('does NOT re-read the row when the conditional update won', async () => {
      // The follow-up SELECT exists only to tell two failures apart. On the happy
      // path it would be a second round trip per claim for nothing — and it must
      // not weaken the single-winner property, which is a property of this exact
      // UPDATE re-evaluating its own predicate.
      mocks.client.query.mockResolvedValue({ rows: [], rowCount: 1 });

      await expect(repo.markClaimed(INVITE, USER, mocks.client)).resolves.toEqual({ ok: true });
      expect(clientSql().some((sql) => sql.startsWith('SELECT claimed_at'))).toBe(false);
    });
  });

  describe('claimWithIdentity', () => {
    it('spends the invite and binds the identity in ONE transaction', async () => {
      mocks.client.query.mockImplementation(async (sql: string) => {
        if (String(sql).includes('UPDATE users')) {
          return { rows: [{ id: USER, firebase_uid: IDENTITY.uid }], rowCount: 1 };
        }
        return { rows: [], rowCount: 1 };
      });

      const result = await repo.claimWithIdentity({ inviteId: INVITE, userId: USER, tenantId: TENANT, identity: IDENTITY });

      expect(result).toEqual({ ok: true, user: { id: USER, firebase_uid: IDENTITY.uid } });
      const sql = clientSql();
      expect(sql[0]).toBe('BEGIN');
      expect(sql[sql.length - 1]).toBe('COMMIT');
      // Claim FIRST: the row lock is taken before anything touches `users`, so
      // the loser of a race refuses before it can write an identity.
      expect(sql[1]).toContain('UPDATE membership_invites');
      /**
       * Then the user row is LOCKED, and only then bound. The lock is its own
       * statement on purpose: `confineStubToTenantId`'s `NOT EXISTS` is a
       * snapshot read that takes no lock on a membership row which does not
       * exist yet, so a concurrent invite could insert one between the check and
       * the commit. Taking the lock first means the bind below is planned under
       * a snapshot that already includes anything an invite committed ahead of
       * us. The ORDER is the guarantee, so it is asserted positionally.
       */
      expect(sql[2]).toContain('FOR UPDATE');
      expect(sql[3]).toContain('UPDATE users');
    });

    it('scopes the bind to an UNCLAIMED STUB — the account-takeover guard', async () => {
      /**
       * `POST /users/invite` aims a membership at an EXISTING `users` row when the
       * invited address is already known, and the claim binds an identity with no
       * relation to that address. Without this predicate the two compose into a
       * remote takeover of any account from its email alone — see
       * `AdoptIdentityOptions`. Asserted on the STATEMENT rather than through a
       * mocked helper, because the guarantee is that the database refuses.
       */
      mocks.client.query.mockImplementation(async (sql: string) => {
        if (String(sql).includes('UPDATE users')) {
          return { rows: [{ id: USER, firebase_uid: IDENTITY.uid }], rowCount: 1 };
        }
        return { rows: [], rowCount: 1 };
      });

      await repo.claimWithIdentity({ inviteId: INVITE, userId: USER, tenantId: TENANT, identity: IDENTITY });

      const bind = clientSql().find((s) => s.includes('UPDATE users'));
      expect(bind).toContain('starts_with(firebase_uid');
    });

    it('binds a row that already carries THE CLAIMANT\u2019S OWN uid', async () => {
      /**
       * The ordinary "add an agent who already has a login" invite,
       * and the case a stub-only predicate refused.
       *
       * `POST /users/invite` reuses the existing `users` row when the address is
       * already known, writes a NEW membership against it, and `issueInvite`
       * still mails a join link. That invitee's `firebase_uid` is already real,
       * so `starts_with(firebase_uid, 'pending_')` alone rolled their claim back
       * and answered `409 identity_already_bound` — the sentence written for the
       * takeover reading — to somebody whose membership is genuinely theirs.
       *
       * The predicate is asserted as a STATEMENT rather than exercised through a
       * mocked pool, for the same reason the takeover guard above is: no unit
       * test with a fake `query` can evaluate a `WHERE` clause, and what has to
       * be true is that the database is the thing deciding. `= $1` is the load
       * bearing detail — the arm compares against the INCOMING uid (the same
       * parameter the `SET` writes), not against a second value that could be
       * anything.
       */
      mocks.client.query.mockImplementation(async (sql: string) => {
        if (String(sql).includes('UPDATE users')) {
          return { rows: [{ id: USER, firebase_uid: IDENTITY.uid }], rowCount: 1 };
        }
        return { rows: [], rowCount: 1 };
      });

      const result = await repo.claimWithIdentity({
        inviteId: INVITE, userId: USER, tenantId: TENANT, identity: IDENTITY,
      });

      const bind = mocks.client.query.mock.calls.find((c) => String(c[0]).includes('UPDATE users'))!;
      expect(String(bind[0])).toContain('firebase_uid = $1');
      expect((bind[1] as unknown[])[0]).toBe(IDENTITY.uid);
      // And the invite is SPENT rather than left outstanding: the rightful owner
      // used their link, so it has done its job.
      expect(result).toEqual({ ok: true, user: { id: USER, firebase_uid: IDENTITY.uid } });
      expect(clientSql()).toContain('COMMIT');
    });

    it('takes the bound identity\u2019s OWN email onto the row', async () => {
      /**
       * Without this the row afterwards keys under the INVITED address while
       * `firebase_uid` names the CLAIMANT — two people in one row — and
       * `POST /auth/session` path 2 looks up by exactly that column and adopts
       * what it finds with no `onlyUnclaimedStub`. Anyone presenting a token for
       * the invited address then took the claimed membership over.
       *
       * In the same statement as the bind, so a bind cannot land without it.
       *
       * `email_verified: true` on the identity is REQUIRED for the write, and
       * the unverified case is its mirror below: the claim accepts an
       * unverified Firebase email on purpose, so adopting one unconditionally
       * would write an address nobody proved onto a row that can now sign in —
       * which `POST /users/invite` and both super-admin provisioning lookups
       * then resolve as an identity. Migration 073.
       */
      mocks.client.query.mockImplementation(async (sql: string) => {
        if (String(sql).includes('UPDATE users')) {
          return { rows: [{ id: USER, firebase_uid: IDENTITY.uid }], rowCount: 1 };
        }
        return { rows: [], rowCount: 1 };
      });

      await repo.claimWithIdentity({
        inviteId: INVITE,
        userId: USER,
        tenantId: TENANT,
        identity: { ...IDENTITY, email: 'personal@gmail.test', email_verified: true },
      });

      const bind = mocks.client.query.mock.calls.find((c) => String(c[0]).includes('UPDATE users'))!;
      expect(String(bind[0])).toContain('email = COALESCE($8::text, email)');
      expect((bind[1] as unknown[])[7]).toBe('personal@gmail.test');
      // A proven address, so the row is not flagged.
      expect((bind[1] as unknown[])[9]).toBe(false);
    });

    it('adopts NOTHING and FLAGS the row when the claimant proved no address', async () => {
      /**
       * The self-invite takeover. `POST /users/invite` returns the raw join link
       * to the INVITER, so "the token was delivered to that inbox" is not
       * evidence when the inviter and the claimant are the same person: an
       * attacker registers an unverified Firebase account for
       * `victim@corp.test`, invites it into their own tenant as an `agent`,
       * claims their own link, and the row then keys under an address they do
       * not control — which every by-address reuse path would hand authority to.
       *
       * Neither claim-path guard can see it (the row is a fresh stub in one
       * tenant), so what closes it is that the bind records the row as carrying
       * an UNPROVEN address and `findByProvenEmail` refuses to reuse it.
       */
      mocks.client.query.mockImplementation(async (sql: string) => {
        if (String(sql).includes('UPDATE users')) {
          return { rows: [{ id: USER, firebase_uid: IDENTITY.uid }], rowCount: 1 };
        }
        return { rows: [], rowCount: 1 };
      });

      await repo.claimWithIdentity({
        inviteId: INVITE,
        userId: USER,
        tenantId: TENANT,
        identity: { ...IDENTITY, email: 'victim@corp.test', email_verified: false },
      });

      const bind = mocks.client.query.mock.calls.find((c) => String(c[0]).includes('UPDATE users'))!;
      // Gated on the row still being a stub — see the same assertion, and why,
      // in `test/unit/auth/firebase-identity.test.ts`.
      expect(String(bind[0])).toContain('WHEN starts_with(firebase_uid, $7) THEN true');
      expect((bind[1] as unknown[])[7]).toBeNull();
      expect((bind[1] as unknown[])[9]).toBe(true);
    });

    it('leaves the address alone when the identity carries none', async () => {
      // A phone-auth identity has no email, and blanking a real address would be
      // the worse half of the same defect. `NULL` means "leave the column".
      mocks.client.query.mockImplementation(async (sql: string) => {
        if (String(sql).includes('UPDATE users')) {
          return { rows: [{ id: USER, firebase_uid: IDENTITY.uid }], rowCount: 1 };
        }
        return { rows: [], rowCount: 1 };
      });

      await repo.claimWithIdentity({ inviteId: INVITE, userId: USER, tenantId: TENANT, identity: IDENTITY });

      const bind = mocks.client.query.mock.calls.find((c) => String(c[0]).includes('UPDATE users'))!;
      expect((bind[1] as unknown[])[7]).toBeNull();
    });

    /**
     * The classifying re-read that runs on the 0-row bind path, and what it
     * answers with. THREE states arrive there — the row is gone, the row is
     * somebody else's, the row is a stub several workspaces are waiting on — and
     * they owe the recipient three different sentences.
     */
    function bindRefusedWith(row: Record<string, unknown> | null) {
      mocks.client.query.mockImplementation(async (sql: string) => {
        if (String(sql).includes('UPDATE users')) return { rows: [], rowCount: 0 };
        if (String(sql).includes('FROM users u')) {
          return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
        }
        return { rows: [], rowCount: 1 };
      });
    }

    it('reports identity_already_bound when the row is bound to somebody else', async () => {
      /**
       * The bind matched nothing and the row carries a real uid that is not the
       * claimant's — their own would have matched both predicates' "already this
       * identity" arm. Distinguished from "the row is gone" and from the
       * cross-tenant stub because the three owe the recipient different
       * sentences, and this one is where a takeover attempt lands.
       *
       * Reported AHEAD of the confinement arm even when both would fire: it is
       * the more actionable answer, and a row that is already somebody's is no
       * longer a stub to confine.
       */
      bindRefusedWith({ firebase_uid: 'fb-somebody-else', has_foreign_membership: true });

      const result = await repo.claimWithIdentity({ inviteId: INVITE, userId: USER, tenantId: TENANT, identity: IDENTITY });

      expect(result).toEqual({ ok: false, reason: 'identity_already_bound' });
      // The invite is NOT spent: burning it would let an attacker deny a real
      // invitee their invitation.
      expect(clientSql()).toContain('ROLLBACK');
      expect(clientSql()).not.toContain('COMMIT');
    });

    it('reports cross_tenant_identity for a STUB another workspace is also waiting on', async () => {
      /**
       * The half `onlyUnclaimedStub` cannot see. `POST /users/invite` REUSES a
       * `users` row whenever the address is already known, so a `pending_` stub
       * can be a super-admin-provisioned owner in one workspace and the
       * attacker's `agent` invitee in their own — and an `agent` invite hands
       * the INVITER the raw join link. Binding it returned every active
       * membership on the row through `buildSessionPayload`.
       *
       * The stub test passes honestly here, which is exactly why this needs its
       * own arm rather than a widening of the one above.
       */
      bindRefusedWith({ firebase_uid: 'pending_abc', has_foreign_membership: true });

      const result = await repo.claimWithIdentity({ inviteId: INVITE, userId: USER, tenantId: TENANT, identity: IDENTITY });

      expect(result).toEqual({ ok: false, reason: 'cross_tenant_identity' });
      expect(clientSql()).toContain('ROLLBACK');
      expect(clientSql()).not.toContain('COMMIT');
    });

    it('classifies against the INVITE\u2019s tenant, in ONE statement inside the transaction', async () => {
      /**
       * "Is this row still a stub" and "does it belong to another workspace too"
       * read against each other, so they are one statement: two would let a
       * membership written in between be seen by exactly one of them. It runs on
       * the transaction's own client, before the ROLLBACK, so the answer cannot
       * be stale.
       */
      bindRefusedWith({ firebase_uid: 'pending_abc', has_foreign_membership: false });

      await repo.claimWithIdentity({ inviteId: INVITE, userId: USER, tenantId: TENANT, identity: IDENTITY });

      const read = mocks.client.query.mock.calls.find((c) => String(c[0]).includes('FROM users u'))!;
      expect(String(read[0])).toContain('m.tenant_id <> $2');
      expect(String(read[0])).toContain("m.status = 'active'");
      expect(read[1]).toEqual([USER, TENANT]);
    });

    it('passes the invite tenant to the bind as confineStubToTenantId', async () => {
      /**
       * The ninth parameter of the bind statement. A claim that passed none
       * would leave the predicate's `$9::uuid IS NULL` short-circuit satisfied
       * and the guard inert, with every other case in this file still green.
       */
      mocks.client.query.mockImplementation(async (sql: string) => {
        if (String(sql).includes('UPDATE users')) {
          return { rows: [{ id: USER, firebase_uid: IDENTITY.uid }], rowCount: 1 };
        }
        return { rows: [], rowCount: 1 };
      });

      await repo.claimWithIdentity({ inviteId: INVITE, userId: USER, tenantId: TENANT, identity: IDENTITY });

      const bind = mocks.client.query.mock.calls.find((c) => String(c[0]).includes('UPDATE users'))!;
      expect(String(bind[0])).toContain('m.tenant_id <> $9::uuid');
      expect((bind[1] as unknown[])[8]).toBe(TENANT);
    });

    it('rolls back and reports already_claimed when the conditional update loses', async () => {
      mocks.client.query.mockImplementation(async (sql: string) => {
        if (String(sql).includes('UPDATE membership_invites')) return { rows: [], rowCount: 0 };
        return { rows: [], rowCount: 1 };
      });

      const result = await repo.claimWithIdentity({ inviteId: INVITE, userId: USER, tenantId: TENANT, identity: IDENTITY });

      expect(result).toEqual({ ok: false, reason: 'already_claimed' });
      expect(clientSql()).toContain('ROLLBACK');
      // Nothing was bound. This is the property bind-then-claim would lose.
      expect(clientSql().some((s) => s.includes('UPDATE users'))).toBe(false);
    });

    it('rolls the CLAIM back when the bind fails — the invite stays outstanding', async () => {
      /**
       * The reason the two writes share a transaction. Claim-then-bind as two
       * statements leaves the recipient holding a dead link for a membership they
       * still cannot reach, and the only remedy is a supervisor noticing.
       */
      mocks.client.query.mockImplementation(async (sql: string) => {
        if (String(sql).includes('UPDATE users')) {
          throw Object.assign(new Error('duplicate key'), {
            code: '23505', constraint: 'users_firebase_uid_key',
          });
        }
        return { rows: [], rowCount: 1 };
      });

      const result = await repo.claimWithIdentity({ inviteId: INVITE, userId: USER, tenantId: TENANT, identity: IDENTITY });

      expect(result).toEqual({ ok: false, reason: 'identity_in_use' });
      expect(clientSql()).toContain('ROLLBACK');
      expect(clientSql()).not.toContain('COMMIT');
    });

    it('answers identity_in_use rather than raising a masked 500', async () => {
      /**
       * Reachable precisely because a mismatched Firebase address is ALLOWED: a
       * person claiming with a personal Google account that already has its own
       * workspace here produces exactly this state. Left to escape, `errorMaskHook`
       * rewrites it into "contact support and quote this request id" for something
       * the person can resolve in one action.
       */
      mocks.client.query.mockImplementation(async (sql: string) => {
        if (String(sql).includes('UPDATE users')) {
          throw Object.assign(new Error('duplicate key'), { code: '23505' });
        }
        return { rows: [], rowCount: 1 };
      });

      await expect(
        repo.claimWithIdentity({ inviteId: INVITE, userId: USER, tenantId: TENANT, identity: IDENTITY }),
      ).resolves.toEqual({ ok: false, reason: 'identity_in_use' });
    });

    it('re-raises any OTHER database error rather than reporting a wrong reason', async () => {
      // A connection fault is not "that identity is taken", and answering 409 for
      // one would tell a person to go and use an account that has nothing to do
      // with the failure.
      mocks.client.query.mockImplementation(async (sql: string) => {
        if (String(sql).includes('UPDATE users')) throw new Error('connection terminated');
        return { rows: [], rowCount: 1 };
      });

      await expect(
        repo.claimWithIdentity({ inviteId: INVITE, userId: USER, tenantId: TENANT, identity: IDENTITY }),
      ).rejects.toThrow('connection terminated');
    });

    it('always releases the client, on every path', async () => {
      // A leaked connection per failed claim exhausts the pool, and the claim
      // route is public.
      mocks.client.query.mockImplementation(async (sql: string) => {
        if (String(sql).includes('UPDATE users')) throw new Error('boom');
        return { rows: [], rowCount: 1 };
      });

      await expect(
        repo.claimWithIdentity({ inviteId: INVITE, userId: USER, tenantId: TENANT, identity: IDENTITY }),
      ).rejects.toThrow();
      expect(mocks.client.release).toHaveBeenCalledTimes(1);
    });

    it('DESTROYS the client when the rollback itself failed', async () => {
      /**
       * Such a client may still hold an open transaction, so returning it to the
       * pool hands the next caller a connection mid-transaction. Same guard, for
       * the same reason, as `membershipRepository.withLastOwnerGuard`.
       */
      mocks.client.query.mockImplementation(async (sql: string) => {
        if (String(sql) === 'ROLLBACK') throw new Error('rollback failed');
        if (String(sql).includes('UPDATE users')) throw new Error('boom');
        return { rows: [], rowCount: 1 };
      });

      await expect(
        repo.claimWithIdentity({ inviteId: INVITE, userId: USER, tenantId: TENANT, identity: IDENTITY }),
      ).rejects.toThrow('boom');
      expect(mocks.client.release).toHaveBeenCalledWith(true);
    });
  });
});
