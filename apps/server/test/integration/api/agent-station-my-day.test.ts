import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';

/**
 * My day (agent station BE-1, BE-2, BE-3; AS6, AS7, AS8): `GET /proxy/agency/my-day` through the
 * REAL app (`buildApp`) on real Postgres, signed in as an agent (Firebase's token check is the one
 * stub): session middleware, tenancy, RBAC, the route and its repository.
 *
 * Pinned here:
 *  - the gate: an agent passes `agency.station.connect`; no account is a 400; a malformed or extra
 *    query a 400 `invalid_my_day_query`; the dialer flag off a 403; a campaign the agent is neither
 *    staffed on nor holding a live session on (or another account's) a 403 `not_staffed`;
 *    `Cache-Control: no-store` on every answer.
 *  - the counts: this agent's attempts on this campaign in the campaign's day, by the floor's
 *    conversation rule (a redialled conversation once), talk time on the agent's leg, successes,
 *    the promises written today on the agent's dialler, soft-phone and inbound calls of the campaign
 *    (AS7); never yesterday's, another agent's or another campaign's.
 *  - `will_pay` null on a campaign whose outcomes record no pay date; the target.
 *  - the call-laters: on pool, the agent's own booked ones; on strict, the ones assigned to them
 *    (a booked one handed to another agent or returned to the pool leaves the booker's list and
 *    the new owner sees it), due before the day's end, oldest first, the overdue ones counted apart; never tomorrow's, another
 *    agent's, a closed or DNC contact's; `comes_to_me` and `left_today_goes_to` by the routing; the
 *    name, never the number; at most 20 rows, the counts uncapped.
 *  - the call-later read is one scan: on pool the booked ones on `idx_agency_contacts_my_callbacks`
 *    (0058, its predicate kept byte for byte), on strict / preferred the assigned ones on
 *    `idx_agency_contacts_assignee` (a call-later the agent booked and still holds is one of them,
 *    listed and counted once), never the roster; the counts on the agent's sessions, their attempts
 *    and the 0050 promise indexes, never a whole call table.
 */

const mocks = vi.hoisted(() => ({ verifyIdToken: vi.fn() }));

vi.mock('../../../src/auth/firebase.js', () => ({
  initFirebase: vi.fn(),
  verifyIdToken: mocks.verifyIdToken,
}));

import { closePool, initDbPool } from '@magick-agency/db';
import type { AgencyMyDay } from '@magick-agency/contracts/api/agency/my-day';
import { TEST_DB_URL, closeTestPool, getTestPool, truncateAll } from '../../../../../packages/db/test/helpers/test-db.js';
import {
  insertAccount,
  insertMembership,
  insertTenant,
  insertUser,
} from '../../../../../packages/db/test/integration/setup/platform-factories.js';
import {
  insertAgencyAttempt, insertAgencyCampaign, insertAgencyContact, insertAgentSession, insertManualCall, insertSoftphoneSession,
} from '../agency/agency-factories.js';
import { buildApp } from '../../../src/app.js';
import { myDayWindow } from '../../../src/agency/my-day.js';
import { MY_CALLBACKS_INDEX_PREDICATE_SQL, MY_DAY_COUNTS_SQL, myCallLaterStatement } from '../../../src/db/repositories/agency.repository.js';

initDbPool({ url: TEST_DB_URL, poolMin: 0, poolMax: 4 });

const MIN = 60_000;
const CATALOG = [
  { code: 'sale', label: 'Sale', is_success: true },
  { code: 'call_later', label: 'Call later', requires_datetime: true },
  { code: 'ptp', label: 'Will pay', requires_promise: true, promise_follow_up_days: 1 },
];
const NO_PROMISE_CATALOG = [
  { code: 'sale', label: 'Sale', is_success: true },
  { code: 'call_later', label: 'Call later', requires_datetime: true },
];

/**
 * A real zone whose local time now is far from midnight, so "today" seeds a few hours either side
 * of now stay inside the campaign's day whenever the suite runs.
 */
function zoneNearNoon(now: Date): string {
  const zones = ['Pacific/Kiritimati', 'Pacific/Auckland', 'Asia/Tokyo', 'Asia/Kolkata', 'Europe/London',
    'America/New_York', 'America/Los_Angeles', 'Pacific/Honolulu', 'Pacific/Pago_Pago'];
  const hour = (z: string) => Number(new Intl.DateTimeFormat('en-GB', { timeZone: z, hour: '2-digit', hourCycle: 'h23' }).format(now));
  return zones.reduce((best, z) => (Math.abs(hour(z) - 12) < Math.abs(hour(best) - 12) ? z : best));
}

