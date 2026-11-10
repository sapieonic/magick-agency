import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { DEFAULTS, insertAccount, insertTenant } from '../setup/factories.js';
import { insertAgencyCampaign } from './agency-factories.js';

const s3 = vi.hoisted(() => ({
  files: new Map<string, string>(),
  uploads: new Map<string, string>(),
}));

vi.mock('@magick-agency/db', () => ({ getPool: () => getTestPool() }));
vi.mock('@magick-agency/db/connection', () => ({ getPool: () => getTestPool() }));
// S3 is mocked at the module boundary, as the brief requires; everything else is real.
vi.mock('../../../src/storage/s3.js', () => ({
  headFile: async (key: string) => ({ contentLength: Buffer.byteLength(s3.files.get(key) ?? '') }),
  getFileStream: async (key: string) => {
    const text = s3.files.get(key);
    if (text === undefined) throw new Error('NoSuchKey');
    return { body: Readable.from([Buffer.from(text, 'utf8')]), contentLength: Buffer.byteLength(text) };
  },
  uploadFile: async (key: string, body: Buffer) => { s3.uploads.set(key, body.toString('utf8')); },
}));

const { agencyIngestService } = await import('../../../src/agency/agency-ingest.service.js');
const { agencyIngestJobRepository } = await import('../../../src/agency/agency-ingest-job.repository.js');
const { sendRosterChunk, rosterChunkKey } = await import('../../../src/agency/agency-roster.client.js');
const { rejectedExportKey } = await import('../../../src/agency/agency-ingest-keys.js');

/**
 * The exit-gate round trip: CSV → parse → DNC filter (all three scopes, the
 * real `dncService.filterSuppressed`) → roster chunks into `agency_contacts` through the
 * in-process hand-off → the rejected-rows CSV, idempotent on a re-sent chunk (`rosterChunkKey`).
 * Postgres is real; S3 is mocked at `storage/s3.js`.
 */

const TENANT = DEFAULTS.tenantId;
const ACCOUNT = DEFAULTS.accountId;
const KEY = `agency-ingest/${TENANT}/u1/roster.csv`;

const CSV = [
  'Name,Mobile',
  'Asha,9876543001',          // 2  accepted
  'Bhim,+919876543002',       // 3  tenant-wide DNC
  'Chitra,9876543003',        // 4  account-scoped DNC
  'Dev,9876543004',           // 5  campaign-scoped DNC
  'Esha,9876543005',          // 6  accepted: DNC exists for a DIFFERENT account
  'Farid,9876543006',         // 7  accepted: DNC exists for a DIFFERENT campaign
  'Gita,9876543007',          // 8  accepted: DNC exists for a DIFFERENT tenant
  'Hari,not-a-number',        // 9  invalid phone
  'Asha again,9876543001',    // 10 in-file duplicate
  '',
].join('\n');

let campaignId: string;

async function dnc(over: { tenant?: string; account?: string | null; campaign?: string | null; phone: string }) {
  await getTestPool().query(
    `INSERT INTO dnc_entries (tenant_id, account_id, campaign_id, phone_e164, source)
     VALUES ($1, $2, $3, $4, 'import')`,
    [over.tenant ?? TENANT, over.account ?? null, over.campaign ?? null, over.phone],
  );
}

async function newJob(over: Record<string, unknown> = {}) {
  return agencyIngestJobRepository.create({
    tenant_id: TENANT, account_id: ACCOUNT, campaign_id: campaignId, s3_key: KEY, file_name: 'roster.csv',
    phone_column: 'Mobile', default_country_code: '91', ...over,
  });
}

const contactPhones = async () =>
  (await getTestPool().query<{ phone_e164: string }>(
    'SELECT phone_e164 FROM agency_contacts WHERE campaign_id = $1 ORDER BY phone_e164', [campaignId],
  )).rows.map((r) => r.phone_e164);

beforeEach(async () => {
  await truncateAll();
  s3.files.clear();
  s3.uploads.clear();
  s3.files.set(KEY, CSV);
  await insertTenant({ id: TENANT });
  await insertAccount({ id: ACCOUNT, tenant_id: TENANT });
  campaignId = (await insertAgencyCampaign()).id as string;

  const otherAccount = (await insertAccount({ tenant_id: TENANT })).id;
  const otherTenant = (await insertTenant()).id;
  await dnc({ phone: '+919876543002' });                                       // tenant-wide
  await dnc({ phone: '+919876543003', account: ACCOUNT });                     // this account
  await dnc({ phone: '+919876543004', campaign: campaignId });                 // this campaign
  await dnc({ phone: '+919876543005', account: otherAccount });                // another account
  await dnc({ phone: '+919876543006', campaign: randomUUID() });               // another campaign
  await dnc({ phone: '+919876543007', tenant: otherTenant });                  // another tenant
});

