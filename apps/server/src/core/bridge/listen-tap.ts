// The listen tap (docs/listening.md §2, §5; decisions LS8, LS11): one call's fan-out of both legs
// to the supervisors listening to it, normalised to A-law 8 kHz in 20 ms frames and sent as one
// tag byte (`AGENCY_LISTEN_LEG`) plus 160 bytes. A nullable field on the bridge session
// (`WebRtcBridgeSession.listenTap`), fed by the relay AFTER its own write, so with nobody
// listening a frame costs one field read and the relay's dwell never includes the tap.
//
// The tap never touches the call:
//  - it owns its codecs (the session's keep FIR history and are called once per frame, by the
//    relay only). A-law in (a VoiceLink customer, an `alaw8` agent) is copied behind the tag
//    byte; a μ-law customer (Plivo) is mapped to A-law one byte at a time by a 256-entry table
//    (both 8 kHz, so nothing to resample: LS17); any other carrier goes through its own carrier
//    codec to PCM16 16 kHz and its own A-law encoder; a `pcm16` agent through its own A-law
//    encoder. Each leg is cut into 20 ms frames by its own `AlawFramer`. A transcoded leg's first
//    output is short of a whole frame by the resampler's look-ahead (152 bytes for 20 ms of
//    `pcm16`), so it is led by that much A-law silence: the framer then carries nothing on whole
//    20 ms inputs (one frame out per frame in, no copy, no frame of lag);
//  - nothing escapes it: every entry point is wrapped. A failed decode, encode or framing step
//    drops that message's 20 ms frames (counted, `agency_listen_tap_errors_total{stage}`);
//    `faultBudget` failed frames of one leg in a row end every sink `tap_error` and detach the tap;
//  - one bad listener stays one: a sink whose send throws or whose socket is gone is ended
//    `listener_disconnected`, one past its hard cap `send_backlog`; the others carry on;
//  - logs are rate-limited (one line per tap per 10 s, one per sink as it is ended) and name the
//    call and the listen ids only: no audio, no numbers.
import type WebSocket from 'ws';
import { createChildLogger } from '@magick-agency/observability';
// Deliberately the agency area's metric, emitted from voice (SWE-L2): `agency_listen_tap_errors_total`
// sits with the other `agency_listen_*` series it is read beside, and the tap is the only place that
// knows a frame failed. Nothing else in voice reads the agency area.
import { trackListenTapError, type ListenTapErrorStage } from '@magick-agency/observability/metrics/agency';
import { trackWebsocketSendBackpressure } from '@magick-agency/observability/metrics/voice';
import { AGENCY_LISTEN_LEG, AGENCY_LISTEN_MESSAGE_BYTES } from '@magick-agency/contracts/agency';
import type { CarrierMediaCodec, CarrierMediaProtocol } from '../../telephony/carrier-module.js';
import { VoicelinkTranscoder } from '../../utils/audio-fir.js';
import { alawEncodeTable, decodeMulaw } from '../../utils/audio.js';
import { LISTENER_LIMITS, LISTENER_SOFT_LIMIT_MAX_MS, sendVerdict } from '../../utils/ws-backpressure.js';
import { ALAW8_FRAME_BYTES, AlawFramer } from './browser-leg-media.js';
import type {
  ListenSendResult, ListenSink, ListenTapEndReason, ListenTapHandle,
} from './bridge-types.js';

const log = createChildLogger({ component: 'listen-tap' });

/** At most one fault line per tap in this long. */
export const LISTEN_TAP_LOG_INTERVAL_MS = 10_000;

/**
 * G.711 μ-law → A-law, one code to one (LS17): each μ-law code decoded to its linear sample and
 * encoded as A-law by the bridge's own encoder, exactly what the codec path would do to that
 * sample without its two resampling filters. Built once at load; read-only.
 */
export const MULAW_TO_ALAW: Uint8Array = (() => {
  const linear = decodeMulaw(Buffer.from(Array.from({ length: 256 }, (_, i) => i)));
  const table = new Uint8Array(256);
  for (let i = 0; i < 256; i++) table[i] = alawEncodeTable[linear[i]! + 32768]!;
  return table;
})();

