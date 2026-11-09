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
const { AgentStateMachine } = await import('../../../src/agency/agent-state-machine.js');
const { InboundConnector } = await import('../../../src/agency/inbound/inbound-connector.js');
const { AgencyInboundCallRouter } = await import('../../../src/agency/inbound/inbound-call-router.js');
const { AgencyDialer } = await import('../../../src/agency/agency-dialer.js');
const { BreakRegistry } = await import('@magick-agency/domain/break-manager');
const { parseInboundRouteCreate } = await import('../../../src/agency/inbound/route-config.js');
const { InboundCallService } = await import('../../../src/agency/inbound/inbound-disposition.js');
const { INBOUND_DEFAULT_WRAPUP } = await import('../../../src/agency/inbound/inbound-wrapup.js');
type Connector = InstanceType<typeof InboundConnector>;
type CallRecord = import('../../../src/db/repositories/agency.repository.js').AgencyInboundCallRecord;
type RouteRecord = import('../../../src/db/repositories/agency.repository.js').AgencyInboundRouteRecord;
type Lifecycle = import('../../../src/core/webrtc-bridge-manager.js').WebRtcLifecycleEvent;

/**
 * Settling an answered inbound call and returning its agent, on real Redis (the agent hash) and
 * real Postgres (the spine), the bridge and the station sockets faked in process
 * (docs/inbound.md §6):
 *
 *  - SWE-M1: a settle (the outcome lapse, the outcome saved) returns the agent to the pool only
 *    from the wrap-up the call holds them in. An agent a restart landed on `break` with the call
 *    re-claimed, who then chose a break, keeps it; one written `offline` stays out. The connector's
 *    `session_busy` give-back (a session the spine says holds another call) puts the agent on
 *    `break`, never `available`, also when the spine cannot be read, and the lapse that settles
 *    the other call later does not lift that break.
 *  - The inbound wrap-up's auto-return (PM): the outcome lapses at the matched campaign's
 *    `wrapup_seconds` when it auto-returns, else at the account default (a new campaign's 30 s),
 *    never past the 30-minute backstop; the agent in that wrap-up is returned.
 *  - A supervisor's force-available on an agent who owes an inbound outcome
 *    (`closeOwedForSupervisor`): the call closed as the lapse closes it, the claim cleared, the
 *    panel told; a call still connected is not forced; an outcome saved first wins.
 *
 * Mutation-checked: `returnAgent` without `returnsToPool` returns the on-break and offline agents
 * to `available` (red); `giveBack` falling through to `releaseAgent` on a failed read leaves the
 * agent `available` (red); the lapse SQL without the campaign window lapses only at 30 minutes
 * (red); `closeOwedForSupervisor` not clearing the claim leaves the force-available refused by
 * the Lua guard (red).
 */

