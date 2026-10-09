// The suite drives the REAL bridge, on VoiceLink.
//
// Harness notes:
//  - the account-settings mock answers `getWebrtcMaxDurationSeconds` with null (the
//    bridge's 1800 default); the campaign fixture is `voicelink`.
//  - `dialAndBridge`: the PSTN attach is followed by VoiceLink's `start` frame — the
//    answer and media negotiation on this carrier. Every case that bridges goes
//    through it.
//  - 'resumes the same call, with audio flowing again on the new socket': the relayed
//    payload is a real 20ms tone (VoiceLink transcodes; a short dummy payload produces
//    no frame). Exactly one more carrier frame is expected, and the leg is not closed
//    and the session is not `ending` after the original deadline.
//  - 'holds the call instead of hanging up, …': asserts `pstn.closeCalls === 0` and
//    `ending === false`. On VoiceLink an answered hangup is a WS close plus `ending` (the
//    session stays in the map), so `getSession` / `endCall` checks alone also pass
//    on a call hung up on the drop. With the grace removed
//    (`browserCloseGraceMs: 0` in the dialer) these lines are the ones that red.
//  - 'settles the call agent_disconnected and holds the release the agent missed': the
//    hangup is asserted as "the carrier leg was closed" (VoiceLink's only hangup), and the
//    carrier's `call.ended` is driven before the settled attempt is read (an answered
//    VoiceLink hangup waits for it).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

// ---------------------------------------------------------------------------
// Presence resilience.
//
// **This file drives the REAL bridge, not a double**, and that is the whole
// point of it. The deferred-hangup window is armed inside
// `WebRtcBridgeManager`'s borrowed-socket close handler and disarmed by its
// re-attach entry point; a fake bridge would let every assertion here pass
// against a window that does not exist. The property has to hold where it is
// CONSUMED, not only where it is implemented, so the test wires the real `AgencyDialer` to the real `WebRtcBridgeManager`
// over a real `StationRegistry` and a real `AgentStateMachine`, and driving the
// whole thing from a socket close.
//
// The one double is Redis, and it is a RECORDING double rather than a stub,
// because the claim at this tier is behavioural: exercising the
// deferred hangup writes no Redis key at all. That is only observable if
// something is watching the wire.
// ---------------------------------------------------------------------------

vi.mock('@magick-agency/observability', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
  createChildLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../../../src/config/index.js', () => ({
  config: {
    redis: { keyPrefix: '' },
    telephony: {
      vobiz: { webhookBaseUrl: 'https://core.test/api/v1/webhooks/vobiz' },
      voicelink: { webhookBaseUrl: 'https://core.test/api/v1/webhooks/voicelink' },
    },
  },
}));

const { repos } = vi.hoisted(() => ({
  repos: {
    attempt: {
      setState: vi.fn().mockResolvedValue(null),
      attachWebrtcCall: vi.fn().mockResolvedValue(undefined),
      findPriorForContactLineage: vi.fn().mockResolvedValue([]),
    },
    contact: {
      unclaim: vi.fn().mockResolvedValue(undefined),
      markState: vi.fn().mockResolvedValue(undefined),
      // Returns the POST-bump budget (the post-bump attempt budget). A number, not undefined: the
      // dial path decides the retry from whatever this returns.
      chargeAttempt: vi.fn().mockResolvedValue(1),
      // The OUR-FAULT ledger. An agent-side drop before the bridge
      // charges THIS instead of `chargeAttempt`, so failure mode 5 below can
      // assert the customer's allowance was never touched.
      chargeOurFaultAttempt: vi.fn().mockResolvedValue(1),
    },
    session: { setState: vi.fn().mockResolvedValue(undefined), findById: vi.fn().mockResolvedValue(null) },
  },
}));
vi.mock('../../../src/db/repositories/agency.repository.js', () => ({
  agencyAttemptRepository: repos.attempt,
  agencyContactRepository: repos.contact,
  agencyCampaignRepository: {},
  agencyAgentSessionRepository: repos.session,
}));

const { mockWebrtcRepo } = vi.hoisted(() => ({
  mockWebrtcRepo: {
    create: vi.fn(),
    findById: vi.fn().mockResolvedValue(null),
    update: vi.fn().mockResolvedValue(null),
  },
}));
vi.mock('@magick-agency/db/repositories/agency-call.repository', () => ({
  webrtcCallRepository: mockWebrtcRepo,
}));

vi.mock('@magick-agency/db/repositories/account-settings.repository', () => ({
  // `getWebrtcMaxDurationSeconds` → null, i.e. the bridge's 1800 default (the max
  // duration is an account-settings column).
  accountSettingsRepository: {
    getAllowRecording: vi.fn().mockResolvedValue(null),
    getWebrtcMaxDurationSeconds: vi.fn().mockResolvedValue(null),
  },
}));

