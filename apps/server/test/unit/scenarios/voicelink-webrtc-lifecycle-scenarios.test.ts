import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock specifiers: logger → @magick-agency/observability, webrtc-call repository →
// the @magick-agency/db agency-call repository, account settings → the
// @magick-agency/db repository (`getWebrtcMaxDurationSeconds` → null = the flag
// mock's 1800).
//
// The calls are created with `createBridgedCall`, with the browser socket borrowed
// at dial time (the fake carries `off`); a user hangup is
// `forceEndWithOutcome('att-1', 'ended_by_user')`, i.e. `localHangup`. The dialer
// never settles, so the terminal event is `trackWebrtcCallCompleted`, which
// `endCall` emits exactly once (asserted by count and by `status` /
// `talkTimeSeconds`).

// ═══════════════════════════════════════════════════════════════════════════
// End-to-end VoiceLink WebRTC-bridge lifecycle scenarios driven with the REAL
// captured payloads (experiment/captures/*.json): the `start` frame, the
// `call.answered`/`call.ended`/`call.completed` webhook bodies (nested
// `body.call.*` shape), and the `stop` frame. These assert the manager
// correctly negotiates, anchors answer, relays, and settles against payloads
// that actually came off the wire — not synthetic approximations.
//
// The manager unit test (webrtc-bridge-manager.test.ts) covers the branch
// matrix; this file locks the real-payload happy path + the unanswered path so
// a payload-shape drift on VoiceLink's side is caught here.
// ═══════════════════════════════════════════════════════════════════════════

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

vi.mock('../../../src/audit/audit-logger.js', () => ({ auditLogger: { log: vi.fn() } }));

// Hoisted so the terminal analytics event is observable; it fires exactly once per `endCall`.
const { mockAnalytics } = vi.hoisted(() => ({
  mockAnalytics: {
    trackWebrtcCallInitiated: vi.fn(),
    trackWebrtcCallRejected: vi.fn(),
    trackWebrtcCallCompleted: vi.fn(),
  },
}));
vi.mock('../../../src/analytics/posthog.js', () => mockAnalytics);

import { WebRtcBridgeManager } from '../../../src/core/webrtc-bridge-manager.js';
import { parseVoicelinkWebhook } from '../../../src/telephony/voicelink/voicelink.webhook.js';

// ── Real captured payloads (from experiment/captures/2026-07-11T06-39-57-498Z) ──
// start frame (007), call.answered (005), call.ended (009), call.completed (012),
// stop frame (008). Kept exactly as captured so a shape change on VoiceLink's side fails here.
// The `call.answered`/`call.ended` bodies carry `null`s the declared
// `VoicelinkWebhookBody` type does not admit, so they are passed `as any` (type-only).
const CARRIER_CALL_ID = 'fecdd5a7-5d14-415f-9222-a0f99b655cb0';

const START_FRAME = {
  event: 'start',
  sequence_number: 0,
  stream_sid: `stream_${CARRIER_CALL_ID}`,
  timestamp: '2026-07-11T12:09:59.000+05:30',
  start: {
    stream_sid: `stream_${CARRIER_CALL_ID}`,
    call_sid: CARRIER_CALL_ID,
    account_sid: '1150',
    from: '919484957166',
    to: '+918093773107',
    media_format: { encoding: 'audio/alaw', sample_rate: '8000' },
  },
};

const CALL_ANSWERED_BODY = {
  event: 'call.answered',
  timestamp: '2026-07-11T12:09:59.344+05:30',
  call: {
    id: CARRIER_CALL_ID,
    direction: 'outbound',
    from: '919484957166',
    to: '+918093773107',
    status: 'answered',
    hangupCause: null,
    answeredAt: '2026-07-11T12:09:59.344+05:30',
  },
};

const CALL_ENDED_BODY = {
  event: 'call.ended',
  timestamp: '2026-07-11T12:10:03.847+05:30',
  call: {
    id: CARRIER_CALL_ID,
    direction: 'outbound',
    status: 'ended',
    hangupCause: '16',
    answeredAt: '2026-07-11T12:09:59.000+05:30',
    endedAt: '2026-07-11T12:10:03.847+05:30',
    durationSec: 4,
    hangupReason: null,
    sipStatus: '200',
  },
};

