// PORT NOTE (magick-agency): ported from magic-voice-core/test/unit/tts/tts-cache-sweep-metrics.test.ts@4850d1d9.
// Only changes: logger mock specifier -> @magick-agency/observability.
import { describe, it, expect, beforeEach, afterEach, afterAll, vi, type Mock } from 'vitest';
import fs from 'node:fs';

/**
 * The sweeper's cache-LEVEL signal.
 *
 * A static-call request is capped at 100 phones, so no single request can
 * approach the 500 MB clip cap — the thing that overflows is this node's
 * directory across many requests (a 3,477-contact campaign arrives as ~35 of
 * them). The sweep is the only pass that ever computes that total, which is why
 * the observer reuses the stats it already collected rather than walking the
 * directory a second time, and why nothing maintains a running counter in
 * `writeTtsFile` (it would drift against external deletion and against the
 * sweeper itself).
 *
 * The counter that matters most here is the liveness FAILURE: a failed lookup
 * skips eviction for the whole cycle, so a query that times out every cycle
 * silently turns the cap into no cap.
 */

const TMP_DIR = vi.hoisted(() => {
  const base = process.env['TMPDIR'] || '/tmp';
  const dir = `${base.replace(/\/$/, '')}/tts-sweep-metrics-${process.pid}-${Date.now()}`;
  process.env['TTS_AUDIO_DIR'] = dir;
  return dir;
});

