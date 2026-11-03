import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { ChildSupervisor } from '../../../src/cluster/child-supervisor.js';

const metrics = vi.hoisted(() => ({ trackChildExit: vi.fn() }));
vi.mock('@magick-agency/observability/metrics/voice', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@magick-agency/observability/metrics/voice')>()),
  trackChildExit: metrics.trackChildExit,
}));

/*
 * The primary's per-role supervisor (docs/scaling.md §6.1–6.2) against fake child
 * processes: ready gating, restart after an unexpected exit (with the exit handler awaited
 * first: a media slot's reap runs there), the crash-loop limit, and stop within a grace.
 */
let nextPid = 1000;

class FakeChild extends EventEmitter {
  connected = true;
  readonly pid = nextPid++;
  readonly sent: unknown[] = [];
  answerShutdown = true;
  /** How it exits once asked to shut down: cleanly by default, or as a crash mid-stop. */
  shutdownExit: [number | null, NodeJS.Signals | null] = [0, null];
  constructor(readonly slot: number) { super(); }
  send(message: unknown, ...rest: unknown[]): boolean {
    this.sent.push(message);
    const cb = rest.find((r) => typeof r === 'function') as ((e: Error | null) => void) | undefined;
    cb?.(null);
    const m = message as { kind?: string; type?: string; id?: number };
    if (m.kind === 'req' && m.type === 'shutdown' && this.answerShutdown) {
      setImmediate(() => this.exit(...this.shutdownExit));
    }
    return true;
  }
  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    setImmediate(() => this.exit(null, signal));
    return true;
  }
  ready(slot = this.slot): void {
    this.emit('message', { v: 1, kind: 'event', type: 'ready', body: { role: 'media', slot, pid: this.pid } });
  }
  exit(code: number | null, signal: NodeJS.Signals | null): void {
    if (!this.connected) return;
    this.connected = false;
    this.emit('disconnect');
    this.emit('exit', code, signal);
  }
}

function harness(opts: Partial<ConstructorParameters<typeof ChildSupervisor>[0]> = {}) {
  const forks: FakeChild[] = [];
  const sup = new ChildSupervisor({
    role: 'media',
    count: 2,
    fork: (slot) => {
      const c = new FakeChild(slot);
      forks.push(c);
      setImmediate(() => c.ready());
      return c as unknown as ChildProcess;
    },
    restartBackoffMs: [5],
    readyTimeoutMs: 1_000,
    ...opts,
  });
  return { sup, forks };
}

const until = async (check: () => boolean, ms = 2_000): Promise<void> => {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
};

