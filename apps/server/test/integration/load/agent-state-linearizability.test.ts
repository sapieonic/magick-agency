import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import Redis from 'ioredis';
import type { AgencyAgentState } from '@magick-agency/contracts/agency';
import { closeTestRedis, flushTestRedis, getTestRedis, TEST_REDIS_URL } from '../../helpers/test-redis.js';
import { createRng, scaled, type Rng } from '../../helpers/load-scale.js';
import { AgentStateMachine } from '../../../src/agency/agent-state-machine.js';

/**
 * ─── THE AGENT STATE MACHINE IS LINEARIZABLE, ON REAL REDIS ─────────────────
 *
 * `AgentStateMachine` is the one authority on whether an agent may be dialled,
 * and every primitive on it — `reserve`, `transition`, `set`, `renew`, `clear`,
 * `get` — is a single Lua script or command on one key. The claim that makes the
 * pacing engine safe is that there is no read-then-write anywhere, so whatever
 * a floor of agents, ticks, wrap-up timers and station heartbeats do to one agent
 * at once, the outcome is the outcome of SOME one-at-a-time order of those calls.
 *
 * That is linearizability, and for a single-key register it is cheap to check
 * exactly: fire K operations at one agent concurrently (each on its own Redis
 * connection, so the server really sees them interleave), then search the K!
 * orders for one in which a reference model of the scripts reproduces every
 * returned value and the final hash. If no order does, two calls saw each other
 * half-done — the defect class the Lua exists to rule out (two reservations both
 * winning, a renew reviving a cleared lease, a CAS landing on a state it did not
 * expect).
 *
 * The reference model is the scripts' semantics, written out once:
 *   reserve(a)      available → reserved(a), else lost
 *   transition(f,t) state = f → t, else false (a missing key matches nothing)
 *   set(s)          unconditional
 *   renew(s)        true iff the key exists AND its state is s; never creates it
 *   clear           delete
 *   get             read
 *
 * Two parts: (1) a concurrent burst per agent, checked for linearizability over
 * many agents and rounds; (2) long seeded sequences run one call at a time and
 * compared call-by-call against the model, with agents in parallel — the exact
 * oracle, which also catches a script that is atomic but WRONG.
 *
 * Leases are long (60s) so nothing expires mid-round: TTL expiry is a liveness
 * question with its own suites; this one is about the CAS.
 */

const PREFIX = 'ma-load:agent-state:';
const LEASE_MS = 60_000;
const STATES: readonly AgencyAgentState[] = ['offline', 'available', 'reserved', 'on_call', 'wrapup', 'break'];

type Op =
  | { kind: 'reserve'; attempt: string }
  | { kind: 'transition'; from: AgencyAgentState; to: AgencyAgentState; attempt: string }
  | { kind: 'set'; state: AgencyAgentState; attempt: string }
  | { kind: 'renew'; state: AgencyAgentState }
  | { kind: 'clear' }
  | { kind: 'get' };

/** What the key holds, as the model sees it. `attempt` '' is "no attempt". */
type Reg = { state: AgencyAgentState; attempt: string } | null;
type Result = string | boolean | null;

/** Apply one op to the model; returns the new register and the op's result. */
function step(reg: Reg, op: Op): [Reg, Result] {
  switch (op.kind) {
    case 'reserve':
      return reg?.state === 'available'
        ? [{ state: 'reserved', attempt: op.attempt }, 'reserved']
        : [reg, 'lost'];
    case 'transition':
      return reg?.state === op.from ? [{ state: op.to, attempt: op.attempt }, true] : [reg, false];
    case 'set':
      return [{ state: op.state, attempt: op.attempt }, null];
    case 'renew':
      return [reg, reg !== null && reg.state === op.state];
    case 'clear':
      return [null, null];
    case 'get':
      return [reg, reg ? `${reg.state}|${reg.attempt}` : 'absent'];
  }
}

/** Run one op against the real machine, normalised to the model's result shape. */
async function run(m: AgentStateMachine, sessionId: string, op: Op): Promise<Result> {
  switch (op.kind) {
    case 'reserve':
      return m.reserve(sessionId, op.attempt);
    case 'transition':
      return m.transition(sessionId, op.from, op.to, { attemptId: op.attempt, leaseMs: LEASE_MS });
    case 'set':
      await m.set(sessionId, op.state, { attemptId: op.attempt, leaseMs: LEASE_MS });
      return null;
    case 'renew':
      return m.renew(sessionId, op.state, LEASE_MS);
    case 'clear':
      await m.clear(sessionId);
      return null;
    case 'get': {
      const live = await m.get(sessionId);
      return live ? `${live.state}|${live.attemptId ?? ''}` : 'absent';
    }
  }
}

function sameReg(a: Reg, b: Reg): boolean {
  if (a === null || b === null) return a === b;
  return a.state === b.state && a.attempt === b.attempt;
}

