// PORT NOTE (magick-agency): ported from magic-voice-core/test/integration/flows/tts-cache-sweep-scale.test.ts@4850d1d9.
// Verbatim.
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';

/**
 * `sweepTtsCache` against the REAL filesystem, at realistic scale.
 *
 * The unit suite instruments `fs/promises` to prove the bound and inject faults.
 * This one deliberately mocks nothing: real `readdir`/`stat`/`unlink`, real
 * `writeTtsFile` output, ~1,500 real files — the conditions the synchronous
 * version actually failed under. It covers three things unit tests structurally
 * cannot:
 *
 *  1. **Event-loop delay under a full-size sweep** — the ticket's own acceptance
 *     criterion. The old implementation issued one `statSync` per entry with no
 *     yield point, so at this scale nothing else in the process could run.
 *  2. **The sweeper racing a live writer** on one directory. `writeTtsFile`'s
 *     atomicity (temp + rename) and the reaper's age gate have to hold against
 *     each other for real, not against a fake.
 *  3. **Overlapping scheduled sweeps** coalescing, which is only meaningful when
 *     a sweep is slow enough to still be running when the next one starts.
 *
 * No Postgres or Redis — it lives in the integration suite because it is an
 * unmocked, full-scale exercise of the real thing, not because it needs a DB.
 */

const TMP_DIR = vi.hoisted(() => {
  const base = process.env['TMPDIR'] || '/tmp';
  const dir = `${base.replace(/\/$/, '')}/tts-sweep-scale-${process.pid}-${Date.now()}`;
  process.env['TTS_AUDIO_DIR'] = dir;
  return dir;
});

const { sweepTtsCache, writeTtsFile, readTtsPcm, getTtsFilePath, hashTtsInput } = await import(
  '../../../src/tts/tts-file-cache.js'
);

/** 40-hex cache keys, distinct per index — the real key shape. */
function keyFor(i: number): string {
  return hashTtsInput(`clip-${i}`, 'en-IN', 'WOMAN');
}

function ageFile(p: string, ageMs: number): void {
  const mtime = new Date(Date.now() - ageMs);
  fs.utimesSync(p, mtime, mtime);
}

/** A real clip, written through the real writer, then back-dated. */
function realClip(hash: string, samples: number, ageMs: number): string {
  writeTtsFile(hash, Buffer.alloc(samples * 2), 8000, 1);
  const p = getTtsFilePath(hash);
  ageFile(p, ageMs);
  return p;
}

function listWavs(): string[] {
  return fs.readdirSync(TMP_DIR).filter((n) => n.endsWith('.wav'));
}

function listTemps(): string[] {
  return fs.readdirSync(TMP_DIR).filter((n) => /\.wav\.tmp-\d+-[0-9a-f]{12}$/.test(n));
}

function resetDir(): void {
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
  fs.mkdirSync(TMP_DIR, { recursive: true });
}

const NEVER_BY_AGE = 86_400_000;
const NEVER_BY_SIZE = Number.MAX_SAFE_INTEGER;

/** Roughly the production cache population: 500 MB cap over ~200 KB clips. */
const SCALE = 1500;

