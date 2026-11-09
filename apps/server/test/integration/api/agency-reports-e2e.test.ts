import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

/**
 * ─── Reports end to end: every part of the pipeline, together, on real Postgres ─────────────
 *
 * The other report suites hold each part against a fake of the next (`agency-reports.test.ts`:
 * a fake builder and a fake renderer; the oracle: builders against the screens; the renderer's
 * own tests: fixtures in memory). This one runs them TOGETHER, so a disagreement between two
 * parts (a key, a content type, the detail file format, the dataset's shape, the module loading,
 * the callback signature) fails here:
 *
 *  - a seeded account (one campaign in Asia/Kolkata, two agents, three worked days of sessions
 *    with recorded state changes, attempts across the outcomes, analysed and recorded calls), the
 *    Insights rollup recomputed, `agency_reports_enabled` on for the tenant;
 *  - through `buildApp` + `inject` with the real session, tenant, RBAC and flag guards: a
 *    supervisor's agent review (`email_me`), the agent's own review (`self`), a campaign report
 *    and an account report;
 *  - the REAL report pipeline as `startReportPipeline` wires it from config (the assembler with
 *    the real dataset builders, the inline dispatcher loading `@magick-agency/report-renderer` by
 *    its package name, its `renderRun` printing with the Chromium its discovery finds, the tick's
 *    notify step with the real email module); S3 is an in-memory bucket at `storage/s3.js` and
 *    Mailjet a stubbed `fetch`, nothing of the pipeline's own is replaced;
 *  - the stored PDF is a PDF whose text names the agent and prints the record's figures; the
 *    stored workbook opens with exceljs with each kind's sheets; the `self` copy has no Benchmark
 *    sheet and masks phones `****1234`; the download answers a presigned URL for the run's own
 *    key; the `email_me` run's email goes out once;
 *  - the SQS mode: the message sent through `@aws-sdk/client-sqs` (mocked at the SDK) is a
 *    `ReportRenderMessage`; the renderer's `renderRun` is called with it as the Lambda would, the
 *    result signed with the renderer's `signCallback` and POSTed to `/webhooks/reports/rendered`:
 *    the server's verifier accepts the renderer's signature and the run turns `ready`.
 */

const SECRET = 'e2e-report-callback-secret-0123456789abcdef';
const QUEUE_URL = 'https://sqs.ap-south-1.amazonaws.com/123456789012/report-jobs';
const CALLBACK_BASE = 'https://console.e2e.test';
const BUCKET = 'e2e-reports-bucket';
const MAILJET_URL = 'https://api.mailjet.com/v3.1/send';

const mocks = vi.hoisted(() => {
  process.env['SUPER_ADMIN_JWT_SECRET'] = 'agency-reports-e2e-secret-0123456789';
  process.env['MAILJET_API_KEY'] = 'mj-key';
  process.env['MAILJET_API_SECRET'] = 'mj-secret';
  process.env['MAILJET_FROM_EMAIL'] = 'reports@agency.test';
  process.env['MAILJET_FROM_NAME'] = 'Reports';
  process.env['CONSOLE_BASE_URL'] = 'https://console.e2e.test';
  return {
    verifyIdToken: vi.fn(),
    objects: new Map<string, { body: Buffer; contentType: string | null }>(),
    presigned: [] as Array<{ key: string; opts: unknown }>,
    sqs: [] as Array<{ QueueUrl: string; MessageBody: string }>,
  };
});
vi.mock('../../../src/auth/firebase.js', () => ({ initFirebase: vi.fn(), verifyIdToken: mocks.verifyIdToken }));
// S3 at the module boundary: an in-memory bucket that keeps each object's content type.
vi.mock('../../../src/storage/s3.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../src/storage/s3.js')>();
  const drain = async (body: Readable) => {
    const chunks: Buffer[] = [];
    for await (const chunk of body) chunks.push(Buffer.from(chunk as Buffer));
    return Buffer.concat(chunks);
  };
  const read = (key: string) => {
    const object = mocks.objects.get(key);
    if (!object) throw Object.assign(new Error(`NoSuchKey: ${key}`), { name: 'NoSuchKey', $metadata: { httpStatusCode: 404 } });
    return object.body;
  };
  return {
    ...real,
    uploadFile: async (key: string, body: Buffer, contentType: string) => { mocks.objects.set(key, { body, contentType }); },
    uploadStream: async (key: string, body: Readable, contentType: string) => {
      const bytes = await drain(body);
      mocks.objects.set(key, { body: bytes, contentType });
      return bytes.length;
    },
    uploadJson: async (key: string, value: unknown) => {
      const bytes = Buffer.from(JSON.stringify(value));
      mocks.objects.set(key, { body: bytes, contentType: 'application/json' });
      return bytes.length;
    },
    getFile: async (key: string) => read(key),
    getFileStream: async (key: string) => {
      const body = read(key);
      return { body: Readable.from([body]), contentLength: body.length };
    },
    headFile: async (key: string) => ({ contentLength: read(key).length }),
    getPresignedUrl: async (key: string, opts: unknown) => {
      mocks.presigned.push({ key, opts });
      return `https://${'e2e-reports-bucket'}.s3.example/${key}?X-Amz-Signature=test`;
    },
  };
});
// SQS at the SDK boundary: the dispatcher's own `SQSClient` / `SendMessageCommand` calls are kept.
vi.mock('@aws-sdk/client-sqs', () => ({
  SQSClient: class {
    async send(command: { input: { QueueUrl: string; MessageBody: string } }) {
      mocks.sqs.push(command.input);
      return { MessageId: randomUUID() };
    }
  },
  SendMessageCommand: class {
    constructor(readonly input: unknown) {}
  },
}));

