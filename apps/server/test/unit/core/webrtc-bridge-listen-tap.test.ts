import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// The listen tap (`src/core/bridge/listen-tap.ts`; docs/listening.md §2, §5; LS8, LS11): a
// supervisor's sink attached to a bridged call gets both legs as one tag byte and 160 bytes of
// A-law, and nothing about it reaches the call.
//
// What is pinned here:
//  - the wire: both legs byte for byte where the audio is A-law already (a VoiceLink customer,
//    an `alaw8` agent), cut into 20 ms frames, a 1 s agent message into 50;
//  - the transcodes (a μ-law customer, a `pcm16` agent) run on the tap's OWN codecs: the
//    session's codec is called exactly once per frame, as without a listener;
//  - with nobody listening a frame costs one field read: no extra codec or send calls;
//  - the tail runs after the relay's write, also when the leg gate returns early, and
//    `recordRelayFrame` (the dwell) is unchanged by two listeners;
//  - back-pressure on the listener's own socket: past 48 KiB dropped and counted, past 256 KiB
//    ended `send_backlog`, the call's two sockets untouched;
//  - fault injection: a throwing codec, a throwing sink, a socket that errors mid-send, a socket
//    that never drains. Both legs keep their frames, nothing throws out of a socket handler, and
//    each sink ends with the right reason;
//  - the fault budget: exactly N failed frames of one leg in a row detach the tap `tap_error`;
//    a success resets the run;
//  - the call's end ends every sink `call_ended`; the agent's re-attach keeps the tap;
//  - `openListenTap`'s refusals.
//
// Harness mirrors webrtc-bridge-alaw8-media.test.ts (project convention: no shared test utilities).
// ---------------------------------------------------------------------------

const { logSpy } = vi.hoisted(() => ({ logSpy: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@magick-agency/observability', () => ({ logger: logSpy, createChildLogger: () => logSpy }));

const { cfg } = vi.hoisted(() => ({
  cfg: {
    redis: { keyPrefix: '' },
    telephony: { voicelink: { webhookBaseUrl: 'https://server.test/api/v1/webhooks/voicelink' } },
    agency: { listen: { faultBudget: 50 } },
  },
}));
vi.mock('../../../src/config/index.js', () => ({ config: cfg }));

const { metrics } = vi.hoisted(() => ({
  metrics: { tapError: vi.fn(), backpressure: vi.fn(), dwell: vi.fn() },
}));
vi.mock('@magick-agency/observability/metrics/agency', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  trackListenTapError: metrics.tapError,
}));
vi.mock('@magick-agency/observability/metrics/voice', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  trackWebsocketSendBackpressure: metrics.backpressure,
  trackRelayDwell: metrics.dwell,
}));

const { mockRepo } = vi.hoisted(() => ({
  mockRepo: { create: vi.fn(), findById: vi.fn().mockResolvedValue(null), update: vi.fn().mockResolvedValue(null) },
}));
vi.mock('@magick-agency/db/repositories/agency-call.repository', () => ({ webrtcCallRepository: mockRepo }));
vi.mock('@magick-agency/db/repositories/account-settings.repository', () => ({
  accountSettingsRepository: {
    getAllowRecording: vi.fn().mockResolvedValue(null),
    getWebrtcMaxDurationSeconds: vi.fn().mockResolvedValue(null),
  },
}));
vi.mock('../../../src/telephony/factory.js', () => ({
  TelephonyProviderRegistry: class {
    get() {
      return {
        capabilities: { cancelRinging: false, queuesOutboundDials: true },
        initiateCall: vi.fn().mockResolvedValue({ providerCallId: 'pcid-1' }),
        endCall: vi.fn().mockResolvedValue(undefined),
      };
    }
  },
}));
vi.mock('../../../src/audit/audit-logger.js', () => ({ auditLogger: { log: vi.fn() } }));
vi.mock('../../../src/analytics/posthog.js', () => ({
  trackWebrtcCallInitiated: vi.fn(), trackWebrtcCallRejected: vi.fn(), trackWebrtcCallCompleted: vi.fn(),
}));

// `mulaw`: Plivo's real media protocol (μ-law 8 kHz, its real codec), streaming on connect so the
// harness needs no `start`. Every codec it makes is recorded with spies: the first is the
// session's, the next the tap's. `codecs.next` swaps in a codec for the next one made.
const { codecs } = vi.hoisted(() => ({
  codecs: {
    made: [] as Array<{ carrierToPcm16k: ReturnType<typeof vi.fn>; pcm16kToCarrier: ReturnType<typeof vi.fn> }>,
    next: null as null | { carrierToPcm16k: (b: Buffer) => Buffer; pcm16kToCarrier: (b: Buffer) => Buffer },
  },
}));
vi.mock('../../../src/telephony/carrier-modules.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/telephony/carrier-modules.js')>();
  const vl = actual.findCarrierModule('voicelink')!;
  const plivo = actual.findCarrierModule('plivo')!;
  const mulaw = {
    ...vl,
    name: 'mulaw',
    answeredHangup: 'rest' as const,
    mediaUrlInDialRequest: false,
    media: {
      ...plivo.media,
      negotiatesOnStart: false,
      createCodec: () => {
        const real = codecs.next ?? plivo.media.createCodec();
        codecs.next = null;
        const spied = { carrierToPcm16k: vi.fn(real.carrierToPcm16k), pcm16kToCarrier: vi.fn(real.pcm16kToCarrier) };
        codecs.made.push(spied);
        return spied;
      },
    },
  };
  return { ...actual, findCarrierModule: (p: string) => (p === 'mulaw' ? mulaw : actual.findCarrierModule(p)) };
});
vi.mock('../../../src/core/webhook-url-builder.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/core/webhook-url-builder.js')>();
  class WebhookUrlBuilder extends actual.WebhookUrlBuilder {
    override baseUrl(p: string): string {
      return p === 'mulaw' ? 'https://server.test/api/v1/webhooks/mulaw' : super.baseUrl(p);
    }
  }
  return { ...actual, WebhookUrlBuilder };
});

import { WebRtcBridgeManager, type ListenSendResult, type ListenSink, type ListenTapHandle } from '../../../src/core/webrtc-bridge-manager.js';
import { AlawFramer, setBrowserLegMediaFormat, type BrowserLegMediaFormat } from '../../../src/core/bridge/browser-leg-media.js';
import { ListenTap, sendToListenerSocket } from '../../../src/core/bridge/listen-tap.js';
import { findCarrierModule } from '../../../src/telephony/carrier-modules.js';
import { VoicelinkTranscoder } from '../../../src/utils/audio-fir.js';
import { LISTENER_LIMITS } from '../../../src/utils/ws-backpressure.js';
import { AGENCY_LISTEN_LEG, AGENCY_LISTEN_MESSAGE_BYTES } from '@magick-agency/contracts/agency';

