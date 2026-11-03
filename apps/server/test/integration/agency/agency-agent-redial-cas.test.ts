import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import { closeTestRedis, flushTestRedis, getTestRedis } from '../setup/test-utils.js';
import { TEST_REDIS_URL } from '../../helpers/test-redis.js';

const { AgentStateMachine, AGENT_LEASE_MS } = await import('../../../src/agency/agent-state-machine.js');

/**
 * Wrap-up redial's step in the agent state machine, `wrapup → reserved`
 * (`AgentStateMachine.reserveFromWrapup`), against REAL Redis running the real Lua.
 *
 * The claims: a redial reserves only an agent who is still in wrap-up, so it can
 * never take one the pool has (`available`, possibly reserved by a tick), a break,
 * or a lapsed lease; and a redial racing a pacing reservation cannot both win.
 * No keyPrefix, matching the shared `getTestRedis()` (see `agency-agent-cas.test.ts`).
 */
describe('reserveFromWrapup — the wrap-up redial CAS (integration, real Lua)', () => {
  beforeEach(flushTestRedis);
  afterAll(closeTestRedis);

  const machine = () => new AgentStateMachine(getTestRedis(), '');

  it('wrapup → reserved, with the short pre-dial lease', async () => {
    const m = machine();
    const s = randomUUID();
    await m.set(s, 'wrapup', { attemptId: 'att-1', leaseMs: AGENT_LEASE_MS.wrapup });
    expect(await m.reserveFromWrapup(s, 'reserving')).toBe('reserved');
    const live = await m.get(s);
    expect(live).toMatchObject({ state: 'reserved', attemptId: 'reserving' });
    const ttl = await getTestRedis().pttl(`agency:agent:${s}:state`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(AGENT_LEASE_MS.reserved_predial);
  });

  it.each(['available', 'break', 'on_call', 'reserved', 'offline'] as const)(
    'refuses (lost) from %s, and leaves the state as it was',
    async (state) => {
      const m = machine();
      const s = randomUUID();
      await m.set(s, state, { attemptId: 'x', leaseMs: 30_000 });
      expect(await m.reserveFromWrapup(s, 'reserving')).toBe('lost');
      expect((await m.get(s))?.state).toBe(state);
    },
  );

  it('refuses a lapsed lease and does not resurrect it', async () => {
    const m = machine();
    const s = randomUUID();
    expect(await m.reserveFromWrapup(s, 'reserving')).toBe('lost');
    expect(await m.get(s)).toBeNull();
  });

  it('a redial and a pacing reservation racing: exactly one wins', async () => {
    const clients = Array.from({ length: 2 }, () => new Redis(TEST_REDIS_URL));
    try {
      for (let round = 0; round < 25; round++) {
        const s = randomUUID();
        await machine().set(s, 'wrapup', { attemptId: 'att', leaseMs: AGENT_LEASE_MS.wrapup });
        const [redial, pacing] = [new AgentStateMachine(clients[0]!, ''), new AgentStateMachine(clients[1]!, '')];
        // The wrap-up ending (→ available) races the redial; the tick then races too.
        const results = await Promise.all([
          redial.reserveFromWrapup(s, 'redial'),
          pacing.transition(s, 'wrapup', 'available', { leaseMs: AGENT_LEASE_MS.available })
            .then(async (ok) => (ok ? pacing.reserve(s, 'tick') : 'lost')),
        ]);
        expect(results.filter((r) => r === 'reserved')).toHaveLength(1);
        expect((await machine().get(s))?.state).toBe('reserved');
      }
    } finally {
      await Promise.all(clients.map((c) => c.quit()));
    }
  });
});
