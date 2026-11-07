import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// A Plivo call through the bridge, on the REAL Plivo carrier module (`plivo.media.ts`)
// and callback reader (`plivo.webhook.ts`), with a stub adapter on the tenant's
// credential (decisions B18–B20):
//
//  - the dial resolves the call's pinned credential for `dial`, never the service's own
//    account; a credential that cannot dial is a leg never placed (no carrier request,
//    no `ended`, its own refusal code);
//  - the stream URL goes in our answer response, not the dial; every callback URL is on
//    the Plivo namespace with the webhook token;
//  - the dial's `request_uuid` is kept and persisted, and a teardown before the answer
//    cancels by it; after the answer the call is hung up by Plivo's call id; never by an
//    empty id;
//  - a calls-per-second refusal and a carrier 401 are refusals before anything was
//    placed, each with its own code;
//  - ring, answer and terminal callbacks drive the call; a recording callback after the
//    call ended is persisted and wakes analysis.
//
// Mock harness mirrors webrtc-bridge-credential-hangup.test.ts (project convention: no
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
      plivo: { webhookBaseUrl: 'https://server.test/api/v1/webhooks/plivo' },
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
    getAllowRecording: vi.fn().mockResolvedValue(true),
    getWebrtcMaxDurationSeconds: vi.fn().mockResolvedValue(600),
  },
}));

// The tenant's Plivo adapter, and the service's own account (which, like the real
// registry, knows no Plivo: `get('plivo')` throws).
const { plivoAdapter, registry } = vi.hoisted(() => {
  const plivoAdapter = {
    name: 'plivo',
    capabilities: { cancelRinging: true, queuesOutboundDials: false },
    initiateCall: vi.fn(),
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
      recordCredentialRefused: vi.fn(async (_a: unknown, _reason: string, _at: unknown) => true),
    },
  };
});
vi.mock('../../../src/telephony/factory.js', () => ({
  TelephonyProviderRegistry: class {
    get(p: string) { return registry.get(p); }
    getForCredentialId(p: string, id: string | null, purpose: string, t: string) {
      return registry.getForCredentialId(p, id, purpose, t);
    }
    recordCredentialRefused(a: unknown, reason: string, at: unknown) { return registry.recordCredentialRefused(a, reason, at); }
  },
}));

vi.mock('../../../src/audit/audit-logger.js', () => ({ auditLogger: { log: vi.fn() } }));
vi.mock('../../../src/analytics/posthog.js', () => ({
  trackWebrtcCallInitiated: vi.fn(),
  trackWebrtcCallRejected: vi.fn(),
  trackWebrtcCallCompleted: vi.fn(),
}));

import { WebRtcBridgeManager, WebRtcCallError } from '../../../src/core/webrtc-bridge-manager.js';
import { normalizePlivoCallback, plivoCallEvent } from '../../../src/telephony/plivo/plivo.webhook.js';
import { CarrierAuthRejectedError, CarrierRateLimitedError } from '../../../src/telephony/carrier-errors.js';
import { setBridgeAnalysisHooks, resetBridgeAnalysisHooks } from '../../../src/seams/bridge-analysis-hooks.js';

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

const CALL_ID = '6b1f7d4e-0c1a-4a55-9a3e-2f1d6c0b9e11';
const PLIVO = {
  tenantId: 'tenant-a',
  accountId: 'a1',
  callerId: '+14155550100',
  destinationPhone: '+14155550199',
  provider: 'plivo',
  telephonyCredentialId: 'cred-1',
  record: true,
  correlation: { kind: 'attempt' as const, campaignId: 'camp-1', agencyAttemptId: 'att-1' },
};

/** A Plivo callback as the route would hand it to the bridge. */
function plivoEvent(kind: 'answer' | 'status', params: Record<string, string>) {
  const event = plivoCallEvent(normalizePlivoCallback(kind, params), CALL_ID);
  if (!event) throw new Error('no event');
  return event;
}

let lifecycle: any[] = [];
const hooks = { onCallFinalized: vi.fn().mockResolvedValue(undefined), onRecordingReady: vi.fn().mockResolvedValue(undefined) };

