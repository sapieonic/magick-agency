import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';

/**
 * ─── Inbound calls in customer history (docs/call-log.md §8, CL39–CL42) ────────
 *
 * `POST /proxy/agency/customers/{search,timeline,export}` through the real app on real Postgres,
 * for a number that RANG US. One number with a call of every kind the rule names, each on its
 * side of it:
 *
 *  - which inbound calls are rows: ended and served, filed under a campaign or under none; never
 *    a `rejected` call, a live one (that is in the summary's live calls), one not yet admitted, a
 *    withheld number, another number's, another account's for an account-scoped caller, another
 *    tenant's, or one with no account;
 *  - found by the caller's number however it is typed (+91, a leading 0, spaces);
 *  - the row's facts, and what each caller is shown of them (CH8): notes to the agent who
 *    answered and to `agency.campaigns.read`, the Call page to `agency.supervise` and only for a
 *    call filed under a campaign, never a recording or voicemail link to anyone;
 *  - one order with the other kinds, keyset pages with ties across kinds and between two inbound
 *    calls, at several page sizes;
 *  - every filter on an inbound call; the summary's inbound totals, live call and filter options;
 *    a callback booked on an inbound call; the audit's count; the export's rows;
 *  - the dialer flag as the data boundary (CH2) and inbound's own flag hiding nothing;
 *  - the summary's open callback names who booked it when it was booked on an inbound call;
 *  - every inbound statement planned on `idx_agency_inbound_calls_from` (0071).
 */

const mocks = vi.hoisted(() => {
  process.env['SUPER_ADMIN_JWT_SECRET'] = 'customer-history-inbound-0123456789';
  return { verifyIdToken: vi.fn() };
});
vi.mock('../../../src/auth/firebase.js', () => ({ initFirebase: vi.fn(), verifyIdToken: mocks.verifyIdToken }));

import { getTestPool, truncateAll } from '../../../../../packages/db/test/helpers/test-db.js';
import {
  drainAudits, headersFor, seedFloor, startLoadApp, stopLoadApp, verifyTestToken,
  type Actor, type LoadApp, type TenantFloor,
} from '../load/load-harness.js';
import {
  agencyCustomerHistoryRepository,
  CUSTOMER_HISTORY_SQL,
  UUID_MAX,
} from '../../../src/db/repositories/agency.repository.js';
import { getFeatureFlagService } from '../../../src/feature-flags/index.js';

const NUMBER = '+919876500001';
const OTHER_NUMBER = '+919876500002';
/** A number whose contact waits on a callback booked on an inbound call. */
const NUMBER_CB = '+919876500003';
const RUNG = '+918000000009';
const DAY = 86_400_000;
const T0 = new Date(Date.now() - 20 * DAY);
const at = (ms: number) => new Date(T0.getTime() + ms);

let loaded: LoadApp;
let floor: TenantFloor;
let other: TenantFloor;
let accountB: string;
let campaignB: string;
let C0: string;
let owner: Actor; // tenant-level tenant_owner
const q = (sql: string, values: unknown[] = []) => getTestPool().query(sql, values);
const sup = () => floor.supervisors[0]!;
const agent = (i: number) => floor.agents[i]!;

const ids = {
  contact: randomUUID(), route: randomUUID(),
  answered: randomUUID(), missedOpen: randomUUID(), missedHandled: randomUUID(), failed: randomUUID(),
  rejected: randomUUID(), live: randomUUID(), arrived: randomUUID(), withheld: randomUUID(), otherNumber: randomUUID(),
  inB: randomUUID(), foreign: randomUUID(), noAccount: randomUUID(),
  tieInbound: randomUUID(), tieInbound2: randomUUID(), tieAttempt: randomUUID(), tieManual: randomUUID(),
  callBack: randomUUID(), leg: randomUUID(), liveB: randomUUID(),
  cbContact: randomUUID(), cbManual: randomUUID(), cbInbound: randomUUID(),
};

type Entry = Record<string, any>;

async function post(path: string, actor: Actor, body: unknown, extra: Record<string, string> = {}, f: TenantFloor = floor) {
  return loaded.app.inject({
    method: 'POST',
    url: `/proxy/agency/customers/${path}`,
    headers: headersFor(actor, f, { 'content-type': 'application/json', ...extra }),
    payload: JSON.stringify(body),
  });
}

async function search(actor: Actor, value = NUMBER, extra: Record<string, string> = {}, f: TenantFloor = floor) {
  const res = await post('search', actor, { by: 'phone', value, country: 'IN' }, extra, f);
  expect(res.statusCode, res.body).toBe(200);
  return res.json();
}

async function allPages(actor: Actor, searchId: string, limit: number, filters?: unknown): Promise<Entry[]> {
  const entries: Entry[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 200; i++) {
    const res = await post('timeline', actor, { search_id: searchId, limit, ...(filters ? { filters } : {}), ...(cursor ? { cursor } : {}) });
    expect(res.statusCode, res.body).toBe(200);
    const page = res.json();
    expect(page.entries.length).toBeLessThanOrEqual(limit);
    entries.push(...page.entries);
    if (!page.next_cursor) return entries;
    cursor = page.next_cursor;
  }
  throw new Error('too many pages');
}

