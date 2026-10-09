import { describe, it, expect, vi, beforeEach } from 'vitest';

// PORT NOTE (magick-agency): ported from core test/unit/core/webrtc-bridge-manager.bridged.test.ts@4850d1d9
// (11 cases → 8). Mock specifiers follow the new paths (logger → @magick-agency/observability,
// webrtc-call repository → @magick-agency/db agency-call repository, account settings → the
// @magick-agency/db repository with `getWebrtcMaxDurationSeconds` → null = the 1800 default the
// flag mock returned); the settlement-dispatcher and feature-flag mocks are gone (the bridge no
// longer imports them).
// The default provider is now VoiceLink (core: VoBiz), so every case below runs on VoiceLink.
//
// DELETED (3):
//  - 'refuses a /browser-stream connect for a bridged call' — `attachBrowserLeg` (the owned,
//    token-gated softphone leg) is deleted with `createCall`; there is no route to refuse.
//  - 'still mints a token and CLOSES its browser socket at teardown' — softphone `createCall` +
//    owned `attachBrowserLeg`, both deleted.
//  - 'writes NULL agency back-references' — softphone `createCall` (the only path that dialled
//    with no campaign/attempt), deleted.
//
// UNCHANGED (2): 'refuses to dial when the station socket is not open (409, no slot, no carrier)',
// 'hangs up the carrier as agent_disconnected when the station socket drops mid-call'.
//
// MODIFIED (6): `forceEndByUser(callId)` (deleted) → the same `localHangup` under the same
// outcome via `forceEndWithOutcome(attemptId, 'ended_by_user')` in 'dials over the shared path
// and persists the agency back-references', 'mints no browser WS token for a borrowed socket',
// 'leaves the station socket OPEN and listener-clean after an attempt completes', 'survives three
// sequential calls over one station socket with one live listener set', 'does not let a finished
// attempt handle a later close of the shared socket', 'relays media both ways over the borrowed
// socket'. Beyond that:
//  - 'mints no browser WS token for a borrowed socket' — on VoiceLink the bridge still stores the
//    carrier's provider + webhook tokens (core's own comment says so), so the assertion is that no
//    `browser`-purpose token is stored, rather than that `redis.set` is never called.
//  - 'relays media both ways over the borrowed socket' — VoiceLink holds the relay until a valid
//    `start` frame (VoBiz was media-ready on connect), so the frame is sent first; the relay
//    transcodes (PCM16 16k ⇄ A-law 8k, plain `media` frames) instead of VoBiz's verbatim L16
//    `playAudio`: a real 20ms tone goes each way and exactly one frame must come out, of the
//    transcoded length (A-law 120-160 B, PCM16 480-640 B) and not silent. The answered VoiceLink
//    hangup waits for the carrier's `call.ended`, which is driven (and the session asserted gone)
//    before the "station never closed" check, so that check still runs after finalization.

// ---------------------------------------------------------------------------
// The borrowed-socket contract (docs/reference/magickvoice-platform/docs/agency-dialer-design.md §7).
//
// The agency dialer inverts the bridge's socket lifetime: the agent's station
// socket is opened once at shift start and reused across hundreds of attempts.
// These tests pin the three things that inversion breaks if it is got wrong —
// the socket surviving teardown, listeners not accumulating across a shift, and
// the existing browser-dialer path being untouched.
//
// Mock harness mirrors webrtc-bridge-manager.test.ts (project convention: no
// shared test utilities).
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

vi.mock('../../../src/audit/audit-logger.js', () => ({
  auditLogger: { log: vi.fn() },
}));

vi.mock('../../../src/analytics/posthog.js', () => ({
  trackWebrtcCallInitiated: vi.fn(),
  trackWebrtcCallRejected: vi.fn(),
  trackWebrtcCallCompleted: vi.fn(),
}));

import { WebRtcBridgeManager, WebRtcCallError } from '../../../src/core/webrtc-bridge-manager.js';
import { encodeAlaw, decodeAlaw } from '../../../src/utils/audio.js';

