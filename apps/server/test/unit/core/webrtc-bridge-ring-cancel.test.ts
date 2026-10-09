import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The default provider is VoiceLink, so `BRIDGED` dials VoiceLink (an unanswered VoiceLink
// teardown finalizes at once). The terminal analytics event `trackWebrtcCallCompleted`, which
// `endCall` emits exactly once, is what the "settles exactly once" cases count; its payload
// fields are `callId`/`status`/`outcome`/`talkTimeSeconds`.

// ---------------------------------------------------------------------------
// The ring-cancel fix, and the confirm-timeout split.
//
// Pilot, 2026-09-08: all 26 `local hangup` lines in the window carried
// `intent: "agent_hangup"` from the agent console, and on VoiceLink not one of
// them stopped the dial. `localHangup` tore a VoiceLink leg down by closing
// `session.pstnWs` — which does not exist until the carrier answers — and
// VoiceLink's `endCall` is a documented no-op, so the call entered `ending` and
// STAYED IN `this.sessions` for 20s. When the customer picked up inside that
// window the PSTN leg's connect found a live session, `attachPstnLeg` bridged
// it, and the relay opened into a dismissed console. Traced end to end on
// callId 064836f1-8915-49f8-9c5a-c741f3cdd2af: dial 10:36:04.155, agent hangup
// 09.541, PSTN connect + answer 12.44, relay open 12.454, ended 27.968
// `completed` / `talkTime: 16`, 769/668 frames relayed.
//
// So these tests are about a session's PRESENCE IN THE MAP, not about the
// status string: finalizing immediately is what makes the later connect hit the
// unknown-call branch. The answered path must keep deferring, because there the
// carrier's own view of a billable leg is worth waiting for.
//
// Mock harness mirrors webrtc-bridge-manager.bridged.test.ts (project
// convention: no shared test utilities). The one deliberate difference is that
// `createChildLogger` returns ONE shared spy, because the pre-answer WARN is
// itself part of the contract — it is the line an operator greps in Loki.
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

// `capabilities` is mutated per test — it is the input this whole file is about.
const { mockAdapter } = vi.hoisted(() => ({
  mockAdapter: {
    capabilities: { cancelRinging: false } as { cancelRinging: boolean } | undefined,
    initiateCall: vi.fn(),
    endCall: vi.fn().mockResolvedValue(undefined),
    generateAnswerResponse: vi.fn().mockReturnValue('<Response><Stream/></Response>'),
  },
}));
vi.mock('../../../src/telephony/factory.js', () => ({
  TelephonyProviderRegistry: class {
    get() { return mockAdapter; }
  },
}));

vi.mock('../../../src/audit/audit-logger.js', () => ({ auditLogger: { log: vi.fn() } }));
// Hoisted so the terminal analytics event can be counted: it fires exactly once per `endCall`.
const { mockAnalytics } = vi.hoisted(() => ({
  mockAnalytics: {
    trackWebrtcCallInitiated: vi.fn(),
    trackWebrtcCallRejected: vi.fn(),
    trackWebrtcCallCompleted: vi.fn(),
  },
}));
vi.mock('../../../src/analytics/posthog.js', () => mockAnalytics);

import { WebRtcBridgeManager } from '../../../src/core/webrtc-bridge-manager.js';

/** A station socket with real add/remove bookkeeping (the borrowed contract needs `off`). */
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

const BRIDGED = {
  tenantId: 't1',
  accountId: 'a1',
  callerId: '+14155550100',
  destinationPhone: '+14155550199',
  campaignId: 'camp-1',
  agencyAttemptId: 'att-1',
};
const VL_BRIDGED = { ...BRIDGED, provider: 'voicelink' as const };

/** The A-law 8kHz `start` frame that negotiates a VoiceLink stream and anchors answer. */
function negotiateVoicelink(pstn: ReturnType<typeof fakeStationWs>): void {
  pstn.emit('message', JSON.stringify({
    event: 'start',
    start: { call_sid: 'carrier-1', stream_sid: 's1', media_format: { encoding: 'audio/alaw', sample_rate: '8000' } },
  }));
}

/** Terminal-row writes only (the ones carrying a status). */
function terminalUpdates(): any[] {
  return mockRepo.update.mock.calls.map((c: any[]) => c[1]).filter((u: any) => u?.status);
}

function ringCancelWarnings(): string[] {
  return logSpy.warn.mock.calls
    .map((c: any[]) => (typeof c[1] === 'string' ? c[1] : ''))
    .filter((m: string) => m.includes('cannot cancel a ringing leg'));
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
    campaign_id: i.campaign_id ?? null,
    agency_attempt_id: i.agency_attempt_id ?? null,
  }));
  mockAdapter.initiateCall.mockResolvedValue({ providerCallId: 'pcid-1' });
  mockAdapter.capabilities = { cancelRinging: false };
  // `clearAllMocks` clears CALLS, not implementations, and two tests below install
  // a payload-conditional `update` that holds the terminal write open. Reset it
  // here so that hold cannot leak into an unrelated test as a hang.
  mockRepo.update.mockReset();
  mockRepo.update.mockResolvedValue(null);
});

