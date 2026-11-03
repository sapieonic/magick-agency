/**
 * Bit-identity guard for the bridge transcoder and the A-law codec.
 *
 * `src/utils/audio-fir.ts` and the A-law half of `src/utils/audio.ts` were rewritten for
 * speed (preallocated windows, split even/odd tap phases, a 64 KiB encode table). The
 * rewrite promises the SAME bytes as before for every input. These tests compare it,
 * byte for byte, with a frozen copy of the pre-rewrite code (`test/helpers/
 * reference-audio-fir.ts`) over seeded random streams: mixed frame sizes (empty, one
 * sample, odd, the 20 ms frame, up to the bridge's largest accepted frame), clipping
 * signals, `reset()` mid-stream, misaligned and odd-length PCM buffers, and an
 * exhaustive sweep of the A-law encoder over all 65,536 int16 values.
 *
 * Outputs are collected and compared only after the whole stream has run, so a result
 * that aliased internal scratch (overwritten by a later call) would show up as a diff.
 *
 * `LOAD_SEED` reproduces a red run (`test/helpers/load-scale.ts`).
 */
import { describe, it, expect } from 'vitest';
import {
  alaw8kToPcm16k,
  pcm16kToAlaw8k,
  Upsampler8to16,
  Downsampler16to8,
  VoicelinkTranscoder,
} from '../../../src/utils/audio-fir.js';
import { decodeAlaw, encodeAlaw } from '../../../src/utils/audio.js';
import {
  referenceAlaw8kToPcm16k,
  referencePcm16kToAlaw8k,
  referenceDecodeAlaw,
  referenceEncodeAlaw,
  referenceEncodeAlawSample,
  ReferenceUpsampler8to16,
  ReferenceDownsampler16to8,
  ReferenceVoicelinkTranscoder,
} from '../../helpers/reference-audio-fir.js';
import { createRng, LOAD_SEED, type Rng } from '../../helpers/load-scale.js';

/** Largest decoded media frame the bridge can hand the codec (base64 bound × 3/4). */
const MAX_BRIDGE_FRAME_BYTES = Math.floor((64000 * 2 * 3) / 4);

/** A frame length in samples, weighted toward the shapes the relay actually sees. */
function frameSamples(rng: Rng, typical: number): number {
  const r = rng.next();
  if (r < 0.45) return typical;
  if (r < 0.55) return rng.pick([0, 1, 2, 3]);
  if (r < 0.75) return rng.int(1, 64) * 2 + 1; // odd
  if (r < 0.95) return rng.int(0, 4 * typical);
  return rng.int(4 * typical, 20 * typical);
}

type Shape = 'noise' | 'tone' | 'clip' | 'silence' | 'quiet';

/** int16 samples of a given character; `clip` drives the FIR into its int16 clamps. */
function samples(rng: Rng, n: number, shape: Shape, phase: number): Int16Array {
  const s = new Int16Array(n);
  const freq = rng.int(50, 3900);
  for (let i = 0; i < n; i++) {
    switch (shape) {
      case 'noise': s[i] = rng.int(-32768, 32767); break;
      case 'tone': s[i] = Math.round(12000 * Math.sin((2 * Math.PI * freq * (phase + i)) / 8000)); break;
      case 'clip': s[i] = (i >> rng.int(0, 2)) & 1 ? 32767 : -32768; break;
      case 'silence': s[i] = 0; break;
      case 'quiet': s[i] = rng.int(-24, 24); break;
    }
  }
  return s;
}

const SHAPES: readonly Shape[] = ['noise', 'tone', 'clip', 'silence', 'quiet'];

/** PCM16 bytes, sometimes at an odd byteOffset and sometimes with a stray trailing byte. */
function pcmBytes(rng: Rng, pcm: Int16Array): Buffer {
  const strayByte = rng.chance(0.1) ? 1 : 0;
  const misaligned = rng.chance(0.15) ? 1 : 0;
  const backing = Buffer.alloc(misaligned + pcm.byteLength + strayByte);
  for (let i = 0; i < pcm.length; i++) backing.writeInt16LE(pcm[i]!, misaligned + i * 2);
  if (strayByte) backing[backing.length - 1] = rng.int(0, 255);
  return backing.subarray(misaligned);
}