/**
 * Is there an order of `ops` that, applied to `initial`, yields exactly
 * `results` and ends in `final`? Depth-first over permutations with pruning on
 * the first mismatching result, so K=6 is at most 720 leaves and usually far
 * fewer.
 */
function linearizable(initial: Reg, ops: readonly Op[], results: readonly Result[], final: Reg): boolean {
  const used = new Array<boolean>(ops.length).fill(false);
  const search = (reg: Reg, depth: number): boolean => {
    if (depth === ops.length) return sameReg(reg, final);
    for (let i = 0; i < ops.length; i++) {
      if (used[i]) continue;
      const [next, res] = step(reg, ops[i]!);
      if (res !== results[i]) continue;
      used[i] = true;
      if (search(next, depth + 1)) return true;
      used[i] = false;
    }
    return false;
  };
  return search(initial, 0);
}

/**
 * A random op, biased towards contention: most CAS ops name the state the agent
 * is in or the ones the dial path actually moves between, so a burst is mostly
 * ops that could each succeed alone and must not all succeed together.
 */
function randomOp(rng: Rng, tag: string): Op {
  const roll = rng.next();
  const attempt = `att-${tag}`;
  if (roll < 0.35) return { kind: 'reserve', attempt };
  if (roll < 0.6) {
    const from = rng.chance(0.6) ? rng.pick(['available', 'reserved'] as const) : rng.pick(STATES);
    return { kind: 'transition', from, to: rng.pick(STATES), attempt };
  }
  if (roll < 0.72) return { kind: 'set', state: rng.pick(STATES), attempt };
  if (roll < 0.84) return { kind: 'renew', state: rng.pick(['available', 'reserved', 'wrapup'] as const) };
  if (roll < 0.9) return { kind: 'clear' };
  return { kind: 'get' };
}

function describeOp(op: Op): string {
  switch (op.kind) {
    case 'reserve': return `reserve(${op.attempt})`;
    case 'transition': return `transition(${op.from}->${op.to},${op.attempt})`;
    case 'set': return `set(${op.state},${op.attempt})`;
    case 'renew': return `renew(${op.state})`;
    default: return op.kind;
  }
}

async function readReg(sessionId: string): Promise<Reg> {
  const h = await getTestRedis().hgetall(`${PREFIX}agency:agent:${sessionId}:state`);
  if (!h.state) return null;
  return { state: h.state as AgencyAgentState, attempt: h.attempt ?? '' };
}

async function seedReg(machine: AgentStateMachine, sessionId: string, reg: Reg): Promise<void> {
  if (reg === null) {
    await machine.clear(sessionId);
    return;
  }
  await machine.set(sessionId, reg.state, { attemptId: reg.attempt, leaseMs: LEASE_MS });
}

