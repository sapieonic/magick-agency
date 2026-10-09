import { createChildLogger } from '@magick-agency/observability';
import type { CompositeReleaseResult } from './provider-concurrency-guard.js';

const log = createChildLogger({ component: 'telephony-release' });

/**
 * How a call's telephony leases were handed back.
 *
 * - `composite` — the atomic transaction released a plausibly complete lease. A
 *   complete lease is 2 scopes (legacy: global + account) or 3 (provider mode), and
 *   the helper cannot tell those apart — it does not know the account's allocation
 *   mode — so `2` is deliberately accepted. That ambiguity is why `partial` below
 *   only catches the case that is unambiguous.
 * - `partial` — exactly ONE scope was released. That can never be a complete
 *   telephony lease, so the rest are still parked: a wrong tenant/account (the
 *   global key is tenant-less, so it alone still hits), or locks that TTL-expired
 *   unevenly. Reported separately rather than as `composite`, and it arms the
 *   self-heal sweep. Re-running the per-scope path would not help — it would use
 *   the same keys — so the value here is the signal, not a retry.
 * - `noop` — the composite ran and deleted nothing. **Ambiguous, not benign:** it
 *   is either a duplicate teardown (a prior release already decremented, counter
 *   correct) or leases that TTL-expired before teardown — and in that second case
 *   `DEL` returns 0, so the counter was never decremented and real drift exists.
 *   That is exactly the "delayed-visibility drift" the self-heal sweep exists for,
 *   so callers should arm the sweep on `noop` as well as on `failure`.
 *   Terminal — no fallback — because the per-guard releases run the same DEL-gated
 *   script against the same keys and provably cannot do anything either.
 * - `fallback` — the composite was declined or inconclusive, so each scope was
 *   released through its own guard. Correct, but three round trips instead of one.
 *   The decline reason is logged (see `declineReason`), because "a guard latched
 *   into degraded mode" and "a session reached teardown with no provider stamped"
 *   need completely different remediations.
 * - `failure` — Redis rejected the atomic release. At least one scope was probably
 *   not released, and its counter over-reports until the sweep reconciles it.
 *
 * How `failure` is detected, because the obvious way does not work: all three
 * guards swallow their own Redis errors internally (each catches, logs, and falls
 * back to a process-local counter), so a per-guard release promise can never
 * reject outside a test double. Classifying on rejection alone would make
 * `failure` unreachable in production and label a total teardown failure as the
 * benign-looking `fallback`. The composite's own `failed` status is therefore the
 * signal. Note the converse limit: on the degraded path the fallback's success is
 * unobservable, so alert on a *rate*, not on any single occurrence: page on
 * `outcome=~"failure|partial"` — a 1-scope release parks the rest, which is the
 * same operational problem — and deliberately not on `noop`.
 */
export type TelephonyReleaseOutcome = 'composite' | 'partial' | 'noop' | 'fallback' | 'failure';

/** Outcomes that leave a counter possibly over-reporting, so the self-heal sweep
 * must be armed. `fallback` is excluded: it released every scope it manages. */
const DRIFT_OUTCOMES: ReadonlySet<TelephonyReleaseOutcome> = new Set(['failure', 'partial', 'noop']);

/**
 * Teardown call sites, as a closed set. This is a Prometheus label, so it must be
 * owned by the code rather than assembled from runtime values.
 *
 * Only `webrtc` (the WebRTC bridge's teardown) is emitted in this service; the
 * other members have no call site here.
 *
 * Not a complete denominator for releases: the partial-acquire rollbacks in
 * `acquireTelephonyConcurrency` release without going through here, so
 * `sum(telephony_lease_release_total)` is releases *through this helper*, not all
 * releases.
 */
export type TelephonyReleaseSource =
  | 'session_end'
  | 'init_rollback'
  | 'transfer_settle'
  | 'cancel_no_session'
  | 'dequeue_static_claim_lost'
  | 'dequeue_static_failed'
  | 'dequeue_ivr_claim_lost'
  | 'dequeue_ivr_failed'
  | 'refill_static_claim_lost'
  | 'refill_static_failed'
  | 'refill_ivr_claim_lost'
  | 'refill_ivr_failed'
  | 'refill_shutdown'
  | 'ws_static_dequeue'
  | 'ws_static_teardown'
  | 'bulk_cancel'
  | 'static_batch_cancel'
  | 'ivr_batch_cancel'
  | 'webhook_static_status'
  | 'webhook_ivr_status'
  | 'webrtc';

/** Why the atomic path was not used. Logged, so an operator can act on a rising
 * `fallback` — the two causes are a Redis incident and a code bug respectively. */
