import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import { gunzipSync } from 'node:zlib';

/**
 * ─── Reports end to end: the real app on real Postgres ─────────────────────────
 *
 * Through `buildApp` with a real context (session middleware with Firebase stubbed, tenant
 * context, RBAC, the `agency_reports_enabled` flag, the reports routes and the render callback),
 * the real repositories on Postgres 5436, and S3 mocked at `storage/s3.js` (an in-memory bucket):
 *
 *  1. a supervisor queues an agent review → the assembler (a fake dataset builder) writes the
 *     dataset and a gzipped detail sheet and records it → the inline dispatcher calls a fake
 *     renderer, which writes both files through the S3-backed IO → the run is `ready` → the
 *     download answers a presigned URL with the file name, audited → `expireDue` turns it
 *     `expired` and the download answers 410;
 *  2. the signed callback against a run in `rendering`: after a re-send (attempt 2) the first
 *     attempt's late callback is stale (204, still `rendering`), the current attempt's applies
 *     (204, `ready`), a replay is acknowledged as stale (204, nothing changes), a bad signature is
 *     401 and a key outside the run's scope is 400;
 *  3. scoping: an agent's history holds only the runs they requested; another tenant reads none.
 */

const mocks = vi.hoisted(() => {
  process.env['SUPER_ADMIN_JWT_SECRET'] = 'agency-reports-secret-0123456789';
  return {
    verifyIdToken: vi.fn(),
    objects: new Map<string, Buffer>(),
    presigned: [] as Array<{ key: string; opts: unknown }>,
  };
});
vi.mock('../../../src/auth/firebase.js', () => ({ initFirebase: vi.fn(), verifyIdToken: mocks.verifyIdToken }));
// S3 at the module boundary: an in-memory bucket. Everything else is real.
vi.mock('../../../src/storage/s3.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../src/storage/s3.js')>();
  const drain = async (body: Readable) => {
    const chunks: Buffer[] = [];
    for await (const chunk of body) chunks.push(Buffer.from(chunk as Buffer));
    return Buffer.concat(chunks);
  };
  return {
    ...real,
    uploadFile: async (key: string, body: Buffer) => { mocks.objects.set(key, body); },
    uploadStream: async (key: string, body: Readable) => {
      const bytes = await drain(body);
      mocks.objects.set(key, bytes);
      return bytes.length;
    },
    uploadJson: async (key: string, value: unknown) => {
      const bytes = Buffer.from(JSON.stringify(value));
      mocks.objects.set(key, bytes);
      return bytes.length;
    },
    getFile: async (key: string) => {
      const bytes = mocks.objects.get(key);
      if (!bytes) throw Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' });
      return bytes;
    },
    getFileStream: async (key: string) => ({ body: Readable.from([mocks.objects.get(key) ?? Buffer.alloc(0)]) }),
    headFile: async (key: string) => {
      const bytes = mocks.objects.get(key);
      if (!bytes) throw Object.assign(new Error('NotFound'), { name: 'NotFound', $metadata: { httpStatusCode: 404 } });
      return { contentLength: bytes.length };
    },
    getPresignedUrl: async (key: string, opts: unknown) => {
      mocks.presigned.push({ key, opts });
      return `https://bucket.example/${key}?X-Amz-Signature=test`;
    },
  };
});

import { REPORT_SIGNATURE_HEADER, REPORT_TIMESTAMP_HEADER, type ReportRenderCallback, type ReportRenderMessage } from '@magick-agency/contracts/reports';
import { getTestPool } from '../../../../../packages/db/test/helpers/test-db.js';
import {
  call, drainAudits, seedFloor, startLoadApp, stopLoadApp, verifyTestToken,
  type LoadApp, type TenantFloor,
} from '../load/load-harness.js';
import { reportRunRepository, reportSubscriptionRepository } from '../../../src/db/repositories/agency.repository.js';
import { createReportAssembler } from '../../../src/agency/reports/assembler.js';
import { createInlineDispatcher, s3RendererIO, type ReportRenderDispatcher } from '../../../src/agency/reports/dispatch.js';
import { applyRenderOutcome } from '../../../src/agency/reports/apply.js';
import { signReportCallback } from '../../../src/agency/reports/callback-signature.js';
import { reportDetailKey, reportOutputKey } from '../../../src/agency/reports/report-keys.js';
import type { ReportDatasetBuilder } from '../../../src/agency/reports/datasets/index.js';
import { uploadStream, uploadJson } from '../../../src/storage/s3.js';

