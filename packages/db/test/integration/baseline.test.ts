import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { MIGRATIONS_DIR } from '../../src/migrations-dir.js';
import { closeTestPool, getTestPool, truncateAll } from '../helpers/test-db.js';
import {
  ACCOUNT,
  TENANT,
  insertAccount,
  insertAttempt,
  insertAudioFile,
  insertCall,
  insertCampaign,
  insertContact,
  insertMembership,
  insertRow,
  insertSession,
  insertTenant,
  insertUser,
  seedUpdatedAtRows,
} from './fixtures.js';

/**
 * The squashed baseline (migrations/0001_baseline.sql) against a real Postgres.
 * globalSetup has already dropped the schema and applied every migration, so the
 * fact that this file runs at all is the "migrates on a throwaway Postgres" check.
 *
 * Assertions ported from the source suites cite their origin as
 * `core:<path>` / `master:<path>` (magic-voice-core v1.123.2, magick-master v3.24.0).
 */

const pool = () => getTestPool();

afterAll(closeTestPool);

/** Every table the baseline owns (partitions excluded). */
const EXPECTED_TABLES = [
  // identity (master)
  'tenants', 'accounts', 'users', 'memberships', 'membership_invites',
  'super_admins', 'super_admin_audit_log',
  // phone inventory (master)
  'telephony_providers', 'phone_numbers', 'tenant_phone_assignments', 'phone_account_tags',
  // notifications (master)
  'user_notification_preferences', 'notification_deliveries',
  // audit (master + core, B7)
  'platform_audit_log', 'audit_logs',
  // master agency
  'dnc_entries', 'agency_ingest_jobs', 'agency_campaign_agents',
  // settings / guard / flags (core)
  'account_settings', 'account_provider_concurrency_allocations', 'feature_flag_overrides',
  // clips (core)
  'audio_files', 'announcements',
  // analysis (core)
  'call_analysis_profiles', 'dialer_analysis_jobs',
  // core agency
  'agency_campaigns', 'agency_contacts', 'agency_agent_sessions', 'agency_agent_session_events',
  'agency_call_attempts', 'agency_ingest_chunks', 'agency_dnc_outbox', 'agency_calls',
].sort();

const UPDATED_AT_TRIGGERS: Array<[trigger: string, table: string]> = [
  ['tenants_updated_at', 'tenants'],
  ['accounts_updated_at', 'accounts'],
  ['users_updated_at', 'users'],
  ['memberships_updated_at', 'memberships'],
  ['trg_telephony_providers_updated', 'telephony_providers'],
  ['trg_phone_numbers_updated', 'phone_numbers'],
  ['user_notification_preferences_updated_at', 'user_notification_preferences'],
  ['agency_ingest_jobs_updated_at', 'agency_ingest_jobs'],
  ['agency_campaign_agents_updated_at', 'agency_campaign_agents'],
  ['set_feature_flag_overrides_updated_at', 'feature_flag_overrides'],
  ['audio_files_updated_at', 'audio_files'],
  ['announcements_updated_at', 'announcements'],
  ['trg_analysis_profiles_updated_at', 'call_analysis_profiles'],
  ['trg_agency_campaigns_updated_at', 'agency_campaigns'],
  ['trg_agency_contacts_updated_at', 'agency_contacts'],
  ['trg_agency_agent_sessions_updated_at', 'agency_agent_sessions'],
  ['trg_agency_call_attempts_updated_at', 'agency_call_attempts'],
  ['trg_agency_dnc_outbox_updated_at', 'agency_dnc_outbox'],
  ['trg_agency_calls_updated_at', 'agency_calls'],
  ['trg_dialer_analysis_jobs_updated_at', 'dialer_analysis_jobs'],
];

const ALL_TRIGGERS: Array<[trigger: string, table: string]> = [
  ...UPDATED_AT_TRIGGERS,
  ['trg_agency_contacts_root', 'agency_contacts'],
];

async function indexDef(name: string): Promise<string | undefined> {
  const { rows } = await pool().query<{ indexdef: string }>(
    `SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = $1`,
    [name],
  );
  return rows[0]?.indexdef;
}

async function columnsOf(table: string): Promise<Map<string, { data_type: string; is_nullable: string; column_default: string | null }>> {
  const { rows } = await pool().query<{ column_name: string; data_type: string; is_nullable: string; column_default: string | null }>(
    `SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1`,
    [table],
  );
  return new Map(rows.map((r) => [r.column_name, r]));
}

