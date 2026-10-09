import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import fs from 'node:fs';

/**
 * The clip sweeper's reference-count guard.
 *
 * Eviction used to be unconditional on both paths. A static-call batch with
 * per-contact `{{variables}}` produces one distinct content-addressed clip per
 * contact (~281 KB for 18 s), so a few thousand calls blow the 500 MB cap — and
 * oldest-first eviction then targets precisely the clips belonging to the calls
 * still parked in the per-account concurrency queue. Those calls dial and play
 * nothing (`TTS_CLIP_UNUSABLE`) while still billing as connected.
 *
 * These tests pin the sweeper HALF of the fix. The SQL half (which non-terminal
 * rows hold a hash, including the `tts_audio_hash IS NULL` window) is
 * `StaticCallRepository.filterDeletableTtsHashes`, covered in
 * `test/unit/db/repositories/static-call-clip-refcount.test.ts` — production
 * registers that exact method through the seam exercised here.
 */

// Point the cache at an isolated temp dir BEFORE the module is loaded — the
// module resolves TTS_AUDIO_DIR from this env var at import time.
const TMP_DIR = vi.hoisted(() => {
  const base = process.env['TMPDIR'] || '/tmp';
  const dir = `${base.replace(/\/$/, '')}/tts-sweep-live-${process.pid}-${Date.now()}`;
  process.env['TTS_AUDIO_DIR'] = dir;
  return dir;
});

