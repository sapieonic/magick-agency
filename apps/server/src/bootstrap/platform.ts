import type Redis from 'ioredis';
import { logger } from '@magick-agency/observability';
import type { AppContext } from '../app-context.js';
import { redisCache } from '../cache/redis-cache.js';
import { runAuditPartitionMaintenance } from '../audit/audit-partition-maintenance.js';
import { platformAuditLogger } from '../audit/platform/audit-logger.js';
import { auditLogger } from '../audit/audit-logger.js';

/**
 * The platform's background work:
 *
 *  1. The cross-instance cache-invalidation subscriber. Only when the in-process cache layer
 *     is enabled; the cache itself was initialised by the platform plugin before any route ran.
 *  2. Audit partition maintenance for `audit_logs` and `platform_audit_log`
 *     (`audit/audit-partition-maintenance.ts`): once at boot, then every
 *     `config.auditPartitions.intervalMs` (default daily). Single replica, so there is no
 *     cross-process lock; every step is idempotent anyway.
 *  3. The two buffered audit writers (decision B7): `platformAuditLogger` (→
 *     `platform_audit_log`) and `auditLogger` (→ `audit_logs`). Both buffer rows and flush
 *     every 500 ms (`audit-buffer.ts`), at 100 rows, or at once for an `error` row — but only
 *     once `start()` has armed the timer, and the tail of the buffer reaches the table only
 *     through `shutdown()`. Without both calls a quiet process would hold its audit rows until
 *     100 had accumulated and lose them on stop. They start here, at boot before `listen`, and
 *     are flushed in this stop. `index.ts` closes HTTP first and then runs the background
 *     stops in reverse start order; platform starts first, so this stop runs last: every other
 *     area's background writes are in the buffer by then, and no request can buffer a row
 *     after the flush.
 *
 * Returns a stop function the process awaits on shutdown.
 */
export async function startPlatform(ctx: AppContext): Promise<() => Promise<void>> {
  const { config } = ctx;
  platformAuditLogger.start();
  auditLogger.start();
  let subscriber: Redis | null = null;

  if (config.localCache.enabled) {
    // A dedicated connection: once a client subscribes, ioredis puts it in
    // subscriber mode where ordinary commands are rejected. NOT a plain
    // `duplicate()` of a client that gives up after N retries — the subscriber
    // going away silently removes the invalidation guarantee while the local cache
    // keeps serving, so retry forever, capped at 2s.
    subscriber = ctx.redis.duplicate({
      retryStrategy: (times: number) => Math.min(times * 200, 2000),
    });
    subscriber.on('error', (err: Error) => {
      logger.warn({ err }, 'Cache invalidation subscriber error');
    });
    // Pub/sub has no replay: messages published while disconnected are gone, so
    // drop every local entry rather than trusting copies that may be stale.
    subscriber.on('ready', () => redisCache.clearLocal());
    await redisCache.attachInvalidationSubscriber(subscriber);
  }

  let timer: NodeJS.Timeout | null = null;
  let running: Promise<unknown> | null = null;
  const maintain = (): void => {
    if (running) return; // a slow pass is never stacked behind itself
    running = runAuditPartitionMaintenance({
      retentionDays: config.auditPartitions.retentionDays,
      monthsAhead: config.auditPartitions.monthsAhead,
    })
      .then((report) => logger.info({ report }, 'Audit partition maintenance complete'))
      .catch((err) => logger.error({ err }, 'Audit partition maintenance failed'))
      .finally(() => { running = null; });
  };
  if (config.auditPartitions.enabled) {
    maintain();
    timer = setInterval(maintain, config.auditPartitions.intervalMs);
    timer.unref();
  }

  return async () => {
    if (timer) clearInterval(timer);
    await running?.catch(() => {});
    // Flush both audit buffers (HTTP is already closed; see the header).
    await platformAuditLogger.shutdown().catch((err) => logger.error({ err }, 'platform audit flush failed'));
    await auditLogger.shutdown().catch((err) => logger.error({ err }, 'audit flush failed'));
    if (subscriber) await subscriber.quit().catch(() => {});
  };
}
