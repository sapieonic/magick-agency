import { beforeEach, describe, expect, it, vi } from 'vitest';

const cache = vi.hoisted(() => ({
  del: vi.fn(async (..._keys: string[]) => {}),
  delForRevocation: vi.fn(async (..._keys: string[]) => true),
}));
vi.mock('../../../src/cache/redis-cache.js', () => ({ redisCache: cache }));

import {
  membershipAdded,
  membershipNotificationsSettled,
  membershipRevoked,
  onMembershipChanged,
} from '../../../src/rbac/membership-changed.js';

/*
 * A membership change (`rbac/membership-changed.ts`): the cached membership dropped, then every
 * subscriber told (live call listening's re-check, LS10, LS22 l), off the request path (LS22 w):
 * the change answers once the cache is dropped, without waiting for a subscriber.
 */

/** A promise the test settles, and whether it has. */
function held() {
  let release!: () => void;
  let fail!: (err: Error) => void;
  const promise = new Promise<void>((res, rej) => { release = res; fail = rej; });
  return { promise, release, fail };
}
describe('membership changes', () => {
  beforeEach(() => {
    cache.del.mockClear();
    cache.delForRevocation.mockClear().mockResolvedValue(true);
  });

  it('a seat added drops the cached membership, then tells every subscriber, surviving one that throws', async () => {
    const a = vi.fn();
    const b = vi.fn(async () => { throw new Error('ipc down'); });
    const offA = onMembershipChanged(a);
    const offB = onMembershipChanged(b);
    await expect(membershipAdded('t', 'u')).resolves.toBeUndefined();
    expect(cache.del).toHaveBeenCalledWith('cache:membership:u:t');
    // Told it is an addition (LS22 w: a check it cannot make is left to the periodic pass).
    expect(a).toHaveBeenCalledWith('t', 'u', 'added');
    expect(b).toHaveBeenCalledWith('t', 'u', 'added');
    expect(a.mock.invocationCallOrder[0]!).toBeGreaterThan(cache.del.mock.invocationCallOrder[0]!);
    offA();
    offB();
    await membershipAdded('t', 'u');
    expect(a).toHaveBeenCalledTimes(1);
  });

  it('a revocation drops it with retries, tells the subscribers whatever the drop did, and says whether it cleared', async () => {
    const a = vi.fn();
    const off = onMembershipChanged(a);
    await expect(membershipRevoked('t', 'u')).resolves.toBe(true);
    expect(cache.delForRevocation).toHaveBeenCalledWith('cache:membership:u:t');
    cache.delForRevocation.mockResolvedValue(false);
    await expect(membershipRevoked('t', 'u')).resolves.toBe(false);
    expect(a).toHaveBeenCalledTimes(2);
    // Told it is a revocation (LS16 c: the re-check fails closed).
    expect(a).toHaveBeenNthCalledWith(1, 't', 'u', 'revoked');
    expect(a).toHaveBeenNthCalledWith(2, 't', 'u', 'revoked');
    expect(cache.del).not.toHaveBeenCalled();
    off();
  });

  it('answers once the cache is dropped, without waiting for a subscriber; the subscriber is still told synchronously, after the drop', async () => {
    for (const change of [membershipAdded, membershipRevoked]) {
      const slow = held();
      const handler = vi.fn(() => slow.promise);
      const off = onMembershipChanged(handler);
      let answered = false;
      const done = change('t', 'u').then(() => { answered = true; });
      await done;
      expect(answered).toBe(true);
      expect(handler).toHaveBeenCalledWith('t', 'u', change === membershipAdded ? 'added' : 'revoked');
      // The notification is still in flight; the test seam waits for it.
      let settled = false;
      const flushed = membershipNotificationsSettled().then(() => { settled = true; });
      await Promise.resolve();
      expect(settled).toBe(false);
      slow.release();
      await flushed;
      expect(settled).toBe(true);
      off();
    }
  });

  it('a subscriber that rejects later, or throws synchronously, is logged, never an unhandled rejection or a failed change', async () => {
    const slow = held();
    const offA = onMembershipChanged(() => slow.promise);
    const offB = onMembershipChanged(() => { throw new Error('sync'); });
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      await expect(membershipRevoked('t', 'u')).resolves.toBe(true);
      slow.fail(new Error('database down'));
      await membershipNotificationsSettled();
      await new Promise((r) => setImmediate(r));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
      offA();
      offB();
    }
  });
});
