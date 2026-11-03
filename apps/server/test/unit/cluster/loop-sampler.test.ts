import { afterEach, describe, expect, it, vi } from 'vitest';
import { performance } from 'node:perf_hooks';
import { createLoopSampler, type LoopSampler } from '../../../src/cluster/loop-sampler.js';

/*
 * The loop sampler closes its window on its own timer; readers (`health.ping`, `/readyz?detail=1`)
 * read the last completed window and reset nothing. So two probers read the same numbers, and a
 * stall stays visible for a whole window however often anyone reads. Only the window timer is
 * faked: the loop itself (the stall, the delay histogram, ELU) is real.
 */
const STALL_MS = 80;
const spin = (ms: number): void => {
  const end = performance.now() + ms;
  while (performance.now() < end) { /* block the loop */ }
};
const turn = (ms = 10): Promise<void> => new Promise((r) => setTimeout(r, ms));
/** A stall the delay histogram sees: its timer must have fired once before the loop blocks. */
const stall = async (): Promise<void> => {
  await turn(10);
  spin(STALL_MS);
  await turn(20);
};
const refTimers = (): number => process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;

let sampler: LoopSampler | null = null;
afterEach(() => {
  sampler?.stop();
  sampler = null;
  vi.useRealTimers();
});

describe('createLoopSampler', () => {
  it('reads do not reset: every read of a window is the same, and a stall stays in it however often it is read', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    sampler = createLoopSampler({ windowMs: 1_000 });
    await stall();
    vi.advanceTimersByTime(1_000);

    const window = sampler.latest();
    expect(window.loopDelayP99Ms).toBeGreaterThanOrEqual(STALL_MS / 2);
    expect(window.elu).toBeGreaterThan(0.3);
    // Twenty probers in a row, the loop turning between them: all read the stall.
    for (let i = 0; i < 20; i++) {
      await turn(2);
      expect(sampler.latest()).toEqual(window);
    }
  });

  it('the window closes on the timer, not on a read: the next quiet window replaces the stall', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    sampler = createLoopSampler({ windowMs: 1_000 });
    await stall();
    vi.advanceTimersByTime(1_000);
    const stalled = sampler.latest();
    expect(stalled.loopDelayP99Ms).toBeGreaterThanOrEqual(STALL_MS / 2);

    await turn(10);
    // Still the stalled window until the timer closes the next one.
    expect(sampler.latest()).toEqual(stalled);
    vi.advanceTimersByTime(1_000);
    const quiet = sampler.latest();
    expect(quiet.loopDelayP99Ms).toBeLessThan(STALL_MS / 2);
    expect(quiet.elu).toBeLessThan(stalled.elu);
  });

  it('before the first window closes, reads see the partial window and do not reset it either', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    sampler = createLoopSampler({ windowMs: 1_000 });
    await stall();
    const a = sampler.latest();
    await turn(5);
    const b = sampler.latest();
    expect(a.loopDelayP99Ms).toBeGreaterThanOrEqual(STALL_MS / 2);
    expect(b.loopDelayP99Ms).toBeGreaterThanOrEqual(STALL_MS / 2);
  });

  it('stop() clears the window timer and freezes the reading', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    sampler = createLoopSampler({ windowMs: 1_000 });
    vi.advanceTimersByTime(1_000);
    expect(vi.getTimerCount()).toBe(1);
    sampler.stop();
    expect(vi.getTimerCount()).toBe(0);
    const frozen = sampler.latest();
    await stall();
    vi.advanceTimersByTime(5_000);
    expect(sampler.latest()).toEqual(frozen);
    sampler.stop(); // idempotent
  });

  it('the window timer never keeps the process alive (unref)', () => {
    const before = refTimers();
    sampler = createLoopSampler();
    expect(refTimers()).toBe(before);
  });
});
