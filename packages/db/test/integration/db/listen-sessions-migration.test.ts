// Real Postgres: migrations/0047_listen_sessions.sql (live call listening, docs/listening.md,
// decisions LS1–LS14). globalSetup has applied every migration. Pins the table (columns, defaults,
// no foreign keys), every CHECK from both sides, each stored vocabulary held equal to the contract's
// list (the origin also to agency_calls' own CHECK), the three indexes with the plans the live list
// and the call page read them with, and down then up, with the down's refusal while a row exists.
import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { runner } from 'node-pg-migrate';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { AGENCY_CALL_ORIGINS, AGENCY_LISTEN_END_REASONS } from '@magick-agency/contracts/agency';
import { MIGRATIONS_DIR } from '../../../src/migrations-dir.js';
import { TEST_DB_URL } from '../../helpers/test-db.js';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { ACCOUNT, TENANT, insertRow } from '../fixtures.js';

const pool = () => getTestPool();

beforeEach(truncateAll);
// The down refuses while a row exists: leave none behind for the down → up suite.
afterAll(async () => {
  await truncateAll();
  await closeTestPool();
});

// No migration lock: nothing else migrates this file's own database copy.
const migrate = (direction: 'up' | 'down', count = Infinity) =>
  runner({ databaseUrl: TEST_DB_URL, dir: MIGRATIONS_DIR, direction, migrationsTable: 'pgmigrations', count, log: () => {}, noLock: true });

const FILE = '0047_listen_sessions.sql';
const refused = (constraint: string) => ({ code: '23514', constraint });

/** Down to just before 0047; returns the restore (up to the top). */
async function downBefore0047(): Promise<() => Promise<void>> {
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  await migrate('down', files.length - files.indexOf(FILE));
  return async () => { await migrate('up'); };
}

async function indexDef(name: string): Promise<string | undefined> {
  const { rows } = await pool().query<{ indexdef: string }>(
    `SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = $1`, [name]);
  return rows[0]?.indexdef;
}

