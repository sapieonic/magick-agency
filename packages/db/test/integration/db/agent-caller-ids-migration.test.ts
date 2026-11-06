// Real Postgres: migrations/0016_agent_caller_ids.sql (docs/decisions.md, DN1). globalSetup has
// applied every migration. Pins the table's two uniqueness rules (one number per agent per
// campaign, one agent per number per campaign; the same number free on another campaign), the
// trimmed-number CHECK, the cascades (tenant, user) and SET NULL (the supervisor), the index the
// unstaff release and the user cascade read, and down then up.
import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { runner } from 'node-pg-migrate';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { MIGRATIONS_DIR } from '../../../src/migrations-dir.js';
import { TEST_DB_URL } from '../../helpers/test-db.js';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { insertAccount, insertRow, insertTenant, insertUser } from '../fixtures.js';

const pool = () => getTestPool();

beforeEach(truncateAll);
afterAll(closeTestPool);

const migrate = (direction: 'up' | 'down', count = Infinity) =>
  runner({ databaseUrl: TEST_DB_URL, dir: MIGRATIONS_DIR, direction, migrationsTable: 'pgmigrations', count, log: () => {} });

const FILE = '0016_agent_caller_ids.sql';
const TABLE = 'agency_campaign_agent_caller_ids';

async function indexDef(name: string): Promise<string | undefined> {
  const { rows } = await pool().query<{ indexdef: string }>(
    `SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = $1`, [name]);
  return rows[0]?.indexdef;
}

async function tableExists(): Promise<boolean> {
  const { rows } = await pool().query<{ t: string | null }>(`SELECT to_regclass('public.${TABLE}')::text AS t`);
  return rows[0]!.t !== null;
}

async function seed() {
  const tenant = await insertTenant();
  const account = await insertAccount(tenant.id);
  const agentA = await insertUser();
  const agentB = await insertUser();
  const supervisor = await insertUser();
  return { tenant: tenant.id, account: account.id, agentA: agentA.id, agentB: agentB.id, supervisor: supervisor.id };
}

function dedicate(s: Awaited<ReturnType<typeof seed>>, o: Record<string, unknown>) {
  return insertRow(TABLE, { tenant_id: s.tenant, account_id: s.account, set_by_user_id: s.supervisor, ...o });
}

describe('0016 — agency_campaign_agent_caller_ids', () => {
  it('one number per agent per campaign, one agent per number per campaign; free on another campaign', async () => {
    const s = await seed();
    const campaign = randomUUID();
    const row = await dedicate(s, { campaign_id: campaign, user_id: s.agentA, caller_id: '+918041000001' });
    expect(row).toMatchObject({ campaign_id: campaign, user_id: s.agentA, caller_id: '+918041000001' });
    expect(row['set_at']).toBeInstanceOf(Date);

    await expect(dedicate(s, { campaign_id: campaign, user_id: s.agentA, caller_id: '+918041000002' }))
      .rejects.toMatchObject({ code: '23505', constraint: 'uq_agency_agent_caller_id_agent' });
    await expect(dedicate(s, { campaign_id: campaign, user_id: s.agentB, caller_id: '+918041000001' }))
      .rejects.toMatchObject({ code: '23505', constraint: 'uq_agency_agent_caller_id_number' });
    // Another campaign: the same number (to another agent) and the same agent (another number).
    const other = randomUUID();
    await expect(dedicate(s, { campaign_id: other, user_id: s.agentB, caller_id: '+918041000001' })).resolves.toBeTruthy();
    await expect(dedicate(s, { campaign_id: randomUUID(), user_id: s.agentA, caller_id: '+918041000009' })).resolves.toBeTruthy();
  });

  it('the number is stored trimmed and non-empty', async () => {
    const s = await seed();
    for (const bad of ['', ' +918041000001', '+918041000001 ']) {
      await expect(dedicate(s, { campaign_id: randomUUID(), user_id: s.agentA, caller_id: bad }))
        .rejects.toMatchObject({ code: '23514', constraint: 'ck_agency_agent_caller_id_trimmed' });
    }
    await expect(dedicate(s, { campaign_id: randomUUID(), user_id: s.agentA, caller_id: '+9180410000011234567' }))
      .resolves.toBeTruthy();
    await expect(dedicate(s, { campaign_id: randomUUID(), user_id: s.agentA, caller_id: '+91804100000112345678' }))
      .rejects.toMatchObject({ code: '22001' });
  });

  it('cascades with the agent and the tenant; the supervisor who set it is nulled', async () => {
    const s = await seed();
    const keep = await dedicate(s, { campaign_id: randomUUID(), user_id: s.agentB, caller_id: '+918041000002' });
    await dedicate(s, { campaign_id: randomUUID(), user_id: s.agentA, caller_id: '+918041000001' });
    await pool().query('DELETE FROM users WHERE id = $1', [s.supervisor]);
    await pool().query('DELETE FROM users WHERE id = $1', [s.agentA]);
    const { rows } = await pool().query<{ id: string; set_by_user_id: string | null }>(`SELECT id, set_by_user_id FROM ${TABLE}`);
    expect(rows).toEqual([{ id: keep.id, set_by_user_id: null }]);
    await pool().query('DELETE FROM tenants WHERE id = $1', [s.tenant]);
    expect((await pool().query(`SELECT 1 FROM ${TABLE}`)).rowCount).toBe(0);
  });

  it('the indexes: the two unique pairs lead with the campaign; the agent index for the release and the cascade', async () => {
    expect(await indexDef('uq_agency_agent_caller_id_agent')).toBe(
      `CREATE UNIQUE INDEX uq_agency_agent_caller_id_agent ON public.${TABLE} USING btree (campaign_id, user_id)`);
    expect(await indexDef('uq_agency_agent_caller_id_number')).toBe(
      `CREATE UNIQUE INDEX uq_agency_agent_caller_id_number ON public.${TABLE} USING btree (campaign_id, caller_id)`);
    expect(await indexDef('idx_agency_agent_caller_ids_user')).toBe(
      `CREATE INDEX idx_agency_agent_caller_ids_user ON public.${TABLE} USING btree (user_id)`);
  });

  it('down drops the table (and its rows); up re-creates it empty', async () => {
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
    const s = await seed();
    await dedicate(s, { campaign_id: randomUUID(), user_id: s.agentA, caller_id: '+918041000001' });
    await migrate('down', files.length - files.indexOf(FILE));
    try {
      const ledger = await pool().query<{ name: string }>('SELECT name FROM pgmigrations ORDER BY id DESC LIMIT 1');
      expect(ledger.rows[0]!.name).toBe('0015_multiple_running_campaigns');
      expect(await tableExists()).toBe(false);
    } finally {
      await migrate('up');
    }
    expect(await tableExists()).toBe(true);
    expect((await pool().query(`SELECT 1 FROM ${TABLE}`)).rowCount).toBe(0);
    await expect(dedicate(s, { campaign_id: randomUUID(), user_id: s.agentA, caller_id: '+918041000001' })).resolves.toBeTruthy();
  });
});
