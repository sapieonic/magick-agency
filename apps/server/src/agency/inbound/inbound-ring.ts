import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  AGENCY_INBOUND_ACCEPT_GRACE_MS,
  AGENCY_INBOUND_RING_MAX_MISSES,
  AGENCY_INBOUND_RING_MS,
  type AgencyInboundCall,
  type AgencyInboundRingResult,
  type AgencyRingOffReason,
} from '@magick-agency/contracts/agency';
import { createChildLogger } from '@magick-agency/observability';
import {
  trackInboundOffer,
  trackInboundRing,
  trackInboundRingAnswer,
  trackInboundRingBind,
  type InboundOfferResult,
} from '@magick-agency/observability/metrics/agency';
import {
  agencyAgentSessionRepository,
  agencyInboundCallRepository,
  type AgencyInboundCallRecord,
  type AgencyInboundRouteRecord,
  type AgencyRingableSession,
} from '../../db/repositories/agency.repository.js';
import type { PushDeviceRecord } from '@magick-agency/db/models/push-device.model';
import { pushFailureRevokes, pushFailureScope } from '../../seams/push-sender.js';
import { AWAY_RING_RETURN_END, type AwayRingService } from '../away-ring.js';
import type { AgentStateMachine } from '../agent-state-machine.js';
import type { StationRegistry } from '../station-registry.js';
import { ringWindowLeft, type InboundCallerView } from './eligibility.js';
import { inboundCallToWire, type InboundPanelContext } from './inbound-call-wire.js';
import type { InboundOfferRefused } from './inbound-handover.js';

const log = createChildLogger({ component: 'agency-inbound-ring' });

/**
 * ─── RINGING AN AWAY PHONE (Mode B, IQ58–IQ77, N1–N5; docs/inbound.md "Ringing an away phone") ───
 *
 * An agent on `away_ring` has parked their station socket; their phone is rung by a data push
 * instead (IQ66: a ring IS an offer, on channel `push`). The inbound connector reads such sessions
 * beside its stations ({@link RingOffers.ringables}: `AwayRingService.ringableSessions`, the ring
 * rule) and its search tries them in IQ63's order (`eligibility.ts`), one phone per caller at a
 * time, and only with a ring window of the caller's wait left (IQ69). This module owns every ring
 * from its start to its end: the ring's state (the offer token, held only here and never logged, audited or
 * persisted; the token of the call's last ring that ended unanswered, and of the ring that bound),
 * the ring and accept timers, the pause after a push service failure, the ring and `ring_cancel`
 * pushes, the ring routes' entry points, and the ONE end of every ring ({@link RingOffers.end}).
 * The call itself, its queue entry, its serial chain, the account's lock and the station offer are
 * the connector's, reached through {@link RingHost} (as `inbound-handover.ts` reaches them through
 * its `HandoverHost`). Every step that touches a call runs on that call's chain.
 *
 * {@link RingOffers.offer}, on the call's chain: the CAS `break (ring = 1) → reserved` was the
 * search's; the spine `offered` with `offer_channel = push`, `ringing_at` and `ring_count + 1`; the
 * call seated on the session (`channel = 'push'`, the lease renewed by the connector: there is no
 * socket), a fresh 128-bit offer token, the ring timer ({@link RingOffersDeps.ringMs}); no
 * `inbound_call` frame and no bind timer. The push is sent after, outside the account's lock.
 *  - `answering` ({@link RingOffers.answering}, token only, on the call's chain): the ring timer
 *    stops, `accepted_at` is stamped and the accept grace starts; from here IQ73 cannot take the
 *    caller.
 *  - `accept` ({@link RingOffers.accept}, the agent's Bearer, the token, the station's device):
 *    `answering` if not yet, then accepted; the route mints the station token. Idempotent for the
 *    same agent and device until the call binds. If an OPEN station that can take inbound calls is
 *    already attached, it binds now.
 *  - The attach (the connector's `reattachStation`): an attach with `caps=inbound` during a ring not
 *    yet answered (the agent opened the app by its icon) is an implicit answer and accept
 *    ({@link RingOffers.acceptOnAttach}), and the phone is sent `ring_cancel` so it stops ringing
 *    (N5). A socket that closes inside the grace does not cancel the offer: it waits for a
 *    re-attach until the grace ends.
 *  - `decline` ({@link RingOffers.decline}, token only, until accept: N4) is `declined` (or
 *    `busy_on_phone`), never a miss; after accept the agent's hang-up is the way out.
 *  - The app's `device_away` during a ring not yet answered (the away notification's "Stop
 *    ringing", IQ79; {@link RingOffers.declineForDeviceAway}) is the agent saying no to it: the same
 *    `declined`, and the absence then ends as `device_away`, keeping its start. During an answered
 *    ring it queues behind the call, as for any call.
 *  - Every other end goes through the same {@link RingOffers.end}: expired, the grace lapsed
 *    (`accept_lapsed`), the push failed, the caller left, the lease lost, a station agent took the
 *    caller (IQ73, `answered_elsewhere`), the away break ended (`cancelled`). Each writes
 *    `ring_result`, sends Android `ring_cancel` (fire and forget), returns the agent to `away_ring`
 *    (`AwayRingService.releaseInbound`; Mode A's return only when an OPEN station is attached
 *    here) and, unless the caller left, puts the caller back at the head of the queue. An expiry or
 *    a lapse is a miss (IQ62): the second in a row ends `away_ring` (`ring_missed`), and an agent
 *    with that many misses is never rung again (`AwayRingService`'s ring rule, by which the
 *    reconcile also ends such an absence; a ring that slipped in before the end landed ends it when
 *    it ends, whatever its end). A failed push is no miss, and
 *    is classed by whose trouble it is (`pushFailureScope`, IQ75): a token the carrier refused for
 *    good (`unregistered`, `invalid`) revokes the device and ends the absence (`revoked`); one
 *    device held back for now (its own `rate_limited`) is never rung again for this caller, whose
 *    search goes on to the next phone; the push service's trouble (unavailable, unconfigured, an
 *    FCM 429) is not the agent's, so the agent stays ringable for this caller, and no phone is rung
 *    for {@link INBOUND_PUSH_RETRY_MS} (no new search either), so an outage never walks a caller
 *    through the whole pool; the republish after that retries.
 *  - IQ73 (N3): a station agent who frees up while a ring is not yet answered is reserved for that
 *    caller under the account's lock first; then, in one step of the call's chain, the ring is
 *    cancelled with no new search and the station agent offered the caller (or, if `answering`
 *    landed first, the station agent is given back): {@link RingOffers.takeOver}.
 *  - IQ68: a ringable agent counts as one who could take the caller (`couldTakeLater`).
 */

