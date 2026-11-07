import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { RouteOptions } from 'fastify';

/**
 * ─── Customer history through the real app and real Postgres ───────────────────
 *
 * `POST /proxy/agency/customers/{search,timeline,export}` and `GET …/options`
 * (`docs/customer-history.md`): session middleware with Firebase stubbed, tenant context, RBAC,
 * the dialer flag, the per-user search cap, the Redis search store and the repository's reads on
 * real Postgres.
 *
 * One number (`+919876543210`) in two accounts of one tenant and in another tenant: an
 * account-scoped caller sees only their account's rows (never counted as hidden), a tenant-level
 * caller sees both, and the other tenant's never; campaign DNC marks written as the dialer writes
 * them (no account, a campaign) scoped through their campaign; every timeline kind in one order,
 * a wrap-up redial chain, a tagged and an untagged soft-phone call, DNC marks, a callback; keyset
 * pages (SQL per source) with no duplicates or skips across entries sharing one instant to the
 * microsecond; the filters; what an agent is shown (CH8); hero fields that respect `hidden` and the
 * import's column order; the uploader's file for a tenant-level import; open overrides and live
 * calls; the search id bound to its user and tenant; the audit rows; the rate limit and its
 * message; the export; an EXPLAIN per statement on analysed tables (CH9); the number never in a
 * URL (CH6).
 */

const mocks = vi.hoisted(() => {
  process.env['SUPER_ADMIN_JWT_SECRET'] = 'customer-history-secret-0123456789';
  return { verifyIdToken: vi.fn() };
});
vi.mock('../../../src/auth/firebase.js', () => ({ initFirebase: vi.fn(), verifyIdToken: mocks.verifyIdToken }));
// Tag each RBAC pre-handler with the permission it checks, so the route table can be asked.
vi.mock('../../../src/rbac/rbac.middleware.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../src/rbac/rbac.middleware.js')>();
  return {
    ...real,
    requirePermission: (permission: Parameters<typeof real.requirePermission>[0]) =>
      Object.assign(real.requirePermission(permission), { permission }),
  };
});

import { getTestPool, truncateAll } from '../../../../../packages/db/test/helpers/test-db.js';
import {
  drainAudits, headersFor, seedFloor, startLoadApp, stopLoadApp, verifyTestToken,
  type Actor, type LoadApp, type TenantFloor,
} from '../load/load-harness.js';
import {
  agencyAttemptRepository,
  agencyCustomerHistoryRepository,
  CUSTOMER_HISTORY_MAX_CONTACT_ROWS,
  CUSTOMER_HISTORY_SQL,
  UUID_MAX,
  type CustomerHistoryPageQuery,
  type CustomerHistoryScope,
} from '../../../src/db/repositories/agency.repository.js';
import { countCustomerEntries, resolveViewer } from '../../../src/agency/customer-history/service.js';
import { entryCount } from '../../../src/agency/customer-history/assemble.js';
import { buildViewer } from '../../../src/agency/customer-history/visibility.js';
import { agentNamesOrNone } from '../../../src/agency/agency-agent-identity.js';

const SEARCH_MAX = 40;
const EXPORT_MAX = 15;
const NUMBER = '+919876543210';
const TYPED = '098765-43210';
/** Live calls: a queued attempt and a ringing soft-phone call. */
const NUMBER_LIVE = '+919811111111';
/** Entries sharing one millisecond, apart by microseconds, across kinds. */
const NUMBER_MICRO = '+919822222222';
/** On more roster rows than the history covers. */
const NUMBER_CAP = '+919833333333';
/** A placeholder on 5,000 roster rows of one account, for the bounded walk's plan (CH14). */
const NUMBER_PLACEHOLDER = '+919999999999';

let loaded: LoadApp;
let floors: TenantFloor[];
let floor: TenantFloor;
let other: TenantFloor;
const routes: RouteOptions[] = [];
const urls: string[] = [];
const q = (sql: string, values: unknown[] = []) => getTestPool().query(sql, values);

// Account A is floor 0's account; account B is added beside it.
let accountB: string;
let campaignB: string;
let retryCampaign: string;
let owner: Actor; // tenant-level tenant_owner
let rateUser: Actor;
let viewerB: Actor; // viewer in account B only
let twoTenants: Actor; // an agent in floor 0's account and in floor 1's
const sup = () => floor.supervisors[0]!;
const agent = (i: number) => floor.agents[i]!;
const inB = () => ({ 'x-account-id': accountB });

const ids = {
  cA: randomUUID(), cAr: randomUUID(), cB: randomUUID(), noise: randomUUID(), foreign: randomUUID(),
  a1: randomUUID(), a2: randomUUID(), a3: randomUUID(), bA1: randomUUID(),
  shared: Array.from({ length: 6 }, () => randomUUID()),
  m1: randomUUID(), m2: randomUUID(), mB: randomUUID(), mB2: randomUUID(),
  dncA: randomUUID(), dncTenant: randomUUID(), dncB: randomUUID(), dncBc: randomUUID(), dncForeign: randomUUID(),
  leg1: randomUUID(), leg2: randomUUID(), legB: randomUUID(), legM1: randomUUID(),
  cLive: randomUUID(), aQueued: randomUUID(), mRinging: randomUUID(),
  cMicro: randomUUID(), mu: Array.from({ length: 3 }, () => randomUUID()), muCb: randomUUID(), mMicro: randomUUID(), dncMicro: randomUUID(),
};

const DAY = 86_400_000;
const T0 = new Date(Date.now() - 30 * DAY);
const at = (ms: number) => new Date(T0.getTime() + ms);
/** `at(12 days)` to the millisecond, then `µs` microseconds into it, as Postgres reads it. */
const MICRO_BASE = at(12 * DAY).toISOString().slice(0, 23);
const micro = (us: number) => `${MICRO_BASE}${String(us).padStart(3, '0')}Z`;

