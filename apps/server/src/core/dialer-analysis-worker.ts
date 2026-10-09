/*
 * PORT NOTE (magick-agency): ported from core `src/core/dialer-analysis-worker.ts`
 * (v1.123.2). The settle step (`settlePending`, `settleOne`, the settlement
 * constants and the oldest-pending-settlement gauge) is removed (plan §4); the
 * promote -> expire -> claim -> recover loop is core's, verbatim. `recordingHosts`
 * is threaded to the runner (new, see the runner).
 */
import type { Transcriber } from '../transcription/types.js';
import type { PostCallAnalysisService } from '../analysis/index.js';
import { dialerAnalysisJobRepository } from '@magick-agency/db/repositories/dialer-analysis-job.repository';
import { DialerAnalysisRunner, type DialerAnalysisConfig } from './dialer-analysis-runner.js';
import { setDialerAnalysisWorker, type DialerAnalysisWorkerHandle } from './dialer-analysis-worker-handle.js';
import { setDialerAnalysisQueueDepth } from '@magick-agency/observability/metrics/analysis';
import { createChildLogger } from '@magick-agency/observability';

const log = createChildLogger({ component: 'dialer-analysis-worker' });

/** Consecutive fully-idle sweeps before the poll disarms itself. */
const DEFAULT_EMPTY_SWEEPS_BEFORE_DORMANT = 2;

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
}

/**
 * Demand-driven, self-dormant background worker for dialer-call analysis. Mirrors
 * `KbIngestRecovery` exactly: `wake()` arms an `unref()`'d poll and resets the
 * empty-sweep counter; the poll disarms after N consecutive fully-idle sweeps so
 * no timer ticks on a quiet replica; `sweepOnce` is reentrancy-guarded and never
 * throws. It registers itself through the pre-existing worker handle so the retry
 * route + recording webhook can wake it.
 *
 * Each tick, IN ORDER (§7): (1) promote awaiting→queued where the recording now
 * exists (B1 — before expiry, so a lost-wake job is rescued rather than expired);
 * (2) expire awaiting rows older than the wait window; (3) claim + run up to
 * `concurrency` runnable jobs; (4) recover stale in-flight jobs (crashed owner). A sweep
 * that promotes/expires/claims/recovers nothing AND finds an empty queue
 * counts toward dormancy; any action re-arms.
 */
export class DialerAnalysisWorker implements DialerAnalysisWorkerHandle {
  private readonly runner: DialerAnalysisRunner;
  private readonly cfg: DialerAnalysisConfig;
  private readonly pollIntervalMs: number;
  private readonly emptySweepsBeforeDormant: number;

  private timer: NodeJS.Timeout | null = null;
  private emptySweeps = 0;
  private sweeping = false;
  private stopped = false;

  /** This replica's in-flight claims, for graceful-shutdown requeue (id → generation). */
  private readonly inFlight = new Map<string, number>();

  constructor(opts: DialerAnalysisWorkerOptions) {
    this.cfg = opts.config;
    this.pollIntervalMs = opts.pollIntervalMs ?? opts.config.pollIntervalMs;
    this.emptySweepsBeforeDormant = opts.emptySweepsBeforeDormant ?? DEFAULT_EMPTY_SWEEPS_BEFORE_DORMANT;
    this.runner = new DialerAnalysisRunner({
      transcriber: opts.transcriber,
      analysisService: opts.analysisService,
      config: opts.config,
      ...(opts.recordingHosts ? { recordingHosts: opts.recordingHosts } : {}),
    });
  }

  /** Arm the poll if dormant; reset the empty-sweep counter. */
  wake(): void {
    if (this.stopped) return;
    this.emptySweeps = 0;
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.runScheduledSweep();
    }, this.pollIntervalMs);
    this.timer.unref?.();
  }

  /** Stop the poll (graceful shutdown / dormancy). */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  isArmed(): boolean {
    return this.timer !== null;
  }

  /**
   * Graceful shutdown: re-queue this replica's in-flight claimed jobs (decrementing
   * `attempts` so a deploy costs nothing) and stop the poll. Generation-matched, so
   * a job already recovered elsewhere is left alone. Call from the SIGTERM handler.
   */
  async gracefulShutdown(): Promise<void> {
    this.stopped = true;
    this.stop();
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
   * recovery) OR the queue is non-empty — either re-arms the poll. Never
   * throws; a step's failure is logged and the sweep continues.
   */
  async sweepOnce(): Promise<boolean> {
    // A scheduled tick that overlaps a long Gemini request means "busy", not
    // "idle". Returning false here used to count two long-running overlaps as two
    // empty sweeps, disarm the timer, and strand any retry queued by the active run.
    if (this.sweeping) return true;
    this.sweeping = true;
    let acted = false;
    let queueNonEmpty = false;
    try {
      // 1. Promote awaiting → queued where the recording now exists (B1). BEFORE expiry.
      acted = (await this.step('promote', () => dialerAnalysisJobRepository.promoteRecordingReady(this.cfg.settleSeconds))) > 0 || acted;

      // 2. Expire awaiting rows the carrier never delivered a recording for.
      const expireBefore = new Date(Date.now() - this.cfg.recordingWaitMinutes * 60_000);
      acted = (await this.step('expire', async () => (await dialerAnalysisJobRepository.expireAwaitingRecording(expireBefore)).length)) > 0 || acted;

      // 3. Claim + run up to `concurrency` runnable jobs.
      acted = (await this.step('claim', () => this.claimAndRun())) > 0 || acted;

      // 4. Recover stale in-flight jobs (owning process died) — M7 (doesn't burn an attempt).
      acted = (await this.step('recover', () => this.recoverStale())) > 0 || acted;

      // Feed the gauges + decide whether the queue still has backlog (keeps the poll armed).
      queueNonEmpty = await this.publishGauges();
    } catch (err) {
      log.warn({ err }, 'Dialer analysis sweep failed');
    } finally {
      this.sweeping = false;
    }
    return acted || queueNonEmpty;
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

  private async claimAndRun(): Promise<number> {
    const claimed = await dialerAnalysisJobRepository.claimRunnable(this.cfg.concurrency);
    if (claimed.length === 0) return 0;
    for (const job of claimed) this.inFlight.set(job.id, job.claim_generation);
    try {
      // Bounded by `concurrency` at claim time; run them together (each never throws).
      await Promise.all(claimed.map((job) => this.runner.run(job)));
    } finally {
      for (const job of claimed) this.inFlight.delete(job.id);
    }
    return claimed.length;
  }

  private async recoverStale(): Promise<number> {
    // A healthy job heartbeats every window; a genuinely dead one goes silent. The
    // staleness threshold must comfortably exceed one window's timeout so a slow-but-
    // -alive window isn't torn from under a live runner (M9).
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
