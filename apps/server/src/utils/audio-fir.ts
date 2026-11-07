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
//
// ─── Cost model ──────────────────────────────────────────────────────────────
//
// Every console call runs a `VoicelinkTranscoder` in both directions on the single
// event loop, 50 frames a second each way, so this file is the bridge's main CPU
// cost. In steady state the hot path allocates nothing but the Buffer it returns:
//   - each stateful resampler keeps ONE growable window of input samples and
//     drops consumed history with an in-place `copyWithin`; inbound A-law is
//     decoded straight into it, outbound PCM is written straight into the
//     returned Buffer;
//   - the tap loops index the window directly (no closure, no clamp, no
//     `Math.round` on tap positions): the 1:2 upsampler's kernel is split into its
//     two phases once at load, and the "samples before the first clamp to the
//     first sample" rule is met by writing the first sample into the window's
//     leading pad slots when it arrives;
//   - four outputs are filtered side by side (see Kernels), so the CPU overlaps
//     their multiply-add chains instead of waiting on one;
//   - the outbound A-law is encoded through a 64 KiB table (`alawEncodeTable`).
// The output is bit-identical to the plain per-sample formulation: every output
// sums the same products in the same order (tap 0 first), so floating-point
// rounding is unchanged. `test/unit/utils/audio-fir.reference.test.ts` compares
// every byte with a frozen copy of that formulation
// (`test/helpers/reference-audio-fir.ts`); `scripts/bench-transcoder.ts` measures
// the per-frame cost of both.

import { alawDecodeTable, alawEncodeTable, decodeMulaw, encodeMulaw } from './audio.js';

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

// ─── Kernels ─────────────────────────────────────────────────────────────────
//
// Upsampling 1:2 zero-stuffs the 8kHz input onto the 16kHz grid and low-passes it
// with PROTO; only the taps that land on real (non-zero) input samples contribute.
// Output m sits at input position m/2 and reaches input samples within ±UP_REACH:
//   even m = 2j: input j-8 … j+8 (17 taps) meet PROTO[0], PROTO[2], …, PROTO[32];
//   odd  m = 2j+1: input j-7 … j+8 (16 taps) meet PROTO[1], PROTO[3], …, PROTO[31].
// Both phases of input j need input j+8, so they are always emitted as a pair.
//
// Downsampling 2:1 low-passes with the full 33-tap PROTO and keeps every second
// sample: output n is centred on input 2n and reaches input 2n-16 … 2n+16.
//
// Each output is one serial chain of multiply-adds, summed tap 0 first. Reordering
// a chain would change the floating-point rounding, so instead the block kernels
// run FOUR outputs' chains side by side: each chain keeps its own order (the same
// double as the one-output kernels), and the CPU overlaps the four. The one-output
// kernels finish the 0–3 outputs a block cannot cover.
//
// Every kernel reads a window `w` around index `c` of the centre input sample;
// every index it reads must be inside `w` (callers pad the edges).

/** Input samples an upsampled output reaches either side of its position. */
const UP_REACH = TAP_HALF / 2;
/** Input samples a downsampled output reaches either side of its centre. */
const DOWN_REACH = TAP_HALF;

const UP_EVEN = new Float64Array(UP_REACH * 2 + 1); // 17 taps
for (let i = 0; i < UP_EVEN.length; i++) UP_EVEN[i] = PROTO[2 * i]!;
const UP_ODD = new Float64Array(UP_REACH * 2); // 16 taps
for (let i = 0; i < UP_ODD.length; i++) UP_ODD[i] = PROTO[2 * i + 1]!;

// Module-local handles on the A-law tables: a hot loop then reads a plain binding,
// not an imported one, which unbundled loaders (tsx, vitest) turn into a getter call.
const ALAW_DECODE: Int16Array = alawDecodeTable;
const ALAW_ENCODE: Uint8Array = alawEncodeTable;

// The μ-law tables, built once at load from the standard codec in `audio.ts` (so the two
// can never disagree): every codeword decoded, and every int16 sample encoded (64 KiB,
// indexed `sample + 32768`, as the A-law encode table is).
const MULAW_DECODE: Int16Array = decodeMulaw(Buffer.from(Array.from({ length: 256 }, (_, i) => i)));
const MULAW_ENCODE: Uint8Array = (() => {
  const all = new Int16Array(65536);
  for (let i = 0; i < 65536; i++) all[i] = i - 32768;
  return new Uint8Array(encodeMulaw(all));
})();

