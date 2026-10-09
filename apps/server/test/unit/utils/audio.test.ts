import { describe, it, expect } from 'vitest';
import {
  decodeMulaw,
  encodeMulaw,
  decodeAlaw,
  encodeAlaw,
  resample,
  mulawToTargetPcm,
  pcmToMulaw,
  alawToTargetPcm,
  pcmToAlaw,
  AudioBuffer,
} from '../../../src/utils/audio.js';

describe('decodeMulaw', () => {
  it('returns an Int16Array of same length as input', () => {
    const input = Buffer.from([0x00, 0x7f, 0x80, 0xff]);
    const result = decodeMulaw(input);
    expect(result).toBeInstanceOf(Int16Array);
    expect(result.length).toBe(4);
  });

  it('decodes silence (0xff) to near-zero', () => {
    const result = decodeMulaw(Buffer.from([0xff]));
    expect(Math.abs(result[0]!)).toBeLessThan(10);
  });

  it('decodes 0x00 to a large negative value (max negative amplitude)', () => {
    const result = decodeMulaw(Buffer.from([0x00]));
    expect(result[0]!).toBeLessThan(-8000);
  });

  it('decodes 0x80 to a large positive value (max positive amplitude)', () => {
    const result = decodeMulaw(Buffer.from([0x80]));
    expect(result[0]!).toBeGreaterThan(8000);
  });
});

describe('encodeMulaw', () => {
  it('returns a Buffer of same length as input', () => {
    const input = new Int16Array([0, 1000, -1000, 32767]);
    const result = encodeMulaw(input);
    expect(result).toBeInstanceOf(Buffer);
    expect(result.length).toBe(4);
  });

  it('encodes silence (0) to near 0xff', () => {
    const result = encodeMulaw(new Int16Array([0]));
    expect(result[0]).toBe(0xff);
  });

  it('encode/decode round-trip preserves sign and relative magnitude', () => {
    const original = new Int16Array([0, 1000, -1000, 8000, -8000, 32000, -32000]);
    const encoded = encodeMulaw(original);
    const decoded = decodeMulaw(encoded);

    // Silence stays near zero
    expect(Math.abs(decoded[0]!)).toBeLessThan(100);

    // Sign is preserved
    for (let i = 1; i < original.length; i++) {
      if (original[i]! > 0) expect(decoded[i]!).toBeGreaterThan(0);
      if (original[i]! < 0) expect(decoded[i]!).toBeLessThan(0);
    }

    // Larger inputs produce larger outputs (monotonic)
    expect(Math.abs(decoded[3]!)).toBeGreaterThan(Math.abs(decoded[1]!));  // 8000 > 1000
    expect(Math.abs(decoded[5]!)).toBeGreaterThan(Math.abs(decoded[3]!));  // 32000 > 8000
  });
});

describe('resample', () => {
  it('returns same array when rates are equal', () => {
    const input = new Int16Array([1, 2, 3, 4]);
    const result = resample(input, 8000, 8000);
    expect(result).toBe(input);
  });

  it('upsamples from 8kHz to 16kHz (doubles length)', () => {
    const input = new Int16Array([100, 200, 300, 400]);
    const result = resample(input, 8000, 16000);
    expect(result.length).toBe(8);
  });

  it('downsamples from 16kHz to 8kHz (halves length)', () => {
    const input = new Int16Array(160);
    input.fill(1000);
    const result = resample(input, 16000, 8000);
    expect(result.length).toBe(80);
  });

  it('preserves constant signal through resampling', () => {
    const input = new Int16Array(100);
    input.fill(5000);
    const result = resample(input, 8000, 16000);
    for (let i = 0; i < result.length; i++) {
      expect(result[i]).toBe(5000);
    }
  });

  it('interpolates between samples when upsampling', () => {
    const input = new Int16Array([0, 1000]);
    const result = resample(input, 8000, 16000);
    // Midpoint should be interpolated between 0 and 1000
    expect(result[1]!).toBeGreaterThan(0);
    expect(result[1]!).toBeLessThan(1000);
  });
});

describe('mulawToTargetPcm', () => {
  it('returns a Buffer with PCM16 data at target rate', () => {
    const mulaw = Buffer.alloc(160, 0xff); // 20ms of silence at 8kHz
    const result = mulawToTargetPcm(mulaw, 16000);
    expect(result).toBeInstanceOf(Buffer);
    // 160 samples at 8kHz → 320 samples at 16kHz → 640 bytes (16-bit)
    expect(result.length).toBe(640);
  });

  it('returns same sample count when target is 8kHz', () => {
    const mulaw = Buffer.alloc(80, 0xff);
    const result = mulawToTargetPcm(mulaw, 8000);
    // 80 samples → 80 * 2 bytes = 160 bytes
    expect(result.length).toBe(160);
  });
});

