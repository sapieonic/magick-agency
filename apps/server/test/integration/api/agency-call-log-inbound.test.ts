import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';

/**
 * Inbound calls in the campaign Call log (`docs/call-log.md` §4, P2), on real Postgres through
 * the real app: the third branch of `listCallLogForCampaign`, its counts, the To follow up view,
 * how each filter reads on an inbound call, the missed call and its call back pointing at each
 * other, the export's inbound rows, the inbound Call page's read, and that the arrival files a
 * matched call under its campaign.
 *
 * The seed is one campaign with a few calls of each type, placed so every rule has a row on each
 * side of it (below). The plan test at the end is the branch's own statement on 0068's index.
 */

const mocks = vi.hoisted(() => {
  process.env['SUPER_ADMIN_JWT_SECRET'] = 'call-log-inbound-secret-0123456789';
  return { verifyIdToken: vi.fn() };
});
vi.mock('../../../src/auth/firebase.js', () => ({ initFirebase: vi.fn(), verifyIdToken: mocks.verifyIdToken }));

import { getTestPool, truncateAll } from '../../../../../packages/db/test/helpers/test-db.js';
import { getPool } from '@magick-agency/db';
import {
  call, seedFloor, startLoadApp, stopLoadApp, verifyTestToken,
  type LoadApp, type TenantFloor,
} from '../load/load-harness.js';
import { insertInboundCall, walkKeyset, type InboundCallSeed } from '../../helpers/call-log-seed.js';
import { ATTEMPT_CSV_COLUMNS } from '../../../src/agency/agency-spine.js';
import { agencyAttemptRepository, agencyInboundCallRepository } from '../../../src/db/repositories/agency.repository.js';

let loaded: LoadApp;
let floor: TenantFloor;
let other: TenantFloor;
let campaignId: string;
let siblingCampaignId: string;
const q = (sql: string, values: unknown[] = []) => getTestPool().query(sql, values);
const MIN = 60_000;
/** Three hours ago, so every seeded minute below is in the past. */
const BASE = new Date(Math.floor((Date.now() - 3 * 60 * MIN) / MIN) * MIN);
const at = (minutes: number, seconds = 0) => new Date(BASE.getTime() + minutes * MIN + seconds * 1000);
const RUNG = '+919000000009';
const CALLER_B = '+919812307730';

const get = async (path: string, actor = () => floor.supervisors[0]!) => {
  const res = await call(loaded.app, 'GET', path, actor(), floor);
  expect(res.statusCode, `${path}: ${res.body}`).toBe(200);
  return res;
};

/** The seeded rows, by the label the tests name them with. */
const id = new Map<string, string>();
let contactA: string;
let contactD: string;

/**
 * An `agency_inbound_calls` row, straight into the table (`insertInboundCall`): on this floor,
 * filed under the campaign and from a number of its own unless the test says otherwise.
 */
async function inbound(label: string, o: Omit<InboundCallSeed, 'tenantId' | 'accountId' | 'campaign' | 'from' | 'to'> & {
  tenant?: TenantFloor;
  campaign?: string | null;
  from?: string | null;
}): Promise<string> {
  const { tenant, campaign, from, ...seed } = o;
  const f = tenant ?? floor;
  const rowId = await insertInboundCall(label, {
    ...seed,
    tenantId: f.tenant,
    accountId: f.account,
    campaign: campaign === undefined ? campaignId : campaign,
    from: from === undefined ? `+9198${String(id.size).padStart(8, '0')}` : from,
    to: RUNG,
  });
  id.set(label, rowId);
  return rowId;
}

