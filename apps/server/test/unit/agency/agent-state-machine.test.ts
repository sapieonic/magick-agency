import { describe, it, expect, vi } from 'vitest';

// ---------------------------------------------------------------------------
// The lease lifecycle and the CAS reservation.
//
// The invariant every test here defends: **a key TTL expires only when the thing
// renewing it is gone.** A lease is a liveness detector, never a business timer —
// a Redis TTL cannot distinguish "took too long" from "the process died".
// ---------------------------------------------------------------------------

vi.mock('@magick-agency/observability', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
  createChildLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { AgentStateMachine, AGENT_LEASE_MS } from '../../../src/agency/agent-state-machine.js';
import { DEFERRED_HANGUP_MS } from '@magick-agency/domain/timers';

/**
 * Redis double that actually executes the three Lua scripts' semantics, so these
 * tests pin behaviour rather than the fact that `eval` was called.
 */
function fakeRedis() {
  const hashes = new Map<string, Record<string, string>>();
  const ttls = new Map<string, number>();
  return {
    hashes,
    ttls,
    /** Simulate the lease lapsing (the process that was renewing it died). */
    lapse(key: string) { hashes.delete(key); ttls.delete(key); },
    hgetall: vi.fn(async (k: string) => hashes.get(k) ?? {}),
    del: vi.fn(async (k: string) => { hashes.delete(k); ttls.delete(k); return 1; }),
    eval: vi.fn(async (script: string, _n: number, key: string, ...argv: any[]) => {
      const h = hashes.get(key);
      if (script.includes('EXISTS')) {
        // RENEW: never resurrects, and the state must still match.
        if (!h) return 0;
        if (h.state !== String(argv[0])) return 0;
        ttls.set(key, Number(argv[1]));
        return 1;
      }
      if (script.includes('HGET')) {
        // CAS
        if ((h?.state ?? null) !== String(argv[0])) return 0;
        hashes.set(key, { state: String(argv[1]), attempt: String(argv[2]), since: String(argv[4]) });
        ttls.set(key, Number(argv[3]));
        return 1;
      }
      // SET (unconditional)
      hashes.set(key, { state: String(argv[0]), attempt: String(argv[1]), since: String(argv[3]) });
      ttls.set(key, Number(argv[2]));
      return 1;
    }),
  };
}

const KEY = 'agency:agent:s1:state';

describe('AgentStateMachine reservation CAS', () => {
  it('reserves an available agent and stamps the attempt', async () => {
    const redis = fakeRedis();
    const sm = new AgentStateMachine(redis as any, '');
    await sm.set('s1', 'available');

    expect(await sm.reserve('s1', 'att-1')).toBe('reserved');
    expect(redis.hashes.get(KEY)).toMatchObject({ state: 'reserved', attempt: 'att-1' });
  });

  it('lets exactly ONE of two racing reservations win', async () => {
    const redis = fakeRedis();
    const sm = new AgentStateMachine(redis as any, '');
    await sm.set('s1', 'available');

    const results = await Promise.all([
      sm.reserve('s1', 'att-A'),
      sm.reserve('s1', 'att-B'),
    ]);

    // There is no read-then-write, so there is no window in which two attempts
    // hold the same agent. The loser is a normal outcome, not an error.
    expect(results.filter((r) => r === 'reserved')).toHaveLength(1);
    expect(results.filter((r) => r === 'lost')).toHaveLength(1);
  });

  it('cannot reserve an agent who is not available', async () => {
    const sm = new AgentStateMachine(fakeRedis() as any, '');
    for (const state of ['on_call', 'reserved', 'break', 'offline', 'wrapup'] as const) {
      await sm.set('s1', state);
      expect(await sm.reserve('s1', 'att-1')).toBe('lost');
    }
  });

  it('reserves with the SHORT pre-dial lease, not the dialing one', async () => {
    const redis = fakeRedis();
    const sm = new AgentStateMachine(redis as any, '');
    await sm.set('s1', 'available');
    await sm.reserve('s1', 'att-1');

    // 10s, because nothing renews it yet — the dial must be prompt.
    expect(redis.ttls.get(KEY)).toBe(AGENT_LEASE_MS.reserved_predial);
    expect(AGENT_LEASE_MS.reserved_predial).toBeLessThan(AGENT_LEASE_MS.reserved_dialing);
  });

  it('FAILS CLOSED when Redis is unavailable or errors', async () => {
    const noRedis = new AgentStateMachine(null, '');
    expect(await noRedis.reserve('s1', 'att-1')).toBe('unavailable');

    const redis = fakeRedis();
    redis.eval.mockRejectedValueOnce(new Error('redis down'));
    const sm = new AgentStateMachine(redis as any, '');
    // An unreadable agent pool must never be dialed into on a guess.
    expect(await sm.reserve('s1', 'att-1')).toBe('unavailable');
  });
});

describe('AgentStateMachine lease lifecycle ', () => {
  it('splits the reserved lease so it cannot expire mid-ring', () => {
    // The bug this prevents: one 20s lease covering the whole dial expires during
    // a 25s ring, the agent flips back to available, the next tick reserves them
    // for another contact, and the original answers with nobody to bridge to — a
    // structurally abandoned call produced by the anti-abandonment mechanism.
    // Carrier no-answer timeouts run 30–45s, so the dialing lease MUST be renewed
    // rather than sized to outlast a ring.
    expect(AGENT_LEASE_MS.renew_interval).toBeLessThan(AGENT_LEASE_MS.reserved_dialing);
    expect(AGENT_LEASE_MS.renew_interval).toBeLessThan(AGENT_LEASE_MS.on_call);
    // Idle agents are held by the 10s heartbeat with 3 misses of slack.
    expect(AGENT_LEASE_MS.available).toBeGreaterThan(30_000);
  });

  it('renews a lease it still owns, and extends the TTL', async () => {
    const redis = fakeRedis();
    const sm = new AgentStateMachine(redis as any, '');
    await sm.set('s1', 'on_call', { leaseMs: AGENT_LEASE_MS.on_call });

    expect(await sm.renew('s1', 'on_call', 99_000)).toBe(true);
    expect(redis.ttls.get(KEY)).toBe(99_000);
  });

  it('NEVER resurrects a lapsed lease', async () => {
    const redis = fakeRedis();
    const sm = new AgentStateMachine(redis as any, '');
    await sm.set('s1', 'on_call', { leaseMs: AGENT_LEASE_MS.on_call });

    redis.lapse(KEY); // the owning replica died

    // If renew re-created the key, an agent whose process is gone would silently
    // come back to life in whatever state they were last in — and the engine
    // would dial into them.
    expect(await sm.renew('s1', 'on_call', 15_000)).toBe(false);
    expect(redis.hashes.has(KEY)).toBe(false);
    expect(await sm.get('s1')).toBeNull();
  });

  it('refuses to renew a lease whose state moved underneath the renewer', async () => {
    const sm = new AgentStateMachine(fakeRedis() as any, '');
    await sm.set('s1', 'on_call');
    await sm.set('s1', 'available'); // the call ended; the renewer is stale

    expect(await sm.renew('s1', 'on_call', 15_000)).toBe(false);
  });

  it('no lease value encodes a business timeout', () => {
    // Ring timeout, wrap-up length and max call duration live in the attempt row
    // and the bridge's setMaxDurationTimer. Every value here is a liveness
    // window: short, and renewed by something alive. If a future value exceeds a
    // minute, challenge it on exactly this basis.
    const liveness = [
      AGENT_LEASE_MS.reserved_predial, AGENT_LEASE_MS.reserved_dialing,
      AGENT_LEASE_MS.on_call, AGENT_LEASE_MS.wrapup,
      AGENT_LEASE_MS.available, AGENT_LEASE_MS.break,
    ];
    for (const ms of liveness) expect(ms).toBeLessThanOrEqual(60_000);
  });

  it('holds exactly the six agent states plus the renew interval, and nothing else', () => {
    // The enumeration above can pass while a seventh, business-flavoured entry
    // sits in the table unasserted — which is exactly the pressure on
    // this file, since wrap-up length and the deferred-hangup window are both
    // real numbers in milliseconds that a reader could mistake for leases. The key
    // set is therefore pinned, not just the values: a new key is a deliberate
    // decision that has to come here and argue for itself.
    expect(Object.keys(AGENT_LEASE_MS).sort()).toEqual([
      'available', 'break', 'on_call',
      'renew_interval', 'reserved_dialing', 'reserved_predial', 'wrapup',
    ]);
  });

  it('keeps the deferred-hangup window out of the lease table entirely', () => {
    // Acceptance: the deferred-hangup window is an in-process timer,
    // never a Redis TTL. Living in this table is how it would accidentally become
    // one, since every value here is passed to PEXPIRE by construction.
    expect(Object.values(AGENT_LEASE_MS)).not.toContain(DEFERRED_HANGUP_MS);
    // And it must not merely differ by coincidence — wrapup's lease is the flat
    // heartbeat lease, identical to available's.
    expect(AGENT_LEASE_MS.wrapup).toBe(AGENT_LEASE_MS.on_call);
    expect(AGENT_LEASE_MS.available).toBe(AGENT_LEASE_MS.break);
  });
});

describe('AgentStateMachine transitions', () => {
  it('transitions only from the expected state', async () => {
    const sm = new AgentStateMachine(fakeRedis() as any, '');
    await sm.set('s1', 'reserved');

    expect(await sm.transition('s1', 'on_call', 'available', { leaseMs: 1000 })).toBe(false);
    expect(await sm.transition('s1', 'reserved', 'on_call', { leaseMs: 1000 })).toBe(true);
    expect((await sm.get('s1'))?.state).toBe('on_call');
  });

  it('reads back the attempt an agent is bound to, and clears it', async () => {
    const sm = new AgentStateMachine(fakeRedis() as any, '');
    await sm.set('s1', 'reserved', { attemptId: 'att-9' });
    expect(await sm.get('s1')).toEqual({
      state: 'reserved', attemptId: 'att-9', since: expect.any(Number),
    });

    await sm.set('s1', 'available');
    expect((await sm.get('s1'))?.attemptId).toBeNull();

    await sm.clear('s1');
    expect(await sm.get('s1')).toBeNull();
  });

  it('degrades quietly without Redis rather than throwing into the dial path', async () => {
    const sm = new AgentStateMachine(null, '');
    await expect(sm.set('s1', 'available')).resolves.toBeUndefined();
    expect(await sm.get('s1')).toBeNull();
    expect(await sm.renew('s1', 'available', 1000)).toBe(false);
    await expect(sm.clear('s1')).resolves.toBeUndefined();
  });
});
