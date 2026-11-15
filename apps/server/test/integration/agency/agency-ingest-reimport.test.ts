import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { DEFAULTS, insertAccount, insertTenant } from '../setup/factories.js';
import { insertAgencyCampaign } from './agency-factories.js';

/**
 * Check, then import, then fix and re-import (IM1–IM5, IM7), on real Postgres through the
 * real ingest service, screen, DNC lookup and roster hand-off. S3 is mocked at `storage/s3.js`.
 *
 * What it pins:
 *  - a check writes nothing (no contact, no chunk marker) and reports what the import then
 *    does, row for row, against the same roster (IM1);
 *  - a corrected file re-imported: rows already in the campaign are SKIPPED, never duplicated
 *    and never changed (IM3, B15); the fixed rows land; the counts add up;
 *  - a Do Not Call row no longer claims its duplicate key (IM4);
 *  - the campaign check reads the roster as it stood when the job began, so a file larger than
 *    one batch finds its own earlier rows as in-file duplicates, in the check and the import alike;
 *  - one live import per campaign (IM7), and one import per check.
 * Mutation-checked (see docs/status.md): a check that sends its chunks reds "writes nothing";
 * a screen that reports nothing as existing reds "never duplicates".
 */

const s3 = vi.hoisted(() => ({
  files: new Map<string, string>(),
  uploads: new Map<string, string>(),
}));

vi.mock('@magick-agency/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@magick-agency/db')>()),
  getPool: () => getTestPool(),
}));
vi.mock('@magick-agency/db/connection', () => ({ getPool: () => getTestPool() }));
vi.mock('../../../src/storage/s3.js', () => ({
  headFile: async (key: string) => ({ contentLength: Buffer.byteLength(s3.files.get(key) ?? '') }),
  getFileStream: async (key: string) => {
    const text = s3.files.get(key);
    if (text === undefined) throw Object.assign(new Error('The specified key does not exist.'), { name: 'NoSuchKey' });
    return { body: Readable.from([Buffer.from(text, 'utf8')]), contentLength: Buffer.byteLength(text) };
  },
  uploadFile: async (key: string, body: Buffer) => { s3.uploads.set(key, body.toString('utf8')); },
  isS3NotFound: (err: { name?: string }) => err?.name === 'NoSuchKey',
}));

const { agencyIngestService } = await import('../../../src/agency/agency-ingest.service.js');
const { agencyIngestJobRepository } = await import('../../../src/agency/agency-ingest-job.repository.js');
const { agencyRosterPresenceRepository } = await import('../../../src/db/repositories/agency.repository.js');
const { skippedExportKey, rejectedExportKey } = await import('../../../src/agency/agency-ingest-keys.js');

const TENANT = DEFAULTS.tenantId;
const ACCOUNT = DEFAULTS.accountId;
let campaignId: string;

const key = (name: string) => `agency-ingest/${TENANT}/u-${name}/${name}.csv`;

function file(name: string, lines: string[]): string {
  s3.files.set(key(name), lines.join('\n') + '\n');
  return key(name);
}

async function run(name: string, over: Record<string, unknown> = {}) {
  const job = await agencyIngestJobRepository.create({
    tenant_id: TENANT, account_id: ACCOUNT, campaign_id: campaignId, s3_key: key(name), file_name: `${name}.csv`,
    phone_column: 'Mobile', default_country_code: '91', ...over,
  });
  await agencyIngestService.run({ job, campaignId });
  const done = (await agencyIngestJobRepository.findById(job.id, TENANT))!;
  expect(done.status, done.error_message ?? '').toBe('completed');
  return {
    job: done,
    counts: {
      rows_read: Number(done.rows_read), accepted: Number(done.accepted), skipped: Number(done.skipped),
      rejected: Number(done.rejected), duplicates: Number(done.duplicates),
    },
  };
}