const CALL_COMPLETED_BODY = {
  event: 'call.completed',
  timestamp: '2026-07-11T12:10:04.000+05:30',
  call: {
    id: CARRIER_CALL_ID,
    direction: 'outbound',
    status: 'ended',
    hangupCause: '16',
    answeredAt: '2026-07-11T12:09:59.000+05:30',
    durationSec: 4,
    callStatus: 'ANSWERED',
    hangupReason: '16',
    recordingUrl: `https://voiceflowai.elisiontec.com/voiceapp-recordings/client_1150/2026-07-11/${CARRIER_CALL_ID}.mp3`,
  },
};

function fakeWs() {
  const handlers: Record<string, ((...a: any[]) => void)[]> = {};
  return {
    readyState: 1,
    OPEN: 1,
    sent: [] as any[],
    send(s: string) { this.sent.push(JSON.parse(s)); },
    on(ev: string, cb: (...a: any[]) => void) { (handlers[ev] ||= []).push(cb); },
    // `off` is needed — a borrowed socket's listeners are removed at detach.
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
    concurrencyGuard: { tryAcquire: vi.fn().mockResolvedValue(true), release: vi.fn().mockResolvedValue(undefined) },
    accountConcurrencyGuard: { tryAcquire: vi.fn().mockResolvedValue(true), release: vi.fn().mockResolvedValue(undefined) },
    triggerDequeue: vi.fn(),
    wakeSelfHeal: vi.fn(),
  };
}

const VL_PARAMS = {
  tenantId: 't1',
  accountId: 'a1',
  callerId: '+14155550100',
  destinationPhone: '+918093773107',
  provider: 'voicelink' as const,
};
/** The agency back-references every bridge call carries. */
const AGENCY = { campaignId: 'camp-1', agencyAttemptId: 'att-1' };

beforeEach(() => {
  vi.clearAllMocks();
  mockRepo.create.mockImplementation(async (i: any) => ({
    id: 'call-1', tenant_id: i.tenant_id, account_id: i.account_id,
    caller_id: i.caller_id, destination_phone: i.destination_phone, provider: i.provider,
    status: 'initiating', provider_call_id: null, answered_at: null, ended_at: null,
    duration_seconds: null, talk_time_seconds: null, sip_connection_id: null,
    recording_requested: false,
  }));
  mockAdapter.initiateCall.mockResolvedValue({ providerCallId: 'pcid-1' });
});

