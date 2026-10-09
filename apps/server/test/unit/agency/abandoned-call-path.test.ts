import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

// ---------------------------------------------------------------------------
// The abandoned-call path, end to end at the unit tier.
//
// **This file drives the REAL bridge**, for the same reason
// `presence-resilience.test.ts` does: every one of this
// ticket's acceptance criteria is a property of what reaches the CARRIER
// SOCKET, and a bridge double would let all four pass against a path that
// plays nothing. So the real `WebRtcBridgeManager`, the real `StationRegistry`,
// the real `AgentStateMachine` and the real pacer are wired together and driven
// from a station socket dropping mid-ring, which is the only route to an
// abandoned call under D1.
//
// The doubles are Redis, the announcement/audio repositories, and the clip
// cache — everything that would otherwise be disk or Postgres.
//
// Self-contained mock harness (project convention: no shared test utilities).
//
// The real bridge here dials VoiceLink. Harness notes:
//   - the answer: VoiceLink answers on the media WS's `start` frame (`answerCarrier`),
//     as the bridge suites do.
//   - the hangup: VoiceLink has no hangup API for an answered call — closing its media
//     WS is the hangup, and the row settles on the carrier's `call.ended`
//     (`confirmCarrierEnd`). So "the carrier leg was hung up" is asserted as the media
//     socket being closed (`hangupAt` is stamped there), not as `adapter.endCall`.
//   - the clip's wire format: VoiceLink `media` frames of A-law 8 kHz (160 bytes per
//     20 ms). Ten frames for the 200 ms clip.
//   - the apology is an UPLOADED clip (`type: 'audio'`, resolved through
//     `ensurePcmClip`): decision #4 has no TTS branch.
//   - "counts an answered call that NEVER BRIDGED, whatever the outcome says": on
//     VoiceLink every carrier-reported end of an answered call classifies
//     `completed`/`remote_hangup`, which the classifier's answered-unbridged arm already
//     reports as `abandoned`, so a carrier fault cannot produce the non-`abandoned` label
//     this case needs. The same shape is driven by a service-initiated teardown
//     (`service_shutdown` → `orphaned`); the property — the counter asks the predicate,
//     not the label — is asserted.
//   - harness: the bridge takes the guard-host stand-in the bridge suites use; the
//     metric reader is `test/helpers/otel-metric-reader.ts`, over a real
//     `@opentelemetry/sdk-metrics` provider (devDependency; `ScrapeMetricReader` inlined).
// ---------------------------------------------------------------------------

vi.mock('@magick-agency/observability', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
  createChildLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../../../src/config/index.js', () => ({
  config: {
    redis: { keyPrefix: '' },
    telephony: {
      voicelink: { webhookBaseUrl: 'https://server.test/api/v1/webhooks/voicelink' },
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
      // Returns the POST-bump budget (the our-fault ledger). A number, not undefined: the
      // dial path decides the retry from whatever this returns.
      chargeAttempt: vi.fn().mockResolvedValue(1),
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
  // `getWebrtcMaxDurationSeconds` (null ⇒ the bridge's 1800 default) —
  // the bridge reads the max duration from the account row here, not from a flag.
  accountSettingsRepository: {
    getAllowRecording: vi.fn().mockResolvedValue(null),
    getWebrtcMaxDurationSeconds: vi.fn().mockResolvedValue(null),
  },
}));

// ── The apology's own dependencies ─────────────────────────────────────────
const { announcements, audioFiles, ttsCache, pcmClip } = vi.hoisted(() => ({
  announcements: { findActiveByIdScoped: vi.fn() },
  audioFiles: { findById: vi.fn().mockResolvedValue(null) },
  ttsCache: { readTtsPcm: vi.fn() },
  // The uploaded clip's decode step (decision #4: no TTS synthesis).
  pcmClip: { ensurePcmClip: vi.fn().mockResolvedValue({ hash: 'apology-hash', sampleRate: 16000 }) },
}));
vi.mock('@magick-agency/db/repositories/announcement.repository', () => ({
  announcementRepository: announcements,
}));
vi.mock('@magick-agency/db/repositories/audio-file.repository', () => ({
  audioFileRepository: audioFiles,
}));
vi.mock('../../../src/tts/tts-file-cache.js', () => ttsCache);
// The uploaded clip resolves through `ensurePcmClip`, mocked here.
vi.mock('../../../src/audio/ensure-pcm-clip.js', () => pcmClip);

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
import { BreakRegistry } from '@magick-agency/domain/break-manager';
// The real meter provider, installed before `metrics.ts` creates its instruments:
// the claim is about the value an export (or a Prometheus scrape) would read.
const { reader } = await vi.hoisted(async () => {
  const { installMetricReader } = await import('../../helpers/otel-metric-reader.js');
  return { reader: installMetricReader() };
});
import { collectMetric } from '../../helpers/otel-metric-reader.js';
import type { DialCommand } from '../../../src/agency/dial-dispatcher.js';