import {
  REPORT_FORMAT_CONTENT_TYPES,
  REPORT_TIMESTAMP_HEADER,
  REPORT_SIGNATURE_HEADER,
  reportFileName,
  type AgentReviewDataset,
  type ReportDataset,
  type ReportRenderCallback,
  type ReportRenderMessage,
} from '@magick-agency/contracts/reports';
import { getTestPool } from '../../../../../packages/db/test/helpers/test-db.js';
import { call, seedFloor, startLoadApp, stopLoadApp, verifyTestToken, type Actor, type LoadApp, type TenantFloor } from '../load/load-harness.js';
import { bulkInsert } from '../agency/insights-rollup-world.js';
import { insightsCache } from '../../../src/agency/insights/cache.js';
import { agencyInsightsRollupRepository, reportRunRepository } from '../../../src/db/repositories/agency.repository.js';
import { localDateOf, localInstant } from '../../../src/agency/reports/schedule.js';
import { createReportDispatcher, startReportPipeline, type ReportPipeline } from '../../../src/agency/reports/pipeline.js';
import { createReportAssembler, defaultAssemblerDeps } from '../../../src/agency/reports/assembler.js';
import type { ReportRendererIO } from '../../../src/agency/reports/dispatch.js';
import { reportDatasetKey, reportDetailKey, reportOutputKey, reportOutputPrefix } from '../../../src/agency/reports/report-keys.js';

// ── The renderer and its readers, loaded as the server loads it (not compiled by the server's tsc) ──

/** What this test uses of `@magick-agency/report-renderer` (the server's `tsc` never follows into it). */
interface RendererPackage {
  renderRun(message: ReportRenderMessage, io: ReportRendererIO, options?: Record<string, unknown>): Promise<ReportRenderCallback>;
  signCallback(secret: string, rawBody: string, timestampSeconds: number): Record<string, string>;
}
interface WorkbookCell { value: unknown }
interface WorkbookRow { getCell(i: number): WorkbookCell; eachCell(opts: { includeEmpty: boolean }, cb: (cell: WorkbookCell) => void): void }
interface Worksheet { name: string; actualRowCount: number; getRow(n: number): WorkbookRow; eachRow(cb: (row: WorkbookRow, n: number) => void): void }
interface Workbook { worksheets: Worksheet[]; getWorksheet(name: string): Worksheet | undefined }

const RENDERER_PACKAGE: string = '@magick-agency/report-renderer';
const RENDERER_DIR = fileURLToPath(new URL('../../../../report-renderer/', import.meta.url));
const renderer = () => import(RENDERER_PACKAGE) as Promise<RendererPackage>;
/** The renderer's own test readers (pdf.js and exceljs are its dependencies, not the server's). */
const pdfText = async (buf: Buffer) =>
  ((await import(`${RENDERER_DIR}test/helpers/pdf-text.ts`)) as { pdfText(b: Buffer): Promise<{ pages: number; text: string[] }> }).pdfText(buf);
const readWorkbook = async (buf: Buffer) =>
  ((await import(`${RENDERER_DIR}test/helpers/xlsx.ts`)) as { readWorkbook(b: Buffer): Promise<Workbook> }).readWorkbook(buf);

// ── Mailjet: a stubbed fetch for its one URL ──────────────────────────────────

interface MailjetMessage { To: Array<{ Email: string }>; Subject: string; TextPart: string; HTMLPart: string }
const mailjet: MailjetMessage[] = [];
const realFetch = globalThis.fetch;
const fetchStub = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (url !== MAILJET_URL) return realFetch(input, init);
  const body = JSON.parse(String(init?.body)) as { Messages: MailjetMessage[] };
  mailjet.push(...body.Messages);
  return new Response(
    JSON.stringify({ Messages: body.Messages.map((m) => ({ Status: 'success', To: m.To.map((t) => ({ Email: t.Email, MessageUUID: randomUUID() })) })) }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
});

