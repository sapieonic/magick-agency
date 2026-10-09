// PORT NOTE (magick-agency): ported from magic-voice-core/test/unit/utils/decode-gate.test.ts@4850d1d9.
// Verbatim (relative paths unchanged; ../../../src/config/schema.js exports appConfigSchema).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// `decode-gate.ts` imports the real config module, whose loader calls
// `process.exit(1)` when required env vars are absent — which is the case in CI.
// Mock it to the one field the gate reads, matching the convention used by the
// other config-importing tests (see decode.test.ts). The value is mutable so a
// test can re-mock the limit and reset the singleton.
const mocks = vi.hoisted(() => ({ audio: { decodeConcurrency: 2 } as { decodeConcurrency?: unknown } }));
vi.mock('../../../src/config/index.js', () => ({
  config: { audio: mocks.audio },
}));

const { Semaphore, runExclusive, getDecodeGateStats, __resetDecodeGate } = await import(
  '../../../src/utils/decode-gate.js'
);

/** A manually-resolvable promise, for deterministic race control. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Let the microtask queue drain so queued acquires can settle. */
const tick = () => new Promise((r) => setTimeout(r, 0));

/**
 * Instrumented task factory: counts entries/exits and records the peak number
 * simultaneously inside `fn`. The peak is the assertion that actually matters —
 * a gate that let two tasks in at limit=1 would still finish, just wrongly.
 */
function makeTracker() {
  const state = { inFlight: 0, maxInFlight: 0, started: [] as number[], finished: [] as number[] };
  const wrap = <T>(id: number, body: () => Promise<T>) => async (): Promise<T> => {
    state.inFlight++;
    state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
    state.started.push(id);
    try {
      return await body();
    } finally {
      state.inFlight--;
      state.finished.push(id);
    }
  };
  return { state, wrap };
}

describe('Semaphore — concurrency ceiling', () => {
  it('never lets more than `limit` tasks run at once under a synchronous burst', async () => {
    // A synchronous burst is the dangerous shape: every caller evaluates its
    // acquire before any of them yields, so a check-then-increment that isn't
    // synchronous would let them all through.
    const sem = new Semaphore(3);
    const { state, wrap } = makeTracker();

    await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        sem.run(wrap(i, async () => {
          await new Promise((r) => setTimeout(r, 1));
          return i;
        })),
      ),
    );

    expect(state.maxInFlight).toBe(3);
    expect(state.finished).toHaveLength(50);
  });

  it('admits exactly one at a time when limit is 1', async () => {
    const sem = new Semaphore(1);
    const { state, wrap } = makeTracker();

    await Promise.all(
      Array.from({ length: 20 }, (_, i) => sem.run(wrap(i, async () => { await tick(); }))),
    );

    expect(state.maxInFlight).toBe(1);
  });

  it('holds the permit for the WHOLE task, not just until the first await', async () => {
    // Regression guard for a missing `await` before the `finally`: without it the
    // permit is released as soon as fn returns its promise, and the limit becomes
    // decorative.
    const sem = new Semaphore(1);
    const { state, wrap } = makeTracker();
    const d1 = deferred<void>();
    const d2 = deferred<void>();

    const p1 = sem.run(wrap(1, () => d1.promise));
    const p2 = sem.run(wrap(2, () => d2.promise));
    await tick();

    // Task 2 must not have started while task 1 is still pending.
    expect(state.started).toEqual([1]);
    expect(sem.stats.active).toBe(1);
    expect(sem.stats.queued).toBe(1);

    d1.resolve();
    await p1;
    await tick();
    expect(state.started).toEqual([1, 2]);

    d2.resolve();
    await p2;
    expect(state.maxInFlight).toBe(1);
  });

  it('clamps a limit below 1 rather than deadlocking', async () => {
    // A zero/negative limit could never admit anyone; the gate must degrade to
    // serial, not to a permanently closed door.
    const sem = new Semaphore(0);
    expect(sem.stats.limit).toBe(1);
    await expect(sem.run(async () => 'ran')).resolves.toBe('ran');
  });

  it('floors a fractional limit to a whole number of permits', async () => {
    const sem = new Semaphore(2.9);
    expect(sem.stats.limit).toBe(2);
  });
});

