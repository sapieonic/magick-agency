import { describe, expect, it, vi } from 'vitest';

/*
 * The invalidations a media worker applies from the primary (`media-child.ts`): each one
 * drops this worker's own copy of what the primary changed. Pinned per event, so a cache
 * that a worker's dials read cannot drop out of the relay unnoticed. And the other way: a
 * cache invalidation published in the worker goes to the primary (`cache.invalidate`).
 */
const dialability = vi.hoisted(() => ({ clearDialableCallerIdCache: vi.fn() }));
vi.mock('../../../src/agency/campaign-dialability.js', () => dialability);

const { installIpcCacheInvalidation, startMediaChild } = await import('../../../src/cluster/media-child.js');
const cacheChannel = await import('../../../src/cache/cache-invalidation.js');

/** Just what `startMediaChild` registers on, with each event handler kept. */
function fakeChannel() {
  const events = new Map<string, (body: any) => void>();
  return {
    events,
    onHandoff: vi.fn(),
    emit: vi.fn(),
    handle: vi.fn(),
    onEvent: vi.fn((type: string, handler: (body: any) => void) => { events.set(type, handler); }),
  };
}

function start() {
  const channel = fakeChannel();
  const guardHost = {
    accountConcurrencyGuard: { invalidateLimit: vi.fn(async () => {}) },
    providerConcurrencyGuard: { invalidateLimits: vi.fn(async () => {}) },
    gracefulShutdown: vi.fn(async () => {}),
  };
  const child = startMediaChild({
    slot: 0,
    channel: channel as any,
    runtime: {
      replicaId: 'h:mw0:1',
      stations: { onAttached: vi.fn(), onDetached: vi.fn(), all: () => [] },
      stopShard: vi.fn(async () => {}),
    } as any,
    bridge: { observeLeases: vi.fn(), getActiveCallIds: () => [], gracefulShutdown: vi.fn(async () => {}) } as any,
    guardHost: guardHost as any,
    app: { close: vi.fn(async () => {}), server: {} } as any,
    core: { close: vi.fn(async () => {}) } as any,
  });
  return { channel, guardHost, child };
}

describe('a media worker applies the primary\'s invalidations', () => {
  it('`dialable.invalidate` drops this worker\'s dialable caller-ID cache (PL13)', async () => {
    const { channel, child } = start();
    expect(dialability.clearDialableCallerIdCache).not.toHaveBeenCalled();
    channel.events.get('dialable.invalidate')!({});
    expect(dialability.clearDialableCallerIdCache).toHaveBeenCalledTimes(1);
    await child.shutdown();
  });

  it('`concurrency.invalidate` drops both guards\' cached limits for the account', async () => {
    const { channel, guardHost, child } = start();
    channel.events.get('concurrency.invalidate')!({ tenantId: 't', accountId: 'a' });
    expect(guardHost.accountConcurrencyGuard.invalidateLimit).toHaveBeenCalledWith('t', 'a');
    expect(guardHost.providerConcurrencyGuard.invalidateLimits).toHaveBeenCalledWith('t', 'a');
    await child.shutdown();
  });

  it('a cache invalidation published here goes to the primary as `cache.invalidate`, and to this process too', () => {
    const channel = fakeChannel();
    const local = vi.fn();
    const off = cacheChannel.onCacheInvalidation('agency-campaign-stats', local);
    try {
      installIpcCacheInvalidation(channel as any);
      cacheChannel.publishCacheInvalidation({ cache: 'agency-campaign-stats', key: 'camp-1' });
      expect(channel.emit).toHaveBeenCalledWith('cache.invalidate', { cache: 'agency-campaign-stats', key: 'camp-1' });
      expect(local).toHaveBeenCalledWith('camp-1');
    } finally {
      off();
      cacheChannel.setCacheInvalidationForwarder(null);
    }
  });
});
