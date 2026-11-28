/**
 * The budgeted read Compare agents and Team performance share (docs/compare-agents.md §7, CP6;
 * docs/team-performance.md §4, TP20): a read that runs in the primary against the live database,
 * bounded on every side. Each area keeps its own rules (its limits, its budget, its cache key, its
 * refusal codes and its metrics) and passes them in; the mechanics are here, once:
 *
 *  - **Slots** ({@link TenantReadLimiter}): at most a number of reads per tenant and in the process
 *    at once, non-blocking; past either the area's busy refusal at once, never queued
 *    ({@link BudgetedReads.acquire}).
 *  - **One snapshot, one deadline** ({@link BudgetedReads.snapshot}): every statement of one read on
 *    one connection in a read-only REPEATABLE READ transaction (`withCancellableRead`,
 *    `@magick-agency/db/utils/cancellable-read`), the whole read's deadline counted from before the
 *    connection is taken, each statement under a `statement_timeout` of what is left less the
 *    area's margin, and the parallel workers capped. Past the deadline, or a statement past its
 *    `statement_timeout` (57014), the area's timed-out refusal; the client gone, its aborted error.
 *    Every read that ran is timed through the area's sink.
 *  - **A shared read** ({@link SharedReads}): an answer cached on success for the area's TTL, an
 *    identical read in flight joined (a cached or joined answer takes no slot and is not timed), one
 *    slot per read in flight, given back when the read has settled (its statement has ENDED, never
 *    before), and the read aborted once the last request waiting on it has gone.
 */
import type { PoolClient } from 'pg';
import { withCancellableRead } from '@magick-agency/db/utils/cancellable-read';
import type { TransactionPool } from '@magick-agency/db/utils/transaction';
import type { TtlCache } from '@magick-agency/db/utils/ttl-cache';
import type { CompareReadRefusal, CompareReadResult } from '@magick-agency/observability/metrics/agency';

/**
 * At most `limit` reads per tenant and `globalLimit` in the process at once. Non-blocking: a caller
 * past either is refused, never queued. The release is idempotent, so a double call cannot free a
 * slot someone else holds. `globalLimit` may be a function, read at the first acquire (the pool it
 * is a share of exists only once the server has started).
 */
export class TenantReadLimiter {
  private readonly held = new Map<string, number>();
  private total = 0;
  private globalResolved: number | null = null;

  constructor(private readonly limit: number, private readonly globalLimit: number | (() => number) = Number.POSITIVE_INFINITY) {
    if (!Number.isInteger(limit) || limit < 1) throw new RangeError(`TenantReadLimiter: limit must be a positive integer, got ${limit}`);
  }

  private global(): number {
    this.globalResolved ??= typeof this.globalLimit === 'function' ? this.globalLimit() : this.globalLimit;
    return this.globalResolved;
  }

  /** A release function when a slot was free (the tenant's and the process's), else null. */
  tryAcquire(tenantId: string): (() => void) | null {
    const n = this.held.get(tenantId) ?? 0;
    if (n >= this.limit || this.total >= this.global()) return null;
    this.held.set(tenantId, n + 1);
    this.total += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.total -= 1;
      const left = (this.held.get(tenantId) ?? 1) - 1;
      if (left <= 0) this.held.delete(tenantId);
      else this.held.set(tenantId, left);
    };
  }

  /** Slots the tenant holds now. Test and diagnostic use. */
  inFlight(tenantId: string): number {
    return this.held.get(tenantId) ?? 0;
  }

  /** Slots held in the process now. Test and diagnostic use. */
  inFlightTotal(): number {
    return this.total;
  }
}

/** `57014 query_canceled`: what a statement past its `statement_timeout` raises. */
function isStatementTimeout(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === '57014';
}

