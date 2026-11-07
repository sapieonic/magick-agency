/**
 * Customer history at the spec's scale (`docs/customer-history.md` §4 "Paging", spec §6): one
 * number with 500+ calls across 20 campaigns, plus soft-phone calls, on a tenant of 1,000,000
 * contacts. Times the search (summary + first page) and a later timeline page through the real
 * service and repository, and prints `EXPLAIN (ANALYZE, BUFFERS)` of every statement the
 * repository runs, as it runs them: nothing is disabled, the tables are analysed.
 *
 * Not a test and never part of CI: an opt-in measurement on its own database.
 *
 *   # once: psql -h localhost -p 5436 -U magick_agency -d postgres -c "create database magick_agency_test_bench owner magick_agency"
 *   pnpm tsx scripts/bench-customer-history.ts                 # from apps/server: migrate, seed, measure
 *   BENCH_RESEED=0 pnpm tsx scripts/bench-customer-history.ts  # measure the data already seeded
 *   BENCH_PLANS_FILE=/path/plans.txt …                         # where the full plans go
 *
 * `BENCH_DB_URL` (the app's connection) and `BENCH_SEED_URL` (a superuser, so the seed can run
 * with triggers off: `session_replication_role = replica`) default to the local stack (port
 * 5436). The database must be named `magick_agency_test_bench`: the script DROPS its schema when
 * it seeds, and refuses any other name or port.
 *
 * The shape (sizes scale with `BENCH_CONTACTS`, default 1,000,000):
 *  - one tenant, 10 accounts, 20 campaigns (2 per account), the contacts spread evenly across them;
 *  - background attempts: one for half the contacts, a second for a quarter (about 750,000 at 1M);
 *  - 200,000 background soft-phone calls, 100,000 DNC entries, 300,000 media legs, 2,000 imports
 *    into the 20 campaigns, and 5,000 other campaigns with 50,000 imports;
 *  - the searched number on one roster row in EACH of the 20 campaigns, with 26 attempts each
 *    (520: callbacks, wrap-up redials, overrides among them), 60 soft-phone calls to it (30
 *    untagged, 30 logged to its contacts), a tenant-wide DNC entry and three campaign marks.
 * Two callers: a tenant-level owner (every account: the soft-phone read walks 10 account slices)
 * and an account-scoped supervisor (one account).
 *
 * Then a placeholder (CH14, `BENCH_PLACEHOLDER_ROWS`, default 200,000; 0 skips it): that many roster
 * rows of `+919999999999` in one account with one placed attempt each, seeded inside a transaction
 * that is rolled back, and `EXPLAIN ANALYZE` of every statement that reaches calls through the
 * number's contacts, for the tenant-level owner: each must walk at most the cap of them.
 */
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { runner } from 'node-pg-migrate';
import { MIGRATIONS_DIR } from '../../../packages/db/src/migrations-dir.js';

const DEFAULT_URL = 'postgresql://magick_agency:magick_agency_password@localhost:5436/magick_agency_test_bench';
const DB_URL = process.env['BENCH_DB_URL'] ?? DEFAULT_URL;
const SEED_URL = process.env['BENCH_SEED_URL'] ?? DEFAULT_URL;
const RESEED = process.env['BENCH_RESEED'] !== '0';
const CONTACTS = Number(process.env['BENCH_CONTACTS'] ?? 1_000_000);
const RUNS = Number(process.env['BENCH_RUNS'] ?? 20);
const PLANS_FILE = process.env['BENCH_PLANS_FILE'] ?? join(tmpdir(), 'bench-customer-history-plans.txt');
const PLACEHOLDER_ROWS = Number(process.env['BENCH_PLACEHOLDER_ROWS'] ?? 200_000);

const NUMBER = '+919876543210';
/** A placeholder pasted down a roster (CH14): measured on its own, seeded and rolled back. */
const PLACEHOLDER = '+919999999999';
const CAMPAIGNS = 20;
const ACCOUNTS = 10;
const ATTEMPTS_PER_CONTACT = 26;

for (const url of [DB_URL, SEED_URL]) {
  const u = new URL(url);
  if (u.port !== '5436' || u.pathname !== '/magick_agency_test_bench') {
    throw new Error(`refusing ${u.host}${u.pathname}: the bench runs only on localhost:5436/magick_agency_test_bench`);
  }
}