beforeAll(async () => {
  mocks.verifyIdToken.mockImplementation(verifyTestToken);
  loaded = await startLoadApp();
  await truncateAll();
  [floor, other] = await seedFloor({ tenants: 2, agentsPerTenant: 2, supervisorsPerTenant: 1, campaignsPerTenant: 2, staffAgents: true }) as [TenantFloor, TenantFloor];
  campaignId = floor.campaigns[0]!;
  siblingCampaignId = floor.campaigns[1]!;
  const [agent0, agent1] = [floor.agents[0]!.id, floor.agents[1]!.id];
  await q(`UPDATE agency_campaigns SET status = 'running', started_at = $2, created_at = $2 WHERE id = ANY($1::uuid[])`, [floor.campaigns, at(-5000)]);

  // ── The dialler: one conversation, and one dial stopped because the customer rang us. ──
  const { rows: [session] } = await q(
    `INSERT INTO agency_agent_sessions (tenant_id, account_id, campaign_id, agent_user_id, state, joined_at, left_at)
     VALUES ($1, $2, $3, $4, 'offline', $5, $6) RETURNING id`, [floor.tenant, floor.account, campaignId, agent0, at(0), at(170)]);
  const contact = async (phone: string) => (await q(
    `INSERT INTO agency_contacts (campaign_id, tenant_id, account_id, phone_e164, context, state)
     VALUES ($1, $2, $3, $4, '{}'::jsonb, 'completed') RETURNING id`, [campaignId, floor.tenant, floor.account, phone])).rows[0].id as string;
  contactA = await contact('+919700004821');
  contactD = await contact('+919700002210');
  const attempt = async (label: string, contactId: string, created: Date, outcome: string, code: string | null) => {
    const { rows: [row] } = await q(
      `INSERT INTO agency_call_attempts (campaign_id, contact_id, tenant_id, account_id, attempt_number, caller_id, reserved_agent_id,
              state, outcome, disposition_code, dialed_at, ended_at, redial_number, created_at)
       VALUES ($1, $2, $3, $4, 1, '+919000000001', $5, 'ended', $6, $7, $8, $9, 0, $8) RETURNING id`,
      [campaignId, contactId, floor.tenant, floor.account, session.id, outcome, code, created, new Date(created.getTime() + 30_000)]);
    id.set(label, row.id as string);
  };
  await attempt('d1', contactA, at(10), 'connected', 'interested');
  await attempt('d2', contactD, at(20), 'canceled', 'inbound_call');

  // ── Inbound, filed under the campaign. ──
  // A: answered by the caller's own agent after 18 s; matched to the roster.
  await inbound('A', {
    arrived: at(42), matched: contactA, from: '+919700004821', queuedAfter: 3, bridgedAfter: 18, answeredBy: agent0, sticky: agent0,
    endedAfter: 270, talk: 252, code: 'will_pay',
  });
  // B: nobody free, left a voicemail; open, assigned to agent 1. Filed by a source other than the
  // match (no matched campaign), so only `campaign_id` puts it in this log.
  await inbound('B', {
    arrived: at(12), from: CALLER_B, outcome: 'voicemail', queuedAfter: 2, endedAfter: 100, voicemailSeconds: 22,
    followUp: { status: 'open', reason: 'overflow', assignee: agent1 },
  });
  // C: out of hours, number withheld; open, the account's.
  await inbound('C', { arrived: at(15), from: null, outcome: 'closed', closedCause: 'hours', followUp: { status: 'open', reason: 'closed' } });
  // D: hung up while waiting; closed since, because the customer was reached.
  await inbound('D', {
    arrived: at(22), matched: contactD, from: '+919700002210', outcome: 'abandoned_in_queue', queuedAfter: 2, endedAfter: 52,
    followUp: { status: 'handled', reason: 'abandoned_in_queue', handledBy: agent0, handledReason: 'reached' },
  });
  // J: an open Missed row from two days ago: outside any "today", still owed a call.
  await inbound('J', { arrived: at(-2 * 24 * 60), outcome: 'overflow_no_capacity', followUp: { status: 'open', reason: 'overflow_no_capacity' } });
  // Never rows of this log: live, turned away, filed under nothing, another campaign's, another tenant's.
  await inbound('live', { arrived: at(50), state: 'queued', queuedAfter: 2 });
  await inbound('rejected', { arrived: at(51), outcome: 'rejected' });
  await inbound('unfiled', { arrived: at(52), campaign: null, outcome: 'closed', followUp: { status: 'open', reason: 'closed' } });
  await inbound('sibling', { arrived: at(53), campaign: siblingCampaignId, outcome: 'closed', followUp: { status: 'open', reason: 'closed' } });
  await inbound('other-tenant', { arrived: at(54), tenant: other, outcome: 'closed', followUp: { status: 'open', reason: 'closed' } });

  // ── The soft phone, by agent 1: B's call back, a call back that never dialled, a plain call. ──
  const { rows: [soft] } = await q(
    `INSERT INTO agency_agent_sessions (tenant_id, account_id, campaign_id, agent_user_id, state, kind, joined_at, left_at)
     VALUES ($1, $2, NULL, $3, 'offline', 'softphone', $4, $5) RETURNING id`, [floor.tenant, floor.account, agent1, at(0), at(170)]);
  const manual = async (label: string, created: Date, to: string, dialled: boolean, callbackOf: string | null) => {
    const ended = new Date(created.getTime() + 60_000);
    const { rows: [row] } = await q(
      `INSERT INTO agency_manual_calls (tenant_id, account_id, session_id, agent_user_id, campaign_id, destination_e164, caller_id,
              state, outcome, disposition_code, disposition_source, dialed_at, bridged_at, ended_at, settled_at, created_at,
              callback_of_inbound_call_id)
       VALUES ($1, $2, $3, $4, $5, $6, '+919000000002', 'ended', $7, $8, $9, $10, $11, $12, $12, $13, $14) RETURNING id`,
      [floor.tenant, floor.account, soft.id, agent1, campaignId, to, dialled ? 'connected' : 'failed', dialled ? 'call_later' : null,
        dialled ? 'campaign' : null, dialled ? new Date(created.getTime() + 500) : null, dialled ? new Date(created.getTime() + 5000) : null,
        ended, created, callbackOf]);
    id.set(label, row.id as string);
  };
  await manual('s1', at(31), CALLER_B, true, id.get('B')!);
  await manual('s3', at(34), CALLER_B, false, id.get('B')!);
  await manual('s2', at(40), '+919811000040', true, null);
}, 180_000);