type DeclineReason = 'degraded_guard' | 'no_provider' | 'no_release_all' | 'missing_core_guard';

/**
 * The guards a release needs, as a structural contract rather than the concrete
 * classes — mirroring the acquire seam's owner interface, so background services
 * and test doubles can share the production release path.
 */
export interface TelephonyReleaseGuards {
  /** Optional for test doubles only. In production `TelephonyGuardHost` declares
   * all three, so the null branch is not a production path. Kept because a
   * missing guard must degrade to "release what exists" rather than throw, and
   * the decline is logged so it cannot go unnoticed. */
  concurrencyGuard?: {
    release(callId: string): Promise<void>;
    isDegraded?(): boolean;
  } | null | undefined;
  accountConcurrencyGuard?: {
    release(callId: string, tenantId: string, accountId: string): Promise<void>;
    isDegraded?(): boolean;
  } | null | undefined;
  providerConcurrencyGuard?: {
    releaseAll?(
      callId: string, tenantId: string, accountId: string, provider: string,
    ): Promise<CompositeReleaseResult | void>;
    release(callId: string, tenantId: string, accountId: string, provider: string): Promise<void>;
  } | null | undefined;
  /**
   * Armed automatically on any {@link DRIFT_OUTCOMES} result.
   *
   * This is deliberately part of the contract rather than a line each caller
   * remembers to write. `noop` and `partial` are terminal — no per-scope fallback
   * runs — so a caller that ignores the outcome silently leaves a counter
   * over-reporting, and a teardown on a replica with no other live call is where
   * the demand-driven sweep is most likely already dormant. The bridge passes
   * `TelephonyGuardHost`, which provides it.
   *
   * Omit it where the caller already wakes the sweep unconditionally on the same
   * path, so it cannot be double-counted.
   */
  wakeSelfHeal?(): void;
}

export interface TelephonyReleaseParams {
  /** The key the leases were acquired under — a random uuid for a WebRTC bridge
   * call. NOT the call id, which is why it is logged as `concurrencyKey`. */
  concurrencyKey: string;
  tenantId: string;
  accountId: string;
  /** Absent/empty declines the atomic path; see {@link releaseTelephonyLease}. */
  provider: string | undefined;
  source: TelephonyReleaseSource;
  /** The DB call/session id, when the caller has one. Correlation only — every
   * other log line in the service puts that value in `callId`, so omitting it
   * here would leave a release failure unjoinable to the rest of the call. */
  callId?: string | undefined;
}

/**
 * Metric emission is a registration seam rather than a direct import of the
 * metrics module: suites mock that module with an explicit factory, and Vitest
 * throws the moment production code reads an export a factory does not list.
 * Importing it on a path the teardown suites execute would fail every one of them
 * on an unrelated property access.
 *
 * This is a test-architecture workaround, not an architectural boundary.
 * `bootstrap/voice.ts` wires it at startup and a test pins that wiring; unwired,
 * the release path behaves identically and emits nothing.
 */
type TelephonyReleaseObserver = (outcome: TelephonyReleaseOutcome, source: TelephonyReleaseSource) => void;

let releaseObserver: TelephonyReleaseObserver | null = null;

/** Register the metric sink. Pass `null` to detach (tests). */
export function setTelephonyReleaseObserver(observer: TelephonyReleaseObserver | null): void {
  releaseObserver = observer;
}

/** One-shot log latches, so a persistent fault cannot spam a hot path. */
const loggedOnce = new Set<string>();
function logOnce(key: string, emit: () => void): void {
  if (loggedOnce.has(key)) return;
  loggedOnce.add(key);
  emit();
}

/** Test seam — mirrors `resetSafeEmitLatches()`. */
export function resetTelephonyReleaseLatches(): void {
  loggedOnce.clear();
}

