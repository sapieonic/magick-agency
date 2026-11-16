// The listen tap (docs/listening.md §2, §5; decisions LS8, LS11): one call's fan-out of both legs
// to the supervisors listening to it, normalised to A-law 8 kHz in 20 ms frames and sent as one
// tag byte (`AGENCY_LISTEN_LEG`) plus 160 bytes. A nullable field on the bridge session
// (`WebRtcBridgeSession.listenTap`), fed by the relay AFTER its own write, so with nobody
// listening a frame costs one field read and the relay's dwell never includes the tap.
//
// The tap never touches the call:
//  - it owns its codecs (the session's keep FIR history and are called once per frame, by the
//    relay only): a μ-law customer leg goes through its own carrier codec to PCM16 16 kHz and its
//    own A-law encoder; a `pcm16` agent through its own A-law encoder; A-law in (a VoiceLink
//    customer, an `alaw8` agent) is copied behind the tag byte, cut into 20 ms frames by its own
//    `AlawFramer`;
//  - nothing escapes it: every entry point is wrapped. A failed decode, encode or framing step
//    drops that frame (counted, `agency_listen_tap_errors_total{stage}`); `faultBudget` failures
//    of one leg in a row end every sink `tap_error` and detach the tap;
//  - one bad listener stays one: a sink whose send throws or whose socket is gone is ended
//    `listener_disconnected`, one past its hard cap `send_backlog`; the others carry on;
//  - logs are rate-limited (one line per tap per 10 s, one per sink as it is ended) and name the
//    call and the listen ids only: no audio, no numbers.
import type WebSocket from 'ws';
import { createChildLogger } from '@magick-agency/observability';
import { trackListenTapError, type ListenTapErrorStage } from '@magick-agency/observability/metrics/agency';
import { trackWebsocketSendBackpressure } from '@magick-agency/observability/metrics/voice';
import { AGENCY_LISTEN_LEG, AGENCY_LISTEN_MESSAGE_BYTES } from '@magick-agency/contracts/agency';
import type { CarrierMediaCodec, CarrierMediaProtocol } from '../../telephony/carrier-module.js';
import { VoicelinkTranscoder } from '../../utils/audio-fir.js';
import { LISTENER_LIMITS, sendVerdict } from '../../utils/ws-backpressure.js';
import { AlawFramer } from './browser-leg-media.js';
import type {
  ListenSendResult, ListenSink, ListenTapEndReason, ListenTapHandle,
} from './bridge-types.js';

const log = createChildLogger({ component: 'listen-tap' });

/** At most one fault line per tap in this long. */
export const LISTEN_TAP_LOG_INTERVAL_MS = 10_000;

type Leg = 'customer' | 'agent';

interface SinkEntry {
  readonly sink: ListenSink;
  readonly handle: ListenTapHandle;
  attached: boolean;
  framesSent: number;
  framesDropped: number;
}

export interface ListenTapOptions {
  callId: string;
  /** The call's carrier media: its wire format (A-law is passed through) and a codec factory. */
  carrierMedia: Pick<CarrierMediaProtocol, 'wireFormat' | 'createCodec'>;
  /** Failed frames of one leg in a row that detach the tap (`agency.listen.faultBudget`). */
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

  /** The customer's wire audio is A-law: copied, never decoded. */
  private readonly customerPassthrough: boolean;
  /** Carrier wire audio → PCM16 16 kHz, this tap's own (null on passthrough). */
  private readonly customerCodec: CarrierMediaCodec | null;
  /** PCM16 16 kHz → A-law for the customer leg (null on passthrough). */
  private readonly customerEncoder: VoicelinkTranscoder | null;
  /** PCM16 16 kHz → A-law for a `pcm16` agent leg; made on its first frame. */
  private agentEncoder: VoicelinkTranscoder | null = null;
  private readonly customerFramer = new AlawFramer();
  private readonly agentFramer = new AlawFramer();

  /** Failed frames in a row, per leg; reset by the leg's next frame that succeeds. */
  private customerFailures = 0;
  private agentFailures = 0;
  private lastFaultLogAt = Number.NEGATIVE_INFINITY;

  constructor(opts: ListenTapOptions) {
    this.callId = opts.callId;
    this.faultBudget = Math.max(1, opts.faultBudget);
    this.onIdle = opts.onIdle;
    this.customerPassthrough = opts.carrierMedia.wireFormat === 'alaw8';
    this.customerCodec = this.customerPassthrough ? null : opts.carrierMedia.createCodec();
    this.customerEncoder = this.customerPassthrough ? null : new VoicelinkTranscoder();
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
      if (this.customerPassthrough) {
        alaw = wire;
      } else {
        const pcm = this.customerCodec!.carrierToPcm16k(wire);
        stage = 'encode';
        alaw = this.customerEncoder!.pcm16kToAlaw(pcm);
      }
      stage = 'frame';
      this.frameAndSend('customer', alaw);
    } catch (err) {
      this.fault('customer', stage, err);
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
      const alaw = this.agentEncoder.pcm16kToAlaw(pcm);
      stage = 'frame';
      this.frameAndSend('agent', alaw);
    } catch (err) {
      this.fault('agent', stage, err);
    }
  }

  /** One `alaw8` agent message (whole 20 ms frames, at most 1 s; the caller has checked). Never throws. */
  feedAgentAlaw(alaw: Buffer): void {
    if (this.ended) return;
    try {
      this.frameAndSend('agent', alaw);
    } catch (err) {
      this.fault('agent', 'frame', err);
    }
  }

  /**
   * The agent's socket was (re-)attached: it may speak another format, and its audio starts on a
   * frame boundary. Drops the agent leg's held-back tail and encoder history; the tap stays.
   */
  resetAgentLeg(): void {
    try {
      this.agentFramer.reset();
      this.agentEncoder = null;
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

  /** A failed frame: dropped for every sink, counted, and the leg's run of failures checked. */
  private fault(leg: Leg, stage: ListenTapErrorStage, err: unknown): void {
    try {
      this.countError(stage);
      for (const entry of this.entries) entry.framesDropped++;
      const failures = leg === 'customer' ? ++this.customerFailures : ++this.agentFailures;
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
 * Send one tap message on a listener's socket, under {@link LISTENER_LIMITS}: what a socket-backed
 * {@link ListenSink.send} does. Reads only this socket's `bufferedAmount`; counts what it drops
 * and the sockets it hands back for closing (`websocket_send_backpressure_total{socket="listener"}`).
 * Never throws: a `send` that throws is counted (`agency_listen_tap_errors_total{stage="send"}`)
 * and answers `closed`, which ends the sink `listener_disconnected`.
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
    case 'drop':
      trackWebsocketSendBackpressure('listener', 'media_dropped');
      return 'dropped';
    case 'send':
      break;
  }
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
