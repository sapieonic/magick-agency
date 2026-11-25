import { describe, it, expect, vi } from 'vitest';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { performance } from 'node:perf_hooks';

/*
 * Closing the server while an Excel upload converts (IM8). `app.close()` waits for requests
 * in flight, and shutdown (`src/index.ts`) awaits it before it halts pacing and drains; a
 * conversion runs for up to five minutes, past Docker's stop grace. The upload sub-plugin's
 * `preClose` hook stops the conversion (`abortXlsxConversions`), so the request answers 503
 * at once, the child is killed and close finishes. A real listening server and a real HTTP
 * request: `inject` is not a connection `close()` waits for. S3 here never reads the CSV
 * (it waits on its signal), as a stalled upload would.
 */
const mocks = vi.hoisted(() => ({ uploadStreamCalled: false }));

vi.mock('../../../src/auth/session.middleware.js', () => ({
  sessionMiddleware: async (request: FastifyRequest) => {
    (request as { user?: { id: string } }).user = { id: 'user-1' };
  },
}));
vi.mock('../../../src/api/middleware/tenant-context.middleware.js', () => ({
  tenantContextMiddleware: async (request: FastifyRequest) => {
    (request as { tenantId?: string }).tenantId = 'tenant-1';
    (request as { accountId?: string }).accountId = 'account-1';
  },
}));
vi.mock('../../../src/rbac/rbac.middleware.js', () => ({ requirePermission: () => async () => {} }));
vi.mock('../../../src/audit/platform/audit-logger.js', () => ({ platformAuditLogger: { log: vi.fn() } }));
vi.mock('../../../src/storage/s3.js', () => ({
  getFileStream: vi.fn(),
  getFile: vi.fn(),
  uploadFile: vi.fn().mockResolvedValue(undefined),
  uploadStream: (_key: string, _body: unknown, _type: string, signal?: AbortSignal) => {
    mocks.uploadStreamCalled = true;
    return new Promise((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  },
  isS3NotFound: () => false,
}));
vi.mock('../../../src/agency/agency-ingest-job.repository.js', () => ({
  agencyIngestJobRepository: { create: vi.fn(), findById: vi.fn(), requestCancel: vi.fn() },
}));
vi.mock('../../../src/agency/agency-ingest.service.js', () => ({ agencyIngestService: { run: vi.fn() } }));
vi.mock('../../../src/config/index.js', () => ({ config: { agency: { rosterReplaceEnabled: false } } }));
vi.mock('@magick-agency/observability', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@magick-agency/observability')>()),
  createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { proxyAgencyCampaignsRoutes } from '../../../src/api/routes/proxy-agency-campaigns.routes.js';
import { xlsxConversionRunning } from '../../../src/agency/agency-xlsx-runner.js';
import { handWorkbook } from '../../helpers/xlsx-fixtures.js';

const PREFIX = '/proxy/agency/campaigns';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.decorate('chargeUserRateLimit', async (_r: FastifyRequest, _p: FastifyReply) => {});
  await app.register(proxyAgencyCampaignsRoutes, { prefix: PREFIX });
  await app.listen({ host: '127.0.0.1', port: 0 });
  return app;
}

describe('closing the server while an Excel upload converts', () => {
  it('answers the upload 503 at once, kills the conversion and lets close finish', async () => {
    const app = await buildApp();
    const address = app.server.address() as { port: number };
    const rows = Array.from({ length: 40_000 }, (_, i) =>
      `<row r="${i + 1}"><c r="A${i + 1}"><v>${9_000_000_000 + i}</v></c><c r="B${i + 1}" t="inlineStr"><is><t>${'n'.repeat(40)}</t></is></c></row>`).join('');
    const workbook = handWorkbook({ sheets: [{ name: 'S', xml: `<sheetData>${rows}</sheetData>` }] });
    const form = new FormData();
    form.append('file', new Blob([workbook]), 'customers.xlsx');
    const response = fetch(`http://127.0.0.1:${address.port}${PREFIX}/ingest/upload`, { method: 'POST', body: form });

    // The conversion has opened and the CSV is being "stored" (never read).
    const deadline = Date.now() + 15_000;
    while (!mocks.uploadStreamCalled) {
      if (Date.now() > deadline) throw new Error('the upload never reached S3');
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(xlsxConversionRunning()).toBe(true);

    const t0 = performance.now();
    await app.close();
    expect(performance.now() - t0).toBeLessThan(5_000);

    const res = await response;
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('60');
    expect(await res.json()).toEqual({
      error: 'Service Unavailable',
      code: 'server_restarting',
      message: 'The server is restarting. Upload the file again in a minute.',
      retry_after_seconds: 60,
    });
    const freed = Date.now() + 5_000;
    while (xlsxConversionRunning() && Date.now() < freed) await new Promise((r) => setTimeout(r, 20));
    expect(xlsxConversionRunning()).toBe(false);
  }, 30_000);
});
