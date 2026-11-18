import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { DEFAULTS, OTHER_ACCOUNT, OTHER_TENANT, insertAccount, insertTenant, insertUser } from '../setup/factories.js';
import {
  insertAgencyAttempt, insertAgencyCampaign, insertAgencyContact, insertAgentSession, insertSoftphoneSession,
} from './agency-factories.js';

vi.mock('@magick-agency/db', async (orig) => ({
  ...(await orig<typeof import('@magick-agency/db')>()),
  getPool: () => getTestPool(),
}));

const { agencyFloorRepository, FLOOR_ROWS_SQL, FLOOR_CALLS_TODAY_SQL } = await import('../../../src/db/repositories/agency/floor.repository.js');
const { agentGroupedStats } = await import('../../../src/db/repositories/agency/agent-grouped-stats.js');
const { registerFloorRoutes, clearFloorCallsTodayCacheForTests } = await import('../../../src/api/routes/agency/floor.js');
const { clearLiveCallAhtCacheForTests } = await import('../../../src/api/routes/agency/live-calls.js');

/**
 * The Live floor's reads on a real Postgres (decision B28b; `floor.repository.ts` and the internal
 * handler `api/routes/agency/floor.ts`): one account's agents across its campaigns, a soft-phone
 * session, a staffed agent who never signed in, one who left today and one who left before today,
 * an agent live in another account, a session on a campaign no longer active, an inbound call, a
 * call in progress with the customer's name (never the number), the break labels, liveness; each
 * agent's conversations in the window, at its edges, equal to the grouped stats' `connected` for
 * `group_by=agent`; another account's and another tenant's agents never on it. Then the plan: the
 * open sessions on `uq_agency_agent_live_tenant` by the tenant, never the table.
 */

const T = DEFAULTS.tenantId;
const A = DEFAULTS.accountId;
const HOUR = 3_600_000;
const NOW = Date.now();
/** "Today" starts six hours ago. */
const FROM = new Date(NOW - 6 * HOUR);
const ago = (ms: number) => new Date(NOW - ms);

type Id = { id: string };
const users: Record<string, string> = {};
let c1: Id & Record<string, unknown>;
let c2: Id;
let c3: Id;
let cx: Id;
const sessions: Record<string, string> = {};
let liveCallId: string;

async function staff(campaign: Id, userId: string, accountId: string = A, opts: { unassigned?: boolean } = {}) {
  await getTestPool().query(
    `INSERT INTO agency_campaign_agents (tenant_id, account_id, campaign_id, user_id, unassigned_at) VALUES ($1, $2, $3, $4, $5)`,
    [T, accountId, campaign.id, userId, opts.unassigned ? new Date() : null]);
}

/** An attempt on `session`, dialled at `at`; `bridged` makes it a conversation (a first dial). */
async function attempt(campaign: Id, session: string, at: Date, over: Record<string, unknown> = {}) {
  const contact = await insertAgencyContact(campaign.id, { account_id: over['account_id'] ?? A }) as Id;
  return insertAgencyAttempt(campaign.id, contact.id, {
    state: 'ended', reserved_agent_id: session, dialed_at: at, ended_at: new Date(at.getTime() + 60_000), ...over,
  }) as Promise<Id>;
}

