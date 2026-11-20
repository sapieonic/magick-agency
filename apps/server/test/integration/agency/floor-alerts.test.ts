import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { AGENCY_HELP_EXPIRY_MS } from '@magick-agency/contracts/agency';
import { AGENCY_FLOOR_DISCONNECTED_ALERT_AFTER_MS } from '@magick-agency/contracts/api/agency/floor';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { DEFAULTS, OTHER_ACCOUNT, OTHER_TENANT } from '../setup/factories.js';
import { insertAgencyCampaign, insertAgentSession, insertAgentSessionEvent, insertManualCall, insertSoftphoneSession } from './agency-factories.js';

vi.mock('@magick-agency/db', async (orig) => ({
  ...(await orig<typeof import('@magick-agency/db')>()),
  getPool: () => getTestPool(),
}));

const {
  agencyFloorAlertsRepository: repo,
  agencyFloorAssistRepository,
  FLOOR_ALERTS_HELP_SQL,
  FLOOR_ALERTS_SESSIONS_SQL,
} = await import('../../../src/db/repositories/agency.repository.js');
const { registerFloorRoutes, clearFloorCallsTodayCacheForTests } = await import('../../../src/api/routes/agency/floor.js');
const { StationDetachTimes } = await import('../../../src/agency/station-detach-times.js');

/**
 * The supervisors' alerts read on a real Postgres (agent station AS16; `floor-alerts.repository.ts`,
 * the internal `GET /floor/alerts` in `api/routes/agency/floor.ts`): the account's open Need help
 * requests (never another account's, another tenant's, a left, answered or expired one; the state at
 * the raise), the sessions on a break or whose station went (with the state a row written `offline`
 * left), the internal handler end to end over a stand-in runtime (each kind, the ids, the threshold,
 * liveness unknown), the floor's `disconnected_since` (BE-11), and both statements' plans on their
 * indexes.
 */

const T = DEFAULTS.tenantId;
const A = DEFAULTS.accountId;
const pool = () => getTestPool();

interface Session { id: string; tenant_id: string; account_id: string; agent_user_id: string; campaign_id: string | null }

async function session(over: Record<string, unknown> = {}, campaign: Record<string, unknown> = {}): Promise<Session> {
  const c = await insertAgencyCampaign({
    status: 'running',
    ...(over['tenant_id'] ? { tenant_id: over['tenant_id'] } : {}),
    ...(over['account_id'] ? { account_id: over['account_id'] } : {}),
    ...campaign,
  });
  return await insertAgentSession(c.id as string, { state: 'available', ...over }) as unknown as Session;
}

const raise = (s: Session, state: 'available' | 'break' | 'on_call' = 'available') => agencyFloorAssistRepository.raise({
  sessionId: s.id, tenantId: s.tenant_id, accountId: s.account_id, callId: null, state, expiryMs: AGENCY_HELP_EXPIRY_MS,
});

afterAll(closeTestPool);

