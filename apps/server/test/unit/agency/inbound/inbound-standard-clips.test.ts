import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  AGENCY_INBOUND_STANDARD_RECORDINGS,
  type AgencyInboundStandardRecording,
} from '@magick-agency/contracts/api/agency/inbound';

/**
 * Our standard recordings (docs/inbound.md §3.4): the committed WAVs are there, one per standard
 * recording, in the form the bridge plays without work per call; and they reach the clip cache
 * lazily, once per recording however many callers ask at once (single-flighted), again after the
 * sweeper evicts one, through the cache's one writer and its content hash; and a recording that
 * cannot be read is "nothing to play", never a throw.
 */

const TMP_DIR = vi.hoisted(() => {
  const base = process.env['TMPDIR'] || '/tmp';
  const dir = `${base.replace(/\/$/, '')}/inbound-standard-${process.pid}-${Date.now()}`;
  process.env['TTS_AUDIO_DIR'] = dir;
  return dir;
});

const spies = vi.hoisted(() => ({ writes: 0, dir: null as string | null }));

vi.mock('../../../../src/tts/tts-file-cache.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/tts/tts-file-cache.js')>();
  return {
    ...actual,
    writeTtsFile: (...args: Parameters<typeof actual.writeTtsFile>) => {
      spies.writes += 1;
      return actual.writeTtsFile(...args);
    },
  };
});

vi.mock('../../../../src/agency/inbound/inbound-standard-clip-files.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/agency/inbound/inbound-standard-clip-files.js')>();
  return { ...actual, inboundStandardClipDir: () => spies.dir ?? actual.inboundStandardClipDir() };
});

import { parseWavPcm16 } from '../../../../src/audio/decode.js';
import { getTtsFilePath, hashAudioFileContent, initTtsFileCache, readTtsPcm } from '../../../../src/tts/tts-file-cache.js';
import { resetStandardClipsForTests, standardClipHash } from '../../../../src/agency/inbound/inbound-standard-clips.js';
import { INBOUND_STANDARD_CLIP_FILES, inboundStandardClipDir } from '../../../../src/agency/inbound/inbound-standard-clip-files.js';

const ASSETS = path.resolve(__dirname, '../../../../assets/inbound');

beforeEach(() => {
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
  initTtsFileCache();
  resetStandardClipsForTests();
  spies.writes = 0;
  spies.dir = null;
});

afterAll(() => {
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
});

describe('the committed recordings', () => {
  it('are found from the module, beside the source tree (the image puts them beside dist/)', () => {
    expect(inboundStandardClipDir()).toBe(ASSETS);
  });

  it('one per standard recording: 8 kHz mono PCM16, a plain 44-byte header, a few seconds long, with 3 dB of headroom', () => {
    expect(Object.keys(INBOUND_STANDARD_CLIP_FILES).sort()).toEqual([...AGENCY_INBOUND_STANDARD_RECORDINGS].sort());
    for (const recording of AGENCY_INBOUND_STANDARD_RECORDINGS) {
      const bytes = fs.readFileSync(path.join(ASSETS, INBOUND_STANDARD_CLIP_FILES[recording]));
      const wav = parseWavPcm16(bytes);
      expect(wav, recording).not.toBeNull();
      expect(wav!.sampleRate, recording).toBe(8000);
      expect(wav!.channels, recording).toBe(1);
      expect(bytes.toString('ascii', 36, 40), `${recording}: data at byte 36, no metadata chunk`).toBe('data');
      const seconds = wav!.pcm.length / 2 / 8000;
      expect(seconds, recording).toBeGreaterThan(2);
      expect(seconds, recording).toBeLessThan(12);
      const samples = new Int16Array(wav!.pcm.buffer, wav!.pcm.byteOffset, wav!.pcm.length / 2);
      let peak = 0;
      for (const v of samples) peak = Math.max(peak, Math.abs(v));
      expect(peak, `${recording}: speech, not silence`).toBeGreaterThan(8000);
      expect(peak, `${recording}: not clipped`).toBeLessThan(32767 * 0.75);
    }
  });

  it('a README states the voice, its licence and attribution, and that the files are replaceable', () => {
    const readme = fs.readFileSync(path.join(ASSETS, 'README.md'), 'utf8');
    expect(readme).toMatch(/southern_english_female/);
    expect(readme).toMatch(/CC BY-SA 4\.0/);
    expect(readme).toMatch(/openslr\.org\/83/);
    expect(readme).toMatch(/drop-in replaceable/);
  });
});

describe('standardClipHash', () => {
  it('writes the recording into the clip cache under its content hash, at the telephony rate', async () => {
    const hash = await standardClipHash('closed');
    const bytes = fs.readFileSync(path.join(ASSETS, INBOUND_STANDARD_CLIP_FILES.closed));
    expect(hash).toBe(hashAudioFileContent(bytes));
    const cached = readTtsPcm(hash!);
    expect(cached?.sampleRate).toBe(8000);
    expect(cached?.pcm16.length).toBe(parseWavPcm16(bytes)!.pcm.length);
  });

  it('once, however many callers ask at once, and not again while it is cached', async () => {
    const hashes = await Promise.all(Array.from({ length: 8 }, () => standardClipHash('please_hold')));
    expect(new Set(hashes).size).toBe(1);
    expect(spies.writes).toBe(1);
    await standardClipHash('please_hold');
    expect(spies.writes).toBe(1);
  });

  it('writes it again after the sweeper evicted it', async () => {
    const hash = (await standardClipHash('callback'))!;
    fs.unlinkSync(getTtsFilePath(hash));
    expect(await standardClipHash('callback')).toBe(hash);
    expect(spies.writes).toBe(2);
    expect(fs.existsSync(getTtsFilePath(hash))).toBe(true);
  });

  it('each recording is its own clip', async () => {
    const all = await Promise.all(AGENCY_INBOUND_STANDARD_RECORDINGS.map((r: AgencyInboundStandardRecording) => standardClipHash(r)));
    expect(all.every((h) => typeof h === 'string')).toBe(true);
    expect(new Set(all).size).toBe(AGENCY_INBOUND_STANDARD_RECORDINGS.length);
  });

  it('a recording that cannot be read is nothing to play: null, never a throw', async () => {
    spies.dir = path.join(TMP_DIR, 'nowhere');
    await expect(standardClipHash('busy')).resolves.toBeNull();
    // Not a WAV of PCM16.
    fs.mkdirSync(spies.dir, { recursive: true });
    fs.writeFileSync(path.join(spies.dir, INBOUND_STANDARD_CLIP_FILES.busy), 'not audio');
    await expect(standardClipHash('busy')).resolves.toBeNull();
    expect(spies.writes).toBe(0);
  });
});
