import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// PORT NOTE (magick-agency): ported from core test/unit/core/webrtc-scenarios.test.ts@4850d1d9
// (15 cases, `it.each` rows expanded → 13). Mock specifiers follow the new paths (logger →
// @magick-agency/observability, webrtc-call repository → @magick-agency/db agency-call
// repository, account settings → the @magick-agency/db repository, whose
// `getWebrtcMaxDurationSeconds` replaces the `webrtc_max_duration_seconds` flag mock: null = 1800);
// the settlement-dispatcher and feature-flag mocks are gone (no longer imported).
//
// FIXTURE (every surviving case): core drove these scenarios through the softphone
// (`createCall` + the owned `attachBrowserLeg`, both deleted) on VoBiz (`handleVobizStatus` /
// `handleVobizAnswer`, deleted). Here a call is dialled through the agency entry point
// `createBridgedCall` with the browser socket borrowed at dial time (the fake gains `off`), or
// `createUnboundBridgedCall` where core's browser "never attaches"; carrier progress is VoiceLink's
// (`handleVoicelinkStatus` `ringing` / `answer` / `hangup`, plus the `start` frame that opens its
// relay); `forceEndByUser(callId)` (deleted) is `forceEndWithOutcome('att-1', 'ended_by_user')`.
// Settlement assertions are removed (agency never settles, plan §9) and `triggerDequeue`
// assertions are removed (the bridge no longer calls it); where a case needed a replacement it is
// named below.
//
// DELETED (2):
//  - 'a single end path calls triggerDequeue() once' — `triggerDequeue` (core's AI SQS queue) is
//    removed from the bridge; the case asserts nothing else.
//  - 'Scenario R5: manager teardown is recording-URL-independent — a recorded call ends/settles
//    even though the manager never persists a recording URL' — its premise is false on VoiceLink:
//    the bridge persists the carrier's recording URL from `call.ended` (covered by
//    webrtc-bridge-manager.test.ts's late `call.completed` recording cases).
//
// MODIFIED (13, every surviving case; each beyond the FIXTURE above):
//  - 'drives the full chain with status transitions, relay, settlement, slot release, analytics' —
//    no browser token is minted for a borrowed leg (assertion dropped); the relay is VoiceLink's
//    transcoded `media` frames (core asserted VoBiz's verbatim L16 `playAudio` of a 4-char
//    payload): a real 20ms frame goes each way and exactly one frame must come out, of the
//    transcoded length (A-law 120-160 B, PCM16 480-640 B) and not silent; the answered
//    VoiceLink hangup defers to the carrier's `call.ended`, which is driven; the carrier leg is torn
//    down by closing the PSTN socket (VoiceLink's only hangup) rather than `adapter.endCall`;
//    settlement → the terminal row (completed, talk 42) and `trackWebrtcCallCompleted`.
//  - 'PSTN answers but browser never attaches → max-duration callback ends + hangs up provider' —
//    `createUnboundBridgedCall` (no browser leg); answered by the `start` frame; the max-duration
//    hangup of an answered VoiceLink call closes the PSTN socket and finalizes on the 45s
//    confirmation timeout (the pending timers are run), so "hangs up provider" is the PSTN socket
//    closing rather than `adapter.endCall`; settlement → terminal row + analytics.
//  - 'after answer, a {event:stop} on the PSTN leg tears the call down' — answered by the VoiceLink
//    `answer` webhook + `start` frame; settlement → `trackWebrtcCallCompleted` (completed).
//  - 'settles, releases slots, hangs up provider, and removes the session for an answered call' —
//    answered by the VoiceLink `answer` webhook; settlement → `trackWebrtcCallCompleted` (already
//    asserted).
//  - 'browser close + carrier hangup → exactly one settlement / one slot release' — the borrowed
//    socket's close defers (answered VoiceLink), and the carrier `call.ended` is the confirmation
//    that finalizes; "one settlement" → exactly one terminal row write (`ended_at`), alongside the
//    release / analytics counts core already asserted.
//  - 'forceEndByUser twice → second is a no-op (session already gone)' — still answered (by the
//    VoiceLink `answer` webhook), but an answered VoiceLink hangup holds the session in `ending`
//    until the carrier confirms, so the carrier's `call.ended` is driven between the two calls
//    (and the session asserted gone) before the second, which then returns false as core's did.
//    Settlement → `trackWebrtcCallCompleted` once.
//  - 'rawCallStatus no-answer → status no_answer, connected=false', 'rawCallStatus busy → status
//    busy, connected=false', 'rawCallStatus cancel → status canceled, connected=false' (the
//    `it.each` rows) — the raw status rides VoiceLink's terminal webhook (`call.ended` with
//    `call.callStatus`, classified by `classifyVoicelinkOutcome`, which maps the three to the same
//    statuses) instead of VoBiz's `rawCallStatus`; settlement → the terminal row (status, talk 0).
//  - 'Scenario R1: full recorded-call happy path — record:true threads <Record> opts yet
//    end/settlement/slots are unchanged' → retitled 'Scenario R1: full recorded-call happy path —
//    record:true sets the dial request's enableRecording yet end/slots are unchanged', and
//    'Scenario R2: non-recorded call — record omitted leaves <Record> opts off but the lifecycle
//    still settles' → retitled 'Scenario R2: non-recorded call — record omitted leaves the dial
//    request's enableRecording off but the lifecycle still ends' (titles follow the assertions:
//    no <Record> options and no settlement on agency) — the recording wiring is the dial request's
//    `enableRecording` / `maxDuration` (core: the answer XML's `enableRecording` /
//    `recordingCallbackUrl` / `recordingMaxLengthSeconds`; VoiceLink has no recording callback
//    URL); the answered hangup is confirmed by the carrier's `call.ended`; R1's relay uses the
//    real-frame check below and its browser token assertion is dropped (borrowed leg);
//    settlement and `triggerDequeue` → the terminal row (completed, talk 30 / 12) and
//    `trackWebrtcCallCompleted`; R1's `endCall('pcid-1')` → the PSTN socket closing.
//  - 'Scenario R3: …' — the busy hangup is VoiceLink's pre-answer `call.ended` with
//    `callStatus: 'BUSY'`; settlement → the terminal row (busy, talk 0). Its "no <Record> XML"
//    assertion is kept but holds by construction (VoiceLink never renders answer XML).
//  - 'Scenario R4: max-duration override flows into the recording cap (3600 instead of 1800)' — the
//    override comes from `account_settings.webrtc_max_duration_seconds` (plan §3.2) instead of the
//    flag; VoiceLink's recording cap is the dial request (`maxDuration` + `enableRecording`), not the
//    VoBiz answer XML's `<Record>` options.

