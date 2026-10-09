import type Redis from 'ioredis';
import { createChildLogger } from '@magick-agency/observability';
import type { AgencyAgentState } from '@magick-agency/contracts/agency';

const log = createChildLogger({ component: 'agency-agent-state' });

/**
 * Compare-and-swap a single agent's state.
 *
 * KEYS[1] = agency:agent:{sessionId}:state (HASH: state, attempt, since)
 * ARGV[1] = expected state  ARGV[2] = next state
 * ARGV[3] = attempt id ('' clears)  ARGV[4] = lease TTL ms
 *
 * There is no read-then-write, so there is no window in which two attempts hold
 * the same agent. A 0 means another tick got there first and the engine should
 * move to the next candidate — it is a normal outcome, not an error.
 */
const CAS_SCRIPT = `
if redis.call('HGET', KEYS[1], 'state') ~= ARGV[1] then return 0 end
redis.call('HSET', KEYS[1], 'state', ARGV[2], 'attempt', ARGV[3], 'since', ARGV[5])
redis.call('PEXPIRE', KEYS[1], ARGV[4])
return 1
`;

/**
 * Unconditional set — for transitions the caller has already authorised (an agent
 * clicking "available", a join, a forced release). Still creates the key with a
 * TTL, because an agent state with no lease is an agent nothing can detect the
 * death of.
 */
const SET_SCRIPT = `
redis.call('HSET', KEYS[1], 'state', ARGV[1], 'attempt', ARGV[2], 'since', ARGV[4])
redis.call('PEXPIRE', KEYS[1], ARGV[3])
return 1
`;

/**
 * Renew a lease **without resurrecting it**.
 *
 * The invariant this protects is the whole point of §6.1: a key TTL expires only
 * when the thing renewing it is gone. If renew re-created an expired key, an agent
 * whose replica died would silently come back to life in whatever state they were
 * last in — and the engine would dial into them. `EXISTS` first, and the state
 * must still match what the renewer believes.
 */
