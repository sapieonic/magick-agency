import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { DEFAULTS, insertTenant } from '../setup/factories.js';
import { insertAgencyCampaign, insertAgentSession } from './agency-factories.js';
import { closeTestRedis, flushTestRedis, getTestRedis } from '../../helpers/test-redis.js';
import { FakeBridge, FakeStations, sleep, until } from './inbound-connector-fakes.js';

vi.mock('@magick-agency/db', async (orig) => ({
  ...(await orig<typeof import('@magick-agency/db')>()),
  getPool: () => getTestPool(),
}));

const { agencyInboundCallRepository: calls, agencyInboundRouteRepository: routes } = await import('../../../src/db/repositories/agency.repository.js');
const { AgentStateMachine, AGENT_LEASE_MS } = await import('../../../src/agency/agent-state-machine.js');
const { InboundConnector } = await import('../../../src/agency/inbound/inbound-connector.js');
const { AgencyInboundCallRouter } = await import('../../../src/agency/inbound/inbound-call-router.js');
const { parseInboundRouteCreate } = await import('../../../src/agency/inbound/route-config.js');
const { InboundCallService } = await import('../../../src/agency/inbound/inbound-disposition.js');
type Connector = InstanceType<typeof InboundConnector>;
type CallRecord = import('../../../src/db/repositories/agency.repository.js').AgencyInboundCallRecord;
type RouteRecord = import('../../../src/db/repositories/agency.repository.js').AgencyInboundRouteRecord;

/**
 * The inbound connector's review fixes, on real Redis and Postgres with the bridge and the station
 * sockets faked in process (`inbound-connector-fakes.ts`):
 *  - PM-M6: a caller nobody in the pool could take is overflowed at once, when queued and when
 *    presence changes while they wait; agents busy with work that ends keep them waiting;
 *  - QA-F10: membership and deactivation are read at every search, so a removed agent is never
 *    offered the caller;
 *  - QA-F3: a hang-up of an offered call is the agent declining it (requeued for the next agent,
 *    nothing abandoned);
 *  - SWE-m4: a bind the bridge refuses for a reason other than the call ending cancels the offer;
 *  - SWE-m1/m8: the hang-up asks the connector whether the call is live, and waits on its end;
 *  - QA-F5 and the tile's `no_agents_available`: who the supervisor's tile counts.
 */

const T = DEFAULTS.tenantId;
const A = DEFAULTS.accountId;
const pool = () => getTestPool();
const PREFIX = 'ibfix:';

let credentialId: string;
let route: RouteRecord;
let campaignId: string;
let agents: InstanceType<typeof AgentStateMachine>;
let stations: FakeStations;
let bridge: FakeBridge;
let connectors: Connector[] = [];

const router = () => new AgencyInboundCallRouter({
  bridge: bridge as never,
  dnc: { check: async () => 'clear', checkEntry: async () => ({ result: 'clear' }) } as never,
});

function connector(opts: { connectDelayMs?: number; republishMs?: number } = {}): Connector {
  const c: Connector = new InboundConnector({
    bridge: bridge as never,
    stations: stations as never,
    agents,
    releaseAgent: async (id) => {
      if (await c.takeOnRelease(id)) return;
      await agents.set(id, 'available', { leaseMs: AGENT_LEASE_MS.available });
    },
    exits: router(),
    connectDelayMs: opts.connectDelayMs ?? 150,
    publish: () => {},
    republishMs: opts.republishMs ?? 60_000,
  });
  c.start();
  connectors.push(c);
  return c;
}

const service = (c: Connector) => new InboundCallService({
  bridge: bridge as never, agents, stations: stations as never,
  releaseAgent: async (id) => { if (!(await c.takeOnRelease(id))) await agents.set(id, 'available', { leaseMs: 60_000 }); },
  connector: () => c,
});

/** An active user with a tenant-wide membership (one who sees every account of the tenant). */
async function member(): Promise<string> {
  const id = randomUUID();
  await pool().query('INSERT INTO users (id, firebase_uid, email) VALUES ($1, $2, $3)', [id, `fb-fix-${id}`, `fix-${id}@example.test`]);
  await pool().query(`INSERT INTO memberships (user_id, tenant_id, role) VALUES ($1, $2, 'agent')`, [id, T]);
  return id;
}

type AgentOpts = { campaign?: string | null; accountId?: string; clientKind?: 'web' | 'mobile'; member?: boolean };

