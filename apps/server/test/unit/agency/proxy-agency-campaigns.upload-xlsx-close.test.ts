import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import http from 'node:http';

/*
 * Closing the server while an Excel upload converts (IM8). `app.close()` waits for requests
 * in flight, and shutdown (`src/index.ts`) awaits it before it halts pacing and drains; a
 * conversion runs for up to five minutes, past Docker's stop grace. The upload sub-plugin's
 * `preClose` hook stops the conversion (`abortXlsxConversions`), so the request answers 503
 * at once, the child is killed and close finishes. A real listening server and a real HTTP
 * request: `inject` is not a connection `close()` waits for. S3 here never reads the CSV
 * (it waits on its signal), as a stalled upload would.
 *
 * Every state an upload can be in when the server begins to close: converting (the child
 * running), storing (the child has exited, its CSV still going to S3), and the body still
 * arriving (no child yet: none is started once the server is closing). And the client going
 * away mid-conversion kills the child and frees the slot.
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
import { abortXlsxConversions, reopenXlsxConversionsForTests, xlsxConversionRunning } from '../../../src/agency/agency-xlsx-runner.js';
import { handWorkbook } from '../../helpers/xlsx-fixtures.js';

const PREFIX = '/proxy/agency/campaigns';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.decorate('chargeUserRateLimit', async (_r: FastifyRequest, _p: FastifyReply) => {});
  await app.register(proxyAgencyCampaignsRoutes, { prefix: PREFIX });
  await app.listen({ host: '127.0.0.1', port: 0 });
  return app;
}

const SHUTDOWN_BODY = {
  error: 'Service Unavailable',
  code: 'server_restarting',
  message: 'The server is restarting. Upload the file again in a minute.',
  retry_after_seconds: 60,
};

/** Forty thousand rows: about 2 MB of CSV, so a child whose CSV nobody reads waits on the pipe. */
function bigWorkbook(): Buffer {
  const rows = Array.from({ length: 40_000 }, (_, i) =>
    `<row r="${i + 1}"><c r="A${i + 1}"><v>${9_000_000_000 + i}</v></c><c r="B${i + 1}" t="inlineStr"><is><t>${'n'.repeat(40)}</t></is></c></row>`).join('');
  return handWorkbook({ sheets: [{ name: 'S', xml: `<sheetData>${rows}</sheetData>` }] });
}

async function until(condition: () => boolean, ms: number, what: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting: ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** Whether `closing` settles within `ms` (a close that waits out the conversion's deadline does not). */
async function settlesWithin(closing: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), ms); });
  try {
    return await Promise.race([closing.then(() => true as const), late]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The upload as one multipart request over its own connection. `holdBack` sends the first half
 * of the body, and the rest only when the returned `finish` is called.
 */
function post(port: number, workbook: Buffer, holdBack = false) {
  const boundary = 'XLSXCLOSE';
  const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="customers.xlsx"\r\nContent-Type: application/octet-stream\r\n\r\n`);
  const body = Buffer.concat([head, workbook, Buffer.from(`\r\n--${boundary}--\r\n`)]);
  const req = http.request({
    host: '127.0.0.1', port, method: 'POST', path: `${PREFIX}/ingest/upload`,
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, 'content-length': body.length },
  });
  const response = new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
    req.on('response', (res) => {
      let text = '';
      res.on('data', (c: Buffer) => { text += c.toString('utf8'); });
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: text }));
    });
    req.on('error', reject);
  });
  const half = Math.floor(body.length / 2);
  if (holdBack) req.write(body.subarray(0, half));
  else req.end(body);
  return { req, response, finish: () => req.end(body.subarray(half)) };
}

let app: FastifyInstance | null = null;

beforeEach(() => {
  mocks.uploadStreamCalled = false;
  reopenXlsxConversionsForTests();
});

afterEach(async () => {
  // A case that failed may have left a conversion or a connection open.
  abortXlsxConversions('the case is over');
  app?.server.closeAllConnections();
  await app?.close();
  app = null;
  await until(() => !xlsxConversionRunning(), 10_000, 'the slot to be free');
  reopenXlsxConversionsForTests();
});

describe('closing the server while an Excel upload converts', () => {
  it('answers the upload 503 at once, kills the conversion and lets close finish', async () => {
    app = await buildApp();
    const address = app.server.address() as { port: number };
    const workbook = bigWorkbook();
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

    expect(await settlesWithin(app.close(), 5_000)).toBe(true);

    const res = await response;
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('60');
    expect(await res.json()).toEqual(SHUTDOWN_BODY);
    const freed = Date.now() + 5_000;
    while (xlsxConversionRunning() && Date.now() < freed) await new Promise((r) => setTimeout(r, 20));
    expect(xlsxConversionRunning()).toBe(false);
  }, 30_000);

  it('the child has exited and only the S3 upload of its CSV is left: 503 at once, and close finishes', async () => {
    app = await buildApp();
    const { port } = app.server.address() as { port: number };
    // One row: the child writes its CSV into the pipe and exits; S3 has not taken it.
    const small = handWorkbook({ sheets: [{ name: 'S', xml: '<sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Mobile</t></is></c></row></sheetData>' }] });
    const { response } = post(port, small);
    await until(() => mocks.uploadStreamCalled, 15_000, 'the upload to reach S3');
    await until(() => !xlsxConversionRunning(), 10_000, 'the child to exit');

    expect(await settlesWithin(app.close(), 5_000)).toBe(true);

    const res = await response;
    expect(res.status).toBe(503);
    expect(res.headers['retry-after']).toBe('60');
    expect(JSON.parse(res.body)).toEqual(SHUTDOWN_BODY);
  }, 30_000);

  it('the body still arriving when the server begins to close: no child is started, 503 once it has come, and close finishes', async () => {
    app = await buildApp();
    const { port } = app.server.address() as { port: number };
    const { response, finish } = post(port, bigWorkbook(), true);
    // The handler is reading the body.
    await new Promise((r) => setTimeout(r, 300));
    const closing = app.close();
    await new Promise((r) => setTimeout(r, 300));
    finish();
    expect(await settlesWithin(closing, 5_000)).toBe(true);

    const res = await response;
    expect(res.status).toBe(503);
    expect(JSON.parse(res.body)).toEqual(SHUTDOWN_BODY);
    expect(mocks.uploadStreamCalled).toBe(false);
    expect(xlsxConversionRunning()).toBe(false);
  }, 30_000);
});

describe('the client going away while an Excel upload converts', () => {
  it('kills the child and frees the slot', async () => {
    app = await buildApp();
    const { port } = app.server.address() as { port: number };
    const { req, response } = post(port, bigWorkbook());
    response.catch(() => { /* the client hangs up: no response */ });
    await until(() => mocks.uploadStreamCalled, 15_000, 'the upload to reach S3');
    // The child waits on its pipe (S3 never reads): only the client's going can stop it now.
    expect(xlsxConversionRunning()).toBe(true);

    req.destroy();
    const t0 = Date.now();
    await until(() => !xlsxConversionRunning(), 10_000, 'the slot to be free');
    expect(Date.now() - t0).toBeLessThan(5_000);
  }, 30_000);
});