const { mockAdapter } = vi.hoisted(() => ({
  mockAdapter: {
    initiateCall: vi.fn().mockResolvedValue({ providerCallId: 'pcid-1' }),
    endCall: vi.fn().mockResolvedValue(undefined),
    generateAnswerResponse: vi.fn().mockReturnValue('<Response><Stream/></Response>'),
  },
}));
vi.mock('../../../src/telephony/factory.js', () => ({
  TelephonyProviderRegistry: class { get() { return mockAdapter; } },
}));

// The bridge has no settlement dispatch, so there is nothing to mock for it.
vi.mock('../../../src/audit/audit-logger.js', () => ({ auditLogger: { log: vi.fn() } }));
vi.mock('../../../src/analytics/posthog.js', () => ({
  trackWebrtcCallInitiated: vi.fn(),
  trackWebrtcCallRejected: vi.fn(),
  trackWebrtcCallCompleted: vi.fn(),
}));
// `isEnabled` and `agency_late_binding` are here because `executeDial` resolves
// the late-binding flag on every dial. `false` keeps these cases on the
// early-binding path they were written for — the flag's own registry default, so
// this double agrees with production for a tenant nobody has enrolled.
vi.mock('../../../src/feature-flags/index.js', () => ({
  getFeatureFlagService: () => ({
    getValue: vi.fn().mockResolvedValue(1800),
    isEnabled: vi.fn().mockResolvedValue(false),
  }),
  FLAGS: {
    webrtc_max_duration_seconds: { default: 1800 },
    agency_late_binding: { key: 'agency_late_binding', type: 'boolean', default: false },
  },
}));

import { WebRtcBridgeManager } from '../../../src/core/webrtc-bridge-manager.js';
import { AgencyDialer } from '../../../src/agency/agency-dialer.js';
import { AgentStateMachine, AGENT_LEASE_MS } from '../../../src/agency/agent-state-machine.js';
import { StationRegistry } from '../../../src/agency/station-registry.js';
import { AgencyRuntime } from '../../../src/agency/runtime.js';
import { BreakRegistry } from '@magick-agency/domain/break-manager';
import { DEFERRED_HANGUP_MS } from '@magick-agency/domain/timers';
import type { DialCommand } from '../../../src/agency/dial-dispatcher.js';

// ─── Doubles ───────────────────────────────────────────────────────────────

/**
 * A station socket backed by a real `EventEmitter`, because the bridge's whole
 * close path runs through `ws.on('close')`. A plain-object fake cannot deliver
 * the event that arms the window, so it cannot falsify anything here.
 */
class StationSocket extends EventEmitter {
  readyState = 1;
  readonly OPEN = 1;
  readonly frames: any[] = [];
  readonly raw: string[] = [];
  closeCalls = 0;
  send(s: string): void {
    this.raw.push(s);
    try { this.frames.push(JSON.parse(s)); } catch { /* binary/media */ }
  }
  close(): void { this.closeCalls++; this.drop(); }
  /** What a network drop looks like: the socket dies and the event fires. */
  drop(): void { this.readyState = 3; this.emit('close'); }
  eventsNamed(name: string): any[] { return this.frames.filter((f) => f.event === name); }
}

/**
 * The carrier leg. On VoiceLink the leg attaching is not yet the
 * answer: the carrier's `start` frame on this socket is — it anchors `answered_at` and
 * negotiates media — so {@link dialAndBridge} sends it right after the attach.
 */
class PstnSocket extends EventEmitter {
  readyState = 1;
  readonly OPEN = 1;
  readonly frames: any[] = [];
  closeCalls = 0;
  send(s: string): void { try { this.frames.push(JSON.parse(s)); } catch { /* ignore */ } }
  close(): void { this.closeCalls++; this.readyState = 3; }
}

interface RedisCall { cmd: string; args: string[] }

/**
 * An in-memory Redis that RECORDS every command.
 *
 * The three Lua scripts are interpreted by shape rather than executed, which is
 * enough for the agent state machine's semantics and — crucially — keeps every
 * TTL argument visible as a recorded argument. That is what makes "no Redis key
 * carries the deferred-hangup window" a real observation rather than a reading
 * of the source.
 */
class RecordingRedis {
  readonly calls: RedisCall[] = [];
  private readonly hashes = new Map<string, Record<string, string>>();
  private readonly strings = new Map<string, string>();

  /** Argument values seen on any command, stringified — the TTL audit surface. */
  allArgs(): string[] { return this.calls.flatMap((c) => c.args); }

  private record(cmd: string, args: unknown[]): void {
    this.calls.push({ cmd, args: args.map((a) => String(a)) });
  }