const contacts = async () =>
  (await getTestPool().query<{ phone_e164: string; context: Record<string, string>; updated_at: Date }>(
    'SELECT phone_e164, context, updated_at FROM agency_contacts WHERE campaign_id = $1 ORDER BY phone_e164, context::text',
    [campaignId],
  )).rows;

async function dnc(phone: string, scope: { account?: string; campaign?: string } = {}) {
  await getTestPool().query(
    `INSERT INTO dnc_entries (tenant_id, account_id, campaign_id, phone_e164, source) VALUES ($1, $2, $3, $4, 'import')`,
    [TENANT, scope.account ?? null, scope.campaign ?? null, phone],
  );
}

beforeEach(async () => {
  await truncateAll();
  s3.files.clear();
  s3.uploads.clear();
  await insertTenant({ id: TENANT });
  await insertAccount({ id: ACCOUNT, tenant_id: TENANT });
  campaignId = (await insertAgencyCampaign()).id as string;
});

afterAll(async () => {
  await closeTestPool();
});

// The operator's first file: two good rows, a bad number, a blank number, an in-file repeat,
// and a number on the account's Do Not Call list.
const FIRST = [
  'Name,Mobile,City',
  'Asha,9876500001,Pune',      // 2 imported
  'Bhim,98765-0000,Pune',      // 3 invalid
  'Chitra,,Nagpur',            // 4 empty number
  'Dev,9876500004,Mumbai',     // 5 imported
  'Asha twin,9876500001,Pune', // 6 duplicate of row 2
  'Esha,9876500006,Delhi',     // 7 Do Not Call (account)
];

describe('the check (IM1)', () => {
  it('writes nothing, and reports exactly what the import then does', async () => {
    await dnc('+919876500006', { account: ACCOUNT });
    file('first', FIRST);

    const check = await run('first', { dry_run: true });
    expect(await contacts()).toEqual([]);
    expect((await getTestPool().query('SELECT 1 FROM agency_ingest_chunks')).rows).toEqual([]);
    expect((await getTestPool().query('SELECT contacts_total FROM agency_campaigns WHERE id = $1', [campaignId])).rows[0])
      .toEqual({ contacts_total: 0 });

    const imported = await run('first');
    expect(check.counts).toEqual({ rows_read: 6, accepted: 2, skipped: 0, rejected: 4, duplicates: 1 });
    expect(imported.counts).toEqual(check.counts);
    expect(imported.job.rejected_by_reason).toEqual(check.job.rejected_by_reason);
    expect(check.job.dnc_by_scope).toEqual({ account: 1 });
    // The review screen's sample: in file order, with a reason that says how to fix the row.
    expect(check.job.rejected_sample!.map((r) => [r.row_number, r.reason_code])).toEqual([
      [3, 'invalid_phone'], [4, 'missing_phone_value'], [6, 'duplicate_phone'], [7, 'dnc_suppressed'],
    ]);
    expect(check.job.rejected_sample![1]!.reason).toBe("The 'Mobile' column is empty. Add the customer's phone number, or delete the row.");
    expect(check.job.rejected_sample![3]!.reason).toContain('for every campaign in this account');
    // The check's rejected-rows download is the one the operator fixes.
    expect(s3.uploads.get(rejectedExportKey(TENANT, check.job.id))).toContain('3,98765-0000,Bhim,Pune,');
    expect((await contacts()).map((c) => c.phone_e164)).toEqual(['+919876500001', '+919876500004']);
  });

  it('a check against a roster that already holds rows says they will be skipped, and the import skips them', async () => {
    file('first', FIRST);
    await run('first');
    const check = await run('first', { dry_run: true });
    const again = await run('first');
    // Asha, Dev and Esha (no Do Not Call entry here) were imported the first time; Asha's
    // repeat on row 6 is in the campaign too, so it is skipped rather than a duplicate.
    expect(check.counts).toEqual({ rows_read: 6, accepted: 0, skipped: 4, rejected: 2, duplicates: 0 });
    expect(again.counts).toEqual(check.counts);
  });

  it('a file over one batch: rows repeated in later batches are in-file duplicates in the check AND the import, never "already in the campaign"', async () => {
    const lines = ['Name,Mobile'];
    for (let i = 0; i < 700; i++) lines.push(`P${i},98700${String(i).padStart(5, '0')}`);
    for (let i = 0; i < 50; i++) lines.push(`Again ${i},98700${String(i).padStart(5, '0')}`); // rows 702..751, repeating rows 2..51
    file('big', lines);
    const check = await run('big', { dry_run: true });
    const imported = await run('big');
    expect(check.counts).toEqual({ rows_read: 750, accepted: 700, skipped: 0, rejected: 50, duplicates: 50 });
    expect(imported.counts).toEqual(check.counts);
    expect(await contacts()).toHaveLength(700);
  });
});

