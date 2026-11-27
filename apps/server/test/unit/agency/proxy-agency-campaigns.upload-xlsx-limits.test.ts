import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import http from 'node:http';
import { once } from 'node:events';
import { Readable } from 'node:stream';

/*
 * The upload route's own limits (IM8), with the conversion stood in for (its runner has its
 * own suite, `agency-xlsx-runner.test.ts`):
 *  - the per-user cap on Excel conversions (`XlsxStartCap`): past ten starts in fifteen
 *    minutes, a workbook is refused 429 `upload_rate_limited` with `Retry-After` BEFORE its
 *    body is read (a workbook under another name, once its bytes say so); a busy refusal costs
 *    nothing; other users and CSV files are not held up;
 *  - a file over the size limit is a coded 413 `file_too_large` in plain words, not the
 *    multipart plugin's "request file too large". The plugin's limit is lowered here (a
 *    512 MB fixture is not one); the words still say the real limit.
 */
const mocks = vi.hoisted(() => ({
  user: 'user-1',
  running: false,
  convert: vi.fn(),
  uploadFile: vi.fn(),
  uploadStream: vi.fn(),
  fileSizeLimit: 4_096,
}));

vi.mock('../../../src/auth/session.middleware.js', () => ({
  sessionMiddleware: async (request: FastifyRequest) => {
    (request as { user?: { id: string } }).user = { id: mocks.user };
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
  uploadFile: mocks.uploadFile,
  uploadStream: mocks.uploadStream,
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
vi.mock('../../../src/agency/agency-xlsx-runner.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/agency/agency-xlsx-runner.js')>()),
  convertXlsxInChild: mocks.convert,
  xlsxConversionRunning: () => mocks.running,
}));
// The real multipart plugin with a small file limit, so the 413 is reachable.
vi.mock('@fastify/multipart', async (importOriginal) => {
  const real = await importOriginal<typeof import('@fastify/multipart')>();
  type Options = { limits?: Record<string, number> };
  const plugin = real.default as unknown as (f: unknown, o: Options, done: (err?: Error) => void) => void;
  const wrapped = (f: unknown, o: Options, done: (err?: Error) => void) =>
    plugin(f, { ...o, limits: { ...o.limits, fileSize: mocks.fileSizeLimit } }, done);
  // fastify-plugin's markers (skip-override, name, meta), so the decorators reach the route.
  for (const key of Object.getOwnPropertySymbols(plugin)) {
    (wrapped as unknown as Record<symbol, unknown>)[key] = (plugin as unknown as Record<symbol, unknown>)[key];
  }
  return { ...real, default: wrapped };
});

import { proxyAgencyCampaignsRoutes } from '../../../src/api/routes/proxy-agency-campaigns.routes.js';
import { handWorkbook } from '../../helpers/xlsx-fixtures.js';

const PREFIX = '/proxy/agency/campaigns';
const BOUNDARY = '----xlsxLimits';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.decorate('chargeUserRateLimit', async (_r: FastifyRequest, _p: FastifyReply) => {});
  await app.register(proxyAgencyCampaignsRoutes, { prefix: PREFIX });
  await app.ready();
  return app;
}

