// The console's `media=alaw8` signal path: G.711 A-law and the 16 kHz <-> 8 kHz half-band
// filters, as one dependency-free module.
//
// ── Why plain JavaScript ────────────────────────────────────────────────────────────
// This file runs in two places: imported by the main thread (playback decodes the
// downlink here) and, as its own source text, inside the capture AudioWorklet
// (`utils/audio-worklet-processor.ts` reads it with `?raw`). A worklet module cannot
// import from the app bundle, and code that went through the bundler's transforms
// (helpers for class fields, renamed module bindings) cannot be lifted out of it with
// `Function.prototype.toString`. Plain JS loaded as text is byte-for-byte what the
// worklet runs, in development and in a production build alike. The types are in
// `g711.d.ts`; the behaviour is pinned by `__tests__/utils/alaw8/g711.test.ts`.
//
// Rules for this file, because it is evaluated as a worklet module too:
//   - no `import`, no reference to anything outside the file except built-ins;
//   - `export` only at the start of a line (the worklet assembly strips it);
//   - no class fields: state is assigned in constructors.
//
// ── What it mirrors ─────────────────────────────────────────────────────────────────
// The agent app's reference DSP (`apps/mobile/packages/agent_audio/lib/src/codec/`):
// the same A-law tables, the same 51-tap half-band filter in the same Q15 integer
// arithmetic. The tests check this file against the cross-language checksums that pin
// the app's Dart, Kotlin and Swift copies, so a browser and a phone put the same bytes
// on the station socket for the same input.

/** Bytes in one 20 ms `alaw8` frame (8000 samples/s x 0.02 s x 1 byte). */
export const ALAW_FRAME_BYTES = 160;

/** The largest `alaw8` message the server accepts from a client: 1 s of audio. */
export const ALAW_MAX_MESSAGE_BYTES = 8000;

/** A-law digital silence: `encode(0)`. */
export const ALAW_SILENCE = 0xd5;

// ── G.711 A-law ──────────────────────────────────────────────────────────────────────
// Encoding works on the 13-bit magnitude (`sample >> 3`) through a 4096-entry table of
// un-masked codes; decoding is a 256-entry table. Built once, no allocation per sample.

const ALAW_SEG_END = [0x1f, 0x3f, 0x7f, 0xff, 0x1ff, 0x3ff, 0x7ff, 0xfff];

const ALAW_ENCODE = (() => {
  const table = new Uint8Array(4096);
  for (let m = 0; m < 4096; m++) {
    let seg = 0;
    while (seg < 8 && m > ALAW_SEG_END[seg]) seg++;
    // m <= 0xfff always lands in segment 0..7, so no clipping branch is needed.
    const quant = seg < 2 ? (m >> 1) & 0x0f : (m >> seg) & 0x0f;
    table[m] = (seg << 4) | quant;
  }
  return table;
})();

const ALAW_DECODE = (() => {
  const table = new Int16Array(256);
  for (let code = 0; code < 256; code++) {
    const a = code ^ 0x55;
    let t = (a & 0x0f) << 4;
    const seg = (a & 0x70) >> 4;
    if (seg === 0) t += 8;
    else if (seg === 1) t += 0x108;
    else t = (t + 0x108) << (seg - 1);
    // The sign bit SET means positive in A-law.
    table[code] = (a & 0x80) !== 0 ? t : -t;
  }
  return table;
})();

/** One signed 16-bit sample to its A-law byte (G.711). */
export function alawEncodeSample(sample) {
  // Arithmetic shift keeps the sign; a negative magnitude folds to -m - 1 exactly as the
  // G.711 reference does, so both halves index the same table.
  const m = sample >> 3;
  return m >= 0 ? ALAW_ENCODE[m] ^ 0xd5 : ALAW_ENCODE[-m - 1] ^ 0x55;
}

/** One A-law byte to its signed 16-bit sample (G.711). */
export function alawDecodeSample(code) {
  return ALAW_DECODE[code & 0xff];
}

