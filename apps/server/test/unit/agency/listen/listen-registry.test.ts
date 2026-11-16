import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgencyListenEndReason } from '@magick-agency/contracts/agency';
import { ListenRegistry, type ListenAccessCheck, type ListenLimits, type ListenSessionHandle } from '../../../../src/agency/listen/listen-registry.js';
import { listenAccessCheck, membershipMayListen, type ListenAccessDeps } from '../../../../src/agency/listen/listen-access.js';
import type { MembershipRecord } from '@magick-agency/db/models/membership.model';

/*
 * The listen registry (docs/listening.md §4, LS5, LS10): the three caps, the supersede, the
 * revocation and its periodic re-check against a database stub, the shutdown. And the re-check's
 * question itself (`listen-access.ts`): the membership floor and both flags.
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
  registry.admit(r.reservation, s);
  return s;
}

function registryWith(access: ListenAccessCheck = vi.fn(async () => new Set<string>()), limits: Partial<ListenLimits> = {}) {
  return new ListenRegistry({ limits: { ...LIMITS, ...limits }, access });
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

  it('a stopping registry admits nothing', async () => {
    const registry = registryWith();
    await registry.shutdown();
    expect(registry.check('c1', 't1', 'u1')).toBe('listen_limit_server');
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
    expect(registry.all().map((s) => s.listenId).sort()).toEqual(['l2', 'o1']);
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
});

describe('ListenRegistry: revocation and the re-check (LS10)', () => {
  it('revokeUser re-checks only that supervisor\'s sessions in the tenant, and ends those that fail', async () => {
    const access = vi.fn(async (sessions: readonly ListenSessionHandle[]) => new Set(sessions.map((s) => s.listenId)));
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
    const access = vi.fn(async () => new Set<string>());
    const registry = registryWith(access);
    expect(await registry.revokeUser('t1', 'u1')).toBe(0);
    expect(access).not.toHaveBeenCalled();
    const s = open(registry, session({ listenId: 'l1' }, registry));
    expect(await registry.revokeUser('t1', 'u1')).toBe(0);
    expect(s.ended).toEqual([]);
  });

  it('a check that cannot be made (the database is down) ends nothing', async () => {
    const registry = registryWith(vi.fn(async () => { throw new Error('ECONNREFUSED'); }));
    const s = open(registry, session({ listenId: 'l1' }, registry));
    expect(await registry.revokeUser('t1', 'u1')).toBe(0);
    expect(await registry.recheck()).toBe(0);
    expect(s.ended).toEqual([]);
  });

  it('the periodic re-check runs every recheckMs and ends what the database says may no longer listen', async () => {
    vi.useFakeTimers();
    let revoked = new Set<string>();
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
    revoked = new Set(['b']);
    await vi.advanceTimersByTimeAsync(LIMITS.recheckMs);
    expect(access).toHaveBeenCalledTimes(2);
    expect(b.ended).toEqual(['permission_revoked']);
    expect(a.ended).toEqual([]);
    registry.stop();
    await vi.advanceTimersByTimeAsync(LIMITS.recheckMs * 3);
    expect(access).toHaveBeenCalledTimes(2);
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
    listenEnabled: vi.fn(async () => true),
    unrecordedAllowed: vi.fn(async () => true),
    ...over,
  });
  const s = (over: Partial<ListenSessionHandle>): ListenSessionHandle =>
    ({ listenId: 'l', tenantId: 't1', accountId: 'a1', callId: 'c1', listenerUserId: 'u1', recording: true, startedAt: 0, end: async () => {}, ...over });

  it('keeps an account admin on a recorded call with the flag on', async () => {
    expect(await listenAccessCheck(deps())([s({})])).toEqual(new Set());
  });

  it('ends a listen whose supervisor fell below account_admin, lost the membership, or holds only another account', async () => {
    expect(await listenAccessCheck(deps({ memberships: async () => [membership({ account_id: 'a1', role: 'operator' })] }))([s({})])).toEqual(new Set(['l']));
    expect(await listenAccessCheck(deps({ memberships: async () => [] }))([s({})])).toEqual(new Set(['l']));
    expect(await listenAccessCheck(deps({ memberships: async () => [membership({ account_id: 'a2' })] }))([s({})])).toEqual(new Set(['l']));
    // A tenant-wide admin passes in every account.
    expect(await listenAccessCheck(deps({ memberships: async () => [membership({ account_id: null, role: 'tenant_admin' })] }))([s({})])).toEqual(new Set());
  });

  it('ends every listen in an account whose consent flag went off', async () => {
    expect(await listenAccessCheck(deps({ listenEnabled: async () => false }))([s({})])).toEqual(new Set(['l']));
  });

  it('LS4: the unrecorded flag ends only listens on unrecorded calls', async () => {
    const d = deps({ unrecordedAllowed: vi.fn(async () => false) });
    expect(await listenAccessCheck(d)([s({ listenId: 'rec' }), s({ listenId: 'unrec', recording: false })])).toEqual(new Set(['unrec']));
  });

  it('reads each supervisor\'s memberships and each account\'s flags once per pass', async () => {
    const d = deps();
    await listenAccessCheck(d)([s({ listenId: 'a' }), s({ listenId: 'b', callId: 'c2' }), s({ listenId: 'c', listenerUserId: 'u2' })]);
    expect(d.memberships).toHaveBeenCalledTimes(2);
    expect(d.listenEnabled).toHaveBeenCalledTimes(1);
  });

  it('membershipMayListen picks the account\'s membership before the tenant-wide one', () => {
    expect(membershipMayListen([membership({ account_id: null, role: 'tenant_admin' }), membership({ account_id: 'a1', role: 'viewer' })], 'a1')).toBe(false);
    expect(membershipMayListen([membership({ account_id: 'a1', status: 'revoked' })], 'a1')).toBe(false);
  });
});
