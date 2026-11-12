// Real Postgres: migrations/0026_inbound_live_indexes.sql (docs/inbound.md §5.3, §7; IB4, IB5).
// globalSetup has applied every migration. Pins the rebuilt insights roster index (0011's, plus
// `callback_source`, which the widened `isCallbackSql` reads; the server's insights-reads suite
// proves the as-of-now reads stay index-only on it), and the two partial indexes by definition AND
// by the planner using each for the read it exists for: pacing's per-account live read (the inbound
// arm of `countLiveForAccount`, apps/server/src/db/repositories/agency/attempt.repository.ts) on a
// table whose history is large and whose live floor is busy elsewhere, and the callback fallback's
// sweep of a catalog with no callback code (`fallBackOverdueCallbacks`, contact.repository.ts) on
// a large pending roster, each copied here verbatim because this package cannot import the server.
// Then down (gone) and up again.
import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import type { PoolClient } from 'pg';
import { runner } from 'node-pg-migrate';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { MIGRATIONS_DIR } from '../../../src/migrations-dir.js';
import { TEST_DB_URL } from '../../helpers/test-db.js';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { ACCOUNT, TENANT, insertCampaign, insertRow, insertTenant } from '../fixtures.js';

const pool = () => getTestPool();

beforeEach(async () => {
  await truncateAll();
  await insertTenant({ id: TENANT });
});
// 0024's Down refuses while an inbound call exists: leave none behind for the down → up suite.
afterAll(async () => {
  await truncateAll();
  await closeTestPool();
});

// No migration lock: nothing else migrates this file's own database copy, and after a refused
// Down the runner's unlock fails on its aborted transaction, so the lock lingers until the session
// ends, which a restore right after could race.
const migrate = (direction: 'up' | 'down', count = Infinity) =>
  runner({ databaseUrl: TEST_DB_URL, dir: MIGRATIONS_DIR, direction, migrationsTable: 'pgmigrations', count, log: () => {}, noLock: true });

const FILE = '0026_inbound_live_indexes.sql';
const CALLBACKS = 'idx_agency_contacts_inbound_callback';
const ACCOUNT_LIVE = 'idx_agency_inbound_calls_account_live';
const INSIGHTS = 'idx_agency_contacts_insights';
const INSIGHTS_0011 = 'CREATE INDEX idx_agency_contacts_insights ON public.agency_contacts USING btree (campaign_id, state) '
  + 'INCLUDE (next_attempt_at, suppressed_reason, attempt_count, dials_placed, last_outcome, last_disposition, assigned_user_id)';
const INSIGHTS_0026 = INSIGHTS_0011.replace('assigned_user_id)', 'assigned_user_id, callback_source)');

async function indexDef(name: string): Promise<string | undefined> {
  const { rows } = await pool().query<{ indexdef: string }>(
    `SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = $1`, [name]);
  return rows[0]?.indexdef;
}

