import { describe, it, expect } from 'vitest';
import {
  alaw8kToPcm16k,
  pcm16kToAlaw8k,
  Upsampler8to16,
  Downsampler16to8,
  VoicelinkTranscoder,
} from '../../../src/utils/audio-fir.js';
import { encodeAlaw, decodeAlaw } from '../../../src/utils/audio.js';

// Build a 8kHz A-law buffer from a sine tone at `freq` Hz.
function alawTone(freq: number, samples: number, amp = 8000): Buffer {
  const pcm = new Int16Array(samples);
  for (let i = 0; i < samples; i++) {
    pcm[i] = Math.round(amp * Math.sin((2 * Math.PI * freq * i) / 8000));
  }
  return encodeAlaw(pcm);
}

// Build a 16kHz PCM16 buffer from a sine tone at `freq` Hz.
function pcm16kTone(freq: number, samples: number, amp = 8000): Buffer {
  const pcm = new Int16Array(samples);
  for (let i = 0; i < samples; i++) {
    pcm[i] = Math.round(amp * Math.sin((2 * Math.PI * freq * i) / 16000));
  }
  return Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
}

describe('alaw8kToPcm16k', () => {
  it('doubles the sample count (8k → 16k)', () => {
    const alaw = alawTone(440, 160); // 20ms @ 8kHz
    const out = alaw8kToPcm16k(alaw);
    // 160 A-law bytes → 160 PCM16 samples → 320 samples @16k → 640 bytes
    expect(out.length).toBe(640);
  });

  it('preserves a mid-band tone (peak amplitude within tolerance)', () => {
    const alaw = alawTone(440, 800, 8000);
    const out = alaw8kToPcm16k(alaw);
    const pcm = new Int16Array(out.buffer, out.byteOffset, out.byteLength / 2);
    let peak = 0;
    // skip kernel edge transients at both ends
    for (let i = 64; i < pcm.length - 64; i++) peak = Math.max(peak, Math.abs(pcm[i]!));
    // A-law quantization + resampling; expect within ~20% of the 8000 input peak.
    expect(peak).toBeGreaterThan(6400);
    expect(peak).toBeLessThan(9600);
  });
});

describe('pcm16kToAlaw8k', () => {
  it('halves the sample count (16k → 8k)', () => {
    const pcm = pcm16kTone(440, 320); // 20ms @ 16kHz = 320 samples = 640 bytes
    const out = pcm16kToAlaw8k(pcm);
    // 320 samples @16k → 160 samples @8k → 160 A-law bytes
    expect(out.length).toBe(160);
  });

  it('attenuates an above-Nyquist tone (anti-alias low-pass)', () => {
    // 6kHz is above the 4kHz Nyquist of the 8kHz output — must be filtered out
    // rather than aliased back into the passband.
    const pcm = pcm16kTone(6000, 1600, 8000);
    const alaw = pcm16kToAlaw8k(pcm);
    const back = alaw8kToPcm16k(alaw);
    const s = new Int16Array(back.buffer, back.byteOffset, back.byteLength / 2);
    let peak = 0;
    for (let i = 128; i < s.length - 128; i++) peak = Math.max(peak, Math.abs(s[i]!));
    // Strongly attenuated relative to the 8000 input amplitude.
    expect(peak).toBeLessThan(3000);
  });
});

describe('robustness', () => {
  it('ignores a stray trailing byte on an odd-length PCM buffer (no throw)', () => {
    const odd = Buffer.alloc(641); // 320 whole samples + 1 stray byte
    const out = pcm16kToAlaw8k(odd);
    expect(out.length).toBe(160); // 320 samples @16k → 160 @8k; stray byte dropped
  });

  it('handles a misaligned (odd byteOffset) buffer view via copy', () => {
    const backing = Buffer.alloc(643);
    const view = backing.subarray(1, 641); // odd byteOffset, 640 bytes = 320 samples
    const out = pcm16kToAlaw8k(view);
    expect(out.length).toBe(160);
  });

  it('handles an empty buffer without throwing', () => {
    expect(pcm16kToAlaw8k(Buffer.alloc(0)).length).toBe(0);
    expect(alaw8kToPcm16k(Buffer.alloc(0)).length).toBe(0);
  });
});