describe('localHangup before answer (VoiceLink) — the 064836f1-8915-49f8-9c5a-c741f3cdd2af path', () => {
  it('finalizes immediately as canceled, never entering `ending`, and leaves no live session', async () => {
    vi.useFakeTimers();
    try {
      const mgr = new WebRtcBridgeManager(makeCallManager() as any, null);
      const station = fakeStationWs();
      await mgr.createBridgedCall({ ...VL_BRIDGED, browserSocket: station as any });

      // The agent dismisses the ringing dial (pilot: +5.4s after dial).
      expect(await mgr.forceEndWithOutcome('att-1', 'agent_hangup')).toBe(true);

      // Settled on the spot — no timer was advanced to get here, which is the
      // difference from the answered path below.
      expect(mgr.getSession('call-1')).toBeUndefined();
      expect(mockAnalytics.trackWebrtcCallCompleted).toHaveBeenCalledTimes(1);
      expect(mockAnalytics.trackWebrtcCallCompleted.mock.calls[0]![0]).toMatchObject({
        callId: 'call-1', status: 'canceled', outcome: 'agent_hangup', talkTimeSeconds: 0,
      });
      const terminal = terminalUpdates().at(-1)!;
      expect(terminal.status).toBe('canceled');
      expect(terminal.outcome).toBe('agent_hangup');

      // Never entered the limbo: the browser is told the call ENDED, not that it
      // is `ending` (that frame is only sent on the deferred path).
      expect(station.sent.some((f) => f.event === 'status' && f.status === 'ending')).toBe(false);
      expect(station.sent.some((f) => f.event === 'ended')).toBe(true);

      // …and nothing fires later either.
      await vi.advanceTimersByTimeAsync(60_000);
      expect(mockAnalytics.trackWebrtcCallCompleted).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses the carrier`s late pstn-stream connect, so the relay never opens', async () => {
    // THIS is the fix. The customer answers after the agent has gone; VoiceLink
    // dials our pstn-stream URL. Because the session left the map at the hangup,
    // the connect hits attachPstnLeg's unknown-call branch instead of bridging
    // into a dismissed console.
    const mgr = new WebRtcBridgeManager(makeCallManager() as any, null);
    const station = fakeStationWs();
    await mgr.createBridgedCall({ ...VL_BRIDGED, browserSocket: station as any });
    await mgr.forceEndWithOutcome('att-1', 'agent_hangup');
    station.sent.length = 0;

    const pstn = fakeStationWs();
    expect(mgr.attachPstnLeg('call-1', pstn as any)).toBe(false);
    expect(pstn.readyState).toBe(3); // closed on us, not left half-open

    // And no audio can reach the agent's socket even if the carrier sends some:
    // the refused connect registered no relay handlers at all.
    negotiateVoicelink(pstn);
    pstn.emit('message', JSON.stringify({ event: 'media', media: { payload: 'AAAA' } }));
    expect(station.sent.filter((f) => f.event === 'media')).toHaveLength(0);
    // The station socket is the agent's shift socket — still open, still theirs.
    expect(station.readyState).toBe(1);
  });

  it('refuses it INSIDE the settle window too, while the session is still in the map', async () => {
    // The sibling test above passes for a reason that does not hold in
    // production: it lets the whole of `endCall` run, so the connect arrives
    // after `this.sessions.delete` and hits the unknown-call branch. But
    // `endCall` claims the call terminal (`endHandled = true`) ~100 lines BEFORE
    // that delete, and awaits a provider hangup and a repository write in
    // between. Under ordinary loaded-Postgres latency the session is still
    // `sessions.get`-able for the whole window, so a guard that tests only
    // `!session` accepts the leg — and every consequence the fix exists to
    // prevent comes back:
    //
    //   answered → phantom entry in the compliance DENOMINATOR
    //   bridged  → connect cue to a console with no panel, agent set `on_call`
    //   ended    → `bridged: true` ⇒ `connected` ⇒ `max_attempts: 0` ⇒ a contact
    //              retired permanently without anyone having spoken to them
    //
    // Held open on `update` rather than on the carrier hangup because the DB
    // write is the hop that actually varies in production.
    const mgr = new WebRtcBridgeManager(makeCallManager() as any, null);
    const station = fakeStationWs();
    await mgr.createBridgedCall({ ...VL_BRIDGED, browserSocket: station as any });

    let releaseUpdate: () => void = () => {};
    const held = new Promise<void>((resolve) => { releaseUpdate = () => resolve(); });
    mockRepo.update.mockImplementationOnce(async () => { await held; return null; });

    const ending = mgr.forceEndWithOutcome('att-1', 'agent_hangup');
    await Promise.resolve(); // let endCall reach the held write

    // Mid-window: terminal claimed, but the session has NOT left the map.
    expect(mgr.getSession('call-1')).toBeDefined();
    station.sent.length = 0;

    const pstn = fakeStationWs();
    expect(mgr.attachPstnLeg('call-1', pstn as any)).toBe(false);
    expect(pstn.readyState).toBe(3);

    // No relay handlers were registered, so the customer's audio reaches nobody…
    negotiateVoicelink(pstn);
    pstn.emit('message', JSON.stringify({ event: 'media', media: { payload: 'AAAA' } }));
    expect(station.sent.filter((f) => f.event === 'media')).toHaveLength(0);
    // …and, the part that protects the contact roster: no second answer, no
    // second bridge. A `bridged` here is what classifies the attempt `connected`.
    expect(station.sent.some((f) => f.event === 'status' && f.status === 'in_progress')).toBe(false);

    releaseUpdate();
    await ending;

    // Still exactly one settlement, still `canceled`, still zero talk time.
    expect(mockAnalytics.trackWebrtcCallCompleted).toHaveBeenCalledTimes(1);
    expect(mockAnalytics.trackWebrtcCallCompleted.mock.calls[0]![0]).toMatchObject({
      callId: 'call-1', status: 'canceled', talkTimeSeconds: 0,
    });
    expect(mgr.getSession('call-1')).toBeUndefined();
  });

  it('settles exactly once even when the carrier`s own call.ended lands afterwards', async () => {
    // The late terminal webhook for a call we already finalized must go to
    // persistLateVoicelinkTerminal, not settle a second time.
    const mgr = new WebRtcBridgeManager(makeCallManager() as any, null);
    await mgr.createBridgedCall({ ...VL_BRIDGED, browserSocket: fakeStationWs() as any });
    await mgr.forceEndWithOutcome('att-1', 'agent_hangup');
    mockRepo.findById.mockResolvedValueOnce({ id: 'call-1', recording_url: null, provider_call_id: 'pcid-1' });

    await mgr.handleVoicelinkStatus('call-1', {
      providerCallId: 'carrier-1', callId: 'call-1', eventType: 'hangup', timestamp: new Date(),
      metadata: { event: 'call.ended', call: { id: 'carrier-1', status: 'ended' } },
    });

    expect(mockAnalytics.trackWebrtcCallCompleted).toHaveBeenCalledTimes(1);
    expect(terminalUpdates().filter((u) => u.status === 'canceled')).toHaveLength(1);
  });
});

describe('the accept-side guards on a call already tearing down', () => {
  // `attachPstnLeg` refuses a NEW connect, but a leg attached before the terminal
  // claim is already holding message handlers. So the same defect is reachable one
  // layer in, through the media `start` frame — which anchors the answer, marks
  // media ready and calls `emitBridgedIfLive`. That is the full sequence:
  // a phantom `answered` in the compliance DENOMINATOR, then a `bridged` that
  // classifies the attempt `connected` — `max_attempts: 0`, retiring a contact
  // nobody spoke to.
  it('ignores a media `start` that arrives inside the settle window', async () => {
    const mgr = new WebRtcBridgeManager(makeCallManager() as any, null);
    const station = fakeStationWs();
    await mgr.createBridgedCall({ ...VL_BRIDGED, browserSocket: station as any });

    // The leg is attached and healthy BEFORE anything tears down.
    const pstn = fakeStationWs();
    expect(mgr.attachPstnLeg('call-1', pstn as any)).toBe(true);

    let releaseUpdate: () => void = () => {};
    const held = new Promise<void>((resolve) => { releaseUpdate = () => resolve(); });
    mockRepo.update.mockImplementationOnce(async () => { await held; return null; });

    const ending = mgr.forceEndWithOutcome('att-1', 'agent_hangup');
    await Promise.resolve();
    station.sent.length = 0;

    // The carrier negotiates the stream mid-teardown.
    negotiateVoicelink(pstn);

    // No answer anchored, no bridge announced, no audio path.
    expect(station.sent.some((f) => f.event === 'status' && f.status === 'in_progress')).toBe(false);
    pstn.emit('message', JSON.stringify({ event: 'media', media: { payload: 'AAAA' } }));
    expect(station.sent.filter((f) => f.event === 'media')).toHaveLength(0);

    releaseUpdate();
    await ending;

    // Still `canceled` with zero talk time — never `completed`.
    expect(terminalUpdates().at(-1)!.status).toBe('canceled');
    expect(mockAnalytics.trackWebrtcCallCompleted).toHaveBeenCalledTimes(1);
    expect(mockAnalytics.trackWebrtcCallCompleted.mock.calls[0]![0]).toMatchObject({ talkTimeSeconds: 0 });
  });

  it('ignores a VoiceLink `answer` webhook in the same window — the pilot carrier', async () => {
    // VoiceLink has no answer XML, so `handleVoicelinkStatus` `case 'answer'` IS
    // its answer path — which makes this the version of the defect that reaches
    // the carrier late binding ships to first. Unguarded it anchored the answer,
    // wrote `in_progress` over a terminal row, and emitted `answered` into the
    // dialer: a phantom compliance denominator entry, and an `ended` that then
    // read `answered: true` so the classifier recorded `abandoned` against the 3%
    // ceiling for a dial nobody reached.
    const mgr = new WebRtcBridgeManager(makeCallManager() as any, null);
    const station = fakeStationWs();
    await mgr.createBridgedCall({ ...VL_BRIDGED, browserSocket: station as any });

    let releaseUpdate: () => void = () => {};
    const held = new Promise<void>((resolve) => { releaseUpdate = () => resolve(); });
    // Held on the TERMINAL write specifically, not on the next write. This method
    // persists `provider_call_id` before the switch, so a `mockImplementationOnce`
    // here would be consumed by that instead and deadlock the test rather than
    // staging the window.
    mockRepo.update.mockImplementation(async (_id: string, u: any) => {
      if (u?.status === 'canceled') await held;
      return null;
    });

    const ending = mgr.forceEndWithOutcome('att-1', 'agent_hangup');
    await Promise.resolve();
    station.sent.length = 0;
    const updatesBefore = mockRepo.update.mock.calls.length;

    // The customer picks up while we are still settling.
    await mgr.handleVoicelinkStatus('call-1', {
      providerCallId: 'carrier-1', callId: 'call-1', eventType: 'answer', timestamp: new Date(),
      metadata: { event: 'call.answered', call: { id: 'carrier-1', status: 'answered' } },
    } as any);

    // No answer anchored, so nothing can reach the compliance denominator…
    expect(station.sent.some((f) => f.event === 'status' && f.status === 'answered')).toBe(false);
    // …and no `in_progress` written over the terminal row.
    const newUpdates = mockRepo.update.mock.calls.slice(updatesBefore).map((c: any[]) => c[1]);
    expect(newUpdates.some((u: any) => u?.status === 'in_progress')).toBe(false);

    releaseUpdate();
    await ending;

    // Terminal row stays `canceled` with zero talk time.
    expect(terminalUpdates().at(-1)!.status).toBe('canceled');
    expect(mockAnalytics.trackWebrtcCallCompleted).toHaveBeenCalledTimes(1);
    expect(mockAnalytics.trackWebrtcCallCompleted.mock.calls[0]![0]).toMatchObject({ talkTimeSeconds: 0 });
  });

  it('still accepts the terminal webhook during `ending` — the confirmation must land', async () => {
    // The guard above must not be widened to the whole method: on the deferred
    // (answered) VoiceLink path, `hangup` during `ending` IS the carrier
    // confirmation `finalizeEnding` waits for. Refusing it would strand the
    // teardown for its full 45s.
    const mgr = new WebRtcBridgeManager(makeCallManager() as any, null);
    await mgr.createBridgedCall({ ...VL_BRIDGED, browserSocket: fakeStationWs() as any });
    const pstn = fakeStationWs();
    mgr.attachPstnLeg('call-1', pstn as any);
    negotiateVoicelink(pstn); // answers, so the hangup below defers

    await mgr.forceEndWithOutcome('att-1', 'agent_hangup');
    expect(mgr.getSession('call-1')?.ending).toBe(true);

    await mgr.handleVoicelinkStatus('call-1', {
      providerCallId: 'carrier-1', callId: 'call-1', eventType: 'hangup', timestamp: new Date(),
      metadata: { event: 'call.ended', call: { id: 'carrier-1', status: 'ended' } },
    } as any);

    // Confirmed and settled, not stranded.
    expect(mgr.getSession('call-1')).toBeUndefined();
    expect(mockAnalytics.trackWebrtcCallCompleted).toHaveBeenCalledTimes(1);
  });
});

describe('localHangup after answer (VoiceLink) — still deferred, now bounded at 45s', () => {
  it('holds the session in `ending` until the carrier confirms, and settles once when it does', async () => {
    const mgr = new WebRtcBridgeManager(makeCallManager() as any, null);
    const station = fakeStationWs();
    const pstn = fakeStationWs();
    await mgr.createBridgedCall({ ...VL_BRIDGED, browserSocket: station as any });
    mgr.attachPstnLeg('call-1', pstn as any);
    negotiateVoicelink(pstn); // anchors the answer — the leg is now billable
    expect(mgr.getSession('call-1')!.answeredAt).not.toBeNull();

    await mgr.forceEndWithOutcome('att-1', 'agent_hangup');

    const session = mgr.getSession('call-1');
    expect(session).toBeDefined();
    expect(session!.ending).toBe(true);
    expect(session!.endHandled).toBe(false);
    expect(mockAnalytics.trackWebrtcCallCompleted).not.toHaveBeenCalled();
    expect(station.sent.some((f) => f.event === 'status' && f.status === 'ending')).toBe(true);

    await mgr.handleVoicelinkStatus('call-1', {
      providerCallId: 'carrier-1', callId: 'call-1', eventType: 'hangup', timestamp: new Date(),
      metadata: { event: 'call.ended', call: { id: 'carrier-1', status: 'ended' } },
    });
    expect(mgr.getSession('call-1')).toBeUndefined();
    expect(mockAnalytics.trackWebrtcCallCompleted).toHaveBeenCalledTimes(1);
  });

  it('waits the full 45s before giving up on the confirmation (and not 20s)', async () => {
    // 45s brackets VoiceLink's measured dial+45–75s reporting. The old 20s bound
    // retired essentially every answered teardown on our own clock and threw the
    // carrier's disposition away, so the exact number is the point.
    vi.useFakeTimers();
    try {
      const mgr = new WebRtcBridgeManager(makeCallManager() as any, null);
      const pstn = fakeStationWs();
      await mgr.createBridgedCall({ ...VL_BRIDGED, browserSocket: fakeStationWs() as any });
      mgr.attachPstnLeg('call-1', pstn as any);
      negotiateVoicelink(pstn);
      await mgr.forceEndWithOutcome('att-1', 'agent_hangup');

      await vi.advanceTimersByTimeAsync(44_000);
      expect(mgr.getSession('call-1')!.ending).toBe(true);
      expect(mockAnalytics.trackWebrtcCallCompleted).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1_000);
      expect(mgr.getSession('call-1')).toBeUndefined();
      expect(mockAnalytics.trackWebrtcCallCompleted).toHaveBeenCalledTimes(1);
      expect(terminalUpdates().at(-1)!.status).toBe('completed'); // answered ⇒ billable
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('the pre-answer capability warning', () => {
  it('warns, naming the consequence, when the carrier cannot cancel a ringing leg', async () => {
    mockAdapter.capabilities = { cancelRinging: false }; // voicelink's real answer
    const mgr = new WebRtcBridgeManager(makeCallManager() as any, null);
    await mgr.createBridgedCall({ ...VL_BRIDGED, browserSocket: fakeStationWs() as any });

    await mgr.forceEndWithOutcome('att-1', 'agent_hangup');

    expect(ringCancelWarnings()).toHaveLength(1);
    const [fields] = logSpy.warn.mock.calls.find(
      (c: any[]) => typeof c[1] === 'string' && c[1].includes('cannot cancel a ringing leg'),
    )!;
    expect(fields).toMatchObject({ callId: 'call-1', correlationId: 'att-1', provider: 'voicelink' });
  });

  it('also warns for an adapter that has declared nothing at all (fail-closed)', async () => {
    mockAdapter.capabilities = undefined;
    const mgr = new WebRtcBridgeManager(makeCallManager() as any, null);
    await mgr.createBridgedCall({ ...VL_BRIDGED, browserSocket: fakeStationWs() as any });
    await mgr.forceEndWithOutcome('att-1', 'agent_hangup');
    expect(ringCancelWarnings()).toHaveLength(1);
  });

  it('stays silent on a cancel-capable carrier, and hangs the leg up', async () => {
    mockAdapter.capabilities = { cancelRinging: true };
    const mgr = new WebRtcBridgeManager(makeCallManager() as any, null);
    await mgr.createBridgedCall({ ...BRIDGED, browserSocket: fakeStationWs() as any });

    await mgr.forceEndWithOutcome('att-1', 'agent_hangup');

    expect(ringCancelWarnings()).toHaveLength(0);
    expect(mockAdapter.endCall).toHaveBeenCalledWith('pcid-1');
    expect(terminalUpdates().at(-1)!.status).toBe('canceled');
  });

  it('does not warn on a teardown after the answer (there is nothing left ringing)', async () => {
    mockAdapter.capabilities = { cancelRinging: false };
    const mgr = new WebRtcBridgeManager(makeCallManager() as any, null);
    const pstn = fakeStationWs();
    await mgr.createBridgedCall({ ...VL_BRIDGED, browserSocket: fakeStationWs() as any });
    mgr.attachPstnLeg('call-1', pstn as any);
    negotiateVoicelink(pstn);

    await mgr.forceEndWithOutcome('att-1', 'agent_hangup');
    await mgr.handleVoicelinkStatus('call-1', {
      providerCallId: 'carrier-1', callId: 'call-1', eventType: 'hangup', timestamp: new Date(),
      metadata: { event: 'call.ended', call: { id: 'carrier-1', status: 'ended' } },
    });

    expect(ringCancelWarnings()).toHaveLength(0);
  });
});

describe('a teardown that races the dial', () => {
  it('hangs the carrier leg up once the dial finally yields an id', async () => {
    // `endCall`'s hangup is gated on `providerCallId`, which does not exist until
    // `initiateCall` resolves. A borrowed socket is attached BEFORE the dial, so
    // an agent who dismisses the call while it is still being placed lands
    // squarely in this window — and used to leave the leg dialling with nothing
    // able to hang it up.
    mockAdapter.capabilities = { cancelRinging: true };
    let resolveDial!: (v: { providerCallId: string }) => void;
    mockAdapter.initiateCall.mockReturnValue(new Promise((r) => { resolveDial = r; }));

    const mgr = new WebRtcBridgeManager(makeCallManager() as any, null);
    const station = fakeStationWs();
    const dial = mgr.createBridgedCall({ ...BRIDGED, browserSocket: station as any });

    // Wait until the socket is attached — i.e. we are inside the dial's await.
    await vi.waitFor(() => expect(station.count('close')).toBe(1));
    station.emit('close');
    await vi.waitFor(() => expect(mgr.getSession('call-1')).toBeUndefined());
    // Nothing could be hung up: the carrier had not named the call yet.
    expect(mockAdapter.endCall).not.toHaveBeenCalled();

    resolveDial({ providerCallId: 'pcid-late' });
    await dial;

    expect(mockAdapter.endCall).toHaveBeenCalledTimes(1);
    expect(mockAdapter.endCall).toHaveBeenCalledWith('pcid-late');
  });

  it('leaves an ordinary dial alone (no hangup when nothing tore the call down)', async () => {
    mockAdapter.capabilities = { cancelRinging: true };
    const mgr = new WebRtcBridgeManager(makeCallManager() as any, null);
    await mgr.createBridgedCall({ ...BRIDGED, browserSocket: fakeStationWs() as any });
    expect(mockAdapter.endCall).not.toHaveBeenCalled();
    expect(mgr.getSession('call-1')).toBeDefined();
  });
});

afterEach(() => {
  vi.useRealTimers();
});
