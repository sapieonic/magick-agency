import { afterEach, describe, expect, it, vi } from 'vitest';
import { performance } from 'node:perf_hooks';
import { createLoopSampler, type LoopSampler } from '../../../src/cluster/loop-sampler.js';

/*
 * The loop sampler closes its window on its own timer; readers (`health.ping`, `/readyz?detail=1`)
 * read the last completed window and reset nothing. So two probers read the same numbers, and a
 * stall stays visible for a whole window however often anyone reads. Only the window timer is
 * faked: the loop itself (the stall, the delay histogram, ELU) is real.
 *
 * ── Deterministic under CPU load, by construction ───────────────────────────────────────
 *
 * The cases run in a full suite next to other workers, so the process is regularly descheduled.
 * Two things the loop does not otherwise guarantee are made explicit:
 *
 *  - **The histogram sees each stall.** `monitorEventLoopDelay` records the gap between two of
 *    its own 1 ms ticks, and its first tick only sets the baseline. `turn(10)` alone did not
 *    order the spin after a tick: when the process is descheduled past both deadlines, the
 *    10 ms timeout and the histogram's first tick expire in the same timers phase, the
 *    timeout's callback can run first, and the spin then runs before any tick (a stalled window
 *    read p99 ~1 ms). So each spin runs in a CHECK phase (`setImmediate`), after a timers phase
 *    in which the tick was due and has fired, and a timers phase follows each spin before the
 *    next.
 *  - **The quiet window is mostly idle.** ELU counts only time blocked in poll as idle. A
 *    ~10 ms quiet window under CPU starvation never reached poll with time left (the timeout had
 *    already expired) and read ELU 1, above the stalled window's. It is `QUIET_MS` of sleep.
 *    A longer quiet window holds more delay samples, so the stalled window carries
 *    `STALL_BURSTS` stall samples: more than 1% of both windows together, so a histogram NOT
 *    reset at the window close still puts the quiet window's p99 at the stall.
 */
const STALL_MS = 80;
const STALL_BURSTS = 6;
const QUIET_MS = 250;
const spin = (ms: number): void => {
  const end = performance.now() + ms;
  while (performance.now() < end) { /* block the loop */ }
};
const turn = (ms = 10): Promise<void> => new Promise((r) => setTimeout(r, ms));
const checkPhase = (): Promise<void> => new Promise((r) => setImmediate(r));
/**
 * `bursts` stalls the delay histogram records, each as one sample of at least `STALL_MS`.
 *
 * `turn(10)` ends in a timers phase whose loop time is at least 10 ms past the sampler's start,
 * so the histogram's 1 ms tick is due in that phase and fires in it. The spin runs in the same
 * iteration's check phase, after it. `turn(2)` then ends in a later timers phase, which the tick
 * (due before the spin ended) has also fired in, recording the spin.
 */
const stall = async (bursts = 1): Promise<void> => {
  await turn(10);
  for (let i = 0; i < bursts; i++) {
    await checkPhase();
    spin(STALL_MS);
    await turn(2);
  }
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
    await stall(STALL_BURSTS);
    vi.advanceTimersByTime(1_000);
    const stalled = sampler.latest();
    expect(stalled.loopDelayP99Ms).toBeGreaterThanOrEqual(STALL_MS / 2);

    await turn(10);
    // Still the stalled window until the timer closes the next one.
    expect(sampler.latest()).toEqual(stalled);
    await turn(QUIET_MS);
    vi.advanceTimersByTime(1_000);
    const quiet = sampler.latest();
    // The histogram was reset at the close: the stall samples are not in this window.
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
