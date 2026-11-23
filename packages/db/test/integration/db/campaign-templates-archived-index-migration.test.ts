// Real Postgres: migrations/0068_campaign_templates_archived_index.sql (docs/campaign-templates.md
// CT14): a scope's archived campaign templates, which Settings › Campaign templates' Archived list
// reads. globalSetup has applied every migration. Pins the index by its definition, that the list's
// statement shape (repeated here: this package cannot import the server's repository) uses it, the
// invalid-index refusal, and down then up.
import { randomUUID } from 'node:crypto';
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

const FILE = '0068_campaign_templates_archived_index.sql';
const NAME = 'idx_agency_campaign_templates_archived';
const DEFINITION =
  'CREATE INDEX idx_agency_campaign_templates_archived ON public.agency_campaign_templates USING btree (tenant_id, account_id) '
  + 'WHERE (archived_at IS NOT NULL)';

async function indexDef(): Promise<string | undefined> {
  const { rows } = await getTestPool().query<{ indexdef: string }>(
    `SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = $1`, [NAME]);
  return rows[0]?.indexdef;
}

describe('0068 — archived campaign templates, by scope', () => {
  it('defines the index exactly, with its comment', async () => {
    expect(await indexDef()).toBe(DEFINITION);
    const { rows } = await getTestPool().query<{ c: string | null }>(`SELECT obj_description($1::regclass, 'pg_class') AS c`, [NAME]);
    expect(rows[0]!.c).toMatch(/archived campaign templates/);
  });

  it('serves the Archived list of one account and its organisation, not a scan of every tenant', async () => {
    const client = await getTestPool().connect();
    try {
      await client.query('BEGIN');
      // 400 tenants with 3 accounts each, 4 templates per scope, half of them archived.
      await client.query(
        `INSERT INTO agency_campaign_templates (tenant_id, account_id, name, archived_at)
         SELECT t.id, a.id, 'T ' || n, CASE WHEN n % 2 = 0 THEN now() END
           FROM (SELECT gen_random_uuid() AS id FROM generate_series(1, 400)) t
           CROSS JOIN LATERAL (SELECT NULL::uuid AS id UNION ALL SELECT gen_random_uuid() FROM generate_series(1, 3)) a
           CROSS JOIN generate_series(1, 4) n`,
      );
      const { rows: [one] } = await client.query<{ tenant_id: string; account_id: string }>(
        `SELECT tenant_id, account_id FROM agency_campaign_templates WHERE account_id IS NOT NULL LIMIT 1`);
      await client.query('ANALYZE agency_campaign_templates');
      const { rows } = await client.query<{ 'QUERY PLAN': string }>(
        `EXPLAIN SELECT id FROM agency_campaign_templates
          WHERE tenant_id = $1::uuid AND (account_id IS NULL OR account_id = $2::uuid) AND archived_at IS NOT NULL
          ORDER BY (account_id IS NULL), is_default DESC, lower(name), id`, [one!.tenant_id, one!.account_id ?? randomUUID()]);
      const plan = rows.map((r) => r['QUERY PLAN']).join('\n');
      expect(plan).toContain(NAME);
      expect(plan).not.toMatch(/Seq Scan on agency_campaign_templates/);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('fails on an invalid index left under its name by a failed CREATE INDEX CONCURRENTLY', async () => {
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
    const pool = getTestPool();
    await migrate('down', files.length - files.indexOf(FILE));
    try {
      await pool.query(`CREATE INDEX ${NAME} ON agency_campaign_templates (tenant_id, account_id) WHERE archived_at IS NOT NULL`);
      await pool.query(`UPDATE pg_index SET indisvalid = false WHERE indexrelid = '${NAME}'::regclass`);
      await expect(migrate('up')).rejects.toThrow(new RegExp(`invalid index.*${NAME}`));
      const { rows } = await pool.query(`SELECT name FROM pgmigrations WHERE name = $1`, [FILE.replace(/\.sql$/, '')]);
      expect(rows).toEqual([]);
    } finally {
      await pool.query(`DROP INDEX IF EXISTS ${NAME}`);
      await migrate('up');
    }
    expect(await indexDef()).toBe(DEFINITION);
  });

  it('down drops it; up restores it', async () => {
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
    await migrate('down', files.length - files.indexOf(FILE));
    try {
      expect(await indexDef()).toBeUndefined();
    } finally {
      await migrate('up');
    }
    expect(await indexDef()).toBe(DEFINITION);
  });
});