function upload(app: FastifyInstance, name: string, content: Buffer | string, complete = true) {
  const head = `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: application/octet-stream\r\n\r\n`;
  const tail = complete ? `\r\n--${BOUNDARY}--\r\n` : '';
  return app.inject({
    method: 'POST',
    url: `${PREFIX}/ingest/upload`,
    headers: { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
    payload: Buffer.concat([Buffer.from(head), Buffer.from(content), Buffer.from(tail)]),
  });
}

const workbook = handWorkbook({ sheets: [{ name: 'S', xml: '<sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData>' }] });
/** A workbook's first bytes and then nothing: had the route read the body, a 400 for a malformed form. */
const CUT_OFF = 'PK\u0003\u0004 cut off';

function fakeConversion() {
  return {
    sheet: { name: 'S', other_sheet_names: [], other_sheet_count: 0 },
    rows: 1,
    columns: 1,
    csv: Readable.from([Buffer.from('1\n')]),
    signal: new AbortController().signal,
    failure: () => null,
    dispose: () => {},
  };
}

let app: FastifyInstance;

beforeEach(async () => {
  mocks.user = 'user-1';
  mocks.running = false;
  mocks.convert.mockReset().mockImplementation(async () => fakeConversion());
  mocks.uploadFile.mockReset().mockResolvedValue(undefined);
  mocks.uploadStream.mockReset().mockImplementation(async (_key: string, body: AsyncIterable<Buffer>) => {
    let n = 0;
    for await (const chunk of body) n += chunk.length;
    return n;
  });
  app = await buildApp();
});

describe('the per-user cap on Excel conversions', () => {
  it('refuses the eleventh workbook in fifteen minutes 429 upload_rate_limited, before its body is read', async () => {
    for (let i = 0; i < 10; i++) {
      const res = await upload(app, `customers-${i}.xlsx`, workbook);
      expect(res.statusCode, res.body).toBe(201);
    }
    expect(mocks.convert).toHaveBeenCalledTimes(10);

    const res = await upload(app, 'customers.xlsx', CUT_OFF, false);
    expect(res.statusCode, res.body).toBe(429);
    const retryAfter = Number(res.headers['retry-after']);
    expect(retryAfter).toBeGreaterThan(14 * 60);
    expect(retryAfter).toBeLessThanOrEqual(15 * 60);
    expect(res.json()).toEqual({
      error: 'Too Many Requests',
      code: 'upload_rate_limited',
      message: "You've uploaded a lot of Excel files in a short time. Try again in 15 minutes, or upload the list as a CSV file.",
      retry_after_seconds: retryAfter,
    });
    expect(mocks.convert).toHaveBeenCalledTimes(10);

    // A CSV is never held up, and another supervisor has a cap of their own.
    expect((await upload(app, 'customers.csv', 'Mobile\n9876500001\n')).statusCode).toBe(201);
    mocks.user = 'user-2';
    expect((await upload(app, 'customers.xlsx', workbook)).statusCode).toBe(201);
  });

  it('refuses a workbook under another name once its bytes say it is one, without converting it', async () => {
    for (let i = 0; i < 10; i++) expect((await upload(app, 'customers.xlsx', workbook)).statusCode).toBe(201);
    const res = await upload(app, 'customers.csv', workbook);
    expect(res.statusCode, res.body).toBe(429);
    expect(res.json()).toMatchObject({ code: 'upload_rate_limited' });
    expect(mocks.convert).toHaveBeenCalledTimes(10);
    expect(mocks.uploadFile).not.toHaveBeenCalled();
  });

  it('a workbook refused busy costs the user nothing', async () => {
    mocks.running = true;
    for (let i = 0; i < 12; i++) {
      // Read in full (a renamed workbook passes the early check), then refused by the slot.
      mocks.convert.mockImplementationOnce(async () => {
        const { XlsxBusyError } = await import('../../../src/agency/agency-xlsx-runner.js');
        throw new XlsxBusyError();
      });
      const res = await upload(app, 'customers.csv', workbook);
      expect(res.statusCode, res.body).toBe(429);
      expect(res.json()).toMatchObject({ code: 'workbook_busy' });
    }
    mocks.running = false;
    mocks.convert.mockReset().mockImplementation(async () => fakeConversion());
    for (let i = 0; i < 10; i++) expect((await upload(app, 'customers.xlsx', workbook)).statusCode).toBe(201);
  });
});

describe('a file over the size limit', () => {
  it('a CSV is refused 413 file_too_large in plain words, and nothing is stored', async () => {
    const res = await upload(app, 'customers.csv', `Mobile\n${'9876500001\n'.repeat(1_000)}`);
    expect(res.statusCode, res.body).toBe(413);
    expect(res.json()).toEqual({
      error: 'Payload Too Large',
      code: 'file_too_large',
      message: 'This file is too large. A file can be up to 512 MB.',
    });
    expect(mocks.uploadFile).not.toHaveBeenCalled();
  });

  it('so is a workbook', async () => {
    const res = await upload(app, 'customers.xlsx', Buffer.alloc(mocks.fileSizeLimit + 1, 0x50));
    expect(res.statusCode, res.body).toBe(413);
    expect(res.json()).toMatchObject({ code: 'file_too_large', message: 'This file is too large. A file can be up to 512 MB.' });
    expect(mocks.convert).not.toHaveBeenCalled();
  });
});

describe("the converter's own limits", () => {
  it.each([
    ['a work cap (too_complex)', 'too_complex'],
    ['the heap cap (too_much_memory)', 'too_much_memory'],
  ] as const)('%s is 422 workbook_too_complex, in words that fit both', async (_label, kind) => {
    const { XlsxLimitError } = await import('../../../src/agency/agency-xlsx-refusals.js');
    mocks.convert.mockImplementationOnce(async () => { throw new XlsxLimitError(kind); });
    const res = await upload(app, 'customers.xlsx', workbook);
    expect(res.statusCode, res.body).toBe(422);
    expect(res.json()).toEqual({
      error: 'Validation Error',
      code: 'workbook_too_complex',
      message: 'This workbook is too large or complex to read. Save the sheet with your customers as a CSV file, '
        + 'or as a workbook with only that sheet, and upload it again.',
    });
    expect(mocks.uploadStream).not.toHaveBeenCalled();
  });
});

describe('the upload\'s other 400s carry a code', () => {
  it('a form with no file: no_file', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `${PREFIX}/ingest/upload`,
      headers: { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
      payload: `--${BOUNDARY}\r\nContent-Disposition: form-data; name="note"\r\n\r\nhello\r\n--${BOUNDARY}--\r\n`,
    });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json()).toEqual({ error: 'Validation Error', code: 'no_file', message: 'No file uploaded.' });
  });

  it('a body cut off mid-file: upload_malformed', async () => {
    const res = await upload(app, 'customers.csv', 'Mobile\n98765', false);
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json()).toEqual({
      error: 'Validation Error',
      code: 'upload_malformed',
      message: 'The upload could not be read: the file was cut off or the form is malformed. Please upload it again.',
    });
  });
});

