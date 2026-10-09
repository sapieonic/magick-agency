import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The two seam behaviours of the bridge:
//
//  1. docs/seams.md — the bridge calls `getBridgeAnalysisHooks().onCallFinalized(facts)`
//     (endCall, fire-and-forget, after the terminal write) and `.onRecordingReady(callId)`
//     (late VoiceLink terminal with a NEW recording URL, awaited). The hook bodies are tested
//     elsewhere; this file tests the call sites.
//  2. Max duration is `account_settings.webrtc_max_duration_seconds`, falling back to the
//     default (1800) on NULL or on a throw. The resolved value drives three things (slot TTL =
//     value + 60, the carrier's `maxDuration`, the session's max-duration timer).
// Harness copied from webrtc-bridge-manager.test.ts (project convention: no shared test utils).

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
      plivo: { webhookBaseUrl: 'https://core.test/api/v1/webhooks/plivo' },
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
/** ends the call as the user (`ended_by_user`). */
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

import {
  setBridgeAnalysisHooks, resetBridgeAnalysisHooks, type BridgeAnalysisHooks,
} from '../../../src/seams/bridge-analysis-hooks.js';

let hooks: { onCallFinalized: ReturnType<typeof vi.fn>; onRecordingReady: ReturnType<typeof vi.fn> };

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
    campaign_id: i.campaign_id ?? null,
    agency_attempt_id: i.agency_attempt_id ?? null,
  }));
  mockAdapter.initiateCall.mockResolvedValue({ providerCallId: 'pcid-1' });
  mockAccountSettings.getWebrtcMaxDurationSeconds.mockResolvedValue(null);
  hooks = {
    onCallFinalized: vi.fn().mockResolvedValue(undefined),
    onRecordingReady: vi.fn().mockResolvedValue(undefined),
  };
  setBridgeAnalysisHooks(hooks as unknown as BridgeAnalysisHooks);
});

afterEach(() => {
  resetBridgeAnalysisHooks();
});