afterAll(async () => {
  await stopLoadApp(loaded);
});

interface LogRow { type: string; id: string; created_at: string; [key: string]: unknown }
interface LogCounts { all: number; dialler: number; soft_phone: number; inbound: number; to_follow_up: number }
interface LogPage { rows: LogRow[]; next_cursor: string | null; limit: number; counts?: LogCounts }
const logPage = async (params = '', campaign = () => campaignId): Promise<LogPage> =>
  (await get(`/proxy/agency/campaigns/${campaign()}/call-log${params ? `?${params}` : ''}`)).json() as LogPage;
const walkLog = (params: string, limit: number, campaign = () => campaignId): Promise<LogRow[]> =>
  walkKeyset((paging) => logPage(`${params}${params ? '&' : ''}${paging}`, campaign), limit);
const labels = (rows: LogRow[]) => rows.map((row) => [...id.entries()].find(([, value]) => value === row.id)?.[0] ?? row.id);
const counts = async (params = '') => (await logPage(`include_counts=1${params ? `&${params}` : ''}`)).counts!;
const iso = (d: Date) => encodeURIComponent(d.toISOString());

describe('the Call log lists a campaign\'s inbound calls with its dials and soft-phone calls', () => {
  it('every type once, newest first on one keyset, an inbound call placed by when it arrived', async () => {
    const ORDER = ['A', 's2', 's3', 's1', 'D', 'd2', 'C', 'B', 'd1', 'J'];
    expect(labels((await logPage()).rows)).toEqual(ORDER);
    // A page size that lands boundaries between types and inside each.
    for (const limit of [1, 3, 4]) expect(labels(await walkLog('', limit)), `limit ${limit}`).toEqual(ORDER);
    const types = Object.fromEntries((await logPage()).rows.map((row) => [labels([row])[0]!, row.type]));
    expect(types).toMatchObject({ A: 'inbound', B: 'inbound', s1: 'soft_phone', d1: 'dialler' });
  });

  it('only ended calls we served, filed under this campaign in this tenant', async () => {
    const listed = new Set((await walkLog('', 50)).map((row) => row.id));
    for (const label of ['live', 'rejected', 'unfiled', 'sibling', 'other-tenant']) {
      expect(listed.has(id.get(label)!), label).toBe(false);
    }
    // The sibling campaign's own log holds its call, and only that.
    expect(labels((await logPage('', () => siblingCampaignId)).rows)).toEqual(['sibling']);
  });

  it('an inbound row carries its own facts: the wait, the queue, the sticky agent, the Missed row, the voicemail', async () => {
    const rows = new Map((await logPage()).rows.map((row) => [labels([row])[0]!, row]));
    expect(rows.get('A')).toMatchObject({
      type: 'inbound', campaign_id: campaignId, campaign_source: 'contact', contact_id: contactA,
      phone_e164: '+919700004821', caller_id: RUNG, agent_user_id: floor.agents[0]!.id, state: 'ended', outcome: 'answered',
      disposition_code: 'will_pay', talk_seconds: 252, wait_seconds: 18, queued: true, via_sticky_agent: true,
      requires_disposition: false, voicemail_seconds: null, follow_up: null, called_back: null,
      created_at: at(42).toISOString(), bridged_at: at(42, 18).toISOString(),
    });
    expect(typeof rows.get('A')!['agent_name']).toBe('string');
    expect(rows.get('B')).toMatchObject({
      type: 'inbound', campaign_source: 'route', contact_id: null, phone_e164: CALLER_B, agent_user_id: null, agent_name: null,
      outcome: 'voicemail', wait_seconds: 100, queued: true, via_sticky_agent: false, voicemail_seconds: 22, talk_seconds: null,
      follow_up: { status: 'open', reason: 'overflow', closed_cause: null, assignee_user_id: floor.agents[1]!.id, handled_reason: null, handled_at: null },
    });
    expect(typeof (rows.get('B')!['follow_up'] as { assignee_name: unknown }).assignee_name).toBe('string');
    // Withheld: no number, never queued; the account's row (no assignee).
    expect(rows.get('C')).toMatchObject({
      phone_e164: null, queued: false, outcome: 'closed',
      follow_up: { status: 'open', reason: 'closed', closed_cause: 'hours', assignee_user_id: null, assignee_name: null },
    });
    expect(rows.get('D')).toMatchObject({
      outcome: 'abandoned_in_queue', wait_seconds: 52,
      follow_up: { status: 'handled', reason: 'abandoned_in_queue', handled_reason: 'reached', handled_at: at(22, 52).toISOString() },
    });
    // The attempt-only columns the union carries are not on an inbound row.
    for (const key of ['source', 'inbound', 'extra', 'attempt_number', 'dialed_at', 'wrapup_seconds', 'reserved_agent_id']) {
      expect(rows.get('A'), key).not.toHaveProperty(key);
    }
  });

  it('a missed call and its call back point at each other; a call back that never dialled is not "called back"', async () => {
    const rows = new Map((await logPage()).rows.map((row) => [labels([row])[0]!, row]));
    // s3 was created later than s1 and never dialled: B was called back by s1.
    expect(rows.get('B')!['called_back']).toEqual({ call_id: id.get('s1'), at: at(31).toISOString() });
    expect(rows.get('s1')!['callback_of']).toEqual({ inbound_call_id: id.get('B'), arrived_at: at(12).toISOString() });
    expect(rows.get('s2')!['callback_of']).toBeNull();
    expect(rows.get('C')!['called_back']).toBeNull();
    // The dial the customer's own call stopped says so in its own columns (docs/inbound.md §5.4).
    expect(rows.get('d2')).toMatchObject({ type: 'dialler', outcome: 'canceled', disposition_code: 'inbound_call' });
  });
});

