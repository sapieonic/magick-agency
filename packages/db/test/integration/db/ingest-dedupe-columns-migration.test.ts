// Real Postgres: migrations/0031_ingest_dedupe_columns.sql. globalSetup has applied every
// migration. The server writes and reads the column (agency-ingest-job.repository.ts); this pins
// its shape and the 1..3 CHECK, that a job created without it keeps the earlier behaviour (NULL,
// dedupe_phones decides), the backfill from 0007's `dedupe_column`, down then up, and that the
// down fails an unfinished combined-key job rather than hand it one of its columns.
import { readdirSync } from 'node:fs';
import { runner } from 'node-pg-migrate';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { MIGRATIONS_DIR } from '../../../src/migrations-dir.js';
import { TEST_DB_URL } from '../../helpers/test-db.js';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { insertTenant } from '../fixtures.js';

const pool = () => getTestPool();

beforeEach(truncateAll);
afterAll(closeTestPool);

// No migration lock: nothing else migrates this file's own database copy, and after a refused
// Down the runner's unlock fails on its aborted transaction, so the lock lingers until the session
// ends, which a restore right after could race.
const migrate = (direction: 'up' | 'down', count = Infinity) =>
  runner({ databaseUrl: TEST_DB_URL, dir: MIGRATIONS_DIR, direction, migrationsTable: 'pgmigrations', count, log: () => {}, noLock: true });

const FILE = '0031_ingest_dedupe_columns.sql';

async function insertJob(extra: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const tenant = await insertTenant();
  const cols = ['tenant_id', 's3_key', 'file_name', 'phone_column', ...Object.keys(extra)];
  const vals = [tenant['id'], 'uploads/x.csv', 'x.csv', 'Mobile', ...Object.values(extra)];
  const { rows } = await pool().query<Record<string, unknown>>(
    `INSERT INTO agency_ingest_jobs (${cols.join(', ')})
     VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})
     RETURNING *`,
    vals,
  );
  return rows[0]!;
}

async function jobRow(id: unknown): Promise<Record<string, unknown>> {
  const { rows } = await pool().query<Record<string, unknown>>('SELECT * FROM agency_ingest_jobs WHERE id = $1', [id]);
  return rows[0]!;
}

