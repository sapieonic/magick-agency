// PORT NOTE (magick-agency): NEW FILE, extracted from
// magic-voice-core/src/core/call-manager.ts@4850d1d9 (8,919 lines). In core the WebRTC
// bridge took the whole `CallManager` and used exactly four things from it: the three
// telephony guards (through `acquireTelephonyConcurrency` / `releaseTelephonyLease`),
// `wakeSelfHeal()` and `triggerDequeue()`. This class is those parts and nothing else
// (docs/seams.md §3.1), so the bridge's constructor takes it in place of `CallManager`.
//
// Carried, bodies verbatim except where a `PORT NOTE` says otherwise (core line numbers):
//   - guard construction                                   :636-652
//   - `tryAcquireTelephonyConcurrency` / `acquireTelephonyScopes`  :725-772
//   - the self-heal dormancy derivation + log              :694-711
//   - `runSelfHealSweep`, `wakeSelfHeal`, `armSelfHealTimer`, `runSelfHealPoll`  :7918-8036
//   - `reconcileConcurrency`                               :8092-8115
//   - `registerWebrtcActiveIdsProvider`                    :8135
//   - `sweepStaleActiveCalls` (WebRTC source only) + `sweepStaleWebrtcCalls`  :8193-8335, :8597-8670
//   - the self-heal half of `gracefulShutdown`             :8774-8826
// Removed (each a PORTING.md row): the per-broadcast group gate and refiller
// (`group-concurrency-gate.ts` is bulk-broadcast concurrency, not ported),
// `triggerDequeue` (core's AI-call SQS queue), every settlement dispatch (plan §4/§S6:
// no billing), the AI/static/IVR/transfer sweeps, the orphaned-queued sweep, the
// live-call gauge reconcile, `reconcileAccountSlots` + `wakeAndReconcileOnAccountFull`
// (SQS coordinator / AI inbound reject path only).
import type Redis from 'ioredis';
import { createChildLogger } from '@magick-agency/observability';
import { agencyCallRepository } from '@magick-agency/db/repositories/agency-call.repository';
import { config } from '../config/index.js';
import { WEBRTC_MAX_DURATION_SECONDS } from '../config/call-duration-limits.js';
import { auditLogger } from '../audit/audit-logger.js';
import { ConcurrencyGuard } from './concurrency-guard.js';
import { AccountConcurrencyGuard } from './account-concurrency-guard.js';
import { ProviderConcurrencyGuard, type TelephonyAdmissionResult } from './provider-concurrency-guard.js';

const log = createChildLogger({ component: 'telephony-guard-host' });

/**
 * Consecutive fully-idle self-heal sweeps (no active calls *and* no drift found)
 * before the loop goes dormant — like the SQS poller and MessagingRecovery, it
 * must not tick while the replica is idle. With the default 5-min cadence this
 * keeps watching ~10 min past the last activity, comfortably beyond the Redis
 * lock TTL (`callTimeoutSeconds + 30` ≈ 5.5 min) after which post-crash counter
 * drift first becomes *visible* (locks expire, the counter stays inflated). The
 * loop is re-armed on the next call start/end, so a fresh call always restores
 * full coverage.
 */
const SELF_HEAL_EMPTY_SWEEPS_BEFORE_DORMANT = 2;

/**
 * How long {@link TelephonyGuardHost.gracefulShutdown} waits for an in-flight
 * self-heal sweep before giving up on it.
 *
 * The wait itself is necessary, but an UNBOUNDED wait put the whole teardown
 * behind whatever the sweep is blocked on, and the sweep is blocked on Postgres:
 * `failStaleActive` is a multi-row `UPDATE ... LIMIT 1000` and no
 * `statement_timeout` is set, so one row lock held by a long transaction stalls
 * it indefinitely. 15s is a budget, not a diagnosis. A healthy sweep is a handful
 * of indexed statements and finishes in milliseconds.
 */
const SELF_HEAL_SHUTDOWN_WAIT_MS = 15_000;

/**
 * The stale sweep is a crash-recovery backstop, not a call-duration timer. Some
 * call types can legitimately outlive the generic 30-minute stale window, so
 * their cutoffs must also exceed the largest duration the product accepts.
 */
const TERMINAL_CALLBACK_GRACE_MS = 5 * 60_000;

