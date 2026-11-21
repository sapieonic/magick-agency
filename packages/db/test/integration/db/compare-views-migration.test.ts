// Real Postgres: migrations/0063_compare_views.sql (docs/compare-agents.md; wire shape
// AgencyCompareView in packages/contracts/src/api/agency/compare.ts). globalSetup has applied every
// migration. Pins agency_compare_views (columns, every CHECK both ways, the one-default-per-campaign
// unique index, the cascades from tenants and campaigns), its listing indexes and the plans that read
// them, the lock timeout on Up and Down, then down and up again.
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { runner } from 'node-pg-migrate';
import type { PoolClient } from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { MIGRATIONS_DIR } from '../../../src/migrations-dir.js';
import { TEST_DB_URL } from '../../helpers/test-db.js';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { ACCOUNT, insertCampaign, insertRow, insertTenant } from '../fixtures.js';

const pool = () => getTestPool();
const FILE = '0063_compare_views.sql';

let tenantId: string;
let campaignId: string;
beforeEach(async () => {
  await truncateAll();
  tenantId = (await insertTenant()).id as string;
  campaignId = (await insertCampaign({ tenant_id: tenantId })).id as string;
});
afterAll(closeTestPool);

// No migration lock: nothing else migrates this file's own database copy.
const migrate = (direction: 'up' | 'down', count = Infinity) =>
  runner({ databaseUrl: TEST_DB_URL, dir: MIGRATIONS_DIR, direction, migrationsTable: 'pgmigrations', count, log: () => {}, noLock: true });

const METRICS = [
  { kind: 'builtin', key: 'calls_handled' },
  { kind: 'outcomes', codes: ['will_pay'], better: 'higher', label: 'Will pay' },
];

/** A valid personal view of the account, no campaign. */
function view(o: Record<string, unknown> = {}) {
  return insertRow('agency_compare_views', {
    tenant_id: tenantId,
    account_id: ACCOUNT,
    owner_user_id: randomUUID(),
    name: 'Collections, weekly',
    lens: 'collections',
    metrics: JSON.stringify(METRICS),
    ...o,
  });
}

const refused = (constraint: string) => ({ code: '23514', constraint });

async function columns(table: string) {
  const { rows } = await pool().query<{ column_name: string; data_type: string; is_nullable: string; column_default: string | null }>(
    `SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`, [table]);
  return rows.map((r) => `${r.column_name} ${r.data_type}${r.is_nullable === 'NO' ? ' not null' : ''}${r.column_default ? ` default ${r.column_default}` : ''}`);
}

async function indexDef(name: string): Promise<string | undefined> {
  const { rows } = await pool().query<{ indexdef: string }>(
    `SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = $1`, [name]);
  return rows[0]?.indexdef;
}

