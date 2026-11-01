import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';

/*
 * `POST /proxy/agency/campaigns/ingest/upload` lives in its own sub-plugin (`ingest.ts`, so
 * the multipart parser is scoped to it). That sub-plugin is an encapsulated CHILD of
 * `proxyAgencyCampaignsRoutes`, and a Fastify child inherits every hook its parent added
 * before registering it. The child used to re-add `sessionMiddleware` and
 * `tenantContextMiddleware` on the belief that it did not, so every upload verified its
 * token twice and charged the per-user rate bucket (`u:<id>`) twice.
 *
 * The session middleware here is a double that does the one thing this pins: charge the
 * per-user bucket, through the same `request.server.chargeUserRateLimit` the real one calls.
 * Mutation-checked: re-adding the two `sub.addHook('preHandler', …)` lines reds it.
 */
const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  tenant: vi.fn(),
  charge: vi.fn(async () => {}),
  uploadFile: vi.fn().mockResolvedValue(undefined),
  proxyToCore: vi.fn(),
}));

vi.mock('../../../src/auth/session.middleware.js', () => ({
  sessionMiddleware: async (request: FastifyRequest, reply: FastifyReply) => {
    mocks.session();
    (request as { user?: { id: string } }).user = { id: 'user-1' };
    await request.server.chargeUserRateLimit?.(request as never, reply);
  },
}));
vi.mock('../../../src/api/middleware/tenant-context.middleware.js', () => ({
  tenantContextMiddleware: async (request: FastifyRequest) => {
    mocks.tenant();
    (request as { tenantId?: string }).tenantId = 'tenant-1';
    (request as { accountId?: string }).accountId = 'account-1';
  },
}));
vi.mock('../../../src/rbac/rbac.middleware.js', () => ({
  requirePermission: () => async () => {},
}));
vi.mock('../../../src/api/core-dispatch.js', async (importOriginal) =>
  (await import('../../helpers/core-dispatch-double.js')).coreDispatchDouble(await importOriginal(), mocks.proxyToCore));
vi.mock('../../../src/audit/platform/audit-logger.js', () => ({ platformAuditLogger: { log: vi.fn() } }));
vi.mock('../../../src/storage/s3.js', () => ({
  getFileStream: vi.fn(),
  getFile: vi.fn(),
  uploadFile: mocks.uploadFile,
}));
vi.mock('../../../src/agency/agency-ingest-job.repository.js', () => ({
  agencyIngestJobRepository: { create: vi.fn(), findById: vi.fn(), requestCancel: vi.fn() },
}));
vi.mock('../../../src/agency/agency-ingest.service.js', () => ({
  agencyIngestService: { run: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock('../../../src/config/index.js', () => ({ config: { agency: { rosterReplaceEnabled: false } } }));
vi.mock('@magick-agency/observability', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@magick-agency/observability')>()),
  createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { proxyAgencyCampaignsRoutes } from '../../../src/api/routes/proxy-agency-campaigns.routes.js';

const PREFIX = '/proxy/agency/campaigns';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  // Set on the root by `registerUserRateLimit` in production (`app.ts`).
  app.decorate('chargeUserRateLimit', mocks.charge);
  await app.register(proxyAgencyCampaignsRoutes, { prefix: PREFIX });
  await app.ready();
  return app;
}

function multipart(fileName: string, body: string) {
  const boundary = '----agencyUploadHooks';
  return {
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload:
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${fileName}"\r\n` +
      'Content-Type: text/csv\r\n\r\n' +
      `${body}\r\n` +
      `--${boundary}--\r\n`,
  };
}

describe('the roster upload sub-plugin inherits its parent\'s hooks, once', () => {
  beforeEach(() => {
    mocks.session.mockClear();
    mocks.tenant.mockClear();
    mocks.charge.mockClear();
    mocks.uploadFile.mockClear();
  });

  it('an upload runs the session middleware once and charges the per-user bucket once', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: `${PREFIX}/ingest/upload`, ...multipart('roster.csv', 'Mobile\n+919812345678\n') });
    expect(res.statusCode).toBe(201);
    // Inherited: the tenant the parent's hook resolved is the one the key is minted under.
    expect(res.json().s3_key).toMatch(/^agency-ingest\/tenant-1\//);
    expect(mocks.session).toHaveBeenCalledTimes(1);
    expect(mocks.tenant).toHaveBeenCalledTimes(1);
    expect(mocks.charge).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it('the same as a JSON route on the parent (the baseline)', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: `${PREFIX}/ingest/limits` });
    expect(res.statusCode).toBe(200);
    expect(mocks.session).toHaveBeenCalledTimes(1);
    expect(mocks.charge).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it('an unauthenticated upload still meets the session middleware (inheritance, not absence)', async () => {
    mocks.session.mockImplementationOnce(() => { throw Object.assign(new Error('no'), { statusCode: 401 }); });
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: `${PREFIX}/ingest/upload`, ...multipart('roster.csv', 'Mobile\n') });
    expect(res.statusCode).toBe(401);
    expect(mocks.uploadFile).not.toHaveBeenCalled();
    await app.close();
  });
});