/**
 * After a ring push that failed for the push service's own reasons (unavailable, rate-limited,
 * refused, unconfigured; not an unregistered token), how long no phone is rung, so an outage of
 * the push service never walks one caller through the whole pool in milliseconds. The republish
 * after it retries.
 */
export const INBOUND_PUSH_RETRY_MS = 10_000;

/** A refusal of the ring routes, typed as the contract's inbound codes. */
export type InboundRingRefusal = 'ring_not_offered' | 'ring_expired' | 'already_accepted';

/**
 * What the ring reaches of the runtime's away break (`AwayRingService`): every Mode B dependency of
 * the inbound connector goes through it. Who may be rung (`ringableSessions`, `ringableDevice`), the
 * pushes (`send`), the return to `away_ring` after an unanswered ring (`releaseInbound`) and the
 * ends of the absence (`end`, `endAfterRing`).
 */
export type InboundAwayRing = Pick<AwayRingService,
  'ringableSessions' | 'ringableDevice' | 'releaseInbound' | 'end' | 'endAfterRing' | 'send'>;

/**
 * Ring results that are a miss (IQ62): the second in a row ends `away_ring`. Only the agent's own
 * (the ring expired, or the answer never bound): a failed push is the carrier's, never a miss.
 */
const MISSES: ReadonlySet<AgencyInboundRingResult> = new Set(['expired', 'accept_lapsed']);
/**
 * Ring results after which this caller never rings that agent again (`InboundCallerView.declinedSessionIds`).
 * Not `push_failed` as such: a failure that is the device's adds the session itself
 * (`neverAgain`, {@link RingOffers.sendRing}), and one that is the push service's is retried
 * after {@link INBOUND_PUSH_RETRY_MS}.
 */
const NEVER_AGAIN: ReadonlySet<AgencyInboundRingResult> = new Set(['declined', 'busy_on_phone', 'expired', 'accept_lapsed']);

/** The offer metric's result for a ring's end. */
function offerResultOfRing(result: AgencyInboundRingResult): InboundOfferResult {
  switch (result) {
    case 'declined':
    case 'busy_on_phone':
      return 'declined';
    case 'expired':
    case 'accept_lapsed':
    case 'push_failed':
      return 'unanswered';
    case 'caller_left':
      return 'caller_left';
    case 'answered':
      return 'connected';
    case 'answered_elsewhere':
      return 'answered_elsewhere';
    default:
      return 'cancelled';
  }
}

const NOT_OFFERED = { ok: false, code: 'ring_not_offered' } as const;
const ALREADY_ACCEPTED = { ok: false, code: 'already_accepted' } as const;

