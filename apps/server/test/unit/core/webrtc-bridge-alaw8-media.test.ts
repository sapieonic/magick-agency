import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// The `alaw8` browser leg (contracts `AgencyStationMediaFormat`): binary frames of raw
// A-law 8 kHz on the station socket, both ways.
//
// What is pinned here:
//  - routing by `isBinary` in the bridge's borrowed-socket listener: a binary frame is
//    audio only on an `alaw8` leg, a JSON media frame only on a `pcm16` one;
//  - PASSTHROUGH on VoiceLink (A-law on the wire): the bytes the agent sends are the
//    bytes the carrier gets, and the carrier's bytes are the agent's, cut into 20 ms
//    binary messages — no codec in either direction;
//  - TRANSCODE on a carrier whose wire audio is not A-law (`wireFormat: null`; a fake
//    L16 carrier is registered for it below);
//  - framing: client messages must be whole 20 ms frames ≤ 1 s, server messages are
//    exactly one 20 ms frame;
//  - the format is the socket's: a re-attach onto a reconnected socket that chose
//    another format switches the relay, and a late bind reads it synchronously;
//  - media before the bridge is live is dropped, as for pcm16.
// ---------------------------------------------------------------------------

vi.mock('@magick-agency/observability', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
  createChildLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../../../src/config/index.js', () => ({
  config: {
    redis: { keyPrefix: '' },
    telephony: { voicelink: { webhookBaseUrl: 'https://server.test/api/v1/webhooks/voicelink' } },
  },
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
  trackWebrtcCallInitiated: vi.fn(),
  trackWebrtcCallRejected: vi.fn(),
  trackWebrtcCallCompleted: vi.fn(),
}));

// A carrier whose wire audio is PCM16 16 kHz (identity codec), streaming on connect —
// the shape of any carrier that is NOT A-law, so an `alaw8` leg must transcode.
vi.mock('../../../src/telephony/carrier-modules.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/telephony/carrier-modules.js')>();
  const vl = actual.findCarrierModule('voicelink')!;
  const l16 = {
    ...vl,
    name: 'l16',
    answeredHangup: 'rest' as const,
    mediaUrlInDialRequest: false,
    media: {
      ...vl.media,
      formatLabel: 'L16 16kHz',
      negotiatesOnStart: false,
      wireFormat: null,
      createCodec: () => ({ carrierToPcm16k: (b: Buffer) => b, pcm16kToCarrier: (b: Buffer) => b }),
    },
  };
  return { ...actual, findCarrierModule: (p: string) => (p === 'l16' ? l16 : actual.findCarrierModule(p)) };
});

import { WebRtcBridgeManager } from '../../../src/core/webrtc-bridge-manager.js';
import {
  AlawFramer,
  browserLegMediaFormatOf,
  isAcceptableAlawMessage,
  setBrowserLegMediaFormat,
  type BrowserLegMediaFormat,
} from '../../../src/core/bridge/browser-leg-media.js';
import { decodeAlaw, encodeAlaw } from '../../../src/utils/audio.js';

// ── Fakes ───────────────────────────────────────────────────────────────────

/** A station socket that records text (JSON) and binary sends apart, as `ws` would. */
function fakeStation(format?: BrowserLegMediaFormat) {
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
    /** What `ws` emits for a text message from the client (a Buffer with isBinary false). */
    sendTextUp(obj: unknown) { this.emit('message', Buffer.from(JSON.stringify(obj)), false); },
    listeners() { return Object.values(handlers).reduce((n, l) => n + l.length, 0); },
  };
  if (format) setBrowserLegMediaFormat(ws as never, format);
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
    /** The carrier sends audio. */
    media(payload: Buffer) { this.emit('message', JSON.stringify({ event: 'media', media: { payload: payload.toString('base64') } })); },
    /** Raw bytes of every audio frame the bridge sent the carrier, in order. */
    receivedAudio(): Buffer[] {
      return this.sent.filter((m) => m.event === 'media').map((m) => Buffer.from(m.media.payload, 'base64'));
    },
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

const ATTEMPT = 'att-1';
const PARAMS = {
  tenantId: 't1',
  accountId: 'a1',
  callerId: '+14155550100',
  destinationPhone: '+14155550199',
  correlation: { kind: 'attempt' as const, campaignId: 'camp-1', agencyAttemptId: ATTEMPT },
  browserCloseGraceMs: 5_000,
};