/**
 * A counter series' live value, or undefined when absent.
 *
 * The real meter provider, deliberately — the abandonment counters are only
 * meaningful as numbers an export would read, and a mocked instrument cannot
 * show that a real abandoned call moved them.
 *
 * A cumulative OTel counter cannot be reset in-process, so each test takes a
 * {@link markBaseline} first and reads the increase since it: `undefined` means
 * the series did not move in this test (which, for these never-pre-zeroed
 * counters, is what "absent" used to mean after a registry reset).
 */
let baseline = new Map<string, number>();
const seriesKey = (name: string, attributes: Record<string, unknown>) =>
  `${name}|${JSON.stringify(Object.entries(attributes).sort())}`;
async function markBaseline(): Promise<void> {
  baseline = new Map();
  for (const name of ['agency_answered_total', 'agency_abandoned_total']) {
    for (const p of await collectMetric(reader, name)) baseline.set(seriesKey(name, p.attributes), p.value);
  }
}
async function counterValue(name: string, labels: Record<string, string>): Promise<number | undefined> {
  const point = (await collectMetric(reader, name)).find((p) =>
    Object.entries(labels).every(([k, val]) => p.attributes[k] === val));
  if (!point) return undefined;
  const moved = point.value - (baseline.get(seriesKey(name, point.attributes)) ?? 0);
  return moved > 0 ? moved : undefined;
}

// ─── Doubles ───────────────────────────────────────────────────────────────

class StationSocket extends EventEmitter {
  readyState = 1;
  readonly OPEN = 1;
  readonly frames: any[] = [];
  send(s: string): void { try { this.frames.push(JSON.parse(s)); } catch { /* binary */ } }
  close(): void { this.drop(); }
  /** What a network drop looks like: the socket dies and the event fires. */
  drop(): void { this.readyState = 3; this.emit('close'); }
  eventsNamed(name: string): any[] { return this.frames.filter((f) => f.event === name); }
}

/**
 * The carrier leg — the customer's ear.
 *
 * Every frame is stamped with the moment it arrived, because two of this
 * ticket's four criteria are about *when* audio reaches this socket relative to
 * the answer and to the hangup, and neither is observable from a bare count.
 */
class PstnSocket extends EventEmitter {
  readyState = 1;
  readonly OPEN = 1;
  readonly frames: Array<{ at: number; frame: any }> = [];
  /**
   * VoiceLink has no hangup API for an answered call — the bridge closes
   * this socket, and that IS the carrier hangup. So the hangup instant is stamped here.
   */
  closedAt: number | null = null;
  /** Frame counts are asserted against this, so a non-media frame can't inflate them. */
  get mediaFrames(): Array<{ at: number; frame: any }> {
    return this.frames.filter((f) => f.frame?.event === 'playAudio' || f.frame?.event === 'media');
  }
  bufferedAmount = 0;
  send(s: string): void {
    try { this.frames.push({ at: Date.now(), frame: JSON.parse(s) }); } catch { /* ignore */ }
  }
  close(): void {
    this.readyState = 3;
    this.closedAt ??= Date.now();
    hangupAt ??= this.closedAt;
  }
}

/**
 * The VoiceLink answer — the carrier's `start` frame negotiates media and
 * anchors the answer. Same frame the bridge suites send.
 */
function answerCarrier(world: { bridge: WebRtcBridgeManager }, pstn: PstnSocket): void {
  world.bridge.attachPstnLeg('call-1', pstn as any);
  pstn.emit('message', JSON.stringify({
    event: 'start',
    start: { call_sid: 'carrier-1', stream_sid: 'stream-1', media_format: { encoding: 'audio/alaw', sample_rate: '8000' } },
  }));
}

/**
 * An answered VoiceLink call settles on the carrier's `call.ended`, which
 * confirms the hangup the bridge issued by closing the media WS.
 */