// ── Fakes ───────────────────────────────────────────────────────────────────

/** A station socket that records text (JSON) and binary sends apart, as `ws` would. */
function fakeStation(format: BrowserLegMediaFormat) {
  const handlers: Record<string, ((...a: any[]) => void)[]> = {};
  const ws = {
    readyState: 1,
    OPEN: 1,
    sent: [] as any[],
    binary: [] as Buffer[],
    send(data: string | Buffer, opts?: { binary?: boolean }) {
      if (opts?.binary) this.binary.push(data as Buffer);
      else this.sent.push(JSON.parse(data as string));
    },
    on(ev: string, cb: (...a: any[]) => void) { (handlers[ev] ||= []).push(cb); },
    off(ev: string, cb: (...a: any[]) => void) {
      const list = handlers[ev];
      if (!list) return;
      const i = list.indexOf(cb);
      if (i >= 0) list.splice(i, 1);
    },
    emit(ev: string, ...a: any[]) { (handlers[ev] || []).slice().forEach((cb) => cb(...a)); },
    close() { this.readyState = 3; this.emit('close'); },
    /** What `ws` emits for a binary message from the client. */
    sendBinaryUp(buf: Buffer) { this.emit('message', buf, true); },
    /** A `pcm16` agent's JSON media frame. */
    sendPcmUp(pcm: Buffer) { this.emit('message', Buffer.from(JSON.stringify({ event: 'media', media: { payload: pcm.toString('base64') } })), false); },
    /** The agent audio frames this socket got: binary on `alaw8`, JSON on `pcm16`. */
    mediaFrames(): number { return this.binary.length + this.sent.filter((m) => m.event === 'media').length; },
  };
  setBrowserLegMediaFormat(ws as never, format);
  return ws;
}

/** The carrier's media socket: JSON text both ways. */
function fakePstn() {
  const handlers: Record<string, ((...a: any[]) => void)[]> = {};
  return {
    readyState: 1,
    OPEN: 1,
    sent: [] as any[],
    send(s: string) { this.sent.push(JSON.parse(s)); },
    on(ev: string, cb: (...a: any[]) => void) { (handlers[ev] ||= []).push(cb); },
    off() { /* not borrowed */ },
    emit(ev: string, ...a: any[]) { (handlers[ev] || []).slice().forEach((cb) => cb(...a)); },
    close() { this.readyState = 3; },
    media(payload: Buffer) { this.emit('message', JSON.stringify({ event: 'media', media: { payload: payload.toString('base64') } })); },
    /** Audio frames the bridge sent the carrier (VoiceLink `media`, Plivo `playAudio`). */
    audioFrames(): number { return this.sent.filter((m) => m.event === 'media' || m.event === 'playAudio').length; },
  };
}

/** A sink that records what it is given. */
function recordingSink(listenId = 'listen-1', answer: () => ListenSendResult = () => 'sent') {
  const messages: Buffer[] = [];
  const closed: Array<{ reason: string; stats: { framesSent: number; framesDropped: number } }> = [];
  const sink = {
    listenId,
    messages,
    closed,
    send: vi.fn((m: Buffer): ListenSendResult => {
      messages.push(m);
      return answer();
    }),
    close: vi.fn((reason: string, stats: { framesSent: number; framesDropped: number }) => { closed.push({ reason, stats }); }),
  };
  return sink;
}
type RecordingSink = ReturnType<typeof recordingSink>;

/** The audio a sink got for one leg, tags stripped, after checking every message's shape. */
function legAudio(sink: RecordingSink, leg: keyof typeof AGENCY_LISTEN_LEG): Buffer {
  for (const m of sink.messages) {
    expect(m.length).toBe(AGENCY_LISTEN_MESSAGE_BYTES);
    expect([AGENCY_LISTEN_LEG.customer, AGENCY_LISTEN_LEG.agent]).toContain(m[0]);
  }
  return Buffer.concat(sink.messages.filter((m) => m[0] === AGENCY_LISTEN_LEG[leg]).map((m) => m.subarray(1)));
}
const legCount = (sink: RecordingSink, leg: keyof typeof AGENCY_LISTEN_LEG) =>
  sink.messages.filter((m) => m[0] === AGENCY_LISTEN_LEG[leg]).length;

/** A listener socket for `sendToListenerSocket`. `drains: false` keeps every byte it is sent. */
function fakeListenerSocket(opts: { drains?: boolean; throwOnSend?: number } = {}) {
  let sends = 0;
  const ws = {
    readyState: 1,
    bufferedAmount: 0,
    got: [] as Buffer[],
    send(data: Buffer) {
      sends++;
      if (opts.throwOnSend !== undefined && sends >= opts.throwOnSend) throw new Error('write EPIPE');
      this.got.push(data);
      if (opts.drains === false) this.bufferedAmount += data.length + 2;
    },
  };
  return ws;
}
/** A sink over a fake listener socket, the way the agency's listener socket will be. */
function socketSink(ws: ReturnType<typeof fakeListenerSocket>, listenId = 'listen-s') {
  const closed: string[] = [];
  const sink: ListenSink & { closed: string[] } = {
    listenId,
    closed,
    send: (m) => sendToListenerSocket(ws as never, m),
    close: (reason) => { closed.push(reason); },
  };
  return sink;
}

function makeGuardHost() {
  return {
    concurrencyGuard: { tryAcquire: vi.fn().mockResolvedValue(true), release: vi.fn().mockResolvedValue(undefined) },
    accountConcurrencyGuard: { tryAcquire: vi.fn().mockResolvedValue(true), release: vi.fn().mockResolvedValue(undefined) },
    triggerDequeue: vi.fn(),
    wakeSelfHeal: vi.fn(),
  };
}

const ATTEMPT = 'att-1';
const CALL = 'call-1';
const PARAMS = {
  tenantId: 't1',
  accountId: 'a1',
  callerId: '+14155550100',
  destinationPhone: '+14155550199',
  correlation: { kind: 'attempt' as const, campaignId: 'camp-1', agencyAttemptId: ATTEMPT },
  browserCloseGraceMs: 5_000,
};

