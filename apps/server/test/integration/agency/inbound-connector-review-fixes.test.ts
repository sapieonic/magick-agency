import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { DEFAULTS, insertTenant } from '../setup/factories.js';
import { insertAgencyCampaign, insertAgentSession } from './agency-factories.js';
import { closeTestRedis, flushTestRedis, getTestRedis } from '../../helpers/test-redis.js';
import { FakeBridge, FakeStations, gate, sleep, until } from './inbound-connector-fakes.js';

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
const { standardClipHash } = await import('../../../src/agency/inbound/inbound-standard-clips.js');
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

function connector(opts: { connectDelayMs?: number; republishMs?: number; rejoinGraceMs?: number } = {}): Connector {
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
    ...(opts.rejoinGraceMs !== undefined ? { rejoinGraceMs: opts.rejoinGraceMs } : {}),
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

});

/**
 * The station closing as in production (`FakeStations.close`): the registry detaches it (the
 * connector hears the detach), then the runtime's close handler tells the connector and, with no
 * live call on the socket, writes the agent `offline`.
 */
async function closeStation(c: Connector, sessionId: string, opts: { liveCall?: boolean } = {}): Promise<void> {
  await stations.close(sessionId, async () => {
    if (opts.liveCall) return; // the bridge's deferred hangup owns presence (`releaseStationOnClose`)
    c.onStationClosed(sessionId);
    await agents.set(sessionId, 'offline', { leaseMs: 60_000 });
  });
}