/** A live campaign session with a station on this "process", in `state` in Redis. */
async function agent(state: 'available' | 'wrapup' | 'on_call' | 'reserved' | 'break' | 'offline' = 'available', opts: AgentOpts = {}): Promise<string> {
  const userId = opts.member === false ? randomUUID() : await member();
  const sessionCampaign = opts.campaign === undefined ? campaignId : opts.campaign;
  const session = await insertAgentSession(sessionCampaign ?? campaignId, { agent_user_id: userId, ...(opts.accountId ? { account_id: opts.accountId } : {}) });
  stations.add({
    sessionId: session.id as string, campaignId: sessionCampaign, tenantId: T, accountId: opts.accountId ?? A, agentUserId: userId,
    ...(opts.clientKind ? { clientKind: opts.clientKind } : {}),
  });
  await agents.set(session.id as string, state, { leaseMs: 60_000 });
  return session.id as string;
}

async function caller(c: Connector, over: Partial<Parameters<typeof calls.insertArrival>[0]> = {}, routeOf = route): Promise<{ call: CallRecord; done: Promise<void> }> {
  const { call } = await calls.insertArrival({
    tenantId: T, accountId: A, routeId: route.id, phoneNumberId: null, provider: 'plivo', telephonyCredentialId: credentialId,
    providerCallId: `CA-${randomUUID()}`, fromE164: `+4477009${String(Math.floor(Math.random() * 90_000) + 10_000)}`, toE164: '+14155550100',
    identification: { match: null, callerDnc: false, sticky: null }, answered: true, recordingRequested: false, analysisProfileId: null,
    ...over,
  });
  await calls.transition(call!.id, 'greeting');
  bridge.take(call!.id);
  const done = c.take({ call: (await calls.findByIdAnyTenant(call!.id))!, route: routeOf, stickyCandidates: [], recordingNotice: false });
  return { call: call!, done };
}

const row = async (id: string) => (await calls.findByIdAnyTenant(id))!;
const drain = async () => { for (const c of connectors) await c.drain(); };
const inboundFrames = (sessionId: string) => (stations.get(sessionId)?.ws.sent ?? []).filter((f) => f['event'] === 'inbound_call').map((f) => f['call'] as Record<string, unknown>);
const offersTo = (sessionId: string) => inboundFrames(sessionId).filter((f) => f['state'] === 'offered').length;
const actorOf = (sessionId: string) => ({ tenantId: T, accountId: A, userId: stations.get(sessionId)!.agentUserId, supervise: false });

beforeEach(async () => {
  await truncateAll();
  await flushTestRedis();
  await pool().query(`INSERT INTO telephony_providers (name, display_name) VALUES ('voicelink', 'VoiceLink'), ('plivo', 'Plivo')`);
  await insertTenant({ id: T });
  credentialId = (await pool().query<{ id: string }>(
    `INSERT INTO telephony_credentials (tenant_id, provider, label, account_ref) VALUES ($1, 'plivo', 'Main', 'MA000000000000000001') RETURNING id`,
    [T])).rows[0]!.id;
  const parsed = parseInboundRouteCreate({ name: 'Main', timezone: 'UTC', weekly_hours: [], sticky_mode: 'off' });
  if (!parsed.ok) throw new Error('route');
  const created = await routes.create({ tenantId: T, accountId: A, createdBy: null, config: parsed.config });
  if (!created.ok) throw new Error('route');
  route = created.route;
  expect(route.queue_max_wait_seconds).toBeGreaterThanOrEqual(60); // every "at once" below is far inside it
  campaignId = (await insertAgencyCampaign({ tenant_id: T, account_id: A, status: 'running' })).id as string;
  agents = new AgentStateMachine(getTestRedis(), PREFIX);
  stations = new FakeStations();
  bridge = new FakeBridge();
  connectors = [];
});

afterEach(async () => {
  for (const [id] of bridge.live) bridge.end(id);
  await drain();
  for (const c of connectors) c.stop();
});

afterAll(async () => {
  await truncateAll();
  await closeTestPool();
  await closeTestRedis();
});

/** The call ended `overflow` with its Missed row, never having been offered, well inside the route's maximum wait. */
async function overflowedAtOnce(id: string, startedAt: number): Promise<void> {
  await until('overflowed', async () => (await row(id)).state === 'ended', 4000);
  expect(Date.now() - startedAt).toBeLessThan(4000);
  expect(await row(id)).toMatchObject({ outcome: 'overflow', follow_up_reason: 'overflow', follow_up_status: 'open', offer_count: 0 });
}

