import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

/*
 * The public archive and restore routes (decisions AR1–AR7): `POST /proxy/agency/campaigns/:id/archive`
 * and `/unarchive`.
 *
 * Pinned here:
 *  - who archived it is the SESSION's user (AR5), with the name the one lookup resolves; an id or
 *    name the caller puts in the body never reaches the internal handler;
 *  - restore sends no body at all;
 *  - each route writes its own platform audit row (`agency_campaign.archived`,
 *    `agency_campaign.restored`) with the campaign and the status the handler answered, stated
 *    under the session's user, and only on success: a 409 or 404 writes none and is relayed as is;
 *  - with no session user the archive goes out unattributed (no body), not as a placeholder.
 */

const TENANT = '11111111-1111-4111-8111-111111111111';
const ACCOUNT = '33333333-3333-4333-8333-333333333333';
const CAMPAIGN = '44444444-4444-4444-4444-444444444444';
const SUPERVISOR = 'aaaaaaaa-0000-4000-8000-000000000001';
const SOMEONE_ELSE = 'aaaaaaaa-0000-4000-8000-000000000009';

const mocks = vi.hoisted(() => ({
  proxyToCore: vi.fn(),
  auditLog: vi.fn(),
  query: vi.fn(),
}));

vi.mock('../../../src/api/core-dispatch.js', async (importOriginal) =>
  (await import('../../helpers/core-dispatch-double.js')).coreDispatchDouble(await importOriginal(), mocks.proxyToCore));
vi.mock('../../../src/audit/platform/audit-logger.js', () => ({ platformAuditLogger: { log: mocks.auditLog } }));
vi.mock('@magick-agency/observability', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@magick-agency/observability')>()),
  createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../../../src/auth/session.middleware.js', () => ({ sessionMiddleware: async () => {} }));
vi.mock('../../../src/api/middleware/tenant-context.middleware.js', () => ({
  tenantContextMiddleware: async () => {},
}));
vi.mock('../../../src/rbac/rbac.middleware.js', () => ({
  requirePermission: () => async () => {},
}));
vi.mock('../../../src/storage/s3.js', () => ({
  getFileStream: vi.fn(), getFile: vi.fn(), uploadFile: vi.fn(),
}));
vi.mock('../../../src/agency/agency-ingest-job.repository.js', () => ({
  agencyIngestJobRepository: { create: vi.fn(), findById: vi.fn(), requestCancel: vi.fn() },
}));
vi.mock('../../../src/agency/agency-ingest.service.js', () => ({
  agencyIngestService: { run: vi.fn() },
}));
vi.mock('@magick-agency/db/connection', () => ({
  getPool: () => ({ query: mocks.query }),
}));

import { proxyAgencyCampaignsRoutes } from '../../../src/api/routes/proxy-agency-campaigns.routes.js';

const PREFIX = '/proxy/agency';

/** The name lookup answers for the supervisor in this tenant only. */
function fakeQuery(sql: string, params: unknown[] = []): { rows: unknown[] } {
  if (sql.includes('FROM users')) {
    const ids = (params[0] as string[]) ?? [];
    return {
      rows: ids.includes(SUPERVISOR) && params[1] === TENANT
        ? [{ id: SUPERVISOR, display_name: 'Asha Menon', email: 'asha@example.com' }]
        : [],
    };
  }
  return { rows: [] };
}

async function buildApp(user: { id: string } | null = { id: SUPERVISOR }): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.addHook('onRequest', async (request) => {
    const r = request as unknown as Record<string, unknown>;
    r['tenantId'] = TENANT;
    r['accountId'] = ACCOUNT;
    if (user) r['user'] = user;
  });
  await app.register(proxyAgencyCampaignsRoutes, { prefix: PREFIX });
  await app.ready();
  return app;
}

const call = () => mocks.proxyToCore.mock.calls[0]![0] as Record<string, unknown>;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.query.mockImplementation(fakeQuery);
  mocks.proxyToCore.mockResolvedValue({
    status: 200,
    body: { id: CAMPAIGN, status: 'stopped', archived_at: '2026-11-21T06:00:00.000Z' },
    headers: new Headers(),
  });
});

