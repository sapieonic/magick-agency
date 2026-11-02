// First import, always: it installs the meter provider before `@magick-agency/observability`
// binds every metric to the global meter, and its auto-instrumentations patch pg, ioredis and
// http before those are loaded.
import { shutdownOtelSdk } from './instrumentation.js';
import Redis from 'ioredis';
import { initDbPool, closePool } from '@magick-agency/db';
import { APP_VERSION, logger } from '@magick-agency/observability';
import { config } from './config/index.js';
import { buildApp } from './app.js';
import type { AppContext } from './app-context.js';
import { dbTlsOptions } from './db-tls.js';
import { redisClientOptions } from './utils/redis-options.js';
import { startPlatform } from './bootstrap/platform.js';
import { getAgencyRuntime, startAgency } from './bootstrap/agency.js';
import { startVoice } from './bootstrap/voice.js';
import { startAnalysis } from './bootstrap/analysis.js';
import { initAnalytics } from './analytics/posthog.js';
import { processIdentityFromEnv } from './cluster/roles.js';
import { runAnalysisChildProcess } from './cluster/analysis-child-main.js';
import { runMediaChildProcess } from './cluster/media-child-main.js';
import { prepareMediaPrimary, startMediaWorkers } from './cluster/primary.js';
import { createLoopSampler } from './cluster/loop-sampler.js';
import { clusterReadiness } from './cluster/readiness.js';
import { runShutdownPlan, type ShutdownPlan } from './cluster/shutdown-order.js';
import { DB_CONNECTION_HEADROOM, planDbConnections, readDbConnectionBudget, type DbConnectionBudget } from './cluster/db-connection-budget.js';
import { setDbConnectionBudgetProvider } from '@magick-agency/observability/metrics/shared';

/**
 * One process, single replica. Start order: storage, PostHog, the app, each area's
 * background work (platform, voice, agency, analysis), then listen; shutdown closes HTTP,
 * halts pacing, runs the drains together (media workers, analysis), then the remaining
 * stops in reverse (`cluster/shutdown-order.ts`).
 */