  /**
   * `ioredis`'s Lua entry point, not JavaScript's `eval` — the script text is
   * matched on, never executed. Interpreting by shape rather than running a Lua
   * VM is deliberate: it keeps every TTL argument visible to {@link allArgs}.
   */
  async eval(script: string, _numKeys: number, key: string, ...argv: string[]): Promise<number> {
    this.record('eval', [key, ...argv]);
    const h = this.hashes.get(key);
    if (script.includes('EXISTS')) {                       // RENEW
      if (!h) return 0;
      return h.state === argv[0] ? 1 : 0;
    }
    if (script.includes('HGET')) {                         // CAS
      if (!h || h.state !== argv[0]) return 0;
      this.hashes.set(key, { state: argv[1]!, attempt: argv[2] ?? '', since: argv[4] ?? '' });
      return 1;
    }
    this.hashes.set(key, { state: argv[0]!, attempt: argv[1] ?? '', since: argv[3] ?? '' }); // SET
    return 1;
  }

  async hgetall(key: string): Promise<Record<string, string>> {
    this.record('hgetall', [key]);
    return this.hashes.get(key) ?? {};
  }

  async set(key: string, value: string, ...rest: string[]): Promise<'OK'> {
    this.record('set', [key, value, ...rest]);
    this.strings.set(key, value);
    return 'OK';
  }

  async get(key: string): Promise<string | null> {
    this.record('get', [key]);
    return this.strings.get(key) ?? null;
  }

  async del(key: string): Promise<number> {
    this.record('del', [key]);
    this.hashes.delete(key);
    return this.strings.delete(key) ? 1 : 0;
  }
}

function makeCallManager() {
  return {
    concurrencyGuard: { tryAcquire: vi.fn().mockResolvedValue(true), release: vi.fn().mockResolvedValue(undefined) },
    accountConcurrencyGuard: { tryAcquire: vi.fn().mockResolvedValue(true), release: vi.fn().mockResolvedValue(undefined) },
    triggerDequeue: vi.fn(),
    wakeSelfHeal: vi.fn(),
  };
}

function fakeWrapup() {
  return {
    // `false` = wrapup_seconds 0, so an ended attempt goes straight back to the
    // pool. Presence, not wrap-up, is what this file is about.
    enter: vi.fn(async () => false),
    cancel: vi.fn(), force: vi.fn(async () => false),
    stateFor: vi.fn(() => null), noteDisposition: vi.fn(async () => false),
    stop: vi.fn(), active: vi.fn(() => 0),
  };
}

const CAMPAIGN = {
  id: 'camp-1', name: 'Q3 Renewals', tenant_id: 't1', account_id: 'a1',
  telephony_provider: 'voicelink', record_calls: false,
  analysis_profile_id: null, caller_ids: ['+14155550100'],
  disposition_catalog: [], wrapup_seconds: 0, wrapup_auto_return: true,
} as any;

const CONTACT = {
  id: 'contact-1', phone_e164: '+919876543210',
  context: { 'First Name': 'Asha' }, attempt_count: 0,
} as any;

function makeCmd(sessionId = 's1', attemptId = 'att-1'): DialCommand {
  return {
    attemptId, campaignId: 'camp-1', contactId: 'contact-1',
    sessionId, ownerReplica: 'r1', tenantId: 't1', accountId: 'a1',
    callerId: '+14155550100', attemptNumber: 1,
    campaign: CAMPAIGN, contact: CONTACT,
  };
}

/** Everything real that can be real, wired the way `AgencyRuntime` wires it. */
function makeWorld() {
  const redis = new RecordingRedis();
  const bridge = new WebRtcBridgeManager(makeCallManager() as any, redis as any);
  const stations = new StationRegistry(redis as any, '', 'r1');
  const agents = new AgentStateMachine(redis as any, '');
  const breaks = new BreakRegistry();
  const dialer = new AgencyDialer(bridge as any, stations, agents, fakeWrapup() as any, breaks);
  dialer.start();
  return { redis, bridge, stations, agents, breaks, dialer };
}

async function attachStation(stations: StationRegistry, sessionId: string, ws: StationSocket) {
  await stations.attach({
    sessionId, campaignId: 'camp-1', tenantId: 't1', accountId: 'a1',
    agentUserId: 'user-1', ws: ws as any,
  });
}

/**
 * Dial, then answer the carrier: attach its media leg and send its `start` frame
 * (see {@link PstnSocket}).
 */
async function dialAndBridge(world: ReturnType<typeof makeWorld>, callId = 'call-1') {
  // `executeDial` is only reachable through a successful `reserve`, and it extends
  // that reservation with a CAS that now aborts the dial when it fails. Seeding the
  // state the pacer would have left is the precondition, not a workaround.
  await world.agents.set('s1', 'reserved', { attemptId: 'att-1', leaseMs: AGENT_LEASE_MS.reserved_predial });
  await world.dialer.executeDial(makeCmd());
  const pstn = new PstnSocket();
  world.bridge.attachPstnLeg(callId, pstn as any);
  negotiateVoicelink(pstn); // VoiceLink's answer + media negotiation.
  // The lifecycle listener is async (`void ... .catch`), so let its microtasks run.
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  return pstn;
}