const RENEW_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 0 then return 0 end
if redis.call('HGET', KEYS[1], 'state') ~= ARGV[1] then return 0 end
redis.call('PEXPIRE', KEYS[1], ARGV[2])
return 1
`;

/**
 * Lease TTLs, in milliseconds (§6.1).
 *
 * These are **liveness detectors, never business timers.** A Redis TTL cannot
 * distinguish "took too long" from "the process died", so ring timeout, wrap-up
 * length and max call duration live in the attempt row and the bridge's existing
 * `setMaxDurationTimer` — never here. Any future addition to this table should be
 * challenged on exactly that basis.
 *
 * `reserved` is split in two because collapsing it is a real bug: a single 20s
 * lease covering the whole dial expires mid-ring on a 25s call, the agent flips
 * back to `available`, the next tick reserves them elsewhere, and then the
 * original contact answers with nobody to bridge to — a structurally abandoned
 * call produced by the mechanism meant to prevent abandonment.
 */
export const AGENT_LEASE_MS = {
  /** Reserved, dial not yet placed. Nothing renews it; the dial must be prompt. */
  reserved_predial: 10_000,
  /** Reserved and dialing/ringing. Renewed by the owning replica every 5s. */
  reserved_dialing: 15_000,
  /** Bridged. Renewed by the owning replica every 5s, tied to the live session. */
  on_call: 15_000,
  /** Wrap-up. Renewed by the station heartbeat, exactly as `available` is. */
  wrapup: 15_000,
  /** Idle. Renewed by the station socket heartbeat (10s ping, 3 misses). */
  available: 45_000,
  break: 45_000,
  /** How often an owning replica renews a lease it is responsible for. */
  renew_interval: 5_000,
} as const;

/** What the engine learns from attempting a reservation. */
export type ReservationResult = 'reserved' | 'lost' | 'unavailable';

/** An agent's live state as Redis holds it — the authority on availability. */
export interface AgentLiveState {
  state: AgencyAgentState;
  attemptId: string | null;
  /** Epoch ms of the last state transition, or null on a pre-`since` key. */
  since: number | null;
}

/**
 * The agent state machine, in Redis.
 *
 * Redis is the authority on agent liveness, not the database: `agency_agent_sessions`
 * is a durable mirror written alongside, and is what a reconnecting agent is
 * rehydrated from, but the pacing tick must never count an agent as available
 * because a DB row says so (§5.1 — presence is the heartbeat, not a state).
 */
export class AgentStateMachine {
  constructor(
    private readonly redis: Redis | null,
    private readonly keyPrefix: string,
  ) {}

  private key(sessionId: string): string {
    return `${this.keyPrefix}agency:agent:${sessionId}:state`;
  }

  /**
   * Reserve an agent for an attempt. **Strictly before the dial** — the agent is
   * committed before the carrier is ever contacted, which is what makes
   * "answered call with no agent" unreachable under D1 except through the agent
   * physically disappearing.
   */
  async reserve(sessionId: string, attemptId: string): Promise<ReservationResult> {
    if (!this.redis) return 'unavailable';
    try {
      const res = await this.redis.eval(
        CAS_SCRIPT, 1, this.key(sessionId),
        'available', 'reserved', attemptId, AGENT_LEASE_MS.reserved_predial, Date.now().toString(),
      );
      return res === 1 ? 'reserved' : 'lost';
    } catch (err) {
      // Fail closed. An unreadable agent pool must not be dialed into.
      log.error({ err, sessionId }, 'Agent reservation failed — treating as unavailable');
      return 'unavailable';
    }
  }

  /** CAS between two known states. Returns false when the agent moved underneath us. */
  async transition(
    sessionId: string,
    from: AgencyAgentState,
    to: AgencyAgentState,
    opts: { attemptId?: string; leaseMs: number } = { leaseMs: AGENT_LEASE_MS.available },
  ): Promise<boolean> {
    if (!this.redis) return false;
    try {
      const res = await this.redis.eval(
        CAS_SCRIPT, 1, this.key(sessionId),
        from, to, opts.attemptId ?? '', opts.leaseMs, Date.now().toString(),
      );
      return res === 1;
    } catch (err) {
      log.error({ err, sessionId, from, to }, 'Agent state CAS failed');
      return false;
    }
  }

  /** Unconditional set — joins, agent-initiated moves, forced releases. */
  async set(
    sessionId: string,
    state: AgencyAgentState,
    opts: { attemptId?: string; leaseMs?: number } = {},
  ): Promise<void> {
    if (!this.redis) return;
    const leaseMs = opts.leaseMs ?? AGENT_LEASE_MS.available;
    try {
      await this.redis.eval(
        SET_SCRIPT, 1, this.key(sessionId),
        state, opts.attemptId ?? '', leaseMs, Date.now().toString(),
      );
    } catch (err) {
      log.error({ err, sessionId, state }, 'Agent state set failed');
    }
  }

  /** Renew a lease the caller is responsible for. False ⇒ the lease is gone. */
  async renew(sessionId: string, expectedState: AgencyAgentState, leaseMs: number): Promise<boolean> {
    if (!this.redis) return false;
    try {
      const res = await this.redis.eval(RENEW_SCRIPT, 1, this.key(sessionId), expectedState, leaseMs);
      return res === 1;
    } catch (err) {
      log.warn({ err, sessionId }, 'Agent lease renew failed');
      return false;
    }
  }

  /**
   * Current state, or null when the lease has lapsed (the agent is gone).
   *
   * `since` is the epoch-ms of the last state *transition* — written by the CAS and
   * SET scripts, and deliberately **not** touched by `renew`, which only extends the
   * TTL. That distinction is what makes it a usable idle clock: an agent sitting
   * `available` for ten minutes has their heartbeat renewing the lease every 10s
   * while `since` stays put, so `now - since` is real idle time rather than time
   * since the last ping.
   */
  async get(sessionId: string): Promise<AgentLiveState | null> {
    if (!this.redis) return null;
    try {
      const h = await this.redis.hgetall(this.key(sessionId));
      if (!h || !h.state) return null;
      const since = Number(h.since);
      return {
        state: h.state as AgencyAgentState,
        attemptId: h.attempt || null,
        since: Number.isFinite(since) ? since : null,
      };
    } catch (err) {
      log.warn({ err, sessionId }, 'Agent state read failed');
      return null;
    }
  }

  /** Drop the lease entirely — logout, leave, campaign stop. */
  async clear(sessionId: string): Promise<void> {
    if (!this.redis) return;
    try {
      await this.redis.del(this.key(sessionId));
    } catch (err) {
      log.warn({ err, sessionId }, 'Agent state clear failed');
    }
  }
}
