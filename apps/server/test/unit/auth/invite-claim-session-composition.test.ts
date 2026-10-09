import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';

/**
 * The invite claim and `POST /auth/session` path 2, COMPOSED — the pair that
 * was an identity swap.
 *
 * ── The defect, in four steps ──────────────────────────────────────────────
 * Each half was defensible alone, which is why neither suite caught it:
 *
 *  1. A supervisor invites `agent@work.com`. `POST /users/invite` writes a stub
 *     `users` row for that address and mails a token.
 *  2. The agent claims with `agent@gmail.com`. That is ALLOWED and deliberately
 *     so — the token was delivered to the invited inbox, so possession of it is
 *     the authority, and refusing an agent whose only Google account is personal
 *     would recreate the defect the whole feature exists to remove.
 *  3. The bind wrote `firebase_uid` and nothing else, so the row afterwards
 *     named the CLAIMANT's identity while still keying under the INVITED
 *     address.
 *  4. `POST /auth/session` path 2 looks a user up BY `users.email` and adopts
 *     what it finds with no `onlyUnclaimedStub`. (It now also requires
 *     `email_verified === true` — that closes the unverified-token race, not
 *     this one.) So anyone presenting a *verified* Firebase token for
 *     `agent@work.com` — an address nobody has had to prove control of since
 *     the mail was sent — took the claimed membership over, and the agent who
 *     claimed it was locked out.
 *
 * `AdoptIdentityOptions.adoptEmail` closes it by making the row key under the
 * identity that actually bound it. These cases exist because the failure is a
 * COMPOSITION: `firebase-identity.test.ts` pins the statement, the repository
 * suite pins the transaction, and neither can see that the row the first one
 * leaves behind is what the second one finds.
 *
 * ── About the fake database ────────────────────────────────────────────────
 * `usersTable` below EVALUATES the bind predicate, because a composition needs a
 * row that survives from one route to the next and no mocked `query` can run
 * SQL. It is therefore a second expression of rules whose first expression is
 * the statement itself — deliberately, and safely, only because the statement's
 * text is pinned independently in `test/unit/auth/firebase-identity.test.ts`:
 * change the predicate and that suite reds even if this fake is updated to
 * agree with it.
 */

const INVITED_EMAIL = 'agent@work.com';
const CLAIMANT_EMAIL = 'agent@gmail.test';
const STUB_USER = '44444444-4444-4444-8444-444444444444';
const INVITE_ID = '66666666-6666-4666-8666-666666666666';
const TENANT = '11111111-1111-4111-8111-111111111111';
const OTHER_TENANT = '99999999-9999-4999-8999-999999999999';

/** Raised by the fake pool when a statement only path 4 runs is reached. */
const PROVISIONED = 'PATH 4 REACHED: a new tenant was about to be provisioned';

interface UserRow {
  id: string;
  firebase_uid: string;
  email: string;
  phone_number: string;
  display_name: string | null;
  avatar_url: string | null;
  status: 'active';
  /** An identity bound here without proving this address. */
  email_unverified: boolean;
  created_at: Date;
  updated_at: Date;
}

const usersTable = new Map<string, UserRow>();

/**
 * The memberships hanging off the stub, because the bind now reads them.
 *
 * A stub is a SHARED object — `POST /users/invite` reuses a `users` row whenever
 * the address is already known — so the bind refuses to activate one carrying
 * active memberships outside the invite's tenant
 * (`AdoptIdentityOptions.confineStubToTenantId`). Defaults to the invitation's
 * own membership and nothing else, which is every case in this file bar the one
 * that pushes a foreign row in deliberately.
 */
const membershipsTable: { user_id: string; tenant_id: string; status: string }[] = [];

function hasForeignActiveMembership(userId: string, tenantId: string): boolean {
  return membershipsTable.some(
    (m) => m.user_id === userId && m.status === 'active' && m.tenant_id !== tenantId,
  );
}

