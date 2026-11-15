import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// RC1: a recording the carrier delivered for a call that did not ask for one is never stored.
// VoiceLink is never told whether to record (its `add_lead` has no such field), so it posts a
// `recordingUrl` on `call.completed` whatever the call asked; Plivo posts one to the recording
// callback. Every door is covered: the live recording callback, the terminal event, the ending
// confirmation, and the late (post-teardown) path, which reads the row's own flag. Each discard
// is logged at warn (call id and provider, never the URL) and counted once per call
// (`recording_discarded_unrequested_total{provider}`). A call that asked for one keeps it.
// Self-contained harness (project convention), after `webrtc-bridge-manager.test.ts`.

const h = vi.hoisted(() => ({
  log: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
  discarded: vi.fn(),
}));
vi.mock('@magick-agency/observability', () => ({
  logger: h.log,
  createChildLogger: () => h.log,
}));
vi.mock('@magick-agency/observability/metrics/voice', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  trackRecordingDiscardedUnrequested: h.discarded,
}));

vi.mock('../../../src/config/index.js', () => ({
  config: {
    redis: { keyPrefix: '' },
    telephony: {
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

const { mockAccountSettings } = vi.hoisted(() => ({
  mockAccountSettings: {
    getAllowRecording: vi.fn().mockResolvedValue(true),
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
    get() { return mockAdapter; }
    async getForCredentialId() { return mockAdapter; }
  },
}));
vi.mock('../../../src/audit/audit-logger.js', () => ({ auditLogger: { log: vi.fn() } }));
vi.mock('../../../src/analytics/posthog.js', () => ({
  trackWebrtcCallInitiated: vi.fn(),
  trackWebrtcCallRejected: vi.fn(),
  trackWebrtcCallCompleted: vi.fn(),
}));

import { WebRtcBridgeManager } from '../../../src/core/webrtc-bridge-manager.js';
import { UnrequestedRecordings } from '../../../src/core/bridge/unrequested-recording.js';
import {
  setBridgeAnalysisHooks, resetBridgeAnalysisHooks, type BridgeAnalysisHooks,
} from '../../../src/seams/bridge-analysis-hooks.js';

const REC = 'https://recording.app.voicelink.co.in/client_1/2026-11-15/abc.mp3?Signature=s3cr3t';

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
      const i = list ? list.indexOf(cb) : -1;
      if (list && i >= 0) list.splice(i, 1);
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

const ATTEMPT = 'att-1';
async function dial(mgr: WebRtcBridgeManager, opts: { provider: 'voicelink' | 'plivo'; record: boolean }) {
  return mgr.createBridgedCall({
    tenantId: 't1', accountId: 'a1', callerId: '+14155550100', destinationPhone: '+14155550199',
    provider: opts.provider, record: opts.record,
    ...(opts.provider === 'plivo' ? { telephonyCredentialId: 'cred-1' } : {}),
    browserSocket: fakeWs() as any,
    correlation: { kind: 'attempt' as const, campaignId: 'camp-1', agencyAttemptId: ATTEMPT },
  });
}

/** VoiceLink's terminal `call.completed`, carrying the recording URL. */
const completed = (url = REC) => ({
  providerCallId: 'carrier-9', callId: 'call-1', eventType: 'hangup' as const, timestamp: new Date(),
  metadata: { event: 'call.completed', call: { id: 'carrier-9', callStatus: 'ANSWERED', recordingUrl: url } },
});

/** Every recording URL any write carried. */
const writtenUrls = () => mockRepo.update.mock.calls.map((c: any[]) => c[1]?.recording_url).filter((u: unknown) => u !== undefined);
const discardWarns = () => h.log.warn.mock.calls.filter((c) => String(c[1]).includes('did not ask for one'));

let hooks: { onCallFinalized: ReturnType<typeof vi.fn>; onRecordingReady: ReturnType<typeof vi.fn> };

beforeEach(() => {
  vi.clearAllMocks();
  mockRepo.create.mockImplementation(async (i: any) => ({
    id: 'call-1', tenant_id: i.tenant_id, account_id: i.account_id, caller_id: i.caller_id,
    destination_phone: i.destination_phone, provider: i.provider, status: 'initiating', provider_call_id: null,
    recording_requested: i.recording_requested, telephony_credential_id: i.telephony_credential_id ?? null,
    campaign_id: i.campaign_id ?? null, agency_attempt_id: i.agency_attempt_id ?? null,
  }));
  mockAdapter.initiateCall.mockResolvedValue({ providerCallId: 'pcid-1' });
  mockAccountSettings.getAllowRecording.mockResolvedValue(true);
  hooks = { onCallFinalized: vi.fn().mockResolvedValue(undefined), onRecordingReady: vi.fn().mockResolvedValue(undefined) };
  setBridgeAnalysisHooks(hooks as unknown as BridgeAnalysisHooks);
});
afterEach(() => resetBridgeAnalysisHooks());

describe('VoiceLink records anyway: the call did not ask', () => {
  it('campaign recording off: the terminal call.completed URL is discarded, warned and counted once', async () => {
    const mgr = new WebRtcBridgeManager(makeCallManager() as any, null);
    await dial(mgr, { provider: 'voicelink', record: false });
    expect(mockRepo.create.mock.calls[0]![0].recording_requested).toBe(false);

    await mgr.handleVoicelinkStatus('call-1', completed());

    expect(mgr.getSession('call-1')).toBeUndefined();
    expect(writtenUrls()).toEqual([]);
    expect(h.discarded).toHaveBeenCalledTimes(1);
    expect(h.discarded).toHaveBeenCalledWith('voicelink');
    expect(discardWarns()).toHaveLength(1);
    expect(discardWarns()[0]![0]).toMatchObject({ callId: 'call-1', provider: 'voicelink', where: 'terminal' });
    expect(JSON.stringify(h.log.warn.mock.calls)).not.toContain('s3cr3t');

    // VoiceLink's retry of the same completion after teardown: the late path reads the row's
    // own flag, stores nothing, wakes no analysis, and is not counted a second time.
    mockRepo.findById.mockResolvedValueOnce({ id: 'call-1', provider: 'voicelink', recording_requested: false, recording_url: null, provider_call_id: 'carrier-9' });
    await mgr.handleVoicelinkStatus('call-1', completed());
    expect(writtenUrls()).toEqual([]);
    expect(hooks.onRecordingReady).not.toHaveBeenCalled();
    expect(h.discarded).toHaveBeenCalledTimes(1);
    expect(discardWarns()).toHaveLength(1);
  });

  it('account allow_recording off (record asked for, ceiling refuses): discarded the same way', async () => {
    mockAccountSettings.getAllowRecording.mockResolvedValue(false);
    const mgr = new WebRtcBridgeManager(makeCallManager() as any, null);
    await dial(mgr, { provider: 'voicelink', record: true });
    expect(mockRepo.create.mock.calls[0]![0].recording_requested).toBe(false);
    await mgr.handleVoicelinkStatus('call-1', completed());
    expect(writtenUrls()).toEqual([]);
    expect(h.discarded).toHaveBeenCalledWith('voicelink');
  });

  it('a hangup we started, confirmed by call.completed with the URL (the ending path): discarded', async () => {
    const mgr = new WebRtcBridgeManager(makeCallManager() as any, null);
    await dial(mgr, { provider: 'voicelink', record: false });
    const pstn = fakeWs();
    mgr.attachPstnLeg('call-1', pstn as any);
    pstn.emit('message', JSON.stringify({
      event: 'start', start: { call_sid: 'c', media_format: { encoding: 'audio/alaw', sample_rate: '8000' } },
    }));
    await mgr.forceEndWithOutcome(ATTEMPT, 'ended_by_user');
    await mgr.handleVoicelinkStatus('call-1', completed());
    expect(mgr.getSession('call-1')).toBeUndefined();
    expect(writtenUrls()).toEqual([]);
    expect(h.discarded).toHaveBeenCalledTimes(1);
  });

  it('a call that asked for a recording keeps it (the control)', async () => {
    const mgr = new WebRtcBridgeManager(makeCallManager() as any, null);
    await dial(mgr, { provider: 'voicelink', record: true });
    await mgr.handleVoicelinkStatus('call-1', completed());
    expect(writtenUrls()).toEqual([REC]);
    expect(h.discarded).not.toHaveBeenCalled();
  });

  it('late: a completion after teardown for a row that did not ask stores nothing and wakes no analysis', async () => {
    const mgr = new WebRtcBridgeManager(makeCallManager() as any, null);
    mockRepo.findById.mockResolvedValueOnce({ id: 'call-1', provider: 'voicelink', recording_requested: false, recording_url: null, provider_call_id: null });
    await mgr.handleVoicelinkStatus('call-1', completed());
    // The carrier id is still filled; the recording is not.
    const patches = mockRepo.update.mock.calls.map((c: any[]) => c[1]);
    expect(patches).toEqual([{ provider_call_id: 'carrier-9' }]);
    expect(hooks.onRecordingReady).not.toHaveBeenCalled();
    expect(h.discarded).toHaveBeenCalledWith('voicelink');
    expect(discardWarns()[0]![0]).toMatchObject({ callId: 'call-1', where: 'late' });
  });

  it('late: another carrier\'s event is ignored before anything is counted', async () => {
    const mgr = new WebRtcBridgeManager(makeCallManager() as any, null);
    mockRepo.findById.mockResolvedValueOnce({ id: 'call-1', provider: 'plivo', recording_requested: false, recording_url: null, provider_call_id: null });
    await mgr.handleVoicelinkStatus('call-1', completed());
    expect(mockRepo.update).not.toHaveBeenCalled();
    expect(h.discarded).not.toHaveBeenCalled();
  });
});

describe('Plivo recording callbacks for a call that did not ask', () => {
  it('live: the recording callback is discarded at once, and the terminal write carries none', async () => {
    const mgr = new WebRtcBridgeManager(makeCallManager() as any, null);
    await dial(mgr, { provider: 'plivo', record: false });
    await mgr.handleCarrierRecording('call-1', 'plivo', { recordingUrl: 'https://media.plivo.com/v1/Account/MA1/Recording/r.mp3', carrierCallId: 'uuid-1' });
    expect(mgr.getSession('call-1')!.recordingUrl).toBeNull();
    expect(h.discarded).toHaveBeenCalledWith('plivo');
    expect(discardWarns()[0]![0]).toMatchObject({ callId: 'call-1', provider: 'plivo', where: 'live' });
    await mgr.forceEndWithOutcome(ATTEMPT, 'ended_by_user');
    expect(writtenUrls()).toEqual([]);
    expect(h.discarded).toHaveBeenCalledTimes(1);
  });

  it('late: an inbound leg whose recording was taken back after arrival (refused admission) keeps none', async () => {
    const mgr = new WebRtcBridgeManager(makeCallManager() as any, null);
    // `refuseAdmission` flipped the leg's `recording_requested` to false on the row.
    mockRepo.findById.mockResolvedValueOnce({ id: 'leg-1', provider: 'plivo', recording_requested: false, recording_url: null, provider_call_id: 'uuid-1' });
    await mgr.handleCarrierRecording('leg-1', 'plivo', { recordingUrl: 'https://media.plivo.com/v1/Account/MA1/Recording/r.mp3', carrierCallId: 'uuid-1' });
    expect(mockRepo.update).not.toHaveBeenCalled();
    expect(hooks.onRecordingReady).not.toHaveBeenCalled();
    expect(h.discarded).toHaveBeenCalledWith('plivo');
  });

  it('late: a row that asked for one is filled and wakes analysis (the control)', async () => {
    const mgr = new WebRtcBridgeManager(makeCallManager() as any, null);
    mockRepo.findById.mockResolvedValueOnce({ id: 'leg-1', provider: 'plivo', recording_requested: true, recording_url: null, provider_call_id: 'uuid-1' });
    await mgr.handleCarrierRecording('leg-1', 'plivo', { recordingUrl: 'https://media.plivo.com/r.mp3', carrierCallId: 'uuid-1' });
    expect(mockRepo.update).toHaveBeenCalledWith('leg-1', { recording_url: 'https://media.plivo.com/r.mp3' });
    expect(hooks.onRecordingReady).toHaveBeenCalledWith('leg-1');
    expect(h.discarded).not.toHaveBeenCalled();
  });
});

describe('UnrequestedRecordings', () => {
  it('logs and counts a call once, and forgets the oldest past its bound', () => {
    const notes = new UnrequestedRecordings(2);
    notes.discard('a', 'voicelink', 'terminal');
    notes.discard('a', 'voicelink', 'late');
    notes.discard('b', 'voicelink', 'late');
    expect(h.discarded).toHaveBeenCalledTimes(2);
    notes.discard('c', 'plivo', 'live'); // forgets 'a'
    notes.discard('b', 'voicelink', 'late');
    expect(h.discarded).toHaveBeenCalledTimes(3);
    notes.discard('a', 'voicelink', 'late');
    expect(h.discarded).toHaveBeenCalledTimes(4);
  });
});
