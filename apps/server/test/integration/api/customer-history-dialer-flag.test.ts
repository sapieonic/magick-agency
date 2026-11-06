import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';

/**
 * ─── Customer history: the dialer flag is a data boundary (CH2) ────────────────
 *
 * `POST /proxy/agency/customers/{search,timeline,export}` through the real app and real Postgres.
 * One tenant, the dialer on for it (the floor's tenant override); account A keeps it, account B
 * has an account-level override turning it off. One number with a roster row, a campaign call and
 * a DNC mark in each account, an untagged soft-phone call in B, and a tenant-wide DNC entry.
 *
 *  1. B off: a tenant-level owner asking in A sees only A (summary, every timeline page, the
 *     export, the audit's `accounts`); asking in B is `403 feature_disabled`, so the same data is
 *     never readable from A either. B's soft-phone call is left out with the rest of B.
 *  2. B off: a role held only in B (account_admin there, agent in A) is not the caller's highest
 *     role, so the tenant-wide DNC entry's reason stays hidden.
 *  3. B on: the owner sees both accounts, and the B-only role shows the reason again.
 *  4. B off again under a live search: the search's later pages and its export drop B at once
 *     (each request narrows the viewer again).
 *
 * The flag service caches what it read, so every flip invalidates the tenant's snapshot.
 */

const mocks = vi.hoisted(() => {
  process.env['SUPER_ADMIN_JWT_SECRET'] = 'customer-history-dialer-flag-0123456789';
  return { verifyIdToken: vi.fn() };
});
vi.mock('../../../src/auth/firebase.js', () => ({ initFirebase: vi.fn(), verifyIdToken: mocks.verifyIdToken }));

import { getTestPool, truncateAll } from '../../../../../packages/db/test/helpers/test-db.js';
import {
  drainAudits, headersFor, seedFloor, startLoadApp, stopLoadApp, verifyTestToken,
  type Actor, type LoadApp, type TenantFloor,
} from '../load/load-harness.js';
import { getFeatureFlagService } from '../../../src/feature-flags/index.js';

const NUMBER = '+919812345678';
const TYPED = '98123 45678';
const DAY = 86_400_000;
const T0 = new Date(Date.now() - 10 * DAY);
const at = (ms: number) => new Date(T0.getTime() + ms);

let loaded: LoadApp;
let floor: TenantFloor;
let accountB: string;
let campaignB: string;
let owner: Actor; // tenant-level tenant_owner
let split: Actor; // agent in A, account_admin in B
const q = (sql: string, values: unknown[] = []) => getTestPool().query(sql, values);
const inB = () => ({ 'x-account-id': accountB });

const ids = {
  cA: randomUUID(), aA: randomUUID(), dncA: randomUUID(),
  cB: randomUUID(), aB: randomUUID(), mB: randomUUID(), dncB: randomUUID(),
  dncTenant: randomUUID(),
};
const A_KEYS = () => [`roster_entry:${ids.cA}`, `campaign_call:${ids.aA}`, `dnc_mark:${ids.dncA}`, `dnc_mark:${ids.dncTenant}`].sort();
const B_KEYS = () => [`roster_entry:${ids.cB}`, `campaign_call:${ids.aB}`, `softphone_call:${ids.mB}`, `dnc_mark:${ids.dncB}`].sort();
/** Every id of account B's that must never reach a caller while its dialer is off. */
const B_IDS = () => [accountB, campaignB, ids.cB, ids.aB, ids.mB, ids.dncB];

/** Account B's dialer: an account-level override (off), or none (inherits the tenant's on). */
async function setDialerB(on: boolean): Promise<void> {
  await q(`DELETE FROM feature_flag_overrides WHERE flag_key = 'agency_dialer_enabled' AND scope_type = 'account' AND account_id = $1`,
    [accountB]);
  if (!on) {
    await q(`INSERT INTO feature_flag_overrides (flag_key, scope_type, tenant_id, account_id, value)
             VALUES ('agency_dialer_enabled', 'account', $1, $2, 'false'::jsonb)`, [floor.tenant, accountB]);
  }
  await getFeatureFlagService().invalidate({ tenantId: floor.tenant });
}

async function user(name: string, memberships: Array<{ accountId: string | null; role: string }>): Promise<Actor> {
  const id = randomUUID();
  const uid = `chf-${name}-${id.slice(0, 8)}`;
  await q(`INSERT INTO users (id, firebase_uid, email, display_name, status) VALUES ($1, $2, $3, $4, 'active')`,
    [id, uid, `${uid}@load.example.com`, name]);
  for (const m of memberships) {
    await q(`INSERT INTO memberships (id, user_id, tenant_id, account_id, role, status) VALUES ($1, $2, $3, $4, $5, 'active')`,
      [randomUUID(), id, floor.tenant, m.accountId, m.role]);
  }
  return { id, uid, tok: `tok:${uid}`, role: 'agent', ip: `10.88.${Math.floor(Math.random() * 200)}.${Math.floor(Math.random() * 200)}` };
}

