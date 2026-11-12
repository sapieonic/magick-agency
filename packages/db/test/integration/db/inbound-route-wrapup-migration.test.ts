// Real Postgres: migrations/0032_inbound_route_wrapup.sql (IQ52, docs/inbound.md §6, §9).
// globalSetup has applied every migration. Pins the route's window (default, the CHECK against the
// contract's limits from both sides), the call's captured window (nullable, the same range), the
// backfill from the call's route with `updated_at` left alone, and down then up.
import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { runner } from 'node-pg-migrate';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { AGENCY_INBOUND_ROUTE_DEFAULTS, AGENCY_INBOUND_ROUTE_LIMITS } from '@magick-agency/contracts/agency';
import { MIGRATIONS_DIR } from '../../../src/migrations-dir.js';
import { TEST_DB_URL } from '../../helpers/test-db.js';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { ACCOUNT, TENANT, insertRow, insertTenant } from '../fixtures.js';

const pool = () => getTestPool();

beforeEach(async () => {
  await truncateAll();
  await insertTenant({ id: TENANT });
});
// 0024's Down (in the down → up suite) refuses while an inbound call exists: leave none behind.
afterAll(async () => {
  await truncateAll();
  await closeTestPool();
});

// No migration lock: nothing else migrates this file's own database copy, and after a refused
// Down the runner's unlock fails on its aborted transaction, so the lock lingers until the session
// ends, which a restore right after could race.
const migrate = (direction: 'up' | 'down', count = Infinity) =>
  runner({ databaseUrl: TEST_DB_URL, dir: MIGRATIONS_DIR, direction, migrationsTable: 'pgmigrations', count, log: () => {}, noLock: true });

const FILE = '0032_inbound_route_wrapup.sql';
const refused = (constraint: string) => ({ code: '23514', constraint });
const L = AGENCY_INBOUND_ROUTE_LIMITS.WRAPUP_SECONDS;

function route(o: Record<string, unknown> = {}) {
  return insertRow('agency_inbound_routes', { tenant_id: TENANT, account_id: ACCOUNT, name: `Route ${randomUUID().slice(0, 6)}`, timezone: 'Europe/London', ...o });
}

function call(o: Record<string, unknown> = {}) {
  return insertRow('agency_inbound_calls', {
    tenant_id: TENANT, account_id: ACCOUNT, provider_call_id: `CA-${randomUUID()}`, to_e164: '+14155550100', ...o,
  });
}

async function column(table: string, name: string) {
  const { rows } = await pool().query<{ data_type: string; is_nullable: string; column_default: string | null }>(
    `SELECT data_type, is_nullable, column_default FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`, [table, name]);
  return rows[0];
}

describe('0032 — the route\'s wrap-up window (IQ52)', () => {
  it('agency_inbound_routes.wrapup_seconds: SMALLINT NOT NULL, defaulted to the contract\'s 30', async () => {
    expect(await column('agency_inbound_routes', 'wrapup_seconds')).toEqual({ data_type: 'smallint', is_nullable: 'NO', column_default: '30' });
    expect(AGENCY_INBOUND_ROUTE_DEFAULTS.wrapup_seconds).toBe(30);
    expect(await route()).toMatchObject({ wrapup_seconds: AGENCY_INBOUND_ROUTE_DEFAULTS.wrapup_seconds });
  });

  it('the route\'s CHECK is the contract\'s bounds, from both sides', async () => {
    expect(L).toEqual({ min: 10, max: 600 });
    await route({ wrapup_seconds: L.min });
    await route({ wrapup_seconds: L.max });
    await expect(route({ wrapup_seconds: L.min - 1 })).rejects.toMatchObject(refused('ck_agency_inbound_routes_wrapup'));
    await expect(route({ wrapup_seconds: L.max + 1 })).rejects.toMatchObject(refused('ck_agency_inbound_routes_wrapup'));
  });

  it('agency_inbound_calls.wrapup_seconds: nullable, no default, the same range when set', async () => {
    expect(await column('agency_inbound_calls', 'wrapup_seconds')).toEqual({ data_type: 'smallint', is_nullable: 'YES', column_default: null });
    expect(await call()).toMatchObject({ wrapup_seconds: null });
    await call({ wrapup_seconds: L.min });
    await call({ wrapup_seconds: L.max });
    await expect(call({ wrapup_seconds: L.min - 1 })).rejects.toMatchObject(refused('ck_agency_inbound_calls_wrapup'));
    await expect(call({ wrapup_seconds: L.max + 1 })).rejects.toMatchObject(refused('ck_agency_inbound_calls_wrapup'));
  });

  it('down drops both; up backfills each call from its route (updated_at kept), a route-less call stays NULL', async () => {
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
    const after = files.length - files.indexOf(FILE);
    const r = await route({ wrapup_seconds: 45 });
    await migrate('down', after);
    try {
      expect(await column('agency_inbound_routes', 'wrapup_seconds')).toBeUndefined();
      expect(await column('agency_inbound_calls', 'wrapup_seconds')).toBeUndefined();
      const old = new Date('2026-01-01T00:00:00Z');
      const routed = await call({ route_id: r['id'], updated_at: old });
      const routeless = await call({ account_id: null, updated_at: old });
      await migrate('up');
      const read = async (id: unknown) => (await pool().query('SELECT wrapup_seconds, updated_at FROM agency_inbound_calls WHERE id = $1', [id])).rows[0];
      // The route came back on its default: the window it had is gone with the column.
      expect(await read(routed['id'])).toEqual({ wrapup_seconds: 30, updated_at: old });
      expect(await read(routeless['id'])).toEqual({ wrapup_seconds: null, updated_at: old });
    } finally {
      await migrate('up');
    }
    expect(await column('agency_inbound_routes', 'wrapup_seconds')).toBeDefined();
  });
});
