// Real Postgres: migrations/0007_ingest_dedupe_column.sql. globalSetup has applied every
// migration. The server writes and reads the column (agency-ingest-job.repository.ts); this pins
// its shape, and that a job created without it keeps the earlier behaviour (NULL, dedupe_phones
// decides).
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { insertTenant } from '../fixtures.js';

const pool = () => getTestPool();

beforeEach(truncateAll);
afterAll(closeTestPool);

async function insertJob(extra: Record<string, unknown> = {}) {
  const tenant = await insertTenant();
  const cols = ['tenant_id', 's3_key', 'file_name', 'phone_column', ...Object.keys(extra)];
  const vals = [tenant['id'], 'uploads/x.csv', 'x.csv', 'Mobile', ...Object.values(extra)];
  const { rows } = await pool().query<{ dedupe_column: string | null; dedupe_phones: boolean }>(
    `INSERT INTO agency_ingest_jobs (${cols.join(', ')})
     VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})
     RETURNING dedupe_column, dedupe_phones`,
    vals,
  );
  return rows[0]!;
}

describe('0007 — agency_ingest_jobs.dedupe_column', () => {
  it('is a nullable TEXT column with no default', async () => {
    const { rows } = await pool().query<{ data_type: string; is_nullable: string; column_default: string | null }>(
      `SELECT data_type, is_nullable, column_default
         FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'agency_ingest_jobs' AND column_name = 'dedupe_column'`,
    );
    expect(rows[0]).toEqual({ data_type: 'text', is_nullable: 'YES', column_default: null });
  });

  it('a job written without it reads NULL and keeps dedupe_phones on', async () => {
    expect(await insertJob()).toEqual({ dedupe_column: null, dedupe_phones: true });
  });

  it('stores the header as given', async () => {
    expect(await insertJob({ dedupe_column: 'Loan No' })).toMatchObject({ dedupe_column: 'Loan No' });
  });
});
