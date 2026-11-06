import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { RouteOptions } from 'fastify';

/**
 * ─── Customer history through the real app and real Postgres ───────────────────
 *
 * `POST /proxy/agency/customers/{search,timeline,export}` (`docs/customer-history.md`): session
 * middleware with Firebase stubbed, tenant context, RBAC, the dialer flag, the per-user search cap,
 * the Redis search store and the repository's reads on real Postgres.
 *
 * One number (`+919876543210`) in two accounts of one tenant and in another tenant: an
 * account-scoped caller sees only their account's rows (never counted as hidden), a tenant-level
 * caller sees both, and the other tenant's never; every timeline kind in one order, a wrap-up
 * redial chain, a tagged and an untagged soft-phone call, DNC marks, a callback; keyset pages with
 * no duplicates or skips across entries sharing one instant; the filters; what an agent is shown
 * (CH8); the search id bound to its user; the audit rows; the rate limit; the export; an EXPLAIN
 * per read (CH9); and the number never in a URL (CH6).
 */

const mocks = vi.hoisted(() => {
  process.env['SUPER_ADMIN_JWT_SECRET'] = 'customer-history-secret-0123456789';
  return { verifyIdToken: vi.fn() };
});
vi.mock('../../../src/auth/firebase.js', () => ({ initFirebase: vi.fn(), verifyIdToken: mocks.verifyIdToken }));

import { getTestPool, truncateAll } from '../../../../../packages/db/test/helpers/test-db.js';
import {
  drainAudits, headersFor, seedFloor, startLoadApp, stopLoadApp, verifyTestToken,
  type Actor, type LoadApp, type TenantFloor,
} from '../load/load-harness.js';
import { agencyCustomerHistoryRepository, CUSTOMER_HISTORY_SQL } from '../../../src/db/repositories/agency.repository.js';

const SEARCH_MAX = 12;
const EXPORT_MAX = 15;
const NUMBER = '+919876543210';
const TYPED = '098765-43210';

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
const sup = () => floor.supervisors[0]!;
const agent = (i: number) => floor.agents[i]!;

const ids = {
  cA: randomUUID(), cAr: randomUUID(), cB: randomUUID(), noise: randomUUID(), foreign: randomUUID(),
  a1: randomUUID(), a2: randomUUID(), a3: randomUUID(), bA1: randomUUID(),
  shared: Array.from({ length: 6 }, () => randomUUID()),
  m1: randomUUID(), m2: randomUUID(), mB: randomUUID(), mB2: randomUUID(),
  dncA: randomUUID(), dncTenant: randomUUID(), dncB: randomUUID(),
  leg1: randomUUID(), leg2: randomUUID(), legB: randomUUID(),
};

const DAY = 86_400_000;
const T0 = new Date(Date.now() - 30 * DAY);
const at = (ms: number) => new Date(T0.getTime() + ms);