describe('the reads', () => {
  beforeEach(async () => { await truncateAll(); });

  it('openHelp: the account\'s open requests on open sessions, with the state at the raise; never another account\'s, tenant\'s, a left, answered or expired one', async () => {
    const open = await session();
    const soft = await insertSoftphoneSession() as unknown as Session;
    const answered = await session();
    const expired = await session();
    const left = await session();
    const otherAccount = await session({ account_id: OTHER_ACCOUNT });
    const otherTenant = await session({ tenant_id: OTHER_TENANT, account_id: randomUUID() });
    for (const s of [open, answered, expired, left, otherAccount, otherTenant]) await raise(s);
    await raise(soft, 'on_call');
    await agencyFloorAssistRepository.answer(answered.id, T, randomUUID(), AGENCY_HELP_EXPIRY_MS);
    await pool().query(`UPDATE agency_agent_sessions SET help_raised_at = now() - interval '16 minutes' WHERE id = $1`, [expired.id]);
    await pool().query(`UPDATE agency_agent_sessions SET left_at = now(), state = 'offline' WHERE id = $1`, [left.id]);
    const rows = await repo.openHelp(T, A, AGENCY_HELP_EXPIRY_MS);
    expect(rows.map((r) => r.session_id).sort()).toEqual([open.id, soft.id].sort());
    expect(rows.find((r) => r.session_id === open.id)).toMatchObject({
      agent_user_id: open.agent_user_id, campaign_id: open.campaign_id, campaign_name: expect.any(String), call_id: null, state: 'available',
    });
    expect(rows.find((r) => r.session_id === soft.id)).toMatchObject({ campaign_id: null, campaign_name: null, state: 'on_call' });
  });

  it('breakOrGoneSessions: every open break of the account, and the gone ones asked about, each with the state its last → offline left', async () => {
    const onBreak = await session({ state: 'break', break_reason: 'tea' }, { break_reasons: JSON.stringify([{ code: 'tea', label: 'Chai', limit_minutes: 10 }]) });
    const working = await session({ state: 'available' });
    const goneReady = await session({ state: 'offline' });
    const goneOnBreak = await session({ state: 'offline' });
    const goneOnCall = await session({ state: 'on_call' });
    const goneLeft = await session({ state: 'offline', left_at: new Date() });
    const otherAccountBreak = await session({ account_id: OTHER_ACCOUNT, state: 'break', break_reason: 'tea' });
    const at = (ms: number) => new Date(Date.now() - ms);
    // The transition log: the last → offline event says what each gone agent was doing.
    for (const [s, chain] of [
      [goneReady, [['break', null], ['available', 'break'], ['offline', 'available']]],
      [goneOnBreak, [['break', null], ['available', 'break'], ['break', 'available'], ['offline', 'break']]],
    ] as const) {
      let i = chain.length;
      for (const [to, from] of chain) await insertAgentSessionEvent(s as never, to, at(60_000 * i--), { from_state: from });
    }
    const gone = [goneReady.id, goneOnBreak.id, goneOnCall.id, goneLeft.id, randomUUID()];
    const rows = await repo.breakOrGoneSessions(T, A, gone);
    const byId = new Map(rows.map((r) => [r.session_id, r]));
    expect([...byId.keys()].sort()).toEqual([onBreak.id, goneReady.id, goneOnBreak.id, goneOnCall.id].sort());
    expect(byId.has(working.id) || byId.has(otherAccountBreak.id)).toBe(false);
    expect(byId.get(onBreak.id)).toMatchObject({
      state: 'break', break_reason: 'tea', break_reasons: [{ code: 'tea', label: 'Chai', limit_minutes: 10 }], left_state: null, client_kind: 'web',
    });
    expect(byId.get(goneReady.id)).toMatchObject({ state: 'offline', break_reason: null, left_state: 'available' });
    expect(byId.get(goneOnBreak.id)).toMatchObject({ state: 'offline', left_state: 'break' });
    expect(byId.get(goneOnCall.id)).toMatchObject({ state: 'on_call', left_state: null, soft_phone_call_live: false });
    // Nothing gone asked about: the breaks only.
    expect((await repo.breakOrGoneSessions(T, A, [])).map((r) => r.session_id)).toEqual([onBreak.id]);
  });
});

describe('the reads: a soft-phone agent\'s live call (BE-11)', () => {
  beforeEach(async () => { await truncateAll(); });

  it('breakOrGoneSessions says whether a gone soft-phone session has a soft-phone call live; never for one not asked about', async () => {
    const onCall = await insertSoftphoneSession({ agent_user_id: randomUUID() }) as unknown as Session;
    const idle = await insertSoftphoneSession({ agent_user_id: randomUUID() }) as unknown as Session;
    const notAsked = await insertSoftphoneSession({ agent_user_id: randomUUID() }) as unknown as Session;
    await insertManualCall(onCall, { state: 'bridged', bridged_at: new Date(), dialed_at: new Date() });
    await insertManualCall(idle, { state: 'ended', ended_at: new Date() });
    await insertManualCall(notAsked, { state: 'bridged', bridged_at: new Date(), dialed_at: new Date() });
    const rows = await repo.breakOrGoneSessions(T, A, [onCall.id, idle.id]);
    const byId = new Map(rows.map((r) => [r.session_id, r]));
    expect(byId.get(onCall.id)).toMatchObject({ state: 'break', break_reason: 'soft_phone', soft_phone_call_live: true });
    expect(byId.get(idle.id)).toMatchObject({ soft_phone_call_live: false });
    expect(byId.get(notAsked.id)).toMatchObject({ soft_phone_call_live: false });
  });
});

