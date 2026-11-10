import type Redis from 'ioredis';
import { createChildLogger } from '@magick-agency/observability';
import type { AgencyAgentState } from '@magick-agency/contracts/agency';

const log = createChildLogger({ component: 'agency-agent-state' });

/**
 * ── The soft phone's two fields, and the inbound call's one, on the agent hash ──
 *
 * Besides `state`, `attempt` and `since` the hash carries:
 *
 * - `manual` — the id of the soft-phone call this session holds (live, or ended
 *   and awaiting its outcome). Set by {@link CLAIM_MANUAL_SCRIPT} only from
 *   `break`, cleared by {@link RELEASE_MANUAL_SCRIPT} only by the id that holds it.
 * - `softphone` — `'1'` on a soft-phone SESSION (`kind = 'softphone'`), which can
 *   never become `available` (written by {@link REHYDRATE_SOFTPHONE_SCRIPT}).
 * - `inbound` — the id of the inbound call this session holds (docs/inbound.md §6, P2):
 *   offered to it, connected, or ended with its outcome owed. Set only by
 *   {@link RESERVE_INBOUND_SCRIPT} (with `state = reserved`) and by
 *   {@link REHYDRATE_INBOUND_SCRIPT}; cleared by {@link RELEASE_INBOUND_SCRIPT} only by
 *   the id that holds it.
 *
 * **Every write that makes an agent `available` refuses, atomically, while any of
 * them is set** — the guard below runs inside the same script as the write, so ending
 * the break and dialing cannot interleave (a check-then-set would let a dial land
 * between the check and the write and put a soft-phone caller in the pacing pool).
 * HSET touches only the fields it names, so all three survive every other transition,
 * the renew and the heartbeat; only the lease lapsing or `clear` drops them.
 *
 * Returns `-1` for `manual`, `-2` for `softphone`, `-3` for `inbound`, from inside the
 * write scripts.
 */
const AVAILABLE_GUARD_LUA = `
local function refuse_available(key)
  local f = redis.call('HMGET', key, 'manual', 'softphone', 'inbound')
  if f[1] and f[1] ~= '' then return -1 end
  if f[2] == '1' then return -2 end
  if f[3] and f[3] ~= '' then return -3 end
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
 * `available` is refused (-1/-2/-3) while the soft-phone or inbound fields say so,
 * and a move TO `reserved` (an attempt's reservation: the paced one, the wrap-up
 * redial's, the lease extension at dial) is refused (-3) while the session holds an
 * inbound call, so no attempt can ever be reserved onto an agent an inbound caller
 * holds. The inbound reservation is {@link RESERVE_INBOUND_SCRIPT}, never this.
 */
const CAS_SCRIPT = `${AVAILABLE_GUARD_LUA}
if redis.call('HGET', KEYS[1], 'state') ~= ARGV[1] then return 0 end
if ARGV[2] == 'available' then
  local refused = refuse_available(KEYS[1])
  if refused ~= 0 then return refused end
end
if ARGV[2] == 'reserved' then
  local held = redis.call('HGET', KEYS[1], 'inbound')
  if held and held ~= '' then return -3 end
end
redis.call('HSET', KEYS[1], 'state', ARGV[2], 'attempt', ARGV[3], 'since', ARGV[5])
redis.call('PEXPIRE', KEYS[1], ARGV[4])
return 1
`;

/**
 * Unconditional set — for transitions the caller has already authorised (an agent
 * clicking "available", a join, a forced release). Still creates the key with a
 * TTL, because an agent state with no lease is an agent nothing can detect the
 * death of. Unconditional in everything but the guard: `available` is refused
 * (-1/-2/-3) while the session holds a manual call, is a soft-phone session, or
 * holds an inbound call.
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
 * Reserve the session for an inbound call (docs/inbound.md §2 step 5, P2).
 *
 * KEYS[1] = the agent hash. ARGV[1] = inbound call id, ARGV[2] = lease ms,
 * ARGV[3] = now (epoch ms), ARGV[4..] = the states it may be taken from.
 *
 * Returns `{1, from}` reserved (`from`: the state it was taken from), or the id
 * already holds it (idempotent: nothing is written, `from` is the state now, '' with
 * no lease); `{0, state}` not in one of the states (`state` '' when there is no
 * lease); `{-1, ''}` a soft-phone call holds it; `{-2, ''}` a soft-phone session;
 * `{2, heldId}` another inbound call holds it.
 *
 * One compare-and-swap, as an attempt's reservation is: the state and every field
 * are checked and written in one script, so an inbound offer and a pacing
 * reservation (both from `available`), or two inbound calls, cannot both win. The
 * write: `state = reserved`, `attempt = ''` (an inbound reservation is not an
 * attempt's), `since`, `inbound = id` and the lease (`reserved_dialing`, which the
 * connector renews while the offer stands). `fromStates` is `available` for an idle
 * agent, and `reserved` / `on_call` / `wrapup` for the release hook, which takes the
 * agent `releaseAgent` would otherwise return to the pool.
 */
const RESERVE_INBOUND_SCRIPT = `
local st = redis.call('HGET', KEYS[1], 'state')
local f = redis.call('HMGET', KEYS[1], 'manual', 'softphone', 'inbound')
if f[3] and f[3] ~= '' then
  if f[3] == ARGV[1] then return {1, st or ''} end
  return {2, f[3]}
