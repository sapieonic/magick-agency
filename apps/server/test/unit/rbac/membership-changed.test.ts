import { beforeEach, describe, expect, it, vi } from 'vitest';

const cache = vi.hoisted(() => ({
  del: vi.fn(async (..._keys: string[]) => {}),
  delForRevocation: vi.fn(async (..._keys: string[]) => true),
}));
vi.mock('../../../src/cache/redis-cache.js', () => ({ redisCache: cache }));

import { membershipAdded, membershipRevoked, onMembershipChanged } from '../../../src/rbac/membership-changed.js';

/*
 * A membership change (`rbac/membership-changed.ts`): the cached membership dropped, then every
 * subscriber told (live call listening's re-check, LS10, LS22 l).
 */
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
    expect(a).toHaveBeenCalledWith('t', 'u');
    expect(b).toHaveBeenCalledWith('t', 'u');
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
    expect(cache.del).not.toHaveBeenCalled();
    off();
  });
});