describe('the internal handler, GET /floor/alerts and the floor\'s disconnected_since', () => {
  let app: FastifyInstance;
  const detach = new StationDetachTimes();
  let connected: Map<string, boolean> | Error;
  const runtime = {
    stations: {
      connectedBySession: async (ids: readonly string[]) => {
        if (connected instanceof Error) throw connected;
        const c = connected;
        return new Map(ids.map((id) => [id, c.get(id) ?? true]));
      },
    },
    stationDisconnects: detach,
  };

  beforeAll(async () => {
    app = Fastify();
    await app.register(async (sub) => registerFloorRoutes(sub, runtime as never), { prefix: '/api/v1/agency' });
  });
  afterAll(async () => { await app.close(); });
  beforeEach(async () => {
    await truncateAll();
    clearFloorCallsTodayCacheForTests();
    for (const id of detach.goneSessionIds()) detach.attached(id);
    connected = new Map();
  });

  const headers = { 'x-mgkvc-tenant': T, 'x-mgkvc-account': A };
  const HERE = { tenantId: T, accountId: A };
  const alerts = async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/agency/floor/alerts', headers });
    expect(res.statusCode, res.body).toBe(200);
    return res.json() as { alerts: Array<Record<string, unknown>>; as_of: string };
  };

  it('each kind once, in order, with ids that hold from poll to poll; the floor carries when the gone station went', async () => {
    const helped = await session({ agent_user_id: randomUUID() });
    const started = new Date(Date.now() - 16 * 60_000);
    const longBreak = await session({ state: 'break', break_reason: 'tea', state_since: started, agent_user_id: randomUUID() });
    const shortBreak = await session({ state: 'break', break_reason: 'tea', state_since: new Date(), agent_user_id: randomUUID() });
    const dropped = await session({ state: 'offline', agent_user_id: randomUUID() });
    await insertAgentSessionEvent(dropped as never, 'offline', new Date(Date.now() - 30_000), { from_state: 'available' });
    const blip = await session({ state: 'offline', agent_user_id: randomUUID() });
    await insertAgentSessionEvent(blip as never, 'offline', new Date(), { from_state: 'available' });
    const raised = (await raise(helped)).help!;
    const wentAt = Date.now() - 30_000;
    detach.detached(dropped.id, HERE, wentAt);
    detach.detached(blip.id, HERE, Date.now() - AGENCY_FLOOR_DISCONNECTED_ALERT_AFTER_MS + 5_000);
    // A station gone elsewhere (another account's session): never on this account's alerts.
    detach.detached(randomUUID(), { tenantId: T, accountId: OTHER_ACCOUNT }, wentAt);
    connected = new Map([[dropped.id, false], [blip.id, false]]);

    const first = await alerts();
    expect(first.alerts).toEqual([
      {
        id: `break_over:${longBreak.id}:${started.toISOString()}`, kind: 'break_over', session_id: longBreak.id,
        agent_user_id: longBreak.agent_user_id, campaign_id: longBreak.campaign_id, campaign_name: expect.any(String),
        since: new Date(started.getTime() + 15 * 60_000).toISOString(), break_reason: 'tea', break_label: 'Tea', limit_minutes: 15,
        break_started_at: started.toISOString(),
      },
      {
        id: `disconnected:${dropped.id}:${new Date(wentAt).toISOString()}`, kind: 'disconnected', session_id: dropped.id,
        agent_user_id: dropped.agent_user_id, campaign_id: dropped.campaign_id, campaign_name: expect.any(String),
        since: new Date(wentAt).toISOString(), state: 'available', client_kind: 'web', call_id: null,
      },
      {
        id: `help:${helped.id}:${raised.raised_at.toISOString()}`, kind: 'help', session_id: helped.id,
        agent_user_id: helped.agent_user_id, campaign_id: helped.campaign_id, campaign_name: expect.any(String),
        since: raised.raised_at.toISOString(), help: { raised_at: raised.raised_at.toISOString(), call_id: null, state_at_raise: 'available' },
      },
    ]);
    expect(first.alerts.some((a) => a['session_id'] === shortBreak.id || a['session_id'] === blip.id)).toBe(false);
    expect((await alerts()).alerts.map((a) => a['id'])).toEqual(first.alerts.map((a) => a['id']));

    // The floor: the gone station's time while it is not held; null on the rest.
    const floor = await app.inject({
      method: 'GET', url: `/api/v1/agency/floor?from=${encodeURIComponent(new Date(Date.now() - 3_600_000).toISOString())}`, headers,
    });
    const bySession = new Map((floor.json().agents as Array<{ session_id: string; connected: boolean | null; disconnected_since: string | null }>)
      .map((a) => [a.session_id, a]));
    expect(bySession.get(dropped.id)).toMatchObject({ connected: false, disconnected_since: new Date(wentAt).toISOString() });
    expect(bySession.get(helped.id)).toMatchObject({ connected: true, disconnected_since: null });

    // The agent comes back: the alert and the time go.
    detach.attached(dropped.id);
    connected = new Map();
    expect((await alerts()).alerts.map((a) => a['kind'])).toEqual(['break_over', 'help']);
  });

  it('liveness unknown (Redis could not answer): no disconnected alert, the rest served', async () => {
    const dropped = await session({ state: 'on_call', agent_user_id: randomUUID() });
    await session({ state: 'break', break_reason: 'lunch', state_since: new Date(Date.now() - 31 * 60_000), agent_user_id: randomUUID() });
    detach.detached(dropped.id, HERE, Date.now() - 60_000);
    connected = new Error('redis down');
    expect((await alerts()).alerts.map((a) => a['kind'])).toEqual(['break_over']);
    connected = new Map([[dropped.id, false]]);
    expect((await alerts()).alerts.map((a) => [a['kind'], a['state']])).toEqual([['break_over', undefined], ['disconnected', 'on_call']]);
  });

  it('a soft-phone agent whose station went during a live soft-phone call is a disconnected alert; idle on the soft phone, none', async () => {
    const onCall = await insertSoftphoneSession({ agent_user_id: randomUUID() }) as unknown as Session;
    const idle = await insertSoftphoneSession({ agent_user_id: randomUUID() }) as unknown as Session;
    await insertManualCall(onCall, { state: 'bridged', bridged_at: new Date(), dialed_at: new Date() });
    const wentAt = Date.now() - 30_000;
    detach.detached(onCall.id, HERE, wentAt);
    detach.detached(idle.id, HERE, wentAt);
    connected = new Map([[onCall.id, false], [idle.id, false]]);
    expect((await alerts()).alerts).toMatchObject([
      { kind: 'disconnected', session_id: onCall.id, state: 'break', campaign_id: null, since: new Date(wentAt).toISOString() },
    ]);
  });

  it('the account\'s gone sessions that have ended are forgotten by the read (the memory keeps only open ones); another account\'s are untouched', async () => {
    const left = await session({ state: 'offline', left_at: new Date(), agent_user_id: randomUUID() });
    const open = await session({ state: 'offline', agent_user_id: randomUUID() });
    await insertAgentSessionEvent(open as never, 'offline', new Date(Date.now() - 60_000), { from_state: 'available' });
    const elsewhere = randomUUID();
    detach.detached(left.id, HERE, Date.now() - 60_000);
    detach.detached(open.id, HERE, Date.now() - 60_000);
    detach.detached(elsewhere, { tenantId: T, accountId: OTHER_ACCOUNT }, Date.now() - 60_000);
    connected = new Map([[open.id, false], [left.id, false]]);
    expect((await alerts()).alerts.map((a) => a['session_id'])).toEqual([open.id]);
    // FALSIFIED: without the forget, the left session stays in memory and is sent to the SQL on every poll.
    expect(detach.goneSessionIds(HERE)).toEqual([open.id]);
    expect(detach.goneSessionIds({ tenantId: T, accountId: OTHER_ACCOUNT })).toEqual([elsewhere]);
  });

  it('refuses a request with no account (400), as the floor does', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/agency/floor/alerts', headers: { 'x-mgkvc-tenant': T } });
    expect(res.statusCode).toBe(400);
  });
});

