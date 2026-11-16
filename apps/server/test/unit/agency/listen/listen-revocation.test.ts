import { describe, expect, it, vi } from 'vitest';
import {
  onListenRevocation,
  remoteSupersedeTargets,
  revokeListens,
} from '../../../../src/agency/listen/listen-revocation.js';
import type { ListenSessionRecord } from '../../../../src/db/repositories/agency.repository.js';
import type { ListenSessionHandle } from '../../../../src/agency/listen/listen-registry.js';

/*
 * How a supervisor's listens are ended from outside the process that holds them (LS10, LS5):
 * the revocation hook the user routes call, and the supersede of listens held by other processes.
 */

describe('revokeListens', () => {
  it('runs every registered handler, survives one that throws, and stops after unsubscribe', async () => {
    const a = vi.fn();
    const b = vi.fn(async () => { throw new Error('ipc down'); });
    const offA = onListenRevocation(a);
    const offB = onListenRevocation(b);
    await expect(revokeListens('t', 'u')).resolves.toBeUndefined();
    expect(a).toHaveBeenCalledWith('t', 'u');
    expect(b).toHaveBeenCalledWith('t', 'u');
    offA();
    offB();
    await revokeListens('t', 'u');
    expect(a).toHaveBeenCalledTimes(1);
  });
});

describe('remoteSupersedeTargets', () => {
  const row = (id: string, replica: string): ListenSessionRecord => ({ id, replica_id: replica } as ListenSessionRecord);
  const session = { listenId: 'new', tenantId: 't', listenerUserId: 'u' } as ListenSessionHandle;

  it('names the supervisor\'s other open listens past the cap that another process holds', async () => {
    const registry = { get: () => undefined, limits: { maxPerCall: 2, maxPerProcess: 20, maxPerUser: 1, recheckMs: 1 } };
    const read = vi.fn(async () => [row('new', 'me'), row('older-elsewhere', 'w2'), row('older-here', 'me')]);
    expect(await remoteSupersedeTargets(session, registry, 'me', read)).toEqual(['older-elsewhere']);
    expect(read).toHaveBeenCalledWith('t', 'u');
  });

  it('keeps maxPerUser of the newest (this one counted); nothing past it, nothing to send', async () => {
    const registry = { get: () => undefined, limits: { maxPerCall: 2, maxPerProcess: 20, maxPerUser: 2, recheckMs: 1 } };
    const read = async () => [row('new', 'me'), row('b', 'w2'), row('c', 'w3')];
    expect(await remoteSupersedeTargets(session, registry, 'me', read)).toEqual(['c']);
    expect(await remoteSupersedeTargets(session, registry, 'me', async () => [row('new', 'me'), row('b', 'w2')])).toEqual([]);
  });
});