end
if not st then return {0, ''} end
local allowed = false
for i = 4, #ARGV do
  if ARGV[i] == st then allowed = true end
end
if not allowed then return {0, st} end
if f[1] and f[1] ~= '' then return {-1, ''} end
if f[2] == '1' then return {-2, ''} end
redis.call('HSET', KEYS[1], 'state', 'reserved', 'attempt', '', 'since', ARGV[3], 'inbound', ARGV[1])
redis.call('PEXPIRE', KEYS[1], ARGV[2])
return {1, st}
`;

/** Clear `inbound`, but only if THIS call holds it. 1 released, 0 not held by it. */
const RELEASE_INBOUND_SCRIPT = `
if redis.call('HGET', KEYS[1], 'inbound') ~= ARGV[1] then return 0 end
redis.call('HDEL', KEYS[1], 'inbound')
return 1
`;

/**
 * Rehydrate a session that owes an inbound call's outcome (docs/inbound.md §2,
 * "Server restart"): the call was bridged and is not settled, so the session must
 * not be `available` until the outcome is saved or lapses.
 *
 * KEYS[1] = the agent hash. ARGV[1] = the owed call id, ARGV[2] = break lease ms,
 * ARGV[3] = now (epoch ms).
 *
 * A lapsed lease (no key), `offline` or `available` becomes `break` (an `available`
 * one is exactly what the guard exists to prevent: a lease that lapsed and was
 * rewritten by something that did not know); any other live state is kept. The
 * `inbound` field is then written to the owed id whatever it held: the database is
 * the authority (one unsettled inbound call per session, a unique index), so a
 * different id in the field is stale. Returns `{state, changed}`.
 */
const REHYDRATE_INBOUND_SCRIPT = `
local st = redis.call('HGET', KEYS[1], 'state')
local changed = 0
if (not st) or st == 'offline' or st == 'available' then
  redis.call('HSET', KEYS[1], 'state', 'break', 'attempt', '', 'since', ARGV[3])
  redis.call('PEXPIRE', KEYS[1], ARGV[2])
  st = 'break'
  changed = 1
end
redis.call('HSET', KEYS[1], 'inbound', ARGV[1])
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
  /**
   * Wrap-up. Renewed by the station heartbeat as `available` is, and as long (the console pings
   * every 10 s and is closed after 30 s of silence), while this process vouches for the wrap-up
   * (`heartbeatLeaseMs`, `station-socket.ts`). Its end is never this TTL: the wrap-up's timer, an
   * outcome or a supervisor ends it, and a station that goes away is written `offline`.
   */
  wrapup: 45_000,
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
 * - `inbound_call_owed` — refused: the session holds an inbound call (offered,
 *   connected, or ended with its outcome owed; docs/inbound.md §6). The routes answer
 *   `409 inbound_call_live`.
 * - `unavailable` — Redis is absent or the write failed (logged).
 */
export type AgentSetResult = 'ok' | 'manual_call_live' | 'softphone_session' | 'inbound_call_owed' | 'unavailable';

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
  if (res === -3) return 'inbound_call_owed';
  return 'unavailable';
}

/** The states {@link AgentStateMachine.reserveForInbound} may take an agent from. */
export type InboundReserveFromState = Extract<AgencyAgentState, 'available' | 'reserved' | 'on_call' | 'wrapup'>;

