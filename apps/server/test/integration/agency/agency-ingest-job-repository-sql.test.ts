import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { insertAccount, insertTenant } from '../setup/factories.js';

vi.mock('@magick-agency/db', () => ({ getPool: () => getTestPool() }));
const { agencyIngestJobRepository: repo, AGENCY_INGEST_JOB_STALE_MINUTES } = await import(
  '../../../src/agency/agency-ingest-job.repository.js'
);

/**
 * Every method of `AgencyIngestJobRepository` against REAL Postgres (a mocked-pool suite
 * cannot see a statement the baseline cannot run — a wrong column, an untyped parameter
 * used in two contexts).
 * `agency-ingest-job.repository.test.ts` (the mocked suite) and
 * `repositories/agency-ingest-job-account-scope.test.ts` stay as they were; this file adds the
 * rows-come-back-right half.
 */

let tenantId: string;
let accountId: string;

const PROGRESS = {
  rows_read: 120, accepted: 100, rejected: 20, duplicates: 4, bytes_read: 4096, chunks_sent: 1,
  core_rejected_duplicate_rows: 7, core_duplicate_source_rows: [2, 9, 11],
  core_rejected_duplicate_rows_may_undercount: true,
};

async function create(over: Partial<Parameters<typeof repo.create>[0]> = {}) {
  return repo.create({
    tenant_id: tenantId, account_id: accountId, campaign_id: randomUUID(),
    s3_key: `agency-ingest/${tenantId}/u/roster.csv`, file_name: 'roster.csv', phone_column: 'Mobile',
    ...over,
  });
}

async function row(id: string) {
  const { rows } = await getTestPool().query('SELECT * FROM agency_ingest_jobs WHERE id = $1', [id]);
  return rows[0]!;
}

beforeEach(async () => {
  await truncateAll();
  tenantId = (await insertTenant()).id;
  accountId = (await insertAccount({ tenant_id: tenantId })).id;
});

afterAll(async () => {
  await closeTestPool();
});