/**
 * Drain the async teardown a socket close kicks off (real timers only).
 *
 * `close` handlers are synchronous but call into `localHangup` → `endCall`,
 * which awaits the repository, the settlement dispatch and the slot release. A
 * fixed number of `Promise.resolve()`s is a guess at that chain's depth; macro
 * ticks drain it whatever it is, so a test cannot pass merely because the
 * teardown had not got round to running yet.
 */
async function flush(times = 5): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((r) => setImmediate(r));
}

/**
 * VoiceLink's A-law 8kHz `start` frame — the answer on this carrier, and
 * what opens the relay. Same frame the bridge suites send.
 */
function negotiateVoicelink(pstn: PstnSocket): void {
  pstn.emit('message', JSON.stringify({
    event: 'start',
    start: { call_sid: 'carrier-1', stream_sid: 's1', media_format: { encoding: 'audio/alaw', sample_rate: '8000' } },
  }));
}

/**
 * A real 20ms PCM16 16kHz tone. VoiceLink transcodes (PCM16 16k → A-law 8k), so the
 * audio has to be real for exactly one carrier frame to come out.
 */
function pcm16kToneFrame(): string {
  const pcm = new Int16Array(320); // 20ms @16k = 640 bytes
  for (let i = 0; i < pcm.length; i++) pcm[i] = Math.round(8000 * Math.sin((2 * Math.PI * 1000 * i) / 16000));
  return Buffer.from(pcm.buffer).toString('base64');
}

/**
 * The carrier's `call.ended` for an ANSWERED VoiceLink call. Its hangup
 * waits in `ending` for this confirmation, so a case that
 * asserts the settled attempt drives it, as the bridge suites do.
 */
async function carrierConfirmsEnd(world: ReturnType<typeof makeWorld>, callId = 'call-1'): Promise<void> {
  await world.bridge.handleVoicelinkStatus(callId, {
    providerCallId: 'carrier-1', callId, eventType: 'hangup', timestamp: new Date(),
    metadata: { event: 'call.ended', call: { id: 'carrier-1', status: 'ended' } },
  } as any);
}

let seq = 0;

beforeEach(() => {
  vi.clearAllMocks();
  seq = 0;
  mockWebrtcRepo.create.mockImplementation(async (i: any) => ({
    id: `call-${++seq}`,
    tenant_id: i.tenant_id, account_id: i.account_id,
    caller_id: i.caller_id, destination_phone: i.destination_phone,
    provider: i.provider, status: 'initiating', provider_call_id: null,
    answered_at: null, ended_at: null, duration_seconds: null, talk_time_seconds: null,
    campaign_id: i.campaign_id ?? null, agency_attempt_id: i.agency_attempt_id ?? null,
  }));
  mockAdapter.initiateCall.mockResolvedValue({ providerCallId: 'pcid-1' });
});

afterEach(() => {
  vi.useRealTimers();
});

// ═══════════════════════════════════════════════════════════════════════════
// The deferred hangup is not a lease: the voice engine's side of the contract.
// ═══════════════════════════════════════════════════════════════════════════