async function post(path: string, actor: Actor, body: unknown, f: TenantFloor = floor, extra: Record<string, string> = {}) {
  const url = `/proxy/agency/customers/${path}`;
  urls.push(url);
  return loaded.app.inject({
    method: 'POST',
    url,
    headers: headersFor(actor, f, { 'content-type': 'application/json', ...extra }),
    payload: JSON.stringify(body),
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
  const uid = `ch-${name}-${id.slice(0, 8)}`;
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

async function contact(id: string, f: { tenant: string }, accountId: string, campaignId: string, phone: string, createdAt: Date, extra: Record<string, unknown> = {}) {
  const cols = ['id', 'tenant_id', 'account_id', 'campaign_id', 'phone_e164', 'context', 'created_at', ...Object.keys(extra)];
  const vals = [id, f.tenant, accountId, campaignId, phone, JSON.stringify({ Name: 'Asha Rao', 'Loan No': 'LN-0042' }), createdAt, ...Object.values(extra)];
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
  await q(`UPDATE agency_campaigns SET name = 'October dues', context_display = '{"hero":["Name","Loan No"]}'::jsonb WHERE id = $1`, [C0]);

  // Account B in the same tenant, with its own campaign and supervisor.
  accountB = randomUUID();
  await q(`INSERT INTO accounts (id, tenant_id, name, slug, settings, status) VALUES ($1, $2, 'South', $3, '{}'::jsonb, 'active')`,
    [accountB, floor.tenant, `south-${accountB.slice(0, 8)}`]);
  campaignB = randomUUID();
  await q(`INSERT INTO agency_campaigns
           SELECT (jsonb_populate_record(c, jsonb_build_object('id', $2::uuid, 'account_id', $3::uuid, 'name', 'South campaign'))).*
             FROM agency_campaigns c WHERE c.id = $1`, [C0, campaignB, accountB]);
  // A retry of C0.
  retryCampaign = randomUUID();
  await q(`INSERT INTO agency_campaigns
           SELECT (jsonb_populate_record(c, jsonb_build_object('id', $2::uuid, 'name', 'October dues (retry 1)',
                   'root_campaign_id', $1::uuid, 'parent_campaign_id', $1::uuid, 'retry_generation', 1, 'status', 'running'))).*
             FROM agency_campaigns c WHERE c.id = $1`, [C0, retryCampaign]);

  owner = await user('tenant_owner', null, 'Owner');
  rateUser = await user('agent', floor.account, 'Rate');

  const a0 = agent(0).id;
  const a1 = agent(1).id;
  const s0 = await session(floor, C0, a1);
  const sRetry = await session(floor, retryCampaign, a0);

  // ── Account A ──
  await contact(ids.cA, floor, floor.account, C0, NUMBER, T0);
  await attempt({ id: ids.a1, campaign_id: C0, contact_id: ids.cA, attempt_number: 1, reserved_agent_id: s0,
    outcome: 'connected', disposition_code: 'ptp', notes: 'A1 notes', webrtc_call_id: ids.leg1,
    dialed_at: at(DAY), ended_at: at(DAY + 60_000), created_at: at(DAY) });
  await attempt({ id: ids.a2, campaign_id: C0, contact_id: ids.cA, attempt_number: 2, reserved_agent_id: s0,
    outcome: 'connected', disposition_code: 'ptp', notes: 'A2 notes', webrtc_call_id: ids.leg2,
    redial_of_attempt_id: ids.a1, redial_number: 1,
    dialed_at: at(DAY + 300_000), ended_at: at(DAY + 360_000), created_at: at(DAY + 300_000) });
  // Six attempts sharing one instant to the microsecond.
  for (const [i, id] of ids.shared.entries()) {
    await attempt({ id, campaign_id: C0, contact_id: ids.cA, attempt_number: 10 + i, outcome: 'no_answer',
      dialed_at: at(5 * DAY), ended_at: at(5 * DAY), created_at: at(5 * DAY) });
  }
  await q(`INSERT INTO agency_calls (id, tenant_id, account_id, caller_id, destination_phone, recording_url)
           VALUES ($1, $2, $3, '+919000000001', $4, 'https://recordings.example.com/1')`, [ids.leg1, floor.tenant, floor.account, NUMBER]);
  // leg2 has no agency_calls row: purged by retention → "expired".
  await q(`INSERT INTO dnc_entries (id, tenant_id, account_id, campaign_id, phone_e164, source, reason, added_by, created_at)
           VALUES ($1, $2, $3, $4, $5, 'agent', 'Asked not to be called', $6, $7)`,
    [ids.dncA, floor.tenant, floor.account, C0, NUMBER, sup().id, at(2 * DAY)]);
  await q(`INSERT INTO dnc_entries (id, tenant_id, account_id, campaign_id, phone_e164, source, reason, added_by, created_at)
           VALUES ($1, $2, NULL, NULL, $3, 'regulator', 'National registry', 'import:registry.csv', $4)`,
    [ids.dncTenant, floor.tenant, NUMBER, at(7 * DAY)]);
  // The retry chain: a copy of cA in the retry campaign, its callback booked by agent 0.
  await contact(ids.cAr, floor, floor.account, retryCampaign, NUMBER, at(10 * DAY), {
    root_contact_id: ids.cA, source_contact_id: ids.cA, last_disposition: 'callback', last_outcome: 'connected',
    next_attempt_at: new Date(Date.now() + DAY), assigned_user_id: a0, assigned_at: at(10 * DAY),
  });
  await attempt({ id: ids.a3, campaign_id: retryCampaign, contact_id: ids.cAr, attempt_number: 1, reserved_agent_id: sRetry,
    outcome: 'connected', disposition_code: 'callback', notes: 'A3 notes', callback_at: new Date(Date.now() + DAY),
    dispositioned_by_user_id: a0, dispositioned_at: at(20 * DAY + 120_000),
    dialed_at: at(20 * DAY), ended_at: at(20 * DAY + 60_000), created_at: at(20 * DAY) });
  // Soft phone: a tagged call (agent 1, logged to cA) and an untagged one (agent 0).
  await manualCall({ id: ids.m2, session_id: await softphoneSession(floor.account, a1), agent_user_id: a1,
    campaign_id: C0, contact_id: ids.cA, outcome: 'no_answer', notes: 'M2 notes', fields: JSON.stringify({ promised: 5 }),
    disposition_source: 'campaign', disposition_code: 'ptp',
    dialed_at: at(15 * DAY), ended_at: at(15 * DAY), settled_at: at(15 * DAY), created_at: at(15 * DAY) });
  await manualCall({ id: ids.m1, session_id: await softphoneSession(floor.account, a0), agent_user_id: a0,
    outcome: 'connected', notes: 'M1 mine', fields: JSON.stringify({ amount: 10 }),
    dialed_at: at(25 * DAY), ended_at: at(25 * DAY), settled_at: at(25 * DAY), created_at: at(25 * DAY) });
  // Noise: another number in A.
  await contact(ids.noise, floor, floor.account, C0, '+919876543211', at(6 * DAY));

  // ── Account B ──
  await contact(ids.cB, floor, accountB, campaignB, NUMBER, at(3 * DAY));
  await attempt({ id: ids.bA1, account_id: accountB, campaign_id: campaignB, contact_id: ids.cB, attempt_number: 1,
    outcome: 'connected', notes: 'B notes', dialed_at: at(4 * DAY), ended_at: at(4 * DAY), created_at: at(4 * DAY) });
  await manualCall({ id: ids.mB, account_id: accountB, session_id: await softphoneSession(accountB, owner.id), agent_user_id: owner.id,
    outcome: 'busy', dialed_at: at(4 * DAY + 1000), ended_at: at(4 * DAY + 1000), settled_at: at(4 * DAY + 1000), created_at: at(4 * DAY + 1000) });
  // A call in B logged to B's contact but dialled to another number: found only through the contact.
  await manualCall({ id: ids.mB2, account_id: accountB, session_id: await softphoneSession(accountB, owner.id), agent_user_id: owner.id,
    campaign_id: campaignB, contact_id: ids.cB, destination_e164: '+919876543299', outcome: 'busy',
    dialed_at: at(4 * DAY + 2000), ended_at: at(4 * DAY + 2000), settled_at: at(4 * DAY + 2000), created_at: at(4 * DAY + 2000) });
  await q(`INSERT INTO dnc_entries (id, tenant_id, account_id, phone_e164, source, created_at) VALUES ($1, $2, $3, $4, 'api', $5)`,
    [ids.dncB, floor.tenant, accountB, NUMBER, at(8 * DAY)]);

  // ── Another tenant, the same number ──
  await contact(ids.foreign, other, other.account, other.campaigns[0]!, NUMBER, at(9 * DAY));
}, 120_000);

afterAll(async () => {
  await stopLoadApp(loaded);
});

/** Account A's timeline, newest first (the six shared-instant attempts by key, descending). */
function expectedA(): string[] {
  const shared = ids.shared.map((id) => `campaign_call:${id}`).sort().reverse();
  return [
    `softphone_call:${ids.m1}`,
    `callback:${ids.a3}`,
    `campaign_call:${ids.a3}`,
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

const accountBIds = () => [accountB, campaignB, ids.cB, ids.bA1, ids.mB, ids.mB2, ids.dncB];

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
    const text = JSON.stringify(body);
    for (const id of [...accountBIds(), other.tenant, other.account, ids.foreign, ids.noise]) expect(text).not.toContain(id);
    expect(text).not.toContain('B notes');
    // 9 attempts + 2 soft-phone calls, all placed.
    expect(body.summary.totals).toMatchObject({ calls: 11, connected: 4 });
    expect(body.summary.dnc.map((d: { id: string }) => d.id)).toEqual([ids.dncTenant, ids.dncA]);
  });

  it('a tenant-level owner sees both accounts, never the other tenant', async () => {
    const body = await search(owner);
    expect(body.summary.contacts.map((c: { contact_id: string }) => c.contact_id).sort()).toEqual([ids.cAr, ids.cB].sort());
    const keys = await allPages(owner, body.search_id, 100);
    for (const k of [`roster_entry:${ids.cB}`, `campaign_call:${ids.bA1}`, `softphone_call:${ids.mB}`, `softphone_call:${ids.mB2}`, `dnc_mark:${ids.dncB}`]) {
      expect(keys).toContain(k);
    }
    expect(keys).toHaveLength(expectedA().length + 5);
    const text = JSON.stringify(body);
    for (const id of [other.tenant, other.account, ids.foreign, ids.noise]) expect(text).not.toContain(id);
  });
});