describe('pcmToMulaw', () => {
  it('returns mu-law encoded Buffer at 8kHz', () => {
    // 320 PCM16 samples at 16kHz = 20ms
    const pcm = Buffer.alloc(640);
    const result = pcmToMulaw(pcm, 16000);
    expect(result).toBeInstanceOf(Buffer);
    // 320 samples at 16kHz → 160 samples at 8kHz
    expect(result.length).toBe(160);
  });

  it('round-trips mulaw → pcm → mulaw with same output length', () => {
    const original = Buffer.from([0x10, 0x30, 0x50, 0x90, 0xb0, 0xd0]);
    const pcm = mulawToTargetPcm(original, 8000);
    const reencoded = pcmToMulaw(pcm, 8000);
    expect(reencoded.length).toBe(original.length);
  });
});

// ── G.711 A-law (VoiceLink's carrier-forced codec) ───────────────────────────
// A-law is the European G.711 variant. VoiceLink's Indian carrier forces
// `audio/alaw` 8kHz on the media stream, so these mirror the mu-law suites.
// A-law silence is 0xD5 (decodes to +8, ≈0) — captured in the live VoiceLink call.

describe('decodeAlaw', () => {
  it('returns an Int16Array of same length as input', () => {
    const input = Buffer.from([0x00, 0x55, 0xd5, 0xaa]);
    const result = decodeAlaw(input);
    expect(result).toBeInstanceOf(Int16Array);
    expect(result.length).toBe(4);
  });

  it('decodes A-law silence (0xD5) to near-zero (+8)', () => {
    const result = decodeAlaw(Buffer.from([0xd5]));
    // 0xD5 is the canonical A-law encoding of 0 — decodes to +8, ~0.
    expect(result[0]!).toBe(8);
    expect(Math.abs(result[0]!)).toBeLessThan(10);
  });

  it('decodes 0x55 to a small negative value (-8, negative silence)', () => {
    const result = decodeAlaw(Buffer.from([0x55]));
    expect(result[0]!).toBe(-8);
  });

  it('decodes 0xAA to a large positive value (max positive amplitude)', () => {
    const result = decodeAlaw(Buffer.from([0xaa]));
    expect(result[0]!).toBeGreaterThan(8000);
  });

  it('decodes 0x2A to a large negative value (max negative amplitude)', () => {
    const result = decodeAlaw(Buffer.from([0x2a]));
    expect(result[0]!).toBeLessThan(-8000);
  });
});

describe('encodeAlaw', () => {
  it('returns a Buffer of same length as input', () => {
    const input = new Int16Array([0, 1000, -1000, 32767]);
    const result = encodeAlaw(input);
    expect(result).toBeInstanceOf(Buffer);
    expect(result.length).toBe(4);
  });

  it('encodes silence (0) to A-law silence 0xD5', () => {
    const result = encodeAlaw(new Int16Array([0]));
    expect(result[0]).toBe(0xd5);
  });

  it('encode/decode round-trip preserves sign and relative magnitude', () => {
    const original = new Int16Array([0, 1000, -1000, 8000, -8000, 32000, -32000]);
    const encoded = encodeAlaw(original);
    const decoded = decodeAlaw(encoded);

    // Silence stays near zero
    expect(Math.abs(decoded[0]!)).toBeLessThan(100);

    // Sign is preserved
    for (let i = 1; i < original.length; i++) {
      if (original[i]! > 0) expect(decoded[i]!).toBeGreaterThan(0);
      if (original[i]! < 0) expect(decoded[i]!).toBeLessThan(0);
    }

    // Larger inputs produce larger outputs (monotonic)
    expect(Math.abs(decoded[3]!)).toBeGreaterThan(Math.abs(decoded[1]!)); // 8000 > 1000
    expect(Math.abs(decoded[5]!)).toBeGreaterThan(Math.abs(decoded[3]!)); // 32000 > 8000
  });

  it('round-trip stays within G.711 A-law quantization tolerance for mid amplitudes', () => {
    // A-law is logarithmic: quantization error grows with magnitude but stays
    // proportionally small. For a mid-range sample the decoded value should be
    // within ~8% of the original (the segment step size at that magnitude).
    const original = new Int16Array([4096]);
    const decoded = decodeAlaw(encodeAlaw(original));
    const err = Math.abs(decoded[0]! - original[0]!) / original[0]!;
    expect(err).toBeLessThan(0.08);
  });

  it('clamps out-of-domain magnitudes to the max A-law code', () => {
    // 32767 >> 3 = 4095 is the top of the encoder's 12-bit domain → max segment.
    const encoded = encodeAlaw(new Int16Array([32767]));
    const decoded = decodeAlaw(encoded);
    expect(decoded[0]!).toBeGreaterThan(8000);
  });
});

