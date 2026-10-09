import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';

/**
 * `POST /users/invite` must never fail on the mail work — including the part of
 * it that reads config.
 *
 * ## The defect
 *
 * `inviteSignInUrl` sat on the line ABOVE the `try` that wraps `sendInviteEmail`,
 * and it reads config too: `(await appConfig()).consoleBaseUrl`, via a lazy
 * `import('../config/index.js')`. So a failure resolving config there escaped as
 * a 500 on a request whose membership had **already been written**. The
 * supervisor is told the invite failed, retries, and gets a 409 from the row the
 * "failed" attempt created — a lie about a durable write, which is worse than the
 * cosmetic 500 it looks like.
 *
 * The route's own docstring claimed the opposite in as many words: that "must
 * never fail the invite" was "made structural here rather than left depending on
 * the callee keeping its word". It was, for one of the two calls.
 *
 * ## Why this needs its own file, and its own assertion
 *
 * It was found through `test/integration/api/user.routes.test.ts`, where both
 * invite-creation cases 500'd — **on `main`** — because config validation failed
 * and called `process.exit(1)`, which vitest turns into a rejection. That suite
 * mocks every module that touches config (`db/connection`, both middlewares,
 * RBAC, `redis-cache`, the logger) and this one still got through, because a lazy
 * `import()` inside a function is invisible to the mock list at the top of a test
 * file.
 *
 * Adding `setupFiles` to `vitest.config.integration.ts` makes that suite green
 * again — and would hide this. A shim that supplies config is not the same fact
 * as a route that survives config being unavailable: production has no shim, and
 * `CONSOLE_BASE_URL` is genuinely optional. So the guarantee is asserted here,
 * directly, by making the call reject.
 *
 * Separate from `user.routes.test.ts` because that file deliberately leaves
 * `invite-mailer` unmocked — its header explains at length that the *shape* of
 * its doubles is the guard — and mocking the mailer there would weaken it.
 */

const mocks = vi.hoisted(() => ({
  membershipRepository: {
    findByUserAndTenant: vi.fn(),
    findAnyByUserAndTenant: vi.fn(),
    create: vi.fn(),
    reactivateWithRole: vi.fn(),
  },
  userRepository: {
    findByProvenEmail: vi.fn(),
    resolveByProvenEmail: vi.fn(),
    create: vi.fn(),
  },
  accountRepository: {
    findByIdInTenant: vi.fn(),
  },
  redisCache: {
    del: vi.fn().mockResolvedValue(undefined),
  },
  inviteSignInUrl: vi.fn(),
  sendInviteEmail: vi.fn(),
}));

vi.mock('../../../../src/auth/session.middleware.js', () => ({
  sessionMiddleware: async () => {},
}));
vi.mock('../../../../src/api/middleware/tenant-context.middleware.js', () => ({
  tenantContextMiddleware: async () => {},
}));
vi.mock('../../../../src/rbac/rbac.middleware.js', () => ({
  requirePermission: () => async () => {},
}));
vi.mock('@magick-agency/db/repositories/membership.repository', () => ({
  membershipRepository: mocks.membershipRepository,
}));
vi.mock('@magick-agency/db/repositories/user.repository', () => ({
  userRepository: mocks.userRepository,
}));
vi.mock('@magick-agency/db/repositories/account.repository', () => ({
  accountRepository: mocks.accountRepository,
}));
vi.mock('../../../../src/cache/redis-cache.js', () => ({
  // Q5: revocation deletes go through `delForRevocation` (retried, reports
  // failure); this double forwards to the `del` mock and reports success, so the assertions on
  // `del` still observe the key.
  redisCache: { ...mocks.redisCache, delForRevocation: async (...k: string[]) => { await mocks.redisCache.del(...k); return true; } },
}));
/**
 * The mailer is mocked, and both of its exports are listed.
 *
 * A partial factory would fail the moment the route reads the export it omits —
 * the known hazard with partial mock factories.
 * `InviteEmailResult` is a type-only import in the route, so it needs nothing here.
 */
vi.mock('../../../../src/notifications/invite-mailer.js', () => ({
  inviteSignInUrl: mocks.inviteSignInUrl,
  sendInviteEmail: mocks.sendInviteEmail,
}));

import Fastify from 'fastify';
import { userRoutes } from '../../../../src/api/routes/user.routes.js';

const TENANT = 'tenant-1';
const MEMBERSHIP = {
  id: 'm-new', user_id: 'u-1', tenant_id: TENANT, account_id: null, role: 'viewer',
};

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.addHook('onRequest', async (request: any) => {
    request.user = { id: 'inviter-1' };
    request.tenantId = TENANT;
    request.membership = { role: 'tenant_admin' };
  });
  await app.register(userRoutes, { prefix: '/users' });
  await app.ready();
  return app;
}

