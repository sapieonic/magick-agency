// Real Postgres: migrations/0036_inbound_ring.sql (Mode B, decisions IQ58–IQ74). globalSetup has
// applied every migration. Pins the push devices table (columns, defaults, foreign keys, every
// CHECK from both sides, the one-row-per-agent-and-device key, the one-live-row-per-token indexes,
// the updated_at trigger), the ring columns on the inbound spine and the away break's columns on
// the session (with their CHECKs), each stored vocabulary held equal to the contract's list, and
// down then up.
import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { runner } from 'node-pg-migrate';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  AGENCY_INBOUND_OFFER_CHANNELS,
  AGENCY_INBOUND_RING_RESULTS,
  AGENCY_PUSH_FAILURE_REASONS,
  AGENCY_PUSH_PLATFORMS,
} from '@magick-agency/contracts/agency';
import { MIGRATIONS_DIR } from '../../../src/migrations-dir.js';
import { TEST_DB_URL } from '../../helpers/test-db.js';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { ACCOUNT, TENANT, insertCampaign, insertRow, insertSession, insertTenant, insertUser } from '../fixtures.js';

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

// No migration lock: nothing else migrates this file's own database copy.
const migrate = (direction: 'up' | 'down', count = Infinity) =>
  runner({ databaseUrl: TEST_DB_URL, dir: MIGRATIONS_DIR, direction, migrationsTable: 'pgmigrations', count, log: () => {}, noLock: true });

const FILE = '0036_inbound_ring.sql';
const refused = (constraint: string) => ({ code: '23514', constraint });

/** Down to just before 0036; returns the restore (up to the top). */
async function downBefore0036(): Promise<() => Promise<void>> {
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  await migrate('down', files.length - files.indexOf(FILE));
  return async () => { await migrate('up'); };
}

async function indexDef(name: string): Promise<string | undefined> {
  const { rows } = await pool().query<{ indexdef: string }>(
    `SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = $1`, [name]);
  return rows[0]?.indexdef;
}

async function columns(table: string, names: string[]): Promise<Record<string, string>> {
  const { rows } = await pool().query<{ column_name: string; data_type: string; is_nullable: string; column_default: string | null; character_maximum_length: number | null }>(
    `SELECT column_name, data_type, is_nullable, column_default, character_maximum_length FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1 AND column_name = ANY($2::text[])`,
    [table, names]);
  return Object.fromEntries(rows.map((r) => [
    r.column_name,
    `${r.data_type}${r.character_maximum_length ? `(${r.character_maximum_length})` : ''}`
      + `${r.is_nullable === 'NO' ? ' not null' : ''}${r.column_default ? ` default ${r.column_default}` : ''}`,
  ]));
}

/** The quoted values a CHECK's definition lists. */
async function checkValues(constraint: string): Promise<Set<string>> {
  const { rows } = await pool().query<{ def: string }>(
    'SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = $1', [constraint]);
  expect(rows, constraint).toHaveLength(1);
  return new Set([...rows[0]!.def.matchAll(/'([a-z_]+)'::(?:character varying|text)/g)].map((m) => m[1]!));
}

let user: string;
async function device(o: Record<string, unknown> = {}) {
  return insertRow('agency_push_devices', {
    tenant_id: TENANT, user_id: user, device_id: `dev-${randomUUID().slice(0, 8)}`, platform: 'android',
    fcm_token: `fcm-${randomUUID()}`, app_build: '0.9.0+412', ...o,
  });
}

/** A spine row; every NOT NULL without a default filled. */
async function call(o: Record<string, unknown> = {}) {
  return insertRow('agency_inbound_calls', {
    tenant_id: TENANT, account_id: ACCOUNT, provider_call_id: `CA-${randomUUID()}`, to_e164: '+14155550100', ...o,
  });
}

