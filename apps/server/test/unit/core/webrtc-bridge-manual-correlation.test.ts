import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// The soft phone's correlation on the bridge seam (docs/seams.md §3.1,
// docs/softphone.md §4.3): a `manual` correlation persists `origin = 'manual'`
// and `manual_call_id` with no campaign or attempt id, keys every
// correlation-keyed member on the manual call id, and honours
// `browserCloseGraceMs` only once the carrier has answered.
//
// Mock harness copied from webrtc-bridge-manager.bridged.test.ts (project
// convention: no shared test utilities).
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

import { WebRtcBridgeManager } from '../../../src/core/webrtc-bridge-manager.js';

// ── Fake WebSocket with real add/remove listener bookkeeping ────────────────
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

/** VoiceLink's A-law 8kHz `start` frame — opens the relay and anchors the answer. */
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
    origin: i.origin ?? 'campaign',
    manual_call_id: i.manual_call_id ?? null,
  }));
  mockAdapter.initiateCall.mockResolvedValue({ providerCallId: 'pcid-1' });
});


const MANUAL = {
  ...PARAMS,
  correlation: { kind: 'manual' as const, manualCallId: 'manual-1' },
};

function recordLifecycle(mgr: WebRtcBridgeManager) {
  const seen: Array<{ phase: string; correlationId?: string | null }> = [];
  mgr.onLifecycle((ev) => seen.push({ phase: ev.phase, correlationId: ev.correlationId ?? null }));
  return seen;
}

describe('WebRtcBridgeManager — a manual (soft-phone) correlation', () => {
  it('persists origin manual with the manual call id and no campaign or attempt id', async () => {
    const mgr = new WebRtcBridgeManager(makeCallManager() as any, null);
    const ws = fakeStationWs();
    const record = await mgr.createBridgedCall({ ...MANUAL, browserSocket: ws as any });

    const created = mockRepo.create.mock.calls[0]![0];
    expect(created.origin).toBe('manual');
    expect(created.manual_call_id).toBe('manual-1');
    expect(created.campaign_id).toBeNull();
    expect(created.agency_attempt_id).toBeNull();
    const session = mgr.getSession(record.id)!;
    expect(session.correlationId).toBe('manual-1');
    expect(session.manualCallId).toBe('manual-1');
    expect(session.campaignId).toBeNull();
    expect(session.agencyAttemptId).toBeNull();

    await mgr.forceEndWithOutcome('manual-1', 'agent_hangup');
    expect(mgr.getSession(record.id)).toBeUndefined();
  });

  it('a campaign attempt still persists origin campaign and its two back-references', async () => {
    const mgr = new WebRtcBridgeManager(makeCallManager() as any, null);
    await mgr.createBridgedCall({
      ...PARAMS,
      correlation: { kind: 'attempt', campaignId: 'camp-1', agencyAttemptId: 'att-1' },
      browserSocket: fakeStationWs() as any,
    });
    const created = mockRepo.create.mock.calls[0]![0];
    expect(created.origin).toBe('campaign');
    expect(created.manual_call_id).toBeNull();
    expect(created.campaign_id).toBe('camp-1');
    expect(created.agency_attempt_id).toBe('att-1');
    await mgr.forceEndWithOutcome('att-1', 'ended_by_user');
  });

  it('lifecycle events carry the manual call id as the correlation id', async () => {
    const mgr = new WebRtcBridgeManager(makeCallManager() as any, null);
    const seen = recordLifecycle(mgr);
    await mgr.createBridgedCall({ ...MANUAL, browserSocket: fakeStationWs() as any });
    const pstn = fakeStationWs();
    mgr.attachPstnLeg('call-1', pstn as any);
    negotiateVoicelink(pstn);
    expect(seen.map((e) => e.phase)).toEqual(['answered', 'bridged']);
    expect(seen.every((e) => e.correlationId === 'manual-1')).toBe(true);
    // An unanswered manual leg's end carries it too (no carrier confirmation to wait for).
    const seen2 = recordLifecycle(mgr);
    await mgr.createBridgedCall({ ...PARAMS, correlation: { kind: 'manual', manualCallId: 'manual-2' }, browserSocket: fakeStationWs() as any });
    await mgr.forceEndWithOutcome('manual-2', 'agent_hangup');
    expect(seen2.filter((e) => e.phase === 'ended').map((e) => e.correlationId)).toEqual(['manual-2']);
  });

  it('a station close BEFORE the answer hangs up at once, whatever grace was asked for', async () => {
    const mgr = new WebRtcBridgeManager(makeCallManager() as any, null);
    const seen = recordLifecycle(mgr);
    const ws = fakeStationWs();
    await mgr.createBridgedCall({ ...MANUAL, browserSocket: ws as any, browserCloseGraceMs: 8_000 });
    const session = mgr.getSession('call-1')!;
    expect(session.answeredAt).toBeNull();

    ws.readyState = 3;
    ws.emit('close');
    expect(session.browserLegGraceArmed).toBe(false);
    await vi.waitFor(() => expect(seen.some((e) => e.phase === 'ended')).toBe(true));
    expect(mgr.getSession('call-1')).toBeUndefined();
  });

  it('a station close AFTER the answer holds the call for a re-attach', async () => {
    const mgr = new WebRtcBridgeManager(makeCallManager() as any, null);
    const ws = fakeStationWs();
    await mgr.createBridgedCall({ ...MANUAL, browserSocket: ws as any, browserCloseGraceMs: 8_000 });
    const pstn = fakeStationWs();
    mgr.attachPstnLeg('call-1', pstn as any);
    negotiateVoicelink(pstn);
    const session = mgr.getSession('call-1')!;
    expect(session.answeredAt).not.toBeNull();

    ws.readyState = 3;
    ws.emit('close');
    expect(session.browserLegGraceArmed).toBe(true);

    const resumed = fakeStationWs();
    expect(mgr.reattachBorrowedBrowserLeg('manual-1', resumed as any)).toBe(true);
    expect(session.browserLegGraceArmed).toBe(false);
    await mgr.forceEndWithOutcome('manual-1', 'agent_hangup');
  });

  it('a campaign attempt keeps its grace window before the answer (unchanged)', async () => {
    const mgr = new WebRtcBridgeManager(makeCallManager() as any, null);
    const ws = fakeStationWs();
    await mgr.createBridgedCall({
      ...PARAMS,
      correlation: { kind: 'attempt', campaignId: 'camp-1', agencyAttemptId: 'att-1' },
      browserSocket: ws as any,
      browserCloseGraceMs: 8_000,
    });
    ws.readyState = 3;
    ws.emit('close');
    expect(mgr.getSession('call-1')!.browserLegGraceArmed).toBe(true);
    await mgr.forceEndWithOutcome('att-1', 'ended_by_user');
  });
});
