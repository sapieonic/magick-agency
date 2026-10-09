// Low-latency fixed-ratio 8kHz↔16kHz resampler for the WebRTC human-bridge relay.
//
// The generic windowed-sinc `resample()` in audio.ts recomputes sinc + Blackman
// coefficients with Math.sin/Math.cos for *every output sample*. That is fine on
// the AI pipeline's single, one-directional leg, but the WebRTC bridge relays
// audio continuously in BOTH directions for the whole call — running that hot
// path per frame per call would burn a core and add jitter.
//
// Here the ratio is a fixed 2:1 (16k→8k) / 1:2 (8k→16k), so we precompute a
// polyphase FIR once at module load: the hot path is a plain multiply-accumulate
// over a small kernel with ZERO transcendental calls. This is the piece that
// keeps the A-law transcode path non-latent.
//
// The low-pass prototype is a Blackman-windowed sinc at the 8kHz Nyquist (4kHz),
// matching the quality target of the generic resampler for telephony voice.

import { decodeAlaw, encodeAlaw } from './audio.js';

// Half-width of the prototype low-pass kernel, in 16kHz samples.
// 16 taps per phase → ~74dB stopband (same target as the generic resampler).
const TAP_HALF = 16;

/**
 * Build a Blackman-windowed sinc low-pass prototype, normalized to unity DC gain,
 * sampled at 16kHz with cutoff at the 8kHz-domain Nyquist (4kHz → normalized 0.5).
 * Length is 2*TAP_HALF+1, centered at TAP_HALF.
 */
function buildPrototype(): Float64Array {
  const len = 2 * TAP_HALF + 1;
  const h = new Float64Array(len);
  const cutoff = 0.5; // normalized to the 16kHz rate (4kHz)
  let sum = 0;
  for (let i = 0; i < len; i++) {
    const x = i - TAP_HALF;
    // sinc(cutoff * x)
    const sinc = x === 0 ? cutoff : Math.sin(Math.PI * cutoff * x) / (Math.PI * x);
    // Blackman window over the full kernel
    const w =
      0.42 -
      0.5 * Math.cos((2 * Math.PI * i) / (len - 1)) +
      0.08 * Math.cos((4 * Math.PI * i) / (len - 1));
    h[i] = sinc * w;
    sum += h[i]!;
  }
  // Normalize to unity DC gain so amplitude is preserved.
  for (let i = 0; i < len; i++) h[i] = h[i]! / sum;
  return h;
}

// Prototype computed exactly once at module load — nothing transcendental runs
// per sample after this point.
const PROTO = buildPrototype();

/**
 * Upsample PCM16 8kHz → 16kHz (1:2) via polyphase FIR.
 * Even output samples use the whole-tap phase, odd samples the half-tap phase.
 */
function upsample8to16(input: Int16Array): Int16Array {
  const out = new Int16Array(input.length * 2);
  for (let n = 0; n < out.length; n++) {
    // Position in the input grid: output sample n corresponds to input n/2.
    const center = n / 2;
    // Only taps aligned to integer input indices contribute (the rest of the
    // zero-stuffed grid is zero); iterate input samples within the kernel radius.
    const start = Math.ceil(center - TAP_HALF / 2);
    const end = Math.floor(center + TAP_HALF / 2);
    let acc = 0;
    for (let k = start; k <= end; k++) {
      const idx = k < 0 ? 0 : k >= input.length ? input.length - 1 : k;
      // Prototype index in 16k-domain samples, centered at TAP_HALF.
      const tap = TAP_HALF + Math.round((k - center) * 2);
      if (tap < 0 || tap >= PROTO.length) continue;
      acc += input[idx]! * PROTO[tap]!;
    }
    // 1:2 upsampling loses half the energy to the inserted zeros → ×2 restores gain.
    const v = Math.round(acc * 2);
    out[n] = v > 32767 ? 32767 : v < -32768 ? -32768 : v;
  }
  return out;
}

/**
 * Downsample PCM16 16kHz → 8kHz (2:1) via polyphase FIR (low-pass then decimate).
 */