// ── The seed ────────────────────────────────────────────────────────────────

const ZONE = 'Asia/Kolkata';
const TODAY = localDateOf(new Date(), ZONE);
const shiftDate = (date: string, days: number) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
const DAYS = [shiftDate(TODAY, -3), shiftDate(TODAY, -2), shiftDate(TODAY, -1)];
const FROM = DAYS[0]!;
const TO = DAYS[2]!;
const L = (date: string, hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  return localInstant(ZONE, date, h * 3600 + m * 60);
};
const plus = (d: Date, seconds: number) => new Date(d.getTime() + seconds * 1000);

let loaded: LoadApp;
let floor: TenantFloor;
const sup = (): Actor => floor.supervisors[0]!;
const agent = (i: number): Actor => floor.agents[i]!;
const campaign = () => floor.campaigns[0]!;

type Row = Record<string, unknown>;
const talked = (t: Date, code: string, talkS: number) => ({
  outcome: 'connected', answered_at: plus(t, 3), bridged_at: plus(t, 4), ended_at: plus(t, 4 + talkS),
  wrapup_started_at: plus(t, 4 + talkS), wrapup_ended_at: plus(t, 34 + talkS), wrapup_resolution: 'disposition_submitted',
  disposition_code: code,
});

async function seed(): Promise<void> {
  [floor] = await seedFloor({ tenants: 1, agentsPerTenant: 2, supervisorsPerTenant: 1, campaignsPerTenant: 1, staffAgents: true }) as [TenantFloor];
  const created = L(shiftDate(FROM, -10), '08:00');
  await getTestPool().query(
    `UPDATE agency_campaigns SET status = 'running', started_at = $2, created_at = $2, default_timezone = $3 WHERE id = $1`,
    [campaign(), created, ZONE],
  );
  await getTestPool().query(
    `INSERT INTO feature_flag_overrides (flag_key, scope_type, tenant_id, value) VALUES ('agency_reports_enabled', 'tenant', $1, 'true'::jsonb)`,
    [floor.tenant],
  );

  const contacts: Row[] = [];
  const sessions: Row[] = [];
  const events: Row[] = [];
  const attempts: Row[] = [];
  const calls: Row[] = [];
  const base = { tenant_id: floor.tenant, account_id: floor.account };
  // Phones +91987654<seq>, seq from 1230: agent 0's fifth dial of the first day ends in 1234.
  let seq = 1230;
  const contact = () => {
    const id = randomUUID();
    contacts.push({ ...base, id, campaign_id: campaign(), phone_e164: `+91987654${String(seq++).padStart(4, '0')}`, context: {}, state: 'completed' });
    return id;
  };
  const attempt = (o: Row) => attempts.push({
    ...base, id: randomUUID(), campaign_id: campaign(), contact_id: contact(), attempt_number: 1, caller_id: '+919000000001',
    reserved_agent_id: null, state: 'ended', outcome: null, disposition_code: null, answered_at: null, bridged_at: null,
    ended_at: null, redial_number: 0, redial_of_attempt_id: null, agent_reopened: false, agent_manual: false,
    override_applied: [], callback_at: null, webrtc_call_id: null, wrapup_started_at: null, wrapup_ended_at: null,
    wrapup_resolution: null, ...o,
  });

  for (let i = 0; i < 2; i++) {
    DAYS.forEach((day, k) => {
      const join = L(day, `09:0${i}`);
      const m = (minutes: number) => plus(join, minutes * 60);
      const sid = randomUUID();
      sessions.push({ ...base, id: sid, campaign_id: campaign(), agent_user_id: agent(i).id, kind: 'campaign', state: 'offline', joined_at: join, left_at: L(day, '13:00') });
      const steps: Array<[string, Date, string | null]> = [
        ['available', join, null], ['on_call', m(20), null], ['wrapup', m(25), null], ['available', m(27), null],
        ['break', L(day, '11:00'), 'lunch'], ['available', L(day, '11:30'), null], ['offline', L(day, '13:00'), null],
      ];
      for (const [state, at, reason] of steps) {
        events.push({ ...base, id: randomUUID(), session_id: sid, campaign_id: campaign(), agent_user_id: agent(i).id, to_state: state, at, break_reason: reason });
      }
      const at = (j: number) => plus(join, 20 * 60 + j * 360);
      const mine = { reserved_agent_id: sid };
      // A recorded, analysed conversation: agent 0's three days are positive, mixed and negative.
      const callId = randomUUID();
      calls.push({
        ...base, id: callId, caller_id: '+919000000001', destination_phone: '+919800000000', status: 'completed',
        recording_url: `https://rec.example/${callId}.mp3`, analysis_status: 'completed', campaign_id: campaign(), agency_attempt_id: null,
        call_analysis: { common: { overall_sentiment: { label: i === 0 ? ['positive', 'mixed', 'negative'][k] : 'neutral', score: 0.5 } } },
      });
      attempt({ ...mine, dialed_at: at(0), ...talked(at(0), 'interested', 60), webrtc_call_id: callId });
      attempt({ ...mine, dialed_at: at(1), ...talked(at(1), 'voicemail', 20) });
      attempt({ ...mine, dialed_at: at(2), outcome: 'no_answer', ended_at: plus(at(2), 20) });
      attempt({ ...mine, dialed_at: at(3), ...talked(at(3), 'not_interested', 40) });
      attempt({ ...mine, dialed_at: at(4), outcome: 'busy', ended_at: plus(at(4), 5) });
      attempt({ ...mine, dialed_at: at(5), ...talked(at(5), 'interested', 90) });
      attempt({ ...mine, dialed_at: at(6), outcome: 'no_answer', ended_at: plus(at(6), 20) });
      attempt({ ...mine, dialed_at: at(7), ...talked(at(7), 'callback', 30), callback_at: plus(at(7), 86_400) });
      attempt({ ...mine, dialed_at: at(8), outcome: 'no_answer', ended_at: plus(at(8), 20) });
      attempt({ ...mine, dialed_at: at(9), ...talked(at(9), 'not_interested', 30) });
      // Answered, reached no agent.
      if (i === 0) attempt({ dialed_at: at(10), outcome: 'abandoned', answered_at: plus(at(10), 3), ended_at: plus(at(10), 11) });
    });
  }

  const pool = getTestPool();
  await bulkInsert(pool, 'agency_contacts', [['id', 'uuid'], ['campaign_id', 'uuid'], ['tenant_id', 'uuid'], ['account_id', 'uuid'], ['phone_e164', 'text'], ['context', 'jsonb'], ['state', 'text']], contacts);
  await bulkInsert(pool, 'agency_agent_sessions', [['id', 'uuid'], ['tenant_id', 'uuid'], ['account_id', 'uuid'], ['campaign_id', 'uuid'], ['agent_user_id', 'uuid'], ['kind', 'text'], ['state', 'text'], ['joined_at', 'timestamptz'], ['left_at', 'timestamptz']], sessions);
  await bulkInsert(pool, 'agency_agent_session_events', [['id', 'uuid'], ['session_id', 'uuid'], ['tenant_id', 'uuid'], ['account_id', 'uuid'], ['campaign_id', 'uuid'], ['agent_user_id', 'uuid'], ['to_state', 'text'], ['at', 'timestamptz'], ['break_reason', 'text']], events);
  await bulkInsert(pool, 'agency_calls', [['id', 'uuid'], ['tenant_id', 'uuid'], ['account_id', 'uuid'], ['caller_id', 'text'], ['destination_phone', 'text'], ['status', 'text'], ['recording_url', 'text'], ['analysis_status', 'text'], ['call_analysis', 'jsonb'], ['campaign_id', 'uuid'], ['agency_attempt_id', 'uuid']], calls);
  await bulkInsert(pool, 'agency_call_attempts', [
    ['id', 'uuid'], ['campaign_id', 'uuid'], ['contact_id', 'uuid'], ['tenant_id', 'uuid'], ['account_id', 'uuid'], ['attempt_number', 'int'],
    ['caller_id', 'text'], ['reserved_agent_id', 'uuid'], ['state', 'text'], ['outcome', 'text'], ['disposition_code', 'text'],
    ['dialed_at', 'timestamptz'], ['answered_at', 'timestamptz'], ['bridged_at', 'timestamptz'], ['ended_at', 'timestamptz'],
    ['redial_number', 'int'], ['redial_of_attempt_id', 'uuid'], ['agent_reopened', 'boolean'], ['agent_manual', 'boolean'],
    ['override_applied', 'text[]'], ['callback_at', 'timestamptz'], ['webrtc_call_id', 'uuid'], ['wrapup_started_at', 'timestamptz'],
    ['wrapup_ended_at', 'timestamptz'], ['wrapup_resolution', 'text'],
  ], attempts);
  for (let n = 0; n < 100; n++) if ((await agencyInsightsRollupRepository.recomputeBatch(500)).picked < 500) break;
  insightsCache.clear();
}

