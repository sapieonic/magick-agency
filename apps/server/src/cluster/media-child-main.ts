/**
 * The process entry of a media worker (`MA_PROCESS_ROLE=media`), forked by the primary.
 * Builds the shard (`media-child.ts`) on this process's own pg pool and Redis client:
 *
 *  - the replica id is this incarnation's (`<base>:mw<slot>:<pid>`), so a crashed
 *    worker's station ownership keys name a replica the primary knows is dead;
 *  - the pacing bus publishes to the primary (`IpcPacingInvalidationBus`), before the
 *    runtime exists so every publisher uses it;
 *  - the guard host admits and releases this worker's calls, and asks the primary to run
 *    the self-heal (`voice.wake_self_heal`), which is the primary's alone;
 *  - the bridge writes `&w=<slot>` into the carrier's URLs, so its media connect and
 *    status posts reach this worker;
 *  - the bridge's analysis hooks enqueue here and wake the analysis slots through the
 *    primary (`analysis.wake`);
 *  - audit buffers and the feature-flag cache as in one process; no leader-only work.
 *
 * SIGTERM and SIGINT are logged and ignored: the primary orders shutdown. If the
 * primary's channel closes (it died), live calls are hung up within a bound and the
 * process exits.
 */
import os from 'node:os';
import Redis from 'ioredis';
import { closePool, initDbPool } from '@magick-agency/db';
import { createChildLogger } from '@magick-agency/observability';
import { config } from '../config/index.js';
import { dbTlsOptions } from '../db-tls.js';
import { redisClientOptions } from '../utils/redis-options.js';
import { auditLogger } from '../audit/audit-logger.js';
import { platformAuditLogger } from '../audit/platform/audit-logger.js';
import { initFeatureFlagService } from '../feature-flags/index.js';
import { initS3Client } from '../storage/s3.js';
import { initTtsFileCache } from '../tts/tts-file-cache.js';
import { setTelephonyReleaseObserver } from '../core/telephony-release.js';
import { trackTelephonyLeaseRelease } from '@magick-agency/observability/metrics/voice';
import { ensureVoiceEngine } from '../bootstrap/voice.js';
import { configureAgencyRuntime, ensureAgencyRuntime } from '../bootstrap/agency.js';
import { createTranscriber } from '../transcription/index.js';
import { createAnalysisService } from '../analysis/index.js';
import { createBridgeAnalysisHooks } from '../analysis/bridge-analysis-hooks.js';
import { setBridgeAnalysisHooks } from '../seams/bridge-analysis-hooks.js';
import { setDialerAnalysisWorker } from '../core/dialer-analysis-worker-handle.js';
import { buildCoreHandlers } from '../api/core-handlers.js';
import { initAnalytics, shutdownAnalytics } from '../analytics/posthog.js';
import { IpcChannel, parentTransport } from './ipc-channel.js';
import { installIpcPacingBus, startMediaChild, type MediaChild } from './media-child.js';
import { buildWorkerApp } from './worker-app.js';

const log = createChildLogger({ component: 'media-child' });

/** How long a worker whose primary died gets to hang up its calls before it exits. */
const ORPHANED_SHUTDOWN_BOUND_MS = 5_000;

export interface MediaChildProcessOptions {
  slot: number;
  flushTelemetry?: () => Promise<void>;
}

export async function runMediaChildProcess(opts: MediaChildProcessOptions): Promise<void> {
  const { slot } = opts;
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => log.info({ slot, signal }, 'Media worker ignores the signal; the primary stops it'));
  }
  const base = process.env['REPLICA_ID'] || os.hostname();
  process.env['REPLICA_ID'] = `${base}:mw${slot}:${process.pid}`;

  const channel = new IpcChannel(parentTransport(), { name: `media${slot}→primary` });
  installIpcPacingBus(channel);

  // ── Stopping, wired before anything awaits ───────────────────────────────
  // The primary may ask this worker to stop while it is still booting (the host is being
  // stopped a moment after it started, or the slot was re-forked just before a stop). The
  // `shutdown` handler is registered first, so that request is answered rather than refused
  // `unsupported` (which left the primary waiting out its grace, then SIGKILL). A stop during
  // boot lets the boot finish building, then tears down what it built instead of starting
  // the shard and announcing `ready`.
  let child: MediaChild | null = null;
  let stopRequested = false;
  let bootSettled!: () => void;
  const booted = new Promise<void>((resolve) => { bootSettled = resolve; });
  let redis: Redis | null = null;
  let exiting = false;
  const finish = async (code: number, why: string, boundMs?: number): Promise<void> => {
    if (exiting) return;
    exiting = true;
    log.info({ slot, why }, 'Media worker process stopping');
    const stop = booted.then(() => child?.shutdown());
    if (boundMs !== undefined) {
      await Promise.race([stop, new Promise((r) => setTimeout(r, boundMs).unref())]);
    } else {
      await stop;
    }
    await shutdownAnalytics().catch(() => {});
    await platformAuditLogger.shutdown().catch(() => {});
    await auditLogger.shutdown().catch(() => {});
    await redis?.quit().catch(() => {});
    await closePool().catch(() => {});
    await opts.flushTelemetry?.().catch(() => {});
    process.exit(code);
  };
  channel.handle('shutdown', async () => {
    stopRequested = true;
    await booted;
    await child?.shutdown();
    setImmediate(() => { void finish(0, 'shutdown requested'); });
    return {};
  });
  channel.onClose(() => { void finish(1, 'parent channel closed', ORPHANED_SHUTDOWN_BOUND_MS); });

  try {
    child = await boot(slot, channel, () => stopRequested, (r) => { redis = r; });
  } finally {
    bootSettled();
  }
}