function downsample16to8(input: Int16Array): Int16Array {
  const out = new Int16Array(Math.floor(input.length / 2));
  for (let n = 0; n < out.length; n++) {
    // Output sample n maps to input index 2n; low-pass around it.
    const center = n * 2;
    let acc = 0;
    for (let tap = 0; tap < PROTO.length; tap++) {
      const k = center + (tap - TAP_HALF);
      const idx = k < 0 ? 0 : k >= input.length ? input.length - 1 : k;
      acc += input[idx]! * PROTO[tap]!;
    }
    const v = Math.round(acc);
    out[n] = v > 32767 ? 32767 : v < -32768 ? -32768 : v;
  }
  return out;
}

function int16ToBuffer(pcm: Int16Array): Buffer {
  return Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
}

function bufferToInt16(buf: Buffer): Int16Array {
  // Whole 16-bit samples only; a stray trailing byte (odd length) is ignored.
  const sampleCount = Math.floor(buf.byteLength / 2);
  // A zero-copy view requires an even byteOffset (Int16Array alignment). Buffers
  // from Buffer.from(base64) are always even-aligned in practice, but guard the
  // misaligned case with a copy rather than throwing out of the relay hot path.
  if (buf.byteOffset % 2 === 0) {
    return new Int16Array(buf.buffer, buf.byteOffset, sampleCount);
  }
  const out = new Int16Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) out[i] = buf.readInt16LE(i * 2);
  return out;
}

/**
 * G.711 A-law 8kHz → PCM16 16kHz. Used PSTN→browser in the WebRTC bridge relay.
 */
export function alaw8kToPcm16k(alaw: Buffer): Buffer {
  const pcm8k = decodeAlaw(alaw);
  const pcm16k = upsample8to16(pcm8k);
  return int16ToBuffer(pcm16k);
}

/**
 * PCM16 16kHz → G.711 A-law 8kHz. Used browser→PSTN in the WebRTC bridge relay.
 */
export function pcm16kToAlaw8k(pcm: Buffer): Buffer {
  const pcm16k = bufferToInt16(pcm);
  const pcm8k = downsample16to8(pcm16k);
  return encodeAlaw(pcm8k);
}

// ─── Stateful streaming resamplers ──────────────────────────────────────────
//
// The stateless functions above edge-pad each buffer independently: a tap that
// reaches before the frame's first sample clamps to that first sample instead of
// the true previous frame's tail. Across a continuous call chopped into 20ms
// frames, that produces a periodic discontinuity at every frame boundary (audible
// clicks / measurable distortion). A per-session stateful resampler fixes this by
// carrying the last TAP_HALF input samples (and, for downsampling, the decimation
// phase) across frames, so each frame is filtered against real neighbouring audio.
//
// One instance PER DIRECTION PER CALL; reset()/discard at stream end.

// Both classes use absolute-index streaming: they retain a sliding window of
// input samples and only emit an output once its ENTIRE kernel window (past AND
// future taps) has arrived, holding the rest for the next frame. This introduces
// a fixed ~TAP_HALF-input-sample latency (~1–2ms) but makes framed processing
// bit-identical to whole-buffer processing — no boundary discontinuity. Samples
// before the very first (absolute index < 0) clamp to the first sample, exactly
// as the stateless whole-buffer path does at t=0.

/** PCM16 8kHz → 16kHz with cross-frame FIR continuity (1:2 upsample). */
export class Upsampler8to16 {
  private window = new Int16Array(0); // retained input tail
  private winBase = 0;                // absolute input index of window[0]
  private totalIn = 0;                // absolute count of input samples seen
  private nextM = 0;                  // next output (16k) index to emit
  // The upsample kernel reaches ±TAP_HALF/2 input samples around center = m/2.
  private static readonly REACH = TAP_HALF / 2;

  reset(): void {
    this.window = new Int16Array(0);
    this.winBase = 0;
    this.totalIn = 0;
    this.nextM = 0;
  }