/** A float sample in [-1, 1] to PCM16, the conversion the `pcm16` path has always used. */
export function floatToPcm16(s) {
  const c = s < -1 ? -1 : s > 1 ? 1 : s;
  // `| 0` truncates toward zero like an Int16Array store, and maps NaN to 0.
  return (c < 0 ? c * 0x8000 : c * 0x7fff) | 0;
}

/** PCM16 to a float sample in [-1, 1], the inverse the playback path has always used. */
export function pcm16ToFloat(v) {
  return v / (v < 0 ? 0x8000 : 0x7fff);
}

// ── The half-band filter ─────────────────────────────────────────────────────────────
// 51 taps (Kaiser beta 5.65, cut-off fs/4) in Q15, summing to 32768 (unity DC gain).
// Flat to 3.4 kHz; everything from 4.6 kHz up is at least 59 dB down, so the only
// content that can alias on the way down lands in 3.4-4 kHz, above the telephone band.
// Every even offset from the centre is zero: a decimator needs 27 multiplies per output.

export const HALF_BAND_TAPS = [
  9, 0, -25, 0, 52, 0, -96, 0, 160, 0, -253, 0, 383, 0, -564, 0, 823, 0, -1214, 0, 1881, 0,
  -3350, 0, 10387, 16382, 10387, 0, -3350, 0, 1881, 0, -1214, 0, 823, 0, -564, 0, 383, 0,
  -253, 0, 160, 0, -96, 0, 52, 0, -25, 0, 9,
];

const HB_TAPS = 51;
const HB_CENTRE = 25;

function clamp16(v) {
  return v > 32767 ? 32767 : v < -32768 ? -32768 : v;
}

/**
 * Streaming 2:1 decimator, 16 kHz -> 8 kHz, low-pass first. Keeps its filter history
 * across calls, so consecutive blocks join without a seam whatever their sizes.
 */
export class HalfBandDecimator {
  constructor() {
    /** The last 50 input samples, then the current block. */
    this.history = new Int16Array(HB_TAPS - 1 + HalfBandDecimator.MAX_BLOCK);
  }

  /** A new call starts from silence. */
  reset() {
    this.history.fill(0);
  }

  /**
   * Decimate `count` samples of `input` from `inputOffset` (count even, at most
   * `MAX_BLOCK`) into `output` from `outputOffset`. Returns the samples written.
   */
  process(input, inputOffset, count, output, outputOffset) {
    if (count % 2 !== 0 || count > HalfBandDecimator.MAX_BLOCK || count < 0) {
      throw new RangeError('count must be even and at most ' + HalfBandDecimator.MAX_BLOCK);
    }
    const hist = HB_TAPS - 1;
    const h = this.history;
    h.set(input.subarray(inputOffset, inputOffset + count), hist);
    let o = outputOffset;
    for (let i = 0; i < count; i += 2) {
      // Output aligned with input sample i: y = sum h[k] * x[i - k].
      const base = i + hist;
      let acc = 0;
      for (let k = 0; k < HB_TAPS; k += 2) acc += HALF_BAND_TAPS[k] * h[base - k];
      acc += HALF_BAND_TAPS[HB_CENTRE] * h[base - HB_CENTRE];
      // Floor division, i.e. an arithmetic shift by 15 with rounding: the Q15 reference.
      output[o++] = clamp16(Math.floor((acc + 16384) / 32768));
    }
    h.copyWithin(0, count, count + hist);
    return count / 2;
  }
}
/** Largest block per call: one 20 ms frame at 48 kHz, with room to spare. */
HalfBandDecimator.MAX_BLOCK = 1920;

/**
 * Streaming 1:2 interpolator, 8 kHz -> 16 kHz: zero-stuff, then the same low-pass with
 * gain 2, computed polyphase. Keeps its history across calls, so frame boundaries are
 * as smooth as the inside of a frame (no click every 20 ms).
 */
export class HalfBandInterpolator {
  constructor() {
    /** The last 25 input samples, then the current block. */
    this.history = new Int16Array(HB_CENTRE + HalfBandInterpolator.MAX_BLOCK);
  }