describe('bridge → analysis seam (docs/seams.md)', () => {
  it('onCallFinalized gets the call\'s facts once, at teardown, for an unanswered call', async () => {
    const mgr = new WebRtcBridgeManager(makeCallManager() as any, null);
    await dial(mgr);
    expect(hooks.onCallFinalized).not.toHaveBeenCalled();

    await endByUser(mgr);

    expect(hooks.onCallFinalized).toHaveBeenCalledTimes(1);
    expect(hooks.onCallFinalized).toHaveBeenCalledWith({
      callId: 'call-1',
      tenantId: 't1',
      accountId: 'a1',
      campaignId: 'camp-1',
      answeredAt: null,
      talkTimeSeconds: 0,
    });
  });

  it('onCallFinalized carries the answer anchor and talk time of an answered call', async () => {
    const mgr = new WebRtcBridgeManager(makeCallManager() as any, null);
    await dial(mgr);
    await mgr.handleVoicelinkStatus('call-1', {
      providerCallId: 'pcid-1', callId: 'call-1', eventType: 'answer', timestamp: new Date(), metadata: {},
    });
    const answeredAt = mgr.getSession('call-1')!.answeredAt;
    expect(answeredAt).toBeInstanceOf(Date);
    await mgr.handleVoicelinkStatus('call-1', {
      providerCallId: 'pcid-1', callId: 'call-1', eventType: 'hangup', timestamp: new Date(),
      metadata: { event: 'call.ended', call: { id: 'pcid-1', status: 'ended', hangupCause: '16' } },
    });

    expect(hooks.onCallFinalized).toHaveBeenCalledTimes(1);
    const facts = hooks.onCallFinalized.mock.calls[0]![0];
    expect(facts.answeredAt).toBe(answeredAt);
    expect(facts.campaignId).toBe('camp-1');
    expect(typeof facts.talkTimeSeconds).toBe('number');
  });

  it('is called after the terminal row is written (after the persist)', async () => {
    const mgr = new WebRtcBridgeManager(makeCallManager() as any, null);
    await dial(mgr);
    await endByUser(mgr);
    const terminalWrite = mockRepo.update.mock.invocationCallOrder[
      mockRepo.update.mock.calls.findIndex((c: any[]) => c[1]?.ended_at !== undefined)
    ]!;
    expect(hooks.onCallFinalized.mock.invocationCallOrder[0]!).toBeGreaterThan(terminalWrite);
  });

  it('is fire-and-forget: a hook that never settles does not hold teardown or the slot release', async () => {
    hooks.onCallFinalized.mockReturnValue(new Promise(() => {}));
    const cm = makeCallManager();
    const mgr = new WebRtcBridgeManager(cm as any, null);
    await dial(mgr);
    await endByUser(mgr);
    expect(mgr.getSession('call-1')).toBeUndefined();
    expect(cm.concurrencyGuard.release).toHaveBeenCalledTimes(1);
  });

  it('a rejecting hook is caught and never reaches the caller', async () => {
    hooks.onCallFinalized.mockRejectedValue(new Error('analysis down'));
    const cm = makeCallManager();
    const mgr = new WebRtcBridgeManager(cm as any, null);
    await dial(mgr);
    await expect(endByUser(mgr)).resolves.toBe(true);
    await new Promise((r) => setImmediate(r));
    expect(cm.accountConcurrencyGuard.release).toHaveBeenCalledTimes(1);
  });

  it('onRecordingReady is awaited with the call id when a late terminal brings a NEW recording URL', async () => {
    let resolveHook!: () => void;
    hooks.onRecordingReady.mockReturnValue(new Promise<void>((r) => { resolveHook = r; }));
    const mgr = new WebRtcBridgeManager(makeCallManager() as any, null);
    mockRepo.findById.mockResolvedValueOnce({ id: 'call-1', recording_url: null, provider_call_id: null });

    let settled = false;
    const handled = mgr.handleVoicelinkStatus('call-1', {
      providerCallId: 'carrier-9', callId: 'call-1', eventType: 'hangup', timestamp: new Date(),
      metadata: { event: 'call.completed', call: { id: 'carrier-9', callStatus: 'ANSWERED', recordingUrl: 'https://rec/late.mp3' } },
    }).then(() => { settled = true; });

    await vi.waitFor(() => expect(hooks.onRecordingReady).toHaveBeenCalledWith('call-1'));
    // The hook is awaited.
    await new Promise((r) => setImmediate(r));
    expect(settled).toBe(false);
    resolveHook();
    await handled;
    expect(settled).toBe(true);
    expect(hooks.onCallFinalized).not.toHaveBeenCalled();
  });

  it('onRecordingReady is NOT called when the late terminal adds no recording URL', async () => {
    const mgr = new WebRtcBridgeManager(makeCallManager() as any, null);
    mockRepo.findById.mockResolvedValueOnce({ id: 'call-1', recording_url: 'https://rec/original.mp3', provider_call_id: null });
    await mgr.handleVoicelinkStatus('call-1', {
      providerCallId: 'carrier-9', callId: 'call-1', eventType: 'hangup', timestamp: new Date(),
      metadata: { event: 'call.completed', call: { id: 'carrier-9', callStatus: 'ANSWERED', recordingUrl: 'https://rec/late.mp3' } },
    });
    expect(hooks.onRecordingReady).not.toHaveBeenCalled();
  });

  it('a rejecting onRecordingReady is swallowed', async () => {
    hooks.onRecordingReady.mockRejectedValue(new Error('boom'));
    const mgr = new WebRtcBridgeManager(makeCallManager() as any, null);
    mockRepo.findById.mockResolvedValueOnce({ id: 'call-1', recording_url: null, provider_call_id: null });
    await expect(mgr.handleVoicelinkStatus('call-1', {
      providerCallId: 'carrier-9', callId: 'call-1', eventType: 'hangup', timestamp: new Date(),
      metadata: { event: 'call.completed', call: { id: 'carrier-9', callStatus: 'ANSWERED', recordingUrl: 'https://rec/late.mp3' } },
    })).resolves.toBeUndefined();
  });
});