beforeEach(() => {
  vi.clearAllMocks();
  // Back to the original implementation: a test's unconsumed `…Once` must not leak into the next.
  registry.getForCredentialId.mockReset();
  lifecycle = [];
  resetBridgeAnalysisHooks();
  setBridgeAnalysisHooks(hooks);
  mockRepo.findById.mockResolvedValue(null);
  mockRepo.create.mockImplementation(async (i: any) => ({
    id: CALL_ID,
    tenant_id: i.tenant_id,
    account_id: i.account_id,
    caller_id: i.caller_id,
    destination_phone: i.destination_phone,
    provider: i.provider,
    status: 'initiating',
    provider_call_id: null,
    provider_request_id: null,
    telephony_credential_id: i.telephony_credential_id ?? null,
    campaign_id: i.campaign_id ?? null,
    agency_attempt_id: i.agency_attempt_id ?? null,
  }));
  plivoAdapter.initiateCall.mockResolvedValue({ providerCallId: '', providerRequestId: 'req-1' });
  plivoAdapter.cancelDialRequest.mockResolvedValue('canceled');
});

async function dial(mgr = new WebRtcBridgeManager(makeGuardHost() as any, null)) {
  mgr.onLifecycle((e) => lifecycle.push(e));
  await mgr.createBridgedCall({ ...PLIVO, browserSocket: fakeWs() as any });
  return mgr;
}

