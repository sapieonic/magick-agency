// Types for `g711.js`, which is plain JavaScript because the capture worklet runs its
// source text (see the note at the top of that file).

/** A sink for one fresh buffer; the receiver may transfer it. */
export type FrameEmit = (buffer: ArrayBuffer) => void;

export const ALAW_FRAME_BYTES: 160;
export const ALAW_MAX_MESSAGE_BYTES: 8000;
export const ALAW_SILENCE: 0xd5;
export const HALF_BAND_TAPS: readonly number[];

export function alawEncodeSample(sample: number): number;
export function alawDecodeSample(code: number): number;
export function floatToPcm16(s: number): number;
export function pcm16ToFloat(v: number): number;

export class HalfBandDecimator {
  static MAX_BLOCK: number;
  reset(): void;
  process(input: Int16Array, inputOffset: number, count: number, output: Int16Array, outputOffset: number): number;
}

export class HalfBandInterpolator {
  static MAX_BLOCK: number;
  reset(): void;
  process(input: Int16Array, inputOffset: number, count: number, output: Int16Array, outputOffset: number): number;
}

export class AlawUplinkEncoder {
  constructor(inputRate: number);
  reset(): void;
  readonly pendingBytes: number;
  push(samples: Float32Array, emit: FrameEmit): void;
}

export class Pcm16UplinkFramer {
  static FRAME_SAMPLES: number;
  reset(): void;
  push(samples: Float32Array, emit: FrameEmit): void;
}

export class AlawDownlinkDecoder {
  reset(): void;
  decode(bytes: Uint8Array): Float32Array;
}