/** What {@link AgentStateMachine.reserveForInbound} did. */
export type InboundReservationResult =
  /** Reserved for the call, from `from`; or already held by it (nothing written, `from` the state now, null: no lease). */
  | { ok: true; from: AgencyAgentState | null }
  /** Not in one of the states asked for (`state` null: no lease at all). */
  | { ok: false; reason: 'wrong_state'; state: AgencyAgentState | null }
  /** Another inbound call holds the session. */
  | { ok: false; reason: 'held'; heldBy: string }
  /** The session holds a soft-phone call, or is a soft-phone session. */
  | { ok: false; reason: 'manual_call_live' | 'softphone_session' }
  | { ok: false; reason: 'unavailable' };

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
  /** The inbound call this session holds (the `inbound` field), or null. */
  inboundCallId: string | null;
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
    inboundCallId: h.inbound || null,
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

  private readonly availableListeners = new Set<(sessionId: string) => void>();

  /**
   * Be told, after the write, every time a session ENTERS `available` through
   * {@link set} or {@link transition}: a join, the end of a wrap-up or a break, a
   * reservation handed back. The pacing engine's wake-up for an idle campaign
   * (`pacing/invalidation-bus.ts`, wired by the runtime). Synchronous and total: a
   * listener that throws is logged, never surfaced to the writer. Returns the
   * unsubscribe.
   */
  onAvailable(listener: (sessionId: string) => void): () => void {
    this.availableListeners.add(listener);
    return () => { this.availableListeners.delete(listener); };
  }

  /**
   * Tell the {@link onAvailable} listeners that `sessionId` entered `available`. Called by
   * {@link set} and {@link transition} after their write, and by a caller that wrote with
   * `announce: false`, once, after the write succeeded.
   */
  announceAvailable(sessionId: string): void {
    for (const listener of this.availableListeners) {
      try {
        listener(sessionId);
      } catch (err) {
        log.warn({ err, sessionId }, 'Agent availability listener threw');
      }
    }
  }

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
   * Reserve an agent in WRAP-UP for a redial of the customer they were just talking to
   * (`wrapup-redial.ts`). The same CAS as {@link reserve}, from `wrapup` instead of
   * `available`, so the redial cannot take an agent who has meanwhile been returned to the
   * pool (and reserved by a tick), put on a break, or lost their lease. `lost` ⇒ they are
   * no longer in wrap-up; the redial is refused.
   *
   * The short pre-dial lease, exactly as a paced reservation: the dial must follow at once,
   * and `executeDial` extends it to `reserved_dialing` before the carrier is contacted.
   */
  async reserveFromWrapup(sessionId: string, attemptMarker: string): Promise<ReservationResult> {
    if (!this.redis) return 'unavailable';
    try {
      const res = await this.redis.eval(
        CAS_SCRIPT, 1, this.key(sessionId),
        'wrapup', 'reserved', attemptMarker, AGENT_LEASE_MS.reserved_predial, Date.now().toString(),
      );
      return res === 1 ? 'reserved' : 'lost';
    } catch (err) {
      log.error({ err, sessionId }, 'Wrap-up redial reservation failed — treating as unavailable');
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
      if (res === 1 && to === 'available') this.announceAvailable(sessionId);
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
    /**
     * `announce: false`: an `available` write is NOT announced here; the caller announces it
     * ({@link announceAvailable}) once it has told the agent and mirrored the row, so nothing a
     * listener starts (an inbound offer, a pacing tick) can reach the agent before its own
     * `available` frame does (`AgencyDialer.releaseAgent`).
     */
    opts: { attemptId?: string; leaseMs?: number; announce?: boolean } = {},
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
      else if (state === 'available' && opts.announce !== false) this.announceAvailable(sessionId);
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

  // ─── Inbound calls (docs/inbound.md §2, §6, P2) ───────────────────────────

  /**
   * Reserve the session for an inbound call: from one of `fromStates`, with no
   * soft-phone call, not a soft-phone session, and no other inbound call (see
   * {@link RESERVE_INBOUND_SCRIPT}). Writes `reserved` with the `reserved_dialing`
   * lease, which the connector renews while the offer stands. Idempotent for the id
   * that already holds it (`from` is then the state now, and nothing was written).
   * Fails closed (`unavailable`) when Redis cannot answer.
   */
  async reserveForInbound(
    sessionId: string,
    inboundCallId: string,
    fromStates: readonly InboundReserveFromState[],
  ): Promise<InboundReservationResult> {
    if (!this.redis) return { ok: false, reason: 'unavailable' };
    if (fromStates.length === 0) return { ok: false, reason: 'wrong_state', state: null };
    try {
      const [code, value] = await this.redis.eval(
        RESERVE_INBOUND_SCRIPT, 1, this.key(sessionId),
        inboundCallId, AGENT_LEASE_MS.reserved_dialing, Date.now().toString(), ...fromStates,
      ) as [number, string];
      const state = value ? (value as AgencyAgentState) : null;
      if (code === 1) return { ok: true, from: state };
      if (code === 2) return { ok: false, reason: 'held', heldBy: value };
      if (code === -1) return { ok: false, reason: 'manual_call_live' };
      if (code === -2) return { ok: false, reason: 'softphone_session' };
      return { ok: false, reason: 'wrong_state', state };
    } catch (err) {
      log.error({ err, sessionId, inboundCallId }, 'Inbound reservation failed — treating as unavailable');
      return { ok: false, reason: 'unavailable' };
    }
  }

  /**
   * Clear the session's `inbound` field — only if `inboundCallId` holds it. Moves no
   * state: the caller returns the agent (`releaseAgent`) after, so the `available`
   * the release writes passes the guard.
   */
  async releaseInbound(sessionId: string, inboundCallId: string): Promise<boolean> {
    if (!this.redis) return false;
    try {
      return (await this.redis.eval(RELEASE_INBOUND_SCRIPT, 1, this.key(sessionId), inboundCallId)) === 1;
    } catch (err) {
      log.warn({ err, sessionId, inboundCallId }, 'Inbound claim release failed');
      return false;
    }
  }

  /** The inbound call this session holds, or null (also when Redis cannot answer). */
  async inboundCallOf(sessionId: string): Promise<string | null> {
    if (!this.redis) return null;
    try {
      return (await this.redis.hget(this.key(sessionId), 'inbound')) || null;
    } catch (err) {
      log.warn({ err, sessionId }, 'Inbound claim read failed');
      return null;
    }
  }

  /**
   * Rehydrate a session that owes an inbound call's outcome into `break` with the
   * call re-claimed (see {@link REHYDRATE_INBOUND_SCRIPT}). Null when Redis cannot
   * answer.
   */
  async rehydrateInbound(
    sessionId: string,
    owedInboundCallId: string,
  ): Promise<{ state: AgencyAgentState; changed: boolean } | null> {
    if (!this.redis) return null;
    try {
      const [state, changed] = await this.redis.eval(
        REHYDRATE_INBOUND_SCRIPT, 1, this.key(sessionId),
        owedInboundCallId, AGENT_LEASE_MS.break, Date.now().toString(),
      ) as [string, number];
      return { state: state as AgencyAgentState, changed: changed === 1 };
    } catch (err) {
      log.error({ err, sessionId, owedInboundCallId }, 'Inbound rehydrate failed');
      return null;
    }
  }

  /**
   * Renew a lease the caller is responsible for. False ⇒ not renewed: the lease is gone, or
   * Redis failed. A caller that must tell those apart uses {@link renewLease}.
   */
  async renew(sessionId: string, expectedState: AgencyAgentState, leaseMs: number): Promise<boolean> {
    return (await this.renewLease(sessionId, expectedState, leaseMs)) === 'renewed';
  }

  /**
   * Renew a lease, saying WHY when it was not renewed: `lost` when Redis answered and the
   * lease is gone or in another state (the CAS missed), `unknown` when Redis failed (an
   * error, or the client's command timeout: `REDIS_COMMAND_TIMEOUT_MS`). The difference
   * matters to a renewer that runs for a whole call: `lost` is final, `unknown` is a
   * moment, and the lease (15 s, renewed every 5 s) outlives two failed renewals. Same
   * shape as the pacing leader lease's `renew`.
   */
  async renewLease(sessionId: string, expectedState: AgencyAgentState, leaseMs: number): Promise<'renewed' | 'lost' | 'unknown'> {
    if (!this.redis) return 'lost';
    try {
      const res = await this.redis.eval(RENEW_SCRIPT, 1, this.key(sessionId), expectedState, leaseMs);
      return res === 1 ? 'renewed' : 'lost';
    } catch (err) {
      log.warn({ err, sessionId }, 'Agent lease renew failed');
      return 'unknown';
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