describe('agent state machine under contention (integration, real Lua)', () => {
  const CLIENTS = 16;
  let clients: Redis[] = [];
  let machines: AgentStateMachine[] = [];
  let base: AgentStateMachine;

  beforeAll(() => {
    // One machine per connection: concurrent ops on one agent ride different
    // sockets, so the server interleaves them rather than one client's pipeline
    // serialising them in issue order.
    clients = Array.from({ length: CLIENTS }, () => new Redis(TEST_REDIS_URL));
    machines = clients.map((c) => new AgentStateMachine(c, PREFIX));
    base = new AgentStateMachine(getTestRedis(), PREFIX);
  });
  beforeEach(flushTestRedis);
  afterAll(async () => {
    await Promise.all(clients.map((c) => c.quit()));
    await closeTestRedis();
  });

  it('every concurrent burst of K ops on one agent is explained by some sequential order', async () => {
    const rng = createRng();
    const AGENTS = scaled(150);
    const ROUNDS = scaled(8);
    const K = 5;
    let explained = 0;
    let doubleReserveAttempts = 0;

    for (let round = 0; round < ROUNDS; round++) {
      const agents = Array.from({ length: AGENTS }, (_, a) => {
        // Start most agents `available` — the state every reservation races on —
        // and the rest anywhere, including absent.
        const initial: Reg = rng.chance(0.6)
          ? { state: 'available', attempt: '' }
          : rng.chance(0.15) ? null : { state: rng.pick(STATES), attempt: `seed-${round}-${a}` };
        const ops = Array.from({ length: K }, (_, k) => randomOp(rng, `${round}-${a}-${k}`));
        return { sessionId: `r${round}-a${a}`, initial, ops };
      });
      await Promise.all(agents.map((a) => seedReg(base, a.sessionId, a.initial)));

      // Every op of every agent in flight at once.
      const results = await Promise.all(agents.map((a, ai) => Promise.all(
        a.ops.map((op, k) => run(machines[(ai * K + k) % CLIENTS]!, a.sessionId, op)),
      )));
      const finals = await Promise.all(agents.map((a) => readReg(a.sessionId)));

      agents.forEach((a, ai) => {
        const res = results[ai]!;
        if (a.ops.filter((o) => o.kind === 'reserve').length >= 2) doubleReserveAttempts++;
        const ok = linearizable(a.initial, a.ops, res, finals[ai]!);
        expect(ok, [
          `seed=${rng.seed} round=${round} agent=${a.sessionId}: no sequential order explains this burst`,
          `initial=${JSON.stringify(a.initial)} final=${JSON.stringify(finals[ai])}`,
          ...a.ops.map((o, k) => `  ${describeOp(o)} -> ${JSON.stringify(res[k])}`),
        ].join('\n')).toBe(true);
        explained++;
      });
    }

    expect(explained).toBe(AGENTS * ROUNDS);
    // The bursts must actually contain the race they are meant to present.
    expect(doubleReserveAttempts).toBeGreaterThan(AGENTS * ROUNDS * 0.1);
  });

  it('N concurrent reservers per agent, across a whole floor: one winner each, bound to its own attempt', async () => {
    // The pacing engine's own shape at scale: every agent on the floor is
    // `available`, and several ticks (forced leaders, or one tick's overlapping
    // passes) try to reserve all of them at once.
    const AGENTS = scaled(300);
    const CONTENDERS = 6;
    await Promise.all(Array.from({ length: AGENTS }, (_, a) =>
      base.set(`floor-${a}`, 'available', { leaseMs: LEASE_MS })));

    const outcomes = await Promise.all(Array.from({ length: AGENTS }, (_, a) => Promise.all(
      Array.from({ length: CONTENDERS }, (_, c) =>
        machines[(a + c) % CLIENTS]!.reserve(`floor-${a}`, `tick-${c}-agent-${a}`)),
    )));

    for (let a = 0; a < AGENTS; a++) {
      const res = outcomes[a]!;
      const winners = res.flatMap((r, c) => (r === 'reserved' ? [c] : []));
      expect(winners, `agent ${a}: ${JSON.stringify(res)}`).toHaveLength(1);
      expect(res.filter((r) => r === 'unavailable')).toHaveLength(0);
      const live = await base.get(`floor-${a}`);
      expect(live?.state).toBe('reserved');
      expect(live?.attemptId).toBe(`tick-${winners[0]}-agent-${a}`);
    }
  });

  it('long seeded sequences match the reference model call for call', async () => {
    const rng = createRng();
    const AGENTS = scaled(60);
    const STEPS = scaled(80);
    const plans = Array.from({ length: AGENTS }, (_, a) => ({
      sessionId: `seq-${a}`,
      ops: Array.from({ length: STEPS }, (_, s) => randomOp(rng, `seq-${a}-${s}`)),
    }));

    // Agents in parallel (distinct keys, so no cross-talk), each one's ops strictly
    // in order: the model is then an exact oracle, not a search.
    await Promise.all(plans.map(async (plan, ai) => {
      const m = machines[ai % CLIENTS]!;
      let reg: Reg = null;
      for (let s = 0; s < plan.ops.length; s++) {
        const op = plan.ops[s]!;
        const [next, expected] = step(reg, op);
        const actual = await run(m, plan.sessionId, op);
        expect(actual, `seed=${rng.seed} ${plan.sessionId} step ${s}: ${describeOp(op)} from ${JSON.stringify(reg)}`)
          .toEqual(expected);
        reg = next;
      }
      expect(await readReg(plan.sessionId)).toEqual(reg);
    }));
  });

  it('`since` moves only on a transition: renew and failed CAS leave the idle clock alone', async () => {
    // `since` is the floor's idle clock (`now - since` is real idle time), so a
    // heartbeat renew or a lost reservation racing a transition must not reset it.
    const AGENTS = scaled(100);
    const sessionIds = Array.from({ length: AGENTS }, (_, a) => `since-${a}`);
    await Promise.all(sessionIds.map((id) => base.set(id, 'wrapup', { leaseMs: LEASE_MS })));
    const before = await Promise.all(sessionIds.map((id) => base.get(id)));
    await new Promise((r) => setTimeout(r, 5));

    // A storm of renews and reservations that cannot win (the agent is in wrap-up).
    await Promise.all(sessionIds.flatMap((id, a) => [
      machines[a % CLIENTS]!.renew(id, 'wrapup', LEASE_MS),
      machines[(a + 1) % CLIENTS]!.reserve(id, `x-${a}`),
      machines[(a + 2) % CLIENTS]!.transition(id, 'available', 'reserved', { leaseMs: LEASE_MS }),
      machines[(a + 3) % CLIENTS]!.renew(id, 'wrapup', LEASE_MS),
    ]));

    const after = await Promise.all(sessionIds.map((id) => base.get(id)));
    after.forEach((live, a) => {
      expect(live?.state).toBe('wrapup');
      expect(live?.since).toBe(before[a]!.since);
    });
  });
});