/** Constant-time comparison of two offer tokens (hashed first, so the lengths match). */
function tokenEquals(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

/** The ring of one push offer (see the header). The token is never logged. */
interface RingState {
  token: string;
  sessionId: string;
  /** The device rung (the session's station device), for `ring_cancel`. */
  device: PushDeviceRecord;
  /** Epoch ms the ring started (`ringing_at`). */
  startedAt: number;
  /** Ends the ring unanswered (`expired`); null once answered or fired. */
  ringTimer: NodeJS.Timeout | null;
  /**
   * When the agent tapped Answer (`…/ring/answering`, an accept, or an attach), epoch ms; null until
   * then. Once set, IQ73 cannot take the caller.
   */
  answeredAt: number | null;
  /** Ends the offer if it has not bound by the grace's end (`accept_lapsed`). */
  acceptTimer: NodeJS.Timeout | null;
  /** `…/ring/accept` (or an attach with `caps=inbound`) took the call: it binds once a station is attached. */
  accepted: boolean;
  /** The device that accepted (null: an attach accepted it): a repeated accept from it is idempotent. */
  acceptedDevice: string | null;
}

/** One call's rings: the current one, and the tokens of its last unanswered ring and of the ring that bound. */
interface CallRings {
  /** The ring of the current push offer (null on a station offer, and once it bound or ended). */
  ring: RingState | null;
  /** The offer token of this call's last ring that ended unanswered (a late accept is `ring_expired`). */
  spentToken: string | null;
  /** The ring that bound (a repeated accept for it is `already_accepted`). */
  boundToken: string | null;
}

/** What the ring reads and writes of a call the connector holds (the live object: read after every await). */
export interface RingCall {
  readonly id: string;
  record: AgencyInboundCallRecord;
  readonly route: AgencyInboundRouteRecord;
  readonly accountKey: string;
  readonly phase: string;
  readonly sessionId: string | null;
  readonly agentUserId: string | null;
  readonly bound: boolean;
  /** How the current offer reached its agent (IQ66): `push` while their phone is rung. */
  readonly channel: 'station' | 'push';
  readonly leaving: boolean;
  /** Sessions this caller is never offered to again (`InboundCallerView.declinedSessionIds`). */
  readonly declined: Set<string>;
  readonly panel: Promise<InboundPanelContext>;
}

/** The connector's side of the ring: its calls, chains, queue and the offer's shared steps. */
export interface RingHost {
  /** The call, if the connector holds it. */
  call(callId: string): RingCall | undefined;
  /** Every call the connector holds. */
  calls(): Iterable<RingCall>;
  /** The call offered to or connected with the session. */
  callFor(sessionId: string): RingCall | undefined;
  /** The caller's queue entry (waiting, or on offer). */
  queueEntry(callId: string): InboundCallerView | undefined;
  /** The caller still waits to be offered: queued, not on offer, not leaving, promised to nobody, the connector running. */
  stillWaiting(call: RingCall): boolean;
  /** Run `fn` on the call's serial chain (never rejects). */
  serial<T>(callId: string, fn: () => Promise<T>): Promise<T>;
  /**
   * Seat the push offer, with no await: the call `offered` to the session (`channel = 'push'`,
   * client `mobile`, the spine's `record`), named by the session, marked offered in the queue, the
   * lease renewed by the connector (no socket heartbeats it), and the offer's bookkeeping (the
   * waiting notice cleared, the queue gauge, `inbound_waiting`).
   */
  seatPushOffer(call: RingCall, sessionId: string, record: AgencyInboundCallRecord, agentUserId: string): void;
  /** The session holds the call no more: no longer named by it, `channel` back to `station`. */
  unseat(call: RingCall, sessionId: string): void;
  /** The call's timers stopped: the lease, the bind timer and its ring's ({@link RingOffers.clearTimers}). */
  clearTimers(call: RingCall): void;
  /** The offer is over with the caller still held: the call `queued` in memory, with the spine's `record` when there is one. */
  markQueued(call: RingCall, record: AgencyInboundCallRecord | null): void;
  /**
   * The caller back at the head of the queue after an offer ended unbound: searched for again
   * (unless `search` is false), or overflowed when their maximum wait passed during the offer.
   */
  requeueHead(call: RingCall, opts: { search: boolean }): void;
  /** The session's `inbound_call` frame of the call as it stands (to the agent it names). */
  sendFrame(call: RingCall): Promise<void>;
  /** Offer the queued call to a station session already reserved for it (the connector's Mode A offer). */
  offer(call: RingCall, sessionId: string): Promise<'offered' | InboundOfferRefused>;
  /** Bind the call to the session's station (the connector's bind; on the call's chain). */
  bind(call: RingCall): Promise<void>;
  /** Return the agent to the pool off the caller's chain (`releaseAgent`), counted in its returns in flight. */
  returnAgent(sessionId: string): Promise<void>;
  /** Count `work` in the session's returns in flight (the connector's `noteReturn`). */
  noteReturn<T>(sessionId: string, work: Promise<T>): Promise<T>;
  /** Keep `work` until it settles (`drain`, shutdown). */
  track<T>(work: Promise<T>): Promise<T>;
}

export interface RingOffersDeps {
  host: RingHost;
  stations: Pick<StationRegistry, 'get' | 'send'>;
  agents: Pick<AgentStateMachine, 'releaseInbound'>;
  /** The runtime's away break. Without it no phone is ever rung (a media worker, the connector's older suites). */
  awayRing?: InboundAwayRing;
  /** The account's ringable sessions (`InboundConnectorDeps.ringables`); default from {@link awayRing}. */
  ringables?: (tenantId: string, accountId: string) => Promise<AgencyRingableSession[]>;
  now: () => number;
  /** For the `inbound_call` frames built here. */
  connectDelayMs: number;
  /** IQ59: `AGENCY_INBOUND_RING_MS` (tests: shorter). */
  ringMs?: number;
  /** IQ59: `AGENCY_INBOUND_ACCEPT_GRACE_MS` (tests: shorter). */
  acceptGraceMs?: number;
  /** {@link INBOUND_PUSH_RETRY_MS} (tests: shorter). */
  pushRetryMs?: number;
}

/**
 * What a ring's end does to the rung agent's absence ({@link RingEndOptions.absence}):
 *  - `keep`: back to `away_ring`, and an end owed by the misses is sent ({@link RingOffers.end});
 *  - `end`: back to `away_ring`, then the absence ends with `reason` (`AwayRingService.end`; null:
 *    no `ring_off`, and the end is not counted);
 *  - `asReturn`: the agent's own return (the app on screen, or its own `device_away`): the absence
 *    ends as `device_away` on `break`, counted `returned` (`AWAY_RING_RETURN_END`);
 *  - `endedBy`: what ended the ring already ended the absence in the mirror (the take-over's claim):
 *    the agent is left on `device_away`, `since` kept at the absence's start (`since`).
 * Every kind but `keep` ends the absence, and a session no longer on one is left on `device_away`
 * as `endedBy` leaves it.
 */
export type RingAbsenceEnd =
  | { kind: 'keep' }
  | { kind: 'end'; reason: AgencyRingOffReason | null }
  | { kind: 'asReturn' }
  | { kind: 'endedBy'; since: Date | null };

const KEEP_ABSENCE: RingAbsenceEnd = { kind: 'keep' };

/** {@link RingOffers.end}'s options. */
export interface RingEndOptions {
  /** False: the caller is not searched for again (IQ73's take-over offers them itself). */
  search?: boolean;
  /** What the end does to the agent's absence ({@link RingAbsenceEnd}); default `keep`. */
  absence?: RingAbsenceEnd;
  /** The offer metric's result, when not the ring result's. */
  offerResult?: InboundOfferResult;
  /** This caller never rings the session again, whatever the result. */
  neverAgain?: boolean;
}

export class RingOffers {
  private readonly host: RingHost;
  /** callId → its rings, while the connector holds the call. */
  private readonly rings = new Map<string, CallRings>();
  /** The ring window and the accept grace (IQ59). */
  readonly ringMs: number;
  private readonly acceptGraceMs: number;
  /** {@link INBOUND_PUSH_RETRY_MS}, and the epoch ms until which no phone is rung (0: none). */
  private readonly pushRetryMs: number;
  private pushPausedUntil = 0;
  private readonly ringablesFn: NonNullable<RingOffersDeps['ringables']>;

  constructor(private readonly deps: RingOffersDeps) {
    this.host = deps.host;
    this.ringMs = deps.ringMs ?? AGENCY_INBOUND_RING_MS;
    this.acceptGraceMs = deps.acceptGraceMs ?? AGENCY_INBOUND_ACCEPT_GRACE_MS;
    this.pushRetryMs = deps.pushRetryMs ?? INBOUND_PUSH_RETRY_MS;
    const awayRing = deps.awayRing;
    this.ringablesFn = deps.ringables
      ?? (awayRing ? (tenantId, accountId) => awayRing.ringableSessions(tenantId, accountId) : async () => []);
  }

  // ─── Reads (the connector's branch points) ─────────────────────────────────

  /**
   * The account's sessions whose phone may be rung now, as far as the database and the flags tell
   * (`InboundAgentView.ringable`).
   */
  ringables(tenantId: string, accountId: string): Promise<AgencyRingableSession[]> {
    return this.ringablesFn(tenantId, accountId);
  }

  /** The call is on a push offer that has not bound (a ring, or an answered ring in its accept grace). */
  isPushOffer(call: RingCall): boolean {
    return call.phase === 'offered' && call.channel === 'push' && !call.bound;
  }

  /** The call's ring was accepted (`…/ring/accept`, or an attach): it binds once a station is attached. */
  isAccepted(call: RingCall): boolean {
    return this.ringOf(call.id)?.accepted ?? false;
  }

  /** A ring IQ73 may still take the caller from: on offer by push, not yet answered. */
  preemptible(call: RingCall): boolean {
    const ring = this.ringOf(call.id);
    return this.isPushOffer(call) && !!ring && ring.answeredAt === null && !ring.accepted;
  }

  /** When the call's current ring started (epoch ms), if it has one. */
  startedAt(call: RingCall): number | null {
    return this.ringOf(call.id)?.startedAt ?? null;
  }

  /** The account's callers whose ring IQ73 may take over, as the search sees callers (oldest first). */
  ringingCallers(accountKey: string): InboundCallerView[] {
    const out: InboundCallerView[] = [];
    for (const call of this.host.calls()) {
      if (call.accountKey !== accountKey || call.leaving || !this.preemptible(call)) continue;
      const entry = this.host.queueEntry(call.id);
      if (entry) out.push(entry);
    }
    return out.sort((a, b) => a.queuedAt - b.queuedAt);
  }

  /** A ring push failed for the push service's own reasons a moment ago: no phone is rung until the pause ends. */
  paused(): boolean {
    return this.deps.now() < this.pushPausedUntil;
  }

  /** The call has left the connector: its rings are forgotten. */
  forget(callId: string): void {
    this.rings.delete(callId);
  }

  /** Stop the call's ring timers (the call ended, or its ring is ending). */
  clearTimers(call: RingCall): void {
    const ring = this.ringOf(call.id);
    if (!ring) return;
    if (ring.ringTimer) clearTimeout(ring.ringTimer);
    if (ring.acceptTimer) clearTimeout(ring.acceptTimer);
    ring.ringTimer = null;
    ring.acceptTimer = null;
  }

  // ─── The ring routes (the connector's public methods delegate here) ───────────

  /**
   * `…/ring/answering` (IQ71, token only): the agent tapped Answer. On the call's chain, with the
   * ring re-checked there (N3: a station agent's take-over queued first wins, and this answers the
   * uniform `ring_not_offered`): the ring timer stops, `accepted_at` is stamped and the accept
   * grace starts. Idempotent while the grace runs; `already_accepted` once accepted.
   */
  async answering(callId: string, token: string): Promise<
    { ok: true; callId: string; acceptBy: Date } | { ok: false; code: 'ring_not_offered' | 'already_accepted' }
  > {
    return this.onUnacceptedRing(callId, token, async (call, ring) => {
      let answeredAt = ring.answeredAt;
      if (answeredAt === null) {
        // The ring timer fired (its expiry is queued behind this step): too late.
        if (!ring.ringTimer) return NOT_OFFERED;
        answeredAt = await this.markAnswering(call, ring);
      }
      return { ok: true as const, callId, acceptBy: new Date(answeredAt + this.acceptGraceMs) };
    });
  }

  /**
   * `…/ring/decline` (IQ71, token only; valid until accept, N4): the phone declined the ring
   * (`declined`, or `busy_on_phone` when a cellular call is on, IQ70). Never a miss; the caller goes
   * back to the head of the queue and never rings this agent again.
   */
  async decline(callId: string, token: string, reason: 'declined' | 'busy_on_phone'): Promise<
    { ok: true; callId: string; sessionId: string; agentUserId: string | null; tenantId: string; accountId: string } | { ok: false; code: 'ring_not_offered' | 'already_accepted' }
  > {
    return this.onUnacceptedRing(callId, token, async (call, ring) => {
      const agentUserId = call.agentUserId;
      await this.end(call, ring.sessionId, reason);
      return {
        ok: true as const, callId, sessionId: ring.sessionId, agentUserId,
        tenantId: call.record.tenant_id, accountId: call.route.account_id,
      };
    });
  }

  /**
   * Who a ring is for, by its token (the accept route checks the agent and claims the station for
   * the device before {@link accept}): the session and its agent. `ring_expired` for this call's
   * last ring that ended unanswered, `already_accepted` for the ring that bound,
   * `ring_not_offered` for anything else.
   */
  peek(callId: string, token: string): { ok: true; sessionId: string; agentUserId: string | null } | { ok: false; code: InboundRingRefusal } {
    const call = this.host.call(callId);
    if (!call) return { ok: false, code: 'ring_not_offered' };
    const ring = this.ringFor(callId, token);
    if (ring) return { ok: true, sessionId: ring.sessionId, agentUserId: call.agentUserId };
    const rings = this.rings.get(callId);
    if (rings?.boundToken && tokenEquals(rings.boundToken, token)) return { ok: false, code: 'already_accepted' };
    if (rings?.spentToken && tokenEquals(rings.spentToken, token)) return { ok: false, code: 'ring_expired' };
    return { ok: false, code: 'ring_not_offered' };
  }

  /**
   * `…/ring/accept` (IQ71; the route has checked the Bearer's agent and claimed the station for
   * `deviceId`): take the call. `answering` if that has not happened yet, then accepted. Idempotent
   * for the same agent and device until the call binds (a lost answer retried: the same call
   * again), and for the session's own device after an attach accepted it; `already_accepted` for
   * another device or once bound; `ring_expired` once the ring or the grace ran out. If an OPEN
   * station that can take inbound calls is already attached, the call binds now (the frame first).
   */
  async accept(callId: string, token: string, by: { agentUserId: string; deviceId: string }): Promise<
    { ok: true; call: AgencyInboundCall; sessionId: string } | { ok: false; code: InboundRingRefusal }
  > {
    const peeked = this.peek(callId, token);
    if (!peeked.ok) return peeked;
    const call = this.host.call(callId)!;
    const out = await this.host.serial(callId, async (): Promise<{ ok: true; sessionId: string; bindNow: boolean } | { ok: false; code: InboundRingRefusal }> => {
      const ring = this.ringFor(callId, token);
      if (!ring) {
        const again = this.peek(callId, token);
        return again.ok ? { ok: false, code: 'ring_not_offered' } : again;
      }
      if (call.agentUserId !== by.agentUserId) return { ok: false, code: 'ring_not_offered' };
      if (ring.accepted) {
        if (ring.acceptedDevice !== null && ring.acceptedDevice !== by.deviceId) return { ok: false, code: 'already_accepted' };
        return { ok: true, sessionId: ring.sessionId, bindNow: false };
      }
      if (ring.answeredAt === null) {
        if (!ring.ringTimer) return { ok: false, code: 'ring_expired' };
        await this.markAnswering(call, ring);
      }
      ring.accepted = true;
      ring.acceptedDevice = by.deviceId;
      log.info({ inboundCallId: call.id, sessionId: ring.sessionId }, 'Inbound ring accepted');
      const station = this.deps.stations.get(ring.sessionId);
      return { ok: true, sessionId: ring.sessionId, bindNow: !!station && station.canTakeInbound && station.ws.readyState === 1 };
    }) ?? { ok: false, code: 'ring_not_offered' };
    if (!out.ok) return out;
    const ctx = await call.panel;
    const wire = inboundCallToWire(call.record, ctx, call.agentUserId, this.deps.connectDelayMs);
    if (out.bindNow) {
      // A station is already here (the race with an attach): it gets the panel, then the bind.
      this.deps.stations.send(out.sessionId, { event: 'inbound_call', call: wire });
      void this.host.serial(callId, () => this.host.bind(call));
    }
    return { ok: true, call: wire, sessionId: out.sessionId };
  }

  /**
   * End the session's ring because its `away_ring` is ending (N1): the reconcile (the flag off, the
   * maximum age, the device revoked or opted out), the opt-out (the Me toggle), the device removed, or the
   * take-over (OS3, `taken_over`). On the call's chain: a ring not yet answered is cancelled
   * (`answered_elsewhere` for a take-over, else `cancelled`), the agent goes back to `away_ring` and
   * the absence is then ended with `reason` (`AwayRingService.end`); the caller goes back to the
   * head of the queue. An answered ring is left to run (its end returns the agent, and the next
   * reconcile finds the absence to end), except on a take-over: the device that answered no longer
   * holds the station. `none`: no push offer for the session.
   */
  async cancelForAwayRingEnd(
    sessionId: string,
    reason: AgencyRingOffReason,
    opts: { absenceSince?: Date | null } = {},
  ): Promise<'cancelled' | 'answered' | 'none'> {
    return this.onPushOfferOf(sessionId, async (call, ring): Promise<'cancelled' | 'answered'> => {
      const takenOver = reason === 'taken_over';
      const answered = ring.answeredAt !== null;
      if (answered && !takenOver) return 'answered';
      await this.end(call, sessionId, takenOver && !answered ? 'answered_elsewhere' : 'cancelled', {
        // The take-over's claim already ended the absence in the mirror, and its caller sends the
        // old device `ring_off`: the agent is left on a plain break for the new device's attach,
        // `since` kept at the absence's start (`opts.absenceSince`, the claim's).
        absence: takenOver ? { kind: 'endedBy', since: opts.absenceSince ?? null } : { kind: 'end', reason },
      });
      return 'cancelled';
    });
  }

  /**
   * The app asked `device_away` while the session holds a push offer (the away notification's
   * "Stop ringing", IQ79; `AwayRingService.declineRingForDeviceAway`). On the call's chain: a ring
   * not yet answered is the agent saying no to it, so it ends `declined` as the token-only decline
   * does (never a miss, IQ62; the caller never rings this agent again and is searched for again),
   * and the absence then ends as `device_away` keeping its start (IQ76; no `ring_off`: the app
   * asked). A ring already answered or accepted is the agent taking the call (`answered`): left to
   * run, and the pause queues behind it as behind any call. `none`: no push offer for the session.
   */
  async declineForDeviceAway(sessionId: string): Promise<'declined' | 'answered' | 'none'> {
    return this.onPushOfferOf(sessionId, async (call, ring): Promise<'declined' | 'answered'> => {
      if (ring.answeredAt !== null || ring.accepted) return 'answered';
      log.info({ inboundCallId: call.id, sessionId }, 'The app paused as away during a ring — declined');
      await this.end(call, sessionId, 'declined', { absence: { kind: 'asReturn' } });
      return 'declined';
    });
  }

  // ─── The ring ─────────────────────────────────────────────────────────────────

  /**
   * Ring `sessionId`'s phone for the caller (see the header): the session is already reserved for
   * the call from `away_ring` (the search's CAS). On the call's chain. `offered`, else why not (the
   * search gives the reservation back: {@link giveBack}).
   */
  async offer(call: RingCall, sessionId: string): Promise<'offered' | 'call_gone' | 'session_busy' | 'not_ringable'> {
    if (!this.deps.awayRing || !this.host.stillWaiting(call)) return 'call_gone';
    // IQ69: a ring starts only with a whole ring window of the caller's wait left.
    const entry = this.host.queueEntry(call.id);
    if (entry && !ringWindowLeft(entry, this.deps.now(), this.ringMs)) return 'call_gone';
    const device = await this.deps.awayRing.ringableDevice(sessionId).catch((err: unknown) => {
      log.warn({ err, sessionId }, 'Could not read the session\'s push device to ring it');
      return null;
    });
    if (!device) return 'not_ringable';
    if (!this.host.stillWaiting(call)) return 'call_gone';
    const at = new Date(this.deps.now());
    const res = await agencyInboundCallRepository.offer(call.id, sessionId, { at, channel: 'push' });
    if (!res.ok) {
      trackInboundOffer('refused', 'mobile', 'push');
      return res.reason === 'session_busy' ? 'session_busy' : 'call_gone';
    }
    // ── From here to the timers, no await ───────────────────────────────────
    const ring: RingState = {
      token: randomBytes(16).toString('base64url'),
      sessionId,
      device,
      startedAt: at.getTime(),
      ringTimer: null,
      answeredAt: null,
      acceptTimer: null,
      accepted: false,
      acceptedDevice: null,
    };
    this.ringsOf(call.id).ring = ring;
    this.host.seatPushOffer(call, sessionId, res.call, device.user_id);
    ring.ringTimer = setTimeout(() => {
      ring.ringTimer = null;
      void this.host.serial(call.id, async () => {
        if (this.ringOf(call.id) !== ring || ring.answeredAt !== null) return;
        await this.end(call, sessionId, 'expired');
      });
    }, this.ringMs);
    ring.ringTimer.unref?.();
    // ── Then the mirror, then the push (outside the account's lock) ─────────────
    await agencyAgentSessionRepository.setState(sessionId, 'reserved')
      .catch((err: unknown) => log.warn({ err, sessionId }, 'Could not mirror an inbound ring\'s reservation'));
    log.info({ inboundCallId: call.id, sessionId }, 'Inbound call ringing an away phone');
    void this.host.track(this.sendRing(call, ring));
    return 'offered';
  }

  /**
   * The `ring` push (IQ61: ids, the token and the deadline only). A failure ends the ring
   * `push_failed`, never a miss (IQ62 counts only the agent's own), and is classed by whose
   * trouble it is (`pushFailureScope`, IQ75):
   *  - this device's, for good (`unregistered`, `invalid`: the carrier refused its token): the
   *    device is revoked (`AwayRingService.send`) and the absence ends (`revoked`);
   *  - this device's, for now (a `rate_limited` held for this device alone): this caller never
   *    rings that phone again and the search goes on (the team's phones next); the agent stays
   *    ringable for other callers;
   *  - the push service's (`unavailable`, `unconfigured`, an FCM 429): every phone would fail
   *    alike, so the agent may be rung for this caller again, no new search is run, and no phone is
   *    rung for {@link INBOUND_PUSH_RETRY_MS} (the republish after it retries): an outage never
   *    walks one caller through the whole pool.
   */
  private async sendRing(call: RingCall, ring: RingState): Promise<void> {
    const awayRing = this.deps.awayRing!;
    const result = await awayRing.send(ring.device, {
      type: 'ring',
      call_id: call.id,
      offer_token: ring.token,
      ring_expires_at: new Date(ring.startedAt + this.ringMs).toISOString(),
      session_id: ring.sessionId,
    }, this.ringMs).catch((err: unknown) => {
      log.warn({ err, inboundCallId: call.id }, 'The ring push threw');
      return { ok: false as const, reason: 'unavailable' as const };
    });
    if (result.ok) return;
    await this.host.serial(call.id, async () => {
      if (this.ringOf(call.id) !== ring || ring.answeredAt !== null) return;
      log.info({ inboundCallId: call.id, sessionId: ring.sessionId, reason: result.reason }, 'The ring push failed — the ring ends');
      if (pushFailureRevokes(result.reason)) {
        // The carrier refused the token for good: the device was revoked (`AwayRingService.send`),
        // and the absence ends `revoked`.
        await this.end(call, ring.sessionId, 'push_failed', { absence: { kind: 'end', reason: 'revoked' }, neverAgain: true });
        return;
      }
      if (pushFailureScope(result) === 'device') {
        // This phone alone cannot be pushed to just now: this caller moves on to the next phone.
        await this.end(call, ring.sessionId, 'push_failed', { neverAgain: true });
        return;
      }
      // The push service's trouble: ringing paused before the caller goes back to the queue, so
      // nothing rings the next phone meanwhile.
      this.pushPausedUntil = Math.max(this.pushPausedUntil, this.deps.now() + this.pushRetryMs);
      await this.end(call, ring.sessionId, 'push_failed', { search: false });
    });
  }

  /**
   * The ring was answered (on the call's chain): the ring timer stopped, `accepted_at`, the grace.
   * Answers the instant it was answered (set before any await).
   */
  private async markAnswering(call: RingCall, ring: RingState): Promise<number> {
    if (ring.ringTimer) clearTimeout(ring.ringTimer);
    ring.ringTimer = null;
    const answeredAt = this.deps.now();
    ring.answeredAt = answeredAt;
    trackInboundRingAnswer((answeredAt - ring.startedAt) / 1000);
    ring.acceptTimer = setTimeout(() => {
      ring.acceptTimer = null;
      void this.host.serial(call.id, async () => {
        if (this.ringOf(call.id) !== ring || call.bound) return;
        await this.end(call, ring.sessionId, 'accept_lapsed');
      });
    }, this.acceptGraceMs);
    ring.acceptTimer.unref?.();
    const at = new Date(answeredAt);
    const row = await agencyInboundCallRepository.markRingAnswered(call.id, ring.sessionId, at).catch((err: unknown) => {
      log.warn({ err, inboundCallId: call.id }, 'Could not stamp an answered ring');
      return null;
    });
    call.record = row ?? { ...call.record, accepted_at: call.record.accepted_at ?? at };
    return answeredAt;
  }

  /** N5: a station with `caps=inbound` attached during a ring (on the call's chain): accepted, and the phone told to stop. */
  async acceptOnAttach(call: RingCall, sessionId: string): Promise<void> {
    const ring = this.ringOf(call.id);
    if (!ring || call.sessionId !== sessionId || !this.isPushOffer(call) || ring.accepted) return;
    if (ring.answeredAt === null) {
      if (!ring.ringTimer) return; // expired: its end is next on this chain
      await this.markAnswering(call, ring);
      log.info({ inboundCallId: call.id, sessionId }, 'The app opened during a ring — answered there');
    }
    ring.accepted = true;
    // The native ring stops (the agent is in the app now).
    this.sendRingCancel(ring, call.id, 'answered');
  }

  /**
   * An accepted ring bound (audio flows from here, as any bind): the ring is over, `answered`, the
   * agent's missed rings reset (IQ62) and the absence over (`away_ring_since` cleared).
   * Synchronous; the writes follow.
   */
  onBound(call: RingCall, sessionId: string): void {
    const rings = this.rings.get(call.id);
    const ring = rings?.ring;
    if (!rings || !ring) return;
    if (ring.ringTimer) clearTimeout(ring.ringTimer);
    if (ring.acceptTimer) clearTimeout(ring.acceptTimer);
    rings.ring = null;
    rings.boundToken = ring.token;
    trackInboundRing('answered');
    // The cold start's headroom inside the accept grace: answered on the phone → bound.
    if (ring.answeredAt !== null) trackInboundRingBind((this.deps.now() - ring.answeredAt) / 1000);
    // Not awaited (this runs inside the bind), but tracked: `drain()` and the shutdown wait for them.
    void this.host.track(agencyInboundCallRepository.setRingResult(call.id, 'answered')
      .catch((err: unknown) => log.warn({ err, inboundCallId: call.id }, 'Could not write an answered ring')));
    void this.host.track(agencyAgentSessionRepository.ringAnswered(sessionId)
      .catch((err: unknown) => log.warn({ err, sessionId }, 'Could not reset the missed rings and the absence')));
    log.info({ inboundCallId: call.id, sessionId }, 'Inbound ring answered and bound');
  }

  /**
   * IQ73 (N3), on the call's chain: `stationSessionId`, a station agent who freed up, is already
   * reserved for this caller (the search's or the release hook's CAS, under the account's lock).
   * If the ring was answered meanwhile it stands, and the station agent is given back
   * (`call_gone`); else the ring ends `answered_elsewhere` with no new search, and the station
   * agent is offered the caller.
   */
  async takeOver(call: RingCall, stationSessionId: string): Promise<'offered' | InboundOfferRefused> {
    // The ring ended between the search's decision and this step (it expired, was declined, or an
    // earlier candidate's take-over ended it): the caller, back in the queue, is offered as any
    // queued caller (`offer` refuses one that is not: an answered ring stands).
    if (!this.preemptible(call) || !call.sessionId) return this.host.offer(call, stationSessionId);
    const row = await this.end(call, call.sessionId, 'answered_elsewhere', { search: false });
    if (!row) return 'call_gone';
    log.info({ inboundCallId: call.id, sessionId: stationSessionId }, 'A station agent freed up mid-ring — they take the caller (IQ73)');
    return this.host.offer(call, stationSessionId);
  }

  // ─── The one end of a ring ────────────────────────────────────────────────────

  /**
   * End a push offer that has not bound (see the header, "Every other end"), on the call's chain:
   * the one end of every ring, the caller's hang-up included. The agent goes back to `away_ring`
   * ({@link releaseRungAgent}), and the absence then goes as `opts.absence` says ({@link RingAbsenceEnd});
   * kept, an owed `ring_missed` end is sent ({@link noteMiss}). The
   * caller goes back to the head of the queue (and the account is searched again unless `search`
   * is false: IQ73's take-over offers the caller itself), except for `caller_left`: the bridge's
   * `ended` has settled the call, which the connector then lets go. Null when the call is not on a
   * push offer to the session, for `caller_left`, or when it ended meanwhile (its `ended` follows
   * on this chain; the agent is released either way).
   */
  async end(
    call: RingCall,
    sessionId: string,
    result: AgencyInboundRingResult,
    opts: RingEndOptions = {},
  ): Promise<AgencyInboundCallRecord | null> {
    if (!this.isPushOffer(call) || call.sessionId !== sessionId) return null;
    const rings = this.ringsOf(call.id);
    const ring = rings.ring;
    this.host.clearTimers(call);
    rings.ring = null;
    if (ring) rings.spentToken = ring.token;
    if (NEVER_AGAIN.has(result) || opts.neverAgain) call.declined.add(sessionId);
    const callEnded = result === 'caller_left';
    let row: AgencyInboundCallRecord | null = null;
    let requeueFailed = false;
    if (callEnded) {
      // The call is settled already (the router's, from the bridge's `ended`): the ring's result is
      // written on the ended row, and the session's last frame of the call says it ended.
      await agencyInboundCallRepository.setRingResult(call.id, 'caller_left')
        .catch((err: unknown) => log.warn({ err, inboundCallId: call.id }, 'Could not write a ring the caller left'));
      const ended = await agencyInboundCallRepository.findByIdAnyTenant(call.id).catch(() => null);
      if (ended) call.record = ended;
      await this.host.sendFrame(call);
    } else {
      // A requeue that throws is handled as the connector's `unwriteOffer`'s: the agent is still
      // released and the caller requeued in memory (below), never left on a push offer with no
      // timer. The spine then still reads `offered` to the session, so every later offer of the
      // caller is refused there (`not_offerable`) and they leave at their maximum wait, whose
      // settle ends the row.
      const requeued = await agencyInboundCallRepository.requeue(call.id, sessionId, { at: new Date(this.deps.now()), ringResult: result })
        .catch((err: unknown) => {
          log.warn({ err, inboundCallId: call.id, sessionId, result },
            'Could not requeue an ended ring — the caller waits in memory and the spine reads offered until they leave');
          return undefined;
        });
      requeueFailed = requeued === undefined;
      row = requeued ?? null;
    }
    // From here the session holds no push offer: the release below may end its absence.
    this.host.unseat(call, sessionId);
    trackInboundRing(result);
    if (ring && result !== 'push_failed') this.sendRingCancel(ring, call.id, result);
    const absence = opts.absence ?? KEEP_ABSENCE;
    const released = await this.releaseRungAgent(call.id, sessionId, absence);
    if (released === 'away_ring' && absence.kind === 'keep') await this.noteMiss(sessionId, MISSES.has(result));
    if (callEnded) {
      trackInboundOffer('caller_left', 'mobile', 'push');
      return null;
    }
    if (!row && !requeueFailed) {
      // Not on offer to this session any more: the call ended (its `ended` is next on this chain).
      this.host.markQueued(call, null);
      return null;
    }
    trackInboundOffer(opts.offerResult ?? offerResultOfRing(result), 'mobile', 'push');
    this.host.markQueued(call, row);
    log.info({ inboundCallId: call.id, sessionId, result }, 'Inbound ring ended — the caller is back at the head of the queue');
    // A station attached for an accepted ring: its last frame of this call says it is not theirs.
    if (row && this.deps.stations.get(sessionId)) {
      const ctx = await call.panel;
      this.deps.stations.send(sessionId, { event: 'inbound_call', call: { ...inboundCallToWire(row, ctx, null, this.deps.connectDelayMs), session_id: sessionId } });
    }
    this.host.requeueHead(call, { search: opts.search !== false });
    return row;
  }

  /**
   * Return a rung agent after their push offer ended unbound (IQ67). With an OPEN station here (an
   * accepted ring whose station attached) and the absence kept, Mode A's: the field cleared and
   * `releaseAgent` (`station`). Otherwise back to `away_ring` (`AwayRingService.releaseInbound`), and
   * the absence then goes as `absence` says ({@link RingAbsenceEnd}; `ended` unless kept). A session
   * no longer on an absence goes back as Mode A's (`returned`) when it is kept, else is left on
   * `device_away` (`AwayRingService.endAfterRing`). Never throws.
   */
  private async releaseRungAgent(
    callId: string,
    sessionId: string,
    absence: RingAbsenceEnd,
  ): Promise<'station' | 'away_ring' | 'ended' | 'returned' | 'not_held'> {
    try {
      const station = this.deps.stations.get(sessionId);
      const awayRing = this.deps.awayRing;
      const ending = absence.kind !== 'keep';
      // Mode A's return with an OPEN station here, unless this end also ends the absence: then the
      // absence's end, whatever is attached (an attach that cannot take the call is the agent's
      // return: `device_away`, never the pool).
      if ((station && station.ws.readyState === 1 && !ending) || !awayRing) {
        await this.deps.agents.releaseInbound(sessionId, callId);
        void this.host.returnAgent(sessionId);
        return station ? 'station' : 'returned';
      }
      const out = await awayRing.releaseInbound(sessionId, callId, { ending });
      if (out === 'away_ring') {
        switch (absence.kind) {
          case 'keep':
            return 'away_ring';
          case 'end':
            await awayRing.end(sessionId, absence.reason);
            return 'ended';
          case 'asReturn':
            await awayRing.end(sessionId, null, AWAY_RING_RETURN_END);
            return 'ended';
          case 'endedBy':
            await awayRing.end(sessionId, null);
            return 'ended';
        }
      }
      if (out === 'not_away_ring') {
        if (ending) {
          // The absence was ended by what ended this ring (the take-over's claim): `device_away`,
          // which the new station's attach shows, `since` kept at the absence's start.
          await awayRing.endAfterRing(sessionId, callId, absence.kind === 'endedBy' ? absence.since : null);
          return 'ended';
        }
        await this.deps.agents.releaseInbound(sessionId, callId);
        void this.host.returnAgent(sessionId);
        return 'returned';
      }
      return out;
    } catch (err) {
      // The reserved lease is no longer renewed: it lapses, and the reconcile re-seeds `away_ring`.
      log.error({ err, inboundCallId: callId, sessionId }, 'Could not return a rung agent — the lease lapses and the reconcile restores away_ring');
      return 'not_held';
    }
  }

  /**
   * After a ring ended with the agent back on `away_ring`: one more missed ring when `missed`
   * (IQ62), and the absence ended (`ring_missed`) once the misses reach the maximum. Asked after
   * every ring's end, not only a miss: the end owed by an earlier miss is lost if another caller's
   * search rang the agent between that ring's release and its end (`ring_in_flight`), so the next
   * ring's end ends it (the ring rule rings no such agent again after that, and the reconcile ends an
   * absence whose owed end was lost all the same). Never throws.
   */
  private async noteMiss(sessionId: string, missed: boolean): Promise<void> {
    try {
      const misses = missed
        ? await agencyAgentSessionRepository.noteRingMiss(sessionId)
        : await agencyAgentSessionRepository.ringMisses(sessionId);
      if (misses >= AGENCY_INBOUND_RING_MAX_MISSES) {
        log.info({ sessionId, misses }, 'Missed rings in a row — the phone stops ringing');
        await this.deps.awayRing?.end(sessionId, 'ring_missed');
      }
    } catch (err) {
      log.warn({ err, sessionId }, 'Could not count a missed ring');
    }
  }

  /** `ring_cancel` to the rung phone (Android only; not awaited, but tracked: `drain()` waits for it). */
  private sendRingCancel(ring: RingState, callId: string, result: AgencyInboundRingResult): void {
    const awayRing = this.deps.awayRing;
    if (!awayRing || ring.device.platform !== 'android') return;
    void this.host.track(awayRing.send(ring.device, { type: 'ring_cancel', call_id: callId, session_id: ring.sessionId, reason: result }, this.ringMs)
      .catch((err: unknown) => log.warn({ err, inboundCallId: callId }, 'Could not send ring_cancel')));
  }

  /**
   * Undo a ring's reservation the ring never used (the call went, it was refused, the device
   * cannot be rung): back to `away_ring`, or Mode A's return for a session no longer on an absence.
   * Counted in the session's returns in flight.
   */
  giveBack(sessionId: string, callId: string, why?: 'session_busy' | 'call_gone' | 'not_ringable'): Promise<void> {
    // A session the spine says holds another unsettled inbound call (a stale row a restart left)
    // is never rung again: its absence ends (`device_away`), as Mode A puts such a session on a
    // break, so no search reserves it again every republish.
    const absence: RingAbsenceEnd = why === 'session_busy' ? { kind: 'end', reason: null } : KEEP_ABSENCE;
    if (why === 'session_busy') log.warn({ sessionId, callId }, 'Session reserved for a ring while it holds another inbound call — its away break ends');
    return this.host.noteReturn(sessionId, this.releaseRungAgent(callId, sessionId, absence).then(() => undefined));
  }

  // ─── Plumbing ─────────────────────────────────────────────────────────────────

  /**
   * A token-only route's step ({@link answering}, {@link decline}): `fn` on the call's chain, with the
   * ring for `token` re-checked there (N3: a take-over queued first wins). `ring_not_offered` when
   * there is no such ring, `already_accepted` once it was accepted.
   */
  private async onUnacceptedRing<T>(
    callId: string,
    token: string,
    fn: (call: RingCall, ring: RingState) => Promise<T>,
  ): Promise<T | typeof NOT_OFFERED | typeof ALREADY_ACCEPTED> {
    if (!this.ringFor(callId, token)) return NOT_OFFERED;
    const call = this.host.call(callId)!;
    return await this.host.serial(callId, async () => {
      const ring = this.ringFor(callId, token);
      if (!ring) return NOT_OFFERED;
      if (ring.accepted) return ALREADY_ACCEPTED;
      return fn(call, ring);
    }) ?? NOT_OFFERED;
  }

  /**
   * A step on the session's push offer ({@link cancelForAwayRingEnd}, {@link declineForDeviceAway}):
   * `fn` on the call's chain, with the push offer re-checked there. `none`: the session holds none.
   */
  private async onPushOfferOf<T>(sessionId: string, fn: (call: RingCall, ring: RingState) => Promise<T>): Promise<T | 'none'> {
    const call = this.host.callFor(sessionId);
    if (!call || !this.isPushOffer(call)) return 'none';
    return await this.host.serial(call.id, async (): Promise<T | 'none'> => {
      const ring = this.ringOf(call.id);
      if (call.sessionId !== sessionId || !this.isPushOffer(call) || !ring) return 'none';
      return fn(call, ring);
    }) ?? 'none';
  }

  /** The current ring of `callId` if `token` is its offer token (constant time); null otherwise. */
  private ringFor(callId: string, token: string): RingState | null {
    const call = this.host.call(callId);
    const ring = this.ringOf(callId);
    if (!call || !ring || !this.isPushOffer(call) || call.sessionId !== ring.sessionId) return null;
    return tokenEquals(ring.token, token) ? ring : null;
  }

  private ringOf(callId: string): RingState | null {
    return this.rings.get(callId)?.ring ?? null;
  }

  private ringsOf(callId: string): CallRings {
    let rings = this.rings.get(callId);
    if (!rings) {
      rings = { ring: null, spentToken: null, boundToken: null };
      this.rings.set(callId, rings);
    }
    return rings;
  }
}
