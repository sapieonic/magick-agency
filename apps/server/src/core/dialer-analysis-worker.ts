/*
 * The promote -> expire -> claim -> recover loop, plus a slot pool that keeps up to
 * `concurrency` jobs in flight between sweeps. There is no settle step (no billing in
 * v1, decision S6). `recordingHosts` is threaded to the runner.
 */
import type { Transcriber } from '../transcription/types.js';
import type { PostCallAnalysisService } from '../analysis/index.js';
import { dialerAnalysisJobRepository } from '@magick-agency/db/repositories/dialer-analysis-job.repository';
import type { DialerAnalysisJobRecord } from '@magick-agency/db/models/dialer-analysis-job.model';
import {
  DialerAnalysisRunner,
  type DialerAnalysisConfig,
  type DialerAnalysisOutcome,
} from './dialer-analysis-runner.js';
import { setDialerAnalysisWorker, type DialerAnalysisWorkerHandle } from './dialer-analysis-worker-handle.js';
import { RecordingByteBudget, type RecordingLease } from './recording-byte-budget.js';
import { VendorRateLimitBreaker } from './vendor-rate-limit-breaker.js';
import { DEFAULT_DIALER_ANALYSIS_MEMORY_BUDGET_BYTES, RECORDING_COPIES } from '../config/blocks/analysis.js';
import {
  setDialerAnalysisQueueDepth,
  setDialerAnalysisSlots,
  setDialerAnalysisMemoryReserved,
  dialerAnalysisBudgetWaitsTotal,
  dialerAnalysisRateLimitPausesTotal,
} from '@magick-agency/observability/metrics/analysis';
import { createChildLogger } from '@magick-agency/observability';

const log = createChildLogger({ component: 'dialer-analysis-worker' });

/** Consecutive fully-idle sweeps before the poll disarms itself. */
const DEFAULT_EMPTY_SWEEPS_BEFORE_DORMANT = 2;

/**
 * Floor for the next-runnable timer. A claim that comes back short while a job is
 * already due (its row locked by another process's claim for a moment) must not spin.
 */
const MIN_REFILL_DELAY_MS = 1000;

export interface DialerAnalysisWorkerOptions {
  transcriber: Transcriber;
  analysisService: PostCallAnalysisService;
  config: DialerAnalysisConfig;
  /** VoiceLink recording hosts the runner's fetch may touch (see `DialerAnalysisRunnerDeps`). */
  recordingHosts?: readonly string[];
  /** Poll interval when armed. */
  pollIntervalMs?: number;
  /** Consecutive idle sweeps before disarming (default 2). */
  emptySweepsBeforeDormant?: number;
  /** The shared rate-limit breaker; injectable so tests can drive its clock. */
  breaker?: VendorRateLimitBreaker;
}

/**
 * Demand-driven, self-dormant background worker for dialer-call analysis.
 *
 * **Slot pool.** Up to `concurrency` jobs run at once, each in its own slot. When a job
 * finishes, its slot claims the next runnable job straight away; nothing waits for the
 * next poll or for the other slots. A claim that comes back short asks the database
 * when the next queued job becomes due (a settle delay or a backoff) and arms a timer
 * for it. `wake()` (a call ended with its recording, or a recording arrived) fills free
 * slots at once. So throughput is slots ÷ job time, not slots per poll interval.
 *
 * **Bounds.** Before a slot claims, it reserves the worst-case recording size on the
 * {@link RecordingByteBudget} (`DIALER_ANALYSIS_MEMORY_BUDGET_BYTES`); the runner shrinks
 * the reservation to the real size once the recording is fetched. A slot with no
 * budget waits for it without a claim, so it never holds a job it cannot start. The
 * {@link VendorRateLimitBreaker} stops claims while an AI vendor is rate-limiting.
 *
 * **Poll.** `wake()` arms an `unref()`'d poll and resets the empty-sweep counter; the
 * poll disarms after N consecutive fully-idle sweeps so no timer ticks on a quiet
 * replica. Each sweep, IN ORDER: (1) promote awaiting→queued where the recording now
 * exists (before expiry, so a lost-wake job is rescued rather than expired); (2) expire
 * awaiting rows older than the wait window; (3) fill free slots (claims and starts jobs,
 * does not wait for them); (4) recover stale in-flight jobs (crashed owner) without
 * using an attempt. A sweep that promotes/expires/claims/recovers nothing, finds an
 * empty queue AND has nothing in flight counts toward dormancy. `sweepOnce` is
 * reentrancy-guarded and never throws.
 *
 * **Shutdown.** `gracefulShutdown()` stops new claims first (no slot fills after it),
 * lets a claim already on its way to the database land, then re-queues every job this
 * process holds, generation-matched.
 *
 * Claims use `FOR UPDATE SKIP LOCKED`, so several processes can share the queue; each
 * has its own slots, budget and breaker. It registers itself through the worker handle
 * so the bridge's analysis hooks can wake it.
 */