/** A-law for a sample of 0: what a transcoded leg's first output is led by. */
const ALAW_SILENCE = alawEncodeTable[32768]!;

/** 20 ms of `pcm16` (PCM16 16 kHz): 320 samples. */
const PCM16_FRAME_BYTES = 640;

/** The 20 ms frames in `bytes` of audio at `frameBytes` a frame, at least one (a failed message is never nothing). */
function framesIn(bytes: number, frameBytes: number): number {
  return Math.max(1, Math.ceil(bytes / frameBytes));
}

/** The decoded length of a base64 string, without decoding it. */
function base64Bytes(b64: string): number {
  const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((b64.length * 3) / 4) - pad);
}

type Leg = 'customer' | 'agent';
type CustomerPath = 'passthrough' | 'mulaw' | 'codec';

interface SinkEntry {
  readonly sink: ListenSink;
  readonly handle: ListenTapHandle;
  attached: boolean;
  framesSent: number;
  framesDropped: number;
}

/** The fault budget when the caller names none (`ListenTapOpenOptions`): the setting's default. */
export const LISTEN_TAP_DEFAULT_FAULT_BUDGET = 50;

export interface ListenTapOptions {
  callId: string;
  /** The call's carrier media: its wire format (A-law is passed through) and a codec factory. */
  carrierMedia: Pick<CarrierMediaProtocol, 'wireFormat' | 'createCodec'>;
  /** Failed frames of one leg in a row that detach the tap (`agency.listen.faultBudget`, passed through the seam). */
  faultBudget: number;
  /** The tap has no sinks left (each ended or detached): the session drops its reference. Called once. */
  onIdle: (tap: ListenTap) => void;
}

export class ListenTap {
  readonly callId: string;
  private readonly faultBudget: number;
  private readonly onIdle: (tap: ListenTap) => void;
  /** Copy-on-write: a broadcast iterates the array it started with, whatever a sink does meanwhile. */
  private entries: readonly SinkEntry[] = [];
  private ended = false;

  /**
   * How the customer's wire audio becomes A-law: copied (`alaw8`), mapped by {@link MULAW_TO_ALAW}
   * (`mulaw8`), or through this tap's own carrier codec and encoder (any other carrier).
   */
  private readonly customerPath: CustomerPath;
  /** Carrier wire audio → PCM16 16 kHz, this tap's own (`codec` path only). */
  private readonly customerCodec: CarrierMediaCodec | null;
  /** PCM16 16 kHz → A-law for the customer leg (`codec` path only). */
  private readonly customerEncoder: VoicelinkTranscoder | null;
  /** PCM16 16 kHz → A-law for a `pcm16` agent leg; made on its first frame. */
  private agentEncoder: VoicelinkTranscoder | null = null;
  private readonly customerFramer = new AlawFramer();
  private readonly agentFramer = new AlawFramer();
  /** A transcoded leg's first output has been led to a whole frame (see {@link primed}). */
  private customerPrimed = false;
  private agentPrimed = false;

  /** Failed frames in a row, per leg; reset by the leg's next frame that succeeds. */
  private customerFailures = 0;
  private agentFailures = 0;
  private lastFaultLogAt = Number.NEGATIVE_INFINITY;

  constructor(opts: ListenTapOptions) {
    this.callId = opts.callId;
    this.faultBudget = Math.max(1, opts.faultBudget);
    this.onIdle = opts.onIdle;
    const wire = opts.carrierMedia.wireFormat;
    this.customerPath = wire === 'alaw8' ? 'passthrough' : wire === 'mulaw8' ? 'mulaw' : 'codec';
    this.customerCodec = this.customerPath === 'codec' ? opts.carrierMedia.createCodec() : null;
    this.customerEncoder = this.customerPath === 'codec' ? new VoicelinkTranscoder() : null;
  }

  /** Sinks attached now. */
  get sinkCount(): number {
    return this.entries.length;
  }

  /** True once the tap has ended (no sinks left, `tap_error`, or the call's end): it takes no more. */
  get isEnded(): boolean {
    return this.ended;
  }