  reset() {
    this.history.fill(0);
  }

  /**
   * Interpolate `count` samples of `input` from `inputOffset` (at most `MAX_BLOCK`)
   * into `output` from `outputOffset`, writing `2 * count`. Returns the samples written.
   */
  process(input, inputOffset, count, output, outputOffset) {
    if (count > HalfBandInterpolator.MAX_BLOCK || count < 0) {
      throw new RangeError('count must be at most ' + HalfBandInterpolator.MAX_BLOCK);
    }
    const span = HB_CENTRE;
    const h = this.history;
    h.set(input.subarray(inputOffset, inputOffset + count), span);
    let o = outputOffset;
    for (let i = 0; i < count; i++) {
      const c = i + span;
      // Zero-stuffed u[2m] = x[m]; y[p] = 2 * sum h[k] * u[p - k].
      // y[2c]: only even k meet a non-zero u -> 2 * sum_j h[2j] * x[c - j], j = 0..25.
      let acc = 0;
      for (let j = 0; j <= 25; j++) acc += HALF_BAND_TAPS[2 * j] * h[c - j];
      // y[2c + 1]: only the centre tap (the one odd non-zero tap) -> 2 * h[25] * x[c - 12].
      const odd = 2 * HALF_BAND_TAPS[HB_CENTRE] * h[c - 12];
      output[o++] = clamp16(Math.floor((2 * acc + 16384) / 32768));
      output[o++] = clamp16(Math.floor((odd + 16384) / 32768));
    }
    h.copyWithin(0, count, count + span);
    return count * 2;
  }
}
HalfBandInterpolator.MAX_BLOCK = 960;

// ── Uplink: microphone floats -> whole 20 ms A-law frames ────────────────────────────

/**
 * The capture side of `alaw8`: float samples at the capture context's rate in, whole
 * 160-byte A-law frames out.
 *
 * The capture context runs at 16 kHz, so each block is low-passed and decimated 2:1
 * before it is encoded (an 8 kHz context is passed straight through: the browser has
 * already resampled). A render quantum is 128 samples, 64 at 8 kHz, which is not a
 * whole frame: the bytes short of a frame are held for the next block, as is a single
 * odd input sample, so the output is one continuous stream cut only at frame
 * boundaries.
 */
export class AlawUplinkEncoder {
  /** @param inputRate the capture context's sample rate: 16000 or 8000. */
  constructor(inputRate) {
    if (inputRate !== 16000 && inputRate !== 8000) {
      throw new RangeError('alaw8 capture needs a 16000 or 8000 Hz context, not ' + inputRate);
    }
    this.decimate = inputRate === 16000;
    this.decimator = new HalfBandDecimator();
    /** Input converted to PCM16, plus at most one odd sample carried from the last call. */
    this.pcm = new Int16Array(HalfBandDecimator.MAX_BLOCK);
    this.pcmFill = 0;
    this.pcm8 = new Int16Array(HalfBandDecimator.MAX_BLOCK / 2);
    /** Encoded bytes short of a whole frame, waiting for the next call. */
    this.pending = new Uint8Array(ALAW_MAX_MESSAGE_BYTES);
    this.pendingFill = 0;
  }

  /** Drop the filter state and any partial frame: a new stream starts clean. */
  reset() {
    this.decimator.reset();
    this.pcmFill = 0;
    this.pendingFill = 0;
  }

  /** Bytes held back for the next frame (always fewer than one frame). */
  get pendingBytes() {
    return this.pendingFill;
  }

  /**
   * Encode `samples` (floats in [-1, 1]) and hand every whole frame to `emit` as a fresh
   * `ArrayBuffer` holding a whole number of frames, at most `ALAW_MAX_MESSAGE_BYTES`
   * (the receiver may transfer it). A 128-sample render quantum yields at most one
   * frame; the bytes short of a frame wait for the next call.
   */
  push(samples, emit) {
    let i = 0;
    const n = samples.length;
    while (i < n) {
      const take = Math.min(this.pcm.length - this.pcmFill, n - i);
      for (let k = 0; k < take; k++) this.pcm[this.pcmFill + k] = floatToPcm16(samples[i + k]);
      this.pcmFill += take;
      i += take;
      this.drain();
      // After every block, so `pending` never holds more than one block plus a partial
      // frame: it cannot overflow, whatever size the caller pushes.
      this.emitWhole(emit);
    }
  }