const T = DEFAULTS.tenantId;
const A = DEFAULTS.accountId;
const pool = () => getTestPool();
const PREFIX = 'ibreturn:';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ─── Fakes: the bridge and the station sockets (as the races suite's) ───────

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
  add(e: Omit<StationEntry, 'ws' | 'clientKind'>): StationEntry {
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
  onLifecycle(l: (ev: Lifecycle) => void) { this.listeners.add(l); return () => { this.listeners.delete(l); }; }
  take(id: string) { this.live.set(id, { bound: false }); }
  playInboundHold(id: string, opts: { onPreambleDone?: () => void }) {
    const c = this.live.get(id);
    if (!c) return Promise.resolve('not_found' as const);
    return new Promise<'released' | 'aborted'>((resolve) => {
      c.hold = resolve;
      setImmediate(() => { if (this.live.has(id)) opts.onPreambleDone?.(); });
    });
  }
  stopInboundHold(id: string) { this.live.get(id)?.hold?.('released'); }
  bindBorrowedBrowserLeg(id: string, ws: FakeWs) {
    const c = this.live.get(id);
    if (!c || c.bound || ws.readyState !== 1) return false;
    c.bound = true;
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
let connector: Connector;
let dialer: InstanceType<typeof AgencyDialer>;
let breaks: InstanceType<typeof BreakRegistry>;
let service: InstanceType<typeof InboundCallService>;

/** A live campaign session with a station on this "process", in `state` in Redis. */
async function agent(state: 'available' | 'wrapup' | 'break' | 'offline' = 'available'): Promise<string> {
  const session = await insertAgentSession(campaignId);
  stations.add({ sessionId: session.id as string, campaignId, tenantId: T, accountId: A, agentUserId: session.agent_user_id as string });
  await agents.set(session.id as string, state, { leaseMs: 60_000 });
  return session.id as string;
}

/** A call answered by `sessionId` that ended `endedAgoSeconds` ago and owes its outcome; matched to `matchedCampaignId` if given. */
async function owed(sessionId: string, endedAgoSeconds: number, matchedCampaignId: string | null = null): Promise<CallRecord> {
  const { call } = await calls.insertArrival({
    tenantId: T, accountId: A, routeId: route.id, phoneNumberId: null, provider: 'plivo', telephonyCredentialId: credentialId,
    providerCallId: `CA-${randomUUID()}`, fromE164: '+447700900555', toE164: '+14155550100',
    identification: { match: matchedCampaignId ? { contactId: randomUUID(), campaignId: matchedCampaignId } : null, callerDnc: false, sticky: null },
    answered: true, recordingRequested: false, analysisProfileId: null,
  });
  await calls.transition(call!.id, 'queued');
  expect((await calls.offer(call!.id, sessionId)).ok).toBe(true);
  expect(await calls.connect(call!.id, { sessionId, answeredByUserId: randomUUID() })).not.toBeNull();
  expect((await calls.end(call!.id, { outcome: 'answered', talkSeconds: 30, followUp: null, callbackDueAt: null, voicemailKey: null })).ended).toBe(true);
  await pool().query(`UPDATE agency_inbound_calls SET ended_at = now() - make_interval(secs => $2) WHERE id = $1`, [call!.id, endedAgoSeconds]);
  return (await calls.findByIdAnyTenant(call!.id))!;
}

/** A caller the connector holds, queued (its media leg faked). */
async function caller(): Promise<CallRecord> {
  const { call } = await calls.insertArrival({
    tenantId: T, accountId: A, routeId: route.id, phoneNumberId: null, provider: 'plivo', telephonyCredentialId: credentialId,
    providerCallId: `CA-${randomUUID()}`, fromE164: `+4477009${String(Math.floor(Math.random() * 90_000) + 10_000)}`, toE164: '+14155550100',
    identification: { match: null, callerDnc: false, sticky: null }, answered: true, recordingRequested: false, analysisProfileId: null,
  });
  await calls.transition(call!.id, 'greeting');
  bridge.take(call!.id);
  void connector.take({ call: (await calls.findByIdAnyTenant(call!.id))!, route, stickyCandidates: [], recordingNotice: false });
  return call!;
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
const frames = (sessionId: string, event: string) => (stations.get(sessionId)?.ws.sent ?? []).filter((f) => f['event'] === event);
const stateFrames = (sessionId: string) => frames(sessionId, 'agent_state').map((f) => f['state']);
const lastInboundFrame = (sessionId: string) => frames(sessionId, 'inbound_call').at(-1)?.['call'] as Record<string, unknown> | undefined;

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
  breaks = new BreakRegistry();
  const exits = new AgencyInboundCallRouter({
    bridge: bridge as never,
    dnc: { check: async () => 'clear', checkEntry: async () => ({ result: 'clear' }) } as never,
  });
  dialer = new AgencyDialer(bridge as never, stations as never, agents, {} as never, breaks);
  connector = new InboundConnector({
    bridge: bridge as never, stations: stations as never, agents,
    releaseAgent: (id) => dialer.releaseAgent(id), exits, connectDelayMs: 100, publish: () => {},
  });
  connector.start();
  dialer.registerInboundTake((id) => connector.takeOnRelease(id));
  service = new InboundCallService({
    bridge: bridge as never, agents, stations: stations as never,
    releaseAgent: (id) => dialer.releaseAgent(id), connector: () => connector,
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const [id] of bridge.live) bridge.end(id);
  await connector.drain();
  connector.stop();
});

afterAll(async () => {
  await truncateAll();
  await closeTestPool();
  await closeTestRedis();
});

describe('a settle never moves an agent off a break, or out of offline, into the pool (SWE-M1)', () => {
  it('rehydrated on break owing the outcome, then a break chosen; the lapse closes the call: still on break, the claim cleared, the panel told', async () => {
    const s = await agent();
    const call = await owed(s, 31 * 60);
    // The restart: the lease lapsed, the reconnect lands the agent on `break` with the call re-claimed.
    await agents.clear(s);
    expect(await agents.rehydrateInbound(s, call.id)).toMatchObject({ state: 'break' });
    // The agent presses a break ("Lunch") from `break`: applied at once, nothing queued.
    await agents.set(s, 'break', { leaseMs: 60_000 });

    expect(await service.sweepLapsed()).toBe(1);
    expect(await row(call.id)).toMatchObject({ disposition_code: 'no_disposition', settled_at: expect.any(Date) });
    expect(await agents.get(s)).toMatchObject({ state: 'break', inboundCallId: null });
    expect(stateFrames(s)).not.toContain('available');
    expect(lastInboundFrame(s)).toMatchObject({ id: call.id, disposition_code: 'no_disposition', outcome_due_at: null });
  });

  it('the outcome saved from that break: settled, the claim cleared, still on break; their own Go available then works', async () => {
    const s = await agent();
    const call = await owed(s, 60);
    await agents.clear(s);
    await agents.rehydrateInbound(s, call.id);
    const res = await service.submitDisposition({ tenantId: T, accountId: A, userId: randomUUID(), supervise: true }, call.id, { code: 'voicemail' });
    expect(res.ok).toBe(true);
    expect(await agents.get(s)).toMatchObject({ state: 'break', inboundCallId: null });
    expect(stateFrames(s)).not.toContain('available');
    // Nothing guards `available` any more: the agent's own move succeeds.
    expect(await agents.set(s, 'available', { leaseMs: 60_000 })).toBe('ok');
  });

  it('written offline (the station`s close) while the station is still known here: the lapse leaves them offline', async () => {
    const s = await agent();
    const call = await owed(s, 31 * 60);
    await agents.set(s, 'offline', { leaseMs: 60_000 });
    expect(await service.sweepLapsed()).toBe(1);
    expect(await agents.get(s)).toMatchObject({ state: 'offline' });
    expect(stateFrames(s)).not.toContain('available');
    expect((await row(call.id)).settled_at).not.toBeNull();
  });

  it('still in the call`s wrap-up: the lapse returns them (the control)', async () => {
    const s = await agent();
    const call = await owed(s, 31 * 60);
    await agents.set(s, 'wrapup', { leaseMs: 60_000 });
    await agents.rehydrateInbound(s, call.id); // a live state is kept; the field (re)claimed
    expect(await agents.get(s)).toMatchObject({ state: 'wrapup', inboundCallId: call.id });
    expect(await service.sweepLapsed()).toBe(1);
    expect(await agents.get(s)).toMatchObject({ state: 'available', inboundCallId: null });
    expect(stateFrames(s).at(-1)).toBe('available');
  });

  it('the connector`s session_busy give-back: the agent goes on break with the owed call re-claimed, never available; the later lapse leaves the break', async () => {
    const s = await agent();
    const first = await owed(s, 60);
    // The Redis claim was lost: the agent looks `available` with nothing held.
    expect(await agents.get(s)).toMatchObject({ state: 'available', inboundCallId: null });
    const next = await caller();
    await until('the session_busy give-back', async () => (await agents.get(s))?.state === 'break');
    await connector.drain();
    expect(await agents.get(s)).toMatchObject({ state: 'break', inboundCallId: first.id });
    expect((await row(next.id)).state).toBe('queued');
    expect(stateFrames(s)).not.toContain('available');

    await pool().query(`UPDATE agency_inbound_calls SET ended_at = now() - interval '31 minutes' WHERE id = $1`, [first.id]);
    expect(await service.sweepLapsed()).toBe(1);
    await connector.drain();
    expect(await agents.get(s)).toMatchObject({ state: 'break', inboundCallId: null });
    expect(stateFrames(s)).not.toContain('available');
    expect((await row(next.id)).state).toBe('queued');
  });

  it('the give-back when the spine cannot be read: on break (fails closed), never available', async () => {
    const s = await agent();
    await owed(s, 60);
    // Every read fails while this runs (a retry through the release hook would only meet it again).
    const read = vi.spyOn(calls, 'findUnsettledForSession').mockRejectedValue(new Error('pool exhausted'));
    const next = await caller();
    await until('the give-back', async () => (await agents.get(s))?.state === 'break');
    await connector.drain();
    expect(read).toHaveBeenCalled();
    expect(await agents.get(s)).toMatchObject({ state: 'break' });
    expect(stateFrames(s)).not.toContain('available');
    expect((await row(next.id)).state).toBe('queued');
  });
});

describe('the inbound wrap-up auto-returns as the outbound one (PM): the matched campaign`s window, else the account default, never past 30 minutes', () => {
  it('the account default is the campaign column defaults (30 s, auto-return on)', async () => {
    const { rows } = await pool().query<{ column_name: string; column_default: string }>(
      `SELECT column_name, column_default FROM information_schema.columns
        WHERE table_name = 'agency_campaigns' AND column_name IN ('wrapup_seconds', 'wrapup_auto_return')`);
    const defaults = Object.fromEntries(rows.map((r) => [r.column_name, r.column_default]));
    expect(Number(defaults['wrapup_seconds'])).toBe(INBOUND_DEFAULT_WRAPUP.wrapupSeconds);
    expect(defaults['wrapup_auto_return']).toBe(String(INBOUND_DEFAULT_WRAPUP.autoReturn));
  });

  it('the lapse picks each call at its own window', async () => {
    const auto45 = (await insertAgencyCampaign({ wrapup_seconds: 45, wrapup_auto_return: true })).id as string;
    const manual = (await insertAgencyCampaign({ wrapup_seconds: 45, wrapup_auto_return: false })).id as string;
    const noTimer = (await insertAgencyCampaign({ wrapup_seconds: 0, wrapup_auto_return: true })).id as string;
    const long = (await insertAgencyCampaign({ wrapup_seconds: 7200, wrapup_auto_return: true })).id as string;
    const session = async () => (await insertAgentSession(campaignId)).id as string;
    const cases = {
      auto45Before: await owed(await session(), 40, auto45),
      auto45After: await owed(await session(), 50, auto45),
      manualAfterWindow: await owed(await session(), 600, manual),
      manualPastBackstop: await owed(await session(), 31 * 60, manual),
      noTimer: await owed(await session(), 600, noTimer),
      longBeforeBackstop: await owed(await session(), 29 * 60, long),
      longPastBackstop: await owed(await session(), 31 * 60, long),
      unmatchedBefore: await owed(await session(), 20),
      unmatchedAfter: await owed(await session(), 35),
      goneCampaignAfter: await owed(await session(), 35, randomUUID()),
    };
    const lapsed = new Set((await calls.lapseUnsettled()).map((r) => r.id));
    const picked = Object.fromEntries(Object.entries(cases).map(([k, c]) => [k, lapsed.has(c.id)]));
    expect(picked).toEqual({
      auto45Before: false, auto45After: true,
      manualAfterWindow: false, manualPastBackstop: true,
      noTimer: false,
      longBeforeBackstop: false, longPastBackstop: true,
      unmatchedBefore: false, unmatchedAfter: true,
      goneCampaignAfter: true,
    });
  });

  it('the panel`s outcome_due_at is the same window the sweep uses', async () => {
    const auto45 = (await insertAgencyCampaign({ wrapup_seconds: 45, wrapup_auto_return: true })).id as string;
    const s = await agent();
    const call = await owed(s, 0, auto45);
    const wire = (await service.get({ tenantId: T, accountId: A, userId: randomUUID(), supervise: true }, call.id));
    expect(wire.ok).toBe(true);
    if (!wire.ok) return;
    expect(new Date(wire.call.outcome_due_at!).getTime() - new Date(wire.call.ended_at!).getTime()).toBe(45_000);
  });

  it('an agent in an unmatched call`s wrap-up past the default window: the call closed, the agent returned', async () => {
    const s = await agent();
    const call = await owed(s, INBOUND_DEFAULT_WRAPUP.wrapupSeconds + 2);
    await agents.set(s, 'wrapup', { leaseMs: 60_000 });
    await agents.rehydrateInbound(s, call.id);
    expect(await service.sweepLapsed()).toBe(1);
    expect(await row(call.id)).toMatchObject({ disposition_code: 'no_disposition' });
    expect(await agents.get(s)).toMatchObject({ state: 'available', inboundCallId: null });
  });
});

describe('a supervisor`s force-available on an agent who owes an inbound outcome (closeOwedForSupervisor)', () => {
  it('closes the call as the lapse would, clears the claim and tells the panel; the release then returns the agent', async () => {
    const s = await agent();
    const call = await owed(s, 5);
    await agents.set(s, 'wrapup', { leaseMs: 60_000 });
    await agents.rehydrateInbound(s, call.id);
    // Before: the Lua guard refuses `available` while the claim stands.
    expect(await agents.set(s, 'available', { leaseMs: 60_000 })).toBe('inbound_call_owed');

    const closed = await service.closeOwedForSupervisor(s);
    expect(closed).toMatchObject({ kind: 'closed', call: { id: call.id, disposition_code: 'no_disposition', dispositioned_by_user_id: null } });
    expect(await agents.get(s)).toMatchObject({ state: 'wrapup', inboundCallId: null });
    expect(lastInboundFrame(s)).toMatchObject({ id: call.id, disposition_code: 'no_disposition', settled_at: expect.any(String) });
    expect(await dialer.releaseAgent(s)).toMatchObject({ state: 'available', result: 'ok' });
    // An outcome after the close is the lapse's answer.
    const late = await service.submitDisposition({ tenantId: T, accountId: A, userId: randomUUID(), supervise: true }, call.id, { code: 'voicemail' });
    expect(late).toMatchObject({ ok: false, refusal: { code: 'inbound_outcome_already_saved' } });
  });

  it('a call still connected is not forced; nothing owed is `none`; an outcome saved first wins', async () => {
    const s = await agent();
    const { call: live } = await calls.insertArrival({
      tenantId: T, accountId: A, routeId: route.id, phoneNumberId: null, provider: 'plivo', telephonyCredentialId: credentialId,
      providerCallId: `CA-${randomUUID()}`, fromE164: '+447700900556', toE164: '+14155550100',
      identification: { match: null, callerDnc: false, sticky: null }, answered: true, recordingRequested: false, analysisProfileId: null,
    });
    await calls.transition(live!.id, 'queued');
    await calls.offer(live!.id, s);
    await calls.connect(live!.id, { sessionId: s, answeredByUserId: randomUUID() });
    expect(await service.closeOwedForSupervisor(s)).toEqual({ kind: 'live', inboundCallId: live!.id });
    expect((await row(live!.id)).settled_at).toBeNull();

    const other = await agent();
    expect(await service.closeOwedForSupervisor(other)).toEqual({ kind: 'none' });

    const third = await agent();
    const call = await owed(third, 5);
    const saved = await service.submitDisposition({ tenantId: T, accountId: A, userId: randomUUID(), supervise: true }, call.id, { code: 'voicemail' });
    expect(saved.ok).toBe(true);
    expect(await service.closeOwedForSupervisor(third)).toEqual({ kind: 'none' });
    expect((await row(call.id)).disposition_code).toBe('voicemail');
  });
});
