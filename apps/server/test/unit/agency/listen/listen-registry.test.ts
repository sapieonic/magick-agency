import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgencyListenEndReason } from '@magick-agency/contracts/agency';
import {
  ListenRegistry, STALE_AFTER_RECHECKS, type ListenAccessCheck, type ListenAccessSubject, type ListenAccessVerdict, type ListenLimits, type ListenSessionHandle,
} from '../../../../src/agency/listen/listen-registry.js';
import { listenAccessCheck, membershipMayListen, type ListenAccessDeps } from '../../../../src/agency/listen/listen-access.js';
import type { MembershipRecord } from '@magick-agency/db/models/membership.model';
import { hasPermission } from '@magick-agency/contracts/rbac';
import { selectMembership } from '../../../../src/api/middleware/tenant-context.middleware.js';

/*
 * The listen registry (docs/listening.md §4, LS5, LS10, LS16): the three caps, the supersede, the
 * revocation and its periodic re-check against a database stub (the immediate path fails closed,
 * the periodic pass fails open under the staleness cap), the revocation generation between a grant
 * and its admission, the rows' upkeep on the tick, the shutdown. And the re-check's question itself
 * (`listen-access.ts`): the membership floor and both flags, a failed read unchecked.
 */

const LIMITS: ListenLimits = { maxPerCall: 2, maxPerProcess: 3, maxPerUser: 1, recheckMs: 30_000 };

let clock = 1_000;
interface FakeSession extends ListenSessionHandle { ended: AgencyListenEndReason[] }

function session(over: Partial<ListenSessionHandle> & { listenId: string }, registry?: ListenRegistry): FakeSession {
  const s: FakeSession = {
    tenantId: 't1', accountId: 'a1', callId: 'c1', listenerUserId: 'u1', recording: true, startedAt: clock++,
    ...over,
    ended: [],
    end: vi.fn(async (reason: AgencyListenEndReason) => {
      s.ended.push(reason);
      registry?.remove(s.listenId);
    }),
  };
  return s;
}

/** Reserve and admit `s` (fails the test if the registry refuses). */
function open(registry: ListenRegistry, s: FakeSession): FakeSession {
  const r = registry.reserve({ listenId: s.listenId, callId: s.callId, tenantId: s.tenantId, listenerUserId: s.listenerUserId });
  if (!r.ok) throw new Error(`refused ${r.code}`);
  if (!registry.admit(r.reservation, s).ok) throw new Error('admission refused');
  return s;
}

/** A verdict: these revoked, those unchecked, the rest passed. */
const verdict = (revoked: Iterable<string> = [], unchecked: Iterable<string> = []): ListenAccessVerdict =>
  ({ revoked: new Set(revoked), unchecked: new Set(unchecked) });
const allPass: ListenAccessCheck = async () => verdict();

function registryWith(access: ListenAccessCheck = vi.fn(allPass), limits: Partial<ListenLimits> = {}, over: { maintainRows?: (held: () => ReadonlySet<string>) => Promise<unknown> } = {}) {
  return new ListenRegistry({ limits: { ...LIMITS, ...limits }, access, ...over });
}

afterEach(() => { vi.useRealTimers(); });