describe('the deferred hangup is not a lease', () => {
  it('writes no Redis key at all — arming and expiring the window are Redis-silent', async () => {
    vi.useFakeTimers();
    const world = makeWorld();
    const ws = new StationSocket();
    await attachStation(world.stations, 's1', ws);
    await world.agents.set('s1', 'available', { leaseMs: AGENT_LEASE_MS.available });
    await dialAndBridge(world);

    // ── The window opens here. Everything from this point is the observation. ──
    const session = world.bridge.getSession('call-1')!;
    const before = world.redis.calls.length;
    ws.drop();

    // **Prove the window exists before proving it is silent.** Redis silence is
    // trivially true of a mechanism that never runs, so without this the whole
    // assertion below would go green against a build where the deferred hangup
    // had been removed — passing while the invariant it guards went unexercised.
    expect(
      session.browserLegGraceArmed,
      'the deferred hangup was not armed — the silence assertions below prove nothing',
    ).toBe(true);

    // Arming must be Redis-silent: a window implemented as a key would announce
    // itself in exactly this gap, and nothing else runs in it.
    expect(
      world.redis.calls.slice(before),
      'the deferred-hangup window wrote to Redis when it was armed',
    ).toEqual([]);

    // Run the window out. The lease renewer legitimately ticks inside it — that
    // is a LIVENESS key and must keep being renewed — so the claim is not
    // "silence", it is that nothing anywhere carries the window's duration.
    await vi.advanceTimersByTimeAsync(DEFERRED_HANGUP_MS + 50);

    const windowTraffic = world.redis.calls.slice(before);
    expect(
      windowTraffic.map((c) => `${c.cmd} ${c.args.join(' ')}`).join('\n'),
      'a Redis command carried the deferred-hangup duration — it has become a TTL',
    ).not.toContain(String(DEFERRED_HANGUP_MS));

    // Stated positively as well, against the CONSTANT rather than a literal, so
    // the assertion still holds if the window's value is retuned. A test that
    // hard-codes 8000 stops asking the question the moment someone changes it.
    expect(world.redis.allArgs()).not.toContain(String(DEFERRED_HANGUP_MS));

    // And the only TTLs that WERE written are the lease table's own — which is
    // what makes the negative above meaningful rather than vacuously true of a
    // run that happened to touch Redis not at all.
    const leaseValues = new Set<string>(Object.values(AGENT_LEASE_MS).map(String));
    const ttlsSeen = world.redis.allArgs().filter((a) => leaseValues.has(a));
    expect(ttlsSeen.length, 'no lease TTL was observed — the audit surface is empty').toBeGreaterThan(0);
  });

  it('detector proof: the audit would catch a window implemented as a TTL', async () => {
    // The assertion above is a negative, and a negative that has never failed is
    // unproven. This writes the exact key the invariant forbids and shows the
    // same audit surface reports it — so a future refactor that neuters the
    // recorder fails here rather than making the test above silently vacuous.
    const redis = new RecordingRedis();
    await redis.set('agency:deferred:att-1', '1', 'PX', String(DEFERRED_HANGUP_MS));
    expect(redis.allArgs()).toContain(String(DEFERRED_HANGUP_MS));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// The five failure modes, each proven by its own test (acceptance (a)).
// ═══════════════════════════════════════════════════════════════════════════

describe('failure mode 1 — heartbeat loss while idle', () => {
  it('an idle agent whose socket goes is written offline immediately, not left to the lease', async () => {
    const world = makeWorld();
    const ws = new StationSocket();
    await attachStation(world.stations, 's1', ws);
    await world.agents.set('s1', 'available', { leaseMs: AGENT_LEASE_MS.available });

    // No live attempt: the socket IS the agent's presence, so its loss is final.
    expect(world.dialer.hasLiveAttempt('s1')).toBe(false);

    await world.stations.detach('s1', ws as any);
    await world.agents.set('s1', 'offline', { leaseMs: AGENT_LEASE_MS.available });

    expect((await world.agents.get('s1'))?.state).toBe('offline');
    // Presence is derived from the socket, never from the durable row: the agent
    // is out of the pool without anything having read `agency_agent_sessions`.
    expect(world.stations.isLocallyOwned('s1')).toBe(false);
  });

  it('nothing but the station heartbeat renews an idle lease', async () => {
    vi.useFakeTimers();
    const world = makeWorld();
    const ws = new StationSocket();
    await attachStation(world.stations, 's1', ws);
    await world.agents.set('s1', 'available', { leaseMs: AGENT_LEASE_MS.available });

    // A silent socket — no `ping` arrives. If any background renewer existed, an
    // agent behind a dead network would stay `available` forever and the tick
    // would dial into them. Advance well past the idle lease and assert nothing
    // touched the key.
    const before = world.redis.calls.length;
    await vi.advanceTimersByTimeAsync(AGENT_LEASE_MS.available * 3);
    expect(
      world.redis.calls.slice(before),
      'something renewed an idle agent lease without a heartbeat',
    ).toEqual([]);
  });
});

describe('failure mode 2 — the socket drops mid-call', () => {
  it('holds the call instead of hanging up, and does not overwrite the on_call lease', async () => {
    vi.useFakeTimers();
    const world = makeWorld();
    const ws = new StationSocket();
    await attachStation(world.stations, 's1', ws);
    await world.agents.set('s1', 'available', { leaseMs: AGENT_LEASE_MS.available });
    const pstn = await dialAndBridge(world); // kept for the VoiceLink hangup check below

    expect((await world.agents.get('s1'))?.state).toBe('on_call');

    ws.drop();
    // Drain the teardown a close would kick off if there were no window: a bare
    // microtask tick returns before  completes, so "the session is still
    // there" would be true of a torn-down call that simply had not finished.
    await vi.advanceTimersByTimeAsync(1);

    // The call is still live: no terminal write, no carrier hangup.
    expect(world.bridge.getSession('call-1'), 'the call was torn down on the drop').toBeDefined();
    expect(mockAdapter.endCall).not.toHaveBeenCalled();
    // On VoiceLink an answered hangup is NOT `endCall` (it closes the provider WS
    // and parks the session in `ending`, still in the map), so the two lines above would
    // also pass on a call hung up on the drop. These two say it on this carrier.
    expect(pstn.closeCalls, 'the carrier leg was hung up on the drop').toBe(0);
    expect(world.bridge.getSession('call-1')!.ending, 'the call is ending on the drop').toBe(false);

    // And the agent is still `on_call` — the state the deferred hangup will
    // resolve. Writing `offline` here would clear the attempt binding, so the
    // owning replica's state-matched renewal starts failing and the lease it
    // depends on lapses underneath the reconnect it is waiting for.
    expect(world.dialer.hasLiveAttempt('s1')).toBe(true);
    expect((await world.agents.get('s1'))?.state).toBe('on_call');
  });
});

describe('failure mode 3 — reconnect INSIDE the window', () => {
  it('resumes the same call, with audio flowing again on the new socket', async () => {
    vi.useFakeTimers();
    const world = makeWorld();
    const first = new StationSocket();
    await attachStation(world.stations, 's1', first);
    await world.agents.set('s1', 'available', { leaseMs: AGENT_LEASE_MS.available });
    const pstn = await dialAndBridge(world);

    first.drop();
    // A wifi roam: well inside the window, and the customer is still on the line.
    await vi.advanceTimersByTimeAsync(DEFERRED_HANGUP_MS / 2);

    const second = new StationSocket();
    await attachStation(world.stations, 's1', second);
    const resumed = world.dialer.reattachStation('s1', second as any);

    expect(resumed, 'the drop was inside the window and did not resume').not.toBeNull();
    expect(resumed!.attempt_id).toBe('att-1');
    // `bridged_at` is the ringing-vs-live discriminator the console has no other
    // way to know. Without it a resumed panel either says "connected" while the
    // phone is still ringing, or "ringing" through a live customer's hello.
    expect(resumed!.bridged_at).not.toBeNull();
    expect(resumed!.state).toBe('bridged');
    expect(resumed!.context).toEqual({ 'First Name': 'Asha' });

    // ── Audio intact. Not "the call object still exists" — audio. ────────────
    const framesBefore = pstn.frames.length;
    // A real 20ms tone — VoiceLink transcodes, so only
    // real audio yields exactly one carrier frame (see `pcm16kToneFrame`).
    second.emit('message', JSON.stringify({ event: 'media', media: { payload: pcm16kToneFrame() } }));
    expect(
      pstn.frames.length,
      'the resumed socket is attached but its media is not reaching the carrier',
    ).toBe(framesBefore + 1);

    // Past the original deadline: the window was genuinely disarmed, not merely
    // out-raced. A re-attach that only re-pointed the socket would let the
    // orphaned timer fire and kill a call the agent is talking on.
    await vi.advanceTimersByTimeAsync(DEFERRED_HANGUP_MS * 2);
    expect(world.bridge.getSession('call-1'), 'the disarmed window fired anyway').toBeDefined();
    expect(mockAdapter.endCall).not.toHaveBeenCalled();
    // The VoiceLink twins of the two lines above — see failure mode 2.
    expect(pstn.closeCalls, 'the disarmed window hung up the carrier leg').toBe(0);
    expect(world.bridge.getSession('call-1')!.ending, 'the disarmed window started a hangup').toBe(false);
  });
});

describe('failure mode 4 — reconnect OUTSIDE the window', () => {
  it('settles the call agent_disconnected and holds the release the agent missed', async () => {
    vi.useFakeTimers();
    const world = makeWorld();
    const first = new StationSocket();
    await attachStation(world.stations, 's1', first);
    await world.agents.set('s1', 'available', { leaseMs: AGENT_LEASE_MS.available });
    const pstn = await dialAndBridge(world); // the leg is kept (see below)

    first.drop();
    await vi.advanceTimersByTimeAsync(DEFERRED_HANGUP_MS + 100);
    // The expired window hung up the carrier leg. VoiceLink's ONLY hangup
    // mechanism is closing the provider WS (`localHangup`, answered arm), and the answered call then settles on
    // the carrier's `call.ended`. So the hangup is asserted as the leg being closed —
    // and still open before the window ran out would have been a hangup on the drop —
    // and the confirmation is driven before the settled attempt is read.
    expect(pstn.closeCalls, 'the expired window did not hang up the carrier leg').toBeGreaterThan(0);
    await carrierConfirmsEnd(world);
    await vi.advanceTimersByTimeAsync(1);

    // The carrier leg was hung up under the caller's own outcome — `browser_hangup`
    // would be a lie about who left, and it is the outcome the attempt is
    // classified from.
    const terminal = mockWebrtcRepo.update.mock.calls.map(([, patch]: any[]) => patch)
      .find((p: any) => p?.outcome);
    expect(terminal?.outcome).toBe('agent_disconnected');

    // The attempt is terminal and the contact has left `in_flight` — otherwise
    // one agent's dead wifi strands a contact for good.
    const ended = repos.attempt.setState.mock.calls.find(([, state]: any[]) => state === 'ended');
    expect(ended, 'the attempt was never ended').toBeDefined();
    expect(repos.contact.markState).toHaveBeenCalled();

    // A reconnect now finds nothing to resume — and is told what happened rather
    // than being handed an empty console.
    const second = new StationSocket();
    await attachStation(world.stations, 's1', second);
    expect(world.dialer.reattachStation('s1', second as any)).toBeNull();

    const missed = world.dialer.takeMissedRelease('s1');
    expect(missed, 'the released frame the agent could not receive was dropped').not.toBeNull();
    expect(missed!.attempt_id).toBe('att-1');
    // Consumed exactly once: a stale release surfacing on a later shift's first
    // frame is worse than not surfacing at all.
    expect(world.dialer.takeMissedRelease('s1')).toBeNull();
  });
});

describe('failure mode 5 — the drop lands DURING the ring', () => {
  it('holds a pre-answer attempt through the window and settles it on expiry', async () => {
    vi.useFakeTimers();
    const world = makeWorld();
    const ws = new StationSocket();
    await attachStation(world.stations, 's1', ws);
    // `reserved`, as the pacer would have left it — `executeDial`'s lease-extension
    // CAS aborts the dial otherwise.
    await world.agents.set('s1', 'reserved', { attemptId: 'att-1', leaseMs: AGENT_LEASE_MS.reserved_predial });

    // Dialed, never answered: no PSTN leg is ever attached.
    await world.dialer.executeDial(makeCmd());
    expect(world.bridge.getSession('call-1')).toBeDefined();

    ws.drop();
    // Drained, not merely un-awaited — see failure mode 2.
    await vi.advanceTimersByTimeAsync(1);
    // Still ringing, still held. The window is not conditional on being bridged —
    // a drop at 2s of a 25s ring is the same wifi blip as one mid-conversation,
    // and the customer has not even been reached yet.
    expect(world.bridge.getSession('call-1'), 'a ringing call was dropped on socket loss').toBeDefined();

    await vi.advanceTimersByTimeAsync(DEFERRED_HANGUP_MS + 100);

    // Never answered ⇒ `canceled`, not `completed`. Recording an unanswered call
    // as a success is the defect already fixed on the max-duration path.
    const terminal = mockWebrtcRepo.update.mock.calls.map(([, patch]: any[]) => patch)
      .find((p: any) => p?.outcome);
    expect(terminal?.outcome).toBe('agent_disconnected');
    expect(terminal?.status).toBe('canceled');
    expect(repos.contact.markState).toHaveBeenCalled();

    // ── our-fault ledger rules — the unit-level twin of the standing
    // integration case in `chaos/network-drop-during-ring.test.ts` ───────────
    //
    // This assertion used to stop at "markState was called", which is true of
    // every possible handling including the defective one. The scenario IS the
    // ticket: our wifi died at 2s of a 25s ring, so the customer was never
    // reached and their retry allowance must be untouched.
    expect(repos.contact.chargeAttempt,
      "an agent's dropped socket spent one of the customer's max_attempts")
      .not.toHaveBeenCalled();
    expect(repos.contact.chargeOurFaultAttempt).toHaveBeenCalledWith('contact-1', 'agent_disconnected');

    // Back on the roster, not retired. Asserted as the STATE — a contact moved to
    // a terminal state keeps a stale `next_attempt_at`, so absence proves nothing.
    const [, state, patch] = repos.contact.markState.mock.calls.at(-1)!;
    expect(state, 'a never-answered contact was retired by our own network fault').toBe('pending');
    // And no second charge sneaking in through the patch.
    expect(patch ?? {}).not.toHaveProperty('bump_attempt');
  });
});

describe('failure mode 6 — the process restarted', () => {
  /** A runtime is what owns the rehydration rule, so drive the real one. */
  function makeRuntime() {
    const redis = new RecordingRedis();
    const bridge = new WebRtcBridgeManager(makeCallManager() as any, redis as any);
    return { redis, runtime: new AgencyRuntime(bridge as any, redis as any, '') };
  }

  it('lands a returning agent in break even when the durable row says available', async () => {
    // The restart signature: Redis is empty (the leases died with the process)
    // while `agency_agent_sessions` still holds whatever was last mirrored.
    // `joinOrRehydrate` preserves any non-`offline` state, so this row really can
    // read `available` — which is why no row-derived rule is safe.
    const { redis, runtime } = makeRuntime();
    // The row really can read `available`: `joinOrRehydrate` preserves any
    // non-`offline` state, so seeding it is the faithful restart, not a contrivance.
    repos.session.findById.mockResolvedValue({ id: 's1', state: 'available' } as never);
    expect(await runtime.agents.get('s1')).toBeNull();

    const state = await runtime.rehydrateAgent('s1');

    expect(state, 'a returning agent came back available after a restart').toBe('break');
    // Written, not merely returned: the pacing tick reads Redis, so a `break` that
    // exists only in the HTTP response would leave the tick seeing no lease at all.
    expect((await runtime.agents.get('s1'))?.state).toBe('break');
    expect(repos.session.setState).toHaveBeenCalledWith('s1', 'break');
    // And on the lease table's own `break` TTL, not an improvised one.
    expect(redis.allArgs()).toContain(String(AGENT_LEASE_MS.break));
  });

  it('does NOT overwrite a live lease — the mid-call reconnect case', async () => {
    // The other half, and the one that was a live bug: an agent reconnecting
    // inside the deferred-hangup window holds `on_call` in Redis while the row
    // still reads whatever it last mirrored. Rehydrating from the row put
    // `available` over the live lease and the next tick reserved an agent who was
    // already talking to a customer.
    const { runtime } = makeRuntime();
    await runtime.agents.set('s1', 'on_call', { attemptId: 'att-1', leaseMs: AGENT_LEASE_MS.on_call });

    const state = await runtime.rehydrateAgent('s1');

    expect(state).toBe('on_call');
    expect((await runtime.agents.get('s1'))?.state).toBe('on_call');
    // The attempt binding survived — it is what the state-matched lease renewal
    // and the eventual disposition both key off.
    expect((await runtime.agents.get('s1'))?.attemptId).toBe('att-1');
    expect(repos.session.setState, 'a live agent was mirrored as break').not.toHaveBeenCalled();
  });

  it('reads nothing from the durable row at all', async () => {
    // Acceptance (d), asserted as an absence rather than an outcome. Any future
    // "fall back to the row when Redis is empty" would satisfy the two tests
    // above for the restart case and still reintroduce the bug the moment the row
    // said `available`.
    const { runtime } = makeRuntime();
    const findById = vi.spyOn(repos.session, 'findById' as never);
    await runtime.rehydrateAgent('s1');
    expect(findById, 'rehydration read the durable session row').not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// The regression bar and the guard the window is NOT.
// ═══════════════════════════════════════════════════════════════════════════

describe('the owned browser dialer is untouched', () => {
  it('refuses to re-attach onto an owned browser leg', async () => {
    // The re-attach entry point takes no token. Letting it reach an owned call
    // would hand anyone who learned the correlation id a seat in the audio.
    const world = makeWorld();
    const { record } = await (world.bridge as any).placeOutboundLeg({
      tenantId: 't1', accountId: 'a1', callerId: '+14155550100',
      destinationPhone: '+14155550199', browserHangupOutcome: 'browser_hangup',
      agencyAttemptId: 'att-owned',
    });
    expect(world.bridge.getSession(record.id)!.browserWsOwned).toBe(true);
    expect(world.bridge.reattachBorrowedBrowserLeg('att-owned', new StationSocket() as any)).toBe(false);
  });
});

describe('the supersession guard is not the window ', () => {
  it('a superseded socket closing neither ends the call nor arms a window', async () => {
    // Two mechanisms that look alike and are not. This one resolves which of two
    // SIMULTANEOUSLY OPEN sockets owns the call; it says nothing about a socket
    // that is simply gone, which is every real network drop. A scenario that
    // conflates them passes while the wifi-blip requirement sits unimplemented.
    vi.useFakeTimers();
    const world = makeWorld();
    const first = new StationSocket();
    await attachStation(world.stations, 's1', first);
    await world.agents.set('s1', 'available', { leaseMs: AGENT_LEASE_MS.available });
    await dialAndBridge(world);

    // A reconnect that races the old socket's close: both are open at once.
    const second = new StationSocket();
    expect(world.bridge.reattachBorrowedBrowserLeg('att-1', second as any)).toBe(true);

    const session = world.bridge.getSession('call-1')!;
    first.drop();                       // the SUPERSEDED socket, now closing
    await Promise.resolve();

    expect(session.browserLegGraceArmed, 'a superseded close armed the window').toBe(false);
    await vi.advanceTimersByTimeAsync(DEFERRED_HANGUP_MS * 2);
    expect(world.bridge.getSession('call-1'), 'a superseded close ended the call').toBeDefined();

    // The CURRENT socket closing is the one that arms it.
    second.drop();
    await Promise.resolve();
    expect(session.browserLegGraceArmed, 'the current socket close did not arm the window').toBe(true);
  });

  it('a borrowed call with no grace supplied still hangs up on close, as before', async () => {
    // The bridge chooses nothing. A caller that asks for no window gets the
    // pre-C-07 behaviour byte for byte, which is what keeps this additive.
    const world = makeWorld();
    const ws = new StationSocket();
    await world.bridge.createBridgedCall({
      tenantId: 't1', accountId: 'a1', callerId: '+14155550100',
      destinationPhone: '+14155550199', campaignId: 'camp-1', agencyAttemptId: 'att-nograce',
      browserSocket: ws as any,
    });
    const session = world.bridge.getSession('call-1')!;
    ws.drop();
    await flush();

    expect(session.browserLegGraceArmed).toBe(false);
    expect(world.bridge.getSession('call-1'), 'a call with no grace was held open anyway').toBeUndefined();
  });
});