const ids = {
  tenant: '0b000000-0000-4000-8000-000000000001',
  owner: '0b000000-0000-4000-8000-000000000002',
  supervisor: '0b000000-0000-4000-8000-000000000003',
};

async function seed(): Promise<void> {
  const app = new pg.Pool({ connectionString: DB_URL, max: 1 });
  await app.query('DROP SCHEMA IF EXISTS public CASCADE');
  await app.query('CREATE SCHEMA public');
  await app.end();
  await runner({ databaseUrl: DB_URL, dir: MIGRATIONS_DIR, direction: 'up', migrationsTable: 'pgmigrations', count: Infinity, log: () => {} });

  const db = new pg.Client({ connectionString: SEED_URL });
  await db.connect();
  const step = async (label: string, sql: string, params: unknown[] = []) => {
    const t = performance.now();
    const r = await db.query(sql, params);
    console.log(`  seed ${label}: ${r.rowCount ?? 0} rows, ${((performance.now() - t) / 1000).toFixed(1)} s`);
  };
  try {
    await db.query("SET session_replication_role = replica"); // no triggers, no FK checks: the rows are consistent by construction
    await db.query("SET maintenance_work_mem = '256MB'");
    const T = ids.tenant;
    await step('tenant', `INSERT INTO tenants (id, name, slug) VALUES ($1::uuid, 'Bench', 'bench')`, [T]);
    await step('accounts', `INSERT INTO accounts (id, tenant_id, name, slug, settings, status)
      SELECT ('0b100000-0000-4000-8000-' || lpad(a::text, 12, '0'))::uuid, $1::uuid, 'Account ' || a, 'acct-' || a, '{}'::jsonb, 'active'
        FROM generate_series(0, ${ACCOUNTS - 1}) a`, [T]);
    await step('users', `INSERT INTO users (id, firebase_uid, email, display_name, status)
      SELECT ('0b200000-0000-4000-8000-' || lpad(u::text, 12, '0'))::uuid, 'bench-' || u, 'bench-' || u || '@example.com', 'Agent ' || u, 'active'
        FROM generate_series(0, 99) u
      UNION ALL SELECT $1::uuid, 'bench-owner', 'owner@example.com', 'Owner', 'active'
      UNION ALL SELECT $2::uuid, 'bench-sup', 'sup@example.com', 'Supervisor', 'active'`, [ids.owner, ids.supervisor]);
    await step('memberships', `INSERT INTO memberships (user_id, tenant_id, account_id, role, status)
      SELECT ('0b200000-0000-4000-8000-' || lpad(u::text, 12, '0'))::uuid, $1::uuid,
             ('0b100000-0000-4000-8000-' || lpad((u % ${ACCOUNTS})::text, 12, '0'))::uuid, 'agent'::membership_role, 'active'
        FROM generate_series(0, 99) u
      UNION ALL SELECT $2::uuid, $1::uuid, NULL::uuid, 'tenant_owner'::membership_role, 'active'
      UNION ALL SELECT $3::uuid, $1::uuid, '0b100000-0000-4000-8000-000000000000'::uuid, 'account_admin'::membership_role, 'active'`, [T, ids.owner, ids.supervisor]);
    await step('campaigns', `INSERT INTO agency_campaigns (id, tenant_id, account_id, name, caller_ids, status, record_calls, context_display, disposition_catalog)
      SELECT ('0b300000-0000-4000-8000-' || lpad(c::text, 12, '0'))::uuid, $1::uuid,
             ('0b100000-0000-4000-8000-' || lpad((c / 2)::text, 12, '0'))::uuid, 'Campaign ' || c, ARRAY['+919000000001'],
             'running', c % 2 = 0, '{"hero":["Name","Loan No"]}'::jsonb,
             '[{"code":"callback","label":"Call back","requires_datetime":true},{"code":"ptp","label":"PTP"}]'::jsonb
        FROM generate_series(0, ${CAMPAIGNS - 1}) c`, [T]);
    await step('sessions', `INSERT INTO agency_agent_sessions (id, tenant_id, account_id, campaign_id, agent_user_id, state, left_at)
      SELECT ('0b400000-0000-4000-8000-' || lpad(s::text, 12, '0'))::uuid, $1::uuid,
             ('0b100000-0000-4000-8000-' || lpad(((s % ${CAMPAIGNS}) / 2)::text, 12, '0'))::uuid,
             ('0b300000-0000-4000-8000-' || lpad((s % ${CAMPAIGNS})::text, 12, '0'))::uuid,
             ('0b200000-0000-4000-8000-' || lpad((s % 100)::text, 12, '0'))::uuid, 'offline', now()
        FROM generate_series(0, 1999) s`, [T]);

    // The tenant's roster: CONTACTS rows across the 20 campaigns, every one its own chain root.
    await step('contacts', `INSERT INTO agency_contacts (id, root_contact_id, tenant_id, account_id, campaign_id, phone_e164, context, state, created_at)
      SELECT id, id, $1::uuid, ('0b100000-0000-4000-8000-' || lpad(((g % ${CAMPAIGNS}) / 2)::text, 12, '0'))::uuid,
             ('0b300000-0000-4000-8000-' || lpad((g % ${CAMPAIGNS})::text, 12, '0'))::uuid,
             '+9170' || lpad(g::text, 8, '0'), jsonb_build_object('Name', 'Customer ' || g, 'Loan No', 'LN-' || g, 'City', 'Pune'),
             (ARRAY['pending','completed','exhausted'])[g % 3 + 1], now() - (g % 120 || ' days')::interval
        FROM (SELECT gen_random_uuid() AS id, g FROM generate_series(0, ${CONTACTS - 1}) g) x`, [T]);
    await step('attempts', `INSERT INTO agency_call_attempts (tenant_id, account_id, campaign_id, contact_id, attempt_number, caller_id, state,
                                     reserved_agent_id, outcome, dialed_at, ended_at, created_at)
      SELECT c.tenant_id, c.account_id, c.campaign_id, c.id, n, '+919000000001', 'ended',
             ('0b400000-0000-4000-8000-' || lpad((abs(hashtext(c.id::text || n)) % 2000)::text, 12, '0'))::uuid,
             (ARRAY['connected','no_answer','busy'])[n % 3 + 1], c.created_at + (n || ' hours')::interval,
             c.created_at + (n || ' hours')::interval, c.created_at + (n || ' hours')::interval
        FROM agency_contacts c CROSS JOIN LATERAL generate_series(1, CASE WHEN abs(hashtext(c.id::text)) % 4 = 0 THEN 2 ELSE 1 END) n
       WHERE abs(hashtext(c.id::text)) % 2 = 0`);
    await step('soft-phone calls', `INSERT INTO agency_manual_calls (tenant_id, account_id, session_id, agent_user_id, destination_e164, caller_id,
                                     state, outcome, dialed_at, ended_at, settled_at, created_at)
      SELECT $1::uuid, ('0b100000-0000-4000-8000-' || lpad((g % ${ACCOUNTS})::text, 12, '0'))::uuid, gen_random_uuid(),
             ('0b200000-0000-4000-8000-' || lpad((g % 100)::text, 12, '0'))::uuid, '+9170' || lpad((g * 7 % ${CONTACTS})::text, 8, '0'),
             '+919000000001', 'ended', 'connected', now() - (g % 90 || ' days')::interval, now() - (g % 90 || ' days')::interval,
             now() - (g % 90 || ' days')::interval, now() - (g % 90 || ' days')::interval
        FROM generate_series(1, 200000) g`, [T]);
    await step('dnc', `INSERT INTO dnc_entries (tenant_id, account_id, phone_e164, source)
      SELECT $1::uuid, CASE WHEN g % 2 = 0 THEN NULL ELSE ('0b100000-0000-4000-8000-' || lpad((g % ${ACCOUNTS})::text, 12, '0'))::uuid END,
             '+9170' || lpad((g * 13 % ${CONTACTS})::text, 8, '0'), 'api'
        FROM generate_series(1, 100000) g ON CONFLICT DO NOTHING`, [T]);
    await step('media legs', `INSERT INTO agency_calls (tenant_id, account_id, caller_id, destination_phone, recording_url)
      SELECT $1::uuid, ('0b100000-0000-4000-8000-' || lpad((g % ${ACCOUNTS})::text, 12, '0'))::uuid, '+919000000001',
             '+9170' || lpad(g::text, 8, '0'), 'https://r/' || g
        FROM generate_series(1, 300000) g`, [T]);
    await step('imports', `INSERT INTO agency_ingest_jobs (tenant_id, account_id, campaign_id, s3_key, file_name, phone_column, status,
                                     context_columns, started_at, finished_at, created_at)
      SELECT $1::uuid, NULL, ('0b300000-0000-4000-8000-' || lpad((g % ${CAMPAIGNS})::text, 12, '0'))::uuid, 'k/' || g, 'roster-' || g || '.csv',
             'phone', 'completed', ARRAY['Name','Loan No','City'], now() - (g || ' hours')::interval, now() - (g || ' hours')::interval,
             now() - (g || ' hours')::interval
        FROM generate_series(1, 2000) g`, [T]);

    // Other campaigns and their imports, so the campaign and import reads face real tables.
    await step('other campaigns', `INSERT INTO agency_campaigns (id, tenant_id, account_id, name, caller_ids, status)
      SELECT ('0b700000-0000-4000-8000-' || lpad(c::text, 12, '0'))::uuid, $1::uuid,
             ('0b100000-0000-4000-8000-' || lpad((c % ${ACCOUNTS})::text, 12, '0'))::uuid, 'Old campaign ' || c, ARRAY['+919000000001'], 'completed'
        FROM generate_series(1, 5000) c`, [T]);
    await step('other imports', `INSERT INTO agency_ingest_jobs (tenant_id, account_id, campaign_id, s3_key, file_name, phone_column, status, created_at)
      SELECT $1::uuid, NULL, ('0b700000-0000-4000-8000-' || lpad((g % 5000 + 1)::text, 12, '0'))::uuid, 'k/old/' || g, 'old-' || g || '.csv',
             'phone', 'completed', now() - (g || ' minutes')::interval
        FROM generate_series(1, 50000) g`, [T]);

    // ── The searched number ──
    await step('the number: 20 roster rows', `INSERT INTO agency_contacts (id, root_contact_id, tenant_id, account_id, campaign_id, phone_e164, context,
                                     state, last_outcome, last_disposition, override_disposition, override_extra_attempts, override_granted_at,
                                     next_attempt_at, created_at)
      SELECT ('0b500000-0000-4000-8000-' || lpad(c::text, 12, '0'))::uuid, ('0b500000-0000-4000-8000-' || lpad(c::text, 12, '0'))::uuid, $1::uuid,
             ('0b100000-0000-4000-8000-' || lpad((c / 2)::text, 12, '0'))::uuid, ('0b300000-0000-4000-8000-' || lpad(c::text, 12, '0'))::uuid,
             $2, jsonb_build_object('Name', 'Asha Rao', 'Loan No', 'LN-0042', 'Aadhaar', '1234'), 'pending', 'connected',
             CASE WHEN c % 4 = 0 THEN 'callback' ELSE 'ptp' END, 'ptp', c % 3, now() - interval '2 days',
             now() + interval '1 day', now() - (100 - c || ' days')::interval
        FROM generate_series(0, ${CAMPAIGNS - 1}) c`, [T, NUMBER]);
    await step('the number: attempts', `INSERT INTO agency_call_attempts (id, tenant_id, account_id, campaign_id, contact_id, attempt_number, caller_id, state,
                                     reserved_agent_id, outcome, disposition_code, notes, callback_at, dialed_at, ended_at, talk_seconds,
                                     dispositioned_by_user_id, dispositioned_at, redial_of_attempt_id, redial_number, override_applied, webrtc_call_id, created_at)
      SELECT ('0b600000-0000-4000-' || lpad(c::text, 4, '0') || '-' || lpad(n::text, 12, '0'))::uuid, c2.tenant_id, c2.account_id, c2.campaign_id, c2.id, n,
             '+919000000001', 'ended', ('0b400000-0000-4000-8000-' || lpad((c * 7 + n)::text, 12, '0'))::uuid,
             (ARRAY['connected','no_answer','busy'])[n % 3 + 1], CASE WHEN n % 3 = 0 THEN (ARRAY['ptp','callback'])[n % 2 + 1] END,
             'Spoke about the dues', CASE WHEN n % 13 = 0 THEN c2.created_at + (n || ' days')::interval END,
             c2.created_at + (n * 3 || ' hours')::interval, c2.created_at + (n * 3 || ' hours')::interval + interval '2 minutes', 95,
             ('0b200000-0000-4000-8000-' || lpad(((c * 7 + n) % 100)::text, 12, '0'))::uuid,
             c2.created_at + (n * 3 || ' hours')::interval + interval '3 minutes',
             CASE WHEN n % 10 = 0 THEN ('0b600000-0000-4000-' || lpad(c::text, 4, '0') || '-' || lpad((n - 1)::text, 12, '0'))::uuid END,
             CASE WHEN n % 10 = 0 THEN 1 ELSE 0 END, CASE WHEN n % 7 = 0 THEN ARRAY['extra_attempts'] ELSE '{}'::text[] END,
             CASE WHEN n % 2 = 0 THEN gen_random_uuid() END, c2.created_at + (n * 3 || ' hours')::interval
        FROM generate_series(0, ${CAMPAIGNS - 1}) c
        JOIN agency_contacts c2 ON c2.id = ('0b500000-0000-4000-8000-' || lpad(c::text, 12, '0'))::uuid
       CROSS JOIN generate_series(1, ${ATTEMPTS_PER_CONTACT}) n`);
    await step('the number: soft-phone calls', `INSERT INTO agency_manual_calls (tenant_id, account_id, session_id, agent_user_id, campaign_id, contact_id,
                                     disposition_source, destination_e164, caller_id, state, outcome, callback_at, recording_requested,
                                     dialed_at, ended_at, settled_at, created_at)
      SELECT $1::uuid, ('0b100000-0000-4000-8000-' || lpad(((g % ${CAMPAIGNS}) / 2)::text, 12, '0'))::uuid, gen_random_uuid(),
             ('0b200000-0000-4000-8000-' || lpad((g % 100)::text, 12, '0'))::uuid,
             CASE WHEN g <= 30 THEN ('0b300000-0000-4000-8000-' || lpad((g % ${CAMPAIGNS})::text, 12, '0'))::uuid END,
             CASE WHEN g <= 30 THEN ('0b500000-0000-4000-8000-' || lpad((g % ${CAMPAIGNS})::text, 12, '0'))::uuid END,
             CASE WHEN g <= 30 THEN 'campaign' END, $2, '+919000000001', 'ended', 'connected',
             CASE WHEN g % 9 = 0 THEN now() + interval '2 days' END, g % 2 = 0,
             now() - (g || ' days')::interval, now() - (g || ' days')::interval, now() - (g || ' days')::interval, now() - (g || ' days')::interval
        FROM generate_series(1, 60) g`, [T, NUMBER]);
    await step('the number: DNC', `INSERT INTO dnc_entries (tenant_id, account_id, campaign_id, phone_e164, source, reason, added_by, created_at)
      SELECT $1::uuid, NULL, CASE WHEN g = 0 THEN NULL ELSE ('0b300000-0000-4000-8000-' || lpad((g * 5)::text, 12, '0'))::uuid END, $2,
             CASE WHEN g = 0 THEN 'regulator' ELSE 'agent' END, 'Asked not to be called', NULL, now() - (g * 10 || ' days')::interval
        FROM generate_series(0, 3) g`, [T, NUMBER]);
    const t = performance.now();
    await db.query('ANALYZE');
    console.log(`  ANALYZE: ${((performance.now() - t) / 1000).toFixed(1)} s`);
  } finally {
    await db.end();
  }
}