// ---------------------------------------------------------------------------
// Multi-step lifecycle scenarios over the REAL WebRtcBridgeManager.
// Mock harness copied from webrtc-bridge-manager.test.ts (project convention:
// no shared test utilities, vi.hoisted mocks, .js import extensions).
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
      plivo: { webhookBaseUrl: 'https://core.test/api/v1/webhooks/plivo' },
      // PORT NOTE: the bridge reads VoiceLink's base (the default provider is now VoiceLink).
      voicelink: { webhookBaseUrl: 'https://core.test/api/v1/webhooks/voicelink' },
    },
  },
}));

const { mockRepo } = vi.hoisted(() => ({
  mockRepo: {
    create: vi.fn(),
    findById: vi.fn().mockResolvedValue(null),
    update: vi.fn().mockResolvedValue(null),
  },
}));
vi.mock('@magick-agency/db/repositories/agency-call.repository', () => ({
  webrtcCallRepository: mockRepo,
}));
// Governance recording ceiling read in createCall; null ⇒ inherit true (no ceiling).
// PORT NOTE: the max duration is read here too (null ⇒ the 1800 default).
const { mockAccountSettings } = vi.hoisted(() => ({
  mockAccountSettings: {
    getAllowRecording: vi.fn().mockResolvedValue(null),
    getWebrtcMaxDurationSeconds: vi.fn().mockResolvedValue(null),
  },
}));
vi.mock('@magick-agency/db/repositories/account-settings.repository', () => ({
  accountSettingsRepository: mockAccountSettings,
}));

const { mockAdapter } = vi.hoisted(() => ({
  mockAdapter: {
    initiateCall: vi.fn().mockResolvedValue({ providerCallId: 'pcid-1' }),
    endCall: vi.fn().mockResolvedValue(undefined),
    generateAnswerResponse: vi.fn().mockReturnValue('<Response><Stream/></Response>'),
  },
}));
vi.mock('../../../src/telephony/factory.js', () => ({
  TelephonyProviderRegistry: class {
    get() {
      return mockAdapter;
    }
  },
}));

const { mockAuditLogger } = vi.hoisted(() => ({ mockAuditLogger: { log: vi.fn() } }));
vi.mock('../../../src/audit/audit-logger.js', () => ({
  auditLogger: mockAuditLogger,
}));

const { mockAnalytics } = vi.hoisted(() => ({
  mockAnalytics: {
    trackWebrtcCallInitiated: vi.fn(),
    trackWebrtcCallRejected: vi.fn(),
    trackWebrtcCallCompleted: vi.fn(),
  },
}));
vi.mock('../../../src/analytics/posthog.js', () => mockAnalytics);

import { WebRtcBridgeManager } from '../../../src/core/webrtc-bridge-manager.js';
import { encodeAlaw, decodeAlaw } from '../../../src/utils/audio.js';