  /** Attach `sink`. On a tap already ended the sink is ended at once `call_ended`, and the handle detached. */
  addSink(sink: ListenSink): ListenTapHandle {
    const entry = this.makeEntry(sink);
    if (this.ended) {
      this.endEntry(entry, 'call_ended');
      return entry.handle;
    }
    this.entries = [...this.entries, entry];
    return entry.handle;
  }

  /**
   * One carrier media frame (the customer), as the base64 payload the carrier sent. The caller has
   * bounded its size. Never throws.
   */
  feedCustomer(payloadBase64: string): void {
    if (this.ended) return;
    let stage: ListenTapErrorStage = 'decode';
    try {
      const wire = Buffer.from(payloadBase64, 'base64');
      let alaw: Buffer;
      if (this.customerPath === 'passthrough') {
        alaw = wire;
      } else if (this.customerPath === 'mulaw') {
        // A fresh Buffer the sinks may hold; one table read a byte.
        alaw = Buffer.allocUnsafe(wire.length);
        for (let i = 0; i < wire.length; i++) alaw[i] = MULAW_TO_ALAW[wire[i]!]!;
      } else {
        const pcm = this.customerCodec!.carrierToPcm16k(wire);
        stage = 'encode';
        alaw = this.customerEncoder!.pcm16kToAlaw(pcm);
        stage = 'frame';
        alaw = this.primed('customer', alaw);
      }
      stage = 'frame';
      this.frameAndSend('customer', alaw);
    } catch (err) {
      // The carrier's wire audio is 8 kHz, a byte a sample (G.711): 160 bytes a frame.
      this.fault('customer', stage, err, framesIn(base64Bytes(payloadBase64), ALAW8_FRAME_BYTES));
    }
  }

  /** One `pcm16` agent frame (the base64 payload of PCM16 16 kHz). The caller has bounded its size. Never throws. */
  feedAgentPcm16(payloadBase64: string): void {
    if (this.ended) return;
    let stage: ListenTapErrorStage = 'decode';
    try {
      const pcm = Buffer.from(payloadBase64, 'base64');
      stage = 'encode';
      this.agentEncoder ??= new VoicelinkTranscoder();
      let alaw = this.agentEncoder.pcm16kToAlaw(pcm);
      stage = 'frame';
      alaw = this.primed('agent', alaw);
      this.frameAndSend('agent', alaw);
    } catch (err) {
      this.fault('agent', stage, err, framesIn(base64Bytes(payloadBase64), PCM16_FRAME_BYTES));
    }
  }

  /** One `alaw8` agent message (whole 20 ms frames, at most 1 s; the caller has checked). Never throws. */
  feedAgentAlaw(alaw: Buffer): void {
    if (this.ended) return;
    try {
      this.frameAndSend('agent', alaw);
    } catch (err) {
      this.fault('agent', 'frame', err, framesIn(alaw.length, ALAW8_FRAME_BYTES));
    }
  }

  /**
   * The agent's socket was (re-)attached: it may speak another format, and its audio starts on a
   * frame boundary. Drops the agent leg's held-back tail, encoder history and priming; the tap stays.
   */
  resetAgentLeg(): void {
    try {
      this.agentFramer.reset();
      this.agentEncoder = null;
      this.agentPrimed = false;
      this.agentFailures = 0;
    } catch { /* nothing to undo */ }
  }

  /** End every sink with `reason` and detach the tap. Idempotent; never throws. */
  end(reason: ListenTapEndReason): void {
    if (this.ended) return;
    this.ended = true;
    const entries = this.entries;
    this.entries = [];
    for (const entry of entries) this.endEntry(entry, reason);
    this.notifyIdle();
  }

  // ─── Inside ──────────────────────────────────────────────────────────────

