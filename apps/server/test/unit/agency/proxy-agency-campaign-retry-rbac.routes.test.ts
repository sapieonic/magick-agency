import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type { MembershipRole } from '@magick-agency/contracts/rbac';

/**
 * **The three retry routes' RBAC floors, asserted by execution**
 *
 * ── Why by execution, and why a file of its own ───────────────────────────
 * `proxy-agency-campaigns.routes.test.ts` stubs `requirePermission` to a no-op
 * and asserts the permission STRING each route carries by reading the source.
 * That leaves a gap open: deleting a `requirePermission(...)` call
 * and editing the source-text table to match keeps the whole suite green. So this
 * file mocks neither `src/rbac/rbac.middleware.js` nor `src/config/index.js` —
 * `requirePermission` is the real factory over the real `PERMISSION_MATRIX`, and
 * the property under test is true at the point of CONSUMPTION.
 *
 * ── The create is the only route on this plugin with TWO permissions ───────
 * `proxy.contact_lists.write` because it creates a campaign, `agency.supervise`
 * because it acts on another campaign's call results. Both floor at
 * `account_admin`, so **no ROLE can hold one without the other** and a
 * role-based test cannot see the difference at all. So the two "holds one but not
 * the other" cases below narrow the real `hasPermission` for one permission
 * (`mocks.denied`): the role clears both floors, one permission is withheld, and the
 * route must 403 naming it before any internal handler call. That is the only way
 * to prove that deleting either guard is caught.
 *
 * The control case ("holds BOTH") ends at the route's 201, which proves the two
 * 403s came from the withheld permission.
 */

/*
 * `requirePermission` is the REAL factory over the real matrix
 * (`@magick-agency/contracts/rbac`; floors as documented in the header).
 *
 * The behavioural-settings gate is not under test here (its own suites are
 * `campaign-behavioral-settings.test.ts` and the behavioral-capabilities route suite), so the
 * account's settings row is supplied with both columns ON and can never be the 403.
 */
const mocks = vi.hoisted(() => ({
  proxyToCore: vi.fn(),
  auditLog: vi.fn(),
  resolveAgentNames: vi.fn(),
  denied: new Set<string>(),
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
// The behavioural-settings gate has its own execution-based suite next door; here its
// settings row is supplied with both behaviours ON, so a 403 can only ever mean RBAC fired.
vi.mock('@magick-agency/db/repositories/account-settings.repository', () => ({
  accountSettingsRepository: {
    findByTenantAndAccount: vi.fn().mockResolvedValue({ allow_recording: true, analyze_calls: true }),
  },
}));
// The real matrix, narrowed for one permission when a case says so (see the header).
vi.mock('@magick-agency/contracts/rbac', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@magick-agency/contracts/rbac')>();
  return {
    ...actual,
    hasPermission: (role: Parameters<typeof actual.hasPermission>[0], permission: Parameters<typeof actual.hasPermission>[1]) =>
      !mocks.denied.has(permission) && actual.hasPermission(role, permission),
  };
});
vi.mock('../../../src/agency/agency-agent-identity.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../../src/agency/agency-agent-identity.js')
  >('../../../src/agency/agency-agent-identity.js');
  return { ...actual, resolveAgentNames: mocks.resolveAgentNames };
});
vi.mock('../../../src/storage/s3.js', () => ({
  getFileStream: vi.fn(),
  getFile: vi.fn(),
  uploadFile: vi.fn(),
}));
vi.mock('../../../src/agency/agency-ingest-job.repository.js', () => ({
  agencyIngestJobRepository: { create: vi.fn(), findById: vi.fn(), requestCancel: vi.fn() },
}));
vi.mock('../../../src/agency/agency-ingest.service.js', () => ({
  agencyIngestService: { run: vi.fn() },
}));
// Deliberately NOT mocked: `src/rbac/rbac.middleware.js`, `src/config/index.js`.

import { proxyAgencyCampaignsRoutes } from '../../../src/api/routes/proxy-agency-campaigns.routes.js';

const PREFIX = '/proxy/agency';
const TENANT = 'tenant-1';
const ACCOUNT = 'account-1';
const USER = 'user-1';
const PARENT = 'camp-parent';

