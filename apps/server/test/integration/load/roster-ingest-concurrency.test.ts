import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ─── Roster imports racing each other while the floor reads the roster ──────────
 *
 * Supervisors upload CSVs through the real multipart route (`POST /proxy/agency/ingest/upload`)
 * and start imports (`POST /proxy/agency/ingest/jobs`) all at once — the same file several
 * times into one campaign (a double-submitted wizard, two supervisors), different files into
 * one campaign, and different files into many campaigns of two tenants — while dashboard
 * reads of the same campaigns keep running. The import runs detached, as in production; the
 * suite polls `GET /proxy/agency/ingest/jobs/:id` like the wizard. S3 is mocked at its module
 * boundary (`storage/s3.js`); Postgres, the DNC filter, the roster hand-off and its
 * idempotency keys are real.
 *
 * What it pins:
 *  1. K concurrent imports of one file into one campaign: every job completes, the roster
 *     holds each person exactly once (the row fingerprint), and the jobs' own accounting
 *     adds up — every job accepted the file's valid rows, and the roster refused the
 *     duplicates of all but one.
 *  2. Different files into one campaign, and files into many campaigns across two tenants,
 *     all at once: every campaign holds exactly its files' rows, on its own tenant and
 *     account, and the reads made meanwhile never 5xx, never see a total above the final
 *     one, and never go backwards.
 *  3. A re-sent chunk is refused by its idempotency key however many copies race: one
 *     write, every other copy `duplicate_chunk`, nothing added.
 * Mutation-checked: inserting contacts without their `row_fingerprint` reds case 1 (4 800
 * rows for 1 200 people); turning the chunk marker's `ON CONFLICT … DO NOTHING` into an
 * update (`contact.repository.ts`) reds case 3.
 */

const s3 = vi.hoisted(() => ({ files: new Map<string, Buffer>() }));
const mocks = vi.hoisted(() => ({ verifyIdToken: vi.fn() }));
vi.mock('../../../src/auth/firebase.js', () => ({ initFirebase: vi.fn(), verifyIdToken: mocks.verifyIdToken }));
vi.mock('../../../src/storage/s3.js', async () => {
  const { Readable } = await import('node:stream');
  const read = (key: string) => {
    const file = s3.files.get(key);
    if (!file) throw new Error('NoSuchKey');
    return file;
  };
  return {
    uploadFile: async (key: string, body: Buffer) => { s3.files.set(key, Buffer.from(body)); },
    getFile: async (key: string) => read(key),
    headFile: async (key: string) => ({ contentLength: read(key).length }),
    getFileStream: async (key: string) => ({ body: Readable.from([read(key)]), contentLength: read(key).length }),
  };
});

import { getTestPool, truncateAll } from '../../../../../packages/db/test/helpers/test-db.js';
import { createRng, scaled } from '../../helpers/load-scale.js';
import { sendRosterChunk, rosterChunkKey } from '../../../src/agency/agency-roster.client.js';
import {
  call, expectHealthy, headersFor, scalar, seedFloor, startLoadApp, stopLoadApp, verifyTestToken,
  type LoadApp, type TenantFloor,
} from './load-harness.js';

const rng = createRng();
const ROWS = scaled(1_200); // > 2 chunks of ROSTER_CHUNK_SIZE (500)
const COPIES = 4;

let loaded: LoadApp;
let floors: TenantFloor[];
const app = () => loaded.app;

beforeAll(async () => {
  console.log(`[roster-ingest-concurrency] seed=${rng.seed} rows=${ROWS} copies=${COPIES}`);
  mocks.verifyIdToken.mockImplementation(verifyTestToken);
  loaded = await startLoadApp({ configure: (c) => ({ ...c, rateLimit: { ...c.rateLimit, max: 1_000_000 } }) });
});

beforeEach(async () => {
  await truncateAll();
  s3.files.clear();
  floors = await seedFloor({ tenants: 2, agentsPerTenant: 0, supervisorsPerTenant: 2, campaignsPerTenant: 3 });
});

afterAll(async () => {
  await stopLoadApp(loaded);
});

/**
 * A roster: `rows` valid people with distinct numbers from `base`, plus three invalid rows
 * and two in-file repeats, in a seeded order. Returns the CSV and its valid phone count.
 */
function roster(base: number, rows: number): { csv: string; valid: number } {
  const lines = Array.from({ length: rows }, (_, i) => `Person ${base + i},98${String(base + i).padStart(8, '0')}`);
  lines.push('Bad One,not-a-number', 'Bad Two,12', 'Bad Three,');
  lines.push(lines[0]!, lines[1]!);
  return { csv: ['Name,Mobile', ...rng.shuffle(lines)].join('\n'), valid: rows };
}

