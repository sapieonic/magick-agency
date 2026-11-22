import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';

/**
 * The account's All calls and the agent's My calls (`docs/call-log.md` §7, P5), on real
 * Postgres through the real app: the call log read at the account's and an agent's scope.
 *
 *  - All calls: the three types on one keyset across an account's campaigns, the Campaign
 *    filter and "No campaign", the counts, the floor, the tenant boundary, the rule's date.
 *  - My calls: only the caller's own rows (their dials, their soft-phone calls, the inbound
 *    calls they answered, their open Missed rows), no media, **and no number the row's campaign
 *    hides from agents**, on any type; To follow up and the callbacks due.
 *  - The dialler branch at the account's scope planned on 0070's index.
 */

const mocks = vi.hoisted(() => {
  process.env['SUPER_ADMIN_JWT_SECRET'] = 'all-calls-secret-0123456789abcdef';
  return { verifyIdToken: vi.fn() };
});
vi.mock('../../../src/auth/firebase.js', () => ({ initFirebase: vi.fn(), verifyIdToken: mocks.verifyIdToken }));

import { getTestPool, truncateAll } from '../../../../../packages/db/test/helpers/test-db.js';
import { getPool } from '@magick-agency/db';
import {
  call, seedFloor, startLoadApp, stopLoadApp, verifyTestToken,
  type Actor, type LoadApp, type TenantFloor,
} from '../load/load-harness.js';
import { agencyAttemptRepository } from '../../../src/db/repositories/agency.repository.js';

let loaded: LoadApp;
let floor: TenantFloor;
let other: TenantFloor;
/** A campaign that hides numbers from agents, and one that shows them. */
let masked: string;
let full: string;
let me: Actor;
let colleague: Actor;
const q = (sql: string, values: unknown[] = []) => getTestPool().query(sql, values);
const MIN = 60_000;
const BASE = new Date(Math.floor((Date.now() - 6 * 60 * MIN) / MIN) * MIN);
const at = (minutes: number) => new Date(BASE.getTime() + minutes * MIN);
const RUNG = '+919000000009';
const id = new Map<string, string>();
const labels = (rows: Array<{ id: string }>) => rows.map((row) => [...id.entries()].find(([, value]) => value === row.id)?.[0] ?? row.id);

/** Every customer number seeded on the masked campaign: none may reach an agent in full. */
const HIDDEN = ['+919700004821', '+919700002210', '+919811000031', '+919812307730', '+919700009999'];

const get = async (path: string, actor: Actor, status = 200, f = floor) => {
  const res = await call(loaded.app, 'GET', path, actor, f);
  expect(res.statusCode, `${path}: ${res.body}`).toBe(status);
  return res;
};

async function inbound(label: string, o: {
  tenant?: TenantFloor; campaign: string | null; matched?: string; from?: string | null; arrived: Date;
  state?: string; outcome?: string; answeredBy?: string; code?: string;
  followUp?: { status: 'open' | 'handled'; assignee?: string };
}): Promise<void> {
  const f = o.tenant ?? floor;
  const state = o.state ?? 'ended';
  const ended = state === 'ended' ? new Date(o.arrived.getTime() + 90_000) : null;
  const bridged = o.answeredBy ? new Date(o.arrived.getTime() + 10_000) : null;
  const { rows: [row] } = await q(
    `INSERT INTO agency_inbound_calls
       (tenant_id, account_id, provider, provider_call_id, from_e164, to_e164, matched_contact_id, matched_campaign_id,
        campaign_id, campaign_source, state, outcome, arrived_at, answered_at, bridged_at, answered_by_user_id, ended_at,
        talk_seconds, disposition_code, disposition_source, dispositioned_at, dispositioned_by_user_id, settled_at,
        follow_up_status, follow_up_reason, follow_up_assignee_user_id, handled_at, webrtc_call_id)
     VALUES ($1, $2, 'plivo', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21,
             $22, $23, $24, $25, $26)
     RETURNING id`,
    [
      f.tenant, f.account, `CA-${randomUUID()}`, o.from === undefined ? `+9198${String(id.size).padStart(8, '0')}` : o.from, RUNG,
      o.matched ?? null, o.matched ? o.campaign : null, o.campaign, o.campaign ? (o.matched ? 'contact' : 'route') : null,
      state, state === 'ended' ? (o.outcome ?? (o.answeredBy ? 'answered' : 'abandoned_in_queue')) : null,
      o.arrived, bridged, o.answeredBy ?? null, ended, o.answeredBy ? 80 : null,
      o.code ?? null, o.code ? (o.matched ? 'campaign' : 'route') : null, o.code ? ended : null, o.code ? o.answeredBy ?? null : null,
      state === 'ended' && (o.code || !bridged) ? ended : null,
      o.followUp?.status ?? null, o.followUp ? 'abandoned_in_queue' : null, o.followUp?.assignee ?? null,
      o.followUp?.status === 'handled' ? ended : null, o.answeredBy ? randomUUID() : null,
    ],
  );
  id.set(label, row.id as string);
}

