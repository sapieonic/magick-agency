// First, as in core (`src/index.ts:1`@4850d1d9): it installs the meter provider before
// `@magick-agency/observability` binds every metric to the global meter, and its
// auto-instrumentations patch pg, ioredis and http before those are loaded.
import { shutdownOtelSdk } from './instrumentation.js';
import Redis from 'ioredis';
import { initDbPool, closePool } from '@magick-agency/db';
import { logger } from '@magick-agency/observability';
import { config } from './config/index.js';
import { buildApp } from './app.js';
import type { AppContext } from './app-context.js';
import { startPlatform } from './bootstrap/platform.js';
import { startAgency } from './bootstrap/agency.js';
import { startVoice } from './bootstrap/voice.js';
import { startAnalysis } from './bootstrap/analysis.js';
import { initAnalytics } from './analytics/posthog.js';

/**
 * One process, single replica (D2). Start order: storage, PostHog, the app, each lane's
 * background work (platform, voice, agency, analysis), then listen; shutdown closes HTTP,
 * then runs the lanes' stops in reverse.
 */
async function main(): Promise<void> {
  const pool = initDbPool({
    url: config.db.url,
    poolMin: config.db.poolMin,
    poolMax: config.db.poolMax,
    ssl: config.server.env === 'production',
    // Q1 (Manas, 2026-10-09): verify the server certificate unless explicitly opted out.
    sslRejectUnauthorized: config.db.sslRejectUnauthorized,
    ...(config.db.sslCa ? { sslCa: config.db.sslCa } : {}),
  });
  const redis = new Redis(config.redis.url, { keyPrefix: config.redis.keyPrefix || undefined });
  const ctx: AppContext = { config, pool, redis };

  // PostHog first, where core initialised it (core `src/index.ts:244`@4850d1d9): before any
  // background work starts and before the server listens (`:984`), so nothing — a bootstrap's
  // first event or an early request — emits into a client that does not exist yet. (Lane C ran
  // it inside `startVoice`; Phase 8 hoist.) No-op unless analytics is enabled.
  initAnalytics();

  const app = await buildApp({ ctx, logger: false });

  const stops: Array<() => Promise<void>> = [];

  // Signal handlers before any background work starts, as core installed them (core
  // `src/index.ts:974-975`@4850d1d9) ahead of `agencyRuntime.start()` (:981): a SIGTERM during
  // a slow startup reap then runs the stops collected so far instead of the default hard exit.
  //
  // Shutdown closes HTTP FIRST — core's `http-close` step (:837) runs before the workers,
  // runtime and bridge stop and before `audit-flush` (:903); master closes the app (:689)
  // before `auditLogger.shutdown()` (:697) — so no request can buffer an audit row after the
  // platform stop has flushed the loggers, then the lanes' stops run in reverse.
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');
    try {
      await app.close().catch((err) => logger.error({ err }, 'http close failed'));
      for (const stop of [...stops].reverse()) {
        await stop().catch((err) => logger.error({ err }, 'stop failed'));
      }
      await redis.quit().catch(() => {});
      await closePool();
    } finally {
      // Last, after everything that records a metric or a span (core `src/index.ts:952`@4850d1d9):
      // the SDK's final forced flush carries what the stops above recorded. No-op with OTel off.
      // In a `finally`, as core's (`:932`): a rejected `closePool()` must not skip the flush and
      // leave the process alive with the shutdown latched.
      await shutdownOtelSdk();
      process.exit(0);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  stops.push(await startPlatform(ctx));
  // Voice before agency (core `src/index.ts@4850d1d9`): the bridge's startup
  // self-heal (:353-354) runs before `agencyRuntime.start()` (:981), and on
  // shutdown the runtime stops (:856) before the bridge drains (:857), so no
  // pacing tick can dial while calls are being torn down.
  stops.push(await startVoice(ctx));
  stops.push(await startAgency(ctx));
  stops.push(await startAnalysis(ctx));

  // Listen only after the bootstraps (core `src/index.ts:977-984` @4850d1d9: the
  // startup reaper and `agencyRuntime.start()` complete before `app.listen`), so no
  // request — an agent going available, say — lands before the startup reap.
  await app.listen({ port: config.server.port, host: config.server.host });
  logger.info({ port: config.server.port, otelExport: config.otel.exporting }, 'magick-agency listening');
}

main().catch(async (err) => {
  logger.fatal({ err }, 'boot failed');
  // PORT NOTE (magick-agency): core `src/index.ts:1020-1023`@4850d1d9 exited without flushing, so
  // with OTel on this line and the startup spans never left the process.
  await shutdownOtelSdk();
  process.exit(1);
});