async function post(path: string, actor: Actor, body: unknown, f: TenantFloor = floor, extra: Record<string, string> = {}) {
  const url = `/proxy/agency/customers/${path}`;
  urls.push(url);
  return loaded.app.inject({
    method: 'POST',
    url,
    headers: headersFor(actor, f, { 'content-type': 'application/json', ...extra }),
    payload: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

async function search(actor: Actor, value = TYPED, f: TenantFloor = floor, extra: Record<string, string> = {}) {
  const res = await post('search', actor, { by: 'phone', value, country: 'IN' }, f, extra);
  expect(res.statusCode, res.body).toBe(200);
  return res.json();
}

async function allPages(actor: Actor, searchId: string, limit: number, filters?: unknown, extra: Record<string, string> = {}) {
  const keys: string[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 100; i++) {
    const res = await post('timeline', actor, { search_id: searchId, limit, ...(filters ? { filters } : {}), ...(cursor ? { cursor } : {}) }, floor, extra);
    expect(res.statusCode, res.body).toBe(200);
    const page = res.json();
    expect(page.entries.length).toBeLessThanOrEqual(limit);
    keys.push(...page.entries.map((e: { key: string }) => e.key));
    if (!page.next_cursor) return keys;
    cursor = page.next_cursor;
  }
  throw new Error('too many pages');
}

async function user(role: string, accountId: string | null, name: string): Promise<Actor> {
  const id = randomUUID();
  const uid = `ch-${name.replace(/\W/g, '')}-${id.slice(0, 8)}`;
  await q(`INSERT INTO users (id, firebase_uid, email, display_name, status) VALUES ($1, $2, $3, $4, 'active')`,
    [id, uid, `${uid}@load.example.com`, name]);
  await q(`INSERT INTO memberships (id, user_id, tenant_id, account_id, role, status) VALUES ($1, $2, $3, $4, $5, 'active')`,
    [randomUUID(), id, floor.tenant, accountId, role]);
  return { id, uid, tok: `tok:${uid}`, role: 'agent', ip: `10.77.${Math.floor(Math.random() * 200)}.${Math.floor(Math.random() * 200)}` };
}

async function session(f: { tenant: string; account: string }, campaignId: string, agentId: string): Promise<string> {
  const id = randomUUID();
  await q(`INSERT INTO agency_agent_sessions (id, tenant_id, account_id, campaign_id, agent_user_id, state, left_at)
           VALUES ($1, $2, $3, $4, $5, 'offline', now())`, [id, f.tenant, f.account, campaignId, agentId]);
  return id;
}

async function softphoneSession(accountId: string, agentId: string): Promise<string> {
  const id = randomUUID();
  await q(`INSERT INTO agency_agent_sessions (id, tenant_id, account_id, campaign_id, agent_user_id, state, kind, left_at)
           VALUES ($1, $2, $3, NULL, $4, 'offline', 'softphone', now())`, [id, floor.tenant, accountId, agentId]);
  return id;
}

const ASHA = { Name: 'Asha Rao', 'Loan No': 'LN-0042' };

async function contact(
  id: string, f: { tenant: string }, accountId: string, campaignId: string, phone: string, createdAt: Date | string,
  extra: Record<string, unknown> = {}, context: Record<string, unknown> = ASHA,
) {
  const cols = ['id', 'tenant_id', 'account_id', 'campaign_id', 'phone_e164', 'context', 'created_at', ...Object.keys(extra)];
  const vals = [id, f.tenant, accountId, campaignId, phone, JSON.stringify(context), createdAt, ...Object.values(extra)];
  await q(`INSERT INTO agency_contacts (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`, vals);
}

async function attempt(row: Record<string, unknown>) {
  const base = { tenant_id: floor.tenant, account_id: floor.account, caller_id: '+919000000001', state: 'ended' };
  const full = { ...base, ...row };
  const cols = Object.keys(full);
  await q(`INSERT INTO agency_call_attempts (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`, Object.values(full));
}

async function manualCall(row: Record<string, unknown>) {
  const base = { tenant_id: floor.tenant, account_id: floor.account, caller_id: '+919000000001', state: 'ended', destination_e164: NUMBER };
  const full = { ...base, ...row };
  const cols = Object.keys(full);
  await q(`INSERT INTO agency_manual_calls (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`, Object.values(full));
}

async function dncRow(row: Record<string, unknown>) {
  const cols = Object.keys(row);
  await q(`INSERT INTO dnc_entries (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`, Object.values(row));
}

beforeAll(async () => {
  mocks.verifyIdToken.mockImplementation(verifyTestToken);
  loaded = await startLoadApp({
    configure: (c) => ({
      ...c,
      agency: { ...c.agency, customerHistory: { ...c.agency.customerHistory, searchesPerMinute: SEARCH_MAX, exportMaxRows: EXPORT_MAX } },
    }),
    onRoute: (r) => routes.push(r),
  });
  await truncateAll();
  floors = await seedFloor({ tenants: 3, agentsPerTenant: 2, supervisorsPerTenant: 1, campaignsPerTenant: 1 });
  floor = floors[0]!;
  other = floors[1]!;
  // The dialer off for tenant 2, before any request (the flag service caches what it read).
  await q(`UPDATE feature_flag_overrides SET value = 'false'::jsonb WHERE flag_key = 'agency_dialer_enabled' AND tenant_id = $1`,
    [floors[2]!.tenant]);

  const C0 = floor.campaigns[0]!;
  await q(`UPDATE agency_campaigns SET name = 'October dues', context_display = '{"hero":["Name","Loan No"]}'::jsonb, record_calls = true
            WHERE id = $1`, [C0]);

  // Account B in the same tenant, with its own campaign: no heroes, `Aadhaar` hidden.
  accountB = randomUUID();
  await q(`INSERT INTO accounts (id, tenant_id, name, slug, settings, status) VALUES ($1, $2, 'South', $3, '{}'::jsonb, 'active')`,
    [accountB, floor.tenant, `south-${accountB.slice(0, 8)}`]);
  campaignB = randomUUID();
  await q(`INSERT INTO agency_campaigns
           SELECT (jsonb_populate_record(c, jsonb_build_object('id', $2::uuid, 'account_id', $3::uuid, 'name', 'South campaign',
                   'context_display', '{"hidden":["Aadhaar"]}'::jsonb))).*
             FROM agency_campaigns c WHERE c.id = $1`, [C0, campaignB, accountB]);
  // A retry of C0.
  retryCampaign = randomUUID();
  await q(`INSERT INTO agency_campaigns
           SELECT (jsonb_populate_record(c, jsonb_build_object('id', $2::uuid, 'name', 'October dues (retry 1)',
                   'root_campaign_id', $1::uuid, 'parent_campaign_id', $1::uuid, 'retry_generation', 1, 'status', 'running'))).*
             FROM agency_campaigns c WHERE c.id = $1`, [C0, retryCampaign]);

  owner = await user('tenant_owner', null, 'Owner');
  rateUser = await user('agent', floor.account, 'Rate');
  viewerB = await user('viewer', accountB, 'B viewer');
  twoTenants = await user('agent', floor.account, 'Two tenants');
  await q(`INSERT INTO memberships (id, user_id, tenant_id, account_id, role, status) VALUES ($1, $2, $3, $4, 'agent', 'active')`,
    [randomUUID(), twoTenants.id, other.tenant, other.account]);

  const a0 = agent(0).id;
  const a1 = agent(1).id;
  const s0 = await session(floor, C0, a1);
  const sRetry = await session(floor, retryCampaign, a0);

  // ── Account A ──
  // cA's override is fully spent (the code stays, every grant is used): not open.
  await contact(ids.cA, floor, floor.account, C0, NUMBER, T0, {
    override_disposition: 'ptp', override_extra_attempts: 0, override_granted_at: at(DAY),
  });
  await attempt({ id: ids.a1, campaign_id: C0, contact_id: ids.cA, attempt_number: 1, reserved_agent_id: s0,
    outcome: 'connected', disposition_code: 'ptp', notes: 'A1 notes', webrtc_call_id: ids.leg1,
    dialed_at: at(DAY), ended_at: at(DAY + 60_000), created_at: at(DAY) });
  await attempt({ id: ids.a2, campaign_id: C0, contact_id: ids.cA, attempt_number: 2, reserved_agent_id: s0,
    outcome: 'connected', disposition_code: 'ptp', notes: 'A2 notes', webrtc_call_id: ids.leg2,
    redial_of_attempt_id: ids.a1, redial_number: 1,
    dialed_at: at(DAY + 300_000), ended_at: at(DAY + 360_000), created_at: at(DAY + 300_000) });
  // Six attempts sharing one instant to the microsecond.
  // The first carries the campaign's automatic outcome for an unanswered call (OD1–OD8).
  for (const [i, id] of ids.shared.entries()) {
    await attempt({ id, campaign_id: C0, contact_id: ids.cA, attempt_number: 10 + i, outcome: 'no_answer',
      ...(i === 0 ? { auto_disposition_code: 'callback' } : {}),
      dialed_at: at(5 * DAY), ended_at: at(5 * DAY), created_at: at(5 * DAY) });
  }
  await q(`INSERT INTO agency_calls (id, tenant_id, account_id, caller_id, destination_phone, recording_url)
           VALUES ($1, $2, $3, '+919000000001', $4, 'https://recordings.example.com/1')`, [ids.leg1, floor.tenant, floor.account, NUMBER]);
  // leg2 has no agency_calls row: purged by retention; C0 records its calls → "expired".
  // A campaign mark, as the dialer writes it: no account, the campaign.
  await dncRow({ id: ids.dncA, tenant_id: floor.tenant, account_id: null, campaign_id: C0, phone_e164: NUMBER, source: 'agent',
    reason: 'Asked not to be called', added_by: sup().id, created_at: at(2 * DAY) });
  await dncRow({ id: ids.dncTenant, tenant_id: floor.tenant, account_id: null, campaign_id: null, phone_e164: NUMBER, source: 'regulator',
    reason: 'National registry', added_by: 'import:registry.csv', created_at: at(7 * DAY) });
  // The retry chain: a copy of cA in the retry campaign, its callback booked by agent 0; its PTP
  // grant has one extra attempt left (open, its follow-up the next dial).
  await contact(ids.cAr, floor, floor.account, retryCampaign, NUMBER, at(10 * DAY), {
    root_contact_id: ids.cA, source_contact_id: ids.cA, last_disposition: 'callback', last_outcome: 'connected',
    next_attempt_at: new Date(Date.now() + DAY), assigned_user_id: a0, assigned_at: at(10 * DAY),
    override_disposition: 'ptp', override_extra_attempts: 1, override_granted_at: at(20 * DAY),
  });
  await attempt({ id: ids.a3, campaign_id: retryCampaign, contact_id: ids.cAr, attempt_number: 1, reserved_agent_id: sRetry,
    outcome: 'connected', disposition_code: 'callback', notes: 'A3 notes', callback_at: new Date(Date.now() + DAY),
    dispositioned_by_user_id: a0, dispositioned_at: at(20 * DAY + 120_000),
    dialed_at: at(20 * DAY), ended_at: at(20 * DAY + 60_000), created_at: at(20 * DAY) });
  // Soft phone: a tagged call (agent 1, logged to cA) and an untagged one (agent 0), whose leg was
  // purged but which never asked for a recording ("not recorded", never "expired").
  await manualCall({ id: ids.m2, session_id: await softphoneSession(floor.account, a1), agent_user_id: a1,
    campaign_id: C0, contact_id: ids.cA, outcome: 'no_answer', notes: 'M2 notes', fields: JSON.stringify({ promised: 5 }),
    disposition_source: 'campaign', disposition_code: 'ptp',
    dialed_at: at(15 * DAY), ended_at: at(15 * DAY), settled_at: at(15 * DAY), created_at: at(15 * DAY) });
  await manualCall({ id: ids.m1, session_id: await softphoneSession(floor.account, a0), agent_user_id: a0,
    outcome: 'connected', notes: 'M1 mine', fields: JSON.stringify({ amount: 10 }), webrtc_call_id: ids.legM1, recording_requested: false,
    dialed_at: at(25 * DAY), ended_at: at(25 * DAY), settled_at: at(25 * DAY), created_at: at(25 * DAY) });
  // Noise: another number in A.
  await contact(ids.noise, floor, floor.account, C0, '+919876543211', at(6 * DAY));

  // ── Account B ──
  // Its row's columns come back from Postgres in JSONB order (`a1`, `bb`, `Aadhaar`); the import
  // kept the file's (`bb`, `Aadhaar`, `a1`); `Aadhaar` is hidden.
  await contact(ids.cB, floor, accountB, campaignB, NUMBER, at(3 * DAY), {}, { a1: 'first', Aadhaar: '1234 5678 9012', bb: 'second' });
  // The roster import, by the tenant-level owner: the job's account is NULL.
  await q(`INSERT INTO agency_ingest_jobs (tenant_id, account_id, campaign_id, s3_key, file_name, phone_column, status,
                                           context_columns, started_at, finished_at, created_at)
           VALUES ($1, NULL, $2, 'k/south', 'south.csv', 'phone', 'completed', ARRAY['bb', 'Aadhaar', 'a1'], $3, $4, $3)`,
    [floor.tenant, campaignB, at(3 * DAY - 60_000), at(3 * DAY + 60_000)]);
  await attempt({ id: ids.bA1, account_id: accountB, campaign_id: campaignB, contact_id: ids.cB, attempt_number: 1,
    outcome: 'connected', notes: 'B notes', dialed_at: at(4 * DAY), ended_at: at(4 * DAY), created_at: at(4 * DAY) });
  await manualCall({ id: ids.mB, account_id: accountB, session_id: await softphoneSession(accountB, owner.id), agent_user_id: owner.id,
    outcome: 'busy', dialed_at: at(4 * DAY + 1000), ended_at: at(4 * DAY + 1000), settled_at: at(4 * DAY + 1000), created_at: at(4 * DAY + 1000) });
  // A call in B logged to B's contact but dialled to another number: found only through the contact.
  await manualCall({ id: ids.mB2, account_id: accountB, session_id: await softphoneSession(accountB, owner.id), agent_user_id: owner.id,
    campaign_id: campaignB, contact_id: ids.cB, destination_e164: '+919876543299', outcome: 'busy',
    dialed_at: at(4 * DAY + 2000), ended_at: at(4 * DAY + 2000), settled_at: at(4 * DAY + 2000), created_at: at(4 * DAY + 2000) });
  await dncRow({ id: ids.dncB, tenant_id: floor.tenant, account_id: accountB, phone_e164: NUMBER, source: 'api', created_at: at(8 * DAY) });
  // B's campaign mark, as the dialer writes it: account-A callers must never see it.
  await dncRow({ id: ids.dncBc, tenant_id: floor.tenant, account_id: null, campaign_id: campaignB, phone_e164: NUMBER, source: 'agent',
    reason: 'B reason', added_by: owner.id, created_at: at(9 * DAY) });

  // ── Another tenant, the same number ──
  await contact(ids.foreign, other, other.account, other.campaigns[0]!, NUMBER, at(9 * DAY));
  // Its registry entry is tenant-wide (no account, no campaign): only the tenant predicate keeps it out.
  await dncRow({ id: ids.dncForeign, tenant_id: other.tenant, account_id: null, campaign_id: null, phone_e164: NUMBER, source: 'regulator',
    reason: 'Other tenant registry', created_at: at(11 * DAY) });

  // ── Live calls: a queued attempt (never dialled) and a ringing soft-phone call ──
  await contact(ids.cLive, floor, floor.account, C0, NUMBER_LIVE, at(26 * DAY));
  await attempt({ id: ids.aQueued, campaign_id: C0, contact_id: ids.cLive, attempt_number: 1, state: 'queued', created_at: at(27 * DAY) });
  await manualCall({ id: ids.mRinging, session_id: await softphoneSession(floor.account, a0), agent_user_id: a0, destination_e164: NUMBER_LIVE,
    state: 'ringing', created_at: at(27 * DAY + 1000) });

  // ── One millisecond, three kinds, apart by microseconds ──
  await contact(ids.cMicro, floor, floor.account, C0, NUMBER_MICRO, micro(1));
  for (const [i, id] of ids.mu.entries()) {
    await attempt({ id, campaign_id: C0, contact_id: ids.cMicro, attempt_number: i + 1, outcome: 'no_answer',
      dialed_at: micro(i + 1), ended_at: micro(i + 1), created_at: micro(i + 1) });
  }
  await attempt({ id: ids.muCb, campaign_id: C0, contact_id: ids.cMicro, attempt_number: 9, outcome: 'connected', disposition_code: 'callback',
    callback_at: new Date(Date.now() + DAY), dialed_at: micro(1), ended_at: micro(1), dispositioned_at: micro(2), created_at: micro(1) });
  await manualCall({ id: ids.mMicro, session_id: await softphoneSession(floor.account, a0), agent_user_id: a0, destination_e164: NUMBER_MICRO,
    dialed_at: micro(2), ended_at: micro(2), settled_at: micro(2), created_at: micro(2) });
  await dncRow({ id: ids.dncMicro, tenant_id: floor.tenant, account_id: null, campaign_id: C0, phone_e164: NUMBER_MICRO, source: 'agent',
    created_at: micro(3) });

  // ── A placeholder number on more roster rows than the history covers ──
  await q(`INSERT INTO agency_contacts (tenant_id, account_id, campaign_id, phone_e164, context, created_at)
           SELECT $1, $2, $3, $4, '{}'::jsonb, $5::timestamptz + (g || ' seconds')::interval FROM generate_series(1, $6::int) g`,
    [floor.tenant, floor.account, C0, NUMBER_CAP, at(13 * DAY), CUSTOMER_HISTORY_MAX_CONTACT_ROWS + 2]);
}, 120_000);

afterAll(async () => {
  await stopLoadApp(loaded);
});

/** Account A's timeline, newest first (the six shared-instant attempts by key, descending). */
function expectedA(): string[] {
  const shared = ids.shared.map((id) => `campaign_call:${id}`).sort().reverse();
  return [
    `softphone_call:${ids.m1}`,
    // The callback sits at its call's created_at (CH14 keyset), after the call: `campaign_call` > `callback`.
    `campaign_call:${ids.a3}`,
    `callback:${ids.a3}`,
    `softphone_call:${ids.m2}`,
    `roster_entry:${ids.cAr}`,
    `dnc_mark:${ids.dncTenant}`,
    ...shared,
    `dnc_mark:${ids.dncA}`,
    `campaign_call:${ids.a2}`,
    `campaign_call:${ids.a1}`,
    `roster_entry:${ids.cA}`,
  ];
}

const accountBIds = () => [accountB, campaignB, ids.cB, ids.bA1, ids.mB, ids.mB2, ids.dncB, ids.dncBc];
const accountBEntries = () => [`roster_entry:${ids.cB}`, `campaign_call:${ids.bA1}`, `softphone_call:${ids.mB}`,
  `softphone_call:${ids.mB2}`, `dnc_mark:${ids.dncB}`, `dnc_mark:${ids.dncBc}`];

describe('scoped by account, inside the query (CH2)', () => {
  it('an account-scoped supervisor sees only their account; the other account is not even counted', async () => {
    const body = await search(sup());
    expect(body.key).toEqual({ by: 'phone', value: NUMBER, display: '+91 98765 43210' });
    expect(body.search_id).toMatch(/^chs_[0-9a-f]{32}$/);
    expect(body.summary.contacts.map((c: { contact_id: string }) => c.contact_id)).toEqual([ids.cAr]);
    expect(body.summary.contacts[0]).toMatchObject({
      root_contact_id: ids.cA, account_name: 'Load Account 0',
      campaign: { id: retryCampaign, root_id: floor.campaigns[0], retry_generation: 1 },
      campaigns: [{ id: floor.campaigns[0] }, { id: retryCampaign }],
      attempt_count: 9,
      fields: [{ column: 'Name', value: 'Asha Rao' }, { column: 'Loan No', value: 'LN-0042' }],
      assigned_to: { user_id: agent(0).id },
    });
    expect(body.summary).not.toHaveProperty('contacts_truncated');
    const text = JSON.stringify(body);
    for (const id of [...accountBIds(), other.tenant, other.account, ids.foreign, ids.noise, ids.dncForeign]) expect(text).not.toContain(id);
    expect(text).not.toContain('B notes');
    expect(text).not.toContain('B reason');
    // 9 attempts + 2 soft-phone calls, all placed.
    expect(body.summary.totals).toMatchObject({ calls: 11, connected: 4 });
    expect(body.summary.dnc.map((d: { id: string }) => d.id)).toEqual([ids.dncTenant, ids.dncA]);
    // The campaign mark belongs to its campaign's account.
    expect(body.summary.dnc[1]).toMatchObject({ scope: 'campaign', account_id: floor.account, account_name: 'Load Account 0',
      reason: 'Asked not to be called' });
  });

  it('a tenant-level owner sees both accounts, never the other tenant', async () => {
    const body = await search(owner);
    expect(body.summary.contacts.map((c: { contact_id: string }) => c.contact_id).sort()).toEqual([ids.cAr, ids.cB].sort());
    const keys = await allPages(owner, body.search_id, 100);
    for (const k of accountBEntries()) expect(keys).toContain(k);
    expect(keys).toHaveLength(expectedA().length + accountBEntries().length);
    expect(body.summary.dnc.map((d: { id: string }) => d.id)).toEqual([ids.dncBc, ids.dncB, ids.dncTenant, ids.dncA]);
    expect(body.summary.dnc[0]).toMatchObject({ scope: 'campaign', account_id: accountB, account_name: 'South', reason: 'B reason' });
    const text = JSON.stringify(body);
    for (const id of [other.tenant, other.account, ids.foreign, ids.noise, ids.dncForeign]) expect(text).not.toContain(id);
  });

  it('a viewer in account B sees B\'s campaign mark with its reason, never account A\'s campaign mark', async () => {
    const body = await search(viewerB, TYPED, floor, inB());
    expect(body.summary.dnc.map((d: { id: string }) => d.id)).toEqual([ids.dncBc, ids.dncB, ids.dncTenant]);
    expect(body.summary.dnc[0]).toMatchObject({ reason: 'B reason', added_by: 'Owner' });
    const keys = await allPages(viewerB, body.search_id, 3, undefined, inB());
    expect(keys).toContain(`dnc_mark:${ids.dncBc}`);
    expect(keys).not.toContain(`dnc_mark:${ids.dncA}`);
    const text = JSON.stringify(body);
    for (const leak of [ids.dncA, 'Asked not to be called', floor.campaigns[0]!, ids.cA, ids.dncForeign]) expect(text).not.toContain(leak);
  });
});

/**
 * Each statement on its own, scoped to account A only: no row of account B comes back from ANY of
 * them. The assembler drops a row whose campaign it was not given, so a route-level test can stay
 * green with one predicate missing; these go red (mutation-checked), one statement per test.
 */
describe('every read binds the visible accounts in SQL (CH2)', () => {
  const repo = agencyCustomerHistoryRepository;
  const onlyA = () => ({ tenantId: floor.tenant, accountIds: [floor.account] });
  const both = () => ({ tenantId: floor.tenant, accountIds: [floor.account, accountB] });
  /** A's 2 roster rows, 11 calls, 1 callback and 2 DNC entries (A's and the tenant-wide one). */
  const ENTRIES_ONLY_A = 16;
  const firstPage = (over: Partial<CustomerHistoryPageQuery> = {}): CustomerHistoryPageQuery => ({
    cursorAt: 'infinity', cursorId: UUID_MAX, limit: 100, from: null, to: null, campaignRoots: null,
    outcomes: null, dispositionCodes: null, agentUserIds: null, connectedOnly: false, ...over,
  });

  it('summary contacts', async () => {
    expect((await repo.summaryContacts(onlyA(), NUMBER, 100)).map((c) => c.id).sort()).toEqual([ids.cA, ids.cAr].sort());
    expect((await repo.summaryContacts(both(), NUMBER, 100)).map((c) => c.id)).toContain(ids.cB);
  });

  it('call aggregates', async () => {
    const a = await repo.callStats(onlyA(), NUMBER);
    expect(a).toMatchObject({ contact_entries: 2, call_entries: 11, callback_entries: 1, calls: 11, connected: 4 });
    expect(a.agent_ids).not.toContain(owner.id);
    expect(a.campaign_ids).not.toContain(campaignB);
    const ab = await repo.callStats(both(), NUMBER);
    expect(ab).toMatchObject({ contact_entries: 3, call_entries: 14 });
    expect(ab.agent_ids).toContain(owner.id);
  });

  it('the export\'s entry count is the search\'s: the aggregates\' entry counts and the DNC rows', async () => {
    const apart = async (scope: CustomerHistoryScope) =>
      entryCount(await repo.callStats(scope, NUMBER), (await repo.dncForNumber(scope, NUMBER)).length);
    const viewerA = await resolveViewer(sup().id, floor.tenant);
    const viewerAll = await resolveViewer(owner.id, floor.tenant);
    expect(await countCustomerEntries(viewerA, floor.tenant, NUMBER)).toBe(await apart(onlyA()));
    expect(await countCustomerEntries(viewerA, floor.tenant, NUMBER)).toBe(ENTRIES_ONLY_A);
    expect(await countCustomerEntries(viewerAll, floor.tenant, NUMBER)).toBe(await apart(both()));
    expect(await countCustomerEntries(viewerAll, floor.tenant, NUMBER)).toBe(ENTRIES_ONLY_A + accountBEntries().length);
    // No visible account: the tenant-wide DNC entry only.
    expect(await countCustomerEntries(buildViewer(sup().id, [], []), floor.tenant, NUMBER)).toBe(1);
  });

  it('the newest placed call and the live calls', async () => {
    expect((await repo.lastPlaced(onlyA(), NUMBER))?.id).toBe(ids.m1);
    expect((await repo.liveCalls(onlyA(), NUMBER))).toEqual([]);
  });

  it('who booked a contact\'s callback', async () => {
    expect(await repo.latestBookings(onlyA(), [ids.cAr]))
      .toEqual([{ contact_id: ids.cAr, booked_by_user_id: agent(0).id, booked_by_name: 'agent 0.0' }]);
    // Asked for B's contact under A's scope: nothing.
    await q(`UPDATE agency_call_attempts SET callback_at = now() WHERE id = $1`, [ids.bA1]);
    try {
      expect(await repo.latestBookings(onlyA(), [ids.cB])).toEqual([]);
      expect(await repo.latestBookings(both(), [ids.cB])).toHaveLength(1);
    } finally {
      await q(`UPDATE agency_call_attempts SET callback_at = NULL WHERE id = $1`, [ids.bA1]);
    }
  });

  it('the booker\'s name comes with the booking, by agentNamesOrNone\'s rule: display name, else email; never a deleted user or a stranger to the tenant', async () => {
    const booker = async (userId: string) => {
      await q('UPDATE agency_call_attempts SET dispositioned_by_user_id = $2 WHERE id = $1', [ids.a3, userId]);
      return (await repo.latestBookings(onlyA(), [ids.cAr]))[0];
    };
    const blank = await user('agent', floor.account, 'Blank');
    await q(`UPDATE users SET display_name = '  ' WHERE id = $1`, [blank.id]);
    const gone = await user('agent', floor.account, 'Gone');
    await q(`UPDATE users SET status = 'deleted' WHERE id = $1`, [gone.id]);
    const stranger = randomUUID();
    await q(`INSERT INTO users (id, firebase_uid, email, display_name, status) VALUES ($1, $2, $3, 'Stranger', 'active')`,
      [stranger, `ch-stranger-${stranger.slice(0, 8)}`, `stranger-${stranger.slice(0, 8)}@load.example.com`]);
    await q(`INSERT INTO memberships (id, user_id, tenant_id, account_id, role, status) VALUES ($1, $2, $3, $4, 'agent', 'active')`,
      [randomUUID(), stranger, other.tenant, other.account]);
    try {
      expect(await booker(blank.id)).toMatchObject({ booked_by_user_id: blank.id, booked_by_name: `${blank.uid}@load.example.com` });
      expect(await booker(gone.id)).toMatchObject({ booked_by_user_id: gone.id, booked_by_name: null });
      expect(await booker(stranger)).toMatchObject({ booked_by_user_id: stranger, booked_by_name: null });
      // The same answers as the name lookup the rest of the search uses.
      expect(await agentNamesOrNone([blank.id, gone.id, stranger], floor.tenant, 'customer history')).toEqual(new Map([[blank.id, `${blank.uid}@load.example.com`]]));
      // The search names the booker from the booking alone (no second lookup).
      const body = await search(sup());
      expect(body.summary.open.callbacks[0].booked_by).toEqual({ user_id: stranger, name: null });
      await booker(blank.id);
      expect((await search(sup())).summary.open.callbacks[0].booked_by).toEqual({ user_id: blank.id, name: `${blank.uid}@load.example.com` });
    } finally {
      await q('UPDATE agency_call_attempts SET dispositioned_by_user_id = $2 WHERE id = $1', [ids.a3, agent(0).id]);
    }
  });

  it('DNC (summary and page): account entries, campaign marks through their campaign, tenant-wide; never another tenant', async () => {
    expect((await repo.dncForNumber(onlyA(), NUMBER)).map((d) => d.id).sort()).toEqual([ids.dncA, ids.dncTenant].sort());
    expect((await repo.pageDnc(onlyA(), NUMBER, firstPage())).map((d) => d.id).sort()).toEqual([ids.dncA, ids.dncTenant].sort());
    expect((await repo.dncForNumber(both(), NUMBER)).map((d) => d.id).sort())
      .toEqual([ids.dncA, ids.dncTenant, ids.dncB, ids.dncBc].sort());
    const bc = (await repo.dncForNumber(both(), NUMBER)).find((d) => d.id === ids.dncBc);
    expect(bc).toMatchObject({ account_id: null, campaign_id: campaignB, effective_account_id: accountB });
    // No visible account: the tenant-wide entry only (never "every account").
    const none = { tenantId: floor.tenant, accountIds: [] };
    expect((await repo.dncForNumber(none, NUMBER)).map((d) => d.id)).toEqual([ids.dncTenant]);
    expect((await repo.pageDnc(none, NUMBER, firstPage())).map((d) => d.id)).toEqual([ids.dncTenant]);
    // The other tenant's tenant-wide entry, from its own tenant only.
    const otherScope = { tenantId: other.tenant, accountIds: [other.account] };
    expect((await repo.dncForNumber(otherScope, NUMBER)).map((d) => d.id)).toEqual([ids.dncForeign]);
  });

  it('timeline attempts and the callbacks booked on them', async () => {
    const a = (await repo.pageAttempts(onlyA(), NUMBER, firstPage())).map((r) => r.id);
    expect(a).toHaveLength(9);
    expect(a).not.toContain(ids.bA1);
    expect((await repo.pageAttempts(both(), NUMBER, firstPage())).map((r) => r.id)).toContain(ids.bA1);
    expect((await repo.pageCallbacks(onlyA(), NUMBER, firstPage())).map((r) => [r.channel, r.id])).toEqual([['campaign', ids.a3]]);
  });

  it('an attempt or a logged soft-phone call of another account on a visible contact is still not read (each statement binds the accounts itself)', async () => {
    // Rows the dialer never writes (an attempt's account is its contact's): the predicate on the
    // call table itself is what keeps them out, not the contact it hangs off.
    const stray = randomUUID();
    const strayCall = randomUUID();
    await attempt({ id: stray, account_id: accountB, campaign_id: floor.campaigns[0], contact_id: ids.cA, attempt_number: 99,
      outcome: 'connected', callback_at: at(29 * DAY), dialed_at: at(29 * DAY), ended_at: at(29 * DAY), created_at: at(29 * DAY) });
    await manualCall({ id: strayCall, account_id: accountB, session_id: await softphoneSession(accountB, owner.id), agent_user_id: owner.id,
      campaign_id: floor.campaigns[0], contact_id: ids.cA, destination_e164: '+919876543298', outcome: 'busy', callback_at: at(29 * DAY),
      dialed_at: at(29 * DAY), ended_at: at(29 * DAY), settled_at: at(29 * DAY), created_at: at(29 * DAY) });
    try {
      expect((await repo.pageAttempts(onlyA(), NUMBER, firstPage())).map((r) => r.id)).not.toContain(stray);
      expect((await repo.pageManualCalls(onlyA(), NUMBER, firstPage())).map((r) => r.id)).not.toContain(strayCall);
      // Both callback arms: the stray attempt's and the stray soft-phone call's.
      const callbacks = (await repo.pageCallbacks(onlyA(), NUMBER, firstPage())).map((r) => r.id);
      expect(callbacks).not.toContain(stray);
      expect(callbacks).not.toContain(strayCall);
      expect(await repo.callStats(onlyA(), NUMBER)).toMatchObject({ call_entries: 11, callback_entries: 1, calls: 11 });
      expect(await countCustomerEntries(await resolveViewer(sup().id, floor.tenant), floor.tenant, NUMBER)).toBe(ENTRIES_ONLY_A);
      expect((await repo.lastPlaced(onlyA(), NUMBER))?.id).toBe(ids.m1);
      expect(await repo.latestBookings(onlyA(), [ids.cA])).toEqual([]);
      const booking = [{ id: ids.a3, at: at(26 * DAY).toISOString().replace('Z', '000Z') }];
      expect((await repo.callbackNext(onlyA(), NUMBER, booking)).get(ids.a3)).toBeNull();
      // Read with B visible, they are there: the rows are real, the scope is what hid them.
      expect((await repo.pageAttempts(both(), NUMBER, firstPage())).map((r) => r.id)).toContain(stray);
      expect((await repo.pageManualCalls(both(), NUMBER, firstPage())).map((r) => r.id)).toContain(strayCall);
      expect((await repo.pageCallbacks(both(), NUMBER, firstPage())).map((r) => r.id)).toEqual(expect.arrayContaining([stray, strayCall]));
    } finally {
      await q('DELETE FROM agency_call_attempts WHERE id = $1', [stray]);
      await q('DELETE FROM agency_manual_calls WHERE id = $1', [strayCall]);
    }
  });

  it('timeline soft-phone calls, by destination and by contact, and the callbacks booked on them', async () => {
    expect((await repo.pageManualCalls(onlyA(), NUMBER, firstPage())).map((m) => m.id)).toEqual([ids.m1, ids.m2]);
    const ab = (await repo.pageManualCalls(both(), NUMBER, firstPage())).map((m) => m.id);
    expect(ab).toContain(ids.mB); // by destination
    expect(ab).toContain(ids.mB2); // by contact only
    const softphoneCallbacks = async (scope: CustomerHistoryScope) =>
      (await repo.pageCallbacks(scope, NUMBER, firstPage())).filter((c) => c.channel === 'softphone').map((c) => c.id);
    expect(await softphoneCallbacks(onlyA())).toEqual([]);
    await q(`UPDATE agency_manual_calls SET callback_at = now() WHERE id = ANY($1::uuid[])`, [[ids.mB, ids.mB2]]);
    try {
      expect(await softphoneCallbacks(onlyA())).toEqual([]);
      expect((await softphoneCallbacks(both())).sort()).toEqual([ids.mB, ids.mB2].sort());
    } finally {
      await q(`UPDATE agency_manual_calls SET callback_at = NULL WHERE id = ANY($1::uuid[])`, [[ids.mB, ids.mB2]]);
    }
  });

  it('timeline roster rows', async () => {
    expect((await repo.pageContacts(onlyA(), NUMBER, firstPage())).map((c) => c.id)).toEqual([ids.cAr, ids.cA]);
    expect((await repo.pageContacts(both(), NUMBER, firstPage())).map((c) => c.id)).toContain(ids.cB);
  });

  it('a callback\'s next placed call counts only visible calls', async () => {
    const booking = [{ id: ids.a3, at: at(3 * DAY).toISOString().replace('Z', '000Z') }];
    // After day 3, A's next placed call is the shared instant (day 5); B's attempt (day 4) is not A's.
    expect((await repo.callbackNext(onlyA(), NUMBER, booking)).get(ids.a3)).toEqual(at(5 * DAY));
    expect((await repo.callbackNext(both(), NUMBER, booking)).get(ids.a3)).toEqual(at(4 * DAY));
  });

  it('campaigns by id', async () => {
    expect((await repo.campaignsByIds(onlyA(), [campaignB, floor.campaigns[0]!])).map((g) => g.id)).toEqual([floor.campaigns[0]]);
  });

  it('campaigns by id with their chain roots: a visible campaign\'s root; never the root of a campaign the caller cannot see', async () => {
    const read = async (scope: CustomerHistoryScope, ids: string[]) => (await repo.campaignsWithRoots(scope, ids)).map((g) => g.id).sort();
    expect(await read(onlyA(), [retryCampaign, campaignB])).toEqual([floor.campaigns[0]!, retryCampaign].sort());
    expect(await read(both(), [retryCampaign, campaignB])).toEqual([floor.campaigns[0]!, retryCampaign, campaignB].sort());
    // A retry in B of A's campaign (a row the dialer never writes): asked under A, neither is read.
    const strayRetry = randomUUID();
    await q(`INSERT INTO agency_campaigns
             SELECT (jsonb_populate_record(c, jsonb_build_object('id', $2::uuid, 'account_id', $3::uuid, 'name', 'Stray retry',
                     'root_campaign_id', $1::uuid, 'parent_campaign_id', $1::uuid, 'retry_generation', 1))).*
               FROM agency_campaigns c WHERE c.id = $1`, [floor.campaigns[0], strayRetry, accountB]);
    try {
      expect(await read(onlyA(), [strayRetry])).toEqual([]);
      expect(await read(both(), [strayRetry])).toEqual([floor.campaigns[0]!, strayRetry].sort());
    } finally {
      await q('DELETE FROM agency_campaigns WHERE id = $1', [strayRetry]);
    }
  });

  it('media legs by id', async () => {
    await q(`INSERT INTO agency_calls (id, tenant_id, account_id, caller_id, destination_phone) VALUES ($1, $2, $3, '+919000000001', $4)
             ON CONFLICT (id) DO NOTHING`, [ids.legB, floor.tenant, accountB, NUMBER]);
    expect((await repo.mediaLegs(onlyA(), [ids.leg1, ids.legB])).map((l) => l.id)).toEqual([ids.leg1]);
  });

  it('uploads: by the campaign\'s account, so a tenant-level uploader\'s import (no account) is found', async () => {
    expect(await repo.uploads(onlyA(), [campaignB])).toEqual([]);
    expect((await repo.uploads(both(), [campaignB])).map((u) => u.file_name)).toEqual(['south.csv']);
  });

  it('no visible account reads nothing (never "every account")', async () => {
    const none = { tenantId: floor.tenant, accountIds: [] };
    expect(await repo.summaryContacts(none, NUMBER, 100)).toEqual([]);
    expect(await repo.pageAttempts(none, NUMBER, firstPage())).toEqual([]);
    expect(await repo.pageManualCalls(none, NUMBER, firstPage())).toEqual([]);
  });
});

describe('the summary (§3)', () => {
  it('hero fields: never a hidden column; with no heroes, the import\'s column order, not JSONB\'s; the tenant-level uploader\'s file', async () => {
    const body = await search(owner);
    const cB = body.summary.contacts.find((c: { contact_id: string }) => c.contact_id === ids.cB);
    expect(cB.fields).toEqual([{ column: 'bb', value: 'second' }, { column: 'a1', value: 'first' }]);
    expect(JSON.stringify(body)).not.toContain('1234 5678 9012');
    expect(cB.upload_file_name).toBe('south.csv');
    // Filtered to B's campaign: A's attempts, the untagged call and the account-level mark drop out.
    const keys = await allPages(owner, body.search_id, 1, { campaign_ids: [campaignB] });
    expect(keys).toEqual([`dnc_mark:${ids.dncBc}`, `softphone_call:${ids.mB2}`, `campaign_call:${ids.bA1}`, `roster_entry:${ids.cB}`]);
    const page = await post('timeline', owner, { search_id: body.search_id, filters: { campaign_ids: [campaignB] }, limit: 100 });
    const roster = page.json().entries.find((e: { key: string }) => e.key === `roster_entry:${ids.cB}`);
    expect(roster).toMatchObject({ upload_file_name: 'south.csv' });
  });

  it('open items: only an override that still grants something, with its follow-up', async () => {
    const body = await search(sup());
    expect(body.summary.open.overrides).toEqual([expect.objectContaining({
      contact_id: ids.cAr, disposition_code: 'ptp', extra_attempts: 1,
      follow_up_at: expect.stringMatching(/^\d{4}-/), granted_at: at(20 * DAY).toISOString(),
    })]);
    expect(body.summary.open.callbacks).toEqual([expect.objectContaining({ contact_id: ids.cAr, owner: { user_id: agent(0).id, name: 'agent 0.0' },
      booked_by: { user_id: agent(0).id, name: 'agent 0.0' } })]);
  });

  it('live calls: a ringing soft-phone call is live; a queued attempt was never dialled and is not', async () => {
    const body = await search(sup(), '98111 11111');
    expect(body.summary.open.live_calls).toEqual([{ channel: 'softphone', campaign: null, agent: { user_id: agent(0).id, name: 'agent 0.0' },
      started_at: at(27 * DAY + 1000).toISOString() }]);
    // The queued attempt is still on the timeline as a call not placed.
    expect(body.timeline.entries.map((e: { key: string }) => e.key)).toContain(`campaign_call:${ids.aQueued}`);
    expect(body.summary.totals).toMatchObject({ calls: 0, last_contacted: null });
  });

  it('the roster-row cap (CH14): the summary, the timeline, the aggregates and the count cover the newest 2,000 rows; a call dialled to the number is found whatever its contact', async () => {
    const C0 = floor.campaigns[0]!;
    const byAge = (dir: 'ASC' | 'DESC') => q(
      `SELECT id FROM agency_contacts WHERE tenant_id = $1 AND phone_e164 = $2 ORDER BY created_at ${dir}, id ${dir} LIMIT 2`,
      [floor.tenant, NUMBER_CAP]);
    const oldest = (await byAge('ASC')).rows.map((r) => r.id as string);
    const newest = (await byAge('DESC')).rows[0]!.id as string;
    // A call reached only through the oldest row (beyond the cap), one on the newest row, and a
    // soft-phone call logged to the oldest row but dialled to the number (found by destination).
    const beyond = randomUUID();
    const covered = randomUUID();
    const dialled = randomUUID();
    await attempt({ id: beyond, campaign_id: C0, contact_id: oldest[0], attempt_number: 1, outcome: 'no_answer',
      dialed_at: at(14 * DAY), ended_at: at(14 * DAY), created_at: at(14 * DAY) });
    await attempt({ id: covered, campaign_id: C0, contact_id: newest, attempt_number: 1, outcome: 'no_answer',
      dialed_at: at(14 * DAY + 1000), ended_at: at(14 * DAY + 1000), created_at: at(14 * DAY + 1000) });
    await manualCall({ id: dialled, session_id: await softphoneSession(floor.account, agent(0).id), agent_user_id: agent(0).id,
      campaign_id: C0, contact_id: oldest[0], destination_e164: NUMBER_CAP, outcome: 'busy',
      dialed_at: at(14 * DAY + 2000), ended_at: at(14 * DAY + 2000), settled_at: at(14 * DAY + 2000), created_at: at(14 * DAY + 2000) });
    const read = vi.spyOn(agencyCustomerHistoryRepository, 'summaryContacts');
    try {
      let body;
      try {
        body = await search(sup(), '98333 33333');
        // The SQL itself is cut (one row past the cap, to know there are more), not the answer only.
        expect(read).toHaveBeenCalledWith(expect.anything(), NUMBER_CAP, CUSTOMER_HISTORY_MAX_CONTACT_ROWS + 1);
        expect((await read.mock.results[0]!.value).length).toBe(CUSTOMER_HISTORY_MAX_CONTACT_ROWS + 1);
      } finally {
        read.mockRestore();
      }
      expect(body.summary.contacts).toHaveLength(CUSTOMER_HISTORY_MAX_CONTACT_ROWS);
      expect(body.summary.contacts_truncated).toBe(true);
      // Two placed calls covered: the newest row's attempt and the dialled soft-phone call.
      expect(body.summary.totals).toMatchObject({ calls: 2 });
      const keys = await allPages(sup(), body.search_id, 100);
      expect(new Set(keys).size).toBe(keys.length);
      expect(keys.filter((k) => k.startsWith('roster_entry:'))).toHaveLength(CUSTOMER_HISTORY_MAX_CONTACT_ROWS);
      for (const id of oldest) expect(keys).not.toContain(`roster_entry:${id}`);
      expect(keys).not.toContain(`campaign_call:${beyond}`);
      expect(keys).toContain(`campaign_call:${covered}`);
      expect(keys).toContain(`softphone_call:${dialled}`);
      expect(keys).toHaveLength(CUSTOMER_HISTORY_MAX_CONTACT_ROWS + 2);
      // The export reads the same rows and counts the same.
      const exp = await post('export', sup(), { search_id: body.search_id, filters: { channel: 'campaign' } });
      expect(exp.headers['x-export-rows']).toBe('1');
      await drainAudits();
      const { rows } = await q(`SELECT action, details FROM platform_audit_log WHERE resource_id = $1 ORDER BY action DESC`, [body.search_id]);
      expect(rows.map((r) => [r.action, r.details.result_count])).toEqual([
        ['agency_customer_history.searched', CUSTOMER_HISTORY_MAX_CONTACT_ROWS + 2],
        ['agency_customer_history.exported', CUSTOMER_HISTORY_MAX_CONTACT_ROWS + 2],
      ]);
    } finally {
      await q('DELETE FROM agency_call_attempts WHERE id = ANY($1::uuid[])', [[beyond, covered]]);
      await q('DELETE FROM agency_manual_calls WHERE id = $1', [dialled]);
    }
  });
});

describe('the timeline (§4)', () => {
  it('every kind, in one order, with the redial chain and the recording states', async () => {
    const body = await search(sup());
    const keys = await allPages(sup(), body.search_id, 100);
    expect(keys).toEqual(expectedA());
    const first = body.timeline.entries;
    expect(first.map((e: { key: string }) => e.key)).toEqual(expectedA());
    expect(body.timeline.next_cursor).toBeNull();
    const byKey = new Map(first.map((e: { key: string }) => [e.key, e]));
    expect(byKey.get(`campaign_call:${ids.a1}`)).toMatchObject({ recording: 'available', chain_attempt_id: ids.a1, notes: 'A1 notes',
      agent: { user_id: agent(1).id }, call_page: { account_id: floor.account, campaign_id: floor.campaigns[0], attempt_id: ids.a1 } });
    expect(byKey.get(`campaign_call:${ids.a2}`)).toMatchObject({ recording: 'expired', redial_of_attempt_id: ids.a1, chain_attempt_id: ids.a1, redial_number: 1 });
    expect(byKey.get(`campaign_call:${ids.a3}`)).toMatchObject({ recording: 'no_call' });
    // The automatic outcome (OD1–OD8) beside the recorded code; null, never absent, without one.
    expect(byKey.get(`campaign_call:${ids.shared[0]}`)).toMatchObject({ outcome: 'no_answer', disposition_code: null, auto_disposition_code: 'callback' });
    expect(byKey.get(`campaign_call:${ids.shared[1]}`)).toHaveProperty('auto_disposition_code', null);
    expect(byKey.get(`campaign_call:${ids.a1}`)).toMatchObject({ disposition_code: 'ptp', auto_disposition_code: null });
    // Purged, but never asked for a recording: not "expired".
    expect(byKey.get(`softphone_call:${ids.m1}`)).toMatchObject({ campaign: null, contact_id: null, notes: 'M1 mine', recording: 'not_recorded' });
    // The next call placed after the booking is the untagged soft-phone call, days before the
    // callback's time: an early call counts as kept (§4, the insights rule IN4).
    expect(byKey.get(`callback:${ids.a3}`)).toMatchObject({ status: 'kept', dialled_at: at(25 * DAY).toISOString(),
      booked_by: { user_id: agent(0).id }, source: { channel: 'campaign', id: ids.a3 } });
    expect(byKey.get(`softphone_call:${ids.m2}`)).toMatchObject({ campaign: { id: floor.campaigns[0] }, contact_id: ids.cA });
    expect(byKey.get(`dnc_mark:${ids.dncA}`)).toMatchObject({ account_id: floor.account,
      entry: { scope: 'campaign', reason: 'Asked not to be called', added_by: 'account_admin 0.0' } });
    expect(byKey.get(`dnc_mark:${ids.dncTenant}`)).toMatchObject({ account_id: null, entry: { scope: 'tenant', added_by: 'import:registry.csv' } });
  });

  it('keyset pages: no duplicates, no skips, across entries sharing one instant', async () => {
    const body = await search(sup());
    for (const limit of [1, 2, 3, 5]) {
      expect(await allPages(sup(), body.search_id, limit), `limit ${limit}`).toEqual(expectedA());
    }
  });

  it('keyset pages at microsecond precision: entries one microsecond apart, across kinds, paged one at a time', async () => {
    const body = await search(sup(), '98222 22222');
    const expected = [
      [micro(3), `dnc_mark:${ids.dncMicro}`],
      [micro(3), `campaign_call:${ids.mu[2]}`],
      [micro(2), `softphone_call:${ids.mMicro}`],
      [micro(2), `campaign_call:${ids.mu[1]}`],
      [micro(1), `roster_entry:${ids.cMicro}`],
      [micro(1), ...[`campaign_call:${ids.mu[0]}`, `campaign_call:${ids.muCb}`].sort().reverse()],
      // Booked at micro(2), but paged at its call's created_at (micro(1)), which a re-booking never moves.
      [micro(1), `callback:${ids.muCb}`],
    ].flatMap(([, ...keys]) => keys);
    expect(body.timeline.entries.map((e: { key: string }) => e.key)).toEqual(expected);
    for (const limit of [1, 2, 3]) {
      expect(await allPages(sup(), body.search_id, limit), `limit ${limit}`).toEqual(expected);
    }
  });

  it('a callback re-booked between pages (the same outcome, a new time) is shown exactly once, on either channel', async () => {
    const body = await search(sup());
    const m2Before = (await q('SELECT callback_at, dispositioned_at FROM agency_manual_calls WHERE id = $1', [ids.m2])).rows[0];
    const a3Before = (await q(`SELECT callback_at, dispositioned_at, dispositioned_by_user_id, dispositioned_on_behalf
                                 FROM agency_call_attempts WHERE id = $1`, [ids.a3])).rows[0];
    // A soft-phone callback too, booked on m2 a minute after it started.
    await q('UPDATE agency_manual_calls SET callback_at = $2, dispositioned_at = $3 WHERE id = $1',
      [ids.m2, new Date(Date.now() + DAY), at(15 * DAY + 60_000)]);
    try {
      const first = await post('timeline', sup(), { search_id: body.search_id, limit: 1 });
      const page1 = first.json();
      expect(page1.entries.map((e: { key: string }) => e.key)).toEqual([`softphone_call:${ids.m1}`]);
      // Both re-booked after page 1 was read: dispositioned_at moves to now, above the cursor.
      const rebooked = await agencyAttemptRepository.recordDisposition({
        attemptId: ids.a3, dispositionCode: 'callback', notes: null, callbackAt: new Date(Date.now() + 2 * DAY),
        actorUserId: agent(0).id, onBehalf: false,
      });
      expect(rebooked!.dispositioned_at!.getTime()).toBeGreaterThan(at(25 * DAY).getTime());
      // As the soft phone's same-code re-disposition writes it (`recordDisposition` in manual-call.repository.ts).
      await q('UPDATE agency_manual_calls SET callback_at = $2, dispositioned_at = now() WHERE id = $1', [ids.m2, new Date(Date.now() + 2 * DAY)]);
      const keys: string[] = page1.entries.map((e: { key: string }) => e.key);
      let cursor: string | null = page1.next_cursor;
      for (let i = 0; cursor && i < 100; i++) {
        const res = await post('timeline', sup(), { search_id: body.search_id, limit: 1, cursor });
        expect(res.statusCode, res.body).toBe(200);
        keys.push(...res.json().entries.map((e: { key: string }) => e.key));
        cursor = res.json().next_cursor;
      }
      expect(keys.filter((k) => k === `callback:${ids.a3}`)).toHaveLength(1);
      expect(keys.filter((k) => k === `callback:${ids.m2}`)).toHaveLength(1);
      expect(new Set(keys).size).toBe(keys.length);
      expect(keys).toHaveLength(expectedA().length + 1);
      // Judged on the new booking: the next call placed after it is none yet, and the time is ahead.
      const page = await post('timeline', sup(), { search_id: body.search_id, limit: 100 });
      const cb = page.json().entries.find((e: { key: string }) => e.key === `callback:${ids.a3}`);
      expect(cb).toMatchObject({ at: at(20 * DAY).toISOString(), status: 'upcoming', dialled_at: null });
    } finally {
      await q('UPDATE agency_manual_calls SET callback_at = $2, dispositioned_at = $3 WHERE id = $1',
        [ids.m2, m2Before.callback_at, m2Before.dispositioned_at]);
      await q(`UPDATE agency_call_attempts SET callback_at = $2, dispositioned_at = $3, dispositioned_by_user_id = $4,
                                                dispositioned_on_behalf = $5 WHERE id = $1`,
        [ids.a3, a3Before.callback_at, a3Before.dispositioned_at, a3Before.dispositioned_by_user_id, a3Before.dispositioned_on_behalf]);
    }
  });

  it('filters: a root campaign includes its retry; from/to; call-only filters', async () => {
    const body = await search(sup());
    const id = body.search_id;
    const all = expectedA();
    expect(await allPages(sup(), id, 100, { campaign_ids: [floor.campaigns[0]] }))
      .toEqual(all.filter((k) => ![`softphone_call:${ids.m1}`, `dnc_mark:${ids.dncTenant}`].includes(k)));
    expect(await allPages(sup(), id, 1, { channel: 'softphone' })).toEqual([`softphone_call:${ids.m1}`, `softphone_call:${ids.m2}`]);
    expect(await allPages(sup(), id, 100, { connected_only: true, channel: 'campaign' }))
      .toEqual([`campaign_call:${ids.a3}`, `campaign_call:${ids.a2}`, `campaign_call:${ids.a1}`]);
    expect(await allPages(sup(), id, 100, { agent_user_ids: [agent(0).id] })).toEqual([`softphone_call:${ids.m1}`, `campaign_call:${ids.a3}`]);
    expect(await allPages(sup(), id, 100, { disposition_codes: ['callback'] })).toEqual([`campaign_call:${ids.a3}`]);
    expect(await allPages(sup(), id, 100, { outcomes: ['no_answer'] }))
      .toEqual([`softphone_call:${ids.m2}`, ...ids.shared.map((s) => `campaign_call:${s}`).sort().reverse()]);
    expect(await allPages(sup(), id, 2, { from: at(5 * DAY).toISOString(), to: at(15 * DAY).toISOString() }))
      .toEqual(all.filter((k) => [`roster_entry:${ids.cAr}`, `dnc_mark:${ids.dncTenant}`].includes(k) || ids.shared.some((s) => k.endsWith(s))));
  });
});

describe('what each caller is shown (CH8)', () => {
  it('an agent: notes hidden on someone else\'s call, shown on their own; no call page; no DNC detail', async () => {
    const body = await search(agent(0));
    const byKey = new Map(body.timeline.entries.map((e: { key: string }) => [e.key, e]));
    expect(byKey.get(`campaign_call:${ids.a1}`)).toMatchObject({ notes: null, notes_hidden: true, call_page: null });
    expect(byKey.get(`softphone_call:${ids.m2}`)).toMatchObject({ notes: null, notes_hidden: true, fields: null, call_page: null });
    expect(byKey.get(`softphone_call:${ids.m1}`)).toMatchObject({ notes: 'M1 mine', notes_hidden: false, fields: { amount: 10 }, call_page: null });
    expect(byKey.get(`campaign_call:${ids.a3}`)).toMatchObject({ notes: 'A3 notes', notes_hidden: false, call_page: null });
    // Not gated like the notes: a catalog code, as `disposition_code` is.
    expect(byKey.get(`campaign_call:${ids.shared[0]}`)).toMatchObject({ auto_disposition_code: 'callback', call_page: null });
    expect(byKey.get(`dnc_mark:${ids.dncA}`)).toMatchObject({ entry: { reason: null, added_by: null } });
    expect(JSON.stringify(body)).not.toContain('A1 notes');
    expect(JSON.stringify(body)).not.toContain('M2 notes');
  });
});

describe('refusals', () => {
  it('another user\'s search id, an unknown one and a malformed one are all 404 search_expired', async () => {
    const mine = await search(sup());
    const expired = { error: 'Not Found', code: 'search_expired', message: 'This search has expired. Search the number again.' };
    for (const searchId of [mine.search_id, 'chs_00112233445566778899aabbccddeeff', 'nope']) {
      const res = await post('timeline', agent(1), { search_id: searchId });
      expect(res.statusCode, res.body).toBe(404);
      expect(res.json()).toEqual(expired);
    }
    const exp = await post('export', agent(1), { search_id: mine.search_id });
    expect(exp.statusCode).toBe(404);
  });

  it('the same user\'s search id replayed in another tenant is 404 search_expired (the Redis store binds the tenant)', async () => {
    const mine = await search(twoTenants);
    expect((await post('timeline', twoTenants, { search_id: mine.search_id })).statusCode).toBe(200);
    const replay = await post('timeline', twoTenants, { search_id: mine.search_id }, other);
    expect(replay.statusCode, replay.body).toBe(404);
    expect(replay.json()).toMatchObject({ code: 'search_expired' });
    expect((await post('export', twoTenants, { search_id: mine.search_id }, other)).statusCode).toBe(404);
  });

  it('a partial number is invalid_number / too_short; a bad body invalid_search_request; a bad cursor invalid_cursor', async () => {
    const short = await post('search', sup(), { by: 'phone', value: '43210', country: 'IN' });
    expect(short.statusCode).toBe(400);
    expect(short.json()).toEqual({
      error: 'Bad Request', code: 'invalid_number', number_error: 'too_short',
      message: "Enter the full number. Searching by the last few digits isn't supported.",
    });
    const bad = await post('search', sup(), { by: 'column', value: 'LN-0042' });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ error: 'Bad Request', code: 'invalid_search_request' });
    const mine = await search(sup());
    const cursor = await post('timeline', sup(), { search_id: mine.search_id, cursor: 'eyJub3BlIjp0cnVlfQ' });
    expect(cursor.statusCode).toBe(400);
    expect(cursor.json()).toMatchObject({ code: 'invalid_cursor' });
    const limit = await post('timeline', sup(), { search_id: mine.search_id, limit: 500 });
    expect(limit.json()).toMatchObject({ code: 'invalid_search_request' });
  });

  it('a country the search does not offer is refused, never searched as an Indian number', async () => {
    const res = await post('search', sup(), { by: 'phone', value: '2079460018', country: 'ZZ' });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json()).toEqual({ error: 'Bad Request', code: 'invalid_search_request', message: 'country: not a country the search offers' });
  });

  it('a body that is not JSON is the family\'s invalid_search_request, on every POST', async () => {
    for (const path of ['search', 'timeline', 'export']) {
      for (const raw of ['{"by": "phone", "value": ', '']) {
        const res = await post(path, sup(), raw);
        expect(res.statusCode, `${path} ${JSON.stringify(raw)}`).toBe(400);
        expect(res.json()).toEqual({ error: 'Bad Request', code: 'invalid_search_request', message: 'The request body is not valid JSON.' });
      }
    }
    // Prototype poisoning is still refused by the same parser.
    const poisoned = await post('search', sup(), '{"by":"phone","value":"9876543210","__proto__":{"x":1}}');
    expect(poisoned.json()).toMatchObject({ code: 'invalid_search_request' });
  });

  it('403 feature_disabled while the dialer flag is off', async () => {
    const off = floors[2]!;
    const res = await post('search', off.supervisors[0]!, { by: 'phone', value: TYPED }, off);
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json()).toMatchObject({ code: 'feature_disabled' });
  });
});