describe('a Plivo dial places the leg on the call`s own credential', () => {
  it('pins the credential on the row and resolves it for `dial`, never the service`s own account', async () => {
    await dial();
    expect(mockRepo.create).toHaveBeenCalledWith(expect.objectContaining({ provider: 'plivo', telephony_credential_id: 'cred-1' }));
    expect(registry.getForCredentialId).toHaveBeenCalledWith('plivo', 'cred-1', 'dial', 'tenant-a');
    expect(registry.get).not.toHaveBeenCalled();
    expect(plivoAdapter.initiateCall).toHaveBeenCalledTimes(1);
  });

  it('hands Plivo tokenized answer and status URLs on its own namespace, and no stream URL in the dial', async () => {
    const mgr = await dial();
    const req = plivoAdapter.initiateCall.mock.calls[0]![0];
    expect(req.webhookUrl).toMatch(new RegExp(`^https://server\\.test/api/v1/webhooks/plivo/webrtc-answer/${CALL_ID}\\?token=[0-9a-f-]{36}$`));
    expect(req.statusCallbackUrl).toMatch(new RegExp(`^https://server\\.test/api/v1/webhooks/plivo/webrtc-status/${CALL_ID}\\?token=[0-9a-f-]{36}$`));
    expect(req.mediaStreamUrl).toBeUndefined();
    // The stream URL is kept for the answer response, with the PROVIDER token (not the webhook one).
    const session = mgr.getSession(CALL_ID)!;
    expect(session.answerStreamUrl).toMatch(new RegExp(`^wss://server\\.test/api/v1/webrtc-call/${CALL_ID}/pstn-stream\\?token=[0-9a-f-]{36}$`));
    expect(session.answerStreamUrl!.split('token=')[1]).not.toBe(req.webhookUrl.split('token=')[1]);
    expect(session.recordingCallbackUrl).toMatch(/\/webhooks\/plivo\/webrtc-recording\/.+\?token=/);
  });

  it('keeps the dial`s request id on the session and persists it as provider_request_id', async () => {
    const mgr = await dial();
    expect(mgr.getSession(CALL_ID)!.providerRequestId).toBe('req-1');
    expect(mgr.getSession(CALL_ID)!.providerCallId).toBeNull();
    expect(mockRepo.update).toHaveBeenCalledWith(CALL_ID, { provider_call_id: null, provider_request_id: 'req-1' });
  });

  it('a credential that cannot dial is a leg never placed: no carrier request, no `ended`, its own code', async () => {
    registry.getForCredentialId.mockRejectedValueOnce(Object.assign(new Error('Telephony credential cred-1 could not be resolved: disabled'), {
      name: 'ByocCredentialUnavailableError', credentialUnavailable: true,
    }));
    const mgr = new WebRtcBridgeManager(makeGuardHost() as any, null);
    mgr.onLifecycle((e) => lifecycle.push(e));
    const err = await mgr.createBridgedCall({ ...PLIVO, browserSocket: fakeWs() as any }).catch((e) => e);
    expect(err).toBeInstanceOf(WebRtcCallError);
    expect(err.code).toBe('telephony_credential_unavailable');
    expect(plivoAdapter.initiateCall).not.toHaveBeenCalled();
    expect(registry.get).not.toHaveBeenCalled();
    expect(lifecycle.filter((e) => e.phase === 'ended')).toHaveLength(0);
    expect(mockRepo.update).toHaveBeenCalledWith(CALL_ID, expect.objectContaining({ status: 'failed', error_code: 'TELEPHONY_CREDENTIAL_UNAVAILABLE' }));
    expect(mgr.getSession(CALL_ID)).toBeUndefined();
  });

  it('a credential not active at the insert is refused with its own code: no row, no session, slots released', async () => {
    mockRepo.create.mockRejectedValueOnce(Object.assign(new Error('Telephony credential cred-1 is not active'), {
      code: 'telephony_credential_not_active',
    }));
    const host = makeGuardHost();
    const mgr = new WebRtcBridgeManager(host as any, null);
    const err = await mgr.createBridgedCall({ ...PLIVO, browserSocket: fakeWs() as any }).catch((e) => e);
    expect(err).toBeInstanceOf(WebRtcCallError);
    expect(err.code).toBe('telephony_credential_unavailable');
    expect(err.cause).toMatchObject({ code: 'telephony_credential_not_active' });
    expect(registry.getForCredentialId).not.toHaveBeenCalled();
    expect(plivoAdapter.initiateCall).not.toHaveBeenCalled();
    expect(mgr.getActiveCallIds()).toEqual([]);
    expect(mgr.heldLeases()).toEqual([]);
  });

  it('a Plivo dial with no credential never reaches the service`s account: unplaced', async () => {
    const mgr = new WebRtcBridgeManager(makeGuardHost() as any, null);
    const err = await mgr.createBridgedCall({ ...PLIVO, telephonyCredentialId: null, browserSocket: fakeWs() as any }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(String(err.message)).toMatch(/Unknown telephony provider: plivo/);
    expect(plivoAdapter.initiateCall).not.toHaveBeenCalled();
    expect(mgr.getActiveCallIds()).toEqual([]);
  });

  it.each([
    ['local calls-per-second gate', new CarrierRateLimitedError('plivo', 'local_gate', 5000), 'carrier_rate_limited', 'CARRIER_RATE_LIMITED'],
    ['carrier 429', new CarrierRateLimitedError('plivo', 'carrier', 0), 'carrier_rate_limited', 'CARRIER_RATE_LIMITED'],
    ['carrier 401', new CarrierAuthRejectedError('plivo', 401), 'carrier_auth_rejected', 'CARRIER_AUTH_REJECTED'],
  ])('a %s is a refusal before anything was placed: its own code, the adapter error as cause, no `ended`', async (_n, cause, code, errorCode) => {
    plivoAdapter.initiateCall.mockRejectedValueOnce(cause);
    const mgr = new WebRtcBridgeManager(makeGuardHost() as any, null);
    mgr.onLifecycle((e) => lifecycle.push(e));
    const err = await mgr.createBridgedCall({ ...PLIVO, browserSocket: fakeWs() as any }).catch((e) => e);
    expect(err).toBeInstanceOf(WebRtcCallError);
    expect(err.code).toBe(code);
    expect(err.cause).toBe(cause);
    expect(lifecycle.filter((e) => e.phase === 'ended')).toHaveLength(0);
    expect(mockRepo.update).toHaveBeenCalledWith(CALL_ID, expect.objectContaining({ status: 'failed', error_code: errorCode }));
    expect(plivoAdapter.cancelDialRequest).not.toHaveBeenCalled();
    expect(plivoAdapter.endCall).not.toHaveBeenCalled();
    // Only the carrier refusing the credential is a verdict on it; a rate limit says nothing.
    if (code === 'carrier_auth_rejected') {
      expect(registry.recordCredentialRefused).toHaveBeenCalledTimes(1);
      expect(registry.recordCredentialRefused).toHaveBeenCalledWith(
        plivoAdapter, 'The carrier refused the credential on a dial (HTTP 401)',
        { tenantId: 'tenant-a', accountId: 'a1', callId: CALL_ID },
      );
    } else {
      expect(registry.recordCredentialRefused).not.toHaveBeenCalled();
    }
  });

  it('a media worker places a Plivo dial with its slot in every URL Plivo gets: answer, status, recording and the stream', async () => {
    plivoAdapter.initiateCall.mockResolvedValueOnce({ providerCallId: '', providerRequestId: 'req-1' });
    const mgr = new WebRtcBridgeManager(makeGuardHost() as any, null, { carrierRouteHint: '1' });
    await mgr.createBridgedCall({ ...PLIVO, browserSocket: fakeWs() as any });
    expect(plivoAdapter.initiateCall).toHaveBeenCalledTimes(1);
    const req = plivoAdapter.initiateCall.mock.calls[0]![0];
    expect(req.webhookUrl).toMatch(/\/webrtc-answer\/.+\?token=[0-9a-f-]{36}&w=1$/);
    expect(req.statusCallbackUrl).toMatch(/\/webrtc-status\/.+\?token=[0-9a-f-]{36}&w=1$/);
    const session = mgr.getSession(CALL_ID)!;
    expect(session.recordingCallbackUrl).toMatch(/\/webrtc-recording\/.+\?token=[0-9a-f-]{36}&w=1$/);
    expect(session.answerStreamUrl).toMatch(/\/pstn-stream\?token=[0-9a-f-]{36}&w=1$/);
  });
});

describe('a Plivo teardown reaches the carrier by the right id, and never an empty one', () => {
  it('before the answer: cancels the dial by its request id, sends no hangup', async () => {
    const mgr = await dial();
    await mgr.forceEndWithOutcome('att-1', 'agent_hangup');
    expect(registry.getForCredentialId).toHaveBeenCalledWith('plivo', 'cred-1', 'call_control', 'tenant-a');
    expect(plivoAdapter.cancelDialRequest).toHaveBeenCalledWith('req-1');
    expect(plivoAdapter.endCall).not.toHaveBeenCalled();
    expect(mgr.getSession(CALL_ID)).toBeUndefined();
  });

  it('before the answer, the request gone and the call named by its ring callback: hangs up by the call id', async () => {
    plivoAdapter.cancelDialRequest.mockResolvedValueOnce('not_found');
    const mgr = await dial();
    await mgr.handleCarrierStatus(CALL_ID, plivoEvent('status', { CallStatus: 'ringing', CallUUID: 'uuid-1', RequestUUID: 'req-1' }), 'plivo');
    await mgr.forceEndWithOutcome('att-1', 'agent_hangup');
    expect(plivoAdapter.cancelDialRequest).toHaveBeenCalledWith('req-1');
    expect(plivoAdapter.endCall).toHaveBeenCalledWith('uuid-1');
  });

  it('before the answer, the request gone and no call id yet: nothing more is sent until a callback names the call', async () => {
    plivoAdapter.cancelDialRequest.mockResolvedValueOnce('not_found');
    const mgr = await dial();
    await mgr.forceEndWithOutcome('att-1', 'agent_hangup');
    expect(plivoAdapter.endCall).not.toHaveBeenCalled();
    expect(logSpy.warn.mock.calls.some((c: any[]) => String(c[1]).includes('its next ring or answer callback names it'))).toBe(true);
    // The answer callback for that call finds nothing to bridge (the route answers with a
    // hangup), and the leg it names is hung up by that id, on the call's own credential.
    mockRepo.findById.mockResolvedValue(endedRow());
    expect(await mgr.answerCarrierCall(CALL_ID, plivoEvent('answer', { CallStatus: 'in-progress', CallUUID: 'uuid-1' }), 'plivo')).toBeNull();
    await vi.waitFor(() => expect(plivoAdapter.endCall).toHaveBeenCalledWith('uuid-1'));
    expect(registry.getForCredentialId).toHaveBeenLastCalledWith('plivo', 'cred-1', 'call_control', 'tenant-a');
  });

  it('after the answer: hangs up by Plivo`s call id from the answer callback, and cancels nothing', async () => {
    const mgr = await dial();
    const plan = await mgr.answerCarrierCall(CALL_ID, plivoEvent('answer', { CallStatus: 'in-progress', CallUUID: 'uuid-1', RequestUUID: 'req-1' }), 'plivo');
    expect(plan).not.toBeNull();
    await mgr.forceEndWithOutcome('att-1', 'agent_hangup');
    expect(plivoAdapter.endCall).toHaveBeenCalledWith('uuid-1');
    expect(plivoAdapter.cancelDialRequest).not.toHaveBeenCalled();
    // `answeredHangup: 'rest'`: finalized at once, no `ending` limbo.
    expect(mgr.getSession(CALL_ID)).toBeUndefined();
    expect(mockRepo.update).toHaveBeenCalledWith(CALL_ID, expect.objectContaining({ status: 'completed', outcome: 'agent_hangup' }));
  });

  it('after the answer, the call id from the stream`s start frame serves too', async () => {
    const mgr = await dial();
    const pstn = fakeWs();
    expect(mgr.attachPstnLeg(CALL_ID, pstn as any)).toBe(true);
    pstn.emit('message', JSON.stringify({
      event: 'start',
      start: { callId: 'uuid-from-stream', streamId: 's1', mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: 8000 } },
    }));
    expect(mgr.getSession(CALL_ID)!.answeredAt).not.toBeNull();
    await mgr.forceEndWithOutcome('att-1', 'agent_hangup');
    expect(plivoAdapter.endCall).toHaveBeenCalledWith('uuid-from-stream');
  });

  it('no call id and no request id: nothing is sent at all (an empty id would hang up every call on the account)', async () => {
    plivoAdapter.initiateCall.mockResolvedValueOnce({ providerCallId: '' });
    const mgr = await dial();
    await mgr.forceEndWithOutcome('att-1', 'agent_hangup');
    expect(plivoAdapter.endCall).not.toHaveBeenCalled();
    expect(plivoAdapter.cancelDialRequest).not.toHaveBeenCalled();
  });

  it('a teardown that ran while the dial was in flight cancels by the request id once the dial returns', async () => {
    let release!: (v: unknown) => void;
    plivoAdapter.initiateCall.mockReturnValueOnce(new Promise((r) => { release = r; }));
    const mgr = new WebRtcBridgeManager(makeGuardHost() as any, null);
    const placing = mgr.createBridgedCall({ ...PLIVO, browserSocket: fakeWs() as any });
    await vi.waitFor(() => expect(plivoAdapter.initiateCall).toHaveBeenCalled());
    await mgr.forceEndWithOutcome('att-1', 'agent_hangup');
    // Nothing to cancel yet: the dial has not said its request id.
    expect(plivoAdapter.cancelDialRequest).not.toHaveBeenCalled();
    release({ providerCallId: '', providerRequestId: 'req-race' });
    await placing;
    expect(plivoAdapter.cancelDialRequest).toHaveBeenCalledWith('req-race');
    expect(plivoAdapter.endCall).not.toHaveBeenCalled();
  });
});

