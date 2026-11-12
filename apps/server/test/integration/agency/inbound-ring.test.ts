import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AGENCY_INBOUND_RING_MAX_MISSES } from '@magick-agency/contracts/agency';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { DEFAULTS, insertTenant } from '../setup/factories.js';
import { insertAgencyCampaign, insertAgentSession } from './agency-factories.js';
import { closeTestRedis, flushTestRedis, getTestRedis } from '../../helpers/test-redis.js';
import { FakeBridge, FakeStations, gate, sleep, until, type FakeStationEntry } from './inbound-connector-fakes.js';

const audit = vi.hoisted(() => ({ log: vi.fn() }));

vi.mock('@magick-agency/db', async (orig) => ({
  ...(await orig<typeof import('@magick-agency/db')>()),
  getPool: () => getTestPool(),
}));
vi.mock('../../../src/audit/platform/audit-logger.js', () => ({ platformAuditLogger: audit }));

const {
  agencyInboundCallRepository: calls, agencyInboundRouteRepository: routes, agencyAgentSessionRepository: sessions,
  agencyPushDeviceRepository: devices,
} = await import('../../../src/db/repositories/agency.repository.js');
const { AgentStateMachine, AGENT_LEASE_MS } = await import('../../../src/agency/agent-state-machine.js');
const { InboundConnector } = await import('../../../src/agency/inbound/inbound-connector.js');
const { AgencyInboundCallRouter } = await import('../../../src/agency/inbound/inbound-call-router.js');
const { AwayRingService } = await import('../../../src/agency/away-ring.js');
const { parseInboundRouteCreate } = await import('../../../src/agency/inbound/route-config.js');
const { setPushSender, resetPushSender } = await import('../../../src/seams/push-sender.js');
type Connector = InstanceType<typeof InboundConnector>;
type CallRecord = import('../../../src/db/repositories/agency.repository.js').AgencyInboundCallRecord;
type RouteRecord = import('../../../src/db/repositories/agency.repository.js').AgencyInboundRouteRecord;

/**
 * Mode B's ring in the inbound connector (IQ58–IQ74, N1–N5; docs/inbound.md "Ringing an away
 * phone") on real Redis (the agent hash's compare-and-swaps and the away-ring Lua) and real Postgres
 * (the spine's guarded writes, the session mirror, the push devices), with the bridge, the station
 * sockets and the push sender faked in process, and the runtime's real `AwayRingService`:
 *
 *  1. the ring and its answer: ring → answering → accept → attach → bind; the attach before the
 *     accept (N5, an implicit answer); a repeated accept (idempotent; another device or a bound
 *     call `already_accepted`); a socket dropped in the grace, then a re-attach;
 *  2. its ends: decline (not a miss, N4, and after accept the hang-up), expiry and a lapsed grace
 *     (misses; two in a row end `away_ring`), the caller leaving, a failed push, an unregistered
 *     token (the device revoked, the absence ended);
 *  3. who is rung: the maximum wait against the ring window (IQ69), strict sticky rung first, a
 *     station agent preferred, two callers and one phone, the flag off, a declined agent no longer
 *     one who could take the caller (IQ68);
 *  4. IQ73 (N3): a station agent who frees up mid-ring takes the caller; `answering` first keeps
 *     the ring (both orderings on the call's chain);
 *  5. the away break around a ring (N1): a crash mid-ring then boot, a reconcile tick during a
 *     ring, a take-over during a ring, "Stop ringing" during a ring.
 */

const T = DEFAULTS.tenantId;
const A = DEFAULTS.accountId;
const pool = () => getTestPool();
const PREFIX = 'ibring:';
const MAX_AGE = 4 * 60 * 60 * 1000;

// ─── The world ──────────────────────────────────────────────────────────────

let credentialId: string;
let route: RouteRecord;
let campaignId: string;
let agents: InstanceType<typeof AgentStateMachine>;
let stations: FakeStations;
let bridge: FakeBridge;
let connectors: Connector[] = [];
let flagsOn = true;

interface SentPush { deviceRowId: string; payload: Record<string, unknown> }
const sender = {
  sent: [] as SentPush[],
  /** The next answers, in order; then `{ ok: true }`. */
  answers: [] as Array<{ ok: true } | { ok: false; reason: 'unregistered' | 'unavailable' }>,
};

function awayRingFor(getConnector: () => Connector | null) {
  const svc = new AwayRingService({
    agents,
    stations: stations as never,
    inbound: getConnector as never,
    ringAllowed: async () => flagsOn,
  });
  svc.configure({ maxAgeMs: MAX_AGE });
  return svc;
}

let awayRing: InstanceType<typeof AwayRingService>;

/** A connector over the shared Redis and Postgres, ringing through the real away break. */
function connector(opts: { ringMs?: number; acceptGraceMs?: number; republishMs?: number } = {}): Connector {
  const exits = new AgencyInboundCallRouter({
    bridge: bridge as never,
    dnc: { check: async () => 'clear', checkEntry: async () => ({ result: 'clear' }) } as never,
  });
  let c!: Connector;
  awayRing = awayRingFor(() => c);
  c = new InboundConnector({
    bridge: bridge as never,
    stations: stations as never,
    agents,
    releaseAgent: async (id) => {
      if (await c.takeOnRelease(id)) return;
      if (!stations.isLocallyOwned(id)) {
        await agents.set(id, 'offline', { leaseMs: AGENT_LEASE_MS.available });
        return;
      }
      await agents.set(id, 'available', { leaseMs: AGENT_LEASE_MS.available });
    },
    exits,
    connectDelayMs: 150,
    publish: () => {},
    awayRing,
    ringMs: opts.ringMs ?? 5_000,
    acceptGraceMs: opts.acceptGraceMs ?? 5_000,
    ...(opts.republishMs ? { republishMs: opts.republishMs } : {}),
  });
  c.start();
  connectors.push(c);
  return c;
}