function invite(app: FastifyInstance) {
  return app.inject({
    method: 'POST',
    url: '/users/invite',
    payload: { email: 'new@test.com', role: 'viewer' },
  });
}

describe('POST /invite — the mail work can never fail the invite', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.redisCache.del.mockResolvedValue(undefined);
    mocks.membershipRepository.findByUserAndTenant.mockResolvedValue([]);
    mocks.membershipRepository.findAnyByUserAndTenant.mockResolvedValue([]);
    mocks.membershipRepository.create.mockResolvedValue(MEMBERSHIP);
    mocks.userRepository.resolveByProvenEmail.mockResolvedValue({ status: 'none' });
    mocks.userRepository.create.mockResolvedValue({ id: 'u-1', email: 'new@test.com' });
    mocks.inviteSignInUrl.mockResolvedValue('https://app.test/login');
    mocks.sendInviteEmail.mockResolvedValue({ sent: false, reason: 'not_implemented' });
  });

  it('still answers 201 when resolving the sign-in url REJECTS', async () => {
    // The regression. `inviteSignInUrl` reads config through a lazy import; when
    // that rejected, this request 500'd with the membership already written.
    mocks.inviteSignInUrl.mockRejectedValue(new Error('config unavailable'));

    const res = await invite(await buildApp());

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.membership).toEqual(MEMBERSHIP);
    // Reported as unsent rather than pretended-sent — `failed` is the honest
    // reason: the caller could not get far enough to know anything else.
    expect(body.invite_email).toEqual({ sent: false, reason: 'failed' });
    // `null` is the value the response already documents for "no CONSOLE_BASE_URL",
    // and "could not be resolved" is the same fact from the caller's side.
    expect(body.sign_in_url).toBeNull();
  });

  it('does not skip the membership write when the mail work fails', async () => {
    // The membership is the real outcome — it is what makes the invitee's first
    // Firebase sign-in adopt the stub user. A 500 here was doubly wrong: it
    // reported failure AND the row existed.
    mocks.inviteSignInUrl.mockRejectedValue(new Error('config unavailable'));

    await invite(await buildApp());

    expect(mocks.membershipRepository.create).toHaveBeenCalledTimes(1);
    expect(mocks.userRepository.create).toHaveBeenCalledTimes(1);
  });

  it('never calls the mailer at all when the url could not be resolved', async () => {
    // Both calls are inside one `try`, so a rejection on the first skips the
    // second. That is correct rather than incidental: `sendInviteEmail` is
    // documented to report `not_configured` for a missing `signInUrl`, which
    // would blame an operator setting for a failure that was not one.
    mocks.inviteSignInUrl.mockRejectedValue(new Error('config unavailable'));

    await invite(await buildApp());

    expect(mocks.sendInviteEmail).not.toHaveBeenCalled();
  });

  it('still answers 201 when the mailer itself REJECTS', async () => {
    // The half that was already guarded. Kept because the guard is now shared
    // with the call above, so a refactor that narrows it would break this too.
    mocks.sendInviteEmail.mockRejectedValue(new Error('transport exploded'));

    const res = await invite(await buildApp());

    expect(res.statusCode).toBe(201);
    expect(res.json().invite_email).toEqual({ sent: false, reason: 'failed' });
    // The url resolved before the mailer threw, so it is reported — a failure
    // sending is not a reason to withhold the link the supervisor needs.
    expect(res.json().sign_in_url).toBe('https://app.test/login');
  });

  it('reports the url and the mailer\'s own reason on the ordinary path', async () => {
    // The shipped behaviour today: no transport, so `not_implemented`. Asserted
    // so the failure cases above are not the only thing pinning this shape.
    const res = await invite(await buildApp());

    expect(res.statusCode).toBe(201);
    expect(res.json().invite_email).toEqual({ sent: false, reason: 'not_implemented' });
    expect(res.json().sign_in_url).toBe('https://app.test/login');
  });

  it('reports sign_in_url as null when there is no CONSOLE_BASE_URL, without failing', async () => {
    // `inviteSignInUrl` returns `null` rather than throwing for an unset base
    // url. The KEY is still present, because a sometimes-absent key is
    // indistinguishable from one a client forgot to read.
    mocks.inviteSignInUrl.mockResolvedValue(null);

    const res = await invite(await buildApp());

    expect(res.statusCode).toBe(201);
    expect(res.json()).toHaveProperty('sign_in_url', null);
  });
});