beforeAll(async () => {
  mocks.verifyIdToken.mockImplementation(verifyTestToken);
  loaded = await startLoadApp();
  await truncateAll();
  [floor, other] = await seedFloor({ tenants: 2, agentsPerTenant: 2, supervisorsPerTenant: 1, campaignsPerTenant: 2, staffAgents: true }) as [TenantFloor, TenantFloor];
  [masked, full] = floor.campaigns as [string, string];
  [me, colleague] = floor.agents as [Actor, Actor];
  await q(`UPDATE agency_campaigns SET status = 'running', started_at = $2, created_at = $2 WHERE id = ANY($1::uuid[])`, [floor.campaigns, at(-9000)]);
  await q(`UPDATE agency_campaigns SET phone_display = 'masked', name = 'Masked campaign' WHERE id = $1`, [masked]);
  await q(`UPDATE agency_campaigns SET name = 'Open campaign' WHERE id = $1`, [full]);

  const session = async (agent: Actor, campaign: string | null) => (await q(
    `INSERT INTO agency_agent_sessions (tenant_id, account_id, campaign_id, agent_user_id, state, kind, joined_at, left_at)
     VALUES ($1, $2, $3, $4, 'offline', $5, $6, $7) RETURNING id`,
    [floor.tenant, floor.account, campaign, agent.id, campaign ? 'campaign' : 'softphone', at(-10), at(300)])).rows[0].id as string;
  const contact = async (campaign: string, phone: string, name: string) => (await q(
    `INSERT INTO agency_contacts (campaign_id, tenant_id, account_id, phone_e164, context, state)
     VALUES ($1, $2, $3, $4, $5::jsonb, 'completed') RETURNING id`,
    [campaign, floor.tenant, floor.account, phone, JSON.stringify({ name })])).rows[0].id as string;
  const attempt = async (label: string, campaign: string, contactId: string, sessionId: string | null, created: Date, code: string | null) => {
    const { rows: [row] } = await q(
      `INSERT INTO agency_call_attempts (campaign_id, contact_id, tenant_id, account_id, attempt_number, caller_id, reserved_agent_id,
              state, outcome, disposition_code, dialed_at, ended_at, talk_seconds, webrtc_call_id, redial_number, created_at)
       VALUES ($1, $2, $3, $4, 1, '+919000000001', $5, 'ended', $6, $7, $8, $9, $10, $11, 0, $8) RETURNING id`,
      [campaign, contactId, floor.tenant, floor.account, sessionId, code ? 'connected' : 'no_answer', code, created,
        new Date(created.getTime() + 30_000), code ? 25 : null, code ? randomUUID() : null]);
    id.set(label, row.id as string);
  };
  const manual = async (label: string, agent: Actor, sessionId: string, campaign: string | null, to: string, created: Date, o: { dialled?: boolean; callbackOf?: string } = {}) => {
    const dialled = o.dialled !== false;
    const ended = new Date(created.getTime() + 60_000);
    const { rows: [row] } = await q(
      `INSERT INTO agency_manual_calls (tenant_id, account_id, session_id, agent_user_id, campaign_id, destination_e164, caller_id,
              state, outcome, disposition_code, disposition_source, dialed_at, bridged_at, ended_at, settled_at, created_at,
              callback_of_inbound_call_id, webrtc_call_id)
       VALUES ($1, $2, $3, $4, $5, $6, '+919000000002', 'ended', $7, $8, $9, $10, $11, $12, $12, $13, $14, $15) RETURNING id`,
      [floor.tenant, floor.account, sessionId, agent.id, campaign, to, dialled ? 'connected' : 'failed', dialled ? 'callback' : null,
        dialled ? (campaign ? 'campaign' : 'softphone') : null, dialled ? new Date(created.getTime() + 500) : null,
        dialled ? new Date(created.getTime() + 5000) : null, ended, created, o.callbackOf ?? null, dialled ? randomUUID() : null]);
    id.set(label, row.id as string);
  };

  const [mineMasked, mineFull, theirs] = [await session(me, masked), await session(me, full), await session(colleague, masked)];
  const [softMine, softTheirs] = [await session(me, null), await session(colleague, null)];
  const asha = await contact(masked, HIDDEN[0]!, 'Asha Rao');
  const vikram = await contact(masked, HIDDEN[1]!, 'Vikram Patil');
  const open1 = await contact(full, '+919600000001', 'Harpreet Singh');
  const open2 = await contact(full, '+919600000002', 'Sunita Deshmukh');
  const never = await contact(masked, HIDDEN[4]!, 'Nobody Reserved');

  // ── The dialler ──
  await attempt('d-mine-masked', masked, asha, mineMasked, at(10), 'interested');
  await attempt('d-mine-full', full, open1, mineFull, at(20), null);
  await attempt('d-theirs', masked, vikram, theirs, at(30), 'interested');
  await attempt('d-nobody', masked, never, null, at(35), null);

  // ── Inbound ──
  await inbound('i-mine-masked', { campaign: masked, matched: asha, from: HIDDEN[0]!, arrived: at(40), answeredBy: me.id, code: 'interested' });
  await inbound('i-theirs', { campaign: masked, matched: vikram, from: HIDDEN[1]!, arrived: at(45), answeredBy: colleague.id, code: 'interested' });
  await inbound('i-mine-unfiled', { campaign: null, from: '+919500000007', arrived: at(50), answeredBy: me.id });
  await inbound('m-mine-masked', { campaign: masked, from: HIDDEN[3]!, arrived: at(55), followUp: { status: 'open', assignee: me.id } });
  await inbound('m-theirs', { campaign: masked, from: '+919811000099', arrived: at(60), followUp: { status: 'open', assignee: colleague.id } });
  await inbound('m-account-unfiled', { campaign: null, from: '+919500000008', arrived: at(65), followUp: { status: 'open' } });
  await inbound('m-mine-handled', { campaign: full, from: '+919600000009', arrived: at(70), followUp: { status: 'handled', assignee: me.id } });
  await inbound('m-mine-old', { campaign: full, matched: open2, from: '+919600000002', arrived: at(-3 * 24 * 60), followUp: { status: 'open', assignee: me.id } });
  await inbound('i-live', { campaign: masked, arrived: at(75), state: 'queued' });
  await inbound('i-rejected', { campaign: masked, arrived: at(76), outcome: 'rejected' });
  await inbound('i-other-tenant', { tenant: other, campaign: null, arrived: at(77), followUp: { status: 'open' } });

  // ── The soft phone ──
  await manual('s-mine-masked', me, softMine, masked, HIDDEN[2]!, at(80));
  await manual('s-mine-untagged', me, softMine, null, '+919500000001', at(85));
  await manual('s-theirs', colleague, softTheirs, full, '+919600000033', at(90));
  await manual('s-mine-callback', me, softMine, masked, HIDDEN[3]!, at(95), { callbackOf: id.get('m-mine-masked')! });
  await manual('s-mine-never-dialled', me, softMine, full, '+919600000044', at(100), { dialled: false });

  // ── Callbacks on the open campaign (a pool campaign: the ones I booked). ──
  const callback = async (label: string, by: Actor, name: string, due: Date) => {
    const { rows: [row] } = await q(
      `INSERT INTO agency_contacts (campaign_id, tenant_id, account_id, phone_e164, context, state, attempt_count, last_outcome,
              last_disposition, next_attempt_at, callback_booked_by_user_id, callback_booked_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, 'pending', 1, 'connected', 'callback', $6, $7, $8) RETURNING id`,
      [full, floor.tenant, floor.account, `+9196111${String(id.size).padStart(5, '0')}`, JSON.stringify({ name }), due, by.id, at(0)]);
    id.set(label, row.id as string);
  };
  const now = Date.now();
  await callback('cb-late', me, 'Anjali Verma', new Date(now - 130 * MIN));
  await callback('cb-soon', me, 'Rohit Nair', new Date(now + 1000));
  await callback('cb-later-days', me, 'Not Yet', new Date(now + 3 * 24 * 60 * MIN));
  await callback('cb-theirs', colleague, 'Their Customer', new Date(now - 30 * MIN));
}, 180_000);

