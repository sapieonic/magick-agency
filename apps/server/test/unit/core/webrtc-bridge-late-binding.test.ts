import { describe, it, expect, vi, beforeEach } from 'vitest';

// The default provider is VoiceLink, so `UNBOUND` and `VL_UNBOUND` dial the same carrier.
// Every case ends its call with `forceEndWithOutcome('att-1', 'ended_by_user')`, a
// `localHangup` under that outcome. VoiceLink specifics the cases account for:
//  - the carrier's provider + webhook tokens are still stored on a dial, so 'mints no browser
//    WS token' asserts no `browser`-purpose token, not "`redis.set` never called";
//  - carrier media is negotiated only after the `start` frame, so cases that need an answered
//    call with media send `start` after the PSTN connect (in 'refuses a socket that has already
//    closed' this is what keeps `not.toContain('bridged')` meaningful: without media `bridged`
//    cannot be emitted at all);
//  - the answer is anchored on the `start` frame, and the relay is VoiceLink's transcoded `media`
//    frames: a real 20ms tone goes each way and exactly one frame must come out, of the
//    transcoded length (A-law 120-160 B, PCM16 480-640 B) and not silent;
//  - an answered VoiceLink hangup defers to the carrier's `call.ended`, so it is driven before
//    the detach assertions.

// ---------------------------------------------------------------------------
// Late binding — the bridge half (`FF_AGENCY_LATE_BINDING`).
//
// The product ask: stop putting the agent on a call that is still ringing, or
// that reaches voicemail, or a switched-off handset. So the agent's station
// socket is attached at the ANSWER rather than before the dial, which gives the
// bridge a third creation mode: dial with no browser leg at all
// (`createUnboundBridgedCall`), then bind one (`bindBorrowedBrowserLeg`).
//
// Three properties carry the whole design and each is pinned below.
//
//  1. A call with no socket must be no more reachable than one with a bound
//     socket. It mints no browser token, so `verifyWsToken` would hit its
//     accept-on-missing-key fallback if anything ever asked it — the leg is
//     marked borrowed-unbound at dial time precisely so `attachBrowserLeg`'s
//     ownership check refuses first, during the ring window.
//  2. `bridged` is emitted by the BIND and by nothing else on this path. The
//     agency handler for it writes `bridged_at`, which is half of the SQL
//     abandonment predicate — so an emission at the answer (no agent yet) or on
//     a wifi-blip re-attach (bridged minutes ago) corrupts a compliance number.
//  3. The bind is synchronous. `ABANDONMENT_BRIDGE_GRACE_MS` is 1000ms from the
//     answer, so every await between the answer and the socket attach is spent
//     out of a budget that decides whether a connected call counts as abandoned.
//
// Mock harness mirrors webrtc-bridge-manager.bridged.test.ts (project
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
    capabilities: { cancelRinging: true },
    initiateCall: vi.fn().mockResolvedValue({ providerCallId: 'pcid-1' }),
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
vi.mock('../../../src/analytics/posthog.js', () => ({
  trackWebrtcCallInitiated: vi.fn(),
  trackWebrtcCallRejected: vi.fn(),
  trackWebrtcCallCompleted: vi.fn(),
}));

import { WebRtcBridgeManager, type WebRtcLifecycleEvent } from '../../../src/core/webrtc-bridge-manager.js';
import { encodeAlaw, decodeAlaw } from '../../../src/utils/audio.js';

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

/** Collects lifecycle phases in order, the way the agency dialer subscribes. */
function recordLifecycle(mgr: WebRtcBridgeManager): WebRtcLifecycleEvent[] {
  const seen: WebRtcLifecycleEvent[] = [];
  mgr.onLifecycle((ev) => seen.push(ev));
  return seen;
}

function phases(seen: WebRtcLifecycleEvent[]): string[] {
  return seen.map((e) => e.phase);
}

const UNBOUND = {
  tenantId: 't1',
  accountId: 'a1',
  callerId: '+14155550100',
  destinationPhone: '+14155550199',
  campaignId: 'camp-1',
  agencyAttemptId: 'att-1',
};
const VL_UNBOUND = { ...UNBOUND, provider: 'voicelink' as const };

