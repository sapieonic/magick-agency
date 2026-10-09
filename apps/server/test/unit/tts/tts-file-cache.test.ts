// PORT NOTE (magick-agency): ported from magic-voice-core/test/unit/tts/tts-file-cache.test.ts@4850d1d9.
// Verbatim.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import {
  initTtsFileCache,
  hashTtsInput,
  getTtsFilePath,
  ttsFileExists,
  writeTtsFile,
  readTtsFile,
  readTtsPcm,
  deleteTtsFiles,
} from '../../../src/tts/tts-file-cache.js';

beforeAll(() => {
  initTtsFileCache();
});

describe('hashTtsInput', () => {
  it('returns a 40-char hex string', () => {
    const hash = hashTtsInput('hello', 'hi-IN', 'WOMAN');
    expect(hash).toMatch(/^[a-f0-9]{40}$/);
  });

  it('is deterministic', () => {
    const a = hashTtsInput('hello world', 'en-IN', 'MAN');
    const b = hashTtsInput('hello world', 'en-IN', 'MAN');
    expect(a).toBe(b);
  });

  it('different inputs produce different hashes', () => {
    const a = hashTtsInput('hello', 'hi-IN', 'WOMAN');
    const b = hashTtsInput('hello', 'hi-IN', 'MAN');
    const c = hashTtsInput('hello', 'en-IN', 'WOMAN');
    const d = hashTtsInput('goodbye', 'hi-IN', 'WOMAN');
    expect(new Set([a, b, c, d]).size).toBe(4);
  });
});

describe('getTtsFilePath', () => {
  it('returns a path ending in .wav', () => {
    expect(getTtsFilePath('abc123')).toMatch(/abc123\.wav$/);
  });
});

describe('writeTtsFile / readTtsFile / ttsFileExists / deleteTtsFiles', () => {
  const hash = hashTtsInput('test-write-read', 'hi-IN', 'WOMAN');

  it('write + exists + read round-trip', () => {
    // PCM16 silence: 160 samples at 16kHz = 10ms
    const pcm16 = Buffer.alloc(320);
    writeTtsFile(hash, pcm16, 16000, 1);

    expect(ttsFileExists(hash)).toBe(true);

    const wav = readTtsFile(hash);
    expect(wav).not.toBeNull();
    // WAV header is 44 bytes + 320 bytes PCM data
    expect(wav!.length).toBe(44 + 320);
    // Check RIFF header
    expect(wav!.subarray(0, 4).toString()).toBe('RIFF');
    expect(wav!.subarray(8, 12).toString()).toBe('WAVE');
    // Check sample rate in header (bytes 24-27)
    expect(wav!.readUInt32LE(24)).toBe(16000);
    // Check channels (bytes 22-23)
    expect(wav!.readUInt16LE(22)).toBe(1);
  });

  it('readTtsFile returns null for missing hash', () => {
    expect(readTtsFile('nonexistent_hash_000000000000000000')).toBeNull();
  });

  it('ttsFileExists returns false for missing hash', () => {
    expect(ttsFileExists('nonexistent_hash_000000000000000000')).toBe(false);
  });

  it('deleteTtsFiles removes files and returns count', () => {
    // Write two files
    const h1 = hashTtsInput('delete-test-1', 'hi-IN', 'WOMAN');
    const h2 = hashTtsInput('delete-test-2', 'en-IN', 'MAN');
    writeTtsFile(h1, Buffer.alloc(32), 16000, 1);
    writeTtsFile(h2, Buffer.alloc(32), 16000, 1);

    expect(ttsFileExists(h1)).toBe(true);
    expect(ttsFileExists(h2)).toBe(true);

    const deleted = deleteTtsFiles([h1, h2, 'nonexistent']);
    expect(deleted).toBe(2);
    expect(ttsFileExists(h1)).toBe(false);
    expect(ttsFileExists(h2)).toBe(false);
  });

  afterAll(() => {
    // Clean up the test file from round-trip test
    deleteTtsFiles([hash]);
  });
});

describe('readTtsPcm', () => {
  const hashes: string[] = [];
  const register = (h: string) => { hashes.push(h); return h; };

  afterAll(() => {
    deleteTtsFiles(hashes);
  });

  it('round-trips the PCM payload and sample rate written by writeTtsFile', () => {
    const hash = register(hashTtsInput('readpcm-roundtrip', 'hi-IN', 'WOMAN'));
    // Distinctive (non-zero) PCM16 samples so the byte comparison is meaningful.
    const pcm16 = Buffer.from(new Int16Array([100, -200, 300, -400, 500]).buffer);
    writeTtsFile(hash, pcm16, 24000, 1);

    const result = readTtsPcm(hash);
    expect(result).not.toBeNull();
    expect(result!.sampleRate).toBe(24000);
    expect(result!.pcm16.equals(pcm16)).toBe(true);
  });

  it('returns null for a missing hash', () => {
    expect(readTtsPcm('nonexistent_hash_111111111111111111')).toBeNull();
  });

  it('returns null for a header-only file (no PCM payload)', () => {
    const hash = register(hashTtsInput('readpcm-header-only', 'en-IN', 'MAN'));
    // Empty payload → createWavBuffer writes just the 44-byte header.
    writeTtsFile(hash, Buffer.alloc(0), 16000, 1);
    expect(readTtsFile(hash)!.length).toBe(44);
    expect(readTtsPcm(hash)).toBeNull();
  });

  it('returns null when the header carries a zero sample rate', () => {
    const hash = register(hashTtsInput('readpcm-zero-rate', 'en-IN', 'WOMAN'));
    writeTtsFile(hash, Buffer.from(new Int16Array([1, 2, 3, 4]).buffer), 0, 1);
    expect(readTtsPcm(hash)).toBeNull();
  });
});
