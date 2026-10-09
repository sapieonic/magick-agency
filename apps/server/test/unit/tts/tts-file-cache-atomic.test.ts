// PORT NOTE (magick-agency): ported from magic-voice-core/test/unit/tts/tts-file-cache-atomic.test.ts@4850d1d9.
// Changes: type-only fix
// for the server tsconfig (typechecks tests): the three `(p: never, d: never)` writeFileSync mocks cast
// through `unknown` (TS2352).
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Point the cache at an isolated temp dir BEFORE the module is loaded — the
// module resolves TTS_AUDIO_DIR from this env var at import time.
const TMP_DIR = vi.hoisted(() => {
  const base = process.env['TMPDIR'] || '/tmp';
  const dir = `${base.replace(/\/$/, '')}/tts-atomic-${process.pid}-${Date.now()}`;
  process.env['TTS_AUDIO_DIR'] = dir;
  return dir;
});

import {
  writeTtsFile,
  readTtsFile,
  readTtsPcm,
  ttsFileExists,
  getTtsFilePath,
  sweepTtsCache,
} from '../../../src/tts/tts-file-cache.js';

/** Names of in-progress scratch files currently in the cache dir. */
function tempFiles(): string[] {
  return fs.readdirSync(TMP_DIR).filter((n) => n.includes('.wav.tmp-'));
}

function clipFiles(): string[] {
  return fs.readdirSync(TMP_DIR).filter((n) => n.endsWith('.wav'));
}

function resetDir(): void {
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
  fs.mkdirSync(TMP_DIR, { recursive: true });
}

/** Distinctive PCM16 so a truncated read is detectable by content, not just length. */
function samplePcm(samples = 8000): Buffer {
  const arr = new Int16Array(samples);
  for (let i = 0; i < samples; i++) arr[i] = ((i * 37) % 30000) - 15000;
  return Buffer.from(arr.buffer);
}

const HASH = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';