describe('the chips: Inbound and To follow up', () => {
  it('counts each type by the filters; To follow up is the open Missed rows and is not added to All twice', async () => {
    // s3 never dialled: listed, counted nowhere (SR2).
    expect(await counts()).toEqual({ all: 9, dialler: 2, soft_phone: 2, inbound: 5, to_follow_up: 3 });
    expect(labels((await logPage('type=inbound')).rows)).toEqual(['A', 'D', 'C', 'B', 'J']);
    expect(labels((await logPage('type=to_follow_up')).rows)).toEqual(['C', 'B', 'J']);
    // The chip changes the rows, never the counts.
    expect((await logPage('include_counts=1&type=to_follow_up&limit=1')).counts).toEqual(await counts());
    expect(labels(await walkLog('type=to_follow_up', 1))).toEqual(['C', 'B', 'J']);
  });

  it('To follow up ignores the dates, and nothing else: someone owed a call back two days ago is still owed one', async () => {
    const today = `from=${iso(at(0))}&to=${iso(at(170))}`;
    expect(await counts(today)).toEqual({ all: 8, dialler: 2, soft_phone: 2, inbound: 4, to_follow_up: 3 });
    expect(labels((await logPage(`type=inbound&${today}`)).rows)).toEqual(['A', 'D', 'C', 'B']);
    expect(labels((await logPage(`type=to_follow_up&${today}`)).rows)).toEqual(['C', 'B', 'J']);
    // Every other filter applies to it: the caller's number keeps B alone.
    expect(labels((await logPage(`type=to_follow_up&${today}&phone=7730`)).rows)).toEqual(['B']);
    expect((await counts(`${today}&phone=7730`)).to_follow_up).toBe(1);
  });

  it('follows the Missed list: a row marked handled leaves To follow up, and a reopened one returns', async () => {
    const before = await counts();
    const marked = await agencyInboundCallRepository.markHandled({
      tenantId: floor.tenant, accountId: floor.account, id: id.get('C')!, userId: floor.supervisors[0]!.id,
    });
    expect(marked?.changed).toBe(true);
    try {
      expect((await counts()).to_follow_up).toBe(before.to_follow_up - 1);
      expect(labels((await logPage('type=to_follow_up')).rows)).toEqual(['B', 'J']);
      // Still an inbound call of the campaign: closing a Missed row is a status, not a call.
      expect((await counts()).inbound).toBe(before.inbound);
    } finally {
      await agencyInboundCallRepository.reopenMissed({ tenantId: floor.tenant, accountId: floor.account, id: id.get('C')! });
    }
    expect(await counts()).toEqual(before);
    // The Missed list's own open count for the account agrees about this campaign's rows.
    const open = await agencyInboundCallRepository.countMissed({ tenantId: floor.tenant, accountId: floor.account });
    // B, C, J on this campaign, plus `unfiled` and `sibling` elsewhere in the account.
    expect(open.open).toBe(5);
  });
});