function alawBytes(rng: Rng, n: number, shape: Shape, phase: number): Buffer {
  if (shape === 'noise') {
    const b = Buffer.alloc(n);
    for (let i = 0; i < n; i++) b[i] = rng.int(0, 255);
    return b;
  }
  return referenceEncodeAlaw(samples(rng, n, shape, phase));
}

function firstDiff(a: Uint8Array, b: Uint8Array): string {
  if (a.length !== b.length) return `length ${a.length} vs reference ${b.length}`;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return `byte ${i}: ${a[i]} vs reference ${b[i]}`;
  return 'equal';
}

function bytesOf(x: Int16Array): Uint8Array {
  return new Uint8Array(x.buffer, x.byteOffset, x.byteLength);
}

interface Step { dir: 'up' | 'down' | 'reset' | 'resetUp' | 'resetDown'; out: Uint8Array; ref: Uint8Array; frame: number }

function expectSame(steps: Step[], seed: number): void {
  // Compared only now, after every call has run: catches results that alias scratch.
  let checked = 0;
  for (const s of steps) {
    if (s.dir === 'reset' || s.dir === 'resetUp' || s.dir === 'resetDown') continue;
    const diff = firstDiff(s.out, s.ref);
    if (diff !== 'equal') {
      throw new Error(`seed ${seed}, frame ${s.frame} (${s.dir}): ${diff}`);
    }
    checked++;
  }
  expect(checked).toBeGreaterThan(0);
}

