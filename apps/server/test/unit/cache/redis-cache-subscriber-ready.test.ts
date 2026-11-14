import { EventEmitter } from 'node:events';
import { describe, it, expect, vi } from 'vitest';

vi.mock('@magick-agency/observability', () => ({
  createChildLogger: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
}));

import { RedisCache, whenReady } from '../../../src/cache/redis-cache.js';
import type { Redis } from 'ioredis';

/**
 * The invalidation subscriber subscribes only once its connection is `ready`. ioredis writes a
 * SUBSCRIBE (a command flagged `loading`) while the connection is still in `connect`, ahead of its
 * own handshake; the connection then refuses that handshake's ready check, and the subscribe
 * resolves while the server holds no subscription (`whenReady` in src/cache/redis-cache.ts). On a
 * busy Redis that lost the subscription for a whole integration file.
 */

/** A subscriber connection as ioredis exposes it: a status and its events. */
function fakeSubscriber(status: string) {
  const emitter = new EventEmitter();
  const subscribe = vi.fn(async () => 1);
  const sub = Object.assign(emitter, { status, subscribe });
  return { sub, subscribe, asRedis: sub as unknown as Redis };
}

function enabledCache(): RedisCache {
  const cache = new RedisCache();
  cache.init({ options: { db: 3 } } as unknown as Redis, { enabled: true, ttlMs: 30_000, maxEntries: 10, channel: 'cache:invalidate' });
  return cache;
}

describe('the cache invalidation subscriber waits for its connection', () => {
  it('does not subscribe while the connection is still connecting, and subscribes once it is ready', async () => {
    const { sub, subscribe, asRedis } = fakeSubscriber('connect');
    const attached = enabledCache().attachInvalidationSubscriber(asRedis);
    await new Promise((r) => setTimeout(r, 10));
    expect(subscribe).not.toHaveBeenCalled();

    sub.status = 'ready';
    sub.emit('ready');
    await attached;
    expect(subscribe).toHaveBeenCalledExactlyOnceWith('cache:invalidate:db3');
  });

  it('subscribes at once on a connection that is already ready', async () => {
    const { subscribe, asRedis } = fakeSubscriber('ready');
    await enabledCache().attachInvalidationSubscriber(asRedis);
    expect(subscribe).toHaveBeenCalledExactlyOnceWith('cache:invalidate:db3');
  });

  it('gives up without throwing when the connection ends before it is ready', async () => {
    const { sub, subscribe, asRedis } = fakeSubscriber('connect');
    const attached = enabledCache().attachInvalidationSubscriber(asRedis);
    sub.emit('end');
    await expect(attached).resolves.toBeUndefined();
    expect(subscribe).not.toHaveBeenCalled();
  });

  it('whenReady leaves no listener behind either way', async () => {
    const ready = fakeSubscriber('connect').sub;
    const a = whenReady(ready as unknown as Redis);
    ready.emit('ready');
    await a;
    expect([ready.listenerCount('ready'), ready.listenerCount('end')]).toEqual([0, 0]);

    const ended = fakeSubscriber('connect').sub;
    const b = whenReady(ended as unknown as Redis);
    ended.emit('end');
    await expect(b).rejects.toThrow('ended before it was ready');
    expect([ended.listenerCount('ready'), ended.listenerCount('end')]).toEqual([0, 0]);
  });
});
