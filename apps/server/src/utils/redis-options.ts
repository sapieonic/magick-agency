// The options every Redis client the server makes is built with (`src/index.ts`; the cache
// invalidation subscriber is a `duplicate()` of it and inherits them). Kept here, apart from
// the composition file, so tests build their clients exactly as production does.
import type { RedisOptions } from 'ioredis';

/** The `redis` config block's fields these options are made from (`config/blocks/base.ts`). */
export interface RedisClientConfig {
  keyPrefix: string;
  commandTimeoutMs: number;
  maxRetriesPerRequest: number;
  connectTimeoutMs: number;
}

/**
 * ioredis's defaults wait a long time on a Redis that is gone: a command is queued while
 * the client reconnects and retried up to 20 times (`maxRetriesPerRequest`), there is no
 * command timeout at all, and a connect may take 10 s. Measured (load suites 2026-10-23):
 * a Redis outage took about 10 s to show on `/readyz` and some requests waited about 30 s.
 *
 *  - `commandTimeout` (`REDIS_COMMAND_TIMEOUT_MS`, default 2 s): every command, including
 *    one queued while the client reconnects, rejects with `Command timed out` after this
 *    long. A rejection, never a reply: each caller takes the branch it already takes for a
 *    Redis error. That matters most for decision Q6: a call token whose check times out is
 *    "Redis erroring" (accepted), never "Redis answered and the key is missing" (refused).
 *    2 s is three orders of magnitude above a healthy reply.
 *  - `maxRetriesPerRequest` (`REDIS_MAX_RETRIES_PER_REQUEST`, default 1): a command caught
 *    by a dropped connection is retried once after the reconnect, then fails.
 *  - `connectTimeout` (`REDIS_CONNECT_TIMEOUT_MS`, default 2 s).
 *
 * Reconnecting is unchanged (ioredis's own back-off, forever), so the client recovers by
 * itself when Redis returns.
 */
export function redisClientOptions(cfg: RedisClientConfig): RedisOptions {
  return {
    keyPrefix: cfg.keyPrefix || undefined,
    commandTimeout: cfg.commandTimeoutMs,
    maxRetriesPerRequest: cfg.maxRetriesPerRequest,
    connectTimeout: cfg.connectTimeoutMs,
  };
}