// ── Fake WebSocket ───────────────────────────────────────────────────────
// PORT NOTE: `off` added — a borrowed socket's listeners are removed at detach.
function fakeWs() {
  const handlers: Record<string, ((...a: any[]) => void)[]> = {};
  return {
    readyState: 1,
    OPEN: 1,
    sent: [] as any[],
    send(s: string) { this.sent.push(JSON.parse(s)); },
    on(ev: string, cb: (...a: any[]) => void) { (handlers[ev] ||= []).push(cb); },
    off(ev: string, cb: (...a: any[]) => void) {
      const list = handlers[ev];
      if (!list) return;
      const i = list.indexOf(cb);
      if (i >= 0) list.splice(i, 1);
    },
    emit(ev: string, ...a: any[]) { (handlers[ev] || []).slice().forEach((cb) => cb(...a)); },
    close() { this.readyState = 3; },
  };
}

function makeCallManager() {
  return {
    concurrencyGuard: {
      tryAcquire: vi.fn().mockResolvedValue(true),
      release: vi.fn().mockResolvedValue(undefined),
    },
    accountConcurrencyGuard: {
      tryAcquire: vi.fn().mockResolvedValue(true),
      release: vi.fn().mockResolvedValue(undefined),
    },
    triggerDequeue: vi.fn(),
    wakeSelfHeal: vi.fn(),
  };
}

const PARAMS = {
  tenantId: 't1',
  accountId: 'a1',
  callerId: '+14155550100',
  destinationPhone: '+14155550199',
};
/** PORT NOTE: the agency back-references every bridge call carries. */
const AGENCY = { campaignId: 'camp-1', agencyAttemptId: 'att-1' };

// PORT NOTE: `as any` (type-only) — this tsconfig typechecks tests; `eventType` is a string here.
const ev = (eventType: string, metadata: Record<string, unknown> = {}) => ({
  providerCallId: 'pcid-1',
  callId: 'call-1',
  eventType,
  timestamp: new Date(),
  metadata,
}) as any;

/** PORT NOTE: VoiceLink webhook bodies (the parser spreads the raw body into `metadata`). */
const VL_RINGING = { event: 'call.ringing', call: { id: 'pcid-1', status: 'ringing' } };
const VL_ANSWERED = { event: 'call.answered', call: { id: 'pcid-1', status: 'answered' } };
const VL_ENDED = { event: 'call.ended', call: { id: 'pcid-1', status: 'ended' } };

/** PORT NOTE: VoiceLink's A-law 8kHz `start` frame — negotiates media and opens the relay. */
function negotiateVoicelink(pstn: ReturnType<typeof fakeWs>): void {
  pstn.emit('message', JSON.stringify({
    event: 'start',
    start: { call_sid: 'pcid-1', stream_sid: 's1', media_format: { encoding: 'audio/alaw', sample_rate: '8000' } },
  }));
}

/**
 * PORT NOTE: real 20ms frames for the relay checks. Core relayed VoBiz's L16 verbatim, so a
 * 4-char payload proved the relay; VoiceLink transcodes (PCM16 16k ⇄ A-law 8k), so the frames
 * must be real audio for the output length and level to mean anything.
 */
function pcm16kFrame(): string {
  const pcm = new Int16Array(320); // 20ms @16k = 640 bytes
  for (let i = 0; i < pcm.length; i++) pcm[i] = Math.round(8000 * Math.sin((2 * Math.PI * 1000 * i) / 16000));
  return Buffer.from(pcm.buffer).toString('base64');
}
function alaw8kFrame(): string {
  const pcm = new Int16Array(160); // 20ms @8k = 160 A-law bytes
  for (let i = 0; i < pcm.length; i++) pcm[i] = Math.round(8000 * Math.sin((2 * Math.PI * 1000 * i) / 8000));
  return encodeAlaw(pcm).toString('base64');
}
function peak(samples: ArrayLike<number>): number {
  let p = 0;
  for (let i = 0; i < samples.length; i++) p = Math.max(p, Math.abs(samples[i]!));
  return p;
}
/**
 * Relay one real frame each way and assert exactly one non-silent, correctly-sized frame came
 * out the other side (bounds as webrtc-bridge-manager.test.ts: first-frame FIR warm-up shortens
 * the output, never lengthens it).
 */