const SECRET = 'integration-report-callback-secret-0123456789';

let loaded: LoadApp;
let floors: TenantFloor[];
let floor: TenantFloor;
const sup = () => floor.supervisors[0]!;
const agent = () => floor.agents[0]!;

/** A small dataset and one detail sheet of three rows, standing in for the dataset builders. */
const fakeBuilder: ReportDatasetBuilder = async ({ run, now }) => ({
  dataset: {
    dataset_version: 1, run_id: run.id, kind: run.kind, audience: run.audience, generated_at: now.toISOString(),
    marker: 'integration',
  } as never,
  details: [{
    sheet: 'calls', label: 'Calls', columns: [{ key: 'n', label: 'N', type: 'int' }],
    rows: async function* () { yield [1]; yield [2]; yield [3]; },
  }],
});

/** The renderer the inline dispatcher loads: writes each format through the IO it is given. */
const fakeRenderer = {
  renderRun: async (message: ReportRenderMessage, io: typeof s3RendererIO): Promise<ReportRenderCallback> => {
    const dataset = JSON.parse((await io.readObject(message.dataset_key)).toString('utf8')) as { marker: string };
    const files = [];
    for (const format of message.formats) {
      const key = `${message.output_prefix}report.${format}`;
      const body = Buffer.from(`${format}:${dataset.marker}`);
      const { bytes } = await io.writeObject(key, body, 'application/octet-stream', body.length);
      files.push({ format, key, bytes });
    }
    return { run_id: message.run_id, attempt: message.attempt, status: 'rendered', files, error: null, renderer_version: 'fake-1' };
  },
};

function assemblerWith(dispatcher: ReportRenderDispatcher) {
  return createReportAssembler(
    { intervalMs: 60_000, maxDetailRows: 1000, maxAttempts: 3 },
    {
      repo: reportRunRepository,
      subscriptions: reportSubscriptionRepository,
      builders: { agent: fakeBuilder, campaign: fakeBuilder, account: fakeBuilder },
      storage: { uploadStream, uploadJson },
      dispatcher,
      now: () => new Date(),
    },
  );
}

const inline = () => createInlineDispatcher({
  bucket: 'test-bucket',
  apply: (runId, attempt, callback) => applyRenderOutcome(runId, attempt, callback, { repo: reportRunRepository, retentionDays: 90 }),
  io: s3RendererIO,
  loader: async () => fakeRenderer,
});

/** Records what an SQS dispatcher would have sent, rendering nothing. */
function capturing() {
  const sent: Array<{ runId: string; attempt: number }> = [];
  const dispatcher: ReportRenderDispatcher = {
    dispatch: async (run, attempt) => { sent.push({ runId: run.id, attempt }); },
    idle: async () => {},
  };
  return { sent, dispatcher };
}

const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
const review = (subject: string) => ({
  kind: 'agent', subject_id: subject, from: daysAgo(6), to: today(), timezone: 'UTC', formats: ['pdf', 'xlsx'],
});

function postCallback(body: string, headers: Record<string, string>) {
  return loaded.app.inject({
    method: 'POST', url: '/webhooks/reports/rendered',
    headers: { 'content-type': 'application/json', ...headers }, payload: body,
  });
}

function signedHeaders(body: string, secret = SECRET) {
  const ts = Math.floor(Date.now() / 1000);
  return { [REPORT_TIMESTAMP_HEADER]: String(ts), [REPORT_SIGNATURE_HEADER]: signReportCallback(secret, ts, body) };
}

