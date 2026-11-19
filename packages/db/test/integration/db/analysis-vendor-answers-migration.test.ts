// Real Postgres: migrations/0054_analysis_vendor_answers.sql and 0055_analysis_vendor_answer_indexes.sql
// (decision AD1: a call's summary reads delayed while the AI vendor's newest answer is a refusal).
// globalSetup has applied every migration. Pins the two columns (nullable, no default, so the ADD
// COLUMN rewrites nothing and every row already there reads null), 0054's lock timeout, the two
// partial indexes by their definitions, that the delay read (`analysisDelaySql`, the repository's
// own SQL) probes each index on a seeded queue rather than walking it, the invalid-index refusal,
// and down then up.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { runner } from 'node-pg-migrate';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { MIGRATIONS_DIR } from '../../../src/migrations-dir.js';
import { analysisDelaySql } from '../../../src/repositories/dialer-analysis-job.repository.js';
import { TEST_DB_URL } from '../../helpers/test-db.js';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { insertWebrtcCall } from '../setup/factories.js';

const pool = () => getTestPool();

beforeEach(truncateAll);
afterAll(closeTestPool);

// No migration lock: nothing else migrates this file's own database copy.
const migrate = (direction: 'up' | 'down', count = Infinity) =>
  runner({ databaseUrl: TEST_DB_URL, dir: MIGRATIONS_DIR, direction, migrationsTable: 'pgmigrations', count, log: () => {}, noLock: true });

const COLUMNS_FILE = '0054_analysis_vendor_answers.sql';
const INDEXES_FILE = '0055_analysis_vendor_answer_indexes.sql';

const DEFINITIONS: Record<string, string> = {
  idx_dialer_analysis_jobs_vendor_refused:
    'CREATE INDEX idx_dialer_analysis_jobs_vendor_refused ON public.dialer_analysis_jobs USING btree (vendor_refused_at) '
    + "WHERE (((status)::text = 'queued'::text) AND ((error_code)::text = 'RATE_LIMITED'::text))",
  idx_dialer_analysis_jobs_completed:
    'CREATE INDEX idx_dialer_analysis_jobs_completed ON public.dialer_analysis_jobs USING btree (completed_at) '
    + 'WHERE (completed_at IS NOT NULL)',
};
const NAMES = Object.keys(DEFINITIONS);

async function columns(): Promise<Record<string, string>> {
  const { rows } = await pool().query<{ column_name: string; data_type: string; is_nullable: string; column_default: string | null }>(
    `SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'dialer_analysis_jobs'
        AND column_name IN ('vendor_refused_at', 'completed_at')`);
  return Object.fromEntries(rows.map((r) => [
    r.column_name,
    `${r.data_type}${r.is_nullable === 'NO' ? ' not null' : ''}${r.column_default ? ` default ${r.column_default}` : ''}`,
  ]));
}

async function indexDefs(): Promise<Record<string, string>> {
  const { rows } = await pool().query<{ indexname: string; indexdef: string }>(
    `SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = ANY($1::text[])`, [NAMES]);
  return Object.fromEntries(rows.map((r) => [r.indexname, r.indexdef]));
}

function stepsDownTo(file: string): number {
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  return files.length - files.indexOf(file);
}