async function columns(table: string): Promise<Record<string, string>> {
  const { rows } = await pool().query<{ column_name: string; data_type: string; is_nullable: string; column_default: string | null; character_maximum_length: number | null }>(
    `SELECT column_name, data_type, is_nullable, column_default, character_maximum_length FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1`,
    [table]);
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

/** A session row; every NOT NULL without a default filled. */
async function session(o: Record<string, unknown> = {}) {
  return insertRow('agency_listen_sessions', {
    tenant_id: TENANT, account_id: ACCOUNT, call_id: randomUUID(), origin: 'campaign', campaign_id: randomUUID(),
    correlation_id: randomUUID(), agent_session_id: randomUUID(), agent_user_id: randomUUID(),
    listener_user_id: randomUUID(), replica_id: 'replica-1', ...o,
  });
}

/**
 * `EXPLAIN` of each statement over a table shaped like production's (a few open sessions among
 * many closed ones, across tenants, accounts, calls and supervisors), seeded and ANALYZEd inside a
 * transaction that is rolled back, so neither the rows nor the statistics outlive the plans.
 */
async function plans(statements: Array<[sql: string, values: unknown[]]>): Promise<string[]> {
  const client = await pool().connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO agency_listen_sessions
         (tenant_id, account_id, call_id, origin, campaign_id, correlation_id, agent_session_id, agent_user_id,
          listener_user_id, started_at, ended_at, end_reason, replica_id)
       SELECT CASE WHEN g % 4 = 0 THEN $1::uuid ELSE gen_random_uuid() END,
              CASE WHEN g % 8 = 0 THEN $2::uuid ELSE gen_random_uuid() END,
              gen_random_uuid(), 'campaign', gen_random_uuid(), gen_random_uuid(), gen_random_uuid(),
              gen_random_uuid(), gen_random_uuid(),
              now() - make_interval(mins => g), now() - make_interval(mins => g) + interval '30 seconds',
              'listener_stopped', 'replica-1'
         FROM generate_series(1, 5000) g`,
      [TENANT, ACCOUNT]);
    await client.query(
      `INSERT INTO agency_listen_sessions
         (tenant_id, account_id, call_id, origin, campaign_id, correlation_id, agent_session_id, agent_user_id,
          listener_user_id, replica_id)
       SELECT $1, $2, gen_random_uuid(), 'campaign', gen_random_uuid(), gen_random_uuid(), gen_random_uuid(),
              gen_random_uuid(), gen_random_uuid(), 'replica-1'
         FROM generate_series(1, 3)`,
      [TENANT, ACCOUNT]);
    await client.query('ANALYZE agency_listen_sessions');
    const out: string[] = [];
    for (const [sql, values] of statements) {
      const { rows } = await client.query<{ 'QUERY PLAN': string }>(`EXPLAIN ${sql}`, values);
      out.push(rows.map((r) => r['QUERY PLAN']).join('\n'));
    }
    return out;
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

describe('0047 — agency_listen_sessions', () => {
  it('has the columns, with the counters at 0, started now and open by default', async () => {
    expect(await columns('agency_listen_sessions')).toEqual({
      id: 'uuid not null default gen_random_uuid()',
      tenant_id: 'uuid not null',
      account_id: 'uuid not null',
      call_id: 'uuid not null',
      origin: 'character varying(16) not null',
      campaign_id: 'uuid',
      correlation_id: 'uuid not null',
      agent_session_id: 'uuid not null',
      agent_user_id: 'uuid not null',
      listener_user_id: 'uuid not null',
      started_at: 'timestamp with time zone not null default now()',
      ended_at: 'timestamp with time zone',
      end_reason: 'character varying(32)',
      frames_sent: 'integer not null default 0',
      frames_dropped: 'integer not null default 0',
      replica_id: 'character varying(100) not null',
    });
    const row = await session();
    expect(row).toMatchObject({ ended_at: null, end_reason: null, frames_sent: 0, frames_dropped: 0 });
    expect(row['started_at']).toBeInstanceOf(Date);
  });

  it('has no foreign keys: the row outlives its call, campaign and users', async () => {
    const { rows } = await pool().query(
      `SELECT conname FROM pg_constraint WHERE conrelid = 'agency_listen_sessions'::regclass AND contype = 'f'`);
    expect(rows).toEqual([]);
  });

  it('the CHECKs: origin, end reason, an end with its reason and never before the start, a dialler call\'s campaign, the counters, not one\'s own call', async () => {
    await expect(session({ origin: 'webrtc' })).rejects.toMatchObject(refused('ck_agency_listen_sessions_origin'));
    await expect(session({ started_at: new Date('2026-11-16T10:00:00Z'), ended_at: new Date('2026-11-16T10:00:05Z'), end_reason: 'hung_up' })).rejects.toMatchObject(refused('ck_agency_listen_sessions_end_reason'));
    await expect(session({ started_at: new Date('2026-11-16T10:00:00Z'), ended_at: new Date('2026-11-16T10:00:05Z') })).rejects.toMatchObject(refused('ck_agency_listen_sessions_ended'));
    await expect(session({ end_reason: 'call_ended' })).rejects.toMatchObject(refused('ck_agency_listen_sessions_ended'));
    await expect(session({ started_at: new Date('2026-11-16T10:00:00Z'), ended_at: new Date('2026-11-16T09:59:59Z'), end_reason: 'call_ended' }))
      .rejects.toMatchObject(refused('ck_agency_listen_sessions_ended'));
    await expect(session({ campaign_id: null })).rejects.toMatchObject(refused('ck_agency_listen_sessions_campaign'));
    await expect(session({ frames_sent: -1 })).rejects.toMatchObject(refused('ck_agency_listen_sessions_frames'));
    await expect(session({ frames_dropped: -1 })).rejects.toMatchObject(refused('ck_agency_listen_sessions_frames'));
    const agent = randomUUID();
    await expect(session({ agent_user_id: agent, listener_user_id: agent })).rejects.toMatchObject(refused('ck_agency_listen_sessions_not_own_call'));

    // A soft-phone or inbound call may have no campaign; an end at the start is allowed.
    expect(await session({ origin: 'manual', campaign_id: null })).toMatchObject({ origin: 'manual', campaign_id: null });
    expect(await session({ origin: 'inbound', campaign_id: null })).toMatchObject({ origin: 'inbound' });
    const at = new Date('2026-11-16T10:00:00Z');
    expect(await session({ started_at: at, ended_at: at, end_reason: 'call_ended' })).toMatchObject({ end_reason: 'call_ended' });
    for (const reason of AGENCY_LISTEN_END_REASONS) {
      expect(await session({ started_at: at, ended_at: new Date(at.getTime() + 1_000), end_reason: reason }))
        .toMatchObject({ end_reason: reason });
    }
    for (const origin of AGENCY_CALL_ORIGINS) expect(await session({ origin })).toMatchObject({ origin });
  });

  it('each stored vocabulary is exactly the contract\'s list, and the origin is agency_calls\' own', async () => {
    expect(await checkValues('ck_agency_listen_sessions_end_reason')).toEqual(new Set(AGENCY_LISTEN_END_REASONS));
    expect(await checkValues('ck_agency_listen_sessions_origin')).toEqual(new Set(AGENCY_CALL_ORIGINS));
    expect(await checkValues('ck_agency_calls_origin')).toEqual(new Set(AGENCY_CALL_ORIGINS));
  });

  it('the three indexes, and the reads they serve', async () => {
    expect(await indexDef('idx_agency_listen_sessions_open')).toBe(
      'CREATE INDEX idx_agency_listen_sessions_open ON public.agency_listen_sessions USING btree (tenant_id, account_id) '
      + 'WHERE (ended_at IS NULL)');
    expect(await indexDef('idx_agency_listen_sessions_call')).toBe(
      'CREATE INDEX idx_agency_listen_sessions_call ON public.agency_listen_sessions USING btree (call_id)');
    expect(await indexDef('idx_agency_listen_sessions_listener')).toBe(
      'CREATE INDEX idx_agency_listen_sessions_listener ON public.agency_listen_sessions USING btree (tenant_id, listener_user_id, started_at DESC)');

    const [open, call, listener] = await plans([
      ['SELECT * FROM agency_listen_sessions WHERE tenant_id = $1 AND account_id = $2 AND ended_at IS NULL', [TENANT, ACCOUNT]],
      ['SELECT * FROM agency_listen_sessions WHERE call_id = $1', [randomUUID()]],
      ['SELECT * FROM agency_listen_sessions WHERE tenant_id = $1 AND listener_user_id = $2 ORDER BY started_at DESC LIMIT 20', [TENANT, randomUUID()]],
    ]);
    expect(open).toContain('idx_agency_listen_sessions_open');
    expect(call).toContain('idx_agency_listen_sessions_call');
    expect(listener).toContain('idx_agency_listen_sessions_listener');
  });
});

describe('0047 — down then up', () => {
  it('down refuses while a session row exists, and changes nothing', async () => {
    await session();
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
    const after = files.length - files.indexOf(FILE) - 1;
    // Later migrations' Downs commit on their own first; restore them whatever happens.
    if (after > 0) await migrate('down', after);
    try {
      await expect(migrate('down', 1)).rejects.toThrow(/listen sessions exist/);
      const { rowCount } = await pool().query('SELECT 1 FROM agency_listen_sessions');
      expect(rowCount).toBe(1);
    } finally {
      if (after > 0) await migrate('up');
    }
    await truncateAll();
  });

  it('down drops the table and its indexes; up restores them', async () => {
    const restore = await downBefore0047();
    try {
      const { rowCount } = await pool().query(`SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'agency_listen_sessions'`);
      expect(rowCount).toBe(0);
      expect(await indexDef('idx_agency_listen_sessions_open')).toBeUndefined();
    } finally {
      await restore();
    }
    expect(await indexDef('idx_agency_listen_sessions_open')).toBeDefined();
    expect(await indexDef('idx_agency_listen_sessions_call')).toBeDefined();
    expect(await indexDef('idx_agency_listen_sessions_listener')).toBeDefined();
  });
});