/** A pattern of distinct bytes, so an exact relay is distinguishable from a re-encode. */
function bytes(n: number, seed = 1): Buffer {
  const b = Buffer.alloc(n);
  for (let i = 0; i < n; i++) b[i] = (i * 37 + seed * 101) & 0xff;
  return b;
}

/** A 1 kHz tone as PCM16 16 kHz. */
function pcm16kTone(samples: number, amp = 8000, phase = 0): Buffer {
  const pcm = new Int16Array(samples);
  for (let i = 0; i < samples; i++) pcm[i] = Math.round(amp * Math.sin((2 * Math.PI * 1000 * (phase + i)) / 16000));
  return Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
}
function alawTone(samples: number, amp = 8000, phase = 0): Buffer {
  const pcm = new Int16Array(samples);
  for (let i = 0; i < samples; i++) pcm[i] = Math.round(amp * Math.sin((2 * Math.PI * 1000 * (phase + i)) / 8000));
  return encodeAlaw(pcm);
}
const peak = (samples: ArrayLike<number>) => Array.from(samples).reduce((m, v) => Math.max(m, Math.abs(v)), 0);

/** Dial on `provider` with `station` borrowed, attach the PSTN leg and open the relay. */
async function bridged(provider: 'voicelink' | 'l16', station: ReturnType<typeof fakeStation>) {
  const mgr = new WebRtcBridgeManager(makeGuardHost() as any, null);
  await mgr.createBridgedCall({ ...PARAMS, provider, browserSocket: station as any });
  const pstn = fakePstn();
  expect(mgr.attachPstnLeg('call-1', pstn as any)).toBe(true);
  if (provider === 'voicelink') {
    pstn.emit('message', JSON.stringify({
      event: 'start',
      start: { call_sid: 'c', stream_sid: 's', media_format: { encoding: 'audio/alaw', sample_rate: '8000' } },
    }));
  }
  expect(mgr.getSession('call-1')!.providerMediaReady).toBe(true);
  return { mgr, pstn, session: mgr.getSession('call-1')! };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRepo.create.mockImplementation(async (i: any) => ({
    id: 'call-1', tenant_id: i.tenant_id, account_id: i.account_id, caller_id: i.caller_id,
    destination_phone: i.destination_phone, provider: i.provider, status: 'initiating',
    provider_call_id: null, telephony_credential_id: null,
    campaign_id: i.campaign_id ?? null, agency_attempt_id: i.agency_attempt_id ?? null,
  }));
});

// ── The leaf pieces ───────────────────────────────────────────────────────────

describe('browser-leg-media', () => {
  it('a socket is pcm16 until tagged, and keeps its tag', () => {
    const ws = {};
    expect(browserLegMediaFormatOf(ws as never)).toBe('pcm16');
    setBrowserLegMediaFormat(ws as never, 'alaw8');
    expect(browserLegMediaFormatOf(ws as never)).toBe('alaw8');
    expect(browserLegMediaFormatOf({} as never)).toBe('pcm16');
  });

  it('accepts a client message of whole 20 ms frames up to 1 s, and nothing else', () => {
    for (const n of [160, 320, 480, 7840, 8000]) expect(isAcceptableAlawMessage(n), String(n)).toBe(true);
    for (const n of [0, 1, 159, 161, 170, 8160, 64000]) expect(isAcceptableAlawMessage(n), String(n)).toBe(false);
  });

  it('AlawFramer: a 20 ms frame passes as the same Buffer; larger ones as views of it; a tail waits', () => {
    const f = new AlawFramer();
    const out: Buffer[] = [];
    const one = bytes(160);
    f.push(one, (b) => out.push(b));
    expect(out).toHaveLength(1);
    expect(out[0]).toBe(one); // zero-copy: the input itself

    out.length = 0;
    const three = bytes(480, 2);
    f.push(three, (b) => out.push(b));
    expect(out.map((b) => b.length)).toEqual([160, 160, 160]);
    for (const b of out) expect(b.buffer).toBe(three.buffer); // views, not copies
    expect(Buffer.concat(out)).toEqual(three);

    out.length = 0;
    const a = bytes(200, 3);
    const b = bytes(120, 4);
    f.push(a, (x) => out.push(x));
    expect(f.pending).toBe(40);
    f.push(b, (x) => out.push(x));
    expect(f.pending).toBe(0);
    expect(out.map((x) => x.length)).toEqual([160, 160]);
    expect(Buffer.concat(out)).toEqual(Buffer.concat([a, b]));

    f.push(bytes(50), () => { /* held */ });
    f.reset();
    expect(f.pending).toBe(0);
  });
});