/** An active user with a tenant-wide membership. */
async function member(): Promise<string> {
  const id = randomUUID();
  await pool().query('INSERT INTO users (id, firebase_uid, email) VALUES ($1, $2, $3)', [id, `fb-ring-${id}`, `ring-${id}@example.test`]);
  await pool().query(`INSERT INTO memberships (user_id, tenant_id, role) VALUES ($1, $2, 'agent')`, [id, T]);
  return id;
}

let deviceSeq = 0;

/** An agent on `away_ring`: a campaign session whose phone (registered, opted in) is its station device; no station here. */
async function awayAgent(opts: { userId?: string } = {}): Promise<{ sessionId: string; userId: string; deviceId: string; deviceRowId: string }> {
  const userId = opts.userId ?? await member();
  const deviceId = `phone-ring-${String(++deviceSeq).padStart(4, '0')}`;
  const row = await insertAgentSession(campaignId, { agent_user_id: userId, station_device_id: deviceId, client_kind: 'mobile' });
  const device = await devices.register({
    tenantId: T, userId, deviceId, platform: 'android', token: `fcm-${randomUUID()}`, appBuild: '1.4.0+40', ringEnabled: true,
  });
  await agents.set(row.id as string, 'available', { leaseMs: 60_000 });
  const session = (await sessions.findById(row.id as string))!;
  expect(await awayRing.enter(session, ['available'])).toMatchObject({ ok: true });
  return { sessionId: row.id as string, userId, deviceId, deviceRowId: device.id };
}

/** An agent on a console station here, `available` (or as told). */
async function deskAgent(state: 'available' | 'on_call' | 'wrapup' = 'available', userId?: string): Promise<string> {
  const session = await insertAgentSession(campaignId, { agent_user_id: userId ?? await member() });
  stations.add({ sessionId: session.id as string, campaignId, tenantId: T, accountId: A, agentUserId: session.agent_user_id as string });
  await agents.set(session.id as string, state, { leaseMs: 60_000 });
  return session.id as string;
}

/** An admitted call the router hands to `c`. */
async function caller(c: Connector, over: Partial<Parameters<typeof calls.insertArrival>[0]> = {}, routeOf = route): Promise<{ call: CallRecord; done: Promise<void> }> {
  const { call } = await calls.insertArrival({
    tenantId: T, accountId: A, routeId: routeOf.id, phoneNumberId: null, provider: 'plivo', telephonyCredentialId: credentialId,
    providerCallId: `CA-${randomUUID()}`, fromE164: `+4477009${String(Math.floor(Math.random() * 90_000) + 10_000)}`, toE164: '+14155550100',
    identification: { match: null, callerDnc: false, sticky: null }, answered: true, recordingRequested: false, analysisProfileId: null,
    ...over,
  });
  await calls.transition(call!.id, 'greeting');
  bridge.take(call!.id);
  const done = c.take({ call: (await calls.findByIdAnyTenant(call!.id))!, route: routeOf, stickyCandidates: [], recordingNotice: false });
  return { call: call!, done };
}

/** A route of the account (sticky off unless told). */
async function makeRoute(over: Record<string, unknown> = {}): Promise<RouteRecord> {
  const parsed = parseInboundRouteCreate({ name: `R-${randomUUID().slice(0, 8)}`, timezone: 'UTC', weekly_hours: [], sticky_mode: 'off', ...over });
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues));
  const created = await routes.create({ tenantId: T, accountId: A, createdBy: null, config: parsed.config });
  if (!created.ok) throw new Error('route');
  return created.route;
}

const row = async (id: string) => (await calls.findByIdAnyTenant(id))!;
const sessionRow = async (id: string) => (await pool().query('SELECT * FROM agency_agent_sessions WHERE id = $1', [id])).rows[0];
const drain = async () => { for (const c of connectors) await c.drain(); };
const pushes = (type: string, deviceRowId?: string) => sender.sent
  .filter((p) => p.payload['type'] === type && (deviceRowId === undefined || p.deviceRowId === deviceRowId))
  .map((p) => p.payload);
/** The `ring` push sent to the device, once it has been. */
const ringPush = (deviceRowId: string, callId?: string) => until('the ring push', () =>
  pushes('ring', deviceRowId).find((p) => callId === undefined || p['call_id'] === callId) ?? null);

/** The app's station attaching as `station-socket.ts` does: the registry, the restore after `ready`, the frame, the bind. */
async function attach(c: Connector, sessionId: string, userId: string, canTakeInbound = true): Promise<FakeStationEntry> {
  const entry = stations.add({ sessionId, campaignId, tenantId: T, accountId: A, agentUserId: userId, clientKind: 'mobile', canTakeInbound });
  const restored = await c.reattachStation(sessionId, entry.ws as never);
  if (restored.call) stations.send(sessionId, { event: 'inbound_call', call: restored.call });
  c.bindAcceptedRing(sessionId);
  return entry;
}

/** The away agent is back on `away_ring` (Redis and the mirror). */
async function expectAwayRing(sessionId: string): Promise<void> {
  expect(await agents.get(sessionId)).toMatchObject({ state: 'break', ring: true, inboundCallId: null, pushOffer: false });
  expect(await sessionRow(sessionId)).toMatchObject({ state: 'break', break_reason: 'away_ring' });
  expect((await sessionRow(sessionId)).away_ring_since).not.toBeNull();
}