describe('PM-M6: a caller nobody in the pool could take is not held to the maximum wait', () => {
  it('nobody logged in: overflowed as soon as they queue (overflow, with the Missed row)', async () => {
    const c = connector();
    const started = Date.now();
    const { call } = await caller(c);
    await overflowedAtOnce(call.id, started);
  });

  it('only agents who will never take them (a break, offline, the phone app, outside the pool, the soft phone, no longer a member): overflowed at once, nobody offered', async () => {
    const pooled = { ...route, pool_campaign_ids: [campaignId] };
    const other = (await insertAgencyCampaign({ tenant_id: T, account_id: A, status: 'running' })).id as string;
    const c = connector();
    const sessions = [
      await agent('break'),
      await agent('offline'),
      await agent('available', { clientKind: 'mobile' }),
      await agent('available', { campaign: other }),
      await agent('available', { campaign: null }),
      await agent('available', { member: false }),
    ];
    const started = Date.now();
    const { call } = await caller(c, {}, pooled);
    await overflowedAtOnce(call.id, started);
    for (const s of sessions) expect(inboundFrames(s), s).toEqual([]);
  });

  it('an agent busy with work that ends (on a call, in wrap-up) keeps them waiting; that agent going on a break (no event: the republish) overflows them', async () => {
    const c = connector({ republishMs: 100 });
    const s1 = await agent('wrapup');
    const s2 = await agent('on_call');
    const { call } = await caller(c);
    await until('queued', async () => (await row(call.id)).state === 'queued');
    await sleep(400); // several republishes and searches
    expect((await row(call.id)).state).toBe('queued');
    await agents.set(s1, 'break', { leaseMs: 60_000 });
    await sleep(300);
    expect((await row(call.id)).state).toBe('queued'); // s2 is still on a call: they will be free
    const started = Date.now();
    await agents.set(s2, 'break', { leaseMs: 60_000 });
    await until('overflowed', async () => (await row(call.id)).state === 'ended', 3000);
    expect(Date.now() - started).toBeLessThan(3000);
    expect(await row(call.id)).toMatchObject({ outcome: 'overflow', follow_up_status: 'open' });
  });

  it('the last station that could take them closing (the runtime`s close handler) overflows them at once, with no republish', async () => {
    const c = connector(); // republish every minute: only the close can tell the connector
    const s1 = await agent('on_call');
    const { call } = await caller(c);
    await until('queued', async () => (await row(call.id)).state === 'queued');
    await sleep(200);
    expect((await row(call.id)).state).toBe('queued');
    stations.get(s1)!.ws.readyState = 3;
    c.onStationClosed(s1);
    await until('overflowed', async () => (await row(call.id)).state === 'ended', 2000);
    expect((await row(call.id)).outcome).toBe('overflow');
  });
});

describe('QA-F10: membership is read at every search', () => {
  it('an agent removed from the account, or deactivated, while the caller waits is never offered them; a member is', async () => {
    const c = connector();
    const removed = await agent('on_call');
    const deactivated = await agent('on_call');
    const stays = await agent('on_call');
    const { call } = await caller(c);
    await until('queued', async () => (await row(call.id)).state === 'queued');
    await pool().query('DELETE FROM memberships WHERE user_id = $1', [stations.get(removed)!.agentUserId]);
    await pool().query(`UPDATE users SET status = 'inactive' WHERE id = $1`, [stations.get(deactivated)!.agentUserId]);
    for (const s of [removed, deactivated]) {
      await agents.set(s, 'available', { leaseMs: 60_000 });
      c.onAgentAvailable(s);
    }
    await sleep(300);
    await drain();
    expect((await row(call.id)).state).toBe('queued'); // `stays` is on a call: they keep waiting for them
    expect(inboundFrames(removed)).toEqual([]);
    expect(inboundFrames(deactivated)).toEqual([]);
    expect(await agents.get(removed)).toMatchObject({ state: 'available', inboundCallId: null });
    await agents.set(stays, 'available', { leaseMs: 60_000 });
    c.onAgentAvailable(stays);
    await until('connected to the member', async () => (await row(call.id)).state === 'connected');
    expect((await row(call.id)).session_id).toBe(stays);
  });
});

