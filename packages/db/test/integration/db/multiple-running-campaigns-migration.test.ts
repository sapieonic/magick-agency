// Real Postgres: migrations/0015_multiple_running_campaigns.sql (docs/decisions.md, MC4 and MC6).
// globalSetup has applied every migration. Pins that uq_agency_campaign_running is gone (an
// account may run several campaigns), the account-wide live-number index by definition AND by the
// planner being able to use it for the claims' busy probe (a partial index whose predicate the
// query does not imply is never chosen, and that is invisible in the definition alone), and down
// (refused while an account runs two campaigns; otherwise the unique index is back) then up.
import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import type { PoolClient } from 'pg';
import { runner } from 'node-pg-migrate';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { MIGRATIONS_DIR } from '../../../src/migrations-dir.js';
import { TEST_DB_URL } from '../../helpers/test-db.js';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { ACCOUNT, TENANT, insertCampaign } from '../fixtures.js';

const pool = () => getTestPool();

beforeEach(truncateAll);
afterAll(closeTestPool);

const migrate = (direction: 'up' | 'down', count = Infinity) =>
  runner({ databaseUrl: TEST_DB_URL, dir: MIGRATIONS_DIR, direction, migrationsTable: 'pgmigrations', count, log: () => {} });

const FILE = '0015_multiple_running_campaigns.sql';
const INDEX = 'idx_agency_contacts_account_live_digits';

async function indexDef(name: string): Promise<string | undefined> {
  const { rows } = await pool().query<{ indexdef: string }>(
    `SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = $1`, [name]);
  return rows[0]?.indexdef;
}

/**
 * The plan for `sql` with sequential scans priced out (see attempt-indexes-migration.test.ts), over
 * a roster of this test's own, ANALYZEd inside the rolled-back transaction (the column statistics
 * leave with the rows; the table's reltuples and relpages, written in place, do not: see
 * insertPlanRoster in ../fixtures.ts).
 *
 * Without its own rows the plan followed whatever statistics earlier files left on
 * agency_contacts: on a table last analyzed empty (reltuples 0, no column statistics) the planner
 * prices every index alike and serves the probe's `live` side from
 * idx_agency_contacts_customer_history (0017; tenant, account, then the number as stored),
 * filtering the digits and the states, so the probe below failed in a full run and passed alone.
 * The roster here is a campaign's shape: 20,000 rows over 10,000 numbers on this account, 1% in
 * flight and 1% connected, the rest pending or done; the plan is then decided by the indexes'
 * merits, every run.
 */