describe('baseline schema — structure', () => {
  it('creates exactly the expected tables', async () => {
    const { rows } = await pool().query<{ relname: string }>(
      `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relispartition
          AND c.relname <> 'pgmigrations'`,
    );
    expect(rows.map((r) => r.relname).sort()).toEqual(EXPECTED_TABLES);
  });

  it('has exactly one up marker and one down marker, so node-pg-migrate splits it correctly', () => {
    // core 093's header: node-pg-migrate's sqlMigration splits on
    // /^\s*--[\s-]*(up|down)\s+migration/im, and a stray comment line that matches
    // moves the split silently.
    const sql = readFileSync(resolve(MIGRATIONS_DIR, '0001_baseline.sql'), 'utf8');
    expect(sql.match(/^\s*--[\s-]*up\s+migration/gim)).toHaveLength(1);
    expect(sql.match(/^\s*--[\s-]*down\s+migration/gim)).toHaveLength(1);
    expect(sql.search(/^\s*--[\s-]*up\s+migration/im)).toBeLessThan(sql.search(/^\s*--[\s-]*down\s+migration/im));
  });

  it('types every tenant, account and user id column as UUID', async () => {
    const expectations: Array<[string, string]> = [
      ['agency_campaigns', 'tenant_id'], ['agency_campaigns', 'account_id'], ['agency_campaigns', 'last_transition_by_user_id'],
      ['agency_contacts', 'tenant_id'], ['agency_contacts', 'account_id'],
      ['agency_agent_sessions', 'tenant_id'], ['agency_agent_sessions', 'account_id'], ['agency_agent_sessions', 'agent_user_id'],
      ['agency_agent_session_events', 'tenant_id'], ['agency_agent_session_events', 'account_id'], ['agency_agent_session_events', 'agent_user_id'],
      ['agency_call_attempts', 'tenant_id'], ['agency_call_attempts', 'account_id'], ['agency_call_attempts', 'dispositioned_by_user_id'],
      ['agency_dnc_outbox', 'tenant_id'],
      ['agency_calls', 'tenant_id'], ['agency_calls', 'account_id'],
      ['dialer_analysis_jobs', 'tenant_id'], ['dialer_analysis_jobs', 'account_id'],
      ['call_analysis_profiles', 'tenant_id'], ['call_analysis_profiles', 'account_id'],
      ['account_settings', 'tenant_id'], ['account_settings', 'account_id'],
      ['account_provider_concurrency_allocations', 'tenant_id'], ['account_provider_concurrency_allocations', 'account_id'],
      ['feature_flag_overrides', 'tenant_id'], ['feature_flag_overrides', 'account_id'],
      ['audio_files', 'tenant_id'], ['audio_files', 'account_id'],
      ['announcements', 'tenant_id'], ['announcements', 'account_id'],
      ['audit_logs', 'tenant_id'], ['audit_logs', 'account_id'],
      ['platform_audit_log', 'tenant_id'], ['platform_audit_log', 'account_id'], ['platform_audit_log', 'user_id'],
    ];
    for (const [table, column] of expectations) {
      const col = (await columnsOf(table)).get(column);
      expect(col, `${table}.${column} missing`).toBeDefined();
      expect(col!.data_type, `${table}.${column}`).toBe('uuid');
    }
  });

  it("drops core's 'default' account_id defaults — they cannot be UUIDs", async () => {
    for (const table of ['agency_campaigns', 'agency_calls', 'call_analysis_profiles', 'dialer_analysis_jobs']) {
      const col = (await columnsOf(table)).get('account_id');
      expect(col!.is_nullable, table).toBe('NO');
      expect(col!.column_default, table).toBeNull();
    }
  });

  it('does not carry the excluded columns', async () => {
    const absent: Array<[string, string]> = [
      ['agency_calls', 'sip_connection_id'],
      ['agency_calls', 'telephony_credential_id'],
      ['agency_campaigns', 'sip_connection_id'],
      ['dialer_analysis_jobs', 'settlement_status'],
      ['dialer_analysis_jobs', 'settlement_attempts'],
      ['dialer_analysis_jobs', 'settlement_pending_since'],
      ['account_settings', 'default_ai_pipeline'],
      ['announcements', 'tts_text'],
      ['announcements', 'tts_voice'],
      ['announcements', 'tts_language'],
      ['platform_audit_log', 'api_key_id'],
      ['telephony_providers', 'live_transfer_enabled'],
      ['phone_numbers', 'ownership'],
      ['phone_numbers', 'owner_tenant_id'],
    ];
    for (const [table, column] of absent) {
      expect((await columnsOf(table)).has(column), `${table}.${column} should not exist`).toBe(false);
    }
    // ...while the metering facts plan §3.3 keeps are still there.
    expect((await columnsOf('dialer_analysis_jobs')).has('analysis_audio_seconds')).toBe(true);
    expect(await indexDef('idx_agency_attempts_billing')).toBeDefined();
  });

  it('renames every object whose name embedded webrtc_calls', async () => {
    const { rows } = await pool().query<{ name: string }>(
      `SELECT indexname AS name FROM pg_indexes WHERE schemaname = 'public' AND indexname LIKE '%webrtc_calls%'
       UNION ALL SELECT conname FROM pg_constraint WHERE conname LIKE '%webrtc_calls%'
       UNION ALL SELECT tgname FROM pg_trigger WHERE tgname LIKE '%webrtc_calls%'`,
    );
    expect(rows).toEqual([]);
    for (const name of ['idx_agency_calls_tenant', 'idx_agency_calls_active', 'idx_agency_calls_provider_call_id', 'idx_agency_calls_analysis_status']) {
      expect(await indexDef(name), name).toBeDefined();
    }
  });

  // core:test/integration/agency/agency-migration.test.ts T-M1b
  it('agency_calls back-references exist and are NULLABLE', async () => {
    const cols = await columnsOf('agency_calls');
    for (const name of ['campaign_id', 'agency_attempt_id']) {
      expect(cols.get(name)!.is_nullable).toBe('YES');
      expect(cols.get(name)!.data_type).toBe('uuid');
    }
  });

  // core:test/integration/agency/agency-migration.test.ts T-M1c
  it('context and caller_ids have the shapes the engine assumes', async () => {
    const contacts = await columnsOf('agency_contacts');
    const campaigns = await columnsOf('agency_campaigns');
    expect(contacts.get('context')!.data_type).toBe('jsonb');
    expect(contacts.get('context')!.is_nullable).toBe('NO');
    expect(contacts.get('next_attempt_at')!.is_nullable).toBe('NO');
    expect(contacts.get('attempt_count')!.is_nullable).toBe('NO');
    expect(campaigns.get('caller_ids')!.data_type).toBe('ARRAY');
    expect(campaigns.get('retry_policy')!.data_type).toBe('jsonb');
    expect(campaigns.get('disposition_catalog')!.data_type).toBe('jsonb');
    expect(campaigns.get('context_display')!.data_type).toBe('jsonb');
  });

  // core:test/unit/agency/retry-lineage-migrations.test.ts (111/112/114), as catalog facts
  it('keeps the lineage shape: FK on the pointers, none on the grouping keys', async () => {
    const { rows } = await pool().query<{ conname: string; def: string }>(
      `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE contype = 'f' AND conrelid IN ('agency_campaigns'::regclass, 'agency_contacts'::regclass)`,
    );
    const defs = rows.map((r) => r.def);
    expect(defs).toContain('FOREIGN KEY (parent_campaign_id) REFERENCES agency_campaigns(id) ON DELETE SET NULL');
    expect(defs).toContain('FOREIGN KEY (source_contact_id) REFERENCES agency_contacts(id) ON DELETE SET NULL');
    expect(defs.some((d) => d.includes('root_campaign_id'))).toBe(false);
    expect(defs.some((d) => d.includes('root_contact_id'))).toBe(false);
    // 112: both lineage columns NULLABLE and DEFAULTLESS.
    const contacts = await columnsOf('agency_contacts');
    for (const name of ['source_contact_id', 'root_contact_id']) {
      expect(contacts.get(name)!.is_nullable).toBe('YES');
      expect(contacts.get(name)!.column_default).toBeNull();
    }
    expect((await columnsOf('agency_campaigns')).get('retry_generation')!.column_default).toBe('0');
    // 114: neither partial nor covering, and not on campaign_id.
    expect(await indexDef('idx_agency_contacts_root')).toBe(
      'CREATE INDEX idx_agency_contacts_root ON public.agency_contacts USING btree (root_contact_id)',
    );
    expect(await indexDef('idx_agency_campaigns_parent')).toContain('WHERE (parent_campaign_id IS NOT NULL)');
  });

  // core:test/integration/agency/agency-duplicate-dial.test.ts T-D3b
  it('uq_agency_attempt_live is defined exactly as the design specifies', async () => {
    expect(await indexDef('uq_agency_attempt_live')).toBe(
      'CREATE UNIQUE INDEX uq_agency_attempt_live ON public.agency_call_attempts ' +
      'USING btree (contact_id) WHERE ((state)::text <> \'ended\'::text)',
    );
  });

  // core:test/integration/agency/agency-dnc-campaign-scope.test.ts T-DNC8
  it('agency_dnc_outbox.campaign_id is nullable and the digit-projection index exists', async () => {
    expect((await columnsOf('agency_dnc_outbox')).get('campaign_id')!.is_nullable).toBe('YES');
    const def = await indexDef('idx_agency_contacts_campaign_phone_digits');
    expect(def).toContain('campaign_id');
    expect(def).toContain("regexp_replace((phone_e164)::text, '[^0-9]'::text, ''::text, 'g'::text)");
  });

  // core:test/integration/db/audio-file-pcm-migration.test.ts
  it('audio_files carries the three PCM columns, nullable and unindexed', async () => {
    const cols = await columnsOf('audio_files');
    expect(cols.get('pcm_audio_hash')).toMatchObject({ data_type: 'character varying', is_nullable: 'YES' });
    expect(cols.get('pcm_sample_rate')).toMatchObject({ data_type: 'integer', is_nullable: 'YES' });
    expect(cols.get('pcm_channels')).toMatchObject({ data_type: 'smallint', is_nullable: 'YES' });
    const { rows } = await pool().query(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'audio_files' AND indexdef ~ 'pcm_'`,
    );
    expect(rows).toEqual([]);
  });

  // master:test/integration/repositories/agency-campaign-agents-schema.test.ts
  it('staffing: the 064 per-campaign index exists and the 060 index is gone', async () => {
    expect(await indexDef('uq_agency_campaign_agent_active_campaign')).toBe(
      'CREATE UNIQUE INDEX uq_agency_campaign_agent_active_campaign ON public.agency_campaign_agents ' +
      'USING btree (tenant_id, user_id, campaign_id) WHERE (unassigned_at IS NULL)',
    );
    expect(await indexDef('uq_agency_campaign_agent_active')).toBeUndefined();
    expect(await indexDef('idx_agency_campaign_agents_campaign_active')).toContain('WHERE (unassigned_at IS NULL)');
  });

  // master:test/integration/dnc/dnc-index-usage.test.ts ("guards the guard")
  it('the DNC indexes exist', async () => {
    for (const name of ['uq_dnc_scope', 'idx_dnc_entries_tenant_phone', 'idx_dnc_entries_tenant_created']) {
      expect(await indexDef(name), name).toBeDefined();
    }
  });

  it('agency.md §2 uq_agency_agent_live is superseded by core 093 — only the tenant index exists', async () => {
    expect(await indexDef('uq_agency_agent_live')).toBeUndefined();
    expect(await indexDef('uq_agency_agent_live_tenant')).toBe(
      'CREATE UNIQUE INDEX uq_agency_agent_live_tenant ON public.agency_agent_sessions ' +
      'USING btree (tenant_id, agent_user_id) WHERE (left_at IS NULL)',
    );
  });
});

describe('membership_role enum', () => {
  it("has master's six values in master's declared order (051 appended agent last)", async () => {
    const { rows } = await pool().query<{ v: string }>(
      `SELECT unnest(enum_range(NULL::membership_role))::text AS v`,
    );
    expect(rows.map((r) => r.v)).toEqual([
      'tenant_owner', 'tenant_admin', 'account_admin', 'operator', 'viewer', 'agent',
    ]);
  });

  it('accepts agent and refuses a role the platform does not have', async () => {
    await truncateAll();
    const tenant = await insertTenant();
    const user = await insertUser();
    await expect(insertMembership(user.id, tenant.id, { role: 'agent' })).resolves.toBeTruthy();
    await expect(insertMembership(user.id, tenant.id, { role: 'supervisor', account_id: (await insertAccount(tenant.id)).id }))
      .rejects.toMatchObject({ code: '22P02' });
  });
});

describe('triggers', () => {
  beforeEach(() => truncateAll());

  it('every carried trigger exists by name on its table, and is enabled', async () => {
    const { rows } = await pool().query<{ tgname: string; relname: string; tgenabled: string }>(
      `SELECT t.tgname, c.relname, t.tgenabled FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
        WHERE NOT t.tgisinternal`,
    );
    const found = new Map(rows.map((r) => [r.tgname, r]));
    expect(rows).toHaveLength(ALL_TRIGGERS.length);
    for (const [trigger, table] of ALL_TRIGGERS) {
      expect(found.get(trigger)?.relname, trigger).toBe(table);
      expect(found.get(trigger)?.tgenabled, trigger).toBe('O');
    }
  });

  it('every updated_at trigger fires on UPDATE', async () => {
    const rows = await seedUpdatedAtRows();
    expect(rows.map((r) => r.trigger).sort()).toEqual(UPDATED_AT_TRIGGERS.map(([t]) => t).sort());
    for (const row of rows) {
      const key = row.key ?? 'id';
      const before = await pool().query<{ updated_at: Date }>(
        `SELECT updated_at FROM ${row.table} WHERE ${key} = $1`, [row.id],
      );
      expect(before.rows[0]!.updated_at.getUTCFullYear(), `${row.table} not backdated`).toBe(2000);
      const after = await pool().query<{ updated_at: Date }>(
        `UPDATE ${row.table} SET ${row.touch} WHERE ${key} = $1 RETURNING updated_at`, [row.id],
      );
      expect(after.rowCount, row.table).toBe(1);
      expect(after.rows[0]!.updated_at.getTime(), `${row.trigger} did not fire`).toBeGreaterThan(Date.now() - 60_000);
    }
  });

  // core:test/integration/agency/agency-retry-seeding.test.ts "stamps root_contact_id on an ordinary ingest row"
  it('trg_agency_contacts_root stamps root_contact_id := id on an ordinary insert', async () => {
    const campaign = await insertCampaign();
    for (let i = 0; i < 5; i++) await insertContact(campaign.id, { phone_e164: `+1415555020${i}` });
    const { rows } = await pool().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM agency_contacts WHERE campaign_id = $1 AND root_contact_id = id`,
      [campaign.id],
    );
    expect(rows[0]!.n).toBe(5);
  });

  // core:test/unit/agency/retry-lineage-migrations.test.ts "stamps the root only when the caller supplied none"
  // + core:test/integration/agency/agency-retry-seeding.test.ts (root = the PARENT's row)
  it('trg_agency_contacts_root leaves a supplied root alone (the retry-copy path)', async () => {
    const parent = await insertCampaign();
    const child = await insertCampaign({ parent_campaign_id: parent.id, root_campaign_id: parent.id, retry_generation: 1 });
    const original = await insertContact(parent.id);
    const copy = await insertContact(child.id, { source_contact_id: original.id, root_contact_id: original.root_contact_id });
    expect(copy.root_contact_id).toBe(original.id);
    expect(copy.source_contact_id).toBe(original.id);
    expect(copy.root_contact_id).not.toBe(copy.id);
  });

  it('trg_agency_contacts_root fires on INSERT only — an UPDATE to NULL is not re-stamped', async () => {
    const campaign = await insertCampaign();
    const contact = await insertContact(campaign.id);
    const { rows } = await pool().query<{ root_contact_id: string | null }>(
      `UPDATE agency_contacts SET root_contact_id = NULL WHERE id = $1 RETURNING root_contact_id`,
      [contact.id],
    );
    expect(rows[0]!.root_contact_id).toBeNull();
  });

  // core:test/integration/agency/agency-retry-seeding.test.ts "113 is a no-op on a second run"
  it('after the trigger, the 113 backfill predicate matches zero rows', async () => {
    const campaign = await insertCampaign();
    await insertContact(campaign.id);
    const result = await pool().query('UPDATE agency_contacts SET root_contact_id = id WHERE root_contact_id IS NULL');
    expect(result.rowCount).toBe(0);
  });

  it('agency_contact_row_fingerprint() is md5 of {p, c, tz}, NULL-timezone-safe and STABLE', async () => {
    const { rows } = await pool().query<{ fp: string; expected: string; tz_null: string | null; vol: string }>(
      `SELECT agency_contact_row_fingerprint('+14155550101', '{"b": 2, "a": 1}'::jsonb, NULL) AS fp,
              md5(jsonb_build_object('p', '+14155550101', 'c', '{"a": 1, "b": 2}'::jsonb, 'tz', NULL)::text) AS expected,
              agency_contact_row_fingerprint('+14155550101', NULL, NULL) AS tz_null,
              (SELECT provolatile::text FROM pg_proc WHERE proname = 'agency_contact_row_fingerprint') AS vol`,
    );
    expect(rows[0]!.fp).toBe(rows[0]!.expected);
    expect(rows[0]!.fp).toMatch(/^[0-9a-f]{32}$/);
    // NOT STRICT: a NULL timezone / context still yields a fingerprint.
    expect(rows[0]!.tz_null).toMatch(/^[0-9a-f]{32}$/);
    expect(rows[0]!.vol).toBe('s');
  });

  // core 083's contract: the fingerprint is what the ingest INSERT writes, and the
  // unique index refuses a byte-identical row in the same campaign.
  it('row fingerprints written through the function collide exactly on identical content', async () => {
    const campaign = await insertCampaign();
    const write = (phone: string, context: object) => pool().query(
      `INSERT INTO agency_contacts (campaign_id, tenant_id, account_id, phone_e164, context, row_fingerprint)
       VALUES ($1, $2, $3, $4, $5::jsonb, agency_contact_row_fingerprint($4, $5::jsonb, NULL))`,
      [campaign.id, TENANT, ACCOUNT, phone, JSON.stringify(context)],
    );
    await write('+14155550101', { name: 'Asha' });
    // same number, different person (household landline) — kept
    await expect(write('+14155550101', { name: 'Ravi' })).resolves.toBeTruthy();
    // same content, key order shuffled — the same row, refused
    await write('+14155550102', { a: 1, b: 2 });
    await expect(write('+14155550102', { b: 2, a: 1 })).rejects.toMatchObject({
      code: '23505', constraint: 'uq_agency_contacts_row_fingerprint',
    });
  });
});