describe('AgencyIngestJobRepository on real Postgres', () => {
  it('create: an unqualified create is a pending, deduping, non-dry-run append', async () => {
    const job = await create({ ignore_columns: ['Notes'], default_country_code: '1', created_by: 'user-9', file_size_bytes: 42 });

    expect(job).toMatchObject({
      tenant_id: tenantId, account_id: accountId, status: 'pending', dedupe_phones: true, dry_run: false,
      mode: 'append', ignore_columns: ['Notes'], default_country_code: '1', created_by: 'user-9',
      cancel_requested: false, rows_read: '0', replace_superseded_contacts: null,
      replace_superseded_uncertain: false, core_rejected_duplicate_rows_may_undercount: false,
    });
    expect(job.file_size_bytes).toBe('42');
  });

  it('create: mode replace takes the optional $14 column; dry_run and dedupe_phones=false are kept', async () => {
    const job = await create({ mode: 'replace', dry_run: true, dedupe_phones: false, account_id: null });

    expect(job).toMatchObject({ mode: 'replace', dry_run: true, dedupe_phones: false, account_id: null });
  });

  it('the baseline CHECK refuses an unrecognised mode (create itself only ever writes `replace`)', async () => {
    const job = await create();
    await expect(
      getTestPool().query(`UPDATE agency_ingest_jobs SET mode = 'merge' WHERE id = $1`, [job.id]),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('recordReplaceSuperseded / recordReplaceUncertain write the two replace columns', async () => {
    const job = await create({ mode: 'replace' });
    await repo.recordReplaceSuperseded(job.id, 5000);
    await repo.recordReplaceUncertain(job.id);

    const r = await row(job.id);
    expect(r.replace_superseded_contacts).toBe('5000');
    expect(r.replace_superseded_uncertain).toBe(true);
  });

  it('findById: tenant scoped, optionally account scoped', async () => {
    const job = await create();
    expect((await repo.findById(job.id, tenantId))?.id).toBe(job.id);
    expect((await repo.findById(job.id, tenantId, accountId))?.id).toBe(job.id);
    expect(await repo.findById(job.id, randomUUID())).toBeNull();
    expect(await repo.findById(job.id, tenantId, randomUUID())).toBeNull();
  });

  it('markRunning: sets running, keeps the first started_at, and COALESCEs the size', async () => {
    const job = await create({ file_size_bytes: 10 });
    await repo.markRunning(job.id, null, 999);
    const first = await row(job.id);
    expect(first).toMatchObject({ status: 'running', chunks_total: null, file_size_bytes: '999' });
    expect(first.started_at).toBeInstanceOf(Date);

    await repo.markRunning(job.id, 4);
    const second = await row(job.id);
    expect(second.chunks_total).toBe(4);
    expect(second.file_size_bytes).toBe('999');
    expect(second.started_at).toEqual(first.started_at);
  });

  it('updateProgress: writes counters, the rejection fields and the undercount bit', async () => {
    const job = await create();
    await repo.updateProgress(job.id, PROGRESS);

    expect(await row(job.id)).toMatchObject({
      rows_read: '120', accepted: '100', rejected: '20', duplicates: '4', bytes_read: '4096',
      chunks_sent: 1, core_rejected_duplicate_rows: '7', core_duplicate_source_rows: [2, 9, 11],
      core_rejected_duplicate_rows_may_undercount: true,
    });
  });

  it('complete: terminal row with the rejected-rows export fields', async () => {
    const job = await create();
    await repo.complete(job.id, {
      progress: PROGRESS, rejected_by_reason: { invalid_phone: 15, duplicate: 5 },
      headers: ['Name', 'Mobile'], context_columns: ['Name'], rejected_s3_key: 'agency-ingest/rej.csv',
      rejected_row_count: 20, rejected_truncated: true,
    });

    const r = await row(job.id);
    expect(r).toMatchObject({
      status: 'completed', rejected_by_reason: { invalid_phone: 15, duplicate: 5 },
      headers: ['Name', 'Mobile'], context_columns: ['Name'], rejected_s3_key: 'agency-ingest/rej.csv',
      rejected_row_count: 20, rejected_truncated: true, core_rejected_duplicate_rows: '7',
      core_rejected_duplicate_rows_may_undercount: true,
    });
    expect(r.finished_at).toBeInstanceOf(Date);
  });

  it('fail: records the code and truncates the message to 2000 characters', async () => {
    const job = await create();
    await repo.fail(job.id, 'core_rejected_chunk', 'x'.repeat(3000));

    const r = await row(job.id);
    expect(r).toMatchObject({ status: 'failed', error_code: 'core_rejected_chunk' });
    expect(r.error_message).toHaveLength(2000);
  });

  it('markCancelled: keeps an existing message when no note is given', async () => {
    const withNote = await create();
    await repo.markCancelled(withNote.id, 'Cancelled by the operator');
    expect(await row(withNote.id)).toMatchObject({ status: 'cancelled', error_message: 'Cancelled by the operator' });

    const bare = await create();
    await repo.fail(bare.id, 'unexpected_error', 'boom');
    await repo.markCancelled(bare.id);
    expect(await row(bare.id)).toMatchObject({ status: 'cancelled', error_message: 'boom' });
  });

  it('requestCancel / isCancelRequested: only a live job in the caller tenant (and account) can be flagged', async () => {
    const job = await create();
    expect(await repo.isCancelRequested(job.id)).toBe(false);
    expect(await repo.requestCancel(job.id, randomUUID())).toBe(false);
    expect(await repo.requestCancel(job.id, tenantId, randomUUID())).toBe(false);
    expect(await repo.requestCancel(job.id, tenantId, accountId)).toBe(true);
    expect(await repo.isCancelRequested(job.id)).toBe(true);

    const other = await create();
    expect(await repo.requestCancel(other.id, tenantId)).toBe(true);

    const done = await create();
    await repo.fail(done.id, 'unexpected_error', 'x');
    expect(await repo.requestCancel(done.id, tenantId)).toBe(false);
    expect(await repo.isCancelRequested(randomUUID())).toBe(false);
  });

  it('reapStaleJobs: fails only live jobs older than the window, with the restart message', async () => {
    const pool = getTestPool();
    const stale = await create();
    const fresh = await create();
    const finished = await create();
    await repo.fail(finished.id, 'unexpected_error', 'x');
    // The updated_at trigger rewrites it on UPDATE, so age the row with the trigger off.
    await pool.query('ALTER TABLE agency_ingest_jobs DISABLE TRIGGER agency_ingest_jobs_updated_at');
    try {
      await pool.query(
        `UPDATE agency_ingest_jobs SET updated_at = NOW() - INTERVAL '${AGENCY_INGEST_JOB_STALE_MINUTES + 5} minutes' WHERE id IN ($1, $2)`,
        [stale.id, finished.id],
      );
    } finally {
      await pool.query('ALTER TABLE agency_ingest_jobs ENABLE TRIGGER agency_ingest_jobs_updated_at');
    }

    expect(await repo.reapStaleJobs()).toBe(1);

    expect(await row(stale.id)).toMatchObject({ status: 'failed', error_code: 'interrupted' });
    expect((await row(stale.id)).error_message).toContain('interrupted by a service restart');
    expect((await row(fresh.id)).status).toBe('pending');
    expect((await row(finished.id)).error_code).toBe('unexpected_error');
  });
});
