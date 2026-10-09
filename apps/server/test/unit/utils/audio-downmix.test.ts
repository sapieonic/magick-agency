import { describe, it, expect } from 'vitest';
import { downmixToMono, pcmToAlaw } from '../../../src/utils/audio.js';

/** Build an interleaved PCM16 buffer from per-channel sample arrays of equal length. */
function interleave(...channels: number[][]): Buffer {
  const frames = channels[0]!.length;
  const buf = Buffer.alloc(frames * channels.length * 2);
  let o = 0;
  for (let f = 0; f < frames; f++) {
    for (const ch of channels) {
      buf.writeInt16LE(ch[f]!, o);
      o += 2;
    }
  }
  return buf;
}

function samples(pcm16: Buffer): number[] {
  const out: number[] = [];
  for (let i = 0; i < pcm16.length; i += 2) out.push(pcm16.readInt16LE(i));
  return out;
}

describe('downmixToMono', () => {
  it('averages two channels rather than dropping one', () => {
    // The load-bearing behaviour: dropping a channel loses anything panned to it,
    // which on a customer announcement can mean losing the voice entirely.
    const out = downmixToMono(interleave([1000, -2000, 300], [3000, 2000, -300]), 2);
    expect(samples(out)).toEqual([2000, 0, 0]);
  });

  it('halves the byte length for stereo input', () => {
    const stereo = interleave([1, 2, 3, 4], [5, 6, 7, 8]);
    expect(stereo.length).toBe(16);
    expect(downmixToMono(stereo, 2).length).toBe(8);
  });

  it('preserves a signal present in only ONE channel (at half amplitude)', () => {
    // A drop-the-right-channel bug would return all zeros here.
    const out = downmixToMono(interleave([0, 0, 0], [10000, -10000, 8000]), 2);
    expect(samples(out)).toEqual([5000, -5000, 4000]);
  });

  it('averages N > 2 channels', () => {
    const out = downmixToMono(interleave([600], [1200], [1800], [2400]), 4);
    expect(samples(out)).toEqual([1500]);
  });

  it('returns the input unchanged for mono (channels = 1)', () => {
    const mono = interleave([1, 2, 3]);
    expect(downmixToMono(mono, 1)).toBe(mono);
  });

  it('returns the input unchanged for channels = 0 (defensive)', () => {
    const mono = interleave([1, 2, 3]);
    expect(downmixToMono(mono, 0)).toBe(mono);
  });

  it('clamps to the int16 range at the extremes', () => {
    const out = downmixToMono(interleave([32767, -32768], [32767, -32768]), 2);
    const s = samples(out);
    expect(s[0]).toBe(32767);
    expect(s[1]).toBe(-32768);
    expect(s[0]).toBeLessThanOrEqual(32767);
    expect(s[1]).toBeGreaterThanOrEqual(-32768);
  });

  it('drops a trailing partial frame instead of shearing a sample', () => {
    // 5 samples of "stereo" = 2 whole frames + one orphan sample.
    const ragged = Buffer.alloc(10);
    for (let i = 0; i < 5; i++) ragged.writeInt16LE(100 * (i + 1), i * 2);
    const out = downmixToMono(ragged, 2);
    expect(out.length).toBe(4);
    expect(samples(out)).toEqual([150, 350]);
  });

  it('handles an empty buffer', () => {
    expect(downmixToMono(Buffer.alloc(0), 2).length).toBe(0);
  });

  it('produces a buffer the downstream A-law encoder accepts', () => {
    // Integration guard: the point of the downmix is that convertClip's
    // pcmToAlaw(clip.pcm16, clip.sampleRate) works on it unchanged.
    const stereo = interleave(
      Array.from({ length: 160 }, (_, i) => Math.round(8000 * Math.sin((2 * Math.PI * 440 * i) / 8000))),
      Array.from({ length: 160 }, (_, i) => Math.round(8000 * Math.sin((2 * Math.PI * 880 * i) / 8000))),
    );
    const mono = downmixToMono(stereo, 2);
    expect(mono.length).toBe(320);
    const alaw = pcmToAlaw(mono, 8000);
    // 1 byte per sample at 8 kHz, same rate in ⇒ same count out.
    expect(alaw.length).toBe(160);
  });

  it('does not alias a stereo buffer as mono (the sndfile trap)', () => {
    // Treating 2ch interleaved as mono doubles the apparent frame count, which is
    // exactly the "plays an octave low for twice as long" failure.
    const stereo = interleave([100, 200, 300], [400, 500, 600]);
    const asMonoFrames = stereo.length / 2;
    const downmixedFrames = downmixToMono(stereo, 2).length / 2;
    expect(asMonoFrames).toBe(6);
    expect(downmixedFrames).toBe(3);
  });
});
