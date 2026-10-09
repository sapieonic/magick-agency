import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * The in-process cache's bootstrap wiring, asserted at the source level.
 *
 * Everything about this layer's safety lives in `src/index.ts` and none of it
 * is reachable from a unit test: `main()` builds the app against live config
 * and a real `listen`, so there is no factory to instantiate. The integration
 * test constructs `RedisCache` directly and passes its OWN literal channel and
 * options — it proves the mechanism works while re-declaring the very values it
 * is meant to protect, exactly the hole documented for `trustProxy`. Each of
 * the reverts below is one word or one argument and passes that whole suite:
 *
 *  - Dropping the `keyPrefix` from the channel name. ioredis applies
 *    `keyPrefix` to KEYS, never to pub/sub channels, so two stages sharing a
 *    Redis would clear each other's caches.
 *  - Dropping the `localConfig` argument to `redisCache.init`, which silently
 *    disables the layer (and, worse, the publish path other instances rely on).
 *  - Reusing the main client's `retryStrategy` for the subscriber. That one
 *    returns null after 5 attempts — roughly 3s of backoff — and PERMANENTLY
 *    ends the connection. The main client dying is survivable (reads fall
 *    through to Postgres); the subscriber dying removes the invalidation
 *    guarantee while the cache keeps serving happily.
 *  - Dropping the `ready` handler that clears the local map on reconnect.
 *    Pub/sub has no replay, so invalidations published while disconnected are
 *    gone for good.
 *
 * Same technique as `test/unit/api/trust-proxy-wiring.test.ts`.
 */
// The cache is initialised in `src/api/platform.plugin.ts` (`redisCache.init(
// opts.ctx.redis, …)`, the shared client from `AppContext`). The three subscriber cases
// read `src/bootstrap/platform.ts`, where the invalidation subscriber lives (`subscriber`,
// `ctx.redis`, and `quit()` on the returned stop function).
const source = readFileSync(resolve(process.cwd(), 'src/api/platform.plugin.ts'), 'utf8');
const bootstrap = readFileSync(resolve(process.cwd(), 'src/bootstrap/platform.ts'), 'utf8');

describe('local cache bootstrap wiring (src/api/platform.plugin.ts)', () => {
  it('namespaces the invalidation channel with the Redis key prefix', () => {
    expect(source).toMatch(/channel:\s*`\$\{config\.redis\.keyPrefix\}cache:invalidate`/);
    // A bare channel name would be shared across every stage on one Redis.
    expect(source).not.toMatch(/channel:\s*['"]cache:invalidate['"]/);
  });

  it('passes the local cache config into redisCache.init', () => {
    expect(source).toMatch(/redisCache\.init\(\s*opts\.ctx\.redis,\s*\{/);
    expect(source).toMatch(/\.\.\.config\.localCache/);
  });

  it('gives the subscriber its own retry strategy instead of inheriting give-up', () => {
    const dup = bootstrap.match(/ctx\.redis\.duplicate\(([\s\S]*?)\);/);
    expect(dup, 'subscriber must be created via duplicate()').not.toBeNull();
    // An argument-less duplicate() inherits `times > 5 => null`, which ends the
    // connection for good after ~3s of Redis unavailability.
    expect(dup![1]).toMatch(/retryStrategy/);
    expect(dup![1]).not.toMatch(/return null/);
  });

  it('drops the local map when the subscriber reconnects', () => {
    expect(bootstrap).toMatch(/subscriber\.on\(\s*['"]ready['"]/);
    expect(bootstrap).toMatch(/redisCache\.clearLocal\(\)/);
  });

  it('attaches the subscriber and closes it on shutdown', () => {
    expect(bootstrap).toMatch(/redisCache\.attachInvalidationSubscriber\(\s*subscriber\s*\)/);
    expect(bootstrap).toMatch(/subscriber\.quit\(\)/);
  });
});

// The schema lives in the platform config block (`src/config/blocks/platform.ts`),
// followed by `auditPartitionsSchema`.
describe('local cache config defaults (src/config/blocks/platform.ts)', () => {
  const schema = readFileSync(resolve(process.cwd(), 'src/config/blocks/platform.ts'), 'utf8');
  const block = schema.slice(
    schema.indexOf('const localCacheSchema'),
    schema.indexOf('const auditPartitionsSchema'),
  );

  it('defaults the layer OFF so the rolling deploy has no authorization gap', () => {
    // Instances on the previous release do not publish invalidations at all, so
    // enabling this by default would mean a role change served by an old
    // instance never reaches a new one, and the new instance serves the revoked
    // role until its TTL expires. Ship off, then enable fleet-wide.
    // `envBoolean` is a schema, not a factory, so the default reads
    // `envBoolean.default(false)`.
    expect(block).toMatch(/enabled:\s*envBoolean\.default\(false\)/);
  });

  it('caps the TTL and the entry count', () => {
    // A TTL in minutes turns a dropped broadcast into a minutes-long revocation
    // window; an unbounded entry count is a memory leak with extra steps.
    expect(block).toMatch(/ttlMs:[\s\S]*?\.max\(60_000\)/);
    expect(block).toMatch(/maxEntries:[\s\S]*?\.max\(/);
  });
});