describe('ChildSupervisor', () => {
  it('start forks every slot and resolves once each says ready; a ready for the wrong slot does not count', async () => {
    const forks: FakeChild[] = [];
    const sup = new ChildSupervisor({
      role: 'media', count: 2, readyTimeoutMs: 200,
      fork: (slot) => {
        const c = new FakeChild(slot);
        forks.push(c);
        setImmediate(() => c.ready(slot === 1 ? 0 : slot)); // slot 1 announces the wrong slot
        return c as unknown as ChildProcess;
      },
    });
    await expect(sup.start()).rejects.toThrow(/media worker 1 not ready/);
    expect(sup.isReady(0)).toBe(true);
    expect(sup.isReady(1)).toBe(false);
    await sup.stop(100);
  });

  it('an unexpected exit runs the exit handler to completion, then re-forks the slot', async () => {
    const order: string[] = [];
    const { sup, forks } = harness({
      onExit: async (e) => {
        order.push(`exit:${e.slot}:${e.signal}`);
        await new Promise((r) => setTimeout(r, 20));
        order.push('reaped');
      },
    });
    await sup.start();
    forks[0]!.exit(null, 'SIGKILL');
    expect(sup.isReady(0)).toBe(false);
    expect(sup.channel(0)).toBeNull();
    await until(() => forks.length === 3 && sup.isReady(0));
    order.push('reforked');
    expect(order).toEqual(['exit:0:SIGKILL', 'reaped', 'reforked']);
    expect(sup.pidOf(0)).toBe(forks[2]!.pid);
    await sup.stop(100);
  });

  it('stop waits for a crash reap already running before it resolves (the pool must outlive it)', async () => {
    let finishReap!: () => void;
    const order: string[] = [];
    const { sup, forks } = harness({
      onExit: () => new Promise<void>((resolve) => {
        order.push('reap started');
        finishReap = () => { order.push('reap done'); resolve(); };
      }),
    });
    await sup.start();
    forks[0]!.exit(null, 'SIGKILL');
    await until(() => order.includes('reap started'));
    const stopped = sup.stop(100).then(() => order.push('stopped'));
    await new Promise((r) => setTimeout(r, 30));
    expect(order).toEqual(['reap started']);
    finishReap();
    await stopped;
    expect(order).toEqual(['reap started', 'reap done', 'stopped']);
  });

  it('more exits of one slot than the crash-loop limit stops re-forking and reports it', async () => {
    const onCrashLoop = vi.fn();
    const { sup, forks } = harness({ crashLoop: { max: 2, onCrashLoop } });
    await sup.start();
    for (let i = 0; i < 3; i++) {
      const current = forks.filter((f) => f.slot === 0).at(-1)!;
      await until(() => sup.isReady(0));
      current.exit(1, null);
      if (i < 2) await until(() => forks.filter((f) => f.slot === 0).length === i + 2);
    }
    await until(() => onCrashLoop.mock.calls.length === 1);
    expect(onCrashLoop).toHaveBeenCalledWith(0);
    await new Promise((r) => setTimeout(r, 30));
    expect(forks.filter((f) => f.slot === 0)).toHaveLength(3); // no fourth
    await sup.stop(100);
  });

  it('stop asks each child to shut down and waits; one that does not exit in its grace is killed', async () => {
    let reaped = false;
    const exitHandler = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 20));
      reaped = true;
    });
    const { sup, forks } = harness({ onExit: exitHandler });
    await sup.start();
    forks[1]!.answerShutdown = false;
    const started = Date.now();
    await sup.stop(50);
    expect(Date.now() - started).toBeGreaterThanOrEqual(45);
    expect(forks[0]!.sent.some((m) => (m as { type?: string }).type === 'shutdown')).toBe(true);
    expect(forks.every((f) => !f.connected)).toBe(true);
    // The child that exited in its grace closed its own work: no exit handling for it. The
    // one that had to be killed did not, so its exit is handled like a crash (a media
    // slot's reap), and the stop resolves only once that is done.
    expect(exitHandler).toHaveBeenCalledTimes(1);
    expect(exitHandler).toHaveBeenCalledWith(expect.objectContaining({ slot: 1, signal: 'SIGKILL', expected: false }));
    expect(reaped).toBe(true);
    expect(forks).toHaveLength(2); // nothing restarted during a stop
  });

  it('a child that crashes during the stop (a signal or a non-zero code) is a crash: counted unexpected and reaped, not restarted', async () => {
    metrics.trackChildExit.mockClear();
    const reaped: Array<{ slot: number; code: number | null; signal: string | null }> = [];
    const { sup, forks } = harness({
      count: 3,
      onExit: async (e) => {
        await new Promise((r) => setTimeout(r, 20));
        reaped.push({ slot: e.slot, code: e.code, signal: e.signal });
      },
    });
    await sup.start();
    forks[0]!.shutdownExit = [null, 'SIGSEGV']; // dies of a signal after the stop began
    forks[1]!.shutdownExit = [1, null]; // an uncaught throw / OOM abort: non-zero code
    await sup.stop(500);
    // Both reaps ran (their slots' leases, attempts and agents) before the stop resolved.
    expect(reaped.sort((a, b) => a.slot - b.slot)).toEqual([
      { slot: 0, code: null, signal: 'SIGSEGV' },
      { slot: 1, code: 1, signal: null },
    ]);
    // Slot 2 finished its own shutdown (code 0): expected, no reap.
    expect(metrics.trackChildExit.mock.calls.sort()).toEqual([['media', false], ['media', false], ['media', true]]);
    expect(forks).toHaveLength(3); // nothing restarted during a stop
  });

  it('broadcast reaches only ready slots, except the one named', async () => {
    const { sup, forks } = harness();
    await sup.start();
    expect(sup.broadcast('analysis.wake', {}, 0)).toBe(1);
    expect(forks[1]!.sent.some((m) => (m as { type?: string }).type === 'analysis.wake')).toBe(true);
    expect(forks[0]!.sent.some((m) => (m as { type?: string }).type === 'analysis.wake')).toBe(false);
    await sup.stop(100);
  });
});