describe('POST /proxy/agency/campaigns/:id/archive', () => {
  it('sends the session user and their name to the internal archive, whatever the body says', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: `${PREFIX}/campaigns/${CAMPAIGN}/archive`,
      payload: { actor_user_id: SOMEONE_ELSE, actor_name: 'Not me' },
    });
    expect(res.statusCode).toBe(200);
    expect(call()['path']).toBe(`/agency-campaigns/${CAMPAIGN}/archive`);
    expect(call()['body']).toEqual({ actor_user_id: SUPERVISOR, actor_name: 'Asha Menon' });
    expect(res.json()).toMatchObject({ id: CAMPAIGN, status: 'stopped' });
    await app.close();
  });

  it('writes agency_campaign.archived under the session user, with the campaign and its status', async () => {
    const app = await buildApp();
    await app.inject({ method: 'POST', url: `${PREFIX}/campaigns/${CAMPAIGN}/archive` });
    expect(mocks.auditLog).toHaveBeenCalledTimes(1);
    expect(mocks.auditLog.mock.calls[0]![0]).toEqual({
      tenant_id: TENANT,
      account_id: ACCOUNT,
      resource_type: 'agency_campaign',
      resource_id: CAMPAIGN,
      campaign_id: CAMPAIGN,
      details: { campaign_id: CAMPAIGN, status: 'stopped' },
      actor_type: 'human',
      user_id: SUPERVISOR,
      action: 'agency_campaign.archived',
    });
    await app.close();
  });

  it('sends no body with no session user: unattributed, never a placeholder', async () => {
    const app = await buildApp(null);
    await app.inject({ method: 'POST', url: `${PREFIX}/campaigns/${CAMPAIGN}/archive` });
    expect('body' in call()).toBe(false);
    await app.close();
  });

  it.each([
    [409, { code: 'campaign_not_archivable', current_status: 'running' }],
    [404, { code: 'campaign_not_found' }],
  ])('relays a %s unchanged and writes no audit row', async (status, body) => {
    mocks.proxyToCore.mockResolvedValue({ status, body, headers: new Headers() });
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: `${PREFIX}/campaigns/${CAMPAIGN}/archive` });
    expect(res.statusCode).toBe(status);
    expect(res.json()).toEqual(body);
    expect(mocks.auditLog).not.toHaveBeenCalled();
    await app.close();
  });
});

describe('POST /proxy/agency/campaigns/:id/unarchive', () => {
  it('sends no body, even when the caller sends one', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: `${PREFIX}/campaigns/${CAMPAIGN}/unarchive`,
      payload: { actor_user_id: SOMEONE_ELSE },
    });
    expect(res.statusCode).toBe(200);
    expect(call()['path']).toBe(`/agency-campaigns/${CAMPAIGN}/unarchive`);
    expect('body' in call()).toBe(false);
    await app.close();
  });

  it('writes agency_campaign.restored under the session user', async () => {
    mocks.proxyToCore.mockResolvedValue({
      status: 200, body: { id: CAMPAIGN, status: 'draft', archived_at: null }, headers: new Headers(),
    });
    const app = await buildApp();
    await app.inject({ method: 'POST', url: `${PREFIX}/campaigns/${CAMPAIGN}/unarchive` });
    expect(mocks.auditLog).toHaveBeenCalledTimes(1);
    expect(mocks.auditLog.mock.calls[0]![0]).toMatchObject({
      action: 'agency_campaign.restored',
      resource_id: CAMPAIGN,
      details: { campaign_id: CAMPAIGN, status: 'draft' },
      actor_type: 'human',
      user_id: SUPERVISOR,
    });
    await app.close();
  });

  it('relays a 409 campaign_not_archived unchanged and writes no audit row', async () => {
    const body = { code: 'campaign_not_archived', current_status: 'draft', archived_at: null };
    mocks.proxyToCore.mockResolvedValue({ status: 409, body, headers: new Headers() });
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: `${PREFIX}/campaigns/${CAMPAIGN}/unarchive` });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual(body);
    expect(mocks.auditLog).not.toHaveBeenCalled();
    await app.close();
  });
});