// ── Passthrough: VoiceLink is A-law on the wire ────────────────────────────────

describe('alaw8 leg on VoiceLink — passthrough', () => {
  it('relays the agent’s A-law to the carrier byte for byte, whatever whole-frame size it comes in', async () => {
    const station = fakeStation('alaw8');
    const { mgr, pstn, session } = await bridged('voicelink', station);
    expect(session.browserMediaFormat).toBe('alaw8');
    expect(session.browserMediaPassthrough).toBe(true);

    const f1 = bytes(160, 1);
    const f2 = bytes(480, 2);
    station.sendBinaryUp(f1);
    station.sendBinaryUp(f2);

    // FALSIFIED by sending the agent's audio through the PCM16 codec instead of
    // passthrough: the carrier gets resampled bytes and these are not equal.
    expect(pstn.receivedAudio()).toEqual([f1, f2]);
    expect(session.browserToPstnFrames).toBe(2);
    // Framed as VoiceLink frames every outbound payload: no extra fields.
    expect(pstn.sent.filter((m) => m.event === 'media')[0]).toEqual({ event: 'media', media: { payload: f1.toString('base64') } });
    await mgr.forceEndWithOutcome(ATTEMPT, 'ended_by_user');
  });

  it('relays the carrier’s A-law to the agent byte for byte, as binary 20 ms messages', async () => {
    const station = fakeStation('alaw8');
    const { mgr, pstn, session } = await bridged('voicelink', station);

    const c1 = bytes(160, 5);
    const c2 = bytes(320, 6);
    pstn.media(c1);
    pstn.media(c2);

    expect(station.binary.map((b) => b.length)).toEqual([160, 160, 160]);
    expect(Buffer.concat(station.binary)).toEqual(Buffer.concat([c1, c2]));
    // No JSON media frame on an alaw8 leg.
    expect(station.sent.filter((m) => m.event === 'media')).toHaveLength(0);
    expect(session.pstnToBrowserFrames).toBe(2);
    await mgr.forceEndWithOutcome(ATTEMPT, 'ended_by_user');
  });

  it('re-chunks a carrier frame that is not a whole number of 20 ms frames, carrying the tail', async () => {
    const station = fakeStation('alaw8');
    const { mgr, pstn } = await bridged('voicelink', station);
    const a = bytes(100, 7);
    const b = bytes(220, 8);
    pstn.media(a);
    expect(station.binary).toHaveLength(0);
    pstn.media(b);
    expect(station.binary.map((x) => x.length)).toEqual([160, 160]);
    expect(Buffer.concat(station.binary)).toEqual(Buffer.concat([a, b]));
    await mgr.forceEndWithOutcome(ATTEMPT, 'ended_by_user');
  });

  it('drops a client message that is not whole 20 ms frames, or is over 1 s, before any work', async () => {
    const station = fakeStation('alaw8');
    const { mgr, pstn, session } = await bridged('voicelink', station);
    for (const n of [1, 100, 170, 8160, 64_000]) expect(() => station.sendBinaryUp(Buffer.alloc(n))).not.toThrow();
    station.sendBinaryUp(Buffer.alloc(0));
    expect(pstn.receivedAudio()).toHaveLength(0);
    expect(session.ignoredBrowserMediaFrames).toBe(6);
    // The ceiling itself is accepted.
    station.sendBinaryUp(bytes(8000));
    expect(pstn.receivedAudio()).toEqual([bytes(8000)]);
    await mgr.forceEndWithOutcome(ATTEMPT, 'ended_by_user');
  });
});

// ── Routing by isBinary ──────────────────────────────────────────────────────