async function planOf(sql: string, params: unknown[]): Promise<string> {
  const client: PoolClient = await pool().connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL enable_seqscan = off');
    const { rows } = await client.query<{ 'QUERY PLAN': string }>(`EXPLAIN (COSTS OFF) ${sql}`, params);
    return rows.map((r) => r['QUERY PLAN']).join('\n');
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

function statements(file: string, part: 'up' | 'down'): string[] {
  const text = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
  const body = part === 'up'
    ? text.split(/^-- Down Migration/m)[0]!.split(/^-- Up Migration/m)[1]!
    : text.split(/^-- Down Migration/m)[1]!;
  return body.replace(/--.*$/gm, '').split(';').map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

describe('0063 — Compare agents saved views', () => {
  it('Up and Down start with the lock timeout (the FK locks agency_campaigns, which the server writes)', () => {
    expect(statements(FILE, 'up')[0]).toBe("SET LOCAL lock_timeout = '10s'");
    expect(statements(FILE, 'down')[0]).toBe("SET LOCAL lock_timeout = '10s'");
  });

  it('the columns of the wire type, and a valid view takes its defaults', async () => {
    expect(await columns('agency_compare_views')).toEqual([
      'id uuid not null default gen_random_uuid()',
      'tenant_id uuid not null',
      'account_id uuid not null',
      'owner_user_id uuid not null',
      'name text not null',
      'lens character varying not null',
      'metrics jsonb not null',
      'trend jsonb',
      'campaign_id uuid',
      'shared boolean not null default false',
      'is_campaign_default boolean not null default false',
      'created_at timestamp with time zone not null default now()',
      'updated_at timestamp with time zone not null default now()',
    ]);
    expect(await view()).toMatchObject({ metrics: METRICS, trend: null, campaign_id: null, shared: false, is_campaign_default: false });
  });

  it('the name: trimmed, 1 to 80 characters', async () => {
    await view({ name: 'x'.repeat(80) });
    await expect(view({ name: 'x'.repeat(81) })).rejects.toMatchObject(refused('ck_agency_compare_views_name'));
    await expect(view({ name: '' })).rejects.toMatchObject(refused('ck_agency_compare_views_name'));
    await expect(view({ name: ' Weekly' })).rejects.toMatchObject(refused('ck_agency_compare_views_name'));
  });

  it('the lens: one of the three', async () => {
    await view({ lens: 'sales' });
    await view({ lens: 'verification' });
    await expect(view({ lens: 'inbound' })).rejects.toMatchObject(refused('ck_agency_compare_views_lens'));
  });

  it('metrics: an array of 1 to 6 objects; the trend an object or NULL', async () => {
    const six = Array.from({ length: 6 }, () => ({ kind: 'builtin', key: 'calls_handled' }));
    await view({ metrics: JSON.stringify(six) });
    await expect(view({ metrics: JSON.stringify([...six, six[0]]) })).rejects.toMatchObject(refused('ck_agency_compare_views_metrics'));
    await expect(view({ metrics: '[]' })).rejects.toMatchObject(refused('ck_agency_compare_views_metrics'));
    await expect(view({ metrics: JSON.stringify({ kind: 'builtin', key: 'calls_handled' }) })).rejects.toMatchObject(refused('ck_agency_compare_views_metrics'));
    await expect(view({ metrics: '"calls_handled"' })).rejects.toMatchObject(refused('ck_agency_compare_views_metrics'));
    await expect(view({ metrics: JSON.stringify([{ kind: 'builtin', key: 'calls_handled' }, 'avg_call']) })).rejects.toMatchObject(refused('ck_agency_compare_views_metrics'));
    await expect(view({ metrics: JSON.stringify([[{ kind: 'builtin' }]]) })).rejects.toMatchObject(refused('ck_agency_compare_views_metrics'));
    await view({ trend: JSON.stringify({ kind: 'builtin', key: 'promises_rate' }) });
    await expect(view({ trend: '[]' })).rejects.toMatchObject(refused('ck_agency_compare_views_trend'));
    await expect(view({ trend: '"promises_rate"' })).rejects.toMatchObject(refused('ck_agency_compare_views_trend'));
  });

  it('a campaign default needs its campaign and to be shared; one per campaign', async () => {
    await expect(view({ is_campaign_default: true, shared: true })).rejects.toMatchObject(refused('ck_agency_compare_views_default'));
    await expect(view({ is_campaign_default: true, campaign_id: campaignId })).rejects.toMatchObject(refused('ck_agency_compare_views_default'));
    await view({ is_campaign_default: true, campaign_id: campaignId, shared: true });
    await expect(view({ is_campaign_default: true, campaign_id: campaignId, shared: true }))
      .rejects.toMatchObject({ code: '23505', constraint: 'uq_agency_compare_views_campaign_default' });
    // Any number of non-default views of the campaign, and a default on another campaign.
    await view({ campaign_id: campaignId, shared: true });
    await view({ campaign_id: campaignId });
    const other = (await insertCampaign({ tenant_id: tenantId })).id as string;
    await view({ is_campaign_default: true, campaign_id: other, shared: true });
    expect(await indexDef('uq_agency_compare_views_campaign_default')).toBe(
      'CREATE UNIQUE INDEX uq_agency_compare_views_campaign_default ON public.agency_compare_views USING btree (campaign_id) WHERE is_campaign_default');
  });

  it('a view names a real campaign; deleting the campaign or the tenant deletes its views', async () => {
    await expect(view({ campaign_id: randomUUID() })).rejects.toMatchObject({ code: '23503' });
    await view({ campaign_id: campaignId, shared: true, is_campaign_default: true });
    await view();
    await pool().query('DELETE FROM agency_campaigns WHERE id = $1', [campaignId]);
    const count = async () => (await pool().query<{ n: number }>('SELECT count(*)::int AS n FROM agency_compare_views')).rows[0]!.n;
    expect(await count()).toBe(1);
    await pool().query('DELETE FROM tenants WHERE id = $1', [tenantId]);
    expect(await count()).toBe(0);
  });

  it('the listing indexes, as defined, and the plans that read them', async () => {
    expect(await indexDef('idx_agency_compare_views_owner')).toBe(
      'CREATE INDEX idx_agency_compare_views_owner ON public.agency_compare_views USING btree (tenant_id, account_id, owner_user_id, updated_at DESC)');
    expect(await indexDef('idx_agency_compare_views_shared')).toBe(
      'CREATE INDEX idx_agency_compare_views_shared ON public.agency_compare_views USING btree (tenant_id, account_id, updated_at DESC) WHERE shared');
    expect(await indexDef('idx_agency_compare_views_campaign')).toBe(
      'CREATE INDEX idx_agency_compare_views_campaign ON public.agency_compare_views USING btree (campaign_id) WHERE (campaign_id IS NOT NULL)');
    const own = await planOf(
      `SELECT id FROM agency_compare_views WHERE tenant_id = $1::uuid AND account_id = $2::uuid AND owner_user_id = $3::uuid
        ORDER BY updated_at DESC`, [tenantId, ACCOUNT, randomUUID()]);
    expect(own).toMatch(/idx_agency_compare_views_owner/);
    const shared = await planOf(
      `SELECT id FROM agency_compare_views WHERE tenant_id = $1::uuid AND account_id = $2::uuid AND shared
        ORDER BY updated_at DESC`, [tenantId, ACCOUNT]);
    expect(shared).toMatch(/idx_agency_compare_views_shared/);
  });

  it('down drops the table; up re-applies', async () => {
    await view();
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
    await migrate('down', files.length - files.indexOf(FILE));
    try {
      const { rows } = await pool().query(`SELECT 1 FROM pg_tables WHERE tablename = 'agency_compare_views'`);
      expect(rows).toEqual([]);
    } finally {
      await migrate('up');
    }
    expect((await columns('agency_compare_views')).length).toBe(13);
    expect(await indexDef('uq_agency_compare_views_campaign_default')).toBeDefined();
  });
});