describe('ListenRegistry: the caps (LS5)', () => {
  it('admits up to maxPerCall on one call, then refuses listen_limit_call; another call is unaffected', () => {
    const registry = registryWith();
    open(registry, session({ listenId: 'l1', listenerUserId: 'u1' }, registry));
    open(registry, session({ listenId: 'l2', listenerUserId: 'u2' }, registry));
    expect(registry.check('c1', 't1', 'u3')).toBe('listen_limit_call');
    expect(registry.reserve({ listenId: 'l3', callId: 'c1', tenantId: 't1', listenerUserId: 'u3' })).toEqual({ ok: false, code: 'listen_limit_call' });
    expect(registry.check('c2', 't1', 'u3')).toBeNull();
  });

  it('refuses listen_limit_server at maxPerProcess, across calls', () => {
    const registry = registryWith();
    open(registry, session({ listenId: 'l1', callId: 'c1', listenerUserId: 'u1' }, registry));
    open(registry, session({ listenId: 'l2', callId: 'c2', listenerUserId: 'u2' }, registry));
    open(registry, session({ listenId: 'l3', callId: 'c3', listenerUserId: 'u3' }, registry));
    expect(registry.check('c4', 't1', 'u4')).toBe('listen_limit_server');
  });

  it('a reservation holds its slot until it is admitted or released: two upgrades cannot take one slot', () => {
    const registry = registryWith(undefined, { maxPerCall: 1 });
    const first = registry.reserve({ listenId: 'l1', callId: 'c1', tenantId: 't1', listenerUserId: 'u1' });
    expect(first.ok).toBe(true);
    expect(registry.reserve({ listenId: 'l2', callId: 'c1', tenantId: 't1', listenerUserId: 'u2' })).toEqual({ ok: false, code: 'listen_limit_call' });
    if (first.ok) registry.release(first.reservation);
    expect(registry.reserve({ listenId: 'l2', callId: 'c1', tenantId: 't1', listenerUserId: 'u2' }).ok).toBe(true);
  });

  it('a supervisor already on the call is not refused by their own session (a reconnect supersedes it)', () => {
    const registry = registryWith();
    open(registry, session({ listenId: 'l1', listenerUserId: 'u1' }, registry));
    open(registry, session({ listenId: 'l2', listenerUserId: 'u2' }, registry));
    expect(registry.check('c1', 't1', 'u1')).toBeNull();
  });

  it('a stopping registry admits nothing: listen_unavailable (a fresh grant reaches the next process), not the server\'s limit', async () => {
    const registry = registryWith();
    await registry.shutdown();
    expect(registry.check('c1', 't1', 'u1')).toBe('listen_unavailable');
    expect(registry.reserve({ listenId: 'l1', callId: 'c1', tenantId: 't1', listenerUserId: 'u1' })).toEqual({ ok: false, code: 'listen_unavailable' });
  });
});

describe('ListenRegistry: supersede', () => {
  it('a second listen by the same supervisor ends the first `superseded`; other supervisors keep theirs', () => {
    const registry = registryWith();
    const first = open(registry, session({ listenId: 'l1', callId: 'c1', listenerUserId: 'u1' }, registry));
    const other = open(registry, session({ listenId: 'o1', callId: 'c1', listenerUserId: 'u2' }, registry));
    const second = open(registry, session({ listenId: 'l2', callId: 'c2', listenerUserId: 'u1' }, registry));
    expect(first.ended).toEqual(['superseded']);
    expect(other.ended).toEqual([]);
    expect(second.ended).toEqual([]);
    expect([...registry.held()].sort()).toEqual(['l2', 'o1']);
  });

  it('with maxPerUser 2 only the oldest past the cap goes; the same user id in another tenant is someone else', () => {
    const registry = registryWith(undefined, { maxPerUser: 2, maxPerProcess: 10 });
    const a = open(registry, session({ listenId: 'a', callId: 'c1' }, registry));
    const b = open(registry, session({ listenId: 'b', callId: 'c2' }, registry));
    const elsewhere = open(registry, session({ listenId: 'x', callId: 'c9', tenantId: 't2' }, registry));
    open(registry, session({ listenId: 'c', callId: 'c3' }, registry));
    expect(a.ended).toEqual(['superseded']);
    expect(b.ended).toEqual([]);
    expect(elsewhere.ended).toEqual([]);
  });

  it('endSessions ends exactly the named sessions held here (a supersede decided in another process)', async () => {
    const registry = registryWith();
    const a = open(registry, session({ listenId: 'a', listenerUserId: 'u1' }, registry));
    const b = open(registry, session({ listenId: 'b', listenerUserId: 'u2' }, registry));
    expect(await registry.endSessions(['a', 'not-here'], 'superseded')).toBe(1);
    expect(a.ended).toEqual(['superseded']);
    expect(b.ended).toEqual([]);
  });

  it('LS22 s: endSessions reaches a listen still in its upgrade: its admission is refused superseded, the slot given back', async () => {
    // Another worker's newer listen read this one's row (written, not yet admitted) and named it.
    const registry = registryWith(undefined, { maxPerCall: 1 });
    const r = registry.reserve({ listenId: 'mid', callId: 'c1', tenantId: 't1', listenerUserId: 'u1' });
    if (!r.ok) throw new Error('refused');
    expect(await registry.endSessions(['mid'], 'superseded')).toBe(1);
    const s = session({ listenId: 'mid' }, registry);
    expect(registry.admit(r.reservation, s)).toEqual({ ok: false, reason: 'superseded' });
    expect(registry.size).toBe(0);
    expect(registry.held().size).toBe(0);
    // A later upgrade of that supervisor is not touched by it.
    const again = registry.reserve({ listenId: 'next', callId: 'c1', tenantId: 't1', listenerUserId: 'u1' });
    if (!again.ok) throw new Error('refused');
    expect(registry.admit(again.reservation, session({ listenId: 'next' }, registry)).ok).toBe(true);
  });

  it('LS22 s: a supersede mark on a reservation given back is forgotten with it', async () => {
    const registry = registryWith();
    const r = registry.reserve({ listenId: 'gone', callId: 'c1', tenantId: 't1', listenerUserId: 'u1' });
    if (!r.ok) throw new Error('refused');
    await registry.endSessions(['gone'], 'superseded');
    registry.release(r.reservation);
    // Nothing is left behind: the next reservation under the same id (a test's reuse) is admitted.
    const again = registry.reserve({ listenId: 'gone', callId: 'c1', tenantId: 't1', listenerUserId: 'u1' });
    if (!again.ok) throw new Error('refused');
    expect(registry.admit(again.reservation, session({ listenId: 'gone' }, registry)).ok).toBe(true);
  });
});

