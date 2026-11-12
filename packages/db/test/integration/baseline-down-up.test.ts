import { randomUUID } from 'node:crypto';
import { runner } from 'node-pg-migrate';
import { afterAll, describe, expect, it } from 'vitest';
import { MIGRATIONS_DIR } from '../../src/migrations-dir.js';
import { TEST_DB_URL, closeTestPool, getTestPool, truncateAll } from '../helpers/test-db.js';
import { insertAttempt, insertCall, insertCampaign, insertContact, insertManualCall, insertSession, insertSoftphoneSession } from './fixtures.js';

/**
 * Every migration's Down section drops everything its Up section creates, and the
 * Up sections re-apply cleanly afterwards. Runs node-pg-migrate's own `runner` both
 * ways, so the marker split is exercised exactly as `migrate:down` / `migrate:up` would.
 *
 * The database is left MIGRATED at the end (the last step is `up`), so this file
 * is safe to run before or after any other integration file.
 */

const migrate = (direction: 'up' | 'down', count = Infinity) =>
  runner({
    databaseUrl: TEST_DB_URL,
    dir: MIGRATIONS_DIR,
    direction,
    migrationsTable: 'pgmigrations',
    // No migration lock: nothing else migrates this file's own database copy, and after a
    // refused Down the runner's unlock fails on its aborted transaction, so the lock lingers
    // until the session ends, which the restore right after could race.
    noLock: true,
    count,
    log: () => {},
  });

/**
 * Roll back every migration after 0005, so 0005's Down is the next one to run: a later
 * migration's Down commits on its own (one transaction per file) before 0005's refuses, so
 * "the refusal changes nothing" is asserted from 0005 being the top. Returns the restore.
 */
async function downTo0005(): Promise<() => Promise<void>> {
  const after = ALL_MIGRATIONS.length - ALL_MIGRATIONS.indexOf('0005_softphone') - 1;
  if (after > 0) await migrate('down', after);
  return async () => { if (after > 0) await migrate('up'); };
}

const UP_TO_0005 = ['0001_baseline', '0002_telephony_credentials', '0003_agency_attempt_indexes', '0004_agency_contacts_in_flight_index', '0005_softphone'];

async function indexExists(name: string): Promise<boolean> {
  const { rowCount } = await getTestPool().query('SELECT 1 FROM pg_indexes WHERE indexname = $1', [name]);
  return rowCount === 1;
}

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
  '0005_softphone', '0006_agent_session_client_kind', '0007_ingest_dedupe_column',
  '0008_wrapup_redial', '0009_contact_assignment', '0010_contact_assignment_index_and_checks',
  '0011_insights_foundation', '0012_insights_rollup', '0013_insights_pacing_history',
  '0014_insights_rollup_first_dials_carrier_errors', '0015_multiple_running_campaigns', '0016_customer_history_indexes',
  '0017_customer_history_contacts_index', '0018_agent_caller_ids', '0019_plivo_numbers_and_carrier_pause',
  '0020_carrier_account_unavailable_pause', '0021_carrier_refusing_calls_pause', '0022_outcome_dispositions',
  '0023_reports', '0024_inbound', '0025_inbound_checks_validate', '0026_inbound_live_indexes',
  '0027_inbound_connect', '0028_inbound_missed_follow_up', '0029_inbound_reach_settles', '0030_inbound_reached_on_outcome',
  '0031_ingest_dedupe_columns', '0032_inbound_route_wrapup',
  '0033_inbound_answered_from_index', '0034_dnc_phone_ending_index',
  '0035_one_station_per_agent', '0036_inbound_ring',
];

/** The CHECKs 0009 adds NOT VALID on the big tables and 0010 validates. */
const CONTACT_ASSIGNMENT_DEFERRED_CHECKS = [
  'ck_agency_attempt_override_applied', 'ck_agency_attempt_override_note',
  'ck_agency_contact_agent_retry_rounds_used', 'ck_agency_contact_assigned_at',
  'ck_agency_contact_override_extra_attempts',
];