beforeEach(async () => {
  await truncateAll();
  await flushTestRedis();
  audit.log.mockReset();
  flagsOn = true;
  sender.sent = [];
  sender.answers = [];
  setPushSender({
    async send(device, payload) {
      sender.sent.push({ deviceRowId: device.id, payload: payload as unknown as Record<string, unknown> });
      return sender.answers.shift() ?? { ok: true };
    },
    configured: () => true,
  });
  await pool().query(`INSERT INTO telephony_providers (name, display_name) VALUES ('voicelink', 'VoiceLink'), ('plivo', 'Plivo')`);
  await insertTenant({ id: T });
  credentialId = (await pool().query<{ id: string }>(
    `INSERT INTO telephony_credentials (tenant_id, provider, label, account_ref) VALUES ($1, 'plivo', 'Main', 'MA000000000000000001') RETURNING id`,
    [T])).rows[0]!.id;
  route = await makeRoute();
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
  resetPushSender();
});

afterAll(async () => {
  await truncateAll();
  await closeTestPool();
  await closeTestRedis();
});

// ─── 1. The ring and its answer ─────────────────────────────────────────────

describe('a ring and its answer', () => {
  it('ring → answering → accept → attach → bind: the push carries ids only, the spine says push, the agent talks, misses reset', async () => {
    const c = connector();
    const away = await awayAgent();
    await pool().query('UPDATE agency_agent_sessions SET ring_misses = 1 WHERE id = $1', [away.sessionId]);
    const { call } = await caller(c);
    const ring = await ringPush(away.deviceRowId);
    // IQ61: the push carries the call, the token, the deadline and the session: nothing about the caller.
    expect(Object.keys(ring).sort()).toEqual(['call_id', 'offer_token', 'ring_expires_at', 'session_id', 'type']);
    expect(ring).toMatchObject({ type: 'ring', call_id: call.id, session_id: away.sessionId });
    const token = String(ring['offer_token']);
    expect(token).toMatch(/^[A-Za-z0-9_-]{22}$/);
    const offered = await row(call.id);
    expect(offered).toMatchObject({ state: 'offered', session_id: away.sessionId, offer_channel: 'push', ring_count: 1, accepted_at: null, ring_result: null });
    expect(offered.ringing_at).not.toBeNull();
    expect(Date.parse(String(ring['ring_expires_at'])) - offered.ringing_at!.getTime()).toBe(5_000);
    // A ring is the existing `reserved` with a push offer; no station frame anywhere, the absence kept.
    expect(await agents.get(away.sessionId)).toMatchObject({ state: 'reserved', inboundCallId: call.id, pushOffer: true, ring: false });
    expect(await sessionRow(away.sessionId)).toMatchObject({ state: 'reserved' });
    expect((await sessionRow(away.sessionId)).away_ring_since).not.toBeNull();
    expect(c.holdsPushOffer(away.sessionId)).toBe(true);
    expect(c.findCallForSession(away.sessionId)).toEqual({ callId: call.id, phase: 'offered' });
    // The station close's decision keeps the session: a push offer, no socket.
    expect(await agents.setOfflineUnlessAway(away.sessionId, c.holdsPushOffer(away.sessionId))).toBe('kept');

    const answering = await c.ringAnswering(call.id, token);
    expect(answering).toMatchObject({ ok: true, callId: call.id });
    expect(await c.ringAnswering(call.id, token)).toMatchObject({ ok: true }); // idempotent in the grace
    expect((await row(call.id)).accepted_at).not.toBeNull();

    const accepted = await c.ringAccept(call.id, token, { agentUserId: away.userId, deviceId: away.deviceId });
    expect(accepted).toMatchObject({ ok: true, sessionId: away.sessionId });
    if (!accepted.ok) throw new Error('accept');
    expect(accepted.call).toMatchObject({ id: call.id, state: 'offered', offer_channel: 'push', connects_at: null, ring_expires_at: null });
    expect(accepted.call.accepted_at).not.toBeNull();
    expect(await c.ringAnswering(call.id, token)).toEqual({ ok: false, code: 'already_accepted' });
    expect(await c.ringDecline(call.id, token, 'declined')).toEqual({ ok: false, code: 'already_accepted' });

    // The app's station attaches: the frame (push, accepted), then the bind.
    const entry = await attach(c, away.sessionId, away.userId);
    await until('connected', async () => (await row(call.id)).state === 'connected');
    const frames = entry.ws.sent.filter((f) => f['event'] === 'inbound_call').map((f) => f['call'] as Record<string, unknown>);
    expect(frames[0]).toMatchObject({ id: call.id, state: 'offered', offer_channel: 'push', connects_at: null });
    expect(frames[0]!['accepted_at']).not.toBeNull();
    expect(frames.some((f) => f['state'] === 'connected')).toBe(true);
    await drain();
    expect(await row(call.id)).toMatchObject({ state: 'connected', session_id: away.sessionId, ring_result: 'answered', answered_by_user_id: away.userId });
    expect(await agents.get(away.sessionId)).toMatchObject({ state: 'on_call', inboundCallId: call.id });
    expect(c.holdsPushOffer(away.sessionId)).toBe(false);
    expect(await sessionRow(away.sessionId)).toMatchObject({ ring_misses: 0 });
    // Past accept: a repeated accept is `already_accepted`.
    expect(await c.ringAccept(call.id, token, { agentUserId: away.userId, deviceId: away.deviceId })).toEqual({ ok: false, code: 'already_accepted' });
    expect(pushes('ring_cancel')).toEqual([]);
  });

  it('a repeated accept from the same agent and device answers the call again; another device is already_accepted, another agent ring_not_offered', async () => {
    const c = connector();
    const away = await awayAgent();
    const { call } = await caller(c);
    const token = String((await ringPush(away.deviceRowId))['offer_token']);
    const first = await c.ringAccept(call.id, token, { agentUserId: away.userId, deviceId: away.deviceId });
    const again = await c.ringAccept(call.id, token, { agentUserId: away.userId, deviceId: away.deviceId });
    expect(first).toMatchObject({ ok: true, sessionId: away.sessionId });
    expect(again).toMatchObject({ ok: true, sessionId: away.sessionId });
    expect(await c.ringAccept(call.id, token, { agentUserId: away.userId, deviceId: 'another-device-01' })).toEqual({ ok: false, code: 'already_accepted' });
    expect(await c.ringAccept(call.id, token, { agentUserId: randomUUID(), deviceId: away.deviceId })).toEqual({ ok: false, code: 'ring_not_offered' });
    expect(await c.ringAccept(call.id, 'not-the-token-at-all-xx', { agentUserId: away.userId, deviceId: away.deviceId })).toEqual({ ok: false, code: 'ring_not_offered' });
    expect(await row(call.id)).toMatchObject({ state: 'offered', offer_channel: 'push' });
  });

  it('N5: the app opened by its icon mid-ring is an implicit answer and accept: it binds at once and the phone is told to stop ringing', async () => {
    const c = connector();
    const away = await awayAgent();
    const { call } = await caller(c);
    const token = String((await ringPush(away.deviceRowId))['offer_token']);
    await attach(c, away.sessionId, away.userId);
    await until('connected', async () => (await row(call.id)).state === 'connected');
    await drain();
    expect(await row(call.id)).toMatchObject({ ring_result: 'answered' });
    expect((await row(call.id)).accepted_at).not.toBeNull();
    expect(await until('ring_cancel', () => pushes('ring_cancel', away.deviceRowId)[0] ?? null))
      .toEqual({ type: 'ring_cancel', call_id: call.id, session_id: away.sessionId, reason: 'answered' });
    // The state stayed `reserved` through the attach (no away-ring end, no `ring_off`).
    expect(pushes('ring_off')).toEqual([]);
    expect(await agents.get(away.sessionId)).toMatchObject({ state: 'on_call' });
    // Dart's accept that follows (the app had the push too) is the bound call: already accepted.
    expect(await c.ringAccept(call.id, token, { agentUserId: away.userId, deviceId: away.deviceId })).toEqual({ ok: false, code: 'already_accepted' });
  });

  it('N5: an attach during an accepted ring keeps the state reserved and binds; an older build (no caps=inbound) ends the ring instead', async () => {
    const c = connector();
    await deskAgent('on_call'); // keeps the caller waiting once the ring ends
    const away = await awayAgent();
    const { call } = await caller(c);
    const token = String((await ringPush(away.deviceRowId))['offer_token']);
    expect(await c.ringAccept(call.id, token, { agentUserId: away.userId, deviceId: away.deviceId })).toMatchObject({ ok: true });
    expect(await agents.get(away.sessionId)).toMatchObject({ state: 'reserved', inboundCallId: call.id });
    // An older build takes the session: never shown the call; the ring ends and the agent goes to the pool.
    stations.add({ sessionId: away.sessionId, campaignId, tenantId: T, accountId: A, agentUserId: away.userId, clientKind: 'mobile', canTakeInbound: false });
    await c.onStationCannotTakeInbound(away.sessionId);
    await drain();
    expect(await row(call.id)).toMatchObject({ state: 'queued', session_id: null, ring_result: 'cancelled' });
    expect(c.holdsPushOffer(away.sessionId)).toBe(false);
  });

  it('a socket dropped inside the accept grace does not cancel the offer: the re-attach binds', async () => {
    const c = connector();
    const away = await awayAgent();
    const { call } = await caller(c);
    const token = String((await ringPush(away.deviceRowId))['offer_token']);
    expect(await c.ringAccept(call.id, token, { agentUserId: away.userId, deviceId: away.deviceId })).toMatchObject({ ok: true });
    // The station attaches and its socket drops before the bind runs.
    const entry = stations.add({ sessionId: away.sessionId, campaignId, tenantId: T, accountId: A, agentUserId: away.userId, clientKind: 'mobile', canTakeInbound: true });
    await c.reattachStation(away.sessionId, entry.ws as never);
    c.bindAcceptedRing(away.sessionId);
    await stations.close(away.sessionId, async () => {
      c.onStationClosed(away.sessionId);
      expect(await agents.setOfflineUnlessAway(away.sessionId, c.holdsPushOffer(away.sessionId))).toBe('kept');
    });
    await drain();
    expect(await row(call.id)).toMatchObject({ state: 'offered', session_id: away.sessionId });
    expect(c.holdsPushOffer(away.sessionId)).toBe(true);
    expect(await agents.get(away.sessionId)).toMatchObject({ state: 'reserved', inboundCallId: call.id });
    await attach(c, away.sessionId, away.userId);
    await until('connected', async () => (await row(call.id)).state === 'connected');
    expect(bridge.binds).toEqual([call.id]);
  });
});