const keysOf = (entries: Entry[]) => entries.map((e) => e.key as string);
const inboundKeys = (entries: Entry[]) => keysOf(entries).filter((k) => k.startsWith('inbound_call:'));
const key = (id: string) => `inbound_call:${id}`;

async function user(role: string, accountId: string | null, name: string): Promise<Actor> {
  const id = randomUUID();
  const uid = `chi-${name.replace(/\W/g, '')}-${id.slice(0, 8)}`;
  await q(`INSERT INTO users (id, firebase_uid, email, display_name, status) VALUES ($1, $2, $3, $4, 'active')`,
    [id, uid, `${uid}@load.example.com`, name]);
  await q(`INSERT INTO memberships (id, user_id, tenant_id, account_id, role, status) VALUES ($1, $2, $3, $4, $5, 'active')`,
    [randomUUID(), id, floor.tenant, accountId, role]);
  return { id, uid, tok: `tok:${uid}`, role: 'agent', ip: `10.78.${Math.floor(Math.random() * 200)}.${Math.floor(Math.random() * 200)}` };
}

async function insert(table: string, row: Record<string, unknown>) {
  const cols = Object.keys(row);
  await q(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`, Object.values(row));
}

/** An ended inbound call from the number in account A, filed under no campaign, unless `row` says otherwise. */
async function inbound(id: string, arrived: Date, row: Record<string, unknown> = {}) {
  const base: Record<string, unknown> = {
    id, tenant_id: floor.tenant, account_id: floor.account, provider: 'plivo', provider_call_id: `CA-${id}`,
    from_e164: NUMBER, to_e164: RUNG, state: 'ended', outcome: 'answered', arrived_at: arrived, answered_at: arrived,
    ended_at: new Date(arrived.getTime() + 120_000),
  };
  await insert('agency_inbound_calls', { ...base, ...row });
}

/** An answered call's columns: put through to `userId` after `waitSeconds`. */
const answeredBy = (arrived: Date, userId: string, waitSeconds = 18) => ({
  bridged_at: new Date(arrived.getTime() + waitSeconds * 1000), answered_by_user_id: userId, talk_seconds: 90,
});

/** A missed call's columns. */
const missed = (outcome: string, status: 'open' | 'handled', arrived: Date, more: Record<string, unknown> = {}) => ({
  outcome, follow_up_status: status, follow_up_reason: outcome === 'voicemail' ? 'overflow' : outcome,
  ...(status === 'handled' ? { handled_at: new Date(arrived.getTime() + 3_600_000) } : {}), ...more,
});

async function softphoneSession(accountId: string, agentId: string): Promise<string> {
  const id = randomUUID();
  await q(`INSERT INTO agency_agent_sessions (id, tenant_id, account_id, campaign_id, agent_user_id, state, kind, left_at)
           VALUES ($1, $2, $3, NULL, $4, 'offline', 'softphone', now())`, [id, floor.tenant, accountId, agentId]);
  return id;
}

async function setFlag(flag: string, accountId: string | null, on: boolean | null): Promise<void> {
  const scope = accountId ? 'account' : 'tenant';
  await q(`DELETE FROM feature_flag_overrides WHERE flag_key = $1 AND scope_type = $2 AND tenant_id = $3
            AND account_id IS NOT DISTINCT FROM $4`, [flag, scope, floor.tenant, accountId]);
  if (on !== null) {
    await q(`INSERT INTO feature_flag_overrides (flag_key, scope_type, tenant_id, account_id, value) VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [flag, scope, floor.tenant, accountId, JSON.stringify(on)]);
  }
  await getFeatureFlagService().invalidate({ tenantId: floor.tenant });
}