/** How a read's statements are bounded inside its whole-read deadline (`withCancellableRead`'s options). */
export interface StatementBudget {
  /** How much earlier than the deadline `statement_timeout` ends a statement. */
  marginMs: number;
  /** `statement_timeout` is lowered before a statement only when what is left is lower by more than this. */
  slackMs: number;
  /** How long a cancelled statement may take to end before it is abandoned with its connection. */
  graceMs: number;
  /** `max_parallel_workers_per_gather` inside the read's transaction. */
  maxParallelWorkersPerGather: number;
}

/** What one area's budgeted reads are bound by, and how it refuses and counts. */
export interface BudgetedReadOptions {
  deps: {
    pool: TransactionPool;
    /** Cancel the statement running on backend `pid`, on a connection of its own; never throws. */
    cancelBackend(pid: number): Promise<boolean>;
  };
  /** Reads per tenant at once. */
  perTenant: number;
  /** Reads in the process at once, or a function read at the first acquire. */
  global: number | (() => number);
  /** The whole read's deadline, counted from before the connection is taken. */
  timeoutMs: number;
  budget: StatementBudget;
  /** The area's refusal when no slot is free. */
  busy(): Error;
  /** The area's refusal past the deadline or a statement's `statement_timeout`. */
  timedOut(): Error;
  /** The area's error when the client went away first. */
  aborted(): Error;
  /** Counts a guard refusal (the area's `…_reads_refused_total`). */
  refused(reason: CompareReadRefusal): void;
}

/** Where a read that ran is timed: how it ended, and its seconds. */
export type ReadTiming = (result: CompareReadResult, seconds: number) => void;

/** One area's slots and snapshots. */
export class BudgetedReads {
  private readonly limiter: TenantReadLimiter;

  constructor(private readonly o: BudgetedReadOptions) {
    this.limiter = new TenantReadLimiter(o.perTenant, o.global);
  }

  /** A slot of the tenant's and the process's, or the busy refusal (counted). The release is idempotent. */
  acquire(tenantId: string): () => void {
    const release = this.limiter.tryAcquire(tenantId);
    if (release === null) {
      this.o.refused('busy');
      throw this.o.busy();
    }
    return release;
  }

  /** The area's error for a client that went away first. */
  aborted(): Error {
    return this.o.aborted();
  }

  /** Slots the tenant holds now. Test and diagnostic use. */
  inFlight(tenantId: string): number {
    return this.limiter.inFlight(tenantId);
  }

  /** Slots held in the process now. Test and diagnostic use. */
  inFlightTotal(): number {
    return this.limiter.inFlightTotal();
  }

  /**
   * `fn` in one read-only snapshot under the whole read's deadline (starting now), timed through
   * `timing`, stopped by `gone` (the client went away: the aborted error) or the deadline (the
   * timed-out refusal, as is a statement past its `statement_timeout`). The statement running is
   * cancelled by its backend's pid, awaited, the connection destroyed after it and a statement still
   * running after the grace abandoned (`withCancellableRead`).
   */
  async snapshot<T>(fn: (db: PoolClient) => Promise<T>, gone: AbortSignal | undefined, timing: ReadTiming): Promise<T> {
    const deadline = { signal: AbortSignal.timeout(this.o.timeoutMs), at: performance.now() + this.o.timeoutMs };
    const started = performance.now();
    let result: CompareReadResult = 'failed';
    const signal = gone ? AbortSignal.any([gone, deadline.signal]) : deadline.signal;
    try {
      signal.throwIfAborted();
      const { budget } = this.o;
      const out = await withCancellableRead(this.o.deps.pool, {
        signal,
        cancel: (pid) => this.o.deps.cancelBackend(pid),
        timeout: { deadlineAt: deadline.at, marginMs: budget.marginMs, slackMs: budget.slackMs },
        // Inside every limit the pool sets: a budgeted read is the shortest reader there is.
        ceiling: 'session',
        settings: { max_parallel_workers_per_gather: budget.maxParallelWorkersPerGather },
        // Abandoned rather than waited for: the slot must come back.
        graceMs: budget.graceMs,
      }, (tx) => fn(tx.client));
      result = 'ok';
      return out;
    } catch (err) {
      if (gone?.aborted) {
        result = 'aborted';
        throw this.o.aborted();
      }
      if (deadline.signal.aborted || isStatementTimeout(err)) {
        result = 'timed_out';
        this.o.refused('timed_out');
        throw this.o.timedOut();
      }
      throw err;
    } finally {
      timing(result, (performance.now() - started) / 1000);
    }
  }
}

