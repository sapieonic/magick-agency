import type { AppContext } from '../app-context.js';
import { logger } from '@magick-agency/observability';
import { initDialerAnalysisWorker } from '../core/dialer-analysis-worker.js';
import { setDialerAnalysisWorker } from '../core/dialer-analysis-worker-handle.js';
import { createTranscriber } from '../transcription/index.js';
import { createAnalysisService } from '../analysis/index.js';
import { createBridgeAnalysisHooks } from '../analysis/bridge-analysis-hooks.js';
import { resetBridgeAnalysisHooks, setBridgeAnalysisHooks } from '../seams/bridge-analysis-hooks.js';
import { runRetentionPurge } from '../maintenance/retention-purge.js';

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

export async function startAnalysis(ctx: AppContext): Promise<() => Promise<void>> {
  const { config } = ctx;
  const stops: Array<() => Promise<void>> = [];

  const transcriber = createTranscriber(config);
  const analysisService = createAnalysisService(config);
  const worker =
    config.dialerAnalysis?.enabled && transcriber && analysisService
      ? initDialerAnalysisWorker({
          transcriber,
          analysisService,
          config: config.dialerAnalysis,
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
