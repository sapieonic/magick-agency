import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

/*
 * Every successful campaign PATCH that changed anything is audited as ONE
 * `agency_campaign.config_changed` row (IN8), from the change the internal handler sends
 * back on `CONFIG_CHANGE_HEADER` (it holds the row before and after the write). No header
 * (nothing changed) or a refused write files nothing; the `assignment_mode_changed` row is
 * kept beside it. A PATCH stays one internal call.
 *
 * Only the I/O edges are doubles: `callCore`, the flag service and the audit logger.
 */

const TENANT = 'tenant-1';
const ACCOUNT = 'account-1';
const USER = '11111111-2222-4333-8444-555555555555';
const PREFIX = '/proxy/agency';

const mocks = vi.hoisted(() => ({
  proxyToCore: vi.fn(),
  auditLog: vi.fn(),
  flagEnabled: vi.fn(),
  findByTenantAndAccount: vi.fn(),
}));

vi.mock('../../../src/api/core-dispatch.js', async (importOriginal) =>
  (await import('../../helpers/core-dispatch-double.js')).coreDispatchDouble(await importOriginal(), mocks.proxyToCore));
vi.mock('../../../src/audit/platform/audit-logger.js', () => ({ platformAuditLogger: { log: mocks.auditLog } }));
vi.mock('../../../src/feature-flags/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/feature-flags/index.js')>()),
  getFeatureFlagService: () => ({ isEnabled: mocks.flagEnabled }),
}));
vi.mock('@magick-agency/observability', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@magick-agency/observability')>()),
  createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../../../src/auth/session.middleware.js', () => ({ sessionMiddleware: async () => {} }));
vi.mock('../../../src/api/middleware/tenant-context.middleware.js', () => ({
  tenantContextMiddleware: async () => {},
}));
vi.mock('../../../src/rbac/rbac.middleware.js', () => ({ requirePermission: () => async () => {} }));
vi.mock('../../../src/config/index.js', () => ({ config: { agency: { rosterReplaceEnabled: false } } }));
vi.mock('../../../src/storage/s3.js', () => ({ getFileStream: vi.fn(), getFile: vi.fn(), uploadFile: vi.fn() }));
vi.mock('../../../src/agency/agency-ingest-job.repository.js', () => ({
  agencyIngestJobRepository: { create: vi.fn(), findById: vi.fn(), requestCancel: vi.fn() },
}));
vi.mock('../../../src/agency/agency-ingest.service.js', () => ({ agencyIngestService: { run: vi.fn() } }));
// The behavioural-capability gate's settings read: recording and analytics on, so a 403
// here can only be the assignment gate.
vi.mock('@magick-agency/db/repositories/account-settings.repository', () => ({
  accountSettingsRepository: { findByTenantAndAccount: mocks.findByTenantAndAccount },
}));
// The actor's display name on the retry create (best effort, never refuses).
vi.mock('../../../src/api/routes/proxy-agency-campaigns/lifecycle.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/api/routes/proxy-agency-campaigns/lifecycle.js')>()),
  resolveActorDisplayName: async () => null,
}));

import { FLAGS } from '../../../src/feature-flags/index.js';
import { proxyAgencyCampaignsRoutes } from '../../../src/api/routes/proxy-agency-campaigns.routes.js';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.addHook('onRequest', async (request) => {
    const r = request as unknown as Record<string, unknown>;
    r['tenantId'] = TENANT;
    r['accountId'] = ACCOUNT;
    r['user'] = { id: USER };
  });
  await app.register(proxyAgencyCampaignsRoutes, { prefix: PREFIX });
  await app.ready();
  return app;
}


import { CONFIG_CHANGE_HEADER } from '../../../src/api/middleware/headers.js';
import { encodeConfigChange } from '../../../src/agency/campaign-config-audit.js';

function core(opts: {
  get?: { status: number; body: unknown };
  patch: { status: number; body: unknown; headers?: Record<string, string> };
}): void {
  mocks.proxyToCore.mockImplementation(async (req: { method: string }) => {
    if (req.method === 'GET') return { ...(opts.get ?? { status: 200, body: { id: 'c1' } }), headers: new Headers() };
    return { status: opts.patch.status, body: opts.patch.body, headers: new Headers(opts.patch.headers ?? {}) };
  });
}

