/**
 * An analysis worker process (`ANALYSIS_WORKERS > 0`, `docs/scaling.md` §1.3): the
 * dialer-analysis slot pool and nothing else, wired to its parent over IPC.
 *
 *  - `analysis.wake` from the primary (a call ended, a recording arrived) fills free
 *    slots, as `getDialerAnalysisWorker().wake()` does in a single process.
 *  - **One vendor rate limit pauses every analysis process (D10).** This process's
 *    breaker announces each opening as `analysis.rate_paused`; the primary relays it to
 *    the others, which apply it with `VendorRateLimitBreaker.applyRemotePause`. Over IPC
 *    through the primary, never Redis.
 *  - `health.ping` reports slots in use and the pause left; `shutdown` stops claims and
 *    requeues this process's in-flight jobs, generation-matched, exactly as the
 *    in-process worker's graceful shutdown does.
 *
 * {@link startAnalysisChild} is the wiring, with its dependencies injected, so the
 * process entry (`analysis-child-main.ts`) and the multi-process tests run the same code.
 */
import { performance } from 'node:perf_hooks';
import { createChildLogger } from '@magick-agency/observability';
import type { Transcriber } from '../transcription/types.js';
import type { PostCallAnalysisService } from '../analysis/index.js';
import type { DialerAnalysisConfig } from '../core/dialer-analysis-runner.js';
import { initDialerAnalysisWorker, type DialerAnalysisWorker } from '../core/dialer-analysis-worker.js';
import { setDialerAnalysisWorker } from '../core/dialer-analysis-worker-handle.js';
import { VendorRateLimitBreaker } from '../core/vendor-rate-limit-breaker.js';
import type { IpcChannel } from './ipc-channel.js';
import type { HealthBody } from './ipc-protocol.js';

const log = createChildLogger({ component: 'analysis-child' });

export interface AnalysisChildDeps {
  slot: number;
  channel: IpcChannel;
  transcriber: Transcriber;
  analysisService: PostCallAnalysisService;
  config: DialerAnalysisConfig;
  recordingHosts: readonly string[];
  /** Tests only: the breaker, so its clock can be driven. */
  breaker?: VendorRateLimitBreaker;
}

export interface AnalysisChild {
  readonly worker: DialerAnalysisWorker;
  readonly breaker: VendorRateLimitBreaker;
  /** Stop claiming and requeue every job this process holds. Idempotent. */
  shutdown(): Promise<void>;
  health(): HealthBody;
}

export function startAnalysisChild(deps: AnalysisChildDeps): AnalysisChild {
  const { slot, channel } = deps;
  const breaker = deps.breaker ?? new VendorRateLimitBreaker();
  // Registered before the worker's own listener (metric, log), and only ever told about
  // THIS process's openings: a remote pause applied below does not call listeners, so a
  // pause is never echoed back round the fleet.
  breaker.onOpenListener((pauseMs, consecutive) => {
    channel.emit('analysis.rate_paused', { untilMs: Date.now() + pauseMs, consecutive });
  });
  const worker = initDialerAnalysisWorker({
    transcriber: deps.transcriber,
    analysisService: deps.analysisService,
    config: deps.config,
    recordingHosts: deps.recordingHosts,
    breaker,
  });

  let draining = false;
  let shuttingDown: Promise<void> | null = null;
  let lastElu = performance.eventLoopUtilization();

  channel.onEvent('analysis.wake', () => { if (!draining) worker.wake(); });
  channel.onEvent('analysis.rate_paused', ({ untilMs, consecutive }) => {
    breaker.applyRemotePause(untilMs, consecutive);
    log.info({ slot, pausedForMs: Math.max(0, untilMs - Date.now()), consecutive },
      'Another analysis process was rate-limited by the AI vendor; pausing claims here too');
  });

  const health = (): HealthBody => {
    const elu = performance.eventLoopUtilization(lastElu);
    lastElu = performance.eventLoopUtilization();
    return {
      role: 'analysis', slot, pid: process.pid,
      elu: Math.min(1, Math.max(0, Number(elu.utilization.toFixed(4)) || 0)),
      inFlight: worker.inFlightCount,
      pausedForMs: Math.max(0, Math.round(breaker.reopensInMs())),
      draining,
    };
  };
  channel.handle('health.ping', health);

  const shutdown = (): Promise<void> => {
    if (shuttingDown) return shuttingDown;
    draining = true;
    shuttingDown = worker.gracefulShutdown().finally(() => setDialerAnalysisWorker(null));
    return shuttingDown;
  };

  // Anything the queue gathered while no process was serving it (a restart, a boot).
  worker.wake();
  channel.emit('ready', { role: 'analysis', slot, pid: process.pid });
  log.info({ slot, slots: deps.config.concurrency }, 'Analysis worker process ready');
  return { worker, breaker, shutdown, health };
}
