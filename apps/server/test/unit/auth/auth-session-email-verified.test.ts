/*
 * PORT NOTE (magick-agency): ported from master test/unit/auth/auth-session-email-verified.test.ts@a1f0756a
 * (6 cases → 6). One case modified: the phone-token case reaches path 4, which
 * now refuses 403 `no_membership` instead of provisioning.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { EMAIL_UNVERIFIED_CODE } from '../../../src/auth/session-email.js';

/**
 * The unverified-email takeover on `POST /auth/session`.
 *
 * Path 1 (UID hit) is identity and stays open for an unverified token. Every
 * other arm treats the token's email as a claim about an inbox. Firebase
 * email/password issues that token before the inbox is proven, and both
 * super-admin tenant create and `POST /users/invite` write `pending_*` stubs
 * keyed on `users.email`. Binding — or falling through to path 4 and planting
 * the address on a new row — is the attack. These cases pin the refusal
 * without Docker: the integration suite covers the verified happy paths.
 */

const mocks = vi.hoisted(() => ({
  verifyIdToken: vi.fn(),
  findByFirebaseUid: vi.fn(),
  findByEmail: vi.fn(),
  adoptFirebaseIdentity: vi.fn(),
  buildSessionPayload: vi.fn(),
  connect: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../../src/auth/firebase.js', () => ({ verifyIdToken: mocks.verifyIdToken }));
vi.mock('@magick-agency/db/repositories/user.repository', () => ({
  userRepository: {
    findByFirebaseUid: mocks.findByFirebaseUid,
    findByEmail: mocks.findByEmail,
    update: vi.fn(),
  },
}));
// Partial: only `adoptFirebaseIdentity` is stubbed. The module also exports
// `PENDING_UID_PREFIX`, which the route reads for its `wasPending` log field —
// and under a factory mock a missing export THROWS on access rather than
// resolving `undefined`, so a whole-module replacement turns this route into a
// 500. The real constant is exactly what this test wants anyway: the point of
// exporting it is that the writer and every reader agree.
vi.mock('../../../src/auth/firebase-identity.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/auth/firebase-identity.js')>()),
  adoptFirebaseIdentity: mocks.adoptFirebaseIdentity,
}));
vi.mock('../../../src/auth/session-payload.js', () => ({
  buildSessionPayload: mocks.buildSessionPayload,
  resolveSettingsSafe: vi.fn(),
}));
vi.mock('@magick-agency/db', () => ({
  getPool: () => ({ query: vi.fn(), connect: mocks.connect }),
}));
vi.mock('@magick-agency/db/repositories/tenant.repository', () => ({
  tenantRepository: { listByUserId: vi.fn() },
}));
vi.mock('@magick-agency/db/repositories/membership.repository', () => ({
  membershipRepository: { findAllByUserId: vi.fn() },
}));
// PORT NOTE (magick-agency): master's `proxy/core-client`, `utils/crypto`,
// `config/index` and `signupPhoneAssignmentsTotal` metric mocks are removed —
// the route imported them only for path 4's provisioning, which now refuses.
vi.mock('@magick-agency/observability', () => ({ createChildLogger: () => mocks.logger }));
vi.mock('../../../src/auth/session.middleware.js', () => ({
  sessionMiddleware: vi.fn(),
  invalidateUserCache: vi.fn(),
}));

const { authRoutes } = await import('../../../src/api/routes/auth.routes.js');

const STUB = {
  id: 'user-stub',
  firebase_uid: 'pending_abc',
  email: 'owner@customer.com',
  phone_number: '0000000000',
};

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(authRoutes, { prefix: '/auth' });
  await app.ready();
  return app;
}