function expectRelaysBothWays(browser: ReturnType<typeof fakeWs>, pstn: ReturnType<typeof fakeWs>): void {
  const toPstn = pstn.sent.filter((m) => m.event === 'media').length;
  browser.emit('message', JSON.stringify({ event: 'media', media: { payload: pcm16kFrame() } }));
  const b2p = pstn.sent.filter((m) => m.event === 'media');
  expect(b2p).toHaveLength(toPstn + 1);
  const alaw = Buffer.from(b2p.at(-1).media.payload, 'base64');
  expect(alaw.length).toBeGreaterThan(120);
  expect(alaw.length).toBeLessThanOrEqual(160);
  expect(peak(decodeAlaw(alaw))).toBeGreaterThan(6400);

  const toBrowser = browser.sent.filter((m) => m.event === 'media').length;
  pstn.emit('message', JSON.stringify({ event: 'media', media: { payload: alaw8kFrame() } }));
  const p2b = browser.sent.filter((m) => m.event === 'media');
  expect(p2b).toHaveLength(toBrowser + 1);
  const pcm = Buffer.from(p2b.at(-1).media.payload, 'base64');
  expect(pcm.length).toBeGreaterThan(480);
  expect(pcm.length).toBeLessThanOrEqual(640);
  expect(peak(new Int16Array(pcm.buffer, pcm.byteOffset, pcm.byteLength / 2))).toBeGreaterThan(6400);
}

/** PORT NOTE: core's `forceEndByUser(callId)` — the same `localHangup`, keyed on the attempt. */
const endByUser = (mgr: WebRtcBridgeManager) => mgr.forceEndWithOutcome('att-1', 'ended_by_user');

beforeEach(() => {
  vi.clearAllMocks();
  mockRepo.create.mockImplementation(async (i: any) => ({
    id: 'call-1',
    tenant_id: i.tenant_id,
    account_id: i.account_id,
    caller_id: i.caller_id,
    destination_phone: i.destination_phone,
    provider: i.provider,
    status: 'initiating',
    provider_call_id: null,
    answered_at: null,
    ended_at: null,
    duration_seconds: null,
    talk_time_seconds: null,
    campaign_id: i.campaign_id ?? null,
    agency_attempt_id: i.agency_attempt_id ?? null,
  }));
  mockAdapter.initiateCall.mockResolvedValue({ providerCallId: 'pcid-1' });
  mockAccountSettings.getWebrtcMaxDurationSeconds.mockResolvedValue(null);
});

afterEach(() => {
  // ensure no scenario leaves real fake-timer state set
  vi.useRealTimers();
});

const lastUpdate = () => mockRepo.update.mock.calls.at(-1)![1];
const updateStatuses = () => mockRepo.update.mock.calls.map((c) => c[1]?.status).filter(Boolean);

