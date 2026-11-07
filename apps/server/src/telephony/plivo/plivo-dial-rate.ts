// The per-account calls-per-second gate in front of Plivo's create-call. A Plivo account
// admits only a few new calls a second (2 by default), counted across everything that
// dials on it, so the gate is keyed by the account (auth_id) and, in production, counted
// in Redis: the primary and every media worker dial, and one account's dials may come
// from any of them.
//
// A sliding window per account: a dial is admitted only while fewer than `perSecond`
// dials were admitted in the last 1000 ms, so no 1000 ms span ever holds more than
// `perSecond` admissions (a fixed per-second window let twice that through across a
// second boundary). The window is a log of admission times. A refused dial is told when
// the slot it needs frees (the admission that must age out, plus 1000 ms) and sleeps
// exactly that long, up to a bounded wait (`acquirePlivoDialSlot`). A dial that gets no
// slot in time is refused before anything reaches Plivo (`CarrierRateLimitedError`,
// `local_gate`).
//
// The limiter is process-wide and set at voice bootstrap (`setPlivoDialRateLimiter`,
// `bootstrap/voice.ts`); until then, and in unit tests, an in-memory one counts per process.
import { randomBytes } from 'node:crypto';
import type Redis from 'ioredis';
import { createChildLogger } from '@magick-agency/observability';

const log = createChildLogger({ component: 'plivo-dial-rate' });

const WINDOW_MS = 1000;

export type DialSlot = { admitted: true } | { admitted: false; retryAfterMs: number };

export interface PlivoDialRateLimiter {
  /** Take a slot for `accountRef` if fewer than `perSecond` were taken in the last 1000 ms. */
  tryAcquire(accountRef: string, perSecond: number): Promise<DialSlot>;
}

/** Drop the admissions that have left the window: those at or before `t - WINDOW_MS`. */
function trim(admissions: number[], t: number): number[] {
  let i = 0;
  while (i < admissions.length && admissions[i]! <= t - WINDOW_MS) i++;
  return i === 0 ? admissions : admissions.slice(i);
}

/** Counts per process. Tests, and the fallback while Redis errors. Same rule as the Redis script. */
export class InMemoryPlivoDialRateLimiter implements PlivoDialRateLimiter {
  /** Per account, its admission times in the window, ascending. */
  private readonly logs = new Map<string, number[]>();

  constructor(private readonly now: () => number = Date.now) {}

  async tryAcquire(accountRef: string, perSecond: number): Promise<DialSlot> {
    const t = this.now();
    if (this.logs.size > 1000) this.prune(t);
    const limit = Math.max(1, Math.floor(perSecond));
    const admissions = trim(this.logs.get(accountRef) ?? [], t);
    this.logs.set(accountRef, admissions);
    if (admissions.length < limit) {
      admissions.push(t);
      return { admitted: true };
    }
    // The slot frees when the admission `limit` places back from the newest ages out.
    const frees = admissions[admissions.length - limit]! + WINDOW_MS;
    return { admitted: false, retryAfterMs: Math.max(1, Math.ceil(frees - t)) };
  }

  /** Accounts with nothing left in the window leave nothing behind. */
  private prune(t: number): void {
    for (const [k, v] of this.logs) if (trim(v, t).length === 0) this.logs.delete(k);
  }
}

/**
 * One atomic step over the account's ZSET of admission times (score = ms): drop what has
 * left the window; admit and record when fewer than the limit remain (the key then
 * expires one window after this newest admission, so an idle account leaves nothing
 * behind); otherwise return when the needed slot frees. The in-memory limiter's rule.
 *
 * KEYS[1] the account's log; ARGV: now (ms), limit, window (ms), a unique member.
 * Returns {1, 0} admitted, or {0, retryAfterMs}.
 */
const ACQUIRE_SCRIPT = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
local window = tonumber(ARGV[3])
redis.call('ZREMRANGEBYSCORE', key, '-inf', now - window)
local n = redis.call('ZCARD', key)
if n < limit then
  redis.call('ZADD', key, now, ARGV[4])
  redis.call('PEXPIRE', key, window)
  return {1, 0}
end
local at = redis.call('ZRANGE', key, n - limit, n - limit, 'WITHSCORES')
local retry = math.ceil(tonumber(at[2]) + window - now)
if retry < 1 then retry = 1 end
return {0, retry}
`;

/**
 * Counts in Redis, so every process dialling on one account shares the window. Admission
 * times are each process's own clock: every process that dials (the primary and its media
 * workers) runs on this one host, a single replica, so they read one clock. A Redis error
 * falls back to the in-memory log (per process, the same sliding window) rather than
 * refusing the dial: Redis down must not stop dialling, and the concurrency guards
 * already degrade the same way.
 */
export class RedisPlivoDialRateLimiter implements PlivoDialRateLimiter {
  private readonly fallback: InMemoryPlivoDialRateLimiter;
  /** With `seq`, makes each admission its own ZSET member, even two in one millisecond. */
  private readonly instance = randomBytes(6).toString('hex');
  private seq = 0;

  constructor(
    private readonly redis: Pick<Redis, 'eval'>,
    private readonly keyPrefix: string,
    private readonly now: () => number = Date.now,
  ) {
    this.fallback = new InMemoryPlivoDialRateLimiter(now);
  }

  async tryAcquire(accountRef: string, perSecond: number): Promise<DialSlot> {
    const t = this.now();
    const key = `${this.keyPrefix}plivo:dial_rate:${accountRef}`;
    const member = `${t}:${this.instance}:${this.seq++}`;
    try {
      const limit = Math.max(1, Math.floor(perSecond));
      const res = await this.redis.eval(ACQUIRE_SCRIPT, 1, key, t, limit, WINDOW_MS, member);
      if (!Array.isArray(res) || typeof res[0] !== 'number' || typeof res[1] !== 'number') {
        throw new Error('unexpected dial-rate script reply');
      }
      if (res[0] === 1) return { admitted: true };
      return { admitted: false, retryAfterMs: res[1] };
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
 * Wait for a dial slot on `accountRef`. Each refusal says when the needed slot frees and
 * the dial sleeps exactly that long, no blind polling (another dial may take the slot
 * first; it then waits for the next). Resolves `{ admitted: true }`, or
 * `{ admitted: false, waitedMs }` when the slot would free after `maxWaitMs`.
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
    // At least 1 ms: a timer that fires a little early retries once more, never spins.
    const wait = Math.max(1, slot.retryAfterMs);
    if (waited + wait > opts.maxWaitMs) return { admitted: false, waitedMs: waited };
    await sleep(wait);
  }
}