describe('round-trip 16k → A-law 8k → 16k', () => {
  it('preserves a passband tone shape', () => {
    const pcm = pcm16kTone(440, 1600, 8000);
    const alaw = pcm16kToAlaw8k(pcm);
    const back = alaw8kToPcm16k(alaw);
    const s = new Int16Array(back.buffer, back.byteOffset, back.byteLength / 2);
    let peak = 0;
    for (let i = 128; i < s.length - 128; i++) peak = Math.max(peak, Math.abs(s[i]!));
    expect(peak).toBeGreaterThan(6000);
    expect(peak).toBeLessThan(10000);
  });
});

describe('stateful streaming resamplers — cross-frame continuity', () => {
  // A continuous tone processed frame-by-frame through the STATEFUL resampler must
  // closely match the same tone processed as one buffer (no boundary discontinuity).
  function pcm16Tone(freq: number, n: number, amp = 8000): Int16Array {
    const s = new Int16Array(n);
    for (let i = 0; i < n; i++) s[i] = Math.round(amp * Math.sin((2 * Math.PI * freq * i) / 16000));
    return s;
  }
  function pcm8Tone(freq: number, n: number, amp = 8000): Int16Array {
    const s = new Int16Array(n);
    for (let i = 0; i < n; i++) s[i] = Math.round(amp * Math.sin((2 * Math.PI * freq * i) / 8000));
    return s;
  }
  function rmsDiff(a: Int16Array, b: Int16Array): number {
    const len = Math.min(a.length, b.length);
    let sq = 0;
    for (let i = 0; i < len; i++) { const d = a[i]! - b[i]!; sq += d * d; }
    return Math.sqrt(sq / len);
  }

  it('downsampler framed output ≈ whole-buffer output (16k→8k)', () => {
    const input = pcm16Tone(440, 3200); // 200ms @16k
    const whole = new Downsampler16to8().process(input);
    // Frame it into 20ms (320-sample) chunks through ONE stateful instance.
    const ds = new Downsampler16to8();
    const parts: Int16Array[] = [];
    for (let i = 0; i < input.length; i += 320) parts.push(ds.process(input.subarray(i, i + 320)));
    const framed = new Int16Array(parts.reduce((a, p) => a + p.length, 0));
    let o = 0; for (const p of parts) { framed.set(p, o); o += p.length; }
    // Same total length and near-identical samples (ignore first frame's warm-up).
    expect(Math.abs(framed.length - whole.length)).toBeLessThanOrEqual(1);
    const skip = 200;
    expect(rmsDiff(framed.subarray(skip), whole.subarray(skip))).toBeLessThan(20);
  });

  it('upsampler framed output ≈ whole-buffer output (8k→16k)', () => {
    const input = pcm8Tone(440, 1600); // 200ms @8k
    const whole = new Upsampler8to16().process(input);
    const us = new Upsampler8to16();
    const parts: Int16Array[] = [];
    for (let i = 0; i < input.length; i += 160) parts.push(us.process(input.subarray(i, i + 160)));
    const framed = new Int16Array(parts.reduce((a, p) => a + p.length, 0));
    let o = 0; for (const p of parts) { framed.set(p, o); o += p.length; }
    expect(Math.abs(framed.length - whole.length)).toBeLessThanOrEqual(2);
    const skip = 400;
    expect(rmsDiff(framed.subarray(skip), whole.subarray(skip))).toBeLessThan(20);
  });

  it('VoicelinkTranscoder streams A-law↔PCM with bounded startup latency then steady state', () => {
    const t = new VoicelinkTranscoder();
    // First 20ms A-law frame (160 samples): output holds back ~TAP_HALF/2 samples
    // for cross-frame continuity, so it's slightly under the ideal 640 bytes.
    const first = t.alawToPcm16k(encodeAlaw(pcm8Tone(440, 160)));
    expect(first.length).toBeGreaterThan(560);
    expect(first.length).toBeLessThanOrEqual(640);
    // Steady state: total output converges to 2× input (16 taps latency amortized).
    let totalOut = first.length / 2; // samples so far
    for (let f = 0; f < 50; f++) totalOut += t.alawToPcm16k(encodeAlaw(pcm8Tone(440, 160))).length / 2;
    const totalIn = 160 * 51;
    // Within one kernel's worth of held-back latency (~16 input → 32 output samples).
    expect(Math.abs(totalOut - totalIn * 2)).toBeLessThan(64);
  });

  it('reset() clears history', () => {
    const t = new VoicelinkTranscoder();
    t.alawToPcm16k(encodeAlaw(pcm8Tone(440, 160)));
    expect(() => t.reset()).not.toThrow();
  });

  it('reset() actually clears continuity: framed-after-reset ≈ a fresh instance', () => {
    // Prime an instance with two frames of history, then reset it. Its next
    // output must be BIT-IDENTICAL to a brand-new instance fed the same frame —
    // proving reset() drops the retained window/phase, not just "doesn't throw".
    const primed = new VoicelinkTranscoder();
    primed.alawToPcm16k(encodeAlaw(pcm8Tone(440, 160)));
    primed.alawToPcm16k(encodeAlaw(pcm8Tone(440, 160)));
    primed.reset();
    const afterReset = primed.alawToPcm16k(encodeAlaw(pcm8Tone(440, 160)));
    const fresh = new VoicelinkTranscoder().alawToPcm16k(encodeAlaw(pcm8Tone(440, 160)));

    const ar = new Int16Array(afterReset.buffer, afterReset.byteOffset, afterReset.byteLength / 2);
    const fr = new Int16Array(fresh.buffer, fresh.byteOffset, fresh.byteLength / 2);
    expect(ar.length).toBe(fr.length);
    let maxDiff = 0;
    for (let i = 0; i < ar.length; i++) maxDiff = Math.max(maxDiff, Math.abs(ar[i]! - fr[i]!));
    expect(maxDiff).toBe(0);
  });

  it('VoicelinkTranscoder A-law→PCM→A-law round-trips a tone through the class with bounded distortion', () => {
    // Feed A-law in, get the browser PCM16 16k, feed THAT back through the reverse
    // (browser→PSTN) leg — exercising both stateful directions of the actual class.
    const t = new VoicelinkTranscoder();
    const src = pcm8Tone(440, 1600, 8000);
    const srcAlaw = encodeAlaw(src);
    const pcm16k = t.alawToPcm16k(srcAlaw);
    const backAlaw = t.pcm16kToAlaw(pcm16k);
    const decBack = decodeAlaw(backAlaw);
    // The reconstructed A-law tone must retain its ~8000 peak (A-law quantization +
    // two FIR passes; skip kernel-edge transients at both ends).
    let peak = 0;
    for (let i = 80; i < decBack.length - 80; i++) peak = Math.max(peak, Math.abs(decBack[i]!));
    expect(peak).toBeGreaterThan(6400);
    expect(peak).toBeLessThan(9600);
  });
});

