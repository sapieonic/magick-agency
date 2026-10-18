import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import Redis from 'ioredis';
import { closeTestRedis, flushTestRedis } from '../setup/test-utils.js';
import { TEST_REDIS_URL } from '../../helpers/test-redis.js';

const { AgentStateMachine, AGENT_LEASE_MS } = await import('../../../src/agency/agent-state-machine.js');

/**
 * `AgentStateMachine.getMany` against real Redis: the pipelined batch the pacing
 * tick reads through must answer exactly what one `get` per agent answers,
 * including through a client `keyPrefix` (production sets one).
 */
describe('AgentStateMachine.getMany (integration, real Redis)', () => {
  beforeEach(flushTestRedis);
  const clients: Redis[] = [];
  afterAll(async () => {
    await Promise.all(clients.map((c) => c.quit()));
    await closeTestRedis();
  });

  it('matches `get` for every agent, in order, through a key prefix', async () => {
    const redis = new Redis(TEST_REDIS_URL, { keyPrefix: 'getmany:' });
    clients.push(redis);
    const sm = new AgentStateMachine(redis, 'p:');
    await sm.set('a', 'available', { leaseMs: AGENT_LEASE_MS.available });
    await sm.set('c', 'on_call', { attemptId: 'att-1', leaseMs: AGENT_LEASE_MS.on_call });

    const ids = ['a', 'b', 'c'];
    const batch = await sm.getMany(ids);
    const single = await Promise.all(ids.map((id) => sm.get(id)));
    expect(batch).toEqual(single);
    expect(batch.map((s) => s?.state ?? null)).toEqual(['available', null, 'on_call']);
    expect(batch[2]!.attemptId).toBe('att-1');
    expect(await sm.getMany([])).toEqual([]);
  });
});
