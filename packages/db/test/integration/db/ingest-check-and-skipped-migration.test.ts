// Real Postgres: migrations/0042_ingest_check_and_skipped.sql. globalSetup has applied every
// migration. The server writes and reads the columns (agency-ingest-job.repository.ts); this
// pins their shapes and defaults (a job written without them reads as one that skipped
// nothing), the shape CHECKs, the one-import-per-check unique index, and down then up.
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
  runner({ databaseUrl: TEST_DB_URL, dir: MIGRATIONS_DIR, direction, migrationsTable: 'pgmigrations', count, log: () => {}, noLock: true });

const FILE = '0042_ingest_check_and_skipped.sql';
const COLUMNS = ['skipped', 'skipped_s3_key', 'skipped_row_count', 'skipped_truncated', 'dnc_by_scope', 'rejected_sample', 'check_job_id'];

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

describe('0042 — agency_ingest_jobs: the check, the skipped rows', () => {
  it('adds the columns with defaults that read as "skipped nothing"', async () => {
    const { rows } = await pool().query<{ column_name: string; data_type: string; is_nullable: string; column_default: string | null }>(
      `SELECT column_name, data_type, is_nullable, column_default
         FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'agency_ingest_jobs' AND column_name = ANY($1::text[])
        ORDER BY column_name`,
      [COLUMNS],
    );
    expect(rows).toEqual([
      { column_name: 'check_job_id', data_type: 'uuid', is_nullable: 'YES', column_default: null },
      { column_name: 'dnc_by_scope', data_type: 'jsonb', is_nullable: 'NO', column_default: "'{}'::jsonb" },
      { column_name: 'rejected_sample', data_type: 'jsonb', is_nullable: 'NO', column_default: "'[]'::jsonb" },
      { column_name: 'skipped', data_type: 'bigint', is_nullable: 'NO', column_default: '0' },
      { column_name: 'skipped_row_count', data_type: 'integer', is_nullable: 'NO', column_default: '0' },
      { column_name: 'skipped_s3_key', data_type: 'text', is_nullable: 'YES', column_default: null },
      { column_name: 'skipped_truncated', data_type: 'boolean', is_nullable: 'NO', column_default: 'false' },
    ]);
    expect(await insertJob()).toMatchObject({
      skipped: '0', skipped_s3_key: null, skipped_row_count: 0, skipped_truncated: false,
      dnc_by_scope: {}, rejected_sample: [], check_job_id: null,
    });
  });

  it('refuses a negative count and a JSONB of the wrong shape', async () => {
    await expect(insertJob({ skipped: -1 })).rejects.toMatchObject({ code: '23514', constraint: 'ck_agency_ingest_jobs_skipped' });
    await expect(insertJob({ dnc_by_scope: '[]' })).rejects.toMatchObject({ code: '23514', constraint: 'ck_agency_ingest_jobs_dnc_by_scope' });
    await expect(insertJob({ rejected_sample: '{}' })).rejects.toMatchObject({ code: '23514', constraint: 'ck_agency_ingest_jobs_rejected_sample' });
  });

  it('one import holds a check: a second live or completed one is refused, a failed or cancelled one lets it go; a deleted check leaves its import', async () => {
    const check = await insertJob({ dry_run: true });
    const imported = await insertJob({ check_job_id: check['id'] });
    for (const status of ['pending', 'running', 'completed']) {
      await expect(insertJob({ check_job_id: check['id'], status }))
        .rejects.toMatchObject({ code: '23505', constraint: 'uq_agency_ingest_jobs_check_job' });
    }
    // The first import fails: its check is free for another, and the failed one keeps its link.
    await pool().query(`UPDATE agency_ingest_jobs SET status = 'failed' WHERE id = $1`, [imported['id']]);
    const retried = await insertJob({ check_job_id: check['id'], status: 'cancelled' });
    const holder = await insertJob({ check_job_id: check['id'] });
    // A failed one cannot come back to hold it beside the import that does.
    await expect(pool().query(`UPDATE agency_ingest_jobs SET status = 'completed' WHERE id = $1`, [retried['id']]))
      .rejects.toMatchObject({ code: '23505', constraint: 'uq_agency_ingest_jobs_check_job' });
    await pool().query('DELETE FROM agency_ingest_jobs WHERE id = $1', [holder['id']]);
    await pool().query('DELETE FROM agency_ingest_jobs WHERE id = $1', [check['id']]);
    const { rows } = await pool().query('SELECT check_job_id FROM agency_ingest_jobs WHERE id = $1', [imported['id']]);
    expect(rows[0]).toEqual({ check_job_id: null });
  });

  it('down drops them and leaves every job; up adds them back', async () => {
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
    const after = files.length - files.indexOf(FILE);
    const job = await insertJob({ skipped: 4, dnc_by_scope: '{"tenant": 1}' });

    await migrate('down', after);
    try {
      const { rows } = await pool().query<Record<string, unknown>>('SELECT * FROM agency_ingest_jobs WHERE id = $1', [job['id']]);
      expect(rows).toHaveLength(1);
      for (const column of COLUMNS) expect(rows[0]).not.toHaveProperty(column);
      const index = await pool().query(`SELECT 1 FROM pg_indexes WHERE indexname = 'uq_agency_ingest_jobs_check_job'`);
      expect(index.rows).toEqual([]);
    } finally {
      await migrate('up');
    }
    const { rows } = await pool().query<Record<string, unknown>>('SELECT skipped, dnc_by_scope FROM agency_ingest_jobs WHERE id = $1', [job['id']]);
    expect(rows[0]).toEqual({ skipped: '0', dnc_by_scope: {} });
  });
});
