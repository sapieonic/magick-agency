import Redis from 'ioredis';
import { initDbPool, closePool } from '@magick-agency/db';
import { logger } from '@magick-agency/observability';
import { config } from './config/index.js';
import { buildApp } from './app.js';
import type { AppContext } from './app-context.js';
import { dbTlsOptions } from './db-tls.js';
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
    // TLS on in production, verified (Q1); shared with dist/migrate.js (`db-tls.ts`).
    ...dbTlsOptions(config),
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
    // `http closed` marks the HTTP-first order in the logs (docs/operations.md, "Shutdown and
    // grace period"); it is logged only when the close succeeded.
    await app.close().then(
      () => logger.info('http closed'),
      (err) => logger.error({ err }, 'http close failed'),
    );
    for (const stop of [...stops].reverse()) {
      await stop().catch((err) => logger.error({ err }, 'stop failed'));
    }
    await redis.quit().catch(() => {});
    await closePool();
    process.exit(0);
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
  logger.info({ port: config.server.port }, 'magick-agency listening');
}

main().catch((err) => {
  logger.fatal({ err }, 'boot failed');
  process.exit(1);
});