/**
 * The statements this composition actually runs, and nothing else.
 *
 * An unrecognised statement throws rather than answering an empty result: a
 * silent `{ rows: [] }` for a statement the fake does not model would make a
 * case pass for the wrong reason, which is the failure mode a fake database has
 * that a real one does not.
 */
async function fakeQuery(sql: string, params: unknown[] = []): Promise<{ rows: unknown[]; rowCount: number }> {
  const text = String(sql).trim();

  if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(text)) return { rows: [], rowCount: 0 };

  // `markClaimed` — the invite is spent. Its own predicates are pinned in the
  // repository suite; here the claim always wins so the BIND is what is under
  // test.
  if (text.startsWith('UPDATE membership_invites')) return { rows: [], rowCount: 1 };

  /**
   * The row lock the claim takes before the bind decides anything. Modelled as
   * a plain existence read: this fake is single-threaded, so there is no
   * contention to simulate — what matters here is that the statement is ISSUED
   * (a missing case would fall through to the unknown-statement throw below and
   * take every case in this file with it). What the lock actually BUYS is
   * ordering against a concurrent invite, which only a real Postgres can show,
   * and `test/integration/repositories/invite-claim-membership-race.test.ts`
   * is where that is pinned.
   */
  if (/^SELECT id FROM users WHERE id = \$1 FOR UPDATE$/.test(text)) {
    const row = usersTable.get(params[0] as string);
    return { rows: row ? [{ id: row.id }] : [], rowCount: row ? 1 : 0 };
  }

  if (text.startsWith('UPDATE users')) {
    const [
      uid, name, picture, userId, phone, onlyUnclaimedStub, prefix, email, confineTenant,
      emailUnverified,
    ] = params as [
      string, string | null, string | null, string, string | null, boolean, string,
      string | null, string | null, boolean | null,
    ];
    const row = usersTable.get(userId);
    if (!row) return { rows: [], rowCount: 0 };
    // The predicates, as the statement declares them. First: refuse a row
    // already bound to a DIFFERENT real identity.
    if (onlyUnclaimedStub === true && !row.firebase_uid.startsWith(prefix) && row.firebase_uid !== uid) {
      return { rows: [], rowCount: 0 };
    }
    // Second, and independent of it: refuse to ACTIVATE a stub that another
    // workspace is also waiting on. A row that is already this identity is
    // exempt — nothing changes hands.
    if (
      confineTenant !== null
      && row.firebase_uid !== uid
      && hasForeignActiveMembership(userId, confineTenant)
    ) {
      return { rows: [], rowCount: 0 };
    }
    row.firebase_uid = uid;
    row.display_name = row.display_name ?? name;
    row.avatar_url = row.avatar_url ?? picture;
    if (row.phone_number === '0000000000' && phone) row.phone_number = phone;
    if (email !== null) row.email = email;
    // COALESCE: `null` leaves the flag, which is what an adoption that neither
    // proves nor claims an address means.
    if (emailUnverified !== null) row.email_unverified = emailUnverified;
    row.updated_at = new Date();
    return { rows: [{ ...row }], rowCount: 1 };
  }

  // The classifying re-read on the 0-row bind path: which of the three refusals
  // this was. One statement, because "is it still a stub" and "does another
  // workspace hold it too" read against each other.
  if (text.startsWith('SELECT u.firebase_uid')) {
    const row = usersTable.get(String(params[0]));
    if (!row) return { rows: [], rowCount: 0 };
    return {
      rows: [{
        firebase_uid: row.firebase_uid,
        has_foreign_membership: hasForeignActiveMembership(row.id, String(params[1])),
      }],
      rowCount: 1,
    };
  }

  // Only `POST /auth/session` path 4 inserts a user. Reaching it is a real
  // outcome this suite asserts on, not an accident — see the case below.
  if (text.startsWith('INSERT INTO users')) throw new Error(PROVISIONED);

  throw new Error(`fake db: unmodelled statement: ${text.slice(0, 60)}`);
}