/** The call's row once it has ended here: what a callback with no live session reads. */
function endedRow(over: Record<string, unknown> = {}) {
  return {
    id: CALL_ID, tenant_id: 'tenant-a', account_id: 'a1', provider: 'plivo', status: 'canceled',
    telephony_credential_id: 'cred-1', provider_call_id: null, provider_request_id: 'req-1', recording_url: null,
    ...over,
  };
}

/** Let background work (the stray-leg hangup runs off the callback's path) finish. */
const settle = () => new Promise((r) => setTimeout(r, 20));

describe('a leg the carrier is still connecting for a call that has ended here is hung up by the id its callback names', () => {
  it('the agent dismissed after the request left the queue (cancel 404, no call id): the late ring hangs it up, once', async () => {
    plivoAdapter.cancelDialRequest.mockResolvedValueOnce('not_found');
    const mgr = await dial();
    await mgr.forceEndWithOutcome('att-1', 'agent_hangup');
    expect(plivoAdapter.endCall).not.toHaveBeenCalled();
    mockRepo.findById.mockResolvedValue(endedRow());

    const ring = plivoEvent('status', { CallStatus: 'ringing', CallUUID: 'uuid-1', RequestUUID: 'req-1' });
    await mgr.handleCarrierStatus(CALL_ID, ring, 'plivo');
    await vi.waitFor(() => expect(plivoAdapter.endCall).toHaveBeenCalledWith('uuid-1'));
    expect(registry.getForCredentialId).toHaveBeenLastCalledWith('plivo', 'cred-1', 'call_control', 'tenant-a');
    // A retried ring, and then the answer, send nothing more.
    await mgr.handleCarrierStatus(CALL_ID, ring, 'plivo');
    expect(await mgr.answerCarrierCall(CALL_ID, plivoEvent('answer', { CallStatus: 'in-progress', CallUUID: 'uuid-1' }), 'plivo')).toBeNull();
    await settle();
    expect(plivoAdapter.endCall).toHaveBeenCalledTimes(1);
    // Nothing on the row is resurrected by the progress event.
    expect(mockRepo.update).not.toHaveBeenCalledWith(CALL_ID, expect.objectContaining({ status: 'ringing' }));
  });

  it('a ring that arrives while the cancel is still out: one hangup by the call id, not two', async () => {
    let answerCancel!: (v: 'not_found') => void;
    plivoAdapter.cancelDialRequest.mockImplementationOnce(() => new Promise((r) => { answerCancel = r; }));
    const mgr = await dial();
    const ending = mgr.forceEndWithOutcome('att-1', 'agent_hangup');
    await vi.waitFor(() => expect(plivoAdapter.cancelDialRequest).toHaveBeenCalled());
    // The session is tearing down: the ring is ignored for the call, but its leg is hung up.
    await mgr.handleCarrierStatus(CALL_ID, plivoEvent('status', { CallStatus: 'ringing', CallUUID: 'uuid-1', RequestUUID: 'req-1' }), 'plivo');
    await vi.waitFor(() => expect(plivoAdapter.endCall).toHaveBeenCalledWith('uuid-1'));
    answerCancel('not_found');
    await ending;
    await settle();
    expect(plivoAdapter.endCall).toHaveBeenCalledTimes(1);
  });

  it('never after the carrier reported the call`s terminal, and never with an empty id', async () => {
    plivoAdapter.cancelDialRequest.mockResolvedValueOnce('not_found');
    const mgr = await dial();
    await mgr.forceEndWithOutcome('att-1', 'agent_hangup');
    mockRepo.findById.mockResolvedValue(endedRow());
    // A ring with no CallUUID names nothing to hang up.
    await mgr.handleCarrierStatus(CALL_ID, plivoEvent('status', { CallStatus: 'ringing', RequestUUID: 'req-1' }), 'plivo');
    await settle();
    expect(plivoAdapter.endCall).not.toHaveBeenCalled();
    // The carrier's terminal, then a stale ring delivered after it: nothing is sent.
    await mgr.handleCarrierStatus(CALL_ID, plivoEvent('status', { CallStatus: 'no-answer', CallUUID: 'uuid-1', HangupCauseName: 'No Answer' }), 'plivo');
    await mgr.handleCarrierStatus(CALL_ID, plivoEvent('status', { CallStatus: 'ringing', CallUUID: 'uuid-1', RequestUUID: 'req-1' }), 'plivo');
    await settle();
    expect(plivoAdapter.endCall).not.toHaveBeenCalled();
  });

  it('a call whose credential cannot be resolved for call control: nothing is sent, said at ERROR', async () => {
    plivoAdapter.cancelDialRequest.mockResolvedValueOnce('not_found');
    const mgr = await dial();
    await mgr.forceEndWithOutcome('att-1', 'agent_hangup');
    mockRepo.findById.mockResolvedValue(endedRow());
    registry.getForCredentialId.mockRejectedValueOnce(new Error('credential unavailable'));
    await mgr.handleCarrierStatus(CALL_ID, plivoEvent('status', { CallStatus: 'ringing', CallUUID: 'uuid-1' }), 'plivo');
    await settle();
    expect(plivoAdapter.endCall).not.toHaveBeenCalled();
    expect(logSpy.error.mock.calls.some((c: any[]) => String(c[1]).includes('may reach the customer'))).toBe(true);
  });

  it('a carrier with no hangup API (VoiceLink, `close_media`): a late progress event sends nothing, as before', async () => {
    const mgr = new WebRtcBridgeManager(makeGuardHost() as any, null);
    mockRepo.findById.mockResolvedValue(endedRow({ provider: 'voicelink', telephony_credential_id: null }));
    for (const eventType of ['ringing', 'answer'] as const) {
      await mgr.handleCarrierStatus(CALL_ID, {
        providerCallId: 'vl-1', callId: CALL_ID, provider: 'voicelink', eventType, timestamp: new Date(), metadata: {},
      } as any, 'voicelink');
    }
    await settle();
    expect(registry.get).not.toHaveBeenCalled();
    expect(registry.getForCredentialId).not.toHaveBeenCalled();
    expect(plivoAdapter.endCall).not.toHaveBeenCalled();
  });
});