  /** Encode what is buffered in `pcm`, leaving an odd sample for the decimator's next call. */
  drain() {
    if (!this.decimate) {
      this.encode(this.pcm, this.pcmFill);
      this.pcmFill = 0;
      return;
    }
    const even = this.pcmFill - (this.pcmFill % 2);
    if (even === 0) return;
    const written = this.decimator.process(this.pcm, 0, even, this.pcm8, 0);
    this.encode(this.pcm8, written);
    if (even < this.pcmFill) this.pcm[0] = this.pcm[even];
    this.pcmFill -= even;
  }

  encode(pcm, count) {
    const out = this.pending;
    let fill = this.pendingFill;
    for (let k = 0; k < count; k++) out[fill++] = alawEncodeSample(pcm[k]);
    this.pendingFill = fill;
  }

  emitWhole(emit) {
    const whole = this.pendingFill - (this.pendingFill % ALAW_FRAME_BYTES);
    if (whole === 0) return;
    emit(this.pending.slice(0, whole).buffer);
    this.pending.copyWithin(0, whole, this.pendingFill);
    this.pendingFill -= whole;
  }
}

// ── Uplink: microphone floats -> 20 ms PCM16 frames (the `pcm16` fallback) ───────────

/**
 * The `pcm16` side, unchanged in output: 320 samples (640 bytes, 20 ms at 16 kHz) per
 * frame, with the same float conversion as always. Partial frames carry over.
 */
export class Pcm16UplinkFramer {
  constructor() {
    this.frame = new Int16Array(Pcm16UplinkFramer.FRAME_SAMPLES);
    this.fill = 0;
  }

  reset() {
    this.fill = 0;
  }

  /** Hand each whole frame to `emit` as a fresh `ArrayBuffer` of 640 bytes. */
  push(samples, emit) {
    const size = Pcm16UplinkFramer.FRAME_SAMPLES;
    for (let i = 0; i < samples.length; i++) {
      this.frame[this.fill++] = floatToPcm16(samples[i]);
      if (this.fill === size) {
        emit(this.frame.slice().buffer);
        this.fill = 0;
      }
    }
  }
}
Pcm16UplinkFramer.FRAME_SAMPLES = 320;

// ── Downlink: A-law frames -> 16 kHz floats ──────────────────────────────────────────

/**
 * The playback side of `alaw8`: A-law bytes in (any length; the server sends one 20 ms
 * frame per message), 16 kHz floats out, twice as many samples as bytes. The
 * interpolator's history survives between calls, so consecutive frames join without a
 * click; `reset()` when a new stream starts.
 */
export class AlawDownlinkDecoder {
  constructor() {
    this.interpolator = new HalfBandInterpolator();
    this.pcm8 = new Int16Array(HalfBandInterpolator.MAX_BLOCK);
    this.pcm16 = new Int16Array(HalfBandInterpolator.MAX_BLOCK * 2);
  }

  reset() {
    this.interpolator.reset();
  }

  /** Decode `bytes` (a Uint8Array) into a new Float32Array of `2 * bytes.length` samples. */
  decode(bytes) {
    const out = new Float32Array(bytes.length * 2);
    const block = HalfBandInterpolator.MAX_BLOCK;
    for (let off = 0; off < bytes.length; off += block) {
      const n = Math.min(block, bytes.length - off);
      for (let k = 0; k < n; k++) this.pcm8[k] = ALAW_DECODE[bytes[off + k]];
      this.interpolator.process(this.pcm8, 0, n, this.pcm16, 0);
      const base = off * 2;
      for (let k = 0; k < 2 * n; k++) out[base + k] = pcm16ToFloat(this.pcm16[k]);
    }
    return out;
  }
}