describe('ListenRegistry: revocation and the re-check (LS10, LS16 c, d)', () => {
  it('revokeUser re-checks only that supervisor\'s sessions in the tenant, and ends those that fail', async () => {
    const access = vi.fn(async (subjects: readonly ListenAccessSubject[]) => verdict(subjects.map((s) => s.listenId)));
    const registry = registryWith(access, { maxPerProcess: 10 });
    const mine = open(registry, session({ listenId: 'm', listenerUserId: 'u1' }, registry));
    const theirs = open(registry, session({ listenId: 't', listenerUserId: 'u2' }, registry));
    const otherTenant = open(registry, session({ listenId: 'o', listenerUserId: 'u1', tenantId: 't2', callId: 'c9' }, registry));
    expect(await registry.revokeUser('t1', 'u1')).toBe(1);
    expect(access).toHaveBeenCalledTimes(1);
    expect(access.mock.calls[0]![0].map((s) => s.listenId)).toEqual(['m']);
    expect(mine.ended).toEqual(['permission_revoked']);
    expect(theirs.ended).toEqual([]);
    expect(otherTenant.ended).toEqual([]);
  });

  it('a role change that still clears the floor ends nothing; with no session it reads nothing', async () => {
    const access = vi.fn(allPass);
    const registry = registryWith(access);
    expect(await registry.revokeUser('t1', 'u1')).toBe(0);
    expect(access).not.toHaveBeenCalled();
    const s = open(registry, session({ listenId: 'l1' }, registry));
    expect(await registry.revokeUser('t1', 'u1')).toBe(0);
    expect(s.ended).toEqual([]);
  });

  it('the immediate path fails CLOSED: a check that throws, or leaves a session unchecked, ends it access_unverified (LS22), not revoked', async () => {
    const throwing = registryWith(vi.fn(async () => { throw new Error('ECONNREFUSED'); }));
    const a = open(throwing, session({ listenId: 'a' }, throwing));
    expect(await throwing.revokeUser('t1', 'u1')).toBe(1);
    expect(a.ended).toEqual(['access_unverified']);

    const partial = registryWith(vi.fn(async () => verdict(['c'], ['b'])), { maxPerUser: 2 });
    const b = open(partial, session({ listenId: 'b' }, partial));
    const c = open(partial, session({ listenId: 'c', callId: 'c2' }, partial));
    expect(await partial.revokeUser('t1', 'u1')).toBe(2);
    expect(b.ended).toEqual(['access_unverified']);
    // What could be read and says no is still a revocation.
    expect(c.ended).toEqual(['permission_revoked']);
  });

  it('the periodic pass fails OPEN: a check that cannot be made ends nothing, short of the staleness cap', async () => {
    const registry = registryWith(vi.fn(async () => { throw new Error('ECONNREFUSED'); }));
    const s = open(registry, session({ listenId: 'l1' }, registry));
    expect(await registry.recheck()).toBe(0);
    expect(s.ended).toEqual([]);
  });

  it('the staleness cap is 2 re-checks (LS21): 60 s at the default AGENCY_LISTEN_RECHECK_MS', () => {
    expect(STALE_AFTER_RECHECKS).toBe(2);
  });

  it('the staleness cap: unverified for STALE_AFTER_RECHECKS × recheckMs ends access_unverified (LS21); a good check resets it', async () => {
    vi.useFakeTimers();
    let failing = false;
    const access = vi.fn(async (subjects: readonly ListenAccessSubject[]) => {
      if (failing) throw new Error('down');
      return verdict([], subjects.filter((x) => x.listenId === 'flaky').map((x) => x.listenId));
    });
    const registry = registryWith(access, { maxPerProcess: 10 });
    const fine = open(registry, session({ listenId: 'fine', listenerUserId: 'u1' }, registry));
    const flaky = open(registry, session({ listenId: 'flaky', listenerUserId: 'u2' }, registry));
    registry.start();
    // `flaky`'s account cannot be read on any pass; `fine` passes until the store goes down.
    await vi.advanceTimersByTimeAsync(LIMITS.recheckMs * (STALE_AFTER_RECHECKS - 1));
    expect(flaky.ended).toEqual([]);
    failing = true;
    await vi.advanceTimersByTimeAsync(LIMITS.recheckMs);
    expect(flaky.ended).toEqual(['access_unverified']);
    expect(fine.ended).toEqual([]);
    // `fine` was last verified one interval before the outage: it goes once the cap has passed.
    await vi.advanceTimersByTimeAsync(LIMITS.recheckMs * (STALE_AFTER_RECHECKS - 2));
    expect(fine.ended).toEqual([]);
    await vi.advanceTimersByTimeAsync(LIMITS.recheckMs);
    expect(fine.ended).toEqual(['access_unverified']);
    registry.stop();
  });

  it('a pass that hangs does not hold the staleness cap off: the next ticks still end the stale sessions', async () => {
    vi.useFakeTimers();
    const registry = registryWith(vi.fn(() => new Promise<ListenAccessVerdict>(() => {})));
    const s = open(registry, session({ listenId: 'l1' }, registry));
    registry.start();
    await vi.advanceTimersByTimeAsync(LIMITS.recheckMs * STALE_AFTER_RECHECKS - 1);
    expect(s.ended).toEqual([]);
    await vi.advanceTimersByTimeAsync(LIMITS.recheckMs);
    expect(s.ended).toEqual(['access_unverified']);
    registry.stop();
  });

  it('a tick still in flight is not stacked on (LS22 k): the next ticks only apply the staleness cap', async () => {
    vi.useFakeTimers();
    const access = vi.fn(allPass);
    const maintainRows = vi.fn(() => new Promise<void>(() => {}));
    const registry = registryWith(access, {}, { maintainRows });
    const s = open(registry, session({ listenId: 'l1' }, registry));
    registry.start();
    await vi.advanceTimersByTimeAsync(LIMITS.recheckMs);
    expect(access).toHaveBeenCalledTimes(1);
    expect(maintainRows).toHaveBeenCalledTimes(1);
    // The first tick's upkeep hangs: three more ticks start no pass and no upkeep of their own.
    await vi.advanceTimersByTimeAsync(LIMITS.recheckMs * 3);
    expect(access).toHaveBeenCalledTimes(1);
    expect(maintainRows).toHaveBeenCalledTimes(1);
    // The cap still holds: last verified on the first tick, so it is stale by now.
    expect(s.ended).toEqual(['access_unverified']);
    registry.stop();
  });

  it('the periodic re-check runs every recheckMs and ends what the database says may no longer listen', async () => {
    vi.useFakeTimers();
    let revoked = verdict();
    const access = vi.fn(async () => revoked);
    const registry = registryWith(access, { maxPerProcess: 10 });
    const a = open(registry, session({ listenId: 'a', listenerUserId: 'u1' }, registry));
    const b = open(registry, session({ listenId: 'b', listenerUserId: 'u2' }, registry));
    registry.start();
    await vi.advanceTimersByTimeAsync(LIMITS.recheckMs - 1);
    expect(access).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(access).toHaveBeenCalledTimes(1);
    expect(a.ended).toEqual([]);
    revoked = verdict(['b']);
    await vi.advanceTimersByTimeAsync(LIMITS.recheckMs);
    expect(access).toHaveBeenCalledTimes(2);
    expect(b.ended).toEqual(['permission_revoked']);
    expect(a.ended).toEqual([]);
    registry.stop();
    await vi.advanceTimersByTimeAsync(LIMITS.recheckMs * 3);
    expect(access).toHaveBeenCalledTimes(2);
  });

  it('each tick hands the rows\' upkeep the ids it holds, read when asked: open sessions and reservations (LS22 k)', async () => {
    vi.useFakeTimers();
    const maintainRows = vi.fn(async (held: () => ReadonlySet<string>) => { void held; });
    const registry = registryWith(undefined, { maxPerProcess: 10 }, { maintainRows });
    open(registry, session({ listenId: 'open1', listenerUserId: 'u1' }, registry));
    registry.reserve({ listenId: 'reserved1', callId: 'c2', tenantId: 't1', listenerUserId: 'u2' });
    registry.start();
    await vi.advanceTimersByTimeAsync(LIMITS.recheckMs);
    expect(maintainRows).toHaveBeenCalledTimes(1);
    const held = maintainRows.mock.calls[0]![0];
    expect([...held()].sort()).toEqual(['open1', 'reserved1']);
    // A getter, not a snapshot: a listen admitted after the tick began is held when it is read.
    open(registry, session({ listenId: 'open2', listenerUserId: 'u3', callId: 'c3' }, registry));
    expect([...held()].sort()).toEqual(['open1', 'open2', 'reserved1']);
    registry.stop();
  });
});