describe('how a filter reads on each type', () => {
  it('agent is who answered an inbound call; a missed call has no agent', async () => {
    expect(await counts(`agent_user_id=${floor.agents[0]!.id}`)).toEqual({ all: 3, dialler: 2, soft_phone: 0, inbound: 1, to_follow_up: 0 });
    // Assigned to agent 1, answered by nobody: not agent 1's call (Inbound 0)...
    expect(await counts(`agent_user_id=${floor.agents[1]!.id}`)).toEqual({ all: 2, dialler: 0, soft_phone: 2, inbound: 0, to_follow_up: 1 });
    expect((await logPage(`type=inbound&agent_user_id=${floor.agents[1]!.id}`)).rows).toEqual([]);
    // ...but theirs to follow up: under To follow up the agent is who the Missed row is assigned to.
    expect(labels((await logPage(`type=to_follow_up&agent_user_id=${floor.agents[1]!.id}`)).rows)).toEqual(['B']);
    // Agent 0 answered A and holds no open row.
    expect((await logPage(`type=to_follow_up&agent_user_id=${floor.agents[0]!.id}`)).rows).toEqual([]);
  });

  it('What happened: connected is an answered inbound call; Missed, Voicemail and Abandoned match inbound calls only', async () => {
    expect(await counts('outcome=connected')).toEqual({ all: 4, dialler: 1, soft_phone: 2, inbound: 1, to_follow_up: 0 });
    expect(await counts('outcome=missed')).toEqual({ all: 4, dialler: 0, soft_phone: 0, inbound: 4, to_follow_up: 3 });
    expect(labels((await logPage('outcome=missed')).rows)).toEqual(['D', 'C', 'B', 'J']);
    expect(await counts('outcome=voicemail')).toEqual({ all: 1, dialler: 0, soft_phone: 0, inbound: 1, to_follow_up: 1 });
    expect(await counts('outcome=abandoned_in_queue')).toEqual({ all: 1, dialler: 0, soft_phone: 0, inbound: 1, to_follow_up: 0 });
    // One OR-ed set across the two vocabularies.
    expect(await counts('outcome=connected,missed')).toEqual({ all: 8, dialler: 1, soft_phone: 2, inbound: 5, to_follow_up: 3 });
    // An attempt outcome an inbound call cannot have matches none of them.
    expect(await counts('outcome=canceled')).toEqual({ all: 1, dialler: 1, soft_phone: 0, inbound: 0, to_follow_up: 0 });
    // The rows of a chip are what its count says, with an inbound-only happening on a type it cannot match.
    expect((await logPage('outcome=missed&type=dialler')).rows).toEqual([]);
    expect((await logPage('outcome=missed&type=soft_phone')).rows).toEqual([]);
  });

  it('the outcome code, the contact, the caller\'s number, the number rung and the state', async () => {
    expect(await counts('disposition_code=will_pay')).toEqual({ all: 1, dialler: 0, soft_phone: 0, inbound: 1, to_follow_up: 0 });
    expect(await counts(`contact_id=${contactA}`)).toEqual({ all: 2, dialler: 1, soft_phone: 0, inbound: 1, to_follow_up: 0 });
    // The caller's number on an inbound call; the number dialled on a soft-phone one.
    expect(await counts('phone=7730')).toEqual({ all: 2, dialler: 0, soft_phone: 1, inbound: 1, to_follow_up: 1 });
    // `caller_id` is the number they rang.
    expect(await counts(`caller_id=${encodeURIComponent(RUNG)}`)).toEqual({ all: 5, dialler: 0, soft_phone: 0, inbound: 5, to_follow_up: 3 });
    expect((await counts('state=ended')).inbound).toBe(5);
    expect((await counts('state=queued')).inbound).toBe(0);
  });

  it('a filter about a dial, and the soft-phone status, leave inbound calls out', async () => {
    for (const filter of ['placed=1', 'placed=0', 'redial=1', 'agent_manual=1', 'agent_reopened=1', 'override_applied=1',
      `dialed_from=${iso(at(-5000))}`, `dialed_to=${iso(at(5000))}`, 'status=settled']) {
      const c = await counts(filter);
      expect([c.inbound, c.to_follow_up], filter).toEqual([0, 0]);
      expect((await logPage(`${filter}&type=inbound`)).rows, filter).toEqual([]);
      expect((await logPage(`${filter}&type=to_follow_up`)).rows, filter).toEqual([]);
    }
    // `=0` of an attempt-only dimension keeps them, as it keeps soft-phone calls.
    expect((await counts('redial=0')).inbound).toBe(5);
    // The status filter is the soft phone's alone.
    expect(await counts('status=settled')).toEqual({ all: 2, dialler: 0, soft_phone: 2, inbound: 0, to_follow_up: 0 });
  });

  it('refuses a type or a happening it does not know', async () => {
    for (const bad of ['type=missed', 'type=follow_up', 'outcome=missed,nonsense']) {
      const refused = await call(loaded.app, 'GET', `/proxy/agency/campaigns/${campaignId}/call-log?${bad}`, floor.supervisors[0]!, floor);
      expect(refused.statusCode, bad).toBe(400);
    }
  });
});

