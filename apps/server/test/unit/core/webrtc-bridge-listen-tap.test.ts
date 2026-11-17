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
    // No `agency` block: the bridge reads no agency config; the tap's budget comes through the
    // seam (`openListenTap`'s options, LS22 j). A read of `config.agency` would throw here.
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
  // `generic`: the same, declaring no G.711 law (`wireFormat: null`), so the tap takes the customer
  // through its own carrier codec and A-law encoder, as it would for any other carrier.
  const generic = { ...mulaw, name: 'generic', media: { ...mulaw.media, wireFormat: null } };
  const fakes: Record<string, unknown> = { mulaw, generic };
  return { ...actual, findCarrierModule: (p: string) => fakes[p] ?? actual.findCarrierModule(p) };
});
vi.mock('../../../src/core/webhook-url-builder.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/core/webhook-url-builder.js')>();
  class WebhookUrlBuilder extends actual.WebhookUrlBuilder {
    override baseUrl(p: string): string {
      return p === 'mulaw' || p === 'generic' ? `https://server.test/api/v1/webhooks/${p}` : super.baseUrl(p);
    }
  }
  return { ...actual, WebhookUrlBuilder };
});

import { WebRtcBridgeManager, type ListenSendResult, type ListenSink, type ListenTapHandle } from '../../../src/core/webrtc-bridge-manager.js';
import { AlawFramer, setBrowserLegMediaFormat, type BrowserLegMediaFormat } from '../../../src/core/bridge/browser-leg-media.js';
import { LISTEN_TAP_DEFAULT_FAULT_BUDGET, ListenTap, MULAW_TO_ALAW, sendToListenerSocket } from '../../../src/core/bridge/listen-tap.js';
import { findCarrierModule } from '../../../src/telephony/carrier-modules.js';
import { MulawTranscoder, VoicelinkTranscoder } from '../../../src/utils/audio-fir.js';
import { alawDecodeTable, alawEncodeTable, decodeMulaw, encodeMulaw } from '../../../src/utils/audio.js';
import { LISTENER_LIMITS, LISTENER_SOFT_LIMIT_MAX_MS, MediaDropRun } from '../../../src/utils/ws-backpressure.js';
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
    /** The socket's own run of drops, as the listener's sink holds it. */
    drops: new MediaDropRun(LISTENER_LIMITS),
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
    send: (m) => sendToListenerSocket(ws as never, m, ws.drops),
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
async function bridged(provider: 'voicelink' | 'mulaw' | 'generic', station: ReturnType<typeof fakeStation>) {
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

/** The fault budget `attach` passes through the seam, as the agency's listener socket does. */
let tapBudget = 50;

function attach(mgr: WebRtcBridgeManager, sink: ListenSink): ListenTapHandle {
  const handle = mgr.openListenTap(CALL, sink, { faultBudget: tapBudget });
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

/** A-law for a sample of 0: what a transcoded leg's first output is led by. */
const ALAW_SILENCE = alawEncodeTable[32768]!;

/**
 * As {@link expectedAlaw}, for a transcoded leg: its first output is led by A-law silence up to a
 * whole frame (the tap's priming, so its framer carries nothing after).
 */
function expectedPrimedAlaw(frames: Buffer[], pipeline: (b: Buffer) => Buffer): Buffer {
  let primed = false;
  return expectedAlaw(frames, (f) => {
    const out = pipeline(f);
    if (primed || out.length === 0) return out;
    primed = true;
    const lead = (160 - (out.length % 160)) % 160;
    return Buffer.concat([Buffer.alloc(lead, ALAW_SILENCE), out]);
  });
}

/** μ-law frames mapped to A-law one byte at a time, as the tap's table does. */
const tableAlaw = (frames: Buffer[]) => Buffer.from(Buffer.concat(frames).map((b) => MULAW_TO_ALAW[b]!));

beforeEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  codecs.made.length = 0;
  codecs.next = null;
  tapBudget = 50;
  mockRepo.update.mockResolvedValue(null);
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
  it('a μ-law customer (Plivo): mapped to A-law by table, one frame out per frame in; no codec of the tap`s; the session codec once per frame', async () => {
    const station = fakeStation('pcm16');
    const { mgr, pstn, session } = await bridged('mulaw', station);
    expect(codecs.made).toHaveLength(1);
    const sessionCodec = codecs.made[0]!;
    expect(session.codec).toBe(sessionCodec);
    const sink = recordingSink();
    attach(mgr, sink);
    // Both 8 kHz: no resampling, so the tap makes no codec (LS17).
    expect(codecs.made).toHaveLength(1);

    const frames = Array.from({ length: 10 }, (_, i) => mulawFrame(i));
    for (let i = 0; i < frames.length; i++) {
      pstn.media(frames[i]!);
      // FALSIFIED by the codec path (its first output is 144 bytes: nothing yet, then a carry).
      expect(legCount(sink, 'customer')).toBe(i + 1);
    }
    expect(sessionCodec.carrierToPcm16k).toHaveBeenCalledTimes(frames.length);
    expect(legAudio(sink, 'customer')).toEqual(tableAlaw(frames));
    // The agent still got every frame, as PCM16 from the session's codec.
    expect(station.sent.filter((m) => m.event === 'media')).toHaveLength(frames.length);
    await mgr.forceEndWithOutcome(ATTEMPT, 'ended_by_user');
  });

  it('a carrier with no G.711 law: the tap`s own carrier codec and A-law encoder, primed to run carry-free; the session codec once per frame', async () => {
    const station = fakeStation('pcm16');
    const { mgr, pstn, session } = await bridged('generic', station);
    const sessionCodec = codecs.made[0]!;
    expect(session.codec).toBe(sessionCodec);
    const sink = recordingSink();
    attach(mgr, sink);
    // The tap made its own codec; the session's is not shared.
    expect(codecs.made).toHaveLength(2);
    const tapCodec = codecs.made[1]!;

    const frames = Array.from({ length: 10 }, (_, i) => mulawFrame(i));
    for (let i = 0; i < frames.length; i++) {
      pstn.media(frames[i]!);
      // FALSIFIED by an unprimed framer: the first frame's 144 bytes wait, and every later one carries.
      expect(legCount(sink, 'customer')).toBe(i + 1);
    }

    // FALSIFIED by feeding the tap from the session's codec: the session codec is called twice per
    // frame, and its FIR history is shared, so the bytes below differ from a fresh pipeline's.
    expect(sessionCodec.carrierToPcm16k).toHaveBeenCalledTimes(frames.length);
    expect(tapCodec.carrierToPcm16k).toHaveBeenCalledTimes(frames.length);
    const plivo = findCarrierModule('plivo')!.media.createCodec();
    const enc = new VoicelinkTranscoder();
    expect(legAudio(sink, 'customer')).toEqual(expectedPrimedAlaw(frames, (f) => enc.pcm16kToAlaw(plivo.carrierToPcm16k(f))));
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
    for (let i = 0; i < frames.length; i++) {
      station.sendPcmUp(frames[i]!);
      // FALSIFIED by an unprimed framer: the first 20 ms gives 152 bytes, held back, and every
      // later frame carries 152 (a frame late, two allocations).
      expect(legCount(sink, 'agent')).toBe(i + 1);
    }

    expect(sessionCodec.pcm16kToCarrier).toHaveBeenCalledTimes(frames.length);
    expect(codecs.made).toHaveLength(1);
    const enc = new VoicelinkTranscoder();
    const want = expectedPrimedAlaw(frames, (f) => enc.pcm16kToAlaw(f));
    expect(legAudio(sink, 'agent')).toEqual(want);
    // Led by 8 bytes (1 ms) of silence, then the encoder's output unchanged.
    expect(want.subarray(0, 8)).toEqual(Buffer.alloc(8, ALAW_SILENCE));
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
    expect(legAudio(sink, 'agent')).toEqual(expectedPrimedAlaw([agent], (f) => enc.pcm16kToAlaw(f)));
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
  it('LISTENER_LIMITS: soft 48 KiB, hard 256 KiB, 10 s of drops', () => {
    expect(LISTENER_LIMITS).toEqual({ mediaSoftLimitBytes: 48 * 1024, hardCapBytes: 256 * 1024, softLimitMaxMs: 10_000 });
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

describe('a listener held past the soft limit', () => {
  it('LISTENER_SOFT_LIMIT_MAX_MS is 10 s', () => {
    expect(LISTENER_SOFT_LIMIT_MAX_MS).toBe(10_000);
  });

  it('MediaDropRun: true on the drop that ends softLimitMaxMs of drops, then starts over; a send ends the run; no bound without softLimitMaxMs', () => {
    let now = 2_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    expect(LISTENER_LIMITS.softLimitMaxMs).toBe(LISTENER_SOFT_LIMIT_MAX_MS);
    const run = new MediaDropRun({ softLimitMaxMs: 100 });
    expect(run.dropped()).toBe(false);
    now += 99;
    expect(run.dropped()).toBe(false);
    run.sent();
    now += 1;
    expect(run.dropped()).toBe(false);
    now += 100;
    expect(run.dropped()).toBe(true);
    expect(run.dropped()).toBe(false);
    const unbounded = new MediaDropRun({});
    expect(unbounded.dropped()).toBe(false);
    now += 1e9;
    expect(unbounded.dropped()).toBe(false);
  });

  it('sendToListenerSocket: dropped continuously for 10 s answers backlog (counted dropped and closed); a frame sent in between starts the clock again', () => {
    let now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const ws = fakeListenerSocket();
    const m = Buffer.alloc(161);
    ws.bufferedAmount = LISTENER_LIMITS.mediaSoftLimitBytes + 1;
    expect(sendToListenerSocket(ws as never, m, ws.drops)).toBe('dropped');
    now += LISTENER_SOFT_LIMIT_MAX_MS - 1;
    expect(sendToListenerSocket(ws as never, m, ws.drops)).toBe('dropped');
    // It read a little: one frame goes, and the 10 s start again from the next drop.
    ws.bufferedAmount = 0;
    expect(sendToListenerSocket(ws as never, m, ws.drops)).toBe('sent');
    ws.bufferedAmount = LISTENER_LIMITS.mediaSoftLimitBytes + 1;
    now += 1;
    expect(sendToListenerSocket(ws as never, m, ws.drops)).toBe('dropped');
    now += LISTENER_SOFT_LIMIT_MAX_MS - 1;
    expect(sendToListenerSocket(ws as never, m, ws.drops)).toBe('dropped');
    now += 1;
    // FALSIFIED by no time bound (a reader that pings but never drains is never ended: media
    // stops at the soft limit, so the hard cap is out of its reach).
    expect(sendToListenerSocket(ws as never, m, ws.drops)).toBe('backlog');
    expect(metrics.backpressure.mock.calls.filter((c) => c[1] === 'closed')).toEqual([['listener', 'closed']]);
    expect(metrics.backpressure.mock.calls.filter((c) => c[1] === 'media_dropped')).toHaveLength(5);
    // Another socket keeps its own clock.
    const other = fakeListenerSocket();
    other.bufferedAmount = LISTENER_LIMITS.mediaSoftLimitBytes + 1;
    expect(sendToListenerSocket(other as never, m, other.drops)).toBe('dropped');
  });

  it('through the tap: a listener that never drains is ended send_backlog 10 s after its first dropped frame; its row`s drops equal the counter`s; the call and the other listener carry on', async () => {
    let now = 5_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const station = fakeStation('alaw8');
    const { mgr, pstn } = await bridged('voicelink', station);
    const stalled = fakeListenerSocket({ drains: false });
    const sink = socketSink(stalled, 'stalled');
    const handle = attach(mgr, sink);
    const fine = recordingSink('fine');
    attach(mgr, fine);

    // 20 ms a frame per leg, as the call sends them.
    let sent = 0;
    for (; handle.attached && sent < 5000; sent++) {
      pstn.media(bytes(160, sent));
      station.sendBinaryUp(bytes(160, sent + 1));
      now += 20;
    }
    expect(sink.closed).toEqual(['send_backlog']);
    const dropped = metrics.backpressure.mock.calls.filter((c) => c[1] === 'media_dropped').length;
    // ~48 KiB is ~300 messages (3 s of both legs); then 10 s of drops.
    expect(sent * 20).toBeGreaterThan(LISTENER_SOFT_LIMIT_MAX_MS);
    expect(sent * 20).toBeLessThan(LISTENER_SOFT_LIMIT_MAX_MS + 5_000);
    expect(sink.closed).toHaveLength(1);
    expect(handle.stats().framesDropped).toBe(dropped);
    expect(metrics.backpressure.mock.calls.filter((c) => c[1] === 'closed')).toEqual([['listener', 'closed']]);
    expect(fine.messages).toHaveLength(2 * sent);
    expect(station.binary).toHaveLength(sent);
    expect(pstn.audioFrames()).toBe(sent);
    await mgr.forceEndWithOutcome(ATTEMPT, 'ended_by_user');
  });
});

describe('a failed message counts its 20 ms frames', () => {
  const vlMedia = () => findCarrierModule('voicelink')!.media;

  it('a failed 1 s agent message is 50 frames dropped, and reaches a budget of 50 alone; a failed 60 ms carrier frame is 3', () => {
    const run = (budget: number) => {
      const tap = new ListenTap({ callId: 'c', carrierMedia: vlMedia(), faultBudget: budget, onIdle: () => {} });
      const sink = recordingSink();
      const handle = tap.addSink(sink);
      return { tap, sink, handle };
    };
    vi.spyOn(AlawFramer.prototype, 'push').mockImplementation(() => { throw new Error('frame'); });
    const a = run(51);
    a.tap.feedCustomer(bytes(480).toString('base64'));
    // FALSIFIED by counting a failed message as one frame.
    expect(a.handle.stats()).toEqual({ framesSent: 0, framesDropped: 3 });
    a.tap.feedAgentAlaw(bytes(8000));
    expect(a.handle.stats()).toEqual({ framesSent: 0, framesDropped: 53 });
    expect(a.handle.attached).toBe(true);
    a.tap.feedAgentAlaw(bytes(160));
    expect(a.sink.closed).toEqual([{ reason: 'tap_error', stats: { framesSent: 0, framesDropped: 54 } }]);

    const b = run(50);
    b.tap.feedAgentAlaw(bytes(8000));
    expect(b.sink.closed).toEqual([{ reason: 'tap_error', stats: { framesSent: 0, framesDropped: 50 } }]);
  });

  it('a failed pcm16 frame of 20 ms is one frame', () => {
    const tap = new ListenTap({ callId: 'c', carrierMedia: vlMedia(), faultBudget: 50, onIdle: () => {} });
    const sink = recordingSink();
    const handle = tap.addSink(sink);
    vi.spyOn(VoicelinkTranscoder.prototype, 'pcm16kToAlaw').mockImplementation(() => { throw new Error('encode'); });
    tap.feedAgentPcm16(pcm16kTone(320).toString('base64'));
    expect(handle.stats().framesDropped).toBe(1);
    tap.feedAgentPcm16(pcm16kTone(960).toString('base64'));
    expect(handle.stats().framesDropped).toBe(4);
  });
});

// ── Fault injection ───────────────────────────────────────────────────────────

describe('fault injection: nothing about a listener reaches the call', () => {
  it('a throwing codec: frames dropped and counted `decode`, both legs relayed, nothing thrown out of the socket handler', async () => {
    const station = fakeStation('pcm16');
    const { mgr, pstn } = await bridged('generic', station);
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
    tapBudget = budget;
    const station = fakeStation('pcm16');
    const { mgr, pstn, session } = await bridged('generic', station);
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

  it('LS22 j: the budget is the caller\'s, through the seam; with none the tap takes LISTEN_TAP_DEFAULT_FAULT_BUDGET', async () => {
    expect(LISTEN_TAP_DEFAULT_FAULT_BUDGET).toBe(50);
    const station = fakeStation('pcm16');
    const { mgr, pstn } = await bridged('generic', station);
    codecs.next = { carrierToPcm16k: () => { throw new Error('bad frame'); }, pcm16kToCarrier: (b) => b };
    const sink = recordingSink('l1');
    const handle = mgr.openListenTap(CALL, sink);
    if ('refused' in handle) throw new Error('refused');
    for (let i = 0; i < 49; i++) pstn.media(mulawFrame(i));
    expect(handle.attached).toBe(true);
    pstn.media(mulawFrame(49));
    expect(sink.closed.map((c) => c.reason)).toEqual(['tap_error']);
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
  it('the call`s end ends every listener call_ended, once, with what each was given, as the hangup starts', async () => {
    const station = fakeStation('alaw8');
    const { mgr, pstn, session } = await bridged('voicelink', station);
    const s1 = recordingSink('l1');
    const s2 = recordingSink('l2');
    attach(mgr, s1);
    const h2 = attach(mgr, s2);
    pstn.media(bytes(160, 1));
    h2.detach();
    pstn.media(bytes(160, 2));

    // A VoiceLink teardown we start waits for the carrier's confirmation (`ending`); the listener
    // is ended as it starts, not when the session is destroyed (LS15 f).
    await mgr.forceEndWithOutcome(ATTEMPT, 'ended_by_user');
    expect(session.ending).toBe(true);
    expect(s1.closed).toEqual([{ reason: 'call_ended', stats: { framesSent: 2, framesDropped: 0 } }]);
    expect(session.listenTap).toBeNull();
    await carrierEnded(mgr);
    expect(mgr.getSession(CALL)).toBeUndefined();
    // Detached by its owner: never closed by the bridge.
    expect(s2.close).not.toHaveBeenCalled();
    session.destroy();
    expect(s1.close).toHaveBeenCalledTimes(1);
  });

  for (const format of ['alaw8', 'pcm16'] as const) {
    it(`after a VoiceLink hangup of ours (an ${format} agent), nothing the agent or the carrier sends reaches a listener`, async () => {
      const station = fakeStation(format);
      const { mgr, pstn, session } = await bridged('voicelink', station);
      const sink = recordingSink();
      attach(mgr, sink);
      const agentSays = () => (format === 'alaw8' ? station.sendBinaryUp(bytes(160, 5)) : station.sendPcmUp(pcm16kTone(320)));
      for (let i = 0; i < 2; i++) {
        agentSays();
        pstn.media(bytes(160, 6));
      }
      const before = sink.messages.length;
      expect(legCount(sink, 'agent')).toBeGreaterThan(0);
      expect(legCount(sink, 'customer')).toBeGreaterThan(0);

      // The agent hangs up; the carrier's confirmation is up to 45 s away. FALSIFIED by feeding the
      // tap while `ending` (the supervisor would hear the agent's microphone after the hangup).
      await mgr.forceEndWithOutcome(ATTEMPT, 'ended_by_user');
      expect(session.isTearingDown).toBe(true);
      for (let i = 0; i < 5; i++) {
        agentSays();
        pstn.media(bytes(160, 7 + i));
      }
      expect(sink.messages).toHaveLength(before);
      expect(sink.closed.map((c) => c.reason)).toEqual(['call_ended']);
      expect(session.listenTap).toBeNull();
      await carrierEnded(mgr);
      expect(sink.close).toHaveBeenCalledTimes(1);
    });
  }

  for (const [what, end] of [
    ['a hangup of ours (a carrier with a hangup API)', (mgr: WebRtcBridgeManager) => mgr.forceEndWithOutcome(ATTEMPT, 'ended_by_user')],
    ['the carrier`s stop', (_mgr: WebRtcBridgeManager, pstn: ReturnType<typeof fakePstn>) => {
      pstn.emit('message', JSON.stringify({ event: 'stop' }));
      return Promise.resolve();
    }],
  ] as const) {
    it(`in the terminal teardown's await window after ${what}, nothing reaches a listener`, async () => {
      const station = fakeStation('pcm16');
      const { mgr, pstn, session } = await bridged('mulaw', station);
      const sink = recordingSink();
      attach(mgr, sink);
      for (let i = 0; i < 2; i++) {
        pstn.media(mulawFrame(i));
        station.sendPcmUp(pcm16kTone(320, i * 320));
      }
      const before = sink.messages.length;
      expect(legCount(sink, 'agent')).toBeGreaterThan(0);
      expect(legCount(sink, 'customer')).toBeGreaterThan(0);

      // The terminal row's write is held: endCall has claimed the call and is awaiting it.
      let release: (() => void) | undefined;
      mockRepo.update.mockImplementation(() => new Promise((r) => { release = () => r(null); }));
      const ending = end(mgr, pstn);
      try {
        await vi.waitFor(() => expect(release).toBeDefined());
        expect(session.endHandled).toBe(true);
        expect(mgr.getSession(CALL)).toBe(session);
        // FALSIFIED by ending the tap only at destroy(): these would reach the listener.
        for (let i = 2; i < 5; i++) {
          station.sendPcmUp(pcm16kTone(320, i * 320));
          pstn.media(mulawFrame(i));
        }
        expect(sink.messages).toHaveLength(before);
        expect(sink.closed.map((c) => c.reason)).toEqual(['call_ended']);
      } finally {
        mockRepo.update.mockResolvedValue(null);
        release?.();
      }
      await ending;
      await vi.waitFor(() => expect(mgr.getSession(CALL)).toBeUndefined());
      expect(sink.close).toHaveBeenCalledTimes(1);
    });
  }

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
    expect(legAudio(sink, 'agent')).toEqual(Buffer.concat([bytes(160, 1), expectedPrimedAlaw([agent], (f) => enc.pcm16kToAlaw(f))]));
    expect(legAudio(sink, 'customer')).toEqual(Buffer.concat([bytes(160, 2), bytes(160, 3)]));
    await mgr.forceEndWithOutcome(ATTEMPT, 'ended_by_user');
  });
});

describe('the agent`s re-attach starts its leg afresh', () => {
  it('pcm16 → pcm16 with a tail held back: after the re-attach the agent is heard as a fresh pipeline would give it', async () => {
    const stationA = fakeStation('pcm16');
    const { mgr, pstn, session } = await bridged('voicelink', stationA);
    const sink = recordingSink();
    attach(mgr, sink);
    // 20 ms, then 6.25 ms: the second leaves a 50-byte tail in the framer and history in the encoder.
    stationA.sendPcmUp(pcm16kTone(320));
    stationA.sendPcmUp(pcm16kTone(100, 320));
    const beforeA = legCount(sink, 'agent');
    expect(beforeA).toBe(1);
    stationA.close();

    const stationB = fakeStation('pcm16');
    expect(mgr.reattachBorrowedBrowserLeg(ATTEMPT, stationB as any)).toBe(true);
    expect(session.listenTap).not.toBeNull();
    const framesB = Array.from({ length: 6 }, (_, i) => pcm16kTone(320, 5000 + i * 320));
    for (const f of framesB) stationB.sendPcmUp(f);
    pstn.media(bytes(160, 3));

    // FALSIFIED by a re-attach that keeps the tail, the encoder's history or the priming: the
    // new socket's audio would start with the old one's tail and be filtered against its samples.
    const enc = new VoicelinkTranscoder();
    const after = Buffer.concat(sink.messages.filter((m) => m[0] === AGENCY_LISTEN_LEG.agent).slice(beforeA).map((m) => m.subarray(1)));
    expect(after).toEqual(expectedPrimedAlaw(framesB, (f) => enc.pcm16kToAlaw(f)));
    expect(legCount(sink, 'agent') - beforeA).toBe(framesB.length);
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

/**
 * G.711's μ-law to A-law conversion table, all 256 codes as transmitted (index: the μ-law byte),
 * written out as literals rather than computed, so the guard shares no code with the table it
 * checks.
 */
const G711_MULAW_TO_ALAW = [
  0x2a, 0x2b, 0x28, 0x29, 0x2e, 0x2f, 0x2c, 0x2d, 0x22, 0x23, 0x20, 0x21, 0x26, 0x27, 0x24, 0x25,
  0x3a, 0x3b, 0x38, 0x39, 0x3e, 0x3f, 0x3c, 0x3d, 0x32, 0x33, 0x30, 0x31, 0x36, 0x37, 0x34, 0x35,
  0x0a, 0x0b, 0x08, 0x09, 0x0e, 0x0f, 0x0c, 0x0d, 0x02, 0x03, 0x00, 0x01, 0x06, 0x07, 0x04, 0x1a,
  0x1b, 0x18, 0x19, 0x1e, 0x1f, 0x1c, 0x1d, 0x12, 0x13, 0x10, 0x11, 0x16, 0x17, 0x14, 0x15, 0x6a,
  0x68, 0x69, 0x6e, 0x6f, 0x6c, 0x6d, 0x62, 0x63, 0x60, 0x61, 0x66, 0x67, 0x64, 0x65, 0x7a, 0x78,
  0x7e, 0x7f, 0x7c, 0x7d, 0x72, 0x73, 0x70, 0x71, 0x76, 0x77, 0x74, 0x75, 0x4b, 0x49, 0x4f, 0x4d,
  0x42, 0x43, 0x40, 0x41, 0x46, 0x47, 0x44, 0x45, 0x5a, 0x5b, 0x58, 0x59, 0x5e, 0x5f, 0x5c, 0x5d,
  0x52, 0x52, 0x53, 0x53, 0x50, 0x50, 0x51, 0x51, 0x56, 0x56, 0x57, 0x57, 0x54, 0x54, 0x55, 0x55,
  0xaa, 0xab, 0xa8, 0xa9, 0xae, 0xaf, 0xac, 0xad, 0xa2, 0xa3, 0xa0, 0xa1, 0xa6, 0xa7, 0xa4, 0xa5,
  0xba, 0xbb, 0xb8, 0xb9, 0xbe, 0xbf, 0xbc, 0xbd, 0xb2, 0xb3, 0xb0, 0xb1, 0xb6, 0xb7, 0xb4, 0xb5,
  0x8a, 0x8b, 0x88, 0x89, 0x8e, 0x8f, 0x8c, 0x8d, 0x82, 0x83, 0x80, 0x81, 0x86, 0x87, 0x84, 0x9a,
  0x9b, 0x98, 0x99, 0x9e, 0x9f, 0x9c, 0x9d, 0x92, 0x93, 0x90, 0x91, 0x96, 0x97, 0x94, 0x95, 0xea,
  0xe8, 0xe9, 0xee, 0xef, 0xec, 0xed, 0xe2, 0xe3, 0xe0, 0xe1, 0xe6, 0xe7, 0xe4, 0xe5, 0xfa, 0xf8,
  0xfe, 0xff, 0xfc, 0xfd, 0xf2, 0xf3, 0xf0, 0xf1, 0xf6, 0xf7, 0xf4, 0xf5, 0xcb, 0xc9, 0xcf, 0xcd,
  0xc2, 0xc3, 0xc0, 0xc1, 0xc6, 0xc7, 0xc4, 0xc5, 0xda, 0xdb, 0xd8, 0xd9, 0xde, 0xdf, 0xdc, 0xdd,
  0xd2, 0xd2, 0xd3, 0xd3, 0xd0, 0xd0, 0xd1, 0xd1, 0xd6, 0xd6, 0xd7, 0xd7, 0xd4, 0xd4, 0xd5, 0xd5,
];


/**
 * The codes where the tap's table (each μ-law code decoded to 16-bit linear and re-encoded as
 * A-law, as the bridge's own μ-law path does for the agent) is one quantisation step from G.711's
 * table: G.711 scales the two laws to the same overload point, a 16-bit decode puts μ-law at
 * exactly half A-law's scale, and the codes on an A-law decision boundary fall the other way. 0x7F
 * is μ-law's negative zero, which G.711 keeps negative (0x55) and a linear 0 cannot (0xD5).
 */
const STEP_FROM_G711 = [
  0x20, 0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, 0x29, 0x2a, 0x2b, 0x2c, 0x2d, 0x2e, 0x3f, 0x4e, 0x4f,
  0x71, 0x73, 0x75, 0x77, 0x79, 0x7b, 0x7d, 0x7f,
  0xa0, 0xa1, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xab, 0xac, 0xad, 0xae, 0xbf, 0xce, 0xcf,
];

/** An A-law code's linear value, from its bits (sign, segment, mantissa), not the bridge's decoder. */
const alawLinear = (code: number) => {
  const a = code ^ 0x55;
  const seg = (a >> 4) & 0x07;
  const mant = a & 0x0f;
  const mag = seg === 0 ? (mant << 4) + 8 : ((mant << 4) + 0x108) << (seg - 1);
  return (a & 0x80) !== 0 ? mag : -mag;
};

describe('the μ-law customer`s table (LS17)', () => {
  it('is G.711\'s μ-law to A-law table on every code but 44, each of those one A-law step away', () => {
    expect(MULAW_TO_ALAW).toHaveLength(256);
    const off: number[] = [];
    for (let mu = 0; mu < 256; mu++) {
      const ours = MULAW_TO_ALAW[mu]!;
      const g711 = G711_MULAW_TO_ALAW[mu]!;
      if (ours === g711) continue;
      off.push(mu);
      if (mu === 0x7f) continue; // the sign of zero: ±8, one step through zero
      // Same sign and segment, the neighbouring mantissa: one quantisation step.
      expect((ours ^ g711) & 0xf0, `0x${mu.toString(16)}`).toBe(0);
      const step = Math.abs(alawLinear(ours) - alawLinear(g711));
      const seg = ((ours ^ 0x55) >> 4) & 0x07;
      expect(step, `0x${mu.toString(16)}`).toBe(seg === 0 ? 16 : 16 << (seg - 1));
    }
    expect(off).toEqual(STEP_FROM_G711);
    expect([MULAW_TO_ALAW[0x7f], G711_MULAW_TO_ALAW[0x7f]]).toEqual([0xd5, 0x55]);
  });

  it('known pairs, as literals', () => {
    const pairs: Array<[number, number]> = [
      [0xff, 0xd5], [0x7e, 0x55], // the quietest codes
      [0x00, 0x2a], [0x80, 0xaa], [0x01, 0x2b], // the loudest codes
      [0x10, 0x3a], [0x90, 0xba], [0x40, 0x68], [0xc0, 0xe8],
      [0x20, 0x0b], [0xa0, 0x8b], // a step from G.711's 0x0a and 0x8a
    ];
    for (const [mu, a] of pairs) expect(MULAW_TO_ALAW[mu], `0x${mu.toString(16)}`).toBe(a);
  });

  it('is at least as faithful as the codec path it replaces: no resampling, so nothing filtered near 4 kHz', () => {
    // Against the μ-law the caller sent (decoded): the table's A-law and the codec path's A-law
    // (μ-law → PCM16 16 kHz → A-law 8 kHz, both FIR), aligned sample for sample.
    const snr = (ref: Int16Array, alaw: Buffer) => {
      let sig = 0;
      let err = 0;
      for (let k = 400; k < alaw.length - 400; k++) {
        const x = ref[k]!;
        sig += x * x;
        err += (x - alawDecodeTable[alaw[k]!]!) ** 2;
      }
      return 10 * Math.log10(sig / err);
    };
    for (const hz of [300, 1000, 3000, 3400]) {
      for (const amp of [500, 8000]) {
        const n = 160 * 50;
        const pcm = new Int16Array(n);
        for (let k = 0; k < n; k++) pcm[k] = Math.round(amp * Math.sin((2 * Math.PI * hz * k) / 8000));
        const mulaw = encodeMulaw(pcm);
        const ref = decodeMulaw(mulaw);
        const table = Buffer.from(mulaw.map((b) => MULAW_TO_ALAW[b]!));
        const codec = new MulawTranscoder();
        const enc = new VoicelinkTranscoder();
        const parts: Buffer[] = [];
        for (let k = 0; k < n; k += 160) parts.push(enc.pcm16kToAlaw(codec.mulawToPcm16k(mulaw.subarray(k, k + 160))));
        const viaCodec = Buffer.concat(parts);
        const ctx = `${hz} Hz at ${amp}`;
        // A-law's own quantisation is the floor: ~34-38 dB on these tones.
        expect(snr(ref, table), ctx).toBeGreaterThan(33);
        expect(snr(ref, table), ctx).toBeGreaterThanOrEqual(snr(ref, viaCodec) - 0.05);
      }
    }
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
    expect(sendToListenerSocket(ws as never, m, ws.drops)).toBe('sent');
    expect(ws.got[0]).toBe(m);
    ws.bufferedAmount = LISTENER_LIMITS.mediaSoftLimitBytes + 1;
    expect(sendToListenerSocket(ws as never, m, ws.drops)).toBe('dropped');
    ws.bufferedAmount = LISTENER_LIMITS.hardCapBytes! + 1;
    expect(sendToListenerSocket(ws as never, m, ws.drops)).toBe('backlog');
    ws.bufferedAmount = 0;
    ws.readyState = 2;
    expect(sendToListenerSocket(ws as never, m, ws.drops)).toBe('closed');
    const throwing = fakeListenerSocket({ throwOnSend: 1 });
    expect(sendToListenerSocket(throwing as never, m, throwing.drops)).toBe('closed');
    expect(metrics.tapError).toHaveBeenCalledWith('send');
    expect(metrics.backpressure.mock.calls).toEqual([['listener', 'media_dropped'], ['listener', 'closed']]);
  });
});