describe('VoicelinkTranscoder is bit-identical to the pre-rewrite reference', () => {
  it.each([1, 2, 3, 4])('seeded mixed stream #%i: both directions, mixed frame sizes, reset() mid-stream', (n) => {
    const seed = LOAD_SEED + n;
    const rng = createRng(seed);
    const t = new VoicelinkTranscoder();
    const ref = new ReferenceVoicelinkTranscoder();
    const steps: Step[] = [];
    let phase = 0;
    let shape: Shape = 'tone';
    for (let f = 0; f < 1500; f++) {
      if (rng.chance(0.05)) shape = rng.pick(SHAPES);
      if (rng.chance(0.01)) {
        t.reset();
        ref.reset();
        steps.push({ dir: 'reset', out: new Uint8Array(0), ref: new Uint8Array(0), frame: f });
      }
      if (rng.chance(0.5)) {
        const alaw = alawBytes(rng, frameSamples(rng, 160), shape, phase);
        phase += alaw.length;
        const copy = Buffer.from(alaw);
        steps.push({ dir: 'up', out: t.alawToPcm16k(alaw), ref: ref.alawToPcm16k(copy), frame: f });
        // The caller's buffer is theirs: the transcoder must not write into it.
        expect(alaw.equals(copy)).toBe(true);
      } else {
        const pcm = pcmBytes(rng, samples(rng, frameSamples(rng, 320), shape, phase));
        const copy = Buffer.from(pcm);
        steps.push({ dir: 'down', out: t.pcm16kToAlaw(pcm), ref: ref.pcm16kToAlaw(pcm), frame: f });
        expect(pcm.equals(copy)).toBe(true);
      }
    }
    expectSame(steps, seed);
  });

  it('a caller that reuses one input buffer for every frame gets the reference output', () => {
    const seed = LOAD_SEED + 10;
    const rng = createRng(seed);
    const t = new VoicelinkTranscoder();
    const ref = new ReferenceVoicelinkTranscoder();
    const alaw = Buffer.alloc(160);
    const pcm = Buffer.alloc(640);
    const steps: Step[] = [];
    for (let f = 0; f < 400; f++) {
      for (let i = 0; i < alaw.length; i++) alaw[i] = rng.int(0, 255);
      for (let i = 0; i < 320; i++) pcm.writeInt16LE(rng.int(-32768, 32767), i * 2);
      steps.push({ dir: 'up', out: t.alawToPcm16k(alaw), ref: ref.alawToPcm16k(alaw), frame: f });
      steps.push({ dir: 'down', out: t.pcm16kToAlaw(pcm), ref: ref.pcm16kToAlaw(pcm), frame: f });
    }
    expectSame(steps, seed);
  });

  it('a long steady 20 ms stream (2 minutes each way) stays identical', () => {
    const seed = LOAD_SEED + 11;
    const rng = createRng(seed);
    const t = new VoicelinkTranscoder();
    const ref = new ReferenceVoicelinkTranscoder();
    const steps: Step[] = [];
    for (let f = 0; f < 6000; f++) {
      const shape = SHAPES[(f >> 6) % SHAPES.length]!;
      const alaw = alawBytes(rng, 160, shape, f * 160);
      steps.push({ dir: 'up', out: t.alawToPcm16k(alaw), ref: ref.alawToPcm16k(alaw), frame: f });
      const pcm = pcmBytes(rng, samples(rng, 320, shape, f * 320));
      steps.push({ dir: 'down', out: t.pcm16kToAlaw(pcm), ref: ref.pcm16kToAlaw(pcm), frame: f });
    }
    expectSame(steps, seed);
  });

  it('the largest frame the bridge accepts, in both directions, between ordinary frames', () => {
    const seed = LOAD_SEED + 12;
    const rng = createRng(seed);
    const t = new VoicelinkTranscoder();
    const ref = new ReferenceVoicelinkTranscoder();
    const steps: Step[] = [];
    const sizes = [160, MAX_BRIDGE_FRAME_BYTES, 160, 1, MAX_BRIDGE_FRAME_BYTES - 1, 160, 0, 160];
    sizes.forEach((bytes, f) => {
      const alaw = alawBytes(rng, bytes, 'tone', 0);
      steps.push({ dir: 'up', out: t.alawToPcm16k(alaw), ref: ref.alawToPcm16k(alaw), frame: f });
      const pcm = pcmBytes(rng, samples(rng, Math.floor(bytes / 2), 'noise', 0));
      steps.push({ dir: 'down', out: t.pcm16kToAlaw(pcm), ref: ref.pcm16kToAlaw(pcm), frame: f });
    });
    expectSame(steps, seed);
  });

  it('empty frames, single samples and reset() before any audio', () => {
    const t = new VoicelinkTranscoder();
    const ref = new ReferenceVoicelinkTranscoder();
    const steps: Step[] = [];
    const ops: Array<() => void> = [
      () => { t.reset(); ref.reset(); },
      () => steps.push({ dir: 'up', out: t.alawToPcm16k(Buffer.alloc(0)), ref: ref.alawToPcm16k(Buffer.alloc(0)), frame: 0 }),
      () => steps.push({ dir: 'down', out: t.pcm16kToAlaw(Buffer.alloc(0)), ref: ref.pcm16kToAlaw(Buffer.alloc(0)), frame: 0 }),
      () => steps.push({ dir: 'down', out: t.pcm16kToAlaw(Buffer.from([7])), ref: ref.pcm16kToAlaw(Buffer.from([7])), frame: 0 }),
    ];
    for (const op of ops) op();
    for (let f = 1; f <= 60; f++) {
      const a = Buffer.from([(f * 37) & 0xff]);
      steps.push({ dir: 'up', out: t.alawToPcm16k(a), ref: ref.alawToPcm16k(a), frame: f });
      const p = Buffer.alloc(2);
      p.writeInt16LE(f % 2 ? 32767 : -32768, 0);
      steps.push({ dir: 'down', out: t.pcm16kToAlaw(p), ref: ref.pcm16kToAlaw(p), frame: f });
      if (f === 30) { t.reset(); ref.reset(); }
    }
    expectSame(steps, 0);
  });
});