// ─── 2. The ends of a ring ──────────────────────────────────────────────────

describe('the ends of a ring', () => {
  it('decline: not a miss, the agent back on away_ring, the caller rung on the next phone and never on this one again', async () => {
    const c = connector();
    const first = await awayAgent();
    const { call } = await caller(c);
    const token = String((await ringPush(first.deviceRowId))['offer_token']);
    const second = await awayAgent();
    expect(await c.ringDecline(call.id, token, 'declined')).toMatchObject({ ok: true, callId: call.id, sessionId: first.sessionId, agentUserId: first.userId });
    expect(await c.ringDecline(call.id, token, 'declined')).toEqual({ ok: false, code: 'ring_not_offered' }); // spent
    await expectAwayRing(first.sessionId);
    expect(await sessionRow(first.sessionId)).toMatchObject({ ring_misses: 0 });
    expect(pushes('ring_cancel', first.deviceRowId)).toEqual([{ type: 'ring_cancel', call_id: call.id, session_id: first.sessionId, reason: 'declined' }]);
    await ringPush(second.deviceRowId, call.id);
    expect(await row(call.id)).toMatchObject({ state: 'offered', session_id: second.sessionId, ring_count: 2, ring_result: null });
    expect(pushes('ring', first.deviceRowId)).toHaveLength(1);
  });

  it('busy_on_phone (IQ70) is a decline: no miss', async () => {
    const c = connector();
    const away = await awayAgent();
    const { call } = await caller(c);
    const token = String((await ringPush(away.deviceRowId))['offer_token']);
    expect(await c.ringDecline(call.id, token, 'busy_on_phone')).toMatchObject({ ok: true });
    await drain();
    expect(await row(call.id)).toMatchObject({ ring_result: 'busy_on_phone' });
    expect(await sessionRow(away.sessionId)).toMatchObject({ ring_misses: 0 });
    await expectAwayRing(away.sessionId);
  });

  it('N4: decline is valid until accept, even after answering; after accept the agent`s hang-up declines (not a miss)', async () => {
    const c = connector();
    const away = await awayAgent();
    await deskAgent('on_call'); // someone who could take the caller later: no overflow at once
    const { call } = await caller(c);
    const token = String((await ringPush(away.deviceRowId))['offer_token']);
    expect(await c.ringAnswering(call.id, token)).toMatchObject({ ok: true });
    expect(await c.ringDecline(call.id, token, 'declined')).toMatchObject({ ok: true });
    await drain();
    expect(await row(call.id)).toMatchObject({ state: 'queued', ring_result: 'declined' });
    await expectAwayRing(away.sessionId);

    // The next phone is rung for the same caller: accepted, then hung up from the app (the Bearer hang-up).
    const other = await awayAgent();
    // The account is searched again (the 2 s republish would, sooner here).
    (c as unknown as { searchInBackground: (k: string) => void }).searchInBackground(`${T}:${A}`);
    const token2 = String((await ringPush(other.deviceRowId, call.id))['offer_token']);
    expect(await c.ringAccept(call.id, token2, { agentUserId: other.userId, deviceId: other.deviceId })).toMatchObject({ ok: true });
    expect(await c.ringDecline(call.id, token2, 'declined')).toEqual({ ok: false, code: 'already_accepted' });
    expect(await c.hangUp(call.id)).toMatchObject({ kind: 'declined' });
    await drain();
    expect(await row(call.id)).toMatchObject({ state: 'queued', ring_result: 'declined' });
    expect(await sessionRow(other.sessionId)).toMatchObject({ ring_misses: 0 });
    await expectAwayRing(other.sessionId);
  });

  it('expiry is a miss; the second miss in a row ends away_ring (device_away, offline with no socket, ring_off, audited)', async () => {
    const c = connector({ ringMs: 300 });
    await deskAgent('on_call'); // keeps the callers waiting (could take them later)
    const away = await awayAgent();
    const { call: one } = await caller(c);
    await ringPush(away.deviceRowId, one.id);
    await until('expired', async () => (await row(one.id)).ring_result === 'expired');
    await drain();
    expect(await row(one.id)).toMatchObject({ state: 'queued', session_id: null });
    expect(await sessionRow(away.sessionId)).toMatchObject({ ring_misses: 1 });
    await expectAwayRing(away.sessionId);
    expect(pushes('ring_cancel', away.deviceRowId)).toEqual([{ type: 'ring_cancel', call_id: one.id, session_id: away.sessionId, reason: 'expired' }]);
    // The same caller never rings them again; a second caller does, and expires too.
    const { call: two } = await caller(c);
    await ringPush(away.deviceRowId, two.id);
    await until('second expired', async () => (await row(two.id)).ring_result === 'expired');
    await drain();
    expect(AGENCY_INBOUND_RING_MAX_MISSES).toBe(2);
    expect(await sessionRow(away.sessionId)).toMatchObject({ state: 'offline', break_reason: 'device_away', away_ring_since: null, ring_misses: 2 });
    expect(await agents.get(away.sessionId)).toMatchObject({ state: 'offline', ring: false });
    expect(await until('ring_off', () => pushes('ring_off', away.deviceRowId)[0] ?? null)).toEqual({ type: 'ring_off', session_id: away.sessionId, reason: 'ring_missed' });
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'agency_session.away_ring_ended', resource_id: away.sessionId, details: expect.objectContaining({ reason: 'ring_missed' }) }));
    expect(pushes('ring', away.deviceRowId).map((p) => p['call_id'])).toEqual([one.id, two.id]);
  });

  it('an answer whose accept never binds lapses (accept_lapsed): a miss, back on away_ring', async () => {
    const c = connector({ acceptGraceMs: 300 });
    await deskAgent('on_call');
    const away = await awayAgent();
    const { call } = await caller(c);
    const token = String((await ringPush(away.deviceRowId))['offer_token']);
    expect(await c.ringAnswering(call.id, token)).toMatchObject({ ok: true });
    await until('lapsed', async () => (await row(call.id)).ring_result === 'accept_lapsed');
    await drain();
    expect(await row(call.id)).toMatchObject({ state: 'queued' });
    expect(await sessionRow(away.sessionId)).toMatchObject({ ring_misses: 1 });
    await expectAwayRing(away.sessionId);
    expect(await c.ringAccept(call.id, token, { agentUserId: away.userId, deviceId: away.deviceId })).toEqual({ ok: false, code: 'ring_expired' });
  });

  it('the caller leaves while it rings: caller_left, the phone told, the agent back on away_ring', async () => {
    const c = connector();
    const away = await awayAgent();
    const { call, done } = await caller(c);
    await ringPush(away.deviceRowId);
    bridge.end(call.id);
    await done;
    await drain();
    expect(await row(call.id)).toMatchObject({ state: 'ended', outcome: 'abandoned_in_queue', ring_result: 'caller_left' });
    await expectAwayRing(away.sessionId);
    expect(c.holdsPushOffer(away.sessionId)).toBe(false);
    expect(pushes('ring_cancel', away.deviceRowId)).toEqual([{ type: 'ring_cancel', call_id: call.id, session_id: away.sessionId, reason: 'caller_left' }]);
    expect(await sessionRow(away.sessionId)).toMatchObject({ ring_misses: 0 });
  });

  it('a push that fails is push_failed and a miss; the agent back on away_ring, no ring_cancel', async () => {
    const c = connector();
    await deskAgent('on_call');
    const away = await awayAgent();
    sender.answers.push({ ok: false, reason: 'unavailable' });
    const { call } = await caller(c);
    await until('push_failed', async () => (await row(call.id)).ring_result === 'push_failed');
    await drain();
    expect(await sessionRow(away.sessionId)).toMatchObject({ ring_misses: 1 });
    await expectAwayRing(away.sessionId);
    expect(pushes('ring_cancel')).toEqual([]);
    expect(await row(call.id)).toMatchObject({ state: 'queued' });
  });

  it('an unregistered token revokes the device and ends away_ring (revoked)', async () => {
    const c = connector();
    await deskAgent('on_call');
    const away = await awayAgent();
    sender.answers.push({ ok: false, reason: 'unregistered' });
    const { call } = await caller(c);
    await until('push_failed', async () => (await row(call.id)).ring_result === 'push_failed');
    await drain();
    expect((await devices.find(away.userId, away.deviceId))!.revoked_at).not.toBeNull();
    expect(await sessionRow(away.sessionId)).toMatchObject({ state: 'offline', break_reason: 'device_away', away_ring_since: null });
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'agency_session.away_ring_ended', details: expect.objectContaining({ reason: 'revoked' }) }));
  });
});

