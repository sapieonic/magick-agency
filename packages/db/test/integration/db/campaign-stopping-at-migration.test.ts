// Real Postgres: migrations/0051_campaign_stopping_at.sql (decision B28b, Home's "Stopping, by …
// at …"). globalSetup has applied every migration. Pins the `stopping_at` column (nullable, no
// default, so the ADD COLUMN rewrites nothing and every row already there reads null, a campaign
// already `stopping` included), and down then up with rows in place.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
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

const FILE = '0051_campaign_stopping_at.sql';

async function column(): Promise<string | undefined> {
  const { rows } = await pool().query<{ data_type: string; is_nullable: string; column_default: string | null }>(
    `SELECT data_type, is_nullable, column_default FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'agency_campaigns' AND column_name = 'stopping_at'`);
  const r = rows[0];
  return r ? `${r.data_type}${r.is_nullable === 'NO' ? ' not null' : ''}${r.column_default ? ` default ${r.column_default}` : ''}` : undefined;
}

describe('0051 — agency_campaigns.stopping_at', () => {
  it('is a nullable TIMESTAMPTZ with no default, and a new campaign has none', async () => {
    expect(await column()).toBe('timestamp with time zone');
    expect(await insertCampaign()).toMatchObject({ stopping_at: null });
    const { rows } = await pool().query<{ description: string | null }>(
      `SELECT col_description('agency_campaigns'::regclass, attnum) AS description
         FROM pg_attribute WHERE attrelid = 'agency_campaigns'::regclass AND attname = 'stopping_at'`);
    expect(rows[0]!.description).toMatch(/Stop/);
  });

  it('starts its Up with a lock timeout and adds the column without a default', () => {
    const up = readFileSync(join(MIGRATIONS_DIR, FILE), 'utf8').split('-- Down Migration')[0]!.split('-- Up Migration')[1]!;
    const statements = up.replace(/--.*$/gm, '').split(';').map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
    expect(statements[0]).toBe("SET LOCAL lock_timeout = '10s'");
    expect(statements[1]).toBe('ALTER TABLE agency_campaigns ADD COLUMN IF NOT EXISTS stopping_at TIMESTAMPTZ');
  });

  it('down drops it and up adds it back null on the rows already there, a stopping campaign included', async () => {
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
    const stopping = await insertCampaign({ status: 'stopping' });
    await pool().query('UPDATE agency_campaigns SET stopping_at = now() WHERE id = $1', [stopping.id]);
    await migrate('down', files.length - files.indexOf(FILE));
    try {
      expect(await column()).toBeUndefined();
      await migrate('up', 1);
      expect(await column()).toBe('timestamp with time zone');
      const { rows } = await pool().query('SELECT status, stopping_at FROM agency_campaigns WHERE id = $1', [stopping.id]);
      expect(rows).toEqual([{ status: 'stopping', stopping_at: null }]);
    } finally {
      await migrate('up');
    }
    expect(await column()).toBeDefined();
  });
});
