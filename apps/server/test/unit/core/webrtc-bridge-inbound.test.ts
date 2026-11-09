import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// An inbound call through the bridge (docs/inbound.md §3; `acceptInboundCall`,
// `playClipSequenceThenHangUp`), on the REAL Plivo carrier module, with a stub adapter on the
// credential the call arrived on:
//
//  - the leg the answer webhook wrote is taken in: a session answered at once, the stream URL
//    with a provider token, no carrier request, the `answered` lifecycle event on its correlation;
//  - admission never refuses (IB5): the account's own limit holds it with no slot, a full global
//    or carrier scope holds it to hear why, and `takeSlots: false` takes none;
//  - a retried answer gets the live session's stream, with no second admission;
//  - the media deadline ends a stream the carrier never opens, and hangs it up by its call id;
//  - the clip sequence waits for the carrier's media, plays every clip paced, then hangs up by REST
//    under the caller's outcome; a caller who leaves mid-clip stops it with no hangup of ours.
//
// Mock harness mirrors webrtc-bridge-plivo.test.ts (project convention: no shared test utilities).
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

const { mockRepo } = vi.hoisted(() => ({
  mockRepo: { create: vi.fn(), findById: vi.fn().mockResolvedValue(null), update: vi.fn().mockResolvedValue(null) },
}));
vi.mock('@magick-agency/db/repositories/agency-call.repository', () => ({ webrtcCallRepository: mockRepo }));
vi.mock('@magick-agency/db/repositories/account-settings.repository', () => ({
  accountSettingsRepository: { getAllowRecording: vi.fn().mockResolvedValue(true), getWebrtcMaxDurationSeconds: vi.fn().mockResolvedValue(600) },
}));