// ─── 3. Who is rung ─────────────────────────────────────────────────────────

describe('who is rung', () => {
  it('IQ69: a caller with less than a ring window of wait left is not rung (and waits for the agent who could take them)', async () => {
    const c = connector({ ringMs: 10 * 60_000 }); // longer than the route's maximum wait
    await deskAgent('on_call');
    const away = await awayAgent();
    const { call } = await caller(c);
    await until('queued', async () => (await row(call.id)).state === 'queued');
    await drain();
    await sleep(100);
    await drain();
    expect(pushes('ring')).toEqual([]);
    expect(await row(call.id)).toMatchObject({ state: 'queued', ring_count: 0 });
    await expectAwayRing(away.sessionId);
  });

  it('a station agent on screen is preferred to a phone: no ring', async () => {
    const c = connector();
    const away = await awayAgent();
    const desk = await deskAgent();
    const { call } = await caller(c);
    await until('offered', async () => (await row(call.id)).state === 'offered');
    expect(await row(call.id)).toMatchObject({ session_id: desk, offer_channel: 'station' });
    await drain();
    expect(pushes('ring')).toEqual([]);
    await expectAwayRing(away.sessionId);
  });

  it('strict sticky: the sticky agent`s phone is rung first even with a team agent on screen; their decline gives the caller to the team', async () => {
    const strict = await makeRoute({ sticky_mode: 'strict' });
    const c = connector();
    const away = await awayAgent();
    const desk = await deskAgent();
    const { call } = await caller(c, { routeId: strict.id, identification: { match: null, callerDnc: false, sticky: { userId: away.userId, reason: 'owner' } } }, strict);
    const token = String((await ringPush(away.deviceRowId, call.id))['offer_token']);
    expect(await row(call.id)).toMatchObject({ state: 'offered', session_id: away.sessionId, offer_channel: 'push' });
    expect(await agents.get(desk)).toMatchObject({ state: 'available' });
    expect(await c.ringDecline(call.id, token, 'declined')).toMatchObject({ ok: true });
    await until('the team', async () => (await row(call.id)).session_id === desk);
    expect(await row(call.id)).toMatchObject({ offer_channel: 'station' });
  });

  it('two callers and one phone: one ring at a time; the second is rung once the first ring ends', async () => {
    const c = connector();
    await deskAgent('on_call');
    const away = await awayAgent();
    const { call: x } = await caller(c);
    const firstRing = await ringPush(away.deviceRowId);
    const { call: y } = await caller(c);
    await until('y queued', async () => (await row(y.id)).state === 'queued');
    await drain();
    expect(pushes('ring', away.deviceRowId)).toHaveLength(1);
    const [rung, other] = firstRing['call_id'] === x.id ? [x, y] : [y, x];
    expect(await c.ringDecline(rung.id, String(firstRing['offer_token']), 'declined')).toMatchObject({ ok: true });
    await ringPush(away.deviceRowId, other.id);
    expect(await row(other.id)).toMatchObject({ state: 'offered', session_id: away.sessionId });
  });

  it('the flag off: nobody is rung, and a caller only a phone could take is overflowed at once', async () => {
    flagsOn = false;
    const c = connector();
    const away = await awayAgent();
    const { call, done } = await caller(c);
    await done;
    expect(await row(call.id)).toMatchObject({ state: 'ended', outcome: 'overflow', ring_count: 0 });
    expect(pushes('ring')).toEqual([]);
    void away;
  });

  it('IQ68: a ringable agent keeps a caller waiting; once the caller declined them nobody could take the caller, who is overflowed at once', async () => {
    const c = connector();
    const away = await awayAgent();
    const { call, done } = await caller(c);
    const token = String((await ringPush(away.deviceRowId))['offer_token']);
    expect(await c.couldAnyoneTake({ tenantId: T, accountId: A, route })).toBe(true);
    expect(await c.ringDecline(call.id, token, 'declined')).toMatchObject({ ok: true });
    await done;
    expect(await row(call.id)).toMatchObject({ state: 'ended', outcome: 'overflow' });
  });
});