describe('the uniqueness constraints that carry the design (agency.md §2)', () => {
  beforeEach(() => truncateAll());

  // core:test/integration/agency/agency-duplicate-dial.test.ts T-M5
  it('uq_agency_campaign_running — one running campaign per account', async () => {
    await insertCampaign({ status: 'running' });
    await expect(insertCampaign({ status: 'running' })).rejects.toMatchObject({
      code: '23505', constraint: 'uq_agency_campaign_running',
    });
    await expect(insertCampaign({ status: 'running', account_id: randomUUID() })).resolves.toBeTruthy();
    await expect(insertCampaign({ status: 'paused' })).resolves.toBeTruthy();
    await expect(insertCampaign({ status: 'draft' })).resolves.toBeTruthy();
  });

  // core:test/integration/agency/agency-duplicate-dial.test.ts T-M6
  it('uq_agency_agent_live_tenant — one live session per agent per TENANT, reusable after leaving', async () => {
    const agent = randomUUID();
    const campaign = await insertCampaign();
    const first = await insertSession(campaign.id, { agent_user_id: agent });
    await expect(insertSession(campaign.id, { agent_user_id: agent })).rejects.toMatchObject({
      code: '23505', constraint: 'uq_agency_agent_live_tenant',
    });
    const otherAccount = randomUUID();
    const other = await insertCampaign({ account_id: otherAccount });
    await expect(insertSession(other.id, { agent_user_id: agent, account_id: otherAccount })).rejects.toMatchObject({
      code: '23505', constraint: 'uq_agency_agent_live_tenant',
    });
    await expect(insertSession(campaign.id, { agent_user_id: agent, tenant_id: randomUUID() })).resolves.toBeTruthy();
    await pool().query('UPDATE agency_agent_sessions SET left_at = now() WHERE id = $1', [first.id]);
    await expect(insertSession(other.id, { agent_user_id: agent, account_id: otherAccount })).resolves.toBeTruthy();
  });

  it('uq_agency_attempt_number — (contact_id, attempt_number)', async () => {
    const campaign = await insertCampaign();
    const contact = await insertContact(campaign.id);
    await insertAttempt(campaign.id, contact.id, { attempt_number: 1, state: 'ended' });
    await expect(insertAttempt(campaign.id, contact.id, { attempt_number: 1, state: 'ended' })).rejects.toMatchObject({
      code: '23505', constraint: 'uq_agency_attempt_number',
    });
  });

  // core:test/integration/agency/agency-duplicate-dial.test.ts T-D1/T-D2/T-D3
  it('uq_agency_attempt_live — every live-state pairing is rejected; an ended attempt frees the contact', async () => {
    const LIVE = ['queued', 'dialing', 'ringing', 'answered', 'bridged'];
    const campaign = await insertCampaign();
    for (const first of LIVE) {
      for (const second of LIVE) {
        const contact = await insertContact(campaign.id);
        await insertAttempt(campaign.id, contact.id, { state: first, attempt_number: 1 });
        await expect(
          insertAttempt(campaign.id, contact.id, { state: second, attempt_number: 2 }),
        ).rejects.toMatchObject({ code: '23505', constraint: 'uq_agency_attempt_live' });
      }
    }
    const contact = await insertContact(campaign.id);
    await insertAttempt(campaign.id, contact.id, { state: 'ended', attempt_number: 1 });
    await expect(insertAttempt(campaign.id, contact.id, { state: 'queued', attempt_number: 2 })).resolves.toBeTruthy();
  });

  it('uq_agency_contacts_row_fingerprint — per campaign, NULLs never conflict', async () => {
    const campaign = await insertCampaign();
    await insertContact(campaign.id, { row_fingerprint: 'a'.repeat(32) });
    await expect(insertContact(campaign.id, { row_fingerprint: 'a'.repeat(32) })).rejects.toMatchObject({
      code: '23505', constraint: 'uq_agency_contacts_row_fingerprint',
    });
    const other = await insertCampaign({ account_id: randomUUID() });
    await expect(insertContact(other.id, { row_fingerprint: 'a'.repeat(32) })).resolves.toBeTruthy();
    await insertContact(campaign.id);
    await expect(insertContact(campaign.id)).resolves.toBeTruthy();
  });

  // core:test/integration/agency/agency-migration.test.ts T-M4b
  it('uq_agency_ingest_chunk — a real UNIQUE on (campaign_id, idempotency_key)', async () => {
    const campaign = await insertCampaign();
    const insert = (index: number) => pool().query(
      `INSERT INTO agency_ingest_chunks (campaign_id, ingest_job_id, chunk_index, idempotency_key, row_count)
       VALUES ($1, 'job-1', $2, $3, 500)`,
      [campaign.id, index, `job-1-${index}`],
    );
    await insert(0);
    await expect(insert(0)).rejects.toMatchObject({ code: '23505', constraint: 'uq_agency_ingest_chunk' });
    await expect(insert(1)).resolves.toBeTruthy();
  });
});

