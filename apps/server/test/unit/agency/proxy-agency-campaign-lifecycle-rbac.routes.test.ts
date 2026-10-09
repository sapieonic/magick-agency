import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type { MembershipRole } from '@magick-agency/contracts/rbac';

/**
 * **`/proxy/agency/campaigns/:id/{start,pause,resume,stop}` and `/stats` —
 * the RBAC floor, asserted by execution.**
 *
 * ── Why this file exists, separate from `proxy-agency-campaigns.routes.test.ts` ──
 * That file stubs `requirePermission` to a no-op for every one of its cases and
 * instead asserts the permission STRING each route carries by reading the
 * source text. That leaves a gap open: nothing in the suite ever
 * asks "does an operator actually get a 403 here" — a `requirePermission(...)`
 * call can be deleted from a handler entirely and, so long as the source-text
 * table is edited to match, every test in that file stays green. That file's own
 * header comment makes the same point about a *different* guard being deleted
 * without a single red test.
 *
 * So this file does the opposite: it does NOT mock `src/rbac/rbac.middleware.js`
 * or `src/config/index.js`. `requirePermission` here is the real factory over
 * the real `PERMISSION_MATRIX` (`src/rbac/roles.ts`), and the role is carried on
 * `request.membership.role` per request. That is the same shape used by
 * `test/unit/dnc/dnc.routes.test.ts`, for the same reason: the property that
 * matters is true at the point of CONSUMPTION (this route, with this role), not
 * only in the matrix.
 *
 * ── What this pins ────────────────────────────────────────────────────────────
 * The four lifecycle routes floor at `agency.supervise` (floor `account_admin`),
 * not at an `operator`-level permission — an `operator` must not be able to stop a
 * live campaign, which is exactly what `agency.supervise` exists to prevent.
 * `GET /campaigns/:id/stats` deliberately keeps its `proxy.contact_lists.read`
 * (floor `viewer`) permission — a supervisor dashboard a viewer can read is the
 * intent, only the controls rise — and a test below pins that boundary so a
 * later "tidy up and make all five routes match" change reds instead of
 * shipping silently.
 */

const mocks = vi.hoisted(() => ({
  proxyToCore: vi.fn(),
  auditLog: vi.fn(),
}));

vi.mock('../../../src/api/core-dispatch.js', () => ({ callCore: mocks.proxyToCore }));
vi.mock('../../../src/audit/platform/audit-logger.js', () => ({ platformAuditLogger: { log: mocks.auditLog } }));
vi.mock('@magick-agency/observability', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@magick-agency/observability')>()),
  createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../../../src/auth/session.middleware.js', () => ({ sessionMiddleware: async () => {} }));
vi.mock('../../../src/api/middleware/tenant-context.middleware.js', () => ({
  tenantContextMiddleware: async () => {},
}));
// Deliberately NOT mocked: `src/rbac/rbac.middleware.js`, `src/config/index.js`.
// See the file header for why.

import { proxyAgencyCampaignsRoutes } from '../../../src/api/routes/proxy-agency-campaigns.routes.js';

const PREFIX = '/proxy/agency';
const TENANT = 'tenant-1';
const ACCOUNT = 'account-1';
const USER = 'user-1';

async function buildApp(role: MembershipRole): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.addHook('onRequest', async (request) => {
    // Double cast: matches `dnc.routes.test.ts` / `proxy-agency-route-table.test.ts`
    // — `lint:test` rejects a single-cast `FastifyRequest as Record<string, unknown>`.
    const r = request as unknown as Record<string, unknown>;
    r['tenantId'] = TENANT;
    r['accountId'] = ACCOUNT;
    r['user'] = { id: USER };
    r['membership'] = { role };
  });
  await app.register(proxyAgencyCampaignsRoutes, { prefix: PREFIX });
  await app.ready();
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.proxyToCore.mockResolvedValue({
    status: 200,
    body: { id: 'c1', status: 'running' },
    headers: new Headers(),
  });
});

describe('campaign lifecycle controls floor at agency.supervise (account_admin)', () => {
  it.each(['start', 'pause', 'resume', 'stop'])(
    'an OPERATOR gets 403 on %s and the proxy is never called',
    async (action) => {
      const app = await buildApp('operator');

      const res = await app.inject({ method: 'POST', url: `${PREFIX}/campaigns/c1/${action}` });

      expect(res.statusCode).toBe(403);
      expect(mocks.proxyToCore).not.toHaveBeenCalled();
      // No audit row either — nothing happened for there to be a trail of.
      expect(mocks.auditLog).not.toHaveBeenCalled();
      await app.close();
    },
  );

  it.each(['start', 'pause', 'resume', 'stop'])(
    'an ACCOUNT_ADMIN gets through on %s and the proxy is called',
    async (action) => {
      const app = await buildApp('account_admin');

      const res = await app.inject({ method: 'POST', url: `${PREFIX}/campaigns/c1/${action}` });

      expect(res.statusCode).toBe(200);
      expect(mocks.proxyToCore).toHaveBeenCalledTimes(1);
      expect(mocks.proxyToCore.mock.calls[0]![0].path).toBe(`/agency-campaigns/c1/${action}`);
      await app.close();
    },
  );
});

describe('the stats boundary must NOT move — GET /campaigns/:id/stats stays viewer-readable', () => {
  it('a VIEWER can still read stats', async () => {
    const app = await buildApp('viewer');

    const res = await app.inject({ method: 'GET', url: `${PREFIX}/campaigns/c1/stats` });

    expect(res.statusCode).toBe(200);
    expect(mocks.proxyToCore).toHaveBeenCalledTimes(1);
    expect(mocks.proxyToCore.mock.calls[0]![0].path).toBe('/agency-campaigns/c1/stats');
    await app.close();
  });

  it('an OPERATOR can also read stats — only the controls rose, not the dashboard', async () => {
    const app = await buildApp('operator');

    const res = await app.inject({ method: 'GET', url: `${PREFIX}/campaigns/c1/stats` });

    expect(res.statusCode).toBe(200);
    expect(mocks.proxyToCore).toHaveBeenCalledTimes(1);
    await app.close();
  });
});