/** ends the call by attempt id via `localHangup` with the `ended_by_user` outcome. */
const endByUser = (mgr: WebRtcBridgeManager, attemptId = 'att-1') =>
  mgr.forceEndWithOutcome(attemptId, 'ended_by_user');

/** 160 bytes of A-law silence — one 20ms VoiceLink frame, base64 as the wire has it. */
function alawFrame(): string {
  return Buffer.alloc(160, 0xd5).toString('base64');
}

/**
 * Real 20ms tone frames for the relay check. VoiceLink transcodes (PCM16 16k ⇄ A-law 8k), so only real
 * audio makes the output's length and level meaningful.
 */
function pcm16kToneFrame(): string {
  const pcm = new Int16Array(320); // 20ms @16k = 640 bytes
  for (let i = 0; i < pcm.length; i++) pcm[i] = Math.round(8000 * Math.sin((2 * Math.PI * 1000 * i) / 16000));
  return Buffer.from(pcm.buffer).toString('base64');
}
function alaw8kToneFrame(): string {
  const pcm = new Int16Array(160); // 20ms @8k = 160 A-law bytes
  for (let i = 0; i < pcm.length; i++) pcm[i] = Math.round(8000 * Math.sin((2 * Math.PI * 1000 * i) / 8000));
  return encodeAlaw(pcm).toString('base64');
}
function peak(samples: ArrayLike<number>): number {
  let p = 0;
  for (let i = 0; i < samples.length; i++) p = Math.max(p, Math.abs(samples[i]!));
  return p;
}

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
    campaign_id: i.campaign_id ?? null,
    agency_attempt_id: i.agency_attempt_id ?? null,
  }));
  mockAdapter.initiateCall.mockResolvedValue({ providerCallId: 'pcid-1' });
});

describe('WebRtcBridgeManager.createUnboundBridgedCall', () => {
  it('dials with no browser leg and marks it borrowed-unbound', async () => {
    const mgr = new WebRtcBridgeManager(makeCallManager() as any, null);

    const record = await mgr.createUnboundBridgedCall(UNBOUND);

    expect(record.id).toBe('call-1');
    const session = mgr.getSession('call-1')!;
    expect(session.browserWs).toBeNull();
    // Not owned FROM BIRTH — this is what makes attachBrowserLeg's refusal true
    // during the ring window, not only after a socket is bound.
    expect(session.browserWsOwned).toBe(false);
    // The dial itself is the shared path: same agency back-references, same carrier call.
    expect(mockRepo.create.mock.calls[0]![0].agency_attempt_id).toBe('att-1');
    expect(mockAdapter.initiateCall).toHaveBeenCalledTimes(1);

    await endByUser(mgr);
  });

  it('mints no browser WS token (there is no /browser-stream connect to gate)', async () => {
    const redis = { set: vi.fn().mockResolvedValue('OK'), get: vi.fn(), del: vi.fn().mockResolvedValue(1) };
    const mgr = new WebRtcBridgeManager(makeCallManager() as any, redis as any);

    await mgr.createUnboundBridgedCall(UNBOUND);

    // The token condition used to key on the presence of a socket, which would
    // hand this call a browser token and open the token-gated route onto the
    // agent's audio for the whole ring window.
    // a VoiceLink dial still stores the carrier's provider + webhook tokens
    // (key `webrtc:ws-token:<purpose>:<callId>`); what must never be stored is a browser one.
    const purposes = redis.set.mock.calls.map((c: any[]) => String(c[0]).split(':')[2]);
    expect(purposes).not.toContain('browser');
    expect([...purposes].sort()).toEqual(['provider', 'webhook']);

    await endByUser(mgr);
  });

  it('emits `answered` but NOT `bridged` when the carrier answers with no agent bound', async () => {
    const mgr = new WebRtcBridgeManager(makeCallManager() as any, null);
    const seen = recordLifecycle(mgr);
    await mgr.createUnboundBridgedCall(VL_UNBOUND);

    const pstn = fakeStationWs();
    mgr.attachPstnLeg('call-1', pstn as any);
    negotiateVoicelink(pstn); // media negotiated + answer anchored

    // Both emission sites ran with only one leg live, so neither fired. That is
    // the whole point: `bridged` must mean an agent is on the call.
    expect(phases(seen)).toEqual(['answered']);
    expect(mgr.getSession('call-1')!.answeredAt).not.toBeNull();

    await endByUser(mgr);
  });

  it('discards carrier audio until a socket is bound', async () => {
    const mgr = new WebRtcBridgeManager(makeCallManager() as any, null);
    await mgr.createUnboundBridgedCall(UNBOUND);
    const pstn = fakeStationWs();
    mgr.attachPstnLeg('call-1', pstn as any);
    // VoiceLink is media-ready only after `start`; negotiate so the missing
    // socket is the only reason the frame below is dropped.
    negotiateVoicelink(pstn);

    // The relay's own guard (`session.browserWs?.readyState !== 1`) already drops
    // this, so the only audio at risk is what the customer says inside the bind
    // window — which the bind being synchronous is what bounds.
    expect(() => pstn.emit('message', JSON.stringify({
      event: 'media', media: { payload: 'AAAA' },
    }))).not.toThrow();

    await endByUser(mgr);
  });
});

