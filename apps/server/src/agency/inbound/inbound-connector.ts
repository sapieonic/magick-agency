import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type WebSocket from 'ws';
import {
  AGENCY_INBOUND_ACCEPT_GRACE_MS,
  AGENCY_INBOUND_CONNECT_DELAY_MS,
  AGENCY_INBOUND_RING_MAX_MISSES,
  AGENCY_INBOUND_RING_MS,
  DEVICE_AWAY_BREAK_REASON,
  type AgencyInboundRingResult,
  type AgencyRingOffReason,
  type AgencyInboundCall,
  type AgencyInboundCallOutcome,
  type AgencyInboundClipSlot,
  type AgencyClientKind,
  type AgencyInboundMissedReason,
  type AgencyInboundStickyReason,
  type AgencyStationCustomerWaitingFrame,
} from '@magick-agency/contracts/agency';
import { createChildLogger } from '@magick-agency/observability';
import {
  trackInboundCallEnded,
  trackInboundOffer,
  trackInboundRing,
  trackInboundRingAnswer,
  trackInboundOverflow,
  trackInboundQueueWaiting,
  trackInboundWait,
  type InboundOfferResult,
  type InboundOverflowReason,
  type InboundWaitResult,
} from '@magick-agency/observability/metrics/agency';
import {
  agencyAgentSessionRepository,
  agencyInboundAnswerRepository,
  agencyInboundCallRepository,
  agencyPushDeviceRepository,
  pushDeviceRingable,
  type AgencyInboundCallRecord,
  type AgencyInboundRouteRecord,
  type AgencyRingableSession,
} from '../../db/repositories/agency.repository.js';
import type { PushDeviceRecord } from '@magick-agency/db/models/push-device.model';
import { getPushSender } from '../../seams/push-sender.js';
import type { AwayRingService } from '../away-ring.js';
import type { InboundHoldResult, WebRtcBridgeManager, WebRtcLifecycleEvent } from '../../core/webrtc-bridge-manager.js';
import type { StationDetached, StationRegistry } from '../station-registry.js';
import { AGENT_LEASE_MS, type AgentLiveState, type AgentStateMachine } from '../agent-state-machine.js';
import { publishPacingInvalidation, type PacingInvalidationEvent } from '../pacing/invalidation-bus.js';
import {
  COULD_TAKE_STATES,
  INBOUND_DEVICE_AWAY_GRACE_MS,
  RELEASE_STATES,
  anyoneCouldTake,
  callerForReleasedAgent,
  inStickyPhase,
  inboundIneligibility,
  ringWindowLeft,
  searchOrder,
  stickyAgentOf,
  stickyAgentStatus,
  type InboundAgentView,
  type InboundCallerView,
  type StickyAgentStatus,
} from './eligibility.js';
import { InboundQueue, accountKeyOfCall, summarizeWaiting, type InboundQueueRouteSnapshot } from './inbound-queue.js';
import { inboundCallToWire, loadInboundPanelContext, type InboundPanelContext } from './inbound-call-wire.js';
import { InboundHandovers, type HandoverHost, type InboundOfferRefused } from './inbound-handover.js';
import { matchName } from './match-name.js';

const log = createChildLogger({ component: 'agency-inbound-connector' });

/**
 * ─── THE INBOUND CONNECTOR: A WAITING CALLER TO AN AGENT (docs/inbound.md §2, §5; P2) ───────
 *
 * Owns every call the router hands it (`take`, the `queue` plan) from the end of its answer to
 * its end: the preamble and the hold (`playInboundHold`), the queue (`inbound-queue.ts`), the
 * agent search (`eligibility.ts`), the reservation (`reserveForInbound`), the offer and the bind,
 * the connected call's end and the agent's wrap-up. What a call that reaches nobody hears and
 * writes (the overflow message, the Missed row, the callback) is the router's
 * ({@link InboundCallExits}); the outcome an answered call owes is the finish routes'
 * (`inbound-disposition.ts`). One process (IB8).
 *
 * ── A call's phases (in memory; the spine row is the durable half) ───────────────
 *   preamble → queued ⇄ offered → connected → done   (and `leaving`: its overflow message plays)
 *  1. `preamble`: the greeting and, for a recorded call, the notice (IB7) play through the hold
 *     member; the hold loop follows. When the preamble is over (`onPreambleDone`, IQ5) the spine
 *     moves to `queued` (`queued_at`), the caller is queued (over `max_waiting` only an agent free
 *     right now keeps them), "Your customer is waiting" goes to a busy sticky agent, pacing is
 *     told (`inbound_waiting`) and the account is searched.
 *  2. The search ({@link search}, one at a time per account): for each waiting caller in order,
 *     each candidate is CAS-reserved from `available` (`reserveForInbound`); the first to win is
 *     offered the call. Lost CAS: the next candidate. A caller nobody can take keeps waiting until
 *     an agent frees: `onAgentAvailable` (an `available` write, announced only after
 *     `releaseAgent` has mirrored it and told the agent) or the release hook ({@link takeOnRelease}:
 *     `releaseAgent` asks before writing `available`, so an agent coming out of a call or a wrap-up
 *     is offered the caller with no `available` instant in between; however long the wrap-up, its
 *     lease is still there: the station heartbeat renews a `wrapup` this process vouches for, a
 *     campaign wrap-up held here or an inbound outcome owed, `heartbeatLeaseMs`). The account is
 *     searched again on every republish (2 s) while callers wait: the backstop for a change no event
 *     reports (a busy sticky agent going away makes their caller the team's, IQ6).
 *  3. The offer ({@link offer}, on the call's serial chain): the spine `offered` (guarded; a call
 *     that ended or a session that owes another outcome refuses and the reservation is given
 *     back), then SYNCHRONOUSLY the `agent_state: reserved` and the `inbound_call` frames (state
 *     `offered`, `connects_at`), so the panel and the chime come before any audio (IB1). The
 *     lease is renewed every 5 s; a lost lease cancels the offer.
 *  4. The bind, `AGENCY_INBOUND_CONNECT_DELAY_MS` after the offer (server-timed, IQ4): the station
 *     socket must be OPEN (else the offer is cancelled), then `bindBorrowedBrowserLeg` stops the
 *     hold synchronously, re-arms the max duration, starts talk time and emits `bridged`. On
 *     `bridged`: the spine `connected` (`bridged_at`, the agent), the agent `on_call`, the frame.
 *     Audio flows from the bind whatever the database says: a `connected` write that fails leaves
 *     the call connected in memory (`connectOwed`) and is retried at its end, before `answered`.
 *  5. The end (the bridge's `ended`): connected → the spine `answered` (owed: `settled_at` NULL),
 *     the agent `wrapup` with the `inbound` field kept (no auto-return, IQ11), the frame with
 *     `outcome_due_at`; offered → the caller hung up: the router's settle (`abandoned_in_queue`,
 *     the Missed row and the callback), the reservation released and the agent returned
 *     (`releaseAgent`: a queued break applies, else the hook may offer the next caller);
 *     preamble/queued → the router's settle.
 *
 * ── Cancelling an offer (the station lost before audio bound, §5.1) ───────────────
 * `onStationClosed` (the runtime's close handler, before it writes `offline`), the bind finding
 * the socket not OPEN, or the lease lost: the spine back to `queued` (session cleared, `queued_at`
 * kept), the reservation field cleared, the caller back at the HEAD of the queue (still on hold:
 * the hold is only stopped by the bind) and the account searched again. A caller whose maximum
 * wait passed during the offer is overflowed then.
 *
 * ── Ordering and races ───────────────────────────────────────────────────────────
 * Every step that touches one call runs on that call's SERIAL chain (the soft phone's pattern):
 * the offer, the bind, `bridged`, `ended`, a cancel, the timers. So a bind never lands on an ended
 * call and an end never interleaves with an offer half written. The search runs under one mutex
 * per ACCOUNT (not for correctness, which the CAS gives: to stop a pile-up of CAS attempts).
 * **No chain task ever waits for an account's mutex**: a task that returns an agent
 * (`releaseAgent`, which runs the hook, which takes the mutex) does it in the background
 * ({@link releaseInBackground}), and a task that wants a search schedules one. The search (and the
 * release hook) awaits the chain of the caller it offers, which holds no long task while the caller
 * waits: the one long step on a waiting caller's chain is their exit (the overflow message, a
 * voicemail: minutes), and a caller is marked `leaving` SYNCHRONOUSLY the moment that exit is
 * decided (the maximum-wait timer, a cancelled offer past it, over `max_waiting` with nobody free),
 * before it is queued on the chain.
 * A leaving caller is never reserved for, and the mark is re-checked after each CAS with no await
 * before the offer is queued, so the lock is never held behind a message.
 *
 * ── The in-flight clash (§5.4): the hand-over ──────────────────────────────────────
 * `inbound-handover.ts` ({@link InboundHandovers}): a call promised to the agent of the outbound
 * dial it superseded ({@link expectHandover}) is offered to nobody else; the release hook
 * ({@link takeOnRelease}) takes that agent for it first, offered at once when the call is queued,
 * else held for it until its preamble ends ({@link onQueued} offers it then). The module keeps the
 * promises and runs those steps; this connector lends it its calls, chains, reservations and
 * offers ({@link handoverHost}).
 *
 * ── Could anyone take them (PM-M6), and the rejoin grace (SWE-F1) ─────────────────
 * A waiting caller nobody in their pool could take, now or once their current work ends
 * (`anyoneCouldTake`), is overflowed at once ({@link overflowWhomNobodyCanTake}); the router asks
 * the same question before the greeting ({@link couldAnyoneTake}) and answers such a caller with
 * the overflow action directly. A station that has just closed still counts for
 * {@link INBOUND_STATION_REJOIN_GRACE_MS}: the registry's detach tells this connector the station
 * and it reads the agent's state at once (issued before the close handler's `offline` write, on
 * the same Redis connection); while the grace runs the session is a `rejoining` view (counted,
 * never offered), and when it ends the account is searched again, so a caller held only by an
 * agent who never came back is overflowed then, not at the maximum wait.
 *
 * ── A phone that just left the app (IQ50) ────────────────────────────────────────
 * An agent on a `device_away` pause applied less than {@link INBOUND_DEVICE_AWAY_GRACE_MS} ago is
 * counted the same way (an `awayGrace` view: could take, never offered), because the app returns
 * them by itself when they come back within it. The source is the session row (`break_reason`
 * `device_away` and `state_since`, written when the pause applied; Redis holds no break reason),
 * read only for the sessions Redis says are on a break that began inside the grace, so a floor
 * with no fresh break reads nothing more. When a pause's grace ends the account is searched again
 * (its own timer, as for the rejoin grace): a caller held only by an agent who did not come back
 * is overflowed then (`no_agents`). A read that fails counts nobody as in the grace.
 *
 * ── Ringing an away phone (Mode B, IQ58–IQ74; docs/inbound.md "Ringing an away phone") ──
 * An agent on `away_ring` has parked their station socket; their phone is rung by a data push
 * instead (IQ66: a ring IS an offer, on channel `push`). The agent views read such sessions from
 * the database in one statement (`findRingableInAccount`: the session's station device registered,
 * opted in, with a token; both flags on; the sender configured) beside Redis's `break, ring = 1`;
 * the search tries them in IQ63's order (`eligibility.ts`), one phone per caller at a time, and only
 * with a ring window of the caller's wait left (IQ69). {@link ringOffer}, on the call's chain: the
 * CAS `break (ring = 1) → reserved` was the search's; the spine `offered` with `offer_channel =
 * push`, `ringing_at` and `ring_count + 1`; the phase `offered` with `held.channel = 'push'`, a fresh
 * 128-bit offer token held only here (never logged, audited or persisted), the lease renewed by
 * this connector (there is no socket), the ring timer ({@link ringMs}); no `inbound_call` frame and
 * no bind timer. The push is sent after, outside the account's lock.
 *  - `answering` ({@link ringAnswering}, token only, on the call's chain): the ring timer stops,
 *    `accepted_at` is stamped and the accept grace starts; from here IQ73 cannot take the caller.
 *  - `accept` ({@link ringAccept}, the agent's Bearer, the token, the station's device): `answering`
 *    if not yet, then accepted; the route mints the station token. Idempotent for the same agent
 *    and device until the call binds. If an OPEN station that can take inbound calls is already
 *    attached, it binds now.
 *  - The attach ({@link reattachStation}): the `inbound_call` frame (no `connects_at`, `accepted_at`
 *    set), then the bind ({@link bindAcceptedRing}). An attach with `caps=inbound` during a ring not
 *    yet answered (the agent opened the app by its icon) is an implicit answer and accept, and the
 *    phone is sent `ring_cancel` so it stops ringing (N5). A socket that closes inside the grace
 *    does not cancel the offer: it waits for a re-attach until the grace ends.
 *  - `decline` ({@link ringDecline}, token only, until accept: N4) is `declined` (or
 *    `busy_on_phone`), never a miss; after accept the agent's hang-up is the way out.
 *  - Every other end ({@link endRing}): expired, the grace lapsed (`accept_lapsed`), the push
 *    failed, the caller left, the lease lost, a station agent took the caller (IQ73,
 *    `answered_elsewhere`), the away break ended (`cancelled`). Each writes `ring_result`, sends
 *    Android `ring_cancel` (fire and forget), returns the agent to `away_ring`
 *    (`AwayRingService.releaseInbound`; Mode A's `releaseAgent` only when an OPEN station is
 *    attached here) and puts the caller back at the head of the queue. An expiry or a lapse is a
 *    miss (IQ62): the second in a row ends `away_ring` (`ring_missed`), and an agent with that many
 *    misses is never rung again (`findRingableInAccount`; a ring that slipped in before the end
 *    landed ends it when it ends). A failed push is no miss: an unregistered token revokes the
 *    device and ends the absence (`revoked`); any other failure (the push service unavailable,
 *    rate-limited, refusing the message, or unconfigured) is the carrier's trouble, not the
 *    agent's, so the agent stays ringable for this caller, and no phone is rung for
 *    {@link INBOUND_PUSH_RETRY_MS} (no new search either), so an outage never walks a caller
 *    through the whole pool; the republish after that retries.
 *  - IQ73 (N3): a station agent who frees up while a ring is not yet answered is reserved for that
 *    caller under the account's lock first; then, in one step of the call's chain, the ring is
 *    cancelled with no new search and the station agent offered the caller (or, if `answering`
 *    landed first, the station agent is given back).
 *  - IQ68: a ringable agent counts as one who could take the caller (`couldTakeLater`).
 *
 * ── Voicemail (§7) ───────────────────────────────────────────────────────────────
 * A caller who reaches nobody leaves through {@link InboundCallExits.overflow}, the router's,
 * which carries out the route's overflow action (the call-back message, or a voicemail) and
 * answers how the call is settled ({@link InboundCallEnd}).
 */

/** How long a published `inbound_waiting` holds pacing back unless republished. */
export const INBOUND_WAITING_TTL_MS = 5_000;
/** How often the connector republishes `inbound_waiting` while callers wait. */
export const INBOUND_WAITING_REPUBLISH_MS = 2_000;

/**
 * Mode B: after a ring push that failed for the push service's own reasons (unavailable,
 * rate-limited, refused, unconfigured; not an unregistered token), how long no phone is rung, so
 * an outage of the push service never walks one caller through the whole pool in milliseconds.
 * The republish after it retries.
 */
export const INBOUND_PUSH_RETRY_MS = 10_000;

/**
 * How long a session whose station socket closed still counts as one who could take a waiting
 * caller (SWE-F1): past the console's reconnect and the bridge's deferred hangup
 * (`DEFERRED_HANGUP_MS`, 8 s), so a blip of the one agent who could take the account's callers
 * does not overflow every one of them.
 */
export const INBOUND_STATION_REJOIN_GRACE_MS = 15_000;

/**
 * How an unconnected call ends: its outcome and, for a voicemail (§7), the recording and the
 * Missed reason of the action that took it (`closed` after hours, `overflow` from the queue).
 */
export interface InboundCallEnd {
  outcome: AgencyInboundCallOutcome;
  voicemail?: { key: string; seconds: number; reason: AgencyInboundMissedReason } | null;
}

/** What a call that reaches nobody does, and how its end is written: the router's. */
export interface InboundCallExits {
  /**
   * End an unconnected call as `end` (an outcome, or an outcome with its voicemail) with its
   * Missed row and callback (`settle`), once: a second end of the same call is a no-op (the
   * spine's terminal guard).
   */
  settleCall(call: AgencyInboundCallRecord, end: AgencyInboundCallOutcome | InboundCallEnd): Promise<void>;
  /**
   * The caller reached nobody (the maximum wait, over `max_waiting`): stop the hold and carry out
   * the route's overflow action (the call-back message, or a voicemail), which ends the call.
   * Resolves with how to settle the call; never throws.
   */
  overflow(call: AgencyInboundCallRecord, route: AgencyInboundRouteRecord): Promise<InboundCallEnd>;
  /** The route's clips for `slots` as hashes, the slots with nothing to play left out. Never throws. */
  clips(route: AgencyInboundRouteRecord, slots: readonly AgencyInboundClipSlot[]): Promise<string[]>;
}

