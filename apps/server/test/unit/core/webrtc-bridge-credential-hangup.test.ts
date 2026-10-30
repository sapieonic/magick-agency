import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// The carrier hangup runs on the account the call was PLACED on (decision B20).
//
// A call pinned to a tenant credential (`agency_calls.telephony_credential_id`)
// must hang up through `getForCredentialId(provider, id, 'call_control', tenant)`.
// The env-only `get(provider)` builds the service's own adapter, and for a carrier
// that only exists as a tenant credential it throws `Unknown telephony provider`:
// the teardown logs, the row is finalized, and the customer's phone keeps ringing.
// A null id stays on `get(provider)`, so today's VoiceLink calls are unchanged.
//
// A carrier module with `answeredHangup: 'rest'` is registered under `plivo` here
// (no such module exists yet); it reuses VoiceLink's media protocol, which these
// cases never exercise past session construction.
//
// Mock harness mirrors webrtc-bridge-ring-cancel.test.ts (project convention: no
// shared test utilities).
// ---------------------------------------------------------------------------

const { logSpy } = vi.hoisted(() => ({
  logSpy: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@magick-agency/observability', () => ({
  logger: logSpy,
  createChildLogger: () => logSpy,
}));

vi.mock('../../../src/config/index.js', () => ({
  config: {
    redis: { keyPrefix: '' },
    telephony: {
      voicelink: { webhookBaseUrl: 'https://server.test/api/v1/webhooks/voicelink' },
    },
    telephonyCredentials: { keyring: '', activeKeyId: '' },
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

vi.mock('@magick-agency/db/repositories/account-settings.repository', () => ({
  accountSettingsRepository: {
    getAllowRecording: vi.fn().mockResolvedValue(null),
    getWebrtcMaxDurationSeconds: vi.fn().mockResolvedValue(null),
  },
}));

// Two adapters, so a test can tell which account the hangup went to.
const { envAdapter, byocAdapter, registry } = vi.hoisted(() => {
  const adapter = (name: string) => ({
    name,
    capabilities: { cancelRinging: true },
    initiateCall: vi.fn(),
    endCall: vi.fn().mockResolvedValue(undefined),
    generateAnswerResponse: vi.fn().mockReturnValue('<Response/>'),
  });
  const envAdapter = adapter('env');
  const byocAdapter = adapter('byoc');
  return {
    envAdapter,
    byocAdapter,
    registry: {
      get: vi.fn((_provider: string) => envAdapter),
      getForCredentialId: vi.fn(async (_p: string, _id: string | null, _purpose: string, _t: string) => byocAdapter),
    },
  };
});
vi.mock('../../../src/telephony/factory.js', () => ({
  TelephonyProviderRegistry: class {
    get(p: string) { return registry.get(p); }
    getForCredentialId(p: string, id: string | null, purpose: string, t: string) {
      return registry.getForCredentialId(p, id, purpose, t);
    }
  },
}));

vi.mock('../../../src/telephony/carrier-modules.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/telephony/carrier-modules.js')>();
  const vl = actual.findCarrierModule('voicelink')!;
  const rest = {
    ...vl,
    name: 'plivo',
    answeredHangup: 'rest' as const,
    mediaUrlInDialRequest: false,
    media: { ...vl.media, negotiatesOnStart: false },
  };
  return {
    ...actual,
    findCarrierModule: (p: string) => (p === 'plivo' ? rest : actual.findCarrierModule(p)),
  };
});

vi.mock('../../../src/audit/audit-logger.js', () => ({ auditLogger: { log: vi.fn() } }));
vi.mock('../../../src/analytics/posthog.js', () => ({
  trackWebrtcCallInitiated: vi.fn(),
  trackWebrtcCallRejected: vi.fn(),
  trackWebrtcCallCompleted: vi.fn(),
}));

import { WebRtcBridgeManager } from '../../../src/core/webrtc-bridge-manager.js';

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

function makeGuardHost() {
  return {
    concurrencyGuard: { tryAcquire: vi.fn().mockResolvedValue(true), release: vi.fn().mockResolvedValue(undefined) },
    accountConcurrencyGuard: { tryAcquire: vi.fn().mockResolvedValue(true), release: vi.fn().mockResolvedValue(undefined) },
    triggerDequeue: vi.fn(),
    wakeSelfHeal: vi.fn(),
  };
}

const BRIDGED = {
  tenantId: 'tenant-a',
  accountId: 'a1',
  callerId: '+14155550100',
  destinationPhone: '+14155550199',
  correlation: { kind: 'attempt' as const, campaignId: 'camp-1', agencyAttemptId: 'att-1' },
};

/** The credential the next inserted row carries (the bridge reads it back off the row). */
let rowCredentialId: string | null = null;

beforeEach(() => {
  vi.clearAllMocks();
  rowCredentialId = null;
  mockRepo.create.mockImplementation(async (i: any) => ({
    id: 'call-1',
    tenant_id: i.tenant_id,
    account_id: i.account_id,
    caller_id: i.caller_id,
    destination_phone: i.destination_phone,
    provider: i.provider,
    status: 'initiating',
    provider_call_id: null,
    provider_request_id: null,
    telephony_credential_id: rowCredentialId,
    campaign_id: i.campaign_id ?? null,
    agency_attempt_id: i.agency_attempt_id ?? null,
  }));
  envAdapter.initiateCall.mockResolvedValue({ providerCallId: 'pcid-1' });
  byocAdapter.initiateCall.mockResolvedValue({ providerCallId: 'pcid-1' });
});

describe('hangupProviderLeg resolves the account the call was placed on', () => {
  it('a call pinned to a credential hangs up through getForCredentialId with call_control and the call`s tenant', async () => {
    rowCredentialId = 'cred-1';
    const mgr = new WebRtcBridgeManager(makeGuardHost() as any, null);
    await mgr.createBridgedCall({ ...BRIDGED, provider: 'plivo', browserSocket: fakeWs() as any });

    expect(await mgr.forceEndWithOutcome('att-1', 'agent_hangup')).toBe(true);

    expect(registry.getForCredentialId).toHaveBeenCalledWith('plivo', 'cred-1', 'call_control', 'tenant-a');
    expect(byocAdapter.endCall).toHaveBeenCalledWith('pcid-1');
    // The hangup never went to the service's own account.
    expect(envAdapter.endCall).not.toHaveBeenCalled();
    // The dial's own lookup only (dialing on a credential is not built yet).
    expect(registry.get).toHaveBeenCalledTimes(1);
    expect(mgr.getSession('call-1')).toBeUndefined();
  });

  it('an answered REST call hangs up on its credential too, and finalizes at once', async () => {
    rowCredentialId = 'cred-1';
    const mgr = new WebRtcBridgeManager(makeGuardHost() as any, null);
    await mgr.createBridgedCall({ ...BRIDGED, provider: 'plivo', browserSocket: fakeWs() as any });
    expect(mgr.attachPstnLeg('call-1', fakeWs() as any)).toBe(true);

    await mgr.forceEndWithOutcome('att-1', 'agent_hangup');

    expect(registry.getForCredentialId).toHaveBeenCalledWith('plivo', 'cred-1', 'call_control', 'tenant-a');
    expect(byocAdapter.endCall).toHaveBeenCalledWith('pcid-1');
    expect(mgr.getSession('call-1')).toBeUndefined();
  });

  it('a credential that does not resolve is logged at ERROR and never falls back to the service`s own account', async () => {
    rowCredentialId = 'cred-1';
    registry.getForCredentialId.mockRejectedValueOnce(new Error('Telephony credential cred-1 could not be resolved'));
    const mgr = new WebRtcBridgeManager(makeGuardHost() as any, null);
    await mgr.createBridgedCall({ ...BRIDGED, provider: 'plivo', browserSocket: fakeWs() as any });

    await mgr.forceEndWithOutcome('att-1', 'agent_hangup');

    expect(envAdapter.endCall).not.toHaveBeenCalled();
    expect(byocAdapter.endCall).not.toHaveBeenCalled();
    const lines = logSpy.error.mock.calls.filter((c: any[]) => String(c[1]).includes('NOT hung up'));
    expect(lines).toHaveLength(1);
    expect(lines[0]![0]).toMatchObject({ callId: 'call-1', telephonyCredentialId: 'cred-1', provider: 'plivo' });
    // Teardown still completed: the row is terminal and the session is gone.
    expect(mockRepo.update.mock.calls.some((c: any[]) => c[1]?.status === 'canceled')).toBe(true);
    expect(mgr.getSession('call-1')).toBeUndefined();
  });

  it('a null credential id stays on get(provider)', async () => {
    const mgr = new WebRtcBridgeManager(makeGuardHost() as any, null);
    await mgr.createBridgedCall({ ...BRIDGED, provider: 'voicelink', browserSocket: fakeWs() as any });
    registry.get.mockClear();

    // Unanswered VoiceLink: finalized at once with a provider hangup attempt.
    await mgr.forceEndWithOutcome('att-1', 'agent_hangup');

    expect(registry.get).toHaveBeenCalledWith('voicelink');
    expect(registry.getForCredentialId).not.toHaveBeenCalled();
    expect(envAdapter.endCall).toHaveBeenCalledWith('pcid-1');
  });

  it('VoiceLink answered: closes the media socket and defers, with no REST hangup on either account', async () => {
    const mgr = new WebRtcBridgeManager(makeGuardHost() as any, null);
    const station = fakeWs();
    await mgr.createBridgedCall({ ...BRIDGED, provider: 'voicelink', browserSocket: station as any });
    const pstn = fakeWs();
    expect(mgr.attachPstnLeg('call-1', pstn as any)).toBe(true);
    pstn.emit('message', JSON.stringify({
      event: 'start',
      start: { call_sid: 'carrier-1', stream_sid: 's1', media_format: { encoding: 'audio/alaw', sample_rate: '8000' } },
    }));
    registry.get.mockClear();

    await mgr.forceEndWithOutcome('att-1', 'agent_hangup');

    // `close_media`: the WS close IS the hangup; the row waits for call.ended.
    expect(pstn.readyState).toBe(3);
    expect(station.sent.some((f) => f.event === 'status' && f.status === 'ending')).toBe(true);
    expect(mgr.getSession('call-1')).toBeDefined();
    expect(registry.get).not.toHaveBeenCalled();
    expect(registry.getForCredentialId).not.toHaveBeenCalled();
    expect(envAdapter.endCall).not.toHaveBeenCalled();
  });
});