const { plivoAdapter, registry } = vi.hoisted(() => {
  const plivoAdapter = {
    name: 'plivo',
    capabilities: { cancelRinging: true, queuesOutboundDials: false, ringTimeoutSeconds: 45 },
    initiateCall: vi.fn(),
    getCallStatus: vi.fn().mockResolvedValue({ status: 'unknown' }),
    endCall: vi.fn().mockResolvedValue(undefined),
    cancelDialRequest: vi.fn().mockResolvedValue('canceled'),
    generateAnswerResponse: vi.fn().mockReturnValue('<Response/>'),
    verifyCarrierRequest: vi.fn().mockReturnValue(true),
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
// 8 kHz PCM16 clips: `short` is 60 ms (3 frames), `long` 2 s.
const { clips } = vi.hoisted(() => ({
  clips: {
    short: { pcm16: Buffer.alloc(480 * 2, 1), sampleRate: 8000 },
    long: { pcm16: Buffer.alloc(16_000 * 2, 1), sampleRate: 8000 },
  } as Record<string, { pcm16: Buffer; sampleRate: number }>,
}));
vi.mock('../../../src/tts/tts-file-cache.js', () => ({ readTtsPcm: (hash: string) => clips[hash] ?? null }));

import { WebRtcBridgeManager, INBOUND_MEDIA_DEADLINE_SECONDS, type WebRtcInboundCallParams } from '../../../src/core/webrtc-bridge-manager.js';

function fakeWs() {
  const handlers: Record<string, ((...a: any[]) => void)[]> = {};
  return {
    readyState: 1,
    OPEN: 1,
    bufferedAmount: 0,
    sent: [] as any[],
    send(s: string) { this.sent.push(JSON.parse(s)); },
    on(ev: string, cb: (...a: any[]) => void) { (handlers[ev] ||= []).push(cb); },
    off(ev: string, cb: (...a: any[]) => void) { const l = handlers[ev]; if (l) l.splice(l.indexOf(cb), 1); },
    emit(ev: string, ...a: any[]) { (handlers[ev] || []).slice().forEach((cb) => cb(...a)); },
    close() { this.readyState = 3; this.emit('close'); },
  };
}

function makeGuardHost(o: { global?: boolean; account?: boolean } = {}) {
  return {
    concurrencyGuard: { tryAcquire: vi.fn().mockResolvedValue(o.global ?? true), release: vi.fn().mockResolvedValue(undefined) },
    accountConcurrencyGuard: { tryAcquire: vi.fn().mockResolvedValue(o.account ?? true), release: vi.fn().mockResolvedValue(undefined) },
    triggerDequeue: vi.fn(),
    wakeSelfHeal: vi.fn(),
  };
}

const LEG = '0b6f2a3c-1d4e-4f5a-8b6c-7d8e9f0a1b2c';
const INBOUND = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const PARAMS: WebRtcInboundCallParams = {
  callId: LEG, correlationId: INBOUND, tenantId: 'tenant-a', accountId: 'a1', provider: 'plivo',
  telephonyCredentialId: 'cred-1', callerId: '+14155550101', destinationPhone: '+919812345678',
  carrierCallId: 'cu-1', takeSlots: true,
};

/** The carrier opens our stream and negotiates μ-law, as Plivo does after running our answer XML. */
function connectStream(mgr: WebRtcBridgeManager) {
  const ws = fakeWs();
  expect(mgr.attachPstnLeg(LEG, ws as any)).toBe(true);
  ws.emit('message', JSON.stringify({
    event: 'start', start: { callId: 'cu-1', streamId: 'st-1', mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: 8000 } },
  }));
  return ws;
}

const frames = (ws: ReturnType<typeof fakeWs>) => ws.sent.filter((f) => f.event === 'playAudio');

let lifecycle: any[] = [];
beforeEach(() => {
  vi.clearAllMocks();
  lifecycle = [];
  registry.getForCredentialId.mockImplementation(async () => plivoAdapter);
});
afterEach(() => { vi.useRealTimers(); });

function bridge(host = makeGuardHost()) {
  const mgr = new WebRtcBridgeManager(host as any, null);
  mgr.onLifecycle((e) => lifecycle.push(e));
  return { mgr, host };
}

describe('acceptInboundCall', () => {
  it('takes the leg in: answered at once, the stream with a provider token, the slots, and nothing sent to the carrier', async () => {
    const { mgr, host } = bridge();
    const accepted = await mgr.acceptInboundCall(PARAMS);
    expect(accepted).toEqual({
      accepted: true, capacity: 'admitted', maxDurationSeconds: 600,
      streamUrl: expect.stringMatching(new RegExp(`^wss://server\\.test/api/v1/webrtc-call/${LEG}/pstn-stream\\?token=[0-9a-f-]{36}$`)),
    });
    expect(host.concurrencyGuard.tryAcquire).toHaveBeenCalledTimes(1);
    expect(host.accountConcurrencyGuard.tryAcquire).toHaveBeenCalledWith(expect.any(String), 'tenant-a', 'a1', 660);
    expect(plivoAdapter.initiateCall).not.toHaveBeenCalled();
    expect(mockRepo.create).not.toHaveBeenCalled();
    const session = mgr.getSession(LEG)!;
    expect(session).toMatchObject({ correlationId: INBOUND, carrierCallId: 'cu-1', telephonyCredentialId: 'cred-1', providerMediaReady: false });
    expect(session.answeredAt).not.toBeNull();
    expect(lifecycle).toEqual([expect.objectContaining({ phase: 'answered', callId: LEG, correlationId: INBOUND })]);
  });

  it('over the account`s own limit it is held anyway, with no slot (IB5)', async () => {
    const { mgr, host } = bridge(makeGuardHost({ account: false }));
    expect(await mgr.acceptInboundCall(PARAMS)).toMatchObject({ accepted: true, capacity: 'account_full' });
    expect(mgr.getSession(LEG)!.slotsHeld).toBe(false);
    expect(host.concurrencyGuard.release).toHaveBeenCalled(); // the global slot taken before the account refused
  });

  it('with the global scope full it is held to hear why (no_capacity), with no slot', async () => {
    const { mgr } = bridge(makeGuardHost({ global: false }));
    expect(await mgr.acceptInboundCall(PARAMS)).toMatchObject({ accepted: true, capacity: 'no_capacity' });
    expect(mgr.getSession(LEG)!.slotsHeld).toBe(false);
  });

  it('takeSlots: false takes none', async () => {
    const { mgr, host } = bridge();
    expect(await mgr.acceptInboundCall({ ...PARAMS, takeSlots: false })).toMatchObject({ accepted: true, capacity: 'not_requested' });
    expect(host.concurrencyGuard.tryAcquire).not.toHaveBeenCalled();
  });

  it('a retried answer gets the same stream and no second admission', async () => {
    const { mgr, host } = bridge();
    const first = await mgr.acceptInboundCall(PARAMS);
    const second = await mgr.acceptInboundCall(PARAMS);
    expect(second).toEqual(first);
    expect(host.concurrencyGuard.tryAcquire).toHaveBeenCalledTimes(1);
  });

  it('a carrier with no stream to offer is refused, nothing held', async () => {
    const { mgr, host } = bridge();
    expect(await mgr.acceptInboundCall({ ...PARAMS, provider: 'nowhere' })).toEqual({ accepted: false, reason: 'stream_unavailable' });
    expect(host.concurrencyGuard.tryAcquire).not.toHaveBeenCalled();
    expect(mgr.getSession(LEG)).toBeUndefined();
  });

  it('the media deadline ends a stream the carrier never opens: failed, hung up by its call id, slots released', async () => {
    vi.useFakeTimers();
    const { mgr, host } = bridge();
    await mgr.acceptInboundCall(PARAMS);
    await vi.advanceTimersByTimeAsync(INBOUND_MEDIA_DEADLINE_SECONDS * 1000 + 10);
    expect(mgr.getSession(LEG)).toBeUndefined();
    expect(mockRepo.update).toHaveBeenCalledWith(LEG, expect.objectContaining({ status: 'failed', outcome: 'inbound_media_timeout' }));
    expect(registry.getForCredentialId).toHaveBeenCalledWith('plivo', 'cred-1', 'call_control', 'tenant-a');
    expect(plivoAdapter.endCall).toHaveBeenCalledWith('cu-1');
    expect(host.accountConcurrencyGuard.release).toHaveBeenCalled();
  });

  it('a stream that opens and negotiates in time is not ended by the deadline', async () => {
    vi.useFakeTimers();
    const { mgr } = bridge();
    await mgr.acceptInboundCall(PARAMS);
    connectStream(mgr);
    await vi.advanceTimersByTimeAsync(INBOUND_MEDIA_DEADLINE_SECONDS * 1000 + 10);
    expect(mgr.getSession(LEG)).toBeDefined();
  });
});

describe('playClipSequenceThenHangUp', () => {
  it('waits for the carrier`s media, plays every clip paced in the carrier`s framing, then hangs up by REST under the outcome', async () => {
    const { mgr } = bridge();
    await mgr.acceptInboundCall(PARAMS);
    const playing = mgr.playClipSequenceThenHangUp(INBOUND, { clipHashes: ['short', 'missing', 'short'], outcome: 'inbound_overflow' });
    await new Promise((r) => setTimeout(r, 20));
    expect(plivoAdapter.endCall).not.toHaveBeenCalled(); // no media yet: nothing played, nothing hung up
    const ws = connectStream(mgr);
    expect(await playing).toBe('completed');
    // 2 × 480 μ-law bytes in 20 ms frames of 160, the missing clip skipped.
    expect(frames(ws).map((f) => Buffer.from(f.media.payload, 'base64').length)).toEqual([160, 160, 160, 160, 160, 160]);
    expect(frames(ws)[0]).toMatchObject({ event: 'playAudio', media: { contentType: 'audio/x-mulaw', sampleRate: 8000 } });
    expect(plivoAdapter.endCall).toHaveBeenCalledWith('cu-1');
    expect(mockRepo.update).toHaveBeenCalledWith(LEG, expect.objectContaining({ status: 'completed', outcome: 'inbound_overflow' }));
    expect(lifecycle.at(-1)).toMatchObject({ phase: 'ended', correlationId: INBOUND, outcome: 'inbound_overflow' });
  });

  it('a caller who hangs up mid-clip stops it: aborted, no REST hangup of ours, the call ended by the stream`s close', async () => {
    const { mgr } = bridge();
    await mgr.acceptInboundCall(PARAMS);
    const ws = connectStream(mgr);
    const playing = mgr.playClipSequenceThenHangUp(INBOUND, { clipHashes: ['long', 'short'], outcome: 'inbound_overflow' });
    await new Promise((r) => setTimeout(r, 120));
    ws.close();
    expect(await playing).toBe('aborted');
    expect(frames(ws).length).toBeLessThan(100);
    expect(plivoAdapter.endCall).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(mockRepo.update).toHaveBeenCalledWith(LEG, expect.objectContaining({ outcome: 'pstn_stream_closed' })));
  });

  it('a call that ends before the carrier`s media is ready: no_media, nothing played', async () => {
    const { mgr } = bridge();
    await mgr.acceptInboundCall(PARAMS);
    const playing = mgr.playClipSequenceThenHangUp(INBOUND, { clipHashes: ['short'], outcome: 'inbound_overflow' });
    expect(await mgr.forceEndWithOutcome(INBOUND, 'caller_gone')).toBe(true);
    expect(await playing).toBe('no_media');
  });

  it('no live call by that correlation: not_found', async () => {
    const { mgr } = bridge();
    expect(await mgr.playClipSequenceThenHangUp(INBOUND, { clipHashes: ['short'], outcome: 'x' })).toBe('not_found');
  });
});