describe('the search box\'s options', () => {
  it('GET /customers/options answers the platform default calling code, to any member, without charging the cap', async () => {
    const res = await loaded.app.inject({ method: 'GET', url: '/proxy/agency/customers/options', headers: headersFor(rateUser, floor) });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ default_country_code: '+91' });
  });
});

describe('audit (CH10) and export', () => {
  it('a search and an export each write a row with the account context, the E.164 and the result count', async () => {
    const body = await search(sup());
    const exp = await post('export', sup(), { search_id: body.search_id, filters: { channel: 'softphone' } });
    expect(exp.statusCode, exp.body).toBe(200);
    await drainAudits();
    const { rows } = await q(
      `SELECT action, resource_type, user_id, actor_type, account_id, details FROM platform_audit_log
        WHERE tenant_id = $1 AND resource_id = $2 ORDER BY action DESC`, [floor.tenant, body.search_id]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ action: 'agency_customer_history.searched', resource_type: 'customer_history', user_id: sup().id, actor_type: 'human',
      account_id: floor.account,
      details: { by: 'phone', value: NUMBER, result_count: expectedA().length, accounts: [floor.account], role: 'account_admin' } });
    expect(rows[1]).toMatchObject({ action: 'agency_customer_history.exported', resource_type: 'customer_history', account_id: floor.account,
      details: { by: 'phone', value: NUMBER, result_count: expectedA().length, rows: 2, filters: { channel: 'softphone' }, truncated: false } });
  });

  it('a search with no results is audited too', async () => {
    const body = await search(sup(), '+1 415 555 2671');
    expect(body.summary.contacts).toEqual([]);
    expect(body.timeline).toEqual({ entries: [], next_cursor: null });
    await drainAudits();
    const { rows } = await q(`SELECT details FROM platform_audit_log WHERE resource_id = $1`, [body.search_id]);
    expect(rows).toEqual([{ details: expect.objectContaining({ value: '+14155552671', result_count: 0 }) }]);
  });

  it('an export\'s filters are bounded on the audit row, a cut list marked rather than silently clipped', async () => {
    const body = await search(owner);
    const campaignIds = Array.from({ length: 51 }, () => randomUUID());
    const exp = await post('export', owner, { search_id: body.search_id, filters: { campaign_ids: campaignIds } });
    expect(exp.statusCode, exp.body).toBe(200);
    await drainAudits();
    const { rows } = await q(
      `SELECT details FROM platform_audit_log WHERE resource_id = $1 AND action = 'agency_customer_history.exported'`, [body.search_id]);
    expect(rows).toHaveLength(1);
    expect(rows[0].details.filters).toEqual({ campaign_ids: [...campaignIds.slice(0, 50), '…[1 more truncated]'] });
  });

  it('the CSV: British English headers, the filename carries no number, cut at the cap with X-Export-Truncated', async () => {
    const body = await search(owner);
    const res = await post('export', owner, { search_id: body.search_id });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(res.headers['content-disposition']).toMatch(/^attachment; filename="customer-history-\d{4}-\d{2}-\d{2}\.csv"/);
    expect(res.headers['content-disposition']).not.toContain('98765');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-export-rows']).toBe(String(EXPORT_MAX));
    expect(res.headers['x-export-truncated']).toBe('true');
    const lines = res.body.trimEnd().split('\n');
    expect(lines[0]).toBe('When (UTC),Entry,Number,Account,Campaign,Agent,Outcome,Outcome code,Talk time (seconds),Notes,Callback due (UTC),Callback status,Recording,Details');
    expect(lines).toHaveLength(EXPORT_MAX + 1);
    // Under the cap: no truncation header.
    const small = await post('export', owner, { search_id: body.search_id, filters: { channel: 'softphone' } });
    expect(small.headers['x-export-truncated']).toBeUndefined();
    expect(small.headers['x-export-rows']).toBe('4');
    // The newest rows come first, in the timeline's order.
    const full = await post('timeline', owner, { search_id: body.search_id, limit: EXPORT_MAX });
    expect(lines.slice(1).map((l: string) => l.slice(0, 24)))
      .toEqual(full.json().entries.map((e: { at: string }) => e.at));
  });
});