/** ANALYZE inside a rolled-back transaction, never bare (statistics outlive the rows). */
async function planOf(sql: string, params: unknown[], table = 'agency_inbound_calls'): Promise<string> {
  const client: PoolClient = await pool().connect();
  try {
    await client.query('BEGIN');
    await client.query(`ANALYZE ${table}`);
    const { rows } = await client.query<{ 'QUERY PLAN': string }>(`EXPLAIN (COSTS OFF) ${sql}`, params);
    return rows.map((r) => r['QUERY PLAN']).join('\n');
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

/** The inbound arm of `countLiveForAccount`, verbatim. */
const ACCOUNT_LIVE_COUNT = `SELECT COUNT(*) FROM agency_inbound_calls i
           WHERE i.account_id = $2::uuid AND i.tenant_id = $1::uuid AND i.state <> 'ended' AND i.state <> 'arrived'`;

/**
 * The callback fallback's pick on a catalog with no callback code (`fallBackOverdueCallbacks`'s
 * `due` CTE with `contactBucketSql` and `presentSessionSql` expanded), verbatim but for the batch
 * id parameter, which only the UPDATE after it reads ($5 → $4 here).
 */
const FALLBACK_INBOUND_ONLY = `SELECT c.id, c.assigned_user_id
           FROM agency_contacts c
          WHERE c.campaign_id = $1::uuid
            AND c.state = 'pending'
            AND c.assigned_user_id IS NOT NULL
            AND c.next_attempt_at <= now() - make_interval(mins => $2::int)
            AND c.callback_source IS NOT NULL
            AND (CASE
    WHEN c.state IN ('in_flight', 'connected') THEN 'in_progress'
    WHEN c.state = 'completed' THEN 'reached'
    WHEN c.state = 'exhausted' THEN 'exhausted'
    WHEN c.state = 'suppressed' OR c.suppressed_reason = 'dnc' THEN 'suppressed'
    WHEN (c.callback_source IS NOT NULL OR (c.last_disposition = ANY($3::text[]) AND c.last_outcome IS NOT DISTINCT FROM 'connected')) THEN 'callback'
    WHEN c.attempt_count > 0 AND c.last_outcome IS DISTINCT FROM 'connected' THEN 'not_reached'
    ELSE 'pending'
  END) = 'callback'
            AND NOT EXISTS (
              SELECT 1 FROM agency_agent_sessions s
               WHERE s.campaign_id = $1::uuid AND s.agent_user_id = c.assigned_user_id
                 AND (s.left_at IS NULL AND s.state <> 'offline'))
          ORDER BY c.next_attempt_at
          LIMIT $4
            FOR UPDATE OF c SKIP LOCKED`;

describe('0026 — the live inbound calls index and the inbound callbacks index', () => {
  it('the per-account index: (tenant, account) over the live rows only', async () => {
    expect(await indexDef(ACCOUNT_LIVE)).toBe(
      'CREATE INDEX idx_agency_inbound_calls_account_live ON public.agency_inbound_calls USING btree '
      + '(tenant_id, account_id) WHERE (((state)::text <> \'ended\'::text) AND ((state)::text <> \'arrived\'::text))');
  });

  it('the inbound callbacks index: (campaign) over the contacts with an inbound callback only', async () => {
    expect(await indexDef(CALLBACKS)).toBe(
      'CREATE INDEX idx_agency_contacts_inbound_callback ON public.agency_contacts USING btree (campaign_id) '
      + 'WHERE (callback_source IS NOT NULL)');
  });

  it('the insights roster index carries callback_source, keeping 0011\'s comment', async () => {
    expect(await indexDef(INSIGHTS)).toBe(INSIGHTS_0026);
    const { rows } = await pool().query<{ c: string }>(`SELECT obj_description('idx_agency_contacts_insights'::regclass, 'pg_class') AS c`);
    expect(rows[0]!.c).toMatch(/^Insights as-of-now reads/);
    expect(await indexDef('idx_agency_contacts_insights_0026')).toBeUndefined();
  });

  it('pacing\'s per-account count reads it, with a large history and many calls live on other accounts', async () => {
    const route = await insertRow('agency_inbound_routes', { tenant_id: TENANT, account_id: ACCOUNT, name: 'Main', timezone: 'Europe/London' });
    // History: 20,000 ended calls over 50 accounts and their routes, this account's and route's
    // among them (a 1/50 share, as a busy tenant's): the floor is small, the history is not.
    await pool().query(
      `INSERT INTO agency_inbound_calls (tenant_id, account_id, route_id, provider_call_id, to_e164, state, outcome, ended_at,
                                         follow_up_status, follow_up_reason)
       SELECT $1,
              CASE WHEN g % 50 = 0 THEN $3::uuid ELSE ('00000000-0000-4000-8000-' || lpad((g % 50)::text, 12, '0'))::uuid END,
              CASE WHEN g % 50 = 0 THEN $2::uuid ELSE ('00000000-0000-4000-9000-' || lpad((g % 50)::text, 12, '0'))::uuid END,
              'CA-' || g, '+14155550100', 'ended', 'closed', now(), 'open', 'closed'
         FROM generate_series(1, 20000) g`, [TENANT, route.id, ACCOUNT]);
    // A busy floor elsewhere: 3,000 live calls on 50 other accounts' routes (the spine has no FK on route_id).
    await pool().query(
      `INSERT INTO agency_inbound_calls (tenant_id, account_id, route_id, provider_call_id, to_e164, state)
       SELECT $1, ('00000000-0000-4000-8000-' || lpad((g % 50)::text, 12, '0'))::uuid,
              ('00000000-0000-4000-9000-' || lpad((g % 50)::text, 12, '0'))::uuid, 'CA-live-' || g, '+14155550100', 'greeting'
         FROM generate_series(1, 3000) g`, [TENANT]);
    // Two admitted, and one turned away (`arrived`: it hears "busy" and is not counted).
    for (const state of ['arrived', 'greeting', 'greeting']) {
      await insertRow('agency_inbound_calls', {
        tenant_id: TENANT, account_id: ACCOUNT, route_id: route.id, provider_call_id: `CA-${randomUUID()}`, to_e164: '+14155550100', state,
      });
    }
    const account = await planOf(ACCOUNT_LIVE_COUNT, [TENANT, ACCOUNT]);
    expect(account).toMatch(new RegExp(`Index Only Scan using ${ACCOUNT_LIVE}|Index Scan using ${ACCOUNT_LIVE}|Bitmap Index Scan on ${ACCOUNT_LIVE}`));
    expect(account).not.toMatch(/idx_agency_inbound_calls_open/);
    expect(Number((await pool().query(ACCOUNT_LIVE_COUNT, [TENANT, ACCOUNT])).rows[0].count)).toBe(2);
  });

  it('the callback fallback on a catalog with no callback code reads it, not the campaign\'s pending roster', async () => {
    const campaign = await insertCampaign({ status: 'running' });
    // A large pending roster, every row owned and overdue, and two inbound callbacks among it.
    await pool().query(
      `INSERT INTO agency_contacts (campaign_id, tenant_id, account_id, phone_e164, state, assigned_user_id, assigned_at, next_attempt_at)
       SELECT $1, $2, $3, '+1415555' || lpad((g % 10000)::text, 4, '0'), 'pending', $4, now(), now() - interval '1 day'
         FROM generate_series(1, 20000) g`, [campaign.id, TENANT, ACCOUNT, randomUUID()]);
    await pool().query(
      `UPDATE agency_contacts SET callback_source = 'inbound', callback_due_at = now() - interval '1 day'
        WHERE id IN (SELECT id FROM agency_contacts WHERE campaign_id = $1 LIMIT 2)`, [campaign.id]);
    const plan = await planOf(FALLBACK_INBOUND_ONLY, [campaign.id, 10, [], 1000], 'agency_contacts');
    expect(plan).toMatch(new RegExp(`Index Scan using ${CALLBACKS}|Bitmap Index Scan on ${CALLBACKS}`));
    expect(plan).not.toMatch(/idx_agency_contacts_insights|idx_agency_contacts_ready|Seq Scan on agency_contacts c/);
  });

  it('down drops the live index and restores 0011\'s insights index; up re-applies both', async () => {
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
    await migrate('down', files.length - files.indexOf(FILE));
    try {
      const ledger = await pool().query<{ name: string }>('SELECT name FROM pgmigrations ORDER BY id DESC LIMIT 1');
      expect(ledger.rows[0]!.name).toBe(files[files.indexOf(FILE) - 1]!.replace(/\.sql$/, ''));
      expect(await indexDef(ACCOUNT_LIVE)).toBeUndefined();
      expect(await indexDef(CALLBACKS)).toBeUndefined();
      expect(await indexDef(INSIGHTS)).toBe(INSIGHTS_0011);
      expect(await indexDef('idx_agency_contacts_insights_0011')).toBeUndefined();
    } finally {
      await migrate('up');
    }
    expect(await indexDef(ACCOUNT_LIVE)).toBeDefined();
    expect(await indexDef(CALLBACKS)).toBeDefined();
    expect(await indexDef(INSIGHTS)).toBe(INSIGHTS_0026);
  });
});