describe('POST /auth/session — unverified Firebase email', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findByFirebaseUid.mockResolvedValue(null);
    mocks.findByEmail.mockResolvedValue(STUB);
    mocks.adoptFirebaseIdentity.mockResolvedValue({ ...STUB, firebase_uid: 'fb-attacker' });
    mocks.buildSessionPayload.mockImplementation(async (user: unknown) => ({
      user, tenants: [], memberships: [], settings: {}, is_new: false,
    }));
    mocks.connect.mockRejectedValue(new Error('PATH 4 MUST NOT RUN'));
  });

  it('403s an unverified email/password token rather than activating a pending stub', async () => {
    mocks.verifyIdToken.mockResolvedValue({
      uid: 'fb-attacker',
      email: 'owner@customer.com',
      email_verified: false,
    });

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/auth/session',
      payload: { id_token: 'unverified-token' },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({
      error: 'Forbidden',
      code: EMAIL_UNVERIFIED_CODE,
    });
    expect(mocks.findByEmail).not.toHaveBeenCalled();
    expect(mocks.adoptFirebaseIdentity).not.toHaveBeenCalled();
    expect(mocks.connect).not.toHaveBeenCalled();
    await app.close();
  });

  it('403s when email_verified is missing — fail closed, not "treat as Google"', async () => {
    mocks.verifyIdToken.mockResolvedValue({
      uid: 'fb-attacker',
      email: 'owner@customer.com',
    });

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/auth/session',
      payload: { id_token: 'token' },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe(EMAIL_UNVERIFIED_CODE);
    expect(mocks.findByEmail).not.toHaveBeenCalled();
    expect(mocks.connect).not.toHaveBeenCalled();
    await app.close();
  });

  it('403s even when no stub exists — must not plant the unverified address on path 4', async () => {
    mocks.findByEmail.mockResolvedValue(null);
    mocks.verifyIdToken.mockResolvedValue({
      uid: 'fb-new',
      email: 'new@example.com',
      email_verified: false,
    });

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/auth/session',
      payload: { id_token: 'unverified-token' },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe(EMAIL_UNVERIFIED_CODE);
    expect(mocks.connect).not.toHaveBeenCalled();
    await app.close();
  });

  it('still signs an already-linked user in by UID when the email is unverified', async () => {
    mocks.findByFirebaseUid.mockResolvedValue({
      id: 'user-1',
      firebase_uid: 'fb-existing',
      email: 'existing@example.com',
      phone_number: '+15551230000',
    });
    mocks.verifyIdToken.mockResolvedValue({
      uid: 'fb-existing',
      email: 'existing@example.com',
      email_verified: false,
    });

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/auth/session',
      payload: { id_token: 'token' },
    });

    expect(res.statusCode).toBe(200);
    expect(mocks.findByEmail).not.toHaveBeenCalled();
    expect(mocks.adoptFirebaseIdentity).not.toHaveBeenCalled();
    await app.close();
  });

  it('activates a pending stub when the email IS verified', async () => {
    mocks.verifyIdToken.mockResolvedValue({
      uid: 'fb-owner',
      email: 'owner@customer.com',
      name: 'Owner',
      email_verified: true,
    });

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/auth/session',
      payload: { id_token: 'verified-token' },
    });

    expect(res.statusCode).toBe(200);
    expect(mocks.findByEmail).toHaveBeenCalledWith('owner@customer.com');
    expect(mocks.adoptFirebaseIdentity).toHaveBeenCalledOnce();
    expect(mocks.connect).not.toHaveBeenCalled();
    await app.close();
  });

  it('does not 403 a phone-auth token that carries no email', async () => {
    mocks.verifyIdToken.mockResolvedValue({ uid: 'fb-phone' });

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/auth/session',
      payload: { id_token: 'phone-token' },
    });

    // Path 4 is reached. An unverified-email token must never get this far; a
    // phone token must.
    // PORT NOTE (magick-agency): master's path 4 provisioned (here: `connect`
    // threw → 500, `connect` called once). Agency's path 4 REFUSES with 403
    // `no_membership` and writes nothing (plan §3.1), so the assertions are the
    // refusal and that no transaction was opened. Still not `email_unverified`.
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('no_membership');
    expect(mocks.findByEmail).not.toHaveBeenCalled();
    expect(mocks.connect).not.toHaveBeenCalled();
    await app.close();
  });
});
