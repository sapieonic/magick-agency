// What the WebRTC bridge needs to know about a carrier beyond `TelephonyProvider`:
// its media-stream wire protocol and how a hangup reaches it. One `CarrierModule` per
// carrier, registered in `carrier-modules.ts`; the bridge asks the module instead of
// branching on a provider name (decision B18).
import type { CallEvent } from './types.js';

/** A per-call, stateful codec between the carrier's wire audio and the browser's PCM16 16 kHz. */
export interface CarrierMediaCodec {
  /** Carrier wire audio → browser PCM16 16 kHz. */
  carrierToPcm16k(carrier: Buffer): Buffer;
  /** Browser PCM16 16 kHz → carrier wire audio. */
  pcm16kToCarrier(pcm: Buffer): Buffer;
}

/** The carrier's own ids, captured off a valid stream `start` frame. */
export interface CarrierStreamStart {
  carrierCallId: string | null;
  streamId: string | null;
}

/**
 * Result of reading a stream `start` frame. A frame that negotiates a format the
 * codec cannot decode is `ok: false`, and the bridge ends the call rather than
 * relay garbage.
 */
export type CarrierStartResult =
  | ({ ok: true } & CarrierStreamStart)
  | { ok: false; encoding: string; rate: string };

export interface CarrierMediaProtocol {
  /** The negotiated wire format, for log lines (e.g. `A-law 8kHz`). */
  readonly formatLabel: string;
  /**
   * True when the carrier's media socket opens BEFORE the stream is negotiated, so
   * the relay is held (and the answer is not anchored) until a valid `start`.
   */
  readonly negotiatesOnStart: boolean;
  /**
   * The carrier's wire audio when it is a format a browser leg can also speak, else
   * null. `alaw8` is raw G.711 A-law, 8 kHz mono, one byte per sample and no header —
   * byte for byte what an `alaw8` station socket carries, so the bridge relays such a
   * leg without a codec in either direction. Null: every browser leg transcodes
   * through {@link createCodec}.
   */
  readonly wireFormat: 'alaw8' | null;
  /** Read a parsed `start` frame. Called only when {@link negotiatesOnStart}. */
  parseStart(frame: unknown): CarrierStartResult;
  /** A fresh codec for one call (it carries resampler history across frames). */
  createCodec(): CarrierMediaCodec;
  /**
   * Frame a base64 payload of carrier wire audio for sending to the carrier. (Inbound
   * media is `{event:'media', media:{payload}}` on every carrier, so it needs no hook.)
   */
  frameOutbound(payloadBase64: string, streamId: string | null): Record<string, unknown>;
  /**
   * Encode a cached PCM16 clip in the carrier's wire format. `byteRate` is wire bytes
   * per second of audio, which the clip pacer needs. Null when nothing can be played.
   */
  encodeClip(pcm16: Buffer, sampleRate: number): { buffer: Buffer; byteRate: number } | null;
}

/**
 * A terminal call classified in the bridge's one vocabulary, whichever carrier reported
 * it: `status` is what the row settles as, `outcome` its label, `rawCause` the carrier's
 * own wording (diagnostics only, never a status).
 */
export interface CarrierTerminalOutcome {
  status: 'completed' | 'no_answer' | 'busy' | 'canceled' | 'failed';
  outcome: string;
  rawCause: string;
}

/** What the bridge reads off one of a carrier's lifecycle events. */
export interface CarrierEventFacts {
  /** The carrier's own id for the call, as this event names it, or ''. */
  carrierCallId: string;
  /** The carrier's recording URL, when this event carries one. */
  recordingUrl?: string;
  /** Whether the event itself says the far end answered. */
  wasAnswered: boolean;
  /**
   * Classify the event as a terminal. `answered` is the event's own answer folded with
   * the bridge's answer anchor: a carrier whose terminal event omits the answer (a
   * VoiceLink `call.ended` carries no `callStatus`) still settles a talked call as one.
   */
  classify(answered: boolean): CarrierTerminalOutcome;
}

/**
 * How the bridge reads a carrier's lifecycle events. The carrier's own route parses its
 * callback into a `CallEvent`; the bridge hands that event back here for the carrier's
 * ids, recording URL and terminal classification, so its status handling has no branch
 * per carrier.
 */
export interface CarrierLifecycle {
  /** Read an event this carrier's parser produced. Never throws. */
  readEvent(event: CallEvent): CarrierEventFacts;
}

export interface CarrierModule {
  /** The provider name, as stored on `agency_calls.provider` and campaigns. */
  readonly name: string;
  readonly media: CarrierMediaProtocol;
  /**
   * How a locally-initiated hangup of an ANSWERED call reaches the carrier.
   *
   *  - `close_media`: the carrier has no hangup API. Closing our media socket is the
   *    only lever, so teardown waits (bounded) for the carrier's terminal webhook,
   *    which also carries the recording URL.
   *  - `rest`: the adapter's `endCall` hangs the call up; teardown finalizes at once.
   */
  readonly answeredHangup: 'close_media' | 'rest';
  /**
   * True when the media-stream URL goes in the dial request itself (the carrier dials
   * out to it). False when the carrier fetches it later from our answer response.
   */
  readonly mediaUrlInDialRequest: boolean;
  /**
   * Whether hanging up a call the far end has NOT answered stops it ringing: the
   * module-level statement of the adapter's `ProviderCapabilities.cancelRinging`, read
   * where no adapter is at hand (one on a tenant's account opens its secrets). The soft
   * phone tells the agent with it whether a hang-up while ringing leaves the customer's
   * phone ringing (`AgencyManualCall.can_cancel_ringing`, SP3). Held equal to the
   * adapter's declaration by `test/unit/telephony/provider-capabilities.test.ts`.
   */
  readonly cancelsRinging: boolean;
  /**
   * How the bridge reads this carrier's lifecycle events (status callbacks). Optional:
   * a carrier without it drives no status handling, and its events are refused.
   */
  readonly lifecycle?: CarrierLifecycle;
}
