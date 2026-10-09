import { describe, it, expect, vi, beforeEach } from 'vitest';

// FIXTURE: a call is dialled through the dialer's entry point, `createBridgedCall`, with the
// browser socket borrowed at dial time (`dial()` below), on VoiceLink (the only carrier), and
// ended via `forceEndWithOutcome(ATTEMPT, 'ended_by_user')` (a `localHangup` under that outcome).
// `getWebrtcMaxDurationSeconds` -> null resolves to the 1800 default.
// There is no billing settlement; cases assert the terminal row write / slot release / analytics
// event instead.
//
// VoiceLink specifics: recording is requested through the dial request's `enableRecording`;
// an answered teardown is deferred to the carrier's `call.ended` (the `ending` cases); the relay
// transcodes (the 'a payload exactly at the limit is still relayed' case).
//
// Q6: the ws-token check returns FALSE when the stored key is missing (get -> null); the
// 'WebRtcBridgeManager ws tokens — Q6 legitimate paths' describe covers a live call, the
// post-end webhook grace, a SET that failed at mint, and Redis absent/erroring.

// ---------------------------------------------------------------------------
// Self-contained mock harness (project convention: no shared test utilities).
// ---------------------------------------------------------------------------

vi.mock('@magick-agency/observability', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
  createChildLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../../../src/config/index.js', () => ({
  config: {
    redis: { keyPrefix: '' },
    telephony: {
      vobiz: { webhookBaseUrl: 'https://server.test/api/v1/webhooks/vobiz' },
      voicelink: { webhookBaseUrl: 'https://server.test/api/v1/webhooks/voicelink' },
      plivo: { webhookBaseUrl: 'https://server.test/api/v1/webhooks/plivo' },
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

// Governance recording ceiling read at dial. Default null ⇒ inherit true
// (no ceiling), preserving pre-governance test behavior; a test can override it.
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

const { mockAnalytics } = vi.hoisted(() => ({
  mockAnalytics: {
    trackWebrtcCallInitiated: vi.fn(),
    trackWebrtcCallRejected: vi.fn(),
    trackWebrtcCallCompleted: vi.fn(),
  },
}));
vi.mock('../../../src/analytics/posthog.js', () => mockAnalytics);

import { WebRtcBridgeManager, WebRtcCallError } from '../../../src/core/webrtc-bridge-manager.js';
import { encodeAlaw, decodeAlaw } from '../../../src/utils/audio.js';

// ── Tone helpers for media-relay fidelity assertions ───────────────────────
function alaw8kTone(freq: number, samples: number, amp = 8000): Buffer {
  const pcm = new Int16Array(samples);
  for (let i = 0; i < samples; i++) pcm[i] = Math.round(amp * Math.sin((2 * Math.PI * freq * i) / 8000));
  return encodeAlaw(pcm);
}
function pcm16kTone(freq: number, samples: number, amp = 8000): Buffer {
  const pcm = new Int16Array(samples);
  for (let i = 0; i < samples; i++) pcm[i] = Math.round(amp * Math.sin((2 * Math.PI * freq * i) / 16000));
  return Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
}
function decodedPeak(pcmBuf: Buffer): number {
  const s = new Int16Array(pcmBuf.buffer, pcmBuf.byteOffset, pcmBuf.byteLength / 2);
  let peak = 0;
  for (const v of s) peak = Math.max(peak, Math.abs(v));
  return peak;
}

// ── Fake WebSocket ───────────────────────────────────────────────────────
// Includes `off`: a borrowed socket's listeners are removed at detach.
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
const VL_PARAMS = { ...PARAMS, provider: 'voicelink' as const };
const ATTEMPT = 'att-1';

/** The dialer's entry point: dial with the browser socket borrowed. */
async function dial(
  mgr: WebRtcBridgeManager,
  params: Record<string, unknown> = VL_PARAMS,
  browser: ReturnType<typeof fakeWs> = fakeWs(),
) {
  const record = await mgr.createBridgedCall({
    ...(params as typeof PARAMS),
    browserSocket: browser as any,
    campaignId: 'camp-1',
    agencyAttemptId: ATTEMPT,
  });
  return { record, browser };
}
/** Ends the call as the user (`ended_by_user`). */
const endByUser = (mgr: WebRtcBridgeManager) => mgr.forceEndWithOutcome(ATTEMPT, 'ended_by_user');

function negotiateVoicelink(pstn: ReturnType<typeof fakeWs>): void {
  pstn.emit('message', JSON.stringify({
    event: 'start',
    start: { call_sid: 'c', stream_sid: 's', media_format: { encoding: 'audio/alaw', sample_rate: '8000' } },
  }));
}
/** The carrier's confirmation of a deferred VoiceLink teardown. */
async function carrierEnded(mgr: WebRtcBridgeManager): Promise<void> {
  await mgr.handleVoicelinkStatus('call-1', {
    providerCallId: 'c', callId: 'call-1', eventType: 'hangup', timestamp: new Date(),
    metadata: { event: 'call.ended', call: { id: 'c', status: 'ended' } },
  });
}

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

describe('WebRtcBridgeManager dial', () => {
  it('acquires shared slots, persists, and places the carrier leg', async () => {
    const cm = makeCallManager();
    const mgr = new WebRtcBridgeManager(cm as any, null);

    const { record } = await dial(mgr);

    expect(cm.concurrencyGuard.tryAcquire).toHaveBeenCalledTimes(1);
    // The per-account acquire carries a lock-TTL override = maxDuration + 60 so the
    // lock outlives a long human bridge call (default 1800 + 60 = 1860).
    expect(cm.accountConcurrencyGuard.tryAcquire).toHaveBeenCalledWith(expect.any(String), 't1', 'a1', 1860);
    expect(cm.concurrencyGuard.tryAcquire).toHaveBeenCalledWith(expect.any(String), 1860);
    expect(mockRepo.create).toHaveBeenCalledTimes(1);
    expect(record.id).toBe('call-1');
    // A borrowed leg mints no browser token (pinned in the bridged suite).

    const initArg = mockAdapter.initiateCall.mock.calls[0]![0];
    expect(initArg.from).toBe('+14155550100');
    expect(initArg.to).toBe('+14155550199');
    expect(initArg.webhookUrl).toContain('/webrtc-answer/call-1');
    expect(initArg.statusCallbackUrl).toContain('/webrtc-status/call-1');
    expect(initArg.machineDetection).toBe(false);
    // provider_call_id persisted
    expect(mockRepo.update).toHaveBeenCalledWith('call-1', { provider_call_id: 'pcid-1' });

    await endByUser(mgr); // cleanup timer
  });

  it('rejects (429) on the global limit without touching the account guard or DB', async () => {
    const cm = makeCallManager();
    cm.concurrencyGuard.tryAcquire.mockResolvedValue(false);
    const mgr = new WebRtcBridgeManager(cm as any, null);

    await expect(dial(mgr)).rejects.toMatchObject({
      code: 'global_concurrency_limit',
      statusCode: 429,
    });
    expect(cm.accountConcurrencyGuard.tryAcquire).not.toHaveBeenCalled();
    expect(mockRepo.create).not.toHaveBeenCalled();
  });

  it('releases the global slot when the account limit is hit', async () => {
    const cm = makeCallManager();
    cm.accountConcurrencyGuard.tryAcquire.mockResolvedValue(false);
    const mgr = new WebRtcBridgeManager(cm as any, null);

    await expect(dial(mgr)).rejects.toBeInstanceOf(WebRtcCallError);
    expect(cm.concurrencyGuard.release).toHaveBeenCalledTimes(1);
    expect(mockRepo.create).not.toHaveBeenCalled();
  });

  it('ends + releases when the provider rejects initiation', async () => {
    const cm = makeCallManager();
    mockAdapter.initiateCall.mockRejectedValue(new Error('vobiz 400'));
    const mgr = new WebRtcBridgeManager(cm as any, null);

    await expect(dial(mgr)).rejects.toMatchObject({ code: 'telephony_init_failed' });
    // slot released via endCall path
    expect(cm.concurrencyGuard.release).toHaveBeenCalledTimes(1);
    expect(cm.accountConcurrencyGuard.release).toHaveBeenCalledTimes(1);
  });
});

// REGRESSION: the max-duration timer hardcoded status 'completed', so a call that
// rang for the full ceiling without anyone picking up was recorded as a successful
// call and counted as connected by WEBRTC_CALLS_CONNECTED_STATUSES in usage
// reporting. Every other teardown path here (browser-close, graceful shutdown)
// already anchored on answeredAt; the timer was the lone outlier. Same defect as
// the AI-call timeout path had.
describe('WebRtcBridgeManager max-duration timer', () => {
  /** Fire the max-duration timer the manager actually armed on this session. */
  async function fireMaxDurationTimer(mgr: WebRtcBridgeManager, callId: string, opts: { confirm?: boolean } = {}) {
    const session = mgr.getSession(callId) as unknown as { maxDurationTimer: NodeJS.Timeout | null };
    const timer = session.maxDurationTimer;
    expect(timer, 'max-duration timer should be armed').toBeTruthy();
    const onFire = (timer as unknown as { _onTimeout: () => void })._onTimeout;
    clearTimeout(timer as NodeJS.Timeout);
    onFire();
    // an ANSWERED VoiceLink call defers its teardown to the carrier's
    // `call.ended`; confirm it here.
    if (opts.confirm) {
      await vi.waitFor(() => expect(mgr.getSession(callId)?.ending).toBe(true));
      await carrierEnded(mgr);
    }
    // localHangup is fire-and-forget inside the timer — let it settle.
    await vi.waitFor(() => expect(mockRepo.update).toHaveBeenCalledWith(
      'call-1', expect.objectContaining({ status: expect.any(String), ended_at: expect.any(Date) }),
    ));
  }

  /** The status written by the terminal update (the one carrying ended_at). */
  function terminalStatus() {
    const terminal = mockRepo.update.mock.calls.filter(
      (c: any[]) => c[1]?.ended_at !== undefined,
    );
    expect(terminal).toHaveLength(1);
    return (terminal[0]![1] as { status: string }).status;
  }

  it('settles `canceled` when the ceiling is hit without the call being answered', async () => {
    const cm = makeCallManager();
    const mgr = new WebRtcBridgeManager(cm as any, null);
    await dial(mgr);

    expect(mgr.getSession('call-1')?.answeredAt).toBeNull();
    mockRepo.update.mockClear();

    await fireMaxDurationTimer(mgr, 'call-1');

    expect(terminalStatus()).toBe('canceled');
  });

  it('settles `completed` when an answered call hits the ceiling', async () => {
    const cm = makeCallManager();
    const mgr = new WebRtcBridgeManager(cm as any, null);
    await dial(mgr);

    mgr.getSession('call-1')!.markAnswered();
    mockRepo.update.mockClear();

    await fireMaxDurationTimer(mgr, 'call-1', { confirm: true });

    expect(terminalStatus()).toBe('completed');
  });
});

describe('WebRtcBridgeManager media relay', () => {
  it('drops browser audio while the PSTN leg is not connected', async () => {
    const cm = makeCallManager();
    const mgr = new WebRtcBridgeManager(cm as any, null);
    const { browser } = await dial(mgr);

    // no PSTN leg yet
    browser.emit('message', JSON.stringify({ event: 'media', media: { payload: 'AAAA' } }));
    // nothing thrown, nothing relayed
    await endByUser(mgr);
  });
});

describe('WebRtcBridgeManager media relay — VoiceLink (A-law transcode)', () => {
  it('transcodes browser PCM16 16k → A-law 8k and PSTN A-law 8k → PCM16 16k', async () => {
    const cm = makeCallManager();
    const mgr = new WebRtcBridgeManager(cm as any, null);
    const { browser } = await dial(mgr, VL_PARAMS);

    const pstn = fakeWs();
    mgr.attachPstnLeg('call-1', pstn as any);

    // VoiceLink gates relay until a valid `start` (A-law 8kHz) negotiates the stream.
    pstn.emit('message', JSON.stringify({
      event: 'start',
      stream_sid: 'stream_x',
      start: {
        stream_sid: 'stream_x',
        call_sid: 'carrier-call-9',
        media_format: { encoding: 'audio/alaw', sample_rate: '8000' },
      },
    }));
    expect(mgr.getSession('call-1')!.providerMediaReady).toBe(true);
    expect(mgr.getSession('call-1')!.carrierCallId).toBe('carrier-call-9');

    // browser → pstn: 320 samples PCM16 @16k (20ms) → ~160 A-law bytes @8k. The
    // stateful resampler holds back ~1 kernel of samples on the first frame for
    // cross-frame continuity, so assert the frame shape + a bounded length.
    const pcm16k = Buffer.alloc(320 * 2); // silence — we assert framing + length
    browser.emit('message', JSON.stringify({
      event: 'media', media: { payload: pcm16k.toString('base64') },
    }));
    const b2p = pstn.sent.find((m) => m.event === 'media');
    expect(b2p).toBeDefined();
    // VoiceLink frame shape: no contentType/sampleRate/stream_sid.
    expect(b2p.media).not.toHaveProperty('contentType');
    expect(b2p.media).not.toHaveProperty('sampleRate');
    const b2pLen = Buffer.from(b2p.media.payload, 'base64').length;
    expect(b2pLen).toBeGreaterThan(120);
    expect(b2pLen).toBeLessThanOrEqual(160);

    // pstn → browser: 160 A-law bytes @8k → ~640 bytes PCM16 @16k (bounded by latency).
    const alaw = Buffer.alloc(160, 0xd5); // A-law silence
    pstn.emit('message', JSON.stringify({
      event: 'media', media: { payload: alaw.toString('base64') },
    }));
    const p2b = browser.sent.find((m) => m.event === 'media');
    expect(p2b).toBeDefined();
    const p2bLen = Buffer.from(p2b.media.payload, 'base64').length;
    expect(p2bLen).toBeGreaterThan(480);
    expect(p2bLen).toBeLessThanOrEqual(640);

    await endByUser(mgr);
  });

  it('handleVoicelinkStatus answer anchors talk-time and goes in_progress', async () => {
    const cm = makeCallManager();
    const mgr = new WebRtcBridgeManager(cm as any, null);
    const { browser } = await dial(mgr, VL_PARAMS);

    await mgr.handleVoicelinkStatus('call-1', {
      providerCallId: 'pcid-1', callId: 'call-1', eventType: 'answer', timestamp: new Date(), metadata: {},
    });

    const session = mgr.getSession('call-1')!;
    expect(session.status).toBe('in_progress');
    expect(session.answeredAt).toBeTruthy();
    expect(browser.sent).toContainEqual({ event: 'status', status: 'answered' });
    await endByUser(mgr);
  });

  it('passes the pstn-stream URL as mediaStreamUrl to the VoiceLink adapter', async () => {
    const cm = makeCallManager();
    const mgr = new WebRtcBridgeManager(cm as any, null);
    await dial(mgr, VL_PARAMS);
    const arg = mockAdapter.initiateCall.mock.calls[0]![0];
    // URL carries a purpose-bound provider token (verified on pstn-stream connect).
    expect(arg.mediaStreamUrl).toContain('wss://server.test/api/v1/webrtc-call/call-1/pstn-stream?token=');
    await endByUser(mgr);
  });

  it('drops a malformed media frame instead of throwing (no replica crash)', async () => {
    const cm = makeCallManager();
    const mgr = new WebRtcBridgeManager(cm as any, null);
    const { browser } = await dial(mgr, VL_PARAMS);
    const pstn = fakeWs();
    mgr.attachPstnLeg('call-1', pstn as any);
    // Negotiate the stream so media isn't dropped by the media-ready gate (we want
    // to exercise the transcode try/catch, not the gate).
    pstn.emit('message', JSON.stringify({
      event: 'start',
      start: { stream_sid: 's', call_sid: 'c', media_format: { encoding: 'audio/alaw', sample_rate: '8000' } },
    }));

    // Non-string payload → Buffer.from(...,'base64') would throw synchronously.
    // The handler must swallow it (a throw here is an uncaught ws-listener error).
    expect(() => browser.emit('message', JSON.stringify({
      event: 'media', media: { payload: 12345 },
    }))).not.toThrow();
    expect(() => pstn.emit('message', JSON.stringify({
      event: 'media', media: { payload: { not: 'a string' } },
    }))).not.toThrow();
    // Nothing relayed from the bad frames.
    expect(pstn.sent.filter((m) => m.event === 'media')).toHaveLength(0);
    expect(browser.sent.filter((m) => m.event === 'media')).toHaveLength(0);

    await endByUser(mgr);
  });

  it('classifies a VoiceLink unanswered hangup as no_answer (space variant)', async () => {
    const cm = makeCallManager();
    const mgr = new WebRtcBridgeManager(cm as any, null);
    await dial(mgr, VL_PARAMS);

    // Not answered; carrier reports "NO ANSWER" (space) — must map to no_answer.
    // metadata mirrors what parseVoicelinkWebhook spreads (the raw body).
    await mgr.handleVoicelinkStatus('call-1', {
      providerCallId: 'pcid-1', callId: 'call-1', eventType: 'hangup', timestamp: new Date(),
      metadata: { event: 'call.completed', call: { id: 'pcid-1', callStatus: 'NO ANSWER' } },
    });
    const persisted = mockRepo.update.mock.calls.map((c: any[]) => c[1]).filter(Boolean);
    expect(persisted.some((u: any) => u.status === 'no_answer')).toBe(true);
  });

  it('handleVoicelinkStatus error tears the call down as failed', async () => {
    const cm = makeCallManager();
    const mgr = new WebRtcBridgeManager(cm as any, null);
    await dial(mgr, VL_PARAMS);

    await mgr.handleVoicelinkStatus('call-1', {
      providerCallId: 'pcid-1', callId: 'call-1', eventType: 'error', timestamp: new Date(),
      metadata: { event: 'call.failed', call: { id: 'pcid-1', callStatus: 'FAILED' } },
    });
    expect(mgr.getSession('call-1')).toBeUndefined(); // ended + cleaned up
    const persisted = mockRepo.update.mock.calls.map((c: any[]) => c[1]).filter(Boolean);
    expect(persisted.some((u: any) => u.status === 'failed')).toBe(true);
  });

  it('handleVoicelinkStatus ringing flips state and notifies the browser', async () => {
    const cm = makeCallManager();
    const mgr = new WebRtcBridgeManager(cm as any, null);
    const { browser } = await dial(mgr, VL_PARAMS);

    await mgr.handleVoicelinkStatus('call-1', {
      providerCallId: 'pcid-1', callId: 'call-1', eventType: 'ringing', timestamp: new Date(), metadata: {},
    });
    expect(mgr.getSession('call-1')!.status).toBe('ringing');
    expect(browser.sent).toContainEqual({ event: 'status', status: 'ringing' });
  });

  it('rejects a start frame with an unsupported media format and ends the call', async () => {
    const cm = makeCallManager();
    const mgr = new WebRtcBridgeManager(cm as any, null);
    await dial(mgr, VL_PARAMS);
    const pstn = fakeWs();
    mgr.attachPstnLeg('call-1', pstn as any);

    pstn.emit('message', JSON.stringify({
      event: 'start',
      start: { media_format: { encoding: 'audio/mulaw', sample_rate: '8000' } },
    }));
    await Promise.resolve(); // let the async endCall settle
    await new Promise((r) => setImmediate(r));
    // Unsupported format → call ended, session gone, media never opened.
    expect(mgr.getSession('call-1')).toBeUndefined();
    const persisted = mockRepo.update.mock.calls.map((c: any[]) => c[1]).filter(Boolean);
    expect(persisted.some((u: any) => u.error_code === 'UNSUPPORTED_MEDIA_FORMAT')).toBe(true);
  });

  it('does not relay VoiceLink media before a valid start (media-ready gate)', async () => {
    const cm = makeCallManager();
    const mgr = new WebRtcBridgeManager(cm as any, null);
    const { browser } = await dial(mgr, VL_PARAMS);
    const pstn = fakeWs();
    mgr.attachPstnLeg('call-1', pstn as any);

    // Browser sends audio before the carrier `start` — must be dropped, not relayed.
    browser.emit('message', JSON.stringify({ event: 'media', media: { payload: Buffer.alloc(640).toString('base64') } }));
    expect(pstn.sent.filter((m) => m.event === 'media')).toHaveLength(0);
    expect(mgr.getSession('call-1')!.answeredAt).toBeNull(); // not answered until start
  });

  it('user hangup defers finalization until carrier call.ended (ending state), then finalizes', async () => {
    const cm = makeCallManager();
    const mgr = new WebRtcBridgeManager(cm as any, null);
    const { browser } = await dial(mgr, VL_PARAMS);
    const pstn = fakeWs();
    mgr.attachPstnLeg('call-1', pstn as any);
    // Negotiate + answer.
    pstn.emit('message', JSON.stringify({
      event: 'start', start: { call_sid: 'c', media_format: { encoding: 'audio/alaw', sample_rate: '8000' } },
    }));

    // User hangs up — must NOT settle yet (awaiting carrier confirmation).
    await endByUser(mgr);
    const s = mgr.getSession('call-1');
    expect(s).toBeDefined();
    expect(s!.ending).toBe(true);
    expect(s!.endHandled).toBe(false);
    // Nothing terminal has happened yet —
    // no slot released and no terminal analytics event.
    expect(cm.concurrencyGuard.release).not.toHaveBeenCalled();
    expect(mockAnalytics.trackWebrtcCallCompleted).not.toHaveBeenCalled();
    expect(browser.sent).toContainEqual({ event: 'status', status: 'ending' });

    // Carrier confirms call.ended → now finalize exactly once.
    await carrierEnded(mgr);
    expect(mgr.getSession('call-1')).toBeUndefined();
    expect(mockAnalytics.trackWebrtcCallCompleted).toHaveBeenCalledTimes(1);
    expect(cm.concurrencyGuard.release).toHaveBeenCalledTimes(1);
  });

  it('persists a late call.completed recording URL when no live session exists', async () => {
    const cm = makeCallManager();
    const mgr = new WebRtcBridgeManager(cm as any, null);
    // No dial — session absent. Repo.findById returns a terminal-ish row.
    mockRepo.findById.mockResolvedValueOnce({ id: 'call-1', recording_url: null, provider_call_id: null });

    await mgr.handleVoicelinkStatus('call-1', {
      providerCallId: 'carrier-9', callId: 'call-1', eventType: 'hangup', timestamp: new Date(),
      metadata: { event: 'call.completed', call: { id: 'carrier-9', callStatus: 'ANSWERED', recordingUrl: 'https://rec/late.mp3' } },
    });

    const patched = mockRepo.update.mock.calls.map((c: any[]) => c[1]).filter(Boolean);
    expect(patched.some((u: any) => u.recording_url === 'https://rec/late.mp3')).toBe(true);
    expect(patched.some((u: any) => u.provider_call_id === 'carrier-9')).toBe(true);
  });

  it('classifies an answered remote hangup (real call.ended, no callStatus) as completed', async () => {
    // Regression: the real `call.ended` payload carries `status:"ended"` +
    // `hangupCause:"16"` + `answeredAt` but NO `callStatus`, so norm.wasAnswered is
    // false. Without folding in session.answeredAt this classified as failed and
    // settled `failed` for a genuinely answered call. This is NOT the local-hangup
    // `ending` path — the far end hangs up first, session live, ending=false.
    const cm = makeCallManager();
    const mgr = new WebRtcBridgeManager(cm as any, null);
    await dial(mgr, VL_PARAMS);
    const pstn = fakeWs();
    mgr.attachPstnLeg('call-1', pstn as any);
    // Negotiate the stream (marks answered) then carrier answer webhook.
    pstn.emit('message', JSON.stringify({
      event: 'start', start: { call_sid: 'c', media_format: { encoding: 'audio/alaw', sample_rate: '8000' } },
    }));
    await mgr.handleVoicelinkStatus('call-1', {
      providerCallId: 'c', callId: 'call-1', eventType: 'answer', timestamp: new Date(),
      metadata: { event: 'call.answered', call: { id: 'c', status: 'answered', answeredAt: '2026-07-11T12:31:27.395+05:30' } },
    });
    expect(mgr.getSession('call-1')!.answeredAt).not.toBeNull();

    // Far end hangs up: real call.ended shape — no callStatus, hangupCause 16.
    await mgr.handleVoicelinkStatus('call-1', {
      providerCallId: 'c', callId: 'call-1', eventType: 'hangup', timestamp: new Date(),
      metadata: { event: 'call.ended', call: { id: 'c', status: 'ended', hangupCause: '16', sipStatus: '200', answeredAt: '2026-07-11T12:31:27.000+05:30', durationSec: 4 } },
    });

    expect(mgr.getSession('call-1')).toBeUndefined();
    const persisted = mockRepo.update.mock.calls.map((c: any[]) => c[1]).filter(Boolean);
    expect(persisted.some((u: any) => u.status === 'completed')).toBe(true);
    // Never marked failed / stamped with a telephony error for an answered call.
    expect(persisted.some((u: any) => u.status === 'failed')).toBe(false);
    expect(persisted.some((u: any) => u.error_code === 'TELEPHONY_ERROR')).toBe(false);
  });

  it('finalizes and settles once when the carrier confirmation times out (45s)', async () => {
    vi.useFakeTimers();
    try {
      const cm = makeCallManager();
      const mgr = new WebRtcBridgeManager(cm as any, null);
      await dial(mgr, VL_PARAMS);
      const pstn = fakeWs();
      mgr.attachPstnLeg('call-1', pstn as any);
      pstn.emit('message', JSON.stringify({
        event: 'start', start: { call_sid: 'c', media_format: { encoding: 'audio/alaw', sample_rate: '8000' } },
      }));

      // User hangs up → ending, nothing terminal yet.
      await endByUser(mgr);
      expect(mgr.getSession('call-1')!.ending).toBe(true);
      // No terminal analytics event yet.
      expect(mockAnalytics.trackWebrtcCallCompleted).not.toHaveBeenCalled();

      // Carrier never confirms; the fallback fires → finalize once. 45s,
      // not 20s: VoiceLink reports terminal state at dial+45–75s, so the old
      // bound retired the wait before the carrier had said anything. The
      // unanswered case does not come here at all — it never enters `ending`
      // (see webrtc-bridge-ring-cancel.test.ts).
      await vi.advanceTimersByTimeAsync(45_000);
      expect(mgr.getSession('call-1')).toBeUndefined();
      expect(mockAnalytics.trackWebrtcCallCompleted).toHaveBeenCalledTimes(1);
      expect(cm.concurrencyGuard.release).toHaveBeenCalledTimes(1);
      expect(cm.accountConcurrencyGuard.release).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not double-settle when the timeout and carrier call.ended both fire', async () => {
    vi.useFakeTimers();
    try {
      const cm = makeCallManager();
      const mgr = new WebRtcBridgeManager(cm as any, null);
      await dial(mgr, VL_PARAMS);
      const pstn = fakeWs();
      mgr.attachPstnLeg('call-1', pstn as any);
      pstn.emit('message', JSON.stringify({
        event: 'start', start: { call_sid: 'c', media_format: { encoding: 'audio/alaw', sample_rate: '8000' } },
      }));
      await endByUser(mgr);

      // Carrier confirms first…
      await carrierEnded(mgr);
      // …then the (now-cleared) 45s fallback window elapses — must be a no-op.
      await vi.advanceTimersByTimeAsync(45_000);
      // Exactly one terminal write and one release.
      const terminal = mockRepo.update.mock.calls.filter((c: any[]) => c[1]?.ended_at !== undefined);
      expect(terminal).toHaveLength(1);
      expect(cm.concurrencyGuard.release).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('tears down a silent VoiceLink WS that never sends start (provider_start_timeout, 30s)', async () => {
    vi.useFakeTimers();
    try {
      const cm = makeCallManager();
      const mgr = new WebRtcBridgeManager(cm as any, null);
      await dial(mgr, VL_PARAMS);
      const pstn = fakeWs();
      mgr.attachPstnLeg('call-1', pstn as any);
      // No `start` frame ever arrives.
      await vi.advanceTimersByTimeAsync(30_000);

      expect(mgr.getSession('call-1')).toBeUndefined();
      const persisted = mockRepo.update.mock.calls.map((c: any[]) => c[1]).filter(Boolean);
      expect(persisted.some((u: any) => u.status === 'failed')).toBe(true);
      // Never anchored answered → never billable.
      expect(persisted.some((u: any) => u.answered_at)).toBe(false);
      expect(cm.concurrencyGuard.release).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

// The three recording cases are about the dial-time recording intent and the governance
// ceiling. The intent reaches the carrier as the dial request's `enableRecording`.
describe('WebRtcBridgeManager recording intent', () => {
  it('does not request recording by default (no <Record> options)', async () => {
    const cm = makeCallManager();
    const mgr = new WebRtcBridgeManager(cm as any, null);
    await dial(mgr);

    // create row persisted with recording_requested=false
    expect(mockRepo.create.mock.calls[0]![0].recording_requested).toBe(false);
    expect(mockAdapter.initiateCall.mock.calls[0]![0].enableRecording).toBe(false);

    await endByUser(mgr);
  });

  it('opts into recording: persists intent and wires the <Record> callback URL', async () => {
    const cm = makeCallManager();
    const mgr = new WebRtcBridgeManager(cm as any, null);
    await dial(mgr, { ...VL_PARAMS, record: true });

    expect(mockRepo.create.mock.calls[0]![0].recording_requested).toBe(true);
    // VoiceLink records carrier-side; the intent rides the dial request and the
    // recording URL arrives on the terminal webhook (no callback URL to wire).
    expect(mockAdapter.initiateCall.mock.calls[0]![0].enableRecording).toBe(true);
    // The resolved max duration (1800) is still what bounds the call.
    expect(mockAdapter.initiateCall.mock.calls[0]![0].maxDuration).toBe(1800);

    await endByUser(mgr);
  });

  it('governance ceiling: allow_recording=false suppresses recording even when record:true requested', async () => {
    mockAccountSettings.getAllowRecording.mockResolvedValueOnce(false);
    const cm = makeCallManager();
    const mgr = new WebRtcBridgeManager(cm as any, null);
    await dial(mgr, { ...VL_PARAMS, record: true });

    // The account is not entitled to record → recording_requested is forced false,
    // regardless of the per-call record:true. Mirrors the AI-call allow_recording ceiling.
    expect(mockAccountSettings.getAllowRecording).toHaveBeenCalledWith(PARAMS.tenantId, PARAMS.accountId);
    expect(mockRepo.create.mock.calls[0]![0].recording_requested).toBe(false);
    expect(mockAdapter.initiateCall.mock.calls[0]![0].enableRecording).toBe(false);

    await endByUser(mgr);
  });
});

describe('WebRtcBridgeManager.endCall', () => {
  it('settles, releases shared slots, triggers dequeue, and is idempotent', async () => {
    const cm = makeCallManager();
    const mgr = new WebRtcBridgeManager(cm as any, null);
    await dial(mgr);
    // A VoiceLink answered call would defer to the carrier, so this case
    // ends the unanswered call (finalized at once) and asserts the terminal write, the
    // release and the self-heal wake.

    const first = await endByUser(mgr);
    expect(first).toBe(true);
    expect(mockRepo.update).toHaveBeenCalledWith('call-1', expect.objectContaining({ status: 'canceled', ended_at: expect.any(Date) }));
    expect(cm.concurrencyGuard.release).toHaveBeenCalledTimes(1);
    expect(cm.accountConcurrencyGuard.release).toHaveBeenCalledTimes(1);
    expect(cm.wakeSelfHeal).toHaveBeenCalled();
    expect(cm.triggerDequeue).not.toHaveBeenCalled();

    // session gone → idempotent second call is a no-op
    expect(mgr.getSession('call-1')).toBeUndefined();
    const second = await endByUser(mgr);
    expect(second).toBe(false);
    expect(cm.concurrencyGuard.release).toHaveBeenCalledTimes(1);
  });

  it('hangs up the provider leg when ending an active call', async () => {
    const cm = makeCallManager();
    const mgr = new WebRtcBridgeManager(cm as any, null);
    await dial(mgr);
    await endByUser(mgr);
    expect(mockAdapter.endCall).toHaveBeenCalledWith('pcid-1');
  });
});

describe('WebRtcBridgeManager.gracefulShutdown', () => {
  it('ends + settles + releases every active call', async () => {
    const cm = makeCallManager();
    const mgr = new WebRtcBridgeManager(cm as any, null);
    await dial(mgr);
    expect(mgr.getActiveCount()).toBe(1);

    await mgr.gracefulShutdown();

    expect(mgr.getActiveCount()).toBe(0);
    expect(mockAdapter.endCall).toHaveBeenCalledWith('pcid-1');
    // The terminal row.
    expect(mockRepo.update).toHaveBeenCalledWith('call-1', expect.objectContaining({
      status: 'canceled', outcome: 'service_shutdown',
    }));
    expect(cm.concurrencyGuard.release).toHaveBeenCalledTimes(1);
    expect(cm.accountConcurrencyGuard.release).toHaveBeenCalledTimes(1);
  });

  it('is a no-op with no active calls', async () => {
    const mgr = new WebRtcBridgeManager(makeCallManager() as any, null);
    await expect(mgr.gracefulShutdown()).resolves.toBeUndefined();
  });
});

describe('WebRtcBridgeManager PostHog analytics', () => {
  it('emits webrtc_call_initiated once on a successful create', async () => {
    const mgr = new WebRtcBridgeManager(makeCallManager() as any, null);
    await dial(mgr);
    expect(mockAnalytics.trackWebrtcCallInitiated).toHaveBeenCalledTimes(1);
    expect(mockAnalytics.trackWebrtcCallInitiated).toHaveBeenCalledWith(expect.objectContaining({ id: 'call-1' }));
    await endByUser(mgr);
  });

  it('emits webrtc_call_rejected (global_concurrency_limit) and no initiated', async () => {
    const cm = makeCallManager();
    cm.concurrencyGuard.tryAcquire.mockResolvedValue(false);
    const mgr = new WebRtcBridgeManager(cm as any, null);
    await expect(dial(mgr)).rejects.toThrow();
    expect(mockAnalytics.trackWebrtcCallRejected).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'global_concurrency_limit', tenantId: 't1', accountId: 'a1' }));
    expect(mockAnalytics.trackWebrtcCallInitiated).not.toHaveBeenCalled();
  });

  it('emits webrtc_call_rejected (account_concurrency_limit)', async () => {
    const cm = makeCallManager();
    cm.accountConcurrencyGuard.tryAcquire.mockResolvedValue(false);
    const mgr = new WebRtcBridgeManager(cm as any, null);
    await expect(dial(mgr)).rejects.toThrow();
    expect(mockAnalytics.trackWebrtcCallRejected).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'account_concurrency_limit' }));
  });

  it('webrtc_call_completed: connected=false + ended_by=user on an unanswered user hangup', async () => {
    const mgr = new WebRtcBridgeManager(makeCallManager() as any, null);
    await dial(mgr);
    await endByUser(mgr);
    expect(mockAnalytics.trackWebrtcCallCompleted).toHaveBeenCalledWith(expect.objectContaining({
      callId: 'call-1', status: 'canceled', connected: false, endedBy: 'user',
    }));
  });

  it('webrtc_call_completed: connected=true + ended_by=remote on answered carrier hangup', async () => {
    const mgr = new WebRtcBridgeManager(makeCallManager() as any, null);
    await dial(mgr);
    // The VoiceLink answer + `call.ended` of an answered call.
    await mgr.handleVoicelinkStatus('call-1', {
      providerCallId: 'pcid-1', callId: 'call-1', eventType: 'answer', timestamp: new Date(), metadata: {},
    });
    await mgr.handleVoicelinkStatus('call-1', {
      providerCallId: 'pcid-1', callId: 'call-1', eventType: 'hangup', timestamp: new Date(),
      metadata: { event: 'call.ended', call: { id: 'pcid-1', status: 'ended', hangupCause: '16' } },
    });
    expect(mockAnalytics.trackWebrtcCallCompleted).toHaveBeenCalledWith(expect.objectContaining({
      status: 'completed', connected: true, endedBy: 'remote',
    }));
  });

  it('webrtc_call_completed: ended_by=error on telephony init failure', async () => {
    mockAdapter.initiateCall.mockRejectedValue(new Error('vobiz down'));
    const mgr = new WebRtcBridgeManager(makeCallManager() as any, null);
    await expect(dial(mgr)).rejects.toThrow();
    expect(mockAnalytics.trackWebrtcCallCompleted).toHaveBeenCalledWith(expect.objectContaining({
      status: 'failed', connected: false, endedBy: 'error',
    }));
    // a failed-init call never reaches the initiated funnel event
    expect(mockAnalytics.trackWebrtcCallInitiated).not.toHaveBeenCalled();
  });
});

describe('WebRtcBridgeManager media-relay fidelity (VoiceLink A-law transcode)', () => {
  it('PSTN A-law tone → browser receives a decoded PCM16 frame (~2× length, real audio)', async () => {
    const mgr = new WebRtcBridgeManager(makeCallManager() as any, null);
    const { browser } = await dial(mgr, VL_PARAMS);
    const pstn = fakeWs();
    mgr.attachPstnLeg('call-1', pstn as any);
    negotiateVoicelink(pstn);

    // 160 A-law bytes @8k of a real 1kHz tone → PCM16 16k. Two things must hold:
    // (1) roughly 2× length (640 bytes ideal; FIR holds back ~1 kernel on the first
    //     frame for cross-frame continuity, so allow a small shortfall), and
    // (2) the decoded output is actually the tone, not silence (peak near 8000).
    pstn.emit('message', JSON.stringify({
      event: 'media', media: { payload: alaw8kTone(1000, 160, 8000).toString('base64') },
    }));
    const p2b = browser.sent.find((m) => m.event === 'media');
    expect(p2b).toBeDefined();
    const out = Buffer.from(p2b.media.payload, 'base64');
    // ~2× the 160-byte input, minus first-frame FIR warm-up latency.
    expect(out.length).toBeGreaterThan(480);
    expect(out.length).toBeLessThanOrEqual(640);
    // Real audio, not dropped-to-silence: peak within ~20% of the 8000 input tone.
    const peak = decodedPeak(out);
    expect(peak).toBeGreaterThan(6400);
    expect(peak).toBeLessThan(9600);

    await endByUser(mgr);
  });

  it('browser PCM16 tone → PSTN receives a ~half-length A-law frame that decodes back to the tone', async () => {
    const mgr = new WebRtcBridgeManager(makeCallManager() as any, null);
    const { browser } = await dial(mgr, VL_PARAMS);
    const pstn = fakeWs();
    mgr.attachPstnLeg('call-1', pstn as any);
    negotiateVoicelink(pstn);

    // 320 samples PCM16 @16k (640 bytes) of a 1kHz tone → ~160 A-law bytes @8k.
    browser.emit('message', JSON.stringify({
      event: 'media', media: { payload: pcm16kTone(1000, 320, 8000).toString('base64') },
    }));
    const b2p = pstn.sent.find((m) => m.event === 'media');
    expect(b2p).toBeDefined();
    const alaw = Buffer.from(b2p.media.payload, 'base64');
    // ~half the 640-byte input (160 ideal), minus first-frame warm-up.
    expect(alaw.length).toBeGreaterThan(120);
    expect(alaw.length).toBeLessThanOrEqual(160);
    // A-law byte count === PCM16 8k sample count → decode and check the tone survived.
    const peak = Math.max(...Array.from(decodeAlaw(alaw)).map((v) => Math.abs(v)));
    expect(peak).toBeGreaterThan(6400);
    expect(peak).toBeLessThan(9600);

    await endByUser(mgr);
  });
});

describe('WebRtcBridgeManager oversized-frame gate (MAX_MEDIA_FRAME_BYTES)', () => {
  // The gate rejects any base64 payload longer than MAX_MEDIA_FRAME_BYTES*2 =
  // 128000 chars BEFORE decoding, so an abusive frame can't drive allocation.
  const OVERSIZE = 'A'.repeat(128001);

  it('drops an oversized browser→PSTN frame (VoiceLink): nothing relayed, no throw', async () => {
    const mgr = new WebRtcBridgeManager(makeCallManager() as any, null);
    const { browser } = await dial(mgr, VL_PARAMS);
    const pstn = fakeWs();
    mgr.attachPstnLeg('call-1', pstn as any);
    negotiateVoicelink(pstn);

    expect(() => browser.emit('message', JSON.stringify({
      event: 'media', media: { payload: OVERSIZE },
    }))).not.toThrow();
    expect(pstn.sent.filter((m) => m.event === 'media')).toHaveLength(0);

    await endByUser(mgr);
  });

  it('drops an oversized PSTN→browser frame (VoiceLink): nothing relayed, no throw', async () => {
    const mgr = new WebRtcBridgeManager(makeCallManager() as any, null);
    const { browser } = await dial(mgr, VL_PARAMS);
    const pstn = fakeWs();
    mgr.attachPstnLeg('call-1', pstn as any);
    negotiateVoicelink(pstn);

    expect(() => pstn.emit('message', JSON.stringify({
      event: 'media', media: { payload: OVERSIZE },
    }))).not.toThrow();
    expect(browser.sent.filter((m) => m.event === 'media')).toHaveLength(0);

    await endByUser(mgr);
  });

  it('a payload exactly at the limit is still relayed (boundary is exclusive)', async () => {
    // VoiceLink transcodes, so the observable is that a
    // frame IS relayed (the gate let it in) rather than its bytes.
    const mgr = new WebRtcBridgeManager(makeCallManager() as any, null);
    const { browser } = await dial(mgr, VL_PARAMS);
    const pstn = fakeWs();
    mgr.attachPstnLeg('call-1', pstn as any);
    negotiateVoicelink(pstn);

    const atLimit = 'A'.repeat(128000); // == MAX_MEDIA_FRAME_BYTES*2, gate uses strict >
    browser.emit('message', JSON.stringify({ event: 'media', media: { payload: atLimit } }));
    expect(pstn.sent.some((m) => m.event === 'media')).toBe(true);

    await endByUser(mgr);
  });
});

describe('WebRtcBridgeManager.verifyWsToken — fail-open under Redis degradation', () => {
  const PURPOSES = ['browser', 'provider', 'webhook'] as const;

  it('returns true for every purpose when redis is null (degraded)', async () => {
    const mgr = new WebRtcBridgeManager(makeCallManager() as any, null);
    for (const p of PURPOSES) {
      expect(await mgr.verifyWsToken('call-x', 'any-token', p)).toBe(true);
      expect(await mgr.verifyWsToken('call-x', undefined, p)).toBe(true);
    }
  });

  // Q6: Redis answered and holds no token: refused, because
  // every token this bridge verifies is stored before the leg it guards can exist.
  it('returns FALSE for every purpose when Redis answers and the stored key is missing (Q6)', async () => {
    const redis = { get: vi.fn().mockResolvedValue(null), set: vi.fn(), del: vi.fn() };
    const mgr = new WebRtcBridgeManager(makeCallManager() as any, redis as any);
    for (const p of PURPOSES) {
      expect(await mgr.verifyWsToken('call-x', 'whatever', p)).toBe(false);
      expect(await mgr.verifyWsToken('call-x', undefined, p)).toBe(false);
    }
    // A key was consulted per purpose (not short-circuited by the null-redis branch).
    expect(redis.get).toHaveBeenCalledTimes(PURPOSES.length * 2);
  });

  it('returns true for every purpose when redis.get throws (fail-open)', async () => {
    const redis = { get: vi.fn().mockRejectedValue(new Error('redis down')), set: vi.fn(), del: vi.fn() };
    const mgr = new WebRtcBridgeManager(makeCallManager() as any, redis as any);
    for (const p of PURPOSES) {
      expect(await mgr.verifyWsToken('call-x', 'whatever', p)).toBe(true);
    }
  });

  it('returns false on a genuine mismatch (present token, wrong value)', async () => {
    const redis = { get: vi.fn().mockResolvedValue('stored-token'), set: vi.fn(), del: vi.fn() };
    const mgr = new WebRtcBridgeManager(makeCallManager() as any, redis as any);
    expect(await mgr.verifyWsToken('call-x', 'WRONG', 'provider')).toBe(false);
    // And accepts the matching value.
    expect(await mgr.verifyWsToken('call-x', 'stored-token', 'provider')).toBe(true);
  });

  it('returns false when a token exists but the client presented none', async () => {
    const redis = { get: vi.fn().mockResolvedValue('stored-token'), set: vi.fn(), del: vi.fn() };
    const mgr = new WebRtcBridgeManager(makeCallManager() as any, redis as any);
    expect(await mgr.verifyWsToken('call-x', undefined, 'webhook')).toBe(false);
  });
});

/**
 * Q6: the legitimate paths that used to lean on the
 * missing-key accept, each kept working explicitly, through a real dial on an in-memory Redis.
 */
function memoryRedis() {
  const store = new Map<string, string>();
  const ttls = new Map<string, number>();
  return {
    store, ttls,
    failSet: false,
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    set: vi.fn(async function (this: any, k: string, v: string, _ex: string, ttl: number) {
      if (this.failSet) throw new Error('redis down at mint');
      store.set(k, v); ttls.set(k, ttl); return 'OK';
    }),
    del: vi.fn(async (k: string) => { const had = store.delete(k); ttls.delete(k); return had ? 1 : 0; }),
    expire: vi.fn(async (k: string, ttl: number) => { if (!store.has(k)) return 0; ttls.set(k, ttl); return 1; }),
  };
}
const tokenOf = (redis: ReturnType<typeof memoryRedis>, purpose: string) =>
  redis.store.get(`webrtc:ws-token:${purpose}:call-1`);

describe('WebRtcBridgeManager ws tokens — Q6 legitimate paths', () => {
  it('a live call: the carrier\'s provider and webhook tokens verify; a wrong or absent one does not', async () => {
    const redis = memoryRedis();
    const mgr = new WebRtcBridgeManager(makeCallManager() as any, redis as any);
    await dial(mgr);
    const webhook = tokenOf(redis, 'webhook')!;
    const provider = tokenOf(redis, 'provider')!;
    expect(webhook).toBeTruthy();
    expect(await mgr.verifyWsToken('call-1', webhook, 'webhook')).toBe(true);
    expect(await mgr.verifyWsToken('call-1', provider, 'provider')).toBe(true);
    expect(await mgr.verifyWsToken('call-1', 'WRONG', 'webhook')).toBe(false);
    expect(await mgr.verifyWsToken('call-1', undefined, 'provider')).toBe(false);
    // A leaked webhook token is not a provider token (purpose-bound).
    expect(await mgr.verifyWsToken('call-1', webhook, 'provider')).toBe(false);
    await endByUser(mgr);
  });

  it('after teardown the WEBHOOK token stays verifiable for the post-end grace (late terminal + recording URL); the media tokens die', async () => {
    const redis = memoryRedis();
    const mgr = new WebRtcBridgeManager(makeCallManager() as any, redis as any);
    await dial(mgr);
    const webhook = tokenOf(redis, 'webhook')!;
    const provider = tokenOf(redis, 'provider')!;
    await endByUser(mgr);
    await carrierEnded(mgr);
    expect(mgr.getSession('call-1')).toBeUndefined();

    expect(redis.expire).toHaveBeenCalledWith('webrtc:ws-token:webhook:call-1', 2 * 60 * 60);
    expect(await mgr.verifyWsToken('call-1', webhook, 'webhook')).toBe(true);
    expect(await mgr.verifyWsToken('call-1', 'FORGED', 'webhook')).toBe(false);
    expect(await mgr.verifyWsToken('call-1', undefined, 'webhook')).toBe(false);
    expect(await mgr.verifyWsToken('call-1', provider, 'provider')).toBe(false);

    // Once the grace has run out (Redis expired the key), nothing is accepted on the id alone.
    redis.store.delete('webrtc:ws-token:webhook:call-1');
    expect(await mgr.verifyWsToken('call-1', webhook, 'webhook')).toBe(false);
  });

  it('a token whose SET failed at mint (Redis down then, up now) is accepted, live and through the grace', async () => {
    const redis = memoryRedis();
    redis.failSet = true;
    const mgr = new WebRtcBridgeManager(makeCallManager() as any, redis as any);
    await dial(mgr);
    redis.failSet = false;
    expect(redis.store.size).toBe(0);
    // The live call is not hard-failed by the earlier outage.
    expect(await mgr.verifyWsToken('call-1', 'anything', 'provider')).toBe(true);
    expect(await mgr.verifyWsToken('call-1', 'anything', 'webhook')).toBe(true);
    // A different call never had that excuse.
    expect(await mgr.verifyWsToken('call-2', 'anything', 'webhook')).toBe(false);

    await endByUser(mgr);
    await carrierEnded(mgr);
    // The carrier's late posts still land; its media leg does not reattach.
    expect(await mgr.verifyWsToken('call-1', 'anything', 'webhook')).toBe(true);
    expect(await mgr.verifyWsToken('call-1', 'anything', 'provider')).toBe(false);
  });

  it('Redis absent or erroring still accepts (never hard-fail a live call on an outage)', async () => {
    expect(await new WebRtcBridgeManager(makeCallManager() as any, null).verifyWsToken('call-1', undefined, 'webhook')).toBe(true);
    const failing = { get: vi.fn().mockRejectedValue(new Error('down')), set: vi.fn(), del: vi.fn() };
    expect(await new WebRtcBridgeManager(makeCallManager() as any, failing as any).verifyWsToken('call-1', 'x', 'provider')).toBe(true);
  });
});

describe('WebRtcBridgeManager VoiceLink PSTN stop / browser-close edges', () => {
  it('a carrier `stop` before any `start` ends the call as no_answer (never answered)', async () => {
    const cm = makeCallManager();
    const mgr = new WebRtcBridgeManager(cm as any, null);
    await dial(mgr, VL_PARAMS);
    const pstn = fakeWs();
    mgr.attachPstnLeg('call-1', pstn as any);

    // No `start` negotiated → answeredAt stays null. A `stop` frame is terminal.
    expect(mgr.getSession('call-1')!.answeredAt).toBeNull();
    pstn.emit('message', JSON.stringify({ event: 'stop', stop: { call_sid: 'c' } }));
    await new Promise((r) => setImmediate(r));

    expect(mgr.getSession('call-1')).toBeUndefined();
    const persisted = mockRepo.update.mock.calls.map((c: any[]) => c[1]).filter(Boolean);
    expect(persisted.some((u: any) => u.status === 'no_answer')).toBe(true);
    // Never anchored answered → 0 talk time (unbilled).
    expect(persisted.some((u: any) => u.talk_time_seconds === 0)).toBe(true);
  });

  it('browser leg closing during the VoiceLink `ending` window does not double-finalize', async () => {
    const cm = makeCallManager();
    const mgr = new WebRtcBridgeManager(cm as any, null);
    const { browser } = await dial(mgr, VL_PARAMS);
    const pstn = fakeWs();
    mgr.attachPstnLeg('call-1', pstn as any);
    negotiateVoicelink(pstn);

    // User hangup → enters `ending`, awaiting carrier call.ended (nothing terminal yet).
    await endByUser(mgr);
    expect(mgr.getSession('call-1')!.ending).toBe(true);
    expect(mockAnalytics.trackWebrtcCallCompleted).not.toHaveBeenCalled();

    // Browser socket closes mid-`ending`. localHangup is a no-op while ending, so
    // nothing finalizes until the carrier confirms.
    browser.emit('close');
    await new Promise((r) => setImmediate(r));
    expect(mockAnalytics.trackWebrtcCallCompleted).not.toHaveBeenCalled();
    expect(mgr.getSession('call-1')).toBeDefined();

    // Carrier confirms → single finalize.
    await carrierEnded(mgr);
    expect(mgr.getSession('call-1')).toBeUndefined();
    expect(mockAnalytics.trackWebrtcCallCompleted).toHaveBeenCalledTimes(1);
  });
});

describe('WebRtcBridgeManager.persistLateVoicelinkTerminal — edge branches', () => {
  it('findById returns null → no update, no throw', async () => {
    const mgr = new WebRtcBridgeManager(makeCallManager() as any, null);
    mockRepo.findById.mockResolvedValueOnce(null);
    await mgr.handleVoicelinkStatus('call-ghost', {
      providerCallId: 'carrier-9', callId: 'call-ghost', eventType: 'hangup', timestamp: new Date(),
      metadata: { event: 'call.completed', call: { id: 'carrier-9', callStatus: 'ANSWERED', recordingUrl: 'https://rec/x.mp3' } },
    });
    expect(mockRepo.update).not.toHaveBeenCalled();
  });

  it('empty patch (no new recording, provider id already matches) → no update call', async () => {
    const mgr = new WebRtcBridgeManager(makeCallManager() as any, null);
    mockRepo.findById.mockResolvedValueOnce({ id: 'call-1', recording_url: null, provider_call_id: 'carrier-9' });
    // No recordingUrl in the body and providerCallId equals the existing one → nothing to patch.
    await mgr.handleVoicelinkStatus('call-1', {
      providerCallId: 'carrier-9', callId: 'call-1', eventType: 'hangup', timestamp: new Date(),
      metadata: { event: 'call.ended', call: { id: 'carrier-9', status: 'ended', hangupCause: '16' } },
    });
    expect(mockRepo.update).not.toHaveBeenCalled();
  });

  it('non-terminal event type (answer) with no live session → early return, no findById', async () => {
    const mgr = new WebRtcBridgeManager(makeCallManager() as any, null);
    await mgr.handleVoicelinkStatus('call-1', {
      providerCallId: 'carrier-9', callId: 'call-1', eventType: 'answer', timestamp: new Date(),
      metadata: { event: 'call.answered', call: { id: 'carrier-9', status: 'answered' } },
    });
    expect(mockRepo.findById).not.toHaveBeenCalled();
    expect(mockRepo.update).not.toHaveBeenCalled();
  });

  it('recording already set → not overwritten (only the new carrier id is patched)', async () => {
    const mgr = new WebRtcBridgeManager(makeCallManager() as any, null);
    mockRepo.findById.mockResolvedValueOnce({ id: 'call-1', recording_url: 'https://rec/original.mp3', provider_call_id: null });
    await mgr.handleVoicelinkStatus('call-1', {
      providerCallId: 'carrier-9', callId: 'call-1', eventType: 'hangup', timestamp: new Date(),
      metadata: { event: 'call.completed', call: { id: 'carrier-9', callStatus: 'ANSWERED', recordingUrl: 'https://rec/late.mp3' } },
    });
    expect(mockRepo.update).toHaveBeenCalledTimes(1);
    const patch = mockRepo.update.mock.calls[0]![1];
    expect(patch).not.toHaveProperty('recording_url'); // existing URL preserved
    expect(patch.provider_call_id).toBe('carrier-9');
  });
});

describe('WebRtcBridgeManager.attachPstnLegVerified — provider-token gate (VoiceLink)', () => {
  function fakeRedis(getVal: string | null) {
    return { get: vi.fn().mockResolvedValue(getVal), set: vi.fn().mockResolvedValue('OK'), del: vi.fn().mockResolvedValue(1) };
  }

  it('attaches the PSTN leg when the provider token matches', async () => {
    const mgr = new WebRtcBridgeManager(makeCallManager() as any, fakeRedis('prov-tok') as any);
    await dial(mgr, VL_PARAMS);
    const pstn = fakeWs();
    expect(await mgr.attachPstnLegVerified('call-1', pstn as any, 'prov-tok')).toBe(true);
    expect(pstn.readyState).toBe(1); // still open
    expect(mgr.getSession('call-1')!.pstnWs).toBe(pstn);
    await endByUser(mgr);
  });

  it('rejects and closes the PSTN leg on a wrong provider token', async () => {
    const mgr = new WebRtcBridgeManager(makeCallManager() as any, fakeRedis('prov-tok') as any);
    await dial(mgr, VL_PARAMS);
    const pstn = fakeWs();
    expect(await mgr.attachPstnLegVerified('call-1', pstn as any, 'WRONG')).toBe(false);
    expect(pstn.readyState).toBe(3); // closed
    expect(mgr.getSession('call-1')!.pstnWs).toBeNull(); // never attached
    await endByUser(mgr);
  });
});