export class TelephonyGuardHost {
  readonly concurrencyGuard: ConcurrencyGuard;
  readonly accountConcurrencyGuard: AccountConcurrencyGuard;
  readonly providerConcurrencyGuard: ProviderConcurrencyGuard;
  private shuttingDown = false;
  /**
   * Returns the call ids the WebRTC bridge is actively handling in memory on this
   * replica, so the stale-call sweep never fails a live local WebRTC call. Wired
   * at boot after the bridge is constructed (the bridge holds a ref to us, not the
   * reverse). Defaults to none so the sweep is safe before/without the bridge.
   */
  private getActiveWebrtcCallIds: () => string[] = () => [];
  private selfHealTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * The in-flight poll body, so shutdown can wait for it. `runSelfHealPoll` nulls
   * `selfHealTimer` at entry and then detaches, so `gracefulShutdown`'s
   * `clearTimeout` finds nothing and cannot stop a sweep that has already started.
   */
  private selfHealInFlight: Promise<void> | null = null;
  private selfHealEmptySweeps = 0;
  private selfHealing = false;
  /**
   * Consecutive fully-idle sweeps before the self-heal poll goes dormant, derived
   * from the lock TTL so the idle window always outlasts it — otherwise env tuning
   * (a large `callTimeoutSeconds` or small `reconcileIntervalMs`) could let the
   * loop go dormant before delayed-visibility drift surfaces. Floored at
   * {@link SELF_HEAL_EMPTY_SWEEPS_BEFORE_DORMANT}. Computed once in the constructor.
   */
  private readonly sweepsBeforeDormant: number;

  constructor(redis: Redis | null) {
    this.concurrencyGuard = new ConcurrencyGuard(
      redis,
      config.redis.keyPrefix,
      config.concurrency.maxConcurrentCalls,
      config.concurrency.callTimeoutSeconds
    );
    this.accountConcurrencyGuard = new AccountConcurrencyGuard(
      redis,
      config.redis.keyPrefix,
      config.concurrency.callTimeoutSeconds
    );
    this.providerConcurrencyGuard = new ProviderConcurrencyGuard(
      redis,
      config.redis.keyPrefix,
      config.concurrency.callTimeoutSeconds,
      config.concurrency.maxConcurrentCalls,
    );
    // Derive the self-heal dormancy window from the lock TTL so the idle cooldown
    // always outlasts it (delayed-visibility drift surfaces only after the locks
    // TTL-expire). Floored at the const so it never drops below the baseline.
    const lockTtlMs = (config.concurrency.callTimeoutSeconds + 30) * 1000;
    this.sweepsBeforeDormant = Math.max(
      SELF_HEAL_EMPTY_SWEEPS_BEFORE_DORMANT,
      Math.ceil(lockTtlMs / config.concurrency.reconcileIntervalMs) + 1,
    );
    log.info(
      {
        sweepsBeforeDormant: this.sweepsBeforeDormant,
        lockTtlSeconds: config.concurrency.callTimeoutSeconds + 30,
        reconcileIntervalMs: config.concurrency.reconcileIntervalMs,
      },
      `Self-heal dormancy window: ${this.sweepsBeforeDormant} sweeps ` +
      `(lockTtl=${config.concurrency.callTimeoutSeconds + 30}s, interval=${config.concurrency.reconcileIntervalMs}ms)`,
    );
  }

  /** Single entry point for telephony capacity. Provider-mode accounts acquire
   * global, account and provider leases atomically; legacy accounts retain the
   * established two-scope behavior until explicitly migrated.
   *
   * PORT NOTE: core's optional 6th `group` parameter (the per-broadcast gate,
   * `admitThroughGroupGate`) is removed; with no group core called
   * `acquireScopes()` directly, which is this body. `callId` is the lease key. */
  async tryAcquireTelephonyConcurrency(
    callId: string,
    tenantId: string,
    accountId: string,
    provider: string,
    ttlSecondsOverride?: number,
  ): Promise<TelephonyAdmissionResult> {
    return this.acquireTelephonyScopes(callId, tenantId, accountId, provider, ttlSecondsOverride);
  }