// ───────────────────────────────────────────────────────────────────────────
// Scenario 1 — Happy path end-to-end
// ───────────────────────────────────────────────────────────────────────────
describe('Scenario: happy path (ring → answer → bridge → user hangup)', () => {
  it('drives the full chain with status transitions, relay, settlement, slot release, analytics', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-24T00:00:00.000Z'));
    const cm = makeCallManager();
    const mgr = new WebRtcBridgeManager(cm as any, null);

    // PORT NOTE: borrowed browser socket at dial time; no browser token is minted for it.
    const browser = fakeWs();
    const record = await mgr.createBridgedCall({ ...PARAMS, ...AGENCY, browserSocket: browser as any });
    expect(record.id).toBe('call-1');
    expect(mgr.getSession('call-1')!.status).toBe('initiating');

    // 1. ringing
    await mgr.handleVoicelinkStatus('call-1', ev('ringing', VL_RINGING));
    expect(mgr.getSession('call-1')!.status).toBe('ringing');
    expect(browser.sent).toContainEqual({ event: 'status', status: 'ringing' });

    // 2. answer
    // PORT NOTE: VoiceLink has no answer XML; `answer` arrives as a status event.
    await mgr.handleVoicelinkStatus('call-1', ev('answer', VL_ANSWERED));
    const session = mgr.getSession('call-1')!;
    expect(session.status).toBe('in_progress');
    expect(session.answeredAt).not.toBeNull();
    expect(browser.sent).toContainEqual({ event: 'status', status: 'answered' });

    // 3. attach PSTN leg (both legs now connected)
    const pstn = fakeWs();
    mgr.attachPstnLeg('call-1', pstn as any);
    negotiateVoicelink(pstn); // PORT NOTE: VoiceLink media is ready only after `start`.
    expect(session.bothLegsConnected).toBe(true);
    expect(browser.sent).toContainEqual({ event: 'status', status: 'in_progress' });

    // 4. relay both directions
    // PORT NOTE: core asserted VoBiz's verbatim L16 frames; VoiceLink transcodes both ways, so
    // a real 20ms frame goes in and one correctly-sized, non-silent frame must come out.
    expectRelaysBothWays(browser, pstn);

    // 5. talk for 42 seconds, then user hangs up
    vi.advanceTimersByTime(42_000);
    const ended = await endByUser(mgr);
    expect(ended).toBe(true);
    // PORT NOTE: an answered VoiceLink hangup settles on the carrier's `call.ended`.
    await mgr.handleVoicelinkStatus('call-1', ev('hangup', VL_ENDED));

    // terminal status persisted as completed with talk_time>0
    expect(updateStatuses()).toContain('completed');
    expect(lastUpdate().talk_time_seconds).toBe(42);

    // PORT NOTE: core asserted the settlement dispatch here (agency never settles); the
    // terminal row above and the analytics event below carry the same facts.

    // slots released once each
    expect(cm.concurrencyGuard.release).toHaveBeenCalledTimes(1);
    expect(cm.accountConcurrencyGuard.release).toHaveBeenCalledTimes(1);

    // analytics: completed, connected, ended_by=user
    expect(mockAnalytics.trackWebrtcCallCompleted).toHaveBeenCalledWith(expect.objectContaining({
      status: 'completed', connected: true, endedBy: 'user', talkTimeSeconds: 42,
    }));

    // browser notified of end + carrier leg hung up
    expect(browser.sent).toContainEqual({ event: 'ended', reason: 'ended_by_user' });
    // PORT NOTE: VoiceLink's only hangup is closing the provider WS (core: `endCall('pcid-1')`).
    expect(pstn.readyState).toBe(3);

    // audit trail: initiating + ended
    const auditEvents = mockAuditLogger.log.mock.calls.map((c) => c[0].eventType);
    expect(auditEvents).toContain('webrtc_call.initiating');
    expect(auditEvents).toContain('webrtc_call.ended');

    expect(mgr.getSession('call-1')).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0); // max-duration timer cleared
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Scenario 2 — No-answer / busy / cancel before answer
// ───────────────────────────────────────────────────────────────────────────
describe('Scenario: carrier hangup before answer', () => {
  it.each([
    ['no-answer', 'no_answer'],
    ['busy', 'busy'],
    ['cancel', 'canceled'],
  ])('rawCallStatus %s → status %s, connected=false', async (raw, expectedStatus) => {
    const cm = makeCallManager();
    const mgr = new WebRtcBridgeManager(cm as any, null);
    await mgr.createBridgedCall({ ...PARAMS, ...AGENCY, browserSocket: fakeWs() as any });
    await mgr.handleVoicelinkStatus('call-1', ev('ringing', VL_RINGING));
    // carrier hangup BEFORE any answer
    // PORT NOTE: VoiceLink's terminal webhook carrying the raw status (core: VoBiz `rawCallStatus`).
    await mgr.handleVoicelinkStatus('call-1', ev('hangup', {
      event: 'call.ended', call: { id: 'pcid-1', callStatus: raw },
    }));

    expect(updateStatuses()).toContain(expectedStatus);
    // PORT NOTE: core asserted the settlement dispatch (status, talk_time_seconds: 0); agency
    // never settles, and the terminal row carries the same two facts.
    expect(lastUpdate()).toMatchObject({ status: expectedStatus, talk_time_seconds: 0 });
    expect(mockAnalytics.trackWebrtcCallCompleted).toHaveBeenCalledWith(expect.objectContaining({
      status: expectedStatus, connected: false,
    }));
    expect(cm.concurrencyGuard.release).toHaveBeenCalledTimes(1);
    expect(cm.accountConcurrencyGuard.release).toHaveBeenCalledTimes(1);
    expect(mgr.getSession('call-1')).toBeUndefined();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Scenario 3 — PSTN answers, browser never attaches, max-duration fires
// ───────────────────────────────────────────────────────────────────────────
describe('Scenario: max-duration guard ends a one-legged call', () => {
  it('PSTN answers but browser never attaches → max-duration callback ends + hangs up provider', async () => {
    vi.useFakeTimers();
    const cm = makeCallManager();
    const mgr = new WebRtcBridgeManager(cm as any, null);
    // PORT NOTE: an unbound dial is the "browser never attaches" call.
    await mgr.createUnboundBridgedCall({ ...PARAMS, ...AGENCY }); // arms a 1800s max-duration timer

    const pstn = fakeWs();
    mgr.attachPstnLeg('call-1', pstn as any);
    negotiateVoicelink(pstn); // PORT NOTE: the VoiceLink answer anchor.
    const session = mgr.getSession('call-1')!;
    expect(session.bothLegsConnected).toBe(false); // no browser leg
    expect(session.answeredAt).not.toBeNull();

    // advance past the 1800s max-duration window
    await vi.advanceTimersByTimeAsync(1_800_000);

    // the max-duration callback runs endCall as fire-and-forget; allow microtasks
    // PORT NOTE: on VoiceLink it closes the PSTN leg and arms the 45s carrier-confirmation
    // fallback; running the pending timers fires that and finalizes.
    await vi.runOnlyPendingTimersAsync();

    expect(mgr.getSession('call-1')).toBeUndefined();
    expect(updateStatuses()).toContain('completed'); // answered → completed
    expect(mockAnalytics.trackWebrtcCallCompleted).toHaveBeenCalledWith(expect.objectContaining({
      status: 'completed', endedBy: 'system', connected: true,
    }));
    // PORT NOTE: provider hung up by closing the VoiceLink WS (core: `endCall('pcid-1')`).
    expect(pstn.readyState).toBe(3);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Scenario 4 — PSTN 'stop' control event ends the call
// ───────────────────────────────────────────────────────────────────────────
describe("Scenario: PSTN 'stop' event ends the call", () => {
  it('after answer, a {event:stop} on the PSTN leg tears the call down', async () => {
    const cm = makeCallManager();
    const mgr = new WebRtcBridgeManager(cm as any, null);
    await mgr.createBridgedCall({ ...PARAMS, ...AGENCY, browserSocket: fakeWs() as any });
    await mgr.handleVoicelinkStatus('call-1', ev('answer', VL_ANSWERED));
    const pstn = fakeWs();
    mgr.attachPstnLeg('call-1', pstn as any);
    negotiateVoicelink(pstn);

    pstn.emit('message', JSON.stringify({ event: 'stop' }));
    // endCall is fire-and-forget from onPstnMessage and releases the provider,
    // account, and global slots independently.
    await vi.waitFor(() => {
      expect(cm.concurrencyGuard.release).toHaveBeenCalledTimes(1);
    });

    expect(mgr.getSession('call-1')).toBeUndefined();
    expect(updateStatuses()).toContain('completed');
    // PORT NOTE: core asserted the settlement dispatch (completed, webrtc_call).
    expect(mockAnalytics.trackWebrtcCallCompleted).toHaveBeenCalledWith(expect.objectContaining({
      status: 'completed',
    }));
    expect(cm.accountConcurrencyGuard.release).toHaveBeenCalledTimes(1);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Scenario 6 — Graceful shutdown mid-call
// ───────────────────────────────────────────────────────────────────────────
describe('Scenario: graceful shutdown mid-call', () => {
  it('settles, releases slots, hangs up provider, and removes the session for an answered call', async () => {
    const cm = makeCallManager();
    const mgr = new WebRtcBridgeManager(cm as any, null);
    await mgr.createBridgedCall({ ...PARAMS, ...AGENCY, browserSocket: fakeWs() as any });
    await mgr.handleVoicelinkStatus('call-1', ev('answer', VL_ANSWERED));
    expect(mgr.getActiveCount()).toBe(1);

    await mgr.gracefulShutdown();

    expect(mgr.getActiveCount()).toBe(0);
    expect(mgr.getSession('call-1')).toBeUndefined();
    // answered → completed on shutdown
    expect(updateStatuses()).toContain('completed');
    // PORT NOTE: core asserted the settlement dispatch here; the analytics event below
    // carries the same terminal facts.
    expect(mockAnalytics.trackWebrtcCallCompleted).toHaveBeenCalledWith(expect.objectContaining({
      status: 'completed', endedBy: 'system',
    }));
    expect(mockAdapter.endCall).toHaveBeenCalledWith('pcid-1');
    expect(cm.concurrencyGuard.release).toHaveBeenCalledTimes(1);
    expect(cm.accountConcurrencyGuard.release).toHaveBeenCalledTimes(1);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Scenario 7 — Idempotent teardown (two end paths race)
// ───────────────────────────────────────────────────────────────────────────
describe('Scenario: idempotent teardown across two end paths', () => {
  it('browser close + carrier hangup → exactly one settlement / one slot release', async () => {
    const cm = makeCallManager();
    const mgr = new WebRtcBridgeManager(cm as any, null);
    const browser = fakeWs();
    await mgr.createBridgedCall({ ...PARAMS, ...AGENCY, browserSocket: browser as any });
    await mgr.handleVoicelinkStatus('call-1', ev('answer', VL_ANSWERED));

    const pstn = fakeWs();
    mgr.attachPstnLeg('call-1', pstn as any);

    // First end path: browser socket closes (fires endCall, browser_hangup)
    // PORT NOTE: a borrowed socket's close is `agent_disconnected`, and on an answered
    // VoiceLink call it enters `ending` and waits for the carrier.
    browser.emit('close');
    // Second end path: carrier hangup webhook arrives after teardown started
    await mgr.handleVoicelinkStatus('call-1', ev('hangup', VL_ENDED));
    // also a PSTN close racing in
    pstn.emit('close');
    await Promise.resolve();
    await Promise.resolve();

    // endHandled guard → exactly one of each
    // PORT NOTE: core counted settlement dispatches; here, terminal row writes.
    expect(mockRepo.update.mock.calls.filter((c) => c[1]?.ended_at)).toHaveLength(1);
    expect(cm.concurrencyGuard.release).toHaveBeenCalledTimes(1);
    expect(cm.accountConcurrencyGuard.release).toHaveBeenCalledTimes(1);
    expect(mockAnalytics.trackWebrtcCallCompleted).toHaveBeenCalledTimes(1);
    expect(mgr.getSession('call-1')).toBeUndefined();
  });

  it('forceEndByUser twice → second is a no-op (session already gone)', async () => {
    const cm = makeCallManager();
    const mgr = new WebRtcBridgeManager(cm as any, null);
    await mgr.createBridgedCall({ ...PARAMS, ...AGENCY, browserSocket: fakeWs() as any });
    await mgr.handleVoicelinkStatus('call-1', ev('answer', VL_ANSWERED));

    expect(await endByUser(mgr)).toBe(true);
    // PORT NOTE: an answered VoiceLink hangup holds the session in `ending` until the carrier
    // confirms; core's VoBiz hangup finalized at once. The confirmation is driven here, so
    // the second call meets the same "session already gone" state core's did.
    await mgr.handleVoicelinkStatus('call-1', ev('hangup', VL_ENDED));
    expect(mgr.getSession('call-1')).toBeUndefined();
    expect(await endByUser(mgr)).toBe(false);
    // PORT NOTE: core counted settlement dispatches.
    expect(mockAnalytics.trackWebrtcCallCompleted).toHaveBeenCalledTimes(1);
    expect(cm.concurrencyGuard.release).toHaveBeenCalledTimes(1);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Recording lifecycle scenarios — opt-in WebRTC call recording.
//
// These exercise the recording feature as MULTI-STEP lifecycles over the real
// manager (not the single-assertion unit cases in webrtc-bridge-manager.test.ts).
// The invariant under test: recording is orthogonal to teardown/settlement/
// slot-release — opting in must change ONLY the answer-XML <Record> options
// (enableRecording / recordingCallbackUrl / recordingMaxLengthSeconds), never
// the terminal status, billing (talk_time), or concurrency bookkeeping.
// ───────────────────────────────────────────────────────────────────────────
describe('recording lifecycle scenarios', () => {
  // PORT NOTE: core read the VoBiz answer XML's <Record> options (`generateAnswerResponse`);
  // VoiceLink requests (and caps) recording on the dial itself.
  const dialRequest = () => mockAdapter.initiateCall.mock.calls.at(-1)![0];

  it('Scenario R1: full recorded-call happy path — record:true sets the dial request\'s enableRecording yet end/slots are unchanged', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-24T00:00:00.000Z'));
    const cm = makeCallManager();
    const mgr = new WebRtcBridgeManager(cm as any, null);

    // create with recording requested
    // PORT NOTE: borrowed browser socket at dial; no token is minted for it (core: `token` truthy).
    const browser = fakeWs();
    const record = await mgr.createBridgedCall({ ...PARAMS, ...AGENCY, browserSocket: browser as any, record: true });
    expect(record.id).toBe('call-1');
    // intent persisted on the row
    expect(mockRepo.create.mock.calls[0]![0].recording_requested).toBe(true);
    // PORT NOTE: the dial request carries the recording wiring (core: the answer XML's <Record>
    // options; VoiceLink has no recording callback URL — the URL arrives on `call.ended`).
    expect(dialRequest().enableRecording).toBe(true);
    expect(dialRequest().maxDuration).toBe(1800);

    // drive ringing
    await mgr.handleVoicelinkStatus('call-1', ev('ringing', VL_RINGING));
    expect(browser.sent).toContainEqual({ event: 'status', status: 'ringing' });

    // answer
    await mgr.handleVoicelinkStatus('call-1', ev('answer', VL_ANSWERED));

    // both legs live + relay each direction (recording doesn't touch the relay)
    const pstn = fakeWs();
    mgr.attachPstnLeg('call-1', pstn as any);
    negotiateVoicelink(pstn);
    expect(mgr.getSession('call-1')!.bothLegsConnected).toBe(true);
    expectRelaysBothWays(browser, pstn);

    // talk 30s, user hangs up
    vi.advanceTimersByTime(30_000);
    expect(await endByUser(mgr)).toBe(true);
    // PORT NOTE: an answered VoiceLink hangup settles on the carrier's `call.ended`.
    await mgr.handleVoicelinkStatus('call-1', ev('hangup', VL_ENDED));

    // terminal/settlement/slots are IDENTICAL to a non-recorded happy path
    expect(updateStatuses()).toContain('completed');
    expect(lastUpdate().talk_time_seconds).toBe(30);
    // PORT NOTE: core asserted the settlement dispatch (completed, talk 30) and one
    // `triggerDequeue`; agency never settles and has no AI queue.
    expect(mockAnalytics.trackWebrtcCallCompleted).toHaveBeenCalledWith(expect.objectContaining({
      status: 'completed', talkTimeSeconds: 30,
    }));
    expect(cm.concurrencyGuard.release).toHaveBeenCalledTimes(1);
    expect(cm.accountConcurrencyGuard.release).toHaveBeenCalledTimes(1);
    // PORT NOTE: VoiceLink's only hangup is closing the provider WS (core: `endCall('pcid-1')`).
    expect(pstn.readyState).toBe(3);
    expect(mgr.getSession('call-1')).toBeUndefined();
  });

  it('Scenario R2: non-recorded call — record omitted leaves the dial request\'s enableRecording off but the lifecycle still ends', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-24T00:00:00.000Z'));
    const cm = makeCallManager();
    const mgr = new WebRtcBridgeManager(cm as any, null);

    await mgr.createBridgedCall({ ...PARAMS, ...AGENCY, browserSocket: fakeWs() as any }); // no record field
    expect(mockRepo.create.mock.calls[0]![0].recording_requested).toBe(false);

    await mgr.handleVoicelinkStatus('call-1', ev('ringing', VL_RINGING));
    await mgr.handleVoicelinkStatus('call-1', ev('answer', VL_ANSWERED));

    // PORT NOTE: the dial request (core: the answer XML options; no callback URL to check).
    expect(dialRequest().enableRecording).toBe(false);
    // max-length is still resolved (used to cap the future <Record> if any), but no callback URL
    expect(dialRequest().maxDuration).toBe(1800);

    const pstn = fakeWs();
    mgr.attachPstnLeg('call-1', pstn as any);
    negotiateVoicelink(pstn);
    vi.advanceTimersByTime(12_000);
    expect(await endByUser(mgr)).toBe(true);
    await mgr.handleVoicelinkStatus('call-1', ev('hangup', VL_ENDED));

    expect(updateStatuses()).toContain('completed');
    expect(lastUpdate().talk_time_seconds).toBe(12);
    // PORT NOTE: core asserted the settlement dispatch (completed, talk 12).
    expect(mockAnalytics.trackWebrtcCallCompleted).toHaveBeenCalledWith(expect.objectContaining({
      status: 'completed', talkTimeSeconds: 12,
    }));
    expect(cm.concurrencyGuard.release).toHaveBeenCalledTimes(1);
    expect(cm.accountConcurrencyGuard.release).toHaveBeenCalledTimes(1);
  });

  it('Scenario R3: recorded call never answered — busy hangup settles at 0 talk-time and no <Record> XML is ever emitted', async () => {
    const cm = makeCallManager();
    const mgr = new WebRtcBridgeManager(cm as any, null);

    await mgr.createBridgedCall({ ...PARAMS, ...AGENCY, browserSocket: fakeWs() as any, record: true });
    expect(mockRepo.create.mock.calls[0]![0].recording_requested).toBe(true);

    // ring then carrier hangup BEFORE any answer
    await mgr.handleVoicelinkStatus('call-1', ev('ringing', VL_RINGING));
    await mgr.handleVoicelinkStatus('call-1', ev('hangup', {
      event: 'call.ended', call: { id: 'pcid-1', callStatus: 'BUSY' },
    }));

    // unanswered → busy, 0 talk-time
    expect(updateStatuses()).toContain('busy');
    // PORT NOTE: core asserted the settlement dispatch (busy, talk 0); the terminal row
    // carries the same facts.
    expect(lastUpdate()).toMatchObject({ status: 'busy', talk_time_seconds: 0 });
    expect(mockAnalytics.trackWebrtcCallCompleted).toHaveBeenCalledWith(expect.objectContaining({
      status: 'busy', connected: false,
    }));
    // answer XML never rendered → recording opt-in never produced a <Record> directive
    // PORT NOTE: VoiceLink never renders answer XML at all, so this holds by construction.
    expect(mockAdapter.generateAnswerResponse).not.toHaveBeenCalled();

    // recording opt-in didn't break the unanswered slot release
    expect(cm.concurrencyGuard.release).toHaveBeenCalledTimes(1);
    expect(cm.accountConcurrencyGuard.release).toHaveBeenCalledTimes(1);
    expect(mgr.getSession('call-1')).toBeUndefined();
  });

  it('Scenario R4: max-duration override flows into the recording cap (3600 instead of 1800)', async () => {
    // override the flag-resolved max duration for this createCall only
    // PORT NOTE: the override is the account's `webrtc_max_duration_seconds` (plan §3.2).
    mockAccountSettings.getWebrtcMaxDurationSeconds.mockResolvedValueOnce(3600);
    const cm = makeCallManager();
    const mgr = new WebRtcBridgeManager(cm as any, null);

    await mgr.createBridgedCall({ ...PARAMS, ...AGENCY, browserSocket: fakeWs() as any, record: true });
    // the override is stamped on the session and capped into <Record>
    expect(mgr.getSession('call-1')!.maxDurationSeconds).toBe(3600);

    // PORT NOTE: VoiceLink has no answer XML; its recording is requested, and capped, on
    // the dial itself.
    expect(mockAdapter.initiateCall).toHaveBeenCalledWith(expect.objectContaining({
      maxDuration: 3600,
      enableRecording: true,
    }));

    await endByUser(mgr);
  });
});
