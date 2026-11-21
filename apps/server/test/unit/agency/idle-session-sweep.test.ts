import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/db/repositories/agency.repository.js', () => ({ agencyAgentSessionRepository: {} }));

const {
  IdleSessionSweep, afterSessionLeft, IDLE_SESSION_END_AFTER_MS,
} = await import('../../../src/agency/idle-session-sweep.js');
type Runtime = ConstructorParameters<typeof IdleSessionSweep>[0];
type Repo = NonNullable<ConstructorParameters<typeof IdleSessionSweep>[1]>;

/**
 * OS9, the idle-session sweep's rules (`agency/idle-session-sweep.ts`) over stand-ins: a session
 * forgotten offline is ended as Leave ends it, and only when nothing is in it (OS7's rule): no
 * station in any process, a lease `offline` or gone and never Mode B's ring, no live attempt,
 * redial, soft-phone or inbound call. The row's own guard runs last and its "no" touches nothing.
 */

const candidate = (id: string) => ({
  id, tenant_id: 't', account_id: 'a', agent_user_id: `u-${id}`, offline_since: new Date(Date.now() - 3 * 3_600_000),
});

function world(over: {
  presence?: 'connected' | 'absent' | 'unknown';
  lease?: { state: string; ring?: boolean } | null;
  liveAttempt?: boolean;
  redial?: boolean;
  softphoneCall?: boolean;
  inboundCall?: boolean;
  rowLeaves?: boolean;
  ids?: string[];
} = {}) {
  const calls: string[] = [];
  const runtime: Runtime = {
    stations: {
      stationPresence: async () => over.presence ?? 'absent',
      detach: (id) => { calls.push(`detach:${id}`); },
      sessionEnded: (id) => { calls.push(`ended:${id}`); },
    },
    stationDisconnects: { forgetEnded: (ids) => { calls.push(`forget:${ids.join(',')}`); } },
    floorAssist: { endWithSession: async (id) => { calls.push(`help:${id}`); } },
    agents: {
      get: async () => (over.lease === undefined ? { state: 'offline' } : over.lease),
      clear: async (id) => { calls.push(`clear:${id}`); },
    },
    dialer: { hasLiveAttempt: () => over.liveAttempt ?? false, hasRedialInFlight: () => over.redial ?? false },
    softphone: { hasLiveCall: () => over.softphoneCall ?? false },
    inbound: { findCallForSession: () => (over.inboundCall ? { callId: 'c' } : null) },
  };
  const repo: Repo = {
    findIdleOffline: vi.fn(async () => (over.ids ?? ['s1']).map(candidate)),
    leaveIdle: vi.fn(async (id: string) => { calls.push(`leave:${id}`); return over.rowLeaves ?? true; }),
  };
  return { runtime, repo, calls };
}