/** A pattern of distinct bytes, so an exact copy is distinguishable from a re-encode. */
function bytes(n: number, seed = 1): Buffer {
  const b = Buffer.alloc(n);
  for (let i = 0; i < n; i++) b[i] = (i * 37 + seed * 101) & 0xff;
  return b;
}
/** A 1 kHz tone as PCM16 16 kHz, 20 ms (320 samples) per frame. */
function pcm16kTone(samples: number, phase = 0): Buffer {
  const pcm = new Int16Array(samples);
  for (let i = 0; i < samples; i++) pcm[i] = Math.round(8000 * Math.sin((2 * Math.PI * 1000 * (phase + i)) / 16000));
  return Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
}
/** A μ-law 20 ms frame of a tone (160 bytes). */
function mulawFrame(i: number): Buffer {
  const b = Buffer.alloc(160);
  for (let k = 0; k < 160; k++) b[k] = (0x80 + Math.round(40 * Math.sin((2 * Math.PI * (i * 160 + k)) / 8))) & 0xff;
  return b;
}

/** Dial on `provider` with `station` borrowed, attach the PSTN leg and open the relay. */
async function bridged(provider: 'voicelink' | 'mulaw', station: ReturnType<typeof fakeStation>) {
  const mgr = new WebRtcBridgeManager(makeGuardHost() as any, null);
  await mgr.createBridgedCall({ ...PARAMS, provider, browserSocket: station as any });
  const pstn = fakePstn();
  expect(mgr.attachPstnLeg(CALL, pstn as any)).toBe(true);
  if (provider === 'voicelink') {
    pstn.emit('message', JSON.stringify({
      event: 'start',
      start: { call_sid: 'c', stream_sid: 's', media_format: { encoding: 'audio/alaw', sample_rate: '8000' } },
    }));
  }
  const session = mgr.getSession(CALL)!;
  expect(session.bridged).toBe(true);
  return { mgr, pstn, session };
}

/** The carrier's confirmation of a VoiceLink teardown we started: the call settles, the session is destroyed. */
async function carrierEnded(mgr: WebRtcBridgeManager): Promise<void> {
  await mgr.handleVoicelinkStatus(CALL, {
    providerCallId: 'c', callId: CALL, eventType: 'hangup', timestamp: new Date(),
    metadata: { event: 'call.ended', call: { id: 'c', status: 'ended' } },
  });
}

function attach(mgr: WebRtcBridgeManager, sink: ListenSink): ListenTapHandle {
  const handle = mgr.openListenTap(CALL, sink);
  if ('refused' in handle) throw new Error(`refused: ${handle.refused}`);
  return handle;
}

/** The A-law a fresh tap-side pipeline would produce for these frames (to compare byte for byte). */
function expectedAlaw(frames: Buffer[], pipeline: (b: Buffer) => Buffer): Buffer {
  const framer = new AlawFramer();
  const out: Buffer[] = [];
  for (const f of frames) framer.push(pipeline(f), (x) => out.push(Buffer.from(x)));
  return Buffer.concat(out);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  codecs.made.length = 0;
  codecs.next = null;
  cfg.agency.listen.faultBudget = 50;
  mockRepo.create.mockImplementation(async (i: any) => ({
    id: CALL, tenant_id: i.tenant_id, account_id: i.account_id, caller_id: i.caller_id,
    destination_phone: i.destination_phone, provider: i.provider, status: 'initiating',
    provider_call_id: null, telephony_credential_id: null,
    campaign_id: i.campaign_id ?? null, agency_attempt_id: i.agency_attempt_id ?? null,
  }));
});

// ── The wire ────────────────────────────────────────────────────────────────

describe('both legs as tagged 20 ms A-law: passthrough', () => {
  it('VoiceLink + an alaw8 agent: each leg byte for byte behind its tag, the call`s own relay unchanged', async () => {
    const station = fakeStation('alaw8');
    const { mgr, pstn } = await bridged('voicelink', station);
    const sink = recordingSink();
    attach(mgr, sink);

    const c1 = bytes(160, 1);
    const c2 = bytes(160, 2);
    const a1 = bytes(160, 3);
    pstn.media(c1);
    station.sendBinaryUp(a1);
    pstn.media(c2);

    // FALSIFIED by decoding the customer through any codec (the bytes differ) or by dropping the
    // tag byte (the length check fails).
    expect(legAudio(sink, 'customer')).toEqual(Buffer.concat([c1, c2]));
    expect(legAudio(sink, 'agent')).toEqual(a1);
    expect(sink.messages.map((m) => m[0])).toEqual([1, 2, 1]);
    // The call itself: the agent heard the customer, the carrier the agent, as before.
    expect(Buffer.concat(station.binary)).toEqual(Buffer.concat([c1, c2]));
    expect(pstn.audioFrames()).toBe(1);
    await mgr.forceEndWithOutcome(ATTEMPT, 'ended_by_user');
  });

  it('an alaw8 agent`s 1 s message reaches the listener as 50 frames, in order; a carrier frame of 60 ms as 3', async () => {
    const station = fakeStation('alaw8');
    const { mgr, pstn } = await bridged('voicelink', station);
    const sink = recordingSink();
    attach(mgr, sink);

    const second = bytes(8000, 4);
    station.sendBinaryUp(second);
    expect(legCount(sink, 'agent')).toBe(50);
    expect(legAudio(sink, 'agent')).toEqual(second);

    const sixty = bytes(480, 5);
    pstn.media(sixty);
    expect(legCount(sink, 'customer')).toBe(3);
    expect(legAudio(sink, 'customer')).toEqual(sixty);

    // A carrier frame that is not whole 20 ms frames: the tail waits for the next, in the tap's
    // own framer (the agent's framer is the session's and unaffected).
    const odd = bytes(100, 6);
    pstn.media(odd);
    expect(legCount(sink, 'customer')).toBe(3);
    pstn.media(bytes(60, 7));
    expect(legCount(sink, 'customer')).toBe(4);
    expect(legAudio(sink, 'customer').subarray(480)).toEqual(Buffer.concat([odd, bytes(60, 7)]));
    await mgr.forceEndWithOutcome(ATTEMPT, 'ended_by_user');
  });

  it('a message is built once per frame and the same Buffer goes to every listener', async () => {
    const station = fakeStation('alaw8');
    const { mgr, pstn } = await bridged('voicelink', station);
    const s1 = recordingSink('l1');
    const s2 = recordingSink('l2');
    attach(mgr, s1);
    attach(mgr, s2);
    pstn.media(bytes(160, 8));
    expect(s1.messages).toHaveLength(1);
    expect(s2.messages[0]).toBe(s1.messages[0]);
    await mgr.forceEndWithOutcome(ATTEMPT, 'ended_by_user');
  });
});