async function main(): Promise<void> {
  // A child forked by the primary (docs/scaling.md) runs only its role's work. The process
  // the operator started has no role in its environment and is the server, as always.
  const identity = processIdentityFromEnv(process.env);
  if (identity.kind === 'child') {
    if (identity.role === 'analysis') {
      await runAnalysisChildProcess({ slot: identity.slot, flushTelemetry: shutdownOtelSdk });
      return;
    }
    await runMediaChildProcess({ slot: identity.slot, flushTelemetry: shutdownOtelSdk });
    return;
  }

  const pool = initDbPool({
    url: config.db.url,
    poolMin: config.db.poolMin,
    poolMax: config.db.poolMax,
    // TLS on in production, verified (decision Q1); shared with dist/migrate.js (`db-tls.ts`).
    ...dbTlsOptions(config),
  });
  // Bounded (command, connect and retry limits): a Redis that is gone fails each command in
  // seconds instead of queueing it. `utils/redis-options.ts`.
  const redis = new Redis(config.redis.url, redisClientOptions(config.redis));
  const ctx: AppContext = { config, pool, redis };

  // PostHog first: before any background work starts and before the server listens, so
  // nothing — a bootstrap's first event or an early request — emits into a client that does
  // not exist yet. No-op unless analytics is enabled.
  initAnalytics();

  // What shutdown runs after HTTP has closed, filled as each part starts.
  const plan: ShutdownPlan = { haltPacing: null, drains: [], stops: [] };
  // Set below; a media crash loop shuts the process down with exit code 1 (D4).
  let shutdownWith: ((signal: string, code: number) => Promise<void>) | null = null;

  // MEDIA_WORKERS > 0 (docs/scaling.md): this process is the primary. Its adapters are
  // installed before `buildApp` builds the agency runtime; null = one process, as always.
  const primaryLoop = createLoopSampler();
  const media = await prepareMediaPrimary(ctx, {
    onFatal: (why) => {
      logger.fatal({ why }, 'media workers cannot be kept running — shutting down');
      void shutdownWith?.('crash-loop', 1);
    },
  });

  // With worker processes the host's pools add up: compare the sum with the server's limit
  // once, now (`cluster/db-connection-budget.ts`). Logged and reported, never refused.
  const analysisWorkers = config.dialerAnalysis?.enabled ? config.dialerAnalysis.processes : 0;
  let dbBudget: DbConnectionBudget | null = null;
  if (media || analysisWorkers > 0) {
    const plan = planDbConnections(config, { mediaWorkers: media?.count ?? 0, analysisWorkers });
    dbBudget = await readDbConnectionBudget((sql) => pool.query(sql), plan)
      .catch((err: unknown) => { logger.warn({ err, plan }, 'Could not read Postgres max_connections to check the host\'s pools'); return null; });
    if (dbBudget) {
      const budget = dbBudget;
      setDbConnectionBudgetProvider(() => ({ planned: budget.total + DB_CONNECTION_HEADROOM, allowed: budget.maxConnections - budget.reserved }));
      if (!budget.fits) {
        logger.error({ db: budget },
          'The host\'s Postgres pools can open more connections than the server allows (max_connections): lower DB_POOL_MAX / MEDIA_WORKER_DB_POOL_MAX or raise max_connections');
      }
    }
  }

  const app = await buildApp({
    ctx,
    logger: false,
    ...(media ? { wsTransport: 'handoff' as const, wsHandoffTarget: () => media } : {}),
    // With workers: ready while this process is not draining and at least one media worker
    // answers; each worker's state is in the body (D5, `cluster/readiness.ts`). One process:
    // ready as before (Postgres and Redis). `?detail=1`: this process's own loop first (the
    // number the media split exists to keep low), then each media worker's.
    readiness: async () => {
      const self = {
        role: media ? 'primary' : 'single', slot: 0, pid: process.pid, ...primaryLoop(), inFlight: 0, draining: shuttingDown,
        ...(dbBudget ? { db: dbBudget } : {}),
      };
      if (!media) return { ready: true, detail: [self] };
      const health = await media.health();
      const verdict = clusterReadiness(shuttingDown, health);
      return { ready: verdict.ready, summary: verdict.summary, detail: [self, ...health] };
    },
  });

  // Signal handlers before any background work starts (in particular before the agency
  // runtime's startup reap): a SIGTERM during a slow startup then runs the stops collected so
  // far instead of the default hard exit.
  //
  // Shutdown closes HTTP FIRST, before the workers, the agency runtime and the bridge stop
  // and before the audit buffers are flushed, so no request can buffer an audit row after the
  // platform stop has flushed the loggers. Then pacing halts (no dial from here on), the
  // drains run together (the media workers beside the completion notices, the analysis
  // stop), and the remaining stops run in reverse (docs/scaling.md §6.4).
  let shuttingDown = false;
  const shutdown = async (signal: string, exitCode = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');
    try {
      // `http closed` marks the HTTP-first order in the logs (docs/operations.md, "Shutdown and
      // grace period"); it is logged only when the close succeeded.
      await app.close().then(
        () => logger.info('http closed'),
        (err) => logger.error({ err }, 'http close failed'),
      );
      await runShutdownPlan(plan, (err, step) => logger.error({ err, step }, 'stop failed'));
      await redis.quit().catch(() => {});
      await closePool();
    } finally {
      // Last, after everything that records a metric or a span: the SDK's final forced flush
      // carries what the stops above recorded. No-op with OTel off. In a `finally`, so a rejected
      // `closePool()` cannot skip the flush and leave the process alive with the shutdown latched.
      await shutdownOtelSdk();
      process.exit(exitCode);
    }
  };
  shutdownWith = shutdown;
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  plan.stops.push(await startPlatform(ctx));
  // Voice before agency: the bridge's startup self-heal runs before the agency
  // runtime starts, and on shutdown (reverse order) the runtime stops before the
  // bridge drains, so no pacing tick can dial while calls are being torn down.
  plan.stops.push(await startVoice(ctx));
  plan.stops.push(await startAgency(ctx));
  // Shutdown halts pacing before anything drains, so no dial overtakes a stop.
  const runtime = getAgencyRuntime();
  if (runtime) plan.haltPacing = () => runtime.pacing.halt();
  // After the startup reap (no worker existed, so "every non-terminal row is dead" held),
  // the media workers. Their stop drains them beside the completion-notice drain; it runs
  // with the analysis stop, after pacing has halted and before agency's (docs/scaling.md §6.4).
  if (media) plan.drains.push(await startMediaWorkers(media));
  plan.drains.push(await startAnalysis(ctx));

  // Listen only after the bootstraps (the startup reaper and the agency runtime's
  // start complete first), so no request — an agent going available, say — lands
  // before the startup reap.
  await app.listen({ port: config.server.port, host: config.server.host });
  // Every record already carries `version` (the logger's base) and the OTel resource carries
  // `service.version`; the version in the message makes each deploy one readable line in Grafana.
  logger.info({ port: config.server.port, otelExport: config.otel.exporting }, `magick-agency v${APP_VERSION} listening`);
}

main().catch(async (err) => {
  logger.fatal({ err }, 'boot failed');
  // Flush first: with OTel on, this line and the startup spans would otherwise never leave the
  // process.
  await shutdownOtelSdk();
  process.exit(1);
});