export class DialerAnalysisWorker implements DialerAnalysisWorkerHandle {
  private readonly runner: DialerAnalysisRunner;
  private readonly cfg: DialerAnalysisConfig;
  private readonly pollIntervalMs: number;
  private readonly emptySweepsBeforeDormant: number;
  private readonly slots: number;
  private readonly budget: RecordingByteBudget;
  /** What a slot reserves before it claims: one worst-case recording. */
  private readonly reserveBytes: number;
  private readonly breaker: VendorRateLimitBreaker;

  private timer: NodeJS.Timeout | null = null;
  private emptySweeps = 0;
  private sweeping = false;
  private stopped = false;

  /** This replica's in-flight claims, for graceful-shutdown requeue (id → generation). */
  private readonly inFlight = new Map<string, number>();
  /** Slots in use: jobs started and not yet finished. */
  private active = 0;
  /** The promise of each running job, for `idle()`. */
  private readonly running = new Set<Promise<void>>();

  /** The fill loop, while one runs; `requestFill` joins it rather than starting another. */
  private filling: Promise<number> | null = null;
  private fillRequested = false;
  /** One-shot timer for the next known moment a fill can do something (earliest wins). */
  private fillTimer: NodeJS.Timeout | null = null;
  private fillTimerAt = 0;
  /** A budget reservation in progress for the next free slot, and the leases it won. */
  private budgetWait: Promise<void> | null = null;
  private readonly granted: RecordingLease[] = [];

  constructor(opts: DialerAnalysisWorkerOptions) {
    this.cfg = opts.config;
    this.pollIntervalMs = opts.pollIntervalMs ?? opts.config.pollIntervalMs;
    this.emptySweepsBeforeDormant = opts.emptySweepsBeforeDormant ?? DEFAULT_EMPTY_SWEEPS_BEFORE_DORMANT;
    this.slots = Math.max(1, opts.config.concurrency);
    this.budget = new RecordingByteBudget(opts.config.memoryBudgetBytes ?? DEFAULT_DIALER_ANALYSIS_MEMORY_BUDGET_BYTES, {
      onReservedChange: (bytes) => setDialerAnalysisMemoryReserved(bytes),
      onWait: () => dialerAnalysisBudgetWaitsTotal.inc(),
    });
    this.reserveBytes = this.budget.clamp(opts.config.maxRecordingBytes * RECORDING_COPIES);
    this.breaker = opts.breaker ?? new VendorRateLimitBreaker();
    this.breaker.onOpenListener((pauseMs, consecutive) => {
      dialerAnalysisRateLimitPausesTotal.inc();
      log.warn({ pauseMs, consecutive }, 'AI vendor rate-limited dialer analysis; pausing new claims');
    });
    this.runner = new DialerAnalysisRunner({
      transcriber: opts.transcriber,
      analysisService: opts.analysisService,
      config: opts.config,
      ...(opts.recordingHosts ? { recordingHosts: opts.recordingHosts } : {}),
    });
  }

