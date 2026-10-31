import type Redis from 'ioredis';
import { createChildLogger } from '@magick-agency/observability';
import type { AgencyAgentState } from '@magick-agency/contracts/agency';

const log = createChildLogger({ component: 'agency-agent-state' });

/**
 * ── The soft phone's two fields on the agent hash (docs/softphone.md §4.1) ───
 *
 * Besides `state`, `attempt` and `since` the hash carries:
 *
 * - `manual` — the id of the soft-phone call this session holds (live, or ended
 *   and awaiting its outcome). Set by {@link CLAIM_MANUAL_SCRIPT} only from
 *   `break`, cleared by {@link RELEASE_MANUAL_SCRIPT} only by the id that holds it.
 * - `softphone` — `'1'` on a soft-phone SESSION (`kind = 'softphone'`), which can
 *   never become `available` (written by {@link REHYDRATE_SOFTPHONE_SCRIPT}).
 *
 * **Every write that makes an agent `available` refuses, atomically, while either
 * is set** — the guard below runs inside the same script as the write, so ending
 * the break and dialing cannot interleave (a check-then-set would let a dial land
 * between the check and the write and put a soft-phone caller in the pacing pool).
 * HSET touches only the fields it names, so both survive every other transition,
 * the renew and the heartbeat; only the lease lapsing or `clear` drops them.
 *
 * Returns `-1` for `manual`, `-2` for `softphone`, from inside the write scripts.
 */
const AVAILABLE_GUARD_LUA = `
local function refuse_available(key)
  local f = redis.call('HMGET', key, 'manual', 'softphone')
  if f[1] and f[1] ~= '' then return -1 end
  if f[2] == '1' then return -2 end
  return 0
end
`;

/**
 * Compare-and-swap a single agent's state.
 *
 * KEYS[1] = agency:agent:{sessionId}:state (HASH: state, attempt, since, manual, softphone)
 * ARGV[1] = expected state  ARGV[2] = next state
 * ARGV[3] = attempt id ('' clears)  ARGV[4] = lease TTL ms
 *
 * There is no read-then-write, so there is no window in which two attempts hold
 * the same agent. A 0 means another tick got there first and the engine should
 * move to the next candidate — it is a normal outcome, not an error. A move TO
 * `available` is refused (-1/-2) while the soft-phone fields say so.
 */
const CAS_SCRIPT = `${AVAILABLE_GUARD_LUA}
if redis.call('HGET', KEYS[1], 'state') ~= ARGV[1] then return 0 end
if ARGV[2] == 'available' then
  local refused = refuse_available(KEYS[1])
  if refused ~= 0 then return refused end
end
redis.call('HSET', KEYS[1], 'state', ARGV[2], 'attempt', ARGV[3], 'since', ARGV[5])
redis.call('PEXPIRE', KEYS[1], ARGV[4])
return 1
`;

/**
 * Unconditional set — for transitions the caller has already authorised (an agent
 * clicking "available", a join, a forced release). Still creates the key with a
 * TTL, because an agent state with no lease is an agent nothing can detect the
 * death of. Unconditional in everything but the soft phone's guard: `available`
 * is refused (-1/-2) while the session holds a manual call or is a soft-phone
 * session.
 */
const SET_SCRIPT = `${AVAILABLE_GUARD_LUA}
if ARGV[1] == 'available' then
  local refused = refuse_available(KEYS[1])
  if refused ~= 0 then return refused end
end
redis.call('HSET', KEYS[1], 'state', ARGV[1], 'attempt', ARGV[2], 'since', ARGV[4])
redis.call('PEXPIRE', KEYS[1], ARGV[3])
return 1
`;

/**
 * Claim the session for one soft-phone call (docs/softphone.md §4.1 step 1).
 *
 * KEYS[1] = the agent hash. ARGV[1] = manual call id.
 * Returns `{1, id}` claimed (or already held by this same id: idempotent),
 * `{0, state}` not on a break (`state` is '' when there is no lease at all),
 * `{2, heldId}` another call holds it.
 *
 * Requires `state = break` (the soft phone IS a break) and an empty `manual`.
 * The lease TTL is NOT touched: the heartbeat goes on renewing `break` exactly as
 * before, so a session whose station dies still lapses — and the field with it.
 */
const CLAIM_MANUAL_SCRIPT = `
local st = redis.call('HGET', KEYS[1], 'state')
if not st then return {0, ''} end
if st ~= 'break' then return {0, st} end
local m = redis.call('HGET', KEYS[1], 'manual')
if m and m ~= '' then
  if m == ARGV[1] then return {1, m} end
  return {2, m}
end
redis.call('HSET', KEYS[1], 'manual', ARGV[1])
return {1, ARGV[1]}
`;

/** Clear `manual`, but only if THIS call holds it. 1 released, 0 not held by it. */
const RELEASE_MANUAL_SCRIPT = `
if redis.call('HGET', KEYS[1], 'manual') ~= ARGV[1] then return 0 end
redis.call('HDEL', KEYS[1], 'manual')
return 1
`;