describe('DC offset preservation', () => {
  it('downsampler holds a constant DC level (unity DC gain)', () => {
    // A DC (constant) input must pass through the unity-DC-gain FIR unchanged —
    // if the kernel weren't normalized to sum=1 the level would scale.
    const dc = new Int16Array(1600).fill(5000);
    const out = new Downsampler16to8().process(dc);
    let sum = 0;
    let count = 0;
    // Skip kernel warm-up at both ends.
    for (let i = 64; i < out.length - 64; i++) { sum += out[i]!; count++; }
    expect(sum / count).toBeCloseTo(5000, 0);
  });

  it('alaw8kToPcm16k preserves a DC level (within A-law quantization)', () => {
    const dc = new Int16Array(400).fill(4000);
    const out = alaw8kToPcm16k(encodeAlaw(dc));
    const s = new Int16Array(out.buffer, out.byteOffset, out.byteLength / 2);
    let sum = 0;
    let count = 0;
    for (let i = 64; i < s.length - 64; i++) { sum += s[i]!; count++; }
    // A-law quantizes 4000 to ~4032; expect the mean within ~5% of the input DC.
    expect(sum / count).toBeGreaterThan(3800);
    expect(sum / count).toBeLessThan(4200);
  });
});

describe('full-scale clipping is hard-pinned to the Int16 rails', () => {
  // A full-scale square wave forces Gibbs overshoot past ±32768 out of the FIR;
  // the round/clamp step must pin those to exactly ±32767/−32768 (never wrap).
  function square16(n: number, halfPeriod = 4): Int16Array {
    const a = new Int16Array(n);
    for (let i = 0; i < n; i++) a[i] = Math.floor(i / halfPeriod) % 2 === 0 ? 32767 : -32768;
    return a;
  }
  function square8(n: number, halfPeriod = 4): Int16Array {
    return square16(n, halfPeriod); // same shape at 8k
  }

  it('downsampler clamps overshoot to ±32767/−32768 exactly', () => {
    const out = new Downsampler16to8().process(square16(800));
    let hi = 0;
    let lo = 0;
    for (const x of out) {
      expect(x).toBeLessThanOrEqual(32767);
      expect(x).toBeGreaterThanOrEqual(-32768);
      if (x === 32767) hi++;
      if (x === -32768) lo++;
    }
    // The overshoot really does reach the rails (proves clamp is exercised, not vacuous).
    expect(hi).toBeGreaterThan(0);
    expect(lo).toBeGreaterThan(0);
  });

  it('upsampler clamps overshoot to ±32767/−32768 exactly', () => {
    const out = new Upsampler8to16().process(square8(400));
    let hi = 0;
    let lo = 0;
    for (const x of out) {
      expect(x).toBeLessThanOrEqual(32767);
      expect(x).toBeGreaterThanOrEqual(-32768);
      if (x === 32767) hi++;
      if (x === -32768) lo++;
    }
    expect(hi).toBeGreaterThan(0);
    expect(lo).toBeGreaterThan(0);
  });
});