describe('0036 — agency_push_devices', () => {
  beforeEach(async () => { user = (await insertUser()).id as string; });

  it('has the columns, with ring_enabled off and last_seen_at now by default', async () => {
    expect(await columns('agency_push_devices', [
      'id', 'tenant_id', 'user_id', 'device_id', 'platform', 'fcm_token', 'voip_token', 'app_build', 'ring_enabled',
      'last_seen_at', 'revoked_at', 'last_failure_at', 'last_failure_reason', 'created_at', 'updated_at',
    ])).toEqual({
      id: 'uuid not null default gen_random_uuid()',
      tenant_id: 'uuid not null',
      user_id: 'uuid not null',
      device_id: 'character varying(64) not null',
      platform: 'character varying(8) not null',
      fcm_token: 'text',
      voip_token: 'text',
      app_build: 'character varying(64) not null',
      ring_enabled: 'boolean not null default false',
      last_seen_at: 'timestamp with time zone not null default now()',
      revoked_at: 'timestamp with time zone',
      last_failure_at: 'timestamp with time zone',
      last_failure_reason: 'character varying(16)',
      created_at: 'timestamp with time zone not null default now()',
      updated_at: 'timestamp with time zone not null default now()',
    });
    const row = await device();
    expect(row).toMatchObject({ ring_enabled: false, revoked_at: null, last_failure_at: null, voip_token: null });
    expect(row['last_seen_at']).toBeInstanceOf(Date);
  });

  it('one row per agent and device: the same device id for another agent is another row', async () => {
    await device({ device_id: 'phone-1' });
    await expect(device({ device_id: 'phone-1' })).rejects.toMatchObject({ code: '23505', constraint: 'uq_agency_push_devices_user_device' });
    const other = (await insertUser()).id as string;
    expect(await device({ device_id: 'phone-1', user_id: other })).toMatchObject({ device_id: 'phone-1' });
  });

  it('one live row per push token, of either platform; a revoked row frees its token', async () => {
    const first = await device({ fcm_token: 'tok-1' });
    await expect(device({ fcm_token: 'tok-1' })).rejects.toMatchObject({ code: '23505', constraint: 'uq_agency_push_devices_fcm_token' });
    await pool().query('UPDATE agency_push_devices SET revoked_at = now() WHERE id = $1', [first.id]);
    expect(await device({ fcm_token: 'tok-1' })).toMatchObject({ fcm_token: 'tok-1' });
    await device({ platform: 'ios', fcm_token: null, voip_token: 'voip-1' });
    await expect(device({ platform: 'ios', fcm_token: null, voip_token: 'voip-1' }))
      .rejects.toMatchObject({ code: '23505', constraint: 'uq_agency_push_devices_voip_token' });
    // Rows with no token never clash.
    await device({ fcm_token: null });
    await device({ fcm_token: null });
    expect(await indexDef('uq_agency_push_devices_fcm_token')).toBe(
      'CREATE UNIQUE INDEX uq_agency_push_devices_fcm_token ON public.agency_push_devices USING btree (fcm_token) '
      + 'WHERE ((fcm_token IS NOT NULL) AND (revoked_at IS NULL))');
    expect(await indexDef('uq_agency_push_devices_voip_token')).toBe(
      'CREATE UNIQUE INDEX uq_agency_push_devices_voip_token ON public.agency_push_devices USING btree (voip_token) '
      + 'WHERE ((voip_token IS NOT NULL) AND (revoked_at IS NULL))');
  });

  it('the CHECKs: platform, a non-blank device id, non-empty tokens, a failure with its reason', async () => {
    await expect(device({ platform: 'windows' })).rejects.toMatchObject(refused('ck_agency_push_devices_platform'));
    await expect(device({ device_id: '  ' })).rejects.toMatchObject(refused('ck_agency_push_devices_device_id'));
    await expect(device({ fcm_token: '' })).rejects.toMatchObject(refused('ck_agency_push_devices_tokens'));
    await expect(device({ voip_token: '' })).rejects.toMatchObject(refused('ck_agency_push_devices_tokens'));
    await expect(device({ last_failure_at: new Date() })).rejects.toMatchObject(refused('ck_agency_push_devices_failure'));
    await expect(device({ last_failure_reason: 'unavailable' })).rejects.toMatchObject(refused('ck_agency_push_devices_failure'));
    await expect(device({ last_failure_at: new Date(), last_failure_reason: 'gone' })).rejects.toMatchObject(refused('ck_agency_push_devices_failure'));
    for (const reason of AGENCY_PUSH_FAILURE_REASONS) {
      expect(await device({ last_failure_at: new Date(), last_failure_reason: reason })).toMatchObject({ last_failure_reason: reason });
    }
    for (const platform of AGENCY_PUSH_PLATFORMS) expect(await device({ platform })).toMatchObject({ platform });
  });

  it('each stored vocabulary is exactly the contract\'s list', async () => {
    expect(await checkValues('ck_agency_push_devices_platform')).toEqual(new Set(AGENCY_PUSH_PLATFORMS));
    expect(await checkValues('ck_agency_push_devices_failure')).toEqual(new Set(AGENCY_PUSH_FAILURE_REASONS));
  });

  it('cascades with its user and its tenant; updated_at moves on update', async () => {
    const row = await device({ updated_at: new Date('2026-01-01T00:00:00Z') });
    await pool().query('UPDATE agency_push_devices SET ring_enabled = true WHERE id = $1', [row.id]);
    const { rows } = await pool().query<{ updated_at: Date }>('SELECT updated_at FROM agency_push_devices WHERE id = $1', [row.id]);
    expect(rows[0]!.updated_at.getTime()).toBeGreaterThan(Date.parse('2026-01-01T00:00:00Z'));

    await pool().query('DELETE FROM users WHERE id = $1', [user]);
    expect((await pool().query('SELECT 1 FROM agency_push_devices WHERE id = $1', [row.id])).rowCount).toBe(0);

    user = (await insertUser()).id as string;
    const tenant = (await insertTenant()).id as string;
    const inOther = await device({ tenant_id: tenant });
    await pool().query('DELETE FROM tenants WHERE id = $1', [tenant]);
    expect((await pool().query('SELECT 1 FROM agency_push_devices WHERE id = $1', [inOther.id])).rowCount).toBe(0);
  });
});