async function insert(table: string, row: Record<string, unknown>): Promise<void> {
  const cols = Object.keys(row);
  await q(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`, Object.values(row));
}

async function post(path: string, actor: Actor, body: unknown, extra: Record<string, string> = {}) {
  return loaded.app.inject({
    method: 'POST',
    url: `/proxy/agency/customers/${path}`,
    headers: headersFor(actor, floor, { 'content-type': 'application/json', ...extra }),
    payload: JSON.stringify(body),
  });
}

async function search(actor: Actor, extra: Record<string, string> = {}) {
  const res = await post('search', actor, { by: 'phone', value: TYPED, country: 'IN' }, extra);
  expect(res.statusCode, res.body).toBe(200);
  return res.json();
}

/** Every timeline key of a search, page by page (2 a page, so paging itself is covered). */
async function allKeys(actor: Actor, searchId: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 20; i++) {
    const res = await post('timeline', actor, { search_id: searchId, limit: 2, ...(cursor ? { cursor } : {}) });
    expect(res.statusCode, res.body).toBe(200);
    const page = res.json();
    keys.push(...page.entries.map((e: { key: string }) => e.key));
    if (!page.next_cursor) return keys.sort();
    cursor = page.next_cursor;
  }
  throw new Error('too many pages');
}

async function auditDetails(searchId: string, action: string): Promise<Record<string, unknown>> {
  await drainAudits();
  const { rows } = await q(`SELECT details FROM platform_audit_log WHERE tenant_id = $1 AND resource_id = $2 AND action = $3`,
    [floor.tenant, searchId, action]);
  expect(rows).toHaveLength(1);
  return rows[0]!.details;
}

const contactIds = (body: { summary: { contacts: Array<{ contact_id: string }> } }) =>
  body.summary.contacts.map((c) => c.contact_id).sort();
const tenantWideDnc = (body: { summary: { dnc: Array<{ id: string; reason: string | null }> } }) =>
  body.summary.dnc.find((d) => d.id === ids.dncTenant);

beforeAll(async () => {
  mocks.verifyIdToken.mockImplementation(verifyTestToken);
  loaded = await startLoadApp();
  await truncateAll();
  floor = (await seedFloor({ tenants: 1, agentsPerTenant: 1, supervisorsPerTenant: 1, campaignsPerTenant: 1 }))[0]!;
  const CA = floor.campaigns[0]!;

  accountB = randomUUID();
  await q(`INSERT INTO accounts (id, tenant_id, name, slug, settings, status) VALUES ($1, $2, 'South', $3, '{}'::jsonb, 'active')`,
    [accountB, floor.tenant, `south-${accountB.slice(0, 8)}`]);
  campaignB = randomUUID();
  await q(`INSERT INTO agency_campaigns
           SELECT (jsonb_populate_record(c, jsonb_build_object('id', $2::uuid, 'account_id', $3::uuid, 'name', 'South campaign'))).*
             FROM agency_campaigns c WHERE c.id = $1`, [CA, campaignB, accountB]);

  owner = await user('owner', [{ accountId: null, role: 'tenant_owner' }]);
  split = await user('split', [{ accountId: floor.account, role: 'agent' }, { accountId: accountB, role: 'account_admin' }]);

  const base = { tenant_id: floor.tenant, caller_id: '+919000000001', state: 'ended' };
  // ── Account A ──
  await insert('agency_contacts', { id: ids.cA, tenant_id: floor.tenant, account_id: floor.account, campaign_id: CA,
    phone_e164: NUMBER, context: '{}', created_at: at(DAY) });
  await insert('agency_call_attempts', { ...base, id: ids.aA, account_id: floor.account, campaign_id: CA, contact_id: ids.cA,
    attempt_number: 1, outcome: 'connected', notes: 'A notes', dialed_at: at(2 * DAY), ended_at: at(2 * DAY), created_at: at(2 * DAY) });
  await insert('dnc_entries', { id: ids.dncA, tenant_id: floor.tenant, account_id: floor.account, phone_e164: NUMBER,
    source: 'api', created_at: at(3 * DAY) });
  // ── Tenant-wide ──
  await insert('dnc_entries', { id: ids.dncTenant, tenant_id: floor.tenant, account_id: null, campaign_id: null, phone_e164: NUMBER,
    source: 'regulator', reason: 'National registry', added_by: 'import:registry.csv', created_at: at(4 * DAY) });
  // ── Account B ──
  await insert('agency_contacts', { id: ids.cB, tenant_id: floor.tenant, account_id: accountB, campaign_id: campaignB,
    phone_e164: NUMBER, context: '{}', created_at: at(5 * DAY) });
  await insert('agency_call_attempts', { ...base, id: ids.aB, account_id: accountB, campaign_id: campaignB, contact_id: ids.cB,
    attempt_number: 1, outcome: 'connected', notes: 'B notes', dialed_at: at(6 * DAY), ended_at: at(6 * DAY), created_at: at(6 * DAY) });
  // An untagged soft-phone call in B: the soft phone has its own flag, but B's history is behind
  // the dialer's, so it is left out with the rest of B.
  const sessionB = randomUUID();
  await insert('agency_agent_sessions', { id: sessionB, tenant_id: floor.tenant, account_id: accountB, campaign_id: null,
    agent_user_id: owner.id, state: 'offline', kind: 'softphone', left_at: at(7 * DAY) });
  await insert('agency_manual_calls', { ...base, id: ids.mB, account_id: accountB, session_id: sessionB, agent_user_id: owner.id,
    destination_e164: NUMBER, outcome: 'busy', dialed_at: at(7 * DAY), ended_at: at(7 * DAY), settled_at: at(7 * DAY), created_at: at(7 * DAY) });
  await insert('dnc_entries', { id: ids.dncB, tenant_id: floor.tenant, account_id: accountB, phone_e164: NUMBER,
    source: 'api', created_at: at(8 * DAY) });

  await setDialerB(false);
}, 120_000);

afterAll(async () => {
  await stopLoadApp(loaded);
});

describe('the dialer flag is a data boundary (CH2)', () => {
  it('B off: a tenant-level owner asking in A sees only A, in the summary, every page, the export and the audit', async () => {
    const body = await search(owner);
    expect(contactIds(body)).toEqual([ids.cA]);
    expect(body.summary.dnc.map((d: { id: string }) => d.id).sort()).toEqual([ids.dncA, ids.dncTenant].sort());
    expect(body.summary.totals).toMatchObject({ calls: 1, connected: 1 });
    expect(await allKeys(owner, body.search_id)).toEqual(A_KEYS());
    const text = JSON.stringify(body);
    for (const id of B_IDS()) expect(text).not.toContain(id);
    expect(text).not.toContain('B notes');

    const exp = await post('export', owner, { search_id: body.search_id });
    expect(exp.statusCode, exp.body).toBe(200);
    expect(exp.headers['x-export-rows']).toBe(String(A_KEYS().length));
    expect(exp.body).not.toContain('South');
    expect(exp.body).not.toContain('B notes');

    const searched = await auditDetails(body.search_id, 'agency_customer_history.searched');
    expect(searched).toMatchObject({ accounts: [floor.account], result_count: A_KEYS().length, role: 'tenant_owner' });
    const exported = await auditDetails(body.search_id, 'agency_customer_history.exported');
    expect(exported).toMatchObject({ accounts: [floor.account], rows: A_KEYS().length });
  });

  it('B off: asking in B is 403 feature_disabled, on every route', async () => {
    const res = await post('search', owner, { by: 'phone', value: TYPED, country: 'IN' }, inB());
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json()).toMatchObject({ code: 'feature_disabled' });
    const mine = await search(owner);
    for (const path of ['timeline', 'export']) {
      const refused = await post(path, owner, { search_id: mine.search_id }, inB());
      expect(refused.statusCode, `${path}: ${refused.body}`).toBe(403);
    }
  });

  it('B off: a role held only in B is not the highest role (the tenant-wide entry\'s reason stays hidden)', async () => {
    const body = await search(split);
    expect(contactIds(body)).toEqual([ids.cA]);
    expect(tenantWideDnc(body)).toMatchObject({ reason: null, added_by: null });
    expect(await auditDetails(body.search_id, 'agency_customer_history.searched')).toMatchObject({ accounts: [floor.account], role: 'agent' });
  });

  it('B on: the owner sees both accounts, and the B-only role counts again', async () => {
    await setDialerB(true);
    const body = await search(owner);
    expect(contactIds(body)).toEqual([ids.cA, ids.cB].sort());
    expect(await allKeys(owner, body.search_id)).toEqual([...A_KEYS(), ...B_KEYS()].sort());
    const searched = await auditDetails(body.search_id, 'agency_customer_history.searched');
    expect((searched['accounts'] as string[]).slice().sort()).toEqual([floor.account, accountB].sort());

    const splitBody = await search(split);
    expect(contactIds(splitBody)).toEqual([ids.cA, ids.cB].sort());
    expect(tenantWideDnc(splitBody)).toMatchObject({ reason: 'National registry' });
  });

  it('B off again under a live search: its later pages and its export drop B at once', async () => {
    await setDialerB(true);
    const body = await search(owner);
    expect(contactIds(body)).toEqual([ids.cA, ids.cB].sort());
    await setDialerB(false);
    expect(await allKeys(owner, body.search_id)).toEqual(A_KEYS());
    const exp = await post('export', owner, { search_id: body.search_id });
    expect(exp.statusCode, exp.body).toBe(200);
    expect(exp.headers['x-export-rows']).toBe(String(A_KEYS().length));
    expect(exp.body).not.toContain('South');
    const exported = await auditDetails(body.search_id, 'agency_customer_history.exported');
    expect(exported).toMatchObject({ accounts: [floor.account], result_count: A_KEYS().length });
  });
});
