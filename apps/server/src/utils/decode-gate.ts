import { config } from '../config/index.js';

/**
 * Semaphore — a FIFO, fair, counting concurrency limiter.
 *
 * Sits alongside {@link SingleFlight} (which coalesces *identical* work) and
 * covers the orthogonal case: work that is all *different* but individually
 * expensive, where the danger is the fleet size rather than duplication.
 * `SingleFlight` keyed on a file id dedupes one file forever and N distinct
 * files not at all — a semaphore is what bounds N.
 *
 * Properties:
 *  - **FIFO** — waiters are served strictly in arrival order. Guaranteed by
 *    baton-passing on release (see {@link release}), not by a scheduler
 *    coincidence: a released permit is handed directly to the queue head rather
 *    than returned to a pool that a newly-arriving caller could win.
 *  - **Fair / starvation-free** — because the permit is handed over rather than
 *    released, `active` never dips below `limit` while anyone is queued, so a
 *    late arrival cannot take the fast path and barge ahead of the queue. Every
 *    waiter therefore advances one position per completion and is eventually
 *    served.
 *  - **Never drops work** — every queued waiter is resolved exactly once, by the
 *    release of the permit ahead of it. {@link run} releases in a `finally`, so
 *    a rejecting (or synchronously throwing) task frees its permit just like a
 *    successful one. A leaked permit would wedge the queue permanently, which is
 *    why the release is unconditional rather than on the success path.
 *  - **Bounded memory** — a waiter holds nothing but its own `resolve`. The
 *    queue empties as work drains, and an empty array retains no entries.
 *
 * **NOT re-entrant.** A task running under a permit must not call {@link run}
 * again (directly or transitively): with all permits held by tasks that are
 * themselves waiting for a permit, nothing can ever release and the gate
 * deadlocks. There is no ownership tracking to detect this — keep the guarded
 * region a leaf.
 *
 * Ordering note for callers: acquire as LATE as correctness allows. Anything
 * that can reject cheaply (validation) should reject before queueing, and any
 * deadline that is meant to measure the *work* must start after acquisition, or
 * it measures the queue wait as well.
 */
export class Semaphore {
  private readonly limit: number;
  private active = 0;
  /** Waiters in arrival order. Each entry resolves that caller's acquire(). */
  private readonly queue: (() => void)[] = [];

  constructor(limit: number) {
    // A limit below 1 could never admit anyone; clamp rather than deadlock.
    this.limit = Math.max(1, Math.floor(limit));
  }

  /**
   * Run `fn` holding one permit, queueing until one is free.
   *
   * The permit is acquired SYNCHRONOUSLY when a slot is free (the counter is
   * incremented before this returns its promise), so a synchronous burst of
   * callers cannot all observe the same free slot and overshoot the limit.
   */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      // `await` matters: without it the `finally` would fire before the task
      // completed, releasing the permit while the work is still running.
      return await fn();
    } finally {
      this.release();
    }
  }

  get stats(): { active: number; queued: number; limit: number } {
    return { active: this.active, queued: this.queue.length, limit: this.limit };
  }

  private acquire(): Promise<void> {
    // The `queue.length === 0` term is redundant under the invariant that a
    // non-empty queue implies `active === limit` (release hands the permit over
    // instead of decrementing). It is kept so fairness is verifiable from this
    // function alone, and so a future edit to `release` cannot silently turn
    // this into a barging fast path.
    if (this.active < this.limit && this.queue.length === 0) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.queue.push(resolve);
    });
  }

  private release(): void {
    const next = this.queue.shift();
    if (next) {
      // Baton-pass: `active` deliberately stays put — the permit moves from the
      // finishing task straight to the queue head. Decrementing and letting the
      // waiter re-acquire would open a window in which an arriving caller could
      // take the free slot ahead of a waiter that has been queued longer.
      next();
      return;
    }
    this.active--;
  }
}

/**
 * Fleet-wide ceiling on concurrent audio decodes.
 *
 * `decodeToPcm16` spawns `mpg123`/`sndfile-convert` as child processes and, while
 * one runs, holds the compressed input plus a decoded PCM16 output (bounded by
 * `MAX_DECODED_OUTPUT_BYTES`, ~23 MB) in scratch, then reads the output whole into
 * a Buffer. Nothing upstream bounds how many of those run at once: the upload
 * route decodes synchronously in the request path behind only a *request* rate
 * limit, and `ensurePcmClip`'s SingleFlight dedupes one audio file, never the
 * fleet. This process also bridges live calls on the same event loop and CPU, so
 * an unbounded decode burst degrades calls that have nothing to do with it.
 */
const DEFAULT_DECODE_CONCURRENCY = 2;

let gate: Semaphore | null = null;

/**
 * Resolve the configured limit, defensively.
 *
 * The Zod schema makes this an integer ≥ 1 in production, so the fallback is
 * unreachable there. It exists for the unit tests that mock the config module
 * with only the fields their subject reads (`{ audio: { decodeTimeoutMs } }`):
 * without it the limit would be `undefined`, `active < undefined` would be false
 * forever, and every decode in the suite would queue and never run — a hang, not
 * a failure. A missing knob must degrade to the documented default, never to a
 * closed gate.
 */
function resolveLimit(): number {
  const raw = (config as { audio?: { decodeConcurrency?: unknown } }).audio?.decodeConcurrency;
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= 1 ? raw : DEFAULT_DECODE_CONCURRENCY;
}

/**
 * Lazily construct the singleton. Lazy because `config` is loaded at import time
 * and a module-init read would bake in whatever the environment looked like
 * during import ordering; and the limit is read ONCE and held for the gate's
 * lifetime because shrinking it mid-flight (below the number of permits already
 * out) would corrupt the accounting rather than shed load.
 */
function getGate(): Semaphore {
  gate ??= new Semaphore(resolveLimit());
  return gate;
}

export interface DecodeGateStats {
  active: number;
  queued: number;
  limit: number;
}

/**
 * Run `fn` under the process-wide decode permit, queueing FIFO when the limit is
 * reached. A rejection from `fn` releases the permit exactly like a success.
 */
export function runExclusive<T>(fn: () => Promise<T>): Promise<T> {
  return getGate().run(fn);
}

/** Current gate occupancy — for tests, diagnostics, and metrics. */
export function getDecodeGateStats(): DecodeGateStats {
  return getGate().stats;
}

/**
 * Test-only reset.
 *
 * Replaces the singleton rather than mutating it, so any work still queued or
 * running on the previous gate completes normally against that gate's own
 * accounting — resetting must not strand a caller's promise. Also drops the
 * cached limit, so a test that re-mocks the config sees the new value.
 */
export function __resetDecodeGate(): void {
  gate = null;
}
