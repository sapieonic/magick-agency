// Real Postgres: migrations/0034_dnc_phone_ending_index.sql (the Do Not Call list's search by the
// end of a number). globalSetup has applied every migration. Pins the index by its definition (the
// expression the repository repeats, and the operator class a prefix LIKE needs) and down then up.
import { readdirSync } from 'node:fs';
import { runner } from 'node-pg-migrate';
import { afterAll, describe, expect, it } from 'vitest';
import { MIGRATIONS_DIR } from '../../../src/migrations-dir.js';
import { TEST_DB_URL } from '../../helpers/test-db.js';
import { closeTestPool, getTestPool } from '../setup/test-utils.js';

afterAll(closeTestPool);

const migrate = (direction: 'up' | 'down', count = Infinity) =>
  runner({ databaseUrl: TEST_DB_URL, dir: MIGRATIONS_DIR, direction, migrationsTable: 'pgmigrations', count, log: () => {} });

const FILE = '0034_dnc_phone_ending_index.sql';
const INDEX = 'idx_dnc_entries_tenant_phone_reversed';

async function indexDef(): Promise<string | undefined> {
  const { rows } = await getTestPool().query<{ indexdef: string }>(
    `SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = $1`, [INDEX]);
  return rows[0]?.indexdef;
}

describe('0034 — the Do Not Call list searched by the end of a number', () => {
  it('keyed (tenant, reversed number) with text_pattern_ops, so an ending is a prefix range', async () => {
    expect(await indexDef()).toBe(
      'CREATE INDEX idx_dnc_entries_tenant_phone_reversed ON public.dnc_entries USING btree '
      + '(tenant_id, reverse((phone_e164)::text) text_pattern_ops)');
  });

  it('down drops it; up restores it', async () => {
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
    const after = files.length - files.indexOf(FILE);
    await migrate('down', after);
    try {
      expect(await indexDef()).toBeUndefined();
    } finally {
      await migrate('up');
    }
    expect(await indexDef()).toBeDefined();
  });
});