const mocks = vi.hoisted(() => ({
  verifyIdToken: vi.fn(),
  buildSessionPayload: vi.fn(),
  // `resolveSettingsSafe` resolves the account settings map.
  resolveSettingsSafe: vi.fn(),
  invalidateUserCache: vi.fn(),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('@magick-agency/db', () => ({
  getPool: () => ({
    query: (sql: string, params?: unknown[]) => fakeQuery(sql, params),
    connect: async () => ({
      query: (sql: string, params?: unknown[]) => fakeQuery(sql, params),
      release: vi.fn(),
    }),
  }),
}));
vi.mock('../../../src/auth/firebase.js', () => ({ verifyIdToken: mocks.verifyIdToken }));
/**
 * `user.repository` answers over the same table, because the composition IS the
 * lookup: path 2 finds a row by `users.email`, and what this suite is about is
 * which address that column holds after a mismatched claim.
 */
vi.mock('@magick-agency/db/repositories/user.repository', () => ({
  userRepository: {
    findByFirebaseUid: async (uid: string) =>
      [...usersTable.values()].find((row) => row.firebase_uid === uid) ?? null,
    /**
     * Ordered as the real statement is: a flagged row and a clean one can share
     * an address (an honest invite writes a fresh stub beside a poisoned row),
     * and the caller here has PROVEN the address, so it wants the clean one.
     */
    findByEmail: async (email: string) =>
      [...usersTable.values()]
        .filter((row) => row.email === email)
        .sort((a, b) => Number(a.email_unverified) - Number(b.email_unverified))[0] ?? null,
    findById: async (id: string) => usersTable.get(id) ?? null,
    update: vi.fn(),
  },
}));
vi.mock('../../../src/auth/session.middleware.js', () => ({
  sessionMiddleware: vi.fn(),
  invalidateUserCache: mocks.invalidateUserCache,
}));
vi.mock('../../../src/auth/session-payload.js', () => ({
  buildSessionPayload: mocks.buildSessionPayload,
  resolveSettingsSafe: mocks.resolveSettingsSafe,
}));
vi.mock('@magick-agency/observability', () => ({ createChildLogger: () => mocks.log }));

const { authRoutes } = await import('../../../src/api/routes/auth.routes.js');
const { membershipInviteRepository } = await import(
  '../../../src/db/repositories/membership-invite.repository.js'
);

async function sessionApp() {
  const app = Fastify({ logger: false });
  await app.register(authRoutes, { prefix: '/auth' });
  await app.ready();
  return app;
}

/** The claim, exactly as `POST /invites/:token/claim` performs it. */
function claimWith(identity: {
  uid: string;
  email?: string;
  name?: string;
  email_verified?: boolean;
}) {
  return membershipInviteRepository.claimWithIdentity({
    inviteId: INVITE_ID,
    userId: STUB_USER,
    tenantId: TENANT,
    identity,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  usersTable.clear();
  membershipsTable.length = 0;
  membershipsTable.push({ user_id: STUB_USER, tenant_id: TENANT, status: 'active' });
  usersTable.set(STUB_USER, {
    id: STUB_USER,
    firebase_uid: `pending_${STUB_USER}`,
    email: INVITED_EMAIL,
    phone_number: '0000000000',
    display_name: null,
    avatar_url: null,
    status: 'active',
    email_unverified: false,
    created_at: new Date(),
    updated_at: new Date(),
  });
  mocks.buildSessionPayload.mockImplementation(async (user: UserRow) => ({
    user, tenants: [], memberships: [], settings: {}, is_new: false,
  }));
});

describe('a mismatched claim, then /auth/session with the INVITED address', () => {
  it('leaves the row keyed under the address that actually bound it', async () => {
    // Step 3 of the defect, and the single write that removes it.
    const claimed = await claimWith({ uid: 'fb-claimant', email: CLAIMANT_EMAIL, email_verified: true });

    expect(claimed).toMatchObject({ ok: true });
    expect(usersTable.get(STUB_USER)).toMatchObject({
      firebase_uid: 'fb-claimant',
      email: CLAIMANT_EMAIL,
    });
  });

  /*
   * The lookup falls through to path 4, which REFUSES with 403 `no_membership` and
   * writes nothing, so the case asserts that refusal. The fake throws on
   * `INSERT INTO users`, so a path 4 that wrote a user would answer 500 and red the
   * 403 assertion.
   */
  it('does NOT let a token for the invited address take the membership over', async () => {
    /**
     * The whole point. Before `adoptEmail`, path 2 found this row by
     * `agent@work.com` and adopted the presenting uid unconditionally — the
     * claimant was locked out of a membership they had already claimed, with
     * nothing logged and nothing failing.
     *
     * Now the lookup finds nothing and the request falls through to path 4,
     * which is CORRECT: whoever holds `agent@work.com` is a different principal
     * from the one that claimed the invitation, and a fresh tenant of their own
     * is exactly what path 4 is for. This suite stops at that door rather than
     * modelling the whole provisioning transaction — the fake raises
     * {@link PROVISIONED} on the statement only path 4 runs — because what is
     * being asserted is which path was taken and what happened to the row.
     */
    await claimWith({ uid: 'fb-claimant', email: CLAIMANT_EMAIL, email_verified: true });
    mocks.verifyIdToken.mockResolvedValue({ uid: 'fb-somebody-else', email: INVITED_EMAIL, email_verified: true });
    const app = await sessionApp();

    const res = await app.inject({
      method: 'POST', url: '/auth/session', payload: { id_token: 'token-for-work-address' },
    });

    // Path 4, named explicitly by its refusal code rather than inferred from the
    // status alone.
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('no_membership');
    // The binding SURVIVES. This is the assertion the defect broke.
    expect(usersTable.get(STUB_USER)).toMatchObject({
      firebase_uid: 'fb-claimant',
      email: CLAIMANT_EMAIL,
    });
    await app.close();
  });

  it('refuses an unverified token for the invited address rather than adopting or provisioning', async () => {
    /**
     * Distinct from the adoptEmail swap above. Firebase email/password issues
     * a token before the inbox is proven; path 2 used to bind on that string
     * and activate the stub. After a mismatched claim the row is no longer
     * keyed under the invited address, so this 403 is the unverified-token
     * refusal itself: it must not reach path 2 OR path 4.
     */
    await claimWith({ uid: 'fb-claimant', email: CLAIMANT_EMAIL, email_verified: true });
    mocks.verifyIdToken.mockResolvedValue({
      uid: 'fb-unverified', email: INVITED_EMAIL, email_verified: false,
    });
    const app = await sessionApp();

    const res = await app.inject({
      method: 'POST', url: '/auth/session', payload: { id_token: 'unverified-token' },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('email_unverified');
    expect(usersTable.get(STUB_USER)).toMatchObject({
      firebase_uid: 'fb-claimant',
      email: CLAIMANT_EMAIL,
    });
    await app.close();
  });

  it('signs the CLAIMANT in through path 1, on their own uid', async () => {
    // The other half of "the binding survives": the identity that claimed is the
    // one that now resolves, without touching the adopt path at all.
    await claimWith({ uid: 'fb-claimant', email: CLAIMANT_EMAIL, email_verified: true });
    mocks.verifyIdToken.mockResolvedValue({ uid: 'fb-claimant', email: CLAIMANT_EMAIL, email_verified: true });
    const app = await sessionApp();

    const res = await app.inject({
      method: 'POST', url: '/auth/session', payload: { id_token: 'token-for-claimant' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().user).toMatchObject({ id: STUB_USER, firebase_uid: 'fb-claimant' });
    await app.close();
  });

  it('still adopts the stub through path 2 when the addresses AGREE', async () => {
    /**
     * The behaviour that must not be lost while closing the swap: an invitee who
     * signs in with the invited address, having never clicked the link, is still
     * adopted onto their stub by path 2. `adoptEmail` writes the same address
     * that was already there, so nothing about this case changes — which is why
     * it is asserted rather than assumed.
     */
    mocks.verifyIdToken.mockResolvedValue({ uid: 'fb-same', email: INVITED_EMAIL, email_verified: true });
    const app = await sessionApp();

    const res = await app.inject({
      method: 'POST', url: '/auth/session', payload: { id_token: 'token-for-work-address' },
    });

    expect(res.statusCode).toBe(200);
    expect(usersTable.get(STUB_USER)).toMatchObject({
      firebase_uid: 'fb-same',
      email: INVITED_EMAIL,
    });
    await app.close();
  });
});

describe('an invitee who ALREADY has a login here', () => {
  it('claims their own invitation instead of being refused', async () => {
    /**
     * The ordinary "add an agent who already works with us" invite, composed:
     * `POST /users/invite` reuses the existing `users` row for a known address,
     * so the row the claim binds is not a stub. Under the stub-only predicate
     * this rolled back and answered `409 identity_already_bound` — the sentence
     * written for an account-takeover attempt — to the person the invitation was
     * for.
     */
    usersTable.set(STUB_USER, {
      ...usersTable.get(STUB_USER)!,
      firebase_uid: 'fb-existing',
      email: INVITED_EMAIL,
      display_name: 'Established Person',
    });

    const claimed = await claimWith({ uid: 'fb-existing', email: INVITED_EMAIL });

    expect(claimed).toMatchObject({ ok: true });
    expect(usersTable.get(STUB_USER)).toMatchObject({
      firebase_uid: 'fb-existing',
      // Untouched by an idempotent bind — a display name somebody set in this
      // product is never overwritten by a Google profile.
      display_name: 'Established Person',
    });
  });

  it('still refuses a DIFFERENT identity against that same row', async () => {
    // The takeover case, unchanged and unwidened: invite an address you do not
    // control, read the join link out of the 201, claim it with a throwaway
    // account. The invitation is left outstanding so a real invitee is not
    // denied theirs.
    usersTable.set(STUB_USER, { ...usersTable.get(STUB_USER)!, firebase_uid: 'fb-victim' });

    const claimed = await claimWith({ uid: 'fb-attacker', email: 'attacker@evil.test' });

    expect(claimed).toEqual({ ok: false, reason: 'identity_already_bound' });
    expect(usersTable.get(STUB_USER)).toMatchObject({
      firebase_uid: 'fb-victim',
      email: INVITED_EMAIL,
    });
  });
});

describe('a stub SEVERAL workspaces are waiting on', () => {
  /**
   * The second composition, and the reason `onlyUnclaimedStub` was not enough.
   *
   * `POST /users/invite` REUSES a `users` row whenever the address is already
   * known, so the stub a super admin wrote for tenant A's owner is the same row
   * an attacker's `agent` invite in tenant B points at — and an `agent` invite
   * hands the INVITER the raw join link. The stub test passes honestly (nobody
   * has signed in as the row), so the bind went through and
   * `buildSessionPayload` listed every active membership on it, tenant A's
   * ownership included.
   *
   * Composed rather than left to the repository suite for the same reason the
   * `adoptEmail` cases above are: what makes the refusal correct is what happens
   * to the row AFTERWARDS. The victim must still be able to sign in and activate
   * their own stub, through the path that proves the ADDRESS rather than a
   * token.
   */
  beforeEach(() => {
    // The victim's workspace, provisioned by a super admin and unclaimed.
    membershipsTable.push({ user_id: STUB_USER, tenant_id: OTHER_TENANT, status: 'active' });
  });

  it('refuses the attacker and leaves the stub exactly as it was', async () => {
    const claimed = await claimWith({ uid: 'fb-attacker', email: 'attacker@evil.test' });

    expect(claimed).toEqual({ ok: false, reason: 'cross_tenant_identity' });
    expect(usersTable.get(STUB_USER)).toMatchObject({
      firebase_uid: `pending_${STUB_USER}`,
      email: INVITED_EMAIL,
    });
  });

  it('still lets the VICTIM activate it by proving the address', async () => {
    /**
     * The refusal must not strand the person the row is for. `/auth/session`
     * path 2 requires a VERIFIED Firebase email (`sessionLinkEmail`), which is
     * proof of the inbox rather than of one invitation, and is therefore
     * entitled to activate a stub every workspace is waiting on — which is also
     * the honest remedy the 409's message points at.
     */
    await claimWith({ uid: 'fb-attacker', email: 'attacker@evil.test' });
    mocks.verifyIdToken.mockResolvedValue({
      uid: 'fb-victim', email: INVITED_EMAIL, email_verified: true,
    });
    const app = await sessionApp();

    const res = await app.inject({
      method: 'POST', url: '/auth/session', payload: { id_token: 'victim-token' },
    });

    expect(res.statusCode).toBe(200);
    // Path 2 adopted the stub — no fresh tenant was provisioned for them.
    expect(usersTable.get(STUB_USER)).toMatchObject({
      firebase_uid: 'fb-victim',
      email: INVITED_EMAIL,
    });
    await app.close();
  });
});

describe('a claim that proves NO address', () => {
  /**
   * The third composition, and the one the `adoptEmail` pair could not reach.
   *
   * The claim accepts an unverified Firebase email deliberately — the token was
   * mailed to the invited inbox, so possession of it is meant to prove the same
   * thing verification would. That reasoning holds only while the INVITER is
   * honest, and `POST /users/invite` returns the raw join link in its own 201
   * body: an attacker registers an unverified email/password account for
   * `victim@corp.test` (Firebase mints a token for any address), invites that
   * address into their OWN tenant as an `agent`, and claims their own link.
   *
   * Adopting that address would then key a signed-in row under an address
   * nobody controls — and `users.email` is the lookup for `POST /users/invite`
   * and both super-admin provisioning paths, so the next person to name it
   * hands over the membership. The refusal to
   * reuse is pinned against real rows in
   * `test/integration/repositories/user-email-proof.test.ts`. What this file
   * adds is the half only a composition can see: what `/auth/session` does with
   * the row afterwards.
   */
  it('adopts nothing and marks the row, rather than keying it under an unproven address', async () => {
    const claimed = await claimWith({ uid: 'fb-claimant', email: CLAIMANT_EMAIL });

    expect(claimed).toMatchObject({ ok: true });
    expect(usersTable.get(STUB_USER)).toMatchObject({
      firebase_uid: 'fb-claimant',
      // The INVITED address stays — it is what the audit row records, and
      // writing the claimant's unproven one would plant a second.
      email: INVITED_EMAIL,
      email_unverified: true,
    });
  });

  it('lets whoever PROVES the invited address take the row, and clears the mark', async () => {
    /**
     * The mirror of the verified case above, and deliberately the opposite
     * outcome. There the claimant had proven their own address, so the row moved
     * to it and a later token for the invited address fell through to path 4.
     * Here the claimant proved nothing, so the person who does prove the invited
     * address is the stronger claim to it — path 2 adopts, and the mark goes
     * with the adoption, which is the repair that keeps a flagged row from being
     * permanently unreusable.
     */
    await claimWith({ uid: 'fb-claimant', email: CLAIMANT_EMAIL });
    mocks.verifyIdToken.mockResolvedValue({
      uid: 'fb-proves-it', email: INVITED_EMAIL, email_verified: true,
    });
    const app = await sessionApp();

    const res = await app.inject({
      method: 'POST', url: '/auth/session', payload: { id_token: 'verified-token' },
    });

    expect(res.statusCode).toBe(200);
    expect(usersTable.get(STUB_USER)).toMatchObject({
      firebase_uid: 'fb-proves-it',
      email_unverified: false,
    });
    await app.close();
  });
});