async function confirmCarrierEnd(world: { bridge: WebRtcBridgeManager }): Promise<void> {
  await world.bridge.handleVoicelinkStatus('call-1', {
    providerCallId: 'carrier-1', callId: 'call-1', eventType: 'hangup', timestamp: new Date(),
    metadata: { event: 'call.ended', call: { id: 'carrier-1', status: 'ended' } },
  } as any);
}

/** In-memory Redis, enough for the agent state machine and ownership keys. */
class FakeRedis {
  private readonly hashes = new Map<string, Record<string, string>>();
  private readonly strings = new Map<string, string>();
  /**
   * `ioredis`'s Lua entry point, NOT JavaScript's `eval` — this is a method on a
   * test double that the agent state machine calls to run its CAS/RENEW scripts.
   * The script text is matched on with `includes()` and is never executed; no Lua
   * VM and no code evaluation is involved. Same double as
   * `presence-resilience.test.ts`.
   */
  async eval(script: string, _n: number, key: string, ...argv: string[]): Promise<number> {
    const h = this.hashes.get(key);
    if (script.includes('EXISTS')) return h && h.state === argv[0] ? 1 : 0;
    if (script.includes('HGET')) {
      if (!h || h.state !== argv[0]) return 0;
      this.hashes.set(key, { state: argv[1]!, attempt: argv[2] ?? '', since: argv[4] ?? '' });
      return 1;
    }
    this.hashes.set(key, { state: argv[0]!, attempt: argv[1] ?? '', since: argv[3] ?? '' });
    return 1;
  }
  async hgetall(key: string): Promise<Record<string, string>> { return this.hashes.get(key) ?? {}; }
  async set(key: string, value: string): Promise<'OK'> { this.strings.set(key, value); return 'OK'; }
  async get(key: string): Promise<string | null> { return this.strings.get(key) ?? null; }
  async del(key: string): Promise<number> {
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
    enter: vi.fn(async () => false), cancel: vi.fn(), force: vi.fn(async () => false),
    stateFor: vi.fn(() => null), noteDisposition: vi.fn(async () => false),
    stop: vi.fn(), active: vi.fn(() => 0),
  };
}

const CAMPAIGN = {
  id: 'camp-1', name: 'Q3 Renewals', tenant_id: 't1', account_id: 'a1',
  telephony_provider: 'voicelink', record_calls: false,
  analysis_profile_id: null, caller_ids: ['+14155550100'],
  disposition_catalog: [], wrapup_seconds: 0, wrapup_auto_return: true,
  abandon_announcement_id: 'ann-1',
} as any;

const CONTACT = {
  id: 'contact-1', phone_e164: '+919876543210',
  context: { 'First Name': 'Asha' }, attempt_count: 0,
} as any;

function makeCmd(campaign: any = CAMPAIGN): DialCommand {
  return {
    attemptId: 'att-1', campaignId: 'camp-1', contactId: 'contact-1',
    sessionId: 's1', ownerReplica: 'r1', tenantId: 't1', accountId: 'a1',
    callerId: '+14155550100', attemptNumber: 1,
    campaign, contact: CONTACT,
  };
}

function makeWorld() {
  const redis = new FakeRedis();
  // The bridge's first argument is the guard host (docs/seams.md); the same
  // stand-in shape the bridge suites pass.
  const bridge = new WebRtcBridgeManager(makeCallManager() as any, redis as any);
  const stations = new StationRegistry(redis as any, '', 'r1');
  const agents = new AgentStateMachine(redis as any, '');
  const dialer = new AgencyDialer(bridge as any, stations, agents, fakeWrapup() as any, new BreakRegistry());
  dialer.start();
  return { redis, bridge, stations, agents, dialer };
}

// ─── The clip ──────────────────────────────────────────────────────────────
//
// 3200 samples at 16 kHz is exactly **200 ms** of audio. On VoiceLink the bridge
// converts the clip to A-law 8 kHz and frames it at 20 ms, so the wire carries
// exactly **10 frames of 160 bytes**. Both numbers are derived from the clip
// rather than read off a run, which is what lets them falsify a change in
// framing or in playback.
const CLIP_SAMPLES = 3200;
const CLIP_MS = 200;
const EXPECTED_FRAMES = 10;

function apologyClip(): { pcm16: Buffer; sampleRate: number } {
  const pcm = new Int16Array(CLIP_SAMPLES);
  for (let i = 0; i < CLIP_SAMPLES; i++) pcm[i] = Math.round(6000 * Math.sin((2 * Math.PI * 440 * i) / 16000));
  return { pcm16: Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength), sampleRate: 16000 };
}