// ─── 4. IQ73 (N3) ───────────────────────────────────────────────────────────

describe('IQ73: on screen first, even mid-ring (N3)', () => {
  it('a station agent who becomes available mid-ring takes the caller: the ring is cancelled answered_elsewhere, no miss', async () => {
    const c = connector();
    const desk = await deskAgent('on_call');
    const away = await awayAgent();
    const { call } = await caller(c);
    const token = String((await ringPush(away.deviceRowId))['offer_token']);
    await sleep(5);
    await agents.set(desk, 'available', { leaseMs: 60_000 });
    c.onAgentAvailable(desk);
    await until('taken', async () => (await row(call.id)).session_id === desk);
    await drain();
    expect(await row(call.id)).toMatchObject({ offer_channel: 'station', ring_result: 'answered_elsewhere' });
    await expectAwayRing(away.sessionId);
    expect(await sessionRow(away.sessionId)).toMatchObject({ ring_misses: 0 });
    expect(pushes('ring_cancel', away.deviceRowId)).toEqual([{ type: 'ring_cancel', call_id: call.id, session_id: away.sessionId, reason: 'answered_elsewhere' }]);
    expect(await c.ringAnswering(call.id, token)).toEqual({ ok: false, code: 'ring_not_offered' });
  });

  it('the release hook takes a ringing caller for an agent coming out of a wrap-up', async () => {
    const c = connector();
    const desk = await deskAgent('wrapup');
    const away = await awayAgent();
    const { call } = await caller(c);
    await ringPush(away.deviceRowId);
    expect(await c.takeOnRelease(desk)).toBe(true);
    await drain();
    expect(await row(call.id)).toMatchObject({ session_id: desk, ring_result: 'answered_elsewhere' });
    await expectAwayRing(away.sessionId);
  });

  it('ordering A: the take-over reaches the call`s chain first; the answering that follows is the uniform 404', async () => {
    const c = connector();
    const desk = await deskAgent('on_call');
    const away = await awayAgent();
    const { call } = await caller(c);
    const token = String((await ringPush(away.deviceRowId))['offer_token']);
    // Hold the call's chain, so both steps queue behind it in a known order.
    const hold = gate();
    void (c as unknown as { serial: (id: string, fn: () => Promise<void>) => Promise<void> }).serial(call.id, () => hold.wait);
    await sleep(5);
    await agents.set(desk, 'available', { leaseMs: 60_000 });
    c.onAgentAvailable(desk);
    // The search reserved the desk agent under the lock and queued its take-over step.
    await until('desk reserved', async () => (await agents.get(desk))?.inboundCallId === call.id);
    const answering = c.ringAnswering(call.id, token);
    hold.open();
    expect(await answering).toEqual({ ok: false, code: 'ring_not_offered' });
    await drain();
    expect(await row(call.id)).toMatchObject({ session_id: desk, offer_channel: 'station', ring_result: 'answered_elsewhere' });
    await expectAwayRing(away.sessionId);
  });

  it('ordering B: answering reaches the call`s chain first; the reserved station agent is given back and the ring stands', async () => {
    const c = connector();
    const desk = await deskAgent('on_call');
    const away = await awayAgent();
    const { call } = await caller(c);
    const token = String((await ringPush(away.deviceRowId))['offer_token']);
    const hold = gate();
    void (c as unknown as { serial: (id: string, fn: () => Promise<void>) => Promise<void> }).serial(call.id, () => hold.wait);
    const answering = c.ringAnswering(call.id, token);
    await sleep(5);
    await agents.set(desk, 'available', { leaseMs: 60_000 });
    c.onAgentAvailable(desk);
    await until('desk reserved', async () => (await agents.get(desk))?.inboundCallId === call.id);
    hold.open();
    expect(await answering).toMatchObject({ ok: true });
    await drain();
    expect(await row(call.id)).toMatchObject({ state: 'offered', session_id: away.sessionId, offer_channel: 'push' });
    expect((await row(call.id)).accepted_at).not.toBeNull();
    expect(await agents.get(desk)).toMatchObject({ state: 'available', inboundCallId: null });
    expect(c.holdsPushOffer(away.sessionId)).toBe(true);
  });

  it('a station agent already on screen when the sticky agent`s phone was rung does not take the ring over', async () => {
    const strict = await makeRoute({ sticky_mode: 'strict' });
    const c = connector({ republishMs: 50 });
    const away = await awayAgent();
    const desk = await deskAgent();
    const { call } = await caller(c, { routeId: strict.id, identification: { match: null, callerDnc: false, sticky: { userId: away.userId, reason: 'owner' } } }, strict);
    await ringPush(away.deviceRowId, call.id);
    await sleep(300); // several republish searches
    await drain();
    expect(await row(call.id)).toMatchObject({ state: 'offered', session_id: away.sessionId, offer_channel: 'push' });
    expect(await agents.get(desk)).toMatchObject({ state: 'available' });
  });
});