describe('max duration from account settings', () => {
  async function dialAndRead(): Promise<{ cm: ReturnType<typeof makeCallManager>; mgr: WebRtcBridgeManager }> {
    const cm = makeCallManager();
    const mgr = new WebRtcBridgeManager(cm as any, null);
    await dial(mgr);
    return { cm, mgr };
  }

  it('uses the account\'s value for the slot TTL, the carrier maxDuration and the session timer', async () => {
    mockAccountSettings.getWebrtcMaxDurationSeconds.mockResolvedValue(600);
    const { cm, mgr } = await dialAndRead();
    expect(mockAccountSettings.getWebrtcMaxDurationSeconds).toHaveBeenCalledWith('t1', 'a1');
    expect(cm.concurrencyGuard.tryAcquire).toHaveBeenCalledWith(expect.any(String), 660);
    expect(cm.accountConcurrencyGuard.tryAcquire).toHaveBeenCalledWith(expect.any(String), 't1', 'a1', 660);
    expect(mockAdapter.initiateCall.mock.calls[0]![0].maxDuration).toBe(600);
    expect(mgr.getSession('call-1')!.maxDurationSeconds).toBe(600);
    await endByUser(mgr);
  });

  it('NULL (no per-account value) falls back to the 1800 default', async () => {
    mockAccountSettings.getWebrtcMaxDurationSeconds.mockResolvedValue(null);
    const { cm, mgr } = await dialAndRead();
    expect(cm.concurrencyGuard.tryAcquire).toHaveBeenCalledWith(expect.any(String), 1860);
    expect(mockAdapter.initiateCall.mock.calls[0]![0].maxDuration).toBe(1800);
    expect(mgr.getSession('call-1')!.maxDurationSeconds).toBe(1800);
    await endByUser(mgr);
  });

  it('a failed read falls back to 1800 and still dials', async () => {
    mockAccountSettings.getWebrtcMaxDurationSeconds.mockRejectedValue(new Error('db down'));
    const { cm, mgr } = await dialAndRead();
    expect(cm.accountConcurrencyGuard.tryAcquire).toHaveBeenCalledWith(expect.any(String), 't1', 'a1', 1860);
    expect(mockAdapter.initiateCall).toHaveBeenCalledTimes(1);
    expect(mgr.getSession('call-1')!.maxDurationSeconds).toBe(1800);
    await endByUser(mgr);
  });
});

// Open question Q6 (docs/decisions.md): `verifyWsToken` is a fail-OPEN check,
// used by the VoiceLink webhook route and the PSTN leg. Its accept/reject outcomes are
// pinned in webrtc-bridge-manager.test.ts ('…fail-open under Redis degradation': no Redis,
// stored key missing, Redis error → accept; wrong value, no token presented → reject).
// This adds the length-mismatch outcome, so a move to fail-closed is a deliberate,
// visible test change.
describe('verifyWsToken — the length-mismatch outcome (Q6)', () => {
  it('rejects a presented token of a different length without throwing (timingSafeEqual is length-guarded)', async () => {
    const redis = { get: vi.fn().mockResolvedValue('stored-token'), set: vi.fn(), del: vi.fn() };
    const mgr = new WebRtcBridgeManager(makeCallManager() as any, redis as any);
    for (const purpose of ['browser', 'provider', 'webhook'] as const) {
      await expect(mgr.verifyWsToken('call-x', 'stored-token-but-longer', purpose)).resolves.toBe(false);
      await expect(mgr.verifyWsToken('call-x', 'short', purpose)).resolves.toBe(false);
      await expect(mgr.verifyWsToken('call-x', '', purpose)).resolves.toBe(false);
    }
  });
});