const logs = vi.hoisted(() => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock('@magick-agency/observability', () => ({
  logger: logs,
  createChildLogger: () => logs,
}));

const { sweepTtsCache, getTtsFilePath, setEvictableClipFilter } = await import(
  '../../../src/tts/tts-file-cache.js'
);

/** Write a `.wav` file of `bytes` length with the given mtime age (ms in the past). */
function writeClip(hash: string, bytes: number, ageMs: number): string {
  const filePath = getTtsFilePath(hash);
  fs.writeFileSync(filePath, Buffer.alloc(bytes));
  const mtime = new Date(Date.now() - ageMs);
  fs.utimesSync(filePath, mtime, mtime);
  return filePath;
}

/** Exactly what `tempFilePath` produces — `{hash}.wav.tmp-{pid}-{12 hex}`. */
function writeTemp(hash: string, bytes: number, ageMs: number, nonce = 'a1b2c3d4e5f6'): string {
  const filePath = `${TMP_DIR}/${hash}.wav.tmp-${process.pid}-${nonce}`;
  fs.writeFileSync(filePath, Buffer.alloc(bytes));
  const mtime = new Date(Date.now() - ageMs);
  fs.utimesSync(filePath, mtime, mtime);
  return filePath;
}

const hash = (c: string): string => c.repeat(40);
const exists = (h: string): boolean => fs.existsSync(getTtsFilePath(h));

const NEVER_BY_AGE = 86_400_000;
const NEVER_BY_SIZE = Number.MAX_SAFE_INTEGER;

/**
 * A filter that retains `held` and lets everything else go — the shape
 * `filterDeletableTtsHashes` has (it returns the hashes SAFE to unlink).
 */
function retaining(...held: string[]): (hashes: string[]) => Promise<string[]> {
  const live = new Set(held);
  return async (hashes) => hashes.filter((h) => !live.has(h));
}

describe('sweepTtsCache — clip liveness guard', () => {
  beforeEach(() => {
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
    fs.mkdirSync(TMP_DIR, { recursive: true });
    logs.warn.mockReset();
    logs.info.mockReset();
  });

  afterEach(() => {
    // Module-level seam: leaking a filter into the next test would silently
    // change what that test is measuring.
    setEvictableClipFilter(null);
  });

  afterAll(() => {
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
  });

  // ── Size path — the easy-to-trigger half of the incident ───────────

  it('retains a clip a non-terminal call still needs even when over the size cap', async () => {
    // The oldest clip is the one a queued call needs — exactly the ordering that
    // makes oldest-first eviction dangerous.
    writeClip(hash('1'), 1000, 30_000); // oldest, still needed
    writeClip(hash('2'), 1000, 20_000);
    writeClip(hash('3'), 1000, 10_000);
    setEvictableClipFilter(retaining(hash('1')));

    const result = await sweepTtsCache({ maxAgeMs: NEVER_BY_AGE, maxBytes: 2500 });

    expect(result).toEqual({ deleted: 0, freedBytes: 0 });
    expect(exists(hash('1'))).toBe(true);
    // The cap is a SOFT target under the guard: we stay over rather than take a
    // newer (i.e. likelier-still-live) clip to make up the deficit.
    expect(exists(hash('2'))).toBe(true);
    expect(exists(hash('3'))).toBe(true);
  });

  it('still evicts a clip referenced only by terminal calls', async () => {
    writeClip(hash('1'), 1000, 30_000); // oldest, dead
    writeClip(hash('2'), 1000, 20_000);
    setEvictableClipFilter(retaining()); // nothing held

    const result = await sweepTtsCache({ maxAgeMs: NEVER_BY_AGE, maxBytes: 1500 });

    expect(result).toEqual({ deleted: 1, freedBytes: 1000 });
    expect(exists(hash('1'))).toBe(false);
    expect(exists(hash('2'))).toBe(true);
  });

  it('evicts the dead victims and retains the live ones from the same victim set', async () => {
    writeClip(hash('1'), 1000, 40_000); // oldest — live
    writeClip(hash('2'), 1000, 30_000); // dead
    writeClip(hash('3'), 1000, 20_000); // newest — never a victim
    setEvictableClipFilter(retaining(hash('1')));

    // 3000 bytes, cap 1000 → victims are the two oldest; only one may go.
    const result = await sweepTtsCache({ maxAgeMs: NEVER_BY_AGE, maxBytes: 1000 });

    expect(result).toEqual({ deleted: 1, freedBytes: 1000 });
    expect(exists(hash('1'))).toBe(true);
    expect(exists(hash('2'))).toBe(false);
    expect(exists(hash('3'))).toBe(true);
  });

  // ── Age path — the hazard that was already documented ──────────────

  it('retains an age-expired clip a non-terminal call still needs', async () => {
    // A call parked in the account queue past the 6 h TTL: the row is live, the
    // clip is "old", and unlinking it puts the callee on a silent billed line.
    writeClip(hash('a'), 100, 90_000);
    writeClip(hash('b'), 100, 90_000);
    setEvictableClipFilter(retaining(hash('a')));

    const result = await sweepTtsCache({ maxAgeMs: 30_000, maxBytes: NEVER_BY_SIZE });

    expect(result).toEqual({ deleted: 1, freedBytes: 100 });
    expect(exists(hash('a'))).toBe(true);
    expect(exists(hash('b'))).toBe(false);
  });

  it('retains a hash held only by the NULL-tts_audio_hash window', async () => {
    // `filterDeletableTtsHashes` also withholds a hash when a non-terminal row
    // for the same announcement has `tts_audio_hash IS NULL` (enqueue parks the
    // call before the hash is written). The sweeper cannot distinguish the two
    // reasons and must not try — it honours the verdict either way.
    writeClip(hash('a'), 100, 90_000);
    setEvictableClipFilter(async () => []); // withheld, no reason given

    const result = await sweepTtsCache({ maxAgeMs: 30_000, maxBytes: NEVER_BY_SIZE });

    expect(result).toEqual({ deleted: 0, freedBytes: 0 });
    expect(exists(hash('a'))).toBe(true);
  });

  // ── One query, both paths, distinct hashes ─────────────────────────

  it('asks once for the combined age + size victim set, never per hash', async () => {
    writeClip(hash('a'), 1000, 90_000); // expired by age
    writeClip(hash('m'), 2000, 5_000); // fresh, pushes over the cap
    writeClip(hash('n'), 2000, 1_000); // fresh, newest
    const filter = vi.fn(async (hashes: string[]) => hashes);
    setEvictableClipFilter(filter);

    await sweepTtsCache({ maxAgeMs: 30_000, maxBytes: 3000 });

    expect(filter).toHaveBeenCalledTimes(1);
    expect([...(filter.mock.calls[0]![0] as string[])].sort()).toEqual([hash('a'), hash('m')].sort());
  });

  it('does not consult the filter at all when nothing would be evicted', async () => {
    writeClip(hash('a'), 100, 1_000);
    const filter = vi.fn(async (hashes: string[]) => hashes);
    setEvictableClipFilter(filter);

    await sweepTtsCache({ maxAgeMs: NEVER_BY_AGE, maxBytes: NEVER_BY_SIZE });

    expect(filter).not.toHaveBeenCalled();
  });

  // ── Failure modes: skip eviction, never throw, never delete ────────

  it('skips eviction and warns when the liveness query fails', async () => {
    writeClip(hash('a'), 1000, 90_000); // expired
    writeClip(hash('1'), 1000, 30_000);
    writeClip(hash('2'), 1000, 20_000);
    setEvictableClipFilter(async () => { throw new Error('db down'); });

    const result = await sweepTtsCache({ maxAgeMs: 30_000, maxBytes: 1500 });

    // Nothing deleted — deleting unguarded is the failure the guard prevents.
    expect(result).toEqual({ deleted: 0, freedBytes: 0 });
    expect(exists(hash('a'))).toBe(true);
    expect(exists(hash('1'))).toBe(true);
    expect(exists(hash('2'))).toBe(true);
    expect(logs.warn).toHaveBeenCalledTimes(1);
    expect(logs.warn.mock.calls[0]?.[1]).toContain('skipping eviction this cycle');
  });

  it('does not reject when the filter throws synchronously', async () => {
    writeClip(hash('a'), 100, 90_000);
    setEvictableClipFilter((() => { throw new Error('sync boom'); }) as never);

    await expect(sweepTtsCache({ maxAgeMs: 30_000, maxBytes: NEVER_BY_SIZE }))
      .resolves.toEqual({ deleted: 0, freedBytes: 0 });
    expect(exists(hash('a'))).toBe(true);
  });

  it('does not reject when the filter returns a rejected promise', async () => {
    writeClip(hash('a'), 100, 90_000);
    setEvictableClipFilter(() => Promise.reject(new Error('pool exhausted')));

    await expect(sweepTtsCache({ maxAgeMs: 30_000, maxBytes: NEVER_BY_SIZE }))
      .resolves.toEqual({ deleted: 0, freedBytes: 0 });
    expect(exists(hash('a'))).toBe(true);
  });

  it('skips eviction when the liveness query exceeds its timeout', async () => {
    // The startup sweep is awaited before `drainQueue()`, so an unbounded query
    // here would hang boot. A stall must degrade to "keep the clip".
    writeClip(hash('a'), 100, 90_000);
    setEvictableClipFilter(() => new Promise<string[]>(() => { /* never settles */ }));

    const result = await sweepTtsCache({
      maxAgeMs: 30_000,
      maxBytes: NEVER_BY_SIZE,
      livenessTimeoutMs: 20,
    });

    expect(result).toEqual({ deleted: 0, freedBytes: 0 });
    expect(exists(hash('a'))).toBe(true);
    expect(logs.warn).toHaveBeenCalledTimes(1);
    expect(String(logs.warn.mock.calls[0]?.[0]?.err)).toContain('timed out');
  });

  it('a late rejection from a timed-out query does not surface as unhandled', async () => {
    writeClip(hash('a'), 100, 90_000);
    setEvictableClipFilter(
      () => new Promise<string[]>((_r, reject) => setTimeout(() => reject(new Error('late')), 30)),
    );

    await sweepTtsCache({ maxAgeMs: 30_000, maxBytes: NEVER_BY_SIZE, livenessTimeoutMs: 5 });
    // Give the underlying promise time to reject after the race has settled.
    await new Promise((r) => setTimeout(r, 60));

    expect(exists(hash('a'))).toBe(true);
  });

  // ── Temp reaping is not a clip and is not guarded ──────────────────

  it('still reaps stale scratch files when the liveness query fails', async () => {
    const tmp = writeTemp(hash('t'), 500, 7_200_000); // 2h old
    writeClip(hash('a'), 100, 90_000);
    setEvictableClipFilter(async () => { throw new Error('db down'); });

    const result = await sweepTtsCache({
      maxAgeMs: 30_000,
      maxBytes: NEVER_BY_SIZE,
      tempReapMinAgeMs: 3_600_000,
    });

    // The clip is retained (guard failed) but the scratch file is gone.
    expect(fs.existsSync(tmp)).toBe(false);
    expect(exists(hash('a'))).toBe(true);
    expect(result).toEqual({ deleted: 0, freedBytes: 0 });
  });

  it('never offers a scratch file to the liveness filter', async () => {
    writeTemp(hash('t'), 500, 7_200_000);
    writeClip(hash('a'), 100, 90_000);
    const filter = vi.fn(async (hashes: string[]) => hashes);
    setEvictableClipFilter(filter);

    await sweepTtsCache({
      maxAgeMs: 30_000,
      maxBytes: NEVER_BY_SIZE,
      tempReapMinAgeMs: 3_600_000,
    });

    expect(filter).toHaveBeenCalledTimes(1);
    expect(filter.mock.calls[0]![0]).toEqual([hash('a')]);
  });

  // ── Single-flight still holds ──────────────────────────────────────

  it('coalesces concurrent sweeps into ONE run and one liveness query', async () => {
    writeClip(hash('a'), 100, 90_000);
    const filter = vi.fn(
      (hashes: string[]) => new Promise<string[]>((r) => setTimeout(() => r(hashes), 5)),
    );
    setEvictableClipFilter(filter);

    const p1 = sweepTtsCache({ maxAgeMs: 30_000, maxBytes: NEVER_BY_SIZE });
    const p2 = sweepTtsCache({ maxAgeMs: 30_000, maxBytes: NEVER_BY_SIZE });

    expect(p2).toBe(p1); // joined the in-flight run

    const [r1, r2] = await Promise.all([p1, p2]);

    // One query, one delete — not double-counted, and no racing unlinks.
    expect(filter).toHaveBeenCalledTimes(1);
    expect(r1).toEqual({ deleted: 1, freedBytes: 100 });
    expect(r2).toEqual(r1);
  });

  // The joiner warn sits in `sweepTtsCache` itself, OUTSIDE `runSweep`'s
  // try/catch. A throw there would leave this function throwing SYNCHRONOUSLY
  // rather than returning a rejected promise, so `src/index.ts`'s
  // `.then(onOk, onErr)` would never be attached and the interval's
  // `void sweepTts()` would become an uncaught exception — which exits a replica
  // carrying live calls, over a cache-cleanup nicety.
  it('returns a promise (never throws synchronously) when the joiner log fails', async () => {
    writeClip(hash('a'), 100, 90_000);
    setEvictableClipFilter(
      (hashes) => new Promise<string[]>((r) => setTimeout(() => r(hashes), 5)),
    );

    const first = sweepTtsCache({ maxAgeMs: 30_000, maxBytes: NEVER_BY_SIZE });
    logs.warn.mockImplementationOnce(() => { throw new Error('transport closed'); });

    let joined: Promise<unknown> | undefined;
    expect(() => { joined = sweepTtsCache({ maxAgeMs: 30_000, maxBytes: NEVER_BY_SIZE }); })
      .not.toThrow();

    // Still the in-flight run, and it still settles normally for both callers.
    expect(joined).toBe(first);
    await expect(joined!).resolves.toEqual({ deleted: 1, freedBytes: 100 });
    await expect(first).resolves.toEqual({ deleted: 1, freedBytes: 100 });
  });

  it('releases the single-flight slot even when the liveness query fails', async () => {
    writeClip(hash('a'), 100, 90_000);
    setEvictableClipFilter(async () => { throw new Error('db down'); });

    const first = await sweepTtsCache({ maxAgeMs: 30_000, maxBytes: NEVER_BY_SIZE });
    expect(first).toEqual({ deleted: 0, freedBytes: 0 });

    // A wedged slot would make every later tick a silent no-op; the next sweep
    // must run for real and, with the query healthy again, actually evict.
    setEvictableClipFilter(retaining());
    await expect(sweepTtsCache({ maxAgeMs: 30_000, maxBytes: NEVER_BY_SIZE }))
      .resolves.toEqual({ deleted: 1, freedBytes: 100 });
  });

  // ── Unregistered seam = pre-existing behaviour ─────────────────────

  it('evicts unguarded when no filter is registered', async () => {
    writeClip(hash('a'), 100, 90_000);
    setEvictableClipFilter(null);

    const result = await sweepTtsCache({ maxAgeMs: 30_000, maxBytes: NEVER_BY_SIZE });

    expect(result).toEqual({ deleted: 1, freedBytes: 100 });
    expect(exists(hash('a'))).toBe(false);
  });
});
