// The per-account calls-per-second gate in front of Plivo's create-call. A Plivo account
// admits only a few new calls a second (2 by default), counted across everything that
// dials on it, so the gate is keyed by the account (auth_id) and, in production, counted
// in Redis: the primary and every media worker dial, and one account's dials may come
// from any of them.
//
// A fixed one-second window per account: the first `perSecond` dials in a wall-clock
// second are admitted, the rest wait for the next second and try again, up to a bounded
// wait (`acquirePlivoDialSlot`). A dial that gets no slot in time is refused before
// anything reaches Plivo (`CarrierRateLimitedError`, `local_gate`).
//
// The limiter is process-wide and set at voice bootstrap (`setPlivoDialRateLimiter`,
// `bootstrap/voice.ts`); until then, and in unit tests, an in-memory one counts per process.
import type Redis from 'ioredis';
import { createChildLogger } from '@magick-agency/observability';

const log = createChildLogger({ component: 'plivo-dial-rate' });

const WINDOW_MS = 1000;

export type DialSlot = { admitted: true } | { admitted: false; retryAfterMs: number };

export interface PlivoDialRateLimiter {
  /** Take a slot in the current window for `accountRef`, if one is left. */
  tryAcquire(accountRef: string, perSecond: number): Promise<DialSlot>;
}

/** Counts per process. Tests, and the fallback while Redis errors. */
export class InMemoryPlivoDialRateLimiter implements PlivoDialRateLimiter {
  private readonly windows = new Map<string, { window: number; count: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  async tryAcquire(accountRef: string, perSecond: number): Promise<DialSlot> {
    const t = this.now();
    const window = Math.floor(t / WINDOW_MS);
    let entry = this.windows.get(accountRef);
    if (!entry || entry.window !== window) {
      if (this.windows.size > 1000) this.prune(window);
      entry = { window, count: 0 };
      this.windows.set(accountRef, entry);
    }
    entry.count += 1;
    if (entry.count <= perSecond) return { admitted: true };
    return { admitted: false, retryAfterMs: WINDOW_MS - (t % WINDOW_MS) };
  }

  private prune(current: number): void {
    for (const [k, v] of this.windows) if (v.window !== current) this.windows.delete(k);
  }
}

/**
 * Counts in Redis, so every process dialling on one account shares the window. Keys
 * expire two windows after they open. A Redis error falls back to the in-memory count
 * (per process) rather than refusing the dial: Redis down must not stop dialling, and the
 * concurrency guards already degrade the same way.
 */
export class RedisPlivoDialRateLimiter implements PlivoDialRateLimiter {
  private readonly fallback: InMemoryPlivoDialRateLimiter;

  constructor(
    private readonly redis: Pick<Redis, 'multi'>,
    private readonly keyPrefix: string,
    private readonly now: () => number = Date.now,
  ) {
    this.fallback = new InMemoryPlivoDialRateLimiter(now);
  }

  async tryAcquire(accountRef: string, perSecond: number): Promise<DialSlot> {
    const t = this.now();
    const window = Math.floor(t / WINDOW_MS);
    const key = `${this.keyPrefix}plivo:dial_rate:${accountRef}:${window}`;
    try {
      const res = await this.redis.multi().incr(key).pexpire(key, 2 * WINDOW_MS).exec();
      const [err, count] = res?.[0] ?? [new Error('empty MULTI reply'), null];
      if (err || typeof count !== 'number') throw err ?? new Error('unexpected INCR reply');
      if (count <= perSecond) return { admitted: true };
      return { admitted: false, retryAfterMs: WINDOW_MS - (t % WINDOW_MS) };
    } catch (err) {
      log.warn({ err }, 'Plivo dial-rate count in Redis failed; counting in this process');
      return this.fallback.tryAcquire(accountRef, perSecond);
    }
  }
}

let limiter: PlivoDialRateLimiter = new InMemoryPlivoDialRateLimiter();

/** Install the process-wide limiter (voice bootstrap). Null restores the in-memory one. */
export function setPlivoDialRateLimiter(next: PlivoDialRateLimiter | null): void {
  limiter = next ?? new InMemoryPlivoDialRateLimiter();
}

export function getPlivoDialRateLimiter(): PlivoDialRateLimiter {
  return limiter;
}

export interface AcquireOptions {
  perSecond: number;
  /** The longest a dial waits for a slot before it is refused. */
  maxWaitMs: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Wait for a dial slot on `accountRef`. Resolves `{ admitted: true }`, or
 * `{ admitted: false, waitedMs }` when the next window would open after `maxWaitMs`.
 */
export async function acquirePlivoDialSlot(
  rate: PlivoDialRateLimiter,
  accountRef: string,
  opts: AcquireOptions,
): Promise<{ admitted: true; waitedMs: number } | { admitted: false; waitedMs: number }> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? defaultSleep;
  const perSecond = Math.max(1, Math.floor(opts.perSecond));
  const started = now();
  for (;;) {
    const slot = await rate.tryAcquire(accountRef, perSecond);
    const waited = now() - started;
    if (slot.admitted) return { admitted: true, waitedMs: waited };
    // A few ms past the boundary, so a clock read just before it does not spin.
    const wait = slot.retryAfterMs + 5;
    if (waited + wait > opts.maxWaitMs) return { admitted: false, waitedMs: waited };
    await sleep(wait);
  }
}