let app: FastifyInstance;
const now = new Date();
const ZONE = zoneNearNoon(now);
const DAY = myDayWindow(ZONE, now);
const at = (minutesFromNow: number) => new Date(now.getTime() + minutesFromNow * MIN);

let w: { tenant: string; account: string; otherAccount: string; uid: string; otherUid: string; me: string; other: string };
const c: Record<string, string> = {};
const names: Record<string, string> = {};

function headers(over: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer tok:${w.uid}`, 'x-tenant-id': w.tenant, 'x-account-id': w.account, ...over };
}

const myDay = (campaignId: string, h: Record<string, string> = {}) =>
  app.inject({ method: 'GET', url: `/proxy/agency/my-day?campaign_id=${campaignId}`, headers: headers(h) });

async function ok(campaignId: string, h: Record<string, string> = {}): Promise<AgencyMyDay> {
  const res = await myDay(campaignId, h);
  expect(res.statusCode, res.body).toBe(200);
  expect(res.headers['cache-control']).toBe('no-store');
  return res.json();
}

async function staff(campaignId: string, userId: string): Promise<void> {
  await getTestPool().query(
    'INSERT INTO agency_campaign_agents (tenant_id, account_id, campaign_id, user_id) VALUES ($1, $2, $3, $4)',
    [w.tenant, w.account, campaignId, userId],
  );
}

const scope = () => ({ tenant_id: w.tenant, account_id: w.account });

/** One attempt on its own contact, by `session`, dialled `minutesFromNow`. */
async function attempt(campaignId: string, sessionId: string, minutesFromNow: number, over: Record<string, unknown> = {}) {
  const contact = await insertAgencyContact(campaignId, { ...scope(), state: 'completed', attempt_count: 1 });
  const dialed = at(minutesFromNow);
  return insertAgencyAttempt(campaignId, contact.id, {
    ...scope(), reserved_agent_id: sessionId, state: 'ended', outcome: 'no_answer',
    dialed_at: dialed, created_at: dialed, ended_at: new Date(dialed.getTime() + 20_000), ...over,
  });
}

/** A bridged conversation of `talkSeconds`, written up with `code`. */
function talked(code: string, minutesFromNow: number, talkSeconds: number, over: Record<string, unknown> = {}) {
  const dialed = at(minutesFromNow);
  const bridged = new Date(dialed.getTime() + 10_000);
  return {
    outcome: 'connected', bridged_at: bridged, answered_at: bridged,
    ended_at: new Date(bridged.getTime() + talkSeconds * 1000),
    disposition_code: code, dispositioned_at: new Date(bridged.getTime() + talkSeconds * 1000 + 5_000), ...over,
  };
}

/** A pending call-later on `campaignId` due `minutesFromNow`. */
async function callLater(name: string, campaignId: string, minutesFromNow: number, over: Record<string, unknown> = {}) {
  const row = await insertAgencyContact(campaignId, {
    ...scope(), context: JSON.stringify({ customer_name: `Customer ${name}`, phone: '+919811122233' }),
    attempt_count: 1, last_outcome: 'connected', last_disposition: 'call_later',
    next_attempt_at: at(minutesFromNow), ...over,
  });
  names[row.id as string] = name;
  return row;
}
const booked = (by: string) => ({ callback_booked_by_user_id: by, callback_booked_at: at(-60) });

beforeAll(async () => {
  mocks.verifyIdToken.mockImplementation(async (token: string) => {
    if (token.startsWith('tok:')) return { uid: token.slice(4), email: `${token.slice(4)}@example.com`, email_verified: true };
    throw new Error('bad token');
  });
  app = await buildApp({ ctx: null });
  await app.ready();

  await truncateAll();
  const tenant = await insertTenant();
  const account = await insertAccount({ tenant_id: tenant.id });
  const otherAccount = await insertAccount({ tenant_id: tenant.id });
  const me = await insertUser({ display_name: 'Asha Agent' });
  const other = await insertUser({ display_name: 'Ravi Agent' });
  await insertMembership({ user_id: me.id, tenant_id: tenant.id, account_id: account.id, role: 'agent' });
  await insertMembership({ user_id: other.id, tenant_id: tenant.id, account_id: account.id, role: 'agent' });
  await getTestPool().query(
    `INSERT INTO feature_flag_overrides (flag_key, scope_type, tenant_id, value)
     VALUES ('agency_dialer_enabled', 'tenant', $1, 'true'::jsonb)`,
    [tenant.id],
  );
  w = {
    tenant: tenant.id, account: account.id, otherAccount: otherAccount.id, uid: me.firebase_uid, otherUid: other.firebase_uid,
    me: me.id, other: other.id,
  };

  const campaign = async (key: string, over: Record<string, unknown>) => {
    c[key] = (await insertAgencyCampaign({
      ...scope(), status: 'running', default_timezone: ZONE, disposition_catalog: JSON.stringify(CATALOG), ...over,
    })).id as string;
  };
  // P: pool, the agent holds a live session on it but is not staffed. Q: no promise outcome,
  // staffed. S: strict, fallback wait, staffed. R: the cap. X: neither. Y: another account.
  // O: preferred, staffed, one call-later the agent booked and still holds.
  await campaign('P', { name: 'Pool', daily_target_calls: 80 });
  await campaign('Q', { name: 'No promise', disposition_catalog: JSON.stringify(NO_PROMISE_CATALOG) });
  await campaign('S', { name: 'Strict', assignment_mode: 'strict', callback_fallback: 'wait' });
  await campaign('R', { name: 'Cap' });
  await campaign('O', { name: 'Preferred', assignment_mode: 'preferred', callback_fallback: 'wait' });
  await campaign('X', { name: 'Not mine' });
  await campaign('Y', { name: 'Other account', account_id: otherAccount.id });
  for (const k of ['Q', 'S', 'R', 'O']) await staff(c[k]!, me.id);
  await staff(c['S']!, other.id);
  await getTestPool().query(
    'INSERT INTO agency_campaign_agents (tenant_id, account_id, campaign_id, user_id) VALUES ($1, $2, $3, $4)',
    [w.tenant, otherAccount.id, c['Y'], me.id],
  );

  // ── P's attempts ─────────────────────────────────────────────────────────────
  const s0 = await insertAgentSession(c['P']!, { ...scope(), agent_user_id: me.id, state: 'offline',
    joined_at: new Date(DAY.start.getTime() - 10 * 60 * MIN), left_at: new Date(DAY.start.getTime() - 8 * 60 * MIN) });
  const s1 = await insertAgentSession(c['P']!, { ...scope(), agent_user_id: me.id, state: 'offline', joined_at: at(-180), left_at: at(-120) });
  const sq = await insertAgentSession(c['Q']!, { ...scope(), agent_user_id: me.id, state: 'offline', joined_at: at(-110), left_at: at(-100) });
  const s2 = await insertAgentSession(c['P']!, { ...scope(), agent_user_id: me.id, state: 'available', joined_at: at(-90) });
  const theirs = await insertAgentSession(c['P']!, { ...scope(), agent_user_id: other.id, state: 'available', joined_at: at(-90) });

  await attempt(c['P']!, s1.id, -150, talked('sale', -150, 120));
  await attempt(c['P']!, s1.id, -140);
  // A conversation redialled from wrap-up: the original closed `redialed`, its redial carries the
  // outcome and the promise. One conversation, two dials, both legs' talk time.
  const original = await attempt(c['P']!, s2.id, -30, talked('redialed', -30, 60));
  await insertAgencyAttempt(c['P']!, original.contact_id, {
    ...scope(), reserved_agent_id: s2.id, state: 'ended', attempt_number: 2, redial_number: 1,
    redial_of_attempt_id: original.id, dialed_at: at(-28), created_at: at(-28),
    ...talked('ptp', -28, 30, { promise_date: '2099-01-01', dispositioned_at: at(-20) }),
  });
  // Yesterday's, on a session that ended yesterday: never today's.
  await attempt(c['P']!, s0.id, -60 * 30 - (now.getTime() - DAY.start.getTime()) / MIN,
    talked('ptp', -60 * 30, 100, { dialed_at: new Date(DAY.start.getTime() - 9 * 60 * MIN), promise_date: '2099-01-01',
      dispositioned_at: new Date(DAY.start.getTime() - 9 * 60 * MIN) }));
  // Another agent's, today.
  await attempt(c['P']!, theirs.id, -20, talked('ptp', -20, 300, { promise_date: '2099-01-01' }));
  // The agent's own on another campaign, today.
  await attempt(c['Q']!, sq.id, -105, talked('sale', -105, 45));

  // AS7: promises the agent saved today on a soft-phone call and on an inbound call, on P, count
  // too; one on another campaign, another agent's, yesterday's and an outcome with no promise do
  // not. A soft-phone session that ended earlier today (one live session per agent).
  const phone = await insertSoftphoneSession({ ...scope(), agent_user_id: me.id, state: 'offline', joined_at: at(-200), left_at: at(-190) });
  const theirPhone = await insertSoftphoneSession({ ...scope(), agent_user_id: other.id, state: 'offline', joined_at: at(-200), left_at: at(-190) });
  const softPromise = (session: typeof phone, campaignId: string | null, when: Date, promise: string | null = '2099-01-01') =>
    insertManualCall(session as { id: string; tenant_id: string; account_id: string; agent_user_id: string }, {
      campaign_id: campaignId, state: 'ended', ended_at: when, disposition_code: 'ptp', dispositioned_at: when,
      promise_date: promise, settled_at: when,
    });
  await softPromise(phone, c['P']!, at(-195));
  await softPromise(phone, c['Q']!, at(-195));
  await softPromise(phone, c['P']!, at(-194), null);
  await softPromise(theirPhone, c['P']!, at(-195));
  await softPromise(phone, c['P']!, new Date(DAY.start.getTime() - 60 * MIN));
  const inboundPromise = (answeredBy: string, campaignId: string, when: Date) => getTestPool().query(
    `INSERT INTO agency_inbound_calls (tenant_id, account_id, provider_call_id, to_e164, state, ended_at, outcome, bridged_at,
                                       answered_by_user_id, settled_at, matched_campaign_id, disposition_code, disposition_source,
                                       dispositioned_at, promise_date)
     VALUES ($1, $2, $3, '+919000000002', 'ended', $4, 'answered', $4, $5, $4, $6, 'ptp', 'campaign', $4, '2099-01-01')`,
    [w.tenant, w.account, `ptp-${randomUUID()}`, when, answeredBy, campaignId]);
  await inboundPromise(me.id, c['P']!, at(-50));
  await inboundPromise(other.id, c['P']!, at(-50));
  await inboundPromise(me.id, c['Q']!, at(-50));

  // ── Call-laters ──────────────────────────────────────────────────────────────
  // S (strict): booked by me, assigned to me, or both; overdue first.
  await callLater('overdue', c['S']!, -30, { ...booked(me.id), assigned_user_id: me.id, assigned_at: at(-60) });
  await callLater('inbound', c['S']!, 60, {
    assigned_user_id: me.id, assigned_at: at(-60), last_outcome: null, last_disposition: null, attempt_count: 0,
    callback_source: 'inbound', callback_due_at: at(60),
  });
  await callLater('booked', c['S']!, 90, { ...booked(me.id), assigned_user_id: me.id, assigned_at: at(-60) });
  await callLater('handedOver', c['S']!, 120, { assigned_user_id: me.id, assigned_at: at(-60) });
  // Booked by me, then a supervisor gave it to Ravi (LF21): it comes to him, not me.
  await callLater('givenAway', c['S']!, 100, { ...booked(me.id), assigned_user_id: other.id, assigned_at: at(-10) });
  // Booked by me, then the callback fallback returned it to the pool (CA5): it comes to nobody in particular.
  await callLater('pooled', c['S']!, -20, booked(me.id));
  await callLater('tomorrow', c['S']!, (DAY.end.getTime() - now.getTime()) / MIN + 60, booked(me.id));
  await callLater('theirs', c['S']!, 30, booked(other.id));
  await callLater('done', c['S']!, 30, { ...booked(me.id), state: 'completed' });
  await callLater('dnc', c['S']!, 30, { ...booked(me.id), suppressed_reason: 'dnc' });
  await callLater('notACallLater', c['S']!, 30, { assigned_user_id: me.id, assigned_at: at(-60), last_disposition: 'sale' });
  // P (pool): only the booked half.
  await callLater('poolBooked', c['P']!, 45, booked(me.id));
  await callLater('poolAssigned', c['P']!, 45, { assigned_user_id: me.id, assigned_at: at(-60) });
  // O (preferred): booked by me and still mine, the agent's only call-later there.
  await callLater('ownBooked', c['O']!, 40, { ...booked(me.id), assigned_user_id: me.id, assigned_at: at(-60) });
  // R: more than a page.
  for (let i = 0; i < 22; i++) await callLater(`r${i}`, c['R']!, i < 10 ? -10 + i : 5 + i, booked(me.id));
});

afterAll(async () => {
  await app?.close();
  await closePool();
  await closeTestPool();
});

describe('GET /proxy/agency/my-day — the gate', () => {
  it('an agent on a campaign they hold a live session on, not staffed: 200, never cached', async () => {
    await ok(c['P']!);
  });

  it('no account: 400 account_scope_required', async () => {
    const res = await app.inject({
      method: 'GET', url: `/proxy/agency/my-day?campaign_id=${c['P']}`,
      headers: { authorization: `Bearer tok:${w.uid}`, 'x-tenant-id': w.tenant },
    });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().code).toBe('account_scope_required');
  });

  it.each([
    ['no campaign', ''],
    ['a malformed one', '?campaign_id=abc'],
    ['another agent named', () => `?campaign_id=${c['P']}&agent_user_id=${w.other}`],
  ])('%s: 400 invalid_my_day_query', async (_label, query) => {
    const q = typeof query === 'function' ? query() : query;
    const res = await app.inject({ method: 'GET', url: `/proxy/agency/my-day${q}`, headers: headers() });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().code).toBe('invalid_my_day_query');
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('a campaign they are not on, another account\'s, and one that does not exist: 403 not_staffed', async () => {
    for (const id of [c['X']!, c['Y']!, randomUUID()]) {
      const res = await myDay(id);
      expect(res.statusCode, res.body).toBe(403);
      expect(res.json().code).toBe('not_staffed');
    }
  });

  it('the dialer flag off (a tenant without it): 403 feature_disabled', async () => {
    const tenant = await insertTenant();
    const account = await insertAccount({ tenant_id: tenant.id });
    await insertMembership({ user_id: w.me, tenant_id: tenant.id, account_id: account.id, role: 'agent' });
    const res = await myDay(c['P']!, { 'x-tenant-id': tenant.id, 'x-account-id': account.id });
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json().code).toBe('feature_disabled');
  });
});

describe('GET /proxy/agency/my-day — the agent\'s numbers', () => {
  it('this agent, this campaign, the campaign\'s day: a redialled conversation once, both legs\' talk time', async () => {
    const day = await ok(c['P']!);
    expect(day).toMatchObject({
      campaign_id: c['P'], timezone: ZONE, day_start: DAY.start.toISOString(), day_end: DAY.end.toISOString(),
      // will_pay: the dialler's promise, the soft phone's and the inbound call's, all on P today.
      dialed: 4, calls: 2, successes: 1, talk_seconds: 120 + 60 + 30, will_pay: 3,
      target: { metric: 'calls', value: 80 },
    });
  });

  it('a campaign whose outcomes record no pay date: will_pay null; no target: null', async () => {
    const day = await ok(c['Q']!);
    expect(day).toMatchObject({ dialed: 1, calls: 1, successes: 1, talk_seconds: 45, will_pay: null, target: null });
  });
});

describe('GET /proxy/agency/my-day — the agent\'s call-laters', () => {
  const rowNames = (day: AgencyMyDay) => day.call_later.rows.map((r) => names[r.contact_id]);

  it('strict: assigned to me (booked by me or not), due before midnight, oldest first, the overdue apart; they come to me', async () => {
    const day = await ok(c['S']!);
    // Not `givenAway` (booked by me, handed to Ravi) nor `pooled` (booked by me, returned to the
    // pool by the fallback): neither will come to me, so neither is listed as coming to me.
    expect(rowNames(day)).toEqual(['overdue', 'inbound', 'booked', 'handedOver']);
    expect(day.call_later).toMatchObject({ today: 3, overdue: 1, comes_to_me: true, left_today_goes_to: 'waits_for_me' });
    expect(day.call_later.rows[0]).toMatchObject({ customer_name: 'Customer overdue', overdue: true });
    expect(day.call_later.rows[1]).toMatchObject({ overdue: false });
    expect(JSON.stringify(day)).not.toContain('+9198');
  });

  it('strict: a call-later handed to another agent is in their list, through their assigned half, and in no one else\'s', async () => {
    const theirs = await ok(c['S']!, { authorization: `Bearer tok:${w.otherUid}` });
    // `givenAway` is now Ravi's; `theirs` (booked by Ravi, never assigned to him) does not come to him.
    expect(rowNames(theirs)).toEqual(['givenAway']);
    expect(theirs.call_later).toMatchObject({ today: 1, overdue: 0, comes_to_me: true });
  });

  it('preferred: a call-later I booked and still hold is listed and counted exactly once', async () => {
    // Read once, as one of the agent's assigned call-laters: the booking adds no second row and no
    // second count (the list is one scan, not the booked ones and the assigned ones together).
    const day = await ok(c['O']!);
    expect(rowNames(day)).toEqual(['ownBooked']);
    expect(day.call_later).toMatchObject({ today: 1, overdue: 0, comes_to_me: true });
  });

  it('pool: only the ones I booked; another agent may get them', async () => {
    const day = await ok(c['P']!);
    expect(rowNames(day)).toEqual(['poolBooked']);
    expect(day.call_later).toMatchObject({ today: 1, overdue: 0, comes_to_me: false, left_today_goes_to: 'pool' });
  });

  it('at most 20 rows; the counts are not capped', async () => {
    const day = await ok(c['R']!);
    expect(day.call_later.rows).toHaveLength(20);
    expect(day.call_later.today + day.call_later.overdue).toBe(22);
    expect(day.call_later.overdue).toBe(10);
  });
});

describe('the call-later read\'s plan, on a seeded roster', () => {
  function nodes(plan: unknown, out: Array<Record<string, unknown>> = []): Array<Record<string, unknown>> {
    if (Array.isArray(plan)) for (const p of plan) nodes(p, out);
    else if (plan && typeof plan === 'object') {
      const node = plan as Record<string, unknown>;
      if (typeof node['Node Type'] === 'string') out.push(node);
      for (const v of Object.values(node)) if (v && typeof v === 'object') nodes(v, out);
    }
    return out;
  }

  beforeAll(async () => {
    // 20,000 contacts never dialled (all due), 300 call-laters booked by 30 agents, 10 of them mine.
    const agents = Array.from({ length: 30 }, (_, i) => (i === 0 ? w.me : randomUUID()));
    await getTestPool().query(
      `INSERT INTO agency_contacts (campaign_id, tenant_id, account_id, phone_e164, context, state, attempt_count,
                                    last_outcome, last_disposition, next_attempt_at, callback_booked_by_user_id, callback_booked_at,
                                    assigned_user_id, assigned_at)
       SELECT $1, $2, $3, '+9170' || lpad(g::text, 8, '0'), '{}'::jsonb, 'pending',
              CASE WHEN g <= 300 THEN 1 ELSE 0 END,
              CASE WHEN g <= 300 THEN 'connected' END,
              CASE WHEN g <= 300 THEN 'call_later' END,
              CASE WHEN g <= 300 THEN now() + g * interval '1 minute' ELSE now() - interval '2 days' END,
              CASE WHEN g <= 300 THEN ($4::uuid[])[1 + g % 30] END,
              CASE WHEN g <= 300 THEN now() END,
              CASE WHEN g <= 300 THEN ($4::uuid[])[1 + g % 30] END,
              CASE WHEN g <= 300 THEN now() END
         FROM generate_series(1, 20000) g`, [c['S'], w.tenant, w.account, agents]);
    await getTestPool().query('ANALYZE agency_contacts');
  }, 120_000);

  async function plan(ownerMode: boolean): Promise<Array<Record<string, unknown>>> {
    const { text, values } = myCallLaterStatement({
      campaignId: c['S']!, agentUserId: w.me, ownerMode, callbackCodes: ['call_later'],
      dueBefore: DAY.end, now: new Date(), limit: 20,
    });
    const { rows } = await getTestPool().query<{ 'QUERY PLAN': unknown }>(`EXPLAIN (ANALYZE, FORMAT JSON) ${text}`, values);
    return nodes(rows[0]!['QUERY PLAN']);
  }

  it('one scan of the agent\'s contacts: the assigned ones on strict and preferred, the booked ones on pool', () => {
    // FALSIFIED: with the booked ones read beside the assigned ones on strict / preferred (a UNION
    // of the two, as the fix stream had it), the owner-mode text reads the booker column too.
    const text = (ownerMode: boolean) => myCallLaterStatement({
      campaignId: c['S']!, agentUserId: w.me, ownerMode, callbackCodes: [], dueBefore: DAY.end, now, limit: 20,
    }).text;
    for (const ownerMode of [true, false]) {
      expect(text(ownerMode)).not.toMatch(/\bUNION\b/);
      expect(text(ownerMode).match(/FROM agency_contacts\b/g)).toHaveLength(1);
    }
    expect(text(true)).toContain('assigned_user_id = $2::uuid');
    expect(text(true)).not.toContain('callback_booked_by_user_id');
    expect(text(false)).toContain(`callback_booked_by_user_id = $2::uuid\n           AND ${MY_CALLBACKS_INDEX_PREDICATE_SQL}`);
    expect(text(false)).not.toContain('assigned_user_id');
  });

  it('repeats 0058\'s predicate byte for byte', () => {
    expect(MY_CALLBACKS_INDEX_PREDICATE_SQL).toBe(`state = 'pending' AND callback_booked_by_user_id IS NOT NULL`);
    expect(myCallLaterStatement({
      campaignId: c['S']!, agentUserId: w.me, ownerMode: false, callbackCodes: [], dueBefore: DAY.end, now, limit: 20,
    }).text).toContain(MY_CALLBACKS_INDEX_PREDICATE_SQL);
  });

  it.each([false, true])('pool: the booked ones on idx_agency_contacts_my_callbacks; strict (%s): the assigned ones on idx_agency_contacts_assignee; never the roster', async (ownerMode) => {
    const p = await plan(ownerMode);
    const used = p.map((n) => [n['Node Type'], n['Index Name'] ?? n['Relation Name']]);
    // On pool the booked ones, on their own index; on strict / preferred the agent's own
    // contacts, on the assignee index: either way a read the size of the agent's contacts, never
    // the roster.
    if (!ownerMode) expect(p.some((n) => n['Index Name'] === 'idx_agency_contacts_my_callbacks'), JSON.stringify(used)).toBe(true);
    if (ownerMode) expect(p.some((n) => n['Index Name'] === 'idx_agency_contacts_assignee'), JSON.stringify(used)).toBe(true);
    expect(p.some((n) => n['Node Type'] === 'Seq Scan' && n['Relation Name'] === 'agency_contacts'), JSON.stringify(used)).toBe(false);
    const read = p
      .filter((n) => typeof n['Actual Rows'] === 'number' && String(n['Node Type']).includes('Scan'))
      .reduce((s, n) => s + (n['Actual Rows'] as number) * ((n['Actual Loops'] as number) ?? 1), 0);
    expect(read).toBeLessThan(500);
  });
});

describe('the counts read\'s plan, on seeded call tables', () => {
  function scans(plan: unknown, out: Array<{ type: string; index?: string; relation?: string }> = []) {
    if (Array.isArray(plan)) for (const p of plan) scans(p, out);
    else if (plan && typeof plan === 'object') {
      const node = plan as Record<string, unknown>;
      if (typeof node['Node Type'] === 'string' && String(node['Node Type']).includes('Scan')) {
        out.push({
          type: node['Node Type'] as string,
          ...(typeof node['Index Name'] === 'string' ? { index: node['Index Name'] } : {}),
          ...(typeof node['Relation Name'] === 'string' ? { relation: node['Relation Name'] } : {}),
        });
      }
      for (const v of Object.values(node)) if (v && typeof v === 'object') scans(v, out);
    }
    return out;
  }

  beforeAll(async () => {
    // 3,000 other agents' sessions of the day, 20,000 of their dialled attempts, and 20,000
    // soft-phone and 20,000 inbound calls of the account written up today without a promise.
    const pool = getTestPool();
    const contact = await insertAgencyContact(c['P']!, { ...scope(), state: 'completed', attempt_count: 1 });
    await pool.query(
      `INSERT INTO agency_agent_sessions (id, tenant_id, account_id, campaign_id, agent_user_id, state, joined_at, left_at)
       SELECT gen_random_uuid(), $1, $2, $3, gen_random_uuid(), 'offline', $4::timestamptz, $4::timestamptz + interval '1 minute'
         FROM generate_series(1, 3000) g`, [w.tenant, w.account, c['P'], at(-300)]);
    await pool.query(
      `INSERT INTO agency_call_attempts (id, campaign_id, contact_id, tenant_id, account_id, attempt_number, caller_id, state,
                                         reserved_agent_id, dialed_at, created_at, ended_at, outcome)
       SELECT gen_random_uuid(), $1, $2, $3, $4, g + 10, '+919000000001', 'ended', s.id, $5::timestamptz, $5::timestamptz,
              $5::timestamptz + interval '20 seconds', 'no_answer'
         FROM generate_series(1, 20000) g
         JOIN LATERAL (SELECT id FROM agency_agent_sessions WHERE agent_user_id <> $6 ORDER BY id OFFSET (g % 3000) LIMIT 1) s ON true`,
      [c['P'], contact.id, w.tenant, w.account, at(-290), w.me]);
    const phone = await insertSoftphoneSession({ ...scope(), agent_user_id: randomUUID(), state: 'offline', joined_at: at(-300), left_at: at(-200) });
    await pool.query(
      `INSERT INTO agency_manual_calls (tenant_id, account_id, session_id, agent_user_id, destination_e164, caller_id, state, ended_at,
                                        disposition_code, dispositioned_at, settled_at, campaign_id)
       SELECT $1::uuid, $2::uuid, $3::uuid, $4::uuid, '+1555' || lpad(g::text, 7, '0'), '+15550000000', 'ended', $5::timestamptz, 'sale',
              $5::timestamptz, $5::timestamptz, $6::uuid
         FROM generate_series(1, 20000) g`, [w.tenant, w.account, phone.id, phone.agent_user_id, at(-250), c['P']]);
    await pool.query(
      `INSERT INTO agency_inbound_calls (tenant_id, account_id, provider_call_id, to_e164, state, ended_at, outcome, bridged_at,
                                         answered_by_user_id, settled_at, disposition_code, disposition_source, dispositioned_at)
       SELECT $1::uuid, $2::uuid, 'plan-' || g, '+15550000001', 'ended', $3::timestamptz, 'answered', $3::timestamptz, gen_random_uuid(),
              $3::timestamptz, 'sale', 'route', $3::timestamptz FROM generate_series(1, 20000) g`, [w.tenant, w.account, at(-250)]);
    await pool.query('ANALYZE agency_agent_sessions, agency_call_attempts, agency_manual_calls, agency_inbound_calls');
  }, 120_000);

  it('the agent\'s sessions first, their attempts by session, the soft-phone and inbound promises on their 0050 indexes; never a whole table', async () => {
    const values = [w.me, w.tenant, w.account, c['P'], DAY.start, DAY.end];
    const { rows } = await getTestPool().query<{ 'QUERY PLAN': unknown }>(`EXPLAIN (FORMAT JSON) ${MY_DAY_COUNTS_SQL}`, values);
    const used = scans(rows[0]!['QUERY PLAN']);
    const names = used.map((u) => u.index ?? `${u.type}:${u.relation}`);
    // Each table on an index of its own: the agent's sessions, their attempts, the agent's own
    // soft-phone calls (or the account's promises of the day, whichever the planner finds smaller)
    // and the account's inbound promises of the day.
    const expected: Array<readonly string[]> = [
      ['idx_agency_agent_sessions_agent'],
      ['idx_agency_attempts_agent_dialed'],
      ['idx_agency_manual_calls_agent', 'idx_agency_manual_calls_promise_written'],
      ['idx_agency_inbound_calls_promise_written'],
    ];
    for (const anyOf of expected) {
      expect(anyOf.some((index) => names.includes(index)), `${anyOf.join(' | ')}: ${JSON.stringify(names)}`).toBe(true);
    }
    for (const table of ['agency_agent_sessions', 'agency_call_attempts', 'agency_manual_calls', 'agency_inbound_calls']) {
      expect(used.some((u) => u.type === 'Seq Scan' && u.relation === table), `${table}: ${JSON.stringify(names)}`).toBe(false);
    }
    // And the answer is unchanged by them.
    expect(await ok(c['P']!)).toMatchObject({ dialed: 4, calls: 2, will_pay: 3 });
  });
});