describe('transcoded legs run on the tap`s own codecs', () => {
  it('a μ-law customer: the tap`s own carrier codec and A-law encoder; the session codec once per frame', async () => {
    const station = fakeStation('pcm16');
    const { mgr, pstn, session } = await bridged('mulaw', station);
    expect(codecs.made).toHaveLength(1);
    const sessionCodec = codecs.made[0]!;
    expect(session.codec).toBe(sessionCodec);
    const sink = recordingSink();
    attach(mgr, sink);
    // The tap made its own codec; the session's is not shared.
    expect(codecs.made).toHaveLength(2);
    const tapCodec = codecs.made[1]!;

    const frames = Array.from({ length: 10 }, (_, i) => mulawFrame(i));
    for (const f of frames) pstn.media(f);

    // FALSIFIED by feeding the tap from the session's codec: the session codec is called twice per
    // frame, and its FIR history is shared, so the bytes below differ from a fresh pipeline's.
    expect(sessionCodec.carrierToPcm16k).toHaveBeenCalledTimes(frames.length);
    expect(tapCodec.carrierToPcm16k).toHaveBeenCalledTimes(frames.length);
    const plivo = findCarrierModule('plivo')!.media.createCodec();
    const enc = new VoicelinkTranscoder();
    const want = expectedAlaw(frames, (f) => enc.pcm16kToAlaw(plivo.carrierToPcm16k(f)));
    expect(want.length).toBeGreaterThan(0);
    expect(legAudio(sink, 'customer')).toEqual(want.subarray(0, legAudio(sink, 'customer').length));
    expect(legAudio(sink, 'customer').length).toBe(want.length);
    // The agent still got every frame, as PCM16 from the session's codec.
    expect(station.sent.filter((m) => m.event === 'media')).toHaveLength(frames.length);
    await mgr.forceEndWithOutcome(ATTEMPT, 'ended_by_user');
  });

  it('a pcm16 agent: the tap`s own A-law encoder; the session codec once per frame', async () => {
    const station = fakeStation('pcm16');
    const { mgr, pstn } = await bridged('mulaw', station);
    const sessionCodec = codecs.made[0]!;
    const sink = recordingSink();
    attach(mgr, sink);

    const frames = Array.from({ length: 8 }, (_, i) => pcm16kTone(320, i * 320));
    for (const f of frames) station.sendPcmUp(f);

    expect(sessionCodec.pcm16kToCarrier).toHaveBeenCalledTimes(frames.length);
    expect(codecs.made[1]!.pcm16kToCarrier).not.toHaveBeenCalled();
    const enc = new VoicelinkTranscoder();
    expect(legAudio(sink, 'agent')).toEqual(expectedAlaw(frames, (f) => enc.pcm16kToAlaw(f)));
    expect(legCount(sink, 'agent')).toBeGreaterThan(0);
    expect(pstn.audioFrames()).toBe(frames.length);
    await mgr.forceEndWithOutcome(ATTEMPT, 'ended_by_user');
  });

  it('VoiceLink + a pcm16 agent: the customer is still passthrough, the agent encoded by the tap', async () => {
    const station = fakeStation('pcm16');
    const { mgr, pstn } = await bridged('voicelink', station);
    const sink = recordingSink();
    attach(mgr, sink);
    const c = bytes(160, 9);
    pstn.media(c);
    const agent = pcm16kTone(320);
    station.sendPcmUp(agent);
    expect(legAudio(sink, 'customer')).toEqual(c);
    const enc = new VoicelinkTranscoder();
    expect(legAudio(sink, 'agent')).toEqual(expectedAlaw([agent], (f) => enc.pcm16kToAlaw(f)));
    await mgr.forceEndWithOutcome(ATTEMPT, 'ended_by_user');
  });
});

describe('with nobody listening a frame costs one field read', () => {
  it('no tap: no extra codec, no tap call; after the last listener leaves the field is null again', async () => {
    const feeds = [
      vi.spyOn(ListenTap.prototype, 'feedCustomer'),
      vi.spyOn(ListenTap.prototype, 'feedAgentPcm16'),
      vi.spyOn(ListenTap.prototype, 'feedAgentAlaw'),
    ];
    const station = fakeStation('pcm16');
    const { mgr, pstn, session } = await bridged('mulaw', station);
    const sessionCodec = codecs.made[0]!;
    expect(session.listenTap).toBeNull();

    for (let i = 0; i < 5; i++) pstn.media(mulawFrame(i));
    for (let i = 0; i < 5; i++) station.sendPcmUp(pcm16kTone(320));
    // FALSIFIED by making the tap eagerly (the codec count) or feeding it unconditionally.
    expect(codecs.made).toHaveLength(1);
    expect(sessionCodec.carrierToPcm16k).toHaveBeenCalledTimes(5);
    expect(sessionCodec.pcm16kToCarrier).toHaveBeenCalledTimes(5);
    for (const f of feeds) expect(f).not.toHaveBeenCalled();

    const handle = attach(mgr, recordingSink());
    pstn.media(mulawFrame(5));
    expect(feeds[0]).toHaveBeenCalledTimes(1);
    handle.detach();
    expect(handle.attached).toBe(false);
    expect(session.listenTap).toBeNull();
    pstn.media(mulawFrame(6));
    station.sendPcmUp(pcm16kTone(320));
    expect(feeds[0]).toHaveBeenCalledTimes(1);
    expect(feeds[1]).not.toHaveBeenCalled();
    expect(sessionCodec.carrierToPcm16k).toHaveBeenCalledTimes(7);
    expect(pstn.audioFrames()).toBe(6);
    await mgr.forceEndWithOutcome(ATTEMPT, 'ended_by_user');
  });
});