describe('QA-F3: hanging up an offered call is the agent declining it', () => {
  it('requeued at the head for the next agent (never this one), the agent back in the pool; nothing abandoned, no Missed row, no callback', async () => {
    const c = connector({ connectDelayMs: 60_000 }); // the offer stands: the bind would come much later
    const s1 = await agent('available');
    const s2 = await agent('on_call');
    const { call } = await caller(c);
    const offered = await until('offered to s1', async () => { const r = await row(call.id); return r.state === 'offered' ? r : null; });
    expect(offered.session_id).toBe(s1);

    const res = await service(c).hangup(actorOf(s1), call.id);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.hungUp).toBe(true);
    expect(res.call).toMatchObject({ id: call.id, state: 'queued', session_id: s1, outcome: null });
    await drain();
    expect(await row(call.id)).toMatchObject({
      state: 'queued', session_id: null, outcome: null, ended_at: null, follow_up_status: null, follow_up_reason: null, callback_due_at: null,
    });
    expect((await row(call.id)).queued_at!.getTime()).toBe(offered.queued_at!.getTime());
    expect(await agents.get(s1)).toMatchObject({ state: 'available', inboundCallId: null });
    expect(inboundFrames(s1).at(-1)).toMatchObject({ id: call.id, state: 'queued', session_id: s1 });
    // Free and searched for again, s1 is never offered this caller a second time.
    c.onAgentAvailable(s1);
    await sleep(300);
    await drain();
    expect(offersTo(s1)).toBe(1);
    expect((await row(call.id)).state).toBe('queued');
    // The next agent free takes them.
    await agents.set(s2, 'available', { leaseMs: 60_000 });
    c.onAgentAvailable(s2);
    await until('offered to s2', async () => (await row(call.id)).session_id === s2);
    expect((await row(call.id)).offer_count).toBe(2);
  });

  it('the only agent declines: nobody else could take the caller, who is overflowed at once (overflow, never abandoned_in_queue)', async () => {
    const c = connector({ connectDelayMs: 60_000 });
    const s1 = await agent('available');
    const { call } = await caller(c);
    await until('offered', async () => (await row(call.id)).state === 'offered');
    const res = await service(c).hangup(actorOf(s1), call.id);
    expect(res.ok && res.hungUp).toBe(true);
    await until('overflowed', async () => (await row(call.id)).state === 'ended', 3000);
    expect(await row(call.id)).toMatchObject({ outcome: 'overflow', follow_up_reason: 'overflow' });
    await drain();
    expect(await agents.get(s1)).toMatchObject({ state: 'available', inboundCallId: null });
  });
});

describe('SWE-m4: a bind the bridge refuses', () => {
  it('for a reason other than the call ending (the station OPEN): the offer cancelled, the caller back at the head for the next agent, the refused agent back in the pool and never offered them again', async () => {
    const c = connector();
    const s1 = await agent('available');
    const s2 = await agent('on_call');
    const { call } = await caller(c);
    bridge.refuseBind.set(call.id, 'other');
    await until('requeued', async () => { const r = await row(call.id); return r.state === 'queued' && r.offer_count === 1; });
    await drain();
    expect(bridge.binds).toEqual([]);
    expect((await row(call.id)).session_id).toBeNull();
    expect(await agents.get(s1)).toMatchObject({ state: 'available', inboundCallId: null });
    c.onAgentAvailable(s1);
    await sleep(300);
    expect(offersTo(s1)).toBe(1);
    await agents.set(s2, 'available', { leaseMs: 60_000 });
    c.onAgentAvailable(s2);
    await until('connected to s2', async () => (await row(call.id)).state === 'connected');
    expect((await row(call.id)).session_id).toBe(s2);
  });

  it('because the call is ending: nothing is cancelled; the caller`s end settles the offer (abandoned_in_queue) and releases the agent', async () => {
    const c = connector();
    const s1 = await agent('available');
    const { call } = await caller(c);
    bridge.refuseBind.set(call.id, 'ending');
    await until('the bind refused', () => !bridge.refuseBind.has(call.id));
    await sleep(100);
    await drain();
    expect(await row(call.id)).toMatchObject({ state: 'offered', session_id: s1, offer_count: 1 });
    bridge.end(call.id);
    await until('ended', async () => (await row(call.id)).state === 'ended');
    await drain();
    expect((await row(call.id)).outcome).toBe('abandoned_in_queue');
    expect((await agents.get(s1))?.inboundCallId ?? null).toBeNull();
  });

  it('with the socket found closed by the bridge: the offer cancelled like a lost station`s, and the agent NOT put back in the pool (the close handler writes offline)', async () => {
    const c = connector();
    const s1 = await agent('available');
    await agent('on_call'); // someone who could take the caller later
    const { call } = await caller(c);
    bridge.refuseBind.set(call.id, 'socket_closed'); // closes after the connector's check, before the bridge's
    await until('requeued', async () => { const r = await row(call.id); return r.state === 'queued' && r.offer_count === 1; });
    expect((await row(call.id)).session_id).toBeNull();
    await drain();
    expect((await agents.get(s1))?.state).toBe('reserved'); // left to the close handler, never `available`
    expect((await agents.get(s1))?.inboundCallId ?? null).toBeNull();
  });
});