  /**
   * A transcoded leg's output, its first non-empty one led by A-law silence up to a whole frame.
   * The resampler holds back its look-ahead, so its first output is short (152 of 160 bytes for
   * 20 ms of `pcm16`, 144 for a carrier codec's 20 ms) and, unled, the framer would carry that
   * shortfall's complement on every frame after: a frame of lag and a concat per frame. Led once
   * (1-2 ms of silence), whole 20 ms inputs come out as whole frames.
   */
  private primed(leg: Leg, alaw: Buffer): Buffer {
    if (alaw.length === 0) return alaw;
    if (leg === 'customer' ? this.customerPrimed : this.agentPrimed) return alaw;
    if (leg === 'customer') this.customerPrimed = true;
    else this.agentPrimed = true;
    const short = alaw.length % ALAW8_FRAME_BYTES;
    if (short === 0) return alaw;
    const lead = ALAW8_FRAME_BYTES - short;
    const out = Buffer.allocUnsafe(lead + alaw.length);
    out.fill(ALAW_SILENCE, 0, lead);
    alaw.copy(out, lead);
    return out;
  }

  /**
   * Cut `alaw` into 20 ms frames, tag each and send it to every sink. Throws only from the
   * framing or the message build (a sink is guarded on its own), which the caller counts `frame`.
   */
  private frameAndSend(leg: Leg, alaw: Buffer): void {
    const framer = leg === 'customer' ? this.customerFramer : this.agentFramer;
    const tag = leg === 'customer' ? AGENCY_LISTEN_LEG.customer : AGENCY_LISTEN_LEG.agent;
    framer.push(alaw, (frame) => {
      // Built once per frame and shared by every sink: `ws` queues the Buffer as is.
      const message = Buffer.allocUnsafe(AGENCY_LISTEN_MESSAGE_BYTES);
      message[0] = tag;
      frame.copy(message, 1);
      this.broadcast(message);
    });
    if (leg === 'customer') this.customerFailures = 0;
    else this.agentFailures = 0;
  }

  /** Offer one message to every sink. Never throws. */
  private broadcast(message: Buffer): void {
    const entries = this.entries;
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]!;
      if (!entry.attached) continue;
      let result: ListenSendResult;
      try {
        result = entry.sink.send(message);
      } catch (err) {
        this.countError('send');
        log.warn({ err, callId: this.callId, listenId: entry.sink.listenId },
          'A listener`s send threw: ending that listener');
        this.removeEntry(entry, 'listener_disconnected');
        continue;
      }
      switch (result) {
        case 'sent': entry.framesSent++; break;
        case 'dropped': entry.framesDropped++; break;
        case 'backlog':
          entry.framesDropped++;
          log.warn({ callId: this.callId, listenId: entry.sink.listenId },
            'A listener stopped reading: its send backlog passed the hard cap, ending it');
          this.removeEntry(entry, 'send_backlog');
          break;
        case 'closed':
          entry.framesDropped++;
          this.removeEntry(entry, 'listener_disconnected');
          break;
        default:
          // A sink answering outside its contract is treated as gone.
          this.removeEntry(entry, 'listener_disconnected');
      }
    }
  }

  /**
   * A failed message: its `frames` 20 ms frames dropped for every sink, the step counted once, and
   * the leg's run of failed frames checked against the budget (a failed 1 s agent message is 50).
   */
  private fault(leg: Leg, stage: ListenTapErrorStage, err: unknown, frames: number): void {
    try {
      this.countError(stage);
      for (const entry of this.entries) entry.framesDropped += frames;
      const failures = leg === 'customer' ? (this.customerFailures += frames) : (this.agentFailures += frames);
      const now = Date.now();
      if (now - this.lastFaultLogAt >= LISTEN_TAP_LOG_INTERVAL_MS) {
        this.lastFaultLogAt = now;
        log.warn({ err, callId: this.callId, listenIds: this.listenIds(), leg, stage, failures },
          'The listen tap dropped a frame it could not build (further ones within 10 s counted, not logged)');
      }
      if (failures >= this.faultBudget) {
        log.error({ callId: this.callId, listenIds: this.listenIds(), leg, stage, failures },
          'The listen tap failed its fault budget of frames in a row: detaching it (the call carries on)');
        this.end('tap_error');
      }
    } catch {
      // Counting must not throw out of the relay either.
    }
  }

  private countError(stage: ListenTapErrorStage): void {
    try {
      trackListenTapError(stage);
    } catch { /* a metric is never worth the relay */ }
  }

  private listenIds(): string[] {
    return this.entries.map((e) => e.sink.listenId);
  }

  private makeEntry(sink: ListenSink): SinkEntry {
    const callId = this.callId;
    const entry: SinkEntry = {
      sink,
      attached: true,
      framesSent: 0,
      framesDropped: 0,
      handle: {
        callId,
        listenId: sink.listenId,
        get attached() { return entry.attached; },
        stats: () => ({ framesSent: entry.framesSent, framesDropped: entry.framesDropped }),
        detach: () => this.detachEntry(entry),
      },
    };
    return entry;
  }

  /** The owner detached its sink: no `close`. */
  private detachEntry(entry: SinkEntry): void {
    if (!entry.attached) return;
    entry.attached = false;
    this.dropEntry(entry);
  }

  /** The tap ends one sink (`close` called), the others carry on. */
  private removeEntry(entry: SinkEntry, reason: ListenTapEndReason): void {
    if (!entry.attached) return;
    this.endEntry(entry, reason);
    this.dropEntry(entry);
  }

  private dropEntry(entry: SinkEntry): void {
    this.entries = this.entries.filter((e) => e !== entry);
    if (this.entries.length === 0 && !this.ended) {
      this.ended = true;
      this.notifyIdle();
    }
  }

  private endEntry(entry: SinkEntry, reason: ListenTapEndReason): void {
    entry.attached = false;
    try {
      entry.sink.close(reason, { framesSent: entry.framesSent, framesDropped: entry.framesDropped });
    } catch (err) {
      log.warn({ err, callId: this.callId, listenId: entry.sink.listenId, reason }, 'A listener`s close threw');
    }
  }

  private notifyIdle(): void {
    try {
      this.onIdle(this);
    } catch (err) {
      log.warn({ err, callId: this.callId }, 'The listen tap`s idle hook threw');
    }
  }
}