describe('mid-band sweep fidelity', () => {
  function alawTone(freq: number, samples: number, amp = 8000): Buffer {
    const pcm = new Int16Array(samples);
    for (let i = 0; i < samples; i++) pcm[i] = Math.round(amp * Math.sin((2 * Math.PI * freq * i) / 8000));
    return encodeAlaw(pcm);
  }
  // Frequencies comfortably inside the 4kHz passband must all survive the resample
  // near their input amplitude (no unexpected in-band attenuation).
  for (const freq of [500, 1000, 2000, 3000]) {
    it(`passes a ${freq}Hz in-band tone (peak within ~20% of input)`, () => {
      const out = alaw8kToPcm16k(alawTone(freq, 800, 8000));
      const s = new Int16Array(out.buffer, out.byteOffset, out.byteLength / 2);
      let peak = 0;
      for (let i = 64; i < s.length - 64; i++) peak = Math.max(peak, Math.abs(s[i]!));
      expect(peak).toBeGreaterThan(6400);
      expect(peak).toBeLessThan(9600);
    });
  }
});

describe('streaming resamplers — degenerate frame sizes', () => {
  it('zero-length frames emit nothing and keep the resampler usable', () => {
    const ds = new Downsampler16to8();
    const us = new Upsampler8to16();
    expect(ds.process(new Int16Array(0)).length).toBe(0);
    expect(us.process(new Int16Array(0)).length).toBe(0);
    // Still functional afterwards (empty frame didn't corrupt internal state).
    expect(us.process(new Int16Array(160)).length).toBeGreaterThan(0);
    expect(ds.process(new Int16Array(320)).length).toBeGreaterThan(0);
  });

  it('single-sample frames buffer (emit 0) until enough samples for a kernel window arrive', () => {
    // The stateful resampler holds output back until an output sample's ENTIRE
    // kernel window has arrived — a lone sample can't fill a window, so it emits 0.
    const ds = new Downsampler16to8();
    const us = new Upsampler8to16();
    expect(ds.process(new Int16Array([1000])).length).toBe(0);
    expect(us.process(new Int16Array([1000])).length).toBe(0);
    // But drip-feeding many single samples eventually produces output.
    let dsOut = 0;
    let usOut = 0;
    for (let i = 0; i < 200; i++) {
      dsOut += ds.process(new Int16Array([2000])).length;
      usOut += us.process(new Int16Array([2000])).length;
    }
    expect(dsOut).toBeGreaterThan(0);
    expect(usOut).toBeGreaterThan(0);
  });
});
