// Real Postgres: migrations/0039_retention_purge_indexes.sql (the retention purge's time indexes).
// globalSetup has applied every migration. Pins each index by its definition, that each purge
// read can use its index, and down then up.
//
// The reads below repeat the server's purge SQL (apps/server/src/maintenance/retention-purge.ts:
// PURGE_TARGETS, purgeAgencyTranscripts, purgeInboundVoicemails) word for word in its WHERE and
// ORDER BY: a partial index is only usable when the planner can prove the read implies its
// predicate, so a change to either side must keep them matching.
import { readdirSync } from 'node:fs';
import { runner } from 'node-pg-migrate';
import { afterAll, describe, expect, it } from 'vitest';
import { MIGRATIONS_DIR } from '../../../src/migrations-dir.js';
import { TEST_DB_URL } from '../../helpers/test-db.js';
import { closeTestPool, getTestPool } from '../setup/test-utils.js';

afterAll(closeTestPool);

// No migration lock: nothing else migrates this file's own database copy.
const migrate = (direction: 'up' | 'down', count = Infinity) =>
  runner({ databaseUrl: TEST_DB_URL, dir: MIGRATIONS_DIR, direction, migrationsTable: 'pgmigrations', count, log: () => {}, noLock: true });

const FILE = '0039_retention_purge_indexes.sql';

const DEFINITIONS: Record<string, string> = {
  idx_agency_calls_transcript_pending:
    'CREATE INDEX idx_agency_calls_transcript_pending ON public.agency_calls USING btree (created_at) '
    + 'WHERE ((conversation_log IS NOT NULL) OR (transcript_meta IS NOT NULL))',
  idx_agency_calls_created: 'CREATE INDEX idx_agency_calls_created ON public.agency_calls USING btree (created_at)',
  idx_dialer_analysis_jobs_created:
    'CREATE INDEX idx_dialer_analysis_jobs_created ON public.dialer_analysis_jobs USING btree (created_at)',
  idx_agency_inbound_calls_voicemail:
    'CREATE INDEX idx_agency_inbound_calls_voicemail ON public.agency_inbound_calls USING btree (arrived_at, id) '
    + 'WHERE (voicemail_key IS NOT NULL)',
};

async function indexDefs(): Promise<Record<string, string>> {
  const { rows } = await getTestPool().query<{ indexname: string; indexdef: string }>(
    `SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = ANY($1::text[])`,
    [Object.keys(DEFINITIONS)]);
  return Object.fromEntries(rows.map((r) => [r.indexname, r.indexdef]));
}

/**
 * The plan of `sql` with sequential scans priced out, so an index the read can use is chosen.
 * `ordered` also prices out bitmap scans (which return rows unordered): a plain index scan whose
 * order matches the ORDER BY then needs no Sort above it.
 */
async function plan(sql: string, params: unknown[], ordered = false): Promise<string> {
  const client = await getTestPool().connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL enable_seqscan = off');
    if (ordered) await client.query('SET LOCAL enable_bitmapscan = off');
    const { rows } = await client.query<{ 'QUERY PLAN': string }>(`EXPLAIN ${sql}`, params);
    return rows.map((r) => r['QUERY PLAN']).join('\n');
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

const CUTOFF = new Date('2026-01-01T00:00:00Z');

describe('0039 — the retention purge\'s time indexes', () => {
  it('defines the four indexes exactly', async () => {
    expect(await indexDefs()).toEqual(DEFINITIONS);
  });

  it('the transcript step reads idx_agency_calls_transcript_pending', async () => {
    // purgeAgencyTranscripts' batch select, with its `hasTranscript` predicate.
    const p = await plan(
      `SELECT id FROM agency_calls
        WHERE created_at < $1 AND (conversation_log IS NOT NULL OR transcript_meta IS NOT NULL)
        LIMIT $2`, [CUTOFF, 5000]);
    expect(p).toContain('idx_agency_calls_transcript_pending');
  });

  it('the row purge reads idx_agency_calls_created and idx_dialer_analysis_jobs_created', async () => {
    expect(await plan('SELECT id FROM agency_calls WHERE created_at < $1 LIMIT $2', [CUTOFF, 5000]))
      .toContain('idx_agency_calls_created');
    expect(await plan('SELECT j.id FROM dialer_analysis_jobs j WHERE j.created_at < $1 LIMIT $2', [CUTOFF, 5000]))
      .toContain('idx_dialer_analysis_jobs_created');
  });

  it('the voicemail walk reads idx_agency_inbound_calls_voicemail in its keyset order', async () => {
    const p = await plan(
      `SELECT id, voicemail_key, arrived_at FROM agency_inbound_calls
        WHERE voicemail_key IS NOT NULL AND arrived_at < $1
          AND ($3::timestamptz IS NULL OR (arrived_at, id) > ($3::timestamptz, $4::uuid))
        ORDER BY arrived_at, id
        LIMIT $2`, [CUTOFF, 200, null, null], true);
    expect(p).toContain('idx_agency_inbound_calls_voicemail');
    expect(p).not.toContain('Sort');
  });

  it('down drops them; up restores them', async () => {
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
    const after = files.length - files.indexOf(FILE);
    await migrate('down', after);
    try {
      expect(await indexDefs()).toEqual({});
    } finally {
      await migrate('up');
    }
    expect(await indexDefs()).toEqual(DEFINITIONS);
  });
});