function upStatements(file: string): string[] {
  const up = readFileSync(join(MIGRATIONS_DIR, file), 'utf8').split('-- Down Migration')[0]!.split('-- Up Migration')[1]!;
  return up.replace(/--.*$/gm, '').split(';').map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

const EXPECTED_COLUMNS = { vendor_refused_at: 'timestamp with time zone', completed_at: 'timestamp with time zone' };

describe('0054 — dialer_analysis_jobs.vendor_refused_at and completed_at', () => {
  it('are nullable TIMESTAMPTZ columns with no default and a comment each; a new job has neither', async () => {
    expect(await columns()).toEqual(EXPECTED_COLUMNS);
    const call = await insertWebrtcCall();
    const { rows } = await pool().query(
      `INSERT INTO dialer_analysis_jobs (call_id, tenant_id, account_id) VALUES ($1, $2, $3)
       RETURNING vendor_refused_at, completed_at`, [call.id, call.tenant_id, call.account_id]);
    expect(rows).toEqual([{ vendor_refused_at: null, completed_at: null }]);
    const comments = await pool().query<{ attname: string; description: string | null }>(
      `SELECT attname, col_description('dialer_analysis_jobs'::regclass, attnum) AS description
         FROM pg_attribute WHERE attrelid = 'dialer_analysis_jobs'::regclass AND attname IN ('vendor_refused_at', 'completed_at')`);
    for (const r of comments.rows) expect(r.description).toMatch(/AD1/);
  });

  it('starts its Up with a lock timeout and adds the columns without a default', () => {
    expect(upStatements(COLUMNS_FILE).slice(0, 3)).toEqual([
      "SET LOCAL lock_timeout = '10s'",
      'ALTER TABLE dialer_analysis_jobs ADD COLUMN IF NOT EXISTS vendor_refused_at TIMESTAMPTZ',
      'ALTER TABLE dialer_analysis_jobs ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ',
    ]);
  });
});

describe('0055 — the delay read\'s indexes of the newest refusal and the newest completion', () => {
  it('defines the two indexes exactly, built in a file of their own after a lock timeout', async () => {
    expect(await indexDefs()).toEqual(DEFINITIONS);
    expect(upStatements(INDEXES_FILE)[0]).toBe("SET LOCAL lock_timeout = '10s'");
    // Out of 0054's ACCESS EXCLUSIVE: 0054 builds no index.
    expect(upStatements(COLUMNS_FILE).some((s) => /CREATE INDEX/i.test(s))).toBe(false);
  });

  it('the delay read probes each index once on a seeded queue, never the runnable index or a scan of the table', async () => {
    // A backlog worth planning over: completed jobs, queued refused ones, queued untried ones.
    const call = await insertWebrtcCall();
    await pool().query(
      `INSERT INTO agency_calls (id, tenant_id, account_id, caller_id, destination_phone, provider, status, metadata, campaign_id)
       SELECT gen_random_uuid(), tenant_id, account_id, caller_id, destination_phone, provider, status, metadata, campaign_id
         FROM agency_calls, generate_series(1, 3000) WHERE id = $1`,
      [call.id]);
    await pool().query(
      `INSERT INTO dialer_analysis_jobs (call_id, tenant_id, account_id, status, error_code, vendor_refused_at, completed_at, next_attempt_at)
       SELECT c.id, c.tenant_id, c.account_id,
              CASE WHEN n % 3 = 0 THEN 'completed' ELSE 'queued' END,
              CASE WHEN n % 3 = 1 THEN 'RATE_LIMITED' END,
              CASE WHEN n % 3 = 1 THEN now() - n * interval '1 second' END,
              CASE WHEN n % 3 = 0 THEN now() - n * interval '1 second' END,
              now() + n * interval '1 second'
         FROM (SELECT id, tenant_id, account_id, row_number() OVER (ORDER BY id) AS n FROM agency_calls) c`);
    await pool().query('ANALYZE dialer_analysis_jobs');
    const { rows } = await pool().query<{ 'QUERY PLAN': string }>(
      `EXPLAIN SELECT ${analysisDelaySql('j')} AS delay FROM dialer_analysis_jobs j WHERE j.call_id = $1`, [call.id]);
    const plan = rows.map((r) => r['QUERY PLAN']).join('\n');
    expect(plan).toMatch(/Index Only Scan Backward using idx_dialer_analysis_jobs_vendor_refused/);
    expect(plan).toMatch(/Index Only Scan Backward using idx_dialer_analysis_jobs_completed/);
    expect(plan).not.toContain('idx_dialer_analysis_jobs_runnable');
    expect(plan).not.toContain('Seq Scan');
  });

  it('fails on an invalid index left under one of its names by a failed CREATE INDEX CONCURRENTLY', async () => {
    const name = 'idx_dialer_analysis_jobs_completed';
    await migrate('down', stepsDownTo(INDEXES_FILE));
    try {
      await pool().query(`CREATE INDEX ${name} ON dialer_analysis_jobs (completed_at) WHERE completed_at IS NOT NULL`);
      await pool().query(`UPDATE pg_index SET indisvalid = false WHERE indexrelid = '${name}'::regclass`);
      await expect(migrate('up')).rejects.toThrow(new RegExp(`invalid index.*${name}`));
      const { rows } = await pool().query(`SELECT name FROM pgmigrations WHERE name = $1`, [INDEXES_FILE.replace(/\.sql$/, '')]);
      expect(rows).toEqual([]);
    } finally {
      await pool().query(`DROP INDEX IF EXISTS ${name}`);
      await migrate('up');
    }
    expect(await indexDefs()).toEqual(DEFINITIONS);
  });

  it('down drops the indexes, then the columns; up adds them back null on the rows already there', async () => {
    const call = await insertWebrtcCall();
    await pool().query(
      `INSERT INTO dialer_analysis_jobs (call_id, tenant_id, account_id, status, error_code, vendor_refused_at)
       VALUES ($1, $2, $3, 'queued', 'RATE_LIMITED', now())`, [call.id, call.tenant_id, call.account_id]);
    await migrate('down', stepsDownTo(INDEXES_FILE));
    try {
      expect(await indexDefs()).toEqual({});
      expect(await columns()).toEqual(EXPECTED_COLUMNS);
      await migrate('down', 1);
      expect(await columns()).toEqual({});
      await migrate('up', 1);
      expect(await columns()).toEqual(EXPECTED_COLUMNS);
      const { rows } = await pool().query(
        'SELECT status, error_code, vendor_refused_at, completed_at FROM dialer_analysis_jobs WHERE call_id = $1', [call.id]);
      expect(rows).toEqual([{ status: 'queued', error_code: 'RATE_LIMITED', vendor_refused_at: null, completed_at: null }]);
    } finally {
      await migrate('up');
    }
    expect(await indexDefs()).toEqual(DEFINITIONS);
  });
});
