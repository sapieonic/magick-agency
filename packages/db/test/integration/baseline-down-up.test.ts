import { runner } from 'node-pg-migrate';
import { afterAll, describe, expect, it } from 'vitest';
import { MIGRATIONS_DIR } from '../../src/migrations-dir.js';
import { TEST_DB_URL, closeTestPool, getTestPool } from '../helpers/test-db.js';

/**
 * The Down section drops everything the Up section creates, and the Up section
 * re-applies cleanly afterwards. Runs node-pg-migrate's own `runner` both ways, so
 * the marker split is exercised exactly as `migrate:down` / `migrate:up` would.
 *
 * The database is left MIGRATED at the end (the last step is `up`), so this file
 * is safe to run before or after any other integration file.
 */

const migrate = (direction: 'up' | 'down') =>
  runner({
    databaseUrl: TEST_DB_URL,
    dir: MIGRATIONS_DIR,
    direction,
    migrationsTable: 'pgmigrations',
    count: direction === 'down' ? 1 : Infinity,
    log: () => {},
  });

/** Every user-visible object in `public` except the migrations ledger. */
async function inventory(): Promise<string[]> {
  const { rows } = await getTestPool().query<{ o: string }>(
    `SELECT 'rel:' || c.relkind::text || ':' || c.relname AS o
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname NOT IN ('pgmigrations', 'pgmigrations_pkey', 'pgmigrations_id_seq')
     UNION ALL
     SELECT 'fn:' || p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
     UNION ALL
     SELECT 'type:' || t.typname FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE n.nspname = 'public' AND t.typtype = 'e'
     UNION ALL
     SELECT 'trigger:' || tgname FROM pg_trigger WHERE NOT tgisinternal
     UNION ALL
     SELECT 'ext:' || extname FROM pg_extension WHERE extname <> 'plpgsql'`,
  );
  return rows.map((r) => r.o).sort();
}

describe('baseline down → up', () => {
  afterAll(closeTestPool);

  it('down removes every object the baseline created; up restores the same set', async () => {
    const before = await inventory();
    // Sanity: the baseline is applied (globalSetup ran it).
    expect(before).toContain('rel:p:platform_audit_log');
    expect(before).toContain('rel:r:agency_calls');
    expect(before).toContain('fn:agency_contact_stamp_root');
    expect(before).toContain('type:membership_role');
    expect(before).toContain('ext:uuid-ossp');

    await migrate('down');
    expect(await inventory()).toEqual([]);
    const ledger = await getTestPool().query('SELECT name FROM pgmigrations');
    expect(ledger.rows).toEqual([]);

    await migrate('up');
    expect(await inventory()).toEqual(before);
    const reapplied = await getTestPool().query<{ name: string }>('SELECT name FROM pgmigrations');
    expect(reapplied.rows.map((r) => r.name)).toEqual(['0001_baseline']);
  });

  it('a fresh apply seeds exactly one telephony provider: voicelink', async () => {
    // Checked here rather than in baseline.test.ts because that file truncates.
    const { rows } = await getTestPool().query<{ name: string }>('SELECT name FROM telephony_providers');
    expect(rows.map((r) => r.name)).toEqual(['voicelink']);
    // ...and nothing else: no seed super-admin, no seed number, no feature flags.
    for (const table of ['super_admins', 'phone_numbers', 'tenant_phone_assignments', 'feature_flag_overrides', 'tenants', 'users']) {
      const { rows: n } = await getTestPool().query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`);
      expect(n[0]!.n, table).toBe(0);
    }
  });
});