/**
 * Rehydrate a soft-phone-flavoured session — a soft-phone session, or a campaign
 * session on the `soft_phone` break — into `break`, never `available`.
 *
 * KEYS[1] = the agent hash. ARGV[1] = '1' for a soft-phone SESSION ('0' otherwise),
 * ARGV[2] = the session's unsettled manual call id ('' none), ARGV[3] = break
 * lease ms, ARGV[4] = now (epoch ms).
 *
 * A lapsed lease (no key) or an `offline` one becomes `break`; any other live
 * state is kept (the rule `rehydrateAgent` states: Redis, or `break`). The
 * `softphone` marker is (re)written, and an unsettled manual call re-claims an
 * empty `manual` field — on `break` only — so a lease that lapsed during an
 * outcome the agent still owes cannot be the gap through which the session goes
 * `available`. Returns `{state, changed}`.
 */
const REHYDRATE_SOFTPHONE_SCRIPT = `
local st = redis.call('HGET', KEYS[1], 'state')
local changed = 0
if (not st) or st == 'offline' then
  redis.call('HSET', KEYS[1], 'state', 'break', 'attempt', '', 'since', ARGV[4])
  redis.call('PEXPIRE', KEYS[1], ARGV[3])
  st = 'break'
  changed = 1
end
if ARGV[1] == '1' then redis.call('HSET', KEYS[1], 'softphone', '1') end
if ARGV[2] ~= '' and st == 'break' then
  local m = redis.call('HGET', KEYS[1], 'manual')
  if (not m) or m == '' then redis.call('HSET', KEYS[1], 'manual', ARGV[2]) end
end
return {st, changed}
`;

/**
 * Renew a lease **without resurrecting it**.
 *
 * The invariant this protects is the whole point of the lease design: a key TTL
 * expires only when the thing renewing it is gone. If renew re-created an expired key, an agent
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
 * Lease TTLs, in milliseconds.
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

/**
 * What {@link AgentStateMachine.set} did. Every caller that only writes non-`available`
 * states may ignore it; a caller writing `available` must not report the move
 * unless it is `ok`.
 *
 * - `manual_call_live` — refused: the session holds a soft-phone call (live or
 *   awaiting its outcome). The routes answer `409 manual_call_live`.
 * - `softphone_session` — refused: a soft-phone session can never be `available`
 *   (the routes answer `409 wrong_session_kind`).
 * - `unavailable` — Redis is absent or the write failed (logged).
 */
export type AgentSetResult = 'ok' | 'manual_call_live' | 'softphone_session' | 'unavailable';

/** What {@link AgentStateMachine.claimManual} learned. */
export type ManualClaimResult =
  | { ok: true }
  /** The session is not on a break (`state` null: no lease at all). */
  | { ok: false; reason: 'not_on_break'; state: AgencyAgentState | null }
  /** Another soft-phone call holds the session. */
  | { ok: false; reason: 'held'; heldBy: string }
  | { ok: false; reason: 'unavailable' };

function setResultFrom(res: unknown): AgentSetResult {
  if (res === 1) return 'ok';
  if (res === -1) return 'manual_call_live';
  if (res === -2) return 'softphone_session';
  return 'unavailable';
}

/** An agent's live state as Redis holds it — the authority on availability. */
export interface AgentLiveState {
  state: AgencyAgentState;
  attemptId: string | null;
  /** Epoch ms of the last state transition, or null on a pre-`since` key. */
  since: number | null;
  /** The soft-phone call this session holds (the `manual` field), or null. */
  manualCallId: string | null;
  /** A soft-phone session (`softphone` field): never `available`. */
  softphone: boolean;
}

/** An `HGETALL` reply as an {@link AgentLiveState}; null for a lapsed (empty) key. */
function parseLiveState(h: Record<string, string> | null | undefined): AgentLiveState | null {
  if (!h || !h.state) return null;
  const since = Number(h.since);
  return {
    state: h.state as AgencyAgentState,
    attemptId: h.attempt || null,
    since: Number.isFinite(since) ? since : null,
    manualCallId: h.manual || null,
    softphone: h.softphone === '1',
  };
}

