// What the WebRTC bridge needs to know about a carrier beyond `TelephonyProvider`:
// its media-stream wire protocol and how a hangup reaches it. One `CarrierModule` per
// carrier, registered in `carrier-modules.ts`; the bridge asks the module instead of
// branching on a provider name (decision B18).

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
}