afterAll(async () => {
  await stopLoadApp(loaded);
});

interface Row { type: string; id: string; created_at: string; [key: string]: unknown }
interface Page { rows: Row[]; next_cursor: string | null; limit: number; counts?: Record<string, number>; [key: string]: unknown }
async function walk(base: string, actor: Actor, limit: number): Promise<Row[]> {
  const rows: Row[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < 60; i++) {
    const sep = base.includes('?') ? '&' : '?';
    const page: Page = (await get(`${base}${sep}limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, actor)).json();
    rows.push(...page.rows);
    cursor = page.next_cursor;
    if (!cursor) return rows;
  }
  throw new Error('the list never ended');
}

const ALL_ORDER = [
  's-mine-never-dialled', 's-mine-callback', 's-theirs', 's-mine-untagged', 's-mine-masked',
  'm-mine-handled', 'm-account-unfiled', 'm-theirs', 'm-mine-masked', 'i-mine-unfiled', 'i-theirs', 'i-mine-masked',
  'd-nobody', 'd-theirs', 'd-mine-full', 'd-mine-masked', 'm-mine-old',
];

describe('All calls: the account\'s calls of every type on one list', () => {
  const sup = () => floor.supervisors[0]!;

  it('every call of the account once, newest first across campaigns and types, at any page size', async () => {
    expect(labels((await get('/proxy/agency/calls', sup())).json<Page>().rows)).toEqual(ALL_ORDER);
    for (const limit of [1, 2, 5]) expect(labels(await walk('/proxy/agency/calls', sup(), limit)), `limit ${limit}`).toEqual(ALL_ORDER);
  });

  it('names each row\'s campaign, and leaves a call filed under none with none', async () => {
    const rows = new Map((await get('/proxy/agency/calls', sup())).json<Page>().rows.map((r) => [labels([r])[0]!, r]));
    expect(rows.get('d-mine-masked')).toMatchObject({ type: 'dialler', campaign_id: masked, campaign_name: 'Masked campaign' });
    expect(rows.get('s-theirs')).toMatchObject({ type: 'soft_phone', campaign_id: full, campaign_name: 'Open campaign', agent_user_id: colleague.id });
    expect(rows.get('s-mine-untagged')).toMatchObject({ type: 'soft_phone', campaign_id: null, campaign_name: null });
    expect(rows.get('m-account-unfiled')).toMatchObject({ type: 'inbound', campaign_id: null, campaign_source: null, campaign_name: null });
    // A supervisor reads numbers in full, as on the campaign Call log.
    expect(rows.get('d-mine-masked')!['phone_e164']).toBe(HIDDEN[0]);
  });

  it('never a live call, one we turned away, or another tenant\'s', async () => {
    const listed = new Set((await walk('/proxy/agency/calls', sup(), 50)).map((r) => r.id));
    for (const label of ['i-live', 'i-rejected', 'i-other-tenant']) expect(listed.has(id.get(label)!), label).toBe(false);
  });

  it('filters by type, and by campaign: one campaign\'s calls, or the calls filed under none', async () => {
    const list = async (params: string) => labels((await get(`/proxy/agency/calls?${params}`, sup())).json<Page>().rows);
    expect(await list('type=dialler')).toEqual(['d-nobody', 'd-theirs', 'd-mine-full', 'd-mine-masked']);
    expect(await list('type=soft_phone')).toEqual(['s-mine-never-dialled', 's-mine-callback', 's-theirs', 's-mine-untagged', 's-mine-masked']);
    expect(await list('type=to_follow_up')).toEqual(['m-account-unfiled', 'm-theirs', 'm-mine-masked', 'm-mine-old']);
    expect(await list(`campaign_id=${full}`)).toEqual(['s-mine-never-dialled', 's-theirs', 'm-mine-handled', 'd-mine-full', 'm-mine-old']);
    // No dialler call is filed under no campaign.
    expect(await list('campaign_id=none')).toEqual(['s-mine-untagged', 'm-account-unfiled', 'i-mine-unfiled']);
    expect(await list('campaign_id=none&type=dialler')).toEqual([]);
    expect(await list(`agent_user_id=${colleague.id}`)).toEqual(['s-theirs', 'i-theirs', 'd-theirs']);
  });

  it('counts each chip by the filters, whatever chip is on', async () => {
    const counts = async (params = '') => (await get(`/proxy/agency/calls?include_counts=1${params}`, sup())).json<Page>().counts;
    // The soft-phone row that never dialled is listed and counted nowhere (SR2).
    expect(await counts()).toEqual({ all: 16, dialler: 4, soft_phone: 4, inbound: 8, to_follow_up: 4 });
    expect(await counts('&type=dialler')).toEqual(await counts());
    expect(await counts('&campaign_id=none')).toEqual({ all: 3, dialler: 0, soft_phone: 1, inbound: 2, to_follow_up: 1 });
    expect(await counts(`&campaign_id=${masked}`)).toMatchObject({ dialler: 3, soft_phone: 2, inbound: 4, to_follow_up: 2 });
    // To follow up is not cut by the dates (CL14); the rest are.
    const today = `&from=${encodeURIComponent(at(0).toISOString())}`;
    expect(await counts(today)).toMatchObject({ inbound: 7, to_follow_up: 4 });
  });

  it('says when the account\'s rule was switched on, for "Before the rule"', async () => {
    expect((await get('/proxy/agency/calls?limit=1', sup())).json<Page>()['rule']).toEqual({ require_campaign: false, require_campaign_since: null });
    const since = new Date();
    await q(`INSERT INTO agency_call_settings (tenant_id, account_id, require_campaign, require_campaign_since)
             VALUES ($1, $2, true, $3)`, [floor.tenant, floor.account, since]);
    try {
      expect((await get('/proxy/agency/calls?limit=1', sup())).json<Page>()['rule'])
        .toEqual({ require_campaign: true, require_campaign_since: since.toISOString() });
    } finally {
      await q('DELETE FROM agency_call_settings WHERE tenant_id = $1', [floor.tenant]);
    }
  });

  it('is the supervisor\'s: an agent is refused, another tenant\'s campaign is not found, an unknown key is a 400', async () => {
    await get('/proxy/agency/calls', me, 403);
    await get(`/proxy/agency/calls?campaign_id=${other.campaigns[0]}`, sup(), 404);
    await get('/proxy/agency/calls?campaign_id=nope', sup(), 400);
    await get('/proxy/agency/calls?type=nope', sup(), 400);
    await get('/proxy/agency/calls?anything=1', sup(), 400);
    // The other tenant's supervisor reads their own account, never this one's.
    const theirs = (await call(loaded.app, 'GET', '/proxy/agency/calls', other.supervisors[0]!, other)).json() as Page;
    expect(labels(theirs.rows)).toEqual(['i-other-tenant']);
  });
});

const MY_ORDER = [
  's-mine-never-dialled', 's-mine-callback', 's-mine-untagged', 's-mine-masked',
  'm-mine-masked', 'i-mine-unfiled', 'i-mine-masked', 'd-mine-full', 'd-mine-masked', 'm-mine-old',
];

describe('My calls: the agent\'s own calls', () => {
  it('only my rows: my dials, my soft-phone calls, the inbound calls I answered and my open Missed rows', async () => {
    expect(labels((await get('/proxy/agency/my-calls', me)).json<Page>().rows)).toEqual(MY_ORDER);
    for (const limit of [1, 3]) expect(labels(await walk('/proxy/agency/my-calls', me, limit)), `limit ${limit}`).toEqual(MY_ORDER);
    // The colleague's list is theirs, and nothing in the query can ask for mine.
    expect(labels((await get('/proxy/agency/my-calls', colleague)).json<Page>().rows)).toEqual(['s-theirs', 'm-theirs', 'i-theirs', 'd-theirs']);
    await get(`/proxy/agency/my-calls?agent_user_id=${me.id}`, colleague, 400);
  });

  it('filters by type and by campaign', async () => {
    const list = async (params: string) => labels((await get(`/proxy/agency/my-calls?${params}`, me)).json<Page>().rows);
    expect(await list('type=dialler')).toEqual(['d-mine-full', 'd-mine-masked']);
    expect(await list('type=soft_phone')).toEqual(['s-mine-never-dialled', 's-mine-callback', 's-mine-untagged', 's-mine-masked']);
    expect(await list('type=inbound')).toEqual(['m-mine-masked', 'i-mine-unfiled', 'i-mine-masked', 'm-mine-old']);
    expect(await list(`campaign_id=${full}`)).toEqual(['s-mine-never-dialled', 'd-mine-full', 'm-mine-old']);
    // Every type on the campaign that hides numbers, and never the colleague's calls on it.
    expect(await list(`campaign_id=${masked}`)).toEqual(['s-mine-callback', 's-mine-masked', 'm-mine-masked', 'i-mine-masked', 'd-mine-masked']);
    expect(await list(`campaign_id=${masked}&type=inbound`)).toEqual(['m-mine-masked', 'i-mine-masked']);
    expect(await list('campaign_id=none')).toEqual(['s-mine-untagged', 'i-mine-unfiled']);
    expect(await list(`from=${encodeURIComponent(at(82).toISOString())}`)).toEqual(['s-mine-never-dialled', 's-mine-callback', 's-mine-untagged']);
  });

  it('never sends a number its campaign hides from agents, on any type of row, whatever is asked', async () => {
    const paths = [
      '/proxy/agency/my-calls', '/proxy/agency/my-calls?type=dialler', '/proxy/agency/my-calls?type=soft_phone',
      '/proxy/agency/my-calls?type=inbound', '/proxy/agency/my-calls?type=to_follow_up&include_counts=1',
      `/proxy/agency/my-calls?campaign_id=${masked}`, '/proxy/agency/my-calls?limit=2',
    ];
    for (const actor of [me, colleague]) {
      for (const path of paths) {
        const body = (await get(path, actor)).body;
        for (const number of HIDDEN) {
          expect(body.includes(number), `${path} sent ${number}`).toBe(false);
          // Nor its digits without the plus.
          expect(body.includes(number.slice(3)), `${path} sent the digits of ${number}`).toBe(false);
        }
      }
    }
    const rows = new Map((await get('/proxy/agency/my-calls', me)).json<Page>().rows.map((r) => [labels([r])[0]!, r]));
    // Each type on the masked campaign: the masked text, and that it is masked.
    expect(rows.get('d-mine-masked')).toMatchObject({ type: 'dialler', phone: '97••• ••821', phone_masked: true });
    expect(rows.get('s-mine-masked')).toMatchObject({ type: 'soft_phone', phone: '98••• ••031', phone_masked: true });
    expect(rows.get('i-mine-masked')).toMatchObject({ type: 'inbound', phone: '97••• ••821', phone_masked: true });
    expect(rows.get('m-mine-masked')).toMatchObject({ type: 'inbound', phone: '98••• ••730', phone_masked: true });
    // A campaign that shows numbers, and a call with no campaign, are in full.
    expect(rows.get('d-mine-full')).toMatchObject({ phone: '+919600000001', phone_masked: false });
    expect(rows.get('s-mine-untagged')).toMatchObject({ phone: '+919500000001', phone_masked: false });
    expect(rows.get('i-mine-unfiled')).toMatchObject({ phone: '+919500000007', phone_masked: false });
  });

  it('masks an inbound call filed under no campaign by the campaign of the contact it matched', async () => {
    // A row written while an older server ran: the matched contact's campaign, and no `campaign_id`.
    const call = id.get('i-mine-masked')!;
    const { rows: [before] } = await q(`SELECT from_e164, campaign_source, matched_campaign_id FROM agency_inbound_calls WHERE id = $1`, [call]);
    await q(`UPDATE agency_inbound_calls SET campaign_id = NULL, campaign_source = NULL, matched_campaign_id = $2 WHERE id = $1`, [call, masked]);
    try {
      const res = await get('/proxy/agency/my-calls?type=inbound', me);
      const row = res.json<Page>().rows.find((r) => r.id === call)!;
      expect(row).toMatchObject({ campaign_id: null, campaign_name: null, phone: '97••• ••821', phone_masked: true });
      expect(res.body.includes(before.from_e164 as string)).toBe(false);
      expect(res.body.includes((before.from_e164 as string).slice(3))).toBe(false);
    } finally {
      await q(`UPDATE agency_inbound_calls SET campaign_id = $2, campaign_source = $3, matched_campaign_id = $4 WHERE id = $1`,
        [call, masked, before.campaign_source, before.matched_campaign_id]);
    }
  });

  it('a campaign that starts hiding numbers hides them on the calls already made', async () => {
    await q(`UPDATE agency_campaigns SET phone_display = 'masked' WHERE id = $1`, [full]);
    try {
      const body = (await get('/proxy/agency/my-calls', me)).body;
      expect(body.includes('+919600000001')).toBe(false);
    } finally {
      await q(`UPDATE agency_campaigns SET phone_display = 'full' WHERE id = $1`, [full]);
    }
  });

  it('carries no media: no leg id, no recording, no summary', async () => {
    const page = (await get('/proxy/agency/my-calls', me)).json<Page>();
    for (const row of page.rows) {
      for (const key of ['webrtc_call_id', 'recording_url', 'recording', 'summary', 'call', 'media', 'agent_user_id', 'phone_e164', 'caller_id']) {
        expect(row, `${row.type} row carries ${key}`).not.toHaveProperty(key);
      }
    }
  });

  it('names the campaign, the customer and the saved outcome', async () => {
    const rows = new Map((await get('/proxy/agency/my-calls', me)).json<Page>().rows.map((r) => [labels([r])[0]!, r]));
    expect(rows.get('d-mine-masked')).toMatchObject({
      campaign_id: masked, campaign_name: 'Masked campaign', customer_name: 'Asha Rao', attempt_number: 1,
      outcome: 'connected', disposition_code: 'interested', disposition_label: 'Interested', talk_seconds: 25,
    });
    expect(rows.get('i-mine-masked')).toMatchObject({ customer_name: 'Asha Rao', outcome: 'answered', wait_seconds: 10, follow_up: null });
    expect(rows.get('s-mine-callback')).toMatchObject({
      callback_of: { inbound_call_id: id.get('m-mine-masked'), arrived_at: at(55).toISOString() }, disposition_label: 'Call back',
    });
    expect(rows.get('m-mine-masked')).toMatchObject({
      follow_up: { status: 'open', reason: 'abandoned_in_queue', closed_cause: null, handled_reason: null },
      called_back: { call_id: id.get('s-mine-callback') },
    });
    expect(rows.get('s-mine-never-dialled')).toMatchObject({ dialed_at: null });
    expect(rows.get('s-mine-untagged')).toMatchObject({ campaign_id: null, campaign_name: null, disposition_label: null });
  });

  it('To follow up: my open Missed rows whatever the dates, then the callbacks I booked that are due today or late', async () => {
    const page = (await get(`/proxy/agency/my-calls?type=to_follow_up&include_counts=1&from=${encodeURIComponent(at(0).toISOString())}`, me)).json<Page>();
    expect(labels(page.rows)).toEqual(['m-mine-masked', 'm-mine-old']);
    const due = page['callbacks_due'] as Array<Record<string, unknown>>;
    expect(due.map((c) => labels([{ id: c['contact_id'] as string }])[0])).toEqual(['cb-late', 'cb-soon']);
    expect(due[0]).toMatchObject({ campaign_id: full, campaign_name: 'Open campaign', customer_name: 'Anjali Verma', overdue: true });
    expect(due[1]).toMatchObject({ customer_name: 'Rohit Nair' });
    expect(page.counts).toEqual({ to_follow_up: 4, missed_open: 2, callbacks_due: 2 });
    // The count is asked for on any chip; the callbacks list comes with To follow up's first page.
    const all = (await get('/proxy/agency/my-calls?include_counts=1&limit=1', me)).json<Page>();
    expect(all.counts).toEqual({ to_follow_up: 4, missed_open: 2, callbacks_due: 2 });
    expect(all).not.toHaveProperty('callbacks_due');
    // The colleague's are their own.
    const theirs = (await get('/proxy/agency/my-calls?type=to_follow_up&include_counts=1', colleague)).json<Page>();
    expect(labels(theirs.rows)).toEqual(['m-theirs']);
    expect((theirs['callbacks_due'] as Array<{ contact_id: string }>).map((c) => c.contact_id)).toEqual([id.get('cb-theirs')]);
  });

  it('To follow up on one campaign: the callbacks of that campaign only, none under No campaign; the counts stay whole', async () => {
    const dueOn = async (campaign: string) => {
      const page = (await get(`/proxy/agency/my-calls?type=to_follow_up&include_counts=1&campaign_id=${campaign}`, me)).json<Page>();
      expect(page.counts, campaign).toEqual({ to_follow_up: 4, missed_open: 2, callbacks_due: 2 });
      return (page['callbacks_due'] as Array<{ contact_id: string; campaign_id: string }>);
    };
    const onFull = await dueOn(full);
    expect(onFull.map((c) => labels([{ id: c.contact_id }])[0])).toEqual(['cb-late', 'cb-soon']);
    // Both callbacks are on the open campaign: the masked one's filter leaves none, as "No campaign" does.
    expect(await dueOn(masked)).toEqual([]);
    expect(await dueOn('none')).toEqual([]);
  });

  it('one Missed row by its id, for Call back: my own and the account’s unassigned, never a colleague’s', async () => {
    const one = (label: string, actor: typeof me, status = 200) => get(`/proxy/agency/inbound/missed/${id.get(label)}`, actor, status);
    // My own open row, on the campaign that hides numbers: the number in full, as the Missed list gives it.
    const mine = (await one('m-mine-masked', me)).json<Record<string, unknown>>();
    expect(mine).toMatchObject({ id: id.get('m-mine-masked'), from_e164: HIDDEN[3], status: 'open', assignee_user_id: me.id });
    // The list's rule: an open row nobody has is readable (IQ49); a colleague's is as absent as one that is not there.
    expect((await one('m-account-unfiled', me)).json<Record<string, unknown>>()).toMatchObject({ assignee_user_id: null });
    expect((await one('m-theirs', me, 404)).json<{ code: string }>().code).toBe('inbound_missed_call_not_found');
    expect((await get(`/proxy/agency/inbound/missed/${randomUUID()}`, me, 404)).json<{ code: string }>().code).toBe('inbound_missed_call_not_found');
    await get('/proxy/agency/inbound/missed/not-an-id', me, 404);
    // A supervisor reads any row of the account.
    expect((await one('m-theirs', floor.supervisors[0]!)).json<Record<string, unknown>>()).toMatchObject({ assignee_user_id: colleague.id });
    // An answered call is no Missed row.
    await one('i-mine-masked', me, 404);
  });

  it('To follow up follows Mark handled', async () => {
    const res = await call(loaded.app, 'POST', `/proxy/agency/inbound/missed/${id.get('m-mine-old')}/handled`, me, floor, {});
    expect(res.statusCode, res.body).toBe(200);
    try {
      const page = (await get('/proxy/agency/my-calls?type=to_follow_up&include_counts=1', me)).json<Page>();
      expect(labels(page.rows)).toEqual(['m-mine-masked']);
      expect(page.counts).toMatchObject({ missed_open: 1, to_follow_up: 3 });
      // Handled, it is no longer one of my calls at all: I did not answer it.
      expect(labels((await get('/proxy/agency/my-calls?type=inbound', me)).json<Page>().rows)).not.toContain('m-mine-old');
    } finally {
      await q(`UPDATE agency_inbound_calls SET follow_up_status = 'open', handled_at = NULL, handled_by_user_id = NULL, handled_reason = NULL WHERE id = $1`, [id.get('m-mine-old')]);
    }
  });

  it('a supervisor reads their own calls here too, and has none', async () => {
    const page = (await get('/proxy/agency/my-calls?include_counts=1', floor.supervisors[0]!)).json<Page>();
    expect(page.rows).toEqual([]);
    expect(page.counts).toEqual({ to_follow_up: 0, missed_open: 0, callbacks_due: 0 });
  });

  it('refuses what it does not take', async () => {
    await get('/proxy/agency/my-calls?type=nope', me, 400);
    await get('/proxy/agency/my-calls?campaign_id=nope', me, 400);
    // A campaign of another tenant is as unknown as one that does not exist.
    await get(`/proxy/agency/my-calls?campaign_id=${other.campaigns[0]}`, me, 404);
    await get('/proxy/agency/my-calls?campaign_id=7b1e5c4a-2d3f-4e6a-9b8c-7d6e5f4a3b2c', me, 404);
    await get('/proxy/agency/my-calls?phone=98', me, 400);
    await get('/proxy/agency/my-calls?cursor=nope', me, 400);
  });
});

describe('the dialler branch at the account\'s scope and 0070', () => {
  it('plans on idx_agency_attempts_account_created, with no sort of the account', async () => {
    await q(`SET session_replication_role = replica`);
    // Another account's attempts beside this one's, so the planner has a reason to choose.
    await q(
      `WITH camp AS (
         INSERT INTO agency_campaigns (tenant_id, account_id, name, caller_ids)
         SELECT $1, CASE WHEN n = 1 THEN $2::uuid ELSE gen_random_uuid() END, 'Plan ' || n, ARRAY['+912200000000']
           FROM generate_series(1, 6) n RETURNING id, account_id),
       con AS (
         INSERT INTO agency_contacts (campaign_id, tenant_id, account_id, phone_e164)
         SELECT camp.id, $1, camp.account_id, '+91' || (7100000000 + row_number() OVER ())::text
           FROM camp, generate_series(1, 6000) g RETURNING id, campaign_id, account_id)
       INSERT INTO agency_call_attempts (campaign_id, contact_id, tenant_id, account_id, attempt_number, caller_id, state, created_at)
       SELECT con.campaign_id, con.id, $1, con.account_id, 1, '+912200000000', 'ended', now() - interval '30 days' - (row_number() OVER () || ' seconds')::interval
         FROM con`,
      [floor.tenant, floor.account]);
    await q(`SET session_replication_role = origin`);
    // Every table the statement joins: an un-analysed one leaves the plan to chance.
    await q('ANALYZE agency_call_attempts');
    await q('ANALYZE agency_contacts');
    await q('ANALYZE agency_agent_sessions');
    const pool = getPool();
    const spy = vi.spyOn(pool, 'query');
    let statement: { text: string; values: unknown[] };
    try {
      await agencyAttemptRepository.listCallLog({
        scope: { kind: 'account', tenantId: floor.tenant, accountId: floor.account }, filters: {}, source: 'dialler', limit: 50,
      });
      const [text, values] = spy.mock.calls.at(-1)! as unknown as [string, unknown[]];
      statement = { text, values };
    } finally {
      spy.mockRestore();
    }
    expect(statement.text).toContain('agency_call_attempts a');
    const { rows } = await getTestPool().query<{ 'QUERY PLAN': string }>(`EXPLAIN ${statement.text}`, statement.values);
    const plan = rows.map((row) => row['QUERY PLAN']).join('\n');
    expect(plan).toContain('idx_agency_attempts_account_created');
    expect(plan).not.toContain('Seq Scan on agency_call_attempts');
    // In the index's own order: the branch's rows are not gathered and sorted.
    expect(plan).not.toContain('Sort Key: a.created_at');
  });
});