export interface InboundConnectorDeps {
  bridge: Pick<WebRtcBridgeManager,
    'onLifecycle' | 'playInboundHold' | 'stopInboundHold' | 'bindBorrowedBrowserLeg' | 'reattachBorrowedBrowserLeg' | 'forceEndWithOutcome' | 'isCallEnding'>;
  stations: Pick<StationRegistry, 'all' | 'get' | 'socketFor' | 'send' | 'isLocallyOwned' | 'onDetached'>;
  agents: Pick<AgentStateMachine,
    'getMany' | 'get' | 'reserveForInbound' | 'releaseInbound' | 'rehydrateInbound' | 'transition' | 'set' | 'renewLease'>;
  /** Return an agent to the pool: `AgencyDialer.releaseAgent` (a queued break, this connector's hook, else `available`). */
  releaseAgent: (sessionId: string) => Promise<unknown>;
  exits: InboundCallExits;
  /**
   * Of `userIds`, those who may take the account's calls now (an active user with an active
   * membership in the tenant or the account). Read at every search (QA-F10). Default: the
   * repository's `filterAccountMembers`.
   */
  members?: (tenantId: string, accountId: string, userIds: readonly string[]) => Promise<Set<string>>;
  publish?: (event: PacingInvalidationEvent) => void;
  now?: () => number;
  connectDelayMs?: number;
  republishMs?: number;
  /** {@link INBOUND_STATION_REJOIN_GRACE_MS} (tests: shorter). */
  rejoinGraceMs?: number;
  /** IQ50: {@link INBOUND_DEVICE_AWAY_GRACE_MS} (tests: shorter). */
  deviceAwayGraceMs?: number;
  /**
   * IQ50: of `sessionIds`, those on a `device_away` pause younger than `withinMs`, with its age in
   * ms. Default: the repository's `deviceAwayPauseAges` (the session row).
   */
  awayPauses?: (sessionIds: readonly string[], withinMs: number) => Promise<Map<string, number>>;
  /**
   * Mode B: the runtime's away break (`runtime.awayRing`): the return to `away_ring` after an
   * unanswered ring, the end of it (two misses, a revoked device), and the pushes. Without it no
   * phone is ever rung (a media worker, the connector's older suites).
   */
  awayRing?: InboundAwayRing;
  /**
   * Mode B: the account's sessions whose phone may be rung now, as far as the database and the
   * flags tell (`InboundAgentView.ringable`). Default with {@link awayRing}: both flags on, then
   * `findRingableInAccount` (one statement), then the sender configured for the platform.
   */
  ringables?: (tenantId: string, accountId: string) => Promise<AgencyRingableSession[]>;
  /** IQ59: `AGENCY_INBOUND_RING_MS` (tests: shorter). */
  ringMs?: number;
  /** IQ59: `AGENCY_INBOUND_ACCEPT_GRACE_MS` (tests: shorter). */
  acceptGraceMs?: number;
  /** {@link INBOUND_PUSH_RETRY_MS} (tests: shorter). */
  pushRetryMs?: number;
}

/** What the connector reaches of the runtime's away break (`AwayRingService`). */
export type InboundAwayRing = Pick<AwayRingService, 'releaseInbound' | 'end' | 'endAfterRing' | 'send' | 'ringAllowed'>;

/** What the router knows of a call it hands over. */
export interface InboundTakeInput {
  call: AgencyInboundCallRecord;
  route: AgencyInboundRouteRecord;
  /** The caller's sticky candidates, member-filtered, in rank order (the first is the sticky agent). */
  stickyCandidates: ReadonlyArray<{ userId: string; reason: AgencyInboundStickyReason }>;
  /** Play the recording notice in the preamble (the route records, its notice is on, and the account allows recording: IB7). */
  recordingNotice: boolean;
}

type Phase = 'preamble' | 'queued' | 'offered' | 'connected' | 'leaving' | 'done';

interface HeldCall {
  id: string;
  record: AgencyInboundCallRecord;
  route: AgencyInboundRouteRecord;
  accountKey: string;
  phase: Phase;
  sessionId: string | null;
  agentUserId: string | null;
  /** The station socket was bound to the call (the bind succeeded). */
  bound: boolean;
  /** The client kind of the station the current offer went to (`agency_inbound_offers_total{client}`). */
  offeredClient: AgencyClientKind;
  /**
   * When audio bridged, if the spine's `connect` write failed then (a database blip): the pair is
   * talking, so the call is connected in memory and the write is retried at its end, before the
   * `answered` end that needs `bridged_at`. Null otherwise.
   */
  connectOwed: Date | null;
  bindTimer: NodeJS.Timeout | null;
  lease: NodeJS.Timeout | null;
  panel: Promise<InboundPanelContext>;
  stickyCandidates: InboundTakeInput['stickyCandidates'];
  /** The session told "Your customer is waiting" for this caller, until cleared. */
  waitingNotified: string | null;
  /**
   * Where the caller's sticky agent was at the account's last search (null: not searched yet).
   * `inbound_waiting`'s `n` leaves out a `strict` caller with that agent not away: only they may
   * take it ({@link publishWaiting}).
   */
  stickyStatus: StickyAgentStatus | null;
  /** The hold's promise, once started. */
  hold: Promise<InboundHoldResult> | null;
  /**
   * The caller is on their way out (the maximum wait passed while they waited): set SYNCHRONOUSLY
   * by the timer, before its `leave` is queued on the chain, so no search or release hook reserves
   * an agent for them and then waits on the chain behind their overflow message or voicemail
   * (minutes, under the account's lock).
   */
  leaving: boolean;
  /**
   * Sessions this caller is never offered to again (the agent turned the offer down, or the
   * bridge refused to bind their socket to it): the search, the release hook and "could anyone
   * take them" all skip them (`InboundCallerView.declinedSessionIds`).
   */
  declined: Set<string>;
  /** Mode B: how the current offer reached its agent (IQ66): `push` while their phone is rung. */
  channel: 'station' | 'push';
  /** Mode B: the ring of the current push offer (null on a station offer, and once it bound or ended). */
  ring: RingState | null;
  /** Mode B: the offer token of this call's last ring that ended unanswered (a late accept is `ring_expired`). */
  spentRingToken: string | null;
  /** Mode B: the ring that bound (a repeated accept for it is `already_accepted`). */
  boundRingToken: string | null;
  /** Resolves `take`'s promise: the call has left the connector. */
  finish: () => void;
  /** `take`'s promise ({@link InboundConnector.whenLeft}). */
  left: Promise<void>;
}


/** The ring of one push offer (Mode B; see the header). The token is never logged. */
interface RingState {
  token: string;
  sessionId: string;
  /** The device rung (the session's station device), for `ring_cancel`. */
  device: PushDeviceRecord;
  /** Epoch ms the ring started (`ringing_at`). */
  startedAt: number;
  /** Ends the ring unanswered (`expired`); null once answered or fired. */
  ringTimer: NodeJS.Timeout | null;
  /** The agent tapped Answer (`…/ring/answering`, an accept, or an attach): IQ73 cannot take the caller now. */
  answering: boolean;
  answeredAt: number | null;
  /** Ends the offer if it has not bound by the grace's end (`accept_lapsed`). */
  acceptTimer: NodeJS.Timeout | null;
  /** `…/ring/accept` (or an attach with `caps=inbound`) took the call: it binds once a station is attached. */
  accepted: boolean;
  /** The device that accepted (null: an attach accepted it): a repeated accept from it is idempotent. */
  acceptedDevice: string | null;
}

/** A refusal of the ring routes, typed as the contract's inbound codes. */
export type InboundRingRefusal = 'ring_not_offered' | 'ring_expired' | 'already_accepted';

/**
 * Ring results that are a miss (IQ62): the second in a row ends `away_ring`. Only the agent's own
 * (the ring expired, or the answer never bound): a failed push is the carrier's, never a miss.
 */