  /** The global/account/provider half of {@link tryAcquireTelephonyConcurrency}. */
  private async acquireTelephonyScopes(
    callId: string,
    tenantId: string,
    accountId: string,
    provider: string,
    ttlSecondsOverride?: number,
  ): Promise<TelephonyAdmissionResult> {
    const composite = await this.providerConcurrencyGuard.tryAcquireAll(
      callId, tenantId, accountId, provider, ttlSecondsOverride,
    );
    if (composite.result !== 'legacy_mode') return composite;

    const globalAcquired = await this.concurrencyGuard.tryAcquire(callId, ttlSecondsOverride);
    if (!globalAcquired) return { result: 'global_full', providerScoped: false };
    try {
      const accountAcquired = await this.accountConcurrencyGuard.tryAcquire(
        callId, tenantId, accountId, ttlSecondsOverride,
      );
      if (!accountAcquired) {
        await this.concurrencyGuard.release(callId);
        return { result: 'account_full', providerScoped: false };
      }
      return { result: 'acquired', providerScoped: false, newlyAcquired: true };
    } catch (err) {
      await this.concurrencyGuard.release(callId);
      throw err;
    }
  }

  /**
   * Calls in flight on this replica, for the poll's idle decision.
   *
   * PORT NOTE: core read `CallManager.getActiveCallCount()` (`activeSessions.size`,
   * its AI-call sessions) together with the static/IVR live-call gauge ids. Neither
   * population exists here; the only calls this process carries are the bridge's,
   * so "in flight" is the bridge's active call count — keeping the poll armed while
   * a live agency call holds slots, which is what core's AI-call term did for its
   * own calls. This is a behaviour change, not a removal: in core a live WebRTC
   * call alone never kept the poll armed. Kept by lead decision B13
   * (docs/decisions.md): agency's only call type is the bridged call.
   */
  getActiveCallCount(): number {
    return this.getActiveWebrtcCallIds().length;
  }

  // ── Self-healing sweep (crash recovery) ─────────────────────────────────
  // A process crash leaves two kinds of debris that never self-correct:
  //   1. Concurrency counters drifted high (the in-memory release never ran;
  //      the per-call Redis locks expire by TTL but the counter is decremented
  //      only on release) — capacity shrinks until an operator resets it.
  //   2. Call rows stuck in a non-terminal state (the owning session died mid
  //      call) — they dangle "active" forever.
  // `runSelfHealSweep` heals both. It runs once on startup and then via a
  // *demand-driven* self-rescheduling poll: armed on every call end, it disarms
  // itself after a couple of fully-idle sweeps so no timer ticks while the
  // replica is quiet.

  /**
   * Run one self-heal pass: reconcile concurrency counters against live Redis
   * locks, then fail stuck active calls. Best-effort and never throws.
   * Returns true if anything was actually healed/swept (used to keep the poll
   * armed while there is still drift to clear). Reentrancy-guarded so the
   * startup pass and a poll tick can't overlap.
   *
   * PORT NOTE: core also ran `sweepOrphanedQueuedCalls` (SQS backlog) and
   * `reconcileLiveCallGauges` (static/IVR gauges) here; neither exists.
   */
  async runSelfHealSweep(reason: 'startup' | 'periodic'): Promise<boolean> {
    if (this.shuttingDown || this.selfHealing) return false;
    this.selfHealing = true;
    try {
      const reconciled = await this.reconcileConcurrency(reason);
      const swept = await this.sweepStaleActiveCalls(reason);
      return reconciled || swept;
    } finally {
      this.selfHealing = false;
    }
  }

  /**
   * Wake the demand-driven self-heal poller. Idempotent; resets the idle counter
   * so a fresh call always restores the full dormancy window. Called on startup
   * and on every call end. No-op while shutting down. The timer is unref'd
   * (never holds the process open) and goes dormant on its own when idle.
   */
  wakeSelfHeal(): void {
    this.selfHealEmptySweeps = 0;
    if (this.selfHealTimer || this.shuttingDown) return;
    this.armSelfHealTimer();
  }

  private armSelfHealTimer(): void {
    if (this.selfHealTimer || this.shuttingDown) return;
    this.selfHealTimer = setTimeout(() => { this.runSelfHealPoll(); }, config.concurrency.reconcileIntervalMs);
    this.selfHealTimer.unref?.();
  }

