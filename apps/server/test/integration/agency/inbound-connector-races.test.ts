import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { DEFAULTS, insertTenant } from '../setup/factories.js';
import { insertAgencyCampaign, insertAgentSession } from './agency-factories.js';
import { closeTestRedis, flushTestRedis, getTestRedis } from '../../helpers/test-redis.js';

vi.mock('@magick-agency/db', async (orig) => ({
  ...(await orig<typeof import('@magick-agency/db')>()),
  getPool: () => getTestPool(),
}));

const { agencyInboundCallRepository: calls, agencyInboundRouteRepository: routes } = await import('../../../src/db/repositories/agency.repository.js');
const { AgentStateMachine, AGENT_LEASE_MS } = await import('../../../src/agency/agent-state-machine.js');
const { InboundConnector } = await import('../../../src/agency/inbound/inbound-connector.js');
const { AgencyInboundCallRouter } = await import('../../../src/agency/inbound/inbound-call-router.js');
const { AgencyDialer } = await import('../../../src/agency/agency-dialer.js');
const { BreakRegistry } = await import('@magick-agency/domain/break-manager');
const { parseInboundRouteCreate } = await import('../../../src/agency/inbound/route-config.js');
const { InboundCallService } = await import('../../../src/agency/inbound/inbound-disposition.js');
type Connector = InstanceType<typeof InboundConnector>;
type CallRecord = import('../../../src/db/repositories/agency.repository.js').AgencyInboundCallRecord;
type RouteRecord = import('../../../src/db/repositories/agency.repository.js').AgencyInboundRouteRecord;
type Lifecycle = import('../../../src/core/webrtc-bridge-manager.js').WebRtcLifecycleEvent;

/**
 * The inbound connector's races on real Redis (the agent hash's compare-and-swaps) and real
 * Postgres (the spine's guarded writes), with the bridge and the station sockets faked in
 * process (docs/inbound.md §2, "Races"): two callers for one agent, pacing and inbound for one
 * agent, two connectors (a deploy's overlap) for one agent, the caller hanging up on offer and
 * against the bind, a station lost before the bind (the head of the queue, the next agent), the
 * lease lost on offer, and the release hook (a waiting caller taken from wrap-up; a queued break
 * winning).
 */

const T = DEFAULTS.tenantId;
const A = DEFAULTS.accountId;
const pool = () => getTestPool();
const PREFIX = 'ibrace:';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ─── Fakes: the bridge and the station sockets ──────────────────────────────

class FakeWs {
  readyState = 1;
  sent: Array<Record<string, unknown>> = [];
  send(s: string) { this.sent.push(JSON.parse(s) as Record<string, unknown>); }
}

interface StationEntry {
  sessionId: string; campaignId: string | null; tenantId: string; accountId: string; agentUserId: string;
  ws: FakeWs; clientKind: 'web' | 'mobile';
}

class FakeStations {
  readonly entries = new Map<string, StationEntry>();
  add(e: Omit<StationEntry, 'ws' | 'clientKind'> & { clientKind?: 'web' | 'mobile' }): StationEntry {
    const entry = { clientKind: 'web' as const, ...e, ws: new FakeWs() };
    this.entries.set(e.sessionId, entry);
    return entry;
  }
  all() { return [...this.entries.values()]; }
  get(id: string) { return this.entries.get(id); }
  socketFor(id: string) { return this.entries.get(id)?.ws; }
  isLocallyOwned(id: string) { return this.entries.has(id); }
  send(id: string, frame: unknown) {
    const ws = this.entries.get(id)?.ws;
    if (!ws || ws.readyState !== 1) return false;
    ws.send(JSON.stringify(frame));
    return true;
  }
  broadcast() { return 0; }
}