/**
 * Release every telephony concurrency scope a call holds, preferring one atomic
 * Redis transaction and falling back to per-guard releases when that is unsafe or
 * inconclusive.
 *
 * Never throws — teardown must not be interruptible — and the guarantee is
 * structural: the whole body is wrapped, not merely the calls that looked risky.
 * The outcome is returned (and counted) so callers can arm the self-heal sweep.
 *
 * ## Why the atomic path is gated
 *
 * **Degraded guards.** `ConcurrencyGuard`/`AccountConcurrencyGuard` fall back to a
 * PROCESS-LOCAL counter when Redis fails, and only their own `release()`
 * decrements it. `degradedMode` is a one-way latch — set in the acquire catch and
 * never reset — so classifying a degraded guard's teardown on the composite alone
 * would leave that local counter to ratchet up to the limit and the replica would
 * stop admitting calls entirely. Such a teardown therefore takes the per-guard
 * path, but STILL fires the composite as best-effort Redis cleanup: a degraded
 * guard skips Redis entirely, so without it a latched replica would park a global
 * + account slot in the *shared* counter on every call it ends, for a full lock
 * TTL, until another replica's sweep healed it. Both are idempotent and touch
 * different counters, so running both cannot double-decrement.
 *
 * **A missing provider.** `releaseAll` builds the provider key from the provider
 * name and reports `unavailable` without one, releasing *nothing*. A teardown
 * with no provider stamped reaches this; such a call still holds global +
 * account leases.
 *
 * **A guard without `releaseAll`, or a missing global/account guard.** Test
 * doubles. Anything the typed contract doesn't recognise is inconclusive.
 *
 * ## Why falling back after a failed composite cannot double-release
 *
 * The composite is a Lua script, so it either ran in full or not at all. A
 * client-side failure leaves us unable to say which, and falling back is safe
 * either way because release is idempotent at the Redis level: the second `DEL`
 * returns 0, so no counter moves.
 *
 * Note one latent coupling: the degraded gate reads `degradedMode`, which is NOT
 * set when a guard is simply constructed with `redis: null`. That case is handled
 * only because `releaseAll` then also reports `unavailable` — i.e. it relies on
 * all three guards sharing one Redis client, as `TelephonyGuardHost` constructs them.
 */
export async function releaseTelephonyLease(
  guards: TelephonyReleaseGuards,
  params: TelephonyReleaseParams,
): Promise<TelephonyReleaseOutcome> {
  let outcome: TelephonyReleaseOutcome;
  try {
    outcome = await resolveRelease(guards, params);
  } catch (err) {
    // Reaching here means something outside the inner guards threw — `isDegraded()`,
    // `declineReason()` or `logOnce()`, all of which run BEFORE any release is
    // attempted. So every lease may still be held, and returning `failure` without
    // trying would make "never throws" mean "never releases" for the callers that
    // do not arm the sweep. Redis release is idempotent, so re-attempting is always
    // safe even if the throw happened later.
    log.error(
      { err, concurrencyKey: params.concurrencyKey, callId: params.callId, source: params.source },
      'Telephony lease release threw — attempting a last-ditch per-scope release',
    );
    try {
      outcome = await releasePerScope(guards, params, true);
    } catch (lastDitchErr) {
      log.error(
        { err: lastDitchErr, concurrencyKey: params.concurrencyKey, callId: params.callId, source: params.source },
        'Last-ditch per-scope telephony release also threw',
      );
      outcome = 'failure';
    }
  }
  if (DRIFT_OUTCOMES.has(outcome)) {
    try {
      guards.wakeSelfHeal?.();
    } catch (err) {
      logOnce('waker-threw', () => log.warn({ err, source: params.source }, 'Telephony release sweep waker threw'));
    }
  }
  // A broken metric sink must never cost a release that already happened.
  try {
    releaseObserver?.(outcome, params.source);
  } catch (err) {
    logOnce('observer-threw', () => log.warn({ err, source: params.source }, 'Telephony release observer threw'));
  }
  return outcome;
}

async function resolveRelease(
  guards: TelephonyReleaseGuards,
  params: TelephonyReleaseParams,
): Promise<TelephonyReleaseOutcome> {
  const { concurrencyKey, tenantId, accountId, provider, source } = params;
  const providerGuard = guards.providerConcurrencyGuard;

  // An absent isDegraded reads as healthy — the same way the acquire seam treats
  // an absent optional method — so older embedders keep working unchanged.
  const degraded = guards.concurrencyGuard?.isDegraded?.() === true
    || guards.accountConcurrencyGuard?.isDegraded?.() === true;

  const decline = declineReason(guards, provider, degraded);
  if (!decline) {
    return classifyComposite(await runComposite(providerGuard!, params), guards, params);
  }

  logOnce(`decline:${decline}:${source}`, () => log.warn(
    { concurrencyKey, callId: params.callId, tenantId, accountId, provider, source, declineReason: decline },
    'Atomic telephony lease release declined — using the per-scope path (logged once per reason+source)',
  ));

  // Degraded is the one decline where Redis may still hold live leases this call
  // owns and no per-guard release will touch them. Best-effort, and deliberately
  // not used for classification: the per-scope path below owns the local counters.
  if (decline === 'degraded_guard' && providerGuard?.releaseAll && provider) {
    await runComposite(providerGuard, params);
  }

  return releasePerScope(guards, params, false);
}