  /**
   * One poll tick. Runs a sweep, then decides whether to re-arm: the loop stays
   * alive while it's healing drift OR this replica still has active calls, and
   * only goes dormant after {@link SELF_HEAL_EMPTY_SWEEPS_BEFORE_DORMANT}
   * consecutive sweeps that found nothing with zero active calls — i.e. truly
   * idle. (Clearing the timer ref at entry lets `wakeSelfHeal` re-arm mid-run.)
   */
  private runSelfHealPoll(): void {
    this.selfHealTimer = null;
    if (this.shuttingDown) return;

    // ── One poll body at a time, or `selfHealInFlight` stops meaning anything ──
    //
    // This method nulls its own timer at entry, so `wakeSelfHeal` re-arms freely
    // while a sweep is running and the next tick can land mid-sweep. Assigning
    // `selfHealInFlight` unconditionally then OVERWROTE the running poll's
    // promise with the new one — and the new body returns almost immediately
    // (`runSelfHealSweep` refuses re-entry via `selfHealing` and answers false),
    // so its `.finally` nulled the field while the real sweep was still going.
    // `gracefulShutdown` then waited for nothing, which is precisely the hole
    // the field was added to close.
    //
    // Refusing the tick is safe because the running body re-arms the timer
    // itself when it finishes, and `wakeSelfHeal` has already reset
    // `selfHealEmptySweeps` to 0 — so activity during a sweep cannot make that
    // body go dormant. Re-arming here as well keeps the cadence honest if the
    // sweep outlives several intervals.
    if (this.selfHealInFlight) {
      this.armSelfHealTimer();
      return;
    }

    this.selfHealInFlight = (async () => {
      let didWork = false;
      try {
        didWork = await this.runSelfHealSweep('periodic');
      } catch (err) {
        log.error({ err }, 'Self-heal sweep failed');
      }

      // "Idle" = nothing to heal AND no calls in flight on this replica. Anything
      // else resets the cooldown and keeps the loop armed.
      // PORT NOTE: core also OR'd `liveCallGaugeIdCount() > 0` (static/IVR gauges).
      if (didWork || this.getActiveCallCount() > 0) {
        this.selfHealEmptySweeps = 0;
      } else {
        this.selfHealEmptySweeps++;
      }

      if (this.shuttingDown) return;
      if (this.selfHealEmptySweeps < this.sweepsBeforeDormant) {
        this.armSelfHealTimer();
      } else {
        log.debug('Self-heal poll idle — going dormant until next call activity');
      }
    })().finally(() => { this.selfHealInFlight = null; });
  }

  /**
   * Reconcile global + all per-account concurrency counters against the live
   * Redis lock keys, healing drift left by crashes. Returns true if drift was
   * healed. No-op (returns false) in Redis-degraded/local mode.
   *
   * PORT NOTE: core kicked `this.triggerDequeue()` on heal (its AI SQS queue);
   * there is no queue here.
   */
  async reconcileConcurrency(reason: 'startup' | 'periodic'): Promise<boolean> {
    try {
      const globalResult = await this.concurrencyGuard.reconcile();
      const accountResult = await this.accountConcurrencyGuard.reconcileAll();
      const providerResult = await this.providerConcurrencyGuard.reconcileAll();
      const healed = globalResult.before !== globalResult.after
        || accountResult.accountsReconciled > 0
        || providerResult.providersReconciled > 0;
      if (healed) {
        log.warn(
          { reason, global: globalResult, account: accountResult, provider: providerResult },
          'Concurrency counters reconciled — healed crash drift',
        );
      } else {
        log.debug({ reason }, 'Concurrency reconcile: no drift');
      }
      return healed;
    } catch (err) {
      log.error({ err, reason }, 'Concurrency reconcile failed');
      return false;
    }
  }

  /**
   * Register the provider for the WebRTC bridge's in-memory active call ids, so
   * the stale-call sweep can exclude calls this replica is actively bridging.
   * Called once at startup from the voice bootstrap.
   */
  registerWebrtcActiveIdsProvider(fn: () => string[]): void {
    this.getActiveWebrtcCallIds = fn;
  }