describe('IdleSessionSweep (OS9)', () => {
  it('ends an idle session: the row first, then the lease, Need help, the station and its detach time', async () => {
    const { runtime, repo, calls } = world();
    expect(await new IdleSessionSweep(runtime, repo).sweep()).toBe(1);
    expect(calls).toEqual(['leave:s1', 'clear:s1', 'help:s1', 'detach:s1', 'ended:s1', 'forget:s1']);
    expect(repo.findIdleOffline).toHaveBeenCalledWith(IDLE_SESSION_END_AFTER_MS, 200);
    expect(repo.leaveIdle).toHaveBeenCalledWith('s1', IDLE_SESSION_END_AFTER_MS);
  });

  it('the cutoff is two hours', () => {
    expect(IDLE_SESSION_END_AFTER_MS).toBe(2 * 60 * 60 * 1000);
  });

  it('ends a session with no lease at all (it lapsed)', async () => {
    const { runtime, repo } = world({ lease: null });
    expect(await new IdleSessionSweep(runtime, repo).sweep()).toBe(1);
  });

  it.each([
    ['a station attached somewhere', { presence: 'connected' as const }],
    ['a presence it could not read', { presence: 'unknown' as const }],
    ['a lease past offline', { lease: { state: 'available' } }],
    ['Mode B away-ring', { lease: { state: 'offline', ring: true } }],
    ['a live attempt', { liveAttempt: true }],
    ['a redial being set up', { redial: true }],
    ['a soft-phone call', { softphoneCall: true }],
    ['an inbound call', { inboundCall: true }],
  ])('keeps a session with %s, and writes nothing', async (_name, over) => {
    const { runtime, repo, calls } = world(over);
    expect(await new IdleSessionSweep(runtime, repo).sweep()).toBe(0);
    expect(repo.leaveIdle).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it('a row that came back since the read (leaveIdle says no) is not cleaned up', async () => {
    const { runtime, repo, calls } = world({ rowLeaves: false });
    expect(await new IdleSessionSweep(runtime, repo).sweep()).toBe(0);
    expect(calls).toEqual(['leave:s1']);
  });

  it('a step that fails after the end does not stop the rest of it, and the session counts as ended', async () => {
    const { runtime, repo, calls } = world();
    runtime.agents.clear = async () => { throw new Error('redis down'); };
    expect(await new IdleSessionSweep(runtime, repo).sweep()).toBe(1);
    expect(calls).toEqual(['leave:s1', 'help:s1', 'detach:s1', 'ended:s1', 'forget:s1']);
  });

  it('one session that fails does not stop the rest, and a failed read ends the pass quietly', async () => {
    const { runtime, repo } = world({ ids: ['s1', 's2'] });
    repo.leaveIdle = vi.fn(async (id: string) => {
      if (id === 's1') throw new Error('boom');
      return true;
    });
    expect(await new IdleSessionSweep(runtime, repo).sweep()).toBe(1);

    repo.findIdleOffline = vi.fn(async () => { throw new Error('db down'); });
    expect(await new IdleSessionSweep(runtime, repo).sweep()).toBe(0);
  });

  it('a pass already running answers a second call; the options set the cutoff and the batch', async () => {
    const { runtime, repo } = world();
    let release!: () => void;
    repo.findIdleOffline = vi.fn(() => new Promise<ReturnType<typeof candidate>[]>((resolve) => { release = () => resolve([candidate('s1')]); }));
    const sweep = new IdleSessionSweep(runtime, repo, { idleMs: 60_000, batch: 5 });
    const first = sweep.sweep();
    const second = sweep.sweep();
    expect(second).toBe(first);
    release();
    expect(await first).toBe(1);
    expect(repo.findIdleOffline).toHaveBeenCalledTimes(1);
    expect(repo.findIdleOffline).toHaveBeenCalledWith(60_000, 5);
    expect(repo.leaveIdle).toHaveBeenCalledWith('s1', 60_000);
  });

  it('runs on its timer and stops waiting for the pass in flight', async () => {
    vi.useFakeTimers();
    try {
      const { runtime, repo } = world();
      const sweep = new IdleSessionSweep(runtime, repo);
      sweep.start(1_000);
      await vi.advanceTimersByTimeAsync(999);
      expect(repo.findIdleOffline).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(repo.findIdleOffline).toHaveBeenCalledTimes(1);
      await sweep.stop();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(repo.findIdleOffline).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('afterSessionLeft', () => {
  it('ends Need help before the detach, then forgets when the station went', async () => {
    const calls: string[] = [];
    await afterSessionLeft({
      stations: { detach: async (id) => { calls.push(`detach:${id}`); }, sessionEnded: (id) => { calls.push(`ended:${id}`); } },
      stationDisconnects: { forgetEnded: (ids) => { calls.push(`forget:${ids.join(',')}`); } },
      floorAssist: { endWithSession: async (id) => { calls.push(`help:${id}`); } },
    }, 's9');
    expect(calls).toEqual(['help:s9', 'detach:s9', 'ended:s9', 'forget:s9']);
  });

  it('runs without the optional readers', async () => {
    const calls: string[] = [];
    await afterSessionLeft({ stations: { detach: () => { calls.push('detach'); }, sessionEnded: () => { calls.push('ended'); } } }, 's9');
    expect(calls).toEqual(['detach', 'ended']);
  });
});