describe('other uniqueness rules', () => {
  beforeEach(() => truncateAll());

  it('uq_agency_contacts_source_row (legacy, still enforced while the column exists)', async () => {
    const campaign = await insertCampaign();
    await insertContact(campaign.id, { source_row_number: 2 });
    await expect(insertContact(campaign.id, { source_row_number: 2 })).rejects.toMatchObject({
      code: '23505', constraint: 'uq_agency_contacts_source_row',
    });
  });

  it('uq_agency_campaign_retry_idempotency', async () => {
    await insertCampaign({ retry_idempotency_key: 'k1' });
    await expect(insertCampaign({ retry_idempotency_key: 'k1' })).rejects.toMatchObject({
      code: '23505', constraint: 'uq_agency_campaign_retry_idempotency',
    });
    await expect(insertCampaign({ retry_idempotency_key: null })).resolves.toBeTruthy();
    await expect(insertCampaign({ retry_idempotency_key: null })).resolves.toBeTruthy();
  });

  // master:test/integration/repositories/agency-campaign-agents-schema.test.ts
  it('uq_agency_campaign_agent_active_campaign — per (tenant, user, campaign), closed rows accumulate', async () => {
    const tenant = await insertTenant();
    const user = await insertUser();
    const campaignA = randomUUID();
    const row = await insertRow('agency_campaign_agents', { tenant_id: tenant.id, user_id: user.id, campaign_id: campaignA });
    await expect(insertRow('agency_campaign_agents', { tenant_id: tenant.id, user_id: user.id, campaign_id: campaignA }))
      .rejects.toMatchObject({ code: '23505', constraint: 'uq_agency_campaign_agent_active_campaign' });
    await expect(insertRow('agency_campaign_agents', { tenant_id: tenant.id, user_id: user.id, campaign_id: randomUUID() }))
      .resolves.toBeTruthy();
    await pool().query('UPDATE agency_campaign_agents SET unassigned_at = now() WHERE id = $1', [row.id]);
    await expect(insertRow('agency_campaign_agents', { tenant_id: tenant.id, user_id: user.id, campaign_id: campaignA }))
      .resolves.toBeTruthy();
  });

  it('uq_dnc_scope — the COALESCE sentinel makes tenant-wide duplicates collide', async () => {
    const tenant = await insertTenant();
    const entry = { tenant_id: tenant.id, phone_e164: '+14155550101', source: 'agent' };
    await insertRow('dnc_entries', entry);
    await expect(insertRow('dnc_entries', entry)).rejects.toMatchObject({ code: '23505', constraint: 'uq_dnc_scope' });
    await expect(insertRow('dnc_entries', { ...entry, campaign_id: randomUUID() })).resolves.toBeTruthy();
    await expect(insertRow('dnc_entries', { ...entry, source: 'robocall' })).rejects.toMatchObject({ code: '23514' });
  });

  it('uq_membership_invites_live and membership_invites_token_hash_key', async () => {
    const tenant = await insertTenant();
    const user = await insertUser();
    const membership = await insertMembership(user.id, tenant.id, { role: 'agent' });
    const invite = (hash: string) => insertRow('membership_invites', {
      membership_id: membership.id, tenant_id: tenant.id, email: 'a@example.test', role: 'agent',
      token_hash: hash, expires_at: new Date(Date.now() + 86_400_000),
    });
    const first = await invite('h1');
    await expect(invite('h2')).rejects.toMatchObject({ code: '23505', constraint: 'uq_membership_invites_live' });
    await pool().query('UPDATE membership_invites SET revoked_at = now() WHERE id = $1', [first.id]);
    await expect(invite('h1')).rejects.toMatchObject({ code: '23505', constraint: 'membership_invites_token_hash_key' });
    await expect(invite('h2')).resolves.toBeTruthy();
  });

  it('users_firebase_uid_key, and an unverified address defaults to false', async () => {
    const user = await insertUser({ firebase_uid: 'pending_x' });
    expect(user.email_unverified).toBe(false);
    await expect(insertUser({ firebase_uid: 'pending_x' })).rejects.toMatchObject({
      code: '23505', constraint: 'users_firebase_uid_key',
    });
  });

  it('idx_accounts_tenant_slug_active — a deleted account frees its slug (master 025)', async () => {
    const tenant = await insertTenant();
    const first = await insertAccount(tenant.id, { slug: 'main' });
    await expect(insertAccount(tenant.id, { slug: 'main' })).rejects.toMatchObject({
      code: '23505', constraint: 'idx_accounts_tenant_slug_active',
    });
    await pool().query("UPDATE accounts SET status = 'deleted' WHERE id = $1", [first.id]);
    await expect(insertAccount(tenant.id, { slug: 'main' })).resolves.toBeTruthy();
  });

  it('memberships: one per (user, tenant, account) and one tenant-level row', async () => {
    const tenant = await insertTenant();
    const user = await insertUser();
    await insertMembership(user.id, tenant.id);
    await expect(insertMembership(user.id, tenant.id)).rejects.toMatchObject({
      code: '23505', constraint: 'idx_memberships_user_tenant_level',
    });
  });

  // core:test/integration/db/dialer-analysis-migration.test.ts
  it('call_analysis_profiles: partial active-name/default uniqueness, name reuse after soft delete', async () => {
    const profile = (o: Record<string, unknown>) => insertRow('call_analysis_profiles', { tenant_id: TENANT, account_id: ACCOUNT, ...o });
    const first = await profile({ name: 'Same', is_default: true });
    await expect(profile({ name: 'Same' })).rejects.toMatchObject({ code: '23505', constraint: 'uq_analysis_profiles_name' });
    await expect(profile({ name: 'Other', is_default: true })).rejects.toMatchObject({ code: '23505', constraint: 'uq_analysis_profiles_default' });
    await pool().query('UPDATE call_analysis_profiles SET is_active = false WHERE id = $1', [first.id]);
    await expect(profile({ name: 'Same' })).resolves.toBeTruthy();
  });

  it('feature_flag_overrides: one override per (flag, scope target), scope columns enforced', async () => {
    const flag = (o: Record<string, unknown>) => insertRow('feature_flag_overrides', { flag_key: 'agency_late_binding', value: 'true', ...o });
    await flag({ scope_type: 'tenant', tenant_id: TENANT });
    await expect(flag({ scope_type: 'tenant', tenant_id: TENANT })).rejects.toMatchObject({ code: '23505', constraint: 'uq_ff_tenant' });
    await flag({ scope_type: 'account', tenant_id: TENANT, account_id: ACCOUNT });
    await expect(flag({ scope_type: 'account', tenant_id: TENANT, account_id: ACCOUNT })).rejects.toMatchObject({ code: '23505', constraint: 'uq_ff_account' });
    await expect(flag({ scope_type: 'global', tenant_id: TENANT })).rejects.toMatchObject({ code: '23514', constraint: 'ck_ff_scope_cols' });
  });
});