async function planOf(sql: string): Promise<string> {
  const client: PoolClient = await pool().connect();
  try {
    await client.query('BEGIN');
    const campaign = randomUUID();
    await client.query(
      `INSERT INTO agency_campaigns (id, tenant_id, account_id, name, caller_ids) VALUES ($1, $2, $3, 'Roster', ARRAY['+14155550100'])`,
      [campaign, TENANT, ACCOUNT]);
    await client.query(
      `INSERT INTO agency_contacts (campaign_id, tenant_id, account_id, phone_e164, state)
       SELECT $1, $2, $3, '+1415555' || lpad((g % 10000)::text, 4, '0'),
              CASE WHEN g % 100 = 0 THEN 'in_flight' WHEN g % 100 = 1 THEN 'connected'
                   WHEN g % 2 = 0 THEN 'pending' ELSE 'completed' END
         FROM generate_series(1, 20000) g`,
      [campaign, TENANT, ACCOUNT]);
    await client.query('ANALYZE agency_contacts');
    await client.query('SET LOCAL enable_seqscan = off');
    const { rows } = await client.query<{ 'QUERY PLAN': string }>(`EXPLAIN (COSTS OFF) ${sql}`);
    return rows.map((r) => r['QUERY PLAN']).join('\n');
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

describe('0015 — several running campaigns per account', () => {
  it('uq_agency_campaign_running is gone: one account may run two campaigns', async () => {
    expect(await indexDef('uq_agency_campaign_running')).toBeUndefined();
    await insertCampaign({ status: 'running' });
    await expect(insertCampaign({ status: 'running' })).resolves.toBeTruthy();
    const { rows } = await pool().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM agency_campaigns WHERE tenant_id = $1 AND account_id = $2 AND status = 'running'`,
      [TENANT, ACCOUNT]);
    expect(rows[0]!.n).toBe(2);
  });

  it('the live-number index: (tenant, account, the digits) partial on in_flight and connected', async () => {
    const def = await indexDef(INDEX);
    expect(def).toMatch(/^CREATE INDEX idx_agency_contacts_account_live_digits ON public\.agency_contacts USING btree \(tenant_id, account_id, /);
    // The same parsed expression as idx_agency_contacts_campaign_phone_digits (CONTACT_PHONE_DIGITS_SQL).
    expect(def).toContain("regexp_replace((phone_e164)::text, '[^0-9]'::text, ''::text, 'g'::text)");
    expect(def).toMatch(/WHERE \(\(state\)::text = ANY \(.*'in_flight'.*'connected'.*\)\)$/);
  });

  it('the claims\' busy probe (numberLiveSql\'s text) is served by it', async () => {
    // numberLiveSql('c') against one candidate row, as the claim spells it.
    const probe = await planOf(
      `SELECT c.id FROM agency_contacts c
        WHERE c.campaign_id = '00000000-0000-0000-0000-000000000001'::uuid
          AND c.state = 'pending' AND c.next_attempt_at <= now()
          AND NOT EXISTS (
              SELECT 1 FROM agency_contacts live
               WHERE live.tenant_id = c.tenant_id
                 AND live.account_id = c.account_id
                 AND regexp_replace(live.phone_e164, '[^0-9]', '', 'g') = regexp_replace(c.phone_e164, '[^0-9]', '', 'g')
                 AND live.state IN ('in_flight', 'connected'))`);
    expect(probe).toContain(INDEX);
    // And with every key bound: an index condition on all three columns, the predicate implied.
    const point = await planOf(
      `SELECT 1 FROM agency_contacts live
        WHERE live.tenant_id = '${TENANT}'::uuid AND live.account_id = '${ACCOUNT}'::uuid
          AND regexp_replace(live.phone_e164, '[^0-9]', '', 'g') = '14155550101'
          AND live.state IN ('in_flight', 'connected')`);
    // Index Scan or Bitmap Index Scan, whichever the near-empty table prices lower; either way
    // the digits are an index condition, not a filter on rows the index returned.
    expect(point).toContain(INDEX);
    expect(point).toMatch(/Index Cond: .*account_id.*regexp_replace/);
  });

  it('down refuses while an account runs two campaigns, and changes nothing', async () => {
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
    const after = files.length - files.indexOf(FILE) - 1;
    if (after > 0) await migrate('down', after);
    try {
      await insertCampaign({ status: 'running' });
      await insertCampaign({ status: 'running' });
      await expect(migrate('down', 1)).rejects.toThrow(/more than one running campaign/);
      const ledger = await pool().query<{ name: string }>('SELECT name FROM pgmigrations ORDER BY id DESC LIMIT 1');
      expect(ledger.rows[0]!.name).toBe('0015_multiple_running_campaigns');
      expect(await indexDef(INDEX)).toBeDefined();
      expect(await indexDef('uq_agency_campaign_running')).toBeUndefined();
    } finally {
      // Unconditional: a no-op when nothing is pending, and a restore if the down ever ran.
      await migrate('up');
    }
  });

  it('down restores uq_agency_campaign_running and drops the live-number index; up re-applies', async () => {
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
    // One running campaign per account, on two accounts: the restored index accepts them.
    await insertCampaign({ status: 'running' });
    await insertCampaign({ status: 'running', account_id: randomUUID() });
    await migrate('down', files.length - files.indexOf(FILE));
    try {
      const ledger = await pool().query<{ name: string }>('SELECT name FROM pgmigrations ORDER BY id DESC LIMIT 1');
      expect(ledger.rows[0]!.name).toBe('0014_insights_rollup_first_dials_carrier_errors');
      expect(await indexDef(INDEX)).toBeUndefined();
      expect(await indexDef('uq_agency_campaign_running')).toBe(
        'CREATE UNIQUE INDEX uq_agency_campaign_running ON public.agency_campaigns USING btree (tenant_id, account_id) '
        + "WHERE ((status)::text = 'running'::text)");
      await expect(insertCampaign({ status: 'running' })).rejects.toMatchObject({
        code: '23505', constraint: 'uq_agency_campaign_running',
      });
    } finally {
      await migrate('up');
    }
    expect(await indexDef('uq_agency_campaign_running')).toBeUndefined();
    expect(await indexDef(INDEX)).toBeDefined();
    await expect(insertCampaign({ status: 'running' })).resolves.toBeTruthy();
  });
});