  /**
   * Mark WebRTC bridge calls stranded in an active in-flight state as `failed`
   * (error_code `STUCK_ACTIVE_CALL`). Only rows older than the configured sweep
   * window — floored at the longest supported WebRTC call plus callback grace —
   * are touched, and live in-memory calls are excluded. Returns true if anything
   * was recovered.
   *
   * PORT NOTE: core swept five sources in one `Promise.all` (AI voice, static,
   * IVR, WebRTC, transferred calls); only the WebRTC source exists here, so its
   * cutoff arithmetic is the only one carried.
   */
  async sweepStaleActiveCalls(reason: 'startup' | 'periodic'): Promise<boolean> {
    const now = Date.now();
    const configuredWindowMs = config.concurrency.staleCallSweepMinutes * 60_000;
    // IVR workflows allow 60 minutes and WebRTC feature flags allow 4 hours.
    // Never let a shorter generic stale window become an accidental hard cap.
    const webrtcCutoff = new Date(now - Math.max(
      configuredWindowMs,
      WEBRTC_MAX_DURATION_SECONDS * 1000 + TERMINAL_CALLBACK_GRACE_MS,
    ));
    // WebRTC human-bridge calls — no batch concept, so a dedicated sweep (the
    // generic sweepStaleRows is batch-oriented). Excludes calls this replica is
    // actively bridging in memory; the age threshold guards live calls elsewhere.
    return this.sweepStaleWebrtcCalls(reason, webrtcCutoff, this.getActiveWebrtcCallIds());
  }

  /**
   * Fail stuck WebRTC bridge calls. Separate from core's `sweepStaleRows` because
   * WebRTC calls have no batch_id / batch-completion path. Best-effort: a failing
   * query is logged and treated as "nothing recovered".
   *
   * PORT NOTE: core then settled each swept row (`dispatchSettlementsBounded`,
   * call_type `webrtc_call`, with the agency discriminator) so master released its
   * credit. Agency has no billing (plan §4, decision S6); the row itself carries the
   * usage facts for metering later.
   */
  private async sweepStaleWebrtcCalls(
    reason: 'startup' | 'periodic',
    cutoff: Date,
    excludeIds: string[],
  ): Promise<boolean> {
    let stale;
    try {
      stale = await agencyCallRepository.failStaleActive(cutoff, excludeIds);
    } catch (err) {
      log.error({ err, reason }, 'WebRTC stale-call sweep failed');
      return false;
    }
    if (stale.length === 0) return false;

    log.warn(
      { reason, count: stale.length },
      'Stale-row sweep: failed stuck WebRTC calls (STUCK_ACTIVE_CALL)',
    );

    for (const row of stale) {
      auditLogger.log({
        callId: row.id,
        tenantId: row.tenant_id,
        accountId: row.account_id,
        eventType: 'call.failed',
        eventCategory: 'call',
        severity: 'warn',
        eventData: { errorCode: 'STUCK_ACTIVE_CALL', reason: 'stuck active call', sweep: reason, dispatchType: 'webrtc_call' },
      });
    }
    return true;
  }

  /**
   * Stop the self-heal poll and wait (bounded) for a sweep already in flight.
   *
   * PORT NOTE: the self-heal half of core's `CallManager.gracefulShutdown`. Core
   * also stopped the SQS coordinator and the group refiller, drained AI calls, and
   * on a timed-out sweep called `noteUnfinishedFanoutProducer` so the settlement
   * fan-out drain would not report all-clear — there is no fan-out here, so the
   * expiry is logged only.
   */
  async gracefulShutdown(): Promise<void> {
    this.shuttingDown = true;
    if (this.selfHealTimer) {
      clearTimeout(this.selfHealTimer);
      this.selfHealTimer = null;
    }
    // Clearing the timer only prevents the NEXT tick. A poll already running has
    // no timer left to clear (it nulls the handle at entry), so shutdown has to
    // wait for the body itself. BOUNDED, because this sits in front of closing the
    // pool. See {@link SELF_HEAL_SHUTDOWN_WAIT_MS}.
    if (this.selfHealInFlight) {
      log.info({ waitMs: SELF_HEAL_SHUTDOWN_WAIT_MS }, 'Waiting for the in-flight self-heal sweep before shutdown');
      let timer: ReturnType<typeof setTimeout> | undefined;
      const expired = await Promise.race([
        this.selfHealInFlight.then(() => false, () => false),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(true), SELF_HEAL_SHUTDOWN_WAIT_MS);
          timer.unref?.();
        }),
      ]);
      if (timer) clearTimeout(timer);
      if (expired) {
        log.error(
          { waitMs: SELF_HEAL_SHUTDOWN_WAIT_MS },
          'Self-heal sweep did not finish within the shutdown budget — proceeding without it',
        );
      }
    }
  }
}