describe('Upsampler8to16 / Downsampler16to8 are bit-identical to the pre-rewrite reference', () => {
  it.each([1, 2])('seeded mixed stream #%i on the resamplers directly, with independent resets', (n) => {
    const seed = LOAD_SEED + 20 + n;
    const rng = createRng(seed);
    const up = new Upsampler8to16();
    const down = new Downsampler16to8();
    const refUp = new ReferenceUpsampler8to16();
    const refDown = new ReferenceDownsampler16to8();
    const steps: Step[] = [];
    let shape: Shape = 'noise';
    for (let f = 0; f < 1200; f++) {
      if (rng.chance(0.05)) shape = rng.pick(SHAPES);
      if (rng.chance(0.01)) { up.reset(); refUp.reset(); steps.push({ dir: 'resetUp', out: new Uint8Array(0), ref: new Uint8Array(0), frame: f }); }
      if (rng.chance(0.01)) { down.reset(); refDown.reset(); steps.push({ dir: 'resetDown', out: new Uint8Array(0), ref: new Uint8Array(0), frame: f }); }
      // Inputs are sometimes views into a larger array, as the relay's subarray() callers pass.
      const pad = rng.int(0, 3);
      const len8 = frameSamples(rng, 160);
      const in8 = samples(rng, len8 + 2 * pad, shape, f * 160).subarray(pad, pad + len8);
      const outUp = up.process(in8);
      expect(outUp).toBeInstanceOf(Int16Array);
      steps.push({ dir: 'up', out: bytesOf(outUp), ref: bytesOf(refUp.process(in8)), frame: f });
      const in16 = samples(rng, frameSamples(rng, 320), shape, f * 320);
      const outDown = down.process(in16);
      expect(outDown).toBeInstanceOf(Int16Array);
      steps.push({ dir: 'down', out: bytesOf(outDown), ref: bytesOf(refDown.process(in16)), frame: f });
    }
    expectSame(steps, seed);
  });
});

describe('stateless alaw8kToPcm16k / pcm16kToAlaw8k are bit-identical to the pre-rewrite reference', () => {
  it('random sizes 0..4000 plus the largest bridge frame, every signal shape, misaligned PCM', () => {
    const seed = LOAD_SEED + 30;
    const rng = createRng(seed);
    const steps: Step[] = [];
    const sizes = [0, 1, 2, 3, 15, 16, 17, 31, 32, 33, 160, 320, MAX_BRIDGE_FRAME_BYTES];
    for (let i = 0; i < 300; i++) sizes.push(rng.int(0, 4000));
    sizes.forEach((bytes, f) => {
      const shape = SHAPES[f % SHAPES.length]!;
      const alaw = alawBytes(rng, bytes, shape, 0);
      steps.push({ dir: 'up', out: alaw8kToPcm16k(alaw), ref: referenceAlaw8kToPcm16k(alaw), frame: f });
      const pcm = pcmBytes(rng, samples(rng, bytes >> 1, shape, 0));
      steps.push({ dir: 'down', out: pcm16kToAlaw8k(pcm), ref: referencePcm16kToAlaw8k(pcm), frame: f });
    });
    expectSame(steps, seed);
  });
});

describe('A-law codec is bit-identical to the pre-rewrite per-sample code', () => {
  it('encodeAlaw matches the original encoder for every one of the 65,536 int16 values', () => {
    const all = new Int16Array(65536);
    for (let i = 0; i < 65536; i++) all[i] = i - 32768;
    const encoded = encodeAlaw(all);
    expect(encoded.length).toBe(65536);
    let mismatches = 0;
    for (let i = 0; i < 65536; i++) {
      if (encoded[i] !== referenceEncodeAlawSample(all[i]!)) mismatches++;
    }
    expect(mismatches).toBe(0);
    expect(encoded.equals(referenceEncodeAlaw(all))).toBe(true);
  });

  it('encodeAlaw handles empty input, subarray views and reversed order', () => {
    expect(encodeAlaw(new Int16Array(0)).length).toBe(0);
    const all = new Int16Array(65536);
    for (let i = 0; i < 65536; i++) all[i] = 32767 - i;
    const view = all.subarray(1001, 60001);
    expect(encodeAlaw(view).equals(referenceEncodeAlaw(view))).toBe(true);
  });

  it('decodeAlaw matches the original decoder for all 256 codewords', () => {
    const codes = Buffer.alloc(256);
    for (let i = 0; i < 256; i++) codes[i] = i;
    expect(Array.from(decodeAlaw(codes))).toEqual(Array.from(referenceDecodeAlaw(codes)));
  });
});