// ── Helpers ─────────────────────────────────────────────────────────────────

const object = (key: string) => {
  const o = mocks.objects.get(key);
  if (!o) throw new Error(`nothing stored at ${key}`);
  return o;
};
const scopeOf = (runId: string) => ({ tenantId: floor.tenant, accountId: floor.account, runId });
const datasetOf = <D extends ReportDataset = ReportDataset>(runId: string) =>
  JSON.parse(object(reportDatasetKey(scopeOf(runId))).body.toString('utf8')) as D;
const sheetNames = (wb: Workbook) => wb.worksheets.map((w) => w.name);
const headerOf = (ws: Worksheet, row = 1) => {
  const out: string[] = [];
  ws.getRow(row).eachCell({ includeEmpty: false }, (c) => out.push(String(c.value)));
  return out;
};
const pdfOf = async (runId: string) => (await pdfText(object(reportOutputKey(scopeOf(runId), 'pdf')).body)).text.join(' ');
const workbookOf = (runId: string) => readWorkbook(object(reportOutputKey(scopeOf(runId), 'xlsx')).body);

async function createRun(actor: Actor, body: Record<string, unknown>): Promise<string> {
  const res = await call(loaded.app, 'POST', '/proxy/agency/reports', actor, floor, { from: FROM, to: TO, formats: ['pdf', 'xlsx'], ...body });
  expect(res.statusCode, res.body).toBe(202);
  expect(res.json().status).toBe('queued');
  return res.json().id as string;
}

