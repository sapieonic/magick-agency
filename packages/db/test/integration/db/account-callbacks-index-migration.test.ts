// Real Postgres: migrations/0053_account_callbacks_index.sql (decisions LF1, LF22): the account's
// callbacks list walks each active campaign's pending contacts that may be callbacks, by due time.
// globalSetup has applied every migration. Pins the index by its definition, the Up's lock timeout,
// the invalid-index refusal, one built beforehand, and down then up. The plan that reads it (the
// list's own statement on seeded rosters) is pinned beside the statement, in
// apps/server/test/integration/agency/callbacks-list.test.ts.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runner } from 'node-pg-migrate';
import { afterAll, describe, expect, it } from 'vitest';
import { MIGRATIONS_DIR } from '../../../src/migrations-dir.js';
import { TEST_DB_URL } from '../../helpers/test-db.js';
import { closeTestPool, getTestPool } from '../setup/test-utils.js';

afterAll(closeTestPool);

// No migration lock: nothing else migrates this file's own database copy.
const migrate = (direction: 'up' | 'down', count = Infinity) =>
  runner({ databaseUrl: TEST_DB_URL, dir: MIGRATIONS_DIR, direction, migrationsTable: 'pgmigrations', count, log: () => {}, noLock: true });

const FILE = '0053_account_callbacks_index.sql';
const NAME = 'idx_agency_contacts_callbacks';
const DEFINITION = 'CREATE INDEX idx_agency_contacts_callbacks ON public.agency_contacts '
  + 'USING btree (campaign_id, next_attempt_at, id) '
  + "WHERE (((state)::text = 'pending'::text) AND (((last_outcome)::text = 'connected'::text) OR (callback_source IS NOT NULL)))";
const BUILD = `ON agency_contacts (campaign_id, next_attempt_at, id) WHERE state = 'pending' AND (last_outcome = 'connected' OR callback_source IS NOT NULL)`;

async function indexDef(): Promise<string | null> {
  const { rows } = await getTestPool().query<{ indexdef: string }>(
    `SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = $1`, [NAME]);
  return rows[0]?.indexdef ?? null;
}

async function recorded(): Promise<boolean> {
  const { rows } = await getTestPool().query(`SELECT name FROM pgmigrations WHERE name = $1`, [FILE.replace(/\.sql$/, '')]);
  return rows.length === 1;
}

function stepsDownTo(file: string): number {
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  return files.length - files.indexOf(file);
}

describe('0053 — the account callbacks list\'s index of the pending contacts that may be callbacks', () => {
  it('defines the index exactly, with its comment', async () => {
    expect(await indexDef()).toBe(DEFINITION);
    const { rows } = await getTestPool().query<{ c: string }>(`SELECT obj_description($1::regclass, 'pg_class') AS c`, [NAME]);
    expect(rows[0]!.c).toMatch(/callbacks list \(LF22\)/);
  });

  it('starts its Up with a lock timeout, before the CREATE INDEX', () => {
    const text = readFileSync(join(MIGRATIONS_DIR, FILE), 'utf8');
    const up = text.split(/^-- Down Migration/m)[0]!.split(/^-- Up Migration/m)[1]!;
    const timeout = up.indexOf("SET LOCAL lock_timeout = '10s';");
    expect(timeout).toBeGreaterThan(-1);
    expect(timeout).toBeLessThan(up.indexOf('CREATE INDEX'));
  });

  it('fails on an invalid index left under its name by a failed CREATE INDEX CONCURRENTLY', async () => {
    const pool = getTestPool();
    await migrate('down', stepsDownTo(FILE));
    try {
      await pool.query(`CREATE INDEX ${NAME} ${BUILD}`);
      await pool.query(`UPDATE pg_index SET indisvalid = false WHERE indexrelid = '${NAME}'::regclass`);
      await expect(migrate('up')).rejects.toThrow(new RegExp(`invalid index.*${NAME}`));
      expect(await recorded()).toBe(false);
    } finally {
      await pool.query(`DROP INDEX IF EXISTS ${NAME}`);
      await migrate('up');
    }
    expect(await indexDef()).toBe(DEFINITION);
  });

  it('records itself over one built beforehand with CONCURRENTLY under its name', async () => {
    await migrate('down', stepsDownTo(FILE));
    try {
      await getTestPool().query(`CREATE INDEX CONCURRENTLY ${NAME} ${BUILD}`);
      await migrate('up');
      expect(await recorded()).toBe(true);
    } finally {
      await migrate('up');
    }
    expect(await indexDef()).toBe(DEFINITION);
  });

  it('down drops it; up restores it', async () => {
    await migrate('down', stepsDownTo(FILE));
    try {
      expect(await indexDef()).toBeNull();
    } finally {
      await migrate('up');
    }
    expect(await indexDef()).toBe(DEFINITION);
  });
});
