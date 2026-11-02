import type { AppContext } from '../app-context.js';
import { logger } from '@magick-agency/observability';
import { initDialerAnalysisWorker } from '../core/dialer-analysis-worker.js';
import { setDialerAnalysisWorker } from '../core/dialer-analysis-worker-handle.js';
import { createTranscriber } from '../transcription/index.js';
import { createAnalysisService } from '../analysis/index.js';
import { createBridgeAnalysisHooks } from '../analysis/bridge-analysis-hooks.js';
import { resetBridgeAnalysisHooks, setBridgeAnalysisHooks } from '../seams/bridge-analysis-hooks.js';
import { runRetentionPurge } from '../maintenance/retention-purge.js';
import type { ChildProcess } from 'node:child_process';
import type { ChildSupervisor } from '../cluster/child-supervisor.js';
import { createAnalysisChildren } from '../cluster/analysis-children.js';
import { analysisChildHeapMb, forkServerChild } from '../cluster/fork.js';

/**
 * The analysis background work (worker, retention purge timers). Returns a stop
 * function the process awaits on shutdown.
 *
 * The worker is only wired when DIALER_ANALYSIS_ENABLED and both a
 * transcriber and the analysis service are constructible — otherwise a total
 * no-op (the worker handle stays null and the bridge hooks stay the seam's no-op).
 */

/** Settle delay before the boot-time retention purge. */
export const BOOT_PURGE_DELAY_MS = 60_000;

/**
 * How long analysis children get to requeue their in-flight jobs and exit. A requeue is
 * one statement; the bound is for a claim already on its way to the database.
 */
export const ANALYSIS_CHILD_STOP_GRACE_MS = 15_000;

export interface StartAnalysisOptions {
  /** Tests: how an analysis child is forked. Default: this server's own entry (`cluster/fork.ts`). */
  forkChild?: (slot: number) => ChildProcess;
  childStopGraceMs?: number;
  readyTimeoutMs?: number;
}

let analysisChildren: ChildSupervisor | null = null;

/** The analysis children, while `ANALYSIS_WORKERS > 0` runs them; null otherwise. */
export function getAnalysisChildren(): ChildSupervisor | null {
  return analysisChildren;
}

type AnalysisDependencies = {
  transcriber: ReturnType<typeof createTranscriber>;
  analysisService: ReturnType<typeof createAnalysisService>;
};
/**
 * Built by {@link plannedAnalysisWorkers} at boot and handed to the next {@link startAnalysis}
 * for the same config, once, so the factories run (and log why analysis is off) once per boot.
 */
const plannedDependencies = new WeakMap<object, AnalysisDependencies>();

function buildAnalysisDependencies(config: AppContext['config']): AnalysisDependencies {
  return { transcriber: createTranscriber(config), analysisService: createAnalysisService(config) };
}

/**
 * How many analysis children {@link startAnalysis} will fork for this config: `ANALYSIS_WORKERS`
 * only when analysis is enabled AND its transcriber and analysis service can be built. The
 * primary's Postgres budget (D12, `cluster/db-connection-budget.ts`) counts these, so a
 * vendor misconfiguration that keeps analysis off cannot refuse a boot for pools never opened.
 */
export function plannedAnalysisWorkers(config: AppContext['config']): number {
  if (!config.dialerAnalysis?.enabled) return 0;
  const deps = buildAnalysisDependencies(config);
  plannedDependencies.set(config, deps);
  const { transcriber, analysisService } = deps;
  return transcriber && analysisService ? config.dialerAnalysis.processes : 0;
}

export async function startAnalysis(ctx: AppContext, opts: StartAnalysisOptions = {}): Promise<() => Promise<void>> {
  const { config } = ctx;
  const stops: Array<() => Promise<void>> = [];

  const planned = plannedDependencies.get(config);
  plannedDependencies.delete(config);
  const { transcriber, analysisService } = planned ?? buildAnalysisDependencies(config);
  const dialerAnalysis = config.dialerAnalysis?.enabled && transcriber && analysisService ? config.dialerAnalysis : null;
  const processes = dialerAnalysis?.processes ?? 0;

  if (dialerAnalysis && processes > 0) {
    // ANALYSIS_WORKERS > 0 (docs/scaling.md §1.3): the slots run in child processes and
    // this process runs none. It still enqueues (the bridge's hooks run here, beside the
    // bridge) and wakes the children; each child has its own slots, recording budget and
    // breaker, and one child's vendor rate limit is relayed to the others (D10).
    const children = createAnalysisChildren({
      count: processes,
      fork: opts.forkChild ?? ((slot) => forkServerChild({
        role: 'analysis', slot, heapMb: analysisChildHeapMb(dialerAnalysis.memoryBudgetBytes),
      })),
      ...(opts.readyTimeoutMs !== undefined ? { readyTimeoutMs: opts.readyTimeoutMs } : {}),
    });
    try {
      await children.start();
    } catch (err) {
      await children.stop(5_000).catch(() => {});
      throw err;
    }
    analysisChildren = children;
    setBridgeAnalysisHooks(createBridgeAnalysisHooks());
    setDialerAnalysisWorker({ wake: () => { children.broadcast('analysis.wake', {}); } });
    logger.info({ processes, slotsEach: dialerAnalysis.concurrency }, 'Dialer call-analysis worker processes started');
    stops.push(async () => {
      setDialerAnalysisWorker(null);
      resetBridgeAnalysisHooks();
      await children.stop(opts.childStopGraceMs ?? ANALYSIS_CHILD_STOP_GRACE_MS);
      if (analysisChildren === children) analysisChildren = null;
    });
  }

  const worker =
    dialerAnalysis && processes === 0 && transcriber && analysisService
      ? initDialerAnalysisWorker({
          transcriber,
          analysisService,
          config: dialerAnalysis,
          recordingHosts: config.voicelinkRecording.allowedHosts,
        })
      : null;

  if (worker) {
    // The seam: the bridge reaches analysis only through these hooks.
    setBridgeAnalysisHooks(createBridgeAnalysisHooks());
    // Wake once at startup to promote/expire/claim anything the recording
    // webhooks left while this process was down.
    worker.wake();
    logger.info('Dialer call-analysis worker enabled');
    stops.push(async () => {
      await worker.gracefulShutdown();
      setDialerAnalysisWorker(null);
      resetBridgeAnalysisHooks();
    });
  }

  // Retention: the agency purge. Runs only when a window is configured — which, since the
  // transcript window defaults to 30 days (Manas, 2026-10-09), is every parsed config.
  const { agencyRetentionDays, agencyTranscriptRetentionDays, purgeIntervalMs } = config.retention;
  if (agencyRetentionDays !== undefined || agencyTranscriptRetentionDays !== undefined) {
    const tick = (): void => {
      runRetentionPurge({ requestedBy: 'scheduler' }).catch((err) =>
        logger.error({ err }, 'Scheduled retention purge failed'));
    };
    const timer = setInterval(tick, purgeIntervalMs);
    timer.unref?.();
    // Also once shortly after boot: with only the interval, a process restarted more
    // often than the interval (a nightly redeploy) would never purge.
    const bootTimer = setTimeout(tick, BOOT_PURGE_DELAY_MS);
    bootTimer.unref?.();
    stops.push(async () => { clearTimeout(bootTimer); clearInterval(timer); });
    logger.info({ agencyRetentionDays, agencyTranscriptRetentionDays, purgeIntervalMs }, 'Retention purge scheduled');
  }

  return async () => {
    for (const stop of stops.reverse()) await stop();
  };
}