/**
 * The agent state machine, in Redis.
 *
 * Redis is the authority on agent liveness, not the database: `agency_agent_sessions`
 * is a durable mirror written alongside, and is what a reconnecting agent is
 * rehydrated from, but the pacing tick must never count an agent as available
 * because a DB row says so (presence is the heartbeat, not a state).
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
   * "answered call with no agent" unreachable under strict power dialing except
   * through the agent physically disappearing.
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

  /**
   * CAS between two known states. Returns false when the agent moved underneath us
   * — and for a move to `available` the soft phone's guard refuses (see
   * {@link AVAILABLE_GUARD_LUA}).
   */
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

  /**
   * Unconditional set — joins, agent-initiated moves, forced releases — except that
   * `available` is refused while the session holds a soft-phone call or is a
   * soft-phone session ({@link AgentSetResult}), atomically in the same script.
   */
  async set(
    sessionId: string,
    state: AgencyAgentState,
    opts: { attemptId?: string; leaseMs?: number } = {},
  ): Promise<AgentSetResult> {
    if (!this.redis) return 'unavailable';
    const leaseMs = opts.leaseMs ?? AGENT_LEASE_MS.available;
    try {
      const res = await this.redis.eval(
        SET_SCRIPT, 1, this.key(sessionId),
        state, opts.attemptId ?? '', leaseMs, Date.now().toString(),
      );
      const result = setResultFrom(res);
      if (result !== 'ok') log.info({ sessionId, state, result }, 'Agent state set refused');
      return result;
    } catch (err) {
      log.error({ err, sessionId, state }, 'Agent state set failed');
      return 'unavailable';
    }
  }

  // ─── The soft phone (docs/softphone.md §4.1) ──────────────────────────────

  /**
   * Claim this session for one soft-phone call: requires `break` and no other
   * call. Idempotent for the id that already holds it. Fails closed
   * (`unavailable`) when Redis cannot answer.
   */
  async claimManual(sessionId: string, manualCallId: string): Promise<ManualClaimResult> {
    if (!this.redis) return { ok: false, reason: 'unavailable' };
    try {
      const res = await this.redis.eval(CLAIM_MANUAL_SCRIPT, 1, this.key(sessionId), manualCallId) as [number, string];
      const [code, value] = res;
      if (code === 1) return { ok: true };
      if (code === 2) return { ok: false, reason: 'held', heldBy: value };
      return { ok: false, reason: 'not_on_break', state: value ? (value as AgencyAgentState) : null };
    } catch (err) {
      log.error({ err, sessionId, manualCallId }, 'Soft-phone claim failed');
      return { ok: false, reason: 'unavailable' };
    }
  }

  /** Release the session's soft-phone claim — only if `manualCallId` holds it. */
  async releaseManual(sessionId: string, manualCallId: string): Promise<boolean> {
    if (!this.redis) return false;
    try {
      return (await this.redis.eval(RELEASE_MANUAL_SCRIPT, 1, this.key(sessionId), manualCallId)) === 1;
    } catch (err) {
      log.warn({ err, sessionId, manualCallId }, 'Soft-phone claim release failed');
      return false;
    }
  }

  /** The soft-phone call this session holds, or null (also when Redis cannot answer). */
  async manualCallOf(sessionId: string): Promise<string | null> {
    if (!this.redis) return null;
    try {
      return (await this.redis.hget(this.key(sessionId), 'manual')) || null;
    } catch (err) {
      log.warn({ err, sessionId }, 'Soft-phone claim read failed');
      return null;
    }
  }

  /**
   * Rehydrate a soft-phone-flavoured session into `break` (see
   * {@link REHYDRATE_SOFTPHONE_SCRIPT}). Null when Redis cannot answer.
   */
  async rehydrateSoftphone(
    sessionId: string,
    opts: { softphoneSession: boolean; unsettledManualCallId: string | null },
  ): Promise<{ state: AgencyAgentState; changed: boolean } | null> {
    if (!this.redis) return null;
    try {
      const [state, changed] = await this.redis.eval(
        REHYDRATE_SOFTPHONE_SCRIPT, 1, this.key(sessionId),
        opts.softphoneSession ? '1' : '0', opts.unsettledManualCallId ?? '',
        AGENT_LEASE_MS.break, Date.now().toString(),
      ) as [string, number];
      return { state: state as AgencyAgentState, changed: changed === 1 };
    } catch (err) {
      log.error({ err, sessionId }, 'Soft-phone rehydrate failed');
      return null;
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
      return parseLiveState(await this.redis.hgetall(this.key(sessionId)));
    } catch (err) {
      log.warn({ err, sessionId }, 'Agent state read failed');
      return null;
    }
  }

  /**
   * {@link get} for several agents in ONE Redis round trip (a pipeline), in the
   * order asked. The pacing tick reads every local agent on a campaign four times a
   * second, and sequential reads made that one round trip per agent per tick.
   *
   * Same failure answer as `get`, per agent: a read that errors is `null` (the
   * agent is treated as gone, which fails closed for dialing), and so is every
   * entry when the pipeline itself cannot run.
   */
  async getMany(sessionIds: readonly string[]): Promise<Array<AgentLiveState | null>> {
    if (!this.redis || sessionIds.length === 0) return sessionIds.map(() => null);
    try {
      const pipeline = this.redis.pipeline();
      for (const sessionId of sessionIds) pipeline.hgetall(this.key(sessionId));
      const results = await pipeline.exec();
      return sessionIds.map((sessionId, i) => {
        const [err, h] = results?.[i] ?? [new Error('missing pipeline result'), null];
        if (err) {
          log.warn({ err, sessionId }, 'Agent state read failed');
          return null;
        }
        return parseLiveState(h as Record<string, string> | null);
      });
    } catch (err) {
      log.warn({ err, count: sessionIds.length }, 'Agent state batch read failed');
      return sessionIds.map(() => null);
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