async function upload(f: TenantFloor, csv: string, name = 'roster.csv'): Promise<string> {
  const boundary = `----load${rng.int(1, 1e9)}`;
  const body = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: text/csv\r\n\r\n${csv}\r\n--${boundary}--\r\n`;
  const res = await app().inject({
    method: 'POST', url: '/proxy/agency/ingest/upload',
    headers: { ...headersFor(f.supervisors[0]!, f), 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: body,
  });
  expectHealthy(res, 'upload');
  expect(res.statusCode, res.body).toBe(201);
  return res.json().s3_key as string;
}

async function startJob(f: TenantFloor, s3Key: string, campaign: string, who = 0): Promise<string> {
  const res = await call(app(), 'POST', '/proxy/agency/ingest/jobs', f.supervisors[who]!, f, {
    s3_key: s3Key, file_name: 'roster.csv', phone_column: 'Mobile', default_country_code: '91', campaign_id: campaign,
  });
  expectHealthy(res, 'start job');
  expect(res.statusCode, res.body).toBe(202);
  return res.json().job_id as string;
}

/** Poll like the wizard until the job is terminal. */
async function settle(f: TenantFloor, jobId: string) {
  const deadline = Date.now() + 45_000;
  for (;;) {
    const res = await call(app(), 'GET', `/proxy/agency/ingest/jobs/${jobId}`, f.supervisors[1]!, f);
    expectHealthy(res, 'poll');
    expect(res.statusCode, res.body).toBe(200);
    const job = res.json();
    if (['completed', 'failed', 'cancelled'].includes(job.status)) return job;
    if (Date.now() > deadline) throw new Error(`job ${jobId} still ${job.status}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** Dashboard reads of `campaign` until `done()`; returns the contacts_total series it saw. */
async function readWhile(f: TenantFloor, campaign: string, done: () => boolean): Promise<number[]> {
  const totals: number[] = [];
  while (!done()) {
    const stats = await call(app(), 'GET', `/proxy/agency/campaigns/${campaign}/stats`, f.supervisors[1]!, f);
    expectHealthy(stats, 'stats during import');
    expect(stats.statusCode, stats.body).toBe(200);
    totals.push(stats.json().contacts_total as number);
    const list = await call(app(), 'GET', `/proxy/agency/campaigns/${campaign}/contacts?limit=50`, f.supervisors[0]!, f);
    expectHealthy(list, 'contacts during import');
    expect(list.statusCode, list.body).toBe(200);
  }
  return totals;
}

const contactsIn = (campaign: string) => scalar('SELECT count(*)::int AS n FROM agency_contacts WHERE campaign_id = $1', [campaign]);
const distinctPhonesIn = (campaign: string) =>
  scalar('SELECT count(DISTINCT phone_e164)::int AS n FROM agency_contacts WHERE campaign_id = $1', [campaign]);

function expectNonDecreasingUpTo(series: number[], max: number, label: string) {
  for (let i = 1; i < series.length; i++) expect(series[i]!, `${label}: went backwards`).toBeGreaterThanOrEqual(series[i - 1]!);
  for (const v of series) expect(v, `${label}: above the final total`).toBeLessThanOrEqual(max);
}

describe('concurrent roster imports (integration, load)', () => {
  it('1. one file imported K times at once into one campaign: each person once, the accounting adds up', async () => {
    const f = floors[0]!;
    const campaign = f.campaigns[0]!;
    const { csv, valid } = roster(1, ROWS);
    const key = await upload(f, csv);

    let finished = false;
    const reads = readWhile(f, campaign, () => finished);
    const jobIds = await Promise.all(Array.from({ length: COPIES }, (_, i) => startJob(f, key, campaign, i % 2)));
    const jobs = await Promise.all(jobIds.map((id) => settle(f, id)));
    finished = true;
    const totals = await reads;

    for (const job of jobs) expect(job, JSON.stringify(job)).toMatchObject({ status: 'completed', accepted: valid, rows_read: valid + 5 });
    expect(await contactsIn(campaign)).toBe(valid);
    expect(await distinctPhonesIn(campaign)).toBe(valid);
    const refused = await scalar(
      'SELECT COALESCE(sum(core_rejected_duplicate_rows), 0)::int AS n FROM agency_ingest_jobs WHERE id = ANY($1::uuid[])', [jobIds]);
    expect(refused).toBe((COPIES - 1) * valid);
    expectNonDecreasingUpTo(totals, valid, 'contacts_total');
  }, 60_000);

  it('2. different files into one campaign and into many campaigns across two tenants, all at once: totals exact', async () => {
    // Per campaign: the files it receives and the rows it should end with.
    const plan: Array<{ f: TenantFloor; campaign: string; files: Array<{ key: string; valid: number }>; expected: number }> = [];
    let base = 1;
    for (const f of floors) {
      for (const [ci, campaign] of f.campaigns.entries()) {
        const count = ci === 0 ? 3 : 1; // the first campaign of each tenant takes three different files
        const files: Array<{ key: string; valid: number }> = [];
        for (let k = 0; k < count; k++) {
          const rows = Math.max(1, Math.floor(ROWS / 2) + rng.int(0, 50));
          const r = roster(base, rows);
          base += rows;
          files.push({ key: await upload(f, r.csv, `roster-${ci}-${k}.csv`), valid: r.valid });
        }
        plan.push({ f, campaign, files, expected: files.reduce((a, b) => a + b.valid, 0) });
      }
    }

    let finished = false;
    const reads = plan.filter((_, i) => i % 3 === 0).map((p) => readWhile(p.f, p.campaign, () => finished).then((t) => ({ p, t })));
    const started = await Promise.all(rng.shuffle(plan.flatMap((p) => p.files.map((file) => ({ p, file }))))
      .map(async ({ p, file }) => ({ p, file, id: await startJob(p.f, file.key, p.campaign) })));
    const jobs = await Promise.all(started.map(async (s) => ({ ...s, job: await settle(s.p.f, s.id) })));
    finished = true;
    const series = await Promise.all(reads);

    for (const { file, job } of jobs) expect(job, JSON.stringify(job)).toMatchObject({ status: 'completed', accepted: file.valid });
    for (const p of plan) {
      expect(await contactsIn(p.campaign), `campaign ${p.campaign}`).toBe(p.expected);
      expect(await distinctPhonesIn(p.campaign)).toBe(p.expected);
      expect(await scalar(
        'SELECT count(*)::int AS n FROM agency_contacts WHERE campaign_id = $1 AND (tenant_id <> $2 OR account_id <> $3)',
        [p.campaign, p.f.tenant, p.f.account])).toBe(0);
    }
    for (const { p, t } of series) expectNonDecreasingUpTo(t, p.expected, `contacts_total ${p.campaign}`);
    expect(await scalar('SELECT count(*)::int AS n FROM agency_contacts')).toBe(plan.reduce((a, p) => a + p.expected, 0));
  }, 60_000);

  it('3. a re-sent chunk is refused by its idempotency key however many copies race', async () => {
    const f = floors[0]!;
    const campaign = f.campaigns[0]!;
    const { csv, valid } = roster(1, 50);
    const jobId = await startJob(f, await upload(f, csv), campaign);
    await settle(f, jobId);
    expect(await contactsIn(campaign)).toBe(valid);

    const copies = await Promise.all(Array.from({ length: 8 }, () => sendRosterChunk({
      campaignId: campaign, tenantId: f.tenant, accountId: f.account, ingestJobId: jobId, chunkIndex: 0, isFinal: false,
      contacts: [{ phone_e164: '+919990000001', context: { Name: 'Late' }, source_row_number: 9_999 }],
    })));
    for (const r of copies) expect(r).toMatchObject({ duplicate_chunk: true, accepted: 0 });
    expect(await contactsIn(campaign)).toBe(valid);

    // A NEW key racing itself: exactly one copy writes.
    const fresh = await Promise.all(Array.from({ length: 8 }, () => sendRosterChunk({
      campaignId: campaign, tenantId: f.tenant, accountId: f.account, ingestJobId: jobId, chunkIndex: 7, isFinal: false,
      contacts: [{ phone_e164: '+919990000002', context: { Name: 'Racer' }, source_row_number: 10_000 }],
    })));
    expect(fresh.filter((r) => !r.duplicate_chunk)).toHaveLength(1);
    expect(fresh.reduce((a, r) => a + r.accepted, 0)).toBe(1);
    expect(await contactsIn(campaign)).toBe(valid + 1);
    expect(await scalar('SELECT count(*)::int AS n FROM agency_ingest_chunks WHERE idempotency_key = $1', [rosterChunkKey(jobId, 7)])).toBe(1);
  });
});