describe('ListenRegistry: between the grant and the admission (LS16 n)', () => {
  it('verify answers the database\'s verdict for one subject, and `unchecked` when the check throws', async () => {
    const subject = { listenId: 'l1', tenantId: 't1', accountId: 'a1', listenerUserId: 'u1', recording: true };
    expect(await registryWith().verify(subject)).toBe('ok');
    expect(await registryWith(async () => verdict(['l1'])).verify(subject)).toBe('revoked');
    expect(await registryWith(async () => verdict([], ['l1'])).verify(subject)).toBe('unchecked');
    expect(await registryWith(async () => { throw new Error('down'); }).verify(subject)).toBe('unchecked');
  });

  it('a grant minted before a revocation is refused at the reservation (revoke between grant and upgrade)', async () => {
    const registry = registryWith();
    const minted = registry.generation('t1', 'u1');
    await registry.revokeUser('t1', 'u1'); // no session yet: only the generation moves
    expect(registry.generation('t1', 'u1')).not.toBe(minted);
    expect(registry.reserve({ listenId: 'l1', callId: 'c1', tenantId: 't1', listenerUserId: 'u1', grantGeneration: minted }))
      .toEqual({ ok: false, code: 'permission_revoked' });
    // Someone else's grant, or the same user in another tenant, is untouched.
    expect(registry.reserve({ listenId: 'l2', callId: 'c1', tenantId: 't1', listenerUserId: 'u2', grantGeneration: registry.generation('t1', 'u2') }).ok).toBe(true);
    expect(registry.reserve({ listenId: 'l3', callId: 'c2', tenantId: 't2', listenerUserId: 'u1', grantGeneration: registry.generation('t2', 'u1') }).ok).toBe(true);
    // A fresh grant, at the new generation, is admitted.
    expect(registry.reserve({ listenId: 'l4', callId: 'c3', tenantId: 't1', listenerUserId: 'u1', grantGeneration: registry.generation('t1', 'u1') }).ok).toBe(true);
  });

  it('a revocation between the reservation and the admission refuses the admission and gives the slot back', async () => {
    const registry = registryWith(undefined, { maxPerCall: 1 });
    const r = registry.reserve({ listenId: 'l1', callId: 'c1', tenantId: 't1', listenerUserId: 'u1' });
    if (!r.ok) throw new Error('refused');
    await registry.revokeUser('t1', 'u1');
    const s = session({ listenId: 'l1' }, registry);
    expect(registry.admit(r.reservation, s)).toEqual({ ok: false, reason: 'permission_revoked' });
    expect(registry.size).toBe(0);
    expect(registry.check('c1', 't1', 'u2')).toBeNull();
    // Another supervisor's revocation does not touch this one's reservation.
    const r2 = registry.reserve({ listenId: 'l2', callId: 'c1', tenantId: 't1', listenerUserId: 'u1' });
    if (!r2.ok) throw new Error('refused');
    await registry.revokeUser('t1', 'u9');
    expect(registry.admit(r2.reservation, session({ listenId: 'l2' }, registry)).ok).toBe(true);
  });
});