/**
 * Build the worker on its own pool and Redis client, then (unless a stop arrived meanwhile)
 * start the shard and announce `ready`. Null when a stop arrived during boot: what was built
 * is torn down and nothing was announced.
 */
async function boot(
  slot: number,
  channel: IpcChannel,
  stopRequested: () => boolean,
  onRedis: (redis: Redis) => void,
): Promise<MediaChild | null> {
  initDbPool({
    url: config.db.url,
    poolMin: 0,
    // Its own pool, sized for its own calls' writes (`MEDIA_WORKER_DB_POOL_MAX`): every
    // process's pool counts against the server's max_connections (`db-connection-budget.ts`).
    poolMax: config.processes.mediaWorkerDbPoolMax,
    ...dbTlsOptions(config),
  });
  const redis = new Redis(config.redis.url, redisClientOptions(config.redis));
  onRedis(redis);
  // PostHog in this process too: the bridge's `webrtc_call_*` events are emitted here. A
  // no-op unless analytics is enabled; flushed by the stop.
  initAnalytics();
  initFeatureFlagService(redis, config.redis.keyPrefix);
  platformAuditLogger.start();
  auditLogger.start();
  if (config.s3) initS3Client(config.s3);
  initTtsFileCache();
  setTelephonyReleaseObserver(trackTelephonyLeaseRelease);

  const { guardHost, bridge } = ensureVoiceEngine(redis, { carrierRouteHint: String(slot) });
  // The self-heal (counters vs locks, stale rows) is the primary's: wake it there.
  guardHost.delegateSelfHeal(() => { channel.emit('voice.wake_self_heal', {}); });
  // D6: while Redis is down every worker admits from local leases, so each takes its share.
  guardHost.setDegradedShare(config.processes.mediaWorkers);

  // A campaign's dials are spread over the workers that own its agents: none of them is
  // the sole counter of its carrier refusals (`carrier-refusal-breaker.ts`).
  configureAgencyRuntime({ refusalCountShared: true });
  const runtime = ensureAgencyRuntime(redis, config.redis.keyPrefix);

  if (config.dialerAnalysis?.enabled && createTranscriber(config) && createAnalysisService(config)) {
    setBridgeAnalysisHooks(createBridgeAnalysisHooks());
    setDialerAnalysisWorker({ wake: () => { channel.emit('analysis.wake', {}); } });
  }

  const app = await buildWorkerApp({ config, runtime, bridge });
  const core = await buildCoreHandlers({
    campaigns: {
      runtime: {
        dnc: { appliedVersion: async () => null },
        stations: {
          connectedBySession: (ids) => runtime.stations.connectedBySession(ids),
          inboundCapabilityBySession: (ids) => runtime.stations.inboundCapabilityBySession(ids),
        },
      },
      callManager: guardHost,
    },
    agency: { runtime },
  });

  if (stopRequested()) {
    // Never `ready`: no socket was handed here and no shard timer started. Close what
    // was built, in the shutdown's order.
    log.info({ slot }, 'Media worker asked to stop while booting — not starting');
    await app.close().catch(() => {});
    await bridge.gracefulShutdown().catch(() => {});
    await guardHost.gracefulShutdown().catch(() => {});
    await core.close().catch(() => {});
    return null;
  }
  runtime.startShard();
  return startMediaChild({ slot, channel, runtime, bridge, guardHost, app, core });
}
