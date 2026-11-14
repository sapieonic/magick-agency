import { afterEach, describe, expect, it, vi } from 'vitest';

/*
 * The cache-invalidation channel (`src/cache/cache-invalidation.ts`): a publish reaches this
 * process's listeners for that cache and, in a media worker, the primary through the forwarder;
 * the primary's relay delivers locally only. Its IPC decoder is `parseCacheInvalidation`, also
 * pinned through `ipc-protocol.test.ts`; the worker's forwarder and the primary's relay are
 * `media-child-invalidations.test.ts` and `media-cluster.test.ts`.
 */

vi.mock('@magick-agency/observability', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@magick-agency/observability')>()),
  createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import {
  CACHE_INVALIDATION_NAMES,
  cacheInvalidationListenerCount,
  deliverCacheInvalidation,
  onCacheInvalidation,
  parseCacheInvalidation,
  publishCacheInvalidation,
  setCacheInvalidationForwarder,
} from '../../../src/cache/cache-invalidation.js';

const STATS = 'agency-campaign-stats' as const;
const offs: Array<() => void> = [];
function listen(handler: (key: string) => void) {
  offs.push(onCacheInvalidation(STATS, handler));
}

afterEach(() => {
  for (const off of offs.splice(0)) off();
  setCacheInvalidationForwarder(null);
});

describe('cache invalidation', () => {
  it('lists the caches it may name', () => {
    expect(CACHE_INVALIDATION_NAMES).toEqual(['agency-campaign-stats']);
  });

  it('a publish reaches every listener for that cache, with the key; an unsubscribed one no more', () => {
    const a = vi.fn();
    const b = vi.fn();
    listen(a);
    const offB = onCacheInvalidation(STATS, b);
    expect(cacheInvalidationListenerCount(STATS)).toBe(2);

    publishCacheInvalidation({ cache: STATS, key: 'c1' });
    expect(a).toHaveBeenCalledWith('c1');
    expect(b).toHaveBeenCalledWith('c1');

    offB();
    publishCacheInvalidation({ cache: STATS, key: 'c2' });
    expect(a).toHaveBeenCalledTimes(2);
    expect(b).toHaveBeenCalledTimes(1);
    expect(cacheInvalidationListenerCount(STATS)).toBe(1);
  });

  it('a listener that throws does not stop the others, nor the publisher', () => {
    const after = vi.fn();
    listen(() => { throw new Error('boom'); });
    listen(after);
    expect(() => publishCacheInvalidation({ cache: STATS, key: 'c1' })).not.toThrow();
    expect(after).toHaveBeenCalledWith('c1');
  });

  it('a publish is forwarded (a media worker to the primary); a delivery, the primary\'s relay, is not', () => {
    const local = vi.fn();
    const forward = vi.fn();
    listen(local);
    setCacheInvalidationForwarder(forward);

    publishCacheInvalidation({ cache: STATS, key: 'c1' });
    expect(local).toHaveBeenCalledWith('c1');
    expect(forward).toHaveBeenCalledWith({ cache: STATS, key: 'c1' });

    deliverCacheInvalidation({ cache: STATS, key: 'c2' });
    expect(local).toHaveBeenLastCalledWith('c2');
    expect(forward).toHaveBeenCalledTimes(1);
  });

  it('a forwarder that throws is swallowed: the write it follows has happened', () => {
    setCacheInvalidationForwarder(() => { throw new Error('channel closed'); });
    expect(() => publishCacheInvalidation({ cache: STATS, key: 'c1' })).not.toThrow();
  });

  it('decodes a listed cache and a bounded key, and nothing else', () => {
    expect(parseCacheInvalidation({ cache: STATS, key: 'c1', extra: 1 })).toEqual({ cache: STATS, key: 'c1' });
    for (const bad of [undefined, null, 'x', 7, [], {}, { cache: STATS }, { cache: STATS, key: 7 }, { cache: STATS, key: '' },
      { cache: STATS, key: 'k'.repeat(129) }, { cache: 'other', key: 'c1' }]) {
      expect(parseCacheInvalidation(bad)).toBeNull();
    }
  });
});