describe('the tail runs after the relay`s write, and the dwell does not see it', () => {
  it('recordRelayFrame runs before every listener send, and its counts and samples are the same with two listeners', async () => {
    const run = async (listeners: number) => {
      metrics.dwell.mockClear();
      const station = fakeStation('alaw8');
      const { mgr, pstn, session } = await bridged('voicelink', station);
      const record = vi.spyOn(mgr as any, 'recordRelayFrame');
      const sinks = Array.from({ length: listeners }, (_, i) => recordingSink(`l${i}`));
      for (const s of sinks) attach(mgr, s);
      for (let i = 0; i < 100; i++) {
        pstn.media(bytes(160, i));
        station.sendBinaryUp(bytes(160, i + 1));
      }
      if (listeners > 0) {
        // Each listener send of a frame follows that frame's recordRelayFrame.
        const recOrder = record.mock.invocationCallOrder;
        const sendOrder = sinks[0]!.send.mock.invocationCallOrder;
        expect(sendOrder).toHaveLength(200);
        for (let i = 0; i < 200; i++) expect(sendOrder[i]!).toBeGreaterThan(recOrder[i]!);
      }
      const out = {
        recorded: record.mock.calls.length,
        p2b: session.pstnToBrowserFrames,
        b2p: session.browserToPstnFrames,
        dwell: metrics.dwell.mock.calls.map((c) => c[0]),
      };
      await mgr.forceEndWithOutcome(ATTEMPT, 'ended_by_user');
      return out;
    };
    const none = await run(0);
    const two = await run(2);
    expect(none).toEqual({ recorded: 200, p2b: 100, b2p: 100, dwell: ['p2b', 'b2p', 'p2b', 'b2p'] });
    expect(two).toEqual(none);
    // A sample is seconds, small and non-negative.
    for (const c of metrics.dwell.mock.calls) expect(c[1]).toBeGreaterThanOrEqual(0);
  });

  it('the customer still reaches the listener while the agent`s socket is inside its re-attach window (the gate returned early)', async () => {
    const station = fakeStation('alaw8');
    const { mgr, pstn, session } = await bridged('voicelink', station);
    const sink = recordingSink();
    attach(mgr, sink);
    station.close();
    expect(session.browserLegGraceArmed).toBe(true);
    const c = bytes(160, 11);
    pstn.media(c);
    expect(station.binary).toHaveLength(0);
    expect(legAudio(sink, 'customer')).toEqual(c);
    await mgr.forceEndWithOutcome(ATTEMPT, 'ended_by_user');
  });

  it('the agent still reaches the listener when the relay to the carrier is gated', async () => {
    const station = fakeStation('alaw8');
    const { mgr, pstn } = await bridged('voicelink', station);
    const sink = recordingSink();
    attach(mgr, sink);
    pstn.readyState = 2;
    const a = bytes(160, 12);
    station.sendBinaryUp(a);
    expect(pstn.audioFrames()).toBe(0);
    expect(legAudio(sink, 'agent')).toEqual(a);
    // What the relay refuses is not the tap's either: a message that is not whole frames.
    station.sendBinaryUp(bytes(100, 13));
    expect(legCount(sink, 'agent')).toBe(1);
    pstn.readyState = 1;
    await mgr.forceEndWithOutcome(ATTEMPT, 'ended_by_user');
  });
});

// ── Back-pressure on the listener's own socket ─────────────────────────────────

describe('back-pressure: the listener`s socket only', () => {
  it('LISTENER_LIMITS: soft 48 KiB, hard 256 KiB', () => {
    expect(LISTENER_LIMITS).toEqual({ mediaSoftLimitBytes: 48 * 1024, hardCapBytes: 256 * 1024 });
  });

  it('past the soft limit a frame is dropped and counted, the legs and the other listener carry on', async () => {
    const station = fakeStation('alaw8');
    const { mgr, pstn } = await bridged('voicelink', station);
    const slow = fakeListenerSocket();
    const slowSink = socketSink(slow, 'slow');
    const fine = recordingSink('fine');
    const slowHandle = attach(mgr, slowSink);
    attach(mgr, fine);

    pstn.media(bytes(160, 1));
    slow.bufferedAmount = 48 * 1024 + 1;
    pstn.media(bytes(160, 2));
    station.sendBinaryUp(bytes(160, 3));

    // FALSIFIED by sending past the soft limit (the slow socket gets 3) or by closing there.
    expect(slow.got).toHaveLength(1);
    expect(slowHandle.stats()).toEqual({ framesSent: 1, framesDropped: 2 });
    expect(slowHandle.attached).toBe(true);
    expect(metrics.backpressure).toHaveBeenCalledWith('listener', 'media_dropped');
    expect(metrics.backpressure.mock.calls.filter((c) => c[0] !== 'listener')).toEqual([]);
    expect(fine.messages).toHaveLength(3);
    expect(station.binary).toHaveLength(2);
    expect(pstn.audioFrames()).toBe(1);

    slow.bufferedAmount = 0;
    pstn.media(bytes(160, 4));
    expect(slow.got).toHaveLength(2);
    await mgr.forceEndWithOutcome(ATTEMPT, 'ended_by_user');
  });

  it('past the hard cap the listener is ended send_backlog, once; the other listener and the call carry on', async () => {
    const station = fakeStation('alaw8');
    const { mgr, pstn } = await bridged('voicelink', station);
    const stuck = fakeListenerSocket();
    const stuckSink = socketSink(stuck, 'stuck');
    const fine = recordingSink('fine');
    const stuckHandle = attach(mgr, stuckSink);
    attach(mgr, fine);

    stuck.bufferedAmount = 256 * 1024 + 1;
    pstn.media(bytes(160, 1));
    pstn.media(bytes(160, 2));
    station.sendBinaryUp(bytes(160, 3));

    expect(stuckSink.closed).toEqual(['send_backlog']);
    expect(stuckHandle.attached).toBe(false);
    expect(metrics.backpressure.mock.calls.filter((c) => c[1] === 'closed')).toEqual([['listener', 'closed']]);
    expect(fine.messages).toHaveLength(3);
    expect(station.binary).toHaveLength(2);
    expect(pstn.audioFrames()).toBe(1);
    await mgr.forceEndWithOutcome(ATTEMPT, 'ended_by_user');
  });
});

// ── Fault injection ───────────────────────────────────────────────────────────

