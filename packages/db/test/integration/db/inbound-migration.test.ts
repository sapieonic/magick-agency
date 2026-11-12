// Real Postgres: migrations/0024_inbound.sql and 0025_inbound_checks_validate.sql
// (docs/inbound.md §9). globalSetup has applied every migration. Pins the three new tables
// (columns, defaults, every CHECK from both sides, the route-number uniqueness, the FKs and their
// ON DELETE), the spine's vocabularies against the contract's lists, the agency_calls origin
// rewrite (and that the manual-correlation CHECK still holds for an inbound leg), the contact,
// campaign, credential and number columns, the indexes the reads need and that the planner uses
// them, the NOT VALID → VALIDATE split, the Down's refusals, and down then up.
import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { runner } from 'node-pg-migrate';
import type { PoolClient } from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  AGENCY_CONTACT_CALLBACK_SOURCES,
  AGENCY_INBOUND_CALL_OUTCOMES,
  AGENCY_INBOUND_CALL_STATES,
  AGENCY_INBOUND_FOLLOW_UP_STATUSES,
  AGENCY_INBOUND_MISSED_REASONS,
  AGENCY_INBOUND_ROUTE_DEFAULTS,
  AGENCY_INBOUND_ROUTE_LIMITS,
  AGENCY_INBOUND_STICKY_MODES,
  AGENCY_INBOUND_STICKY_REASONS,
  AGENCY_INBOUND_UNCONNECTED_ACTIONS,
} from '@magick-agency/contracts/agency';
import { MIGRATIONS_DIR } from '../../../src/migrations-dir.js';
import { TEST_DB_URL } from '../../helpers/test-db.js';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import {
  ACCOUNT, TENANT, insertAudioFile, insertCall, insertCampaign, insertContact, insertRow, insertTenant,
} from '../fixtures.js';

const pool = () => getTestPool();

beforeEach(async () => {
  await truncateAll();
  // Routes key their tenant (ON DELETE CASCADE); the fixtures' default tenant must exist.
  await insertTenant({ id: TENANT });
});
// 0024's Down refuses while an inbound call exists: leave none behind for the down → up suite.
afterAll(async () => {
  await truncateAll();
  await closeTestPool();
});

// No migration lock: nothing else migrates this file's own database copy, and after a refused
// Down the runner's unlock fails on its aborted transaction, so the lock lingers until the session
// ends, which a restore right after could race.
const migrate = (direction: 'up' | 'down', count = Infinity) =>
  runner({ databaseUrl: TEST_DB_URL, dir: MIGRATIONS_DIR, direction, migrationsTable: 'pgmigrations', count, log: () => {}, noLock: true });

const FILE = '0024_inbound.sql';
const refused = (constraint: string) => ({ code: '23514', constraint });
const H = 'a'.repeat(64);

async function columns(table: string) {
  const { rows } = await pool().query<{ column_name: string; data_type: string; is_nullable: string }>(
    `SELECT column_name, data_type, is_nullable FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`, [table]);
  return rows.map((r) => `${r.column_name} ${r.data_type}${r.is_nullable === 'NO' ? ' not null' : ''}`);
}

async function indexDef(name: string): Promise<string | undefined> {
  const { rows } = await pool().query<{ indexdef: string }>(
    `SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = $1`, [name]);
  return rows[0]?.indexdef;
}

async function checkDef(name: string): Promise<{ def: string; validated: boolean } | undefined> {
  const { rows } = await pool().query<{ def: string; validated: boolean }>(
    `SELECT pg_get_constraintdef(oid) AS def, convalidated AS validated FROM pg_constraint WHERE conname = $1`, [name]);
  return rows[0];
}