describe('a cancel that fails is not the end of the teardown', () => {
  it.each([
    ['a 5xx', new Error('Plivo cancel request error 503: upstream')],
    ['a network error', Object.assign(new TypeError('fetch failed'), { cause: new Error('ECONNRESET') })],
    ['a timeout', Object.assign(new Error('Plivo cancel request timed out'), { name: 'CarrierRequestTimeoutError' })],
  ])('%s with the call already named: hangs up by the call id', async (_n, failure) => {
    plivoAdapter.cancelDialRequest.mockRejectedValueOnce(failure);
    const mgr = await dial();
    await mgr.handleCarrierStatus(CALL_ID, plivoEvent('status', { CallStatus: 'ringing', CallUUID: 'uuid-1', RequestUUID: 'req-1' }), 'plivo');
    await mgr.forceEndWithOutcome('att-1', 'agent_hangup');
    expect(plivoAdapter.cancelDialRequest).toHaveBeenCalledWith('req-1');
    expect(plivoAdapter.endCall).toHaveBeenCalledWith('uuid-1');
    expect(plivoAdapter.endCall).toHaveBeenCalledTimes(1);
    expect(mgr.getSession(CALL_ID)).toBeUndefined();
  });

  it('a failed cancel with no call id yet: the late ring hangs it up', async () => {
    plivoAdapter.cancelDialRequest.mockRejectedValueOnce(new Error('Plivo cancel request error 500: boom'));
    const mgr = await dial();
    await mgr.forceEndWithOutcome('att-1', 'agent_hangup');
    expect(plivoAdapter.endCall).not.toHaveBeenCalled();
    mockRepo.findById.mockResolvedValue(endedRow());
    await mgr.handleCarrierStatus(CALL_ID, plivoEvent('status', { CallStatus: 'ringing', CallUUID: 'uuid-1' }), 'plivo');
    await vi.waitFor(() => expect(plivoAdapter.endCall).toHaveBeenCalledWith('uuid-1'));
  });
});