// ─── 5. The away break around a ring (N1) ───────────────────────────────────

describe('the away break around a ring (N1)', () => {
  it('a crash mid-ring, then boot: the reconcile leaves the ring`s key alone, then re-seeds away_ring once it lapsed; a new process rings the agent', async () => {
    const before = connector();
    await deskAgent('on_call');
    const away = await awayAgent();
    await caller(before);
    await ringPush(away.deviceRowId);
    // The process dies: its connector and timers are gone (stopped without ending anything), and the
    // next start's sweep ends the calls it left open.
    before.stop();
    connectors = connectors.filter((x) => x !== before);
    for (const [id] of bridge.live) bridge.live.delete(id);
    expect((await calls.sweepStale(new Date(Date.now() + 60_000), 10)).length).toBeGreaterThan(0);
    const after = connector();
    expect(await awayRing.reconcile()).toMatchObject({ skippedInFlight: 1, reseeded: 0 });
    expect(await agents.get(away.sessionId)).toMatchObject({ state: 'reserved', pushOffer: true });
    // The ring's `reserved` lease lapses with nobody renewing it.
    await getTestRedis().del(`${PREFIX}agency:agent:${away.sessionId}:state`);
    expect(await agents.get(away.sessionId)).toBeNull();
    expect(await awayRing.reconcile()).toMatchObject({ reseeded: 1 });
    await expectAwayRing(away.sessionId);
    const { call } = await caller(after);
    await ringPush(away.deviceRowId, call.id);
    expect(await row(call.id)).toMatchObject({ state: 'offered', session_id: away.sessionId, offer_channel: 'push' });
  });

  it('a reconcile tick during a ring: nothing while the absence may go on; the flag off cancels the ring on the call`s chain and ends the absence', async () => {
    const c = connector();
    await deskAgent('on_call');
    const away = await awayAgent();
    const { call } = await caller(c);
    await ringPush(away.deviceRowId);
    expect(await awayRing.reconcile()).toMatchObject({ skippedInFlight: 1, ended: 0 });
    expect(await row(call.id)).toMatchObject({ state: 'offered', session_id: away.sessionId });
    flagsOn = false;
    expect(await awayRing.reconcile()).toMatchObject({ ended: 1 });
    await drain();
    expect(await row(call.id)).toMatchObject({ state: 'queued', session_id: null, ring_result: 'cancelled' });
    expect(await sessionRow(away.sessionId)).toMatchObject({ state: 'offline', break_reason: 'device_away', away_ring_since: null, ring_misses: 0 });
    expect(await until('ring_off', () => pushes('ring_off', away.deviceRowId)[0] ?? null)).toMatchObject({ reason: 'flag_off' });
    expect(c.holdsPushOffer(away.sessionId)).toBe(false);
  });

  it('a reconcile tick during an ANSWERED ring leaves it to run', async () => {
    const c = connector();
    await deskAgent('on_call');
    const away = await awayAgent();
    const { call } = await caller(c);
    const token = String((await ringPush(away.deviceRowId))['offer_token']);
    expect(await c.ringAnswering(call.id, token)).toMatchObject({ ok: true });
    flagsOn = false;
    expect(await awayRing.reconcile()).toMatchObject({ ended: 0, skippedInFlight: 1 });
    expect(await row(call.id)).toMatchObject({ state: 'offered', session_id: away.sessionId });
  });

  it('a take-over during a ring cancels it (answered_elsewhere): the agent on a plain break for the new device, the old one told', async () => {
    const c = connector();
    await deskAgent('on_call');
    const away = await awayAgent();
    const { call } = await caller(c);
    await ringPush(away.deviceRowId);
    // The claim (another device's "Use it here") rewrote the mirror; then the runtime's end.
    await sessions.claimStationDevice(away.sessionId, { deviceId: 'laptop-take-over-1', takeOver: true }, { reconnect: false });
    await awayRing.endOnTakeOver(away.sessionId, away.userId, away.deviceId);
    await drain();
    expect(await row(call.id)).toMatchObject({ state: 'queued', ring_result: 'answered_elsewhere' });
    expect(await agents.get(away.sessionId)).toMatchObject({ state: 'break', ring: false, inboundCallId: null });
    expect(await sessionRow(away.sessionId)).toMatchObject({ state: 'break', break_reason: 'device_away', away_ring_since: null });
    expect(await until('ring_off', () => pushes('ring_off', away.deviceRowId)[0] ?? null)).toMatchObject({ reason: 'taken_over' });
  });

  it('"Stop ringing" during a ring cancels it and ends the absence (opted_out)', async () => {
    const c = connector();
    await deskAgent('on_call');
    const away = await awayAgent();
    const { call } = await caller(c);
    await ringPush(away.deviceRowId);
    await devices.setRingEnabled(away.userId, away.deviceId, false);
    expect(await awayRing.endForDevice(away.userId, away.deviceId, 'opted_out')).toBe('ended');
    await drain();
    expect(await row(call.id)).toMatchObject({ state: 'queued', ring_result: 'cancelled' });
    expect(await sessionRow(away.sessionId)).toMatchObject({ break_reason: 'device_away', away_ring_since: null });
  });
});
