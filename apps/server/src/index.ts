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
 * One process, single replica. Start order: storage, PostHog, the app, each area's
 * background work (platform, voice, agency, analysis), then listen; shutdown closes HTTP,
 * then runs the background stops in reverse.
 */
async function main(): Promise<void> {
  const pool = initDbPool({
    url: config.db.url,
    poolMin: config.db.poolMin,
    poolMax: config.db.poolMax,
    // TLS on in production, verified (decision Q1); shared with dist/migrate.js (`db-tls.ts`).
    ...dbTlsOptions(config),
  });
  const redis = new Redis(config.redis.url, { keyPrefix: config.redis.keyPrefix || undefined });
  const ctx: AppContext = { config, pool, redis };

  // PostHog first: before any background work starts and before the server listens, so
  // nothing — a bootstrap's first event or an early request — emits into a client that does
  // not exist yet. No-op unless analytics is enabled.
  initAnalytics();

  const app = await buildApp({ ctx, logger: false });

  const stops: Array<() => Promise<void>> = [];

  // Signal handlers before any background work starts (in particular before the agency
  // runtime's startup reap): a SIGTERM during a slow startup then runs the stops collected so
  // far instead of the default hard exit.
  //
  // Shutdown closes HTTP FIRST, before the workers, the agency runtime and the bridge stop
  // and before the audit buffers are flushed, so no request can buffer an audit row after the
  // platform stop has flushed the loggers; then the background stops run in reverse.
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
  // Voice before agency: the bridge's startup self-heal runs before the agency
  // runtime starts, and on shutdown (reverse order) the runtime stops before the
  // bridge drains, so no pacing tick can dial while calls are being torn down.
  stops.push(await startVoice(ctx));
  stops.push(await startAgency(ctx));
  stops.push(await startAnalysis(ctx));

  // Listen only after the bootstraps (the startup reaper and the agency runtime's
  // start complete first), so no request — an agent going available, say — lands
  // before the startup reap.
  await app.listen({ port: config.server.port, host: config.server.host });
  logger.info({ port: config.server.port }, 'magick-agency listening');
}

main().catch((err) => {
  logger.fatal({ err }, 'boot failed');
  process.exit(1);
});