beforeAll(async () => {
  mocks.verifyIdToken.mockImplementation(verifyTestToken);
  loaded = await startLoadApp();
  await truncateAll();
  [floor, other] = await seedFloor({ tenants: 2, agentsPerTenant: 2, supervisorsPerTenant: 1, campaignsPerTenant: 1 }) as [TenantFloor, TenantFloor];
  C0 = floor.campaigns[0]!;
  await q(`UPDATE agency_campaigns SET name = 'Diwali EMI' WHERE id = $1`, [C0]);
  accountB = randomUUID();
  await q(`INSERT INTO accounts (id, tenant_id, name, slug, settings, status) VALUES ($1, $2, 'South', $3, '{}'::jsonb, 'active')`,
    [accountB, floor.tenant, `south-${accountB.slice(0, 8)}`]);
  campaignB = randomUUID();
  await q(`INSERT INTO agency_campaigns
           SELECT (jsonb_populate_record(c, jsonb_build_object('id', $2::uuid, 'account_id', $3::uuid, 'name', 'South campaign'))).*
             FROM agency_campaigns c WHERE c.id = $1`, [C0, campaignB, accountB]);
  owner = await user('tenant_owner', null, 'Owner');
  const a0 = agent(0).id;
  const a1 = agent(1).id;

  await insert('agency_inbound_routes', { id: ids.route, tenant_id: floor.tenant, account_id: floor.account, name: 'Collections line', timezone: 'Asia/Kolkata' });
  await insert('agency_contacts', {
    id: ids.contact, tenant_id: floor.tenant, account_id: floor.account, campaign_id: C0, phone_e164: NUMBER,
    context: JSON.stringify({ Name: 'Asha Rao' }), created_at: T0,
  });

  // Answered by agent 0, the caller's own agent, after 18 s; on the campaign's list; an outcome with
  // notes, a callback and a recording.
  await insert('agency_calls', { id: ids.leg, tenant_id: floor.tenant, account_id: floor.account, caller_id: RUNG,
    destination_phone: NUMBER, recording_url: 'https://recordings.example.com/inbound-1', recording_requested: true });
  await inbound(ids.answered, at(2 * DAY), {
    ...answeredBy(at(2 * DAY), a0), matched_contact_id: ids.contact, matched_campaign_id: C0, campaign_id: C0, campaign_source: 'contact',
    sticky_user_id: a0, sticky_reason: 'last_connected', route_id: ids.route,
    webrtc_call_id: ids.leg, recording_requested: true,
    disposition_code: 'callback', disposition_source: 'campaign', notes: 'Inbound notes', callback_at: new Date(Date.now() + DAY),
    dispositioned_at: at(2 * DAY + 200_000), dispositioned_by_user_id: a0, settled_at: at(2 * DAY + 200_000),
  });
  // Missed, still to follow up, assigned to agent 1; queued, left a voicemail; filed under no campaign.
  await inbound(ids.missedOpen, at(4 * DAY), {
    ...missed('voicemail', 'open', at(4 * DAY), { follow_up_assignee_user_id: a1 }), queued_at: at(4 * DAY + 2000),
    voicemail_key: 'inbound-voicemail/secret-key.wav', voicemail_seconds: 22, settled_at: at(4 * DAY + 120_000),
  });
  // Missed out of hours, filed under the campaign by its route, rung back from the soft phone, the customer reached.
  await inbound(ids.missedHandled, at(6 * DAY), {
    ...missed('closed', 'handled', at(6 * DAY), { handled_reason: 'reached', closed_cause: 'hours' }),
    campaign_id: C0, campaign_source: 'route', settled_at: at(6 * DAY + 120_000),
  });
  await insert('agency_manual_calls', {
    id: ids.callBack, tenant_id: floor.tenant, account_id: floor.account, session_id: await softphoneSession(floor.account, a1),
    agent_user_id: a1, caller_id: '+919000000001', destination_e164: NUMBER, state: 'ended', outcome: 'connected', campaign_id: C0,
    callback_of_inbound_call_id: ids.missedHandled,
    dialed_at: at(6 * DAY + 1_200_000), ended_at: at(6 * DAY + 1_260_000), settled_at: at(6 * DAY + 1_260_000), created_at: at(6 * DAY + 1_200_000),
  });
  // Could not be answered: served, no Missed row, no campaign.
  await inbound(ids.failed, at(7 * DAY), { outcome: 'failed', settled_at: at(7 * DAY + 120_000) });

  // ── Never a row ──
  await inbound(ids.rejected, at(8 * DAY), { outcome: 'rejected', settled_at: at(8 * DAY) });
  await inbound(ids.live, at(19 * DAY), { state: 'queued', outcome: null, ended_at: null, queued_at: at(19 * DAY + 1000) });
  await inbound(ids.arrived, at(19 * DAY + 5000), { state: 'arrived', outcome: null, ended_at: null, answered_at: null });
  await inbound(ids.withheld, at(9 * DAY), { from_e164: null, ...missed('overflow', 'open', at(9 * DAY)), settled_at: at(9 * DAY) });
  await inbound(ids.otherNumber, at(9 * DAY + 1000), { from_e164: OTHER_NUMBER, ...answeredBy(at(9 * DAY + 1000), a0) });
  // Another account of the tenant: a tenant-level caller's alone.
  await inbound(ids.inB, at(10 * DAY), {
    account_id: accountB, ...answeredBy(at(10 * DAY), owner.id), campaign_id: campaignB, campaign_source: 'route',
  });
  // Another tenant, and a call that never had an account.
  await inbound(ids.foreign, at(11 * DAY), { tenant_id: other.tenant, account_id: other.account, ...answeredBy(at(11 * DAY), other.agents[0]!.id) });
  await inbound(ids.noAccount, at(12 * DAY), { account_id: null, ...missed('closed', 'open', at(12 * DAY)), closed_cause: 'no_route', settled_at: at(12 * DAY) });

  // Live in the other account too: a tenant-level caller's alone.
  await inbound(ids.liveB, at(19 * DAY + 2000), {
    account_id: accountB, state: 'queued', outcome: null, ended_at: null, queued_at: at(19 * DAY + 3000),
    campaign_id: campaignB, campaign_source: 'route',
  });

  // ── A contact waiting on a callback booked on an inbound call (as `settleFromInbound` leaves it) ──
  // An older callback booked on a soft-phone call by agent 1, then the customer rang, agent 0
  // answered and booked the callback the contact now waits on.
  await insert('agency_contacts', {
    id: ids.cbContact, tenant_id: floor.tenant, account_id: floor.account, campaign_id: C0, phone_e164: NUMBER_CB,
    context: JSON.stringify({ Name: 'Ravi Kumar' }), created_at: T0, state: 'pending', last_outcome: 'connected',
    last_disposition: 'callback', next_attempt_at: new Date(Date.now() + DAY),
  });
  await insert('agency_manual_calls', {
    id: ids.cbManual, tenant_id: floor.tenant, account_id: floor.account, session_id: await softphoneSession(floor.account, a1),
    agent_user_id: a1, caller_id: '+919000000001', destination_e164: NUMBER_CB, state: 'ended', outcome: 'connected', campaign_id: C0,
    contact_id: ids.cbContact, disposition_code: 'callback', disposition_source: 'campaign', callback_at: at(5 * DAY),
    dispositioned_at: at(3 * DAY + 60_000), dialed_at: at(3 * DAY), ended_at: at(3 * DAY + 50_000), settled_at: at(3 * DAY + 60_000),
    created_at: at(3 * DAY),
  });
  await inbound(ids.cbInbound, at(8 * DAY), {
    from_e164: NUMBER_CB, ...answeredBy(at(8 * DAY), a0), matched_contact_id: ids.cbContact, matched_campaign_id: C0,
    campaign_id: C0, campaign_source: 'contact', disposition_code: 'callback', disposition_source: 'campaign',
    callback_at: new Date(Date.now() + DAY), dispositioned_at: at(8 * DAY + 200_000), dispositioned_by_user_id: a0,
    settled_at: at(8 * DAY + 200_000),
  });

  // ── One instant, three kinds, and two inbound calls on it ──
  const tie = at(14 * DAY);
  await inbound(ids.tieInbound, tie, { ...missed('abandoned_in_queue', 'handled', tie, { handled_reason: 'marked' }), queued_at: tie, settled_at: tie });
  await inbound(ids.tieInbound2, tie, { ...answeredBy(tie, a1, 5) });
  await insert('agency_call_attempts', {
    id: ids.tieAttempt, tenant_id: floor.tenant, account_id: floor.account, campaign_id: C0, contact_id: ids.contact, attempt_number: 1,
    caller_id: '+919000000001', state: 'ended', outcome: 'no_answer', dialed_at: tie, ended_at: tie, created_at: tie,
  });
  await insert('agency_manual_calls', {
    id: ids.tieManual, tenant_id: floor.tenant, account_id: floor.account, session_id: await softphoneSession(floor.account, a0),
    agent_user_id: a0, caller_id: '+919000000001', destination_e164: NUMBER, state: 'ended', outcome: 'busy',
    dialed_at: tie, ended_at: tie, settled_at: tie, created_at: tie,
  });
}, 120_000);

