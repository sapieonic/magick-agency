import { describe, expect, it } from 'vitest';
import {
  AGENCY_STATION_ALAW8_FRAME_BYTES,
  AGENCY_STATION_ALAW8_MAX_FRAME_BYTES,
} from '@magick-agency/contracts/agency';
import {
  ALAW_FRAME_BYTES,
  ALAW_MAX_MESSAGE_BYTES,
  ALAW_SILENCE,
  AlawDownlinkDecoder,
  AlawUplinkEncoder,
  HALF_BAND_TAPS,
  HalfBandDecimator,
  HalfBandInterpolator,
  Pcm16UplinkFramer,
  alawDecodeSample,
  alawEncodeSample,
  floatToPcm16,
} from '../../../utils/alaw8/g711.js';

/**
 * The console's `alaw8` signal path (`utils/alaw8/g711.js`): what the capture worklet
 * puts on the station socket and what playback makes of what comes back.
 *
 * Three kinds of evidence, because each catches what the others miss:
 *  - **G.711 exactly.** Every one of the 65536 PCM16 inputs against an independent
 *    transcription of the reference encoder (Sun's public-domain `g711.c`, the form the
 *    server's `utils/audio.ts` tables follow), plus the known vectors.
 *  - **The same bytes as the agent app.** The checksums below are the ones that pin the
 *    app's Dart, Kotlin and Swift copies (`apps/mobile/packages/agent_audio/test`), so a
 *    browser and a phone agree on the A-law and on the half-band decimation, bit for bit.
 *  - **The behaviour a listener hears.** Pass band, alias and image rejection, and
 *    output that does not depend on how the stream was cut into blocks: state carried
 *    across frames is what keeps a 20 ms boundary from being a click.
 */

/** Sun `g711.c` `linear2alaw`, transcribed independently of the table-based codec. */
function referenceEncode(pcm: number): number {
  const segEnd = [0x1f, 0x3f, 0x7f, 0xff, 0x1ff, 0x3ff, 0x7ff, 0xfff];
  let v = pcm >> 3;
  let mask: number;
  if (v >= 0) {
    mask = 0xd5;
  } else {
    mask = 0x55;
    v = -v - 1;
  }
  let seg = 0;
  while (seg < 8 && v > segEnd[seg]!) seg++;
  if (seg >= 8) return 0x7f ^ mask;
  let aval = seg << 4;
  aval |= seg < 2 ? (v >> 1) & 0x0f : (v >> seg) & 0x0f;
  return aval ^ mask;
}

/** Sun `g711.c` `alaw2linear`. */
function referenceDecode(code: number): number {
  const a = code ^ 0x55;
  let t = (a & 0x0f) << 4;
  const seg = (a & 0x70) >> 4;
  if (seg === 0) t += 8;
  else if (seg === 1) t += 0x108;
  else {
    t += 0x108;
    t <<= seg - 1;
  }
  return (a & 0x80) !== 0 ? t : -t;
}

/** Shared with the agent app's `alaw_test.dart` / `ALawTest.kt`. */
const ENCODE_CHECKSUM = 297161535488;
const DECODE_CHECKSUM = 100139008;
/** Shared with the agent app's `half_band_test.dart` / `HalfBandDecimatorTest.kt`. */
const DECIMATOR_CHECKSUM = -40745250;

function tone(hz: number, rate: number, samples: number, amplitude = 10000): Int16Array {
  const x = new Int16Array(samples);
  for (let i = 0; i < samples; i++) x[i] = Math.round(amplitude * Math.sin((2 * Math.PI * hz * i) / rate));
  return x;
}

function floatTone(hz: number, rate: number, samples: number, amplitude = 0.3): Float32Array {
  const x = new Float32Array(samples);
  for (let i = 0; i < samples; i++) x[i] = amplitude * Math.sin((2 * Math.PI * hz * i) / rate);
  return x;
}

/** Amplitude of `hz` in `x` (Goertzel), skipping the filter's warm-up. */
function amplitude(x: ArrayLike<number>, hz: number, rate: number, skip = 100): number {
  const n = x.length - skip;
  const w = (2 * Math.PI * hz) / rate;
  const coeff = 2 * Math.cos(w);
  let s1 = 0;
  let s2 = 0;
  for (let i = skip; i < x.length; i++) {
    const s = x[i]! + coeff * s1 - s2;
    s2 = s1;
    s1 = s;
  }
  return (2 * Math.sqrt(s1 * s1 + s2 * s2 - coeff * s1 * s2)) / n;
}