/** Drain the async teardown chain with macro ticks (real timers only). */
async function flush(times = 8): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((r) => setImmediate(r));
}

/**
 * Wait for a real condition against real timers.
 *
 * `setImmediate` ticks are NOT enough here and the difference is the point:
 * playback is paced with `setTimeout`, so a microtask/check-phase drain observes
 * exactly one frame and would have made every "the clip played" assertion below
 * pass against a clip that had barely started. Polling on the *terminal* event
 * rather than sleeping a guessed duration also means the test cannot pass because
 * it happened to wait long enough.
 */
async function waitUntil(pred: () => boolean, budgetMs = 4000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error('waitUntil: condition never became true');
    await new Promise((r) => setTimeout(r, 5));
  }
  await flush();
}

/**
 * Dial, lose the agent mid-ring, then have the carrier answer.
 *
 * The order is the scenario: the station socket dies while the phone is still
 * ringing, and the customer picks up afterwards. Nothing else reaches the
 * abandoned path under D1.
 */
async function loseAgentThenAnswer(world: ReturnType<typeof makeWorld>, campaign: any = CAMPAIGN) {
  const ws = new StationSocket();
  await world.stations.attach({
    sessionId: 's1', campaignId: 'camp-1', tenantId: 't1', accountId: 'a1',
    agentUserId: 'user-1', ws: ws as any,
  });
  // `reserved`, not `available` — `executeDial` is only ever reached through a
  // successful `reserve`, and it now extends that reservation with a CAS whose
  // failure aborts the dial. Seeding `available` left the harness one state behind
  // the precondition the method assumes, which passed only while the dialer
  // discarded the CAS result and would have dialled with no agent committed.
  await world.agents.set('s1', 'reserved', { attemptId: 'att-1', leaseMs: AGENT_LEASE_MS.reserved_predial });
  await world.dialer.executeDial(makeCmd(campaign));

  // The agent's laptop closes. The socket dies and the WS route detaches it —
  // this is the reserved-agent loss D1 leaves as the only route to abandonment.
  ws.drop();
  await world.stations.detach('s1', ws as any);
  expect(world.stations.isLocallyOwned('s1')).toBe(false);

  // The customer picks up: on VoiceLink the `start` frame is the answer (`answerCarrier`).
  const pstn = new PstnSocket();
  const answeredAt = Date.now();
  answerCarrier(world, pstn);
  // The bridge hangs up by closing the media WS, and the attempt settles on
  // the carrier's confirmation of it.
  await waitUntil(() => pstn.readyState === 3);
  await confirmCarrierEnd(world);
  // Settled = the attempt reached `ended`. Anchored on the attempt rather than on
  // the carrier hangup so the no-clip arms wait on the same condition.
  await waitUntil(() => repos.attempt.setState.mock.calls.some((c) => c[1] === 'ended'));
  return { ws, pstn, answeredAt };
}

/** The `setState` call that settled the attempt, if any. */
function endedWith(): Record<string, unknown> | undefined {
  const call = repos.attempt.setState.mock.calls.find((c) => c[1] === 'ended');
  return call?.[2] as Record<string, unknown> | undefined;
}

let seq = 0;
/** When the carrier leg was actually torn down. Null until it is. */
let hangupAt: number | null = null;

beforeEach(() => {
  vi.clearAllMocks();
  seq = 0;
  hangupAt = null;
  mockWebrtcRepo.create.mockImplementation(async (i: any) => ({
    id: `call-${++seq}`,
    tenant_id: i.tenant_id, account_id: i.account_id,
    caller_id: i.caller_id, destination_phone: i.destination_phone,
    provider: i.provider, status: 'initiating', provider_call_id: null,
    answered_at: null, ended_at: null, duration_seconds: null, talk_time_seconds: null,
    sip_connection_id: null,
    campaign_id: i.campaign_id ?? null, agency_attempt_id: i.agency_attempt_id ?? null,
  }));
  mockAdapter.initiateCall.mockResolvedValue({ providerCallId: 'pcid-1' });
  // `hangupAt` is stamped by `PstnSocket.close` (VoiceLink's hangup), so
  // `endCall` is a plain mock here.
  mockAdapter.endCall.mockResolvedValue(undefined);
  // An uploaded recording (decision #4), resolved through `ensurePcmClip`.
  announcements.findActiveByIdScoped.mockResolvedValue({
    id: 'ann-1', tenant_id: 't1', account_id: 'a1', name: 'Apology', type: 'audio',
    audio_file_id: 'af-1', is_active: true,
  });
  audioFiles.findById.mockResolvedValue({ id: 'af-1', s3_key: 'clips/af-1.wav' });
  pcmClip.ensurePcmClip.mockResolvedValue({ hash: 'apology-hash', sampleRate: 16000 });
  ttsCache.readTtsPcm.mockReturnValue(apologyClip());
});

