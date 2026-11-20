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
 *    the promises written today; never yesterday's, another agent's or another campaign's.
 *  - `will_pay` null on a campaign whose outcomes record no pay date; the target.
 *  - the call-laters: the agent's own booked ones (and, on strict, the ones assigned to them) due
 *    before the day's end, oldest first, the overdue ones counted apart; never tomorrow's, another
 *    agent's, a closed or DNC contact's; `comes_to_me` and `left_today_goes_to` by the routing; the
 *    name, never the number; at most 20 rows, the counts uncapped.
 *  - the plan: the booked half on `idx_agency_contacts_my_callbacks` (0058), the assigned half on
 *    `idx_agency_contacts_assignee`, never the roster.
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
import { insertAgencyAttempt, insertAgencyCampaign, insertAgencyContact, insertAgentSession } from '../agency/agency-factories.js';
import { buildApp } from '../../../src/app.js';
import { myDayWindow } from '../../../src/agency/my-day.js';
import { MY_CALLBACKS_INDEX_PREDICATE_SQL, myCallLaterStatement } from '../../../src/db/repositories/agency.repository.js';

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

let w: { tenant: string; account: string; otherAccount: string; uid: string; me: string; other: string };
const c: Record<string, string> = {};
const names: Record<string, string> = {};

function headers(over: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer tok:${w.uid}`, 'x-tenant-id': w.tenant, 'x-account-id': w.account, ...over };
}

const myDay = (campaignId: string, h: Record<string, string> = {}) =>
  app.inject({ method: 'GET', url: `/proxy/agency/my-day?campaign_id=${campaignId}`, headers: headers(h) });

async function ok(campaignId: string): Promise<AgencyMyDay> {
  const res = await myDay(campaignId);
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
  await getTestPool().query(
    `INSERT INTO feature_flag_overrides (flag_key, scope_type, tenant_id, value)
     VALUES ('agency_dialer_enabled', 'tenant', $1, 'true'::jsonb)`,
    [tenant.id],
  );
  w = { tenant: tenant.id, account: account.id, otherAccount: otherAccount.id, uid: me.firebase_uid, me: me.id, other: other.id };

  const campaign = async (key: string, over: Record<string, unknown>) => {
    c[key] = (await insertAgencyCampaign({
      ...scope(), status: 'running', default_timezone: ZONE, disposition_catalog: JSON.stringify(CATALOG), ...over,
    })).id as string;
  };
  // P: pool, the agent holds a live session on it but is not staffed. Q: no promise outcome,
  // staffed. S: strict, fallback wait, staffed. R: the cap. X: neither. Y: another account.
  await campaign('P', { name: 'Pool', daily_target_calls: 80 });
  await campaign('Q', { name: 'No promise', disposition_catalog: JSON.stringify(NO_PROMISE_CATALOG) });
  await campaign('S', { name: 'Strict', assignment_mode: 'strict', callback_fallback: 'wait' });
  await campaign('R', { name: 'Cap' });
  await campaign('X', { name: 'Not mine' });
  await campaign('Y', { name: 'Other account', account_id: otherAccount.id });
  for (const k of ['Q', 'S', 'R']) await staff(c[k]!, me.id);
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

  // ── Call-laters ──────────────────────────────────────────────────────────────
  // S (strict): booked by me, assigned to me, or both; overdue first.
  await callLater('overdue', c['S']!, -30, { ...booked(me.id), assigned_user_id: me.id, assigned_at: at(-60) });
  await callLater('inbound', c['S']!, 60, {
    assigned_user_id: me.id, assigned_at: at(-60), last_outcome: null, last_disposition: null, attempt_count: 0,
    callback_source: 'inbound', callback_due_at: at(60),
  });
  await callLater('booked', c['S']!, 90, booked(me.id));
  await callLater('handedOver', c['S']!, 120, { assigned_user_id: me.id, assigned_at: at(-60) });
  await callLater('tomorrow', c['S']!, (DAY.end.getTime() - now.getTime()) / MIN + 60, booked(me.id));
  await callLater('theirs', c['S']!, 30, booked(other.id));
  await callLater('done', c['S']!, 30, { ...booked(me.id), state: 'completed' });
  await callLater('dnc', c['S']!, 30, { ...booked(me.id), suppressed_reason: 'dnc' });
  await callLater('notACallLater', c['S']!, 30, { assigned_user_id: me.id, assigned_at: at(-60), last_disposition: 'sale' });
  // P (pool): only the booked half.
  await callLater('poolBooked', c['P']!, 45, booked(me.id));
  await callLater('poolAssigned', c['P']!, 45, { assigned_user_id: me.id, assigned_at: at(-60) });
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
      dialed: 4, calls: 2, successes: 1, talk_seconds: 120 + 60 + 30, will_pay: 1,
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

  it('strict: booked by me or assigned to me, due before midnight, oldest first, the overdue apart; they come to me', async () => {
    const day = await ok(c['S']!);
    expect(rowNames(day)).toEqual(['overdue', 'inbound', 'booked', 'handedOver']);
    expect(day.call_later).toMatchObject({ today: 3, overdue: 1, comes_to_me: true, left_today_goes_to: 'waits_for_me' });
    expect(day.call_later.rows[0]).toMatchObject({ customer_name: 'Customer overdue', overdue: true });
    expect(day.call_later.rows[1]).toMatchObject({ overdue: false });
    expect(JSON.stringify(day)).not.toContain('+9198');
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

  async function plan(includeAssigned: boolean): Promise<Array<Record<string, unknown>>> {
    const { text, values } = myCallLaterStatement({
      campaignId: c['S']!, agentUserId: w.me, includeAssigned, callbackCodes: ['call_later'],
      dueBefore: DAY.end, now: new Date(), limit: 20,
    });
    const { rows } = await getTestPool().query<{ 'QUERY PLAN': unknown }>(`EXPLAIN (ANALYZE, FORMAT JSON) ${text}`, values);
    return nodes(rows[0]!['QUERY PLAN']);
  }

  it('repeats 0058\'s predicate byte for byte', () => {
    expect(MY_CALLBACKS_INDEX_PREDICATE_SQL).toBe(`state = 'pending' AND callback_booked_by_user_id IS NOT NULL`);
    expect(myCallLaterStatement({
      campaignId: c['S']!, agentUserId: w.me, includeAssigned: false, callbackCodes: [], dueBefore: DAY.end, now, limit: 20,
    }).text).toContain(MY_CALLBACKS_INDEX_PREDICATE_SQL);
  });

  it.each([false, true])('the booked half on idx_agency_contacts_my_callbacks (assigned half: %s), never the roster', async (includeAssigned) => {
    const p = await plan(includeAssigned);
    const used = p.map((n) => [n['Node Type'], n['Index Name'] ?? n['Relation Name']]);
    expect(p.some((n) => n['Index Name'] === 'idx_agency_contacts_my_callbacks'), JSON.stringify(used)).toBe(true);
    if (includeAssigned) expect(p.some((n) => n['Index Name'] === 'idx_agency_contacts_assignee'), JSON.stringify(used)).toBe(true);
    expect(p.some((n) => n['Node Type'] === 'Seq Scan' && n['Relation Name'] === 'agency_contacts'), JSON.stringify(used)).toBe(false);
    const read = p
      .filter((n) => typeof n['Actual Rows'] === 'number' && String(n['Node Type']).includes('Scan'))
      .reduce((s, n) => s + (n['Actual Rows'] as number) * ((n['Actual Loops'] as number) ?? 1), 0);
    expect(read).toBeLessThan(500);
  });
});