describe('fault injection: nothing about a listener reaches the call', () => {
  it('a throwing codec: frames dropped and counted `decode`, both legs relayed, nothing thrown out of the socket handler', async () => {
    const station = fakeStation('pcm16');
    const { mgr, pstn } = await bridged('mulaw', station);
    codecs.next = { carrierToPcm16k: () => { throw new Error('bad frame'); }, pcm16kToCarrier: (b) => b };
    const sink = recordingSink();
    const handle = attach(mgr, sink);

    for (let i = 0; i < 5; i++) {
      expect(() => pstn.media(mulawFrame(i))).not.toThrow();
      expect(() => station.sendPcmUp(pcm16kTone(320))).not.toThrow();
    }
    expect(station.sent.filter((m) => m.event === 'media')).toHaveLength(5);
    expect(pstn.audioFrames()).toBe(5);
    expect(legCount(sink, 'customer')).toBe(0);
    expect(legCount(sink, 'agent')).toBeGreaterThan(0);
    expect(metrics.tapError).toHaveBeenCalledTimes(5);
    expect(metrics.tapError).toHaveBeenCalledWith('decode');
    expect(handle.stats().framesDropped).toBe(5);
    expect(handle.attached).toBe(true);
    // Rate-limited: one line for five failures within 10 s, ids only.
    const lines = logSpy.warn.mock.calls.filter((c) => String(c[1]).startsWith('The listen tap dropped'));
    expect(lines).toHaveLength(1);
    expect(Object.keys(lines[0]![0]).sort()).toEqual(['callId', 'err', 'failures', 'leg', 'listenIds', 'stage']);
    expect(lines[0]![0]).toMatchObject({ callId: CALL, listenIds: ['listen-1'], leg: 'customer', stage: 'decode' });
    await mgr.forceEndWithOutcome(ATTEMPT, 'ended_by_user');
  });

  it('a throwing encoder on the agent leg is counted `encode`; the customer leg is untouched', async () => {
    const station = fakeStation('pcm16');
    const { mgr, pstn, session } = await bridged('mulaw', station);
    const sink = recordingSink();
    attach(mgr, sink);
    const real = VoicelinkTranscoder.prototype.pcm16kToAlaw;
    vi.spyOn(VoicelinkTranscoder.prototype, 'pcm16kToAlaw').mockImplementation(function (this: VoicelinkTranscoder, pcm: Buffer) {
      if (this === (session.listenTap as any).agentEncoder) throw new Error('encoder broke');
      return real.call(this, pcm);
    });
    for (let i = 0; i < 3; i++) {
      expect(() => station.sendPcmUp(pcm16kTone(320))).not.toThrow();
      expect(() => pstn.media(mulawFrame(i))).not.toThrow();
    }
    expect(metrics.tapError.mock.calls).toEqual([['encode'], ['encode'], ['encode']]);
    expect(legCount(sink, 'agent')).toBe(0);
    expect(legCount(sink, 'customer')).toBeGreaterThan(0);
    expect(pstn.audioFrames()).toBe(3);
    await mgr.forceEndWithOutcome(ATTEMPT, 'ended_by_user');
  });

  it('a throwing sink: that listener is ended listener_disconnected (counted `send`), the other and both legs carry on', async () => {
    const station = fakeStation('alaw8');
    const { mgr, pstn } = await bridged('voicelink', station);
    const bad = recordingSink('bad', () => { throw new Error('socket gone'); });
    const good = recordingSink('good');
    const badHandle = attach(mgr, bad);
    attach(mgr, good);

    expect(() => pstn.media(bytes(160, 1))).not.toThrow();
    expect(() => station.sendBinaryUp(bytes(160, 2))).not.toThrow();
    expect(() => pstn.media(bytes(160, 3))).not.toThrow();

    expect(bad.send).toHaveBeenCalledTimes(1);
    expect(bad.closed.map((c) => c.reason)).toEqual(['listener_disconnected']);
    expect(badHandle.attached).toBe(false);
    expect(metrics.tapError.mock.calls).toEqual([['send']]);
    expect(good.messages).toHaveLength(3);
    expect(station.binary).toHaveLength(2);
    expect(pstn.audioFrames()).toBe(1);
    await mgr.forceEndWithOutcome(ATTEMPT, 'ended_by_user');
  });

  it('a sink whose close throws too: nothing escapes', async () => {
    const station = fakeStation('alaw8');
    const { mgr, pstn, session } = await bridged('voicelink', station);
    const bad = recordingSink('bad', () => { throw new Error('send'); });
    bad.close.mockImplementation(() => { throw new Error('close'); });
    attach(mgr, bad);
    expect(() => pstn.media(bytes(160, 1))).not.toThrow();
    expect(session.listenTap).toBeNull();
    expect(station.binary).toHaveLength(1);
    await mgr.forceEndWithOutcome(ATTEMPT, 'ended_by_user');
  });

  it('a socket that errors mid-send: ended listener_disconnected at the failing send; a socket that closes, at the next', async () => {
    const station = fakeStation('alaw8');
    const { mgr, pstn } = await bridged('voicelink', station);
    const breaking = fakeListenerSocket({ throwOnSend: 3 });
    const breakingSink = socketSink(breaking, 'breaking');
    const closing = fakeListenerSocket();
    const closingSink = socketSink(closing, 'closing');
    attach(mgr, breakingSink);
    const closingHandle = attach(mgr, closingSink);

    for (let i = 0; i < 4; i++) expect(() => pstn.media(bytes(160, i))).not.toThrow();
    expect(breaking.got).toHaveLength(2);
    expect(breakingSink.closed).toEqual(['listener_disconnected']);
    expect(metrics.tapError).toHaveBeenCalledWith('send');

    closing.readyState = 3; // its `error` closed it
    expect(() => station.sendBinaryUp(bytes(160, 9))).not.toThrow();
    expect(closingSink.closed).toEqual(['listener_disconnected']);
    expect(closingHandle.stats()).toEqual({ framesSent: 4, framesDropped: 1 });
    expect(station.binary).toHaveLength(4);
    expect(pstn.audioFrames()).toBe(1);
    await mgr.forceEndWithOutcome(ATTEMPT, 'ended_by_user');
  });

  it('a socket that never drains: dropped past the soft limit and counted, ended send_backlog past the hard cap; the call never waits', async () => {
    const station = fakeStation('alaw8');
    const { mgr, pstn } = await bridged('voicelink', station);
    const stalled = fakeListenerSocket({ drains: false });
    const sink = socketSink(stalled, 'stalled');
    const handle = attach(mgr, sink);

    // Media alone stops at the soft limit: ~48 KiB / 163 bytes is about 300 messages.
    for (let i = 0; i < 500; i++) {
      pstn.media(bytes(160, i));
      station.sendBinaryUp(bytes(160, i + 1));
    }
    expect(stalled.bufferedAmount).toBeGreaterThan(LISTENER_LIMITS.mediaSoftLimitBytes);
    expect(stalled.bufferedAmount).toBeLessThan(LISTENER_LIMITS.mediaSoftLimitBytes + 200);
    const { framesSent, framesDropped } = handle.stats();
    expect(framesSent).toBe(stalled.got.length);
    expect(framesSent + framesDropped).toBe(1000);
    expect(framesDropped).toBeGreaterThan(600);
    expect(handle.attached).toBe(true);
    // The call's own sockets got every frame.
    expect(station.binary).toHaveLength(500);
    expect(pstn.audioFrames()).toBe(500);

    // What else is queued on it (its control frames) takes it past the cap: the next frame ends it.
    stalled.bufferedAmount = LISTENER_LIMITS.hardCapBytes! + 1;
    pstn.media(bytes(160, 7));
    expect(sink.closed).toEqual(['send_backlog']);
    expect(handle.attached).toBe(false);
    expect(station.binary).toHaveLength(501);
    await mgr.forceEndWithOutcome(ATTEMPT, 'ended_by_user');
  });
});