describe('a page boundary between an inbound call and a soft-phone call on one instant', () => {
  it('drops and repeats neither', async () => {
    const instant = at(60);
    const tied = await inbound('tie-inbound', { arrived: instant, campaign: siblingCampaignId, outcome: 'closed', followUp: { status: 'open', reason: 'closed' } });
    const { rows: [session] } = await q(
      `INSERT INTO agency_agent_sessions (tenant_id, account_id, campaign_id, agent_user_id, state, kind, joined_at, left_at)
       VALUES ($1, $2, NULL, $3, 'offline', 'softphone', $4, $5) RETURNING id`, [floor.tenant, floor.account, floor.agents[0]!.id, at(0), at(170)]);
    const { rows: [soft] } = await q(
      `INSERT INTO agency_manual_calls (tenant_id, account_id, session_id, agent_user_id, campaign_id, destination_e164, caller_id,
              state, outcome, dialed_at, ended_at, settled_at, created_at)
       VALUES ($1, $2, $3, $4, $5, '+919811000060', '+919000000002', 'ended', 'no_answer', $6, $6, $6, $6) RETURNING id`,
      [floor.tenant, floor.account, session.id, floor.agents[0]!.id, siblingCampaignId, instant]);
    // Only the id orders the two; whichever sorts first, a one-row page must hand over to the other.
    const expected = [tied, soft.id as string].sort().reverse();
    const walked = await walkLog('', 1, () => siblingCampaignId);
    expect(walked.map((row) => row.id)).toEqual([...expected, id.get('sibling')]);
    expect(walked.map((row) => row.created_at).slice(0, 2)).toEqual([instant.toISOString(), instant.toISOString()]);
  });
});

/** A preamble-less export's rows, keyed by column. */
async function exportRows(params = ''): Promise<Array<Record<string, string>>> {
  const res = await get(`/proxy/agency/campaigns/${campaignId}/attempts.csv?preamble=false${params}`);
  const lines = res.body.split('\n').filter((l) => l.length > 0);
  expect(lines[0]).toBe(ATTEMPT_CSV_COLUMNS.join(','));
  // No cell in this seed carries a comma or a quote.
  return lines.slice(1).map((line) => Object.fromEntries(ATTEMPT_CSV_COLUMNS.map((c, i) => [c, line.split(',')[i] ?? ''])));
}