beforeAll(async () => {
  await truncateAll();
  await insertTenant({ id: T });
  await insertAccount({ id: A, tenant_id: T });
  await insertAccount({ id: OTHER_ACCOUNT, tenant_id: T });
  await insertTenant({ id: OTHER_TENANT });
  for (const name of ['onCall', 'soft', 'tea', 'never', 'leftToday', 'leftBefore', 'completedOnly', 'unassigned', 'elsewhere',
    'onCompleted', 'inbound', 'otherTenant']) {
    users[name] = (await insertUser() as Id).id;
  }
  c1 = await insertAgencyCampaign({ status: 'running', name: 'Renewals', wrapup_seconds: 45,
    break_reasons: JSON.stringify([{ code: 'tea', label: 'Tea', is_paid: true }]) });
  c2 = await insertAgencyCampaign({ status: 'paused', name: 'Paused one' });
  c3 = await insertAgencyCampaign({ status: 'completed', name: 'Done' });
  cx = await insertAgencyCampaign({ status: 'running', account_id: OTHER_ACCOUNT, name: 'Elsewhere' });

  // Staffing: on active campaigns of A (c1 running, c2 paused); c3 is completed; one unassigned.
  for (const u of ['onCall', 'tea', 'leftToday', 'leftBefore', 'elsewhere']) await staff(c1, users[u]!);
  await staff(c2, users['never']!);
  await staff(c2, users['onCall']!); // staffed twice: one person
  await staff(c3, users['completedOnly']!);
  await staff(c1, users['unassigned']!, A, { unassigned: true });
  await staff(cx, users['elsewhere']!, OTHER_ACCOUNT);

  // Open sessions in A.
  sessions['onCall'] = (await insertAgentSession(c1.id, { agent_user_id: users['onCall'], state: 'on_call', state_since: ago(90_000), client_kind: 'mobile', joined_at: ago(5 * HOUR) }) as Id).id;
  sessions['soft'] = (await insertSoftphoneSession({ agent_user_id: users['soft'], state_since: ago(60_000) }) as Id).id;
  sessions['tea'] = (await insertAgentSession(c1.id, { agent_user_id: users['tea'], state: 'break', break_reason: 'tea', state_since: ago(600_000) }) as Id).id;
  sessions['onCompleted'] = (await insertAgentSession(c3.id, { agent_user_id: users['onCompleted'], state: 'available', break_reason: 'lunch' }) as Id).id;
  sessions['inbound'] = (await insertAgentSession(c1.id, { agent_user_id: users['inbound'], state: 'on_call' }) as Id).id;
  // Closed sessions: one who left today (and was here yesterday), one who left before today.
  sessions['leftYesterday'] = (await insertAgentSession(c1.id, { agent_user_id: users['leftToday'], state: 'offline', joined_at: ago(30 * HOUR), left_at: ago(26 * HOUR) }) as Id).id;
  sessions['leftToday'] = (await insertAgentSession(c1.id, { agent_user_id: users['leftToday'], state: 'offline', joined_at: ago(5 * HOUR), left_at: ago(2 * HOUR) }) as Id).id;
  sessions['leftBefore'] = (await insertAgentSession(c1.id, { agent_user_id: users['leftBefore'], state: 'offline', joined_at: ago(12 * HOUR), left_at: ago(7 * HOUR) }) as Id).id;
  // Live in another account of the tenant (OS1: one session at a time), and in another tenant.
  sessions['elsewhere'] = (await insertAgentSession(cx.id, { account_id: OTHER_ACCOUNT, agent_user_id: users['elsewhere'], state: 'available' }) as Id).id;
  await insertSoftphoneSession({ tenant_id: OTHER_TENANT, account_id: randomUUID(), agent_user_id: users['otherTenant'] });

  // The call in progress on `onCall`: a bridged attempt, its leg, a contact with a name.
  const contact = await insertAgencyContact(c1.id, { context: JSON.stringify({ name: 'Ada Lovelace' }), phone_e164: '+919811122233' }) as Id;
  liveCallId = randomUUID();
  await getTestPool().query(
    `INSERT INTO agency_calls (id, tenant_id, account_id, caller_id, destination_phone, recording_requested) VALUES ($1, $2, $3, '+919000000001', '+919811122233', true)`,
    [liveCallId, T, A]);
  await insertAgencyAttempt(c1.id, contact.id, {
    state: 'bridged', reserved_agent_id: sessions['onCall'], dialed_at: ago(100_000), bridged_at: ago(80_000), webrtc_call_id: liveCallId,
  });
  // The inbound agent's unsettled, connected inbound call.
  await getTestPool().query(
    `INSERT INTO agency_inbound_calls (tenant_id, account_id, provider_call_id, to_e164, state, bridged_at, answered_by_user_id, session_id, offered_at, offer_count)
     VALUES ($1, $2, 'floor-ib-1', '+919000000002', 'connected', now(), $3, $4, now(), 1)`,
    [T, A, users['inbound'], sessions['inbound']]);

  // Today's conversations (FROM is six hours ago).
  await attempt(c1, sessions['onCall']!, ago(1 * HOUR), { bridged_at: ago(1 * HOUR - 5_000) }); // counts
  await attempt(c1, sessions['onCall']!, FROM, { bridged_at: new Date(FROM.getTime() + 5_000) }); // at `from`: counts
  await attempt(c1, sessions['onCall']!, new Date(FROM.getTime() - 1_000), { bridged_at: FROM }); // dialled before: no
  await attempt(c1, sessions['onCall']!, ago(2 * HOUR)); // never bridged: no
  // A redialled conversation counts once, at its last attempt (the redial, bridged or not).
  const original = await attempt(c1, sessions['onCall']!, ago(3 * HOUR), { bridged_at: ago(3 * HOUR - 5_000), disposition_code: 'redialed' });
  await attempt(c1, sessions['onCall']!, ago(3 * HOUR - 60_000), { redial_number: 1, redial_of_attempt_id: original.id });
  await attempt(c1, sessions['leftToday']!, ago(4 * HOUR), { bridged_at: ago(4 * HOUR - 5_000) }); // counts for leftToday
  await attempt(c1, sessions['leftYesterday']!, ago(28 * HOUR), { bridged_at: ago(28 * HOUR - 5_000) }); // yesterday: no
  await attempt(cx, sessions['elsewhere']!, ago(1 * HOUR), { bridged_at: ago(1 * HOUR - 5_000), account_id: OTHER_ACCOUNT }); // other account: no
}, 60_000);