describe('Plivo callbacks drive the call', () => {
  it('ringing, then the answer: status written, the answer anchored once, the carrier id learnt', async () => {
    const mgr = await dial();
    await mgr.handleCarrierStatus(CALL_ID, plivoEvent('status', { CallStatus: 'ringing', RequestUUID: 'req-1' }), 'plivo');
    expect(mockRepo.update).toHaveBeenCalledWith(CALL_ID, { status: 'ringing' });
    const plan = await mgr.answerCarrierCall(CALL_ID, plivoEvent('answer', { CallStatus: 'in-progress', CallUUID: 'uuid-1' }), 'plivo');
    expect(mockRepo.update).toHaveBeenCalledWith(CALL_ID, { provider_call_id: 'uuid-1' });
    expect(mockRepo.update).toHaveBeenCalledWith(CALL_ID, expect.objectContaining({ status: 'in_progress' }));
    expect(lifecycle.filter((e) => e.phase === 'answered')).toHaveLength(1);
    const session = mgr.getSession(CALL_ID)!;
    expect(plan).toEqual({
      streamUrl: session.answerStreamUrl,
      enableRecording: true,
      recordingCallbackUrl: session.recordingCallbackUrl,
      maxDurationSeconds: 600,
    });
  });

  it('an answer for a call that is not this carrier`s, or unknown, gets no plan', async () => {
    const mgr = await dial();
    expect(await mgr.answerCarrierCall(CALL_ID, plivoEvent('answer', { CallStatus: 'in-progress', CallUUID: 'u' }), 'voicelink')).toBeNull();
    expect(await mgr.answerCarrierCall('7b1f7d4e-0c1a-4a55-9a3e-2f1d6c0b9e12', plivoEvent('answer', { CallStatus: 'in-progress' }), 'plivo')).toBeNull();
    expect(mgr.getSession(CALL_ID)!.answeredAt).toBeNull();
  });

  it.each([
    [{ CallStatus: 'no-answer', HangupCauseName: 'No Answer' }, 'no_answer', 'no_answer'],
    [{ CallStatus: 'timeout' }, 'no_answer', 'no_answer'],
    [{ CallStatus: 'busy', HangupCauseName: 'Busy Line' }, 'busy', 'busy'],
    [{ CallStatus: 'cancel', HangupCauseName: 'Canceled' }, 'canceled', 'canceled'],
    [{ CallStatus: 'failed', HangupCauseName: 'Network Error' }, 'failed', 'failed|network error'],
  ])('an unanswered terminal %j settles %s', async (params, status, outcome) => {
    const mgr = await dial();
    await mgr.handleCarrierStatus(CALL_ID, plivoEvent('status', { ...params, CallUUID: 'uuid-1' }), 'plivo');
    expect(mgr.getSession(CALL_ID)).toBeUndefined();
    const ended = lifecycle.filter((e) => e.phase === 'ended');
    expect(ended).toHaveLength(1);
    expect(ended[0]).toMatchObject({ status, answered: false });
    expect(ended[0].outcome).toContain(outcome);
    // The carrier's own terminal needs no hangup from us.
    expect(plivoAdapter.endCall).not.toHaveBeenCalled();
    expect(plivoAdapter.cancelDialRequest).not.toHaveBeenCalled();
  });

  it('a completed terminal after the answer settles completed / remote_hangup', async () => {
    const mgr = await dial();
    await mgr.answerCarrierCall(CALL_ID, plivoEvent('answer', { CallStatus: 'in-progress', CallUUID: 'uuid-1' }), 'plivo');
    await mgr.handleCarrierStatus(CALL_ID, plivoEvent('status', { CallStatus: 'completed', CallUUID: 'uuid-1', Duration: '42', HangupCauseName: 'Normal Hangup' }), 'plivo');
    const ended = lifecycle.filter((e) => e.phase === 'ended');
    expect(ended[0]).toMatchObject({ status: 'completed', outcome: 'remote_hangup', answered: true });
  });

  it('a status event from another carrier`s route is ignored', async () => {
    const mgr = await dial();
    await mgr.handleCarrierStatus(CALL_ID, plivoEvent('status', { CallStatus: 'busy' }), 'voicelink');
    expect(mgr.getSession(CALL_ID)).toBeDefined();
    expect(lifecycle.filter((e) => e.phase === 'ended')).toHaveLength(0);
  });
});

