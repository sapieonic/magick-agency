/**
 * Bounded-concurrency `Promise.all`.
 *
 * `Promise.all(items.map(fn))` starts every task at once, which is fine for a
 * handful and wrong for a page: the campaign list fans out one core request per
 * job, and with a page size of 100 that is 100 simultaneous requests to core
 * from a single list load — per user, per poll. The undici pool caps sockets
 * per origin (128), so past that they queue anyway; the visible effect is
 * simply that everything else on the instance queues behind them.
 *
 * Order of results matches order of `items`, exactly like `Promise.all`.
 *
 * Failure semantics also match `Promise.all`: the returned promise rejects with
 * the first rejection, and tasks already in flight are not cancelled (nothing
 * here can cancel an in-flight fetch). Tasks not yet started are NOT started —
 * every worker checks a shared `failed` flag before claiming its next index.
 * Without that flag the pool keeps draining the whole queue after the caller
 * has already been handed a rejection, which for this helper's purpose (capping
 * load on a downstream service) is precisely the wrong behaviour.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError(`mapWithConcurrency: limit must be a positive integer, got ${limit}`);
  }
  if (items.length === 0) return [];

  const results = new Array<R>(items.length);
  let next = 0;
  let failed = false;

  // One worker per slot, each pulling the next index until the list is drained.
  // `next` is only ever read-then-incremented synchronously, so no two workers
  // can claim the same index despite the awaits.
  const workerCount = Math.min(limit, items.length);
  const workers = Array.from({ length: workerCount }, async () => {
    for (;;) {
      if (failed) return;
      const index = next++;
      if (index >= items.length) return;
      try {
        results[index] = await fn(items[index]!, index);
      } catch (err) {
        // Stop the other workers from claiming further items, then propagate:
        // `Promise.all` below surfaces the first rejection to the caller.
        failed = true;
        throw err;
      }
    }
  });

  await Promise.all(workers);
  return results;
}

/**
 * A counting semaphore, for bounding work that is NOT one mappable list.
 *
 * `mapWithConcurrency` bounds one call over one array. This bounds a shared
 * resource across independent callers — the notification transport, where the
 * digest runner drives several fan-outs at once and the bound has to hold over
 * all of them together rather than within each.
 *
 * ── The slot is HANDED OVER, never released and re-taken ──────────────────
 *
 * The obvious implementation — `release` decrements then wakes a waiter, the
 * waiter re-increments — does not hold its bound, and this is the bug it was
 * extracted here to make testable. The waiter's increment runs a microtask after
 * the decrement, so any `acquire()` whose continuation is already queued in that
 * window sees a slot that has been promised to somebody else and takes it too.
 * A limit of 6 was measured admitting 7.
 *
 * So `release` decrements ONLY when nobody is waiting; otherwise the count stays
 * at the bound for the whole handover and the woken waiter inherits the slot it
 * was already counted for.
 *
 * Deliberately NOT re-entrant and with no timeout: every caller here wraps
 * `release()` in a `finally`, which is what stops a throwing task from leaking
 * a slot. A slot leak is worse than an overshoot — it is permanent, and the
 * process sends progressively slower until it stops.
 */
export interface Semaphore {
  /** Resolves when a slot is held. The caller MUST `release()` in a `finally`. */
  acquire(): Promise<void>;
  release(): void;
  /** Slots currently held. Test and diagnostic use. */
  readonly inFlight: number;
  /** Callers parked waiting for a slot. Test and diagnostic use. */
  readonly waiting: number;
}

export function createSemaphore(limit: number): Semaphore {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError(`createSemaphore: limit must be a positive integer, got ${limit}`);
  }

  const waiters: Array<() => void> = [];
  let inFlight = 0;

  return {
    async acquire(): Promise<void> {
      if (inFlight < limit) {
        inFlight += 1;
        return;
      }
      await new Promise<void>((resolve) => waiters.push(resolve));
    },
    release(): void {
      const next = waiters.shift();
      if (next) {
        next();
        return;
      }
      inFlight -= 1;
    },
    get inFlight() {
      return inFlight;
    },
    get waiting() {
      return waiters.length;
    },
  };
}

// ── PORT NOTE (magick-agency): appended verbatim from magic-voice-core@4850d1d9:src/utils/concurrency.ts
// (same path in both source repos; lead decision: master's file owns the path, core's helper rides beside it
// for lane C's clip-cache sweeper). No name collides: master exports mapWithConcurrency, Semaphore,
// createSemaphore; core exports runWithConcurrency.

/**
 * Run async tasks over a list with a bounded concurrency limit.
 *
 * A fixed pool of workers pulls from a shared cursor until the list is drained,
 * so at most `concurrency` invocations of `fn` are in flight at any time. The
 * returned promise resolves once every item has been processed. `fn` is
 * expected to handle its own errors — a rejection propagates and aborts the run.
 */
export async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let idx = 0;
  async function worker(): Promise<void> {
    while (idx < items.length) {
      const i = idx++;
      await fn(items[i]!);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
}