describe('the export carries the inbound rows', () => {
  it('source gains inbound, with the wait, the missed reason and the call back\'s link at the end of the row', async () => {
    const rows = await exportRows();
    expect(rows.map((row) => row['source'])).toEqual(
      ['inbound', 'soft_phone', 'soft_phone', 'soft_phone', 'inbound', 'dialler', 'inbound', 'inbound', 'dialler', 'inbound']);
    const byId = new Map(rows.map((row) => [row['attempt_id']!, row]));
    expect(byId.get(id.get('A')!)).toMatchObject({
      source: 'inbound', contact_id: contactA, attempt_number: '', agent_user_id: floor.agents[0]!.id, state: 'ended', outcome: 'answered',
      disposition_code: 'will_pay', talk_seconds: '252', dialed_at: '', created_at: at(42).toISOString(),
      wait_seconds: '18', missed_reason: '', callback_of: '',
    });
    expect(byId.get(id.get('B')!)).toMatchObject({ source: 'inbound', agent_user_id: '', outcome: 'voicemail', wait_seconds: '100', missed_reason: 'overflow' });
    // Withheld: an empty phone cell.
    expect(byId.get(id.get('C')!)).toMatchObject({ phone: '', missed_reason: 'closed' });
    expect(byId.get(id.get('s1')!)).toMatchObject({ source: 'soft_phone', callback_of: id.get('B'), wait_seconds: '', missed_reason: '' });
    expect(byId.get(id.get('s2')!)).toMatchObject({ callback_of: '' });
    expect(byId.get(id.get('d1')!)).toMatchObject({ source: 'dialler', wait_seconds: '', missed_reason: '', callback_of: '' });
  });

  it('source keeps one type, or the open Missed rows', async () => {
    expect((await exportRows('&source=inbound')).map((row) => row['attempt_id'])).toEqual(['A', 'D', 'C', 'B', 'J'].map((l) => id.get(l)));
    expect((await exportRows('&source=to_follow_up')).map((row) => row['attempt_id'])).toEqual(['C', 'B', 'J'].map((l) => id.get(l)));
    expect((await exportRows('&source=dialler')).every((row) => row['source'] === 'dialler')).toBe(true);
    expect(await exportRows('&source=inbound&outcome=voicemail')).toHaveLength(1);
  });
});

describe('the inbound Call page\'s read', () => {
  const detail = (label: string, campaign = campaignId) => `/proxy/agency/campaigns/${campaign}/call-log/inbound/${id.get(label)}`;

  it('serves the Call log\'s row and the caller\'s path, for a supervisor', async () => {
    const body = (await get(detail('A'))).json();
    expect(body.inbound).toMatchObject({ type: 'inbound', id: id.get('A'), outcome: 'answered', wait_seconds: 18, via_sticky_agent: true });
    // The same row the list serves.
    const listed = (await logPage('type=inbound&limit=1')).rows[0];
    expect(body.inbound).toEqual(listed);
    expect(body.journey).toEqual([
      { kind: 'rang', at: at(42).toISOString(), seconds: null },
      { kind: 'greeting', at: at(42).toISOString(), seconds: null },
      { kind: 'waited', at: null, seconds: 18 },
      { kind: 'answered', at: at(42, 18).toISOString(), seconds: null },
      { kind: 'ended', at: at(42, 270).toISOString(), seconds: 252 },
    ]);
    expect(typeof body.dispositioned_by_name).toBe('string');
    // No media leg was seeded: there was never a recording, said as such.
    expect(body).toMatchObject({ call: null, call_availability: 'never_placed', voicemail_url: null });

    const missed = (await get(detail('B'))).json();
    expect(missed.journey.map((step: { kind: string }) => step.kind)).toEqual(['rang', 'greeting', 'waited', 'missed', 'voicemail', 'ended']);
    expect(missed.voicemail_url).toBe(`/inbound/missed/${id.get('B')}/voicemail`);
    expect(missed.inbound.called_back).toEqual({ call_id: id.get('s1'), at: at(31).toISOString() });
  });

  it('is a 404 for a call that is not a row of this campaign\'s log', async () => {
    const supervisor = floor.supervisors[0]!;
    for (const label of ['live', 'rejected', 'unfiled', 'sibling', 'other-tenant']) {
      const res = await call(loaded.app, 'GET', detail(label), supervisor, floor);
      expect(res.statusCode, label).toBe(404);
      expect(res.json().code, label).toBe('inbound_call_not_found');
    }
    expect((await call(loaded.app, 'GET', `/proxy/agency/campaigns/${campaignId}/call-log/inbound/${randomUUID()}`, supervisor, floor)).statusCode).toBe(404);
    // Its own campaign serves it.
    expect((await get(detail('sibling', siblingCampaignId))).json().inbound.id).toBe(id.get('sibling'));
  });

  it('is the supervisor\'s: an agent is refused the page and the recording, and another tenant finds no such campaign', async () => {
    for (const path of [detail('A'), `${detail('A')}/recording`, `/proxy/agency/campaigns/${campaignId}/call-log?type=inbound`]) {
      expect((await call(loaded.app, 'GET', path, floor.agents[0]!, floor)).statusCode, path).toBe(403);
    }
    expect((await call(loaded.app, 'GET', detail('A'), other.supervisors[0]!, other)).statusCode).toBe(404);
    // A supervisor asking for a recording that never was is told so, not served bytes.
    const recording = await call(loaded.app, 'GET', `${detail('A')}/recording`, floor.supervisors[0]!, floor);
    expect([403, 404]).toContain(recording.statusCode);
    expect(recording.headers['content-type']).toMatch(/json/);
  });
});