describe('sweepTtsCache at scale, against the real filesystem (integration)', () => {
  beforeEach(() => {
    resetDir();
  });

  afterAll(() => {
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
  });

  it(`evicts correctly across ${SCALE} real files`, async () => {
    // Half aged out, half fresh — interleaved so ordering cannot accidentally
    // produce the right answer.
    for (let i = 0; i < SCALE; i++) {
      realClip(keyFor(i), 64, i % 2 === 0 ? 7 * 3_600_000 : 60_000);
    }
    expect(listWavs()).toHaveLength(SCALE);

    const result = await sweepTtsCache({ maxAgeMs: 6 * 3_600_000, maxBytes: NEVER_BY_SIZE });

    expect(result.deleted).toBe(SCALE / 2);
    expect(listWavs()).toHaveLength(SCALE / 2);
    // Every survivor is a fresh (odd-indexed) clip, and still readable.
    for (let i = 1; i < SCALE; i += 2) {
      expect(readTtsPcm(keyFor(i))?.pcm16.length).toBe(128);
    }
  });

  it('keeps the event loop responsive during a full-size sweep', async () => {
    for (let i = 0; i < SCALE; i++) realClip(keyFor(i), 64, 7 * 3_600_000);

    const histogram = monitorEventLoopDelay({ resolution: 1 });
    let ticks = 0;
    const timer = setInterval(() => { ticks++; }, 2);

    histogram.enable();
    try {
      await sweepTtsCache({ maxAgeMs: 6 * 3_600_000, maxBytes: NEVER_BY_SIZE });
    } finally {
      histogram.disable();
      clearInterval(timer);
    }

    expect(listWavs()).toHaveLength(0);

    // The load-bearing assertion, and the threshold is deliberately 0 rather
    // than a tuned number. A synchronous sweep over 1,500 entries blocks start
    // to finish, so the timer fires EXACTLY zero times; any yielding
    // implementation fires at least once. Anything higher would be tuned to one
    // machine's speed — timers also coalesce (a 2 ms interval overdue by 10 ms
    // fires once, not five times), so `ticks` counts loop iterations, not
    // elapsed intervals, and it drops as hardware gets faster.
    expect(ticks).toBeGreaterThan(0);

    // Corroborating, on `max` rather than `mean`: the sweep window is short, so
    // the histogram holds few samples and one GC pause would dominate a mean.
    // Sized to catch a sweep that monopolizes the loop for a second or more —
    // the actual regression — not to police jitter on shared CI hardware.
    expect(histogram.max / 1e6).toBeLessThan(1000);
  });

  it('does not corrupt or reap clips being written while it sweeps', async () => {
    // A big population of expiring clips, so the sweep is long enough to overlap.
    for (let i = 0; i < SCALE; i++) realClip(keyFor(i), 64, 7 * 3_600_000);

    const liveHashes: string[] = [];
    const writer = (async () => {
      for (let i = 0; i < 120; i++) {
        const h = hashTtsInput(`live-${i}`, 'en-IN', 'WOMAN');
        // Distinct payload length per clip, so a torn/half-written file or a
        // mixed-up rename shows up as a wrong sample count rather than passing.
        writeTtsFile(h, Buffer.alloc((i + 1) * 2), 8000, 1);
        liveHashes.push(h);
        await new Promise((r) => setImmediate(r));
      }
    })();

    const [result] = await Promise.all([
      sweepTtsCache({ maxAgeMs: 6 * 3_600_000, maxBytes: NEVER_BY_SIZE }),
      writer,
    ]);

    // Every aged clip went; the sweep never touched the fresh concurrent writes.
    expect(result.deleted).toBe(SCALE);
    for (const [i, h] of liveHashes.entries()) {
      const clip = readTtsPcm(h);
      expect(clip, `live clip ${i} missing`).not.toBeNull();
      expect(clip?.pcm16.length, `live clip ${i} truncated`).toBe((i + 1) * 2);
      expect(clip?.sampleRate).toBe(8000);
    }
    // The writer's own temps are renamed into place; none may be left behind.
    expect(listTemps()).toEqual([]);
  });

  it('reaps a crashed writer\'s scratch files without touching a live write', async () => {
    // Scratch left by a process killed between write and rename, backdated past
    // the reap gate. Shape must match `tempFilePath` exactly.
    const stale = path.join(TMP_DIR, `${keyFor(1)}.wav.tmp-9999-0123456789ab`);
    fs.writeFileSync(stale, Buffer.alloc(4096));
    ageFile(stale, 7_200_000); // 2h

    // A scratch file from a writer still running elsewhere on a shared volume.
    const fresh = path.join(TMP_DIR, `${keyFor(2)}.wav.tmp-8888-abcdef012345`);
    fs.writeFileSync(fresh, Buffer.alloc(4096));

    const result = await sweepTtsCache({
      maxAgeMs: NEVER_BY_AGE,
      maxBytes: NEVER_BY_SIZE,
      tempReapMinAgeMs: 3_600_000,
    });

    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
    // Reaps are never reported as clip evictions.
    expect(result).toEqual({ deleted: 0, freedBytes: 0 });
  });

  it('coalesces sweeps that overlap, so work is never double-counted', async () => {
    for (let i = 0; i < SCALE; i++) realClip(keyFor(i), 64, 7 * 3_600_000);
    const before = listWavs().length;

    // Fire a second sweep while the first is still walking the directory —
    // exactly what the hourly interval does when a sweep outruns its period.
    const p1 = sweepTtsCache({ maxAgeMs: 6 * 3_600_000, maxBytes: NEVER_BY_SIZE });
    const p2 = sweepTtsCache({ maxAgeMs: 6 * 3_600_000, maxBytes: NEVER_BY_SIZE });
    const [r1, r2] = await Promise.all([p1, p2]);

    // Both callers see the same single run…
    expect(r2).toEqual(r1);
    // …and that run's count matches what actually left the disk. Two concurrent
    // sweeps would each have claimed a share of the same files.
    expect(r1.deleted).toBe(before);
    expect(listWavs()).toHaveLength(0);
  });

  it('honours the size cap across a large population, evicting oldest-first', async () => {
    // 600 clips x 256 bytes of PCM (+44 header) — all fresh, so only size acts.
    const count = 600;
    const payload = 256;
    const onDisk = payload + 44;
    for (let i = 0; i < count; i++) {
      // Strictly increasing mtime with index: index 0 is oldest.
      realClip(keyFor(i), payload / 2, (count - i) * 1000);
    }

    // Keep room for 100 clips.
    const maxBytes = onDisk * 100;
    const result = await sweepTtsCache({ maxAgeMs: NEVER_BY_AGE, maxBytes });

    expect(result.deleted).toBe(count - 100);
    const survivors = listWavs();
    expect(survivors).toHaveLength(100);
    // The 100 newest are the ones kept.
    const expected = new Set(
      Array.from({ length: 100 }, (_, k) => `${keyFor(count - 1 - k)}.wav`),
    );
    expect(new Set(survivors)).toEqual(expected);
  });
});