afterAll(closeTestPool);

describe('floorRows', () => {
  it('one row per person: every open session in the account, then the staffed agents of active campaigns with none', async () => {
    const rows = await agencyFloorRepository.floorRows(T, A, FROM);
    const byUser = new Map(rows.map((r) => [r.agent_user_id, r]));
    const name = (id: string) => Object.keys(users).find((k) => users[k] === id);
    expect(rows.map((r) => name(r.agent_user_id)).sort()).toEqual(
      ['elsewhere', 'inbound', 'leftBefore', 'leftToday', 'never', 'onCall', 'onCompleted', 'soft', 'tea'].sort());
    // Open sessions first.
    expect(rows.slice(0, 5).every((r) => r.session_id !== null)).toBe(true);
    expect(rows.slice(5).every((r) => r.session_id === null)).toBe(true);

    expect(byUser.get(users['onCall']!)).toMatchObject({
      session_id: sessions['onCall'], campaign_id: c1.id, campaign_name: 'Renewals', wrapup_seconds: 45,
      state: 'on_call', client_kind: 'mobile', staffed: true, left_at: null, on_inbound_call: false,
    });
    // A soft-phone session: no campaign, on its reserved break, not staffed but on the floor.
    expect(byUser.get(users['soft']!)).toMatchObject({
      session_id: sessions['soft'], campaign_id: null, campaign_name: null, wrapup_seconds: null, break_reasons: null,
      state: 'break', break_reason: 'soft_phone', staffed: false,
    });
    expect(byUser.get(users['tea']!)).toMatchObject({ state: 'break', break_reason: 'tea', break_reasons: [{ code: 'tea', label: 'Tea', is_paid: true }] });
    // A stale reason is not served off a break.
    expect(byUser.get(users['onCompleted']!)).toMatchObject({ campaign_id: c3.id, state: 'available', break_reason: null, staffed: false });
    expect(byUser.get(users['inbound']!)).toMatchObject({ on_inbound_call: true, inbound_outcome_owed: false });
    // No open session here.
    expect(byUser.get(users['never']!)).toMatchObject({ session_id: null, state: 'offline', state_since: null, client_kind: null, staffed: true, left_at: null });
    expect(byUser.get(users['leftToday']!)!.left_at!.toISOString()).toBe(ago(2 * HOUR).toISOString());
    expect(byUser.get(users['leftBefore']!)!.left_at).toBeNull();
    // Live in the other account: offline here, never left here.
    expect(byUser.get(users['elsewhere']!)).toMatchObject({ session_id: null, state: 'offline', left_at: null });
  });

  it('another account sees only its own: its live agent, never this account\'s', async () => {
    const rows = await agencyFloorRepository.floorRows(T, OTHER_ACCOUNT, FROM);
    expect(rows.map((r) => r.agent_user_id)).toEqual([users['elsewhere']]);
    expect(rows[0]).toMatchObject({ session_id: sessions['elsewhere'], staffed: true });
  });

  it('keeps one row for an agent with two open sessions: the newest joined', async () => {
    // The unique index forbids it; drop it inside a transaction to see the rule, then roll back.
    const client = await getTestPool().connect();
    try {
      await client.query('BEGIN');
      await client.query('DROP INDEX uq_agency_agent_live_agent');
      await client.query('DROP INDEX uq_agency_agent_live_tenant');
      const newer = randomUUID();
      await client.query(
        `INSERT INTO agency_agent_sessions (id, tenant_id, account_id, campaign_id, agent_user_id, state, joined_at)
         VALUES ($1, $2, $3, $4, $5, 'available', now())`, [newer, T, A, c1.id, users['tea']]);
      const { rows } = await client.query(FLOOR_ROWS_SQL, [T, A, FROM, ['running', 'stopping', 'paused']]);
      const tea = rows.filter((r: { agent_user_id: string }) => r.agent_user_id === users['tea']);
      expect(tea.map((r: { session_id: string }) => r.session_id)).toEqual([newer]);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});

describe('callsToday', () => {
  it('counts each agent\'s conversations dialled in [from, to): the edges, a redial chain once, other accounts never', async () => {
    const counts = await agencyFloorRepository.callsToday(T, A, FROM, new Date(NOW + 1_000));
    expect(Object.fromEntries([...counts].map(([k, v]) => [Object.keys(users).find((n) => users[n] === k), v]))).toEqual({
      onCall: 4, // the live call, one an hour ago, one at `from`, the redial chain once
      leftToday: 1,
    });
    // `to` is exclusive: an attempt dialled exactly at it is not counted.
    const before = await agencyFloorRepository.callsToday(T, A, FROM, ago(1 * HOUR));
    expect(before.get(users['onCall']!)).toBe(2); // at `from`, the redial chain
  });

  it('equals the grouped stats\' `connected` for group_by=agent over the same window', async () => {
    const to = new Date(NOW + 1_000);
    const page = await agentGroupedStats({ tenantId: T, accountId: A }, {
      from: FROM, to, groupBy: ['agent'], sort: 'key', order: 'asc', limit: 1000,
    });
    const grouped = new Map(page.rows.map((r) => [r.key.agent_user_id!, r.connected]));
    expect(await agencyFloorRepository.callsToday(T, A, FROM, to)).toEqual(grouped);
  });
});

describe('the internal handler, GET /floor', () => {
  let app: FastifyInstance;
  let connected: (ids: readonly string[]) => Promise<Map<string, boolean>>;

  beforeAll(async () => {
    clearFloorCallsTodayCacheForTests();
    clearLiveCallAhtCacheForTests();
    connected = async (ids) => new Map(ids.map((id) => [id, id !== sessions['tea']]));
    app = Fastify({ logger: false });
    const runtime = { stations: { connectedBySession: (ids: readonly string[]) => connected(ids) } };
    await app.register(async (sub) => registerFloorRoutes(sub, runtime as never), { prefix: '/api/v1/agency' });
    await app.ready();
  });
  afterAll(async () => { await app.close(); });

  const get = (from: string, account = A) => app.inject({
    method: 'GET', url: `/api/v1/agency/floor?from=${encodeURIComponent(from)}`,
    headers: { 'x-mgkvc-tenant': T, 'x-mgkvc-account': account },
  });

  it('answers the rows with the call in progress (name, never the number), labels, liveness, calls today and totals', async () => {
    const res = await get(FROM.toISOString());
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const of = (u: string) => body.agents.find((a: { agent_user_id: string }) => a.agent_user_id === users[u]);
    expect(of('onCall')).toEqual({
      agent_user_id: users['onCall'], session_id: sessions['onCall'], campaign_id: c1.id, campaign_name: 'Renewals',
      state: 'on_call', state_since: ago(90_000).toISOString(), connected: true, client_kind: 'mobile',
      break_reason: null, break_label: null, on_inbound_call: false, inbound_outcome_owed: false, wrapup_window_seconds: 45,
      call: {
        call_id: liveCallId, origin: 'campaign', correlation_id: expect.any(String), customer_name: 'Ada Lovelace',
        connected_at: ago(80_000).toISOString(), aht_seconds: expect.anything(), recording: true, listener_user_ids: [],
      },
      calls_today: 4, left_at: null,
    });
    expect(JSON.stringify(body)).not.toContain('9811122233');
    expect(of('soft')).toMatchObject({ break_reason: 'soft_phone', break_label: 'Soft phone', campaign_id: null, call: null });
    expect(of('tea')).toMatchObject({ break_label: 'Tea', connected: false });
    expect(of('never')).toMatchObject({ connected: null, calls_today: 0, left_at: null, call: null });
    expect(of('leftToday')).toMatchObject({ calls_today: 1, left_at: ago(2 * HOUR).toISOString() });
    expect(body.totals).toEqual({
      on_shift: 5, // onCall, soft, tea, onCompleted, inbound
      assigned: 9, // staffed: onCall, tea, never, leftToday, leftBefore, elsewhere; and on shift: soft, onCompleted, inbound
    });
    expect(body.totals.on_shift).toBeLessThanOrEqual(body.totals.assigned);
  });

  it('serves connected: null when station liveness cannot be read, never false', async () => {
    connected = async () => { throw new Error('redis down'); };
    try {
      const body = (await get(FROM.toISOString())).json();
      expect(body.agents.filter((a: { session_id: string | null }) => a.session_id).map((a: { connected: unknown }) => a.connected))
        .toEqual([null, null, null, null, null]);
    } finally {
      connected = async (ids) => new Map(ids.map((id) => [id, true]));
    }
  });

  it('refuses a bad `from` with a 400', async () => {
    expect((await get('yesterday')).statusCode).toBe(400);
    expect((await get(new Date(NOW - 40 * HOUR).toISOString())).statusCode).toBe(400);
  });
});

describe('the plan, on a seeded table', () => {
  beforeAll(async () => {
    const pool = getTestPool();
    // Other tenants' open sessions (one agent each), and many closed sessions everywhere.
    await pool.query(
      `INSERT INTO agency_agent_sessions (tenant_id, account_id, kind, agent_user_id, state, break_reason)
       SELECT gen_random_uuid(), gen_random_uuid(), 'softphone', gen_random_uuid(), 'break', 'soft_phone' FROM generate_series(1, 3000)`);
    await pool.query(
      `INSERT INTO agency_agent_sessions (tenant_id, account_id, kind, agent_user_id, state, joined_at, left_at)
       SELECT CASE WHEN g % 10 = 0 THEN $1::uuid ELSE gen_random_uuid() END, CASE WHEN g % 10 = 0 THEN $2::uuid ELSE gen_random_uuid() END,
              'softphone', gen_random_uuid(), 'offline', now() - interval '3 days', now() - interval '2 days'
         FROM generate_series(1, 20000) g`, [T, A]);
    await pool.query('ANALYZE agency_agent_sessions, agency_campaigns, agency_campaign_agents, agency_call_attempts');
  }, 60_000);

  /** Every node of a JSON plan. */
  function nodes(plan: unknown, out: Array<Record<string, unknown>> = []): Array<Record<string, unknown>> {
    if (Array.isArray(plan)) for (const p of plan) nodes(p, out);
    else if (plan && typeof plan === 'object') {
      const node = plan as Record<string, unknown>;
      if (typeof node['Node Type'] === 'string') out.push(node);
      for (const v of Object.values(node)) if (v && typeof v === 'object') nodes(v, out);
    }
    return out;
  }

  async function plan(sql: string, params: unknown[]): Promise<Array<Record<string, unknown>>> {
    const { rows } = await getTestPool().query<{ 'QUERY PLAN': unknown }>(`EXPLAIN (FORMAT JSON) ${sql}`, params);
    return nodes(rows[0]!['QUERY PLAN']);
  }

  it('reads the account\'s open sessions on uq_agency_agent_live_tenant by the tenant, never the sessions table whole', async () => {
    const p = await plan(FLOOR_ROWS_SQL, [T, A, FROM, ['running', 'stopping', 'paused']]);
    const live = p.filter((n) => n['Index Name'] === 'uq_agency_agent_live_tenant');
    expect(live.length).toBe(1);
    expect(String(live[0]!['Index Cond'])).toMatch(/tenant_id = /);
    expect(p.filter((n) => n['Node Type'] === 'Seq Scan' && n['Relation Name'] === 'agency_agent_sessions')).toEqual([]);
    // An absent agent's last session: their own sessions, by the agent.
    const last = p.filter((n) => n['Index Name'] === 'idx_agency_agent_sessions_agent');
    expect(last.length).toBe(1);
    expect(String(last[0]!['Index Cond'])).toMatch(/agent_user_id = /);
  });

  it('the conversations read is still the right answer on the seeded table', async () => {
    const { rows } = await getTestPool().query(FLOOR_CALLS_TODAY_SQL, [T, A, FROM, new Date(NOW + 1_000)]);
    expect(rows.map((r: { calls: string }) => Number(r.calls)).sort()).toEqual([1, 4]);
  });
});