afterAll(async () => {
  await stopLoadApp(loaded);
});

/** Account A's inbound rows, newest first; the two on one instant by key, descending. */
const expectedInboundA = () => [
  ...[key(ids.tieInbound), key(ids.tieInbound2)].sort().reverse(),
  key(ids.failed), key(ids.missedHandled), key(ids.missedOpen), key(ids.answered),
];

describe('which inbound calls are in a number\'s history (CL39)', () => {
  it('ended, served calls from the number, filed under a campaign or under none; nothing else', async () => {
    const body = await search(sup());
    const entries = await allPages(sup(), body.search_id, 100);
    expect(inboundKeys(entries)).toEqual(expectedInboundA());
    const text = JSON.stringify(entries);
    for (const never of [ids.rejected, ids.live, ids.arrived, ids.withheld, ids.otherNumber, ids.inB, ids.foreign, ids.noAccount]) {
      expect(text, never).not.toContain(never);
    }
  });

  it('a tenant-level caller sees the other account\'s call too; never another tenant\'s or one with no account', async () => {
    const body = await search(owner);
    const entries = await allPages(owner, body.search_id, 100);
    expect(inboundKeys(entries).sort()).toEqual([...expectedInboundA(), key(ids.inB)].sort());
    const text = JSON.stringify(body) + JSON.stringify(entries);
    expect(text).not.toContain(ids.foreign);
    expect(text).not.toContain(ids.noAccount);
  });

  it('the other tenant\'s caller sees only their own tenant\'s call', async () => {
    const body = await search(other.supervisors[0]!, NUMBER, {}, other);
    expect(inboundKeys(body.timeline.entries)).toEqual([key(ids.foreign)]);
  });

  it('is found however the number is typed: +91, a leading 0, spaces, bare digits', async () => {
    for (const typed of ['+91 98765 00001', '098765-00001', '98765 00001', '9876500001', '+919876500001']) {
      const body = await search(sup(), typed);
      expect(body.key.value, typed).toBe(NUMBER);
      expect(inboundKeys(body.timeline.entries), typed).toEqual(expectedInboundA());
    }
  });

  it('a live call is in the summary\'s live calls, not the timeline; one not yet admitted is in neither', async () => {
    const body = await search(sup());
    expect(body.summary.open.live_calls).toEqual([
      { channel: 'inbound', campaign: null, agent: null, started_at: at(19 * DAY).toISOString() },
    ]);
  });

  it('a live call in another account is a tenant-level caller\'s alone, and gone with that account\'s dialler off (CH2)', async () => {
    const liveOf = async (actor: Actor) => (await search(actor)).summary.open.live_calls.map((l: Entry) => l.started_at);
    const [mine, theirs] = [at(19 * DAY).toISOString(), at(19 * DAY + 2000).toISOString()];
    expect(await liveOf(sup())).toEqual([mine]);
    expect(await liveOf(owner)).toEqual([theirs, mine]);
    await setFlag('agency_dialer_enabled', accountB, false);
    try {
      expect(await liveOf(owner)).toEqual([mine]);
    } finally {
      await setFlag('agency_dialer_enabled', accountB, null);
    }
    expect(await liveOf(owner)).toEqual([theirs, mine]);
  });

  it('the repository reads nothing with no visible account', async () => {
    const page = await agencyCustomerHistoryRepository.pageInboundCalls({ tenantId: floor.tenant, accountIds: [] }, NUMBER, {
      cursorAt: 'infinity', cursorId: UUID_MAX, limit: 50, from: null, to: null, campaignRoots: null,
      outcomes: null, dispositionCodes: null, agentUserIds: null, connectedOnly: false,
    });
    expect(page).toEqual([]);
  });
});

