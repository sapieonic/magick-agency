// Real Postgres: migrations/0063_campaign_archive.sql (archived campaigns, AR1–AR7). globalSetup has
// applied every migration. Pins the three columns (nullable, no default, so every row already there
// reads as not archived), the CHECK that only a draft or stopped campaign is archived, and down then
// up with rows in place.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { runner } from 'node-pg-migrate';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { MIGRATIONS_DIR } from '../../../src/migrations-dir.js';
import { TEST_DB_URL } from '../../helpers/test-db.js';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { insertCampaign } from '../fixtures.js';

const pool = () => getTestPool();

beforeEach(truncateAll);
afterAll(closeTestPool);

// No migration lock: nothing else migrates this file's own database copy.
const migrate = (direction: 'up' | 'down', count = Infinity) =>
  runner({ databaseUrl: TEST_DB_URL, dir: MIGRATIONS_DIR, direction, migrationsTable: 'pgmigrations', count, log: () => {}, noLock: true });

const FILE = '0063_campaign_archive.sql';
const COLUMNS = ['archived_at', 'archived_by_user_id', 'archived_by_name'] as const;

async function columns(): Promise<Record<string, string>> {
  const { rows } = await pool().query<{ column_name: string; data_type: string; is_nullable: string; column_default: string | null; len: number | null }>(
    `SELECT column_name, data_type, is_nullable, column_default, character_maximum_length AS len
       FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'agency_campaigns' AND column_name = ANY($1::text[])`,
    [COLUMNS]);
  return Object.fromEntries(rows.map((r) => [
    r.column_name,
    `${r.data_type}${r.len ? `(${r.len})` : ''}${r.is_nullable === 'NO' ? ' not null' : ''}${r.column_default ? ` default ${r.column_default}` : ''}`,
  ]));
}

async function check(): Promise<string | undefined> {
  const { rows } = await pool().query<{ def: string; validated: boolean }>(
    `SELECT pg_get_constraintdef(oid) AS def, convalidated AS validated FROM pg_constraint
      WHERE conname = 'ck_agency_campaign_archived_status' AND conrelid = 'agency_campaigns'::regclass`);
  return rows[0] ? `${rows[0].def}${rows[0].validated ? '' : ' NOT VALID'}` : undefined;
}

describe('0063 — archived campaigns', () => {
  it('adds three nullable columns with no default, and a new campaign is not archived', async () => {
    expect(await columns()).toEqual({
      archived_at: 'timestamp with time zone',
      archived_by_user_id: 'uuid',
      archived_by_name: 'character varying(255)',
    });
    expect(await insertCampaign()).toMatchObject({ archived_at: null, archived_by_user_id: null, archived_by_name: null });
  });

  it('archives only a draft or a stopped campaign, with a validated CHECK', async () => {
    expect(await check()).toMatch(/archived_at IS NULL/);
    expect(await check()).not.toMatch(/NOT VALID/);
    for (const status of ['draft', 'stopped']) {
      const c = await insertCampaign({ status });
      await expect(pool().query('UPDATE agency_campaigns SET archived_at = now() WHERE id = $1', [c.id])).resolves.toBeDefined();
    }
    for (const status of ['running', 'paused', 'stopping', 'completed']) {
      const c = await insertCampaign({ status });
      await expect(pool().query('UPDATE agency_campaigns SET archived_at = now() WHERE id = $1', [c.id]))
        .rejects.toMatchObject({ code: '23514', constraint: 'ck_agency_campaign_archived_status' });
    }
  });

  it('refuses to move an archived draft out of draft', async () => {
    const c = await insertCampaign({ status: 'draft', archived_at: new Date() });
    await expect(pool().query(`UPDATE agency_campaigns SET status = 'running' WHERE id = $1`, [c.id]))
      .rejects.toMatchObject({ code: '23514' });
  });

  it('starts its Up with a lock timeout', () => {
    const up = readFileSync(join(MIGRATIONS_DIR, FILE), 'utf8').split('-- Down Migration')[0]!.split('-- Up Migration')[1]!;
    const statements = up.replace(/--.*$/gm, '').split(';').map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
    expect(statements[0]).toBe("SET LOCAL lock_timeout = '10s'");
  });

  it('down drops the columns and the CHECK, and up adds them back with every row not archived', async () => {
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
    const archived = await insertCampaign({ status: 'stopped', archived_at: new Date(), archived_by_user_id: randomUUID(), archived_by_name: 'Ravi' });
    await migrate('down', files.length - files.indexOf(FILE));
    try {
      expect(await columns()).toEqual({});
      expect(await check()).toBeUndefined();
      await migrate('up', 1);
      expect(Object.keys(await columns()).sort()).toEqual([...COLUMNS].sort());
      expect(await check()).toBeDefined();
      const { rows } = await pool().query('SELECT status, archived_at, archived_by_user_id, archived_by_name FROM agency_campaigns WHERE id = $1', [archived.id]);
      expect(rows).toEqual([{ status: 'stopped', archived_at: null, archived_by_user_id: null, archived_by_name: null }]);
    } finally {
      await migrate('up');
    }
    expect(await check()).toBeDefined();
  });
});
