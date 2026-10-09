// PORT NOTE (magick-agency): ported from magic-voice-core/test/unit/tts/tts-cache-sweep.test.ts@4850d1d9.
// Only changes: logger mock specifier -> @magick-agency/observability.
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import fs from 'node:fs';

// Point the cache at an isolated temp dir BEFORE the module is loaded — the
// module resolves TTS_AUDIO_DIR from this env var at import time.
const TMP_DIR = vi.hoisted(() => {
  const base = process.env['TMPDIR'] || '/tmp';
  const dir = `${base.replace(/\/$/, '')}/tts-sweep-${process.pid}-${Date.now()}`;
  process.env['TTS_AUDIO_DIR'] = dir;
  return dir;
});

/**
 * Instrumented `fs/promises`, wrapping the REAL implementation.
 *
 * Two things need a seam the real module cannot give us: the in-flight counter
 * (to prove the concurrency bound actually bounds) and per-path fault injection
 * (ENOENT from a racing deleter, EACCES from an unreadable file). Everything
 * else runs against the real filesystem, so the tests still exercise real
 * `stat`/`unlink`/`readdir` semantics rather than a hand-rolled fake.
 */
const io = vi.hoisted(() => ({
  inFlight: 0,
  maxInFlight: 0,
  statCalls: 0,
  unlinkCalls: 0,
  readdirCalls: 0,
  /** Artificial latency per stat, to widen the window the bound is measured over. */
  statDelayMs: 0,
  /**
   * Faults are keyed PER OPERATION, not just per path.
   *
   * A single shared map looks tidier and is silently wrong: `stat` runs before
   * `unlink` on every path, so one map means a fault always fires on the stat and
   * the unlink is never reached. Both "unlink fails" tests below then passed
   * while exercising the stat `catch` — and the size-cap eviction `catch` had no
   * coverage at all, because a stat that throws never reaches `survivors`.
   */
  statFaults: new Map<string, NodeJS.ErrnoException>(),
  unlinkFaults: new Map<string, NodeJS.ErrnoException>(),
  readdirFaults: new Map<string, NodeJS.ErrnoException>(),
  reset(): void {
    this.inFlight = 0;
    this.maxInFlight = 0;
    this.statCalls = 0;
    this.unlinkCalls = 0;
    this.readdirCalls = 0;
    this.statDelayMs = 0;
    this.statFaults.clear();
    this.unlinkFaults.clear();
    this.readdirFaults.clear();
  },
}));

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');

  const track = async <T>(run: () => Promise<T>): Promise<T> => {
    io.inFlight++;
    io.maxInFlight = Math.max(io.maxInFlight, io.inFlight);
    try {
      return await run();
    } finally {
      io.inFlight--;
    }
  };

  const mocked = {
    ...actual,
    readdir: (async (p: never, ...rest: never[]) => {
      io.readdirCalls++;
      const f = io.readdirFaults.get(String(p));
      if (f) throw f;
      return track(() => (actual.readdir as never as (...a: unknown[]) => Promise<unknown>)(p, ...rest));
    }) as unknown as typeof actual.readdir,
    stat: (async (p: never, ...rest: never[]) => {
      io.statCalls++;
      return track(async () => {
        if (io.statDelayMs > 0) await new Promise((r) => setTimeout(r, io.statDelayMs));
        const f = io.statFaults.get(String(p));
        if (f) throw f;
        return (actual.stat as never as (...a: unknown[]) => Promise<unknown>)(p, ...rest);
      });
    }) as unknown as typeof actual.stat,
    unlink: (async (p: never, ...rest: never[]) => {
      io.unlinkCalls++;
      return track(async () => {
        const f = io.unlinkFaults.get(String(p));
        if (f) throw f;
        return (actual.unlink as never as (...a: unknown[]) => Promise<unknown>)(p, ...rest);
      });
    }) as unknown as typeof actual.unlink,
  };

  return { ...mocked, default: mocked };
});