beforeAll(async () => {
  mocks.verifyIdToken.mockImplementation(verifyTestToken);
  loaded = await startLoadApp({
    configure: (c) => ({ ...c, agency: { ...c.agency, reports: { ...c.agency.reports, callbackSecret: SECRET } } }),
  });
  // The assembler and the tick take every queued run and due subscription in the database, and the
  // integration files share one: start from none, whatever an earlier file left.
  await getTestPool().query('DELETE FROM report_runs');
  await getTestPool().query('DELETE FROM report_subscriptions');
  floors = await seedFloor({ tenants: 2, agentsPerTenant: 2, supervisorsPerTenant: 1 });
  floor = floors[0]!;
  for (const f of floors) {
    await getTestPool().query(
      `INSERT INTO feature_flag_overrides (flag_key, scope_type, tenant_id, value) VALUES ('agency_reports_enabled', 'tenant', $1, 'true'::jsonb)`,
      [f.tenant],
    );
  }
});

afterAll(async () => {
  await stopLoadApp(loaded);
});

describe('reports on real Postgres through the real app', () => {
  it('queue → assemble → render inline → ready → download → expire', async () => {
    const created = await call(loaded.app, 'POST', '/proxy/agency/reports', sup(), floor, review(agent().id));
    expect(created.statusCode, created.body).toBe(202);
    const runId = created.json().id as string;
    expect(created.json()).toMatchObject({ status: 'queued', audience: 'supervisor', subject: { id: agent().id, name: expect.any(String) } });

    const dispatcher = inline();
    const outcomes = await assemblerWith(dispatcher).drain(() => false);
    expect(outcomes).toEqual([{ runId, outcome: 'sent', attempt: 1 }]);
    await dispatcher.idle();

    const scope = { tenantId: floor.tenant, accountId: floor.account, runId };
    expect(gunzipSync(mocks.objects.get(reportDetailKey(scope, 'calls'))!).toString()).toBe('[1]\n[2]\n[3]\n');

    const run = await call(loaded.app, 'GET', `/proxy/agency/reports/${runId}`, sup(), floor);
    expect(run.statusCode).toBe(200);
    expect(run.json()).toMatchObject({
      status: 'ready', files: [{ format: 'pdf', bytes: 'pdf:integration'.length }, { format: 'xlsx', bytes: 'xlsx:integration'.length }],
      truncated: false, error: null,
    });
    const stored = (await reportRunRepository.findById(floor.tenant, runId))!;
    expect(stored).toMatchObject({ renderer_version: 'fake-1', render_attempt: 1 });
    expect(stored.detail_files).toEqual([expect.objectContaining({ sheet: 'calls', rows: 3, truncated: false })]);

    const download = await call(loaded.app, 'GET', `/proxy/agency/reports/${runId}/files/pdf`, sup(), floor);
    expect(download.statusCode, download.body).toBe(200);
    expect(download.json().url).toContain(reportOutputKey(scope, 'pdf'));
    expect(download.json().filename).toMatch(/^agent-review_.+\.pdf$/);
    expect(mocks.presigned.at(-1)).toEqual({
      key: reportOutputKey(scope, 'pdf'),
      opts: { expiresIn: 300, filename: download.json().filename, contentType: 'application/pdf' },
    });
    await drainAudits();
    const audits = await getTestPool().query<{ action: string; user_id: string }>(
      `SELECT action, user_id::text FROM platform_audit_log WHERE resource_id = $1 ORDER BY created_at`, [runId],
    );
    expect(audits.rows.map((r) => r.action)).toEqual(['agency_report.requested', 'agency_report.downloaded']);
    expect(audits.rows.every((r) => r.user_id === sup().id)).toBe(true);

    expect(await reportRunRepository.expireDue(new Date(Date.now() + 91 * 86_400_000))).toBeGreaterThanOrEqual(1);
    const expired = await call(loaded.app, 'GET', `/proxy/agency/reports/${runId}/files/pdf`, sup(), floor);
    expect(expired.statusCode).toBe(410);
    expect(expired.json().code).toBe('report_expired');
  });

  it('the signed callback: a superseded attempt is stale, the current one applies once, a replay is stale, a bad signature 401, a foreign key 400', async () => {
    const created = await call(loaded.app, 'POST', '/proxy/agency/reports', sup(), floor, review(agent().id));
    expect(created.statusCode, created.body).toBe(202);
    const runId = created.json().id as string;
    const sqs = capturing();
    await assemblerWith(sqs.dispatcher).drain(() => false);
    expect(sqs.sent).toEqual([{ runId, attempt: 1 }]);
    expect((await reportRunRepository.findById(floor.tenant, runId))!.status).toBe('rendering');

    const scope = { tenantId: floor.tenant, accountId: floor.account, runId };
    const callback = (over: Partial<ReportRenderCallback> = {}): string => JSON.stringify({
      run_id: runId, attempt: 1, status: 'rendered', error: null, renderer_version: 'lambda-1',
      files: [
        { format: 'pdf', key: reportOutputKey(scope, 'pdf'), bytes: 11 },
        { format: 'xlsx', key: reportOutputKey(scope, 'xlsx'), bytes: 22 },
      ],
      ...over,
    });

    const badSig = await postCallback(callback(), signedHeaders(callback(), 'not-the-secret-not-the-secret-not-it'));
    expect(badSig.statusCode).toBe(401);

    const otherTenant = floors[1]!;
    const foreign = callback({ files: [
      { format: 'pdf', key: reportOutputKey({ ...scope, tenantId: otherTenant.tenant, accountId: otherTenant.account }, 'pdf'), bytes: 1 },
      { format: 'xlsx', key: reportOutputKey(scope, 'xlsx'), bytes: 1 },
    ] });
    expect((await postCallback(foreign, signedHeaders(foreign))).statusCode).toBe(400);
    expect((await reportRunRepository.findById(floor.tenant, runId))!.status).toBe('rendering');

    // The tick re-sends it (attempt 2): attempt 1's late callback is now stale, acknowledged, ignored.
    expect(await reportRunRepository.markSent(runId, { renderAttempt: 1 })).toBe(2);
    const late = callback();
    expect((await postCallback(late, signedHeaders(late))).statusCode).toBe(204);
    expect((await reportRunRepository.findById(floor.tenant, runId))!).toMatchObject({ status: 'rendering', files: [] });

    const body = callback({ attempt: 2 });
    const applied = await postCallback(body, signedHeaders(body));
    expect(applied.statusCode).toBe(204);
    const ready = (await reportRunRepository.findById(floor.tenant, runId))!;
    expect(ready).toMatchObject({ status: 'ready', renderer_version: 'lambda-1' });
    expect(ready.files).toEqual([
      { format: 'pdf', key: reportOutputKey(scope, 'pdf'), bytes: 11 },
      { format: 'xlsx', key: reportOutputKey(scope, 'xlsx'), bytes: 22 },
    ]);

    const failedReplay = callback({ attempt: 2, status: 'failed', files: [], error: { code: 'render_failed', message: 'late' } });
    const replay = await postCallback(failedReplay, signedHeaders(failedReplay));
    expect(replay.statusCode).toBe(204);
    expect((await reportRunRepository.findById(floor.tenant, runId))!).toMatchObject({ status: 'ready', error_code: null });
  });

  it('an agent sees only the runs they requested; another tenant reads none', async () => {
    const own = await call(loaded.app, 'POST', '/proxy/agency/reports', agent(), floor, review(agent().id));
    expect(own.statusCode, own.body).toBe(202);
    expect(own.json().audience).toBe('self');
    // Not the second agent's review.
    expect((await call(loaded.app, 'POST', '/proxy/agency/reports', agent(), floor, review(floor.agents[1]!.id))).statusCode).toBe(403);

    const agentList = await call(loaded.app, 'GET', '/proxy/agency/reports', agent(), floor);
    expect(agentList.json().runs.map((r: { id: string }) => r.id)).toEqual([own.json().id]);
    const supList = await call(loaded.app, 'GET', '/proxy/agency/reports', sup(), floor);
    expect(supList.json().runs.length).toBeGreaterThanOrEqual(3);

    const other = floors[1]!;
    const foreignList = await call(loaded.app, 'GET', '/proxy/agency/reports', other.supervisors[0]!, other);
    expect(foreignList.json().runs).toEqual([]);
    const foreignRead = await call(loaded.app, 'GET', `/proxy/agency/reports/${own.json().id}`, other.supervisors[0]!, other);
    expect(foreignRead.statusCode).toBe(404);
  });
});
