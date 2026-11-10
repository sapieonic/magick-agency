import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * A recording uploaded for inbound routes (docs/inbound.md §8.4): checked and decoded whole
 * before anything is stored (type, name, size, length, a file that does not decode), cached at
 * the telephony rate under the hash `ensurePcmClip` would compute, and stored under a key of the
 * tenant and account that the internal handler can prove. Decoding is real (`mpg123` and
 * `sndfile-programs`, as `test/unit/audio/decode.test.ts`).
 */

const TMP_DIR = vi.hoisted(() => {
  const base = process.env['TMPDIR'] || '/tmp';
  const dir = `${base.replace(/\/$/, '')}/inbound-recordings-${process.pid}-${Date.now()}`;
  process.env['TTS_AUDIO_DIR'] = dir;
  return dir;
});

import {
  inboundRecordingExt,
  inboundRecordingKey,
  inboundRecordingName,
  inboundRecordingSlug,
  isInboundRecordingKey,
  prepareInboundRecording,
} from '../../../../src/agency/inbound/inbound-recordings.js';
import { createWavBuffer, hashAudioFileContent, initTtsFileCache, readTtsPcm } from '../../../../src/tts/tts-file-cache.js';

const WAV = fs.readFileSync(path.resolve(__dirname, '../../../../assets/inbound/recording-notice.wav'));
const T = '11111111-1111-4111-8111-111111111111';
const A = '22222222-2222-4222-8222-222222222222';

beforeAll(() => initTtsFileCache());
afterAll(() => fs.rmSync(TMP_DIR, { recursive: true, force: true }));

describe('prepareInboundRecording', () => {
  it('a WAV that decodes: named from the file, its length, cached at 8 kHz under its content hash', async () => {
    const result = await prepareInboundRecording({ bytes: WAV, filename: 'Notice.WAV', mimetype: 'audio/x-wav' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const r = result.recording;
    expect(r).toMatchObject({ name: 'Notice', contentType: 'audio/wav', ext: '.wav', pcmSampleRate: 8000 });
    expect(r.durationSeconds).toBeGreaterThan(3);
    expect(r.durationSeconds).toBeLessThan(6);
    expect(r.pcmHash).toBe(hashAudioFileContent(WAV));
    expect(readTtsPcm(r.pcmHash)?.sampleRate).toBe(8000);
  });

  it('a 44.1 kHz stereo WAV is converted to the telephony rate for the cache', async () => {
    const stereo = createWavBuffer(Buffer.alloc(44_100 * 2 * 2), 44_100, 2);
    // A second of silence is a plausible clip as far as the decoder goes.
    const result = await prepareInboundRecording({ bytes: stereo, filename: 'tone.wav', name: 'Tone' });
    expect(result.ok && readTtsPcm(result.recording.pcmHash)?.sampleRate).toBe(8000);
  });

  it('refuses before decoding: a type it cannot play, a name it cannot show, an empty or oversized file', async () => {
    expect(await prepareInboundRecording({ bytes: WAV, filename: 'notes.txt' })).toMatchObject({ ok: false, reason: 'unsupported_type' });
    expect(await prepareInboundRecording({ bytes: WAV, filename: 'clip.m4a', mimetype: 'audio/mp4' })).toMatchObject({ ok: false, reason: 'unsupported_type' });
    expect(await prepareInboundRecording({ bytes: WAV, filename: 'a.wav', name: 'x'.repeat(121) })).toMatchObject({ ok: false, reason: 'name_invalid' });
    expect(await prepareInboundRecording({ bytes: Buffer.alloc(0), filename: 'a.wav' })).toMatchObject({ ok: false, reason: 'empty' });
    expect(await prepareInboundRecording({ bytes: Buffer.alloc(5 * 1024 * 1024 + 1), filename: 'a.wav' })).toMatchObject({ ok: false, reason: 'too_large' });
  });

  it('refuses a file that does not decode, with a clear message', async () => {
    const result = await prepareInboundRecording({ bytes: Buffer.from('this is not audio at all, just text'.repeat(40)), filename: 'fake.mp3' });
    expect(result).toEqual({
      ok: false, reason: 'undecodable',
      message: 'The file could not be read as audio. It may be damaged, or not the type its name says.',
    });
    const wavJunk = await prepareInboundRecording({ bytes: Buffer.from('RIFF....WAVEjunkjunkjunk'), filename: 'fake.wav' });
    expect(wavJunk).toMatchObject({ ok: false });
  });

  it('refuses a recording longer than two minutes', async () => {
    const long = createWavBuffer(Buffer.alloc(121 * 8000 * 2), 8000, 1);
    expect(await prepareInboundRecording({ bytes: long, filename: 'long.wav' })).toMatchObject({ ok: false, reason: 'too_long' });
  });
});

describe('the pieces', () => {
  it('the type from the name, else from the browser’s type when the name has no extension', () => {
    expect(inboundRecordingExt('a.MP3', undefined)).toBe('.mp3');
    expect(inboundRecordingExt('a.ogg', 'audio/wav')).toBe('.ogg');
    expect(inboundRecordingExt('recording', 'audio/mpeg')).toBe('.mp3');
    expect(inboundRecordingExt('recording', 'audio/wav; codecs=1')).toBe('.wav');
    expect(inboundRecordingExt('a.flac', 'audio/wav')).toBeNull();
    expect(inboundRecordingExt('recording', undefined)).toBeNull();
  });

  it('the name: given, else the file’s; whitespace and control characters folded', () => {
    expect(inboundRecordingName('  Spring\n greeting ', 'x.wav')).toBe('Spring greeting');
    expect(inboundRecordingName(undefined, 'Main greeting.wav')).toBe('Main greeting');
    expect(inboundRecordingName('   ', 'Fallback.mp3')).toBe('Fallback');
    expect(inboundRecordingName(undefined, '.wav')).toBe('.wav');
    expect(inboundRecordingName('\u0007', '')).toBeNull();
  });

  it('a key of the tenant and account, proved by its shape; another account’s, or a path, is not', () => {
    const key = inboundRecordingKey(T, A, '.wav');
    expect(key).toMatch(new RegExp(`^inbound-audio/${T}/${A}/[0-9a-f-]{36}\\.wav$`));
    expect(isInboundRecordingKey(key, T, A)).toBe(true);
    expect(isInboundRecordingKey(key, T, '33333333-3333-4333-8333-333333333333')).toBe(false);
    expect(isInboundRecordingKey(`inbound-audio/${T}/${A}/../x.wav`, T, A)).toBe(false);
    expect(isInboundRecordingKey(`inbound-voicemail/${T}/${A}/${'a'.repeat(36)}.wav`, T, A)).toBe(false);
    expect(inboundRecordingKey(T, A, '.wav')).not.toBe(key);
  });

  it('a slug for the row', () => {
    expect(inboundRecordingSlug('Spring greeting (v2)')).toBe('spring-greeting-v2');
    expect(inboundRecordingSlug('££')).toBe('recording');
  });
});