describe('Plivo recordings', () => {
  it('a recording callback after the call ended persists recording_url and fires recording-ready', async () => {
    mockRepo.findById.mockResolvedValueOnce({ id: CALL_ID, provider: 'plivo', recording_url: null, provider_call_id: 'uuid-1' });
    const mgr = new WebRtcBridgeManager(makeGuardHost() as any, null);
    await mgr.handleCarrierRecording(CALL_ID, 'plivo', { recordingUrl: 'https://media.plivo.com/v1/Account/MA1/Recording/r1.mp3', carrierCallId: 'uuid-1' });
    expect(mockRepo.update).toHaveBeenCalledWith(CALL_ID, { recording_url: 'https://media.plivo.com/v1/Account/MA1/Recording/r1.mp3' });
    expect(hooks.onRecordingReady).toHaveBeenCalledWith(CALL_ID);
  });

  it('a recording already on the row is kept, and a row of another carrier is left alone', async () => {
    const mgr = new WebRtcBridgeManager(makeGuardHost() as any, null);
    mockRepo.findById.mockResolvedValueOnce({ id: CALL_ID, provider: 'plivo', recording_url: 'https://media.plivo.com/x.mp3', provider_call_id: 'uuid-1' });
    await mgr.handleCarrierRecording(CALL_ID, 'plivo', { recordingUrl: 'https://media.plivo.com/y.mp3', carrierCallId: 'uuid-1' });
    mockRepo.findById.mockResolvedValueOnce({ id: CALL_ID, provider: 'voicelink', recording_url: null, provider_call_id: null });
    await mgr.handleCarrierRecording(CALL_ID, 'plivo', { recordingUrl: 'https://media.plivo.com/y.mp3' });
    expect(mockRepo.update).not.toHaveBeenCalled();
    expect(hooks.onRecordingReady).not.toHaveBeenCalled();
  });

  it('a recording callback on a live call is kept for the terminal write', async () => {
    const mgr = await dial();
    await mgr.answerCarrierCall(CALL_ID, plivoEvent('answer', { CallStatus: 'in-progress', CallUUID: 'uuid-1' }), 'plivo');
    await mgr.handleCarrierRecording(CALL_ID, 'plivo', { recordingUrl: 'https://media.plivo.com/r.mp3' });
    expect(mockRepo.findById).not.toHaveBeenCalled();
    await mgr.handleCarrierStatus(CALL_ID, plivoEvent('status', { CallStatus: 'completed', CallUUID: 'uuid-1', Duration: '9' }), 'plivo');
    expect(mockRepo.update).toHaveBeenCalledWith(CALL_ID, expect.objectContaining({ status: 'completed', recording_url: 'https://media.plivo.com/r.mp3' }));
  });
});