afterAll(async () => {
  await closeTestPool();
});

describe('agency ingest round trip on real Postgres', () => {
  it('filters all three DNC scopes, lands the rest in agency_contacts and writes the rejected-rows CSV', async () => {
    const job = await newJob();
    await agencyIngestService.run({ job, campaignId });

    const done = (await agencyIngestJobRepository.findById(job.id, TENANT))!;
    expect(done).toMatchObject({ status: 'completed', error_code: null });
    expect(Number(done.rows_read)).toBe(9);
    expect(Number(done.accepted)).toBe(4);
    expect(Number(done.rejected)).toBe(5);
    expect(Number(done.duplicates)).toBe(1);
    expect(done.rejected_by_reason).toMatchObject({ dnc_suppressed: 3, invalid_phone: 1 });
    expect(Number(done.core_rejected_duplicate_rows)).toBe(0);
    expect(done.chunks_sent).toBe(1);

    // Only the four dialable numbers reached the roster; suppressed numbers never did.
    expect(await contactPhones()).toEqual(['+919876543001', '+919876543005', '+919876543006', '+919876543007']);

    // The rejected-rows CSV exists under the shared key shape and names every refusal.
    const rejectedKey = rejectedExportKey(TENANT, job.id);
    expect(done.rejected_s3_key).toBe(rejectedKey);
    const csv = s3.uploads.get(rejectedKey)!;
    expect(csv.split('\n')[0]).toBe('_row,Mobile,Name,_reason');
    expect(csv.match(/On the Do Not Call list/g)).toHaveLength(3);
    expect(csv).toContain("'not-a-number' is not a valid phone number.");
    expect(csv).toContain('already appears earlier in this file');
    for (const phone of ['+919876543002', '+919876543003', '+919876543004', 'not-a-number']) {
      expect(csv).toContain(phone);
    }
    expect(csv).not.toContain('+919876543005');
  });

  it('is idempotent on a re-sent chunk: the same job and chunk key adds nothing', async () => {
    const job = await newJob();
    await agencyIngestService.run({ job, campaignId });
    const before = await contactPhones();

    const replay = await sendRosterChunk({
      campaignId, tenantId: TENANT, accountId: ACCOUNT, ingestJobId: job.id, chunkIndex: 0, isFinal: false,
      contacts: [{ phone_e164: '+919990000001', context: { Name: 'Late' }, source_row_number: 99 }],
    });

    expect(replay).toMatchObject({ duplicate_chunk: true, accepted: 0 });
    expect(await contactPhones()).toEqual(before);
    const { rows } = await getTestPool().query<{ idempotency_key: string }>(
      'SELECT idempotency_key FROM agency_ingest_chunks WHERE campaign_id = $1', [campaignId],
    );
    // Chunk 0 carries the rows; chunk 1 is the empty final chunk that reports completeness.
    expect(rows.map((r) => r.idempotency_key).sort()).toEqual([rosterChunkKey(job.id, 0), rosterChunkKey(job.id, 1)]);
  });

  it('a second upload of the same file under a new job adds no duplicate people and reports what the roster refused', async () => {
    await agencyIngestService.run({ job: await newJob(), campaignId });
    const again = await newJob();
    await agencyIngestService.run({ job: again, campaignId });

    expect(await contactPhones()).toHaveLength(4);
    const done = (await agencyIngestJobRepository.findById(again.id, TENANT))!;
    expect(done.status).toBe('completed');
    expect(Number(done.accepted)).toBe(4); // the operator's file still had four dialable rows
    expect(Number(done.core_rejected_duplicate_rows)).toBe(4); // and the roster refused all four verbatim repeats
  });

  describe('duplicates on a chosen column, through to agency_contacts', () => {
    // One borrower with two loans (rows 2 and 3), and a loan number repeated on another number (row 4).
    const LOANS_KEY = `agency-ingest/${TENANT}/u1/loans.csv`;
    const LOANS = [
      'Name,Mobile,Loan No',
      'Asha,9876543101,LN-001',
      'Asha,+919876543101,LN-002',
      'Ravi,9876543102,ln-001',
      '',
    ].join('\n');
    const loansOn = async (phone: string) =>
      (await getTestPool().query<{ loan: string }>(
        `SELECT context->>'Loan No' AS loan FROM agency_contacts WHERE campaign_id = $1 AND phone_e164 = $2 ORDER BY 1`,
        [campaignId, phone],
      )).rows.map((r) => r.loan);

    beforeEach(() => { s3.files.set(LOANS_KEY, LOANS); });

    it('deduped on the loan number: both loans on one number become contacts; the repeated loan is rejected and named', async () => {
      const job = await newJob({ s3_key: LOANS_KEY, file_name: 'loans.csv', dedupe_columns: ['Loan No'] });
      await agencyIngestService.run({ job, campaignId });

      const done = (await agencyIngestJobRepository.findById(job.id, TENANT))!;
      expect(done).toMatchObject({ status: 'completed', dedupe_columns: ['Loan No'], rejected_by_reason: { duplicate_key: 1 } });
      expect([done.rows_read, done.accepted, done.rejected, done.duplicates, done.core_rejected_duplicate_rows])
        .toEqual(['3', '2', '1', '1', '0']);
      expect(await loansOn('+919876543101')).toEqual(['LN-001', 'LN-002']);
      expect(await loansOn('+919876543102')).toEqual([]);

      const csv = s3.uploads.get(rejectedExportKey(TENANT, job.id))!;
      expect(csv).toContain('4,9876543102,Ravi,ln-001,Duplicate Loan No of an earlier row in this file.');
    });

    it('the same file deduped on the phone keeps one contact per number, as before', async () => {
      const job = await newJob({ s3_key: LOANS_KEY, file_name: 'loans.csv' });
      await agencyIngestService.run({ job, campaignId });

      const done = (await agencyIngestJobRepository.findById(job.id, TENANT))!;
      expect(done).toMatchObject({ status: 'completed', dedupe_columns: null, rejected_by_reason: { duplicate_phone: 1 } });
      expect(await loansOn('+919876543101')).toEqual(['LN-001']);
      expect(await loansOn('+919876543102')).toEqual(['ln-001']);
    });

    it('deduped on loan number + name: every row differs in one of them, so all three become contacts', async () => {
      const job = await newJob({ s3_key: LOANS_KEY, file_name: 'loans.csv', dedupe_columns: ['Loan No', 'Name'] });
      await agencyIngestService.run({ job, campaignId });

      const done = (await agencyIngestJobRepository.findById(job.id, TENANT))!;
      expect(done).toMatchObject({ status: 'completed', dedupe_columns: ['Loan No', 'Name'], rejected_by_reason: {} });
      expect([done.rows_read, done.accepted, done.rejected, done.duplicates]).toEqual(['3', '3', '0', '0']);
      expect(await loansOn('+919876543101')).toEqual(['LN-001', 'LN-002']);
      expect(await loansOn('+919876543102')).toEqual(['ln-001']);
    });
  });

  it('a dry run parses and filters but writes no contacts and no chunk markers', async () => {
    const job = await newJob({ dry_run: true });
    await agencyIngestService.run({ job, campaignId });

    expect(await contactPhones()).toEqual([]);
    const done = (await agencyIngestJobRepository.findById(job.id, TENANT))!;
    expect(done.status).toBe('completed');
    expect(Number(done.accepted)).toBe(4);
    const chunks = await getTestPool().query('SELECT 1 FROM agency_ingest_chunks');
    expect(chunks.rows).toHaveLength(0);
  });

  it('fails closed when the DNC list cannot be read: nothing is sent', async () => {
    const job = await newJob();
    // Break only the DNC table's read: the roster insert path never touches it.
    await getTestPool().query('ALTER TABLE dnc_entries RENAME TO dnc_entries_broken');
    try {
      await agencyIngestService.run({ job, campaignId });
    } finally {
      await getTestPool().query('ALTER TABLE dnc_entries_broken RENAME TO dnc_entries');
    }

    const done = (await agencyIngestJobRepository.findById(job.id, TENANT))!;
    expect(done.status).toBe('failed');
    expect(await contactPhones()).toEqual([]);
  });

  it('replace mode keeps failing `replace_unsupported` and touches nothing (decision B15)', async () => {
    await agencyIngestService.run({ job: await newJob(), campaignId });
    const before = await contactPhones();

    const job = await newJob({ mode: 'replace' });
    await agencyIngestService.run({ job, campaignId, expectedContactsTotal: before.length });

    const done = (await agencyIngestJobRepository.findById(job.id, TENANT))!;
    expect(done).toMatchObject({ status: 'failed', error_code: 'replace_unsupported' });
    expect(done.error_message).toContain('your existing contacts were not touched');
    expect(await contactPhones()).toEqual(before);
  });

  it('refuses a campaign that belongs to another account: the hand-off 404s and the job fails core_rejected_chunk', async () => {
    const otherAccount = (await insertAccount({ tenant_id: TENANT })).id;
    const job = await newJob({ account_id: otherAccount });
    await agencyIngestService.run({ job, campaignId });

    const done = (await agencyIngestJobRepository.findById(job.id, TENANT))!;
    expect(done).toMatchObject({ status: 'failed', error_code: 'core_rejected_chunk' });
    expect(await contactPhones()).toEqual([]);
  });
});