describe('SWE-F1: the rejoin grace — a station that has just closed still counts as one who could take the caller', () => {
  it('a blip under the grace does not overflow: the only agent on a call (live call: Redis keeps on_call) or in wrap-up (written offline) drops and comes back; the 2 s republish searches meanwhile', async () => {
    const c = connector({ republishMs: 100, rejoinGraceMs: 1500 });
    const onCall = await agent('on_call');
    const { call } = await caller(c);
    await until('queued', async () => (await row(call.id)).state === 'queued');
    const station = { ...stations.get(onCall)! };
    await closeStation(c, onCall, { liveCall: true });
    await sleep(600); // several republish searches inside the grace
    expect((await row(call.id)).state).toBe('queued');
    stations.reattach(station);
    await sleep(1400); // the grace has ended: the agent, back and on their call, still counts
    expect((await row(call.id)).state).toBe('queued');

    // In wrap-up: the close writes `offline`; the state at the close (wrap-up) is what counts.
    await agents.set(onCall, 'wrapup', { leaseMs: 60_000 });
    await closeStation(c, onCall);
    expect(await agents.get(onCall)).toMatchObject({ state: 'offline' });
    await sleep(600);
    expect((await row(call.id)).state).toBe('queued');
    stations.reattach(station);
    await agents.set(onCall, 'wrapup', { leaseMs: 60_000 }); // the rehydrate restores the wrap-up this process holds
    await sleep(1400);
    expect((await row(call.id)).state).toBe('queued');
    expect((await row(call.id)).outcome).toBeNull();
  });

  it('a close that outlasts the grace overflows them when it ends (its own timer: no republish), not before and not at the maximum wait', async () => {
    const c = connector({ rejoinGraceMs: 1000 }); // republish every minute: only the grace's timer can tell
    const s1 = await agent('wrapup');
    const { call } = await caller(c);
    await until('queued', async () => (await row(call.id)).state === 'queued');
    const closedAt = Date.now();
    await closeStation(c, s1);
    await sleep(500);
    expect((await row(call.id)).state).toBe('queued');
    await until('overflowed', async () => (await row(call.id)).state === 'ended', 3000);
    expect(Date.now() - closedAt).toBeGreaterThanOrEqual(1000);
    expect(Date.now() - closedAt).toBeLessThan(2500);
    expect(await row(call.id)).toMatchObject({ outcome: 'overflow', follow_up_reason: 'overflow', offer_count: 0 });
  });

  it('a station that closes while its agent is on a break never counted: it does not hold the caller', async () => {
    const c = connector({ rejoinGraceMs: 60_000 });
    const s1 = await agent('on_call');
    const s2 = await agent('break');
    const { call } = await caller(c);
    await until('queued', async () => (await row(call.id)).state === 'queued');
    await closeStation(c, s2);
    await agents.set(s1, 'break', { leaseMs: 60_000 });
    c.onAgentAvailable(s1); // a search (any presence event): s1 on a break, s2 gone on a break
    await until('overflowed', async () => (await row(call.id)).state === 'ended', 3000);
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

describe('SWE-F3: a decline or a refused bind after the caller`s maximum wait passed during the offer', () => {
  it('the decline answers and the agent is back in the pool at once; the overflow message plays after, on the call`s chain', async () => {
    const short = { ...route, queue_max_wait_seconds: 1 };
    const c = connector({ connectDelayMs: 60_000 }); // the offer stands past the maximum wait
    const s1 = await agent('available');
    await agent('on_call'); // someone who could take the caller later: no `no_agents` overflow
    const clip = gate();
    bridge.clipGate = clip.wait; // the overflow message plays until the test says
    const { call } = await caller(c, {}, short);
    await until('offered', async () => (await row(call.id)).state === 'offered');
    await sleep(1200); // the maximum wait passes during the offer
    const started = Date.now();
    const answered = await Promise.race([service(c).hangup(actorOf(s1), call.id).then(() => 'answered'), sleep(2000).then(() => 'blocked')]);
    expect(answered).toBe('answered');
    expect(Date.now() - started).toBeLessThan(1500);
    await until('the agent back in the pool', async () => {
      const live = await agents.get(s1);
      return live?.state === 'available' && live.inboundCallId === null;
    }, 1500);
    // The overflow message is still playing: the call has not ended yet.
    expect((await row(call.id)).state).toBe('queued');
    clip.open();
    await until('overflowed', async () => (await row(call.id)).state === 'ended');
    expect(await row(call.id)).toMatchObject({ outcome: 'overflow', follow_up_reason: 'overflow' });
    expect(offersTo(s1)).toBe(1);
  });

  it('a bind refused (station OPEN) past the maximum wait: the agent released before the overflow runs', async () => {
    const short = { ...route, queue_max_wait_seconds: 1 };
    const c = connector({ connectDelayMs: 1300 }); // the bind comes after the maximum wait
    const s1 = await agent('available');
    await agent('on_call');
    const clip = gate();
    bridge.clipGate = clip.wait;
    const { call } = await caller(c, {}, short);
    bridge.refuseBind.set(call.id, 'other');
    await until('offered', async () => (await row(call.id)).state === 'offered');
    await until('the bind refused', () => !bridge.refuseBind.has(call.id), 3000);
    await until('the agent back in the pool while the message plays', async () => {
      const live = await agents.get(s1);
      return live?.state === 'available' && live.inboundCallId === null;
    }, 1500);
    expect((await row(call.id)).state).toBe('queued');
    clip.open();
    await until('overflowed', async () => (await row(call.id)).state === 'ended');
    expect((await row(call.id)).outcome).toBe('overflow');
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

describe('PM-M6 / SWE-N4: nobody could take the caller — decided at the answer, before any "please hold"', () => {
  const ALWAYS = [1, 2, 3, 4, 5, 6, 7].map((day) => ({ day, start: '00:00', end: '24:00' }));
  let seq = 0;

  /** An open route of the account answering a fresh number linked to inbound on the credential. */
  async function openRoute(o: Record<string, unknown> = {}): Promise<string> {
    const e164 = `+1415557${String(1000 + ++seq).padStart(4, '0')}`;
    const plivo = (await pool().query<{ id: string }>(`SELECT id FROM telephony_providers WHERE name = 'plivo'`)).rows[0]!.id;
    const { rows: [n] } = await pool().query<{ id: string }>(
      `INSERT INTO phone_numbers (phone_number, provider_id, telephony_credential_id, status, inbound_linked_at)
       VALUES ($1, $2, $3, 'active', now()) RETURNING id`, [e164, plivo, credentialId]);
    await pool().query('INSERT INTO tenant_phone_assignments (tenant_id, phone_number_id) VALUES ($1, $2)', [T, n!.id]);
    const parsed = parseInboundRouteCreate({ name: `Open ${seq}`, timezone: 'UTC', weekly_hours: ALWAYS, sticky_mode: 'off', ...o });
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues));
    const created = await routes.create({ tenantId: T, accountId: A, createdBy: null, config: parsed.config });
    if (!created.ok) throw new Error(created.reason);
    const attached = await routes.attachNumber({ tenantId: T, accountId: A, routeId: created.route.id, phoneNumberId: n!.id, attachedBy: null });
    if (!attached.ok) throw new Error(attached.reason);
    return e164;
  }

  /** The router as `startInboundCalls` wires it, with this connector; the bridge's stream and voicemail faked. */
  function routed(c: Connector) {
    const accept = vi.fn(async (input: { correlationId: string }) => {
      bridge.take(input.correlationId);
      return { accepted: true as const, streamUrl: 'wss://agency.test/stream', maxDurationSeconds: 1800, capacity: 'admitted' as const };
    });
    const recordInboundAudio = vi.fn(async () => ({ result: 'aborted' as const, pcm16: Buffer.alloc(1600), sampleRate: 8000, seconds: 0.1 }));
    const r = new AgencyInboundCallRouter({
      bridge: Object.assign(bridge, { acceptInboundCall: accept, recordInboundAudio }) as never,
      dnc: { check: async () => 'clear', checkEntry: async () => ({ result: 'clear' }) } as never,
      connect: { connector: c, enabled: async () => true, mediaWorkers: 0 },
      voicemailStorage: { configured: () => true, upload: vi.fn(async () => undefined), remove: vi.fn(async () => undefined) },
    });
    return { r, accept, recordInboundAudio };
  }

  const arrive = (toE164: string) => ({
    credentialId, tenantId: T, provider: 'plivo', credentialStatus: 'active' as const,
    carrierCallId: `CA-${randomUUID()}`, fromE164: '+447700900777', toE164,
  });
  const byCarrierId = async (id: string) => (await pool().query<CallRecord>('SELECT * FROM agency_inbound_calls WHERE provider_call_id = $1', [id])).rows[0]!;

  it('nobody logged in, or only an agent on a break: the call-back message at once (spoken, no stream), never queued, overflow with its Missed row', async () => {
    const c = connector();
    const e164 = await openRoute();
    const { r, accept } = routed(c);
    const a = arrive(e164);
    expect(await r.answer(a)).toEqual({ kind: 'spoken', message: 'callback' });
    await agent('break');
    const b = arrive(e164);
    expect(await r.answer(b)).toEqual({ kind: 'spoken', message: 'callback' });
    expect(accept).not.toHaveBeenCalled();
    expect(c.heldCallIds()).toEqual([]);
    for (const id of [a.carrierCallId, b.carrierCallId]) {
      expect(await byCarrierId(id)).toMatchObject({ state: 'ended', outcome: 'overflow', follow_up_status: 'open', follow_up_reason: 'overflow', queued_at: null });
    }
  });

  it('nobody, on a route whose overflow action is voicemail: the voicemail at once (our prompt, the beep), with no "please hold" and no queue', async () => {
    const c = connector();
    const e164 = await openRoute({ overflow_action: 'voicemail' });
    const { r, recordInboundAudio } = routed(c);
    const a = arrive(e164);
    expect(await r.answer(a)).toMatchObject({ kind: 'stream' });
    await r.drain();
    expect(c.heldCallIds()).toEqual([]);
    expect(recordInboundAudio).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      promptClipHashes: [await standardClipHash('voicemail_prompt')], beep: true,
    }));
    expect(await byCarrierId(a.carrierCallId)).toMatchObject({ state: 'ended', outcome: 'overflow', queued_at: null });
  });

  it('an agent who could take them later (on a call), or whose station closed within the rejoin grace: queued as before', async () => {
    const c = connector({ rejoinGraceMs: 60_000 });
    const e164 = await openRoute();
    const { r } = routed(c);
    const s1 = await agent('on_call');
    const a = arrive(e164);
    expect(await r.answer(a)).toMatchObject({ kind: 'stream' });
    const first = await byCarrierId(a.carrierCallId);
    expect(c.holds(first.id)).toBe(true);
    await until('queued', async () => (await row(first.id)).state === 'queued');
    // The same agent, in wrap-up, drops: within the grace they still count.
    await agents.set(s1, 'wrapup', { leaseMs: 60_000 });
    await closeStation(c, s1);
    const b = arrive(e164);
    expect(await r.answer(b)).toMatchObject({ kind: 'stream' });
    expect(c.holds((await byCarrierId(b.carrierCallId)).id)).toBe(true);
  });
});