describe('Semaphore — FIFO fairness', () => {
  it('runs queued tasks in strict arrival order', async () => {
    const sem = new Semaphore(1);
    const order: number[] = [];
    const gate = deferred<void>();

    // The first task holds the only permit; 1..9 all queue behind it.
    const first = sem.run(async () => {
      order.push(0);
      await gate.promise;
    });
    const rest = Array.from({ length: 9 }, (_, i) =>
      sem.run(async () => {
        order.push(i + 1);
      }),
    );

    gate.resolve();
    await Promise.all([first, ...rest]);

    expect(order).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('does not let a late arrival barge ahead of an already-queued waiter', async () => {
    // The starvation case. If `release` decremented `active` and let waiters
    // re-acquire, a caller arriving in that window could win the free slot. The
    // baton-pass in `release` is what prevents it — a newcomer must join the back
    // of the queue while anyone is waiting.
    const sem = new Semaphore(1);
    const order: string[] = [];
    const holder = deferred<void>();

    const running = sem.run(async () => {
      order.push('running');
      await holder.promise;
    });
    const earlyWaiter = sem.run(async () => {
      order.push('early-waiter');
    });
    await tick();

    // A newcomer arrives while one task runs and one waits.
    const lateArrival = sem.run(async () => {
      order.push('late-arrival');
    });

    holder.resolve();
    await Promise.all([running, earlyWaiter, lateArrival]);

    expect(order).toEqual(['running', 'early-waiter', 'late-arrival']);
  });

  it('preserves FIFO across multiple permits', async () => {
    const sem = new Semaphore(2);
    const order: number[] = [];
    const holders = [deferred<void>(), deferred<void>()];

    const running = [0, 1].map((i) =>
      sem.run(async () => {
        order.push(i);
        await holders[i]!.promise;
      }),
    );
    // Each queued task also blocks, so exactly one permit's worth of progress is
    // observable per release — an instantly-returning task would cascade through
    // the whole queue in one tick and prove nothing about ordering.
    const queuedHolders = [deferred<void>(), deferred<void>(), deferred<void>(), deferred<void>()];
    const queued = [2, 3, 4, 5].map((i) =>
      sem.run(async () => {
        order.push(i);
        await queuedHolders[i - 2]!.promise;
      }),
    );
    await tick();
    expect(order).toEqual([0, 1]);

    // Release the SECOND holder first — the freed permit must still go to the
    // longest-waiting queue head (2), not to whoever is "closest".
    holders[1]!.resolve();
    await tick();
    expect(order).toEqual([0, 1, 2]);

    // And the next release goes to 3, not back to whoever arrived most recently.
    holders[0]!.resolve();
    await tick();
    expect(order).toEqual([0, 1, 2, 3]);

    for (const h of queuedHolders) h.resolve();
    await Promise.all([...running, ...queued]);
    expect(order).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('starves nobody: every task in a large burst eventually runs exactly once', async () => {
    const sem = new Semaphore(2);
    const ran: number[] = [];

    await Promise.all(
      Array.from({ length: 200 }, (_, i) =>
        sem.run(async () => {
          await tick();
          ran.push(i);
        }),
      ),
    );

    expect(ran).toHaveLength(200);
    expect(new Set(ran).size).toBe(200);
  });
});

describe('Semaphore — permit release on failure', () => {
  it('releases the permit when the task rejects', async () => {
    const sem = new Semaphore(1);

    await expect(sem.run(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(sem.stats.active).toBe(0);

    // The gate is not wedged: the next caller runs immediately.
    await expect(sem.run(async () => 'ok')).resolves.toBe('ok');
  });

  it('releases the permit when the task throws SYNCHRONOUSLY', async () => {
    // `run` is an async function, so a sync throw inside `fn` is raised at the
    // `await fn()` point and still hits the `finally`. Pinned because a
    // non-async wrapper would leak the permit here.
    const sem = new Semaphore(1);
    const sync = (() => { throw new Error('sync-boom'); }) as () => Promise<never>;

    await expect(sem.run(sync)).rejects.toThrow('sync-boom');
    expect(sem.stats.active).toBe(0);
    await expect(sem.run(async () => 'ok')).resolves.toBe('ok');
  });

  it('hands a failing task\'s permit to the next waiter (queue is never wedged)', async () => {
    // The whole point of the try/finally: a rejection must free the baton, or
    // every queued decode after the first failure hangs forever.
    const sem = new Semaphore(1);
    const order: string[] = [];
    const d = deferred<void>();

    const failing = sem.run(async () => {
      order.push('failing');
      await d.promise;
      throw new Error('nope');
    });
    const waiter = sem.run(async () => {
      order.push('waiter');
    });

    d.resolve();
    await expect(failing).rejects.toThrow('nope');
    await waiter;

    expect(order).toEqual(['failing', 'waiter']);
    expect(sem.stats).toEqual({ active: 0, queued: 0, limit: 1 });
  });

  it('survives a burst where every other task rejects', async () => {
    const sem = new Semaphore(2);
    const { state, wrap } = makeTracker();

    const results = await Promise.allSettled(
      Array.from({ length: 40 }, (_, i) =>
        sem.run(wrap(i, async () => {
          await tick();
          if (i % 2 === 0) throw new Error(`fail-${i}`);
          return i;
        })),
      ),
    );

    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(20);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(20);
    expect(state.maxInFlight).toBe(2);
    expect(sem.stats).toEqual({ active: 0, queued: 0, limit: 2 });
  });
});

describe('Semaphore — stats and memory', () => {
  it('reports active/queued/limit accurately through a call\'s lifecycle', async () => {
    const sem = new Semaphore(2);
    expect(sem.stats).toEqual({ active: 0, queued: 0, limit: 2 });

    const holders = [deferred<void>(), deferred<void>(), deferred<void>()];
    const ps = holders.map((h) => sem.run(() => h.promise));
    await tick();

    // Two hold permits; the third is queued.
    expect(sem.stats).toEqual({ active: 2, queued: 1, limit: 2 });

    holders[0]!.resolve();
    await ps[0];
    await tick();
    // The freed permit was handed to the waiter, so active stays at 2.
    expect(sem.stats).toEqual({ active: 2, queued: 0, limit: 2 });

    holders[1]!.resolve();
    holders[2]!.resolve();
    await Promise.all(ps);
    expect(sem.stats).toEqual({ active: 0, queued: 0, limit: 2 });
  });

  it('drains the waiter queue to empty after a burst (no retained entries)', async () => {
    const sem = new Semaphore(1);
    await Promise.all(Array.from({ length: 100 }, () => sem.run(async () => { await tick(); })));
    expect(sem.stats.queued).toBe(0);
    expect(sem.stats.active).toBe(0);
  });

  it('propagates the task\'s resolved value unchanged', async () => {
    const sem = new Semaphore(1);
    const obj = { deep: { value: 1 } };
    await expect(sem.run(async () => obj)).resolves.toBe(obj);
  });
});

describe('decode gate singleton', () => {
  beforeEach(() => {
    mocks.audio.decodeConcurrency = 2;
    __resetDecodeGate();
  });
  afterEach(() => {
    mocks.audio.decodeConcurrency = 2;
    __resetDecodeGate();
  });

  it('reads its limit from config.audio.decodeConcurrency', () => {
    mocks.audio.decodeConcurrency = 5;
    __resetDecodeGate();
    expect(getDecodeGateStats().limit).toBe(5);
  });

  it('bounds concurrency across independent runExclusive callers', async () => {
    // The point of a module singleton: `ensurePcmClip` and the upload route are
    // different call sites, and the ceiling must apply to their SUM.
    mocks.audio.decodeConcurrency = 2;
    __resetDecodeGate();
    const { state, wrap } = makeTracker();

    await Promise.all(
      Array.from({ length: 30 }, (_, i) =>
        runExclusive(wrap(i, async () => { await tick(); })),
      ),
    );

    expect(state.maxInFlight).toBe(2);
    expect(state.finished).toHaveLength(30);
  });

  it('falls back to the documented default of 2 when the config field is missing', async () => {
    // Unit tests elsewhere mock the config with only `{ audio: { decodeTimeoutMs } }`.
    // `active < undefined` is false forever, so an unguarded read would make every
    // decode in those suites queue and never run — a hang, not a failure.
    delete mocks.audio.decodeConcurrency;
    __resetDecodeGate();

    expect(getDecodeGateStats().limit).toBe(2);
    await expect(runExclusive(async () => 'ran')).resolves.toBe('ran');
  });

  it('falls back to the default for a non-integer / out-of-range config value', () => {
    for (const bad of [0, -1, 1.5, NaN, '3', null, undefined]) {
      mocks.audio.decodeConcurrency = bad;
      __resetDecodeGate();
      expect(getDecodeGateStats().limit).toBe(2);
    }
  });

  it('releases the permit when a runExclusive task rejects', async () => {
    await expect(runExclusive(async () => { throw new Error('gate-boom'); })).rejects.toThrow('gate-boom');
    expect(getDecodeGateStats().active).toBe(0);
    await expect(runExclusive(async () => 'ok')).resolves.toBe('ok');
  });

  it('AUDIO_DECODE_CONCURRENCY validates as an integer >= 1, defaulting to 2', async () => {
    // The schema is the real gate on a fat-fingered env var: a typo must fail at
    // startup rather than silently degrade the ceiling (NaN would compare false
    // and close the gate entirely). Asserted against the REAL schema, not the
    // mocked config above.
    const { appConfigSchema } = await import('../../../src/config/schema.js');
    const audio = appConfigSchema.shape.audio;
    const bare = (audio as unknown as { removeDefault(): { safeParse(v: unknown): { success: boolean } } })
      .removeDefault();

    expect(audio.parse(undefined).decodeConcurrency).toBe(2);
    // env vars are strings, so coercion is what makes "4" usable.
    expect(audio.parse({ decodeConcurrency: '4' }).decodeConcurrency).toBe(4);
    expect(audio.parse({ decodeConcurrency: '1' }).decodeConcurrency).toBe(1);
    for (const bad of ['0', '-1', '1.5', 'two']) {
      expect(bare.safeParse({ decodeConcurrency: bad }).success).toBe(false);
    }
  });

  it('__resetDecodeGate does not strand work already running on the old gate', async () => {
    // Reset swaps the singleton rather than mutating it, so an in-flight caller
    // still settles against the gate it acquired on.
    const d = deferred<string>();
    const inflight = runExclusive(() => d.promise);
    await tick();
    expect(getDecodeGateStats().active).toBe(1);

    __resetDecodeGate();
    expect(getDecodeGateStats().active).toBe(0); // fresh gate

    d.resolve('finished-anyway');
    await expect(inflight).resolves.toBe('finished-anyway');
  });
});
