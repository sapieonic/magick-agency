import { randomUUID } from 'node:crypto';
import { runner } from 'node-pg-migrate';
import { afterAll, describe, expect, it } from 'vitest';
import { MIGRATIONS_DIR } from '../../src/migrations-dir.js';
import { TEST_DB_URL, closeTestPool, getTestPool, truncateAll } from '../helpers/test-db.js';
import { insertCall, insertCampaign, insertManualCall, insertSession, insertSoftphoneSession } from './fixtures.js';

/**
 * Every migration's Down section drops everything its Up section creates, and the
 * Up sections re-apply cleanly afterwards. Runs node-pg-migrate's own `runner` both
 * ways, so the marker split is exercised exactly as `migrate:down` / `migrate:up` would.
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
    count: Infinity,
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

const ALL_MIGRATIONS = [
  '0001_baseline', '0002_telephony_credentials', '0003_agency_attempt_indexes', '0004_agency_contacts_in_flight_index',
  '0005_softphone',
];

describe('migrations down → up', () => {
  afterAll(closeTestPool);

  it('0005 down refuses while a soft-phone session exists, and changes nothing', async () => {
    // Reverting agency_agent_sessions.campaign_id to NOT NULL cannot keep a soft-phone
    // session, and deleting one would take its manual calls' audit trail with it, so
    // the Down section raises before it alters anything (one transaction).
    await truncateAll();
    const session = await insertSoftphoneSession();
    await insertManualCall(session.id);
    const before = await inventory();

    await expect(migrate('down')).rejects.toThrow(/soft-phone sessions exist/);
    expect(await inventory()).toEqual(before);
    const ledger = await getTestPool().query<{ name: string }>('SELECT name FROM pgmigrations ORDER BY id');
    expect(ledger.rows.map((r) => r.name)).toEqual(ALL_MIGRATIONS);
    await truncateAll();
  });

  it('0005 down refuses while a manual call from a switched CAMPAIGN session exists, and changes nothing', async () => {
    // SP7: an agent on a campaign switched to the soft phone and dialled. No session or
    // session event has a NULL campaign_id, so the session guard alone would let the Down
    // drop agency_manual_calls and the call's audit trail with it.
    await truncateAll();
    const campaign = await insertCampaign();
    const session = await insertSession(campaign.id, { state: 'break', break_reason: 'soft_phone' });
    await insertManualCall(session.id, { campaign_id: campaign.id });
    const before = await inventory();

    await expect(migrate('down')).rejects.toThrow(/soft-phone calls exist/);
    expect(await inventory()).toEqual(before);
    expect((await getTestPool().query('SELECT count(*)::int AS n FROM agency_manual_calls')).rows[0].n).toBe(1);
    const ledger = await getTestPool().query<{ name: string }>('SELECT name FROM pgmigrations ORDER BY id');
    expect(ledger.rows.map((r) => r.name)).toEqual(ALL_MIGRATIONS);
    await truncateAll();
  });

  it('0005 down refuses while a manual media leg exists, its manual call already purged', async () => {
    await truncateAll();
    await insertCall({ origin: 'manual', manual_call_id: randomUUID() });
    const before = await inventory();
    await expect(migrate('down')).rejects.toThrow(/soft-phone calls exist/);
    expect(await inventory()).toEqual(before);
    await truncateAll();
  });

  it('down removes every object the migrations created; up restores the same set', async () => {
    // Another file may have left a soft-phone session behind, which 0005's Down refuses
    // to drop (the test above); the rows themselves do not matter to the inventory.
    await truncateAll();
    const before = await inventory();
    // Sanity: the baseline is applied (globalSetup ran it).
    expect(before).toContain('rel:p:platform_audit_log');
    expect(before).toContain('rel:r:agency_calls');
    expect(before).toContain('fn:agency_contact_stamp_root');
    expect(before).toContain('type:membership_role');
    expect(before).toContain('ext:uuid-ossp');
    expect(before).toContain('rel:r:telephony_credentials');
    expect(before).toContain('rel:r:telephony_credential_secrets');
    expect(before).toContain('rel:r:agency_manual_calls');
    expect(before).toContain('rel:r:agency_softphone_settings');

    await migrate('down');
    expect(await inventory()).toEqual([]);
    const ledger = await getTestPool().query('SELECT name FROM pgmigrations');
    expect(ledger.rows).toEqual([]);

    await migrate('up');
    expect(await inventory()).toEqual(before);
    const reapplied = await getTestPool().query<{ name: string }>('SELECT name FROM pgmigrations ORDER BY id');
    expect(reapplied.rows.map((r) => r.name)).toEqual(ALL_MIGRATIONS);
  });

  it('a fresh apply seeds exactly the telephony providers voicelink (active) and plivo (inactive)', async () => {
    // Checked here rather than in baseline.test.ts because that file truncates.
    const { rows } = await getTestPool().query<{ name: string; status: string }>('SELECT name, status FROM telephony_providers ORDER BY name');
    // Plivo stays inactive until its dial path ships: numbers and allocations cannot use it.
    expect(rows).toEqual([{ name: 'plivo', status: 'inactive' }, { name: 'voicelink', status: 'active' }]);
    // ...and nothing else: no seed super-admin, no seed number, no feature flags.
    for (const table of ['super_admins', 'phone_numbers', 'tenant_phone_assignments', 'feature_flag_overrides', 'tenants', 'users', 'telephony_credentials']) {
      const { rows: n } = await getTestPool().query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`);
      expect(n[0]!.n, table).toBe(0);
    }
  });
});