describe('the activity log records how a committed upload ended (IN8)', () => {
  const uploadRows = async () => {
    const { platformAuditLogger } = await import('../../../src/audit/platform/audit-logger.js');
    await platformAuditLogger.shutdown();
    return (await getTestPool().query<{ action: string; actor_type: string; user_id: string | null; details: Record<string, unknown> }>(
      `SELECT action, actor_type, user_id, details FROM platform_audit_log
        WHERE campaign_id = $1 AND action LIKE 'agency_campaign.roster_upload_%' ORDER BY created_at`,
      [campaignId],
    )).rows;
  };

  it('a completed import writes one completed row with its counts, from the system actor', async () => {
    const job = await newJob();
    await agencyIngestService.run({ job, campaignId });

    expect(await uploadRows()).toEqual([{
      action: 'agency_campaign.roster_upload_completed',
      actor_type: 'system',
      user_id: null,
      details: {
        campaign_id: campaignId, job_id: job.id, file_name: 'roster.csv', mode: 'append',
        status: 'completed', rows_read: 9, accepted: 4, rejected: 5, duplicates: 1,
      },
    }]);
  });

  it('a failed import writes one failed row naming the failure', async () => {
    const job = await newJob();
    await getTestPool().query('ALTER TABLE dnc_entries RENAME TO dnc_entries_broken');
    try {
      await agencyIngestService.run({ job, campaignId });
    } finally {
      await getTestPool().query('ALTER TABLE dnc_entries_broken RENAME TO dnc_entries');
    }

    const rows = await uploadRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'agency_campaign.roster_upload_failed',
      details: { job_id: job.id, status: 'failed', error_code: 'dnc_unavailable', accepted: 0 },
    });
  });

  it('a dry run writes nothing', async () => {
    await agencyIngestService.run({ job: await newJob({ dry_run: true }), campaignId });
    expect(await uploadRows()).toEqual([]);
  });

  it('a job the stale-job reaper fails writes one failed row (its run never returns to write it)', async () => {
    const { AGENCY_INGEST_JOB_STALE_MINUTES } = await import('../../../src/agency/agency-ingest-job.repository.js');
    const orphan = await newJob();
    const live = await newJob();
    const preview = await newJob({ dry_run: true });
    // Orphaned: its process died mid-run, so its heartbeat aged. The updated_at trigger rewrites
    // the column on UPDATE, so age the rows with it off.
    await getTestPool().query('ALTER TABLE agency_ingest_jobs DISABLE TRIGGER agency_ingest_jobs_updated_at');
    try {
      await getTestPool().query(
        `UPDATE agency_ingest_jobs SET status = 'running', updated_at = NOW() - make_interval(mins => $3::int)
          WHERE id IN ($1, $2)`,
        [orphan.id, preview.id, AGENCY_INGEST_JOB_STALE_MINUTES + 5]);
    } finally {
      await getTestPool().query('ALTER TABLE agency_ingest_jobs ENABLE TRIGGER agency_ingest_jobs_updated_at');
    }

    expect(await agencyIngestJobRepository.reapStaleJobs()).toBe(2);

    // One row: the committed orphan's. The live job is untouched, the reaped preview writes none.
    expect(await uploadRows()).toEqual([{
      action: 'agency_campaign.roster_upload_failed',
      actor_type: 'system',
      user_id: null,
      details: {
        campaign_id: campaignId, job_id: orphan.id, file_name: 'roster.csv', mode: 'append',
        status: 'failed', rows_read: 0, accepted: 0, rejected: 0, duplicates: 0, error_code: 'interrupted',
      },
    }]);
    expect((await agencyIngestJobRepository.findById(live.id, TENANT))!.status).toBe('pending');
  });
});