/** An app on a real port that records, for each upload it answers, the body and whether the request had been read to its end. */
async function listening(): Promise<{ app: FastifyInstance; port: number; answers: Array<{ readEnded: boolean; body: string }> }> {
  const answers: Array<{ readEnded: boolean; body: string }> = [];
  const real = Fastify({ logger: false });
  real.decorate('chargeUserRateLimit', async (_r: FastifyRequest, _p: FastifyReply) => {});
  real.addHook('onSend', async (request, _reply, payload) => {
    if (request.url.endsWith('/ingest/upload')) answers.push({ readEnded: request.raw.readableEnded, body: String(payload) });
    return payload;
  });
  await real.register(proxyAgencyCampaignsRoutes, { prefix: PREFIX });
  await real.listen({ host: '127.0.0.1', port: 0 });
  return { app: real, port: (real.server.address() as { port: number }).port, answers };
}

/**
 * A multipart upload over a real connection, its file written in 64 KiB chunks as the
 * socket takes them (a browser sending a large file). Resolves with what came back, or the
 * client's own error (`ECONNRESET`, `EPIPE`) if the connection was cut.
 */
function send(port: number, name: string, file: Buffer, opts: { destroyWhen?: () => boolean } = {}) {
  const head = Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: application/octet-stream\r\n\r\n`);
  const tail = Buffer.from(`\r\n--${BOUNDARY}--\r\n`);
  const req = http.request({
    host: '127.0.0.1', port, method: 'POST', path: `${PREFIX}/ingest/upload`,
    headers: { 'content-type': `multipart/form-data; boundary=${BOUNDARY}`, 'content-length': head.length + file.length + tail.length },
  });
  const outcome = new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string } | { error: string }>((resolve) => {
    req.on('response', (res) => {
      let body = '';
      res.on('data', (c: Buffer) => { body += c.toString('utf8'); });
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body }));
      res.on('error', (err: NodeJS.ErrnoException) => resolve({ error: err.code ?? err.message }));
    });
    req.on('error', (err: NodeJS.ErrnoException) => resolve({ error: err.code ?? err.message }));
  });
  void (async () => {
    try {
      req.write(head);
      for (let at = 0; at < file.length; at += 64 * 1024) {
        if (req.destroyed) return;
        if (!req.write(file.subarray(at, at + 64 * 1024))) await once(req, 'drain');
      }
      req.end(tail);
    } catch { /* the outcome says what happened */ }
  })();
  return { req, outcome };
}

describe('a refusal before the file is read reads the rest of the body first', () => {
  let real: Awaited<ReturnType<typeof listening>>;
  const BIG = Buffer.concat([Buffer.from('PK\u0003\u0004'), Buffer.alloc(16 * 1024 * 1024, 0x41)]);

  beforeEach(async () => {
    mocks.fileSizeLimit = 64 * 1024 * 1024;
    real = await listening();
  });
  afterEach(async () => {
    mocks.fileSizeLimit = 4_096;
    real.app.server.closeAllConnections();
    await real.app.close();
  });

  it('a second workbook while one converts: the 429 arrives whole after the body is read, never a reset', async () => {
    mocks.running = true;
    const result = await send(real.port, 'customers.xlsx', BIG).outcome;
    expect(result).toMatchObject({ status: 429 });
    expect(JSON.parse((result as { body: string }).body)).toMatchObject({ code: 'workbook_busy', retry_after_seconds: 60 });
    expect(real.answers).toHaveLength(1);
    expect(real.answers[0]!.readEnded).toBe(true);
    expect(mocks.convert).not.toHaveBeenCalled();
  }, 30_000);

  it('a workbook over the user\'s cap: the same, and reading the rest costs no conversion start', async () => {
    for (let i = 0; i < 10; i++) expect((await upload(real.app, 'customers.xlsx', workbook)).statusCode).toBe(201);
    real.answers.length = 0;
    const result = await send(real.port, 'customers.xlsx', BIG).outcome;
    expect(result).toMatchObject({ status: 429 });
    expect(JSON.parse((result as { body: string }).body)).toMatchObject({ code: 'upload_rate_limited' });
    expect(real.answers[0]!.readEnded).toBe(true);
    expect(mocks.convert).toHaveBeenCalledTimes(10);
  }, 30_000);

  it('a file past the size limit is read only to the limit, and still refused 429, the connection closed', async () => {
    await real.app.close();
    mocks.fileSizeLimit = 1024 * 1024;
    real = await listening();
    mocks.running = true;
    const res = await upload(real.app, 'customers.xlsx', Buffer.alloc(4 * 1024 * 1024, 0x41));
    expect(res.statusCode, res.body).toBe(429);
    expect(res.json()).toMatchObject({ code: 'workbook_busy' });
    expect(res.headers['connection']).toBe('close');
  });
});

describe('a client that goes away mid-conversion', () => {
  let real: Awaited<ReturnType<typeof listening>>;
  beforeEach(async () => { real = await listening(); });
  afterEach(async () => {
    real.app.server.closeAllConnections();
    await real.app.close();
  });

  /** A stand-in that waits until the upload is stopped (the client gone), then fails with why. */
  const untilStopped = (signal?: AbortSignal) => new Promise<never>((_resolve, reject) => {
    signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
  });

  it.each([
    ['while the workbook is read', 'convert'],
    ['while its CSV is stored', 'store'],
  ] as const)('%s: answered 400 upload_stopped', async (_label, where) => {
    let started = false;
    if (where === 'convert') {
      mocks.convert.mockImplementationOnce((_buf: Buffer, _limits: unknown, options?: { signal?: AbortSignal }) => {
        started = true;
        return untilStopped(options?.signal);
      });
    } else {
      mocks.uploadStream.mockImplementationOnce((_key: string, _body: unknown, _type: string, signal?: AbortSignal) => {
        started = true;
        return untilStopped(signal);
      });
    }
    const { req, outcome } = send(real.port, 'customers.xlsx', workbook);
    const deadline = Date.now() + 5_000;
    while (!started && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    expect(started).toBe(true);
    req.destroy();
    await outcome;
    while (real.answers.length === 0 && Date.now() < deadline + 5_000) await new Promise((r) => setTimeout(r, 10));
    expect(JSON.parse(real.answers[0]!.body)).toEqual({
      error: 'Validation Error',
      code: 'upload_stopped',
      message: 'The upload was stopped before it finished.',
    });
  });
});