describe('fix and re-import (IM3)', () => {
  it('skips what is already in the campaign, imports the fixed rows, and changes nothing that was there', async () => {
    file('first', FIRST);
    await run('first');
    const before = await contacts();

    // The operator fixed rows 3 and 4 and edited Asha's city (a non-key column), and
    // re-uploaded the whole file.
    file('fixed', [
      'Name,Mobile,City',
      'Asha,9876500001,Pune West',  // already in (same number): skipped, NOT a second Asha
      'Bhim,9876500002,Pune',       // fixed: imported
      'Chitra,9876500003,Nagpur',   // fixed: imported
      'Dev,9876500004,Mumbai',      // already in: skipped
      'Asha twin,9876500001,Pune',  // that number is in the campaign: skipped too
    ]);
    const { job, counts } = await run('fixed');
    expect(counts).toEqual({ rows_read: 5, accepted: 2, skipped: 3, rejected: 0, duplicates: 0 });
    expect(counts.accepted + counts.skipped + counts.rejected).toBe(counts.rows_read);

    const after = await contacts();
    expect(after.map((c) => c.phone_e164)).toEqual(['+919876500001', '+919876500002', '+919876500003', '+919876500004', '+919876500006']);
    // Nothing already imported was changed: Asha keeps the city she was imported with.
    for (const old of before) {
      expect(after.find((c) => c.phone_e164 === old.phone_e164)).toEqual(old);
    }
    const skipped = s3.uploads.get(skippedExportKey(TENANT, job.id))!;
    expect(skipped.split('\n').slice(1, 3)).toEqual([
      '2,9876500001,Asha,Pune West,"Already in this campaign from an earlier import, so it was skipped. Nothing about that contact was changed."',
      '5,9876500004,Dev,Mumbai,"Already in this campaign from an earlier import, so it was skipped. Nothing about that contact was changed."',
    ]);
    expect(job.skipped_row_count).toBe(3);
  });

  it('on a column key: a loan already in the campaign is skipped even on a corrected number, and headers match whatever their case', async () => {
    file('loans', ['Name,Mobile,Loan No', 'Asha,9876500001,LN-1', 'Ravi,9876500002,LN-2']);
    await run('loans', { dedupe_columns: ['Loan No'] });
    file('loans2', ['Name,Mobile,loan no', 'Asha,9876599999,ln-1', 'Ravi,9876500002,LN-3', 'Sita,9876500003,']);
    const { counts } = await run('loans2', { dedupe_columns: ['loan no'] });
    // LN-1 is in (a new number does not make it a new loan), LN-3 is new, Sita has no loan
    // number (never a duplicate) and is not an exact copy of anything.
    expect(counts).toEqual({ rows_read: 3, accepted: 2, skipped: 1, rejected: 0, duplicates: 0 });
    expect(await contacts()).toHaveLength(4);
  });

  it('with no duplicate check, an exact copy of a contact is skipped and a changed row is imported', async () => {
    file('household', ['Name,Mobile', 'Asha,9876500001', 'Ravi,9876500001']);
    await run('household', { dedupe_phones: false });
    file('household2', ['Name,Mobile', 'Asha,9876500001', 'Sita,9876500001']);
    const { counts } = await run('household2', { dedupe_phones: false });
    expect(counts).toEqual({ rows_read: 2, accepted: 1, skipped: 1, rejected: 0, duplicates: 0 });
    expect((await contacts()).map((c) => c.context['Name'])).toEqual(['Asha', 'Ravi', 'Sita']);
  });

  it('every row whose key is in the campaign is skipped, a repeat in the file included', async () => {
    file('loans', ['Name,Mobile,Loan No', 'Asha,9876500001,LN-1']);
    await run('loans', { dedupe_columns: ['Loan No'] });
    file('loans2', ['Name,Mobile,Loan No', 'Asha,9876500001,LN-1', 'Asha again,9876500009,LN-1']);
    const { counts } = await run('loans2', { dedupe_columns: ['Loan No'] });
    expect(counts).toEqual({ rows_read: 2, accepted: 0, skipped: 2, rejected: 0, duplicates: 0 });
  });
});