describe('an inbound row\'s facts and who sees what (CH8)', () => {
  it('a supervisor: the answered call\'s facts, its notes and its Call page; no page for a call filed under none', async () => {
    const body = await search(sup());
    const by = new Map<string, Entry>(body.timeline.entries.map((e: Entry) => [e.key, e]));
    expect(by.get(key(ids.answered))).toMatchObject({
      kind: 'inbound_call', at: at(2 * DAY).toISOString(), account_id: floor.account, inbound_call_id: ids.answered,
      campaign: { id: C0, name: 'Diwali EMI', root_id: C0 }, campaign_source: 'contact', contact_id: ids.contact,
      line_e164: RUNG, route_name: 'Collections line', agent: { user_id: agent(0).id }, outcome: 'answered', disposition_code: 'callback',
      talk_seconds: 90, notes: 'Inbound notes', notes_hidden: false, wait_seconds: 18, queued: false, via_sticky_agent: true,
      voicemail_seconds: null, follow_up: null, called_back_at: null, recording: 'available',
      call_page: { account_id: floor.account, campaign_id: C0, inbound_call_id: ids.answered },
    });
    expect(by.get(key(ids.missedOpen))).toMatchObject({
      campaign: null, campaign_source: null, agent: null, outcome: 'voicemail', queued: true, voicemail_seconds: 22,
      follow_up: { status: 'open', reason: 'overflow', assignee: { user_id: agent(1).id }, handled_reason: null, handled_at: null },
      recording: 'no_call', call_page: null,
    });
    expect(by.get(key(ids.missedHandled))).toMatchObject({
      campaign: { id: C0 }, campaign_source: 'route', outcome: 'closed',
      follow_up: { status: 'handled', reason: 'closed', closed_cause: 'hours', assignee: null, handled_reason: 'reached' },
      called_back_at: at(6 * DAY + 1_200_000).toISOString(),
      call_page: { account_id: floor.account, campaign_id: C0, inbound_call_id: ids.missedHandled },
    });
    expect(by.get(key(ids.failed))).toMatchObject({ outcome: 'failed', follow_up: null, campaign: null, call_page: null });
  });

  it('an agent who did not answer: notes hidden, no Call page; the agent who answered reads their own notes, still no Call page', async () => {
    const stranger = await search(agent(1));
    const theirs = stranger.timeline.entries.find((e: Entry) => e.key === key(ids.answered));
    expect(theirs).toMatchObject({ notes: null, notes_hidden: true, call_page: null, disposition_code: 'callback' });
    expect(JSON.stringify(stranger)).not.toContain('Inbound notes');
    expect(stranger.timeline.entries.every((e: Entry) => !('call_page' in e) || e.call_page === null)).toBe(true);

    const own = await search(agent(0));
    const mine = own.timeline.entries.find((e: Entry) => e.key === key(ids.answered));
    expect(mine).toMatchObject({ notes: 'Inbound notes', notes_hidden: false, call_page: null });
  });

  it('nobody is sent a recording or voicemail link, or the media leg: only that one exists', async () => {
    for (const actor of [agent(0), agent(1), sup(), owner]) {
      const body = await search(actor);
      const text = JSON.stringify(body) + JSON.stringify(await allPages(actor, body.search_id, 100));
      expect(text).not.toContain('recordings.example.com');
      expect(text).not.toContain('secret-key');
      expect(text).not.toContain('voicemail_key');
      expect(text).not.toContain('voicemail_url');
      expect(text).not.toContain(ids.leg);
    }
  });
});