/**
 * One read in flight, shared by every request for its key that arrives before it settles (a joiner
 * takes no slot: it runs nothing). The load holds ONE slot, released when it settles. When every
 * request waiting on it has gone it is aborted: its statement is cancelled, and the load settles
 * (and gives its slot back) once that statement has ended.
 */
interface SharedLoad<T> {
  promise: Promise<T>;
  controller: AbortController;
  release: () => void;
  waiters: number;
  settled: boolean;
}

const noop = (): void => undefined;

/** One cache of an area's answers, each from the cache, joined to the same read in flight, or a new read under a slot. */
export class SharedReads<T> {
  private readonly loads = new Map<string, SharedLoad<T>>();

  constructor(private readonly reads: BudgetedReads, private readonly cache: TtlCache<T>) {}

  /**
   * The answer for `key`: from the cache (no slot), joined to the same read in flight (no slot), or
   * `load` run under a new slot of `tenantId`'s (the busy refusal when none is free). Rejects with
   * the aborted error when `signal` aborts first; when every request waiting on a read has gone, its
   * statement is cancelled and its slot comes back once that statement has ended.
   */
  async get(key: string, tenantId: string, load: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) throw this.reads.aborted();
    return this.cache.get(key) ?? this.wait(this.loadFor(key, tenantId, load), key, signal);
  }

  /** Drop every cached answer. */
  clear(): void {
    this.cache.clear();
  }

  /** The read in flight for `key`, or a new one holding a slot (the busy refusal when none is free). */
  private loadFor(key: string, tenantId: string, run: (signal: AbortSignal) => Promise<T>): SharedLoad<T> {
    const running = this.loads.get(key);
    if (running) return running;
    const release = this.reads.acquire(tenantId);
    const controller = new AbortController();
    const load: SharedLoad<T> = {
      controller, release, waiters: 0, settled: false,
      promise: run(controller.signal).then((out) => {
        // An aborted read's answer is nobody's; an answer is kept for the TTL.
        if (!controller.signal.aborted) this.cache.set(key, out);
        return out;
      }),
    };
    this.loads.set(key, load);
    load.promise
      .finally(() => {
        // The read has settled: its statement has ended (or its connection was abandoned).
        load.settled = true;
        load.release();
        if (this.loads.get(key) === load) this.loads.delete(key);
      })
      .catch(noop);
    return load;
  }

  /** Wait for `load` as one of its requests; leaving (an abort) may abort the load (see {@link SharedLoad}). */
  private wait(load: SharedLoad<T>, key: string, signal: AbortSignal | undefined): Promise<T> {
    load.waiters += 1;
    let done = false;
    return new Promise<T>((resolve, reject) => {
      const leave = (): void => {
        if (done) return;
        done = true;
        load.waiters -= 1;
        if (load.waiters === 0 && !load.settled) {
          // Nobody is left to answer: stop the statement. The slot comes back when the load
          // settles, once the statement has ended; a new request for the key starts afresh.
          if (this.loads.get(key) === load) this.loads.delete(key);
          load.controller.abort();
        }
        reject(this.reads.aborted());
      };
      signal?.addEventListener('abort', leave, { once: true });
      load.promise.then(
        (value) => { signal?.removeEventListener('abort', leave); if (!done) { done = true; resolve(value); } },
        (err: unknown) => { signal?.removeEventListener('abort', leave); if (!done) { done = true; reject(err); } },
      );
    });
  }
}
