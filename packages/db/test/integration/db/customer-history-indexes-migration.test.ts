// Real Postgres: migrations/0016_customer_history_indexes.sql (docs/customer-history.md, CH9).
// globalSetup has applied every migration. Pins the soft-phone destination index by definition
// AND by the planner walking it for the history's keyset read: the per-account probe of
// `CUSTOMER_HISTORY_SQL.pageManualCalls` (apps/server/src/db/repositories/agency/
// customer-history.repository.ts), copied here verbatim because this package cannot import the
// server; the server's own suite EXPLAINs the whole statement. The trailing `created_at DESC,
// id DESC` columns are what put the cursor in the index condition and leave no sort. Then down
// (the index is gone) and up again.
import { readdirSync } from 'node:fs';
import type { PoolClient } from 'pg';
import { runner } from 'node-pg-migrate';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { MIGRATIONS_DIR } from '../../../src/migrations-dir.js';
import { TEST_DB_URL } from '../../helpers/test-db.js';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { ACCOUNT, insertSoftphoneSession, TENANT } from '../fixtures.js';

const pool = () => getTestPool();

beforeEach(truncateAll);
afterAll(closeTestPool);

const migrate = (direction: 'up' | 'down', count = Infinity) =>
  runner({ databaseUrl: TEST_DB_URL, dir: MIGRATIONS_DIR, direction, migrationsTable: 'pgmigrations', count, log: () => {} });

const FILE = '0016_customer_history_indexes.sql';
const INDEX = 'idx_agency_manual_calls_destination';

async function indexDef(name: string): Promise<string | undefined> {
  const { rows } = await pool().query<{ indexdef: string }>(
    `SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = $1`, [name]);
  return rows[0]?.indexdef;
}

/** The plan for `sql`, every plan type allowed, on analysed tables. */
async function planOf(sql: string, params: unknown[]): Promise<string> {
  const client: PoolClient = await pool().connect();
  try {
    const { rows } = await client.query<{ 'QUERY PLAN': string }>(`EXPLAIN (COSTS OFF) ${sql}`, params);
    return rows.map((r) => r['QUERY PLAN']).join('\n');
  } finally {
    client.release();
  }
}

/**
 * The destination branch of `CUSTOMER_HISTORY_SQL.pageManualCalls`, verbatim (its filters
 * expanded): one account's calls to the number strictly after the cursor, newest first. $1 tenant,
 * $2 phone, $3 accounts, $4/$5 the cursor, $6 limit, $7/$8 from/to, $9 root campaigns, $10–$13 the
 * call-only filters.
 */
const DESTINATION_PROBE = `
      SELECT d.id, d.created_at FROM unnest($3::uuid[]) AS acc(id)
      CROSS JOIN LATERAL (
        SELECT m.id, m.created_at FROM agency_manual_calls m
         WHERE m.tenant_id = $1::uuid AND m.account_id = acc.id AND m.destination_e164 = $2::text
           AND (m.created_at, m.id) < ($4::timestamptz, $5::uuid)
           AND ($7::timestamptz IS NULL OR m.created_at >= $7::timestamptz) AND ($8::timestamptz IS NULL OR m.created_at < $8::timestamptz)
           AND ($9::uuid[] IS NULL OR EXISTS (
         SELECT 1 FROM agency_campaigns g9 WHERE g9.id = m.campaign_id AND COALESCE(g9.root_campaign_id, g9.id) = ANY($9::uuid[])))
           AND ($10::text[] IS NULL OR m.outcome = ANY($10::text[]))
       AND ($11::text[] IS NULL OR m.disposition_code = ANY($11::text[]))
       AND ($12::uuid[] IS NULL OR m.agent_user_id = ANY($12::uuid[]))
       AND (NOT $13::boolean OR m.outcome = 'connected')
         ORDER BY m.created_at DESC, m.id DESC
         LIMIT $6::int) d`;

describe('0016 — customer history indexes', () => {
  it('the soft-phone destination index: (tenant, account, destination, created_at DESC, id DESC)', async () => {
    expect(await indexDef(INDEX)).toBe(
      'CREATE INDEX idx_agency_manual_calls_destination ON public.agency_manual_calls USING btree '
      + '(tenant_id, account_id, destination_e164, created_at DESC, id DESC)');
  });

  it('the history\'s keyset probe walks it in order: keys and cursor in the index condition, no sort', async () => {
    // A tenant with a real amount of soft-phone calls to other numbers, analysed.
    const session = await insertSoftphoneSession();
    await pool().query(
      `INSERT INTO agency_manual_calls (tenant_id, account_id, session_id, agent_user_id, destination_e164, caller_id,
                                        state, ended_at, settled_at, created_at)
       SELECT $1, $2, $3, gen_random_uuid(), '+9170' || lpad((g % 1500)::text, 8, '0'), '+14155550100',
              'ended', now(), now(), now() - (g || ' minutes')::interval
         FROM generate_series(1, 6000) g`, [TENANT, ACCOUNT, session.id]);
    await pool().query('ANALYZE agency_manual_calls');
    const plan = await planOf(DESTINATION_PROBE, [
      TENANT, '+917000000042', [ACCOUNT], '2026-11-06T10:00:00.123456Z', 'ffffffff-ffff-ffff-ffff-ffffffffffff', 51,
      null, null, null, null, null, null, false,
    ]);
    expect(plan).toMatch(new RegExp(`Limit\\n\\s+->\\s+Index (Only )?Scan using ${INDEX}`));
    expect(plan).toMatch(/Index Cond: .*destination_e164.*ROW\(created_at, id\) < ROW\(/);
    expect(plan).not.toMatch(/\bSort\b/);
  });

  it('down drops the index; up re-applies it', async () => {
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
    await migrate('down', files.length - files.indexOf(FILE));
    try {
      const ledger = await pool().query<{ name: string }>('SELECT name FROM pgmigrations ORDER BY id DESC LIMIT 1');
      expect(ledger.rows[0]!.name).toBe('0015_multiple_running_campaigns');
      expect(await indexDef(INDEX)).toBeUndefined();
    } finally {
      await migrate('up');
    }
    expect(await indexDef(INDEX)).toBeDefined();
  });
});