describe('0031 — agency_ingest_jobs.dedupe_columns', () => {
  it('is a nullable TEXT[] column with no default', async () => {
    const { rows } = await pool().query<{ data_type: string; udt_name: string; is_nullable: string; column_default: string | null }>(
      `SELECT data_type, udt_name, is_nullable, column_default
         FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'agency_ingest_jobs' AND column_name = 'dedupe_columns'`,
    );
    expect(rows[0]).toEqual({ data_type: 'ARRAY', udt_name: '_text', is_nullable: 'YES', column_default: null });
  });

  it('a job written without it reads NULL and keeps dedupe_phones on', async () => {
    expect(await insertJob()).toMatchObject({ dedupe_columns: null, dedupe_phones: true });
  });

  it('stores one to three headers in the order given', async () => {
    expect(await insertJob({ dedupe_columns: ['Loan No'] })).toMatchObject({ dedupe_columns: ['Loan No'] });
    expect(await insertJob({ dedupe_columns: ['Loan No', 'Branch', 'Mobile'] }))
      .toMatchObject({ dedupe_columns: ['Loan No', 'Branch', 'Mobile'] });
  });

  it('refuses an empty array and more than three headers', async () => {
    await expect(insertJob({ dedupe_columns: [] }))
      .rejects.toMatchObject({ code: '23514', constraint: 'ck_agency_ingest_jobs_dedupe_columns' });
    await expect(insertJob({ dedupe_columns: ['a', 'b', 'c', 'd'] }))
      .rejects.toMatchObject({ code: '23514', constraint: 'ck_agency_ingest_jobs_dedupe_columns' });
  });

  it('refuses a NULL or empty header in the list', async () => {
    await expect(insertJob({ dedupe_columns: ['Loan No', null] }))
      .rejects.toMatchObject({ code: '23514', constraint: 'ck_agency_ingest_jobs_dedupe_columns' });
    await expect(insertJob({ dedupe_columns: ['Loan No', ''] }))
      .rejects.toMatchObject({ code: '23514', constraint: 'ck_agency_ingest_jobs_dedupe_columns' });
  });

  it('backfills 0007 jobs; down keeps a single key and the first of a finished combination; up again', async () => {
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
    const after = files.length - files.indexOf(FILE);
    // As the server writes them: a one-column key in both columns, a combination in the new one.
    const single = await insertJob({ dedupe_columns: ['Loan No'], dedupe_column: 'Loan No' });
    const runningSingle = await insertJob({ dedupe_columns: ['Loan No'], dedupe_column: 'Loan No', status: 'running' });
    const combined = await insertJob({ dedupe_columns: ['Loan No', 'Branch'], status: 'completed' });
    const phone = await insertJob();

    const stamped = async () => (await pool().query<{ id: string; updated_at: Date }>(
      'SELECT id, updated_at FROM agency_ingest_jobs ORDER BY id')).rows.map((r) => [r.id, r.updated_at.toISOString()]);
    const before = await stamped();

    await migrate('down', after);
    try {
      // `updated_at` is a running job's heartbeat: the Down's copy is not progress.
      expect(await stamped()).toEqual(before);
      expect(await jobRow(single['id'])).toMatchObject({ dedupe_column: 'Loan No', status: 'pending' });
      expect(await jobRow(runningSingle['id'])).toMatchObject({ dedupe_column: 'Loan No', status: 'running' });
      expect(await jobRow(combined['id'])).toMatchObject({ dedupe_column: 'Loan No', status: 'completed' });
      expect(await jobRow(phone['id'])).toMatchObject({ dedupe_column: null });
      expect(await jobRow(single['id'])).not.toHaveProperty('dedupe_columns');
      // A job an 0007 server wrote, for the backfill.
      const legacy = await insertJob({ dedupe_column: 'Policy No' });
      const legacyStamp = (await jobRow(legacy['id']))['updated_at'];
      await migrate('up');
      expect(await jobRow(legacy['id'])).toMatchObject({ dedupe_columns: ['Policy No'] });
      // Nor is the backfill: the heartbeat of an old job is left as it was.
      expect(await jobRow(legacy['id'])).toMatchObject({ updated_at: legacyStamp });
    } finally {
      await migrate('up');
    }
    expect(await jobRow(single['id'])).toMatchObject({ dedupe_columns: ['Loan No'] });
    // The combination came back through `dedupe_column`: the down kept only its first key.
    expect(await jobRow(combined['id'])).toMatchObject({ dedupe_columns: ['Loan No'] });
    expect(await jobRow(phone['id'])).toMatchObject({ dedupe_columns: null });
  });

  it('down fails an unfinished combined-key job, so a server before 0031 never runs it on one column', async () => {
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
    const after = files.length - files.indexOf(FILE);
    const old = new Date('2026-01-01T00:00:00Z');
    const pending = await insertJob({ dedupe_columns: ['Loan No', 'Branch'], updated_at: old });
    const running = await insertJob({ dedupe_columns: ['Loan No', 'Branch', 'Mobile'], status: 'running', updated_at: old });
    // Finished combinations keep today's handling: left as they ended, their first key kept for display.
    const terminal = await Promise.all((['completed', 'failed', 'cancelled'] as const).map((status) =>
      insertJob({ dedupe_columns: ['Loan No', 'Branch'], status, updated_at: old,
        ...(status === 'failed' ? { error_code: 'malformed_csv', error_message: 'Bad file.' } : {}) })));
    const pendingSingle = await insertJob({ dedupe_columns: ['Loan No'], dedupe_column: 'Loan No', updated_at: old });

    await migrate('down', after);
    try {
      for (const job of [pending, running]) {
        const r = await jobRow(job['id']);
        expect(r).toMatchObject({ status: 'failed', error_code: 'interrupted', dedupe_column: 'Loan No' });
        expect(r['error_message']).toMatch(/Upload the file again\.$/);
        expect(r['finished_at']).toBeInstanceOf(Date);
        // A change of state, not a schema copy: `updated_at` moves with it.
        expect((r['updated_at'] as Date).getTime()).toBeGreaterThan(old.getTime());
      }
      expect(await jobRow(terminal[0]!['id'])).toMatchObject({
        status: 'completed', error_code: null, finished_at: null, dedupe_column: 'Loan No', updated_at: old });
      expect(await jobRow(terminal[1]!['id'])).toMatchObject({
        status: 'failed', error_code: 'malformed_csv', error_message: 'Bad file.', dedupe_column: 'Loan No', updated_at: old });
      expect(await jobRow(terminal[2]!['id'])).toMatchObject({
        status: 'cancelled', error_code: null, dedupe_column: 'Loan No', updated_at: old });
      expect(await jobRow(pendingSingle['id'])).toMatchObject({
        status: 'pending', error_code: null, finished_at: null, dedupe_column: 'Loan No', updated_at: old });
    } finally {
      await migrate('up');
    }
  });
});
