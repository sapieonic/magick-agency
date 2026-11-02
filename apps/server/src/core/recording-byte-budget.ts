/**
 * The byte budget for call recordings the analysis worker holds in memory.
 *
 * Every analysis slot may buffer a whole recording (up to `DIALER_MAX_RECORDING_BYTES`,
 * 50 MiB) and hand it to an upload, which wraps it in a `Blob` (a second copy). With
 * many slots, slots × recording size is unbounded, so each slot holds a
 * {@link RecordingLease} on this budget while it holds recording bytes:
 *
 *  - the worker takes a lease for the worst case (`maxRecordingBytes` × `RECORDING_COPIES`)
 *    BEFORE it claims a job, so a slot never waits for memory while it holds a claim
 *    (a claimed job that waits goes stale and is recovered from under it);
 *  - the runner shrinks the lease to the real size once the recording is fetched, and to
 *    zero once it no longer needs the bytes (transcript analysis, after transcription);
 *  - a re-fetch (the truncated-recording retry) grows the lease back to the worst case.
 *    Growing releases what the lease holds first and then waits in line, so a waiter
 *    never holds bytes while it waits and two growing leases cannot deadlock.
 *
 * Waiters are served first in, first out, and `tryAcquire` refuses while anyone waits,
 * so a large reservation is not starved by a stream of small ones. A single
 * reservation is clamped to the total, so it can always be granted eventually.
 *
 * This is accounting, not a hard RSS cap: a released `Buffer` is freed when the GC
 * runs, not when the lease drops. It bounds what the worker asks for, which is what
 * concurrency × recording size would otherwise leave unbounded.
 */

/** One slot's hold on the budget. */
export interface RecordingLease {
  /** Bytes this lease currently holds. */
  readonly bytes: number;
  /** Lower the reservation to `bytes` (never raises it, never waits). */
  shrinkTo(bytes: number): void;
  /**
   * Raise the reservation to `bytes`. Releases what the lease holds first, then waits
   * its turn. A no-op shrink when `bytes` is not more than it holds.
   */
  growTo(bytes: number): Promise<void>;
  /** Give everything back. Idempotent; a grow still waiting is cancelled. */
  release(): void;
}

/** A lease on no budget, for a runner driven without a worker (tests, one-off runs). */
export const UNBUDGETED_LEASE: RecordingLease = {
  bytes: 0,
  shrinkTo: () => {},
  growTo: async () => {},
  release: () => {},
};

export interface RecordingByteBudgetHooks {
  /** Called whenever the reserved total changes. */
  onReservedChange?(reservedBytes: number): void;
  /** Called each time a reservation has to wait. */
  onWait?(): void;
}

interface Waiter {
  bytes: number;
  grant: () => void;
}

export class RecordingByteBudget {
  private reserved = 0;
  private readonly waiters: Waiter[] = [];

  constructor(
    readonly totalBytes: number,
    private readonly hooks: RecordingByteBudgetHooks = {},
  ) {
    if (!Number.isFinite(totalBytes) || totalBytes <= 0) {
      throw new RangeError(`RecordingByteBudget: totalBytes must be positive, got ${totalBytes}`);
    }
  }

  /** Bytes currently held by leases. */
  get reservedBytes(): number {
    return this.reserved;
  }

  /** Reservations waiting their turn. */
  get waiting(): number {
    return this.waiters.length;
  }

  /** A lease for `bytes` now, or null when it would have to wait. */
  tryAcquire(bytes: number): RecordingLease | null {
    const n = this.clamp(bytes);
    if (this.waiters.length > 0 || this.reserved + n > this.totalBytes) return null;
    this.add(n);
    return new Lease(this, n);
  }

  /** A lease for `bytes`, waiting in line when the budget is spent. */
  async acquire(bytes: number): Promise<RecordingLease> {
    const lease = new Lease(this, 0);
    await lease.growTo(bytes);
    return lease;
  }

  /** @internal Lease → budget: wait for `n` bytes. */
  take(n: number): Promise<void> {
    if (this.waiters.length === 0 && this.reserved + n <= this.totalBytes) {
      this.add(n);
      return Promise.resolve();
    }
    this.hooks.onWait?.();
    return new Promise<void>((grant) => {
      this.waiters.push({ bytes: n, grant });
    });
  }

  /** @internal Lease → budget: give `n` bytes back and serve the line. */
  give(n: number): void {
    if (n <= 0) return;
    this.add(-n);
    while (this.waiters.length > 0 && this.reserved + this.waiters[0]!.bytes <= this.totalBytes) {
      const next = this.waiters.shift()!;
      this.add(next.bytes);
      next.grant();
    }
  }

  /** @internal A single reservation can never exceed the total, or it would wait forever. */
  clamp(bytes: number): number {
    if (!Number.isFinite(bytes) || bytes <= 0) return 0;
    return Math.min(Math.ceil(bytes), this.totalBytes);
  }

  private add(n: number): void {
    this.reserved += n;
    this.hooks.onReservedChange?.(this.reserved);
  }
}

class Lease implements RecordingLease {
  private held: number;
  private released = false;

  constructor(private readonly budget: RecordingByteBudget, bytes: number) {
    this.held = bytes;
  }

  get bytes(): number {
    return this.held;
  }

  shrinkTo(bytes: number): void {
    const target = this.budget.clamp(bytes);
    if (this.released || target >= this.held) return;
    const surplus = this.held - target;
    this.held = target;
    this.budget.give(surplus);
  }

  async growTo(bytes: number): Promise<void> {
    if (this.released) return;
    const target = this.budget.clamp(bytes);
    if (target <= this.held) {
      this.shrinkTo(target);
      return;
    }
    // Hold nothing while waiting: two leases each holding a little and each waiting
    // for more than is left would otherwise wait for each other forever.
    const had = this.held;
    this.held = 0;
    this.budget.give(had);
    await this.budget.take(target);
    if (this.released) {
      // Released while it waited: the grant is nobody's, hand it straight back.
      this.budget.give(target);
      return;
    }
    this.held = target;
  }

  release(): void {
    if (this.released) return;
    this.released = true;
    const had = this.held;
    this.held = 0;
    this.budget.give(had);
  }
}