describe('checks, cascades and foreign keys', () => {
  beforeEach(() => truncateAll());

  // core:test/integration/agency/agency-migration.test.ts T-M2..T-M2e
  it('state machines accept every legal value and reject anything else', async () => {
    const statuses = ['draft', 'running', 'paused', 'stopping', 'completed', 'stopped'];
    for (const status of statuses) await insertCampaign({ status, account_id: randomUUID() });
    await expect(insertCampaign({ status: 'bogus' })).rejects.toMatchObject({ code: '23514' });

    const campaign = await insertCampaign();
    for (const state of ['pending', 'in_flight', 'connected', 'completed', 'exhausted', 'suppressed']) {
      await insertContact(campaign.id, { state });
    }
    await expect(insertContact(campaign.id, { state: 'bogus' })).rejects.toMatchObject({ code: '23514' });

    for (const state of ['offline', 'available', 'reserved', 'on_call', 'wrapup', 'break']) {
      await insertSession(campaign.id, { state });
    }
    await expect(insertSession(campaign.id, { state: 'bogus' })).rejects.toMatchObject({ code: '23514' });

    for (const state of ['queued', 'dialing', 'ringing', 'answered', 'bridged', 'ended']) {
      const contact = await insertContact(campaign.id);
      await insertAttempt(campaign.id, contact.id, { state });
    }
    const contact = await insertContact(campaign.id);
    await expect(insertAttempt(campaign.id, contact.id, { state: 'bogus' })).rejects.toMatchObject({ code: '23514' });
    await expect(insertAttempt(campaign.id, contact.id, { wrapup_resolution: 'bogus' })).rejects.toMatchObject({
      code: '23514', constraint: 'ck_agency_wrapup_resolution',
    });
  });

  it('JSONB shape guards and the campaign range checks guard', async () => {
    const campaign = await insertCampaign();
    await expect(insertContact(campaign.id, { context: JSON.stringify(['not', 'an', 'object']) })).rejects.toMatchObject({ code: '23514' });
    await expect(insertCampaign({ disposition_catalog: JSON.stringify({ not: 'an array' }) })).rejects.toMatchObject({ code: '23514' });
    await expect(insertCampaign({ retry_policy: JSON.stringify([]) })).rejects.toMatchObject({ code: '23514' });
    await expect(insertCampaign({ context_display: JSON.stringify([]) })).rejects.toMatchObject({ code: '23514' });
    await expect(insertCampaign({ break_reasons: JSON.stringify({}) })).rejects.toMatchObject({
      code: '23514', constraint: 'ck_agency_campaign_break_reasons',
    });
    await expect(insertCampaign({ abandonment_ceiling_pct: 0 })).rejects.toMatchObject({
      code: '23514', constraint: 'ck_agency_campaign_abandonment_ceiling',
    });
    await expect(insertCampaign({ pause_reason: 'lunch' })).rejects.toMatchObject({
      code: '23514', constraint: 'ck_agency_campaign_pause_reason',
    });
  });

  // core:test/integration/agency/agency-migration.test.ts T-M3/T-M3b/T-M3c
  it('deleting a campaign removes its whole execution subtree; attempts need a real session', async () => {
    const campaign = await insertCampaign();
    const contact = await insertContact(campaign.id);
    const session = await insertSession(campaign.id);
    await insertAttempt(campaign.id, contact.id, { reserved_agent_id: session.id });
    await insertRow('agency_agent_session_events', {
      session_id: session.id, tenant_id: TENANT, account_id: ACCOUNT, campaign_id: campaign.id,
      agent_user_id: session.agent_user_id, to_state: 'break',
    });
    await pool().query(
      `INSERT INTO agency_ingest_chunks (campaign_id, ingest_job_id, chunk_index, idempotency_key) VALUES ($1, 'j', 0, 'j-0')`,
      [campaign.id],
    );
    await pool().query('DELETE FROM agency_campaigns WHERE id = $1', [campaign.id]);
    for (const table of ['agency_contacts', 'agency_agent_sessions', 'agency_call_attempts', 'agency_ingest_chunks', 'agency_agent_session_events']) {
      const { rows } = await pool().query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table} WHERE campaign_id = $1`, [campaign.id]);
      expect(rows[0]!.n, `${table} did not cascade`).toBe(0);
    }
    const c2 = await insertCampaign();
    const k2 = await insertContact(c2.id);
    await expect(insertAttempt(c2.id, k2.id, { reserved_agent_id: randomUUID() })).rejects.toMatchObject({ code: '23503' });
  });

  it('the attempt spine and the call correlation ids carry NO foreign keys (core 075/076)', async () => {
    const campaign = await insertCampaign();
    const contact = await insertContact(campaign.id);
    // A dangling media-leg id is legal on the attempt...
    await expect(insertAttempt(campaign.id, contact.id, { webrtc_call_id: randomUUID() })).resolves.toBeTruthy();
    // ...and dangling campaign / attempt ids are legal on the call.
    await expect(insertCall({ campaign_id: randomUUID(), agency_attempt_id: randomUUID() })).resolves.toBeTruthy();
  });

  // core:test/integration/db/dialer-analysis-migration.test.ts (re-keyed onto agency_calls)
  it('dialer_analysis_jobs: one job per call, status checks, cascade from agency_calls', async () => {
    const call = await insertCall();
    const job = () => insertRow('dialer_analysis_jobs', { call_id: call.id, tenant_id: TENANT, account_id: ACCOUNT });
    await expect(insertRow('dialer_analysis_jobs', { call_id: call.id, tenant_id: TENANT, account_id: ACCOUNT, status: 'bogus' }))
      .rejects.toMatchObject({ code: '23514' });
    await expect(pool().query(`UPDATE agency_calls SET analysis_status = 'bogus' WHERE id = $1`, [call.id]))
      .rejects.toMatchObject({ code: '23514', constraint: 'ck_webrtc_analysis_status' });
    await job();
    await expect(job()).rejects.toMatchObject({ code: '23505', constraint: 'uq_dialer_analysis_jobs_call' });
    await expect(insertRow('dialer_analysis_jobs', { call_id: randomUUID(), tenant_id: TENANT, account_id: ACCOUNT }))
      .rejects.toMatchObject({ code: '23503' });
    await pool().query('DELETE FROM agency_calls WHERE id = $1', [call.id]);
    const { rows } = await pool().query('SELECT 1 FROM dialer_analysis_jobs WHERE call_id = $1', [call.id]);
    expect(rows).toEqual([]);
  });

  it('account_settings: webrtc_max_duration_seconds is nullable and must be > 0', async () => {
    const settings = (o: Record<string, unknown>) => insertRow('account_settings', { tenant_id: randomUUID(), account_id: ACCOUNT, ...o });
    const row = await settings({});
    expect(row.webrtc_max_duration_seconds).toBeNull();
    expect(row.max_concurrent_calls).toBe(5);
    expect(row.concurrency_allocation_mode).toBe('legacy_total');
    await expect(settings({ webrtc_max_duration_seconds: 3600 })).resolves.toBeTruthy();
    await expect(settings({ webrtc_max_duration_seconds: 0 })).rejects.toMatchObject({
      code: '23514', constraint: 'chk_account_settings_webrtc_max_duration_seconds',
    });
    await expect(settings({ concurrency_allocation_mode: 'bogus' })).rejects.toMatchObject({
      code: '23514', constraint: 'chk_account_settings_concurrency_allocation_mode',
    });
  });

  it('provider allocations need a settings row (RESTRICT) and a lower-case provider', async () => {
    const tenant = randomUUID();
    await expect(insertRow('account_provider_concurrency_allocations', {
      tenant_id: tenant, account_id: ACCOUNT, telephony_provider: 'voicelink', max_concurrent_calls: 3,
    })).rejects.toMatchObject({ code: '23503', constraint: 'fk_account_provider_concurrency_settings' });
    await insertRow('account_settings', { tenant_id: tenant, account_id: ACCOUNT });
    await insertRow('account_provider_concurrency_allocations', {
      tenant_id: tenant, account_id: ACCOUNT, telephony_provider: 'voicelink', max_concurrent_calls: 3,
    });
    await expect(insertRow('account_provider_concurrency_allocations', {
      tenant_id: tenant, account_id: ACCOUNT, telephony_provider: 'VoiceLink', max_concurrent_calls: 3,
    })).rejects.toMatchObject({ code: '23514', constraint: 'chk_account_provider_concurrency_provider' });
    await expect(pool().query('DELETE FROM account_settings WHERE tenant_id = $1', [tenant])).rejects.toMatchObject({ code: '23503' });
  });

  it('clips: audio-only announcements; deleting a file un-links inactive announcements (core 031)', async () => {
    const audio = await insertAudioFile();
    const announce = (o: Record<string, unknown>) => insertRow('announcements', { tenant_id: TENANT, account_id: ACCOUNT, name: `a-${randomUUID()}`, ...o });
    await expect(announce({ type: 'tts' })).rejects.toMatchObject({ code: '23514', constraint: 'announcements_type_check' });
    await expect(announce({ type: 'audio' })).rejects.toMatchObject({ code: '23514', constraint: 'announcements_audio_check' });
    const a = await announce({ type: 'audio', audio_file_id: audio.id, is_active: false });
    await pool().query('DELETE FROM audio_files WHERE id = $1', [audio.id]);
    const { rows } = await pool().query<{ audio_file_id: string | null }>('SELECT audio_file_id FROM announcements WHERE id = $1', [a.id]);
    expect(rows[0]!.audio_file_id).toBeNull();
  });

  it('identity cascades: a deleted tenant takes its accounts, memberships, staffing and DNC with it', async () => {
    const tenant = await insertTenant();
    const account = await insertAccount(tenant.id);
    const user = await insertUser();
    await insertMembership(user.id, tenant.id, { account_id: account.id });
    await insertRow('agency_campaign_agents', { tenant_id: tenant.id, user_id: user.id, campaign_id: randomUUID() });
    await insertRow('dnc_entries', { tenant_id: tenant.id, phone_e164: '+1', source: 'agent' });
    await pool().query('DELETE FROM tenants WHERE id = $1', [tenant.id]);
    for (const table of ['accounts', 'memberships', 'agency_campaign_agents', 'dnc_entries']) {
      const { rows } = await pool().query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table} WHERE tenant_id = $1`, [tenant.id]);
      expect(rows[0]!.n, table).toBe(0);
    }
  });

  it('lead decisions: no dnc_sync_state, no analyze_dialer_calls, VoiceLink defaults (B8, Q3b)', async () => {
    const { rows: t } = await pool().query(`SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'dnc_sync_state'`);
    expect(t).toHaveLength(0);
    const { rows: c } = await pool().query(
      `SELECT 1 FROM information_schema.columns WHERE table_name = 'account_settings' AND column_name = 'analyze_dialer_calls'`);
    expect(c).toHaveLength(0);
    const { rows: d } = await pool().query<{ table_name: string; column_default: string }>(
      `SELECT table_name, column_default FROM information_schema.columns
        WHERE (table_name, column_name) IN (('agency_campaigns', 'telephony_provider'), ('agency_calls', 'provider'))
        ORDER BY table_name`);
    expect(d.map((r) => [r.table_name, r.column_default])).toEqual([
      ['agency_calls', "'voicelink'::character varying"],
      ['agency_campaigns', "'voicelink'::character varying"],
    ]);
  });
});

