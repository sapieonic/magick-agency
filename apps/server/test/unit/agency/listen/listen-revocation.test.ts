import { describe, expect, it, vi } from 'vitest';
import { remoteSupersedeTargets } from '../../../../src/agency/listen/listen-revocation.js';
import type { ListenSessionRecord } from '../../../../src/db/repositories/agency.repository.js';
import type { ListenSessionHandle } from '../../../../src/agency/listen/listen-registry.js';

/*
 * How a supervisor's listens are ended from outside the process that holds them (LS10, LS5): the
 * supersede of listens held by other processes. (The revocation hook is the platform's membership
 * change, `test/unit/rbac/membership-changed.test.ts`.)
 */

describe('remoteSupersedeTargets', () => {
  /** A row started `at` seconds into the minute. */
  const row = (id: string, replica: string, at: number): ListenSessionRecord =>
    ({ id, replica_id: replica, started_at: new Date(Date.UTC(2026, 10, 16, 10, 0, at)) } as ListenSessionRecord);
  const session = (listenId: string) => ({ listenId, tenantId: 't', listenerUserId: 'u' } as ListenSessionHandle);
  const registryOf = (maxPerUser: number) => ({ get: () => undefined, limits: { maxPerCall: 2, maxPerProcess: 20, maxPerUser, recheckMs: 1 } });

  it('names the supervisor\'s other open listens past the cap that another process holds', async () => {
    const read = vi.fn(async () => [row('new', 'me', 30), row('older-elsewhere', 'w2', 20), row('older-here', 'me', 10)]);
    expect(await remoteSupersedeTargets(session('new'), registryOf(1), 'me', read)).toEqual(['older-elsewhere']);
    expect(read).toHaveBeenCalledWith('t', 'u');
  });

  it('keeps maxPerUser of the newest (this one counted); nothing past it, nothing to send', async () => {
    const read = async () => [row('new', 'me', 30), row('b', 'w2', 20), row('c', 'w3', 10)];
    expect(await remoteSupersedeTargets(session('new'), registryOf(2), 'me', read)).toEqual(['c']);
    expect(await remoteSupersedeTargets(session('new'), registryOf(2), 'me', async () => [row('new', 'me', 30), row('b', 'w2', 20)])).toEqual([]);
  });

  it('two listens admitted at once in two workers: only the older ends, by the newer (never both)', async () => {
    const rows = async () => [row('in-w2', 'w2', 31), row('in-w1', 'w1', 30)];
    // Worker 1 admitted the older listen: the newer one in worker 2 is not its to end.
    expect(await remoteSupersedeTargets(session('in-w1'), registryOf(1), 'w1', rows)).toEqual([]);
    // Worker 2 admitted the newer one: it ends the older.
    expect(await remoteSupersedeTargets(session('in-w2'), registryOf(1), 'w2', rows)).toEqual(['in-w1']);
    // The same start: the id breaks the tie, the same way on both sides.
    const tie = async () => [row('aaaa', 'w1', 30), row('bbbb', 'w2', 30)];
    expect(await remoteSupersedeTargets(session('aaaa'), registryOf(1), 'w1', tie)).toEqual([]);
    expect(await remoteSupersedeTargets(session('bbbb'), registryOf(1), 'w2', tie)).toEqual(['aaaa']);
  });

  it('a session whose own row is gone (ended under the read) supersedes nothing', async () => {
    expect(await remoteSupersedeTargets(session('new'), registryOf(1), 'me', async () => [row('other', 'w2', 10)])).toEqual([]);
  });
});