describe('SWE-m1 / SWE-m8: the hang-up asks the connector, and waits on its end', () => {
  it('a connected call whose row the stale sweep already ended is still hung up (the connector says it is live)', async () => {
    const c = connector();
    const s1 = await agent('available');
    const { call } = await caller(c);
    await until('connected', async () => (await row(call.id)).state === 'connected');
    await pool().query(`UPDATE agency_inbound_calls SET state = 'ended', outcome = 'answered', ended_at = now() WHERE id = $1`, [call.id]);
    const res = await service(c).hangup(actorOf(s1), call.id);
    expect(res.ok && res.hungUp).toBe(true);
    expect(bridge.live.has(call.id)).toBe(false);
    expect(c.holds(call.id)).toBe(false);
  });

  it('answers the ended row: the connector`s end is awaited (its completion promise), not polled', async () => {
    const c = connector();
    const s1 = await agent('available');
    const { call } = await caller(c);
    await until('connected', async () => (await row(call.id)).state === 'connected');
    const res = await service(c).hangup(actorOf(s1), call.id);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.hungUp).toBe(true);
    expect(res.call).toMatchObject({ id: call.id, state: 'ended', outcome: 'answered' });
    expect(c.holds(call.id)).toBe(false);
    expect(await agents.get(s1)).toMatchObject({ state: 'wrapup', inboundCallId: call.id });
    // A second hang-up: nothing live here any more.
    const again = await service(c).hangup(actorOf(s1), call.id);
    expect(again.ok && again.hungUp).toBe(false);
  });
});

describe('the supervisor`s tile: who it counts (QA-F5) and `no_agents_available` (PM-M6)', () => {
  it('eligible_agents judges each waiting caller by ITS account: a caller matched into another account is not counted as takeable by this route`s free agents', async () => {
    const c = connector();
    const other = randomUUID();
    const free = await agent('available');
    expect((await service(c).queueTiles(T, A))[0]).toMatchObject({ route_id: route.id, waiting: 0, eligible_agents: 1, no_agents_available: false });
    // A caller on this route whose match put them in another account (Q21): only that account's agents may take them.
    await agent('on_call', { accountId: other, campaign: (await insertAgencyCampaign({ tenant_id: T, account_id: other, status: 'running' })).id as string });
    const { call } = await caller(c, { accountId: other });
    await until('queued', async () => (await row(call.id)).state === 'queued');
    await sleep(200);
    expect((await row(call.id)).state).toBe('queued');
    expect(inboundFrames(free)).toEqual([]);
    const [tile] = await service(c).queueTiles(T, A);
    expect(tile).toMatchObject({ route_id: route.id, waiting: 1, eligible_agents: 0, no_agents_available: false });
  });

  it('no_agents_available: nobody in the route`s pool could take its next caller (a break does not count; wrap-up does)', async () => {
    const c = connector();
    expect((await service(c).queueTiles(T, A))[0]).toMatchObject({ eligible_agents: 0, no_agents_available: true });
    const s1 = await agent('break');
    expect((await service(c).queueTiles(T, A))[0]).toMatchObject({ eligible_agents: 0, no_agents_available: true });
    await agents.set(s1, 'wrapup', { leaseMs: 60_000 });
    expect((await service(c).queueTiles(T, A))[0]).toMatchObject({ eligible_agents: 0, no_agents_available: false });
    await agents.set(s1, 'available', { leaseMs: 60_000 });
    expect((await service(c).queueTiles(T, A))[0]).toMatchObject({ eligible_agents: 1, no_agents_available: false });
  });
});