async function buildApp(
  role: MembershipRole,
  withheld?: readonly string[],
): Promise<FastifyInstance> {
  // `withheld` (see the header): the permissions the caller's role would clear but which are withheld from it.
  mocks.denied.clear();
  for (const permission of withheld ?? []) mocks.denied.add(permission);
  const app = Fastify({ logger: false });
  app.addHook('onRequest', async (request) => {
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

const RETRY_BODY = { selector: { last_outcome: ['no_answer'] } };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.denied.clear();
  mocks.resolveAgentNames.mockResolvedValue(new Map([[USER, 'Priya S']]));
  mocks.proxyToCore.mockResolvedValue({
    status: 200,
    body: { id: PARENT, tenant_id: TENANT, account_id: ACCOUNT, name: 'Q3 Winback', status: 'completed' },
    headers: new Headers(),
  });
});

describe('the create needs BOTH permissions, and a scoped key is what proves it', () => {
  it('403s a key holding proxy.contact_lists.write but NOT agency.supervise', async () => {
    const app = await buildApp('account_admin', ['agency.supervise']);

    const res = await app.inject({
      method: 'POST',
      url: `${PREFIX}/campaigns/${PARENT}/retry`,
      payload: RETRY_BODY,
    });

    expect(res.statusCode).toBe(403);
    // Naming the permission is what makes the refusal actionable, and it is the
    // supervisory one because the guards are ordered supervise-first: a caller
    // missing it is missing the permission that is about acting on someone
    // else's call results, which is the harder one to guess at.
    expect(res.json().message).toContain('agency.supervise');
    // Nothing reached the internal handler — not even the parent read.
    expect(mocks.proxyToCore).not.toHaveBeenCalled();
    await app.close();
  });

  it('403s a key holding agency.supervise but NOT proxy.contact_lists.write', async () => {
    const app = await buildApp('account_admin', ['agency.campaigns.write']);

    const res = await app.inject({
      method: 'POST',
      url: `${PREFIX}/campaigns/${PARENT}/retry`,
      payload: RETRY_BODY,
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().message).toContain('agency.campaigns.write');
    expect(mocks.proxyToCore).not.toHaveBeenCalled();
    await app.close();
  });

  it('a key holding BOTH clears RBAC — the control for the two cases above', async () => {
    /**
     * Nothing is withheld, and the same request goes all the way through to the
     * internal handler's 201 — the control that proves the two 403s above came from
     * the withheld permission.
     */
    mocks.proxyToCore.mockImplementation(async (req: { method: string }) => ({
      status: req.method === 'POST' ? 201 : 200,
      body: req.method === 'POST'
        ? { campaign: { id: 'camp-child' }, contacts_seeded: 12 }
        : { id: PARENT, tenant_id: TENANT, account_id: ACCOUNT, name: 'Q3 Winback', status: 'completed' },
      headers: new Headers(),
    }));
    const app = await buildApp('account_admin');

    const res = await app.inject({
      method: 'POST',
      url: `${PREFIX}/campaigns/${PARENT}/retry`,
      payload: RETRY_BODY,
    });

    expect(res.statusCode).toBe(201);
    await app.close();
  });
});

describe('the role floors, by execution', () => {
  it.each<[MembershipRole, number]>([
    ['viewer', 403],
    ['operator', 403],
    ['account_admin', 201],
  ])('a %s gets %d on POST /campaigns/:id/retry', async (role, expected) => {
    // Both permissions floor at `account_admin`, so an `operator` running the
    // floor cannot author a retry campaign off someone else's call results —
    // the same boundary the lifecycle routes (start/pause/resume/stop) draw.
    mocks.proxyToCore.mockImplementation(async (req: { method: string }) => ({
      status: req.method === 'POST' ? 201 : 200,
      body: req.method === 'POST'
        ? { campaign: { id: 'camp-child' }, contacts_seeded: 12 }
        : { id: PARENT, tenant_id: TENANT, account_id: ACCOUNT, name: 'Q3 Winback', status: 'completed' },
      headers: new Headers(),
    }));
    const app = await buildApp(role);

    const res = await app.inject({
      method: 'POST',
      url: `${PREFIX}/campaigns/${PARENT}/retry`,
      payload: RETRY_BODY,
    });

    expect(res.statusCode).toBe(expected);
    await app.close();
  });

  it.each<[MembershipRole, number]>([
    ['viewer', 403],
    ['operator', 403],
    ['account_admin', 200],
  ])('a %s gets %d on GET /campaigns/:id/retry/preview', async (role, expected) => {
    // `agency.supervise`, NOT the `proxy.contact_lists.read` (`viewer`) its
    // `GET /campaigns/:id` neighbour carries: the preview breaks a campaign's
    // contacts down by how their calls went, which is the supervisory record.
    const app = await buildApp(role);

    const res = await app.inject({
      method: 'GET',
      url: `${PREFIX}/campaigns/${PARENT}/retry/preview?last_outcome=no_answer`,
    });

    expect(res.statusCode).toBe(expected);
    await app.close();
  });

  it.each<[MembershipRole, number]>([
    ['viewer', 200],
    ['account_admin', 200],
  ])('a %s gets %d on GET /campaigns/:id/lineage', async (role, expected) => {
    /**
     * Lineage stays at `viewer`, and the disagreement with its two siblings is
     * deliberate rather than an oversight: it is navigation — names, statuses,
     * generations, contact totals — every field of which a viewer can already
     * read one campaign at a time through `GET /campaigns/:id`. Flooring it
     * higher would mean a viewer opening a retry campaign and not being told
     * what it was a retry of, which reads as missing data rather than as a
     * permission boundary.
     *
     * Pinned so a later "tidy up and make the three retry routes match" change
     * reds here instead of shipping.
     */
    const app = await buildApp(role);

    const res = await app.inject({ method: 'GET', url: `${PREFIX}/campaigns/${PARENT}/lineage` });

    expect(res.statusCode).toBe(expected);
    await app.close();
  });
});