describe('audit partitions', () => {
  beforeEach(() => truncateAll());

  const MONTHS = Array.from({ length: 24 }, (_, i) => {
    const d = new Date(Date.UTC(2026, i, 1));
    return `${d.getUTCFullYear()}_${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  });

  it.each(['platform_audit_log', 'audit_logs'])('%s has monthly partitions 2026-01..2027-12 plus a DEFAULT', async (parent) => {
    const { rows } = await pool().query<{ relname: string; bound: string }>(
      `SELECT c.relname, pg_get_expr(c.relpartbound, c.oid) AS bound
         FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
        WHERE i.inhparent = $1::regclass`,
      [parent],
    );
    const names = rows.map((r) => r.relname).sort();
    expect(names).toEqual([...MONTHS.map((m) => `${parent}_${m}`), `${parent}_default`].sort());
    expect(rows.find((r) => r.relname === `${parent}_default`)!.bound).toBe('DEFAULT');
    expect(rows.find((r) => r.relname === `${parent}_2026_01`)!.bound).toBe(
      "FOR VALUES FROM ('2026-01-01 00:00:00+00') TO ('2026-02-01 00:00:00+00')",
    );
  });

  it('a platform_audit_log insert lands in its month, and an out-of-range one in DEFAULT', async () => {
    const insert = (createdAt: string) => pool().query<{ part: string }>(
      `INSERT INTO platform_audit_log (tenant_id, action, resource_type, created_at, actor_type)
       VALUES ($1, 'agency_campaign.started', 'agency_campaign', $2, 'human')
       RETURNING tableoid::regclass::text AS part`,
      [TENANT, createdAt],
    );
    expect((await insert('2026-10-08T12:00:00Z')).rows[0]!.part).toBe('platform_audit_log_2026_10');
    expect((await insert('2027-12-31T23:59:59Z')).rows[0]!.part).toBe('platform_audit_log_2027_12');
    expect((await insert('2028-01-01T00:00:00Z')).rows[0]!.part).toBe('platform_audit_log_default');
  });

  it('an audit_logs insert lands in its month, and an out-of-range one in DEFAULT', async () => {
    const insert = (ts: string) => pool().query<{ part: string }>(
      `INSERT INTO audit_logs (tenant_id, account_id, event_type, event_category, event_data, timestamp)
       VALUES ($1, $2, 'agency_campaign.running', 'agency', $3::jsonb, $4)
       RETURNING tableoid::regclass::text AS part`,
      [TENANT, ACCOUNT, JSON.stringify({ campaign_id: randomUUID() }), ts],
    );
    expect((await insert('2026-01-15T00:00:00Z')).rows[0]!.part).toBe('audit_logs_2026_01');
    expect((await insert('2026-10-08T12:00:00Z')).rows[0]!.part).toBe('audit_logs_2026_10');
    expect((await insert('2025-12-31T23:59:59Z')).rows[0]!.part).toBe('audit_logs_default');
  });

  it('the parent indexes exist (core 094 campaign expression index included)', async () => {
    for (const name of [
      'idx_audit_log_tenant_created', 'idx_audit_log_action', 'idx_audit_log_tenant_resource',
      'idx_audit_log_tenant_campaign', 'idx_audit_log_tenant_account',
      'idx_audit_call_id', 'idx_audit_tenant', 'idx_audit_event_type', 'idx_audit_severity', 'idx_audit_logs_campaign_id',
    ]) {
      expect(await indexDef(name), name).toBeDefined();
    }
    expect(await indexDef('idx_audit_logs_campaign_id')).toContain("(event_data ->> 'campaign_id'::text)");
    expect(await indexDef('idx_audit_log_tenant_api_key')).toBeUndefined();
  });
});