describe('the arrival files a matched call under its campaign', () => {
  it('campaign_id is the matched campaign with source contact; an unmatched call is filed under none', async () => {
    const arrive = async (match: { contactId: string; campaignId: string } | null) => (await agencyInboundCallRepository.insertArrival({
      tenantId: floor.tenant, accountId: null, routeId: null, phoneNumberId: null, provider: 'plivo', telephonyCredentialId: null,
      providerCallId: `CA-${randomUUID()}`, fromE164: '+919700004821', toE164: RUNG,
      identification: { match: null, callerDnc: false, sticky: null }, answered: true, recordingRequested: false, analysisProfileId: null,
      ...(match ? { accountId: floor.account, identification: { match, callerDnc: false, sticky: null } } : {}),
    })).call!;
    const matched = await arrive({ contactId: contactA, campaignId });
    expect(matched).toMatchObject({ matched_campaign_id: campaignId, campaign_id: campaignId, campaign_source: 'contact' });
    const unmatched = await arrive(null);
    expect(unmatched).toMatchObject({ matched_campaign_id: null, campaign_id: null, campaign_source: null });
    // Live: not yet a row of the log; ended, it is one.
    const listedLive = (await logPage('type=inbound')).rows.map((row) => row.id);
    expect(listedLive).not.toContain(matched.id);
    await agencyInboundCallRepository.end(matched.id, {
      outcome: 'closed', talkSeconds: null, followUp: { reason: 'closed', assigneeUserId: null }, callbackDueAt: null, voicemailKey: null,
    });
    expect((await logPage('type=inbound')).rows.map((row) => row.id)).toContain(matched.id);
    await q('DELETE FROM agency_calls WHERE inbound_call_id = ANY($1::uuid[])', [[matched.id, unmatched.id]]);
    await q('DELETE FROM agency_inbound_calls WHERE id = ANY($1::uuid[])', [[matched.id, unmatched.id]]);
  });

  it('a call back is linked only to a Missed row of the account from the number dialled', async () => {
    const probe = (label: string, phone: string, f = floor) =>
      agencyInboundCallRepository.isMissedCallFrom(f.tenant, f.account, id.get(label)!, phone);
    expect(await probe('B', CALLER_B)).toBe(true);
    // Formatting does not matter; the digits do.
    expect(await probe('B', '+91 98123 07730')).toBe(true);
    expect(await probe('B', '+919812300000')).toBe(false);
    // An answered call is not a Missed row; a withheld caller has no number to ring back.
    expect(await probe('A', '+919700004821')).toBe(false);
    expect(await probe('C', '+919700004821')).toBe(false);
    // Another tenant's row, or this row asked for from another tenant.
    expect(await probe('B', CALLER_B, other)).toBe(false);
  });
});

describe('the inbound branch\'s own statement and 0068', () => {
  it('plans on idx_agency_inbound_calls_campaign', async () => {
    // Many campaigns' inbound calls beside this one's, so the planner has a reason to choose.
    await q(
      `INSERT INTO agency_inbound_calls (tenant_id, account_id, provider, provider_call_id, from_e164, to_e164, campaign_id, campaign_source,
              state, outcome, arrived_at, ended_at, settled_at)
       SELECT $1, $2, 'plivo', 'CA-plan-' || n, '+9198' || lpad(n::text, 8, '0'), $3,
              CASE WHEN n % 40 = 0 THEN $4::uuid ELSE gen_random_uuid() END, 'route',
              'ended', 'rejected', now() - (n || ' seconds')::interval, now(), now()
         FROM generate_series(1, 8000) n`,
      [floor.tenant, floor.account, RUNG, siblingCampaignId]);
    await q('ANALYZE agency_inbound_calls');
    const pool = getPool();
    const spy = vi.spyOn(pool, 'query');
    let statement: { text: string; values: unknown[] };
    try {
      await agencyAttemptRepository.listCallLogForCampaign({
        campaignId: siblingCampaignId, tenantId: floor.tenant, filters: {}, source: 'inbound', limit: 50,
      });
      const [text, values] = spy.mock.calls.at(-1)! as unknown as [string, unknown[]];
      statement = { text, values };
    } finally {
      spy.mockRestore();
    }
    expect(statement.text).toContain('agency_inbound_calls i');
    const { rows } = await getTestPool().query<{ 'QUERY PLAN': string }>(`EXPLAIN ${statement.text}`, statement.values);
    expect(rows.map((row) => row['QUERY PLAN']).join('\n')).toContain('idx_agency_inbound_calls_campaign');
  });
});