class FakeBridge {
  readonly listeners = new Set<(ev: Lifecycle) => void>();
  readonly live = new Map<string, { bound: boolean; hold?: (r: 'released' | 'aborted') => void }>();
  binds: string[] = [];
  onLifecycle(l: (ev: Lifecycle) => void) { this.listeners.add(l); return () => { this.listeners.delete(l); }; }
  take(id: string) { this.live.set(id, { bound: false }); }
  playInboundHold(id: string, opts: { onPreambleDone?: () => void }) {
    const c = this.live.get(id);
    if (!c) return Promise.resolve('not_found' as const);
    return new Promise<'released' | 'aborted'>((resolve) => {
      c.hold = resolve;
      setImmediate(() => opts.onPreambleDone?.());
    });
  }
  stopInboundHold(id: string) { this.live.get(id)?.hold?.('released'); }
  bindBorrowedBrowserLeg(id: string, ws: FakeWs) {
    const c = this.live.get(id);
    if (!c || c.bound || ws.readyState !== 1) return false;
    c.bound = true;
    this.binds.push(id);
    c.hold?.('released');
    this.emit({ phase: 'bridged', correlationId: id });
    return true;
  }
  reattachBorrowedBrowserLeg() { return true; }
  async forceEndWithOutcome(id: string, outcome: string) { return this.end(id, outcome); }
  async playClipSequenceThenHangUp(id: string) { this.end(id, 'inbound_overflow'); return 'completed' as const; }
  async acceptInboundCall() { throw new Error('not used'); }
  end(id: string, outcome = 'pstn_stream_closed', talkTimeSeconds = 0): boolean {
    const c = this.live.get(id);
    if (!c) return false;
    this.live.delete(id);
    c.hold?.('aborted');
    this.emit({ phase: 'ended', correlationId: id, outcome, status: 'completed', talkTimeSeconds });
    return true;
  }
  emit(ev: Partial<Lifecycle> & { phase: Lifecycle['phase'] }) {
    for (const l of this.listeners) l({ callId: 'leg', answered: true, ...ev } as Lifecycle);
  }
}

// ─── The world ──────────────────────────────────────────────────────────────

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

/** A connector over the shared Redis and Postgres, returning agents as `releaseAgent` would (its hook first). */
function connector(opts: { stationsOf?: FakeStations; releaseAgent?: (id: string) => Promise<unknown>; connectDelayMs?: number } = {}): Connector {
  const st = opts.stationsOf ?? stations;
  const exits = router();
  const c: Connector = new InboundConnector({
    bridge: bridge as never,
    stations: st as never,
    agents,
    releaseAgent: opts.releaseAgent ?? (async (id) => {
      if (await c.takeOnRelease(id)) return;
      await agents.set(id, 'available', { leaseMs: AGENT_LEASE_MS.available });
    }),
    exits,
    connectDelayMs: opts.connectDelayMs ?? 150,
    publish: () => {},
  });
  c.start();
  connectors.push(c);
  return c;
}

/** A live campaign session with a station on this "process", `available` in Redis unless told. */
async function agent(state: 'available' | 'wrapup' | 'on_call' | 'reserved' | 'break' = 'available', st = stations): Promise<string> {
  const session = await insertAgentSession(campaignId);
  st.add({ sessionId: session.id as string, campaignId, tenantId: T, accountId: A, agentUserId: session.agent_user_id as string });
  await agents.set(session.id as string, state, { leaseMs: 60_000 });
  return session.id as string;
}

/** An admitted call the router hands to `c` (its media leg faked in the bridge). */
async function caller(c: Connector, over: Partial<Parameters<typeof calls.insertArrival>[0]> = {}): Promise<{ call: CallRecord; done: Promise<void> }> {
  const { call } = await calls.insertArrival({
    tenantId: T, accountId: A, routeId: route.id, phoneNumberId: null, provider: 'plivo', telephonyCredentialId: credentialId,
    providerCallId: `CA-${randomUUID()}`, fromE164: `+4477009${String(Math.floor(Math.random() * 90_000) + 10_000)}`, toE164: '+14155550100',
    identification: { match: null, callerDnc: false, sticky: null }, answered: true, recordingRequested: false, analysisProfileId: null,
    ...over,
  });
  await calls.transition(call!.id, 'greeting');
  bridge.take(call!.id);
  const done = c.take({ call: (await calls.findByIdAnyTenant(call!.id))!, route, stickyCandidates: [], recordingNotice: false });
  return { call: call!, done };
}

const row = async (id: string) => (await calls.findByIdAnyTenant(id))!;
const until = async <V>(what: string, probe: () => Promise<V | null | false> | V | null | false, ms = 5000): Promise<V> => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await probe();
    if (v) return v as V;
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await sleep(10);
  }
};
const drain = async () => { for (const c of connectors) await c.drain(); };
const inboundFrames = (sessionId: string) => (stations.get(sessionId)?.ws.sent ?? []).filter((f) => f['event'] === 'inbound_call').map((f) => f['call'] as Record<string, unknown>);

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