/**
 * Each read on its own, scoped to account A only: no row of account B comes back from ANY of them.
 * The assembler drops a row whose campaign it was not given, so the route-level test above would
 * stay green with one predicate missing; this one goes red (mutation-checked).
 */
describe('every read binds the visible accounts in SQL (CH2)', () => {
  it('contacts, attempts, soft-phone calls, DNC, campaigns, media legs, uploads: account A only', async () => {
    const repo = agencyCustomerHistoryRepository;
    const onlyA = { tenantId: floor.tenant, accountIds: [floor.account] };
    const both = { tenantId: floor.tenant, accountIds: [floor.account, accountB] };
    const contacts = await repo.contactsForNumber(onlyA, NUMBER);
    expect(contacts.map((c) => c.id).sort()).toEqual([ids.cA, ids.cAr].sort());
    expect((await repo.contactsForNumber(both, NUMBER)).map((c) => c.id)).toContain(ids.cB);
    // Asked for B's contact by id, under A's scope: nothing.
    expect((await repo.attemptsForContacts(onlyA, [ids.cB])).map((a) => a.id)).toEqual([]);
    expect((await repo.attemptsForContacts(both, [ids.cB])).map((a) => a.id)).toEqual([ids.bA1]);
    expect((await repo.manualCallsForNumber(onlyA, NUMBER, [ids.cB])).map((m) => m.id).sort()).toEqual([ids.m1, ids.m2].sort());
    expect((await repo.manualCallsForNumber(both, NUMBER, [])).map((m) => m.id)).toContain(ids.mB);
    expect((await repo.manualCallsForNumber(both, NUMBER, [ids.cB])).map((m) => m.id)).toContain(ids.mB2);
    expect((await repo.dncForNumber(onlyA, NUMBER)).map((d) => d.id).sort()).toEqual([ids.dncA, ids.dncTenant].sort());
    expect((await repo.campaignsByIds(onlyA, [campaignB, floor.campaigns[0]!])).map((g) => g.id)).toEqual([floor.campaigns[0]]);
    await q(`INSERT INTO agency_calls (id, tenant_id, account_id, caller_id, destination_phone) VALUES ($1, $2, $3, '+919000000001', $4)`,
      [ids.legB, floor.tenant, accountB, NUMBER]);
    expect((await repo.mediaLegs(onlyA, [ids.leg1, ids.legB])).map((l) => l.id)).toEqual([ids.leg1]);
    await q(`INSERT INTO agency_ingest_jobs (tenant_id, account_id, campaign_id, s3_key, file_name, phone_column) VALUES ($1, $2, $3, 'k', 'south.csv', 'phone')`,
      [floor.tenant, accountB, campaignB]);
    expect(await repo.uploads(onlyA, [campaignB])).toEqual([]);
    expect((await repo.uploads(both, [campaignB])).map((u) => u.file_name)).toEqual(['south.csv']);
    // No visible account: nothing at all (never "every account").
    const none = { tenantId: floor.tenant, accountIds: [] };
    expect(await repo.contactsForNumber(none, NUMBER)).toEqual([]);
    expect((await repo.dncForNumber(none, NUMBER)).map((d) => d.id)).toEqual([ids.dncTenant]);
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
    // The next call placed after the booking is the untagged soft-phone call, days before the
    // callback's time: an early call counts as kept (§4, the insights rule IN4).
    expect(byKey.get(`callback:${ids.a3}`)).toMatchObject({ status: 'kept', dialled_at: at(25 * DAY).toISOString(),
      booked_by: { user_id: agent(0).id }, source: { channel: 'campaign', id: ids.a3 } });
    expect(byKey.get(`softphone_call:${ids.m1}`)).toMatchObject({ campaign: null, contact_id: null, notes: 'M1 mine' });
    expect(byKey.get(`softphone_call:${ids.m2}`)).toMatchObject({ campaign: { id: floor.campaigns[0] }, contact_id: ids.cA });
    expect(byKey.get(`dnc_mark:${ids.dncA}`)).toMatchObject({ entry: { scope: 'campaign', reason: 'Asked not to be called', added_by: 'account_admin 0.0' } });
    expect(byKey.get(`dnc_mark:${ids.dncTenant}`)).toMatchObject({ account_id: null, entry: { scope: 'tenant', added_by: 'import:registry.csv' } });
    expect(body.summary.open.callbacks).toEqual([expect.objectContaining({ contact_id: ids.cAr, owner: { user_id: agent(0).id, name: 'agent 0.0' } })]);
  });

  it('keyset pages: no duplicates, no skips, across entries sharing one instant', async () => {
    const body = await search(sup());
    for (const limit of [1, 2, 3, 5]) {
      expect(await allPages(sup(), body.search_id, limit), `limit ${limit}`).toEqual(expectedA());
    }
  });

  it('filters: a root campaign includes its retry; from/to; call-only filters', async () => {
    const body = await search(sup());
    const id = body.search_id;
    const all = expectedA();
    expect(await allPages(sup(), id, 100, { campaign_ids: [floor.campaigns[0]] }))
      .toEqual(all.filter((k) => ![`softphone_call:${ids.m1}`, `dnc_mark:${ids.dncTenant}`].includes(k)));
    expect(await allPages(sup(), id, 100, { channel: 'softphone' })).toEqual([`softphone_call:${ids.m1}`, `softphone_call:${ids.m2}`]);
    expect(await allPages(sup(), id, 100, { connected_only: true, channel: 'campaign' }))
      .toEqual([`campaign_call:${ids.a3}`, `campaign_call:${ids.a2}`, `campaign_call:${ids.a1}`]);
    expect(await allPages(sup(), id, 100, { agent_user_ids: [agent(0).id] })).toEqual([`softphone_call:${ids.m1}`, `campaign_call:${ids.a3}`]);
    expect(await allPages(sup(), id, 100, { disposition_codes: ['callback'] })).toEqual([`campaign_call:${ids.a3}`]);
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

  it('403 feature_disabled while the dialer flag is off', async () => {
    const off = floors[2]!;
    const res = await post('search', off.supervisors[0]!, { by: 'phone', value: TYPED }, off);
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json()).toMatchObject({ code: 'feature_disabled' });
  });
});

describe('audit (CH10) and export', () => {
  it('a search and an export each write a row with the E.164 and the result count', async () => {
    const body = await search(sup());
    const exp = await post('export', sup(), { search_id: body.search_id, filters: { channel: 'softphone' } });
    expect(exp.statusCode, exp.body).toBe(200);
    await drainAudits();
    const { rows } = await q(
      `SELECT action, resource_type, user_id, actor_type, details FROM platform_audit_log
        WHERE tenant_id = $1 AND resource_id = $2 ORDER BY action DESC`, [floor.tenant, body.search_id]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ action: 'agency_customer_history.searched', resource_type: 'customer_history', user_id: sup().id, actor_type: 'human',
      details: { by: 'phone', value: NUMBER, result_count: expectedA().length, accounts: [floor.account], role: 'account_admin' } });
    expect(rows[1]).toMatchObject({ action: 'agency_customer_history.exported', resource_type: 'customer_history',
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
  });
});

describe('the rate limit (CH11)', () => {
  it('refuses the search after the configured max a minute, per user, with retryAfter', async () => {
    for (let i = 0; i < SEARCH_MAX; i++) {
      const res = await post('search', rateUser, { by: 'phone', value: TYPED });
      expect(res.statusCode, `search ${i + 1}`).toBe(200);
    }
    const refused = await post('search', rateUser, { by: 'phone', value: TYPED });
    expect(refused.statusCode).toBe(429);
    expect(refused.json()).toMatchObject({ error: 'Too Many Requests', retryAfter: expect.any(Number) });
    expect(refused.headers['retry-after']).toBeDefined();
    // The export is charged to the same bucket; the timeline is not.
    const exp = await post('export', rateUser, { search_id: 'chs_00112233445566778899aabbccddeeff' });
    expect(exp.statusCode).toBe(429);
    const page = await post('timeline', rateUser, { search_id: 'chs_00112233445566778899aabbccddeeff' });
    expect(page.statusCode).toBe(404);
    // Another user is not affected.
    expect((await post('search', agent(1), { by: 'phone', value: TYPED })).statusCode).toBe(200);
  });
});

describe('the number never travels in a URL (CH6)', () => {
  it('the family is three POSTs with no params, and no request this suite sent carried the number', async () => {
    const family = routes.filter((r) => r.url.startsWith('/proxy/agency/customers'));
    expect(family.map((r) => `${String(r.method)} ${r.url}`).sort()).toEqual([
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
});

// ─── CH9: every read uses an index ─────────────────────────────────────────────

async function planOf(sql: string, params: unknown[]): Promise<string> {
  const client: PoolClient = await getTestPool().connect();
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

describe('every read uses its index (CH9)', () => {
  const accounts = () => [floor.account, accountB];

  // Real statistics, as production has: on a never-analysed table the planner prices every index
  // from defaults and can pick a broader one for a handful of rows.
  // A tenant with a real amount of other rows (other numbers' DNC entries, other campaigns, other
  // calls' media legs, other imports), and real statistics, as production has: on a near-empty,
  // never-analysed table the planner prices a broad index (the tenant's) the same as the exact one,
  // and the plan says nothing about production.
  beforeAll(async () => {
    const C0 = floor.campaigns[0]!;
    await q(`INSERT INTO dnc_entries (tenant_id, account_id, phone_e164, source)
             SELECT $1, $2, '+9170' || lpad(g::text, 8, '0'), 'api' FROM generate_series(1, 3000) g`, [floor.tenant, floor.account]);
    await q(`INSERT INTO agency_campaigns
             SELECT (jsonb_populate_record(c, jsonb_build_object('id', gen_random_uuid(), 'name', 'Bulk ' || g))).*
               FROM agency_campaigns c, generate_series(1, 3000) g WHERE c.id = $1`, [C0]);
    await q(`INSERT INTO agency_calls (tenant_id, account_id, caller_id, destination_phone)
             SELECT $1, $2, '+919000000001', '+9170' || lpad(g::text, 8, '0') FROM generate_series(1, 3000) g`, [floor.tenant, floor.account]);
    await q(`INSERT INTO agency_ingest_jobs (tenant_id, account_id, campaign_id, s3_key, file_name, phone_column, status)
             SELECT $1, $2, gen_random_uuid(), 'k/' || g, 'bulk-' || g || '.csv', 'phone', 'completed' FROM generate_series(1, 3000) g`,
      [floor.tenant, floor.account]);
    await q('ANALYZE agency_contacts, agency_call_attempts, agency_manual_calls, dnc_entries, agency_campaigns, agency_calls, agency_ingest_jobs');
  });

  it('contacts: idx_agency_contacts_phone', async () => {
    const plan = await planOf(CUSTOMER_HISTORY_SQL.contacts, [floor.tenant, NUMBER, accounts(), 2000]);
    expect(plan).toContain('idx_agency_contacts_phone');
    expect(plan).toMatch(/Index Cond: .*phone_e164/);
  });

  it('attempts: uq_agency_attempt_number by contact', async () => {
    const plan = await planOf(CUSTOMER_HISTORY_SQL.attempts, [floor.tenant, accounts(), [ids.cA, ids.cAr]]);
    expect(plan).toContain('uq_agency_attempt_number');
    expect(plan).toMatch(/Index Cond: .*contact_id/);
  });

  it('soft-phone calls: the destination index and the contact-history index', async () => {
    const plan = await planOf(CUSTOMER_HISTORY_SQL.manualCalls, [floor.tenant, accounts(), NUMBER, [ids.cA, ids.cAr]]);
    expect(plan).toContain('idx_agency_manual_calls_destination');
    expect(plan).toContain('idx_agency_manual_calls_contact_history');
    expect(plan).toMatch(/Index Cond: .*destination_e164/);
  });

  it('DNC: idx_dnc_entries_tenant_phone', async () => {
    const plan = await planOf(CUSTOMER_HISTORY_SQL.dnc, [floor.tenant, NUMBER, accounts()]);
    expect(plan).toContain('idx_dnc_entries_tenant_phone');
  });

  it('campaigns, media legs by primary key; uploads by idx_agency_ingest_jobs_campaign', async () => {
    expect(await planOf(CUSTOMER_HISTORY_SQL.campaigns, [floor.tenant, accounts(), [floor.campaigns[0], retryCampaign]]))
      .toContain('agency_campaigns_pkey');
    expect(await planOf(CUSTOMER_HISTORY_SQL.mediaLegs, [floor.tenant, accounts(), [ids.leg1, ids.leg2]]))
      .toContain('agency_calls_pkey');
    expect(await planOf(CUSTOMER_HISTORY_SQL.uploads, [floor.tenant, accounts(), [floor.campaigns[0]]]))
      .toContain('idx_agency_ingest_jobs_campaign');
  });
});