describe('alawToTargetPcm', () => {
  it('returns a Buffer with PCM16 data at target rate', () => {
    const alaw = Buffer.alloc(160, 0xd5); // 20ms of silence at 8kHz
    const result = alawToTargetPcm(alaw, 16000);
    expect(result).toBeInstanceOf(Buffer);
    // 160 samples at 8kHz → 320 samples at 16kHz → 640 bytes (16-bit)
    expect(result.length).toBe(640);
  });

  it('returns same sample count when target is 8kHz', () => {
    const alaw = Buffer.alloc(80, 0xd5);
    const result = alawToTargetPcm(alaw, 8000);
    // 80 samples → 80 * 2 bytes = 160 bytes
    expect(result.length).toBe(160);
  });

  it('decodes A-law silence to near-zero PCM16 at 8kHz', () => {
    const alaw = Buffer.alloc(80, 0xd5);
    const result = alawToTargetPcm(alaw, 8000);
    const pcm = new Int16Array(result.buffer, result.byteOffset, result.byteLength / 2);
    for (let i = 0; i < pcm.length; i++) {
      expect(Math.abs(pcm[i]!)).toBeLessThan(10);
    }
  });
});

describe('pcmToAlaw', () => {
  it('returns A-law encoded Buffer at 8kHz', () => {
    // 320 PCM16 samples at 16kHz = 20ms
    const pcm = Buffer.alloc(640);
    const result = pcmToAlaw(pcm, 16000);
    expect(result).toBeInstanceOf(Buffer);
    // 320 samples at 16kHz → 160 samples at 8kHz
    expect(result.length).toBe(160);
  });

  it('encodes PCM16 silence to A-law silence 0xD5 at 8kHz', () => {
    const pcm = Buffer.alloc(160); // 80 PCM16 samples of zero at 8kHz
    const result = pcmToAlaw(pcm, 8000);
    for (let i = 0; i < result.length; i++) {
      expect(result[i]).toBe(0xd5);
    }
  });

  it('round-trips alaw → pcm → alaw with same output length', () => {
    const original = Buffer.from([0x10, 0x30, 0x50, 0x90, 0xb0, 0xd0]);
    const pcm = alawToTargetPcm(original, 8000);
    const reencoded = pcmToAlaw(pcm, 8000);
    expect(reencoded.length).toBe(original.length);
  });

  it('is distinct from mu-law encoding for the same input (A-law ≠ mu-law)', () => {
    const pcm = Buffer.alloc(160);
    // fill with a non-silent ramp so the two codecs diverge
    const view = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.byteLength / 2);
    for (let i = 0; i < view.length; i++) view[i] = i * 200;
    const alaw = pcmToAlaw(pcm, 8000);
    const mulaw = pcmToMulaw(pcm, 8000);
    expect(Buffer.compare(alaw, mulaw)).not.toBe(0);
  });
});

describe('AudioBuffer', () => {
  it('returns null when buffer is below target', () => {
    // 20ms at 8kHz, 1 byte/sample = 160 bytes
    const buf = new AudioBuffer(20, 8000, 1);
    expect(buf.push(Buffer.alloc(80))).toBeNull();
  });

  it('returns concatenated buffer when target reached', () => {
    const buf = new AudioBuffer(20, 8000, 1);
    buf.push(Buffer.alloc(80));
    const result = buf.push(Buffer.alloc(80));
    expect(result).not.toBeNull();
    expect(result!.length).toBe(160);
  });

  it('resets after returning a buffer', () => {
    const buf = new AudioBuffer(20, 8000, 1);
    buf.push(Buffer.alloc(160));
    // After flush, next push should start fresh
    expect(buf.push(Buffer.alloc(80))).toBeNull();
  });

  it('returns accumulated data when target exceeded', () => {
    const buf = new AudioBuffer(20, 8000, 1);
    const result = buf.push(Buffer.alloc(200));
    expect(result).not.toBeNull();
    expect(result!.length).toBe(200);
  });

  it('flush returns remaining data', () => {
    const buf = new AudioBuffer(20, 8000, 1);
    buf.push(Buffer.alloc(50));
    const result = buf.flush();
    expect(result).not.toBeNull();
    expect(result!.length).toBe(50);
  });

  it('flush returns null when empty', () => {
    const buf = new AudioBuffer(20, 8000, 1);
    expect(buf.flush()).toBeNull();
  });

  it('clear discards all buffered data', () => {
    const buf = new AudioBuffer(20, 8000, 1);
    buf.push(Buffer.alloc(100));
    buf.clear();
    expect(buf.flush()).toBeNull();
  });

  it('handles PCM16 (2 bytes per sample)', () => {
    // 20ms at 16kHz, 2 bytes/sample = 640 bytes
    const buf = new AudioBuffer(20, 16000, 2);
    expect(buf.push(Buffer.alloc(320))).toBeNull();
    const result = buf.push(Buffer.alloc(320));
    expect(result).not.toBeNull();
    expect(result!.length).toBe(640);
  });
});
