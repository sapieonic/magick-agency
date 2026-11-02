/**
 * The process entry of an analysis worker (`MA_PROCESS_ROLE=analysis`), forked by the
 * primary. Owns the process's lifecycle around {@link startAnalysisChild}:
 *
 *  - its own pg pool (no Redis: the slot pool never touches it) and its `audit_logs`
 *    buffer, which the runner writes and which is flushed before exit;
 *  - SIGTERM and SIGINT are logged and ignored. The primary decides when a child stops (a
 *    terminal's Ctrl-C signals the whole process group, and the order is the primary's);
 *  - `shutdown` from the primary: requeue in-flight jobs, answer, flush, exit 0;
 *  - the channel closing (the primary died): the same requeue, then exit, so no job is
 *    left claimed by a process nobody will ask about.
 */
import { closePool, initDbPool } from '@magick-agency/db';
import { createChildLogger } from '@magick-agency/observability';
import { config } from '../config/index.js';
import { dbTlsOptions } from '../db-tls.js';
import { auditLogger } from '../audit/audit-logger.js';
import { createTranscriber } from '../transcription/index.js';
import { createAnalysisService } from '../analysis/index.js';
import type { Transcriber } from '../transcription/types.js';
import type { PostCallAnalysisService } from '../analysis/index.js';
import type { DialerAnalysisConfig } from '../core/dialer-analysis-runner.js';
import { IpcChannel, parentTransport } from './ipc-channel.js';
import { startAnalysisChild } from './analysis-child.js';
import { analysisChildDbPoolMax } from './db-connection-budget.js';

const log = createChildLogger({ component: 'analysis-child' });

export interface AnalysisChildProcessOptions {
  slot: number;
  /** Flushes OTel last (`shutdownOtelSdk`); the process entry passes it. */
  flushTelemetry?: () => Promise<void>;
  /** Tests only: fakes for the AI vendors and the config they run under. */
  overrides?: {
    transcriber: Transcriber;
    analysisService: PostCallAnalysisService;
    config: DialerAnalysisConfig;
    recordingHosts?: readonly string[];
  };
}

export async function runAnalysisChildProcess(opts: AnalysisChildProcessOptions): Promise<void> {
  const { slot } = opts;
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => log.info({ slot, signal }, 'Analysis worker ignores the signal; the primary stops it'));
  }

  const transcriber = opts.overrides?.transcriber ?? createTranscriber(config);
  const analysisService = opts.overrides?.analysisService ?? createAnalysisService(config);
  const analysisConfig = opts.overrides?.config ?? config.dialerAnalysis;
  if (!analysisConfig?.enabled || !transcriber || !analysisService) {
    // The primary forks only when all three are constructible from the same env; reaching
    // this means the env differs between them, which is a deployment fault.
    log.fatal({ slot }, 'Analysis worker process started without a runnable analysis config — exiting');
    process.exit(1);
  }

  initDbPool({
    url: config.db.url,
    poolMin: 0,
    // A slot holds a connection only for a claim, a heartbeat or the final transaction. The
    // primary counts this pool in the host's total (`db-connection-budget.ts`).
    poolMax: analysisChildDbPoolMax(config.db.poolMax, analysisConfig.concurrency),
    ...dbTlsOptions(config),
  });
  auditLogger.start();

  const channel = new IpcChannel(parentTransport(), { name: `analysis${slot}→primary` });
  const child = startAnalysisChild({
    slot,
    channel,
    transcriber,
    analysisService,
    config: analysisConfig,
    recordingHosts: opts.overrides?.recordingHosts ?? config.voicelinkRecording.allowedHosts,
  });

  let exiting = false;
  const finish = async (code: number, why: string): Promise<void> => {
    if (exiting) return;
    exiting = true;
    log.info({ slot, why }, 'Analysis worker process stopping');
    await child.shutdown().catch((err) => log.error({ err, slot }, 'Analysis requeue on shutdown failed'));
    await auditLogger.shutdown().catch((err) => log.error({ err, slot }, 'audit flush failed'));
    await closePool().catch(() => {});
    await opts.flushTelemetry?.().catch(() => {});
    process.exit(code);
  };

  channel.handle('shutdown', async () => {
    await child.shutdown();
    // Answer first; the exit follows on the next turn, after the answer is queued.
    setImmediate(() => { void finish(0, 'shutdown requested'); });
    return {};
  });
  channel.onClose(() => { void finish(0, 'parent channel closed'); });
}