async function getRun(runId: string, actor: Actor = sup()) {
  const res = await call(loaded.app, 'GET', `/proxy/agency/reports/${runId}`, actor, floor);
  expect(res.statusCode, res.body).toBe(200);
  return res.json();
}

/** The run is `ready` with both files, whose byte counts are the stored objects' sizes and types. */
async function expectReady(runId: string, actor: Actor = sup()) {
  const run = await getRun(runId, actor);
  expect(run, JSON.stringify(run.error)).toMatchObject({ status: 'ready', error: null, truncated: false });
  const scope = scopeOf(runId);
  expect(run.files).toEqual([
    { format: 'pdf', bytes: object(reportOutputKey(scope, 'pdf')).body.length },
    { format: 'xlsx', bytes: object(reportOutputKey(scope, 'xlsx')).body.length },
  ]);
  for (const format of ['pdf', 'xlsx'] as const) {
    expect(object(reportOutputKey(scope, format)).contentType).toBe(REPORT_FORMAT_CONTENT_TYPES[format]);
    expect(run.files.find((f: { format: string }) => f.format === format).bytes).toBeGreaterThan(1000);
  }
  expect(object(reportOutputKey(scope, 'pdf')).body.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  return run;
}

// ── The suite ───────────────────────────────────────────────────────────────

let pipeline: ReportPipeline;
const runs = { review: '', self: '', campaign: '', account: '' };

beforeAll(async () => {
  vi.stubGlobal('fetch', fetchStub);
  mocks.verifyIdToken.mockImplementation(verifyTestToken);
  loaded = await startLoadApp({
    configure: (c) => ({
      ...c,
      s3: { audioBucket: BUCKET, region: 'ap-south-1', accessKeyId: 'AKIAE2ETEST', secretAccessKey: 'e2e-secret' },
      agency: {
        ...c.agency,
        reports: {
          ...c.agency.reports,
          renderer: 'inline', callbackSecret: SECRET, userPerMinute: 20, tenantPendingLimit: 10,
          // The loops are driven by hand below; their timers never fire within the test.
          assemblerIntervalMs: 600_000, tickIntervalMs: 3_600_000,
        },
      },
    }),
  });
  // The assembler and the tick take every queued run and due subscription in the database, and the
  // integration files share one: start from none, whatever an earlier file left.
  await getTestPool().query('DELETE FROM report_runs');
  await getTestPool().query('DELETE FROM report_subscriptions');
  await seed();
  // The pipeline exactly as boot starts it from config: inline renderer, real builders, real email.
  pipeline = startReportPipeline(loaded.ctx.config);
}, 120_000);

afterAll(async () => {
  await pipeline?.stop();
  vi.unstubAllGlobals();
  await stopLoadApp(loaded);
});

/** One tick now (the one `startReportTick` runs at start may still be in flight). */
async function tickNow() {
  for (let i = 0; i < 50; i++) {
    const result = await pipeline.tick.runTick();
    if (result) return result;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('the reports tick never became free');
}

describe('reports end to end: routes → assembler → real builders → inline renderer → ready → download → email', () => {
  it('four runs requested through the routes are assembled, rendered in process and ready', async () => {
    runs.review = await createRun(sup(), { kind: 'agent', subject_id: agent(0).id, timezone: ZONE, email_me: true });
    runs.self = await createRun(agent(0), { kind: 'agent', subject_id: agent(0).id, timezone: ZONE });
    runs.campaign = await createRun(sup(), { kind: 'campaign', subject_id: campaign() });
    runs.account = await createRun(sup(), { kind: 'account', subject_id: floor.account, timezone: ZONE });
    expect((await getRun(runs.self, agent(0))).audience).toBe('self');

    const outcomes = await pipeline.assembler.runPass();
    expect(outcomes).toEqual([runs.review, runs.self, runs.campaign, runs.account].map((runId) => ({ runId, outcome: 'sent', attempt: 1 })));
    await pipeline.dispatcher.idle();

    for (const id of [runs.review, runs.campaign, runs.account]) await expectReady(id);
    await expectReady(runs.self, agent(0));
    const stored = (await reportRunRepository.findById(floor.tenant, runs.review))!;
    expect(stored.renderer_version).toMatch(/^\d+\.\d+\.\d+/); // the renderer package's own version, not a fallback
  }, 90_000);

  it('the datasets and detail files are where the run says, gzipped NDJSON in the columns\' order', () => {
    for (const id of Object.values(runs)) {
      const scope = scopeOf(id);
      const dataset = datasetOf(id);
      expect(dataset).toMatchObject({ dataset_version: 1, run_id: id });
      for (const file of dataset.detail_files) {
        expect(file.key).toBe(reportDetailKey(scope, file.sheet));
        expect(object(file.key).contentType).toBe('application/gzip');
        const lines = gunzipSync(object(file.key).body).toString('utf8').split('\n').filter(Boolean);
        expect(lines).toHaveLength(file.rows);
        for (const line of lines) expect(JSON.parse(line)).toHaveLength(file.columns.length);
      }
    }
  });

  it('the supervisor\'s review: the PDF names the agent and prints the record\'s figures; the workbook has every agent sheet', async () => {
    const d = datasetOf<AgentReviewDataset>(runs.review);
    // The record is the agent record screen's, for the same window.
    const screen = await call(loaded.app, 'GET',
      `/proxy/agency/agents/${agent(0).id}/stats?from=${encodeURIComponent(d.range.start)}&to=${encodeURIComponent(d.range.end)}&bucket=day`, sup(), floor);
    expect(screen.json().totals.attempts).toBe(d.record.attempts);
    expect(d.record.attempts).toBe(30);
    const firstDials = d.daily.reduce((s, r) => s + r.first_dials, 0);
    const humans = d.daily.reduce((s, r) => s + r.human_connects, 0);
    expect(firstDials).toBeGreaterThanOrEqual(d.floors.agent_rate_min_first_dials); // so the rate prints as a figure
    // The day rows' two conversation counts are one count (the contract says so).
    for (const day of d.daily) expect(day.conversations).toBe(day.connected);
    expect(d.daily.reduce((s, r) => s + r.connected, 0)).toBe(d.record.connected);

    const text = await pdfOf(runs.review);
    expect(text).toContain('agent 0.0');
    expect(text).toContain(`of ${d.record.attempts} dials`);
    expect(text).toContain(`${humans} people / ${firstDials} first dials`);
    // Call analysis: the mixed call is its own count, from the builder through the PDF.
    expect(d.quality).toEqual({ analysed_calls: 3, sentiment: { positive: 1, neutral: 0, negative: 1, mixed: 1 } });
    expect(text).toContain('Mixed 1 (');
    expect(text).toContain('Neutral 0 (');

    const wb = await workbookOf(runs.review);
    const summary: Record<string, unknown> = {};
    wb.getWorksheet('Summary')!.eachRow((row) => { summary[String(row.getCell(1).value)] = row.getCell(2).value; });
    expect(summary).toMatchObject({ 'Dials': 30, 'Sentiment: mixed': 1, 'Sentiment: neutral': 0, 'Sentiment: positive': 1 });
    expect(sheetNames(wb)).toEqual([
      'Summary', 'Daily', 'Sessions', 'State log', 'Breaks', 'Calls', 'Outcomes', 'Callbacks', 'Campaigns', 'Benchmark', 'Definitions',
    ]);
    const calls = d.detail_files.find((f) => f.sheet === 'calls')!;
    expect(headerOf(wb.getWorksheet('Calls')!)).toEqual(calls.columns.map((c) => c.label));
    expect(wb.getWorksheet('Calls')!.actualRowCount).toBe(calls.rows + 1);
    expect(calls.rows).toBe(30);
    const phoneCol = calls.columns.findIndex((c) => c.key === 'phone') + 1;
    expect(String(wb.getWorksheet('Calls')!.getRow(2).getCell(phoneCol).value)).toMatch(/^\+91987654\d{4}$/);
  });

  it('the agent\'s own copy: no Benchmark sheet, no sentiment block, phones masked to ****1234', async () => {
    const d = datasetOf<AgentReviewDataset>(runs.self);
    expect(d).toMatchObject({ audience: 'self', benchmark: null, quality: null });
    const text = await pdfOf(runs.self);
    expect(text).toContain('agent 0.0');
    expect(text.toLowerCase()).toContain('own copy');

    const wb = await workbookOf(runs.self);
    expect(sheetNames(wb)).toEqual(['Summary', 'Daily', 'Sessions', 'State log', 'Breaks', 'Calls', 'Outcomes', 'Callbacks', 'Campaigns', 'Definitions']);
    const ws = wb.getWorksheet('Calls')!;
    const header = headerOf(ws);
    expect(header).not.toContain('Sentiment');
    expect(header).not.toContain('Recorded');
    const phoneLabel = d.detail_files.find((f) => f.sheet === 'calls')!.columns.find((c) => c.key === 'phone')!.label;
    const phoneCol = header.indexOf(phoneLabel) + 1;
    const phones: string[] = [];
    ws.eachRow((row, n) => { if (n > 1) phones.push(String(row.getCell(phoneCol).value)); });
    expect(phones).toHaveLength(30);
    for (const p of phones) expect(p).toMatch(/^\*{4}\d{4}$/);
    expect(phones).toContain('****1234');
  });

  it('the campaign report and the account report print their subjects; their workbooks have the attempts and campaigns sheets', async () => {
    const campaignText = await pdfOf(runs.campaign);
    expect(campaignText).toContain('Load 0.0');
    const cwb = await workbookOf(runs.campaign);
    const attempts = datasetOf(runs.campaign).detail_files.find((f) => f.sheet === 'attempts')!;
    expect(sheetNames(cwb)).toEqual([
      'Summary', 'Daily', 'By hour', 'Outcomes', 'Agents', 'Callbacks', 'Health', 'Caller IDs', attempts.label, 'Sessions', 'Definitions',
    ]);
    expect(cwb.getWorksheet(attempts.label)!.actualRowCount).toBe(attempts.rows + 1);
    expect(attempts.rows).toBe(63); // 2 agents × 3 days × 10, plus 3 abandoned

    const accountText = await pdfOf(runs.account);
    expect(accountText).toContain('Load Account 0');
    const awb = await workbookOf(runs.account);
    const accountAttempts = datasetOf(runs.account).detail_files.find((f) => f.sheet === 'attempts')!;
    expect(sheetNames(awb)).toEqual(['Summary', 'Campaigns', 'Agents', 'Daily', 'Health', accountAttempts.label, 'Definitions']);
    expect(awb.getWorksheet('Campaigns')!.actualRowCount).toBe(1 + 1 + 1); // header, one campaign, the totals row
  });

  it('the download answers a presigned URL for the run\'s own key, named for the subject and window', async () => {
    for (const [id, actor] of [[runs.review, sup()], [runs.self, agent(0)], [runs.campaign, sup()], [runs.account, sup()]] as const) {
      for (const format of ['pdf', 'xlsx'] as const) {
        const res = await call(loaded.app, 'GET', `/proxy/agency/reports/${id}/files/${format}`, actor, floor);
        expect(res.statusCode, res.body).toBe(200);
        const run = await getRun(id, actor);
        const key = reportOutputKey(scopeOf(id), format);
        expect(res.json().url).toContain(key);
        expect(res.json().filename).toBe(reportFileName(run.kind, run.subject.name, FROM, TO, format));
        expect(mocks.presigned.at(-1)).toEqual({
          key, opts: { expiresIn: 300, filename: res.json().filename, contentType: REPORT_FORMAT_CONTENT_TYPES[format] },
        });
      }
    }
    expect(mocks.presigned.find((p) => p.key.endsWith('report.pdf'))!.opts).toMatchObject({ filename: expect.stringMatching(/^agent-review_agent-0-0_.+\.pdf$/) });
  });

  it('the tick emails the email_me run\'s requester once, and nobody else', async () => {
    mailjet.length = 0;
    const first = await tickNow();
    expect(first.notified).toBe(1); // only runs with email_me or a subscription are notified
    const second = await tickNow();
    expect(second.notified).toBe(0);
    expect(mailjet).toHaveLength(1);
    const [mail] = mailjet as [MailjetMessage];
    expect(mail.To).toEqual([{ Email: `${sup().uid}@load.example.com` }]);
    expect(mail.Subject).toContain('agent review');
    expect(mail.Subject).toContain('agent 0.0');
    expect(mail.TextPart).toContain(`https://console.e2e.test/t/${floor.tenant}/a/${floor.account}/agency/reports/${runs.review}`);
  });
});

describe('SQS mode: the server\'s message, the renderer as the Lambda runs it, the signed callback', () => {
  it('the message is a ReportRenderMessage; the renderer\'s signature passes the server\'s verifier; the run is ready', async () => {
    const runId = await createRun(sup(), { kind: 'agent', subject_id: agent(1).id, timezone: ZONE, formats: ['xlsx'] });
    const config = loaded.ctx.config;
    const sqsConfig = {
      ...config,
      agency: { ...config.agency, reports: { ...config.agency.reports, renderer: 'sqs' as const, sqsQueueUrl: QUEUE_URL, callbackBaseUrl: CALLBACK_BASE } },
    };
    mocks.sqs.length = 0;
    const sentFrom = Date.now();
    const assembler = createReportAssembler({ intervalMs: 600_000, maxDetailRows: 100_000, maxAttempts: 3 }, defaultAssemblerDeps(createReportDispatcher(sqsConfig)));
    expect(await assembler.drain(() => false)).toEqual([{ runId, outcome: 'sent', attempt: 1 }]);
    expect((await getRun(runId)).status).toBe('rendering');

    expect(mocks.sqs).toHaveLength(1);
    expect(mocks.sqs[0]!.QueueUrl).toBe(QUEUE_URL);
    const message = JSON.parse(mocks.sqs[0]!.MessageBody) as ReportRenderMessage;
    const scope = scopeOf(runId);
    expect(message).toStrictEqual({
      run_id: runId,
      attempt: 1,
      dataset_version: 1,
      bucket: BUCKET,
      dataset_key: reportDatasetKey(scope),
      output_prefix: reportOutputPrefix(scope),
      formats: ['xlsx'],
      callback_url: `${CALLBACK_BASE}/webhooks/reports/rendered`,
      superseded_after: expect.any(String),
    } satisfies ReportRenderMessage);
    // The tick's deadline for this attempt: the send plus AGENCY_REPORTS_RENDER_TIMEOUT_MS.
    const deadline = Date.parse(message.superseded_after!) - config.agency.reports.renderTimeoutMs;
    expect(deadline).toBeGreaterThanOrEqual(sentFrom);
    expect(deadline).toBeLessThanOrEqual(Date.now());

    // The Lambda's part: render with an IO over the message's bucket, sign, POST.
    const { renderRun, signCallback } = await renderer();
    const io: ReportRendererIO = {
      readObject: async (key) => object(key).body,
      readStream: async (key) => Readable.from([object(key).body]),
      async writeObject(key, body, contentType, bytes) {
        const buf = Buffer.isBuffer(body) ? body : Buffer.concat(await body.toArray() as Buffer[]);
        expect(buf.length).toBe(bytes);
        mocks.objects.set(key, { body: buf, contentType });
        return { bytes: buf.length };
      },
    };
    const callback = await renderRun(message, io);
    expect(callback).toMatchObject({ run_id: runId, attempt: 1, status: 'rendered', error: null });
    const rawBody = JSON.stringify(callback);

    const forged = await loaded.app.inject({
      method: 'POST', url: '/webhooks/reports/rendered', payload: rawBody,
      headers: { 'content-type': 'application/json', ...signCallback('not-the-secret-not-the-secret-not-it!!', rawBody, Date.now() / 1000) },
    });
    expect(forged.statusCode).toBe(401);
    const headers = signCallback(SECRET, rawBody, Date.now() / 1000);
    expect(Object.keys(headers).sort()).toEqual([REPORT_SIGNATURE_HEADER, REPORT_TIMESTAMP_HEADER].sort());
    const res = await loaded.app.inject({
      method: 'POST', url: new URL(message.callback_url).pathname, payload: rawBody,
      headers: { 'content-type': 'application/json', ...headers },
    });
    expect(res.statusCode, res.body).toBe(204);

    const run = await getRun(runId);
    expect(run).toMatchObject({ status: 'ready', error: null, files: [{ format: 'xlsx', bytes: object(reportOutputKey(scope, 'xlsx')).body.length }] });
    expect((await reportRunRepository.findById(floor.tenant, runId))!.renderer_version).toBe(callback.renderer_version);
    const wb = await workbookOf(runId);
    expect(sheetNames(wb)).toContain('Benchmark');
    expect(String(wb.getWorksheet('Summary')!.getRow(1).getCell(1).value)).toBe('Metric');
  }, 30_000);
});
