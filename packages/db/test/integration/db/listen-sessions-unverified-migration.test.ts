// Real Postgres: migrations/0048_listen_sessions_unverified.sql (live call listening,
// docs/listening.md, LS21, LS22). globalSetup has applied every migration. Pins the end reason's
// CHECK extended to `access_unverified` (held equal to the contract's list), the `live_at` column
// with its CHECK, the backfill of rows written before it, and down then up, with the down's
// refusal while an `access_unverified` row exists (0047's CHECK could not hold it).
import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { runner } from 'node-pg-migrate';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { AGENCY_LISTEN_END_REASONS } from '@magick-agency/contracts/agency';
import { MIGRATIONS_DIR } from '../../../src/migrations-dir.js';
import { TEST_DB_URL } from '../../helpers/test-db.js';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { ACCOUNT, TENANT, insertRow } from '../fixtures.js';

const pool = () => getTestPool();

beforeEach(truncateAll);
// 0047's down refuses while a row exists: leave none behind.
afterAll(async () => {
  await truncateAll();
  await closeTestPool();
});

// No migration lock: nothing else migrates this file's own database copy.
const migrate = (direction: 'up' | 'down', count = Infinity) =>
  runner({ databaseUrl: TEST_DB_URL, dir: MIGRATIONS_DIR, direction, migrationsTable: 'pgmigrations', count, log: () => {}, noLock: true });

const FILE = '0048_listen_sessions_unverified.sql';
const refused = (constraint: string) => ({ code: '23514', constraint });

/** How many migrations come after 0048 (their Downs run first). */
function after0048(): number {
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  expect(files).toContain(FILE);
  return files.length - files.indexOf(FILE) - 1;
}

/** The quoted values a CHECK's definition lists. */
async function checkValues(constraint: string): Promise<Set<string>> {
  const { rows } = await pool().query<{ def: string }>(
    'SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = $1', [constraint]);
  expect(rows, constraint).toHaveLength(1);
  return new Set([...rows[0]!.def.matchAll(/'([a-z_]+)'::(?:character varying|text)/g)].map((m) => m[1]!));
}

async function liveColumn(): Promise<string | undefined> {
  const { rows } = await pool().query<{ data_type: string; is_nullable: string; column_default: string | null }>(
    `SELECT data_type, is_nullable, column_default FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'agency_listen_sessions' AND column_name = 'live_at'`);
  const r = rows[0];
  return r ? `${r.data_type}${r.is_nullable === 'NO' ? ' not null' : ''}${r.column_default ? ` default ${r.column_default}` : ''}` : undefined;
}

/** A session row; every NOT NULL without a default filled. */
async function session(o: Record<string, unknown> = {}) {
  return insertRow('agency_listen_sessions', {
    tenant_id: TENANT, account_id: ACCOUNT, call_id: randomUUID(), origin: 'campaign', campaign_id: randomUUID(),
    correlation_id: randomUUID(), agent_session_id: randomUUID(), agent_user_id: randomUUID(),
    listener_user_id: randomUUID(), replica_id: 'replica-1', ...o,
  });
}

const AT = new Date('2026-11-16T10:00:00Z');
const LATER = new Date('2026-11-16T10:00:05Z');

describe('0048 — access_unverified and live_at', () => {
  it('the end reason\'s CHECK is exactly the contract\'s list, access_unverified included', async () => {
    expect(AGENCY_LISTEN_END_REASONS).toContain('access_unverified');
    expect(await checkValues('ck_agency_listen_sessions_end_reason')).toEqual(new Set(AGENCY_LISTEN_END_REASONS));
    expect(await session({ started_at: AT, ended_at: LATER, end_reason: 'access_unverified' }))
      .toMatchObject({ end_reason: 'access_unverified' });
    await expect(session({ started_at: AT, ended_at: LATER, end_reason: 'access_unknown' }))
      .rejects.toMatchObject(refused('ck_agency_listen_sessions_end_reason'));
  });

  it('live_at: nullable, no default (a row is written before it goes live), never before the start', async () => {
    expect(await liveColumn()).toBe('timestamp with time zone');
    expect(await session()).toMatchObject({ live_at: null });
    expect(await session({ started_at: AT, live_at: AT })).toMatchObject({ live_at: AT });
    await expect(session({ started_at: AT, live_at: new Date(AT.getTime() - 1) }))
      .rejects.toMatchObject(refused('ck_agency_listen_sessions_live'));
  });
});

describe('0048 — up over existing rows, down then up', () => {
  it('up backfills live_at with the start for rows written before it; down drops the column and restores 0047\'s CHECK', async () => {
    const n = after0048();
    if (n > 0) await migrate('down', n);
    try {
      await migrate('down', 1);
      expect(await liveColumn()).toBeUndefined();
      expect(await checkValues('ck_agency_listen_sessions_end_reason'))
        .toEqual(new Set(AGENCY_LISTEN_END_REASONS.filter((r) => r !== 'access_unverified')));
      await expect(session({ started_at: AT, ended_at: LATER, end_reason: 'access_unverified' }))
        .rejects.toMatchObject(refused('ck_agency_listen_sessions_end_reason'));
      const open = await session({ started_at: AT });
      const closed = await session({ started_at: LATER, ended_at: LATER, end_reason: 'call_ended' });
      await migrate('up', 1);
      const { rows } = await pool().query<{ id: string; live_at: Date | null; started_at: Date }>(
        'SELECT id, live_at, started_at FROM agency_listen_sessions ORDER BY started_at');
      expect(rows.map((r) => [r.id, r.live_at?.toISOString()])).toEqual([
        [open['id'], AT.toISOString()], [closed['id'], LATER.toISOString()],
      ]);
    } finally {
      await migrate('up');
    }
    expect(await liveColumn()).toBeDefined();
  });

  it('down refuses while an access_unverified row exists, and changes nothing', async () => {
    await session({ started_at: AT, ended_at: LATER, end_reason: 'access_unverified' });
    const n = after0048();
    if (n > 0) await migrate('down', n);
    try {
      await expect(migrate('down', 1)).rejects.toThrow(/access_unverified/);
      expect(await liveColumn()).toBeDefined();
      expect(await checkValues('ck_agency_listen_sessions_end_reason')).toContain('access_unverified');
    } finally {
      if (n > 0) await migrate('up');
    }
  });
});
