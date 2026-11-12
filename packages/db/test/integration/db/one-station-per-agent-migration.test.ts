// Real Postgres: migrations/0034_one_station_per_agent.sql (OS1, OS3; docs/decisions.md "One
// station per agent"). globalSetup has applied every migration. Pins the new arbiter, the device
// column, the clean-up of an agent live in two tenants when the migration runs (the newest
// heartbeat stays, the others are left with their transition logged) and down then up.
import { readdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { runner } from 'node-pg-migrate';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { MIGRATIONS_DIR } from '../../../src/migrations-dir.js';
import { TEST_DB_URL } from '../../helpers/test-db.js';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { insertCampaign, insertSession, insertSoftphoneSession } from '../fixtures.js';

const pool = () => getTestPool();

beforeEach(truncateAll);
afterAll(async () => {
  await truncateAll();
  await closeTestPool();
});

const migrate = (direction: 'up' | 'down', count = Infinity) =>
  runner({ databaseUrl: TEST_DB_URL, dir: MIGRATIONS_DIR, direction, migrationsTable: 'pgmigrations', count, log: () => {} });

const FILE = '0034_one_station_per_agent.sql';

/** Down to just before 0034; returns the restore (up to the top). */
async function downBefore0034(): Promise<() => Promise<void>> {
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  await migrate('down', files.length - files.indexOf(FILE));
  return async () => { await migrate('up'); };
}

async function indexDef(name: string): Promise<string | undefined> {
  const { rows } = await pool().query<{ indexdef: string }>(
    `SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = $1`, [name]);
  return rows[0]?.indexdef;
}

async function deviceColumn(): Promise<{ data_type: string; character_maximum_length: number; is_nullable: string; column_default: string | null } | undefined> {
  const { rows } = await pool().query(
    `SELECT data_type, character_maximum_length, is_nullable, column_default
       FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'agency_agent_sessions' AND column_name = 'station_device_id'`,
  );
  return rows[0];
}

describe('0034 — one station per agent', () => {
  it('the arbiter is the agent alone, over live sessions', async () => {
    expect(await indexDef('uq_agency_agent_live_agent')).toBe(
      'CREATE UNIQUE INDEX uq_agency_agent_live_agent ON public.agency_agent_sessions '
      + 'USING btree (agent_user_id) WHERE (left_at IS NULL)');
  });

  it('keeps the per-tenant index, so the image before 0034 still finds its ON CONFLICT arbiter (rollback)', async () => {
    expect(await indexDef('uq_agency_agent_live_tenant')).toBe(
      'CREATE UNIQUE INDEX uq_agency_agent_live_tenant ON public.agency_agent_sessions '
      + 'USING btree (tenant_id, agent_user_id) WHERE (left_at IS NULL)');
    // The previous image's upsert, verbatim in its conflict target: it must plan and run.
    const campaign = await insertCampaign();
    const agent = randomUUID();
    const upsert = () => pool().query(
      `INSERT INTO agency_agent_sessions (tenant_id, account_id, campaign_id, agent_user_id, state)
       VALUES ($1, $2, $3, $4, 'break')
       ON CONFLICT (tenant_id, agent_user_id) WHERE left_at IS NULL
       DO UPDATE SET last_heartbeat = now()
       RETURNING id`,
      [campaign['tenant_id'], campaign['account_id'], campaign['id'], agent],
    );
    const first = await upsert();
    const again = await upsert();
    expect(again.rows[0].id).toBe(first.rows[0].id);
  });

  it('station_device_id is VARCHAR(64), nullable, no default: every older session holds no device', async () => {
    expect(await deviceColumn()).toMatchObject({
      data_type: 'character varying', character_maximum_length: 64, is_nullable: 'YES', column_default: null,
    });
    const campaign = await insertCampaign();
    const session = await insertSession(campaign.id);
    expect(session['station_device_id']).toBeNull();
  });

  it('an agent live in two tenants when it runs keeps only the newest heartbeat; the other is left and logged', async () => {
    const restore = await downBefore0034();
    const agent = randomUUID();
    const bystander = randomUUID();
    let keep: Record<string, unknown>;
    let older: Record<string, unknown>;
    let oldest: Record<string, unknown>;
    let alone: Record<string, unknown>;
    try {
      const campaign = await insertCampaign();
      const otherTenant = randomUUID();
      const otherCampaign = await insertCampaign({ tenant_id: otherTenant });
      // Three tenants, three live sessions for one agent (allowed before 0034).
      keep = await insertSession(campaign.id, { agent_user_id: agent, state: 'available', last_heartbeat: new Date(Date.now() - 1_000) });
      older = await insertSession(otherCampaign.id, {
        agent_user_id: agent, tenant_id: otherTenant, state: 'on_call', last_heartbeat: new Date(Date.now() - 60_000),
      });
      oldest = await insertSoftphoneSession({
        agent_user_id: agent, tenant_id: randomUUID(), state: 'offline', last_heartbeat: new Date(Date.now() - 600_000),
      });
      alone = await insertSession(campaign.id, { agent_user_id: bystander });
    } catch (err) {
      await restore();
      throw err;
    }
    await restore();

    const { rows } = await pool().query<{ id: string; state: string; left: boolean }>(
      'SELECT id, state, left_at IS NOT NULL AS left FROM agency_agent_sessions WHERE id = ANY($1::uuid[])',
      [[keep['id'], older['id'], oldest['id'], alone['id']]],
    );
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(byId[keep['id'] as string]).toMatchObject({ state: 'available', left: false });
    expect(byId[alone['id'] as string]).toMatchObject({ left: false });
    expect(byId[older['id'] as string]).toMatchObject({ state: 'offline', left: true });
    expect(byId[oldest['id'] as string]).toMatchObject({ state: 'offline', left: true });

    // The one that was working gets its interval closed; one already offline logs nothing.
    const events = await pool().query<{ session_id: string; from_state: string; to_state: string }>(
      'SELECT session_id, from_state, to_state FROM agency_agent_session_events WHERE agent_user_id = $1', [agent]);
    expect(events.rows).toEqual([{ session_id: older['id'], from_state: 'on_call', to_state: 'offline' }]);
  });

  it('down drops the agent index and the column, keeping the per-tenant index; up restores both', async () => {
    const restore = await downBefore0034();
    try {
      expect(await indexDef('uq_agency_agent_live_agent')).toBeUndefined();
      expect(await indexDef('uq_agency_agent_live_tenant')).toBe(
        'CREATE UNIQUE INDEX uq_agency_agent_live_tenant ON public.agency_agent_sessions '
        + 'USING btree (tenant_id, agent_user_id) WHERE (left_at IS NULL)');
      expect(await deviceColumn()).toBeUndefined();
    } finally {
      await restore();
    }
    expect(await indexDef('uq_agency_agent_live_agent')).toBeDefined();
    expect(await deviceColumn()).toBeDefined();
  });
});