async function checksValidated(names: readonly string[]): Promise<Record<string, boolean>> {
  const { rows } = await getTestPool().query<{ conname: string; convalidated: boolean }>(
    'SELECT conname, convalidated FROM pg_constraint WHERE conname = ANY($1::text[]) ORDER BY conname', [names]);
  return Object.fromEntries(rows.map((r) => [r.conname, r.convalidated]));
}

describe('migrations down → up', () => {
  afterAll(closeTestPool);

  it('0005 down refuses while a soft-phone session exists, and changes nothing', async () => {
    // Reverting agency_agent_sessions.campaign_id to NOT NULL cannot keep a soft-phone
    // session, and deleting one would take its manual calls' audit trail with it, so
    // the Down section raises before it alters anything (one transaction).
    await truncateAll();
    const session = await insertSoftphoneSession();
    await insertManualCall(session.id);
    const restore = await downTo0005();
    try {
      const before = await inventory();

      await expect(migrate('down')).rejects.toThrow(/soft-phone sessions exist/);
      expect(await inventory()).toEqual(before);
      const ledger = await getTestPool().query<{ name: string }>('SELECT name FROM pgmigrations ORDER BY id');
      expect(ledger.rows.map((r) => r.name)).toEqual(UP_TO_0005);
    } finally {
      await restore();
    }
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
    const restore = await downTo0005();
    try {
      const before = await inventory();

      await expect(migrate('down')).rejects.toThrow(/soft-phone calls exist/);
      expect(await inventory()).toEqual(before);
      expect((await getTestPool().query('SELECT count(*)::int AS n FROM agency_manual_calls')).rows[0].n).toBe(1);
      const ledger = await getTestPool().query<{ name: string }>('SELECT name FROM pgmigrations ORDER BY id');
      expect(ledger.rows.map((r) => r.name)).toEqual(UP_TO_0005);
    } finally {
      await restore();
    }
    await truncateAll();
  });

  it('0005 down refuses while a manual media leg exists, its manual call already purged', async () => {
    await truncateAll();
    await insertCall({ origin: 'manual', manual_call_id: randomUUID() });
    const restore = await downTo0005();
    try {
      const before = await inventory();
      await expect(migrate('down')).rejects.toThrow(/soft-phone calls exist/);
      expect(await inventory()).toEqual(before);
    } finally {
      await restore();
    }
    await truncateAll();
  });

  it('0008 down runs with a redial chain present: `redialed` wrap-ups become agent_left, the rows survive', async () => {
    // A redialled call (wrap-up resolution and system code `redialed`) and its redial.
    // The resolution CHECK loses `redialed`, so the Down rewrites it first; the redial
    // row keeps everything but its link and number; the `redialed` disposition code is
    // an ordinary string the Down leaves alone. Then Up re-applies over the same rows.
    await truncateAll();
    const campaign = await insertCampaign({ allow_wrapup_redial: true });
    const contact = await insertContact(campaign.id);
    const original = await insertAttempt(campaign.id, contact.id, {
      state: 'ended', attempt_number: 1, outcome: 'connected', disposition_code: 'redialed', wrapup_resolution: 'redialed',
    });
    const redial = await insertAttempt(campaign.id, contact.id, {
      state: 'ended', attempt_number: 2, outcome: 'no_answer', redial_of_attempt_id: original.id, redial_number: 1,
    });
    await migrate('down', ALL_MIGRATIONS.length - ALL_MIGRATIONS.indexOf('0008_wrapup_redial'));
    try {
      const ledger = await getTestPool().query<{ name: string }>('SELECT name FROM pgmigrations ORDER BY id');
      expect(ledger.rows.map((r) => r.name)).toEqual(ALL_MIGRATIONS.slice(0, ALL_MIGRATIONS.indexOf('0008_wrapup_redial')));
      const { rows } = await getTestPool().query<Record<string, unknown>>(
        'SELECT * FROM agency_call_attempts WHERE id = ANY($1::uuid[]) ORDER BY attempt_number', [[original.id, redial.id]]);
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({ wrapup_resolution: 'agent_left', disposition_code: 'redialed' });
      expect(rows[0]).not.toHaveProperty('redial_number');
      expect(rows[1]).not.toHaveProperty('redial_of_attempt_id');
      const camp = await getTestPool().query('SELECT * FROM agency_campaigns WHERE id = $1', [campaign.id]);
      expect(camp.rows[0]).not.toHaveProperty('allow_wrapup_redial');
    } finally {
      await migrate('up');
    }
    const back = await getTestPool().query<{ redial_number: number; redial_of_attempt_id: string | null }>(
      'SELECT redial_number, redial_of_attempt_id FROM agency_call_attempts WHERE id = $1', [redial.id]);
    // Re-applied with the column defaults: the link is not restored (it was dropped).
    expect(back.rows[0]).toEqual({ redial_number: 0, redial_of_attempt_id: null });
    await truncateAll();
  });

  it('0009 down runs with assigned contacts and their history present: the rows survive, unowned', async () => {
    await truncateAll();
    const campaign = await insertCampaign({ assignment_mode: 'strict', allow_agent_retry: true });
    const agent = randomUUID();
    const contact = await insertContact(campaign.id, {
      assigned_user_id: agent, assigned_at: new Date(), override_extra_attempts: 2, override_disposition: 'ptp',
    });
    await getTestPool().query(
      `INSERT INTO agency_contact_assignment_events (tenant_id, campaign_id, contact_id, to_user_id, reason, batch_id)
       VALUES ($1, $2, $3, $4, 'manual', $5)`,
      [campaign['tenant_id'], campaign.id, contact.id, agent, randomUUID()]);
    await insertAttempt(campaign.id, contact.id, {
      state: 'ended', attempt_number: 1, agent_manual: true, override_applied: ['calling_hours'], override_note: 'customer asked for 9pm',
    });
    await migrate('down', ALL_MIGRATIONS.length - ALL_MIGRATIONS.indexOf('0009_contact_assignment'));
    try {
      const { rows } = await getTestPool().query<Record<string, unknown>>('SELECT * FROM agency_contacts WHERE id = $1', [contact.id]);
      expect(rows).toHaveLength(1);
      expect(rows[0]).not.toHaveProperty('assigned_user_id');
      expect(rows[0]).not.toHaveProperty('override_extra_attempts');
      const camp = await getTestPool().query('SELECT * FROM agency_campaigns WHERE id = $1', [campaign.id]);
      expect(camp.rows[0]).not.toHaveProperty('assignment_mode');
      const attempts = await getTestPool().query('SELECT * FROM agency_call_attempts WHERE contact_id = $1', [contact.id]);
      expect(attempts.rows[0]).not.toHaveProperty('agent_manual');
    } finally {
      await migrate('up');
    }
    const back = await getTestPool().query<{ assigned_user_id: string | null; assignment_mode: string }>(
      `SELECT c.assigned_user_id, k.assignment_mode FROM agency_contacts c
         JOIN agency_campaigns k ON k.id = c.campaign_id WHERE c.id = $1`, [contact.id]);
    // Re-applied with the column defaults: the owner is not restored (it was dropped).
    expect(back.rows[0]).toEqual({ assigned_user_id: null, assignment_mode: 'pool' });
    await truncateAll();
  });

  it('0009 adds its contact and attempt CHECKs NOT VALID yet enforced; 0010 validates the rows already there', async () => {
    // 0009 holds ACCESS EXCLUSIVE on agency_contacts and agency_call_attempts, so it must not
    // scan them: the CHECKs go in NOT VALID, and 0010 validates them under SHARE UPDATE
    // EXCLUSIVE in its own transaction (0009's header, "Locking"). Rows that predate 0009 are
    // present at both steps, so validation runs over real rows.
    await truncateAll();
    await migrate('down', ALL_MIGRATIONS.length - ALL_MIGRATIONS.indexOf('0009_contact_assignment'));
    try {
      const campaign = await insertCampaign();
      const contact = await insertContact(campaign.id);
      await insertAttempt(campaign.id, contact.id, { state: 'ended', attempt_number: 1 });

      await migrate('up', 1);
      const ledger = await getTestPool().query<{ name: string }>('SELECT name FROM pgmigrations ORDER BY id');
      expect(ledger.rows.map((r) => r.name)).toEqual(ALL_MIGRATIONS.slice(0, ALL_MIGRATIONS.indexOf('0009_contact_assignment') + 1));
      expect(await checksValidated(CONTACT_ASSIGNMENT_DEFERRED_CHECKS))
        .toEqual(Object.fromEntries(CONTACT_ASSIGNMENT_DEFERRED_CHECKS.map((n) => [n, false])));
      // The small table's CHECKs are validated by 0009 itself.
      expect(await checksValidated(['ck_agency_campaign_assignment_mode'])).toEqual({ ck_agency_campaign_assignment_mode: true });
      // NOT VALID still refuses every new bad write.
      await expect(getTestPool().query('UPDATE agency_contacts SET assigned_user_id = $1 WHERE id = $2', [randomUUID(), contact.id]))
        .rejects.toMatchObject({ code: '23514', constraint: 'ck_agency_contact_assigned_at' });
      await expect(getTestPool().query('UPDATE agency_contacts SET override_extra_attempts = 6 WHERE id = $1', [contact.id]))
        .rejects.toMatchObject({ code: '23514', constraint: 'ck_agency_contact_override_extra_attempts' });
      await expect(insertAttempt(campaign.id, contact.id, { state: 'ended', attempt_number: 2, override_note: 'short' }))
        .rejects.toMatchObject({ code: '23514', constraint: 'ck_agency_attempt_override_note' });
      expect(await indexExists('idx_agency_contacts_assignee')).toBe(false);
    } finally {
      await migrate('up');
    }
    expect(await checksValidated(CONTACT_ASSIGNMENT_DEFERRED_CHECKS))
      .toEqual(Object.fromEntries(CONTACT_ASSIGNMENT_DEFERRED_CHECKS.map((n) => [n, true])));
    expect(await indexExists('idx_agency_contacts_assignee')).toBe(true);
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
    expect(before).toContain('rel:r:agency_insights_rollup_buckets');
    expect(before).toContain('fn:agency_insights_bucket');

    await migrate('down');
    expect(await inventory()).toEqual([]);
    const ledger = await getTestPool().query('SELECT name FROM pgmigrations');
    expect(ledger.rows).toEqual([]);

    await migrate('up');
    expect(await inventory()).toEqual(before);
    const reapplied = await getTestPool().query<{ name: string }>('SELECT name FROM pgmigrations ORDER BY id');
    expect(reapplied.rows.map((r) => r.name)).toEqual(ALL_MIGRATIONS);
  });

  it('a fresh apply seeds exactly the telephony providers voicelink and plivo, both active (0019 activates plivo)', async () => {
    // Checked here rather than in baseline.test.ts because that file truncates.
    const { rows } = await getTestPool().query<{ name: string; status: string }>('SELECT name, status FROM telephony_providers ORDER BY name');
    // 0002 seeds plivo inactive; 0019 activates it with its dial path (numbers, allocations, campaigns).
    expect(rows).toEqual([{ name: 'plivo', status: 'active' }, { name: 'voicelink', status: 'active' }]);
    // ...and nothing else: no seed super-admin, no seed number, no feature flags.
    for (const table of ['super_admins', 'phone_numbers', 'tenant_phone_assignments', 'feature_flag_overrides', 'tenants', 'users', 'telephony_credentials']) {
      const { rows: n } = await getTestPool().query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`);
      expect(n[0]!.n, table).toBe(0);
    }
  });
});