describe('WebRtcBridgeManager.bindBorrowedBrowserLeg', () => {
  it('binds at the answer, emits exactly one `bridged`, and opens the relay both ways', async () => {
    const mgr = new WebRtcBridgeManager(makeCallManager() as any, null);
    const seen = recordLifecycle(mgr);
    await mgr.createUnboundBridgedCall(UNBOUND);
    const pstn = fakeStationWs();
    mgr.attachPstnLeg('call-1', pstn as any);
    // VoiceLink anchors the answer on its `start` frame, not on the connect.
    negotiateVoicelink(pstn);
    expect(phases(seen)).toEqual(['answered']);

    const station = fakeStationWs();
    // Keyed on the correlation id, not the call id: the answer can precede the
    // dial's own resolution, so the caller may not know the call id yet.
    const bound = mgr.bindBorrowedBrowserLeg('att-1', station as any);

    // Synchronous: the boolean AND the event are both available with no await.
    expect(bound).toBe(true);
    expect(phases(seen)).toEqual(['answered', 'bridged']);
    expect(seen.at(-1)).toMatchObject({ callId: 'call-1', correlationId: 'att-1', answered: true });
    expect(station.sent.some((f) => f.event === 'status' && f.status === 'in_progress')).toBe(true);

    // A real bind, not just an event: audio flows.
    // VoiceLink transcodes both ways into plain `media` frames, so a real 20ms tone goes
    // each way and exactly one transcoded, non-silent frame must come out the other side
    // (bounds as webrtc-bridge-manager.test.ts: FIR warm-up shortens the first frame).
    const toPstn = pstn.sent.filter((f) => f.event === 'media').length;
    station.emit('message', JSON.stringify({ event: 'media', media: { payload: pcm16kToneFrame() } }));
    const b2p = pstn.sent.filter((f) => f.event === 'media');
    expect(b2p).toHaveLength(toPstn + 1);
    const alaw = Buffer.from(b2p.at(-1).media.payload, 'base64');
    expect(alaw.length).toBeGreaterThan(120);
    expect(alaw.length).toBeLessThanOrEqual(160);
    expect(peak(decodeAlaw(alaw))).toBeGreaterThan(6400);
    const toStation = station.sent.filter((f) => f.event === 'media').length;
    pstn.emit('message', JSON.stringify({ event: 'media', media: { payload: alaw8kToneFrame() } }));
    const p2s = station.sent.filter((f) => f.event === 'media');
    expect(p2s).toHaveLength(toStation + 1);
    const pcm = Buffer.from(p2s.at(-1).media.payload, 'base64');
    expect(pcm.length).toBeGreaterThan(480);
    expect(pcm.length).toBeLessThanOrEqual(640);
    expect(peak(new Int16Array(pcm.buffer, pcm.byteOffset, pcm.byteLength / 2))).toBeGreaterThan(6400);

    // And the borrowed contract still holds: detached, never closed.
    await endByUser(mgr);
    // an answered VoiceLink hangup waits for the carrier's `call.ended`
    // before it finalizes (and detaches).
    await mgr.handleVoicelinkStatus('call-1', {
      providerCallId: 'carrier-1', callId: 'call-1', eventType: 'hangup', timestamp: new Date(),
      metadata: { event: 'call.ended', call: { id: 'carrier-1', status: 'ended' } },
    });
    expect(station.readyState).toBe(1);
    expect(station.count('close')).toBe(0);
  });

  it('binds before the carrier media arrives, and `bridged` waits for it', async () => {
    // The other ordering: the caller binds on the `answer` webhook, and the
    // VoiceLink `start` frame that negotiates media lands after.
    const mgr = new WebRtcBridgeManager(makeCallManager() as any, null);
    const seen = recordLifecycle(mgr);
    await mgr.createUnboundBridgedCall(VL_UNBOUND);
    const pstn = fakeStationWs();
    mgr.attachPstnLeg('call-1', pstn as any); // open but not yet media-ready

    expect(mgr.bindBorrowedBrowserLeg('att-1', fakeStationWs() as any)).toBe(true);
    expect(phases(seen)).toEqual([]); // nothing negotiated, nothing answered

    negotiateVoicelink(pstn);
    expect(phases(seen)).toEqual(['answered', 'bridged']);

    await endByUser(mgr);
  });

  it('VoiceLink, PSTN leg attached BEFORE the start frame, bound from the `answered` listener: exactly one `bridged`', async () => {
    // The re-entrant double-emit, reproduced in its own ordering. This is how a
    // late-binding VoiceLink call actually runs, and the ordering IS the defect:
    //
    //   handleProviderStart → providerMediaReady = true
    //                       → anchorAnswer → `answered` → the listener binds
    //                                      → bindBorrowedBrowserLeg → `bridged`
    //                       → emitBridgedIfLive → `bridged` AGAIN
    //
    // Both legs are live and media is ready by the time control returns to that
    // last line, so nothing there could tell it had already happened. The second
    // event makes the dialer rewrite `bridged_at` with the later instant,
    // move the agent to `on_call` twice, and send the console two
    // connect cues.
    //
    // Binding before the `start` frame would pass either way (one leg is still down,
    // so the bind emits once purely by ordering); the bind here happens after it.
    const mgr = new WebRtcBridgeManager(makeCallManager() as any, null);
    const seen = recordLifecycle(mgr);
    const station = fakeStationWs();

    // The agency dialer's shape: bind synchronously, inside the `answered` arm.
    const binds: boolean[] = [];
    mgr.onLifecycle((ev) => {
      if (ev.phase === 'answered') binds.push(mgr.bindBorrowedBrowserLeg('att-1', station as any));
    });

    await mgr.createUnboundBridgedCall(VL_UNBOUND);
    const pstn = fakeStationWs();
    mgr.attachPstnLeg('call-1', pstn as any); // open, but not yet media-ready
    expect(phases(seen)).toEqual([]);

    negotiateVoicelink(pstn);

    expect(binds).toEqual([true]);
    expect(phases(seen)).toEqual(['answered', 'bridged']);
    expect(phases(seen).filter((p) => p === 'bridged')).toHaveLength(1);
    // Ordering still holds: the bind's own emission is the one that lands, so
    // `bridged` follows `answered` inside the same turn rather than after it.
    expect(seen[1]).toMatchObject({ callId: 'call-1', correlationId: 'att-1', answered: true });
    // And the call really is bridged — audio flows to the socket bound re-entrantly.
    pstn.emit('message', JSON.stringify({ event: 'media', media: { payload: alawFrame() } }));
    expect(station.sent.filter((f) => f.event === 'media')).toHaveLength(1);

    await endByUser(mgr);
  });

  it('a PSTN leg that re-connects mid-call re-notifies the browser but emits no second `bridged`', async () => {
    // The two halves of `emitBridgedIfLive` diverge here: the browser genuinely
    // wants to know media is live again, and a `bridged` subscriber must not be
    // told a second bridge happened at a later instant.
    const mgr = new WebRtcBridgeManager(makeCallManager() as any, null);
    const seen = recordLifecycle(mgr);
    await mgr.createUnboundBridgedCall(UNBOUND);
    const firstPstn = fakeStationWs();
    mgr.attachPstnLeg('call-1', firstPstn as any);
    negotiateVoicelink(firstPstn); // VoiceLink media is ready only after `start`.
    const station = fakeStationWs();
    mgr.bindBorrowedBrowserLeg('att-1', station as any);
    expect(phases(seen).filter((p) => p === 'bridged')).toHaveLength(1);
    station.sent.length = 0;

    mgr.attachPstnLeg('call-1', fakeStationWs() as any); // carrier re-connects

    expect(station.sent.filter((f) => f.event === 'status' && f.status === 'in_progress')).toHaveLength(1);
    expect(phases(seen).filter((p) => p === 'bridged')).toHaveLength(1);

    await endByUser(mgr);
  });

  it('refuses a second bind rather than displacing a live agent', async () => {
    const mgr = new WebRtcBridgeManager(makeCallManager() as any, null);
    const seen = recordLifecycle(mgr);
    await mgr.createUnboundBridgedCall(UNBOUND);
    const pstn = fakeStationWs();
    mgr.attachPstnLeg('call-1', pstn as any);
    negotiateVoicelink(pstn); // VoiceLink media is ready only after `start`.
    const first = fakeStationWs();
    expect(mgr.getSession('call-1')!.browserLegBound).toBe(false);
    expect(mgr.bindBorrowedBrowserLeg('att-1', first as any)).toBe(true);
    expect(mgr.getSession('call-1')!.browserLegBound).toBe(true);

    // `adoptBorrowedBrowserLeg` drops the previous reference without closing or
    // notifying it, so a second bind would leave the first agent silently on a
    // call that no longer relays to them.
    const second = fakeStationWs();
    expect(mgr.bindBorrowedBrowserLeg('att-1', second as any)).toBe(false);

    expect(mgr.getSession('call-1')!.browserWs).toBe(first);
    expect(second.count('close')).toBe(0); // never wired in at all
    expect(phases(seen).filter((p) => p === 'bridged')).toHaveLength(1);

    // Still relaying to the FIRST agent — the displacement this refuses is
    // silent, so the audio path is the only thing that proves it did not happen.
    first.emit('message', JSON.stringify({ event: 'media', media: { payload: 'DDDD' } }));
    second.emit('message', JSON.stringify({ event: 'media', media: { payload: 'EEEE' } }));
    expect(mgr.getSession('call-1')!.browserToPstnFrames).toBe(1);

    await endByUser(mgr);
  });

  it('refuses a bind after the socket dropped, and again after a re-attach', async () => {
    // `browserLegBound` is monotonic, so neither a drop nor the re-attach that
    // follows it reopens the bind. Pinned because the obvious implementation of
    // this guard — `session.browserWs !== null` — passes the first case and
    // fails this one: the close handler leaves the reference in place.
    const mgr = new WebRtcBridgeManager(makeCallManager() as any, null);
    await mgr.createUnboundBridgedCall({ ...UNBOUND, browserCloseGraceMs: 5_000 });
    const pstn = fakeStationWs();
    mgr.attachPstnLeg('call-1', pstn as any);
    negotiateVoicelink(pstn); // answered, with media negotiated.
    const station = fakeStationWs();
    mgr.bindBorrowedBrowserLeg('att-1', station as any);

    station.readyState = 3;
    station.emit('close');
    expect(mgr.getSession('call-1')!.browserLegBound).toBe(true);
    expect(mgr.bindBorrowedBrowserLeg('att-1', fakeStationWs() as any)).toBe(false);

    const resumed = fakeStationWs();
    expect(mgr.reattachBorrowedBrowserLeg('att-1', resumed as any)).toBe(true);
    expect(mgr.bindBorrowedBrowserLeg('att-1', fakeStationWs() as any)).toBe(false);
    expect(mgr.getSession('call-1')!.browserWs).toBe(resumed);

    await endByUser(mgr);
  });

  it('refuses a socket that has already closed', async () => {
    const mgr = new WebRtcBridgeManager(makeCallManager() as any, null);
    const seen = recordLifecycle(mgr);
    await mgr.createUnboundBridgedCall(UNBOUND);
    const pstn = fakeStationWs();
    mgr.attachPstnLeg('call-1', pstn as any);
    // answered with media negotiated. Without it `bridged`
    // could never be emitted on VoiceLink, and the `not.toContain('bridged')` below would be
    // vacuous.
    negotiateVoicelink(pstn);
    expect(phases(seen)).toEqual(['answered']);

    // The agent went away between the caller's own check and this call. There is
    // no pre-flight socket check on an unbound dial, so this IS that check.
    const dead = fakeStationWs();
    dead.readyState = 3;
    expect(mgr.bindBorrowedBrowserLeg('att-1', dead as any)).toBe(false);
    expect(mgr.getSession('call-1')!.browserWs).toBeNull();
    expect(phases(seen)).not.toContain('bridged');

    await endByUser(mgr);
  });

  it('refuses a call that has already ended, and one that is settling', async () => {
    const mgr = new WebRtcBridgeManager(makeCallManager() as any, null);
    await mgr.createUnboundBridgedCall(UNBOUND);
    await endByUser(mgr);
    // Nothing to bind onto: a false obliges the caller to treat the customer as
    // unreached (the abandoned path), not to retry.
    expect(mgr.bindBorrowedBrowserLeg('att-1', fakeStationWs() as any)).toBe(false);

    // …and the `ending` half of the same guard: an answered VoiceLink teardown
    // awaiting carrier confirmation still has a live session in the map.
    const pstn = fakeStationWs();
    await mgr.createUnboundBridgedCall({ ...VL_UNBOUND, agencyAttemptId: 'att-2' });
    mgr.attachPstnLeg('call-2', pstn as any);
    negotiateVoicelink(pstn);
    await mgr.forceEndWithOutcome('att-2', 'agent_hangup');
    expect(mgr.getSession('call-2')!.ending).toBe(true);
    expect(mgr.bindBorrowedBrowserLeg('att-2', fakeStationWs() as any)).toBe(false);
  });

  it('refuses a bridge-owned browser leg', async () => {
    // Unreachable through the public API today — every unbound dial marks the leg
    // borrowed — so the state is forced here. The guard is what keeps a future
    // fourth creation mode from binding a caller's socket onto a call whose
    // socket lifetime the bridge owns.
    const mgr = new WebRtcBridgeManager(makeCallManager() as any, null);
    await mgr.createUnboundBridgedCall(UNBOUND);
    mgr.getSession('call-1')!.browserWsOwned = true;

    expect(mgr.bindBorrowedBrowserLeg('att-1', fakeStationWs() as any)).toBe(false);

    await endByUser(mgr);
  });

  it('refuses an id that names no live call', async () => {
    const mgr = new WebRtcBridgeManager(makeCallManager() as any, null);
    expect(mgr.bindBorrowedBrowserLeg('att-nobody', fakeStationWs() as any)).toBe(false);
  });
});