const db = (ratio: number) => 20 * Math.log10(ratio);

function decimate(input: Int16Array, block = 320): Int16Array {
  const d = new HalfBandDecimator();
  const out = new Int16Array(input.length / 2);
  for (let i = 0; i < input.length; i += block) d.process(input, i, block, out, i / 2);
  return out;
}

function interpolate(input: Int16Array, block = 160): Int16Array {
  const it = new HalfBandInterpolator();
  const out = new Int16Array(input.length * 2);
  for (let i = 0; i < input.length; i += block) {
    const n = Math.min(block, input.length - i);
    it.process(input, i, n, out, i * 2);
  }
  return out;
}

/** The agent app's cross-language signal: a 1 kHz integer triangle plus LCG noise, 1 s at 16 kHz. */
function crossLanguageSignal(): Int16Array {
  const x = new Int16Array(16000);
  let rng = 1;
  for (let i = 0; i < x.length; i++) {
    // 64-bit integer arithmetic in Dart; BigInt here so the LCG is computed the same way.
    rng = Number((BigInt(rng) * 1103515245n + 12345n) & 0x7fffffffn);
    const noise = ((rng >> 16) % 8001) - 4000;
    const p = i % 16;
    const tri = p < 8 ? -16000 + p * 4000 : 16000 - (p - 8) * 4000;
    x[i] = tri + noise;
  }
  return x;
}

/** Push `samples` through `push` in blocks of `block`, collecting every emitted buffer. */
function collect(
  push: (samples: Float32Array, emit: (b: ArrayBuffer) => void) => void,
  samples: Float32Array,
  block: number,
): ArrayBuffer[] {
  const out: ArrayBuffer[] = [];
  for (let i = 0; i < samples.length; i += block) push(samples.subarray(i, i + block), (b) => out.push(b));
  return out;
}

function concat(buffers: ArrayBuffer[]): Uint8Array {
  const total = buffers.reduce((n, b) => n + b.byteLength, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const b of buffers) {
    out.set(new Uint8Array(b), off);
    off += b.byteLength;
  }
  return out;
}

describe('G.711 A-law', () => {
  it('encodes every 16-bit sample exactly as the G.711 reference does', () => {
    const mismatches: number[] = [];
    for (let x = -32768; x <= 32767; x++) {
      if (alawEncodeSample(x) !== referenceEncode(x)) mismatches.push(x);
    }
    expect(mismatches).toEqual([]);
  });

  it('decodes every code exactly as the G.711 reference does', () => {
    for (let c = 0; c < 256; c++) expect(alawDecodeSample(c), `code ${c}`).toBe(referenceDecode(c));
  });

  it('known vectors', () => {
    expect(alawEncodeSample(0)).toBe(0xd5);
    expect(alawEncodeSample(-1)).toBe(0x55);
    expect(alawEncodeSample(32767)).toBe(0xaa);
    expect(alawEncodeSample(-32768)).toBe(0x2a);
    expect(alawEncodeSample(1000)).toBe(0xfa);
    expect(alawEncodeSample(-1000)).toBe(0x7a);
    expect(alawDecodeSample(0xd5)).toBe(8);
    expect(alawDecodeSample(0x55)).toBe(-8);
    expect(alawDecodeSample(0xaa)).toBe(32256);
    expect(alawDecodeSample(0x2a)).toBe(-32256);
    expect(alawDecodeSample(0xfa)).toBe(1008);
    expect(ALAW_SILENCE).toBe(alawEncodeSample(0));
  });

  it('decode then encode returns the same code for all 256 codes', () => {
    for (let c = 0; c < 256; c++) expect(alawEncodeSample(alawDecodeSample(c)), `code ${c}`).toBe(c);
  });

  it('quantisation error stays within half a step of each segment', () => {
    for (let x = -32768; x <= 32767; x += 7) {
      const y = alawDecodeSample(alawEncodeSample(x));
      const mag = Math.abs(x);
      let step = 16;
      for (let edge = 512; edge <= mag && step < 1024; edge <<= 1) step <<= 1;
      expect(Math.abs(y - x), `sample ${x} -> ${y}`).toBeLessThanOrEqual(step / 2 + 1);
    }
  });

  it('agrees with the agent app (cross-language checksums)', () => {
    let enc = 0;
    for (let x = -32768; x <= 32767; x++) enc += alawEncodeSample(x) * (x + 32769);
    let dec = 0;
    for (let c = 0; c < 256; c++) dec += alawDecodeSample(c) * (c + 1);
    expect(enc).toBe(ENCODE_CHECKSUM);
    expect(dec).toBe(DECODE_CHECKSUM);
  });

  it('frames match the station contract', () => {
    expect(ALAW_FRAME_BYTES).toBe(AGENCY_STATION_ALAW8_FRAME_BYTES);
    expect(ALAW_MAX_MESSAGE_BYTES).toBe(AGENCY_STATION_ALAW8_MAX_FRAME_BYTES);
  });

  it('converts floats to PCM16 the way the pcm16 path always has', () => {
    for (const s of [0, 0.5, -0.5, 1, -1, 1.5, -1.5, 0.12345, -0.98765, Number.NaN]) {
      const clamped = Math.max(-1, Math.min(1, s));
      const viaInt16Array = new Int16Array([clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff])[0];
      expect(floatToPcm16(s), `sample ${s}`).toBe(viaInt16Array);
    }
  });
});

