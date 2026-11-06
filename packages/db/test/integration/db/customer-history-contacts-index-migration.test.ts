// Real Postgres: migrations/0017_customer_history_contacts_index.sql (docs/customer-history.md,
// CH9 and CH14). globalSetup has applied every migration. Pins the roster index by definition AND
// by the planner walking it for the history's contact read: `newestContacts` of
// `CUSTOMER_HISTORY_SQL` (apps/server/src/db/repositories/agency/customer-history.repository.ts),
// copied here verbatim at the cap because this package cannot import the server; the server's
// own suite EXPLAINs every statement that uses it. The trailing `created_at DESC, id DESC` columns
// are what let the LIMIT stop each account's walk at the cap with no sort of every match. Then down
// (the index is gone) and up again.
import { readdirSync } from 'node:fs';
import type { PoolClient } from 'pg';
import { runner } from 'node-pg-migrate';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { MIGRATIONS_DIR } from '../../../src/migrations-dir.js';
import { TEST_DB_URL } from '../../helpers/test-db.js';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { ACCOUNT, insertCampaign, TENANT } from '../fixtures.js';

const pool = () => getTestPool();

beforeEach(truncateAll);
afterAll(closeTestPool);

const migrate = (direction: 'up' | 'down', count = Infinity) =>
  runner({ databaseUrl: TEST_DB_URL, dir: MIGRATIONS_DIR, direction, migrationsTable: 'pgmigrations', count, log: () => {} });

const FILE = '0017_customer_history_contacts_index.sql';
const INDEX = 'idx_agency_contacts_customer_history';
const PLACEHOLDER = '+919999999999';

async function indexDef(name: string): Promise<string | undefined> {
  const { rows } = await pool().query<{ indexdef: string }>(
    `SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = $1`, [name]);
  return rows[0]?.indexdef;
}

/**
 * `newestContacts` at the cap (2,000), verbatim: each visible account's roster rows of the number,
 * newest first, stopped at the cap, then the newest 2,000 of those. $1 tenant, $2 phone,
 * $3 accounts.
 */
const CONTACT_WALK = `
      SELECT w.* FROM unnest($3::uuid[]) AS acc(id)
      CROSS JOIN LATERAL (
        SELECT c.id, c.campaign_id, c.created_at FROM agency_contacts c
         WHERE c.tenant_id = $1::uuid AND c.account_id = acc.id AND c.phone_e164 = $2::text
         ORDER BY c.created_at DESC, c.id DESC
         LIMIT 2000) w
      ORDER BY w.created_at DESC, w.id DESC
      LIMIT 2000`;

describe('0017 — customer history contacts index', () => {
  it('the roster index: (tenant, account, phone, created_at DESC, id DESC) INCLUDE (campaign_id)', async () => {
    expect(await indexDef(INDEX)).toBe(
      'CREATE INDEX idx_agency_contacts_customer_history ON public.agency_contacts USING btree '
      + '(tenant_id, account_id, phone_e164, created_at DESC, id DESC) INCLUDE (campaign_id)');
  });

  it('a placeholder on 5,000 roster rows: each account\'s walk is a Limit over the index, stopped at the cap, no sort under it', async () => {
    const campaign = await insertCampaign();
    // Seeded, analysed and planned in one rolled-back transaction: no row or statistic outlives it.
    // The table is of a realistic size around the placeholder (on a tiny table a full read costs
    // less than 2,000 fetches by index, which a production roster table never does).
    const client: PoolClient = await pool().connect();
    let plan: string;
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO agency_contacts (tenant_id, account_id, campaign_id, phone_e164)
         SELECT $1, $2, $3, '+9173' || lpad(g::text, 8, '0') FROM generate_series(1, 200000) g`,
        [TENANT, ACCOUNT, campaign.id]);
      await client.query(
        `INSERT INTO agency_contacts (tenant_id, account_id, campaign_id, phone_e164, created_at)
         SELECT $1, $2, $3, $4, now() - (g || ' seconds')::interval FROM generate_series(1, 5000) g`,
        [TENANT, ACCOUNT, campaign.id, PLACEHOLDER]);
      await client.query('ANALYZE agency_contacts');
      const { rows } = await client.query<{ 'QUERY PLAN': string }>(
        `EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF, SUMMARY OFF) ${CONTACT_WALK}`, [TENANT, PLACEHOLDER, [ACCOUNT]]);
      plan = rows.map((r) => r['QUERY PLAN']).join('\n');
    } finally {
      await client.query('ROLLBACK');
      // The rolled-back rows still leave their pages, and the planner sizes a table by its pages:
      // a later file's plan would see a 200,000-row roster table. VACUUM gives the pages back.
      await client.query('VACUUM agency_contacts');
      client.release();
    }
    expect(plan, plan).toMatch(new RegExp(`Limit[^\\n]*\\n\\s+->\\s+Index (Only )?Scan using ${INDEX}`));
    expect(plan, plan).toMatch(/Index Cond: .*account_id = acc\.id.*phone_e164/);
    expect(plan, plan).not.toMatch(/Seq Scan on agency_contacts/);
    // The walk stopped at the cap: 2,000 of the 5,000 entries read.
    expect(plan, plan).toMatch(new RegExp(`Scan using ${INDEX} on agency_contacts c \\(actual rows=2000 loops=1\\)`));
  }, 60_000);

  it('down drops the index; up re-applies it', async () => {
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
    await migrate('down', files.length - files.indexOf(FILE));
    try {
      const ledger = await pool().query<{ name: string }>('SELECT name FROM pgmigrations ORDER BY id DESC LIMIT 1');
      expect(ledger.rows[0]!.name).toBe('0016_customer_history_indexes');
      expect(await indexDef(INDEX)).toBeUndefined();
    } finally {
      await migrate('up');
    }
    expect(await indexDef(INDEX)).toBeDefined();
  });
});