describe('the inbound connector`s races (real Redis and Postgres)', () => {
  it('two callers, one agent: exactly one offer, connected; the other keeps waiting and takes the agent once they are free', async () => {
    const c = connector();
    const s1 = await agent();
    const [x, y] = await Promise.all([caller(c), caller(c)]);
    const first = await until('one connected', async () => {
      const rows = await Promise.all([row(x.call.id), row(y.call.id)]);
      return rows.find((r) => r.state === 'connected') ?? null;
    });
    const other = first.id === x.call.id ? y : x;
    await drain();
    expect(first.session_id).toBe(s1);
    expect((await row(other.call.id)).state).toBe('queued');
    expect(await agents.get(s1)).toMatchObject({ state: 'on_call', inboundCallId: first.id });
    // The first caller hangs up: the agent owes its outcome; once saved and released, the hook offers the second.
    bridge.end(first.id, 'pstn_stream_closed', 12);
    await until('first ended', async () => (await row(first.id)).state === 'ended');
    await drain();
    expect(await agents.get(s1)).toMatchObject({ state: 'wrapup', inboundCallId: first.id });
    expect((await row(other.call.id)).state).toBe('queued');
    await calls.saveDisposition({ id: first.id, code: 'voicemail', source: 'route', notes: null, callbackAt: null, actorUserId: randomUUID(), onBehalf: false });
    await agents.releaseInbound(s1, first.id);
    expect(await c.takeOnRelease(s1)).toBe(true); // from `wrapup`: no `available` instant
    await until('second connected', async () => (await row(other.call.id)).state === 'connected');
    expect((await row(other.call.id)).session_id).toBe(s1);
  });

  it('pacing and inbound race for one agent: exactly one CAS wins, and an agent an inbound caller holds is never reserved by an attempt', async () => {
    for (let round = 0; round < 10; round++) {
      await flushTestRedis();
      bridge = new FakeBridge();
      for (const c of connectors) c.stop();
      connectors = [];
      stations = new FakeStations();
      const c = connector();
      const s1 = await agent();
      const attemptId = randomUUID();
      const [{ call }] = await Promise.all([caller(c), agents.reserve(s1, attemptId)]);
      await sleep(30);
      await drain();
      const live = (await agents.get(s1))!;
      const spine = await row(call.id);
      if (live.attemptId === attemptId) {
        expect(live).toMatchObject({ state: 'reserved', inboundCallId: null });
        expect(spine.state).toBe('queued');
      } else {
        expect(live.inboundCallId).toBe(call.id);
        expect(['offered', 'connected']).toContain(spine.state);
        // Pacing's CAS on an agent the caller holds is refused (−3 on the move to `reserved`).
        await agents.set(s1, 'available', { leaseMs: 1000 }).catch(() => undefined);
        expect(await agents.reserve(s1, randomUUID())).toBe('lost');
      }
      bridge.end(call.id);
      await drain();
    }
  });

  it('two connectors (a deploy`s overlap) and one agent: one reservation, one offer', async () => {
    const shared = stations;
    const c1 = connector({ stationsOf: shared });
    const c2 = connector({ stationsOf: shared });
    const s1 = await agent();
    const [x, y] = await Promise.all([caller(c1), caller(c2)]);
    await until('one offered or connected', async () => {
      const rows = await Promise.all([row(x.call.id), row(y.call.id)]);
      return rows.some((r) => r.session_id === s1) ? rows : null;
    });
    await sleep(400);
    await drain();
    const rows = await Promise.all([row(x.call.id), row(y.call.id)]);
    expect(rows.filter((r) => r.session_id === s1)).toHaveLength(1);
    expect(rows.filter((r) => r.state === 'queued')).toHaveLength(1);
  });

  it('the caller hangs up while offered: the bind never lands, abandoned_in_queue (settled, Missed row), the agent released', async () => {
    const c = connector();
    const s1 = await agent();
    const { call } = await caller(c);
    await until('offered', async () => (await row(call.id)).state === 'offered');
    bridge.end(call.id); // before connects_at (150 ms)
    await sleep(300);
    await drain();
    expect(bridge.binds).toEqual([]);
    expect(await row(call.id)).toMatchObject({ state: 'ended', outcome: 'abandoned_in_queue', follow_up_status: 'open', bridged_at: null, settled_at: expect.any(Date) });
    expect(await agents.get(s1)).toMatchObject({ state: 'available', inboundCallId: null });
    expect(inboundFrames(s1).map((f) => f['state'])).toEqual(['offered', 'ended']);
  });

  it('the bind and the caller`s end in one tick are serialised: never a connected row on an ended call', async () => {
    for (let i = 0; i < 8; i++) {
      for (const old of connectors) old.stop();
      connectors = [];
      stations = new FakeStations(); // a fresh floor each round: one agent
      const c = connector();
      const s1 = await agent();
      const { call } = await caller(c);
      await until('offered', async () => (await row(call.id)).state === 'offered');
      await sleep(140 + i * 3); // around connects_at
      bridge.end(call.id);
      await sleep(200);
      await drain();
      const r = await row(call.id);
      expect(r.state).toBe('ended');
      if (r.bridged_at) expect(r.outcome).toBe('answered');
      else expect(r).toMatchObject({ outcome: 'abandoned_in_queue', settled_at: expect.any(Date) });
      const live = await agents.get(s1);
      expect(live?.inboundCallId ?? null).toBe(r.bridged_at ? call.id : null);
    }
  });

  it('the station lost before the bind: back at the head of the queue (session cleared, queued_at kept), the next agent offered', async () => {
    const c = connector();
    const s1 = await agent();
    await sleep(20);
    const s2 = await agent();
    const { call } = await caller(c);
    const offered = await until('offered to the longest idle', async () => { const r = await row(call.id); return r.state === 'offered' ? r : null; });
    expect(offered.session_id).toBe(s1);
    stations.get(s1)!.ws.readyState = 3;
    c.onStationClosed(s1);
    await until('connected to the next agent', async () => (await row(call.id)).state === 'connected');
    const r = await row(call.id);
    expect(r).toMatchObject({ session_id: s2, offer_count: 2 });
    expect(r.queued_at!.getTime()).toBe(offered.queued_at!.getTime());
    expect((await agents.get(s1))?.inboundCallId ?? null).toBeNull();
  });

  it('the socket found closed at the bind (a close the handler has not seen): the same requeue', async () => {
    const c = connector();
    const s1 = await agent();
    const { call } = await caller(c);
    await until('offered', async () => (await row(call.id)).state === 'offered');
    stations.get(s1)!.ws.readyState = 3;
    await until('requeued', async () => { const r = await row(call.id); return r.state === 'queued' && r.session_id === null; });
    expect(bridge.binds).toEqual([]);
  });

  it('the lease lost on offer: the offer cancelled, the caller back in the queue (and not re-offered to the lost agent)', async () => {
    const c = connector({ connectDelayMs: 20_000 }); // the renewal (every 5 s) acts before the bind
    const s1 = await agent();
    const { call } = await caller(c);
    await until('offered', async () => (await row(call.id)).state === 'offered');
    await agents.clear(s1); // the lease lapsed (a Redis eviction, a stalled renewer)
    await until('requeued', async () => { const r = await row(call.id); return r.state === 'queued' && r.session_id === null; }, 8000);
    await drain();
    expect(bridge.binds).toEqual([]);
    expect((await row(call.id)).state).toBe('queued');
  });

  it('the search never takes an agent in a campaign wrap-up or on a call (WR5): only the release hook does, when that work ends', async () => {
    const c = connector();
    const inWrapup = await agent('wrapup');
    const onCall = await agent('on_call');
    const { call } = await caller(c);
    await until('queued', async () => (await row(call.id)).state === 'queued');
    c.onAgentAvailable(inWrapup); // a stray wake: nothing to take
    await sleep(300);
    await drain();
    expect((await row(call.id)).state).toBe('queued');
    expect(await agents.get(inWrapup)).toMatchObject({ state: 'wrapup', inboundCallId: null });
    expect(await agents.get(onCall)).toMatchObject({ state: 'on_call', inboundCallId: null });

    // A stale view (the agent went into wrap-up between the read and the reservation): the CAS
    // itself refuses, since the search reserves from `available` only.
    const stale = Object.create(agents) as typeof agents;
    stale.getMany = async (ids) => (await agents.getMany(ids)).map((l) => (l ? { ...l, state: 'available' as const } : l));
    const exits = router();
    const blind = new InboundConnector({
      bridge: bridge as never, stations: stations as never, agents: stale,
      releaseAgent: async () => undefined, exits, connectDelayMs: 150, publish: () => {},
    });
    blind.start();
    connectors.push(blind);
    const second = await caller(blind);
    await until('queued', async () => (await row(second.call.id)).state === 'queued');
    await sleep(300);
    await drain();
    expect((await row(second.call.id)).state).toBe('queued');
    expect(await agents.get(inWrapup)).toMatchObject({ state: 'wrapup', inboundCallId: null });
    expect(await agents.get(onCall)).toMatchObject({ state: 'on_call', inboundCallId: null });
  });

  it('the release hook: a waiting caller takes an agent from wrap-up; a queued break wins over the caller', async () => {
    const c = connector();
    const breaks = new BreakRegistry();
    const dialer = new AgencyDialer(bridge as never, stations as never, agents, {} as never, breaks);
    dialer.registerInboundTake((id) => c.takeOnRelease(id));
    const s1 = await agent('break');
    const { call } = await caller(c);
    await until('queued', async () => (await row(call.id)).state === 'queued');
    // A queued break: the release applies it and the caller keeps waiting.
    await agents.set(s1, 'wrapup', { leaseMs: 60_000 });
    breaks.queue(s1, { code: 'lunch', label: 'Lunch' });
    expect(await dialer.releaseAgent(s1)).toMatchObject({ state: 'break', result: 'ok' });
    await drain();
    expect((await row(call.id)).state).toBe('queued');
    // No break: the release hands them the caller, straight from wrap-up.
    await agents.set(s1, 'wrapup', { leaseMs: 60_000 });
    expect(await dialer.releaseAgent(s1)).toEqual({ state: 'reserved', result: 'ok' });
    await until('connected', async () => (await row(call.id)).state === 'connected');
    expect(stations.get(s1)!.ws.sent.filter((f) => f['event'] === 'agent_state').map((f) => f['state'])).toEqual(['break', 'reserved', 'on_call']);
  });

  it('the outcome lapse: an answered call owed past 30 minutes is closed no_disposition, its field cleared, its agent returned and told', async () => {
    const c = connector();
    const s1 = await agent();
    const { call } = await caller(c);
    await until('connected', async () => (await row(call.id)).state === 'connected');
    bridge.end(call.id, 'pstn_stream_closed', 30);
    await until('owed', async () => (await agents.get(s1))?.state === 'wrapup');
    const service = new InboundCallService({
      bridge: bridge as never, agents, stations: stations as never,
      releaseAgent: async (id) => { if (!(await c.takeOnRelease(id))) await agents.set(id, 'available', { leaseMs: 60_000 }); },
      connector: () => c,
    });
    expect(await service.sweepLapsed()).toBe(0); // not yet
    await pool().query(`UPDATE agency_inbound_calls SET ended_at = now() - interval '31 minutes' WHERE id = $1`, [call.id]);
    expect(await service.sweepLapsed()).toBe(1);
    expect(await row(call.id)).toMatchObject({ disposition_code: 'no_disposition', settled_at: expect.any(Date) });
    expect(await agents.get(s1)).toMatchObject({ state: 'available', inboundCallId: null });
    expect(inboundFrames(s1).at(-1)).toMatchObject({ id: call.id, disposition_code: 'no_disposition', outcome_due_at: null });
    expect(await service.sweepLapsed()).toBe(0);
  });

  it('a graceful shutdown (Q18): the stopped connector takes no new work; callers nobody took end failed with their Missed row; the agent on offer is released', async () => {
    const c = connector();
    const s1 = await agent();
    const offered = await caller(c);
    await until('offered', async () => (await row(offered.call.id)).state === 'offered');
    const waiting = await caller(c);
    await until('queued', async () => (await row(waiting.call.id)).state === 'queued');
    c.stop();
    expect(await c.takeOnRelease(s1)).toBe(false);
    await sleep(300); // the offer's bind timer is gone with the stop
    expect(bridge.binds).toEqual([]);
    bridge.end(offered.call.id, 'service_shutdown');
    bridge.end(waiting.call.id, 'service_shutdown');
    await until('both ended', async () => (await row(offered.call.id)).state === 'ended' && (await row(waiting.call.id)).state === 'ended');
    await drain();
    for (const id of [offered.call.id, waiting.call.id]) {
      expect(await row(id)).toMatchObject({ outcome: 'failed', follow_up_reason: 'failed', follow_up_status: 'open', settled_at: expect.any(Date) });
    }
    expect((await agents.get(s1))?.inboundCallId ?? null).toBeNull();
    expect(bridge.listeners.size).toBe(0); // no call held: the stopped connector unsubscribed
  });
});