function stats(ms: number[]): string {
  const s = [...ms].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))]!;
  return `median ${q(0.5).toFixed(1)} ms, p95 ${q(0.95).toFixed(1)} ms, max ${s[s.length - 1]!.toFixed(1)} ms (n=${s.length})`;
}

async function measure(): Promise<void> {
  process.env['DATABASE_URL'] = DB_URL;
  const { initDbPool, getPool, closePool } = await import('@magick-agency/db');
  initDbPool({ url: DB_URL, poolMax: 10 });
  const { resolveViewer, loadCustomerSummary, loadTimelinePage } = await import('../src/agency/customer-history/service.js');
  const { toTimelineFilter } = await import('../src/agency/customer-history/requests.js');
  const { decodeTimelineCursor } = await import('../src/agency/customer-history/cursor.js');
  const { CUSTOMER_HISTORY_SQL, UUID_MAX } = await import('../src/db/repositories/agency.repository.js');

  const counts = await getPool().query<{ contacts: string; attempts: string; manual: string; mine: string; mine_calls: string }>(`
    SELECT (SELECT count(*) FROM agency_contacts) AS contacts, (SELECT count(*) FROM agency_call_attempts) AS attempts,
           (SELECT count(*) FROM agency_manual_calls) AS manual,
           (SELECT count(*) FROM agency_contacts WHERE phone_e164 = $1) AS mine,
           (SELECT count(*) FROM agency_call_attempts a JOIN agency_contacts c ON c.id = a.contact_id WHERE c.phone_e164 = $1)
             + (SELECT count(*) FROM agency_manual_calls WHERE destination_e164 = $1) AS mine_calls`, [NUMBER]);
  const c = counts.rows[0]!;
  console.log(`\ndata: ${c.contacts} contacts, ${c.attempts} attempts, ${c.manual} soft-phone calls; `
    + `the number: ${c.mine} roster rows, ${c.mine_calls} calls (attempts + soft phone)\n`);

  const plans: string[] = [];
  const firstPageOf = { filter: toTimelineFilter(undefined), limit: 50 };
  for (const [label, userId] of [['tenant-level owner (10 accounts)', ids.owner], ['account-scoped supervisor (1 account)', ids.supervisor]] as const) {
    const search = async () => {
      const viewer = await resolveViewer(userId, ids.tenant);
      const [s, p] = await Promise.all([
        loadCustomerSummary(viewer, ids.tenant, NUMBER),
        loadTimelinePage(viewer, ids.tenant, NUMBER, firstPageOf.filter, null, firstPageOf.limit),
      ]);
      return { s, p };
    };
    // The cursor of page 6 (entries 251–300): a later page.
    const viewer = await resolveViewer(userId, ids.tenant);
    let cursor = null as ReturnType<typeof decodeTimelineCursor>;
    for (let i = 0; i < 5; i++) {
      const page = await loadTimelinePage(viewer, ids.tenant, NUMBER, firstPageOf.filter, cursor, 50);
      cursor = page.next_cursor ? decodeTimelineCursor(page.next_cursor) : null;
    }
    const later = async () => {
      const v = await resolveViewer(userId, ids.tenant);
      return loadTimelinePage(v, ids.tenant, NUMBER, firstPageOf.filter, cursor, 50);
    };
    const cold = performance.now();
    const first = await search();
    const coldMs = performance.now() - cold;
    for (let i = 0; i < 3; i++) { await search(); await later(); }
    const searchMs: number[] = [];
    const laterMs: number[] = [];
    for (let i = 0; i < RUNS; i++) {
      let t = performance.now(); await search(); searchMs.push(performance.now() - t);
      t = performance.now(); await later(); laterMs.push(performance.now() - t);
    }
    const lp = await later();
    console.log(`${label}:`);
    console.log(`  search (viewer + summary + first page of 50): first run ${coldMs.toFixed(1)} ms; ${stats(searchMs)}`);
    console.log(`    summary: ${first.s.summary.contacts.length} rows, ${first.s.summary.totals.calls} calls placed, `
      + `${first.s.summary.dnc.length} DNC entries, result_count ${first.s.resultCount}; first page ${first.p.entries.length} entries`);
    console.log(`  later page (entries 251–300): ${stats(laterMs)}; ${lp.entries.length} entries, more: ${lp.next_cursor !== null}`);
  }

  // EXPLAIN (ANALYZE, BUFFERS) of every statement, as the repository runs it (the tenant-level scope).
  const accounts = (await getPool().query<{ id: string }>('SELECT id FROM accounts WHERE tenant_id = $1', [ids.tenant])).rows.map((r) => r.id);
  const contactIds = Array.from({ length: CAMPAIGNS }, (_, i) => `0b500000-0000-4000-8000-${String(i).padStart(12, '0')}`);
  const campaignIds = Array.from({ length: CAMPAIGNS }, (_, i) => `0b300000-0000-4000-8000-${String(i).padStart(12, '0')}`);
  const laterAt = cursorAt(await getPool().query<{ at: string }>(
    `SELECT to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at FROM agency_call_attempts
      WHERE contact_id = ANY($1::uuid[]) ORDER BY created_at DESC OFFSET 250 LIMIT 1`, [contactIds]));
  function cursorAt(r: { rows: Array<{ at: string }> }): string { return r.rows[0]?.at ?? 'infinity'; }
  const page = (at: string) => [ids.tenant, NUMBER, accounts, at, UUID_MAX, 51, null, null, null];
  const calls = (at: string) => [...page(at), null, null, null, false];
  const statements: Array<[string, string, unknown[]]> = [
    ['summaryContacts', CUSTOMER_HISTORY_SQL.summaryContacts, [ids.tenant, NUMBER, accounts, 2001]],
    ['callStats', CUSTOMER_HISTORY_SQL.callStats, [ids.tenant, NUMBER, accounts]],
    ['lastPlaced', CUSTOMER_HISTORY_SQL.lastPlaced, [ids.tenant, NUMBER, accounts]],
    ['liveCalls', CUSTOMER_HISTORY_SQL.liveCalls, [ids.tenant, NUMBER, accounts]],
    ['latestBookings', CUSTOMER_HISTORY_SQL.latestBookings, [ids.tenant, accounts, contactIds]],
    ['dnc', CUSTOMER_HISTORY_SQL.dnc, [ids.tenant, NUMBER, accounts]],
    ['pageAttempts (first)', CUSTOMER_HISTORY_SQL.pageAttempts, calls('infinity')],
    ['pageAttempts (later)', CUSTOMER_HISTORY_SQL.pageAttempts, calls(laterAt)],
    ['pageCallbacks', CUSTOMER_HISTORY_SQL.pageCallbacks, page('infinity')],
    ['pageManualCalls (first)', CUSTOMER_HISTORY_SQL.pageManualCalls, calls('infinity')],
    ['pageManualCalls (later)', CUSTOMER_HISTORY_SQL.pageManualCalls, calls(laterAt)],
    ['pageDnc', CUSTOMER_HISTORY_SQL.pageDnc, page('infinity')],
    ['pageContacts', CUSTOMER_HISTORY_SQL.pageContacts, page('infinity')],
    ['callbackNext', CUSTOMER_HISTORY_SQL.callbackNext, [ids.tenant, NUMBER, accounts, [contactIds[0]], ['2026-01-01T00:00:00.000000Z']]],
    ['campaigns', CUSTOMER_HISTORY_SQL.campaigns, [ids.tenant, accounts, campaignIds]],
    ['campaignsWithRoots', CUSTOMER_HISTORY_SQL.campaignsWithRoots, [ids.tenant, accounts, campaignIds]],
    ['mediaLegs', CUSTOMER_HISTORY_SQL.mediaLegs, [ids.tenant, accounts, contactIds]],
    ['uploads', CUSTOMER_HISTORY_SQL.uploads, [ids.tenant, accounts, campaignIds]],
  ];
  const fullScan = /Seq Scan on (agency_contacts|agency_call_attempts|agency_manual_calls|dnc_entries|agency_calls|agency_ingest_jobs|agency_campaigns|agency_agent_sessions)\b/;
  console.log('\nEXPLAIN (ANALYZE, BUFFERS), every plan type allowed:');
  for (const [name, sql, params] of statements) {
    await getPool().query(`EXPLAIN (ANALYZE, BUFFERS) ${sql}`, params); // warm
    const { rows } = await getPool().query<{ 'QUERY PLAN': string }>(`EXPLAIN (ANALYZE, BUFFERS) ${sql}`, params);
    const plan = rows.map((r) => r['QUERY PLAN']).join('\n');
    const exec = /Execution Time: ([\d.]+) ms/.exec(plan)?.[1] ?? '?';
    const scan = fullScan.exec(plan)?.[0];
    const sorts = (plan.match(/Sort Method: [^\n]*/g) ?? []).join('; ');
    console.log(`  ${name.padEnd(24)} ${exec.padStart(8)} ms  ${scan ? `FULL SCAN: ${scan}` : 'no full scan'}${sorts ? `  [${sorts}]` : ''}`);
    plans.push(`── ${name}\n${plan}\n`);
  }
  if (PLACEHOLDER_ROWS > 0) await measurePlaceholder(getPool(), accounts, CUSTOMER_HISTORY_SQL, UUID_MAX, plans);
  writeFileSync(PLANS_FILE, plans.join('\n'));
  console.log(`\nfull plans: ${PLANS_FILE}`);
  await closePool();
}