describe('the half-band filter', () => {
  it('taps are symmetric, half-band, and sum to unity gain in Q15', () => {
    expect(HALF_BAND_TAPS).toHaveLength(51);
    expect(HALF_BAND_TAPS.reduce((a, b) => a + b, 0)).toBe(32768);
    for (let k = 0; k < 51; k++) {
      expect(HALF_BAND_TAPS[k]).toBe(HALF_BAND_TAPS[50 - k]);
      if (k !== 25 && (k - 25) % 2 === 0) expect(HALF_BAND_TAPS[k], `tap ${k}`).toBe(0);
    }
  });

  describe('decimator 16 kHz -> 8 kHz (capture)', () => {
    it('agrees with the agent app bit for bit (cross-language checksum)', () => {
      const out = decimate(crossLanguageSignal());
      let sum = 0;
      for (let i = 0; i < out.length; i++) sum += out[i]! * ((i % 97) + 1);
      expect(sum).toBe(DECIMATOR_CHECKSUM);
    });

    it('passes DC', () => {
      const out = decimate(new Int16Array(3200).fill(10000));
      for (const v of out.subarray(100)) expect(v).toBeGreaterThanOrEqual(9998);
      for (const v of out.subarray(100)) expect(v).toBeLessThanOrEqual(10002);
    });

    it.each([300, 1000, 2000, 3000, 3400])('keeps %i Hz within 0.1 dB', (hz) => {
      const out = decimate(tone(hz, 16000, 16000));
      expect(Math.abs(db(amplitude(out, hz, 8000) / 10000))).toBeLessThan(0.1);
    });

    it.each([4600, 5000, 6000, 7500])('removes %i Hz before it can alias, by at least 55 dB', (hz) => {
      // Naive sample dropping would fold this to (8000 - hz) Hz at full strength.
      const out = decimate(tone(hz, 16000, 16000));
      expect(db(amplitude(out, 8000 - hz, 8000) / 10000)).toBeLessThan(-55);
    });

    it('does not depend on block size (state carries across calls)', () => {
      const x = crossLanguageSignal();
      expect(decimate(x, 2)).toEqual(decimate(x, 320));
      expect(decimate(x, 128)).toEqual(decimate(x, 320));
      expect(decimate(x, 1600)).toEqual(decimate(x, 320));
    });

    it('refuses odd or oversized blocks', () => {
      const d = new HalfBandDecimator();
      expect(() => d.process(new Int16Array(3), 0, 3, new Int16Array(2), 0)).toThrow(RangeError);
      expect(() => d.process(new Int16Array(1922), 0, 1922, new Int16Array(961), 0)).toThrow(RangeError);
    });

    it('reset() clears the history', () => {
      const x = crossLanguageSignal();
      const d = new HalfBandDecimator();
      const a = new Int16Array(160);
      const b = new Int16Array(160);
      d.process(x, 0, 320, a, 0);
      d.process(x, 320, 320, new Int16Array(160), 0);
      d.reset();
      d.process(x, 0, 320, b, 0);
      expect(b).toEqual(a);
    });
  });

  describe('interpolator 8 kHz -> 16 kHz (playback)', () => {
    it('keeps 1 kHz and suppresses its 7 kHz image by at least 55 dB', () => {
      const out = interpolate(tone(1000, 8000, 8000));
      expect(Math.abs(db(amplitude(out, 1000, 16000, 200) / 10000))).toBeLessThan(0.1);
      expect(db(amplitude(out, 7000, 16000, 200) / 10000)).toBeLessThan(-55);
    });

    it('a round trip through 8 kHz preserves in-band speech frequencies', () => {
      const back = interpolate(decimate(tone(800, 16000, 16000)));
      expect(Math.abs(db(amplitude(back, 800, 16000, 400) / 10000))).toBeLessThan(0.2);
    });

    it('joins 20 ms frames exactly as one long block would (no seam at a frame boundary)', () => {
      const x = tone(1000, 8000, 8000);
      const whole = interpolate(x, 960);
      expect(interpolate(x, 160)).toEqual(whole);
      expect(interpolate(x, 7)).toEqual(whole);
    });
  });
});