afterEach(() => { vi.useRealTimers(); });

// ═══════════════════════════════════════════════════════════════════════════
// Acceptance (a) and (c): the sequence, and the outcome it settles under.
// ═══════════════════════════════════════════════════════════════════════════

describe('agent loss during ring produces exactly this sequence', () => {
  it('plays the apology to the carrier, hangs up, and settles `abandoned`', async () => {
    const world = makeWorld();
    const { pstn } = await loseAgentThenAnswer(world);

    // 1. The apology reached the CUSTOMER'S socket, in the carrier's own format.
    // VoiceLink's format — `media` frames of 20 ms A-law at 8 kHz.
    expect(pstn.mediaFrames.length).toBe(EXPECTED_FRAMES);
    expect(pstn.mediaFrames[0]!.frame).toMatchObject({
      event: 'media',
      media: { payload: expect.any(String) },
    });
    expect(Buffer.from(pstn.mediaFrames[0]!.frame.media.payload, 'base64').length).toBe(160);

    // 2. The carrier leg was hung up.
    // VoiceLink's hangup is closing its media WS (see `PstnSocket.closedAt`).
    expect(pstn.closedAt).not.toBeNull();

    // 3. `abandoned`, NOT `failed` and NOT `connected`. The classifier is handed
    //    the carrier's `answered` flag, which is TRUE here, so both the
    //    `completed` and `canceled` arms would otherwise return `connected` —
    //    reporting a call nobody spoke on as a successful conversation and
    //    zeroing the numerator C-06's compliance rate is computed from.
    expect(endedWith()).toMatchObject({ outcome: 'abandoned' });
  });

  it('does NOT bill or file the attempt as a conversation', async () => {
    const world = makeWorld();
    await loseAgentThenAnswer(world);

    // `connected` is what sends a contact to wrap-up and into the connect rate, and
    // it is the assertion this test is named for: an abandoned call must never be
    // filed as a conversation.
    const states = repos.contact.markState.mock.calls.map((c) => c[1]);
    expect(states).not.toContain('connected');
    // `pending`, not `completed`, since the our-fault ledger. The design is explicit
    // that an abandoned contact is *re-queued* per the `abandoned` retry policy —
    // which is the whole point: the customer picked up and reached nobody, so they
    // are owed another call, not written off. `completed` would be the honest
    // answer only if no retry engine existed.
    expect(states).toContain('pending');
    expect(states).not.toContain('completed');
  });

  it('writes `answered_at` on a call that never bridged — the abandonment-predicate falsifier', async () => {
    const world = makeWorld();
    await loseAgentThenAnswer(world);

    const answered = repos.attempt.setState.mock.calls.find((c) => c[1] === 'answered');
    expect(answered, 'no `answered` state was written, so the abandonment predicate has no numerator').toBeTruthy();
    expect(answered![2]).toMatchObject({ answered_at: expect.any(Date) });

    // And no `bridged` write at all. This is the whole point: an
    // abandoned call is the one shape where `answered_at` exists and
    // `bridged_at` does not, and it used to be unreachable because `answered_at`
    // was only ever written from `bridgedAt` on the bridged path — which made
    // the abandonment SQL predicate vacuous while returning 0 for months.
    expect(repos.attempt.setState.mock.calls.map((c) => c[1])).not.toContain('bridged');
  });

  it('tells the agent WHY, if their socket comes back to find the call gone', async () => {
    const world = makeWorld();
    await loseAgentThenAnswer(world);

    // The `released` frame could not be delivered — the socket that would have
    // received it is the one whose death caused the abandonment — so it is HELD
    // for the reconnect rather than dropped. An agent returning to an empty panel
    // with no account of the call they were on concludes the app is broken.
    // Asserted unconditionally: an `if (held)` here would pass on a build that
    // held nothing, which is the shape this assertion guards against.
    const held = world.dialer.takeMissedRelease('s1');
    expect(held).not.toBeNull();
    expect(held!.reason).toBe('abandoned');
    expect(held!.requires_disposition).toBe(false);
    // Consumed exactly once — a second reconnect must not replay it.
    expect(world.dialer.takeMissedRelease('s1')).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Acceptance (b) and (d): the clip is heard, not merely sent.
// ═══════════════════════════════════════════════════════════════════════════

describe('the clip plays to completion, and starts immediately', () => {
  it('sends every frame BEFORE the hangup, not alongside it', async () => {
    const world = makeWorld();
    const { pstn } = await loseAgentThenAnswer(world);

    // `hangupAt` is stamped inside the real carrier-teardown call, so this is the
    // criterion measured where it is consumed rather than at the send site.
    // On VoiceLink the carrier teardown is the media WS closing, so that is
    // where `hangupAt` is stamped.
    expect(pstn.closedAt).not.toBeNull();
    expect(hangupAt).not.toBeNull();
    expect(pstn.mediaFrames.length).toBe(EXPECTED_FRAMES);
    // Not one frame may be stamped at or after the hangup: a frame written after
    // the carrier leg is torn down is audio the customer never hears, which is
    // exactly how "we sent the whole apology" and "they heard the whole apology"
    // come apart.
    for (const f of pstn.mediaFrames) expect(f.at).toBeLessThanOrEqual(hangupAt!);
  });

  it('REGRESSION LOCK (do not prune): paces playback at real time instead of blasting it', async () => {
    // THE REGRESSION LOCK. The first implementation pushed the whole clip in one
    // synchronous loop and then slept for its duration. Every frame-count and
    // ordering assertion above passes against that — and the customer hears a
    // fragment, because a carrier's jitter buffer discards audio arriving faster
    // than it plays. The only observable difference is that a paced clip occupies
    // its own duration on the wire.
    const world = makeWorld();
    const { pstn } = await loseAgentThenAnswer(world);

    const first = pstn.mediaFrames[0]!.at;
    const last = pstn.mediaFrames[pstn.mediaFrames.length - 1]!.at;
    // 10 frames at 20ms: the last is scheduled 9 frames = 180ms after the first.
    // One frame of slack for scheduler jitter; a burst measures ~0.
    expect(last - first).toBeGreaterThanOrEqual(CLIP_MS - 2 * 20);
  });

  it('starts the apology before the customer can notice silence', async () => {
    const world = makeWorld();
    const { pstn, answeredAt } = await loseAgentThenAnswer(world);

    // (d): the only latency the customer may hear is the clip's own resolution.
    // Budgeted against the clip's own length rather than a bare `> 0` — the
    // failure this catches is a DB or S3 round trip landing ahead of the first
    // frame, which is a whole clip's worth of dead air, not a millisecond.
    expect(pstn.mediaFrames[0]!.at - answeredAt).toBeLessThan(CLIP_MS);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// The fail-quiet arms. The accounting is the mechanism; the clip is the courtesy.
// ═══════════════════════════════════════════════════════════════════════════

describe('every clip failure still settles the attempt `abandoned`', () => {
  it('hangs up bare when no apology is configured', async () => {
    const world = makeWorld();
    const { pstn } = await loseAgentThenAnswer(world, { ...CAMPAIGN, abandon_announcement_id: null });

    expect(announcements.findActiveByIdScoped).not.toHaveBeenCalled();
    expect(pstn.mediaFrames.length).toBe(0);
    expect(pstn.closedAt).not.toBeNull(); // VoiceLink's hangup
    // Unconfigured must never mean "the call stays open" or "the attempt stays
    // non-terminal" — the abandonment rate counts this call either way.
    expect(endedWith()).toMatchObject({ outcome: 'abandoned' });
  });

  it('hangs up bare when the clip is not on THIS replica’s disk', async () => {
    // The resolver hands back a hash and the bytes are missing locally — the
    // ordinary state of a replica that has never played this clip. `false` from
    // the bridge obliges the caller to hang up by its own route.
    const world = makeWorld();
    ttsCache.readTtsPcm.mockReturnValue(null);
    const { pstn } = await loseAgentThenAnswer(world);

    expect(pstn.mediaFrames.length).toBe(0);
    expect(pstn.closedAt).not.toBeNull(); // VoiceLink's hangup
    expect(endedWith()).toMatchObject({ outcome: 'abandoned' });
  });

  it('hangs up bare when the announcement was deleted OR belongs to another account', async () => {
    // One test for both because the scoped lookup deliberately cannot tell them
    // apart, and must not: confirming that another tenant's announcement exists is
    // itself a leak. Either way the customer gets silence and a clean hangup.
    const world = makeWorld();
    announcements.findActiveByIdScoped.mockResolvedValue(null);
    const { pstn } = await loseAgentThenAnswer(world);

    expect(pstn.mediaFrames.length).toBe(0);
    expect(endedWith()).toMatchObject({ outcome: 'abandoned' });
  });

  it('scopes the dial-time lookup to the campaign’s own tenancy', async () => {
    // Consumer-side check: the scope has to be threaded by the DIALER, not
    // merely accepted by the resolver. A resolver with a mandatory scope parameter
    // that the one real caller fills in from the wrong place is no protection.
    const world = makeWorld();
    await loseAgentThenAnswer(world, {
      ...CAMPAIGN, tenant_id: 't-owner', account_id: 'a-owner', abandon_announcement_id: 'ann-1',
    });

    expect(announcements.findActiveByIdScoped).toHaveBeenCalledWith('ann-1', 't-owner', 'a-owner');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// The abandonment counters, asserted where they are INCREMENTED rather than where
// they are declared. `metrics.test.ts` pins the names; only this file can show
// that a real abandoned call moves them.
// ═══════════════════════════════════════════════════════════════════════════

describe('the counters move on a real abandoned call', () => {
  it('counts the call in BOTH the numerator and the denominator', async () => {
    await markBaseline();
    const world = makeWorld();
    await loseAgentThenAnswer(world);

    const labels = { tenant_id: 't1', campaign_id: 'camp-1' };
    // The denominator must include the abandoned call. Counting answers on the
    // `bridged` phase instead would exclude every abandoned call from the
    // denominator and understate the compliance rate — in the safe-looking
    // direction, which is the one nobody checks.
    expect(await counterValue('agency_answered_total', labels)).toBe(1);
    expect(await counterValue('agency_abandoned_total', labels)).toBe(1);
  });

  it('counts a CONNECTED call in the denominator only', async () => {
    // The rate's whole meaning depends on this asymmetry. If `agency_abandoned_total`
    // moved here the rate would read 100% on a perfectly healthy campaign.
    await markBaseline();
    const world = makeWorld();
    const ws = new StationSocket();
    await world.stations.attach({
      sessionId: 's1', campaignId: 'camp-1', tenantId: 't1', accountId: 'a1',
      agentUserId: 'user-1', ws: ws as any,
    });
    await world.agents.set('s1', 'reserved', { attemptId: 'att-1', leaseMs: AGENT_LEASE_MS.reserved_predial });
    await world.dialer.executeDial(makeCmd());
    answerCarrier(world, new PstnSocket()); // VoiceLink answers on `start`
    await flush(30);

    const labels = { tenant_id: 't1', campaign_id: 'camp-1' };
    expect(await counterValue('agency_answered_total', labels)).toBe(1);
    expect(await counterValue('agency_abandoned_total', labels)).toBeUndefined();
  });

  it('counts an answered call that NEVER BRIDGED, whatever the outcome says', async () => {
    // ─── The abandonment-counter fix, at the unit tier ─────────────────────
    //
    // The scenario the integration tier encodes as a standing failure
    // (`abandonment-counter-vs-table.test.ts`): the customer picks up, the media
    // legs never join, and the attempt settles under some outcome OTHER than
    // `abandoned` — here because the agent's socket died in the window between
    // answer and bridge, so `StationRegistry` still owns the session (nothing has
    // detached it yet) and `abandonAnsweredCall` never runs.
    //
    // By the ratified definition this call IS abandoned: a customer answered and
    // reached nobody. The counter used to key on the classifier's LABEL, so it saw
    // none of these — under-reporting in the direction that reads compliant.
    await markBaseline();
    const world = makeWorld();
    const ws = new StationSocket();
    await world.stations.attach({
      sessionId: 's1', campaignId: 'camp-1', tenantId: 't1', accountId: 'a1',
      agentUserId: 'user-1', ws: ws as any,
    });
    await world.agents.set('s1', 'reserved', { attemptId: 'att-1', leaseMs: AGENT_LEASE_MS.reserved_predial });
    await world.dialer.executeDial(makeCmd());

    // The browser leg's socket is dead but NOTHING has observed it: no `close`
    // event, no detach. That is the answer/bridge race, and it is why the station
    // is still locally owned below — the abandoned path is not what settles this.
    ws.readyState = 3;
    expect(world.stations.isLocallyOwned('s1')).toBe(true);

    // The customer picks up. `bothLegsConnected` is false, so no `bridged` is ever
    // emitted — the shape the predicate is about.
    answerCarrier(world, new PstnSocket()); // VoiceLink answers on `start`
    await flush(20);
    // Then the carrier reports a fault and the attempt settles.
    // VoiceLink classifies every carrier-reported end of an answered call as
    // `completed`/`remote_hangup`, which the classifier already labels `abandoned` when
    // unbridged — so a carrier fault cannot produce a non-`abandoned` outcome here. A
    // service-initiated teardown (a deploy landing on this call) does: `service_shutdown`
    // → `orphaned`. The bridge closes the media WS and settles on `call.ended`.
    await world.bridge.forceEndWithOutcome('att-1', 'service_shutdown');
    await confirmCarrierEnd(world);
    await waitUntil(() => repos.attempt.setState.mock.calls.some((c) => c[1] === 'ended'));

    const states = repos.attempt.setState.mock.calls.map((c) => c[1]);
    expect(states).toContain('answered');
    // The row's shape, asserted so this test cannot pass on a run where the bridge
    // happened to emit `bridged` — which would make the predicate's arm vacuous.
    expect(states).not.toContain('bridged');

    // THE OUTCOME WRITE IS UNCHANGED, and that is half the decision: relabelling
    // this `abandoned` would hand the contact the wrong retry policy and tell the
    // agent their own dropped socket "could not be connected to you".
    // `orphaned` — see the teardown above.
    expect(endedWith()).toMatchObject({ outcome: 'orphaned' });

    // And the counter still sees it, because it now asks the table's question.
    const labels = { tenant_id: 't1', campaign_id: 'camp-1' };
    expect(await counterValue('agency_answered_total', labels)).toBe(1);
    expect(
      await counterValue('agency_abandoned_total', labels),
      'the counter is keyed on the classifier label again, so every '
      + 'answered-but-unbridged call that failed for another reason is invisible',
    ).toBe(1);
  });

  it('does not count an UNANSWERED call in the denominator', async () => {
    // Billing and compliance both anchor on the carrier answer. A call that rang
    // out has no bearing on the abandonment rate and must not dilute it — an
    // inflated denominator is how a real breach gets averaged away.
    await markBaseline();
    const world = makeWorld();
    const ws = new StationSocket();
    await world.stations.attach({
      sessionId: 's1', campaignId: 'camp-1', tenantId: 't1', accountId: 'a1',
      agentUserId: 'user-1', ws: ws as any,
    });
    await world.agents.set('s1', 'reserved', { attemptId: 'att-1', leaseMs: AGENT_LEASE_MS.reserved_predial });
    await world.dialer.executeDial(makeCmd());
    // No PSTN leg ever attaches: nobody picked up.
    await flush(10);

    expect(await counterValue('agency_answered_total', { tenant_id: 't1', campaign_id: 'camp-1' }))
      .toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// The negative control. Without this, everything above could be firing on
// every answered call in the system.
// ═══════════════════════════════════════════════════════════════════════════

describe('a call whose agent IS present is never abandoned', () => {
  it('plays no clip and does not hang up when the station is still owned', async () => {
    const world = makeWorld();
    const ws = new StationSocket();
    await world.stations.attach({
      sessionId: 's1', campaignId: 'camp-1', tenantId: 't1', accountId: 'a1',
      agentUserId: 'user-1', ws: ws as any,
    });
    await world.agents.set('s1', 'reserved', { attemptId: 'att-1', leaseMs: AGENT_LEASE_MS.reserved_predial });
    await world.dialer.executeDial(makeCmd());

    const pstn = new PstnSocket();
    answerCarrier(world, pstn); // VoiceLink answers on `start`
    await flush(30);

    // No apology, no teardown, and the attempt is bridged rather than settled.
    expect(announcements.findActiveByIdScoped).not.toHaveBeenCalled();
    expect(pstn.mediaFrames.length).toBe(0);
    expect(mockAdapter.endCall).not.toHaveBeenCalled();
    expect(pstn.closedAt).toBeNull(); // VoiceLink's hangup would close the media WS
    expect(endedWith()).toBeUndefined();
    expect(repos.attempt.setState.mock.calls.map((c) => c[1])).toContain('bridged');
    expect(ws.eventsNamed('bridged').length).toBe(1);
  });
});