describe('VoiceLink WebRTC lifecycle — answered call to completion (real payloads)', () => {
  it('start → answer webhook → call.ended (remote) → completed + settled once, carrier id captured', async () => {
    const cm = makeCallManager();
    const mgr = new WebRtcBridgeManager(cm as any, null);
    // The call is created with `createBridgedCall`, the browser socket borrowed at dial.
    const browser = fakeWs();
    const pstn = fakeWs();
    await mgr.createBridgedCall({ ...VL_PARAMS, ...AGENCY, browserSocket: browser as any });
    await mgr.attachPstnLegVerified('call-1', pstn as any, undefined);

    // 1. Real `start` frame negotiates the A-law 8k stream + anchors answer.
    pstn.emit('message', JSON.stringify(START_FRAME));
    const session = mgr.getSession('call-1')!;
    expect(session.providerMediaReady).toBe(true);
    expect(session.carrierCallId).toBe(CARRIER_CALL_ID);
    expect(session.answeredAt).not.toBeNull();

    // 2. Real `call.answered` webhook (idempotent answer; already anchored).
    const answerEvent = parseVoicelinkWebhook(CALL_ANSWERED_BODY as any, 'call-1')!;
    expect(answerEvent.eventType).toBe('answer');
    await mgr.handleVoicelinkStatus('call-1', answerEvent);
    expect(mgr.getSession('call-1')!.status).toBe('in_progress');
    expect(browser.sent).toContainEqual({ event: 'status', status: 'answered' });

    // 3. Far end hangs up — REAL `call.ended` (no callStatus, hangupCause 16).
    //    Folding in the session answer anchor must classify this as completed.
    const endedEvent = parseVoicelinkWebhook(CALL_ENDED_BODY as any, 'call-1')!;
    expect(endedEvent.eventType).toBe('hangup');
    await mgr.handleVoicelinkStatus('call-1', endedEvent);

    expect(mgr.getSession('call-1')).toBeUndefined();
    const persisted = mockRepo.update.mock.calls.map((c: any[]) => c[1]).filter(Boolean);
    expect(persisted.some((u: any) => u.status === 'completed')).toBe(true);
    expect(persisted.some((u: any) => u.status === 'failed')).toBe(false);
    expect(persisted.some((u: any) => u.error_code === 'TELEPHONY_ERROR')).toBe(false);
    // Carrier's real id was persisted.
    expect(persisted.some((u: any) => u.provider_call_id === CARRIER_CALL_ID)).toBe(true);
    // The terminal analytics event fires once, completed.
    expect(mockAnalytics.trackWebrtcCallCompleted).toHaveBeenCalledTimes(1);
    expect(mockAnalytics.trackWebrtcCallCompleted).toHaveBeenCalledWith(expect.objectContaining({
      status: 'completed',
    }));

    // 4. Late `call.completed` (with recordingUrl) arrives after teardown — the
    //    no-live-session late path persists the recording without re-settling.
    const completedEvent = parseVoicelinkWebhook(CALL_COMPLETED_BODY, 'call-1')!;
    expect(completedEvent.eventType).toBe('hangup'); // ANSWERED → hangup
    mockRepo.findById.mockResolvedValueOnce({ id: 'call-1', recording_url: null, provider_call_id: CARRIER_CALL_ID });
    await mgr.handleVoicelinkStatus('call-1', completedEvent);
    const latePatch = mockRepo.update.mock.calls.map((c: any[]) => c[1]).filter(Boolean);
    expect(latePatch.some((u: any) => u.recording_url === CALL_COMPLETED_BODY.call.recordingUrl)).toBe(true);
    // Still exactly one settlement (late path never settles).
    expect(mockAnalytics.trackWebrtcCallCompleted).toHaveBeenCalledTimes(1);
  });

  it('user hangup defers settlement until the real call.ended confirms (ending window)', async () => {
    const cm = makeCallManager();
    const mgr = new WebRtcBridgeManager(cm as any, null);
    // The call is created with `createBridgedCall`, the browser socket borrowed at dial.
    const browser = fakeWs();
    const pstn = fakeWs();
    await mgr.createBridgedCall({ ...VL_PARAMS, ...AGENCY, browserSocket: browser as any });
    await mgr.attachPstnLegVerified('call-1', pstn as any, undefined);
    pstn.emit('message', JSON.stringify(START_FRAME));

    // The user hangup is `localHangup`, by attempt.
    await mgr.forceEndWithOutcome('att-1', 'ended_by_user');
    expect(mgr.getSession('call-1')!.ending).toBe(true);
    expect(mockAnalytics.trackWebrtcCallCompleted).not.toHaveBeenCalled();
    expect(browser.sent).toContainEqual({ event: 'status', status: 'ending' });

    // Real carrier confirmation.
    await mgr.handleVoicelinkStatus('call-1', parseVoicelinkWebhook(CALL_ENDED_BODY as any, 'call-1')!);
    expect(mgr.getSession('call-1')).toBeUndefined();
    expect(mockAnalytics.trackWebrtcCallCompleted).toHaveBeenCalledTimes(1);
  });
});

describe('VoiceLink WebRTC lifecycle — unanswered / stop-before-start (real stop frame)', () => {
  it('a `stop` frame before any `start` ends the call as no_answer (0 talk time)', async () => {
    const STOP_FRAME = {
      event: 'stop',
      sequenceNumber: '201',
      streamSid: `stream_${CARRIER_CALL_ID}`,
      timestamp: '2026-07-11T12:10:03.869+05:30',
      stop: { accountSid: '1', call_sid: CARRIER_CALL_ID, outboundQueueId: 1716830 },
    };
    const cm = makeCallManager();
    const mgr = new WebRtcBridgeManager(cm as any, null);
    // The call is created with `createBridgedCall`, the browser socket borrowed at dial.
    const browser = fakeWs();
    const pstn = fakeWs();
    await mgr.createBridgedCall({ ...VL_PARAMS, ...AGENCY, browserSocket: browser as any });
    await mgr.attachPstnLegVerified('call-1', pstn as any, undefined);

    expect(mgr.getSession('call-1')!.answeredAt).toBeNull();
    pstn.emit('message', JSON.stringify(STOP_FRAME));
    await new Promise((r) => setImmediate(r));

    expect(mgr.getSession('call-1')).toBeUndefined();
    const persisted = mockRepo.update.mock.calls.map((c: any[]) => c[1]).filter(Boolean);
    expect(persisted.some((u: any) => u.status === 'no_answer')).toBe(true);
    // The terminal analytics event fires.
    expect(mockAnalytics.trackWebrtcCallCompleted).toHaveBeenCalledWith(expect.objectContaining({
      talkTimeSeconds: 0,
    }));
  });
});