describe('AlawUplinkEncoder (capture: floats -> whole A-law frames)', () => {
  it('emits whole 160-byte frames from 128-sample render quanta, carrying the remainder', () => {
    const enc = new AlawUplinkEncoder(16000);
    const sizes: number[] = [];
    const pending: number[] = [];
    const quantum = floatTone(1000, 16000, 128);
    for (let q = 0; q < 10; q++) {
      enc.push(quantum, (b) => sizes.push(b.byteLength));
      pending.push(enc.pendingBytes);
    }
    // 64 bytes per quantum: frames complete after the 3rd, 5th, 8th and 10th quanta.
    expect(pending).toEqual([64, 128, 32, 96, 0, 64, 128, 32, 96, 0]);
    expect(sizes).toEqual([160, 160, 160, 160]);
  });

  it('cuts the stream only at frame boundaries, however it was pushed', () => {
    const x = floatTone(440, 16000, 16000);
    const reference = concat(collect((s, e) => new AlawUplinkEncoder(16000).push(s, e), x, x.length));
    for (const block of [128, 1, 7, 333, 2000]) {
      const enc = new AlawUplinkEncoder(16000);
      const buffers = collect((s, e) => enc.push(s, e), x, block);
      for (const b of buffers) expect(b.byteLength % ALAW_FRAME_BYTES).toBe(0);
      for (const b of buffers) expect(b.byteLength).toBeLessThanOrEqual(ALAW_MAX_MESSAGE_BYTES);
      expect(concat(buffers), `block ${block}`).toEqual(reference);
    }
    // 1 s at 16 kHz is 8000 A-law bytes: fifty frames, nothing held back.
    expect(reference.length).toBe(8000);
  });

  it('is the half-band decimation of the PCM16 input, then G.711', () => {
    const x = floatTone(1000, 16000, 3200);
    const pcm = Int16Array.from(x, floatToPcm16);
    const expected = Uint8Array.from(decimate(pcm, 320), alawEncodeSample);
    const enc = new AlawUplinkEncoder(16000);
    expect(concat(collect((s, e) => enc.push(s, e), x, 128))).toEqual(expected);
  });

  it('passes an 8 kHz context straight through to G.711', () => {
    const x = floatTone(1000, 8000, 1600);
    const enc = new AlawUplinkEncoder(8000);
    const out = concat(collect((s, e) => enc.push(s, e), x, 128));
    expect(out).toEqual(Uint8Array.from(x, (s) => alawEncodeSample(floatToPcm16(s))));
  });

  it('hands out a fresh buffer each time (safe to transfer)', () => {
    const enc = new AlawUplinkEncoder(16000);
    const buffers = collect((s, e) => enc.push(s, e), floatTone(1000, 16000, 1280), 128);
    expect(new Set(buffers).size).toBe(buffers.length);
  });

  it('refuses a context rate it cannot make A-law from', () => {
    expect(() => new AlawUplinkEncoder(44100)).toThrow(RangeError);
    expect(() => new AlawUplinkEncoder(48000)).toThrow(RangeError);
  });

  it('reset() drops the partial frame and the filter state', () => {
    const enc = new AlawUplinkEncoder(16000);
    enc.push(floatTone(1000, 16000, 128), () => {});
    expect(enc.pendingBytes).toBe(64);
    enc.reset();
    expect(enc.pendingBytes).toBe(0);
    const after = collect((s, e) => enc.push(s, e), floatTone(1000, 16000, 640), 128);
    const fresh = new AlawUplinkEncoder(16000);
    expect(concat(after)).toEqual(concat(collect((s, e) => fresh.push(s, e), floatTone(1000, 16000, 640), 128)));
  });
});