describe('one order with the other kinds, keyset pages', () => {
  it('every entry once, in `at DESC, key DESC`, at every page size, with a tie across three kinds and between two inbound calls', async () => {
    const body = await search(sup());
    const whole = await allPages(sup(), body.search_id, 100);
    const sorted = [...whole].sort((a, b) => (a.at !== b.at ? (a.at < b.at ? 1 : -1) : a.key < b.key ? 1 : -1));
    expect(keysOf(whole)).toEqual(keysOf(sorted));
    const tied = whole.filter((e) => e.at === at(14 * DAY).toISOString()).map((e) => e.key);
    expect(tied).toEqual([
      `softphone_call:${ids.tieManual}`,
      ...[key(ids.tieInbound), key(ids.tieInbound2)].sort().reverse(),
      `campaign_call:${ids.tieAttempt}`,
    ]);
    for (const limit of [1, 2, 3, 5]) {
      const paged = await allPages(sup(), body.search_id, limit);
      expect(keysOf(paged), `limit ${limit}`).toEqual(keysOf(whole));
    }
    expect(new Set(keysOf(whole)).size).toBe(whole.length);
  });
});

describe('the filters on an inbound call (CL13, CL40)', () => {
  let searchId: string;
  const filtered = async (filters: unknown) => inboundKeys(await allPages(sup(), searchId, 3, filters));
  beforeAll(async () => { searchId = (await search(sup())).search_id; });

  it('channel: inbound keeps the inbound calls alone; another channel keeps none', async () => {
    const entries = await allPages(sup(), searchId, 100, { channel: 'inbound' });
    expect(keysOf(entries)).toEqual(expectedInboundA());
    expect(await filtered({ channel: 'softphone' })).toEqual([]);
    expect(await filtered({ channel: 'campaign' })).toEqual([]);
  });

  it('connected only, and the outcome `connected`: the calls an agent answered; any other attempt outcome matches none', async () => {
    const answered = [key(ids.tieInbound2), key(ids.answered)];
    expect(await filtered({ connected_only: true })).toEqual(answered);
    expect(await filtered({ outcomes: ['connected'] })).toEqual(answered);
    expect(await filtered({ outcomes: ['connected', 'busy'] })).toEqual(answered);
    expect(await filtered({ outcomes: ['no_answer', 'busy'] })).toEqual([]);
  });

  it('the agent is who answered; the outcome code the call\'s own', async () => {
    expect(await filtered({ agent_user_ids: [agent(0).id] })).toEqual([key(ids.answered)]);
    expect(await filtered({ agent_user_ids: [agent(1).id] })).toEqual([key(ids.tieInbound2)]);
    expect(await filtered({ disposition_codes: ['callback'] })).toEqual([key(ids.answered)]);
    expect(await filtered({ disposition_codes: ['nothing'] })).toEqual([]);
  });

  it('a campaign keeps the calls filed under it; a call filed under none drops out', async () => {
    expect(await filtered({ campaign_ids: [C0] })).toEqual([key(ids.missedHandled), key(ids.answered)]);
    expect(await filtered({ campaign_ids: [randomUUID()] })).toEqual([]);
  });

  it('the dates are when the call arrived, half-open', async () => {
    expect(await filtered({ from: at(4 * DAY).toISOString(), to: at(6 * DAY).toISOString() })).toEqual([key(ids.missedOpen)]);
    expect(await filtered({ from: at(4 * DAY).toISOString(), to: at(6 * DAY + 1).toISOString() }))
      .toEqual([key(ids.missedHandled), key(ids.missedOpen)]);
  });
});

describe('the summary', () => {
  it('counts the calls received apart from the calls placed, and offers the answerers and the campaigns in the filters', async () => {
    const body = await search(sup());
    // Placed: the tied attempt, the tied soft-phone call and the call back. Connected: the call back.
    expect(body.summary.totals).toMatchObject({ calls: 3, connected: 1, inbound: { calls: 6, answered: 2 } });
    // The newest placed call is still a call we placed.
    expect(body.summary.totals.last_contacted).toMatchObject({ at: at(14 * DAY).toISOString() });
    expect(body.summary.totals.last_contacted.channel).not.toBe('inbound');
    expect(body.summary.filter_options.agents.map((a: Entry) => a.user_id).sort()).toEqual([agent(0).id, agent(1).id].sort());
    expect(body.summary.filter_options.campaigns).toEqual([{ id: C0, name: 'Diwali EMI' }]);
    expect(body.summary.filter_options.outcomes).toEqual(['busy', 'connected', 'no_answer']);
    expect(body.summary.filter_options.disposition_codes).toEqual(['callback']);
  });

  it('a number that only ever rang us has a history: its calls received, no call placed', async () => {
    const body = await search(sup(), OTHER_NUMBER);
    expect(body.summary.totals).toMatchObject({ calls: 0, connected: 0, inbound: { calls: 1, answered: 1 }, last_contacted: null });
    expect(keysOf(body.timeline.entries)).toEqual([key(ids.otherNumber)]);
  });
});

