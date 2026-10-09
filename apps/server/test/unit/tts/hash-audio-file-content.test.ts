// PORT NOTE (magick-agency): ported from magic-voice-core/test/unit/tts/hash-audio-file-content.test.ts@4850d1d9.
// Verbatim.
import { describe, it, expect, beforeAll } from 'vitest';

import crypto from 'node:crypto';
import fs from 'node:fs';
import {
  initTtsFileCache,
  hashAudioFileContent,
  hashTtsInput,
  getTtsFilePath,
  writeTtsFile,
  readTtsPcm,
  ttsFileExists,
  deleteTtsFiles,
} from '../../../src/tts/tts-file-cache.js';

beforeAll(() => {
  initTtsFileCache();
});

describe('hashAudioFileContent', () => {
  it('returns a 40-char hex string, matching the width of hashTtsInput', () => {
    const hash = hashAudioFileContent(Buffer.from('some audio bytes'));
    expect(hash).toMatch(/^[a-f0-9]{40}$/);
    expect(hash.length).toBe(hashTtsInput('x', 'en-IN', 'WOMAN').length);
  });

  it('is deterministic — the same bytes always give the same key', () => {
    // This is what makes re-decoding from S3 on another replica idempotent.
    const bytes = crypto.randomBytes(512);
    expect(hashAudioFileContent(bytes)).toBe(hashAudioFileContent(Buffer.from(bytes)));
  });

  it('changes when a single byte changes', () => {
    const a = Buffer.from([1, 2, 3, 4, 5]);
    const b = Buffer.from([1, 2, 3, 4, 6]);
    expect(hashAudioFileContent(a)).not.toBe(hashAudioFileContent(b));
  });

  it('is domain-separated from hashTtsInput so an audio clip cannot collide with a TTS clip', () => {
    // Both hashes live in ONE cache directory. Without a domain prefix, any
    // future change that made a TTS input serialize to the same bytes as a file
    // would have one clip silently overwrite the other — the customer hears the
    // wrong audio on a live call. Assert the prefix is actually applied by
    // showing the digest is NOT a plain sha256 of the bytes.
    const bytes = Buffer.from('collide');
    const plain = crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 40);
    expect(hashAudioFileContent(bytes)).not.toBe(plain);
    expect(hashAudioFileContent(bytes)).toBe(
      crypto.createHash('sha256').update('audio-file:v1:').update(bytes).digest('hex').slice(0, 40),
    );
  });

  it('never equals hashTtsInput for the same textual content', () => {
    const text = 'Hello, your payment is due';
    expect(hashAudioFileContent(Buffer.from(text))).not.toBe(hashTtsInput(text, 'en-IN', 'WOMAN'));
  });

  it('handles an empty buffer without throwing', () => {
    expect(hashAudioFileContent(Buffer.alloc(0))).toMatch(/^[a-f0-9]{40}$/);
  });
});

describe('audio clips round-trip through writeTtsFile → readTtsPcm', () => {
  // §5.4: writeTtsFile MUST be the only writer. readTtsPcm hardcodes a 44-byte
  // header, so any other writer (e.g. copying decoder output verbatim, which may
  // carry a LIST chunk) would have its chunk header read as audio samples.
  it('preserves samples and sample rate at a decoder-native rate', () => {
    const pcm = Buffer.alloc(200);
    for (let i = 0; i < 100; i++) pcm.writeInt16LE(Math.round(9000 * Math.sin(i / 5)), i * 2);

    const hash = hashAudioFileContent(Buffer.from('fixture-bytes-A'));
    writeTtsFile(hash, pcm, 44100, 1);

    try {
      expect(ttsFileExists(hash)).toBe(true);
      const read = readTtsPcm(hash);
      expect(read).not.toBeNull();
      expect(read!.sampleRate).toBe(44100);
      expect(read!.pcm16.length).toBe(pcm.length);
      expect(Buffer.compare(read!.pcm16, pcm)).toBe(0);
    } finally {
      deleteTtsFiles([hash]);
    }
  });

  it('writes exactly the 44-byte-header layout readTtsPcm assumes', () => {
    const hash = hashAudioFileContent(Buffer.from('fixture-bytes-B'));
    const pcm = Buffer.from([0x11, 0x22, 0x33, 0x44]);
    writeTtsFile(hash, pcm, 16000, 1);

    try {
      const raw = fs.readFileSync(getTtsFilePath(hash));
      // No LIST/INFO chunk: `data` starts at 36 and payload at 44.
      expect(raw.toString('ascii', 36, 40)).toBe('data');
      expect(raw.length).toBe(44 + pcm.length);
      expect(raw.readUInt32LE(24)).toBe(16000);
      expect(raw.readUInt16LE(22)).toBe(1); // mono
    } finally {
      deleteTtsFiles([hash]);
    }
  });

  it('two different audio files land on two different cache files', () => {
    const h1 = hashAudioFileContent(Buffer.from('file-one'));
    const h2 = hashAudioFileContent(Buffer.from('file-two'));
    writeTtsFile(h1, Buffer.from([1, 0]), 8000, 1);
    writeTtsFile(h2, Buffer.from([2, 0]), 8000, 1);
    try {
      expect(h1).not.toBe(h2);
      expect(readTtsPcm(h1)!.pcm16[0]).toBe(1);
      expect(readTtsPcm(h2)!.pcm16[0]).toBe(2);
    } finally {
      deleteTtsFiles([h1, h2]);
    }
  });
});