describe('the plans, on a seeded table', () => {
  beforeAll(async () => {
    await truncateAll();
    // Other tenants' open sessions, and many closed sessions, some with old requests on them.
    await pool().query(
      `INSERT INTO agency_agent_sessions (tenant_id, account_id, kind, agent_user_id, state, break_reason)
       SELECT gen_random_uuid(), gen_random_uuid(), 'softphone', gen_random_uuid(), 'break', 'soft_phone' FROM generate_series(1, 3000)`);
    await pool().query(
      `INSERT INTO agency_agent_sessions (tenant_id, account_id, kind, agent_user_id, state, joined_at, left_at)
       SELECT CASE WHEN g % 10 = 0 THEN $1::uuid ELSE gen_random_uuid() END, CASE WHEN g % 10 = 0 THEN $2::uuid ELSE gen_random_uuid() END,
              'softphone', gen_random_uuid(), 'offline', now() - interval '3 days', now() - interval '2 days'
         FROM generate_series(1, 20000) g`, [T, A]);
    // A transition log of other agents' shifts.
    await pool().query(
      `INSERT INTO agency_agent_session_events (session_id, tenant_id, account_id, agent_user_id, from_state, to_state, at)
       SELECT s.id, s.tenant_id, s.account_id, s.agent_user_id, 'available', 'offline', s.joined_at + (g || ' seconds')::interval
         FROM agency_agent_sessions s CROSS JOIN generate_series(1, 3) g`);
    await pool().query('ANALYZE agency_agent_sessions, agency_campaigns, agency_agent_session_events');
  }, 60_000);

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
    const { rows } = await pool().query<{ 'QUERY PLAN': unknown }>(`EXPLAIN (FORMAT JSON) ${sql}`, params);
    return nodes(rows[0]!['QUERY PLAN']);
  }
  const seqOnSessions = (p: Array<Record<string, unknown>>) =>
    p.filter((n) => n['Node Type'] === 'Seq Scan' && n['Relation Name'] === 'agency_agent_sessions');

  it('the open requests on idx_agency_agent_sessions_help_open, by tenant and account', async () => {
    const p = await plan(FLOOR_ALERTS_HELP_SQL, [T, A, AGENCY_HELP_EXPIRY_MS]);
    const idx = p.filter((n) => n['Index Name'] === 'idx_agency_agent_sessions_help_open');
    expect(idx).toHaveLength(1);
    expect(String(idx[0]!['Index Cond'])).toMatch(/tenant_id = .*account_id = /);
    expect(seqOnSessions(p)).toEqual([]);
  });

  it('the breaks and gone sessions on uq_agency_agent_live_tenant by the tenant; the last event on the agent\'s events', async () => {
    const p = await plan(FLOOR_ALERTS_SESSIONS_SQL, [T, A, [randomUUID(), randomUUID()]]);
    const live = p.filter((n) => n['Index Name'] === 'uq_agency_agent_live_tenant');
    expect(live).toHaveLength(1);
    expect(String(live[0]!['Index Cond'])).toMatch(/tenant_id = /);
    expect(seqOnSessions(p)).toEqual([]);
    expect(p.filter((n) => n['Node Type'] === 'Seq Scan' && n['Relation Name'] === 'agency_agent_session_events')).toEqual([]);
    const events = p.filter((n) => n['Index Name'] === 'idx_agency_session_events_agent');
    expect(events).toHaveLength(1);
    expect(String(events[0]!['Index Cond'])).toMatch(/agent_user_id = /);
  });
});