const logs = vi.hoisted(() => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock('@magick-agency/observability', () => ({
  logger: logs,
  createChildLogger: () => logs,
}));

const {
  sweepTtsCache,
  getTtsFilePath,
  setEvictableClipFilter,
  setTtsCacheSweepObserver,
} = await import('../../../src/tts/tts-file-cache.js');

function writeClip(hash: string, bytes: number, ageMs: number): void {
  const filePath = getTtsFilePath(hash);
  fs.writeFileSync(filePath, Buffer.alloc(bytes));
  const mtime = new Date(Date.now() - ageMs);
  fs.utimesSync(filePath, mtime, mtime);
}

function writeTemp(hash: string, bytes: number, ageMs: number): void {
  const filePath = `${TMP_DIR}/${hash}.wav.tmp-${process.pid}-a1b2c3d4e5f6`;
  fs.writeFileSync(filePath, Buffer.alloc(bytes));
  const mtime = new Date(Date.now() - ageMs);
  fs.utimesSync(filePath, mtime, mtime);
}

const hash = (c: string): string => c.repeat(40);

/** Mirrors `TtsCacheSweepStats` structurally — the seam is duck-typed on purpose. */
type SweepStats = { cacheBytes: number; retained: number; livenessFailed: boolean };

const NEVER_BY_AGE = 86_400_000;
const NEVER_BY_SIZE = Number.MAX_SAFE_INTEGER;

/** Matches `filterDeletableTtsHashes`: returns the hashes SAFE to unlink. */
function retaining(...held: string[]): (hashes: string[]) => Promise<string[]> {
  const live = new Set(held);
  return async (hashes) => hashes.filter((h) => !live.has(h));
}

describe('sweepTtsCache — cache-level metrics', () => {
  let observed: SweepStats[];
  let observer: Mock<(stats: SweepStats) => void>;

  beforeEach(() => {
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
    fs.mkdirSync(TMP_DIR, { recursive: true });
    logs.warn.mockReset();
    logs.info.mockReset();
    observed = [];
    observer = vi.fn((stats: SweepStats) => { observed.push(stats); });
    setTtsCacheSweepObserver(observer);
  });

  afterEach(() => {
    // Module-level seams: leaking either into the next test would silently
    // change what that test measures.
    setTtsCacheSweepObserver(null);
    setEvictableClipFilter(null);
  });

  afterAll(() => {
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
  });

  // ── The gauge: on-disk clip bytes AFTER eviction ───────────────────

  it('reports the full clip total when nothing is evicted', async () => {
    writeClip(hash('a'), 1000, 1_000);
    writeClip(hash('b'), 500, 2_000);

    await sweepTtsCache({ maxAgeMs: NEVER_BY_AGE, maxBytes: NEVER_BY_SIZE });

    expect(observed).toEqual([{ cacheBytes: 1500, retained: 0, livenessFailed: false }]);
  });

  it('reports the POST-eviction total, not what it found', async () => {
    writeClip(hash('a'), 1000, 90_000); // expired
    writeClip(hash('b'), 500, 1_000);

    const result = await sweepTtsCache({ maxAgeMs: 30_000, maxBytes: NEVER_BY_SIZE });

    expect(result).toEqual({ deleted: 1, freedBytes: 1000 });
    expect(observed[0]?.cacheBytes).toBe(500);
  });

  // A clip the guard withheld is still ON DISK, so it must still be counted —
  // this is exactly the case where the gauge tells an operator the cap is being
  // exceeded on purpose.
  it('counts a retained clip toward the cache total', async () => {
    writeClip(hash('a'), 1000, 40_000); // oldest — live, retained
    writeClip(hash('b'), 1000, 30_000); // dead, evicted
    writeClip(hash('c'), 1000, 20_000);
    setEvictableClipFilter(retaining(hash('a')));

    await sweepTtsCache({ maxAgeMs: NEVER_BY_AGE, maxBytes: 1000 });

    expect(observed).toEqual([{ cacheBytes: 2000, retained: 1, livenessFailed: false }]);
  });

  // The gauge is compared against `maxBytes`, which counts CLIPS. Scratch files
  // never end in `.wav`, so they are outside both — and must stay outside both.
  it('excludes scratch files from the cache total', async () => {
    writeClip(hash('a'), 1000, 1_000);
    writeTemp(hash('t'), 9_000, 1_000); // too young to reap, and never a clip

    await sweepTtsCache({ maxAgeMs: NEVER_BY_AGE, maxBytes: NEVER_BY_SIZE });

    expect(observed[0]?.cacheBytes).toBe(1000);
  });

  // A unlink that fails frees nothing, and the gauge must say so rather than
  // assuming the eviction landed.
  it('does not subtract bytes for an eviction that failed', async () => {
    writeClip(hash('a'), 1000, 90_000);
    writeClip(hash('b'), 500, 1_000);
    const unlink = vi.spyOn(fs.promises, 'unlink')
      .mockRejectedValueOnce(Object.assign(new Error('EACCES'), { code: 'EACCES' }));

    const result = await sweepTtsCache({ maxAgeMs: 30_000, maxBytes: NEVER_BY_SIZE });

    expect(result).toEqual({ deleted: 0, freedBytes: 0 });
    expect(observed[0]?.cacheBytes).toBe(1500);
    unlink.mockRestore();
  });

  // ENOENT is NOT the same as a failed eviction: the file is genuinely gone,
  // just not by our hand. `releaseBatchTtsClips` unlinks shared clips on batch
  // completion and runs concurrently with the sweep, so this is a normal
  // outcome, not an error — hence no warn line and no retry.
  it('discounts a clip already deleted by a concurrent batch cleanup', async () => {
    writeClip(hash('a'), 1000, 90_000);
    writeClip(hash('b'), 500, 1_000);
    const unlink = vi.spyOn(fs.promises, 'unlink')
      .mockRejectedValueOnce(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

    const result = await sweepTtsCache({ maxAgeMs: 30_000, maxBytes: NEVER_BY_SIZE });

    // The sweep freed nothing — it must not claim credit for someone else's
    // unlink, because `freedBytes` is what SweepResult reports.
    expect(result).toEqual({ deleted: 0, freedBytes: 0 });
    // ...but the bytes are off the disk, so the capacity gauge must not
    // still be carrying them. This is the whole distinction.
    expect(observed[0]?.cacheBytes).toBe(500);
    expect(logs.warn).not.toHaveBeenCalled();
    unlink.mockRestore();
  });

  // ── The counters ───────────────────────────────────────────────────

  it('reports every victim as retained when the liveness lookup fails', async () => {
    writeClip(hash('a'), 1000, 90_000);
    writeClip(hash('b'), 1000, 90_000);
    setEvictableClipFilter(async () => { throw new Error('db down'); });

    const result = await sweepTtsCache({ maxAgeMs: 30_000, maxBytes: NEVER_BY_SIZE });

    expect(result).toEqual({ deleted: 0, freedBytes: 0 });
    expect(observed).toEqual([{ cacheBytes: 2000, retained: 2, livenessFailed: true }]);
  });

  it('reports a liveness TIMEOUT the same way as a failure', async () => {
    writeClip(hash('a'), 1000, 90_000);
    setEvictableClipFilter(() => new Promise<string[]>(() => { /* never settles */ }));

    await sweepTtsCache({ maxAgeMs: 30_000, maxBytes: NEVER_BY_SIZE, livenessTimeoutMs: 20 });

    expect(observed[0]).toMatchObject({ retained: 1, livenessFailed: true });
  });

  it('reports livenessFailed=false when no filter is registered at all', async () => {
    writeClip(hash('a'), 1000, 90_000);
    setEvictableClipFilter(null);

    await sweepTtsCache({ maxAgeMs: 30_000, maxBytes: NEVER_BY_SIZE });

    expect(observed).toEqual([{ cacheBytes: 0, retained: 0, livenessFailed: false }]);
  });

  // ── When it fires, and when it must not ────────────────────────────

  it('observes once per sweep, and joiners do not double-count', async () => {
    writeClip(hash('a'), 1000, 90_000);
    setEvictableClipFilter(
      (hashes) => new Promise<string[]>((r) => setTimeout(() => r(hashes), 5)),
    );

    const p1 = sweepTtsCache({ maxAgeMs: 30_000, maxBytes: NEVER_BY_SIZE });
    const p2 = sweepTtsCache({ maxAgeMs: 30_000, maxBytes: NEVER_BY_SIZE });
    await Promise.all([p1, p2]);

    expect(observer).toHaveBeenCalledTimes(1);
  });

  // The early return measured nothing. Publishing 0 there would read as "the
  // cache is empty", which is a different fact from "not measured".
  it('does not observe when the cache directory is absent', async () => {
    fs.rmSync(TMP_DIR, { recursive: true, force: true });

    await sweepTtsCache({ maxAgeMs: 30_000, maxBytes: NEVER_BY_SIZE });

    expect(observer).not.toHaveBeenCalled();
  });

  // ── An observability fault must never damage the thing it observes ──

  it('completes the sweep normally when the observer throws', async () => {
    writeClip(hash('a'), 1000, 90_000);
    observer.mockImplementation(() => { throw new Error('metrics registry error'); });

    // The unlink already happened, so the result must still report it — being
    // caught by `runSweep` instead would report { deleted: 0, freedBytes: 0 }.
    await expect(sweepTtsCache({ maxAgeMs: 30_000, maxBytes: NEVER_BY_SIZE }))
      .resolves.toEqual({ deleted: 1, freedBytes: 1000 });
    expect(fs.existsSync(getTtsFilePath(hash('a')))).toBe(false);
    expect(logs.warn.mock.calls.at(-1)?.[1]).toContain('metrics observer threw');
  });

  it('releases the single-flight slot when the observer throws', async () => {
    writeClip(hash('a'), 100, 90_000);
    observer.mockImplementation(() => { throw new Error('boom'); });
    await sweepTtsCache({ maxAgeMs: 30_000, maxBytes: NEVER_BY_SIZE });

    // A wedged slot would make every later tick a silent no-op.
    writeClip(hash('b'), 100, 90_000);
    await expect(sweepTtsCache({ maxAgeMs: 30_000, maxBytes: NEVER_BY_SIZE }))
      .resolves.toEqual({ deleted: 1, freedBytes: 100 });
  });

  it('sweeps normally with no observer registered', async () => {
    setTtsCacheSweepObserver(null);
    writeClip(hash('a'), 100, 90_000);

    await expect(sweepTtsCache({ maxAgeMs: 30_000, maxBytes: NEVER_BY_SIZE }))
      .resolves.toEqual({ deleted: 1, freedBytes: 100 });
  });
});