const CHANGE = {
  fields: ['calling_window_end', 'retry_policy'],
  changes: { calling_window_end: { from: '20:00:00', to: '21:00:00' } },
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.flagEnabled.mockResolvedValue(true);
  mocks.findByTenantAndAccount.mockResolvedValue({ allow_recording: true, analyze_calls: true });
});

const configRows = () => mocks.auditLog.mock.calls
  .map(([row]) => row as { action: string })
  .filter((row) => row.action === 'agency_campaign.config_changed');

describe('PATCH /campaigns/:id — every config change is audited (IN8)', () => {
  it('a change writes one row naming the fields, with the actor, from the handler\'s header', async () => {
    core({ patch: { status: 200, body: { id: 'c1' }, headers: { [CONFIG_CHANGE_HEADER]: encodeConfigChange(CHANGE) } } });
    const app = await buildApp();
    const res = await app.inject({
      method: 'PATCH', url: `${PREFIX}/campaigns/c1`,
      payload: { calling_window_end: '21:00', retry_policy: { no_answer: { max_attempts: 2 } } },
    });
    expect(res.statusCode, res.body).toBe(200);
    // Still one internal call: the change came back with the write.
    expect(mocks.proxyToCore.mock.calls.map(([req]) => req.method)).toEqual(['PATCH']);
    expect(mocks.auditLog).toHaveBeenCalledTimes(1);
    expect(mocks.auditLog).toHaveBeenCalledWith({
      tenant_id: TENANT, account_id: ACCOUNT, actor_type: 'human', user_id: USER,
      action: 'agency_campaign.config_changed',
      resource_type: 'agency_campaign', resource_id: 'c1', campaign_id: 'c1',
      details: { campaign_id: 'c1', ...CHANGE },
    });
    // The private header is the handler's, not the client's.
    expect(res.headers[CONFIG_CHANGE_HEADER]).toBeUndefined();
    await app.close();
  });

  it('nothing changed (no header): no row', async () => {
    core({ patch: { status: 200, body: { id: 'c1' } } });
    const app = await buildApp();
    const res = await app.inject({ method: 'PATCH', url: `${PREFIX}/campaigns/c1`, payload: { name: 'Same' } });
    expect(res.statusCode).toBe(200);
    expect(mocks.auditLog).not.toHaveBeenCalled();
    await app.close();
  });

  it('a refused write files nothing, even with a header', async () => {
    core({ patch: { status: 409, body: { code: 'mode_change_requires_pause' }, headers: { [CONFIG_CHANGE_HEADER]: encodeConfigChange(CHANGE) } } });
    const app = await buildApp();
    const res = await app.inject({ method: 'PATCH', url: `${PREFIX}/campaigns/c1`, payload: { name: 'X' } });
    expect(res.statusCode).toBe(409);
    expect(mocks.auditLog).not.toHaveBeenCalled();
    await app.close();
  });

  it('a malformed header files nothing and the write still answers', async () => {
    core({ patch: { status: 200, body: { id: 'c1' }, headers: { [CONFIG_CHANGE_HEADER]: 'not-json' } } });
    const app = await buildApp();
    const res = await app.inject({ method: 'PATCH', url: `${PREFIX}/campaigns/c1`, payload: { name: 'X' } });
    expect(res.statusCode).toBe(200);
    expect(mocks.auditLog).not.toHaveBeenCalled();
    await app.close();
  });

  it('keeps the assignment_mode_changed row beside the config row', async () => {
    core({
      get: { status: 200, body: { id: 'c1', assignment_mode: 'pool' } },
      patch: {
        status: 200, body: { id: 'c1', assignment_mode: 'strict' },
        headers: { [CONFIG_CHANGE_HEADER]: encodeConfigChange({
          fields: ['assignment_mode'], changes: { assignment_mode: { from: 'pool', to: 'strict' } },
        }) },
      },
    });
    const app = await buildApp();
    const res = await app.inject({ method: 'PATCH', url: `${PREFIX}/campaigns/c1`, payload: { assignment_mode: 'strict' } });
    expect(res.statusCode, res.body).toBe(200);
    expect(mocks.auditLog.mock.calls.map(([row]) => (row as { action: string }).action))
      .toEqual(['agency_campaign.assignment_mode_changed', 'agency_campaign.config_changed']);
    expect(configRows()).toHaveLength(1);
    await app.close();
  });
});