describe('0036 — the ring on agency_inbound_calls', () => {
  it('adds the ring columns; an existing-style row has none and no rings', async () => {
    expect(await columns('agency_inbound_calls', ['offer_channel', 'ringing_at', 'accepted_at', 'ring_result', 'ring_count'])).toEqual({
      offer_channel: 'character varying(8)',
      ringing_at: 'timestamp with time zone',
      accepted_at: 'timestamp with time zone',
      ring_result: 'character varying(24)',
      ring_count: 'smallint not null default 0',
    });
    expect(await call()).toMatchObject({ offer_channel: null, ringing_at: null, accepted_at: null, ring_result: null, ring_count: 0 });
  });

  it('the CHECKs: the channel and result vocabularies; a push offer has its ring; an answer only after a ring', async () => {
    await expect(call({ offer_channel: 'sms' })).rejects.toMatchObject(refused('ck_agency_inbound_calls_offer_channel'));
    await expect(call({ ring_result: 'ignored' })).rejects.toMatchObject(refused('ck_agency_inbound_calls_ring_result'));
    await expect(call({ offer_channel: 'push' })).rejects.toMatchObject(refused('ck_agency_inbound_calls_ring'));
    await expect(call({ accepted_at: new Date() })).rejects.toMatchObject(refused('ck_agency_inbound_calls_ring'));
    await expect(call({ ring_count: -1 })).rejects.toMatchObject(refused('ck_agency_inbound_calls_ring'));
    expect(await call({ offer_channel: 'station' })).toMatchObject({ offer_channel: 'station' });
    const rung = { offer_channel: 'push', ringing_at: new Date(), ring_count: 1 };
    expect(await call(rung)).toMatchObject({ offer_channel: 'push', ring_count: 1 });
    expect(await call({ ...rung, accepted_at: new Date() })).toMatchObject({ offer_channel: 'push' });
    // A ring that ended and requeued keeps its result; the next offer may be a station's.
    expect(await call({ offer_channel: 'station', ringing_at: new Date(), ring_result: 'expired', ring_count: 1 }))
      .toMatchObject({ ring_result: 'expired' });
    for (const result of AGENCY_INBOUND_RING_RESULTS) expect(await call({ ring_result: result })).toMatchObject({ ring_result: result });
  });

  it('each stored vocabulary is exactly the contract\'s list', async () => {
    expect(await checkValues('ck_agency_inbound_calls_offer_channel')).toEqual(new Set(AGENCY_INBOUND_OFFER_CHANNELS));
    expect(await checkValues('ck_agency_inbound_calls_ring_result')).toEqual(new Set(AGENCY_INBOUND_RING_RESULTS));
  });
});

describe('0036 — the away break on agency_agent_sessions', () => {
  it('ring_misses (never negative, 0 by default) and away_ring_since (NULL by default)', async () => {
    expect(await columns('agency_agent_sessions', ['ring_misses', 'away_ring_since'])).toEqual({
      ring_misses: 'smallint not null default 0',
      away_ring_since: 'timestamp with time zone',
    });
    const campaign = await insertCampaign();
    expect(await insertSession(campaign.id as string)).toMatchObject({ ring_misses: 0, away_ring_since: null });
    await expect(insertSession(campaign.id as string, { ring_misses: -1 })).rejects.toMatchObject(refused('ck_agency_agent_sessions_ring_misses'));
    expect(await insertSession(campaign.id as string, {
      state: 'break', break_reason: 'away_ring', ring_misses: 1, away_ring_since: new Date(),
    })).toMatchObject({ break_reason: 'away_ring', ring_misses: 1 });
  });
});

describe('0036 — down then up', () => {
  it('down drops the table, the columns and the CHECKs; up restores them', async () => {
    const restore = await downBefore0036();
    try {
      const { rowCount } = await pool().query(`SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'agency_push_devices'`);
      expect(rowCount).toBe(0);
      expect(await columns('agency_inbound_calls', ['offer_channel', 'ringing_at', 'accepted_at', 'ring_result', 'ring_count'])).toEqual({});
      expect(await columns('agency_agent_sessions', ['ring_misses', 'away_ring_since'])).toEqual({});
      const { rows } = await pool().query<{ conname: string }>(
        `SELECT conname FROM pg_constraint WHERE conname = ANY($1::text[])`,
        [['ck_agency_inbound_calls_offer_channel', 'ck_agency_inbound_calls_ring_result', 'ck_agency_inbound_calls_ring',
          'ck_agency_agent_sessions_ring_misses']]);
      expect(rows).toEqual([]);
    } finally {
      await restore();
    }
    expect(await indexDef('uq_agency_push_devices_user_device')).toBeDefined();
    expect(Object.keys(await columns('agency_inbound_calls', ['offer_channel', 'ring_count']))).toHaveLength(2);
    expect(Object.keys(await columns('agency_agent_sessions', ['ring_misses', 'away_ring_since']))).toHaveLength(2);
  });
});