describe('carrierCallbackAdapter — what a Plivo callback is checked against', () => {
  it('a live call: its own credential, for call_control', async () => {
    const mgr = await dial();
    registry.getForCredentialId.mockClear();
    expect(await mgr.carrierCallbackAdapter(CALL_ID, 'plivo')).toBe(plivoAdapter);
    expect(registry.getForCredentialId).toHaveBeenCalledWith('plivo', 'cred-1', 'call_control', 'tenant-a');
  });

  it('a call that ended: read off its row', async () => {
    mockRepo.findById.mockResolvedValueOnce({ id: CALL_ID, provider: 'plivo', tenant_id: 'tenant-b', telephony_credential_id: 'cred-9' });
    const mgr = new WebRtcBridgeManager(makeGuardHost() as any, null);
    expect(await mgr.carrierCallbackAdapter(CALL_ID, 'plivo')).toBe(plivoAdapter);
    expect(registry.getForCredentialId).toHaveBeenCalledWith('plivo', 'cred-9', 'call_control', 'tenant-b');
  });

  it('unknown, another carrier`s, or a credential that does not resolve: null', async () => {
    const mgr = new WebRtcBridgeManager(makeGuardHost() as any, null);
    expect(await mgr.carrierCallbackAdapter(CALL_ID, 'plivo')).toBeNull();
    mockRepo.findById.mockResolvedValueOnce({ id: CALL_ID, provider: 'voicelink', tenant_id: 't', telephony_credential_id: null });
    expect(await mgr.carrierCallbackAdapter(CALL_ID, 'plivo')).toBeNull();
    mockRepo.findById.mockResolvedValueOnce({ id: CALL_ID, provider: 'plivo', tenant_id: 't', telephony_credential_id: 'cred-1' });
    registry.getForCredentialId.mockRejectedValueOnce(new Error('revoked'));
    expect(await mgr.carrierCallbackAdapter(CALL_ID, 'plivo')).toBeNull();
  });
});