describe('the rate limit (CH11)', () => {
  it('refuses the search after the configured max a minute, per user, with retryAfter and a friendly message', async () => {
    for (let i = 0; i < SEARCH_MAX; i++) {
      const res = await post('search', rateUser, { by: 'phone', value: TYPED });
      expect(res.statusCode, `search ${i + 1}`).toBe(200);
    }
    const refused = await post('search', rateUser, { by: 'phone', value: TYPED });
    expect(refused.statusCode).toBe(429);
    const body = refused.json();
    expect(body).toMatchObject({ error: 'Too Many Requests', retryAfter: expect.any(Number) });
    expect(body.message).toMatch(/^You've searched a lot of numbers in a short time\. Try again in (\d+ seconds?|a minute)\.$/);
    expect(refused.headers['retry-after']).toBeDefined();
    // The export is charged to the same bucket; the timeline and the options are not.
    const exp = await post('export', rateUser, { search_id: 'chs_00112233445566778899aabbccddeeff' });
    expect(exp.statusCode).toBe(429);
    const page = await post('timeline', rateUser, { search_id: 'chs_00112233445566778899aabbccddeeff' });
    expect(page.statusCode).toBe(404);
    const options = await loaded.app.inject({ method: 'GET', url: '/proxy/agency/customers/options', headers: headersFor(rateUser, floor) });
    expect(options.statusCode).toBe(200);
    // Another user is not affected.
    expect((await post('search', agent(1), { by: 'phone', value: TYPED })).statusCode).toBe(200);
  });
});

describe('the route table', () => {
  it('the number never travels in a URL (CH6): three POSTs and one GET, no params; no request this suite sent carried the number', async () => {
    const family = routes.filter((r) => r.url.startsWith('/proxy/agency/customers') && r.method !== 'HEAD');
    expect(family.map((r) => `${String(r.method)} ${r.url}`).sort()).toEqual([
      'GET /proxy/agency/customers/options',
      'POST /proxy/agency/customers/export', 'POST /proxy/agency/customers/search', 'POST /proxy/agency/customers/timeline',
    ]);
    for (const r of family) expect(r.url).not.toContain(':');
    // A GET with the number in the query string is not a route.
    const get = await loaded.app.inject({ method: 'GET', url: `/proxy/agency/customers/search?value=${encodeURIComponent(NUMBER)}`, headers: headersFor(sup(), floor) });
    expect(get.statusCode).toBe(404);
    expect(urls.length).toBeGreaterThan(10);
    for (const url of urls) {
      expect(url).not.toMatch(/9876543210|98765|43210/);
    }
  });

  it('every route of the family checks agency.customer_history.read in its pre-handler', () => {
    const family = routes.filter((r) => r.url.startsWith('/proxy/agency/customers') && r.method !== 'HEAD');
    expect(family).toHaveLength(4);
    for (const r of family) {
      const handlers = [r.preHandler].flat().filter(Boolean) as Array<{ name?: string; permission?: string }>;
      expect(handlers.map((h) => [h.name, h.permission]), `${String(r.method)} ${r.url}`)
        .toContainEqual(['rbacPreHandler', 'agency.customer_history.read']);
    }
  });
});

// ─── CH9: every read uses an index ─────────────────────────────────────────────

/** The plan of `sql` as the repository runs it: every plan type allowed, on analysed tables. */
/** The tables the plans read; ANALYZEd inside each plan's rolled-back transaction (see {@link planOf}). */
const PLANNED_TABLES = 'agency_contacts, agency_call_attempts, agency_manual_calls, dnc_entries, agency_campaigns, '
  + 'agency_calls, agency_ingest_jobs, agency_agent_sessions';

/**
 * The plan the repository gets on this file's analysed seed. Never a bare ANALYZE (the rule in
 * `insights-reads.test.ts`): statistics outlive the rows, so a later file's plan test would plan
 * on this file's bulk seed. ANALYZE runs inside the transaction and the ROLLBACK discards it.
 */
async function planOf(sql: string, params: unknown[]): Promise<string> {
  const client: PoolClient = await getTestPool().connect();
  try {
    await client.query('BEGIN');
    await client.query(`ANALYZE ${PLANNED_TABLES}`);
    const { rows } = await client.query<{ 'QUERY PLAN': string }>(`EXPLAIN (COSTS OFF) ${sql}`, params);
    return rows.map((r) => r['QUERY PLAN']).join('\n');
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

/** The contact walk (CH14): an account's slice of the 0017 index, newest first, directly under its `Limit` (no sort). */
const CONTACT_WALK = /Limit[^\n]*\n\s+->\s+Index (Only )?Scan using idx_agency_contacts_customer_history/;

const BIG_TABLES = /Seq Scan on (agency_contacts|agency_call_attempts|agency_manual_calls|dnc_entries|agency_calls|agency_ingest_jobs|agency_campaigns|agency_agent_sessions)\b/;

describe('every read uses its index (CH9)', () => {
  const accounts = () => [floor.account, accountB];
  const pageParams = () => [floor.tenant, NUMBER, accounts(), 'infinity', UUID_MAX, 51, null, null, null];
  const callParams = () => [...pageParams(), null, null, null, false];

  // A tenant with a real amount of other rows (other numbers' contacts, attempts, soft-phone calls
  // and DNC entries, other campaigns, other calls' media legs, other imports), and real
  // statistics, as production has: on a near-empty, never-analysed table the planner prices a
  // full scan below any index, and the plan says nothing about production. Nothing is disabled:
  // these are the plans the repository gets.
  beforeAll(async () => {
    const C0 = floor.campaigns[0]!;
    const sess = await session(floor, C0, agent(0).id);
    const soft = await softphoneSession(floor.account, agent(0).id);
    await q(`INSERT INTO agency_contacts (id, tenant_id, account_id, campaign_id, phone_e164, context)
             SELECT ('00000000-0000-4000-9000-' || lpad(g::text, 12, '0'))::uuid, $1, $2, $3, '+9171' || lpad(g::text, 8, '0'), '{}'::jsonb
               FROM generate_series(1, 6000) g`, [floor.tenant, floor.account, C0]);
    await q(`INSERT INTO agency_call_attempts (tenant_id, account_id, campaign_id, contact_id, attempt_number, caller_id, state,
                                               reserved_agent_id, dialed_at, ended_at, callback_at)
             SELECT $1, $2, $3, ('00000000-0000-4000-9000-' || lpad(((g % 6000) + 1)::text, 12, '0'))::uuid, g / 6000 + 1, '+919000000001',
                    'ended', $4, now(), now(), CASE WHEN g % 10 = 0 THEN now() END
               FROM generate_series(1, 18000) g`, [floor.tenant, floor.account, C0, sess]);
    await q(`INSERT INTO agency_manual_calls (tenant_id, account_id, session_id, agent_user_id, destination_e164, caller_id, state,
                                              dialed_at, ended_at, settled_at)
             SELECT $1, $2, $3, $4, '+9172' || lpad((g % 3000)::text, 8, '0'), '+919000000001', 'ended', now(), now(), now()
               FROM generate_series(1, 6000) g`, [floor.tenant, floor.account, soft, agent(0).id]);
    await q(`INSERT INTO dnc_entries (tenant_id, account_id, phone_e164, source)
             SELECT $1, $2, '+9170' || lpad(g::text, 8, '0'), 'api' FROM generate_series(1, 3000) g`, [floor.tenant, floor.account]);
    await q(`INSERT INTO agency_agent_sessions (tenant_id, account_id, campaign_id, agent_user_id, state, left_at)
             SELECT $1, $2, $3, gen_random_uuid(), 'offline', now() FROM generate_series(1, 3000) g`, [floor.tenant, floor.account, C0]);
    await q(`INSERT INTO agency_campaigns
             SELECT (jsonb_populate_record(c, jsonb_build_object('id', gen_random_uuid(), 'name', 'Bulk ' || g))).*
               FROM agency_campaigns c, generate_series(1, 3000) g WHERE c.id = $1`, [C0]);
    await q(`INSERT INTO agency_calls (tenant_id, account_id, caller_id, destination_phone)
             SELECT $1, $2, '+919000000001', '+9170' || lpad(g::text, 8, '0') FROM generate_series(1, 3000) g`, [floor.tenant, floor.account]);
    await q(`INSERT INTO agency_ingest_jobs (tenant_id, account_id, campaign_id, s3_key, file_name, phone_column, status)
             SELECT $1, $2, gen_random_uuid(), 'k/' || g, 'bulk-' || g || '.csv', 'phone', 'completed' FROM generate_series(1, 3000) g`,
      [floor.tenant, floor.account]);
  }, 120_000);

  const noFullScan = (plan: string) => expect(plan, plan).not.toMatch(BIG_TABLES);

  it('summary contacts: each account\'s slice of idx_agency_contacts_customer_history under its limit; each row\'s placed attempts by uq_agency_attempt_number', async () => {
    const plan = await planOf(CUSTOMER_HISTORY_SQL.summaryContacts, [floor.tenant, NUMBER, accounts(), 2001]);
    expect(plan).toMatch(CONTACT_WALK);
    expect(plan).toMatch(/Index Cond: .*account_id = acc\.id.*phone_e164/);
    expect(plan).toContain('uq_agency_attempt_number');
    noFullScan(plan);
  });

  it('call aggregates, the newest placed call, live calls, the callback judgement: contacts, attempts and both soft-phone indexes', async () => {
    for (const [name, sql, params] of [
      ['callStats', CUSTOMER_HISTORY_SQL.callStats, [floor.tenant, NUMBER, accounts()]],
      ['lastPlaced', CUSTOMER_HISTORY_SQL.lastPlaced, [floor.tenant, NUMBER, accounts()]],
      ['liveCalls', CUSTOMER_HISTORY_SQL.liveCalls, [floor.tenant, NUMBER, accounts()]],
      ['callbackNext', CUSTOMER_HISTORY_SQL.callbackNext, [floor.tenant, NUMBER, accounts(), [ids.a3], [at(3 * DAY).toISOString()]]],
    ] as const) {
      const plan = await planOf(sql, [...params]);
      expect(plan, name).toMatch(CONTACT_WALK);
      // Live attempts may come by contact or from a live-only partial index (a tenant's live calls;
      // 0005's idx_agency_attempts_account_live is one, chosen when the statistics favour it).
      expect(plan, name).toMatch(/uq_agency_attempt_(number|live)|idx_agency_attempts_(agent|live|account_live)\b/);
      expect(plan, name).toContain('idx_agency_manual_calls_destination');
      expect(plan, name).toContain('idx_agency_manual_calls_contact_history');
      noFullScan(plan);
    }
  });

  it('who booked a callback: attempts and soft-phone calls by contact', async () => {
    const plan = await planOf(CUSTOMER_HISTORY_SQL.latestBookings, [floor.tenant, accounts(), [ids.cA, ids.cAr]]);
    expect(plan).toContain('uq_agency_attempt_number');
    expect(plan).toContain('idx_agency_manual_calls_contact_history');
    noFullScan(plan);
  });

  it('DNC (summary and page): idx_dnc_entries_tenant_phone, the mark\'s campaign by primary key', async () => {
    for (const [sql, params] of [
      [CUSTOMER_HISTORY_SQL.dnc, [floor.tenant, NUMBER, accounts()]],
      [CUSTOMER_HISTORY_SQL.pageDnc, pageParams()],
    ] as const) {
      const plan = await planOf(sql, [...params]);
      expect(plan).toContain('idx_dnc_entries_tenant_phone');
      noFullScan(plan);
    }
  });

  it('timeline attempts and their callbacks: the number\'s contacts, then attempts by contact', async () => {
    for (const [sql, params] of [[CUSTOMER_HISTORY_SQL.pageAttempts, callParams()], [CUSTOMER_HISTORY_SQL.pageCallbacks, pageParams()]] as const) {
      const plan = await planOf(sql, [...params]);
      expect(plan).toMatch(CONTACT_WALK);
      expect(plan).toContain('uq_agency_attempt_number');
      noFullScan(plan);
    }
  });

  it('timeline soft-phone calls: each account\'s destination slice and each contact\'s calls walked in keyset order, the cursor in the index condition, no sort under the limit', async () => {
    const plan = await planOf(CUSTOMER_HISTORY_SQL.pageManualCalls, callParams());
    expect(plan).toMatch(/Limit\n\s+->\s+Index (Only )?Scan using idx_agency_manual_calls_destination/);
    expect(plan).toMatch(/Limit\n\s+->\s+Index (Only )?Scan using idx_agency_manual_calls_contact_history/);
    expect(plan).toMatch(/Index Cond: .*destination_e164.*ROW\(created_at, id\) < ROW\(/);
    noFullScan(plan);
    const callbacks = await planOf(CUSTOMER_HISTORY_SQL.pageCallbacks, pageParams());
    expect(callbacks).toContain('idx_agency_manual_calls_destination');
    expect(callbacks).toContain('idx_agency_manual_calls_contact_history');
    noFullScan(callbacks);
  });

  it('timeline roster rows: the covered rows by idx_agency_contacts_customer_history, then by primary key', async () => {
    const plan = await planOf(CUSTOMER_HISTORY_SQL.pageContacts, pageParams());
    expect(plan).toMatch(CONTACT_WALK);
    expect(plan).toContain('agency_contacts_pkey');
    noFullScan(plan);
  });

  it('a placeholder on 5,000 roster rows (CH14): every statement walks at most the cap of them, newest first, and sorts no more', async () => {
    const C0 = floor.campaigns[0]!;
    const sess = await session(floor, C0, agent(0).id);
    const soft = await softphoneSession(floor.account, agent(0).id);
    const client: PoolClient = await getTestPool().connect();
    const plans: Array<[string, string]> = [];
    try {
      // Everything is seeded and planned inside one transaction that is rolled back: no row and no
      // statistic of this seed outlives the test.
      await client.query('BEGIN');
      // A roster table of a realistic size around the placeholder: at 13,000 rows, reading the whole
      // table costs less than fetching 2,000 rows by index, which at production size (a million
      // roster rows) is never true.
      await client.query(`INSERT INTO agency_contacts (tenant_id, account_id, campaign_id, phone_e164, context)
               SELECT $1, $2, $3, '+9173' || lpad(g::text, 8, '0'), '{}'::jsonb FROM generate_series(1, 200000) g`,
        [floor.tenant, floor.account, C0]);
      // 5,000 roster rows of the placeholder in account A, one placed attempt each (a callback on every
      // tenth), and soft-phone calls dialled to it.
      await client.query(`INSERT INTO agency_contacts (id, tenant_id, account_id, campaign_id, phone_e164, context, created_at)
               SELECT ('00000000-0000-4000-9100-' || lpad(g::text, 12, '0'))::uuid, $1, $2, $3, $4, '{}'::jsonb,
                      $5::timestamptz + (g || ' seconds')::interval
                 FROM generate_series(1, 5000) g`, [floor.tenant, floor.account, C0, NUMBER_PLACEHOLDER, at(2 * DAY)]);
      await client.query(`INSERT INTO agency_call_attempts (tenant_id, account_id, campaign_id, contact_id, attempt_number, caller_id, state,
                                                 reserved_agent_id, outcome, dialed_at, ended_at, callback_at, created_at)
               SELECT $1, $2, $3, ('00000000-0000-4000-9100-' || lpad(g::text, 12, '0'))::uuid, 1, '+919000000001', 'ended', $4,
                      'connected', $5::timestamptz + (g || ' seconds')::interval, $5::timestamptz + (g || ' seconds')::interval,
                      CASE WHEN g % 10 = 0 THEN now() END, $5::timestamptz + (g || ' seconds')::interval
                 FROM generate_series(1, 5000) g`, [floor.tenant, floor.account, C0, sess, at(3 * DAY)]);
      await client.query(`INSERT INTO agency_manual_calls (tenant_id, account_id, session_id, agent_user_id, destination_e164, caller_id, state,
                                                dialed_at, ended_at, settled_at, created_at)
               SELECT $1, $2, $3, $4, $5, '+919000000001', 'ended', now(), now(), now(), $6::timestamptz + (g || ' seconds')::interval
                 FROM generate_series(1, 20) g`, [floor.tenant, floor.account, soft, agent(0).id, NUMBER_PLACEHOLDER, at(4 * DAY)]);
      const oldestAttempt = (await client.query(
        `SELECT id FROM agency_call_attempts WHERE contact_id = '00000000-0000-4000-9100-000000000001'`)).rows[0]!.id;
      await client.query(`ANALYZE ${PLANNED_TABLES}`);

      const onlyA = [floor.account];
      const page = [floor.tenant, NUMBER_PLACEHOLDER, onlyA, 'infinity', UUID_MAX, 51, null, null, null];
      const calls = [...page, null, null, null, false];
      const number = [floor.tenant, NUMBER_PLACEHOLDER, onlyA];
      for (const [name, sql, params] of [
        ['summaryContacts', CUSTOMER_HISTORY_SQL.summaryContacts, [...number, CUSTOMER_HISTORY_MAX_CONTACT_ROWS + 1]],
        ['callStats', CUSTOMER_HISTORY_SQL.callStats, number],
        ['lastPlaced', CUSTOMER_HISTORY_SQL.lastPlaced, number],
        ['liveCalls', CUSTOMER_HISTORY_SQL.liveCalls, number],
        ['callbackNext', CUSTOMER_HISTORY_SQL.callbackNext, [...number, [oldestAttempt], [at(3 * DAY).toISOString()]]],
        ['pageAttempts', CUSTOMER_HISTORY_SQL.pageAttempts, calls],
        ['pageCallbacks', CUSTOMER_HISTORY_SQL.pageCallbacks, page],
        ['pageManualCalls', CUSTOMER_HISTORY_SQL.pageManualCalls, calls],
        ['pageContacts', CUSTOMER_HISTORY_SQL.pageContacts, page],
      ] as const) {
        const { rows } = await client.query<{ 'QUERY PLAN': string }>(
          `EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF, SUMMARY OFF) ${sql}`, [...params]);
        plans.push([name, rows.map((r) => r['QUERY PLAN']).join('\n')]);
      }
    } finally {
      await client.query('ROLLBACK');
      // The rolled-back seed still leaves its pages behind, and the planner sizes a table by its
      // pages: a later file's plan (insights-reads' pace) saw a 200,000-row roster table. VACUUM
      // removes the dead rows and gives back the empty pages.
      await client.query('VACUUM agency_contacts, agency_call_attempts, agency_manual_calls');
      client.release();
    }
    for (const [name, plan] of plans) {
      const why = `${name}\n${plan}`;
      expect(plan, why).toMatch(CONTACT_WALK);
      expect(plan, why).not.toMatch(/Seq Scan on agency_contacts\b/);
      // Every read of the roster table stops at the cap (+1: the summary's look-ahead): the walk, one loop
      // for the one visible account, and any read of covered rows by primary key.
      const walks = [...plan.matchAll(/Index (?:Only )?Scan using idx_agency_contacts_customer_history[^\n]*\(actual rows=(\d+) loops=(\d+)\)/g)];
      expect(walks.length, why).toBeGreaterThan(0);
      for (const [, rows, loops] of plan.matchAll(/ on agency_contacts \w+ \(actual rows=(\d+) loops=(\d+)\)/g)) {
        expect(Number(rows) * Number(loops), why).toBeLessThanOrEqual(CUSTOMER_HISTORY_MAX_CONTACT_ROWS + 1);
      }
      // No sort of every match, nor of every match's attempt: what is sorted is the covered rows and their calls.
      for (const [, rows, loops] of plan.matchAll(/Sort \(actual rows=(\d+) loops=(\d+)\)/g)) {
        expect(Number(rows) * Number(loops), why).toBeLessThan(5000);
      }
      // How the covered rows' attempts are joined is the planner's call at this size (23,000 attempts:
      // one hash join over them is cheaper than 2,000 probes); on the ordinary number above, and at
      // the bench's scale, they are probed by contact (uq_agency_attempt_number).
    }
  }, 120_000);

  it('campaigns (and with their roots), media legs by primary key; uploads by idx_agency_ingest_jobs_campaign', async () => {
    const campaigns = await planOf(CUSTOMER_HISTORY_SQL.campaigns, [floor.tenant, accounts(), [floor.campaigns[0], retryCampaign]]);
    expect(campaigns).toContain('agency_campaigns_pkey');
    const withRoots = await planOf(CUSTOMER_HISTORY_SQL.campaignsWithRoots, [floor.tenant, accounts(), [retryCampaign, campaignB]]);
    expect(withRoots).toContain('agency_campaigns_pkey');
    noFullScan(withRoots);
    const legs = await planOf(CUSTOMER_HISTORY_SQL.mediaLegs, [floor.tenant, accounts(), [ids.leg1, ids.leg2]]);
    expect(legs).toContain('agency_calls_pkey');
    const uploads = await planOf(CUSTOMER_HISTORY_SQL.uploads, [floor.tenant, accounts(), [floor.campaigns[0], campaignB]]);
    expect(uploads).toContain('idx_agency_ingest_jobs_campaign');
    for (const plan of [campaigns, legs, uploads]) noFullScan(plan);
  });
});
