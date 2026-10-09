import { describe, it, expect } from 'vitest';
import { toTelephonyClip, TELEPHONY_CLIP_SAMPLE_RATE } from '../../../src/audio/telephony-clip.js';
import { pcmToAlaw, pcmToMulaw } from '../../../src/utils/audio.js';

/**
 * Pre-converting the cached clip to the 8kHz telephony wire rate moves the
 * expensive resample off the call path. `WebSocketStaticCallSession.handleStart`
 * cannot convert until the carrier negotiates a codec, so whatever the cache
 * holds at that moment is what the callee waits for.
 *
 * Measured on a 58s clip: 44.1kHz→8k resample ~1.9s, G.711 encode from 8kHz ~3ms.
 * The resample is the entire cost, so the wire bytes MUST be unchanged — this is
 * a latency change, not an audio change.
 */

/** A 440Hz tone, so a broken resample shows up as altered audio, not just a count. */
function tone(seconds: number, rate: number): Buffer {
  const buf = Buffer.alloc(Math.round(seconds * rate) * 2);
  for (let i = 0; i < buf.length / 2; i++) {
    buf.writeInt16LE(Math.round(12000 * Math.sin((2 * Math.PI * 440 * i) / rate)), i * 2);
  }
  return buf;
}

describe('toTelephonyClip', () => {
  it('downsamples to the 8kHz wire rate', () => {
    const out = toTelephonyClip(tone(1, 44100), 44100);
    expect(out.sampleRate).toBe(TELEPHONY_CLIP_SAMPLE_RATE);
    expect(out.sampleRate).toBe(8000);
    // 1 second at 8kHz PCM16 = 8000 samples = 16000 bytes.
    expect(out.pcm16.length).toBe(16000);
  });

  it.each([8000, 16000, 22050, 24000, 44100, 48000])('normalizes %ikHz source to 8kHz', (rate) => {
    const out = toTelephonyClip(tone(0.5, rate), rate);
    expect(out.sampleRate).toBe(8000);
    expect(out.pcm16.length).toBe(8000); // 0.5s @ 8kHz PCM16
  });

  /**
   * Idempotence is what makes this safe to call on BOTH the upload path and the
   * cache-miss re-decode path without tracking whether it already ran.
   */
  it('returns an already-8kHz clip untouched, by reference', () => {
    const src = tone(1, 8000);
    const out = toTelephonyClip(src, 8000);
    expect(out.sampleRate).toBe(8000);
    expect(out.pcm16).toBe(src); // same object — no copy, no resample
  });

  it('is idempotent when applied twice', () => {
    const once = toTelephonyClip(tone(1, 44100), 44100);
    const twice = toTelephonyClip(once.pcm16, once.sampleRate);
    expect(twice.pcm16.equals(once.pcm16)).toBe(true);
    expect(twice.sampleRate).toBe(once.sampleRate);
  });

  /**
   * THE load-bearing property. Pre-converting must produce byte-for-byte the same
   * wire audio as the old convert-at-answer path, or this traded latency for a
   * change in what the callee hears.
   */
  it.each([
    ['pcma', pcmToAlaw],
    ['pcmu', pcmToMulaw],
  ] as const)('produces wire bytes identical to converting from source (%s)', (_name, encode) => {
    const src = tone(2, 44100);

    const oldWay = encode(src, 44100);              // resample + encode at answer
    const clip = toTelephonyClip(src, 44100);       // resample at upload…
    const newWay = encode(clip.pcm16, clip.sampleRate); // …encode at answer

    expect(newWay.length).toBe(oldWay.length);
    expect(newWay.equals(oldWay)).toBe(true);
  });

  it('preserves duration (same audio, fewer samples per second)', () => {
    const seconds = 3;
    const out = toTelephonyClip(tone(seconds, 44100), 44100);
    // A-law is 1 byte/sample at 8kHz, so encoded length ÷ 8000 is the duration.
    const alaw = pcmToAlaw(out.pcm16, out.sampleRate);
    expect(alaw.length / 8000).toBeCloseTo(seconds, 2);
  });

  it('preserves the signal — output is not silence or clipping', () => {
    const out = toTelephonyClip(tone(1, 44100), 44100);
    const samples = new Int16Array(out.pcm16.buffer, out.pcm16.byteOffset, out.pcm16.length / 2);
    let peak = 0;
    let nonZero = 0;
    for (const s of samples) {
      peak = Math.max(peak, Math.abs(s));
      if (s !== 0) nonZero++;
    }
    // A 12000-amplitude tone survives at roughly its original level (the sinc
    // kernel's ripple keeps this loose) and is nowhere near full-scale clipping.
    expect(peak).toBeGreaterThan(8000);
    expect(peak).toBeLessThan(32767);
    expect(nonZero).toBeGreaterThan(samples.length * 0.9);
  });

  /** Int16Array views need 2-byte alignment; an odd byteOffset must not throw. */
  it('handles an unaligned input buffer', () => {
    const backing = Buffer.alloc(1 + 44100 * 2);
    const unaligned = backing.subarray(1); // odd byteOffset
    expect(unaligned.byteOffset % 2).toBe(1);
    expect(() => toTelephonyClip(unaligned, 44100)).not.toThrow();
    expect(toTelephonyClip(unaligned, 44100).sampleRate).toBe(8000);
  });

  it('handles an empty buffer without throwing', () => {
    const out = toTelephonyClip(Buffer.alloc(0), 44100);
    expect(out.sampleRate).toBe(8000);
    expect(out.pcm16.length).toBe(0);
  });

  /**
   * Not a strict perf budget (CI machines vary) — a guard that the conversion is
   * in the milliseconds, catching an accidental O(n²) or a per-sample allocation.
   * The point of the change is that per-call cost is ~3ms, not ~1.9s.
   *
   * The clip is 5 s, not the 30 s it started as. The RATIO is what this asserts and
   * that is length-independent, but the absolute runtime is not: resampling 30 s of
   * 44.1 kHz through a ~176-tap sinc twice (once in `toTelephonyClip`, once in the
   * unconverted `pcmToAlaw`) overran vitest's 5 s default timeout on CI's 2-vCPU
   * box — a timeout, not an assertion failure, so it read as a hang rather than a
   * regression. 5 s of audio keeps the ratio just as visible at a fraction of the
   * work. Do not raise this back up to buy a "more realistic" clip length; the
   * length is not what is under test.
   */
  it('encoding from a pre-converted clip is orders of magnitude cheaper', () => {
    const src = tone(5, 44100);
    const clip = toTelephonyClip(src, 44100);

    const t0 = process.hrtime.bigint();
    pcmToAlaw(clip.pcm16, clip.sampleRate);
    const preConvertedMs = Number(process.hrtime.bigint() - t0) / 1e6;

    const t1 = process.hrtime.bigint();
    pcmToAlaw(src, 44100);
    const fromSourceMs = Number(process.hrtime.bigint() - t1) / 1e6;

    expect(preConvertedMs).toBeLessThan(fromSourceMs);
    // Deliberately loose (10x, when the real ratio is ~600x) so it cannot flake.
    expect(preConvertedMs * 10).toBeLessThan(fromSourceMs);
  });
});