// ── Fake WebSocket with real add/remove listener bookkeeping ────────────────
// `off` is the whole point here: the existing fake in webrtc-bridge-manager.test.ts
// has no removal at all, because the owned path never removes anything.
function fakeStationWs() {
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
    /** How many listeners are currently registered for an event. */
    count(ev: string) { return (handlers[ev] || []).length; },
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

const BRIDGED = {
  ...PARAMS,
  campaignId: 'camp-1',
  agencyAttemptId: 'att-1',
};

/** PORT NOTE: core's `forceEndByUser(callId)` — the same `localHangup`, keyed on the attempt. */
const endByUser = (mgr: WebRtcBridgeManager, attemptId = 'att-1') =>
  mgr.forceEndWithOutcome(attemptId, 'ended_by_user');

/** PORT NOTE: VoiceLink's A-law 8kHz `start` frame — opens the relay (VoBiz needed none). */
/**
 * PORT NOTE: real 20ms tone frames for the relay check. Core relayed VoBiz's L16 verbatim, so a
 * 4-byte payload proved the relay; VoiceLink transcodes (PCM16 16k ⇄ A-law 8k), so only real
 * audio makes the output's length and level meaningful.
 */
function pcm16kToneFrame(): string {
  const pcm = new Int16Array(320); // 20ms @16k = 640 bytes
  for (let i = 0; i < pcm.length; i++) pcm[i] = Math.round(8000 * Math.sin((2 * Math.PI * 1000 * i) / 16000));
  return Buffer.from(pcm.buffer).toString('base64');
}
function alaw8kToneFrame(): string {
  const pcm = new Int16Array(160); // 20ms @8k = 160 A-law bytes
  for (let i = 0; i < pcm.length; i++) pcm[i] = Math.round(8000 * Math.sin((2 * Math.PI * 1000 * i) / 8000));
  return encodeAlaw(pcm).toString('base64');
}
function peak(samples: ArrayLike<number>): number {
  let p = 0;
  for (let i = 0; i < samples.length; i++) p = Math.max(p, Math.abs(samples[i]!));
  return p;
}

function negotiateVoicelink(pstn: ReturnType<typeof fakeStationWs>): void {
  pstn.emit('message', JSON.stringify({
    event: 'start',
    start: { call_sid: 'carrier-1', stream_sid: 's1', media_format: { encoding: 'audio/alaw', sample_rate: '8000' } },
  }));
}

let seq = 0;

beforeEach(() => {
  vi.clearAllMocks();
  seq = 0;
  mockRepo.create.mockImplementation(async (i: any) => ({
    id: `call-${++seq}`,
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
});

describe('WebRtcBridgeManager.createBridgedCall', () => {
  it('dials over the shared path and persists the agency back-references', async () => {
    const mgr = new WebRtcBridgeManager(makeCallManager() as any, null);
    const ws = fakeStationWs();

    const record = await mgr.createBridgedCall({ ...BRIDGED, browserSocket: ws as any });

    expect(record.id).toBe('call-1');
    // Same dial path as createCall — concurrency, persistence, provider dial.
    const created = mockRepo.create.mock.calls[0]![0];
    expect(created.campaign_id).toBe('camp-1');
    expect(created.agency_attempt_id).toBe('att-1');
    const initArg = mockAdapter.initiateCall.mock.calls[0]![0];
    expect(initArg.from).toBe('+14155550100');
    expect(initArg.to).toBe('+14155550199');
    expect(initArg.webhookUrl).toContain('/webrtc-answer/call-1');

    // The socket was attached before the dial, so an early carrier event has
    // somewhere to go — the initial status frame is already on the wire.
    expect(ws.sent.some((f) => f.event === 'status')).toBe(true);

    await endByUser(mgr);
  });

  it('refuses to dial when the station socket is not open (409, no slot, no carrier)', async () => {
    const cm = makeCallManager();
    const mgr = new WebRtcBridgeManager(cm as any, null);
    const ws = fakeStationWs();
    ws.readyState = 3; // CLOSED

    await expect(
      mgr.createBridgedCall({ ...BRIDGED, browserSocket: ws as any }),
    ).rejects.toMatchObject({ code: 'station_socket_unavailable', statusCode: 409 });

    expect(cm.concurrencyGuard.tryAcquire).not.toHaveBeenCalled();
    expect(mockRepo.create).not.toHaveBeenCalled();
    expect(mockAdapter.initiateCall).not.toHaveBeenCalled();
  });

  it('mints no browser WS token for a borrowed socket', async () => {
    const redis = { set: vi.fn().mockResolvedValue('OK'), get: vi.fn(), del: vi.fn().mockResolvedValue(1) };
    const mgr = new WebRtcBridgeManager(makeCallManager() as any, redis as any);
    const ws = fakeStationWs();

    await mgr.createBridgedCall({ ...BRIDGED, browserSocket: ws as any });

    // A VoBiz bridged call stores no token at all (VoiceLink would still store its
    // provider/webhook tokens — those gate the carrier's own legs, not the agent's).
    // PORT NOTE: this is a VoiceLink call, so exactly those two are stored and no
    // `browser`-purpose token (key `webrtc:ws-token:<purpose>:<callId>`).
    const purposes = redis.set.mock.calls.map((c: any[]) => String(c[0]).split(':')[2]);
    expect(purposes).not.toContain('browser');
    expect([...purposes].sort()).toEqual(['provider', 'webhook']);

    await endByUser(mgr);
  });

  // ── The contract's central promise ────────────────────────────────────────
  it('leaves the station socket OPEN and listener-clean after an attempt completes', async () => {
    const mgr = new WebRtcBridgeManager(makeCallManager() as any, null);
    const ws = fakeStationWs();
    // The station's own control-plane handler, registered once at shift start.
    const stationHandler = vi.fn();
    ws.on('message', stationHandler);

    await mgr.createBridgedCall({ ...BRIDGED, browserSocket: ws as any });
    // Mid-attempt: the bridge's own listener set is live alongside the station's.
    expect(ws.count('message')).toBe(2);
    expect(ws.count('close')).toBe(1);
    expect(ws.count('error')).toBe(1);

    await endByUser(mgr);

    expect(ws.readyState).toBe(1); // NOT closed — the agent is still logged in
    expect(mgr.getSession('call-1')).toBeUndefined();
    // Exactly the station's own handler survives; the attempt's three are gone.
    expect(ws.count('message')).toBe(1);
    expect(ws.count('close')).toBe(0);
    expect(ws.count('error')).toBe(0);
    ws.emit('message', 'still wired');
    expect(stationHandler).toHaveBeenCalledTimes(1);
  });

  it('survives three sequential calls over one station socket with one live listener set', async () => {
    const mgr = new WebRtcBridgeManager(makeCallManager() as any, null);
    const ws = fakeStationWs();

    for (let i = 1; i <= 3; i++) {
      await mgr.createBridgedCall({
        ...BRIDGED,
        agencyAttemptId: `att-${i}`,
        browserSocket: ws as any,
      });
      // Never more than one attempt's worth of listeners at a time.
      expect(ws.count('message')).toBe(1);
      expect(ws.count('close')).toBe(1);
      expect(ws.count('error')).toBe(1);
      await endByUser(mgr, `att-${i}`);
      expect(ws.readyState).toBe(1);
    }

    expect(seq).toBe(3);
    expect(ws.readyState).toBe(1);
    expect(ws.count('message')).toBe(0);
    expect(ws.count('close')).toBe(0);
    expect(ws.count('error')).toBe(0);
  });

  it('does not let a finished attempt handle a later close of the shared socket', async () => {
    const cm = makeCallManager();
    const mgr = new WebRtcBridgeManager(cm as any, null);
    const ws = fakeStationWs();

    await mgr.createBridgedCall({ ...BRIDGED, browserSocket: ws as any });
    await endByUser(mgr);
    mockAdapter.endCall.mockClear();

    // Shift over — the agent closes their station socket. No stale handler runs.
    ws.emit('close');
    expect(mockAdapter.endCall).not.toHaveBeenCalled();
  });

  it('hangs up the carrier as agent_disconnected when the station socket drops mid-call', async () => {
    const mgr = new WebRtcBridgeManager(makeCallManager() as any, null);
    const ws = fakeStationWs();

    await mgr.createBridgedCall({ ...BRIDGED, browserSocket: ws as any });
    mockRepo.update.mockClear();

    ws.emit('close');
    await vi.waitFor(() => expect(mgr.getSession('call-1')).toBeUndefined());

    // The carrier leg is torn down — the station socket IS the agent's media path,
    // so there is no "let the call finish"; the customer would hear dead air.
    expect(mockAdapter.endCall).toHaveBeenCalledWith('pcid-1');
    const terminal = mockRepo.update.mock.calls.at(-1)![1];
    expect(terminal.outcome).toBe('agent_disconnected');
    // Never answered ⇒ canceled, answer-anchored like every other teardown here.
    expect(terminal.status).toBe('canceled');
  });

  it('relays media both ways over the borrowed socket', async () => {
    const mgr = new WebRtcBridgeManager(makeCallManager() as any, null);
    const station = fakeStationWs();
    const pstn = fakeStationWs();

    await mgr.createBridgedCall({ ...BRIDGED, browserSocket: station as any });
    mgr.attachPstnLeg('call-1', pstn as any);
    // PORT NOTE: VoiceLink opens the relay on its `start` frame.
    negotiateVoicelink(pstn);
    station.sent.length = 0;

    // PORT NOTE: core sent a 4-byte payload and asserted VoBiz's verbatim `playAudio` L16
    // frame; VoiceLink gets the transcoded A-law in a plain `media` frame, so a real 20ms tone
    // goes in and exactly one transcoded, non-silent frame must come out.
    const toPstn = pstn.sent.filter((f) => f.event === 'media').length;
    station.emit('message', JSON.stringify({ event: 'media', media: { payload: pcm16kToneFrame() } }));
    const b2p = pstn.sent.filter((f) => f.event === 'media');
    expect(b2p).toHaveLength(toPstn + 1);
    const alaw = Buffer.from(b2p.at(-1).media.payload, 'base64');
    expect(alaw.length).toBeGreaterThan(120);
    expect(alaw.length).toBeLessThanOrEqual(160);
    expect(peak(decodeAlaw(alaw))).toBeGreaterThan(6400);

    // PORT NOTE: core asserted the verbatim payload; VoiceLink's is transcoded to PCM16 16k.
    pstn.emit('message', JSON.stringify({ event: 'media', media: { payload: alaw8kToneFrame() } }));
    const p2s = station.sent.filter((f) => f.event === 'media');
    expect(p2s).toHaveLength(1); // `station.sent` was cleared after negotiation
    const pcm = Buffer.from(p2s[0].media.payload, 'base64');
    expect(pcm.length).toBeGreaterThan(480);
    expect(pcm.length).toBeLessThanOrEqual(640);
    expect(peak(new Int16Array(pcm.buffer, pcm.byteOffset, pcm.byteLength / 2))).toBeGreaterThan(6400);

    await endByUser(mgr);
    // PORT NOTE: an answered VoiceLink hangup waits in `ending` for the carrier's `call.ended`
    // (VoBiz finalized at once), so the confirmation is driven and the call asserted finalized
    // before the socket check — otherwise "never closed at finalization" would go untested.
    await mgr.handleVoicelinkStatus('call-1', {
      providerCallId: 'carrier-1', callId: 'call-1', eventType: 'hangup', timestamp: new Date(),
      metadata: { event: 'call.ended', call: { id: 'carrier-1', status: 'ended' } },
    });
    expect(mgr.getSession('call-1')).toBeUndefined();
    expect(station.readyState).toBe(1);
    expect(pstn.readyState).toBe(3); // the PSTN leg IS ours — still closed
  });
});
