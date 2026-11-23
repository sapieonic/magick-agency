// Real Postgres: migrations/0071_call_settings.sql (docs/call-log.md §5; wire shape AgencyCallSettings
// in packages/contracts/src/api/agency/call-settings.ts). globalSetup has applied every migration.
// Pins agency_call_settings (columns, the one row per account, the CHECK that ties "since" to the
// switch, the updated_at trigger), the inbound route's default_campaign_id and its partial index (by
// definition, and that a statement asking "which live routes file callers under this campaign" uses
// it), the lock timeout on Up and Down, then down and up again.
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { runner } from 'node-pg-migrate';
import type { PoolClient } from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { MIGRATIONS_DIR } from '../../../src/migrations-dir.js';
import { TEST_DB_URL } from '../../helpers/test-db.js';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { ACCOUNT, insertRow, insertTenant } from '../fixtures.js';

const pool = () => getTestPool();
const FILE = '0071_call_settings.sql';
const INDEX = 'idx_agency_inbound_routes_default_campaign';

let tenantId: string;
beforeEach(async () => {
  await truncateAll();
  tenantId = (await insertTenant()).id as string;
});
afterAll(closeTestPool);

// No migration lock: nothing else migrates this file's own database copy.
const migrate = (direction: 'up' | 'down', count = Infinity) =>
  runner({ databaseUrl: TEST_DB_URL, dir: MIGRATIONS_DIR, direction, migrationsTable: 'pgmigrations', count, log: () => {}, noLock: true });

const settings = (o: Record<string, unknown> = {}) =>
  insertRow('agency_call_settings', { tenant_id: tenantId, account_id: ACCOUNT, ...o });
const route = (o: Record<string, unknown> = {}) =>
  insertRow('agency_inbound_routes', { tenant_id: tenantId, account_id: ACCOUNT, name: `Route ${randomUUID().slice(0, 6)}`, timezone: 'Asia/Kolkata', ...o });

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

function statements(part: 'up' | 'down'): string[] {
  const text = readFileSync(join(MIGRATIONS_DIR, FILE), 'utf8');
  const body = part === 'up'
    ? text.split(/^-- Down Migration/m)[0]!.split(/^-- Up Migration/m)[1]!
    : text.split(/^-- Down Migration/m)[1]!;
  return body.replace(/--.*$/gm, '').split(';').map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

describe('0071 — the account\'s call settings and the route\'s campaign for unknown callers', () => {
  it('Up and Down start with the lock timeout (agency_inbound_routes is read on every inbound arrival)', () => {
    expect(statements('up')[0]).toBe("SET LOCAL lock_timeout = '10s'");
    expect(statements('down')[0]).toBe("SET LOCAL lock_timeout = '10s'");
  });

  it('agency_call_settings: the columns, and a row that names only its account is the setting off', async () => {
    expect(await columns('agency_call_settings')).toEqual([
      'id uuid not null default gen_random_uuid()',
      'tenant_id uuid not null',
      'account_id uuid not null',
      'require_campaign boolean not null default false',
      'require_campaign_since timestamp with time zone',
      'updated_by uuid',
      'created_at timestamp with time zone not null default now()',
      'updated_at timestamp with time zone not null default now()',
    ]);
    expect(await settings()).toMatchObject({ require_campaign: false, require_campaign_since: null, updated_by: null });
  });

  it('one row per account: a second is refused, another account of the tenant is not', async () => {
    await settings();
    await expect(settings()).rejects.toMatchObject({ code: '23505', constraint: 'uq_agency_call_settings_account' });
    await expect(settings({ account_id: randomUUID() })).resolves.toBeDefined();
  });

  it('"since" is set exactly while the switch is on', async () => {
    const refused = { code: '23514', constraint: 'ck_agency_call_settings_since' };
    await expect(settings({ require_campaign: true })).rejects.toMatchObject(refused);
    await expect(settings({ require_campaign: false, require_campaign_since: new Date() })).rejects.toMatchObject(refused);
    const on = await settings({ require_campaign: true, require_campaign_since: new Date() });
    await expect(pool().query('UPDATE agency_call_settings SET require_campaign = false WHERE id = $1', [on.id])).rejects.toMatchObject(refused);
    await pool().query('UPDATE agency_call_settings SET require_campaign = false, require_campaign_since = NULL WHERE id = $1', [on.id]);
  });

  it('updated_at moves on a write', async () => {
    const row = await settings({ updated_at: new Date('2026-01-01T00:00:00Z') });
    const { rows } = await pool().query<{ updated_at: Date }>(
      'UPDATE agency_call_settings SET updated_by = gen_random_uuid() WHERE id = $1 RETURNING updated_at', [row.id]);
    expect(rows[0]!.updated_at.getTime()).toBeGreaterThan(new Date('2026-01-01T00:00:00Z').getTime());
  });

  it('agency_inbound_routes.default_campaign_id: nullable, none by default, no FK (any uuid is stored)', async () => {
    expect((await columns('agency_inbound_routes')).at(-1)).toBe('default_campaign_id uuid');
    expect((await route()).default_campaign_id).toBeNull();
    const id = randomUUID();
    expect((await route({ default_campaign_id: id })).default_campaign_id).toBe(id);
  });

  it('the index of the live routes that file callers under a campaign: its definition, and a statement that uses it', async () => {
    expect(await indexDef(INDEX)).toBe(
      `CREATE INDEX ${INDEX} ON public.agency_inbound_routes USING btree (default_campaign_id) `
      + 'WHERE ((default_campaign_id IS NOT NULL) AND (deleted_at IS NULL))');
    const campaign = randomUUID();
    await route({ default_campaign_id: campaign });
    const client: PoolClient = await pool().connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL enable_seqscan = off');
      const { rows } = await client.query<{ 'QUERY PLAN': string }>(
        `EXPLAIN (COSTS OFF) SELECT r.id, r.name, r.account_id FROM agency_inbound_routes r
          WHERE r.default_campaign_id = $1::uuid AND r.deleted_at IS NULL AND r.tenant_id = $2::uuid`, [campaign, tenantId]);
      expect(rows.map((r) => r['QUERY PLAN']).join('\n')).toContain(INDEX);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('down drops the index, the column and the table; up restores them', async () => {
    await settings();
    await route({ default_campaign_id: randomUUID() });
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
    await migrate('down', files.length - files.indexOf(FILE));
    try {
      expect((await pool().query(`SELECT 1 FROM pg_tables WHERE tablename = 'agency_call_settings'`)).rows).toEqual([]);
      expect(await indexDef(INDEX)).toBeUndefined();
      expect((await columns('agency_inbound_routes')).some((c) => c.startsWith('default_campaign_id'))).toBe(false);
      // The routes themselves are kept.
      expect((await pool().query('SELECT count(*)::int AS n FROM agency_inbound_routes')).rows[0]!.n).toBe(1);
    } finally {
      await migrate('up');
    }
    expect((await columns('agency_call_settings')).length).toBe(8);
    expect(await indexDef(INDEX)).toBeDefined();
    expect((await pool().query('SELECT default_campaign_id FROM agency_inbound_routes')).rows[0]!.default_campaign_id).toBeNull();
  });
});