describe('the bridge’s borrowed-socket listener routes by isBinary', () => {
  it('ignores a JSON media frame on an alaw8 leg (counted), and relays nothing for it', async () => {
    const station = fakeStation('alaw8');
    const { mgr, pstn, session } = await bridged('voicelink', station);
    station.sendTextUp({ event: 'media', media: { payload: pcm16kTone(320).toString('base64') } });
    expect(pstn.receivedAudio()).toHaveLength(0);
    expect(session.ignoredBrowserMediaFrames).toBe(1);
    await mgr.forceEndWithOutcome(ATTEMPT, 'ended_by_user');
  });

  it('ignores a binary frame on a pcm16 leg, even one whose bytes are a valid JSON media frame', async () => {
    // FALSIFIED by routing on a failed `JSON.parse` again (drop the `isBinary` branch in
    // `registerBrowserLegHandlers`): the binary JSON parses and the carrier gets audio.
    const station = fakeStation(); // untagged: pcm16
    const { mgr, pstn, session } = await bridged('voicelink', station);
    expect(session.browserMediaFormat).toBe('pcm16');
    const asJson = Buffer.from(JSON.stringify({ event: 'media', media: { payload: pcm16kTone(320).toString('base64') } }));
    station.sendBinaryUp(asJson);
    station.sendBinaryUp(bytes(160));
    expect(pstn.receivedAudio()).toHaveLength(0);
    expect(session.ignoredBrowserMediaFrames).toBe(2);

    // The same JSON as a text frame IS this leg's audio, transcoded as before.
    station.sendTextUp({ event: 'media', media: { payload: pcm16kTone(320).toString('base64') } });
    expect(pstn.receivedAudio()).toHaveLength(1);
    // And carrier audio reaches a pcm16 leg as JSON, never binary.
    pstn.media(alawTone(160));
    expect(station.binary).toHaveLength(0);
    expect(station.sent.filter((m) => m.event === 'media')).toHaveLength(1);
    await mgr.forceEndWithOutcome(ATTEMPT, 'ended_by_user');
  });

  it('a listener emitted without isBinary (a bare string or Buffer) is text, as before', async () => {
    const station = fakeStation('alaw8');
    const { mgr, pstn } = await bridged('voicelink', station);
    // A bare Buffer of A-law: not JSON, ignored like any non-frame.
    expect(() => station.emit('message', bytes(160))).not.toThrow();
    expect(pstn.receivedAudio()).toHaveLength(0);
    await mgr.forceEndWithOutcome(ATTEMPT, 'ended_by_user');
  });

  it('drops alaw8 audio while nothing is bridged, exactly as for pcm16', async () => {
    const station = fakeStation('alaw8');
    const mgr = new WebRtcBridgeManager(makeGuardHost() as any, null);
    await mgr.createBridgedCall({ ...PARAMS, provider: 'voicelink', browserSocket: station as any });
    station.sendBinaryUp(bytes(160)); // no PSTN leg
    const pstn = fakePstn();
    mgr.attachPstnLeg('call-1', pstn as any);
    station.sendBinaryUp(bytes(160)); // PSTN leg, but no VoiceLink `start` yet
    expect(pstn.receivedAudio()).toHaveLength(0);
    expect(mgr.getSession('call-1')!.ignoredBrowserMediaFrames).toBe(0); // dropped, not "wrong format"
    await mgr.forceEndWithOutcome(ATTEMPT, 'ended_by_user');
  });
});

// ── Transcode: a carrier that is not A-law ─────────────────────────────────────

describe('alaw8 leg on a carrier whose wire audio is not A-law — transcode', () => {
  it('agent A-law → carrier PCM16 16 kHz, and carrier PCM16 → agent A-law in 20 ms binary messages', async () => {
    const station = fakeStation('alaw8');
    const { mgr, pstn, session } = await bridged('l16', station);
    expect(session.browserMediaPassthrough).toBe(false);

    // Agent → carrier: three 20 ms A-law tone frames come out as PCM16 16 kHz (~2× the
    // samples, so ~4× the bytes), still the tone.
    for (let k = 0; k < 3; k++) station.sendBinaryUp(alawTone(160, 8000, k * 160));
    const toCarrier = pstn.receivedAudio();
    expect(toCarrier).toHaveLength(3);
    const lastPcm = new Int16Array(toCarrier[2]!.buffer, toCarrier[2]!.byteOffset, toCarrier[2]!.length / 2);
    expect(toCarrier[2]!.length).toBe(640);
    expect(peak(lastPcm)).toBeGreaterThan(6400);

    // Carrier → agent: PCM16 tone frames come back as A-law, exactly 160 bytes per message.
    for (let k = 0; k < 4; k++) pstn.media(pcm16kTone(320, 8000, k * 320));
    expect(station.binary.length).toBeGreaterThanOrEqual(3);
    for (const m of station.binary) expect(m.length).toBe(160);
    expect(peak(decodeAlaw(station.binary.at(-1)!))).toBeGreaterThan(6400);
    expect(station.sent.filter((m) => m.event === 'media')).toHaveLength(0);
    await mgr.forceEndWithOutcome(ATTEMPT, 'ended_by_user');
  });

  it('a pcm16 leg on that carrier is untouched (no A-law transcoder is built)', async () => {
    const station = fakeStation();
    const { mgr, pstn, session } = await bridged('l16', station);
    const pcm = pcm16kTone(320);
    station.sendTextUp({ event: 'media', media: { payload: pcm.toString('base64') } });
    expect(pstn.receivedAudio()).toEqual([pcm]); // identity carrier codec
    expect((session as unknown as { browserAlawTranscoder: unknown }).browserAlawTranscoder).toBeNull();
    await mgr.forceEndWithOutcome(ATTEMPT, 'ended_by_user');
  });
});