describe('a Do Not Call row does not claim its key (IM4)', () => {
  it('the same loan on a callable number is imported, and a re-import skips it', async () => {
    await dnc('+919876500001');
    file('loans', ['Name,Mobile,Loan No', 'Asha,9876500001,LN-1', 'Asha (work),9876500002,LN-1']);
    const first = await run('loans', { dedupe_columns: ['Loan No'] });
    expect(first.counts).toEqual({ rows_read: 2, accepted: 1, skipped: 0, rejected: 1, duplicates: 0 });
    expect(first.job.dnc_by_scope).toEqual({ tenant: 1 });
    expect((await contacts()).map((c) => c.phone_e164)).toEqual(['+919876500002']);

    const again = await run('loans', { dedupe_columns: ['Loan No'] });
    // LN-1 is in the campaign now, so both rows are skipped: the Do Not Call row too, since
    // nothing about it would be imported either way and there is nothing to fix.
    expect(again.counts).toEqual({ rows_read: 2, accepted: 0, skipped: 2, rejected: 0, duplicates: 0 });
  });
});

describe('the roster reads', () => {
  it('pages the key parts newest first without repeating or missing a contact, and never past the job start', async () => {
    const lines = ['Name,Mobile,Loan No'];
    for (let i = 0; i < 25; i++) lines.push(`P${i},98710${String(i).padStart(5, '0')},LN-${i}`);
    file('loans', lines);
    const blank = { tenant_id: TENANT, account_id: ACCOUNT, campaign_id: campaignId, s3_key: key('x'), file_name: 'x.csv', phone_column: 'Mobile', dry_run: true };
    const earlier = await agencyIngestJobRepository.create(blank);
    await run('loans', { dedupe_columns: ['Loan No'] });
    const later = await agencyIngestJobRepository.create(blank);

    const seen: string[] = [];
    let after: { created_at: string; id: string } | null = null;
    for (;;) {
      const page = await agencyRosterPresenceRepository.keyPartsPage(campaignId, later.id, ['LOAN NO'], [false], after, 7);
      seen.push(...page.map((r) => r.parts[0]!));
      if (page.length < 7) break;
      after = { created_at: page[page.length - 1]!.created_at, id: page[page.length - 1]!.id };
    }
    expect(seen.sort()).toEqual(Array.from({ length: 25 }, (_, i) => `LN-${i}`).sort());
    // Bounded by the job: a job created before the contacts sees none of them.
    expect(await agencyRosterPresenceRepository.keyPartsPage(campaignId, earlier.id, ['Loan No'], [false], null, 7)).toEqual([]);
  });
});

