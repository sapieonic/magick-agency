// Real Postgres: migrations/0040_drop_duplicate_indexes.sql (seven indexes that repeated a unique
// index). globalSetup has applied every migration. Pins that each is gone, that each lookup it
// served is still an index scan (on the unique index that covers it), and down then up.
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

const FILE = '0040_drop_duplicate_indexes.sql';

const T = '00000000-0000-0000-0000-000000000001';
const A = '00000000-0000-0000-0000-000000000002';

/** Each dropped index: 0001's definition (what Down restores), a lookup it served, and the index that serves it now. */
const DROPPED = [
  {
    name: 'idx_super_admins_email',
    def: 'CREATE INDEX idx_super_admins_email ON public.super_admins USING btree (email)',
    lookup: { sql: 'SELECT id FROM super_admins WHERE email = $1', params: ['a@example.com'] },
    coveredBy: 'super_admins_email_key',
  },
  {
    name: 'idx_account_settings_tenant_account',
    def: 'CREATE INDEX idx_account_settings_tenant_account ON public.account_settings USING btree (tenant_id, account_id)',
    lookup: { sql: 'SELECT id FROM account_settings WHERE tenant_id = $1 AND account_id = $2', params: [T, A] },
    coveredBy: 'uq_account_settings_tenant_account',
  },
  {
    name: 'idx_account_settings_tenant',
    def: 'CREATE INDEX idx_account_settings_tenant ON public.account_settings USING btree (tenant_id)',
    lookup: { sql: 'SELECT id FROM account_settings WHERE tenant_id = $1', params: [T] },
    coveredBy: 'uq_account_settings_tenant_account',
  },
  {
    name: 'idx_account_provider_concurrency_account',
    def: 'CREATE INDEX idx_account_provider_concurrency_account ON public.account_provider_concurrency_allocations USING btree (tenant_id, account_id)',
    lookup: { sql: 'SELECT id FROM account_provider_concurrency_allocations WHERE tenant_id = $1 AND account_id = $2', params: [T, A] },
    coveredBy: 'uq_account_provider_concurrency',
  },
  {
    name: 'idx_memberships_user_id',
    def: 'CREATE INDEX idx_memberships_user_id ON public.memberships USING btree (user_id)',
    lookup: { sql: 'SELECT id FROM memberships WHERE user_id = $1', params: [T] },
    coveredBy: 'memberships_user_id_tenant_id_account_id_key',
  },
  {
    name: 'idx_tenant_phone_tenant',
    def: 'CREATE INDEX idx_tenant_phone_tenant ON public.tenant_phone_assignments USING btree (tenant_id)',
    lookup: { sql: 'SELECT id FROM tenant_phone_assignments WHERE tenant_id = $1', params: [T] },
    coveredBy: 'tenant_phone_assignments_tenant_id_phone_number_id_key',
  },
  {
    name: 'idx_phone_account_tags_assignment',
    def: 'CREATE INDEX idx_phone_account_tags_assignment ON public.phone_account_tags USING btree (assignment_id)',
    lookup: { sql: 'SELECT id FROM phone_account_tags WHERE assignment_id = $1', params: [T] },
    coveredBy: 'phone_account_tags_assignment_id_account_id_key',
  },
] as const;

async function indexDefs(): Promise<Record<string, string>> {
  const { rows } = await getTestPool().query<{ indexname: string; indexdef: string }>(
    `SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = ANY($1::text[])`,
    [DROPPED.map((d) => d.name)]);
  return Object.fromEntries(rows.map((r) => [r.indexname, r.indexdef]));
}

/** The plan of `sql` with sequential scans priced out, so the read shows which index it can use. */
async function plan(sql: string, params: readonly unknown[]): Promise<string> {
  const client = await getTestPool().connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL enable_seqscan = off');
    const { rows } = await client.query<{ 'QUERY PLAN': string }>(`EXPLAIN ${sql}`, [...params]);
    return rows.map((r) => r['QUERY PLAN']).join('\n');
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

describe('0040 — duplicate indexes dropped', () => {
  it('drops all seven', async () => {
    expect(await indexDefs()).toEqual({});
  });

  it.each(DROPPED)('$name: its lookup is an index scan on $coveredBy', async ({ lookup, coveredBy }) => {
    const p = await plan(lookup.sql, lookup.params);
    expect(p).toContain(coveredBy);
    expect(p).not.toMatch(/Seq Scan/);
  });

  it("down restores 0001's definitions; up drops them again", async () => {
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
    const after = files.length - files.indexOf(FILE);
    await migrate('down', after);
    try {
      expect(await indexDefs()).toEqual(Object.fromEntries(DROPPED.map((d) => [d.name, d.def])));
    } finally {
      await migrate('up');
    }
    expect(await indexDefs()).toEqual({});
  });
});