describe('reattachBorrowedBrowserLeg after a late bind', () => {
  it('resumes the bridge WITHOUT emitting a second `bridged`', async () => {
    // `bridged_at` is half of the SQL abandonment predicate
    // (`answered_at IS NOT NULL AND bridged_at IS NULL`). Re-emitting on a wifi
    // blip would move the recorded bridge instant later and make a call that WAS
    // bridged on time read as a slow one — a corrupted compliance measurement,
    // from a socket event with no bearing on it.
    const mgr = new WebRtcBridgeManager(makeCallManager() as any, null);
    const seen = recordLifecycle(mgr);
    await mgr.createUnboundBridgedCall({ ...UNBOUND, browserCloseGraceMs: 5_000 });
    const pstn = fakeStationWs();
    mgr.attachPstnLeg('call-1', pstn as any);
    negotiateVoicelink(pstn); // VoiceLink media is ready only after `start`.

    const station = fakeStationWs();
    expect(mgr.bindBorrowedBrowserLeg('att-1', station as any)).toBe(true);
    expect(phases(seen).filter((p) => p === 'bridged')).toHaveLength(1);

    // The agent's wifi drops. The grace window was carried through the unbound
    // dial (markBorrowedUnbound stores it), so the call is held, not hung up.
    station.readyState = 3;
    station.emit('close');
    expect(mgr.getSession('call-1')!.browserLegGraceArmed).toBe(true);

    const resumed = fakeStationWs();
    expect(mgr.reattachBorrowedBrowserLeg('att-1', resumed as any)).toBe(true);
    expect(mgr.getSession('call-1')!.browserLegGraceArmed).toBe(false);
    expect(phases(seen).filter((p) => p === 'bridged')).toHaveLength(1);

    await endByUser(mgr);
  });

  it('refuses an attempt that has NEVER been bound, rather than joining a ringing call', async () => {
    // The guard the other three cannot express. An unbound session passes every
    // existing refusal — not owned, not endHandled, not ending — so without this
    // a station socket reconnecting during the ring would be adopted onto a call
    // the customer has not answered: late binding defeated, and the ringing panel
    // this change exists to remove back on the console.
    const mgr = new WebRtcBridgeManager(makeCallManager() as any, null);
    const seen = recordLifecycle(mgr);
    await mgr.createUnboundBridgedCall({ ...UNBOUND, browserCloseGraceMs: 5_000 });
    const session = mgr.getSession('call-1')!;
    expect(session.browserLegBound).toBe(false);
    // The state that makes this dangerous: nothing else says no.
    expect(session.browserWsOwned).toBe(false);
    expect(session.endHandled).toBe(false);
    expect(session.ending).toBe(false);

    const reconnecting = fakeStationWs();
    expect(mgr.reattachBorrowedBrowserLeg('att-1', reconnecting as any)).toBe(false);

    // Nothing adopted, nothing announced: `AgencyDialer.reattachStation` reads the
    // false as "nothing live to resume" and the attempt still binds at the answer.
    expect(session.browserWs).toBeNull();
    expect(reconnecting.count('close')).toBe(0);
    expect(phases(seen)).not.toContain('bridged');

    // And the bind still works afterwards — the refusal consumed nothing.
    const pstn = fakeStationWs();
    mgr.attachPstnLeg('call-1', pstn as any);
    negotiateVoicelink(pstn); // VoiceLink media is ready only after `start`.
    expect(mgr.bindBorrowedBrowserLeg('att-1', reconnecting as any)).toBe(true);
    expect(phases(seen).filter((p) => p === 'bridged')).toHaveLength(1);

    await endByUser(mgr);
  });

  it('is the route for a dropped socket — a bind is refused for it', async () => {
    const mgr = new WebRtcBridgeManager(makeCallManager() as any, null);
    await mgr.createUnboundBridgedCall({ ...UNBOUND, browserCloseGraceMs: 5_000 });
    const pstn = fakeStationWs();
    mgr.attachPstnLeg('call-1', pstn as any);
    negotiateVoicelink(pstn); // answered, with media negotiated.
    const station = fakeStationWs();
    mgr.bindBorrowedBrowserLeg('att-1', station as any);
    station.readyState = 3;
    station.emit('close');

    // The dead reference is still held, so this is the already-bound case — and
    // it must stay that way, or a "bind" would skip disarming the grace window
    // and the call would be hung up under the re-attached agent.
    expect(mgr.bindBorrowedBrowserLeg('att-1', fakeStationWs() as any)).toBe(false);
    expect(mgr.getSession('call-1')!.browserLegGraceArmed).toBe(true);

    await endByUser(mgr);
  });
});