function clamp16(v: number): number {
  return v > 32767 ? 32767 : v < -32768 ? -32768 : v;
}

/** Upsampled output 2j, with input j at w[c]. */
function upEven(w: Int16Array, c: number): number {
  let acc = 0;
  for (let i = 0, k = c - UP_REACH; i < 17; i++, k++) acc += w[k]! * UP_EVEN[i]!;
  // 1:2 upsampling loses half the energy to the inserted zeros → ×2 restores gain.
  return clamp16(Math.round(acc * 2));
}

/** Upsampled output 2j+1, with input j at w[c]. */
function upOdd(w: Int16Array, c: number): number {
  let acc = 0;
  for (let i = 0, k = c - UP_REACH + 1; i < 16; i++, k++) acc += w[k]! * UP_ODD[i]!;
  return clamp16(Math.round(acc * 2));
}

/** Upsampled outputs 2j … 2j+3 (inputs j and j+1), with input j at w[c], into out[o…o+3]. */
function upBlock(w: Int16Array, c: number, out: Int16Array, o: number): void {
  let e0 = 0, o0 = 0, e1 = 0, o1 = 0;
  for (let i = 0, k = c - UP_REACH; i < 16; i++, k++) {
    const he = UP_EVEN[i]!, ho = UP_ODD[i]!;
    e0 += w[k]! * he;
    o0 += w[k + 1]! * ho;
    e1 += w[k + 1]! * he;
    o1 += w[k + 2]! * ho;
  }
  // The even phase's 17th tap (PROTO[32]) comes last, as in upEven.
  e0 += w[c + UP_REACH]! * UP_EVEN[16]!;
  e1 += w[c + UP_REACH + 1]! * UP_EVEN[16]!;
  out[o] = clamp16(Math.round(e0 * 2));
  out[o + 1] = clamp16(Math.round(o0 * 2));
  out[o + 2] = clamp16(Math.round(e1 * 2));
  out[o + 3] = clamp16(Math.round(o1 * 2));
}

/**
 * Upsample the inputs at w[from … to) to out[0 …), two outputs each. Every input
 * needs UP_REACH samples either side of it in `w`.
 */
function upsampleRun(w: Int16Array, from: number, to: number, out: Int16Array): void {
  let c = from;
  let o = 0;
  for (; c + 1 < to; c += 2, o += 4) upBlock(w, c, out, o);
  if (c < to) {
    out[o] = upEven(w, c);
    out[o + 1] = upOdd(w, c);
  }
}

/** Downsampled output centred on w[c]. */
function downOne(w: Int16Array, c: number): number {
  let acc = 0;
  for (let i = 0, k = c - DOWN_REACH; i < 33; i++, k++) acc += w[k]! * PROTO[i]!;
  return clamp16(Math.round(acc));
}

/** Downsampled outputs centred on w[c], w[c+2], w[c+4], w[c+6], into out[o…o+3]. */
function downBlock(w: Int16Array, c: number, out: Int16Array, o: number): void {
  let a0 = 0, a1 = 0, a2 = 0, a3 = 0;
  for (let i = 0, k = c - DOWN_REACH; i < 33; i++, k++) {
    const h = PROTO[i]!;
    a0 += w[k]! * h;
    a1 += w[k + 2]! * h;
    a2 += w[k + 4]! * h;
    a3 += w[k + 6]! * h;
  }
  out[o] = clamp16(Math.round(a0));
  out[o + 1] = clamp16(Math.round(a1));
  out[o + 2] = clamp16(Math.round(a2));
  out[o + 3] = clamp16(Math.round(a3));
}

/**
 * `count` downsampled outputs centred on w[from], w[from+2], … into out[0 …). Every
 * centre needs DOWN_REACH samples either side of it in `w`.
 */
function downsampleRun(w: Int16Array, from: number, count: number, out: Int16Array): void {
  let c = from;
  let o = 0;
  for (; o + 3 < count; o += 4, c += 8) downBlock(w, c, out, o);
  for (; o < count; o++, c += 2) out[o] = downOne(w, c);
}