describe('one import per campaign at a time (IM7), one import per check (IM2)', () => {
  const input = () => ({
    tenant_id: TENANT, account_id: ACCOUNT, campaign_id: campaignId, s3_key: key('x'), file_name: 'x.csv', phone_column: 'Mobile',
  });

  it('refuses a second live import, but not a check, and not after the first has finished', async () => {
    const first = await agencyIngestJobRepository.createExclusive(input());
    expect(first.outcome).toBe('created');
    const second = await agencyIngestJobRepository.createExclusive(input());
    expect(second).toMatchObject({ outcome: 'busy', live: { id: first.outcome === 'created' ? first.job.id : '' } });
    // A check writes nothing, so it runs beside anything.
    expect((await agencyIngestJobRepository.create({ ...input(), dry_run: true })).dry_run).toBe(true);

    await getTestPool().query(`UPDATE agency_ingest_jobs SET status = 'completed' WHERE dry_run = FALSE`);
    expect((await agencyIngestJobRepository.createExclusive(input())).outcome).toBe('created');
  });

  it('a live import orphaned by a restart (no heartbeat) does not block the campaign', async () => {
    await agencyIngestJobRepository.createExclusive(input());
    await getTestPool().query('ALTER TABLE agency_ingest_jobs DISABLE TRIGGER agency_ingest_jobs_updated_at');
    try {
      await getTestPool().query(`UPDATE agency_ingest_jobs SET status = 'running', updated_at = NOW() - INTERVAL '30 minutes'`);
    } finally {
      await getTestPool().query('ALTER TABLE agency_ingest_jobs ENABLE TRIGGER agency_ingest_jobs_updated_at');
    }
    expect((await agencyIngestJobRepository.createExclusive(input())).outcome).toBe('created');
  });

  it('two creates racing: exactly one is created', async () => {
    const results = await Promise.all(Array.from({ length: 6 }, () => agencyIngestJobRepository.createExclusive(input())));
    expect(results.filter((r) => r.outcome === 'created')).toHaveLength(1);
    expect(results.filter((r) => r.outcome === 'busy')).toHaveLength(5);
  });

  it('a check committed twice answers with the first import', async () => {
    const check = await agencyIngestJobRepository.create({ ...input(), dry_run: true });
    const first = await agencyIngestJobRepository.createExclusive({ ...input(), check_job_id: check.id });
    expect(first.outcome).toBe('created');
    await getTestPool().query(`UPDATE agency_ingest_jobs SET status = 'completed' WHERE dry_run = FALSE`);
    const second = await agencyIngestJobRepository.createExclusive({ ...input(), check_job_id: check.id });
    expect(second).toMatchObject({ outcome: 'already_imported', job: { id: first.outcome === 'created' ? first.job.id : '' } });
    // The unique index is the backstop for a commit into another campaign at the same instant.
    const other = (await insertAgencyCampaign()).id as string;
    await expect(agencyIngestJobRepository.create({ ...input(), campaign_id: other, check_job_id: check.id }))
      .rejects.toMatchObject({ code: '23505' });
    expect((await agencyIngestJobRepository.findImportOfCheck(check.id, TENANT, ACCOUNT))!.id)
      .toBe(first.outcome === 'created' ? first.job.id : '');
    expect(await agencyIngestJobRepository.findImportOfCheck(check.id, TENANT, (await insertAccount({ tenant_id: TENANT })).id)).toBeNull();
  });
});

describe('the stored upload is gone', () => {
  it('fails upload_missing with a sentence, and writes nothing', async () => {
    const job = await agencyIngestJobRepository.create({
      tenant_id: TENANT, account_id: ACCOUNT, campaign_id: campaignId, s3_key: key('gone'), file_name: 'gone.csv', phone_column: 'Mobile',
    });
    await agencyIngestService.run({ job, campaignId });
    const done = (await agencyIngestJobRepository.findById(job.id, TENANT))!;
    expect(done).toMatchObject({ status: 'failed', error_code: 'upload_missing', error_message: 'The uploaded file is no longer stored. Upload it again.' });
    expect(await contacts()).toEqual([]);
  });
});