/**
 * The placeholder's statements on the real data, in one transaction that is rolled back (the
 * service reads through the pool and cannot see uncommitted rows, so only the statements are timed).
 */
async function measurePlaceholder(
  pool: pg.Pool,
  accounts: string[],
  SQL: Record<string, string>,
  uuidMax: string,
  plans: string[],
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let t = performance.now();
    await client.query(`INSERT INTO agency_contacts (id, root_contact_id, tenant_id, account_id, campaign_id, phone_e164, context, created_at)
      SELECT id, id, $1::uuid, '0b100000-0000-4000-8000-000000000000'::uuid, '0b300000-0000-4000-8000-000000000000'::uuid, $2,
             '{}'::jsonb, now() - (g || ' seconds')::interval
        FROM (SELECT gen_random_uuid() AS id, g FROM generate_series(1, $3::int) g) x`, [ids.tenant, PLACEHOLDER, PLACEHOLDER_ROWS]);
    await client.query(`INSERT INTO agency_call_attempts (tenant_id, account_id, campaign_id, contact_id, attempt_number, caller_id, state,
                                     outcome, dialed_at, ended_at, callback_at, created_at)
      SELECT c.tenant_id, c.account_id, c.campaign_id, c.id, 1, '+919000000001', 'ended', 'no_answer', c.created_at, c.created_at,
             CASE WHEN abs(hashtext(c.id::text)) % 10 = 0 THEN now() END, c.created_at
        FROM agency_contacts c WHERE c.tenant_id = $1::uuid AND c.phone_e164 = $2`, [ids.tenant, PLACEHOLDER]);
    await client.query('ANALYZE agency_contacts, agency_call_attempts');
    console.log(`\nplaceholder ${PLACEHOLDER}: ${PLACEHOLDER_ROWS} roster rows and attempts seeded (rolled back after) in `
      + `${((performance.now() - t) / 1000).toFixed(1)} s; EXPLAIN (ANALYZE, BUFFERS), tenant-level owner:`);
    const page = [ids.tenant, PLACEHOLDER, accounts, 'infinity', uuidMax, 51, null, null, null];
    const calls = [...page, null, null, null, false];
    const number = [ids.tenant, PLACEHOLDER, accounts];
    const statements: Array<[string, string, unknown[]]> = [
      ['summaryContacts', SQL['summaryContacts']!, [...number, 2001]],
      ['callStats', SQL['callStats']!, number],
      ['lastPlaced', SQL['lastPlaced']!, number],
      ['liveCalls', SQL['liveCalls']!, number],
      ['pageAttempts', SQL['pageAttempts']!, calls],
      ['pageCallbacks', SQL['pageCallbacks']!, page],
      ['pageManualCalls', SQL['pageManualCalls']!, calls],
      ['pageContacts', SQL['pageContacts']!, page],
    ];
    for (const [name, sql, params] of statements) {
      t = performance.now();
      const { rows } = await client.query<{ 'QUERY PLAN': string }>(`EXPLAIN (ANALYZE, BUFFERS) ${sql}`, params);
      const plan = rows.map((r) => r['QUERY PLAN']).join('\n');
      const exec = /Execution Time: ([\d.]+) ms/.exec(plan)?.[1] ?? '?';
      const walked = [...plan.matchAll(/Scan using idx_agency_contacts_customer_history[^\n]*actual time=[^ ]+ rows=(\d+) loops=(\d+)/g)]
        .reduce((n, m) => n + Number(m[1]) * Number(m[2]), 0);
      const scan = /Seq Scan on (agency_contacts|agency_call_attempts)\b/.exec(plan)?.[0];
      console.log(`  ${name.padEnd(18)} ${exec.padStart(8)} ms  roster rows walked ${walked}${scan ? `  FULL SCAN: ${scan}` : ''}`);
      plans.push(`── placeholder ${name}\n${plan}\n`);
    }
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

async function main(): Promise<void> {
  if (RESEED) {
    console.log(`seeding ${CONTACTS} contacts into magick_agency_test_bench…`);
    await seed();
  }
  await measure();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