describe('Pcm16UplinkFramer (capture: the pcm16 fallback)', () => {
  it('emits 640-byte frames with the conversion the pcm16 path always used', () => {
    const framer = new Pcm16UplinkFramer();
    const x = floatTone(1000, 16000, 960);
    const frames = collect((s, e) => framer.push(s, e), x, 128);
    expect(frames.map((f) => f.byteLength)).toEqual([640, 640, 640]);
    const expected = new Int16Array(960);
    for (let i = 0; i < 960; i++) {
      const s = Math.max(-1, Math.min(1, x[i]!));
      expected[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    expect(new Int16Array(concat(frames).buffer)).toEqual(expected);
  });
});

describe('AlawDownlinkDecoder (playback: A-law frames -> 16 kHz floats)', () => {
  it('turns one 160-byte frame into 320 samples at 16 kHz', () => {
    const out = new AlawDownlinkDecoder().decode(new Uint8Array(160).fill(ALAW_SILENCE));
    expect(out).toBeInstanceOf(Float32Array);
    expect(out).toHaveLength(320);
  });

  it('decodes frame by frame exactly as one continuous stream (no click at a boundary)', () => {
    const bytes = Uint8Array.from(tone(1000, 8000, 8000), alawEncodeSample);
    const whole = new AlawDownlinkDecoder().decode(bytes);
    const framed = new AlawDownlinkDecoder();
    const pieces: Float32Array[] = [];
    for (let i = 0; i < bytes.length; i += 160) pieces.push(framed.decode(bytes.subarray(i, i + 160)));
    const joined = new Float32Array(whole.length);
    pieces.forEach((p, i) => joined.set(p, i * 320));
    expect(joined).toEqual(whole);

    // And the joins are as smooth as the inside of a frame: no step at any boundary is
    // larger than the steepest step of the tone itself.
    const steepest = (0.305 * 2 * Math.PI * 1000) / 16000;
    let worstAtBoundary = 0;
    for (let i = 320; i < joined.length; i += 320) {
      worstAtBoundary = Math.max(worstAtBoundary, Math.abs(joined[i]! - joined[i - 1]!));
    }
    expect(worstAtBoundary).toBeLessThan(steepest * 1.05);
  });

  it('a capture-to-playback round trip keeps a 1 kHz tone within 0.5 dB', () => {
    const x = floatTone(1000, 16000, 16000, 0.3);
    const enc = new AlawUplinkEncoder(16000);
    const dec = new AlawDownlinkDecoder();
    const frames = collect((s, e) => enc.push(s, e), x, 128);
    const out = new Float32Array(16000);
    let off = 0;
    for (const f of frames) {
      const pcm = dec.decode(new Uint8Array(f));
      out.set(pcm, off);
      off += pcm.length;
    }
    expect(off).toBe(16000);
    expect(Math.abs(db(amplitude(out, 1000, 16000, 400) / 0.3))).toBeLessThan(0.5);
  });

  it('reset() starts a new stream from silence', () => {
    const dec = new AlawDownlinkDecoder();
    const frame = Uint8Array.from(tone(1000, 8000, 160), alawEncodeSample);
    const first = dec.decode(frame);
    dec.decode(frame);
    dec.reset();
    expect(dec.decode(frame)).toEqual(first);
  });

  it('decodes a message of any length', () => {
    expect(new AlawDownlinkDecoder().decode(new Uint8Array(1))).toHaveLength(2);
    expect(new AlawDownlinkDecoder().decode(new Uint8Array(8000))).toHaveLength(16000);
  });
});