describe('a callback booked on an inbound call', () => {
  it('is a callback entry at the call\'s arrival, booked by who saved the outcome', async () => {
    const body = await search(sup());
    const entries = await allPages(sup(), body.search_id, 100);
    const callback = entries.find((e) => e.key === `callback:${ids.answered}`);
    expect(callback).toMatchObject({
      kind: 'callback', at: at(2 * DAY).toISOString(), source: { channel: 'inbound', id: ids.answered },
      campaign: { id: C0 }, booked_by: { user_id: agent(0).id },
      // Judged as every callback is: by the next call we PLACED to the number after it was booked.
      status: 'kept', dialled_at: at(6 * DAY + 1_200_000).toISOString(),
    });
    // Sorts beside its call by key alone: `inbound_call:` after `callback:` descending.
    const i = keysOf(entries).indexOf(key(ids.answered));
    expect(keysOf(entries)[i + 1]).toBe(`callback:${ids.answered}`);
    // The call-only filters drop it, as they drop every callback.
    expect(keysOf(await allPages(sup(), body.search_id, 100, { channel: 'inbound' }))).not.toContain(`callback:${ids.answered}`);
  });
});

describe('the summary\'s open callback, booked on an inbound call', () => {
  it('names who booked it: the agent who saved the inbound call\'s outcome, not the booker of an older callback', async () => {
    const body = await search(sup(), NUMBER_CB);
    expect(body.summary.open.callbacks).toHaveLength(1);
    expect(body.summary.open.callbacks[0]).toMatchObject({
      contact_id: ids.cbContact, disposition_code: 'callback',
      booked_by: { user_id: agent(0).id, name: expect.any(String) },
    });
    // Its name comes with the booking: the same person the timeline's callback entry names.
    const entry = body.timeline.entries.find((e: Entry) => e.key === `callback:${ids.cbInbound}`);
    expect(entry.booked_by).toEqual(body.summary.open.callbacks[0].booked_by);
  });

  it('the repository reads the booking only in the accounts it is given', async () => {
    const repo = agencyCustomerHistoryRepository;
    const mine = await repo.latestBookings({ tenantId: floor.tenant, accountIds: [floor.account] }, NUMBER_CB, [ids.cbContact]);
    expect(mine.map((b) => b.booked_by_user_id)).toEqual([agent(0).id]);
    // Another account's scope never reads account A's inbound call: the soft-phone booking is not its either.
    expect(await repo.latestBookings({ tenantId: floor.tenant, accountIds: [accountB] }, NUMBER_CB, [ids.cbContact])).toEqual([]);
  });
});

describe('audit (CH10) and export', () => {
  it('the audit\'s result count is every entry the caller can see, inbound calls among them', async () => {
    const body = await search(sup());
    const entries = await allPages(sup(), body.search_id, 100);
    const exp = await post('export', sup(), { search_id: body.search_id, filters: { channel: 'inbound' } });
    expect(exp.statusCode, exp.body).toBe(200);
    await drainAudits();
    const { rows } = await q(
      `SELECT action, details FROM platform_audit_log WHERE tenant_id = $1 AND resource_id = $2 ORDER BY action DESC`,
      [floor.tenant, body.search_id]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ action: 'agency_customer_history.searched',
      details: { by: 'phone', value: NUMBER, result_count: entries.length, accounts: [floor.account] } });
    expect(rows[1]).toMatchObject({ action: 'agency_customer_history.exported',
      details: { value: NUMBER, result_count: entries.length, rows: 6, filters: { channel: 'inbound' } } });
    // 6 inbound calls, the callback booked on one, the roster row, the attempt, two soft-phone calls.
    expect(entries.length).toBe(11);
  });

  it('the CSV has a line per inbound call: its outcome as the wire writes it, the rest in Details; notes hidden from an agent who did not answer', async () => {
    const body = await search(sup());
    const res = await post('export', sup(), { search_id: body.search_id, filters: { channel: 'inbound' } });
    const lines = res.body.trim().split('\n');
    expect(lines).toHaveLength(7);
    const answered = lines.find((l) => l.includes(at(2 * DAY).toISOString()))!;
    expect(answered).toContain('Inbound call');
    expect(answered).toContain('Diwali EMI');
    expect(answered).toContain('answered');
    expect(answered).toContain('Inbound notes');
    expect(answered).toContain(`Rang ${RUNG}`);
    expect(answered).toContain('Waited 18 seconds');
    expect(answered).toContain('Came through their agent');
    const missedLine = lines.find((l) => l.includes(at(4 * DAY).toISOString()))!;
    expect(missedLine).toContain('voicemail');
    expect(missedLine).toContain('Voicemail 22 seconds');
    expect(missedLine).toContain('Missed: overflow');
    expect(missedLine).toContain('Follow-up: open');
    expect(res.body).not.toContain('secret-key');

    const agentBody = await search(agent(1));
    const agentCsv = await post('export', agent(1), { search_id: agentBody.search_id, filters: { channel: 'inbound' } });
    expect(agentCsv.statusCode, agentCsv.body).toBe(200);
    expect(agentCsv.body).not.toContain('Inbound notes');
    expect(agentCsv.body).toContain('Hidden');
  });
});