const logs = vi.hoisted(() => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock('@magick-agency/observability', () => ({
  logger: logs,
  createChildLogger: () => logs,
}));

const { sweepTtsCache, getTtsFilePath } = await import('../../../src/tts/tts-file-cache.js');

/** Write a `.wav` file of `bytes` length with the given mtime age (ms in the past). */
function writeClip(hash: string, bytes: number, ageMs: number): string {
  const filePath = getTtsFilePath(hash);
  fs.writeFileSync(filePath, Buffer.alloc(bytes));
  const mtime = new Date(Date.now() - ageMs);
  fs.utimesSync(filePath, mtime, mtime);
  return filePath;
}

/**
 * Write a scratch file matching exactly what `tempFilePath` produces —
 * `{hash}.wav.tmp-{pid}-{12 hex}`. The suffix deliberately does not end in
 * `.wav`, which is the property several tests below pin.
 */
function writeTemp(hash: string, bytes: number, ageMs: number, nonce = 'a1b2c3d4e5f6'): string {
  const filePath = `${TMP_DIR}/${hash}.wav.tmp-${process.pid}-${nonce}`;
  fs.writeFileSync(filePath, Buffer.alloc(bytes));
  const mtime = new Date(Date.now() - ageMs);
  fs.utimesSync(filePath, mtime, mtime);
  return filePath;
}

const hash = (c: string): string => c.repeat(40);

function resetDir(): void {
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
  fs.mkdirSync(TMP_DIR, { recursive: true });
}

const NEVER_BY_AGE = 86_400_000;
const NEVER_BY_SIZE = Number.MAX_SAFE_INTEGER;

describe('sweepTtsCache', () => {
  beforeEach(() => {
    resetDir();
    io.reset();
    logs.warn.mockReset();
    logs.info.mockReset();
  });

  afterAll(() => {
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
  });

  // ── Age sweep ──────────────────────────────────────────────────────

  it('deletes clips older than maxAgeMs and keeps fresh ones', async () => {
    writeClip(hash('a'), 100, 60_000); // 60s old
    writeClip(hash('b'), 100, 1_000); // 1s old

    const result = await sweepTtsCache({ maxAgeMs: 30_000, maxBytes: NEVER_BY_SIZE });

    expect(result.deleted).toBe(1);
    expect(result.freedBytes).toBe(100);
    expect(fs.existsSync(getTtsFilePath(hash('a')))).toBe(false);
    expect(fs.existsSync(getTtsFilePath(hash('b')))).toBe(true);
  });

  it('treats maxAgeMs as strictly-greater — a clip exactly at the boundary survives', async () => {
    writeClip(hash('e'), 100, 0); // mtime = now

    const result = await sweepTtsCache({ maxAgeMs: NEVER_BY_AGE, maxBytes: NEVER_BY_SIZE });

    expect(result.deleted).toBe(0);
    expect(fs.existsSync(getTtsFilePath(hash('e')))).toBe(true);
  });

  // ── Size cap ───────────────────────────────────────────────────────

  it('evicts oldest-first when total size exceeds maxBytes', async () => {
    // Three 1000-byte clips, distinct ages. Cap at 2500 → oldest must go.
    writeClip(hash('1'), 1000, 30_000); // oldest
    writeClip(hash('2'), 1000, 20_000);
    writeClip(hash('3'), 1000, 10_000); // newest

    // maxAgeMs huge so age never triggers; only the size cap acts.
    const result = await sweepTtsCache({ maxAgeMs: NEVER_BY_AGE, maxBytes: 2500 });

    expect(result.deleted).toBe(1);
    expect(result.freedBytes).toBe(1000);
    expect(fs.existsSync(getTtsFilePath(hash('1')))).toBe(false); // oldest evicted
    expect(fs.existsSync(getTtsFilePath(hash('2')))).toBe(true);
    expect(fs.existsSync(getTtsFilePath(hash('3')))).toBe(true);
  });

  it('does not evict when the total sits exactly on maxBytes', async () => {
    writeClip(hash('1'), 1000, 30_000);
    writeClip(hash('2'), 1000, 20_000);

    const result = await sweepTtsCache({ maxAgeMs: NEVER_BY_AGE, maxBytes: 2000 });

    expect(result.deleted).toBe(0);
    expect(io.unlinkCalls).toBe(0);
  });

  it('evicts as many as needed to get under the cap, not just one', async () => {
    for (let i = 0; i < 5; i++) writeClip(hash(String(i)), 1000, 50_000 - i * 1000);

    // 5000 bytes total, cap 1500 → must drop the four oldest.
    const result = await sweepTtsCache({ maxAgeMs: NEVER_BY_AGE, maxBytes: 1500 });

    expect(result.deleted).toBe(4);
    expect(result.freedBytes).toBe(4000);
    expect(fs.existsSync(getTtsFilePath(hash('4')))).toBe(true); // newest survives
  });

  it('combines age sweep then size cap', async () => {
    writeClip(hash('o'), 1000, 90_000); // expired by age
    writeClip(hash('m'), 2000, 5_000); // fresh, but pushes over cap
    writeClip(hash('n'), 2000, 1_000); // fresh, newest

    // Age sweep removes the 90s clip; survivors total 4000 > 3000 → evict oldest survivor.
    const result = await sweepTtsCache({ maxAgeMs: 30_000, maxBytes: 3000 });

    expect(result.deleted).toBe(2);
    expect(result.freedBytes).toBe(3000);
    expect(fs.existsSync(getTtsFilePath(hash('o')))).toBe(false);
    expect(fs.existsSync(getTtsFilePath(hash('m')))).toBe(false);
    expect(fs.existsSync(getTtsFilePath(hash('n')))).toBe(true);
  });

  // ── What is and isn't a clip ───────────────────────────────────────

  it('ignores non-wav files', async () => {
    fs.writeFileSync(`${TMP_DIR}/keep.txt`, Buffer.alloc(10));
    writeClip(hash('w'), 100, 90_000);

    const result = await sweepTtsCache({ maxAgeMs: 30_000, maxBytes: NEVER_BY_SIZE });

    expect(result.deleted).toBe(1);
    expect(fs.existsSync(`${TMP_DIR}/keep.txt`)).toBe(true);
  });

  it('skips a DIRECTORY named like a clip rather than trying to unlink it', async () => {
    fs.mkdirSync(`${TMP_DIR}/${hash('d')}.wav`);
    const old = new Date(Date.now() - 90_000);
    fs.utimesSync(`${TMP_DIR}/${hash('d')}.wav`, old, old);

    const result = await sweepTtsCache({ maxAgeMs: 30_000, maxBytes: NEVER_BY_SIZE });

    expect(result.deleted).toBe(0);
    expect(fs.existsSync(`${TMP_DIR}/${hash('d')}.wav`)).toBe(true);
    expect(io.unlinkCalls).toBe(0);
  });

  // ── Scratch-file reaping ───────────────────────────────────────────

  it('reaps an orphaned scratch file older than tempReapMinAgeMs', async () => {
    const tmp = writeTemp(hash('t'), 500, 7_200_000); // 2h old

    const result = await sweepTtsCache({
      maxAgeMs: NEVER_BY_AGE,
      maxBytes: NEVER_BY_SIZE,
      tempReapMinAgeMs: 3_600_000,
    });

    expect(fs.existsSync(tmp)).toBe(false);
    // Reaped temps are deliberately NOT counted as evicted clips.
    expect(result).toEqual({ deleted: 0, freedBytes: 0 });
  });

  it('leaves a FRESH scratch file alone — it may be an in-flight write by another replica', async () => {
    const tmp = writeTemp(hash('t'), 500, 60_000); // 1 min old

    await sweepTtsCache({
      maxAgeMs: NEVER_BY_AGE,
      maxBytes: NEVER_BY_SIZE,
      tempReapMinAgeMs: 3_600_000,
    });

    expect(fs.existsSync(tmp)).toBe(true);
  });

  it('never counts a scratch file toward the size cap', async () => {
    // A huge fresh temp must not push real clips over the cap and evict them.
    writeTemp(hash('t'), 10_000, 60_000);
    writeClip(hash('c'), 100, 10_000);

    const result = await sweepTtsCache({
      maxAgeMs: NEVER_BY_AGE,
      maxBytes: 1000,
      tempReapMinAgeMs: 3_600_000,
    });

    expect(result.deleted).toBe(0);
    expect(fs.existsSync(getTtsFilePath(hash('c')))).toBe(true);
  });

  it('never evicts a scratch file as if it were an aged-out clip', async () => {
    // Old enough to blow the CLIP age limit, but young enough for the temp gate.
    const tmp = writeTemp(hash('t'), 500, 120_000);

    await sweepTtsCache({
      maxAgeMs: 30_000,
      maxBytes: NEVER_BY_SIZE,
      tempReapMinAgeMs: 3_600_000,
    });

    expect(fs.existsSync(tmp)).toBe(true);
  });

  it('reaps several scratch files and still reports only clip evictions', async () => {
    writeTemp(hash('t'), 500, 7_200_000, 'aaaaaaaaaaaa');
    writeTemp(hash('u'), 500, 7_200_000, 'bbbbbbbbbbbb');
    writeClip(hash('c'), 100, 90_000);

    const result = await sweepTtsCache({
      maxAgeMs: 30_000,
      maxBytes: NEVER_BY_SIZE,
      tempReapMinAgeMs: 3_600_000,
    });

    expect(result).toEqual({ deleted: 1, freedBytes: 100 });
    expect(fs.readdirSync(TMP_DIR)).toEqual([]);
  });

  // ── Empty / missing directory ──────────────────────────────────────

  it('no-ops cleanly on an empty dir', async () => {
    const result = await sweepTtsCache({ maxAgeMs: 1000, maxBytes: 1000 });
    expect(result).toEqual({ deleted: 0, freedBytes: 0 });
  });

  it('no-ops (and does not reject) when the dir does not exist', async () => {
    fs.rmSync(TMP_DIR, { recursive: true, force: true });

    await expect(sweepTtsCache()).resolves.toEqual({ deleted: 0, freedBytes: 0 });
    // A missing dir is expected, not a fault — it must not warn.
    expect(logs.warn).not.toHaveBeenCalled();
  });

  it('warns but does not reject when the dir is unreadable', async () => {
    const err: NodeJS.ErrnoException = Object.assign(new Error('EACCES'), { code: 'EACCES' });
    io.readdirFaults.set(TMP_DIR, err);

    await expect(sweepTtsCache()).resolves.toEqual({ deleted: 0, freedBytes: 0 });
    expect(logs.warn).toHaveBeenCalledTimes(1);
  });

  // ── Racing filesystem faults ───────────────────────────────────────

  it('tolerates a clip deleted between readdir and stat (ENOENT), silently', async () => {
    const doomed = writeClip(hash('x'), 100, 90_000);
    writeClip(hash('y'), 100, 90_000);
    io.statFaults.set(doomed, Object.assign(new Error('gone'), { code: 'ENOENT' }));

    const result = await sweepTtsCache({ maxAgeMs: 30_000, maxBytes: NEVER_BY_SIZE });

    // Only the surviving clip is counted; the racing one is ignored, not warned.
    expect(result).toEqual({ deleted: 1, freedBytes: 100 });
    expect(logs.warn).not.toHaveBeenCalled();
  });

  it('warns and continues when one clip stats with a non-ENOENT error', async () => {
    const bad = writeClip(hash('x'), 100, 90_000);
    writeClip(hash('y'), 100, 90_000);
    io.statFaults.set(bad, Object.assign(new Error('EIO'), { code: 'EIO' }));

    const result = await sweepTtsCache({ maxAgeMs: 30_000, maxBytes: NEVER_BY_SIZE });

    // The bad file must not abort the sweep — the good one is still evicted.
    expect(result).toEqual({ deleted: 1, freedBytes: 100 });
    expect(logs.warn).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(bad)).toBe(true);
  });

  it('does not count a clip whose age-eviction unlink fails', async () => {
    const stubborn = writeClip(hash('x'), 100, 90_000);
    writeClip(hash('y'), 100, 90_000);
    // The stat succeeds, so the file IS classified expired and the unlink is
    // genuinely attempted — this exercises the age-pass unlink catch, which a
    // stat-side fault could never reach.
    io.unlinkFaults.set(stubborn, Object.assign(new Error('EPERM'), { code: 'EPERM' }));

    const result = await sweepTtsCache({ maxAgeMs: 30_000, maxBytes: NEVER_BY_SIZE });

    expect(io.unlinkCalls).toBe(2); // both attempted; one failed
    expect(result).toEqual({ deleted: 1, freedBytes: 100 });
    expect(logs.warn).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(stubborn)).toBe(true);
  });

  it('stays silent when an age-eviction unlink races a deleter (ENOENT)', async () => {
    const doomed = writeClip(hash('x'), 100, 90_000);
    io.unlinkFaults.set(doomed, Object.assign(new Error('gone'), { code: 'ENOENT' }));

    const result = await sweepTtsCache({ maxAgeMs: 30_000, maxBytes: NEVER_BY_SIZE });

    expect(io.unlinkCalls).toBe(1);
    expect(result).toEqual({ deleted: 0, freedBytes: 0 });
    expect(logs.warn).not.toHaveBeenCalled();
  });

  it('does not count a clip whose size-cap eviction races a deleter (ENOENT)', async () => {
    const doomed = writeClip(hash('1'), 1000, 30_000); // oldest → chosen as victim
    writeClip(hash('2'), 1000, 20_000);
    // Unlink-only fault: the stat must succeed or the file never reaches
    // `survivors`, the total stays under the cap, and the size-cap pass would
    // not run at all.
    io.unlinkFaults.set(doomed, Object.assign(new Error('gone'), { code: 'ENOENT' }));

    const result = await sweepTtsCache({ maxAgeMs: NEVER_BY_AGE, maxBytes: 1500 });

    expect(io.unlinkCalls).toBe(1); // the size-cap pass really did fire
    // Not counted (the unlink did not succeed), and ENOENT must stay silent.
    expect(result).toEqual({ deleted: 0, freedBytes: 0 });
    expect(logs.warn).not.toHaveBeenCalled();
  });

  it('warns when a size-cap eviction fails for a non-ENOENT reason', async () => {
    const stubborn = writeClip(hash('1'), 1000, 30_000);
    writeClip(hash('2'), 1000, 20_000);
    io.unlinkFaults.set(stubborn, Object.assign(new Error('EPERM'), { code: 'EPERM' }));

    const result = await sweepTtsCache({ maxAgeMs: NEVER_BY_AGE, maxBytes: 1500 });

    expect(result).toEqual({ deleted: 0, freedBytes: 0 });
    expect(logs.warn).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(stubborn)).toBe(true);
  });

  it('tolerates a scratch file renamed away before its stat (ENOENT), silently', async () => {
    const tmp = writeTemp(hash('t'), 500, 7_200_000);
    io.statFaults.set(tmp, Object.assign(new Error('gone'), { code: 'ENOENT' }));

    await expect(
      sweepTtsCache({ maxAgeMs: NEVER_BY_AGE, maxBytes: NEVER_BY_SIZE, tempReapMinAgeMs: 3_600_000 }),
    ).resolves.toEqual({ deleted: 0, freedBytes: 0 });
    expect(logs.warn).not.toHaveBeenCalled();
  });

  it('tolerates a scratch file renamed away between its stat and its unlink', async () => {
    const tmp = writeTemp(hash('t'), 500, 7_200_000);
    io.unlinkFaults.set(tmp, Object.assign(new Error('gone'), { code: 'ENOENT' }));

    await expect(
      sweepTtsCache({ maxAgeMs: NEVER_BY_AGE, maxBytes: NEVER_BY_SIZE, tempReapMinAgeMs: 3_600_000 }),
    ).resolves.toEqual({ deleted: 0, freedBytes: 0 });
    expect(io.unlinkCalls).toBe(1);
    expect(logs.warn).not.toHaveBeenCalled();
  });

  it('warns when a scratch reap fails for a non-ENOENT reason', async () => {
    const tmp = writeTemp(hash('t'), 500, 7_200_000);
    io.unlinkFaults.set(tmp, Object.assign(new Error('EPERM'), { code: 'EPERM' }));

    await sweepTtsCache({
      maxAgeMs: NEVER_BY_AGE,
      maxBytes: NEVER_BY_SIZE,
      tempReapMinAgeMs: 3_600_000,
    });

    expect(logs.warn).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(tmp)).toBe(true);
  });

  it('skips a DIRECTORY shaped like a scratch file rather than trying to unlink it', async () => {
    const dir = `${TMP_DIR}/${hash('t')}.wav.tmp-${process.pid}-a1b2c3d4e5f6`;
    fs.mkdirSync(dir);
    const past = new Date(Date.now() - 7_200_000);
    fs.utimesSync(dir, past, past);

    const result = await sweepTtsCache({
      maxAgeMs: NEVER_BY_AGE,
      maxBytes: NEVER_BY_SIZE,
      tempReapMinAgeMs: 3_600_000,
    });

    expect(fs.existsSync(dir)).toBe(true);
    expect(io.unlinkCalls).toBe(0);
    expect(result).toEqual({ deleted: 0, freedBytes: 0 });
  });

  // ── Bounded concurrency ────────────────────────────────────────────

  it('never exceeds the configured concurrency', async () => {
    for (let i = 0; i < 60; i++) writeClip(hash('a').slice(0, 38) + String(i).padStart(2, '0'), 10, 1_000);
    io.statDelayMs = 1; // widen the window so overlap is observable

    await sweepTtsCache({ maxAgeMs: NEVER_BY_AGE, maxBytes: NEVER_BY_SIZE, concurrency: 4 });

    expect(io.statCalls).toBe(60);
    expect(io.maxInFlight).toBeLessThanOrEqual(4);
    // Sanity: it really did run in parallel, so the bound is meaningful.
    expect(io.maxInFlight).toBeGreaterThan(1);
  });

  it('clamps a zero or negative concurrency to a single worker', async () => {
    for (let i = 0; i < 5; i++) writeClip(hash('a').slice(0, 39) + String(i), 10, 1_000);

    await sweepTtsCache({ maxAgeMs: NEVER_BY_AGE, maxBytes: NEVER_BY_SIZE, concurrency: 0 });

    expect(io.maxInFlight).toBe(1);
    expect(io.statCalls).toBe(5);
  });

  it('bounds the size-cap eviction pass too, not just the stat pass', async () => {
    for (let i = 0; i < 40; i++) writeClip(hash('a').slice(0, 38) + String(i).padStart(2, '0'), 100, 50_000 - i * 100);

    // 4000 bytes, cap 100 → 39 victims to unlink.
    await sweepTtsCache({ maxAgeMs: NEVER_BY_AGE, maxBytes: 100, concurrency: 3 });

    expect(io.unlinkCalls).toBe(39);
    expect(io.maxInFlight).toBeLessThanOrEqual(3);
  });

  // ── The actual regression this change exists to prevent ────────────

  it('yields to the event loop while sweeping (the synchronous version could not)', async () => {
    for (let i = 0; i < 120; i++) writeClip(hash('a').slice(0, 37) + String(i).padStart(3, '0'), 10, 1_000);
    io.statDelayMs = 1;

    let ticks = 0;
    const timer = setInterval(() => { ticks++; }, 1);
    try {
      await sweepTtsCache({ maxAgeMs: NEVER_BY_AGE, maxBytes: NEVER_BY_SIZE, concurrency: 8 });
    } finally {
      clearInterval(timer);
    }

    // The old readdirSync + statSync-per-entry loop blocked the loop end to end,
    // so this would have been exactly 0.
    expect(ticks).toBeGreaterThan(0);
  });

  // ── Single-flight ──────────────────────────────────────────────────

  it('coalesces concurrent sweeps into one run', async () => {
    writeClip(hash('a'), 100, 90_000);
    io.statDelayMs = 1;

    const p1 = sweepTtsCache({ maxAgeMs: 30_000, maxBytes: NEVER_BY_SIZE });
    const p2 = sweepTtsCache({ maxAgeMs: 30_000, maxBytes: NEVER_BY_SIZE });

    // Same promise object — the second caller joined the in-flight run.
    expect(p2).toBe(p1);

    const [r1, r2] = await Promise.all([p1, p2]);

    expect(io.readdirCalls).toBe(1);
    // Counted once, not twice — the double-count this guard exists to prevent.
    expect(r1).toEqual({ deleted: 1, freedBytes: 100 });
    expect(r2).toEqual(r1);
  });

  it('releases the single-flight slot so a later sweep runs fresh', async () => {
    writeClip(hash('a'), 100, 90_000);

    const first = sweepTtsCache({ maxAgeMs: 30_000, maxBytes: NEVER_BY_SIZE });
    await first;

    writeClip(hash('b'), 100, 90_000);
    const second = sweepTtsCache({ maxAgeMs: 30_000, maxBytes: NEVER_BY_SIZE });

    expect(second).not.toBe(first);
    await expect(second).resolves.toEqual({ deleted: 1, freedBytes: 100 });
    expect(io.readdirCalls).toBe(2);
  });

  it('serves a joiner the in-flight run, ignoring its own options (documented)', async () => {
    writeClip(hash('a'), 100, 90_000);
    io.statDelayMs = 1;

    const p1 = sweepTtsCache({ maxAgeMs: NEVER_BY_AGE, maxBytes: NEVER_BY_SIZE }); // deletes nothing
    const p2 = sweepTtsCache({ maxAgeMs: 1, maxBytes: NEVER_BY_SIZE }); // would delete everything

    await Promise.all([p1, p2]);

    // The joiner's aggressive maxAgeMs must not take effect.
    expect(fs.existsSync(getTtsFilePath(hash('a')))).toBe(true);
  });

  it('warns when a caller joins an in-flight sweep', async () => {
    writeClip(hash('a'), 100, 90_000);
    io.statDelayMs = 1;

    await Promise.all([
      sweepTtsCache({ maxAgeMs: 30_000, maxBytes: NEVER_BY_SIZE }),
      sweepTtsCache({ maxAgeMs: 30_000, maxBytes: NEVER_BY_SIZE }),
    ]);

    // A wedged sweep never releases the slot, and every later tick then silently
    // no-ops. The join warning is the only symptom, so it has to be emitted.
    expect(logs.warn).toHaveBeenCalledTimes(1);
    expect(logs.warn.mock.calls[0]?.[1]).toContain('joining the in-flight run');
  });

  // ── Contract: infallible promise ───────────────────────────────────

  it('resolves rather than rejecting when the logger itself throws, and frees the slot', async () => {
    writeClip(hash('a'), 100, 90_000);
    // The success log is the one statement outside every per-file try/catch.
    logs.info.mockImplementationOnce(() => { throw new Error('logger down'); });

    // Contract is "never rejects" — a fire-and-forget caller relies on it, and an
    // unhandled rejection would take the process down on Node >= 15.
    await expect(
      sweepTtsCache({ maxAgeMs: 30_000, maxBytes: NEVER_BY_SIZE }),
    ).resolves.toEqual({ deleted: 0, freedBytes: 0 });

    // The single-flight slot must still be released, or the sweeper is dead for
    // the lifetime of the process.
    writeClip(hash('b'), 100, 90_000);
    await expect(
      sweepTtsCache({ maxAgeMs: 30_000, maxBytes: NEVER_BY_SIZE }),
    ).resolves.toEqual({ deleted: 1, freedBytes: 100 });
  });

  // ── Deterministic ordering ─────────────────────────────────────────

  it('breaks mtime ties deterministically by path', async () => {
    const a = writeClip(hash('1'), 1000, 30_000);
    const b = writeClip(hash('2'), 1000, 30_000);
    // Force byte-identical mtimes. `survivors` is filled in stat-COMPLETION
    // order, so without the path tiebreak the victim would vary run to run.
    const mtime = new Date(Date.now() - 30_000);
    fs.utimesSync(a, mtime, mtime);
    fs.utimesSync(b, mtime, mtime);

    const result = await sweepTtsCache({ maxAgeMs: NEVER_BY_AGE, maxBytes: 1500 });

    expect(result.deleted).toBe(1);
    expect(fs.existsSync(a)).toBe(false); // '1…' sorts before '2…'
    expect(fs.existsSync(b)).toBe(true);
  });

  // ── Defaults ───────────────────────────────────────────────────────

  it('applies the documented defaults when called with no options', async () => {
    writeClip(hash('a'), 100, 7 * 3_600_000); // 7h old → past the 6h default TTL
    writeClip(hash('b'), 100, 60_000); // fresh

    const result = await sweepTtsCache();

    expect(result.deleted).toBe(1);
    expect(fs.existsSync(getTtsFilePath(hash('a')))).toBe(false);
    expect(fs.existsSync(getTtsFilePath(hash('b')))).toBe(true);
  });
});