// ── The format is the socket's: re-attach, late bind ─────────────────────────

describe('the leg’s format follows the socket', () => {
  it('a re-attach onto a reconnected socket that chose alaw8 switches the relay to binary passthrough', async () => {
    const first = fakeStation(); // pcm16 (a browser)
    const { mgr, pstn, session } = await bridged('voicelink', first);
    expect(session.browserMediaFormat).toBe('pcm16');

    // The socket drops (grace window armed), and the agent comes back on alaw8.
    first.close();
    expect(session.browserLegGraceArmed).toBe(true);
    const second = fakeStation('alaw8');
    expect(mgr.reattachBorrowedBrowserLeg(ATTEMPT, second as any)).toBe(true);
    expect(session.browserMediaFormat).toBe('alaw8');
    expect(session.browserMediaPassthrough).toBe(true);
    expect(first.listeners()).toBe(0);

    const up = bytes(160, 9);
    second.sendBinaryUp(up);
    expect(pstn.receivedAudio()).toEqual([up]);
    const down = bytes(160, 10);
    pstn.media(down);
    expect(second.binary).toEqual([down]);
    // The new socket's JSON media is not its format.
    second.sendTextUp({ event: 'media', media: { payload: pcm16kTone(320).toString('base64') } });
    expect(pstn.receivedAudio()).toHaveLength(1);
    await mgr.forceEndWithOutcome(ATTEMPT, 'ended_by_user');
  });

  it('and back: alaw8 → pcm16 on re-attach, with no A-law tail carried onto the new socket', async () => {
    const first = fakeStation('alaw8');
    const { mgr, pstn, session } = await bridged('voicelink', first);
    pstn.media(bytes(100)); // a tail held for the first socket
    expect(session.browserAlawFramer.pending).toBe(100);

    first.close();
    const second = fakeStation();
    expect(mgr.reattachBorrowedBrowserLeg(ATTEMPT, second as any)).toBe(true);
    expect(session.browserMediaFormat).toBe('pcm16');
    expect(session.browserAlawFramer.pending).toBe(0);

    second.sendBinaryUp(bytes(160));
    expect(pstn.receivedAudio()).toHaveLength(0);
    second.sendTextUp({ event: 'media', media: { payload: pcm16kTone(320).toString('base64') } });
    expect(pstn.receivedAudio()).toHaveLength(1);
    pstn.media(alawTone(160));
    expect(second.binary).toHaveLength(0);
    expect(second.sent.filter((m) => m.event === 'media')).toHaveLength(1);
    await mgr.forceEndWithOutcome(ATTEMPT, 'ended_by_user');
  });

  it('a late bind reads the socket’s format synchronously, inside the bind', async () => {
    const mgr = new WebRtcBridgeManager(makeGuardHost() as any, null);
    await mgr.createUnboundBridgedCall({ ...PARAMS, provider: 'voicelink' });
    const pstn = fakePstn();
    mgr.attachPstnLeg('call-1', pstn as any);
    pstn.emit('message', JSON.stringify({
      event: 'start',
      start: { call_sid: 'c', stream_sid: 's', media_format: { encoding: 'audio/alaw', sample_rate: '8000' } },
    }));
    const station = fakeStation('alaw8');
    expect(mgr.bindBorrowedBrowserLeg(ATTEMPT, station as any)).toBe(true);
    // No await between the bind and the first frame: the format is already in force.
    station.sendBinaryUp(bytes(160, 11));
    expect(pstn.receivedAudio()).toEqual([bytes(160, 11)]);
    await mgr.forceEndWithOutcome(ATTEMPT, 'ended_by_user');
  });
});