describe('ListenRegistry: shutdown', () => {
  it('ends every session `server_shutdown` and resolves once they have', async () => {
    const registry = registryWith(undefined, { maxPerProcess: 10 });
    const a = open(registry, session({ listenId: 'a', listenerUserId: 'u1' }, registry));
    const b = open(registry, session({ listenId: 'b', listenerUserId: 'u2', callId: 'c2' }, registry));
    await registry.shutdown();
    expect(a.ended).toEqual(['server_shutdown']);
    expect(b.ended).toEqual(['server_shutdown']);
    expect(registry.size).toBe(0);
  });
});

// ─── The re-check's question (`listen-access.ts`) ───────────────────────────

function membership(over: Partial<MembershipRecord>): MembershipRecord {
  return { id: 'm', user_id: 'u1', tenant_id: 't1', account_id: null, role: 'account_admin', status: 'active', created_at: new Date(0), ...over } as MembershipRecord;
}

describe('listenAccessCheck', () => {
  const deps = (over: Partial<ListenAccessDeps> = {}): ListenAccessDeps => ({
    memberships: vi.fn(async () => [membership({ account_id: 'a1' })]),
    flags: vi.fn(async () => ({ enabled: true, unrecordedAllowed: true })),
    ...over,
  });
  const s = (over: Partial<ListenAccessSubject>): ListenAccessSubject =>
    ({ listenId: 'l', tenantId: 't1', accountId: 'a1', listenerUserId: 'u1', recording: true, ...over });
  const none = verdict();

  it('keeps an account admin on a recorded call with the flag on', async () => {
    expect(await listenAccessCheck(deps())([s({})])).toEqual(none);
  });

  it('starts every distinct read before awaiting any, and reads each once', async () => {
    const pending: Array<() => void> = [];
    const memberships = vi.fn(() => new Promise<MembershipRecord[]>((resolve) => {
      pending.push(() => resolve([membership({ account_id: 'a1' })]));
    }));
    const d = deps({ memberships });
    const checked = listenAccessCheck(d)([s({ listenId: 'l1' }), s({ listenId: 'l2', listenerUserId: 'u2' }), s({ listenId: 'l3' })]);
    await Promise.resolve();
    await Promise.resolve();
    // FALSIFIED by awaiting each subject's reads before starting the next's.
    expect(memberships).toHaveBeenCalledTimes(2);
    expect(d.flags).toHaveBeenCalledTimes(1);
    for (const release of pending) release();
    expect(await checked).toEqual(none);
  });

  it('ends a listen whose supervisor fell below account_admin, lost the membership, or holds only another account', async () => {
    const revoked = verdict(['l']);
    expect(await listenAccessCheck(deps({ memberships: async () => [membership({ account_id: 'a1', role: 'operator' })] }))([s({})])).toEqual(revoked);
    expect(await listenAccessCheck(deps({ memberships: async () => [] }))([s({})])).toEqual(revoked);
    expect(await listenAccessCheck(deps({ memberships: async () => [membership({ account_id: 'a2' })] }))([s({})])).toEqual(revoked);
    // A tenant-wide admin passes in every account.
    expect(await listenAccessCheck(deps({ memberships: async () => [membership({ account_id: null, role: 'tenant_admin' })] }))([s({})])).toEqual(none);
  });

  it('ends every listen in an account whose consent flag went off', async () => {
    expect(await listenAccessCheck(deps({ flags: async () => ({ enabled: false, unrecordedAllowed: true }) }))([s({})])).toEqual(verdict(['l']));
  });

  it('LS4: the unrecorded flag ends only listens on unrecorded calls', async () => {
    const d = deps({ flags: vi.fn(async () => ({ enabled: true, unrecordedAllowed: false })) });
    expect(await listenAccessCheck(d)([s({ listenId: 'rec' }), s({ listenId: 'unrec', recording: false })])).toEqual(verdict(['unrec']));
  });

  it('a read that fails leaves its listens unchecked, never passed; what could be read and says no still revokes', async () => {
    const flagsDown = deps({ flags: vi.fn(async () => { throw new Error('flag store down'); }) });
    expect(await listenAccessCheck(flagsDown)([s({})])).toEqual(verdict([], ['l']));
    // The membership says no: revoked, whatever the flags.
    const demoted = deps({ memberships: async () => [membership({ account_id: 'a1', role: 'viewer' })], flags: async () => { throw new Error('down'); } });
    expect(await listenAccessCheck(demoted)([s({})])).toEqual(verdict(['l']));
    // The flags say no: revoked, whatever the membership.
    const off = deps({ memberships: async () => { throw new Error('down'); }, flags: async () => ({ enabled: false, unrecordedAllowed: true }) });
    expect(await listenAccessCheck(off)([s({})])).toEqual(verdict(['l']));
    // One account unreadable: only its listens are unchecked.
    const oneDown = deps({ memberships: async () => [membership({ account_id: null, role: 'tenant_admin' })], flags: vi.fn(async (_t: string, a: string) => { if (a === 'a2') throw new Error('down'); return { enabled: true, unrecordedAllowed: true }; }) });
    expect(await listenAccessCheck(oneDown)([s({ listenId: 'x' }), s({ listenId: 'y', accountId: 'a2' })])).toEqual(verdict([], ['y']));
  });

  it('reads each supervisor\'s memberships and each account\'s flags once per pass', async () => {
    const d = deps();
    await listenAccessCheck(d)([s({ listenId: 'a' }), s({ listenId: 'b' }), s({ listenId: 'c', listenerUserId: 'u2' })]);
    expect(d.memberships).toHaveBeenCalledTimes(2);
    expect(d.flags).toHaveBeenCalledTimes(1);
  });

  it('membershipMayListen picks the account\'s membership before the tenant-wide one', () => {
    expect(membershipMayListen([membership({ account_id: null, role: 'tenant_admin' }), membership({ account_id: 'a1', role: 'viewer' })], 'a1')).toBe(false);
    expect(membershipMayListen([membership({ account_id: 'a1', status: 'revoked' })], 'a1')).toBe(false);
  });

  it('membershipMayListen asks of the membership the tenant context would pick (LS22 l: one rule, `selectMembership`)', () => {
    const lists: MembershipRecord[][] = [
      [],
      [membership({ account_id: null, role: 'tenant_admin' })],
      [membership({ account_id: 'a2', role: 'account_admin' })],
      [membership({ account_id: null, role: 'viewer' }), membership({ id: 'm2', account_id: 'a1', role: 'account_admin' })],
      [membership({ account_id: 'a1', role: 'agent' }), membership({ id: 'm2', account_id: null, role: 'tenant_owner' })],
      [membership({ account_id: 'a1', role: 'account_admin', status: 'inactive' })],
    ];
    for (const list of lists) {
      const picked = selectMembership(list, 'a1');
      const expected = !!picked && picked.status === 'active' && hasPermission(picked.role, 'agency.calls.listen');
      expect(membershipMayListen(list, 'a1'), JSON.stringify(list.map((m) => [m.account_id, m.role, m.status]))).toBe(expected);
    }
  });
});
