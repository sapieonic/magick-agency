import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Connecting an inbound caller through the bridge (docs/inbound.md §5, P2), on the REAL Plivo
// carrier module, with a stub adapter on the credential the call arrived on:
//
//  - a connectable call is parked: borrowed-unbound, its budget parked + max duration (answer,
//    slot TTL), the parked backstop as its timer until the bind re-arms the full max duration;
//  - the hold: the preamble once, then the hold clip (or the built-in tone) on a loop until the
//    bind; no hold frame reaches the carrier once the bind returns; a caller who leaves resolves
//    `aborted` with no hangup of ours; it never hangs up; stopInboundHold and a later hold stop it;
//  - talk time counts from the bind (0 for a call no agent took);
//  - the carrier tap: bounded, installed only while recording, fed with nobody bound, with a
//    prompt and beep before it, ended by the caller leaving or the wall clock;
//  - the recording at the bind: the Record API only after `bridged`, with a webhook token minted
//    for its callback; never for a call that did not ask, or on a carrier that cannot.
//
// Mock harness mirrors webrtc-bridge-inbound.test.ts (project convention: no shared test utilities).
// ---------------------------------------------------------------------------

const { logSpy } = vi.hoisted(() => ({ logSpy: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@magick-agency/observability', () => ({ logger: logSpy, createChildLogger: () => logSpy }));

vi.mock('../../../src/config/index.js', () => ({
  config: {
    redis: { keyPrefix: '' },
    telephony: {
      voicelink: { webhookBaseUrl: 'https://server.test/api/v1/webhooks/voicelink' },
      plivo: { webhookBaseUrl: 'https://server.test/api/v1/webhooks/plivo' },
    },
    telephonyCredentials: { keyring: '', activeKeyId: '' },
  },
}));

const { mockRepo, mockSettings } = vi.hoisted(() => ({
  mockRepo: { create: vi.fn(), findById: vi.fn().mockResolvedValue(null), update: vi.fn().mockResolvedValue(null) },
  mockSettings: { getAllowRecording: vi.fn().mockResolvedValue(true), getWebrtcMaxDurationSeconds: vi.fn().mockResolvedValue(600) },
}));
vi.mock('@magick-agency/db/repositories/agency-call.repository', () => ({ webrtcCallRepository: mockRepo }));
vi.mock('@magick-agency/db/repositories/account-settings.repository', () => ({ accountSettingsRepository: mockSettings }));

const { plivoAdapter, registry } = vi.hoisted(() => {
  const plivoAdapter = {
    name: 'plivo',
    capabilities: { cancelRinging: true, queuesOutboundDials: false, ringTimeoutSeconds: 45, recordsOnDemand: true } as Record<string, unknown>,
    initiateCall: vi.fn(),
    getCallStatus: vi.fn().mockResolvedValue({ status: 'unknown' }),
    endCall: vi.fn().mockResolvedValue(undefined),
    cancelDialRequest: vi.fn().mockResolvedValue('canceled'),
    generateAnswerResponse: vi.fn().mockReturnValue('<Response/>'),
    verifyCarrierRequest: vi.fn().mockReturnValue(true),
    startRecording: vi.fn().mockResolvedValue({ recordingId: 'rec-1' }),
  };
  return {
    plivoAdapter,
    registry: {
      get: vi.fn((provider: string) => { throw new Error(`Unknown telephony provider: ${provider}`); }),
      getForCredentialId: vi.fn(async (_p: string, _id: string | null, _purpose: string, _t: string) => plivoAdapter),
    },
  };
});
vi.mock('../../../src/telephony/factory.js', () => ({
  TelephonyProviderRegistry: class {
    get(p: string) { return registry.get(p); }
    getForCredentialId(p: string, id: string | null, purpose: string, t: string) { return registry.getForCredentialId(p, id, purpose, t); }
    recordCredentialRefused() { return true; }
  },
}));
vi.mock('../../../src/audit/audit-logger.js', () => ({ auditLogger: { log: vi.fn() } }));
vi.mock('../../../src/analytics/posthog.js', () => ({
  trackWebrtcCallInitiated: vi.fn(), trackWebrtcCallRejected: vi.fn(), trackWebrtcCallCompleted: vi.fn(),
}));

// 8 kHz PCM16 clips, each a constant level so its μ-law frames tell it apart. 60 ms = 3 frames of 160.
const { clips } = vi.hoisted(() => {
  const level = (ms: number, v: number) => {
    const b = Buffer.alloc((8000 * ms / 1000) * 2);
    for (let i = 0; i < b.length; i += 2) b.writeInt16LE(v, i);
    return { pcm16: b, sampleRate: 8000 };
  };
  return { clips: { pre: level(60, 1000), pre2: level(40, 2000), hold: level(60, -1000), prompt: level(60, 3000) } as Record<string, { pcm16: Buffer; sampleRate: number }> };
});
vi.mock('../../../src/tts/tts-file-cache.js', () => ({ readTtsPcm: (hash: string) => clips[hash] ?? null }));

import {
  WebRtcBridgeManager, INBOUND_MEDIA_DEADLINE_SECONDS, type WebRtcInboundCallParams,
} from '../../../src/core/webrtc-bridge-manager.js';
import { pcmToMulaw } from '../../../src/utils/audio.js';
import { holdTonePcm16, recordBeepPcm16 } from '../../../src/core/bridge/hold-tone.js';

function fakeWs() {
  const handlers: Record<string, ((...a: any[]) => void)[]> = {};
  return {
    readyState: 1,
    OPEN: 1,
    bufferedAmount: 0,
    sent: [] as any[],
    sentAt: [] as number[],
    send(s: string) { this.sent.push(JSON.parse(s)); this.sentAt.push(Date.now()); },
    on(ev: string, cb: (...a: any[]) => void) { (handlers[ev] ||= []).push(cb); },
    off(ev: string, cb: (...a: any[]) => void) { const l = handlers[ev]; if (l) l.splice(l.indexOf(cb), 1); },
    emit(ev: string, ...a: any[]) { (handlers[ev] || []).slice().forEach((cb) => cb(...a)); },
    close() { this.readyState = 3; this.emit('close'); },
  };
}
type FakeWs = ReturnType<typeof fakeWs>;

/** A Redis double for the per-call tokens: get/set/del/expire on a map. */
function fakeRedis() {
  const kv = new Map<string, string>();
  return {
    kv,
    set: vi.fn(async (k: string, v: string) => { kv.set(k, v); return 'OK'; }),
    get: vi.fn(async (k: string) => kv.get(k) ?? null),
    del: vi.fn(async (k: string) => (kv.delete(k) ? 1 : 0)),
    expire: vi.fn(async () => 1),
  };
}

function makeGuardHost() {
  return {
    concurrencyGuard: { tryAcquire: vi.fn().mockResolvedValue(true), release: vi.fn().mockResolvedValue(undefined) },
    accountConcurrencyGuard: { tryAcquire: vi.fn().mockResolvedValue(true), release: vi.fn().mockResolvedValue(undefined) },
    triggerDequeue: vi.fn(),
    wakeSelfHeal: vi.fn(),
  };
}

const LEG = '0b6f2a3c-1d4e-4f5a-8b6c-7d8e9f0a1b2c';
const INBOUND = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const PARKED = 300;
const MAX = 600;
const PARAMS: WebRtcInboundCallParams = {
  callId: LEG, correlationId: INBOUND, tenantId: 'tenant-a', accountId: 'a1', provider: 'plivo',
  telephonyCredentialId: 'cred-1', callerId: '+14155550101', destinationPhone: '+919812345678',
  carrierCallId: 'cu-1', takeSlots: true, connectable: true, browserCloseGraceMs: 8000, parkedSeconds: PARKED, record: false,
};

/** The carrier opens our stream and negotiates μ-law. */
function connectStream(mgr: WebRtcBridgeManager): FakeWs {
  const ws = fakeWs();
  expect(mgr.attachPstnLeg(LEG, ws as any)).toBe(true);
  ws.emit('message', JSON.stringify({
    event: 'start', start: { callId: 'cu-1', streamId: 'st-1', mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: 8000 } },
  }));
  return ws;
}

/** One 20 ms μ-law frame from the caller (160 bytes, a constant level). */
function callerSays(ws: FakeWs, n = 1, byte = 0x10): void {
  for (let i = 0; i < n; i++) {
    ws.emit('message', JSON.stringify({ event: 'media', media: { payload: Buffer.alloc(160, byte).toString('base64') } }));
  }
}

const frames = (ws: FakeWs) => ws.sent.filter((f) => f.event === 'playAudio').map((f) => Buffer.from(f.media.payload, 'base64'));
/** The μ-law frames a clip is played as. */
function framesOf(pcm: { pcm16: Buffer; sampleRate: number }): Buffer[] {
  const wire = pcmToMulaw(pcm.pcm16, pcm.sampleRate);
  const out: Buffer[] = [];
  for (let i = 0; i < wire.length; i += 160) out.push(wire.subarray(i, Math.min(i + 160, wire.length)));
  return out;
}
const same = (a: Buffer[], b: Buffer[]) => a.length === b.length && a.every((x, i) => x.equals(b[i]!));
const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

let lifecycle: any[] = [];
beforeEach(() => {
  vi.clearAllMocks();
  lifecycle = [];
  registry.getForCredentialId.mockImplementation(async () => plivoAdapter);
  mockSettings.getAllowRecording.mockResolvedValue(true);
  mockSettings.getWebrtcMaxDurationSeconds.mockResolvedValue(MAX);
  plivoAdapter.capabilities = { cancelRinging: true, queuesOutboundDials: false, ringTimeoutSeconds: 45, recordsOnDemand: true };
  plivoAdapter.startRecording.mockResolvedValue({ recordingId: 'rec-1' });
});
afterEach(() => { vi.useRealTimers(); });

function bridge(redis: ReturnType<typeof fakeRedis> | null = null) {
  const host = makeGuardHost();
  const mgr = new WebRtcBridgeManager(host as any, redis as any);
  mgr.onLifecycle((e) => lifecycle.push(e));
  return { mgr, host };
}

describe('acceptInboundCall: a connectable call is parked', () => {
  it('its budget is parked + max duration: the answer`s maxDurationSeconds and the slot TTL; the leg is borrowed-unbound', async () => {
    const { mgr, host } = bridge();
    const accepted = await mgr.acceptInboundCall(PARAMS);
    expect(accepted).toMatchObject({ accepted: true, capacity: 'admitted', maxDurationSeconds: PARKED + MAX });
    expect(host.accountConcurrencyGuard.tryAcquire).toHaveBeenCalledWith(expect.any(String), 'tenant-a', 'a1', PARKED + MAX + 60);
    const session = mgr.getSession(LEG)!;
    expect(session).toMatchObject({
      inboundConnectable: true, browserWsOwned: false, browserLegBound: false, browserHangupOutcome: 'agent_disconnected', browserLegGraceMs: 8000,
    });
    // A retried answer gets the same budget.
    expect((await mgr.acceptInboundCall(PARAMS))).toEqual(accepted);
  });

  it('a call that is not connectable keeps P1`s budget and refuses a bind', async () => {
    const { mgr } = bridge();
    expect(await mgr.acceptInboundCall({ ...PARAMS, connectable: false, parkedSeconds: 999 })).toMatchObject({ maxDurationSeconds: MAX });
    connectStream(mgr);
    expect(mgr.getSession(LEG)!.browserWsOwned).toBe(true);
    expect(mgr.bindBorrowedBrowserLeg(INBOUND, fakeWs() as any)).toBe(false);
  });

  it('the parked time is never shorter than the media deadline', async () => {
    const { mgr } = bridge();
    expect(await mgr.acceptInboundCall({ ...PARAMS, parkedSeconds: 2 })).toMatchObject({ maxDurationSeconds: INBOUND_MEDIA_DEADLINE_SECONDS + MAX });
  });

  it('the parked backstop ends a call still unbound after parkedSeconds (max_duration_reached), hung up by REST', async () => {
    vi.useFakeTimers();
    const { mgr } = bridge();
    await mgr.acceptInboundCall(PARAMS);
    connectStream(mgr);
    await vi.advanceTimersByTimeAsync((PARKED - 1) * 1000);
    expect(mgr.getSession(LEG)).toBeDefined();
    await vi.advanceTimersByTimeAsync(2000);
    expect(mgr.getSession(LEG)).toBeUndefined();
    expect(mockRepo.update).toHaveBeenCalledWith(LEG, expect.objectContaining({ outcome: 'max_duration_reached', talk_time_seconds: 0 }));
    expect(plivoAdapter.endCall).toHaveBeenCalledWith('cu-1');
  });

  it('the bind re-arms the full max duration from the bind, and talk time counts from the bind', async () => {
    vi.useFakeTimers();
    const { mgr } = bridge();
    await mgr.acceptInboundCall(PARAMS);
    connectStream(mgr);
    await vi.advanceTimersByTimeAsync(200_000); // 200 s parked
    expect(mgr.bindBorrowedBrowserLeg(INBOUND, fakeWs() as any)).toBe(true);
    await vi.advanceTimersByTimeAsync((PARKED - 200 + 10) * 1000); // past where the parked backstop was
    expect(mgr.getSession(LEG)).toBeDefined();
    await vi.advanceTimersByTimeAsync((MAX - (PARKED - 200 + 10) - 1) * 1000);
    expect(mgr.getSession(LEG)).toBeDefined();
    await vi.advanceTimersByTimeAsync(2000);
    expect(mgr.getSession(LEG)).toBeUndefined();
    expect(lifecycle.at(-1)).toMatchObject({ phase: 'ended', outcome: 'max_duration_reached', talkTimeSeconds: MAX });
    expect(mockRepo.update).toHaveBeenCalledWith(LEG, expect.objectContaining({ talk_time_seconds: MAX, duration_seconds: 200 + MAX }));
  });

  it('a call no agent took has no talk time', async () => {
    vi.useFakeTimers();
    const { mgr } = bridge();
    await mgr.acceptInboundCall(PARAMS);
    connectStream(mgr);
    await vi.advanceTimersByTimeAsync(40_000);
    await mgr.forceEndWithOutcome(INBOUND, 'inbound_abandoned_in_queue');
    expect(lifecycle.at(-1)).toMatchObject({ phase: 'ended', talkTimeSeconds: 0, answered: true });
  });

  it('the media deadline still ends a connectable stream that never opens; a hold waiting on it is no_media', async () => {
    vi.useFakeTimers();
    const { mgr } = bridge();
    await mgr.acceptInboundCall(PARAMS);
    const hold = mgr.playInboundHold(INBOUND, { preambleClipHashes: ['pre'], holdClipHash: 'hold' });
    await vi.advanceTimersByTimeAsync(INBOUND_MEDIA_DEADLINE_SECONDS * 1000 + 10);
    expect(await hold).toBe('no_media');
    expect(mockRepo.update).toHaveBeenCalledWith(LEG, expect.objectContaining({ status: 'failed', outcome: 'inbound_media_timeout' }));
  });
});

describe('playInboundHold', () => {
  it('waits for media, plays the preamble once, then loops the hold clip until the bind; nothing hangs up', async () => {
    const { mgr } = bridge();
    await mgr.acceptInboundCall(PARAMS);
    const hold = mgr.playInboundHold(INBOUND, { preambleClipHashes: ['pre', 'missing', 'pre2'], holdClipHash: 'hold' });
    await tick(20);
    const carrier = connectStream(mgr);
    await vi.waitFor(() => expect(frames(carrier).length).toBeGreaterThan(5 + 3 * 3), { timeout: 2000 });
    const got = frames(carrier);
    const pre = [...framesOf(clips.pre!), ...framesOf(clips.pre2!)];
    expect(same(got.slice(0, pre.length), pre)).toBe(true); // the preamble, the missing clip skipped
    const holdFrames = framesOf(clips.hold!);
    const rest = got.slice(pre.length);
    // The hold clip, pass after pass, and never the preamble again.
    for (let i = 0; i < rest.length; i++) expect(rest[i]!.equals(holdFrames[i % holdFrames.length]!)).toBe(true);

    const station = fakeWs();
    expect(mgr.bindBorrowedBrowserLeg(INBOUND, station as any)).toBe(true);
    const atBind = frames(carrier).length;
    expect(await hold).toBe('released');
    await tick(120);
    expect(frames(carrier).length).toBe(atBind); // no hold frame after the bind returned
    expect(plivoAdapter.endCall).not.toHaveBeenCalled();
    expect(mgr.getSession(LEG)).toBeDefined();
    expect(lifecycle.map((e) => e.phase)).toEqual(['answered', 'bridged']);
  });

  it('the bind stops the hold synchronously: the hold`s sink refuses the very next frame', async () => {
    const { mgr } = bridge();
    await mgr.acceptInboundCall(PARAMS);
    const carrier = connectStream(mgr);
    const hold = mgr.playInboundHold(INBOUND, { preambleClipHashes: [], holdClipHash: 'hold' });
    await vi.waitFor(() => expect(frames(carrier).length).toBeGreaterThan(2));
    // Bind while a frame's pacing sleep is in progress, and count in the same synchronous turn.
    mgr.bindBorrowedBrowserLeg(INBOUND, fakeWs() as any);
    const atBind = carrier.sent.length;
    await hold;
    await tick(60);
    expect(carrier.sent.length).toBe(atBind);
  });

  it('with no hold clip (or one not on this replica) the caller hears the built-in hold tone', async () => {
    for (const holdClipHash of [null, 'missing']) {
      const { mgr } = bridge();
      await mgr.acceptInboundCall(PARAMS);
      const carrier = connectStream(mgr);
      const hold = mgr.playInboundHold(INBOUND, { preambleClipHashes: [], holdClipHash });
      await vi.waitFor(() => expect(frames(carrier).length).toBeGreaterThanOrEqual(4));
      mgr.stopInboundHold(INBOUND);
      expect(await hold).toBe('released');
      const tone = framesOf(holdTonePcm16());
      expect(same(frames(carrier).slice(0, 4), tone.slice(0, 4))).toBe(true);
      await mgr.forceEndWithOutcome(INBOUND, 'test_over');
    }
  });

  it('a caller who hangs up stops it: aborted, no REST hangup of ours, the call ended by the stream`s close', async () => {
    const { mgr } = bridge();
    await mgr.acceptInboundCall(PARAMS);
    const carrier = connectStream(mgr);
    const hold = mgr.playInboundHold(INBOUND, { preambleClipHashes: ['pre'], holdClipHash: 'hold' });
    await tick(150);
    carrier.close();
    expect(await hold).toBe('aborted');
    expect(plivoAdapter.endCall).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(mockRepo.update).toHaveBeenCalledWith(LEG, expect.objectContaining({ outcome: 'pstn_stream_closed' })));
  });

  it('stopInboundHold releases it with the caller still on, and the overflow message can then play and hang up', async () => {
    const { mgr } = bridge();
    await mgr.acceptInboundCall(PARAMS);
    const carrier = connectStream(mgr);
    const hold = mgr.playInboundHold(INBOUND, { preambleClipHashes: [], holdClipHash: 'hold' });
    await tick(100);
    mgr.stopInboundHold(INBOUND);
    const atStop = frames(carrier).length;
    expect(await hold).toBe('released');
    expect(mgr.getSession(LEG)).toBeDefined();
    expect(await mgr.playClipSequenceThenHangUp(INBOUND, { clipHashes: ['prompt'], outcome: 'inbound_overflow' })).toBe('completed');
    // Only the overflow clip after the stop: no hold frame interleaved.
    expect(same(frames(carrier).slice(atStop), framesOf(clips.prompt!))).toBe(true);
    expect(plivoAdapter.endCall).toHaveBeenCalledWith('cu-1');
  });

  it('a later hold on the same call replaces the first (released), and one by an unknown id is not_found', async () => {
    const { mgr } = bridge();
    await mgr.acceptInboundCall(PARAMS);
    connectStream(mgr);
    const first = mgr.playInboundHold(INBOUND, { preambleClipHashes: [], holdClipHash: 'hold' });
    await tick(30);
    const second = mgr.playInboundHold(INBOUND, { preambleClipHashes: [], holdClipHash: null });
    expect(await first).toBe('released');
    mgr.stopInboundHold(INBOUND);
    expect(await second).toBe('released');
    expect(await mgr.playInboundHold('nobody', { preambleClipHashes: [], holdClipHash: null })).toBe('not_found');
    mgr.stopInboundHold('nobody'); // a no-op
  });
});

describe('recordInboundAudio: the carrier tap', () => {
  it('stops the hold, plays the prompt and the beep, then records the caller with nobody bound, bounded to maxSeconds', async () => {
    const { mgr } = bridge();
    await mgr.acceptInboundCall(PARAMS);
    const carrier = connectStream(mgr);
    const hold = mgr.playInboundHold(INBOUND, { preambleClipHashes: [], holdClipHash: 'hold' });
    await tick(50);
    const atRecord = frames(carrier).length;
    const recording = mgr.recordInboundAudio(INBOUND, { maxSeconds: 0.1, promptClipHashes: ['prompt'], beep: true });
    expect(await hold).toBe('released');
    // Media before the tap is installed is not recorded.
    callerSays(carrier, 3, 0x05);
    const prompt = [...framesOf(clips.prompt!), ...framesOf(recordBeepPcm16())];
    await vi.waitFor(() => expect(mgr.getSession(LEG)!.carrierTap).not.toBeNull(), { timeout: 2000 });
    expect(same(frames(carrier).slice(atRecord), prompt)).toBe(true);
    // 0.1 s of PCM16 16 kHz is 3,200 bytes: five 20 ms frames, the sixth not taken.
    callerSays(carrier, 6);
    const result = await recording;
    expect(result).toMatchObject({ result: 'completed', sampleRate: 16_000, seconds: 0.1 });
    expect(result.pcm16.length).toBe(3200);
    expect(result.pcm16.some((b) => b !== 0)).toBe(true);
    expect(mgr.getSession(LEG)!.carrierTap).toBeNull(); // removed once done
    callerSays(carrier, 2); // and the frames after it go nowhere, without error
    expect(plivoAdapter.endCall).not.toHaveBeenCalled(); // never hangs up
    expect(mgr.getSession(LEG)).toBeDefined();
  });

  it('a caller who hangs up while recording: caller_left with what was captured', async () => {
    const { mgr } = bridge();
    await mgr.acceptInboundCall(PARAMS);
    const carrier = connectStream(mgr);
    const recording = mgr.recordInboundAudio(INBOUND, { maxSeconds: 60 });
    await vi.waitFor(() => expect(mgr.getSession(LEG)!.carrierTap).not.toBeNull());
    callerSays(carrier, 4);
    carrier.close();
    const result = await recording;
    // Four 20 ms frames, less the resampler's few samples of delay.
    expect(result.result).toBe('caller_left');
    expect(result.seconds).toBeCloseTo(0.08, 2);
    expect(result.seconds).toBe(result.pcm16.length / 32_000);
  });

  it('a caller who hangs up during the prompt: caller_left, nothing captured', async () => {
    const { mgr } = bridge();
    await mgr.acceptInboundCall(PARAMS);
    const carrier = connectStream(mgr);
    const recording = mgr.recordInboundAudio(INBOUND, { maxSeconds: 60, beep: true });
    await tick(60);
    carrier.close();
    expect(await recording).toMatchObject({ result: 'caller_left', seconds: 0 });
  });

  it('the wall clock ends it when the carrier stops sending frames', async () => {
    vi.useFakeTimers();
    const { mgr } = bridge();
    await mgr.acceptInboundCall(PARAMS);
    const carrier = connectStream(mgr);
    const recording = mgr.recordInboundAudio(INBOUND, { maxSeconds: 5 });
    await vi.advanceTimersByTimeAsync(10);
    callerSays(carrier, 2);
    await vi.advanceTimersByTimeAsync(5000);
    const result = await recording;
    expect(result.result).toBe('completed');
    expect(result.seconds).toBeCloseTo(0.04, 2);
  });

  it('no live call: not_found; a call that ends before media: no_media', async () => {
    const { mgr } = bridge();
    expect(await mgr.recordInboundAudio(INBOUND, { maxSeconds: 5 })).toMatchObject({ result: 'not_found', seconds: 0 });
    await mgr.acceptInboundCall(PARAMS);
    const recording = mgr.recordInboundAudio(INBOUND, { maxSeconds: 5 });
    await mgr.forceEndWithOutcome(INBOUND, 'gone');
    expect(await recording).toMatchObject({ result: 'no_media', seconds: 0 });
  });

  it('a bound call`s relay is unchanged by a tap: the browser still hears the caller', async () => {
    const { mgr } = bridge();
    await mgr.acceptInboundCall(PARAMS);
    const carrier = connectStream(mgr);
    const station = fakeWs();
    mgr.bindBorrowedBrowserLeg(INBOUND, station as any);
    const recording = mgr.recordInboundAudio(INBOUND, { maxSeconds: 60 });
    await vi.waitFor(() => expect(mgr.getSession(LEG)!.carrierTap).not.toBeNull());
    callerSays(carrier, 2);
    carrier.close();
    expect((await recording).seconds).toBeCloseTo(0.04, 2);
    expect(station.sent.filter((f) => f.event === 'media')).toHaveLength(2);
  });
});

describe('recording at the bind', () => {
  async function boundCall(o: { record?: boolean; redis?: ReturnType<typeof fakeRedis> | null } = {}) {
    const { mgr } = bridge(o.redis ?? null);
    await mgr.acceptInboundCall({ ...PARAMS, record: o.record ?? true });
    connectStream(mgr);
    return mgr;
  }

  it('starts through the Record API only after `bridged`, with a webhook token minted for its callback', async () => {
    const redis = fakeRedis();
    const mgr = await boundCall({ redis });
    void mgr.playInboundHold(INBOUND, { preambleClipHashes: [], holdClipHash: 'hold' });
    await tick(60);
    expect(plivoAdapter.startRecording).not.toHaveBeenCalled(); // never the hold
    expect(await mgr.verifyWsToken(LEG, 'anything', 'webhook')).toBe(false); // no webhook token yet
    mgr.bindBorrowedBrowserLeg(INBOUND, fakeWs() as any);
    await vi.waitFor(() => expect(plivoAdapter.startRecording).toHaveBeenCalledTimes(1));
    const [carrierCallId, req] = plivoAdapter.startRecording.mock.calls[0]!;
    expect(carrierCallId).toBe('cu-1');
    expect(req).toEqual({
      callbackUrl: expect.stringMatching(new RegExp(`^https://server\\.test/api/v1/webhooks/plivo/webrtc-recording/${LEG}\\?token=[0-9a-f-]{36}$`)),
      timeLimitSeconds: MAX,
    });
    const token = new URL(req.callbackUrl).searchParams.get('token')!;
    expect(await mgr.verifyWsToken(LEG, token, 'webhook')).toBe(true);
    expect(registry.getForCredentialId).toHaveBeenCalledWith('plivo', 'cred-1', 'call_control', 'tenant-a');
    // `bridged` was announced first: the recording runs in the background behind it.
    expect(lifecycle.map((e) => e.phase)).toEqual(['answered', 'bridged']);
  });

  it('a recording callback while the call is live is kept for the terminal write', async () => {
    const mgr = await boundCall();
    mgr.bindBorrowedBrowserLeg(INBOUND, fakeWs() as any);
    await vi.waitFor(() => expect(plivoAdapter.startRecording).toHaveBeenCalled());
    await mgr.handleCarrierRecording(LEG, 'plivo', { recordingUrl: 'https://media.plivo.com/r.mp3', carrierCallId: 'cu-1' });
    await mgr.forceEndWithOutcome(INBOUND, 'agent_hangup');
    expect(mockRepo.update).toHaveBeenCalledWith(LEG, expect.objectContaining({ recording_url: 'https://media.plivo.com/r.mp3' }));
  });

  it('never for a call that did not ask, nor over the account`s ceiling, nor on a carrier that cannot record on demand', async () => {
    const cases: Array<() => Promise<WebRtcBridgeManager>> = [
      () => boundCall({ record: false }),
      async () => { mockSettings.getAllowRecording.mockResolvedValueOnce(false); return boundCall(); },
      async () => { mockSettings.getAllowRecording.mockResolvedValueOnce(null); return boundCall(); },
      async () => { plivoAdapter.capabilities = { cancelRinging: true }; return boundCall(); },
    ];
    for (const make of cases) {
      const mgr = await make();
      expect(mgr.bindBorrowedBrowserLeg(INBOUND, fakeWs() as any)).toBe(true);
      await tick(20);
      await mgr.forceEndWithOutcome(INBOUND, 'agent_hangup');
    }
    expect(plivoAdapter.startRecording).not.toHaveBeenCalled();
  });

  it('a carrier that refuses it leaves the call alone', async () => {
    plivoAdapter.startRecording.mockRejectedValueOnce(new Error('refused'));
    const mgr = await boundCall();
    mgr.bindBorrowedBrowserLeg(INBOUND, fakeWs() as any);
    await vi.waitFor(() => expect(plivoAdapter.startRecording).toHaveBeenCalled());
    await tick(10);
    expect(mgr.getSession(LEG)).toBeDefined();
    expect(plivoAdapter.endCall).not.toHaveBeenCalled();
  });

  it('a dropped station socket after the bind is held for browserCloseGraceMs and resumed by a re-attach', async () => {
    vi.useFakeTimers();
    const { mgr } = bridge();
    await mgr.acceptInboundCall(PARAMS);
    connectStream(mgr);
    const first = fakeWs();
    mgr.bindBorrowedBrowserLeg(INBOUND, first as any);
    first.close();
    await vi.advanceTimersByTimeAsync(7000);
    expect(mgr.reattachBorrowedBrowserLeg(INBOUND, fakeWs() as any)).toBe(true);
    await vi.advanceTimersByTimeAsync(5000);
    expect(mgr.getSession(LEG)).toBeDefined();
    expect(lifecycle.filter((e) => e.phase === 'bridged')).toHaveLength(1);
  });
});
