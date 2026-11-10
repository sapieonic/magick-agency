// Real Postgres: migrations/0031_ingest_dedupe_columns.sql. globalSetup has applied every
// migration. The server writes and reads the column (agency-ingest-job.repository.ts); this pins
// its shape and the 1..3 CHECK, that a job created without it keeps the earlier behaviour (NULL,
// dedupe_phones decides), the backfill from 0007's `dedupe_column`, and down then up.
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

const migrate = (direction: 'up' | 'down', count = Infinity) =>
  runner({ databaseUrl: TEST_DB_URL, dir: MIGRATIONS_DIR, direction, migrationsTable: 'pgmigrations', count, log: () => {} });

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

  it('backfills 0007 jobs; down keeps a single key and the first of a combination; up again', async () => {
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
    const after = files.length - files.indexOf(FILE);
    const single = await insertJob({ dedupe_columns: ['Loan No'] });
    const combined = await insertJob({ dedupe_columns: ['Loan No', 'Branch'] });
    const phone = await insertJob();

    await migrate('down', after);
    try {
      expect(await jobRow(single['id'])).toMatchObject({ dedupe_column: 'Loan No' });
      expect(await jobRow(combined['id'])).toMatchObject({ dedupe_column: 'Loan No' });
      expect(await jobRow(phone['id'])).toMatchObject({ dedupe_column: null });
      expect(await jobRow(single['id'])).not.toHaveProperty('dedupe_columns');
      // A job an 0007 server wrote, for the backfill.
      const legacy = await insertJob({ dedupe_column: 'Policy No' });
      await migrate('up');
      expect(await jobRow(legacy['id'])).toMatchObject({ dedupe_columns: ['Policy No'] });
    } finally {
      await migrate('up');
    }
    expect(await jobRow(single['id'])).toMatchObject({ dedupe_columns: ['Loan No'] });
    // The combination came back through `dedupe_column`: the down kept only its first key.
    expect(await jobRow(combined['id'])).toMatchObject({ dedupe_columns: ['Loan No'] });
    expect(await jobRow(phone['id'])).toMatchObject({ dedupe_columns: null });
  });
});