const MISSES: ReadonlySet<AgencyInboundRingResult> = new Set(['expired', 'accept_lapsed']);
/**
 * Ring results after which this caller never rings that agent again (`InboundCallerView.declinedSessionIds`).
 * Not `push_failed`: an unregistered token revokes the device (never ringable again anyway), and
 * any other failure is the carrier's, retried after {@link INBOUND_PUSH_RETRY_MS}.
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

/** Constant-time comparison of two offer tokens (hashed first, so the lengths match). */
function tokenEquals(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

/** A station that closed within the rejoin grace (see the header): who it was, when, and its agent's state then. */
interface RejoiningStation {
  station: StationDetached;
  closedAt: number;
  /** The agent's Redis state as the close was heard (null: no lease, or the read failed). */
  atClose: Promise<AgentLiveState | null>;
  timer: NodeJS.Timeout;
}

/** The raw queue view the supervisor's tile is built from ({@link InboundConnector.queueSnapshot}). */
export interface InboundQueueSnapshot extends InboundQueueRouteSnapshot {
  /** Calls of the route connected to an agent in this process now. */
  connected: number;
}

export class InboundConnector {
  private readonly calls = new Map<string, HeldCall>();
  /** sessionId → the call offered to or connected with it. */
  private readonly bySession = new Map<string, string>();
  private readonly chains = new Map<string, Promise<void>>();
  private readonly locks = new Map<string, Promise<void>>();
  /** Background releases and searches, so `drain` (tests, shutdown) can wait for them. */
  private readonly background = new Set<Promise<unknown>>();
  /**
   * sessionId → its returns in flight ({@link noteReturn}): reservations the search or the release
   * hook holds for it until their offer or give-back, give-backs, returns to the pool.
   */
  private readonly returning = new Map<string, Promise<void>>();
  /** The in-flight clash's hand-overs (§5.4): calls promised to the agent of the dial they superseded. */
  private readonly handovers: InboundHandovers;
  /** Accounts whose last `inbound_waiting` said someone waits. */
  private readonly holding = new Set<string>();
  private readonly routesWaiting = new Map<string, number>();
  private readonly queue: InboundQueue;
  private readonly now: () => number;
  private readonly connectDelayMs: number;
  private readonly publish: (event: PacingInvalidationEvent) => void;
  private readonly members: NonNullable<InboundConnectorDeps['members']>;
  private unsubscribe: (() => void) | null = null;
  private unsubscribeDetach: (() => void) | null = null;
  /** Stations closed within the rejoin grace, by session (see the header). */
  private readonly rejoining = new Map<string, RejoiningStation>();
  private readonly rejoinGraceMs: number;
  private readonly deviceAwayGraceMs: number;
  private readonly awayPauses: NonNullable<InboundConnectorDeps['awayPauses']>;
  /** IQ50: sessionId → the timer that searches its account again when its `device_away` grace ends. */
  private readonly awayTimers = new Map<string, NodeJS.Timeout>();
  /** Mode B: the ring window and the accept grace (IQ59). */
  private readonly ringMs: number;
  private readonly acceptGraceMs: number;
  /** {@link INBOUND_PUSH_RETRY_MS}, and the epoch ms until which no phone is rung (0: none). */
  private readonly pushRetryMs: number;
  private pushPausedUntil = 0;
  private readonly ringables: NonNullable<InboundConnectorDeps['ringables']>;
  /** {@link stop} ran: no new work; the listener stays for the calls still held. */
  private stopped = false;
  private republishTimer: NodeJS.Timeout | null = null;

  constructor(private readonly deps: InboundConnectorDeps) {
    this.now = deps.now ?? Date.now;
    this.connectDelayMs = deps.connectDelayMs ?? AGENCY_INBOUND_CONNECT_DELAY_MS;
    this.publish = deps.publish ?? publishPacingInvalidation;
    this.rejoinGraceMs = deps.rejoinGraceMs ?? INBOUND_STATION_REJOIN_GRACE_MS;
    this.deviceAwayGraceMs = deps.deviceAwayGraceMs ?? INBOUND_DEVICE_AWAY_GRACE_MS;
    this.awayPauses = deps.awayPauses ?? ((ids, withinMs) => agencyAgentSessionRepository.deviceAwayPauseAges(ids, withinMs));
    this.members = deps.members ?? ((tenantId, accountId, userIds) =>
      agencyInboundAnswerRepository.filterAccountMembers(tenantId, accountId, userIds));
    this.ringMs = deps.ringMs ?? AGENCY_INBOUND_RING_MS;
    this.acceptGraceMs = deps.acceptGraceMs ?? AGENCY_INBOUND_ACCEPT_GRACE_MS;
    this.pushRetryMs = deps.pushRetryMs ?? INBOUND_PUSH_RETRY_MS;
    const awayRing = deps.awayRing;
    this.ringables = deps.ringables ?? (awayRing
      ? async (tenantId, accountId) => {
        if (!(await awayRing.ringAllowed(tenantId, accountId))) return [];
        const rows = await agencyAgentSessionRepository.findRingableInAccount(tenantId, accountId);
        const sender = getPushSender();
        return rows.filter((r) => sender.configured(r.device_platform));
      }
      : async () => []);
    this.queue = new InboundQueue({
      now: this.now,
      onMaxWait: (callId) => this.onTimer(callId, 'max_wait'),
      onStickyLapse: (callId) => this.onTimer(callId, 'sticky_lapse'),
    });
    this.handovers = new InboundHandovers(this.handoverHost());
  }

  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.deps.bridge.onLifecycle((ev) => {
      const held = ev.correlationId ? this.calls.get(ev.correlationId) : undefined;
      if (!held) return; // not an inbound call this connector holds
      void this.serial(held.id, () => this.onLifecycle(held, ev));
    });
    this.unsubscribeDetach = this.deps.stations.onDetached((_sessionId, station) => this.onStationDetached(station));
    // While callers wait: `inbound_waiting` republished, and the account searched again. The
    // search is the backstop for a change no event reports: a busy sticky agent going away
    // (a queued break applied, the station gone) makes their caller the team's at once (IQ6),
    // and it refreshes the sticky agents' status that `n` is counted from. Not while the account's
    // lock is held or waited for: that search (or release) is the one this would queue behind.
    this.republishTimer = setInterval(() => {
      for (const key of [...this.holding]) {
        this.publishWaiting(key);
        if (this.queue.waiting(key).length > 0 && !this.locks.has(key)) this.searchInBackground(key);
      }
    }, this.deps.republishMs ?? INBOUND_WAITING_REPUBLISH_MS);
    this.republishTimer.unref?.();
  }

  /**
   * Stop taking work: no more queueing, searching, offering or release hook, every timer dropped
   * (a bind not yet made never will be). The lifecycle listener stays until the calls still held
   * have ended: the inbound stop (`startInboundCalls`) ends them `service_shutdown` and waits for
   * {@link drain}, which settles a caller nobody took `failed` with its follow-up and callback (IQ18)
   * and leaves an answered one owing its outcome. A process that dies instead leaves them to the
   * next start's sweep.
   */
  stop(): void {
    this.stopped = true;
    if (this.republishTimer) clearInterval(this.republishTimer);
    this.republishTimer = null;
    for (const held of this.calls.values()) this.clearTimers(held);
    this.unsubscribeDetach?.();
    this.unsubscribeDetach = null;
    for (const r of this.rejoining.values()) clearTimeout(r.timer);
    this.rejoining.clear();
    for (const t of this.awayTimers.values()) clearTimeout(t);
    this.awayTimers.clear();
    this.handovers.clearTimers();
    this.queue.clear();
    this.unsubscribeWhenIdle();
  }

  private unsubscribeWhenIdle(): void {
    if (!this.stopped || this.calls.size > 0) return;
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  /** Wait for every call event, search and release started so far (tests, shutdown). */
  async drain(): Promise<void> {
    for (let i = 0; i < 50; i++) {
      const pending = [...this.chains.values(), ...this.locks.values(), ...this.background];
      if (pending.length === 0) return;
      await Promise.allSettled(pending);
    }
  }

  // ─── Reads ────────────────────────────────────────────────────────────────

  /** The calls this connector holds (tests). */
  heldCallIds(): string[] {
    return [...this.calls.keys()];
  }

  /** Whether the connector holds this call (from `take` until it has left). */
  holds(callId: string): boolean {
    return this.calls.has(callId);
  }

  /**
   * Resolves once the call has left the connector (ended and settled, or overflowed and settled);
   * at once for a call it does not hold. Never rejects.
   */
  whenLeft(callId: string): Promise<void> {
    return this.calls.get(callId)?.left ?? Promise.resolve();
  }

  /**
   * An agent's (or a supervisor's) hang-up of a call this connector holds, decided on the call's
   * chain. A call OFFERED whose audio has not bound is the agent turning it down (QA-F3): the
   * offer is cancelled as a lost station's is (back to the head of the queue, `queued_at` kept,
   * never offered to this session again), the agent is returned to the pool, and nothing is
   * recorded as abandoned: `declined`, with the requeued row. Anything else this connector holds
   * (connected, or bound with its `bridged` already on the chain ahead of this step) is the
   * bridge's to end: `end`. `not_held`: not this connector's (any more).
   */
  async hangUp(callId: string): Promise<{ kind: 'declined'; call: AgencyInboundCallRecord } | { kind: 'end' } | { kind: 'not_held' }> {
    const held = this.calls.get(callId);
    if (!held) return { kind: 'not_held' };
    const verdict = await this.serial(callId, async (): Promise<{ kind: 'declined'; call: AgencyInboundCallRecord } | { kind: 'end' } | { kind: 'not_held' }> => {
      if (held.phase === 'done' || !this.calls.has(callId)) return { kind: 'not_held' };
      if (held.phase === 'offered' && !held.bound && held.sessionId) {
        const sessionId = held.sessionId;
        if (held.channel === 'push') {
          // Mode B (N4): after `accept` the agent's hang-up is the way out of a ring not yet bound:
          // `declined`, never a miss; the agent goes back to `away_ring` (or, with a station open
          // here, to the pool as Mode A's).
          const rung = await this.endRing(held, sessionId, 'declined');
          return rung ? { kind: 'declined', call: rung } : { kind: 'not_held' };
        }
        const row = await this.cancelOffer(held, sessionId, 'declined');
        if (!row) return { kind: 'not_held' };
        this.releaseInBackground(sessionId);
        return { kind: 'declined', call: row };
      }
      return { kind: 'end' };
    });
    return verdict ?? { kind: 'not_held' };
  }

  /**
   * The call offered to or connected with this session, with its phase: what `/leave` refuses
   * on (an agent with a call on offer or connected cannot leave the station).
   */
  findCallForSession(sessionId: string): { callId: string; phase: 'offered' | 'connected' } | null {
    const held = this.forSession(sessionId);
    if (!held) return null;
    // A session held for a superseding call through its preamble is as good as offered it.
    if (held.phase === 'preamble' && this.handovers.isHeldFor(held.id, sessionId)) return { callId: held.id, phase: 'offered' };
    if (held.phase !== 'offered' && held.phase !== 'connected') return null;
    return { callId: held.id, phase: held.phase };
  }

  /**
   * Whether the session's station socket is an inbound call's media leg now (bound, until the
   * call ends): the runtime's close handler and silent-station sweep leave presence to the
   * bridge's deferred hangup then, as for a campaign call.
   */
  hasLiveCall(sessionId: string): boolean {
    const held = this.forSession(sessionId);
    return !!held && (held.phase === 'connected' || (held.phase === 'offered' && held.bound));
  }

  /**
   * Whether the session holds a PUSH offer (IQ66: a ring to the away agent's phone, or an answered
   * ring in its accept grace, until it binds). Synchronous, beside {@link hasLiveCall}: the station
   * close decides presence from it with nothing awaited (`AgencyRuntime.releaseStationOnClose`), and
   * the away-ring reconcile and ends leave a session it answers true for to
   * {@link cancelRingForAwayRingEnd} (N1).
   */
  holdsPushOffer(sessionId: string): boolean {
    const held = this.forSession(sessionId);
    return !!held && held.phase === 'offered' && held.channel === 'push' && !held.bound;
  }

  /** The queue as it stands, per route, for the supervisor's tile (docs/inbound.md §6). */
  queueSnapshot(): InboundQueueSnapshot[] {
    const connected = new Map<string, number>();
    for (const held of this.calls.values()) {
      if (held.phase === 'connected') connected.set(held.route.id, (connected.get(held.route.id) ?? 0) + 1);
    }
    const out: InboundQueueSnapshot[] = this.queue.snapshot().map((s) => ({ ...s, connected: connected.get(s.routeId) ?? 0 }));
    for (const [routeId, n] of connected) {
      if (out.some((s) => s.routeId === routeId)) continue;
      const held = [...this.calls.values()].find((h) => h.route.id === routeId)!;
      out.push({ routeId, tenantId: held.route.tenant_id, accountId: held.route.account_id, waiting: 0, offered: 0, longestWaitSeconds: 0, connected: n });
    }
    return out;
  }

  /**
   * Who could take a route's callers, for the supervisor's tile (docs/inbound.md §6), by the rules
   * the search applies (`eligibility.ts`), so the tile never counts an agent the connector would
   * not offer them to (QA-F5):
   *  - `eligible`: with callers waiting on the route, the sessions free now (`available`, holding
   *    nothing) who may take at least one of them, each caller judged by ITS account (IQ21: a caller
   *    matched into another account is that account's agents' alone, and the route's pool applies
   *    only to callers of the route's account); with nobody waiting, those who may take the route's
   *    next caller (one of the route's account);
   *  - `noneCouldTake`: no session could take the route's next caller now or once their current
   *    work ends ({@link anyoneCouldTake}, PM-M6): such a caller is overflowed at once.
   * `viewsOf` memoises the agent views per account: pass one map to every route of one tile read,
   * so each account's views are read once for all of them.
   */
  async routeAgents(
    route: Pick<AgencyInboundRouteRecord, 'id' | 'tenant_id' | 'account_id' | 'pool_campaign_ids'>,
    viewsOf: InboundAgentViewsMemo = new Map(),
  ): Promise<{ eligible: number; noneCouldTake: boolean }> {
    const views = (key: string): Promise<InboundAgentView[]> => {
      let v = viewsOf.get(key);
      if (!v) {
        v = this.agentViews(key);
        viewsOf.set(key, v);
      }
      return v;
    };
    const next = nextCallerView(route.tenant_id, route.account_id, route);
    const waiting = this.queue.waiting().filter((e) => e.routeId === route.id);
    const probes: InboundCallerView[] = waiting.length > 0 ? waiting : [next];
    const free = new Set<string>();
    for (const probe of probes) {
      for (const v of await views(accountKeyOfCall(probe.tenantId, probe.accountId))) {
        if (inboundIneligibility(v, probe) === null) free.add(v.sessionId);
      }
    }
    const own = await views(accountKeyOfCall(route.tenant_id, route.account_id));
    return { eligible: free.size, noneCouldTake: !anyoneCouldTake(next, own) };
  }

  /**
   * Whether anyone could take a caller of `accountId` arriving on `route` now or once their
   * current work ends ({@link anyoneCouldTake}, the rule the queue applies to a waiting caller,
   * with the same presence read: the stations held here and those within the rejoin grace). The
   * router asks it before the greeting (PM-M6, SWE-N4): false, and the caller is answered with the
   * route's overflow action instead of being queued. A failed read rejects.
   */
  async couldAnyoneTake(input: {
    tenantId: string;
    accountId: string;
    route: Pick<AgencyInboundRouteRecord, 'account_id' | 'pool_campaign_ids'>;
  }): Promise<boolean> {
    const caller = nextCallerView(input.tenantId, input.accountId, input.route);
    return anyoneCouldTake(caller, await this.agentViews(accountKeyOfCall(input.tenantId, input.accountId)));
  }

  // ─── The router's hand-over ───────────────────────────────────────────────

  /**
   * Hold a call the router admitted on the `queue` plan (its stream is promised): play the
   * preamble and the hold, then queue it. Resolves once the call has left the connector (ended,
   * or overflowed and settled). Never rejects.
   */
  take(input: InboundTakeInput): Promise<void> {
    const { call, route } = input;
    if (this.calls.has(call.id)) return Promise.resolve();
    let finish!: () => void;
    const done = new Promise<void>((resolve) => { finish = resolve; });
    const held: HeldCall = {
      id: call.id,
      record: call,
      route,
      accountKey: accountKeyOfCall(call.tenant_id, call.account_id!),
      phase: 'preamble',
      sessionId: null,
      agentUserId: null,
      bound: false,
      offeredClient: 'web',
      connectOwed: null,
      bindTimer: null,
      lease: null,
      // Read once, while the preamble plays, so the offer frame is built with no await.
      panel: loadInboundPanelContext(call, { stickyCandidates: input.stickyCandidates }),
      stickyCandidates: input.stickyCandidates,
      waitingNotified: null,
      stickyStatus: null,
      hold: null,
      leaving: false,
      declined: new Set(),
      channel: 'station',
      ring: null,
      spentRingToken: null,
      boundRingToken: null,
      finish,
      left: done,
    };
    this.calls.set(call.id, held);
    void this.serial(call.id, async () => {
      const slots: AgencyInboundClipSlot[] = input.recordingNotice ? ['greeting', 'recording_notice'] : ['greeting'];
      const [preamble, hold] = await Promise.all([this.deps.exits.clips(route, slots), this.deps.exits.clips(route, ['hold'])]);
      if (held.phase !== 'preamble') return; // ended while the clips resolved
      held.hold = this.deps.bridge.playInboundHold(call.id, {
        preambleClipHashes: preamble,
        holdClipHash: hold[0] ?? null,
        onPreambleDone: () => { void this.serial(call.id, () => this.onQueued(held)); },
      });
      void held.hold.then((result) => this.serial(call.id, () => this.onHoldEnded(held, result)));
    });
    return done;
  }

  // ─── The pool's events ────────────────────────────────────────────────────

  /**
   * An agent entered `available` (`AgentStateMachine.onAvailable`): search their account if a
   * caller waits there. Synchronous and total; the search runs in the background.
   */
  onAgentAvailable(sessionId: string): void {
    if (this.stopped) return;
    const station = this.deps.stations.get(sessionId);
    if (!station) return;
    const key = accountKeyOfCall(station.tenantId, station.accountId);
    if (this.queue.waiting(key).length > 0 || this.ringingCallerViews(key).length > 0) this.searchInBackground(key);
  }

  /**
   * THE RELEASE HOOK (`AgencyDialer.releaseAgent`, before it writes `available`, only with no
   * queued break): should this agent, still `reserved`, `on_call` or `wrapup`, be offered a
   * waiting caller instead of going back to the pool? A caller handed over by a cancelled dial
   * first (the clash), then callers sticky to them, then the team's they may take. True: they
   * were reserved for it (CAS from those states) and offered it; `releaseAgent` writes nothing.
   */
  async takeOnRelease(sessionId: string): Promise<boolean> {
    if (this.stopped) return false;
    const station = this.releasableStation(sessionId);
    if (!station) return false;
    const key = accountKeyOfCall(station.tenantId, station.accountId);
    if (!this.handovers.hasPending(sessionId) && this.queue.waiting(key).length === 0 && this.ringingCallerViews(key).length === 0) return false;
    // Counted in the session's returns in flight until the hook has answered (an older build's
    // attach meanwhile reads the agent after it; the `available` its caller writes on a false
    // follows the answer, and is not counted).
    const settle = this.holdReturn(sessionId);
    try {
      return await this.takeOnReleaseLocked(sessionId, station.agentUserId, key);
    } finally {
      settle();
    }
  }

  private takeOnReleaseLocked(sessionId: string, agentUserId: string, key: string): Promise<boolean> {
    return this.withAccountLock(key, async () => {
      if (this.handovers.hasPending(sessionId) && await this.handovers.take(sessionId, agentUserId)) return true;
      // Mode B (IQ73): a caller whose phone ring is not answered yet is this freed agent's too.
      const callers = [...this.ringingCallerViews(key), ...this.callerViews(key)];
      if (callers.length === 0) return false;
      const views = await this.agentViews(key);
      const self = views.find((v) => v.sessionId === sessionId);
      if (!self) return false;
      const callId = callerForReleasedAgent(self, callers, views, this.now());
      if (!callId) return false;
      const held = this.calls.get(callId);
      if (!held || held.leaving) return false;
      const takeOver = this.ringPreemptible(held);
      const reserved = await this.deps.agents.reserveForInbound(sessionId, callId, RELEASE_STATES);
      if (!reserved.ok) return false;
      // Re-checked after the CAS and queued with no await between: a caller marked leaving
      // meanwhile would put this offer behind their whole overflow message (the header).
      if (held.leaving) {
        await this.giveBack(sessionId, callId, 'call_gone');
        return false;
      }
      const offered = await this.serial(callId, () => (takeOver ? this.takeOverRing(held, sessionId) : this.offer(held, sessionId))) ?? 'call_gone';
      if (offered === 'offered') return true;
      await this.giveBack(sessionId, callId, offered);
      return false;
    });
  }

  /**
   * The in-flight clash (docs/inbound.md §5.4): the outbound dial ringing on `sessionId` is about
   * to be cancelled because its customer rang in on `callId`, which this connector holds (in its
   * preamble, or already queued). From now on the call is promised to that session: no other
   * agent is offered it, and when the cancelled dial's end releases the session
   * (`releaseAgent` → {@link takeOnRelease}) the session is taken for it whatever the call's
   * phase, so the hand-over always lands:
   *  - the call already queued: offered to them at once;
   *  - the call still in its preamble: the session is reserved for it there and then (the CAS
   *    from `reserved`, the `inbound` field set: no `available` instant pacing could take), and
   *    offered it the moment the preamble ends ({@link onQueued}).
   * Dropped ({@link dropHandover}) when the dial was not cancelled after all, when the release
   * did not reach the hook (a queued break, the station gone), or after
   * `INBOUND_HANDOVER_TIMEOUT_MS`: the caller then queues normally. {@link InboundHandovers.expect}.
   *
   * False, and nothing promised: the call is not held here waiting (ended, offered, overflowing),
   * or one of the two already has a hand-over.
   */
  expectHandover(sessionId: string, callId: string): boolean {
    return this.handovers.expect(sessionId, callId);
  }

  /**
   * Drop a hand-over not yet taken by the session's release ({@link expectHandover}): the call
   * queues normally and the account is searched. A no-op once the release took it (the session
   * is reserved for the call then) or when none is pending.
   */
  dropHandover(sessionId: string): void {
    this.handovers.drop(sessionId);
  }

  /**
   * What the hand-over module ({@link InboundHandovers}) reaches of this connector: its calls, the
   * calls' chains, the agents' reservations, the offer, the search, and seating a session held for
   * a call through its preamble.
   */
  private handoverHost(): HandoverHost {
    return {
      call: (callId) => this.calls.get(callId),
      offeredNow: (callId) => this.queue.offeredTo(callId) !== null,
      releasable: (sessionId) => this.releasableStation(sessionId) !== null,
      stopped: () => this.stopped,
      serial: (callId, fn) => this.serial(callId, fn),
      reserve: (sessionId, callId) => this.deps.agents.reserveForInbound(sessionId, callId, RELEASE_STATES),
      unreserve: (sessionId, callId) => this.deps.agents.releaseInbound(sessionId, callId),
      offer: async (callId, sessionId) => {
        const held = this.calls.get(callId);
        return held ? this.offer(held, sessionId) : 'call_gone';
      },
      giveBack: (sessionId, callId, why) => this.giveBack(sessionId, callId, why),
      search: (accountKey) => this.searchInBackground(accountKey),
      seat: async (callId, sessionId, agentUserId) => {
        const held = this.calls.get(callId);
        if (!held) return;
        held.sessionId = sessionId;
        held.agentUserId = agentUserId;
        this.bySession.set(sessionId, callId);
        this.deps.stations.send(sessionId, { event: 'agent_state', state: 'reserved', since: new Date(this.now()).toISOString() });
        this.startLease(held, 'reserved');
        await agencyAgentSessionRepository.setState(sessionId, 'reserved')
          .catch((err: unknown) => log.warn({ err, sessionId }, 'Could not mirror an inbound reservation'));
      },
      unseat: (callId, sessionId) => {
        const held = this.calls.get(callId);
        if (held) this.unseat(held, sessionId);
      },
      returnAgent: (sessionId) => this.releaseInBackground(sessionId),
    };
  }

  /** A session held for this call through its preamble is no longer: its lease stopped, the call no longer names it. */
  private unseat(held: HeldCall, sessionId: string): void {
    this.stopLease(held);
    if (this.bySession.get(sessionId) === held.id) this.bySession.delete(sessionId);
    held.sessionId = null;
    held.agentUserId = null;
  }

  /**
   * The session's station socket closed (the runtime's close handler, before it writes
   * `offline`): an offer whose audio has not bound is cancelled and the caller goes back to the
   * head of the queue. A bound call is the bridge's (its deferred hangup). Synchronous: the
   * cancel runs on the call's chain. Whether the account's waiting callers still have anyone who
   * could take them is the rejoin grace's to answer ({@link onStationDetached}).
   */
  onStationClosed(sessionId: string): void {
    const held = this.forSession(sessionId);
    // Mode B: a push offer has no socket to lose until it binds; an accepted ring whose station
    // closed inside the grace waits for a re-attach until the grace ends (`accept_lapsed`).
    if (held && held.phase === 'offered' && !held.bound && held.channel === 'push') return;
    if (held && held.phase === 'offered' && !held.bound) {
      void this.serial(held.id, () => this.cancelOffer(held, sessionId, 'station_lost'));
    } else if (held && this.handovers.isHeldFor(held.id, sessionId)) {
      // Held for a superseding call still in its preamble: let go (the runtime writes `offline`).
      void this.serial(held.id, () => this.handovers.release(held.id, { returnAgent: false }));
    }
  }

  /**
   * A station socket that cannot take inbound calls (an app build that did not declare
   * `caps=inbound`) attached to this session: a reattach from another device or an older build
   * (the prior socket closed 4409). The station socket asks right after the attach, before it
   * reads the agent's state for `ready`, and waits for the answer, bounded by
   * `STATION_INBOUND_LET_GO_WAIT_MS` (3 s). The capability belongs to the socket (IQ46), so what
   * this session held on the prior one is handled as if that station were lost:
   *  - an offer whose audio has not bound: cancelled as a lost station's (`station_lost`: back at
   *    the head of the queue, `queued_at` kept, the next agent searched), and the agent, whose
   *    station is still open, returned to the pool (`releaseAgent`: a queued break applies first);
   *  - held for a superseding call through its preamble (§5.4): let go, the agent returned;
   *  - a bound call: NOT re-adopted onto this socket (the caller's audio never goes to an app that
   *    cannot show the call). The prior socket's close armed the bridge's 8 s deferred hangup, so
   *    the call ends `answered` with its outcome owed (IQ17), as for any station lost after the
   *    bind; the agent then owes it in `wrapup` on this station, which the outcome's lapse (or a
   *    supervisor's close, IQ33) returns. Until then the agent is still `on_call`.
   *
   * What the promise guarantees when it settles: every return of this session to the pool that
   * this connector had in flight when it was called, or started while it ran, has run
   * ({@link noteReturn}): a reservation the search or the release hook held for the session,
   * through its offer or its give-back; a give-back; the bind's cancel of an offer to this station
   * (its timer may fire during the attach) and the agent's return; this method's own cancel and
   * return. So the `ready` read after it never finds the session `reserved` for an inbound call
   * the connector offered it, was offering it or held it for, unless the 3 s bound is hit first
   * (then `ready` says what Redis says, and the `agent_state` frame of the return that is still
   * running follows it). Not covered: the `available` that a caller of the release hook
   * (`releaseAgent`) writes after the hook answered false, which is that caller's, with its own
   * `agent_state` frame. Never rejects. The bind re-checks the capability anyway ({@link bind}),
   * so an offer whose `connects_at` falls before this runs is cancelled the same way.
   */
  async onStationCannotTakeInbound(sessionId: string): Promise<void> {
    try {
      // First what was under way for the session as it attached: a reservation on its way to an
      // offer is then found below as the offer.
      await this.returnsSettled(sessionId);
      await this.letGoForIncapableStation(sessionId);
      // Then every return that started meanwhile, this method's own included.
      await this.returnsSettled(sessionId);
    } catch (err) {
      log.error({ err, sessionId }, 'Could not let go of an inbound call for a station that cannot take one');
    }
  }

  /** {@link onStationCannotTakeInbound}'s steps on what the session holds now. */
  private async letGoForIncapableStation(sessionId: string): Promise<void> {
    const held = this.forSession(sessionId);
    if (!held) return;
    let returnAgent = false;
    if (held.phase === 'offered' && !held.bound && held.channel === 'push') {
      // Mode B: a ring (or an accepted one) for a session an older app build took over: it can
      // never show the call. Ended `cancelled`; the agent, whose station is open here, is returned
      // to the pool by the end itself (Mode A's release), counted in the returns awaited below.
      log.info({ inboundCallId: held.id, sessionId }, 'A station that cannot take inbound calls attached during a ring — ending it');
      await this.serial(held.id, () => this.endRing(held, sessionId, 'cancelled', { offerResult: 'station_lost' }));
    } else if (held.phase === 'offered' && !held.bound) {
      log.info({ inboundCallId: held.id, sessionId }, 'A station that cannot take inbound calls attached during an offer — cancelling it');
      returnAgent = await this.serial(held.id, async () => {
        const row = await this.cancelOffer(held, sessionId, 'station_lost');
        return row !== null;
      }) ?? false;
    } else if (this.handovers.isHeldFor(held.id, sessionId)) {
      returnAgent = await this.serial(held.id, async () => {
        if (!this.handovers.isHeldFor(held.id, sessionId)) return false;
        await this.handovers.release(held.id, { returnAgent: false });
        return true;
      }) ?? false;
    } else if (held.phase === 'connected' || held.bound) {
      log.warn({ inboundCallId: held.id, sessionId },
        'A station that cannot take inbound calls attached during an inbound call — not re-adopted; the deferred hangup ends it');
    }
    // Off the call's chain (the release hook may search the account, which offers on chains),
    // and awaited (with every other return in flight), so the caller's `ready` reads the agent
    // back in the pool.
    if (returnAgent && this.deps.stations.get(sessionId)) await this.releaseInBackground(sessionId);
  }

  /**
   * A station left the registry (its socket closed, or the silent-station sweep detached it): the
   * rejoin grace starts (see the header). The agent's state is read now, synchronously issued, so
   * it is the state before the close handler's `offline` write (one Redis connection, in order);
   * read later it would say `offline` and the agent would not count. When the grace ends the
   * account is searched again: the callers still waiting are judged without this station unless
   * it came back.
   */
  private onStationDetached(station: StationDetached): void {
    if (this.stopped) return;
    const prior = this.rejoining.get(station.sessionId);
    if (prior) clearTimeout(prior.timer);
    const atClose = this.deps.agents.get(station.sessionId).catch(() => null);
    const record: RejoiningStation = {
      station,
      closedAt: this.now(),
      atClose,
      timer: setTimeout(() => {
        if (this.rejoining.get(station.sessionId) === record) this.rejoining.delete(station.sessionId);
        if (this.stopped) return;
        const key = accountKeyOfCall(station.tenantId, station.accountId);
        if (this.queue.waiting(key).length > 0) this.searchInBackground(key);
      }, this.rejoinGraceMs),
    };
    record.timer.unref?.();
    this.rejoining.set(station.sessionId, record);
  }

  /**
   * A station socket (re)attached, after `ready`: re-adopt a bound call's browser leg onto it, and
   * answer what to restore: the session's unsettled inbound call (connected, or owing its outcome)
   * as the `inbound_call` frame, and a `customer_waiting` frame for each caller still waiting for
   * this agent.
   */
  async reattachStation(sessionId: string, ws: WebSocket): Promise<{ call: AgencyInboundCall | null; waiting: AgencyStationCustomerWaitingFrame[] }> {
    const held = this.forSession(sessionId);
    if (held && (held.phase === 'connected' || held.bound)) {
      const resumed = this.deps.bridge.reattachBorrowedBrowserLeg(held.id, ws);
      log.info({ sessionId, inboundCallId: held.id, resumed }, 'Station reconnected during an inbound call');
    }
    if (held && held.phase === 'offered' && held.channel === 'push' && !held.bound) {
      // Mode B: the app's station attached during a ring (N5). Accepted already: the frame below,
      // then the bind (`bindAcceptedRing`, after the station has sent it). Not yet answered (the
      // agent opened the app by its icon): an implicit answer and accept, so it binds the same way,
      // and the phone is told to stop ringing. The state stays `reserved` either way.
      await this.serial(held.id, () => this.acceptOnAttach(held, sessionId));
    }
    const unsettled = await agencyInboundCallRepository.findUnsettledForSession(sessionId).catch((err: unknown) => {
      log.warn({ err, sessionId }, 'Could not read the session\'s inbound call on reconnect');
      return null;
    });
    let call: AgencyInboundCall | null = null;
    if (unsettled && unsettled.state !== 'queued') {
      const ctx = this.calls.get(unsettled.id)?.panel ?? loadInboundPanelContext(unsettled);
      call = inboundCallToWire(unsettled, await ctx, this.deps.stations.get(sessionId)?.agentUserId ?? null, this.connectDelayMs);
    }
    const waiting: AgencyStationCustomerWaitingFrame[] = [];
    for (const h of this.calls.values()) {
      if (h.waitingNotified === sessionId) waiting.push(await this.waitingFrame(h));
    }
    return { call, waiting };
  }

  /**
   * Mode B: the station socket that attached during an accepted ring has been sent the
   * `inbound_call` frame (after `ready`, {@link reattachStation}): bind the call to it now, on the
   * call's chain. A no-op unless the session holds an accepted push offer not yet bound.
   */
  bindAcceptedRing(sessionId: string): void {
    const held = this.forSession(sessionId);
    if (!held || held.phase !== 'offered' || held.channel !== 'push' || held.bound || !held.ring?.accepted) return;
    void this.serial(held.id, () => this.bind(held));
  }

  // ─── Internals: phases ────────────────────────────────────────────────────

  /** The preamble is over: the caller queues (see the header, step 1). On the call's chain. */
  private async onQueued(held: HeldCall): Promise<void> {
    if (held.phase !== 'preamble' || this.stopped) return;
    const row = await agencyInboundCallRepository.transition(held.id, 'queued', { at: new Date(this.now()) });
    if (!row) return; // ended meanwhile: its `ended` follows on this chain
    held.record = row;
    held.phase = 'queued';
    const queuedAt = (row.queued_at ?? new Date(this.now())).getTime();
    const route = held.route;
    const admitted = this.queue.admit({
      ...this.callerView(held),
      queuedAt,
      routeId: route.id,
      maxWaitAt: queuedAt + route.queue_max_wait_seconds * 1000,
    }, route.max_waiting);
    this.noteRouteWaiting(route.id);
    this.publishWaiting(held.accountKey);
    const heldFor = this.handovers.takeHeld(held.id);
    if (heldFor !== null) {
      // The superseded dial's agent, held for this call through the preamble (§5.4): offered now.
      // Counted in the session's returns in flight until offered or given back.
      const sessionId = heldFor;
      const settle = this.holdReturn(sessionId);
      this.unseat(held, sessionId);
      const offered = await this.offer(held, sessionId).catch((err: unknown) => {
        settle();
        throw err;
      });
      if (offered === 'offered') {
        settle();
        return;
      }
      // The session owes another call, its station can no longer take one, or the call went: the
      // reservation is given back, the agent returned, and the caller (if still here) searched
      // for like any other.
      settle(this.trackBackground(this.giveBack(sessionId, held.id, offered, { release: true })));
    } else if (this.handovers.of(held.id)) {
      // Promised to the superseded dial's agent, whose release is on its way: kept for them.
      return;
    }
    if (admitted === 'over_cap') {
      // Over `max_waiting`: only an agent free right now keeps this caller.
      void this.trackBackground(this.search(held.accountKey).then(() => this.exitWhenQueued(held, 'over_cap')));
      return;
    }
    this.searchInBackground(held.accountKey);
  }

  /** The hold ended: only a hold that could not even start matters here (the end arrives as `ended`). */
  private async onHoldEnded(held: HeldCall, result: InboundHoldResult): Promise<void> {
    if (result !== 'not_found') return;
    // No live media session by this id: no `ended` will ever come for it.
    if (held.phase === 'preamble' || held.phase === 'queued') {
      log.warn({ inboundCallId: held.id }, 'Inbound hold found no media session — ending the call failed');
      this.queue.remove(held.id);
      await this.handovers.release(held.id, { returnAgent: true });
      await this.deps.exits.settleCall(held.record, 'failed');
      this.finishCall(held, 'failed');
    }
  }

  private onTimer(callId: string, which: 'max_wait' | 'sticky_lapse'): void {
    const held = this.calls.get(callId);
    if (!held) return;
    if (which === 'sticky_lapse') {
      // The team may take them now: counted in `n` again, and searched for.
      this.publishWaiting(held.accountKey);
      this.searchInBackground(held.accountKey);
      return;
    }
    // An offer in flight runs to its bind or its cancel (the cancel overflows a lapsed caller).
    void this.exitWhenQueued(held, 'max_wait');
  }

  /**
   * Queue `held`'s exit ({@link leave}) on its chain. A caller still waiting (queued, no offer in
   * flight) is marked leaving NOW, before the chain gets to it, as every exit is (the header): from
   * this instant no search or release hook reserves an agent for them (M4: none waits behind their
   * message). The exit itself runs only for a caller still queued then.
   */
  private exitWhenQueued(held: HeldCall, why: InboundOverflowReason): Promise<void> {
    if (held.phase === 'queued' && this.queue.offeredTo(held.id) === null) held.leaving = true;
    return this.serial(held.id, () => this.leave(held, why));
  }

  /**
   * The caller reached nobody: out of the queue, the route's overflow action (the router's), then
   * the call settled with what it returned. On the call's chain.
   */
  private async leave(held: HeldCall, why: InboundOverflowReason): Promise<void> {
    if (held.phase !== 'queued') return;
    held.phase = 'leaving';
    held.leaving = true;
    this.queue.remove(held.id);
    this.noteRouteWaiting(held.route.id);
    this.clearWaitingNotice(held);
    this.publishWaiting(held.accountKey);
    await this.handovers.release(held.id, { returnAgent: true });
    log.info({ inboundCallId: held.id, why }, 'Inbound caller reached nobody — overflow');
    trackInboundOverflow(why);
    const end = await this.deps.exits.overflow(held.record, held.route);
    await this.deps.exits.settleCall(held.record, end);
    this.finishCall(held, waitResultOf(end.outcome));
  }

  /**
   * Offer the call to `sessionId`, already reserved for it in Redis (see the header, step 3). On
   * the call's chain. `offered`, else why not (the caller gives the reservation back).
   */
  private async offer(held: HeldCall, sessionId: string): Promise<'offered' | InboundOfferRefused> {
    if (this.stopped || held.phase !== 'queued' || this.queue.offeredTo(held.id) !== null) return 'call_gone';
    // The panel first (read once while the preamble played: settled long since), so the spine's
    // write below is the one await between the checks and the frames.
    const ctx = await held.panel;
    if (this.stopped || held.phase !== 'queued' || this.queue.offeredTo(held.id) !== null) return 'call_gone';
    // Promised to the superseded dial's agent meanwhile (§5.4): not this session's to take.
    const handover = this.handovers.of(held.id);
    if (handover && handover.sessionId !== sessionId) return 'call_gone';
    // Its maximum wait passed while this offer waited on the chain: it overflows instead.
    if (held.leaving) return 'call_gone';
    // The session's station can no longer take inbound calls (an older app build took it over
    // since the search: IQ46): never offered, so it is never told `reserved` for a call it
    // cannot see. Not a busy session (nothing is owed): the agent is returned, the next
    // candidate tried.
    if (this.deps.stations.get(sessionId)?.canTakeInbound === false) return 'station_incapable';
    const at = new Date(this.now());
    const res = await agencyInboundCallRepository.offer(held.id, sessionId, { at });
    const station = this.deps.stations.get(sessionId);
    const client = station?.clientKind ?? 'web';
    if (!res.ok) {
      trackInboundOffer('refused', client);
      return res.reason === 'session_busy' ? 'session_busy' : 'call_gone';
    }
    if (station?.canTakeInbound === false) return this.unwriteOffer(held, sessionId, client);
    // ── From here to the frames, no await (IB1) ─────────────────────────────
    held.record = res.call;
    held.phase = 'offered';
    held.sessionId = sessionId;
    held.agentUserId = station?.agentUserId ?? null;
    held.offeredClient = client;
    held.bound = false;
    held.channel = 'station';
    this.bySession.set(sessionId, held.id);
    this.queue.markOffered(held.id, sessionId);
    this.deps.stations.send(sessionId, { event: 'agent_state', state: 'reserved', since: at.toISOString() });
    this.deps.stations.send(sessionId, { event: 'inbound_call', call: inboundCallToWire(res.call, ctx, held.agentUserId, this.connectDelayMs) });
    this.startLease(held, 'reserved');
    held.bindTimer = setTimeout(() => {
      held.bindTimer = null;
      void this.serial(held.id, () => this.bind(held));
    }, this.connectDelayMs);
    held.bindTimer.unref?.();
    // ── The rest is bookkeeping ────────────────────────────────────────────
    this.clearWaitingNotice(held);
    this.noteRouteWaiting(held.route.id);
    this.publishWaiting(held.accountKey);
    await agencyAgentSessionRepository.setState(sessionId, 'reserved')
      .catch((err: unknown) => log.warn({ err, sessionId }, 'Could not mirror an inbound reservation'));
    log.info({ inboundCallId: held.id, sessionId }, 'Inbound call offered');
    return 'offered';
  }

  /**
   * {@link offer}'s spine write landed for a session a station that cannot take inbound calls took
   * over during it (IQ46): the spine goes back to `queued` before any frame is sent
   * ({@link onStationCannotTakeInbound} found nothing held for the session yet), counted `refused`
   * (the spine counted an offer nobody saw). `station_incapable`: the caller gives the reservation
   * back and the search tries its next candidate. A requeue that moved nothing (the call is no
   * longer on offer to the session: it ended, and its `ended` is next on this chain) or that threw
   * is `call_gone`: the search leaves this caller. After a throw the spine still reads `offered` to
   * the session while the caller waits in memory, so every later offer of them is refused by the
   * spine (`not_offerable`) and they leave at their maximum wait, whose settle ends the row.
   */
  private async unwriteOffer(held: HeldCall, sessionId: string, client: AgencyClientKind): Promise<'station_incapable' | 'call_gone'> {
    trackInboundOffer('refused', client);
    const requeued = await agencyInboundCallRepository.requeue(held.id, sessionId, { at: new Date(this.now()) })
      .catch((err: unknown) => {
        log.warn({ err, inboundCallId: held.id, sessionId },
          'Could not requeue an inbound offer written for a station that cannot take inbound calls — the spine reads offered until the caller leaves');
        return undefined;
      });
    if (requeued === undefined) return 'call_gone';
    if (requeued === null) {
      log.warn({ inboundCallId: held.id, sessionId },
        'An inbound offer written for a station that cannot take inbound calls was no longer on offer to it — not requeued');
      return 'call_gone';
    }
    held.record = requeued;
    log.info({ inboundCallId: held.id, sessionId }, 'A station that cannot take inbound calls took the session during the offer — not offered');
    return 'station_incapable';
  }

  /** The bind, at `connects_at` (see the header, step 4). On the call's chain. */
  private async bind(held: HeldCall): Promise<void> {
    if (held.phase !== 'offered' || held.bound || !held.sessionId) return;
    const push = held.channel === 'push';
    // Mode B: a ring binds only once accepted (the accept, or an attach that accepted it).
    if (push && !held.ring?.accepted) return;
    const sessionId = held.sessionId;
    const station = this.deps.stations.get(sessionId);
    const ws = station?.ws;
    if (!station || !ws || ws.readyState !== 1 /* OPEN */) {
      // Mode B: an accepted ring waits for its station (a re-attach) until the grace ends.
      if (push) return;
      await this.cancelOffer(held, sessionId, 'station_lost');
      return;
    }
    if (!station.canTakeInbound && push) {
      // An older app build took the session over since the accept (IQ46): it can never show the
      // call. Its end returns the agent (Mode A's release: the station is open), counted in the
      // session's returns in flight.
      await this.endRing(held, sessionId, 'cancelled', { offerResult: 'station_lost' });
      return;
    }
    if (!station.canTakeInbound) {
      // The session's station was replaced, during the offer, by one that cannot take inbound calls
      // (an older app build: IQ46). Never bound: cancelled as a lost station's, and the agent, whose
      // station is still open, returned to the pool ({@link onStationCannotTakeInbound}).
      // Counted in the session's returns in flight from this check to the agent's return, so the
      // attach of that station, which may be running now, reads the agent after both.
      log.warn({ inboundCallId: held.id, sessionId }, 'Inbound bind found a station that cannot take inbound calls — the offer is cancelled');
      const settle = this.holdReturn(sessionId);
      let returned: Promise<void> | undefined;
      try {
        const row = await this.cancelOffer(held, sessionId, 'station_lost');
        if (row) returned = this.releaseInBackground(sessionId);
      } finally {
        settle(returned);
      }
      return;
    }
    if (!this.deps.bridge.bindBorrowedBrowserLeg(held.id, ws)) {
      if (this.deps.bridge.isCallEnding(held.id)) {
        // The caller is gone: its `ended` is on this chain next and settles the offer.
        log.info({ inboundCallId: held.id, sessionId }, 'Inbound bind refused: the call is ending');
        return;
      }
      // Refused for another reason (the socket closed between the check above and the bridge's,
      // a leg already bound): the offer is cancelled, the caller goes back to the head of the queue
      // and is never offered to this session again, and an agent whose station is still OPEN goes
      // back to the pool (a closed one is the close handler's: `offline`). SWE-m4.
      const stillOpen = ws.readyState === 1;
      log.warn({ inboundCallId: held.id, sessionId, stillOpen }, 'Inbound bind refused by the bridge — the offer is cancelled');
      if (push) {
        // Its end returns the agent itself: to the pool with the station still open (Mode A's), else
        // to `away_ring`. Never offered this caller again.
        held.declined.add(sessionId);
        await this.endRing(held, sessionId, 'cancelled', { offerResult: stillOpen ? 'bind_refused' : 'station_lost' });
        return;
      }
      const row = await this.cancelOffer(held, sessionId, stillOpen ? 'bind_refused' : 'station_lost');
      if (row && stillOpen) this.releaseInBackground(sessionId);
      return;
    }
    held.bound = true;
    if (push) this.onRingBound(held, sessionId);
  }

  /**
   * Mode B: an accepted ring bound (audio flows from here, as any bind): the ring is over,
   * `answered`, the agent's missed rings reset (IQ62) and the absence over (`away_ring_since`
   * cleared). Synchronous; the writes follow.
   */
  private onRingBound(held: HeldCall, sessionId: string): void {
    const ring = held.ring;
    if (!ring) return;
    if (ring.ringTimer) clearTimeout(ring.ringTimer);
    if (ring.acceptTimer) clearTimeout(ring.acceptTimer);
    held.ring = null;
    held.boundRingToken = ring.token;
    trackInboundRing('answered');
    void agencyInboundCallRepository.setRingResult(held.id, 'answered')
      .catch((err: unknown) => log.warn({ err, inboundCallId: held.id }, 'Could not write an answered ring'));
    void agencyAgentSessionRepository.ringAnswered(sessionId)
      .catch((err: unknown) => log.warn({ err, sessionId }, 'Could not reset the missed rings and the absence'));
    log.info({ inboundCallId: held.id, sessionId }, 'Inbound ring answered and bound');
  }

  private async onLifecycle(held: HeldCall, ev: WebRtcLifecycleEvent): Promise<void> {
    if (ev.phase === 'bridged') await this.onBridged(held);
    else if (ev.phase === 'ended') await this.onEnded(held, ev);
  }

  /** Audio both ways (step 4). */
  private async onBridged(held: HeldCall): Promise<void> {
    if (held.phase !== 'offered' || !held.sessionId) return;
    const sessionId = held.sessionId;
    const at = new Date(this.now());
    const row = await this.writeConnected(held, sessionId, at).catch((err: unknown) => {
      log.error({ err, inboundCallId: held.id, sessionId }, 'Could not write an inbound call connected — the pair is talking; retried at its end');
      return undefined;
    });
    // Not on offer to this session any more (it ended): nothing to connect.
    if (row === null) return;
    if (row) {
      held.record = row;
    } else {
      // Audio flows both ways whatever the row says: connected in memory, so its end is an
      // answered call owing its outcome, never a caller who "hung up on offer" (m7).
      held.connectOwed = at;
      held.record = { ...held.record, state: 'connected', bridged_at: at, answered_by_user_id: held.agentUserId };
    }
    held.phase = 'connected';
    this.stopLease(held);
    trackInboundOffer('connected', held.offeredClient, held.channel);
    trackInboundWait('connected', (at.getTime() - (held.record.queued_at ?? held.record.arrived_at).getTime()) / 1000);
    this.queue.remove(held.id);
    if (!await this.deps.agents.transition(sessionId, 'reserved', 'on_call', { leaseMs: AGENT_LEASE_MS.on_call })) {
      log.warn({ inboundCallId: held.id, sessionId }, 'Inbound call bridged with the agent no longer reserved for it');
    }
    this.startLease(held, 'on_call');
    this.deps.stations.send(sessionId, { event: 'agent_state', state: 'on_call', since: at.toISOString() });
    await this.sendFrame(held);
    await agencyAgentSessionRepository.setState(sessionId, 'on_call')
      .catch((err: unknown) => log.warn({ err, sessionId }, 'Could not mirror an inbound call\'s agent state'));
    log.info({ inboundCallId: held.id, sessionId }, 'Inbound call connected');
  }

  /** The bridge ended the call (step 5). */
  private async onEnded(held: HeldCall, ev: WebRtcLifecycleEvent): Promise<void> {
    const phase = held.phase;
    if (phase === 'done' || phase === 'leaving') return; // the overflow path ends and settles it
    this.clearTimers(held);
    this.queue.remove(held.id);
    this.noteRouteWaiting(held.route.id);
    this.clearWaitingNotice(held);
    if (phase === 'connected') {
      await this.endConnected(held, ev);
      return;
    }
    const outcome = unconnectedOutcome(ev.outcome);
    // A session held for this call through its preamble (the clash's hand-over) goes back.
    await this.handovers.release(held.id, { returnAgent: true });
    await this.deps.exits.settleCall(held.record, outcome);
    if (phase === 'offered' && held.sessionId && held.channel === 'push' && !held.bound) {
      // Mode B: the caller left while the phone rang (or in the accept grace): `caller_left`, the
      // phone told to stop, the agent back on `away_ring` (or to the pool with a station open here).
      const sessionId = held.sessionId;
      const ring = held.ring;
      held.ring = null;
      held.spentRingToken = ring?.token ?? held.spentRingToken;
      trackInboundOffer('caller_left', held.offeredClient, 'push');
      trackInboundRing('caller_left');
      await agencyInboundCallRepository.setRingResult(held.id, 'caller_left')
        .catch((err: unknown) => log.warn({ err, inboundCallId: held.id }, 'Could not write a ring the caller left'));
      if (ring) this.sendRingCancel(ring, held.id, 'caller_left');
      const ended = await agencyInboundCallRepository.findByIdAnyTenant(held.id).catch(() => null);
      if (ended) held.record = ended;
      await this.sendFrame(held);
      // From here the session holds no push offer: the release may end its absence.
      this.bySession.delete(sessionId);
      held.sessionId = null;
      await this.releaseRungAgent(held.id, sessionId);
    } else if (phase === 'offered' && held.sessionId) {
      const sessionId = held.sessionId;
      trackInboundOffer('caller_left', held.offeredClient, held.channel);
      await this.deps.agents.releaseInbound(sessionId, held.id);
      const ended = await agencyInboundCallRepository.findByIdAnyTenant(held.id).catch(() => null);
      if (ended) held.record = ended;
      await this.sendFrame(held);
      this.bySession.delete(sessionId);
      this.releaseInBackground(sessionId);
    }
    this.finishCall(held, waitResultOf(outcome));
    this.publishWaiting(held.accountKey);
  }

  private async endConnected(held: HeldCall, ev: WebRtcLifecycleEvent): Promise<void> {
    const sessionId = held.sessionId!;
    const talkSeconds = typeof ev.talkTimeSeconds === 'number' ? Math.max(0, Math.round(ev.talkTimeSeconds)) : null;
    if (held.connectOwed) {
      // The bridge's `connect` write failed: `answered` needs `bridged_at`, so it goes first.
      const row = await this.writeConnected(held, sessionId, held.connectOwed).catch((err: unknown) => {
        log.error({ err, inboundCallId: held.id, sessionId }, 'Could not write an inbound call connected at its end');
        return null;
      });
      if (row) {
        held.record = row;
        held.connectOwed = null;
      }
    }
    // The agent's side below runs whatever this write does: a row it could not end is the stale
    // sweep's (bridged: `answered`, owing its outcome).
    const res = await agencyInboundCallRepository.end(held.id, {
      outcome: 'answered', talkSeconds, followUp: null, callbackDueAt: null, voicemailKey: null,
    }).catch((err: unknown) => {
      log.error({ err, inboundCallId: held.id, sessionId }, 'Could not end an answered inbound call — the stale sweep ends it');
      return { call: null, ended: false };
    });
    if (res.call) held.record = res.call;
    if (res.ended) trackInboundCallEnded('answered');
    // An outcome is owed (IQ11): `wrapup`, the `inbound` field kept, no auto-return. An agent whose
    // station is gone is `offline` (they come back to `break` with the call re-claimed).
    const since = new Date(this.now()).toISOString();
    if (this.deps.stations.isLocallyOwned(sessionId)) {
      await this.deps.agents.set(sessionId, 'wrapup', { leaseMs: AGENT_LEASE_MS.wrapup });
      await agencyAgentSessionRepository.setState(sessionId, 'wrapup')
        .catch((err: unknown) => log.warn({ err, sessionId }, 'Could not mirror an inbound wrap-up'));
      this.deps.stations.send(sessionId, { event: 'agent_state', state: 'wrapup', since });
    } else {
      await this.deps.agents.set(sessionId, 'offline', { leaseMs: AGENT_LEASE_MS.available });
      await agencyAgentSessionRepository.setState(sessionId, 'offline')
        .catch((err: unknown) => log.warn({ err, sessionId }, 'Could not mirror an inbound call\'s departed agent'));
    }
    await this.sendFrame(held);
    this.bySession.delete(sessionId);
    this.dropCall(held);
    log.info({ inboundCallId: held.id, sessionId, talkSeconds }, 'Inbound call ended — its outcome is owed');
  }

  /**
   * Cancel an offer whose audio has not bound (see the header). On the call's chain. `why` names
   * the offer's end for the metric. A caller whose maximum wait passed during the offer is marked
   * leaving here and overflowed by the NEXT step of their chain, after the step that cancelled has
   * returned its agent (SWE-F3).
   */
  private async cancelOffer(
    held: HeldCall,
    sessionId: string,
    why: Extract<InboundOfferResult, 'station_lost' | 'lease_lost' | 'declined' | 'bind_refused'>,
  ): Promise<AgencyInboundCallRecord | null> {
    if (held.phase !== 'offered' || held.sessionId !== sessionId || held.bound) return null;
    // Mode B: a push offer ends through its own path (the agent back to `away_ring`).
    if (held.channel === 'push') return this.endRing(held, sessionId, why === 'declined' ? 'declined' : 'cancelled', { offerResult: why });
    this.clearTimers(held);
    // Turned down, or unbindable: this session is never offered the caller again.
    if (why === 'declined' || why === 'bind_refused') held.declined.add(sessionId);
    const row = await agencyInboundCallRepository.requeue(held.id, sessionId, { at: new Date(this.now()) });
    await this.deps.agents.releaseInbound(sessionId, held.id);
    this.bySession.delete(sessionId);
    held.sessionId = null;
    held.agentUserId = null;
    if (!row) {
      // Not on offer to this session any more: it ended (its `ended` is next on this chain).
      held.phase = 'queued';
      return null;
    }
    trackInboundOffer(why, held.offeredClient);
    held.record = row;
    held.phase = 'queued';
    // The session's last frame of this call says it is no longer theirs (if the socket is still there).
    const ctx = await held.panel;
    this.deps.stations.send(sessionId, { event: 'inbound_call', call: { ...inboundCallToWire(row, ctx, null, this.connectDelayMs), session_id: sessionId } });
    // Marked before it is waiting again, so no search takes a caller about to overflow (M4).
    if (this.queue.maxWaitLapsed(held.id)) held.leaving = true;
    this.queue.requeueHead(held.id);
    this.noteRouteWaiting(held.route.id);
    log.info({ inboundCallId: held.id, sessionId, why }, 'Inbound offer cancelled before audio bound — the caller is back at the head of the queue');
    if (this.queue.maxWaitLapsed(held.id)) {
      // Queued on the call's chain, not run here (SWE-F3): the step that cancelled (an agent's
      // decline, a refused bind) returns its agent and answers first; the exit (the overflow
      // message, a voicemail: seconds to minutes) runs after it, as the maximum-wait timer's does.
      void this.serial(held.id, () => this.leave(held, 'max_wait'));
      return row;
    }
    this.publishWaiting(held.accountKey);
    this.searchInBackground(held.accountKey);
    return row;
  }

  // ─── Mode B: ringing an away phone (see the header) ──────────────────────────

  /**
   * The ring routes' tenancy for a call this connector holds: where the public layer sends the
   * token-only routes (`callCore` needs the tenant). Null for a call not held here (the routes
   * answer the uniform 404). Says nothing about the token.
   */
  ringTenancy(callId: string): { tenantId: string; accountId: string } | null {
    const held = this.calls.get(callId);
    if (!held) return null;
    return { tenantId: held.record.tenant_id, accountId: held.record.account_id! };
  }

  /**
   * `…/ring/answering` (IQ71, token only): the agent tapped Answer. On the call's chain, with the
   * ring re-checked there (N3: a station agent's take-over queued first wins, and this answers the
   * uniform `ring_not_offered`): the ring timer stops, `accepted_at` is stamped and the accept
   * grace starts. Idempotent while the grace runs; `already_accepted` once accepted.
   */
  async ringAnswering(callId: string, token: string): Promise<
    { ok: true; callId: string; acceptBy: Date } | { ok: false; code: 'ring_not_offered' | 'already_accepted' }
  > {
    const notOffered = { ok: false as const, code: 'ring_not_offered' as const };
    if (!this.ringFor(callId, token)) return notOffered;
    const held = this.calls.get(callId)!;
    return await this.serial(callId, async () => {
      const ring = this.ringFor(callId, token);
      if (!ring) return notOffered;
      if (ring.accepted) return { ok: false as const, code: 'already_accepted' as const };
      if (!ring.answering) {
        // The ring timer fired (its expiry is queued behind this step): too late.
        if (!ring.ringTimer) return notOffered;
        await this.markAnswering(held, ring);
      }
      return { ok: true as const, callId, acceptBy: new Date(ring.answeredAt! + this.acceptGraceMs) };
    }) ?? notOffered;
  }

  /**
   * `…/ring/decline` (IQ71, token only; valid until accept, N4): the phone declined the ring
   * (`declined`, or `busy_on_phone` when a cellular call is on, IQ70). Never a miss; the caller goes
   * back to the head of the queue and never rings this agent again.
   */
  async ringDecline(callId: string, token: string, reason: 'declined' | 'busy_on_phone'): Promise<
    { ok: true; callId: string; sessionId: string; agentUserId: string | null; tenantId: string; accountId: string } | { ok: false; code: 'ring_not_offered' | 'already_accepted' }
  > {
    const notOffered = { ok: false as const, code: 'ring_not_offered' as const };
    if (!this.ringFor(callId, token)) return notOffered;
    const held = this.calls.get(callId)!;
    return await this.serial(callId, async () => {
      const ring = this.ringFor(callId, token);
      if (!ring) return notOffered;
      if (ring.accepted) return { ok: false as const, code: 'already_accepted' as const };
      const agentUserId = held.agentUserId;
      await this.endRing(held, ring.sessionId, reason);
      return {
        ok: true as const, callId, sessionId: ring.sessionId, agentUserId,
        tenantId: held.record.tenant_id, accountId: held.record.account_id!,
      };
    }) ?? notOffered;
  }

  /**
   * Who a ring is for, by its token (the accept route checks the agent and claims the station for
   * the device before {@link ringAccept}): the session and its agent. `ring_expired` for this
   * call's last ring that ended unanswered, `already_accepted` for the ring that bound,
   * `ring_not_offered` for anything else.
   */
  ringPeek(callId: string, token: string): { ok: true; sessionId: string; agentUserId: string | null } | { ok: false; code: InboundRingRefusal } {
    const held = this.calls.get(callId);
    if (!held) return { ok: false, code: 'ring_not_offered' };
    const ring = this.ringFor(callId, token);
    if (ring) return { ok: true, sessionId: ring.sessionId, agentUserId: held.agentUserId };
    if (held.boundRingToken && tokenEquals(held.boundRingToken, token)) return { ok: false, code: 'already_accepted' };
    if (held.spentRingToken && tokenEquals(held.spentRingToken, token)) return { ok: false, code: 'ring_expired' };
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
  async ringAccept(callId: string, token: string, by: { agentUserId: string; deviceId: string }): Promise<
    { ok: true; call: AgencyInboundCall; sessionId: string } | { ok: false; code: InboundRingRefusal }
  > {
    const peeked = this.ringPeek(callId, token);
    if (!peeked.ok) return peeked;
    const held = this.calls.get(callId)!;
    const out = await this.serial(callId, async (): Promise<{ ok: true; sessionId: string; bindNow: boolean } | { ok: false; code: InboundRingRefusal }> => {
      const ring = this.ringFor(callId, token);
      if (!ring) {
        const again = this.ringPeek(callId, token);
        return again.ok ? { ok: false, code: 'ring_not_offered' } : again;
      }
      if (held.agentUserId !== by.agentUserId) return { ok: false, code: 'ring_not_offered' };
      if (ring.accepted) {
        if (ring.acceptedDevice !== null && ring.acceptedDevice !== by.deviceId) return { ok: false, code: 'already_accepted' };
        return { ok: true, sessionId: ring.sessionId, bindNow: false };
      }
      if (!ring.answering) {
        if (!ring.ringTimer) return { ok: false, code: 'ring_expired' };
        await this.markAnswering(held, ring);
      }
      ring.accepted = true;
      ring.acceptedDevice = by.deviceId;
      log.info({ inboundCallId: held.id, sessionId: ring.sessionId }, 'Inbound ring accepted');
      const station = this.deps.stations.get(ring.sessionId);
      return { ok: true, sessionId: ring.sessionId, bindNow: !!station && station.canTakeInbound && station.ws.readyState === 1 };
    }) ?? { ok: false, code: 'ring_not_offered' };
    if (!out.ok) return out;
    const ctx = await held.panel;
    const call = inboundCallToWire(held.record, ctx, held.agentUserId, this.connectDelayMs);
    if (out.bindNow) {
      // A station is already here (the race with an attach): it gets the panel, then the bind.
      this.deps.stations.send(out.sessionId, { event: 'inbound_call', call });
      void this.serial(callId, () => this.bind(held));
    }
    return { ok: true, call, sessionId: out.sessionId };
  }

  /**
   * End the session's ring because its `away_ring` is ending (N1): the reconcile (the flag off, the
   * maximum age, the device revoked or opted out), "Stop ringing", the device removed, or the
   * take-over (OS3, `taken_over`). On the call's chain: a ring not yet answered is cancelled
   * (`answered_elsewhere` for a take-over, else `cancelled`), the agent goes back to `away_ring` and
   * the absence is then ended with `reason` (`AwayRingService.end`); the caller goes back to the
   * head of the queue. An answered ring is left to run (its end returns the agent, and the next
   * reconcile finds the absence to end), except on a take-over: the device that answered no longer
   * holds the station. `none`: no push offer for the session.
   */
  async cancelRingForAwayRingEnd(
    sessionId: string,
    reason: AgencyRingOffReason,
    opts: { absenceSince?: Date | null } = {},
  ): Promise<'cancelled' | 'answered' | 'none'> {
    const held = this.forSession(sessionId);
    if (!held || !this.holdsPushOffer(sessionId)) return 'none';
    return await this.serial(held.id, async (): Promise<'cancelled' | 'answered' | 'none'> => {
      if (held.sessionId !== sessionId || !this.holdsPushOffer(sessionId) || !held.ring) return 'none';
      const takenOver = reason === 'taken_over';
      if (held.ring.answering && !takenOver) return 'answered';
      await this.endRing(held, sessionId, takenOver && !held.ring.answering ? 'answered_elsewhere' : 'cancelled', {
        // The take-over's claim already ended the absence in the mirror, and its caller sends the
        // old device `ring_off`: the agent is left on a plain break for the new device's attach,
        // `since` kept at the absence's start (`opts.absenceSince`, the claim's).
        awayRingEnd: takenOver ? null : reason,
        ...(opts.absenceSince !== undefined ? { absenceSince: opts.absenceSince } : {}),
      });
      return 'cancelled';
    }) ?? 'none';
  }

  /** The current ring of `callId` if `token` is its offer token (constant time); null otherwise. */
  private ringFor(callId: string, token: string): RingState | null {
    const held = this.calls.get(callId);
    const ring = held?.ring;
    if (!held || !ring || held.phase !== 'offered' || held.channel !== 'push' || held.bound || held.sessionId !== ring.sessionId) return null;
    return tokenEquals(ring.token, token) ? ring : null;
  }

  /** A ring IQ73 may still take the caller from: on offer by push, not yet answered. */
  private ringPreemptible(held: HeldCall): boolean {
    return held.phase === 'offered' && held.channel === 'push' && !held.bound && !!held.ring && !held.ring.answering && !held.ring.accepted;
  }

  /** The account's callers whose ring IQ73 may take over, as the search sees callers (oldest first). */
  private ringingCallerViews(accountKey: string): InboundCallerView[] {
    const out: InboundCallerView[] = [];
    for (const held of this.calls.values()) {
      if (held.accountKey !== accountKey || held.leaving || !this.ringPreemptible(held)) continue;
      const entry = this.queue.entry(held.id);
      if (entry) out.push(entry);
    }
    return out.sort((a, b) => a.queuedAt - b.queuedAt);
  }

  /**
   * Ring `sessionId`'s phone for the caller (see the header): the session is already reserved for
   * the call from `away_ring` (the search's CAS). On the call's chain. `offered`, else why not (the
   * search gives the reservation back: {@link giveBackRing}).
   */
  private async ringOffer(held: HeldCall, sessionId: string): Promise<'offered' | 'call_gone' | 'session_busy' | 'not_ringable'> {
    const awayRing = this.deps.awayRing;
    const stillQueued = () => !this.stopped && held.phase === 'queued' && this.queue.offeredTo(held.id) === null && !held.leaving
      && (!this.handovers.of(held.id));
    if (!awayRing || !stillQueued()) return 'call_gone';
    // IQ69: a ring starts only with a whole ring window of the caller's wait left.
    const entry = this.queue.entry(held.id);
    if (entry && !ringWindowLeft(entry, this.now(), this.ringMs)) return 'call_gone';
    const device = await agencyPushDeviceRepository.findForSession(sessionId).catch((err: unknown) => {
      log.warn({ err, sessionId }, 'Could not read the session\'s push device to ring it');
      return null;
    });
    if (!device || !pushDeviceRingable(device) || !getPushSender().configured(device.platform)) return 'not_ringable';
    if (!stillQueued()) return 'call_gone';
    const at = new Date(this.now());
    const res = await agencyInboundCallRepository.offer(held.id, sessionId, { at, channel: 'push' });
    if (!res.ok) {
      trackInboundOffer('refused', 'mobile', 'push');
      return res.reason === 'session_busy' ? 'session_busy' : 'call_gone';
    }
    // ── From here to the timers, no await ───────────────────────────────────
    held.record = res.call;
    held.phase = 'offered';
    held.sessionId = sessionId;
    held.agentUserId = device.user_id;
    held.offeredClient = 'mobile';
    held.bound = false;
    held.channel = 'push';
    const ring: RingState = {
      token: randomBytes(16).toString('base64url'),
      sessionId,
      device,
      startedAt: at.getTime(),
      ringTimer: null,
      answering: false,
      answeredAt: null,
      acceptTimer: null,
      accepted: false,
      acceptedDevice: null,
    };
    held.ring = ring;
    this.bySession.set(sessionId, held.id);
    this.queue.markOffered(held.id, sessionId);
    // No socket heartbeats this lease: the connector renews it while the offer stands.
    this.startLease(held, 'reserved');
    ring.ringTimer = setTimeout(() => {
      ring.ringTimer = null;
      void this.serial(held.id, async () => {
        if (held.ring !== ring || ring.answering) return;
        await this.endRing(held, sessionId, 'expired');
      });
    }, this.ringMs);
    ring.ringTimer.unref?.();
    // ── The rest is bookkeeping, then the push (outside the account's lock) ─────
    this.clearWaitingNotice(held);
    this.noteRouteWaiting(held.route.id);
    this.publishWaiting(held.accountKey);
    await agencyAgentSessionRepository.setState(sessionId, 'reserved')
      .catch((err: unknown) => log.warn({ err, sessionId }, 'Could not mirror an inbound ring\'s reservation'));
    log.info({ inboundCallId: held.id, sessionId }, 'Inbound call ringing an away phone');
    void this.trackBackground(this.sendRing(held, ring));
    return 'offered';
  }

  /**
   * The `ring` push (IQ61: ids, the token and the deadline only). A failure ends the ring
   * `push_failed`, never a miss (IQ62 counts only the agent's own): an unregistered token revokes
   * the device and ends the absence (`revoked`); any other failure is the push service's trouble,
   * so the agent may be rung for this caller again, no new search is run, and no phone is rung
   * for {@link pushRetryMs} (the republish after it retries): an outage never walks one caller
   * through the whole pool.
   */
  private async sendRing(held: HeldCall, ring: RingState): Promise<void> {
    const awayRing = this.deps.awayRing!;
    const result = await awayRing.send(ring.device, {
      type: 'ring',
      call_id: held.id,
      offer_token: ring.token,
      ring_expires_at: new Date(ring.startedAt + this.ringMs).toISOString(),
      session_id: ring.sessionId,
    }, this.ringMs).catch((err: unknown) => {
      log.warn({ err, inboundCallId: held.id }, 'The ring push threw');
      return { ok: false as const, reason: 'unavailable' as const };
    });
    if (result.ok) return;
    await this.serial(held.id, async () => {
      if (held.ring !== ring || ring.answering) return;
      log.info({ inboundCallId: held.id, sessionId: ring.sessionId, reason: result.reason }, 'The ring push failed — the ring ends');
      if (result.reason === 'unregistered') {
        // An unregistered token revoked the device (`AwayRingService.send`): the absence ends `revoked`.
        await this.endRing(held, ring.sessionId, 'push_failed', { awayRingEnd: 'revoked', neverAgain: true });
        return;
      }
      // The push service's trouble: ringing paused before the caller goes back to the queue, so
      // nothing rings the next phone meanwhile.
      this.pushPausedUntil = Math.max(this.pushPausedUntil, this.now() + this.pushRetryMs);
      await this.endRing(held, ring.sessionId, 'push_failed', { search: false });
    });
  }

  /** The ring was answered (on the call's chain): the ring timer stopped, `accepted_at`, the grace. */
  private async markAnswering(held: HeldCall, ring: RingState): Promise<void> {
    if (ring.ringTimer) clearTimeout(ring.ringTimer);
    ring.ringTimer = null;
    ring.answering = true;
    ring.answeredAt = this.now();
    trackInboundRingAnswer((ring.answeredAt - ring.startedAt) / 1000);
    ring.acceptTimer = setTimeout(() => {
      ring.acceptTimer = null;
      void this.serial(held.id, async () => {
        if (held.ring !== ring || held.bound) return;
        await this.endRing(held, ring.sessionId, 'accept_lapsed');
      });
    }, this.acceptGraceMs);
    ring.acceptTimer.unref?.();
    const at = new Date(ring.answeredAt);
    const row = await agencyInboundCallRepository.markRingAnswered(held.id, ring.sessionId, at).catch((err: unknown) => {
      log.warn({ err, inboundCallId: held.id }, 'Could not stamp an answered ring');
      return null;
    });
    held.record = row ?? { ...held.record, accepted_at: held.record.accepted_at ?? at };
  }

  /** N5: a station with `caps=inbound` attached during a ring (on the call's chain): accepted, and the phone told to stop. */
  private async acceptOnAttach(held: HeldCall, sessionId: string): Promise<void> {
    const ring = held.ring;
    if (!ring || held.sessionId !== sessionId || held.phase !== 'offered' || held.channel !== 'push' || held.bound || ring.accepted) return;
    if (!ring.answering) {
      if (!ring.ringTimer) return; // expired: its end is next on this chain
      await this.markAnswering(held, ring);
      log.info({ inboundCallId: held.id, sessionId }, 'The app opened during a ring — answered there');
    }
    ring.accepted = true;
    // The native ring stops (the agent is in the app now).
    this.sendRingCancel(ring, held.id, 'answered');
  }

  /**
   * IQ73 (N3), on the call's chain: `stationSessionId`, a station agent who freed up, is already
   * reserved for this caller (the search's or the release hook's CAS, under the account's lock).
   * If the ring was answered meanwhile it stands, and the station agent is given back
   * (`call_gone`); else the ring ends `answered_elsewhere` with no new search, and the station
   * agent is offered the caller.
   */
  private async takeOverRing(held: HeldCall, stationSessionId: string): Promise<'offered' | InboundOfferRefused> {
    // The ring ended between the search's decision and this step (it expired, was declined, or an
    // earlier candidate's take-over ended it): the caller, back in the queue, is offered as any
    // queued caller (`offer` refuses one that is not: an answered ring stands).
    if (!this.ringPreemptible(held) || !held.sessionId) return this.offer(held, stationSessionId);
    const row = await this.endRing(held, held.sessionId, 'answered_elsewhere', { search: false });
    if (!row) return 'call_gone';
    log.info({ inboundCallId: held.id, sessionId: stationSessionId }, 'A station agent freed up mid-ring — they take the caller (IQ73)');
    return this.offer(held, stationSessionId);
  }

  /**
   * End a push offer that has not bound (see the header, "Every other end"), on the call's chain.
   * The caller goes back to the head of the queue (and the account is searched again unless
   * `search` is false: IQ73's take-over offers the caller itself). The agent goes back to
   * `away_ring` ({@link releaseRungAgent}); with `awayRingEnd` the absence then ends with that
   * reason (null: ended by its caller already). Null when the call is not on a push offer to the
   * session, or when it ended meanwhile (its `ended` follows on this chain; the agent is released
   * either way).
   */
  private async endRing(
    held: HeldCall,
    sessionId: string,
    result: AgencyInboundRingResult,
    opts: {
      search?: boolean;
      awayRingEnd?: AgencyRingOffReason | null;
      /** With `awayRingEnd: null`: the start of the absence its cause ended, kept as `since`. */
      absenceSince?: Date | null;
      offerResult?: InboundOfferResult;
      neverAgain?: boolean;
    } = {},
  ): Promise<AgencyInboundCallRecord | null> {
    if (held.phase !== 'offered' || held.sessionId !== sessionId || held.channel !== 'push' || held.bound) return null;
    const ring = held.ring;
    this.clearTimers(held);
    held.ring = null;
    if (ring) held.spentRingToken = ring.token;
    if (NEVER_AGAIN.has(result) || opts.neverAgain) held.declined.add(sessionId);
    // A requeue that throws is handled as `unwriteOffer`'s: the agent is still released and the
    // caller requeued in memory (below), never left on a push offer with no timer. The spine then
    // still reads `offered` to the session, so every later offer of the caller is refused there
    // (`not_offerable`) and they leave at their maximum wait, whose settle ends the row.
    const requeued = await agencyInboundCallRepository.requeue(held.id, sessionId, { at: new Date(this.now()), ringResult: result })
      .catch((err: unknown) => {
        log.warn({ err, inboundCallId: held.id, sessionId, result },
          'Could not requeue an ended ring — the caller waits in memory and the spine reads offered until they leave');
        return undefined;
      });
    const requeueFailed = requeued === undefined;
    const row = requeued ?? null;
    // From here the session holds no push offer: the release below may end its absence.
    this.bySession.delete(sessionId);
    held.sessionId = null;
    held.agentUserId = null;
    held.channel = 'station';
    trackInboundRing(result);
    if (ring && result !== 'push_failed') this.sendRingCancel(ring, held.id, result);
    const released = await this.releaseRungAgent(held.id, sessionId, opts.awayRingEnd, opts.absenceSince ?? null);
    if (released === 'away_ring' && opts.awayRingEnd === undefined) await this.noteMiss(sessionId, MISSES.has(result));
    if (!row && !requeueFailed) {
      held.phase = 'queued';
      return null;
    }
    trackInboundOffer(opts.offerResult ?? offerResultOfRing(result), 'mobile', 'push');
    if (row) held.record = row;
    held.phase = 'queued';
    log.info({ inboundCallId: held.id, sessionId, result }, 'Inbound ring ended — the caller is back at the head of the queue');
    // A station attached for an accepted ring: its last frame of this call says it is not theirs.
    if (row && this.deps.stations.get(sessionId)) {
      const ctx = await held.panel;
      this.deps.stations.send(sessionId, { event: 'inbound_call', call: { ...inboundCallToWire(row, ctx, null, this.connectDelayMs), session_id: sessionId } });
    }
    if (this.queue.maxWaitLapsed(held.id)) held.leaving = true;
    this.queue.requeueHead(held.id);
    this.noteRouteWaiting(held.route.id);
    if (this.queue.maxWaitLapsed(held.id)) {
      void this.serial(held.id, () => this.leave(held, 'max_wait'));
      return row;
    }
    this.publishWaiting(held.accountKey);
    if (opts.search !== false) this.searchInBackground(held.accountKey);
    return row;
  }

  /**
   * Return a rung agent after their push offer ended unbound (IQ67). With an OPEN station here (an
   * accepted ring whose station attached), Mode A's: the field cleared and `releaseAgent`
   * (`station`). Otherwise back to `away_ring` (`AwayRingService.releaseInbound`); with
   * `endReason` the absence then ends with it (`ended`; null: its cause already ended it in the
   * mirror, so the agent is left on `device_away` with `since` kept at `absenceSince`,
   * `AwayRingService.endAfterRing`). A session no longer on an absence goes back as Mode A's
   * (`returned`). Never throws.
   */
  private async releaseRungAgent(
    callId: string,
    sessionId: string,
    endReason?: AgencyRingOffReason | null,
    absenceSince: Date | null = null,
  ): Promise<'station' | 'away_ring' | 'ended' | 'returned' | 'not_held'> {
    try {
      const station = this.deps.stations.get(sessionId);
      const awayRing = this.deps.awayRing;
      if ((station && station.ws.readyState === 1) || !awayRing) {
        await this.deps.agents.releaseInbound(sessionId, callId);
        void this.releaseInBackground(sessionId);
        return station ? 'station' : 'returned';
      }
      const out = await awayRing.releaseInbound(sessionId, callId);
      if (out === 'away_ring') {
        if (endReason === undefined) return 'away_ring';
        await awayRing.end(sessionId, endReason);
        return 'ended';
      }
      if (out === 'not_away_ring') {
        if (endReason !== undefined) {
          // The absence was ended by what ended this ring (the take-over's claim): `device_away`,
          // which the new station's attach shows, `since` kept at the absence's start.
          await awayRing.endAfterRing(sessionId, callId, absenceSince);
          return 'ended';
        }
        await this.deps.agents.releaseInbound(sessionId, callId);
        void this.releaseInBackground(sessionId);
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
   * ring's end ends it (`findRingableInAccount` rings no such agent again after that). Never throws.
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

  /** `ring_cancel` to the rung phone (Android only; fire and forget). */
  private sendRingCancel(ring: RingState, callId: string, result: AgencyInboundRingResult): void {
    const awayRing = this.deps.awayRing;
    if (!awayRing || ring.device.platform !== 'android') return;
    void awayRing.send(ring.device, { type: 'ring_cancel', call_id: callId, session_id: ring.sessionId, reason: result }, this.ringMs)
      .catch((err: unknown) => log.warn({ err, inboundCallId: callId }, 'Could not send ring_cancel'));
  }

  /**
   * Undo a ring's reservation the ring never used (the call went, it was refused, the device
   * cannot be rung): back to `away_ring`, or Mode A's return for a session no longer on an absence.
   * Counted in the session's returns in flight.
   */
  private giveBackRing(sessionId: string, callId: string, why?: 'session_busy' | 'call_gone' | 'not_ringable'): Promise<void> {
    // A session the spine says holds another unsettled inbound call (a stale row a restart left)
    // is never rung again: its absence ends (`device_away`), as Mode A puts such a session on a
    // break, so no search reserves it again every republish.
    const endReason = why === 'session_busy' ? null : undefined;
    if (why === 'session_busy') log.warn({ sessionId, callId }, 'Session reserved for a ring while it holds another inbound call — its away break ends');
    return this.noteReturn(sessionId, this.releaseRungAgent(callId, sessionId, endReason).then(() => undefined));
  }

  // ─── Internals: the search ────────────────────────────────────────────────

  private searchInBackground(accountKey: string): void {
    void this.trackBackground(this.search(accountKey));
  }

  /** One search of the account's waiting callers (see the header, step 2). */
  private async search(accountKey: string): Promise<void> {
    if (this.stopped) return;
    const giveBacks: Array<{ settle: (after?: Promise<unknown>) => void; run: () => Promise<void> }> = [];
    // The reservations still held are given back below whatever the locked part did (a failed
    // read rejects the search, which the next republish retries).
    const locked = this.withAccountLock(accountKey, async () => {
      const callers = this.callerViews(accountKey);
      // Mode B (IQ73): callers whose phone ring has not been answered yet are searched for too,
      // for a station agent who became available since the ring started.
      const ringing = this.ringingCallerViews(accountKey);
      if (callers.length === 0 && ringing.length === 0) return;
      const views = await this.agentViews(accountKey);
      this.overflowWhomNobodyCanTake(callers, views);
      this.notifyBusyStickyAgents(callers, views);
      if (this.noteStickyStatus(callers, views)) this.publishWaiting(accountKey);
      const taken = new Set<string>();
      /** Callers rung by this search: never taken over by it (a station agent it saw then was not "freed mid-ring"). */
      const rung = new Set<string>();
      const viewOf = new Map(views.map((v) => [v.sessionId, v]));
      for (const step of searchOrder([...ringing, ...callers], views, this.now(), this.ringMs)) {
        const held = this.calls.get(step.callId);
        if (!held || this.handovers.of(held.id) || held.leaving) continue;
        // IQ73: the ring's start, read once here. Whether the caller is still on a ring that may be
        // taken over is asked again per candidate: an earlier candidate's take-over may have ended
        // the ring and then been refused, or the ring may have ended during an await; once the
        // ring is gone the caller is searched for as any queued caller.
        const ringStartedAt = !rung.has(held.id) && this.ringPreemptible(held) ? held.ring!.startedAt : null;
        if (ringStartedAt === null && (held.phase !== 'queued' || this.queue.offeredTo(step.callId) !== null)) continue;
        for (const candidate of step.candidates) {
          const sessionId = candidate.sessionId;
          if (taken.has(sessionId)) continue;
          const takeOver = ringStartedAt !== null && this.ringPreemptible(held);
          if (takeOver) {
            // IQ73: only a station agent, and only one who became available after the ring began.
            const since = viewOf.get(sessionId)?.live?.since ?? null;
            if (candidate.channel !== 'station' || since === null || since < ringStartedAt) continue;
          } else if (held.phase !== 'queued' || this.queue.offeredTo(step.callId) !== null) {
            break;
          }
          const push = candidate.channel === 'push';
          // A ring push failed for the push service's own reasons a moment ago: no phone is rung
          // until the pause ends (the republish after it retries), so an outage never walks a
          // caller through the pool.
          if (push && this.now() < this.pushPausedUntil) continue;
          // Counted in the session's returns in flight from before the CAS to the offer or the
          // give-back's end: an older build attaching meanwhile reads the agent after it.
          const settle = this.holdReturn(sessionId);
          // A ring takes the agent from `away_ring` (`break` with `ring = 1`; the script refuses any
          // other break), a station offer from `available`.
          const reserved = await this.deps.agents.reserveForInbound(sessionId, step.callId, push ? ['break'] : ['available']);
          if (!reserved.ok) {
            settle();
            continue;
          }
          taken.add(sessionId);
          // Re-checked after the CAS, and the offer queued with no await between (M4): a caller
          // marked leaving (or promised elsewhere) meanwhile is not waited for under the lock;
          // its chain may be playing a message or recording a voicemail for minutes.
          if (held.leaving || this.handovers.of(held.id)) {
            giveBacks.push({
              settle,
              run: () => (push ? this.giveBackRing(sessionId, step.callId) : this.giveBack(sessionId, step.callId, 'call_gone', { release: true })),
            });
            break;
          }
          if (push) {
            // One phone per caller at a time (IQ60): the search moves on to the next caller.
            const ringResult = await this.serial(step.callId, () => this.ringOffer(held, sessionId)) ?? 'call_gone';
            if (ringResult === 'offered') {
              rung.add(held.id);
              settle();
              break;
            }
            giveBacks.push({ settle, run: () => this.giveBackRing(sessionId, step.callId, ringResult) });
            if (ringResult === 'call_gone') break;
            continue;
          }
          // A take-over decided before the CAS whose ring has ended since is an ordinary offer
          // (`takeOverRing` falls back to it; `offer` refuses a caller no longer queued).
          const offered = await this.serial(step.callId, () => (takeOver ? this.takeOverRing(held, sessionId) : this.offer(held, sessionId))) ?? 'call_gone';
          if (offered === 'offered') {
            settle();
            break;
          }
          // Given back after the lock: `releaseAgent` runs the release hook, which takes it. A
          // station that cannot take inbound calls (`station_incapable`) or a busy session: the
          // next candidate is tried; a caller gone: the search leaves them.
          giveBacks.push({ settle, run: () => this.giveBack(sessionId, step.callId, offered, { release: true }) });
          if (offered === 'call_gone') break;
        }
      }
    });
    await locked.finally(async () => {
      for (const { settle, run } of giveBacks) {
        const done = run();
        settle(done);
        await done.catch((err: unknown) => log.error({ err, accountKey }, 'Could not give back an inbound reservation'));
      }
    });
  }

  /**
   * PM-M6: a waiting caller nobody in their pool could take, now or once their current work ends
   * ({@link anyoneCouldTake}: everyone on a break, offline, on a station that cannot take inbound
   * calls (an app build without `caps=inbound`, IQ46), outside the pool or gone from the account),
   * is overflowed at once instead of being held to the maximum wait. Asked
   * at every search: when the caller queues, and while they wait at every presence change the
   * connector hears of (a station closing, an agent available) and at the 2 s republish (a break,
   * which no event reports). Marked leaving synchronously (the header), so this search and every
   * later one skip them; the exit runs on the call's chain, never under the lock.
   */
  private overflowWhomNobodyCanTake(callers: readonly InboundCallerView[], views: readonly InboundAgentView[]): void {
    for (const caller of callers) {
      if (anyoneCouldTake(caller, views)) continue;
      const held = this.calls.get(caller.callId);
      if (!held || held.phase !== 'queued' || held.leaving || this.handovers.of(held.id) || this.queue.offeredTo(held.id) !== null) continue;
      log.info({ inboundCallId: held.id }, 'Nobody in the pool could take this inbound caller — overflowing now');
      void this.exitWhenQueued(held, 'no_agents');
    }
  }

  /**
   * Undo a reservation whose offer was refused: the `inbound` field cleared, and (from the
   * search, where the agent was `available`) the agent returned. A session the spine says holds
   * another unsettled inbound call (`session_busy`: its Redis field was lost) never goes to the
   * pool (SWE-M1): it is put on `break`, re-claimed for that call when its outcome is owed; the
   * same when the spine cannot be read (fails closed). The settle that follows never lifts that
   * break (`InboundCallService.returnAgent`): the agent's own "Go available" does. Every other
   * refusal (`call_gone`, `station_incapable`: an older app build took the session over, which owes
   * nothing for it) reads no spine: the field cleared and the agent returned. Counted in the
   * session's returns in flight ({@link noteReturn}), which an older build's attach waits for.
   */
  private giveBack(sessionId: string, callId: string, why: InboundOfferRefused, opts: { release?: boolean } = {}): Promise<void> {
    return this.noteReturn(sessionId, this.giveBackNow(sessionId, callId, why, opts));
  }

  private async giveBackNow(sessionId: string, callId: string, why: InboundOfferRefused, opts: { release?: boolean }): Promise<void> {
    await this.deps.agents.releaseInbound(sessionId, callId);
    if (why === 'session_busy') {
      const owed = await agencyInboundCallRepository.findUnsettledForSession(sessionId).catch(() => undefined);
      if (owed !== null) {
        log.warn({ sessionId, owedInboundCallId: owed?.id ?? null }, 'Session reserved for an inbound call while it holds another — on break, never the pool');
        await this.deps.agents.set(sessionId, 'break', { leaseMs: AGENT_LEASE_MS.break });
        if (owed && owed.state === 'ended' && owed.bridged_at !== null) await this.deps.agents.rehydrateInbound(sessionId, owed.id);
        await agencyAgentSessionRepository.setState(sessionId, 'break').catch(() => undefined);
        this.deps.stations.send(sessionId, { event: 'agent_state', state: 'break', since: new Date(this.now()).toISOString() });
        return;
      }
    }
    if (opts.release) await this.deps.releaseAgent(sessionId);
  }

  /**
   * The account's waiting callers as the search sees them, in service order. A caller promised
   * to the agent of the dial it superseded (a hand-over, §5.4) is theirs alone until it is taken
   * or dropped.
   */
  private callerViews(accountKey: string): InboundCallerView[] {
    return this.queue.waiting(accountKey).filter((c) => {
      const held = this.calls.get(c.callId);
      return !this.handovers.of(c.callId) && !held?.leaving;
    });
  }

  private callerView(held: HeldCall): Omit<InboundCallerView, 'queuedAt'> {
    const r = held.record;
    const route = held.route;
    return {
      callId: held.id,
      tenantId: r.tenant_id,
      accountId: r.account_id!,
      routeAccountId: route.account_id,
      poolCampaignIds: route.pool_campaign_ids,
      stickyMode: route.sticky_mode,
      stickyUserId: r.sticky_user_id,
      stickyWaitMs: route.sticky_wait_seconds * 1000,
      declinedSessionIds: held.declined,
    };
  }

  /**
   * The account's sessions on this process with their Redis state (one pipelined read) and
   * whether each agent may still take the account's calls (one indexed read: an agent removed
   * from the account or deactivated while their station stays open is never offered a call,
   * QA-F10). A failed read rejects: the search is retried at the next republish.
   */
  private async agentViews(accountKey: string): Promise<InboundAgentView[]> {
    const [tenantId, accountId] = accountKey.split(':') as [string, string];
    // Mode B: the sessions whose phone may be rung (no station here: the app parked it). Read
    // FIRST, so the registry read below and the Redis read stay one synchronous run (the rejoin
    // grace's rule). A failed read counts nobody as ringable.
    const ringRows = await this.ringables(tenantId, accountId).catch((err: unknown) => {
      log.warn({ err, accountKey }, 'inbound: could not read the ringable sessions; nobody is rung this search');
      return [] as AgencyRingableSession[];
    });
    const stations = this.deps.stations.all().filter((s) => accountKeyOfCall(s.tenantId, s.accountId) === accountKey);
    // Stations closed within the rejoin grace (SWE-F1), not back yet: counted, never offered.
    const now = this.now();
    const rejoining = [...this.rejoining.values()].filter((r) => accountKeyOfCall(r.station.tenantId, r.station.accountId) === accountKey
      && now - r.closedAt < this.rejoinGraceMs && !this.deps.stations.get(r.station.sessionId));
    const known = new Set([...stations.map((s) => s.sessionId), ...rejoining.map((r) => r.station.sessionId)]);
    const ringOnly = ringRows.filter((r) => !known.has(r.id));
    if (stations.length === 0 && rejoining.length === 0 && ringOnly.length === 0) return [];
    const ringable = new Set(ringRows.map((r) => r.id));
    const [states, members, atClose] = await Promise.all([
      this.deps.agents.getMany([
        ...stations.map((s) => s.sessionId), ...rejoining.map((r) => r.station.sessionId), ...ringOnly.map((r) => r.id),
      ]),
      this.members(tenantId, accountId, [...new Set([
        ...[...stations, ...rejoining.map((r) => r.station)].map((s) => s.agentUserId), ...ringOnly.map((r) => r.agent_user_id),
      ])]),
      Promise.all(rejoining.map((r) => r.atClose)),
    ]);
    const viewOf = (s: StationDetached, stationOpen: boolean, rejoins: boolean, live: InboundAgentView['live']): InboundAgentView => ({
      sessionId: s.sessionId,
      agentUserId: s.agentUserId,
      tenantId: s.tenantId,
      accountId: s.accountId,
      campaignId: s.campaignId,
      canTakeInbound: s.canTakeInbound,
      stationOpen,
      ...(rejoins ? { rejoining: true } : {}),
      ...(ringable.has(s.sessionId) ? { ringable: true } : {}),
      member: members.has(s.agentUserId),
      live,
    });
    const open = stations.map((s, i) => viewOf(s, s.ws.readyState === 1,
      // Closed (and detached: its grace began) while this read was in flight. Its state was read
      // in the same synchronous run as the registry, so before the close: the grace's rule.
      s.ws.readyState !== 1 && this.rejoining.has(s.sessionId) && !this.deps.stations.get(s.sessionId),
      states[i] ?? null));
    const back = rejoining.map((r, i) => viewOf(r.station, false, true,
      rejoinState(states[stations.length + i] ?? null, atClose[i] ?? null)));
    // Mode B: an agent on `away_ring` has no station here at all: never offered on a station, rung.
    const away = ringOnly.map((r, i): InboundAgentView => ({
      sessionId: r.id,
      agentUserId: r.agent_user_id,
      tenantId,
      accountId,
      campaignId: r.campaign_id,
      canTakeInbound: false,
      stationOpen: false,
      ringable: true,
      member: members.has(r.agent_user_id),
      live: states[stations.length + rejoining.length + i] ?? null,
    }));
    // Open stations first: a user's open session is the one `stickyAgentOf` finds.
    const views = [...open, ...back, ...away];
    await this.markAwayGrace(accountKey, views, now);
    return views;
  }

  /**
   * IQ50 (see the header): mark the views on a `device_away` pause younger than the grace
   * (`awayGrace`), and arm a search of the account for when each one's grace ends. Only the
   * sessions Redis says are on a break that began inside the grace are read (the session row);
   * a failed read marks none.
   */
  private async markAwayGrace(accountKey: string, views: InboundAgentView[], now: number): Promise<void> {
    const fresh = views.filter((v) => v.live?.state === 'break' && v.campaignId !== null && !v.live.ring
      && (v.live.since === null || now - v.live.since < this.deviceAwayGraceMs));
    if (fresh.length === 0) return;
    const ages = await Promise.resolve()
      .then(() => this.awayPauses(fresh.map((v) => v.sessionId), this.deviceAwayGraceMs))
      .catch((err: unknown) => {
        log.warn({ err, accountKey }, 'inbound: could not read the device_away pauses; none counted as able to take callers');
        return new Map<string, number>();
      });
    for (const v of fresh) {
      const age = ages.get(v.sessionId);
      if (age === undefined || age >= this.deviceAwayGraceMs) continue;
      v.awayGrace = true;
      this.armAwayGraceEnd(accountKey, v.sessionId, this.deviceAwayGraceMs - age);
    }
  }

  /** Search the account again when a `device_away` pause's grace ends (once per session at a time). */
  private armAwayGraceEnd(accountKey: string, sessionId: string, inMs: number): void {
    if (this.stopped || this.awayTimers.has(sessionId)) return;
    const timer = setTimeout(() => {
      this.awayTimers.delete(sessionId);
      if (this.stopped) return;
      if (this.queue.waiting(accountKey).length > 0) this.searchInBackground(accountKey);
    }, Math.max(0, Math.ceil(inMs)) + 50);
    timer.unref?.();
    this.awayTimers.set(sessionId, timer);
  }

  /** "Your customer is waiting" to each busy sticky agent not yet told (§4.3). */
  private notifyBusyStickyAgents(callers: readonly InboundCallerView[], views: readonly InboundAgentView[]): void {
    for (const caller of callers) {
      if (caller.stickyMode === 'off') continue;
      const held = this.calls.get(caller.callId);
      if (!held || held.waitingNotified !== null) continue;
      const sticky = stickyAgentOf(caller, views);
      if (!sticky || stickyAgentStatus(sticky, caller) !== 'busy') continue;
      held.waitingNotified = sticky.sessionId;
      void this.waitingFrame(held).then((frame) => this.deps.stations.send(sticky.sessionId, frame));
    }
  }

  /** Each caller's sticky agent's status as this search saw it ({@link HeldCall.stickyStatus}). True: one changed. */
  private noteStickyStatus(callers: readonly InboundCallerView[], views: readonly InboundAgentView[]): boolean {
    let changed = false;
    for (const caller of callers) {
      const held = this.calls.get(caller.callId);
      if (!held) continue;
      const status = caller.stickyMode === 'off' ? null : stickyAgentStatus(stickyAgentOf(caller, views), caller);
      if (held.stickyStatus !== status) changed = true;
      held.stickyStatus = status;
    }
    return changed;
  }

  /**
   * No team agent should be held back for this caller (see {@link publishWaiting}): promised to the
   * agent of the dial it superseded (a hand-over, §5.4), or `strict` with their sticky agent not
   * away as of the last search (only that agent may ever take them). A `loose` caller in its sticky
   * phase IS counted: the team takes them when the phase lapses, and the agent held back is the one
   * free to (IQ2's accepted over-hold).
   */
  private notTheTeams(entry: InboundCallerView): boolean {
    const held = this.calls.get(entry.callId);
    if (!held) return false;
    if (this.handovers.of(held.id)) return true;
    return entry.stickyMode === 'strict' && held.stickyStatus !== null && inStickyPhase(entry, held.stickyStatus, this.now());
  }

  private async waitingFrame(held: HeldCall): Promise<AgencyStationCustomerWaitingFrame> {
    const ctx = await held.panel;
    const name = ctx.match ? matchName(ctx.match.context) : undefined;
    return {
      event: 'customer_waiting',
      inbound_call_id: held.id,
      from_e164: held.record.from_e164,
      ...(name ? { match_name: name } : {}),
      waiting_since: (held.record.queued_at ?? held.record.arrived_at).toISOString(),
    };
  }

  private clearWaitingNotice(held: HeldCall): void {
    const sessionId = held.waitingNotified;
    if (!sessionId) return;
    held.waitingNotified = null;
    void this.waitingFrame(held).then((frame) => this.deps.stations.send(sessionId, { ...frame, cleared: true }));
  }

  // ─── Internals: pacing and metrics ────────────────────────────────────────

  /**
   * `inbound_waiting` for the account (docs/inbound.md §5.2): republished every
   * {@link INBOUND_WAITING_REPUBLISH_MS} while anyone waits, and once more with `n = 0` and no
   * preferred session when nobody does. `n` counts the callers the team may take, now or when a
   * `loose` sticky phase lapses ({@link notTheTeams}): a `strict` caller whose sticky agent is not
   * away is that agent's alone (held back as a preferred session), and one promised by a hand-over
   * is its superseded dial's agent's; holding a team agent for either would idle them for nothing.
   * A preferred session is a sticky agent's station that can take inbound calls (IQ46); pacing
   * also never holds back one that cannot (`pacing/inbound-hold-back.ts`).
   */
  private publishWaiting(accountKey: string): void {
    // One read of the account's waiting callers (sorted once) serves the summary and the test below.
    const waiting = this.queue.waiting(accountKey);
    const [tenantId, accountId] = accountKey.split(':') as [string, string];
    if (waiting.length === 0) {
      if (!this.holding.delete(accountKey)) return;
      this.publish({ type: 'inbound_waiting', tenantId, accountId, n: 0, preferredSessionIds: [], poolCampaignIds: null, ttlMs: INBOUND_WAITING_TTL_MS });
      return;
    }
    this.holding.add(accountKey);
    const summary = summarizeWaiting(waiting, (e) => this.notTheTeams(e));
    const sticky = new Set(summary.stickyUserIds);
    // Only a station that can take the caller (IQ46): an older app build's is never offered one, so
    // holding it back from pacing would idle it for nothing.
    const preferred = this.deps.stations.all()
      .filter((s) => s.canTakeInbound && sticky.has(s.agentUserId) && s.tenantId === tenantId && s.accountId === accountId)
      .map((s) => s.sessionId);
    this.publish({
      type: 'inbound_waiting', tenantId, accountId, n: summary.n,
      preferredSessionIds: preferred.slice(0, 100),
      poolCampaignIds: summary.poolCampaignIds === null ? null : summary.poolCampaignIds.slice(0, 100),
      ttlMs: INBOUND_WAITING_TTL_MS,
    });
  }

  /**
   * `agency_inbound_queue_waiting{route_id}` as the route's queue changes. A route nobody waits on
   * any more reports 0 once (the next export) and its series then goes (SWE-n1), so a deleted
   * route, or one quiet for the rest of the process's life, keeps no series.
   */
  private noteRouteWaiting(routeId: string): void {
    const waiting = this.queue.waitingOnRoute(routeId);
    if ((this.routesWaiting.get(routeId) ?? 0) === waiting) return;
    if (waiting === 0) this.routesWaiting.delete(routeId);
    else this.routesWaiting.set(routeId, waiting);
    trackInboundQueueWaiting(routeId, waiting);
  }

  /** The call has left the connector (settled, unconnected): its wait observed once if it queued. */
  private finishCall(held: HeldCall, result: InboundWaitResult): void {
    if (held.phase === 'done') return;
    this.clearTimers(held);
    // Every path that ends a held hand-over lets its session go first (`InboundHandovers.release`).
    this.handovers.forget(held.id);
    if (held.record.queued_at) trackInboundWait(result, (this.now() - held.record.queued_at.getTime()) / 1000);
    if (held.sessionId && this.bySession.get(held.sessionId) === held.id) this.bySession.delete(held.sessionId);
    this.dropCall(held);
  }

  /** The call is done and no longer held: whoever waits on it ({@link whenLeft}) is told. */
  private dropCall(held: HeldCall): void {
    held.phase = 'done';
    this.calls.delete(held.id);
    held.finish();
    this.unsubscribeWhenIdle();
  }

  // ─── Internals: the frame, the lease, the plumbing ────────────────────────

  private async sendFrame(held: HeldCall): Promise<void> {
    if (!held.sessionId) return;
    try {
      const ctx = await held.panel;
      this.deps.stations.send(held.sessionId, {
        event: 'inbound_call', call: inboundCallToWire(held.record, ctx, held.agentUserId, this.connectDelayMs),
      });
    } catch (err) {
      log.warn({ err, inboundCallId: held.id }, 'Could not send the inbound_call frame');
    }
  }

  /**
   * Renew the agent's lease every 5 s while the offer stands (`reserved`) and the call is
   * connected (`on_call`), as the dialer does for an attempt. A renewal Redis answers `lost` ends
   * an offer (requeued at the head); a connected call is left to its media.
   */
  private startLease(held: HeldCall, state: 'reserved' | 'on_call'): void {
    this.stopLease(held);
    const sessionId = held.sessionId!;
    const leaseMs = state === 'on_call' ? AGENT_LEASE_MS.on_call : AGENT_LEASE_MS.reserved_dialing;
    held.lease = setInterval(() => {
      void this.deps.agents.renewLease(sessionId, state, leaseMs).then((result) => {
        if (result !== 'lost' || held.sessionId !== sessionId) return;
        log.warn({ inboundCallId: held.id, sessionId, state }, 'Inbound call\'s agent lease lost');
        this.stopLease(held);
        if (state !== 'reserved') return;
        void this.serial(held.id, async () => {
          // Held for a superseding call through its preamble: let go; else the offer is cancelled.
          if (held.phase === 'preamble' && this.handovers.isHeldFor(held.id, sessionId)) await this.handovers.release(held.id, { returnAgent: true });
          else if (held.channel === 'push') await this.endRing(held, sessionId, 'cancelled', { offerResult: 'lease_lost' });
          else await this.cancelOffer(held, sessionId, 'lease_lost');
        });
      });
    }, AGENT_LEASE_MS.renew_interval);
    held.lease.unref?.();
  }

  private stopLease(held: HeldCall): void {
    if (held.lease) clearInterval(held.lease);
    held.lease = null;
  }

  private clearTimers(held: HeldCall): void {
    this.stopLease(held);
    if (held.bindTimer) clearTimeout(held.bindTimer);
    held.bindTimer = null;
    const ring = held.ring;
    if (ring) {
      if (ring.ringTimer) clearTimeout(ring.ringTimer);
      if (ring.acceptTimer) clearTimeout(ring.acceptTimer);
      ring.ringTimer = null;
      ring.acceptTimer = null;
    }
  }

  private forSession(sessionId: string): HeldCall | undefined {
    const id = this.bySession.get(sessionId);
    return id === undefined ? undefined : this.calls.get(id);
  }

  /**
   * The session's station if the release hook may take it for an inbound call: held here, OPEN,
   * able to take inbound calls (a console, or a phone that declared `caps=inbound`; an older app
   * build has no inbound frame, IQ20 as amended by IQ46) on a campaign (not the soft phone). The one
   * predicate {@link takeOnRelease} and {@link expectHandover} share.
   */
  private releasableStation(sessionId: string) {
    const station = this.deps.stations.get(sessionId);
    if (!station || station.campaignId === null || !station.canTakeInbound || station.ws.readyState !== 1) return null;
    return station;
  }

  /** The spine `offered → connected` for `sessionId` (`connect`); null: not on offer to it. Throws on a failed write. */
  private async writeConnected(held: HeldCall, sessionId: string, at: Date): Promise<AgencyInboundCallRecord | null> {
    return agencyInboundCallRepository.connect(held.id, {
      sessionId, answeredByUserId: held.agentUserId ?? (await this.agentOf(sessionId)), at,
    });
  }

  private async agentOf(sessionId: string): Promise<string> {
    const session = await agencyAgentSessionRepository.findById(sessionId);
    return session?.agent_user_id ?? '';
  }

  /**
   * Return an agent to the pool off the caller's chain (it may take an account's lock: the header).
   * Counted in the session's returns in flight ({@link noteReturn}).
   */
  private releaseInBackground(sessionId: string): Promise<void> {
    return this.noteReturn(sessionId, this.trackBackground(this.deps.releaseAgent(sessionId).then(() => undefined, (err: unknown) => {
      log.error({ err, sessionId }, 'Could not return an agent after an inbound offer');
    })));
  }

  /**
   * Count `work` in the session's returns in flight until it settles: a reservation the search or
   * the release hook holds for it (from the CAS to the offer, or to the give-back's end), a
   * give-back, an agent's return to the pool. {@link onStationCannotTakeInbound} waits for them,
   * so an older app build's `ready` reads the agent after them. Resolves (or rejects) as `work`.
   */
  private noteReturn<T>(sessionId: string, work: Promise<T>): Promise<T> {
    const prev = this.returning.get(sessionId);
    const mine: Promise<void> = Promise.allSettled(prev ? [prev, work] : [work]).then(() => undefined);
    this.returning.set(sessionId, mine);
    void mine.then(() => { if (this.returning.get(sessionId) === mine) this.returning.delete(sessionId); });
    return work;
  }

  /**
   * A reservation held for the session from now until the returned function is called (with the
   * give-back that ends it, if any): counted in its returns in flight ({@link noteReturn}). Call it
   * on every path, or the attach that waits on it waits out its bound.
   */
  private holdReturn(sessionId: string): (after?: Promise<unknown>) => void {
    let settle!: (after?: Promise<unknown>) => void;
    void this.noteReturn(sessionId, new Promise<unknown>((resolve) => { settle = resolve; }));
    return (after) => settle(after);
  }

  /** Resolves once the session's returns in flight, and any they started meanwhile, have settled. Never rejects. */
  private async returnsSettled(sessionId: string): Promise<void> {
    for (let i = 0; i < 10; i++) {
      const pending = this.returning.get(sessionId);
      if (!pending) return;
      await pending;
    }
  }

  private trackBackground<T>(p: Promise<T>): Promise<T> {
    const tracked = p.catch((err: unknown) => {
      log.error({ err }, 'Inbound connector background work failed');
      return undefined as T;
    });
    this.background.add(tracked);
    void tracked.finally(() => this.background.delete(tracked));
    return tracked;
  }

  /** Run `fn` after every earlier step of this call. Never rejects; resolves with `fn`'s value (undefined if it threw). */
  private serial<T>(callId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(callId) ?? Promise.resolve();
    const run = prev.then(fn);
    const next = run.then(() => undefined, (err: unknown) => {
      log.error({ err, inboundCallId: callId }, 'Inbound call step failed');
    });
    this.chains.set(callId, next);
    void next.then(() => { if (this.chains.get(callId) === next) this.chains.delete(callId); });
    return run.catch(() => undefined as T);
  }

  /** One holder per account at a time (see the header). */
  private async withAccountLock<T>(accountKey: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(accountKey) ?? Promise.resolve();
    let release!: () => void;
    const tail = new Promise<void>((resolve) => { release = resolve; });
    const mine = prev.then(() => tail);
    this.locks.set(accountKey, mine);
    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (this.locks.get(accountKey) === mine) this.locks.delete(accountKey);
    }
  }
}

/** The agent views of each account key, read once per tile read ({@link InboundConnector.routeAgents}). */
export type InboundAgentViewsMemo = Map<string, Promise<InboundAgentView[]>>;

/** A caller of `accountId` arriving on `route`, as the search would see them (the next caller: no sticky agent, none declined). */
function nextCallerView(
  tenantId: string,
  accountId: string,
  route: Pick<AgencyInboundRouteRecord, 'account_id' | 'pool_campaign_ids'>,
): InboundCallerView {
  return {
    callId: '', tenantId, accountId, routeAccountId: route.account_id,
    poolCampaignIds: route.pool_campaign_ids, stickyMode: 'off', stickyUserId: null, stickyWaitMs: 0, queuedAt: 0,
  };
}

/**
 * The state a station within the rejoin grace is judged by: its agent's state now while that is
 * still one who could take a caller (`COULD_TAKE_STATES`: a live call keeps `on_call` across the
 * blip); else, when nothing but the close has written since (`offline`, or the lease gone), the
 * state the agent was in when the station closed. Anything else written since (a break) stands.
 */
export function rejoinState(now: AgentLiveState | null, atClose: AgentLiveState | null): AgentLiveState | null {
  if (now && (COULD_TAKE_STATES as readonly string[]).includes(now.state)) return now;
  if ((!now || now.state === 'offline') && atClose && (COULD_TAKE_STATES as readonly string[]).includes(atClose.state)) return atClose;
  return now;
}

/** The wait metric's result for a call that left unconnected (a voicemail is an overflow: nobody took the caller). */
export function waitResultOf(outcome: AgencyInboundCallOutcome): InboundWaitResult {
  switch (outcome) {
    case 'abandoned_in_queue':
      return 'abandoned';
    case 'overflow':
    case 'voicemail':
      return 'overflow';
    default:
      return 'failed';
  }
}

/**
 * How a call nobody took ends, from the bridge's outcome: our shutdown is `failed` (IQ18: our side,
 * with its follow-up and callback); a stream that never opened is `failed`; the parked backstop
 * (the call's budget ran out unbound) is `overflow`; anything else is the caller hanging up while
 * they waited.
 */
export function unconnectedOutcome(bridgeOutcome: string | undefined): AgencyInboundCallOutcome {
  switch (bridgeOutcome) {
    case 'service_shutdown':
    case 'system_rebooted':
    case 'inbound_media_timeout':
      return 'failed';
    case 'max_duration_reached':
      return 'overflow';
    default:
      return 'abandoned_in_queue';
  }
}
