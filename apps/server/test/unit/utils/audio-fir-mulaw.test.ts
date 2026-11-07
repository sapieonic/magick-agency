// `MulawTranscoder` (Plivo legs): framed output must equal the streaming resamplers fed
// the standard μ-law codec's samples, byte for byte, and the transcoder must keep a
// tone's level through μ-law → PCM16 16k → μ-law.
import { describe, it, expect } from 'vitest';
import { MulawTranscoder, Upsampler8to16, Downsampler16to8 } from '../../../src/utils/audio-fir.js';
import { decodeMulaw, encodeMulaw } from '../../../src/utils/audio.js';

function tone8k(freq: number, samples: number, amp = 8000): Int16Array {
  const pcm = new Int16Array(samples);
  for (let i = 0; i < samples; i++) pcm[i] = Math.round(amp * Math.sin((2 * Math.PI * freq * i) / 8000));
  return pcm;
}

function tone16k(freq: number, samples: number, amp = 8000): Buffer {
  const pcm = new Int16Array(samples);
  for (let i = 0; i < samples; i++) pcm[i] = Math.round(amp * Math.sin((2 * Math.PI * freq * i) / 16000));
  return Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
}

const asBuffer = (pcm: Int16Array) => Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);

describe('MulawTranscoder', () => {
  it('μ-law → PCM16 16k equals the upsampler fed the standard decode, frame by frame', () => {
    const mulaw = encodeMulaw(tone8k(440, 160 * 12));
    const t = new MulawTranscoder();
    const ref = new Upsampler8to16();
    // Uneven frames, a 1-sample one and an empty one included.
    const sizes = [160, 1, 0, 159, 320, 80, 160, 400, 320];
    let at = 0;
    for (const n of sizes) {
      const frame = mulaw.subarray(at, at + n);
      at += n;
      expect(t.mulawToPcm16k(frame)).toEqual(asBuffer(ref.process(decodeMulaw(frame))));
    }
  });

  it('PCM16 16k → μ-law equals the downsampler then the standard encode, frame by frame', () => {
    const pcm = tone16k(1000, 320 * 12);
    const t = new MulawTranscoder();
    const ref = new Downsampler16to8();
    const sizes = [640, 2, 0, 638, 1280, 160, 640, 1600];
    let at = 0;
    for (const n of sizes) {
      const frame = pcm.subarray(at, at + n);
      at += n;
      const want = ref.process(new Int16Array(frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.byteLength)));
      expect(t.pcm16kToMulaw(frame)).toEqual(encodeMulaw(want));
    }
  });

  it('encodes a steady level, the rails included, as the standard codec does', () => {
    // Through the downsampler a constant run stays that constant (unity DC gain), so its
    // settled output byte is the encode table's entry for that sample.
    for (const v of [-32768, -12345, -1, 0, 1, 7, 32636, 32767]) {
      const t = new MulawTranscoder();
      const out = t.pcm16kToMulaw(asBuffer(new Int16Array(2048).fill(v)));
      expect(out[out.length - 1], String(v)).toBe(encodeMulaw(Int16Array.of(v))[0]);
    }
  });

  it('keeps a 440 Hz tone’s level through μ-law → PCM16 16k → μ-law', () => {
    const t = new MulawTranscoder();
    const mulaw = encodeMulaw(tone8k(440, 160 * 20));
    const pcm: Buffer[] = [];
    for (let f = 0; f < 20; f++) pcm.push(t.mulawToPcm16k(mulaw.subarray(f * 160, (f + 1) * 160)));
    const all16 = Buffer.concat(pcm);
    const back: Buffer[] = [];
    for (let f = 0; f * 640 < all16.length; f++) back.push(t.pcm16kToMulaw(all16.subarray(f * 640, (f + 1) * 640)));
    const decoded = decodeMulaw(Buffer.concat(back)).subarray(400, 2400);
    const peak = decoded.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
    expect(peak).toBeGreaterThan(7500);
    expect(peak).toBeLessThan(8600);
  });

  it('returns buffers the caller owns, and reset() starts a fresh stream', () => {
    const t = new MulawTranscoder();
    const frame = encodeMulaw(tone8k(300, 160));
    const a = t.mulawToPcm16k(frame);
    const copy = Buffer.from(a);
    t.mulawToPcm16k(frame);
    expect(a).toEqual(copy);
    t.reset();
    const fresh = new MulawTranscoder();
    expect(t.mulawToPcm16k(frame)).toEqual(fresh.mulawToPcm16k(frame));
  });
});