describe('the fault budget', () => {
  async function failingCustomer(budget: number, schedule: (n: number) => boolean) {
    cfg.agency.listen.faultBudget = budget;
    const station = fakeStation('pcm16');
    const { mgr, pstn, session } = await bridged('mulaw', station);
    let n = 0;
    const plivo = findCarrierModule('plivo')!.media.createCodec();
    codecs.next = {
      carrierToPcm16k: (b) => {
        if (schedule(n++)) throw new Error('bad frame');
        return plivo.carrierToPcm16k(b);
      },
      pcm16kToCarrier: (b) => b,
    };
    const s1 = recordingSink('l1');
    const s2 = recordingSink('l2');
    const h1 = attach(mgr, s1);
    const h2 = attach(mgr, s2);
    return { mgr, pstn, station, session, s1, s2, h1, h2 };
  }

  it('detaches at exactly N failed frames of one leg in a row: every listener ended tap_error, the call carries on', async () => {
    const { mgr, pstn, station, session, s1, s2, h1, h2 } = await failingCustomer(5, () => true);
    for (let i = 0; i < 4; i++) pstn.media(mulawFrame(i));
    // FALSIFIED by an off-by-one in the budget (detached at 4) or by never detaching.
    expect(h1.attached).toBe(true);
    expect(session.listenTap).not.toBeNull();
    pstn.media(mulawFrame(4));
    expect(s1.closed.map((c) => c.reason)).toEqual(['tap_error']);
    expect(s2.closed.map((c) => c.reason)).toEqual(['tap_error']);
    expect(s1.closed[0]!.stats).toEqual({ framesSent: 0, framesDropped: 5 });
    expect(h2.attached).toBe(false);
    expect(session.listenTap).toBeNull();
    expect(logSpy.error).toHaveBeenCalledWith(
      expect.objectContaining({ callId: CALL, listenIds: ['l1', 'l2'], failures: 5 }), expect.stringContaining('fault budget'),
    );
    // The call: every frame relayed before, during and after.
    for (let i = 5; i < 8; i++) pstn.media(mulawFrame(i));
    station.sendPcmUp(pcm16kTone(320));
    expect(station.sent.filter((m) => m.event === 'media')).toHaveLength(8);
    expect(pstn.audioFrames()).toBe(1);
    expect(s1.close).toHaveBeenCalledTimes(1);
    // A new listener gets a fresh tap.
    const again = recordingSink('l3');
    expect('refused' in mgr.openListenTap(CALL, again)).toBe(false);
    expect(session.listenTap).not.toBeNull();
    await mgr.forceEndWithOutcome(ATTEMPT, 'ended_by_user');
  });

  it('a frame that succeeds resets the run: N-1 failures, one success, N-1 failures stay attached', async () => {
    const { mgr, pstn, s1, h1 } = await failingCustomer(5, (n) => n !== 4);
    for (let i = 0; i < 9; i++) pstn.media(mulawFrame(i));
    // FALSIFIED by counting failures in total rather than in a row (9 failures pass 5).
    expect(h1.attached).toBe(true);
    expect(metrics.tapError).toHaveBeenCalledTimes(8);
    pstn.media(mulawFrame(9));
    expect(s1.closed.map((c) => c.reason)).toEqual(['tap_error']);
    await mgr.forceEndWithOutcome(ATTEMPT, 'ended_by_user');
  });

  it('the legs are counted apart: the agent`s good frames do not keep a dead customer leg alive', async () => {
    const { mgr, pstn, station, s1 } = await failingCustomer(3, () => true);
    for (let i = 0; i < 3; i++) {
      pstn.media(mulawFrame(i));
      station.sendPcmUp(pcm16kTone(320));
    }
    expect(s1.closed.map((c) => c.reason)).toEqual(['tap_error']);
    await mgr.forceEndWithOutcome(ATTEMPT, 'ended_by_user');
  });
});

// ── Lifecycle ─────────────────────────────────────────────────────────────────

describe('the tap`s lifecycle on the call', () => {
  it('the call`s end ends every listener call_ended, once, with what each was given', async () => {
    const station = fakeStation('alaw8');
    const { mgr, pstn, session } = await bridged('voicelink', station);
    const s1 = recordingSink('l1');
    const s2 = recordingSink('l2');
    attach(mgr, s1);
    const h2 = attach(mgr, s2);
    pstn.media(bytes(160, 1));
    h2.detach();
    pstn.media(bytes(160, 2));

    // A VoiceLink teardown we start waits for the carrier's confirmation: the listener stays on
    // (no frames come: the carrier's socket is closed) until the session is destroyed.
    await mgr.forceEndWithOutcome(ATTEMPT, 'ended_by_user');
    expect(session.ending).toBe(true);
    expect(s1.close).not.toHaveBeenCalled();
    await carrierEnded(mgr);
    expect(mgr.getSession(CALL)).toBeUndefined();
    expect(s1.closed).toEqual([{ reason: 'call_ended', stats: { framesSent: 2, framesDropped: 0 } }]);
    // Detached by its owner: never closed by the bridge.
    expect(s2.close).not.toHaveBeenCalled();
    expect(session.listenTap).toBeNull();
    session.destroy();
    expect(s1.close).toHaveBeenCalledTimes(1);
  });

  it('the agent`s re-attach keeps the tap: the customer heard throughout, the new socket`s format taken up', async () => {
    const stationA = fakeStation('alaw8');
    const { mgr, pstn, session } = await bridged('voicelink', stationA);
    const sink = recordingSink();
    attach(mgr, sink);
    const tap = session.listenTap;
    stationA.sendBinaryUp(bytes(160, 1));
    stationA.close();
    pstn.media(bytes(160, 2));

    const stationB = fakeStation('pcm16');
    expect(mgr.reattachBorrowedBrowserLeg(ATTEMPT, stationB as any)).toBe(true);
    // FALSIFIED by closing or replacing the tap at the attach.
    expect(session.listenTap).toBe(tap);
    expect(sink.close).not.toHaveBeenCalled();
    const agent = pcm16kTone(320);
    stationB.sendPcmUp(agent);
    pstn.media(bytes(160, 3));

    const enc = new VoicelinkTranscoder();
    expect(legAudio(sink, 'agent')).toEqual(Buffer.concat([bytes(160, 1), expectedAlaw([agent], (f) => enc.pcm16kToAlaw(f))]));
    expect(legAudio(sink, 'customer')).toEqual(Buffer.concat([bytes(160, 2), bytes(160, 3)]));
    await mgr.forceEndWithOutcome(ATTEMPT, 'ended_by_user');
  });
});