/**
 * `input` with `pad` copies of its first sample in front and `pad` copies of its
 * last behind: the edge clamp of the stateless whole-buffer path. Non-empty input.
 */
function edgePadded(input: Int16Array, pad: number): Int16Array {
  const n = input.length;
  const p = new Int16Array(n + 2 * pad);
  p.fill(input[0]!, 0, pad);
  p.set(input, pad);
  p.fill(input[n - 1]!, pad + n);
  return p;
}

/**
 * Upsample PCM16 8kHz → 16kHz (1:2) via polyphase FIR.
 * Even output samples use the whole-tap phase, odd samples the half-tap phase.
 */
function upsample8to16(input: Int16Array): Int16Array {
  const out = new Int16Array(input.length * 2);
  if (input.length === 0) return out;
  upsampleRun(edgePadded(input, UP_REACH), UP_REACH, UP_REACH + input.length, out);
  return out;
}

/**
 * Downsample PCM16 16kHz → 8kHz (2:1) via polyphase FIR (low-pass then decimate).
 */
function downsample16to8(input: Int16Array): Int16Array {
  const out = new Int16Array(Math.floor(input.length / 2));
  if (out.length === 0) return out;
  downsampleRun(edgePadded(input, DOWN_REACH), DOWN_REACH, out.length, out);
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

function decodeAlawInto(alaw: Buffer, out: Int16Array): void {
  for (let i = 0; i < alaw.length; i++) out[i] = ALAW_DECODE[alaw[i]!]!;
}

/**
 * G.711 A-law 8kHz → PCM16 16kHz. Used PSTN→browser in the WebRTC bridge relay.
 */
export function alaw8kToPcm16k(alaw: Buffer): Buffer {
  const pcm8k = new Int16Array(alaw.length);
  decodeAlawInto(alaw, pcm8k);
  return int16ToBuffer(upsample8to16(pcm8k));
}

/**
 * PCM16 16kHz → G.711 A-law 8kHz. Used browser→PSTN in the WebRTC bridge relay.
 */
export function pcm16kToAlaw8k(pcm: Buffer): Buffer {
  const pcm8k = downsample16to8(bufferToInt16(pcm));
  return encodeAlawFrom(pcm8k, pcm8k.length);
}

/** A fresh Buffer of the first `n` samples of `pcm`, A-law encoded. */
function encodeAlawFrom(pcm: Int16Array, n: number): Buffer {
  // allocUnsafe: every byte is written below.
  const out = Buffer.allocUnsafe(n);
  for (let i = 0; i < n; i++) out[i] = ALAW_ENCODE[pcm[i]! + 32768]!;
  return out;
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
//
// Window layout: `win[0 … len)` holds the input still needed, and `next` is the
// index in `win` of the centre input sample of the next output. When the first
// sample after construction/reset() arrives, `reach` copies of it are written in
// front of it (the clamp above, paid once instead of per tap), so `next` starts at
// `reach`. After each call the window is shifted down so `win[0]` is the lowest
// sample the next output reads. The window grows (never truncates) to hold any
// frame, and shrinks back after an outsized one.

/** Window capacity in samples: a 20ms frame plus history fits three times over. */
const WINDOW_SAMPLES = 1024;

/** Growable input window shared by both resampler directions. */
class SampleWindow {
  win = new Int16Array(WINDOW_SAMPLES);
  len = 0;
  next: number;
  private started = false;

  constructor(private readonly reach: number) {
    this.next = reach;
  }

  reset(): void {
    if (this.win.length > WINDOW_SAMPLES) this.win = new Int16Array(WINDOW_SAMPLES);
    this.len = 0;
    this.next = this.reach;
    this.started = false;
  }

  /** Make room for `n` more samples and return the index to write them at. */
  reserve(n: number): number {
    const start = this.started ? this.len : this.reach;
    const need = start + n;
    if (need > this.win.length) {
      let cap = this.win.length * 2;
      while (cap < need) cap *= 2;
      const grown = new Int16Array(cap);
      grown.set(this.win.subarray(0, this.len));
      this.win = grown;
    }
    return start;
  }

  /** Record `n` samples written at the index `reserve(n)` returned. */
  commit(n: number): void {
    if (n === 0) return;
    if (!this.started) {
      this.win.fill(this.win[this.reach]!, 0, this.reach);
      this.len = this.reach;
      this.started = true;
    }
    this.len += n;
  }

  append(input: Int16Array): void {
    const at = this.reserve(input.length);
    this.win.set(input, at);
    this.commit(input.length);
  }

  /** Drop everything below `win[next - reach]`, the lowest sample still needed. */
  trim(): void {
    const drop = this.next - this.reach;
    if (drop <= 0) return;
    const keep = this.len - drop;
    if (this.win.length > WINDOW_SAMPLES && keep <= WINDOW_SAMPLES) {
      const shrunk = new Int16Array(WINDOW_SAMPLES);
      shrunk.set(this.win.subarray(drop, this.len));
      this.win = shrunk;
    } else {
      this.win.copyWithin(0, drop, this.len);
    }
    this.len = keep;
    this.next -= drop;
  }
}

/** PCM16 8kHz → 16kHz with cross-frame FIR continuity (1:2 upsample). */
export class Upsampler8to16 {
  private readonly w = new SampleWindow(UP_REACH);

  reset(): void {
    this.w.reset();
  }

  process(input: Int16Array): Int16Array {
    this.w.append(input);
    const out = new Int16Array(this.ready());
    this.emit(out);
    return out;
  }

  /** @internal Room for `n` 8kHz samples; write them at the returned index of `window()`. */
  reserve(n: number): number {
    return this.w.reserve(n);
  }

  /** @internal The window `reserve` returned an index into (valid until the next call). */
  window(): Int16Array {
    return this.w.win;
  }

  /** @internal Record `n` samples written after `reserve(n)`. */
  commit(n: number): void {
    this.w.commit(n);
  }

  /** @internal Outputs whose whole kernel has arrived: `emit` writes exactly this many. */
  ready(): number {
    // Input j's two outputs need input j + UP_REACH, the window's last sample at most.
    const pairs = this.w.len - UP_REACH - this.w.next;
    return pairs > 0 ? 2 * pairs : 0;
  }

  /** @internal Write `ready()` outputs to `out` and drop the history no longer needed. */
  emit(out: Int16Array): void {
    const end = this.w.len - UP_REACH;
    if (end <= this.w.next) return;
    upsampleRun(this.w.win, this.w.next, end, out);
    this.w.next = end;
    this.w.trim();
  }
}

/** PCM16 16kHz → 8kHz with cross-frame FIR continuity + phase (2:1 downsample). */
export class Downsampler16to8 {
  private readonly w = new SampleWindow(DOWN_REACH);

  reset(): void {
    this.w.reset();
  }

  process(input: Int16Array): Int16Array {
    this.w.append(input);
    const out = new Int16Array(this.ready());
    this.emit(out);
    return out;
  }

  /** @internal Append 16kHz samples to the window. */
  append(input: Int16Array): void {
    this.w.append(input);
  }

  /** @internal Outputs whose whole kernel has arrived: `emit` writes exactly this many. */
  ready(): number {
    // Output centred on win[c] needs win[c + DOWN_REACH]; centres step by 2.
    const span = this.w.len - 1 - DOWN_REACH - this.w.next;
    return span >= 0 ? (span >> 1) + 1 : 0;
  }

  /** @internal Write `ready()` outputs to `out` and drop the history no longer needed. */
  emit(out: Int16Array): void {
    const n = this.ready();
    if (n === 0) return;
    downsampleRun(this.w.win, this.w.next, n, out);
    this.w.next += 2 * n;
    this.w.trim();
  }
}

/**
 * A per-session pair of stateful transcoders for the VoiceLink bridge relay:
 * A-law 8k ⇄ PCM16 16k with cross-frame FIR continuity in both directions.
 *
 * Every Buffer returned is freshly allocated and owned by the caller (a send queue
 * may hold it): nothing returned is a view into state a later call overwrites.
 */
export class VoicelinkTranscoder {
  private readonly up = new Upsampler8to16();     // PSTN A-law 8k → browser PCM16 16k
  private readonly down = new Downsampler16to8();  // browser PCM16 16k → PSTN A-law 8k
  /** 8kHz samples on their way to the A-law encoder; never handed out. */
  private readonly pcm8k = new Int16Array(WINDOW_SAMPLES);

  /** PSTN A-law 8kHz → browser PCM16 16kHz. */
  alawToPcm16k(alaw: Buffer): Buffer {
    // Decode straight into the upsampler's window: no intermediate array.
    const at = this.up.reserve(alaw.length);
    const win = this.up.window();
    for (let i = 0; i < alaw.length; i++) win[at + i] = ALAW_DECODE[alaw[i]!]!;
    this.up.commit(alaw.length);

    const n = this.up.ready();
    // A fresh slice the caller owns; the samples are written straight into it.
    const out = Buffer.allocUnsafe(n * 2);
    if (out.byteOffset % 2 === 0) {
      this.up.emit(new Int16Array(out.buffer, out.byteOffset, n));
      return out;
    }
    // Pool slices are 8-byte aligned, so this is unreachable in practice; it keeps
    // the Int16Array view legal regardless.
    const pcm = new Int16Array(n);
    this.up.emit(pcm);
    return int16ToBuffer(pcm);
  }

  /** Browser PCM16 16kHz → PSTN A-law 8kHz. */
  pcm16kToAlaw(pcm: Buffer): Buffer {
    this.down.append(bufferToInt16(pcm));
    const n = this.down.ready();
    // An outsized frame gets a one-off array, so the scratch stays small.
    const pcm8k = n <= this.pcm8k.length ? this.pcm8k : new Int16Array(n);
    this.down.emit(pcm8k);
    return encodeAlawFrom(pcm8k, n);
  }

  reset(): void {
    this.up.reset();
    this.down.reset();
  }
}

/** A fresh Buffer of the first `n` samples of `pcm`, μ-law encoded. */
function encodeMulawFrom(pcm: Int16Array, n: number): Buffer {
  // allocUnsafe: every byte is written below.
  const out = Buffer.allocUnsafe(n);
  for (let i = 0; i < n; i++) out[i] = MULAW_ENCODE[pcm[i]! + 32768]!;
  return out;
}

/**
 * A per-session pair of stateful transcoders for a μ-law carrier leg (Plivo):
 * G.711 μ-law 8k ⇄ PCM16 16k, on the same streaming resamplers as
 * {@link VoicelinkTranscoder}, so framed output is bit-identical to whole-buffer output.
 *
 * Every Buffer returned is freshly allocated and owned by the caller.
 */
export class MulawTranscoder {
  private readonly up = new Upsampler8to16();     // PSTN μ-law 8k → browser PCM16 16k
  private readonly down = new Downsampler16to8();  // browser PCM16 16k → PSTN μ-law 8k
  /** 8kHz samples on their way to the μ-law encoder; never handed out. */
  private readonly pcm8k = new Int16Array(WINDOW_SAMPLES);

  /** PSTN μ-law 8kHz → browser PCM16 16kHz. */
  mulawToPcm16k(mulaw: Buffer): Buffer {
    const at = this.up.reserve(mulaw.length);
    const win = this.up.window();
    for (let i = 0; i < mulaw.length; i++) win[at + i] = MULAW_DECODE[mulaw[i]!]!;
    this.up.commit(mulaw.length);

    const n = this.up.ready();
    const out = Buffer.allocUnsafe(n * 2);
    if (out.byteOffset % 2 === 0) {
      this.up.emit(new Int16Array(out.buffer, out.byteOffset, n));
      return out;
    }
    const pcm = new Int16Array(n);
    this.up.emit(pcm);
    return int16ToBuffer(pcm);
  }

  /** Browser PCM16 16kHz → PSTN μ-law 8kHz. */
  pcm16kToMulaw(pcm: Buffer): Buffer {
    this.down.append(bufferToInt16(pcm));
    const n = this.down.ready();
    const pcm8k = n <= this.pcm8k.length ? this.pcm8k : new Int16Array(n);
    this.down.emit(pcm8k);
    return encodeMulawFrom(pcm8k, n);
  }

  reset(): void {
    this.up.reset();
    this.down.reset();
  }
}