  process(input: Int16Array): Int16Array {
    if (input.length > 0) {
      const merged = new Int16Array(this.window.length + input.length);
      merged.set(this.window, 0);
      merged.set(input, this.window.length);
      this.window = merged;
      this.totalIn += input.length;
    }
    const at = (absIdx: number): number => {
      const clamped = absIdx < 0 ? 0 : absIdx >= this.totalIn ? this.totalIn - 1 : absIdx;
      return this.window[clamped - this.winBase]!;
    };

    const out: number[] = [];
    // Emit output m while the highest input index its kernel needs has arrived.
    while (Math.floor(this.nextM / 2 + Upsampler8to16.REACH) <= this.totalIn - 1) {
      const m = this.nextM;
      const center = m / 2;
      const start = Math.ceil(center - Upsampler8to16.REACH);
      const end = Math.floor(center + Upsampler8to16.REACH);
      let acc = 0;
      for (let k = start; k <= end; k++) {
        const tap = TAP_HALF + Math.round((k - center) * 2);
        if (tap < 0 || tap >= PROTO.length) continue;
        acc += at(k) * PROTO[tap]!;
      }
      const v = Math.round(acc * 2);
      out.push(v > 32767 ? 32767 : v < -32768 ? -32768 : v);
      this.nextM++;
    }

    // Trim input we'll never need again (below the next output's lowest tap).
    const minNeeded = Math.ceil(this.nextM / 2 - Upsampler8to16.REACH);
    const drop = Math.max(0, minNeeded - this.winBase);
    if (drop > 0) {
      this.window = this.window.slice(drop);
      this.winBase += drop;
    }
    return Int16Array.from(out);
  }
}

/** PCM16 16kHz → 8kHz with cross-frame FIR continuity + phase (2:1 downsample). */
export class Downsampler16to8 {
  private window = new Int16Array(0);
  private winBase = 0;
  private totalIn = 0;
  private nextN = 0; // next output (8k) index to emit

  reset(): void {
    this.window = new Int16Array(0);
    this.winBase = 0;
    this.totalIn = 0;
    this.nextN = 0;
  }

  process(input: Int16Array): Int16Array {
    if (input.length > 0) {
      const merged = new Int16Array(this.window.length + input.length);
      merged.set(this.window, 0);
      merged.set(input, this.window.length);
      this.window = merged;
      this.totalIn += input.length;
    }
    const at = (absIdx: number): number => {
      const clamped = absIdx < 0 ? 0 : absIdx >= this.totalIn ? this.totalIn - 1 : absIdx;
      return this.window[clamped - this.winBase]!;
    };

    const out: number[] = [];
    // Output n maps to input center 2n; kernel reaches [2n-TAP_HALF, 2n+TAP_HALF].
    while (this.nextN * 2 + TAP_HALF <= this.totalIn - 1) {
      const center = this.nextN * 2;
      let acc = 0;
      for (let tap = 0; tap < PROTO.length; tap++) {
        acc += at(center + (tap - TAP_HALF)) * PROTO[tap]!;
      }
      const v = Math.round(acc);
      out.push(v > 32767 ? 32767 : v < -32768 ? -32768 : v);
      this.nextN++;
    }

    const minNeeded = this.nextN * 2 - TAP_HALF;
    const drop = Math.max(0, minNeeded - this.winBase);
    if (drop > 0) {
      this.window = this.window.slice(drop);
      this.winBase += drop;
    }
    return Int16Array.from(out);
  }
}

/**
 * A per-session pair of stateful transcoders for the VoiceLink bridge relay:
 * A-law 8k ⇄ PCM16 16k with cross-frame FIR continuity in both directions.
 */
export class VoicelinkTranscoder {
  private readonly up = new Upsampler8to16();     // PSTN A-law 8k → browser PCM16 16k
  private readonly down = new Downsampler16to8();  // browser PCM16 16k → PSTN A-law 8k

  /** PSTN A-law 8kHz → browser PCM16 16kHz. */
  alawToPcm16k(alaw: Buffer): Buffer {
    const pcm8k = decodeAlaw(alaw);
    const pcm16k = this.up.process(pcm8k);
    return int16ToBuffer(pcm16k);
  }

  /** Browser PCM16 16kHz → PSTN A-law 8kHz. */
  pcm16kToAlaw(pcm: Buffer): Buffer {
    const pcm16k = bufferToInt16(pcm);
    const pcm8k = this.down.process(pcm16k);
    return encodeAlaw(pcm8k);
  }

  reset(): void {
    this.up.reset();
    this.down.reset();
  }
}