describe('openListenTap`s refusals', () => {
  it('not_found for a call this process does not bridge', () => {
    const mgr = new WebRtcBridgeManager(makeGuardHost() as any, null);
    expect(mgr.openListenTap('nope', recordingSink())).toEqual({ refused: 'not_found' });
  });

  it('not_bridged while the customer`s phone rings; listenable once bridged', async () => {
    const mgr = new WebRtcBridgeManager(makeGuardHost() as any, null);
    const station = fakeStation('alaw8');
    await mgr.createBridgedCall({ ...PARAMS, provider: 'voicelink', browserSocket: station as any });
    const sink = recordingSink();
    expect(mgr.openListenTap(CALL, sink)).toEqual({ refused: 'not_bridged' });
    // The carrier's socket is up but VoiceLink has not negotiated its media: still not bridged.
    const pstn = fakePstn();
    mgr.attachPstnLeg(CALL, pstn as any);
    expect(mgr.openListenTap(CALL, sink)).toEqual({ refused: 'not_bridged' });
    expect(mgr.getSession(CALL)!.listenTap).toBeNull();
    pstn.emit('message', JSON.stringify({
      event: 'start',
      start: { call_sid: 'c', stream_sid: 's', media_format: { encoding: 'audio/alaw', sample_rate: '8000' } },
    }));
    const handle = mgr.openListenTap(CALL, sink);
    expect(handle).toMatchObject({ callId: CALL, listenId: 'listen-1', attached: true });
    expect(sink.close).not.toHaveBeenCalled();
    await mgr.forceEndWithOutcome(ATTEMPT, 'ended_by_user');
  });

  it('ending once the call is settling, and not_found after', async () => {
    const station = fakeStation('alaw8');
    const { mgr } = await bridged('voicelink', station);
    // A VoiceLink hangup of ours: the session waits for the carrier's confirmation.
    await mgr.forceEndWithOutcome(ATTEMPT, 'ended_by_user');
    expect(mgr.getSession(CALL)!.isTearingDown).toBe(true);
    expect(mgr.openListenTap(CALL, recordingSink())).toEqual({ refused: 'ending' });
    await carrierEnded(mgr);
    expect(mgr.getSession(CALL)).toBeUndefined();
    expect(mgr.openListenTap(CALL, recordingSink())).toEqual({ refused: 'not_found' });
  });
});

// ── The tap on its own ─────────────────────────────────────────────────────────

describe('ListenTap', () => {
  const vlMedia = () => findCarrierModule('voicelink')!.media;

  it('a sink added to an ended tap is ended call_ended at once, its handle detached', () => {
    const tap = new ListenTap({ callId: 'c', carrierMedia: vlMedia(), faultBudget: 50, onIdle: () => {} });
    tap.end('call_ended');
    const sink = recordingSink();
    const handle = tap.addSink(sink);
    expect(handle.attached).toBe(false);
    expect(sink.closed.map((c) => c.reason)).toEqual(['call_ended']);
    tap.feedCustomer(bytes(160).toString('base64'));
    expect(sink.messages).toHaveLength(0);
  });

  it('onIdle is called once, when the last sink goes; a throwing onIdle is contained', () => {
    const onIdle = vi.fn(() => { throw new Error('idle'); });
    const tap = new ListenTap({ callId: 'c', carrierMedia: vlMedia(), faultBudget: 50, onIdle });
    const h1 = tap.addSink(recordingSink('a'));
    const h2 = tap.addSink(recordingSink('b'));
    h1.detach();
    expect(onIdle).not.toHaveBeenCalled();
    expect(() => h2.detach()).not.toThrow();
    h2.detach();
    tap.end('call_ended');
    expect(onIdle).toHaveBeenCalledTimes(1);
    expect(tap.isEnded).toBe(true);
  });

  it('a sink that detaches itself from inside send: the other sinks still get the frame', () => {
    const tap = new ListenTap({ callId: 'c', carrierMedia: vlMedia(), faultBudget: 50, onIdle: () => {} });
    let h1!: ListenTapHandle;
    const s1 = recordingSink('a', () => { h1.detach(); return 'sent'; });
    const s2 = recordingSink('b');
    h1 = tap.addSink(s1);
    tap.addSink(s2);
    tap.feedAgentAlaw(bytes(320));
    expect(s1.messages).toHaveLength(1);
    expect(s2.messages).toHaveLength(2);
  });

  it('a sink answering outside its contract is treated as gone', () => {
    const tap = new ListenTap({ callId: 'c', carrierMedia: vlMedia(), faultBudget: 50, onIdle: () => {} });
    const sink = recordingSink('a', () => 'weird' as never);
    tap.addSink(sink);
    tap.feedAgentAlaw(bytes(160));
    expect(sink.closed.map((c) => c.reason)).toEqual(['listener_disconnected']);
  });

  it('a frame step that throws is counted `frame` and contained', () => {
    const tap = new ListenTap({ callId: 'c', carrierMedia: vlMedia(), faultBudget: 2, onIdle: () => {} });
    const sink = recordingSink();
    tap.addSink(sink);
    vi.spyOn(AlawFramer.prototype, 'push').mockImplementation(() => { throw new Error('frame'); });
    expect(() => tap.feedAgentAlaw(bytes(160))).not.toThrow();
    expect(metrics.tapError).toHaveBeenCalledWith('frame');
    expect(() => tap.feedCustomer(bytes(160).toString('base64'))).not.toThrow();
    expect(sink.close).not.toHaveBeenCalled();
    expect(() => tap.feedAgentAlaw(bytes(160))).not.toThrow();
    expect(sink.closed.map((c) => c.reason)).toEqual(['tap_error']);
  });

  it('sendToListenerSocket: sent, dropped past the soft limit, backlog past the cap, closed when not open or when send throws', () => {
    const ws = fakeListenerSocket();
    const m = Buffer.alloc(161);
    expect(sendToListenerSocket(ws as never, m)).toBe('sent');
    expect(ws.got[0]).toBe(m);
    ws.bufferedAmount = LISTENER_LIMITS.mediaSoftLimitBytes + 1;
    expect(sendToListenerSocket(ws as never, m)).toBe('dropped');
    ws.bufferedAmount = LISTENER_LIMITS.hardCapBytes! + 1;
    expect(sendToListenerSocket(ws as never, m)).toBe('backlog');
    ws.bufferedAmount = 0;
    ws.readyState = 2;
    expect(sendToListenerSocket(ws as never, m)).toBe('closed');
    const throwing = fakeListenerSocket({ throwOnSend: 1 });
    expect(sendToListenerSocket(throwing as never, m)).toBe('closed');
    expect(metrics.tapError).toHaveBeenCalledWith('send');
    expect(metrics.backpressure.mock.calls).toEqual([['listener', 'media_dropped'], ['listener', 'closed']]);
  });
});
