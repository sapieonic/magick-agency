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
const { agencyListenSessionRepository } = await import('../../../src/db/repositories/agency.repository.js');

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
  const app = { close: vi.fn(async () => {}), server: {} };
  const runtime = {
      replicaId: 'h:mw0:1',
      stations: { onAttached: vi.fn(), onDetached: vi.fn(), all: () => [] },
      stopShard: vi.fn(async () => {}),
      listen: {
        shutdown: vi.fn(async () => {}), revokeUser: vi.fn(async () => 0), endSessions: vi.fn(async (_ids: string[], _reason: string) => 0),
        limits: { maxPerUser: 1 }, get: (_id: string): unknown => undefined,
      },
      supersedeListensElsewhere: null as null | ((session: unknown) => void),
  };
  const child = startMediaChild({
    slot: 0,
    channel: channel as any,
    runtime: runtime as any,
    bridge: { observeLeases: vi.fn(), getActiveCallIds: () => [], gracefulShutdown: vi.fn(async () => {}) } as any,
    guardHost: guardHost as any,
    app: app as any,
    core: { close: vi.fn(async () => {}) } as any,
  });
  return { channel, guardHost, child, runtime, app };
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

  it('`listen.revoke` re-checks the supervisor (a revocation) or ends exactly the named listens (a supersede); shutdown ends the listens before the app closes', async () => {
    const { channel, child, runtime, app } = start();
    channel.events.get('listen.revoke')!({ tenantId: 't', userId: 'u', reason: 'permission_revoked', listenIds: null, change: 'revoked' });
    expect(runtime.listen.revokeUser).toHaveBeenLastCalledWith('t', 'u', 'revoked');
    // A seat added carries its kind through (LS22 w: an unreadable check is left to the pass).
    channel.events.get('listen.revoke')!({ tenantId: 't', userId: 'u', reason: 'permission_revoked', listenIds: null, change: 'added' });
    expect(runtime.listen.revokeUser).toHaveBeenLastCalledWith('t', 'u', 'added');
    expect(runtime.listen.endSessions).not.toHaveBeenCalled();
    channel.events.get('listen.revoke')!({ tenantId: 't', userId: 'u', reason: 'superseded', listenIds: ['l1', 'l2'] });
    expect(runtime.listen.endSessions).toHaveBeenCalledWith(['l1', 'l2'], 'superseded');
    expect(runtime.supersedeListensElsewhere).toBeTypeOf('function');
    const order: string[] = [];
    runtime.listen.shutdown.mockImplementation(async () => { order.push('listen'); });
    app.close.mockImplementation(async () => { order.push('app'); });
    await child.shutdown();
    expect(order).toEqual(['listen', 'app']);
    expect(runtime.listen.shutdown).toHaveBeenCalledTimes(1);
  });

  it('LS22 v: a listen admitted here ends the supervisor\'s listens past the cap ranked across workers: its own here, the others\' through the primary', async () => {
    const { channel, child, runtime } = start();
    const n = { listenId: 'N', callId: 'c0', tenantId: 't', listenerUserId: 'u' };
    runtime.listen.limits.maxPerUser = 2;
    runtime.listen.get = ((id: string) => (id === 'N' ? n : undefined)) as any;
    const at = (s: number) => new Date(Date.UTC(2026, 10, 16, 10, 0, s));
    const read = vi.spyOn(agencyListenSessionRepository, 'listOpenForListener');
    try {
      // A here, then B (newer) on the other worker, then N here: A is the one past the cap.
      read.mockResolvedValueOnce([
        { id: 'N', replica_id: 'h:mw0:1', call_id: 'c0', started_at: at(30) },
        { id: 'B', replica_id: 'h:mw1:1', call_id: 'c1', started_at: at(20) },
        { id: 'A', replica_id: 'h:mw0:1', call_id: 'c2', started_at: at(10) },
      ] as any);
      runtime.supersedeListensElsewhere!(n);
      await vi.waitFor(() => expect(runtime.listen.endSessions).toHaveBeenCalledWith(['A'], 'superseded'));
      expect(channel.emit).not.toHaveBeenCalledWith('listen.revoke', expect.anything());
      // The other way about: the other worker's is the oldest, and goes to the primary.
      runtime.listen.endSessions.mockClear();
      read.mockResolvedValueOnce([
        { id: 'N', replica_id: 'h:mw0:1', call_id: 'c0', started_at: at(30) },
        { id: 'A', replica_id: 'h:mw0:1', call_id: 'c2', started_at: at(20) },
        { id: 'B', replica_id: 'h:mw1:1', call_id: 'c1', started_at: at(10) },
      ] as any);
      runtime.supersedeListensElsewhere!(n);
      await vi.waitFor(() => expect(channel.emit).toHaveBeenCalledWith('listen.revoke', {
        tenantId: 't', userId: 'u', reason: 'superseded', listenIds: ['B'],
      }));
      expect(runtime.listen.endSessions).not.toHaveBeenCalled();
    } finally {
      read.mockRestore();
      await child.shutdown();
    }
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