/** The plan with sequential scans priced out, as the other migration suites read it. */
async function planOf(sql: string, params: unknown[] = []): Promise<string> {
  const client: PoolClient = await pool().connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL enable_seqscan = off');
    const { rows } = await client.query<{ 'QUERY PLAN': string }>(`EXPLAIN (COSTS OFF) ${sql}`, params);
    return rows.map((r) => r['QUERY PLAN']).join('\n');
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

/** The values a CHECK's `IN (...)` / `ANY (ARRAY[...])` lists, in order. */
function listedValues(def: string): string[] {
  return [...def.matchAll(/'([a-z_]+)'::(?:character varying|text)/g)].map((m) => m[1]!);
}

async function plivoProvider(): Promise<{ id: string; name: string }> {
  const { rows } = await pool().query<{ id: string; name: string }>(
    `INSERT INTO telephony_providers (name, display_name, status) VALUES ('plivo', 'Plivo', 'active')
     ON CONFLICT (name) DO UPDATE SET status = 'active' RETURNING id, name`);
  return rows[0]!;
}

async function credential(tenantId: string, o: Record<string, unknown> = {}) {
  await plivoProvider();
  return insertRow('telephony_credentials', {
    tenant_id: tenantId, provider: 'plivo', label: `cred-${randomUUID().slice(0, 6)}`,
    account_ref: `MA${randomUUID().replace(/-/g, '').slice(0, 18).toUpperCase()}`, ...o,
  });
}

async function number(o: Record<string, unknown> = {}) {
  const provider = await plivoProvider();
  return insertRow('phone_numbers', {
    phone_number: `+1415555${String(Math.floor(Math.random() * 10_000)).padStart(4, '0')}`, provider_id: provider.id, ...o,
  });
}

const enabled = {
  inbound_app_id: 'app-1', inbound_answer_url: 'https://x/a', inbound_hangup_url: 'https://x/h',
  inbound_fallback_answer_url: 'https://x/f', inbound_token_hash: H, inbound_enabled_at: new Date(),
};

function route(o: Record<string, unknown> = {}) {
  return insertRow('agency_inbound_routes', { tenant_id: TENANT, account_id: ACCOUNT, name: `Route ${randomUUID().slice(0, 6)}`, timezone: 'Europe/London', ...o });
}

function call(o: Record<string, unknown> = {}) {
  return insertRow('agency_inbound_calls', {
    tenant_id: TENANT, account_id: ACCOUNT, provider_call_id: `CA-${randomUUID()}`, to_e164: '+14155550100', ...o,
  });
}

/** An ended call that reached nobody, with its Missed row. */
const missed = (o: Record<string, unknown> = {}) => ({
  state: 'ended', outcome: 'closed', ended_at: new Date(), follow_up_status: 'open', follow_up_reason: 'closed', ...o,
});

describe('0024 — agency_inbound_routes', () => {
  it('the columns, every one defaulted to the contract\'s AGENCY_INBOUND_ROUTE_DEFAULTS', async () => {
    expect(await columns('agency_inbound_routes')).toEqual([
      'id uuid not null', 'tenant_id uuid not null', 'account_id uuid not null', 'name character varying not null',
      'timezone text not null', 'weekly_hours jsonb not null', 'holidays jsonb not null',
      'greeting_audio_id uuid', 'hold_audio_id uuid', 'closed_audio_id uuid', 'busy_audio_id uuid',
      'recording_notice_audio_id uuid', 'callback_audio_id uuid',
      'sticky_mode character varying not null', 'sticky_wait_seconds smallint not null', 'sticky_lookback_days smallint not null',
      'pool_campaign_ids ARRAY not null', 'queue_max_wait_seconds smallint not null', 'max_waiting smallint not null',
      'max_concurrent smallint not null', 'after_hours_action character varying not null', 'overflow_action character varying not null',
      'record_calls boolean not null', 'recording_notice boolean not null', 'analysis_profile_id uuid',
      'disposition_catalog jsonb not null', 'created_by uuid', 'updated_by uuid',
      'created_at timestamp with time zone not null', 'updated_at timestamp with time zone not null',
      'deleted_at timestamp with time zone', 'deleted_by uuid',
      // 0032: the route's wrap-up window, IQ52 (inbound-route-wrapup-migration.test.ts pins it).
      'wrapup_seconds smallint not null',
    ]);
    const d = AGENCY_INBOUND_ROUTE_DEFAULTS;
    expect(await route()).toMatchObject({
      weekly_hours: d.weekly_hours, holidays: d.holidays, sticky_mode: d.sticky_mode,
      sticky_wait_seconds: d.sticky_wait_seconds, sticky_lookback_days: d.sticky_lookback_days,
      pool_campaign_ids: d.pool_campaign_ids, queue_max_wait_seconds: d.queue_max_wait_seconds,
      max_waiting: d.max_waiting, max_concurrent: d.max_concurrent, after_hours_action: d.after_hours_action,
      overflow_action: d.overflow_action, record_calls: d.record_calls, recording_notice: d.recording_notice,
      analysis_profile_id: null, disposition_catalog: [], greeting_audio_id: null, deleted_at: null,
      wrapup_seconds: d.wrapup_seconds,
    });
  });

  it('the vocabularies are the contract\'s lists', async () => {
    expect(listedValues((await checkDef('ck_agency_inbound_routes_sticky_mode'))!.def)).toEqual([...AGENCY_INBOUND_STICKY_MODES]);
    const actions = listedValues((await checkDef('ck_agency_inbound_routes_actions'))!.def);
    expect(actions).toEqual([...AGENCY_INBOUND_UNCONNECTED_ACTIONS, ...AGENCY_INBOUND_UNCONNECTED_ACTIONS]);
  });

  it('every bound of AGENCY_INBOUND_ROUTE_LIMITS, from both sides', async () => {
    const L = AGENCY_INBOUND_ROUTE_LIMITS;
    await route({ name: 'x'.repeat(L.NAME_MAX) });
    await expect(route({ name: 'x'.repeat(L.NAME_MAX + 1) })).rejects.toMatchObject({ code: '22001' });
    await expect(route({ name: ' padded' })).rejects.toMatchObject(refused('ck_agency_inbound_routes_name'));
    await expect(route({ name: '' })).rejects.toMatchObject(refused('ck_agency_inbound_routes_name'));
    await expect(route({ timezone: ' UTC' })).rejects.toMatchObject(refused('ck_agency_inbound_routes_timezone'));
    await route({ sticky_wait_seconds: L.STICKY_WAIT_SECONDS.min, sticky_lookback_days: L.STICKY_LOOKBACK_DAYS.max });
    for (const bad of [
      { sticky_wait_seconds: L.STICKY_WAIT_SECONDS.min - 1 },
      { sticky_wait_seconds: L.STICKY_WAIT_SECONDS.max + 1, queue_max_wait_seconds: L.QUEUE_MAX_WAIT_SECONDS.max },
      { sticky_lookback_days: L.STICKY_LOOKBACK_DAYS.min - 1 },
      { sticky_lookback_days: L.STICKY_LOOKBACK_DAYS.max + 1 },
      // The sticky wait never outlasts the queue's own maximum.
      { sticky_wait_seconds: 60, queue_max_wait_seconds: 59 },
    ]) await expect(route(bad), JSON.stringify(bad)).rejects.toMatchObject(refused('ck_agency_inbound_routes_sticky'));
    await route({ queue_max_wait_seconds: L.QUEUE_MAX_WAIT_SECONDS.max, max_waiting: L.MAX_WAITING.max, max_concurrent: L.MAX_CONCURRENT.max });
    await route({ max_waiting: L.MAX_WAITING.min, max_concurrent: L.MAX_CONCURRENT.min });
    for (const bad of [
      { queue_max_wait_seconds: L.QUEUE_MAX_WAIT_SECONDS.min - 1, sticky_wait_seconds: 5 },
      { queue_max_wait_seconds: L.QUEUE_MAX_WAIT_SECONDS.max + 1 },
      { max_waiting: L.MAX_WAITING.min - 1 },
      { max_waiting: L.MAX_WAITING.max + 1, max_concurrent: L.MAX_CONCURRENT.max },
      { max_concurrent: L.MAX_CONCURRENT.min - 1, max_waiting: 0 },
      { max_concurrent: L.MAX_CONCURRENT.max + 1 },
      // Waiting callers count in max_concurrent (IB5).
      { max_waiting: 11, max_concurrent: 10 },
    ]) await expect(route(bad), JSON.stringify(bad)).rejects.toMatchObject(refused('ck_agency_inbound_routes_queue'));
    await expect(route({ weekly_hours: JSON.stringify({}) })).rejects.toMatchObject(refused('ck_agency_inbound_routes_hours'));
    await route({ weekly_hours: JSON.stringify(Array.from({ length: L.WEEKLY_HOURS_MAX }, () => ({}))) });
    await expect(route({ weekly_hours: JSON.stringify(Array.from({ length: L.WEEKLY_HOURS_MAX + 1 }, () => ({}))) }))
      .rejects.toMatchObject(refused('ck_agency_inbound_routes_hours'));
    await route({ holidays: JSON.stringify(Array.from({ length: L.HOLIDAYS_MAX }, () => ({}))) });
    await expect(route({ holidays: JSON.stringify(Array.from({ length: L.HOLIDAYS_MAX + 1 }, () => ({}))) }))
      .rejects.toMatchObject(refused('ck_agency_inbound_routes_holidays'));
    await expect(route({ pool_campaign_ids: Array.from({ length: L.POOL_CAMPAIGNS_MAX + 1 }, () => randomUUID()) }))
      .rejects.toMatchObject(refused('ck_agency_inbound_routes_pool'));
    await expect(route({ sticky_mode: 'sticky' })).rejects.toMatchObject(refused('ck_agency_inbound_routes_sticky_mode'));
    await expect(route({ overflow_action: 'hangup' })).rejects.toMatchObject(refused('ck_agency_inbound_routes_actions'));
    await expect(route({ disposition_catalog: JSON.stringify({}) })).rejects.toMatchObject(refused('ck_agency_inbound_routes_dispositions'));
    await expect(route({ deleted_by: randomUUID() })).rejects.toMatchObject(refused('ck_agency_inbound_routes_deleted'));
  });

  it('one live route per name in an account (case-insensitive); deleting one frees its name', async () => {
    const first = await route({ name: 'Main line' });
    await expect(route({ name: 'MAIN LINE' })).rejects.toMatchObject({ code: '23505', constraint: 'uq_agency_inbound_routes_name' });
    await route({ name: 'Main line', account_id: randomUUID() }); // another account
    await pool().query('UPDATE agency_inbound_routes SET deleted_at = now() WHERE id = $1', [first.id]);
    await route({ name: 'Main line' });
  });

  it('a deleted clip puts its slot back on the built-in clip (ON DELETE SET NULL); a tenant delete cascades', async () => {
    const tenant = await insertTenant();
    const clip = await insertAudioFile();
    const r = await route({ tenant_id: tenant.id, greeting_audio_id: clip.id, closed_audio_id: clip.id });
    await pool().query('DELETE FROM audio_files WHERE id = $1', [clip.id]);
    const { rows } = await pool().query('SELECT greeting_audio_id, closed_audio_id FROM agency_inbound_routes WHERE id = $1', [r.id]);
    expect(rows[0]).toEqual({ greeting_audio_id: null, closed_audio_id: null });
    await pool().query('DELETE FROM tenants WHERE id = $1', [tenant.id]);
    expect((await pool().query('SELECT 1 FROM agency_inbound_routes WHERE id = $1', [r.id])).rowCount).toBe(0);
  });
});

describe('0024 — agency_inbound_route_numbers', () => {
  it('one ACTIVE route per number; detached rows are kept with their reason', async () => {
    const n = await number();
    const a = await route();
    const b = await route();
    const link = await insertRow('agency_inbound_route_numbers', { route_id: a.id, phone_number_id: n.id });
    await expect(insertRow('agency_inbound_route_numbers', { route_id: b.id, phone_number_id: n.id }))
      .rejects.toMatchObject({ code: '23505', constraint: 'uq_agency_inbound_route_numbers_active' });
    await pool().query(`UPDATE agency_inbound_route_numbers SET detached_at = now(), detached_reason = 'detached' WHERE id = $1`, [link.id]);
    await insertRow('agency_inbound_route_numbers', { route_id: b.id, phone_number_id: n.id });
    expect((await pool().query('SELECT 1 FROM agency_inbound_route_numbers WHERE phone_number_id = $1', [n.id])).rowCount).toBe(2);
  });

  it('a detachment has its time and reason together, a known reason, and a detacher only once detached', async () => {
    const n = await number();
    const r = await route();
    for (const reason of ['detached', 'route_deleted', 'number_unlinked']) {
      await insertRow('agency_inbound_route_numbers', { route_id: r.id, phone_number_id: n.id, detached_at: new Date(), detached_reason: reason });
    }
    for (const bad of [
      { detached_at: new Date() },
      { detached_reason: 'detached' },
      { detached_at: new Date(), detached_reason: 'gone' },
      { detached_by: randomUUID() },
    ]) {
      await expect(insertRow('agency_inbound_route_numbers', { route_id: r.id, phone_number_id: n.id, ...bad }))
        .rejects.toMatchObject(refused('ck_agency_inbound_route_numbers_detached'));
    }
  });

  it('a route delete cascades to its numbers; a routed number cannot be hard-deleted (RESTRICT)', async () => {
    const n = await number();
    const r = await route();
    await insertRow('agency_inbound_route_numbers', { route_id: r.id, phone_number_id: n.id });
    await expect(pool().query('DELETE FROM phone_numbers WHERE id = $1', [n.id])).rejects.toMatchObject({ code: '23503' });
    await pool().query('DELETE FROM agency_inbound_routes WHERE id = $1', [r.id]);
    expect((await pool().query('SELECT 1 FROM agency_inbound_route_numbers')).rowCount).toBe(0);
  });
});

describe('0024 — agency_inbound_calls (the spine)', () => {
  it('the columns', async () => {
    expect(await columns('agency_inbound_calls')).toEqual([
      'id uuid not null', 'tenant_id uuid not null', 'account_id uuid', 'route_id uuid', 'phone_number_id uuid',
      'provider character varying not null', 'telephony_credential_id uuid', 'provider_call_id character varying not null',
      'from_e164 character varying', 'to_e164 character varying not null', 'matched_contact_id uuid',
      'matched_campaign_id uuid', 'caller_dnc boolean not null', 'sticky_user_id uuid', 'sticky_reason character varying',
      'state character varying not null', 'outcome character varying', 'arrived_at timestamp with time zone not null',
      'answered_at timestamp with time zone', 'bridged_at timestamp with time zone', 'answered_by_user_id uuid',
      'ended_at timestamp with time zone', 'talk_seconds integer', 'webrtc_call_id uuid', 'voicemail_key text',
      'callback_due_at timestamp with time zone', 'follow_up_status character varying', 'follow_up_reason character varying',
      'follow_up_assignee_user_id uuid', 'handled_by_user_id uuid', 'handled_at timestamp with time zone',
      'created_at timestamp with time zone not null', 'updated_at timestamp with time zone not null',
      // 0027 (inbound P2): the agent side (inbound-connect-migration.test.ts pins them).
      'session_id uuid', 'queued_at timestamp with time zone', 'offered_at timestamp with time zone',
      'offer_count smallint not null', 'recording_requested boolean not null', 'disposition_code character varying',
      'disposition_source character varying', 'notes text', 'callback_at timestamp with time zone',
      'dispositioned_by_user_id uuid', 'dispositioned_at timestamp with time zone', 'dispositioned_on_behalf boolean not null',
      'settled_at timestamp with time zone', 'voicemail_seconds integer', 'clash_attempt_id uuid',
      // 0028: how a Missed row was handled (inbound-missed-follow-up-migration.test.ts pins it).
      'handled_reason character varying',
      // 0029: the carrier's duration (inbound-reach-settles-migration.test.ts pins it).
      'carrier_seconds integer',
      // 0030: why a call was answered closed (inbound-reached-on-outcome-migration.test.ts pins it).
      'closed_cause character varying',
      // 0032: the route's wrap-up window, captured at arrival (inbound-route-wrapup-migration.test.ts).
      'wrapup_seconds smallint',
      // 0036 (Mode B): the ring (inbound-ring-migration.test.ts pins them).
      'offer_channel character varying', 'ringing_at timestamp with time zone', 'accepted_at timestamp with time zone',
      'ring_result character varying', 'ring_count smallint not null',
    ]);
    expect(await call()).toMatchObject({ state: 'arrived', provider: 'plivo', caller_dnc: false, outcome: null, follow_up_status: null });
  });

  it('every vocabulary CHECK is the contract\'s list, in order', async () => {
    expect(listedValues((await checkDef('ck_agency_inbound_calls_state'))!.def)).toEqual([...AGENCY_INBOUND_CALL_STATES]);
    expect(listedValues((await checkDef('ck_agency_inbound_calls_outcome'))!.def)).toEqual([...AGENCY_INBOUND_CALL_OUTCOMES]);
    expect(listedValues((await checkDef('ck_agency_inbound_calls_sticky'))!.def)).toEqual([...AGENCY_INBOUND_STICKY_REASONS]);
    const followUp = listedValues((await checkDef('ck_agency_inbound_calls_follow_up'))!.def);
    // statuses, then reasons, then the two outcomes that owe no follow-up, then 'handled'.
    expect(followUp.slice(0, 2)).toEqual([...AGENCY_INBOUND_FOLLOW_UP_STATUSES]);
    expect(followUp.slice(2, 2 + AGENCY_INBOUND_MISSED_REASONS.length)).toEqual([...AGENCY_INBOUND_MISSED_REASONS]);
    expect(listedValues((await checkDef('ck_agency_contact_callback_source'))!.def)).toEqual([...AGENCY_CONTACT_CALLBACK_SOURCES]);
  });

  it('one row per provider call: a retried answer webhook cannot write a second', async () => {
    await call({ provider_call_id: 'CA-1' });
    await expect(call({ provider_call_id: 'CA-1' })).rejects.toMatchObject({ code: '23505', constraint: 'uq_agency_inbound_calls_provider_call' });
    await call({ provider_call_id: 'CA-1', provider: 'voicelink' });
    await expect(call({ provider_call_id: ' CA-2' })).rejects.toMatchObject(refused('ck_agency_inbound_calls_provider_call_id'));
  });

  it('numbers are E.164; a withheld caller is NULL', async () => {
    await call({ from_e164: null });
    await call({ from_e164: '+919876543210' });
    for (const bad of [{ to_e164: '14155550100' }, { from_e164: 'anonymous' }, { from_e164: '' }, { to_e164: '+0123' }]) {
      await expect(call(bad), JSON.stringify(bad)).rejects.toMatchObject(refused('ck_agency_inbound_calls_numbers'));
    }
  });

  it('a route, a match and a media leg belong to an account; a callback only on a matched contact', async () => {
    await call({ account_id: null }); // the tenant default
    for (const bad of [{ route_id: randomUUID() }, { matched_contact_id: randomUUID(), matched_campaign_id: randomUUID() }, { webrtc_call_id: randomUUID() }]) {
      await expect(call({ account_id: null, ...bad })).rejects.toMatchObject(refused('ck_agency_inbound_calls_account'));
    }
    await expect(call({ matched_contact_id: randomUUID() })).rejects.toMatchObject(refused('ck_agency_inbound_calls_match'));
    await expect(call({ callback_due_at: new Date() })).rejects.toMatchObject(refused('ck_agency_inbound_calls_match'));
    await call({ matched_contact_id: randomUUID(), matched_campaign_id: randomUUID(), callback_due_at: new Date() });
  });

  it('ended exactly with an outcome and an end time', async () => {
    await call({ state: 'ended', outcome: 'rejected', ended_at: new Date() });
    for (const bad of [
      { state: 'ended', ended_at: new Date() },
      { state: 'ended', outcome: 'closed' },
      { outcome: 'closed', ended_at: new Date() },
      { state: 'greeting', ended_at: new Date() },
    ]) await expect(call(bad), JSON.stringify(bad)).rejects.toMatchObject(refused('ck_agency_inbound_calls_ended'));
  });

  it('bridged exactly with its agent; connected and answered only once bridged', async () => {
    const agent = randomUUID();
    // 0027: a connected call is with a session.
    await call({ state: 'connected', bridged_at: new Date(), answered_by_user_id: agent, session_id: randomUUID(), offered_at: new Date(), offer_count: 1 });
    await call({ state: 'ended', outcome: 'answered', ended_at: new Date(), bridged_at: new Date(), answered_by_user_id: agent, talk_seconds: 0 });
    for (const bad of [
      { bridged_at: new Date() },
      { answered_by_user_id: agent },
      { state: 'connected' },
      { state: 'ended', outcome: 'answered', ended_at: new Date() },
    ]) await expect(call(bad), JSON.stringify(bad)).rejects.toMatchObject(refused('ck_agency_inbound_calls_bridged'));
    await expect(call({ talk_seconds: -1 })).rejects.toMatchObject(refused('ck_agency_inbound_calls_talk_seconds'));
  });

  it('sticky agent and reason together, a known reason', async () => {
    await call({ sticky_user_id: randomUUID(), sticky_reason: 'owner' });
    for (const bad of [{ sticky_user_id: randomUUID() }, { sticky_reason: 'owner' }, { sticky_user_id: randomUUID(), sticky_reason: 'favourite' }]) {
      await expect(call(bad), JSON.stringify(bad)).rejects.toMatchObject(refused('ck_agency_inbound_calls_sticky'));
    }
  });

  it('the Missed row: only on an ended call that reached nobody, status and reason together, handled exactly with its time', async () => {
    const user = randomUUID();
    await call(missed({ follow_up_assignee_user_id: user }));
    await call(missed({ follow_up_status: 'handled', handled_at: new Date(), handled_by_user_id: user }));
    // The system may close a row with no person named (handled_by NULL).
    await call(missed({ follow_up_status: 'handled', handled_at: new Date() }));
    for (const reason of AGENCY_INBOUND_MISSED_REASONS) await call(missed({ follow_up_reason: reason }));
    for (const bad of [
      missed({ follow_up_reason: null }),
      missed({ follow_up_status: null }),
      missed({ follow_up_status: 'snoozed' }),
      missed({ follow_up_reason: 'answered' }),
      // Not ended yet.
      { follow_up_status: 'open', follow_up_reason: 'closed' },
      // Answered, or refused at the answer: nothing is owed.
      missed({ outcome: 'rejected' }),
      missed({ outcome: 'answered', bridged_at: new Date(), answered_by_user_id: user }),
      // An assignee only on a Missed row.
      { follow_up_assignee_user_id: user },
      missed({ follow_up_status: 'handled' }),
      missed({ handled_at: new Date() }),
      missed({ handled_by_user_id: user }),
    ]) await expect(call(bad), JSON.stringify(bad)).rejects.toMatchObject(refused('ck_agency_inbound_calls_follow_up'));
  });

  it('the credential FK is composite: another tenant\'s credential is refused, and a pinned credential cannot be deleted', async () => {
    const tenant = await insertTenant();
    const mine = await credential(tenant.id);
    const theirs = await credential((await insertTenant()).id);
    await call({ tenant_id: tenant.id, telephony_credential_id: mine.id });
    await expect(call({ tenant_id: tenant.id, telephony_credential_id: theirs.id }))
      .rejects.toMatchObject({ code: '23503', constraint: 'fk_agency_inbound_calls_telephony_credential' });
    await expect(pool().query('DELETE FROM telephony_credentials WHERE id = $1', [mine.id])).rejects.toMatchObject({ code: '23503' });
  });

  it('the indexes the reads need, as defined, and the planner uses them', async () => {
    expect(await indexDef('uq_agency_inbound_calls_provider_call')).toBe(
      'CREATE UNIQUE INDEX uq_agency_inbound_calls_provider_call ON public.agency_inbound_calls USING btree (provider, provider_call_id)');
    expect(await indexDef('idx_agency_inbound_calls_missed')).toBe(
      'CREATE INDEX idx_agency_inbound_calls_missed ON public.agency_inbound_calls USING btree (tenant_id, account_id, follow_up_status, arrived_at DESC, id DESC) WHERE (follow_up_status IS NOT NULL)');
    expect(await indexDef('idx_agency_inbound_calls_missed_assignee')).toBe(
      'CREATE INDEX idx_agency_inbound_calls_missed_assignee ON public.agency_inbound_calls USING btree (tenant_id, account_id, follow_up_assignee_user_id, follow_up_status, arrived_at DESC, id DESC) WHERE (follow_up_status IS NOT NULL)');
    expect(await indexDef('idx_agency_inbound_calls_open')).toBe(
      "CREATE INDEX idx_agency_inbound_calls_open ON public.agency_inbound_calls USING btree (arrived_at) WHERE ((state)::text <> 'ended'::text)");
    expect(await indexDef('uq_agency_inbound_route_numbers_active')).toBe(
      'CREATE UNIQUE INDEX uq_agency_inbound_route_numbers_active ON public.agency_inbound_route_numbers USING btree (phone_number_id) WHERE (detached_at IS NULL)');
    expect(await indexDef('idx_phone_numbers_inbound_linked')).toBe(
      'CREATE INDEX idx_phone_numbers_inbound_linked ON public.phone_numbers USING btree (telephony_credential_id) WHERE (inbound_linked_at IS NOT NULL)');
    // No new agency_calls index: the baseline's serves the status webhook's CallUUID lookup.
    expect(await indexDef('idx_agency_calls_provider_call_id')).toMatch(/\(provider_call_id\) WHERE \(provider_call_id IS NOT NULL\)/);

    const account = `'${ACCOUNT}'::uuid`;
    expect(await planOf(
      `SELECT id FROM agency_inbound_calls
        WHERE tenant_id = '${TENANT}'::uuid AND account_id = ${account} AND follow_up_status = 'open'
        ORDER BY arrived_at DESC, id DESC LIMIT 51`)).toContain('idx_agency_inbound_calls_missed');
    expect(await planOf(
      `SELECT id FROM agency_inbound_calls
        WHERE tenant_id = '${TENANT}'::uuid AND account_id = ${account} AND follow_up_assignee_user_id = '${randomUUID()}'::uuid
          AND follow_up_status = 'open'
        ORDER BY arrived_at DESC, id DESC LIMIT 51`)).toContain('idx_agency_inbound_calls_missed_assignee');
    expect(await planOf(
      `SELECT id FROM agency_inbound_calls WHERE state <> 'ended' AND arrived_at < now() ORDER BY arrived_at LIMIT 100`,
    )).toContain('idx_agency_inbound_calls_open');
    expect(await planOf(
      `SELECT id FROM agency_inbound_calls WHERE provider = 'plivo' AND provider_call_id = 'CA-1'`,
    )).toContain('uq_agency_inbound_calls_provider_call');
  });
});

describe('0024 — agency_calls.origin gains inbound', () => {
  it('an inbound leg carries inbound_call_id and no campaign, attempt or manual call', async () => {
    await expect(insertCall({ origin: 'inbound', inbound_call_id: randomUUID() })).resolves.toMatchObject({ origin: 'inbound' });
    await expect(insertCall({ origin: 'preview' })).rejects.toMatchObject(refused('ck_agency_calls_origin'));
    for (const bad of [{ origin: 'inbound' }, { origin: 'campaign', inbound_call_id: randomUUID() }, { origin: 'manual', manual_call_id: randomUUID(), inbound_call_id: randomUUID() }]) {
      await expect(insertCall(bad), JSON.stringify(bad)).rejects.toMatchObject(refused('ck_agency_calls_inbound_correlation'));
    }
    // ck_agency_calls_manual_correlation is not rewritten: its arms already refuse an inbound leg
    // that names a campaign, an attempt or a manual call.
    for (const bad of [
      { campaign_id: randomUUID() }, { agency_attempt_id: randomUUID() }, { manual_call_id: randomUUID() },
    ]) {
      await expect(insertCall({ origin: 'inbound', inbound_call_id: randomUUID(), ...bad }), JSON.stringify(bad))
        .rejects.toMatchObject(refused('ck_agency_calls_manual_correlation'));
    }
    expect((await checkDef('ck_agency_calls_origin'))!.def).toBe(
      "CHECK (((origin)::text = ANY ((ARRAY['campaign'::character varying, 'manual'::character varying, 'inbound'::character varying])::text[])))");
  });
});

describe('0024 — contacts and campaigns', () => {
  it('a contact\'s inbound callback: source and due time together, source inbound only', async () => {
    const campaign = await insertCampaign();
    expect(await insertContact(campaign.id)).toMatchObject({ callback_source: null, callback_due_at: null });
    await insertContact(campaign.id, { callback_source: 'inbound', callback_due_at: new Date() });
    for (const bad of [{ callback_source: 'inbound' }, { callback_due_at: new Date() }, { callback_source: 'disposition', callback_due_at: new Date() }]) {
      await expect(insertContact(campaign.id, bad), JSON.stringify(bad)).rejects.toMatchObject(refused('ck_agency_contact_callback_source'));
    }
  });

  it('a campaign is a sticky-routing signal by default', async () => {
    expect(await insertCampaign()).toMatchObject({ inbound_sticky_enabled: true });
  });
});

describe('0024 — credentials and numbers', () => {
  it('inbound is all of it or none of it; the token is a sha256 hex, never the token', async () => {
    const tenant = await insertTenant();
    expect(await credential(tenant.id)).toMatchObject({ inbound_app_id: null, inbound_token_hash: null });
    await credential(tenant.id, enabled);
    for (const key of Object.keys(enabled)) {
      await expect(credential(tenant.id, { ...enabled, [key]: null }), key).rejects.toMatchObject(refused('ck_telephony_credentials_inbound'));
    }
    await expect(credential(tenant.id, { inbound_token_hash: H })).rejects.toMatchObject(refused('ck_telephony_credentials_inbound'));
    for (const bad of ['raw-token', 'A'.repeat(64), 'a'.repeat(63)]) {
      await expect(credential(tenant.id, { ...enabled, inbound_token_hash: bad })).rejects.toMatchObject(refused('ck_telephony_credentials_inbound'));
    }
    await expect(credential(tenant.id, { ...enabled, inbound_app_id: ' app' })).rejects.toMatchObject(refused('ck_telephony_credentials_inbound'));
  });

  it('a previous token: hash and expiry together, only beside a current one', async () => {
    const tenant = await insertTenant();
    const later = new Date(Date.now() + 3_600_000);
    await credential(tenant.id, { ...enabled, inbound_previous_token_hash: 'b'.repeat(64), inbound_previous_token_expires_at: later });
    for (const bad of [
      { ...enabled, inbound_previous_token_hash: 'b'.repeat(64) },
      { ...enabled, inbound_previous_token_expires_at: later },
      { ...enabled, inbound_previous_token_hash: 'raw', inbound_previous_token_expires_at: later },
      { inbound_previous_token_hash: 'b'.repeat(64), inbound_previous_token_expires_at: later },
    ]) await expect(credential(tenant.id, bad)).rejects.toMatchObject(refused('ck_telephony_credentials_inbound_previous_token'));
  });

  it('a revoked credential has no inbound Application', async () => {
    const tenant = await insertTenant();
    const c = await credential(tenant.id, enabled);
    await expect(pool().query(`UPDATE telephony_credentials SET status = 'revoked', revoked_at = now() WHERE id = $1`, [c.id]))
      .rejects.toMatchObject(refused('ck_telephony_credentials_inbound_revoked'));
  });

  it('only a synced number links; its previous app only while linked', async () => {
    const tenant = await insertTenant();
    const c = await credential(tenant.id);
    expect(await number({ telephony_credential_id: c.id })).toMatchObject({ inbound_linked_at: null, inbound_previous_app_id: null });
    await number({ telephony_credential_id: c.id, inbound_linked_at: new Date(), inbound_previous_app_id: 'old-app' });
    await number({ telephony_credential_id: c.id, inbound_linked_at: new Date() });
    await expect(number({ inbound_linked_at: new Date() })).rejects.toMatchObject(refused('ck_phone_numbers_inbound'));
    await expect(number({ telephony_credential_id: c.id, inbound_previous_app_id: 'old-app' })).rejects.toMatchObject(refused('ck_phone_numbers_inbound'));
  });
});

describe('0024 / 0025 — the big tables\' CHECKs: NOT VALID in 0024, validated by 0025', () => {
  const DEFERRED = ['ck_agency_calls_origin', 'ck_agency_calls_inbound_correlation', 'ck_agency_contact_callback_source'];
  const files = () => readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();

  it('0024 leaves them unvalidated and enforced; 0025 validates the rows already there', async () => {
    // Rows that predate 0024 are present at both steps, so validation runs over real rows.
    await migrate('down', files().length - files().indexOf(FILE));
    try {
      const campaign = await insertCampaign();
      const contact = await insertContact(campaign.id);
      await insertCall({ origin: 'manual', manual_call_id: randomUUID() });
      await migrate('up', 1);
      const ledger = await pool().query<{ name: string }>('SELECT name FROM pgmigrations ORDER BY id DESC LIMIT 1');
      expect(ledger.rows[0]!.name).toBe('0024_inbound');
      const validated = async () => Object.fromEntries(await Promise.all(DEFERRED.map(async (n) => [n, (await checkDef(n))!.validated])));
      expect(await validated()).toEqual(Object.fromEntries(DEFERRED.map((n) => [n, false])));
      // The small tables' CHECKs are validated by 0024 itself.
      expect((await checkDef('ck_telephony_credentials_inbound'))!.validated).toBe(true);
      expect((await checkDef('ck_phone_numbers_inbound'))!.validated).toBe(true);
      // NOT VALID still refuses every new bad write.
      await expect(insertCall({ origin: 'inbound' })).rejects.toMatchObject(refused('ck_agency_calls_inbound_correlation'));
      await expect(insertCall({ origin: 'preview' })).rejects.toMatchObject(refused('ck_agency_calls_origin'));
      await expect(pool().query(`UPDATE agency_contacts SET callback_source = 'inbound' WHERE id = $1`, [contact.id]))
        .rejects.toMatchObject(refused('ck_agency_contact_callback_source'));
    } finally {
      await migrate('up');
    }
    for (const name of DEFERRED) expect((await checkDef(name))!.validated, name).toBe(true);
  });
});

describe('0024 — down', () => {
  const files = () => readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  const downTo0024 = () => migrate('down', files().length - files().indexOf(FILE));

  it('refuses while an inbound call exists, and changes nothing', async () => {
    await call();
    await migrate('down', files().length - files().indexOf(FILE) - 1); // 0025 first, on its own
    try {
      await expect(migrate('down', 1)).rejects.toThrow(/0024_inbound down: inbound calls exist/);
      expect((await pool().query('SELECT count(*)::int AS n FROM agency_inbound_calls')).rows[0].n).toBe(1);
    } finally {
      await migrate('up');
    }
  });

  it('refuses while an inbound media leg exists, its spine row already purged', async () => {
    await insertCall({ origin: 'inbound', inbound_call_id: randomUUID() });
    await migrate('down', files().length - files().indexOf(FILE) - 1);
    try {
      await expect(migrate('down', 1)).rejects.toThrow(/0024_inbound down: inbound calls exist/);
    } finally {
      await migrate('up');
    }
  });

  it('refuses while a number is linked or a credential has inbound enabled', async () => {
    const tenant = await insertTenant();
    await credential(tenant.id, enabled);
    await migrate('down', files().length - files().indexOf(FILE) - 1);
    try {
      await expect(migrate('down', 1)).rejects.toThrow(/numbers are linked to inbound or a credential has inbound enabled/);
    } finally {
      await migrate('up');
    }
  });

  it('drops the tables and columns and restores the old origin CHECK; up re-applies', async () => {
    await downTo0024();
    try {
      const { rows } = await pool().query(
        `SELECT tablename AS name FROM pg_tables
          WHERE tablename IN ('agency_inbound_routes', 'agency_inbound_route_numbers', 'agency_inbound_calls')
         UNION ALL SELECT table_name || '.' || column_name FROM information_schema.columns
          WHERE (table_name, column_name) IN (('agency_calls', 'inbound_call_id'), ('agency_contacts', 'callback_source'),
            ('agency_campaigns', 'inbound_sticky_enabled'), ('telephony_credentials', 'inbound_app_id'), ('phone_numbers', 'inbound_linked_at'))`);
      expect(rows).toEqual([]);
      expect((await checkDef('ck_agency_calls_origin'))!.def).toBe(
        "CHECK (((origin)::text = ANY ((ARRAY['campaign'::character varying, 'manual'::character varying])::text[])))");
      expect(await checkDef('ck_agency_calls_inbound_correlation')).toBeUndefined();
    } finally {
      await migrate('up');
    }
    expect((await columns('agency_inbound_calls')).length).toBe(57); // 0024's 33, 0027's 15, 0028's 1, 0029's 1, 0030's 1, 0032's 1 and 0036's 5
    expect((await checkDef('ck_agency_calls_origin'))!.validated).toBe(true);
  });
});