describe('writeTtsFile — atomicity', () => {
  beforeEach(() => {
    resetDir();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(() => {
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
  });

  it('writes the payload to a scratch file, never directly to the final path', () => {
    const seen: string[] = [];
    const realWrite = fs.writeFileSync;
    vi.spyOn(fs, 'writeFileSync').mockImplementation(((p: never, d: never, o: never) => {
      seen.push(String(p));
      return (realWrite as never as (a: never, b: never, c: never) => void)(p, d, o);
    }) as typeof fs.writeFileSync);

    writeTtsFile(HASH, samplePcm(64), 8000, 1);

    expect(seen).toHaveLength(1);
    expect(seen[0]).not.toBe(getTtsFilePath(HASH));
    expect(seen[0]).toContain('.wav.tmp-');
    // Same directory — rename(2) is only atomic within one filesystem.
    expect(path.dirname(seen[0]!)).toBe(path.dirname(getTtsFilePath(HASH)));
    // …and the temp name must not end in `.wav`, or the sweeper's clip filter
    // would treat a half-written file as a servable clip.
    expect(seen[0]!.endsWith('.wav')).toBe(false);
  });

  it('a reader at the instant before rename observes no file at all (never a partial one)', () => {
    const pcm = samplePcm();
    let observedExists: boolean | null = null;
    let observedPcm: unknown = 'unset';

    const realRename = fs.renameSync;
    vi.spyOn(fs, 'renameSync').mockImplementation(((from: never, to: never) => {
      // The full payload is already on disk under the scratch name at this
      // point. A concurrent reader must still see nothing.
      observedExists = ttsFileExists(HASH);
      observedPcm = readTtsPcm(HASH);
      return (realRename as never as (a: never, b: never) => void)(from, to);
    }) as typeof fs.renameSync);

    writeTtsFile(HASH, pcm, 8000, 1);

    expect(observedExists).toBe(false);
    expect(observedPcm).toBeNull();
    // After the rename the clip is complete and intact.
    expect(readTtsPcm(HASH)!.pcm16.equals(pcm)).toBe(true);
  });

  it('a mid-write failure leaves NO destination file and NO temp litter', () => {
    const boom = Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
    const realWrite = fs.writeFileSync;
    vi.spyOn(fs, 'writeFileSync').mockImplementation(((p: never, d: never) => {
      // Emulate the real ENOSPC shape: a PREFIX of the payload lands on disk,
      // then the write fails. This is exactly what poisoned the cache before.
      const buf = d as unknown as Buffer;
      (realWrite as never as (a: never, b: never) => void)(p, buf.subarray(0, 44 + 1600) as never);
      throw boom;
    }) as unknown as typeof fs.writeFileSync);

    expect(() => writeTtsFile(HASH, samplePcm(), 8000, 1)).toThrow(boom);

    expect(ttsFileExists(HASH)).toBe(false);
    expect(readTtsFile(HASH)).toBeNull();
    expect(readTtsPcm(HASH)).toBeNull();
    expect(tempFiles()).toEqual([]);
    expect(clipFiles()).toEqual([]);
  });

  it('propagates the ORIGINAL error object unchanged (callers key cleanup off the throw)', () => {
    const boom = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    vi.spyOn(fs, 'writeFileSync').mockImplementation((() => {
      throw boom;
    }) as typeof fs.writeFileSync);

    let caught: unknown;
    try {
      writeTtsFile(HASH, samplePcm(16), 8000, 1);
    } catch (err) {
      caught = err;
    }
    // Identity, not just message — the scratch cleanup must not swallow or
    // replace it (e.g. with its own ENOENT).
    expect(caught).toBe(boom);
    expect((caught as NodeJS.ErrnoException).code).toBe('EACCES');
    expect(tempFiles()).toEqual([]);
  });

  it('a failed rewrite does not clobber an existing good clip', () => {
    const good = samplePcm();
    writeTtsFile(HASH, good, 8000, 1);
    expect(readTtsPcm(HASH)!.pcm16.equals(good)).toBe(true);

    const boom = Object.assign(new Error('disk full'), { code: 'ENOSPC' });
    const realWrite = fs.writeFileSync;
    vi.spyOn(fs, 'writeFileSync').mockImplementation(((p: never, d: never) => {
      const buf = d as unknown as Buffer;
      (realWrite as never as (a: never, b: never) => void)(p, buf.subarray(0, 60) as never);
      throw boom;
    }) as unknown as typeof fs.writeFileSync);

    expect(() => writeTtsFile(HASH, samplePcm(), 8000, 1)).toThrow(boom);

    // The previously-cached clip is untouched — the failed write never reached
    // the final path.
    expect(readTtsPcm(HASH)!.pcm16.equals(good)).toBe(true);
    expect(tempFiles()).toEqual([]);
  });

  it('two concurrent writers of the SAME hash both succeed and leave one valid clip', () => {
    const pcm = samplePcm();
    // Interleave by pausing writer A between its temp write and its rename, and
    // running writer B (write + rename) entirely inside that window. Both must
    // succeed; because clips are content-addressed the payloads are identical
    // and last-rename-wins is correct.
    let reentered = false;
    const realRename = fs.renameSync;
    vi.spyOn(fs, 'renameSync').mockImplementation(((from: never, to: never) => {
      if (!reentered) {
        reentered = true;
        writeTtsFile(HASH, pcm, 8000, 1); // writer B, start to finish
      }
      return (realRename as never as (a: never, b: never) => void)(from, to);
    }) as typeof fs.renameSync);

    expect(() => writeTtsFile(HASH, pcm, 8000, 1)).not.toThrow(); // writer A

    expect(readTtsPcm(HASH)!.pcm16.equals(pcm)).toBe(true);
    expect(clipFiles()).toEqual([`${HASH}.wav`]);
    expect(tempFiles()).toEqual([]);
  });

  it('distinct concurrent writers use distinct scratch paths (pid + random)', () => {
    const seen = new Set<string>();
    const realWrite = fs.writeFileSync;
    vi.spyOn(fs, 'writeFileSync').mockImplementation(((p: never, d: never, o: never) => {
      seen.add(String(p));
      return (realWrite as never as (a: never, b: never, c: never) => void)(p, d, o);
    }) as typeof fs.writeFileSync);

    for (let i = 0; i < 25; i++) writeTtsFile(HASH, samplePcm(16), 8000, 1);

    expect(seen.size).toBe(25);
    for (const p of seen) {
      expect(path.basename(p)).toMatch(new RegExp(`^${HASH}\\.wav\\.tmp-\\d+-[0-9a-f]{12}$`));
    }
  });

  it('regression: the reproduced poisoning scenario can no longer produce a cache hit', () => {
    // Before the fix, a 44+1600-byte prefix on the FINAL path satisfied
    // ttsFileExists, generateTtsAudio short-circuited on it, and the call played
    // 0.1 s of a 20 s announcement while still billing as connected.
    const twentySecondsAt8k = samplePcm(8000 * 20);
    const boom = Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
    const realWrite = fs.writeFileSync;
    vi.spyOn(fs, 'writeFileSync').mockImplementation(((p: never, d: never) => {
      const buf = d as unknown as Buffer;
      (realWrite as never as (a: never, b: never) => void)(p, buf.subarray(0, 44 + 1600) as never);
      throw boom;
    }) as unknown as typeof fs.writeFileSync);

    expect(() => writeTtsFile(HASH, twentySecondsAt8k, 8000, 1)).toThrow(boom);
    vi.restoreAllMocks();

    // No poisoned hit: the next synthesis attempt is NOT short-circuited.
    expect(ttsFileExists(HASH)).toBe(false);
    expect(readTtsPcm(HASH)).toBeNull();

    // …and re-synthesis lands the full 20 s.
    writeTtsFile(HASH, twentySecondsAt8k, 8000, 1);
    const clip = readTtsPcm(HASH)!;
    expect(clip.pcm16.length / 2 / clip.sampleRate).toBe(20);
  });
});

describe('sweepTtsCache — scratch files', () => {
  beforeEach(() => {
    resetDir();
  });

  afterAll(() => {
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
  });

  /** Write a scratch file with the exact name shape writeTtsFile produces. */
  function writeTemp(hash: string, bytes: number, ageMs: number): string {
    const p = path.join(TMP_DIR, `${hash}.wav.tmp-4242-0123456789ab`);
    fs.writeFileSync(p, Buffer.alloc(bytes));
    const mtime = new Date(Date.now() - ageMs);
    fs.utimesSync(p, mtime, mtime);
    return p;
  }

  function writeClip(hash: string, bytes: number, ageMs: number): string {
    const p = getTtsFilePath(hash);
    fs.writeFileSync(p, Buffer.alloc(bytes));
    const mtime = new Date(Date.now() - ageMs);
    fs.utimesSync(p, mtime, mtime);
    return p;
  }

  it('does not count a temp file toward the size cap', async () => {
    // One 1000-byte clip plus a 10 MB temp. With a 2000-byte cap, a sweeper that
    // counted the temp would evict the clip; it must not.
    const clip = writeClip('c'.repeat(40), 1000, 1_000);
    writeTemp('d'.repeat(40), 10_000_000, 1_000);

    const result = await sweepTtsCache({ maxAgeMs: 86_400_000, maxBytes: 2000 });

    expect(result.deleted).toBe(0);
    expect(fs.existsSync(clip)).toBe(true);
  });

  it('does not delete a temp file as if it were an expired clip', async () => {
    // Old enough to blow the CLIP age gate, young enough for the temp gate.
    const tmp = writeTemp('e'.repeat(40), 100, 60_000);

    const result = await sweepTtsCache({ maxAgeMs: 30_000, maxBytes: Number.MAX_SAFE_INTEGER });

    expect(result.deleted).toBe(0);
    expect(fs.existsSync(tmp)).toBe(true);
  });

  it('reaps a stale temp but leaves a fresh one alone', async () => {
    const stale = writeTemp('f'.repeat(40), 100, 7_200_000); // 2h old
    const fresh = writeTemp('9'.repeat(40), 100, 60_000); // 1m old

    await sweepTtsCache({
      maxAgeMs: 86_400_000,
      maxBytes: Number.MAX_SAFE_INTEGER,
      tempReapMinAgeMs: 3_600_000,
    });

    expect(fs.existsSync(stale)).toBe(false);
    // A fresh temp may be an in-progress write by another replica on a shared
    // volume — reaping it would turn a slow write into a failed one.
    expect(fs.existsSync(fresh)).toBe(true);
  });

  it('reaped temps do not inflate the clip `deleted` count', async () => {
    writeTemp('7'.repeat(40), 100, 7_200_000);
    writeClip('8'.repeat(40), 100, 90_000); // expired clip

    const result = await sweepTtsCache({ maxAgeMs: 30_000, maxBytes: Number.MAX_SAFE_INTEGER });

    // Exactly one CLIP evicted; the reap is not counted.
    expect(result.deleted).toBe(1);
    expect(result.freedBytes).toBe(100);
  });

  it('an interrupted write cannot leak a file the sweeper ignores forever', async () => {
    // Simulate a crash between temp-write and rename: the scratch survives.
    const realRename = fs.renameSync;
    vi.spyOn(fs, 'renameSync').mockImplementation((() => {
      throw Object.assign(new Error('killed'), { code: 'EIO' });
    }) as typeof fs.renameSync);
    expect(() => writeTtsFile(HASH, samplePcm(16), 8000, 1)).toThrow();
    vi.mocked(fs.renameSync).mockRestore();
    void realRename;

    // writeTtsFile's own cleanup already handles this case…
    expect(tempFiles()).toEqual([]);

    // …but a hard kill (no catch block runs) leaves the scratch behind. The
    // sweeper is the backstop for that.
    const orphan = writeTemp(HASH, 500, 7_200_000);
    expect(fs.existsSync(orphan)).toBe(true);
    await sweepTtsCache({ maxAgeMs: 86_400_000, maxBytes: Number.MAX_SAFE_INTEGER });
    expect(fs.existsSync(orphan)).toBe(false);
  });

  it('leaves unrelated non-clip files untouched', async () => {
    fs.writeFileSync(`${TMP_DIR}/notes.txt`, Buffer.alloc(10));
    fs.writeFileSync(`${TMP_DIR}/x.wav.tmp`, Buffer.alloc(10)); // not our shape
    const oldNote = `${TMP_DIR}/old.txt`;
    fs.writeFileSync(oldNote, Buffer.alloc(10));
    const past = new Date(Date.now() - 86_400_000);
    fs.utimesSync(oldNote, past, past);
    fs.utimesSync(`${TMP_DIR}/x.wav.tmp`, past, past);

    await sweepTtsCache({ maxAgeMs: 1000, maxBytes: 1, tempReapMinAgeMs: 1000 });

    expect(fs.existsSync(`${TMP_DIR}/notes.txt`)).toBe(true);
    expect(fs.existsSync(oldNote)).toBe(true);
    // The reaper matches ONLY the exact `{hash}.wav.tmp-{pid}-{nonce}` shape.
    expect(fs.existsSync(`${TMP_DIR}/x.wav.tmp`)).toBe(true);
  });
});