/**
 * When each listener socket's current run of dropped frames began (`Date.now()`); absent while its
 * frames are being sent. Keyed weakly: a socket that goes takes its entry with it.
 */
const droppingSince = new WeakMap<object, number>();

/**
 * Send one tap message on a listener's socket, under {@link LISTENER_LIMITS}: what a socket-backed
 * {@link ListenSink.send} does. Reads only this socket's `bufferedAmount`; counts what it drops
 * and the sockets it hands back for closing (`websocket_send_backpressure_total{socket="listener"}`).
 * `backlog` past the hard cap, or once every frame for {@link LISTENER_SOFT_LIMIT_MAX_MS} has been
 * dropped (that last one counted dropped too, so a row's `frames_dropped` matches the counter).
 * The clock is read only on a drop. Never throws: a `send` that throws is counted
 * (`agency_listen_tap_errors_total{stage="send"}`) and answers `closed`, which ends the sink
 * `listener_disconnected`.
 */
export function sendToListenerSocket(
  ws: Pick<WebSocket, 'readyState' | 'bufferedAmount' | 'send'>,
  message: Buffer,
): ListenSendResult {
  switch (sendVerdict(ws, { media: true }, LISTENER_LIMITS)) {
    case 'not_open':
      return 'closed';
    case 'over_cap':
      trackWebsocketSendBackpressure('listener', 'closed');
      return 'backlog';
    case 'drop': {
      trackWebsocketSendBackpressure('listener', 'media_dropped');
      const now = Date.now();
      const since = droppingSince.get(ws);
      if (since === undefined) {
        droppingSince.set(ws, now);
      } else if (now - since >= LISTENER_SOFT_LIMIT_MAX_MS) {
        droppingSince.delete(ws);
        trackWebsocketSendBackpressure('listener', 'closed');
        return 'backlog';
      }
      return 'dropped';
    }
    case 'send':
      break;
  }
  droppingSince.delete(ws);
  try {
    ws.send(message, { binary: true });
    return 'sent';
  } catch {
    try {
      trackListenTapError('send');
    } catch { /* a metric is never worth the relay */ }
    return 'closed';
  }
}