describe('the flags', () => {
  it('inbound switched off hides nothing: the history keeps the calls it holds', async () => {
    await setFlag('agency_inbound_enabled', null, false);
    try {
      const body = await search(sup());
      expect(inboundKeys(await allPages(sup(), body.search_id, 100))).toEqual(expectedInboundA());
    } finally {
      await setFlag('agency_inbound_enabled', null, null);
    }
  });

  it('the dialer flag is the data boundary (CH2): an account with the dialer off gives up no inbound call, on a search, a page or a count', async () => {
    const before = await search(owner);
    expect(JSON.stringify(await allPages(owner, before.search_id, 100))).toContain(ids.inB);
    await setFlag('agency_dialer_enabled', accountB, false);
    try {
      // The search made while it was on drops the account from its next page.
      const next = await allPages(owner, before.search_id, 100);
      expect(JSON.stringify(next)).not.toContain(ids.inB);
      const body = await search(owner);
      expect(JSON.stringify(body)).not.toContain(ids.inB);
      expect(body.summary.totals.inbound).toEqual({ calls: 6, answered: 2 });
    } finally {
      await setFlag('agency_dialer_enabled', accountB, null);
    }
    expect((await search(owner)).summary.totals.inbound).toEqual({ calls: 7, answered: 3 });
  });
});

/**
 * The plan the repository gets on an analysed bulk seed. ANALYZE runs inside the transaction and
 * the ROLLBACK discards it, with the seed (the rule in `customer-history.test.ts`).
 */
describe('every inbound read uses idx_agency_inbound_calls_from (CH9, CL41)', () => {
  async function plansOf(statements: Array<[string, string, unknown[]]>): Promise<Map<string, string>> {
    const client: PoolClient = await getTestPool().connect();
    const plans = new Map<string, string>();
    try {
      await client.query('BEGIN');
      // 40,000 other calls of the two accounts from 4,000 other numbers, half answered, half missed.
      await client.query(
        `INSERT INTO agency_inbound_calls
           (tenant_id, account_id, provider_call_id, from_e164, to_e164, state, outcome, arrived_at, answered_at, bridged_at,
            answered_by_user_id, ended_at, follow_up_status, follow_up_reason)
         SELECT $1, CASE WHEN g % 2 = 0 THEN $2::uuid ELSE $3::uuid END, 'bulk-' || g, '+9197' || lpad((g % 4000)::text, 8, '0'), $4,
                'ended', CASE WHEN g % 4 < 2 THEN 'answered' ELSE 'overflow' END,
                now() - (g || ' seconds')::interval, now() - (g || ' seconds')::interval,
                CASE WHEN g % 4 < 2 THEN now() - (g || ' seconds')::interval END, CASE WHEN g % 4 < 2 THEN $5::uuid END,
                now() - (g || ' seconds')::interval,
                CASE WHEN g % 4 >= 2 THEN 'open' END, CASE WHEN g % 4 >= 2 THEN 'overflow' END
           FROM generate_series(1, 40000) g`,
        [floor.tenant, floor.account, accountB, RUNG, agent(0).id]);
      await client.query('ANALYZE agency_inbound_calls, agency_contacts, agency_call_attempts, agency_manual_calls, agency_campaigns');
      for (const [name, sql, params] of statements) {
        const { rows } = await client.query<{ 'QUERY PLAN': string }>(`EXPLAIN (COSTS OFF) ${sql}`, params);
        plans.set(name, rows.map((r) => r['QUERY PLAN']).join('\n'));
      }
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
    return plans;
  }

  it('the page walks each account\'s slice in keyset order, the cursor in the index condition, no sort under the limit; the aggregates, the live calls and the callbacks read the same index; no scan of the table', async () => {
    const accounts = [floor.account, accountB];
    const page = [floor.tenant, NUMBER, accounts, 'infinity', UUID_MAX, 51, null, null, null];
    const plans = await plansOf([
      ['pageInboundCalls', CUSTOMER_HISTORY_SQL.pageInboundCalls, [...page, null, null, null, false]],
      ['callStats', CUSTOMER_HISTORY_SQL.callStats, [floor.tenant, NUMBER, accounts]],
      ['liveCalls', CUSTOMER_HISTORY_SQL.liveCalls, [floor.tenant, NUMBER, accounts]],
      ['pageCallbacks', CUSTOMER_HISTORY_SQL.pageCallbacks, page],
      ['latestBookings', CUSTOMER_HISTORY_SQL.latestBookings, [floor.tenant, accounts, [ids.contact], NUMBER]],
    ]);
    for (const [name, plan] of plans) {
      // The live arm may come from an index of live calls alone (every call still on, or the
      // account's): there are few of them whatever the number's history.
      if (name === 'liveCalls') expect(plan, `${name}\n${plan}`).toMatch(/idx_agency_inbound_calls_(from|open|account_live)\b/);
      else expect(plan, `${name}\n${plan}`).toContain('idx_agency_inbound_calls_from');
      expect(plan, `${name}\n${plan}`).not.toMatch(/Seq Scan on agency_inbound_calls/);
      // No other index of the table stands in for it (the account's ended calls, 0033's answered ones).
      expect(plan, `${name}\n${plan}`).not.toMatch(/idx_agency_inbound_calls_(account_arrived|answered_from)/);
    }
    const walk = plans.get('pageInboundCalls')!;
    expect(walk, walk).toMatch(/Limit\n\s+->\s+Index Scan using idx_agency_inbound_calls_from/);
    expect(walk, walk).toMatch(/Index Cond: .*account_id = acc\.id.*from_e164.*ROW\(arrived_at, id\) < ROW\(/);
  });
});
