// Real Postgres: migrations/0038_table_storage_settings.sql (per-table autovacuum thresholds and
// fillfactor). globalSetup has applied every migration. Pins every table's storage parameters
// (and that nothing else got any), and down then up.
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

const FILE = '0038_table_storage_settings.sql';

const EXPECTED: Record<string, string[]> = {
  agency_call_attempts: ['autovacuum_analyze_scale_factor=0.02', 'autovacuum_vacuum_scale_factor=0.02'],
  agency_contacts: ['autovacuum_analyze_scale_factor=0.02', 'autovacuum_vacuum_scale_factor=0.02'],
  agency_calls: ['autovacuum_vacuum_scale_factor=0.05'],
  agency_agent_sessions: ['autovacuum_vacuum_scale_factor=0.05', 'fillfactor=80'],
  agency_insights_rollup_agents: ['autovacuum_vacuum_scale_factor=0.05'],
  agency_insights_rollup_codes: ['autovacuum_vacuum_scale_factor=0.05'],
  agency_insights_rollup_facets: ['autovacuum_vacuum_scale_factor=0.05'],
  agency_campaign_pacing_minutes: ['fillfactor=85'],
};

/** Every ordinary table in `public` that carries storage parameters, with them sorted. */
async function reloptions(): Promise<Record<string, string[]>> {
  const { rows } = await getTestPool().query<{ relname: string; reloptions: string[] }>(
    `SELECT c.relname, c.reloptions FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.reloptions IS NOT NULL`);
  return Object.fromEntries(rows.map((r) => [r.relname, [...r.reloptions].sort()]));
}

describe('0038 — per-table autovacuum thresholds and fillfactor', () => {
  it('sets exactly these parameters, on exactly these tables', async () => {
    expect(await reloptions()).toEqual(EXPECTED);
  });

  it('down resets every one of them; up sets them again', async () => {
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
    const after = files.length - files.indexOf(FILE);
    await migrate('down', after);
    try {
      expect(await reloptions()).toEqual({});
    } finally {
      await migrate('up');
    }
    expect(await reloptions()).toEqual(EXPECTED);
  });
});