function declineReason(
  guards: TelephonyReleaseGuards,
  provider: string | undefined,
  degraded: boolean,
): DeclineReason | null {
  if (degraded) return 'degraded_guard';
  if (!provider) return 'no_provider';
  if (!guards.providerConcurrencyGuard?.releaseAll) return 'no_release_all';
  // The composite releases the global and account leases straight in Redis, so
  // taking it for a caller that does not hold those guards would release scopes
  // that caller does not manage.
  if (!guards.concurrencyGuard || !guards.accountConcurrencyGuard) return 'missing_core_guard';
  return null;
}

async function runComposite(
  providerGuard: NonNullable<TelephonyReleaseGuards['providerConcurrencyGuard']>,
  params: TelephonyReleaseParams,
): Promise<CompositeReleaseResult | void> {
  const { concurrencyKey, tenantId, accountId, provider, source } = params;
  try {
    return await providerGuard.releaseAll!(concurrencyKey, tenantId, accountId, provider!);
  } catch (err) {
    // releaseAll already folds Redis errors into a `failed` result; this guards an
    // unexpected throw escaping it.
    log.error({ err, concurrencyKey, callId: params.callId, tenantId, accountId, provider, source }, 'Composite telephony lease release threw');
    return { status: 'failed', err };
  }
}

async function classifyComposite(
  result: CompositeReleaseResult | void,
  guards: TelephonyReleaseGuards,
  params: TelephonyReleaseParams,
): Promise<TelephonyReleaseOutcome> {
  const status = result && typeof result === 'object' && 'status' in result ? result.status : 'unrecognised';
  const scopes = result && typeof result === 'object' && 'scopes' in result
    ? (result as { scopes: unknown }).scopes
    : undefined;

  // A count must be a real non-negative integer. `undefined`, `NaN` and negatives
  // all make `scopes > 0` false and would land on the TERMINAL `noop`, skipping
  // the fallback and leaking every lease — the same trap `Number(null) === 0`
  // sets one layer down in `releaseAll`.
  if (status === 'released' && typeof scopes === 'number' && Number.isInteger(scopes) && scopes >= 0) {
    if (scopes === 0) return 'noop';
    // 1 is never a complete lease (legacy holds 2, provider mode 3), so the rest
    // are still parked. 2 is ambiguous — legacy-complete or provider-partial — and
    // the helper cannot tell, so it is accepted rather than guessed at.
    return scopes === 1 ? 'partial' : 'composite';
  }

  log.debug(
    { concurrencyKey: params.concurrencyKey, callId: params.callId, source: params.source, compositeStatus: status },
    'Composite telephony lease release inconclusive — releasing per scope',
  );
  // Only `failed` is evidence Redis rejected the release. `unavailable` and an
  // unreadable reply mean the composite never ran, which the fallback handles as
  // ordinary business.
  return releasePerScope(guards, params, status === 'failed');
}

/** Normalize a synchronous throw into a rejected promise, so a guard that throws
 * before returning its promise cannot escape `Promise.allSettled`. */
function attempt(fn: () => Promise<void>): Promise<void> {
  try {
    return fn();
  } catch (err) {
    return Promise.reject(err);
  }
}

/**
 * Per-guard release. Concurrent rather than serial: the three keys are
 * independent, and the serial shape this replaces existed only so a throw on one
 * could not skip the others — `allSettled` keeps that property while collapsing
 * three sequential waits into one.
 */
async function releasePerScope(
  guards: TelephonyReleaseGuards,
  params: TelephonyReleaseParams,
  compositeFailed: boolean,
): Promise<TelephonyReleaseOutcome> {
  const { concurrencyKey, tenantId, accountId, provider, source } = params;
  const providerGuard = guards.providerConcurrencyGuard;
  const globalGuard = guards.concurrencyGuard;
  const accountGuard = guards.accountConcurrencyGuard;

  const settled = await Promise.allSettled([
    ...(providerGuard && provider
      ? [attempt(() => providerGuard.release(concurrencyKey, tenantId, accountId, provider))]
      : []),
    ...(globalGuard ? [attempt(() => globalGuard.release(concurrencyKey))] : []),
    ...(accountGuard ? [attempt(() => accountGuard.release(concurrencyKey, tenantId, accountId))] : []),
  ]);

  // Seeded from the composite: see the `failure` note on TelephonyReleaseOutcome
  // for why a rejected promise alone cannot carry this signal.
  let failed = compositeFailed;
  for (const entry of settled) {
    if (entry.status !== 'rejected') continue;
    failed = true;
    log.error(
      { err: entry.reason, concurrencyKey, callId: params.callId, tenantId, accountId, provider, source },
      'Failed to release a telephony concurrency scope',
    );
  }
  return failed ? 'failure' : 'fallback';
}