  /** Arm the poll if dormant, reset the empty-sweep counter, and fill free slots now. */
  wake(): void {
    if (this.stopped) return;
    this.emptySweeps = 0;
    void this.requestFill();
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.runScheduledSweep();
    }, this.pollIntervalMs);
    this.timer.unref?.();
  }

  /** Stop the poll (graceful shutdown / dormancy). Running jobs and a pending refill are untouched. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  isArmed(): boolean {
    return this.timer !== null;
  }

  /** Jobs running in this process. */
  get inFlightCount(): number {
    return this.active;
  }

  /**
   * Resolves once no job is running and no fill is in progress. For tests and
   * one-off drains; the worker itself never waits on it.
   */
  async idle(): Promise<void> {
    while (this.running.size > 0 || this.filling) {
      await Promise.allSettled([...this.running, ...(this.filling ? [this.filling] : [])]);
    }
  }

  /**
   * Graceful shutdown: stop starting jobs, then re-queue this replica's in-flight
   * claimed jobs (decrementing `attempts` so a deploy costs nothing). Generation-matched,
   * so a job already recovered elsewhere is left alone. Call from the SIGTERM handler.
   */
  async gracefulShutdown(): Promise<void> {
    // 1. No new work: every fill path checks `stopped`, a finishing job no longer refills.
    this.stopped = true;
    this.stop();
    this.clearFillTimer();
    // 2. A claim already sent to the database lands in `inFlight` (and is not started);
    //    wait for it so its rows are re-queued below rather than left to the stale sweep.
    if (this.filling) await this.filling.catch(() => 0);
    for (const lease of this.granted.splice(0)) lease.release();
    // 3. Re-queue everything this process holds.
    const claims = Array.from(this.inFlight, ([id, generation]) => ({ id, generation }));
    this.inFlight.clear();
    if (claims.length === 0) return;
    try {
      const requeued = await dialerAnalysisJobRepository.gracefulRequeue(claims);
      log.info({ requeued, claimed: claims.length }, 'Re-queued in-flight dialer analysis jobs for shutdown');
    } catch (err) {
      log.error({ err }, 'Failed to gracefully re-queue in-flight dialer analysis jobs');
    }
  }

  private async runScheduledSweep(): Promise<void> {
    const acted = await this.sweepOnce();
    if (acted) {
      this.emptySweeps = 0;
      return;
    }
    this.emptySweeps++;
    if (this.emptySweeps >= this.emptySweepsBeforeDormant) {
      this.stop();
    }
  }

  /**
   * One sweep. Returns true when it acted on anything (promotion/expiry/claim/
   * recovery), the queue is non-empty, or a job is still running: any of them keeps
   * the poll armed. Never throws; a step's failure is logged and the sweep continues.
   * It does not wait for the jobs it starts (`idle()` does).
   */
  async sweepOnce(): Promise<boolean> {
    // A tick that overlaps a slow sweep means "busy", not "idle".
    if (this.sweeping) return true;
    this.sweeping = true;
    let acted = false;
    let queueNonEmpty = false;
    try {
      // 1. Promote awaiting → queued where the recording now exists. BEFORE expiry.
      acted = (await this.step('promote', () => dialerAnalysisJobRepository.promoteRecordingReady(this.cfg.settleSeconds))) > 0 || acted;

      // 2. Expire awaiting rows the carrier never delivered a recording for.
      const expireBefore = new Date(Date.now() - this.cfg.recordingWaitMinutes * 60_000);
      acted = (await this.step('expire', async () => (await dialerAnalysisJobRepository.expireAwaitingRecording(expireBefore)).length)) > 0 || acted;

      // 3. Fill free slots. A short claim arms a timer for the next due job, which is
      //    how a just-promoted job (settle delay) starts on time.
      acted = (await this.step('claim', () => this.requestFill())) > 0 || acted;

      // 4. Recover stale in-flight jobs (owning process died); doesn't burn an attempt.
      acted = (await this.step('recover', () => this.recoverStale())) > 0 || acted;

      // Feed the gauges + decide whether the queue still has backlog (keeps the poll armed).
      queueNonEmpty = await this.publishGauges();
    } catch (err) {
      log.warn({ err }, 'Dialer analysis sweep failed');
    } finally {
      this.sweeping = false;
    }
    return acted || queueNonEmpty || this.active > 0;
  }

  /** Run one sweep step, isolating failures so the rest of the sweep still runs. */
  private async step(name: string, fn: () => Promise<number>): Promise<number> {
    try {
      return await fn();
    } catch (err) {
      log.warn({ err, step: name }, 'Dialer analysis sweep step failed');
      return 0;
    }
  }

  // ── Slot pool ────────────────────────────────────────────────────────────

  /**
   * Fill free slots; resolves with the number of jobs started. Calls while a fill runs
   * join it and make it go round once more, so a request is never lost and two fills
   * never claim at once. Rejects only with the claim's own error (the sweep logs it).
   */
  private requestFill(): Promise<number> {
    this.fillRequested = true;
    if (!this.filling) {
      this.filling = this.fillLoop();
      // Handled by whoever awaits it; this keeps a fire-and-forget caller from leaking a rejection.
      this.filling.catch((err) => log.warn({ err }, 'Dialer analysis slot fill failed'));
    }
    return this.filling;
  }

  private async fillLoop(): Promise<number> {
    let started = 0;
    try {
      // The check and the `finally` run in the same turn: a request made after the last
      // check sees `filling` null and starts a new loop.
      while (this.fillRequested && !this.stopped) {
        this.fillRequested = false;
        started += await this.fillOnce();
      }
    } finally {
      this.filling = null;
    }
    return started;
  }

  /** One pass: claim as many jobs as free slots, breaker and budget allow, and start them. */
  private async fillOnce(): Promise<number> {
    const free = this.slots - this.active;
    if (this.stopped || free <= 0) return 0; // a finishing job asks again

    const admitted = this.breaker.admit(free);
    if (admitted === 0) {
      // Paused: come back when the pause ends. (A half-open probe in flight asks again when it finishes.)
      const wait = this.breaker.reopensInMs();
      if (wait > 0) this.scheduleFill(wait);
      return 0;
    }

    const leases = this.takeLeases(admitted);
    if (leases.length === 0) {
      this.waitForBudget();
      return 0;
    }

    const asked = leases.length;
    let claimed: DialerAnalysisJobRecord[];
    try {
      claimed = await dialerAnalysisJobRepository.claimRunnable(asked);
    } catch (err) {
      for (const lease of leases) lease.release();
      throw err;
    }
    for (const lease of leases.splice(claimed.length)) lease.release();

    if (this.stopped) {
      // Shutdown began while the claim was in flight: hand the rows to its requeue, start nothing.
      for (const job of claimed) this.inFlight.set(job.id, job.claim_generation);
      for (const lease of leases) lease.release();
      return 0;
    }

    const probe = this.breaker.onStarted(claimed.length);
    claimed.forEach((job, i) => this.startJob(job, leases[i]!, probe));

    if (claimed.length < asked) {
      // Nothing more is runnable now: come back when the next queued job is due.
      await this.armNextRunnable();
    } else if (asked < admitted) {
      // The budget, not the queue, held the slots back: wait for it without a claim.
      this.waitForBudget();
    }
    return claimed.length;
  }

  /**
   * After a short claim: arm a fill for when the next queued job becomes due, if that
   * is sooner than the poll. Catches a settle delay or a backoff on time. Never throws.
   */
  private async armNextRunnable(): Promise<void> {
    try {
      const ms = await dialerAnalysisJobRepository.msUntilNextRunnable();
      if (ms === null || ms > this.pollIntervalMs) return;
      this.scheduleFill(Math.max(ms, MIN_REFILL_DELAY_MS));
    } catch (err) {
      log.warn({ err }, 'Failed to read when the next dialer analysis job is due');
    }
  }

  /** Leases for up to `n` slots: those a budget wait already won, then whatever is free now. */
  private takeLeases(n: number): RecordingLease[] {
    const leases = this.granted.splice(0, n);
    while (leases.length < n) {
      const lease = this.budget.tryAcquire(this.reserveBytes);
      if (!lease) break;
      leases.push(lease);
    }
    return leases;
  }

  /** Wait (in the background, holding no claim) for budget for one more slot, then fill. */
  private waitForBudget(): void {
    if (this.budgetWait || this.stopped) return;
    this.budgetWait = this.budget.acquire(this.reserveBytes).then((lease) => {
      this.budgetWait = null;
      if (this.stopped) {
        lease.release();
        return;
      }
      this.granted.push(lease);
      void this.requestFill();
    });
  }

  private startJob(job: DialerAnalysisJobRecord, lease: RecordingLease, probe: boolean): void {
    this.active++;
    this.inFlight.set(job.id, job.claim_generation);
    this.publishSlots();
    const done = this.runJob(job, lease, probe);
    this.running.add(done);
    void done.finally(() => this.running.delete(done));
  }

  /** One slot's run; never rejects. Frees the slot and refills it when the job ends. */
  private async runJob(job: DialerAnalysisJobRecord, lease: RecordingLease, probe: boolean): Promise<void> {
    const startedAt = Date.now();
    let outcome: DialerAnalysisOutcome | undefined;
    try {
      outcome = await this.runner.run(job, {
        lease,
        onRateLimited: () => this.breaker.recordRateLimit(startedAt),
      });
    } catch (err) {
      // `run` never throws; this only keeps a broken promise from wedging the slot.
      log.error({ err, jobId: job.id }, 'Dialer analysis run threw');
    } finally {
      lease.release();
      // Only this claim's entry: a recovered-and-reclaimed job may hold a newer generation.
      if (this.inFlight.get(job.id) === job.claim_generation) this.inFlight.delete(job.id);
      this.active--;
      this.breaker.onFinished(probe);
      if (outcome === 'completed') this.breaker.recordSuccess(startedAt);
      this.publishSlots();
      // The slot is free: take the next job now, not at the next poll.
      if (!this.stopped) void this.requestFill();
    }
  }

  private publishSlots(): void {
    setDialerAnalysisSlots(this.active, this.slots);
  }

  /** Fill again in `delayMs`, unless a fill is already due sooner. */
  private scheduleFill(delayMs: number): void {
    if (this.stopped) return;
    const at = Date.now() + delayMs;
    if (this.fillTimer && this.fillTimerAt <= at) return;
    this.clearFillTimer();
    this.fillTimerAt = at;
    this.fillTimer = setTimeout(() => {
      this.fillTimer = null;
      void this.requestFill();
    }, delayMs);
    this.fillTimer.unref?.();
  }

  private clearFillTimer(): void {
    if (this.fillTimer) {
      clearTimeout(this.fillTimer);
      this.fillTimer = null;
    }
  }

  // ── Sweep steps ──────────────────────────────────────────────────────────

  private async recoverStale(): Promise<number> {
    // A healthy job heartbeats every window; a genuinely dead one goes silent. The
    // staleness threshold must comfortably exceed one window's timeout so a slow-but-
    // -alive window isn't torn from under a live runner.
    const staleThresholdMs = Math.max(this.cfg.transcribeTimeoutMs * 3, 5 * 60_000);
    const staleBefore = new Date(Date.now() - staleThresholdMs);
    const recovered = await dialerAnalysisJobRepository.recoverStale(staleBefore, this.cfg.maxAttemptsTotal);
    if (recovered.length > 0) {
      log.warn({ count: recovered.length }, 'Recovered stale in-flight dialer analysis jobs');
    }
    return recovered.length;
  }

  /** Publish the backlog gauge; return whether the queue is non-empty. */
  private async publishGauges(): Promise<boolean> {
    this.publishSlots();
    let backlog = false;
    try {
      const depths = await dialerAnalysisJobRepository.queueDepthByStatus();
      const seen = new Map(depths.map((d) => [d.status, d.count]));
      // Zero out statuses no longer present so a stale series doesn't linger.
      for (const status of ['awaiting_recording', 'queued', 'transcribing', 'analyzing', 'completed', 'failed', 'skipped', 'expired']) {
        setDialerAnalysisQueueDepth(status, seen.get(status) ?? 0);
      }
      // Active backlog that keeps the poll armed: anything not yet terminal.
      backlog = (['awaiting_recording', 'queued', 'transcribing', 'analyzing'] as const)
        .some((s) => (seen.get(s) ?? 0) > 0);
    } catch (err) {
      log.warn({ err }, 'Failed to publish dialer analysis queue-depth gauge');
    }
    return backlog;
  }
}

/** Construct + register the worker so wake-on-demand callers reach it. */
export function initDialerAnalysisWorker(opts: DialerAnalysisWorkerOptions): DialerAnalysisWorker {
  const worker = new DialerAnalysisWorker(opts);
  setDialerAnalysisWorker(worker);
  return worker;
}
