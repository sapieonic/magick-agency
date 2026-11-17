import { describe, expect, it, vi } from 'vitest';
import { supersedeTargets } from '../../../../src/agency/listen/listen-revocation.js';
import type { ListenSessionRecord } from '../../../../src/db/repositories/agency.repository.js';
import type { ListenSessionHandle } from '../../../../src/agency/listen/listen-registry.js';

/*
 * How a supervisor's listens are ended from outside the process that holds them (LS10, LS5): the
 * supersede across processes, which ranks the supervisor's open rows, this process's and the
 * others', in one order (LS16 e, p, LS22 v). (The revocation hook is the platform's membership
 * change, `test/unit/rbac/membership-changed.test.ts`.)
 */

describe('supersedeTargets', () => {
  /** A row started `at` seconds into the minute, on `call` (by default one of its own). */
  const row = (id: string, replica: string, at: number, call = `call-${id}`): ListenSessionRecord =>
    ({ id, replica_id: replica, call_id: call, started_at: new Date(Date.UTC(2026, 10, 16, 10, 0, at)) } as ListenSessionRecord);
  const session = (listenId: string, callId = `call-${listenId}`) =>
    ({ listenId, callId, tenantId: 't', listenerUserId: 'u' } as ListenSessionHandle);
  /** A registry that holds `held` (the admitted session among them) and nothing else. */
  const registryOf = (maxPerUser: number, ...held: ListenSessionHandle[]) => ({
    get: (id: string) => held.find((s) => s.listenId === id),
    limits: { maxPerCall: 2, maxPerProcess: 20, maxPerUser, recheckMs: 1 },
  });

  it('at the default 1: every older listen, those another process holds to send and this one\'s own to end here', async () => {
    const mine = session('new');
    const read = vi.fn(async () => [row('new', 'me', 30), row('older-elsewhere', 'w2', 20), row('older-here', 'me', 10)]);
    expect(await supersedeTargets(mine, registryOf(1, mine), 'me', read)).toEqual({ here: ['older-here'], elsewhere: ['older-elsewhere'] });
    expect(read).toHaveBeenCalledWith('t', 'u');
  });

  it('keeps maxPerUser of the newest (this one counted); nothing past it, nothing to end', async () => {
    const mine = session('new');
    const read = async () => [row('new', 'me', 30), row('b', 'w2', 20), row('c', 'w3', 10)];
    expect(await supersedeTargets(mine, registryOf(2, mine), 'me', read)).toEqual({ here: [], elsewhere: ['c'] });
    expect(await supersedeTargets(mine, registryOf(2, mine), 'me', async () => [row('new', 'me', 30), row('b', 'w2', 20)]))
      .toEqual({ here: [], elsewhere: [] });
  });

  it('maxPerUser 2: this process\'s and the others\' rows ranked together; a local listen past the cap ends here', async () => {
    // A on worker 1, then B (newer) on worker 2; N admitted on worker 1, whose own admission saw
    // only A and kept it. Ranked together, B is the one kept: A ends.
    const n = session('N');
    const rows = async () => [row('N', 'w1', 30), row('B', 'w2', 20), row('A', 'w1', 10)];
    expect(await supersedeTargets(n, registryOf(2, n), 'w1', rows)).toEqual({ here: ['A'], elsewhere: [] });
    // The other way about (the local one newer): the remote one ends.
    const flipped = async () => [row('N', 'w1', 30), row('A', 'w1', 20), row('B', 'w2', 10)];
    expect(await supersedeTargets(n, registryOf(2, n), 'w1', flipped)).toEqual({ here: [], elsewhere: ['B'] });
    // maxPerUser 3 with four older listens on both sides: the two oldest end, wherever they are.
    const four = async () => [row('N', 'w1', 50), row('a', 'w2', 40), row('b', 'w1', 30), row('c', 'w1', 20), row('d', 'w2', 10)];
    expect(await supersedeTargets(n, registryOf(3, n), 'w1', four)).toEqual({ here: ['c'], elsewhere: ['d'] });
  });

  it('LS22 v: an older listen of the supervisor on the same call ends whatever the cap, and does not use up a place', async () => {
    const n = session('N', 'call-1');
    const rows = async () => [row('N', 'w1', 30, 'call-1'), row('same', 'w1', 20, 'call-1'), row('other', 'w2', 10, 'call-2')];
    expect(await supersedeTargets(n, registryOf(2, n), 'w1', rows)).toEqual({ here: ['same'], elsewhere: [] });
  });

  it('two listens admitted at once in two workers: only the older ends, by the newer (never both)', async () => {
    const inW1 = session('in-w1');
    const inW2 = session('in-w2');
    const rows = async () => [row('in-w2', 'w2', 31), row('in-w1', 'w1', 30)];
    // Worker 1 admitted the older listen: the newer one in worker 2 is not its to end.
    expect(await supersedeTargets(inW1, registryOf(1, inW1), 'w1', rows)).toEqual({ here: [], elsewhere: [] });
    // Worker 2 admitted the newer one: it ends the older.
    expect(await supersedeTargets(inW2, registryOf(1, inW2), 'w2', rows)).toEqual({ here: [], elsewhere: ['in-w1'] });
    // The same start: the id breaks the tie, the same way on both sides.
    const a = session('aaaa');
    const b = session('bbbb');
    const tie = async () => [row('aaaa', 'w1', 30), row('bbbb', 'w2', 30)];
    expect(await supersedeTargets(a, registryOf(1, a), 'w1', tie)).toEqual({ here: [], elsewhere: [] });
    expect(await supersedeTargets(b, registryOf(1, b), 'w2', tie)).toEqual({ here: [], elsewhere: ['aaaa'] });
  });

  it('a session whose own row is gone (ended under the read) supersedes nothing', async () => {
    const mine = session('new');
    expect(await supersedeTargets(mine, registryOf(1, mine), 'me', async () => [row('other', 'w2', 10)])).toEqual({ here: [], elsewhere: [] });
  });

  it('a session no longer open here when the rows come back supersedes nothing: an older row admitted after it already ended it', async () => {
    // Its row is still open (the close is in flight), but a later admission here ended it: ranking
    // it now would end that admission's listen too, and leave the supervisor none.
    const mine = session('new');
    const read = async () => [row('new', 'me', 30), row('older-here', 'me', 20), row('older-elsewhere', 'w2', 10)];
    expect(await supersedeTargets(mine, registryOf(1), 'me', read)).toEqual({ here: [], elsewhere: [] });
  });
});
