import type WebSocket from 'ws';
import {
  AGENCY_INBOUND_CONNECT_DELAY_MS,
  type AgencyInboundCall,
  type AgencyInboundCallOutcome,
  type AgencyInboundClipSlot,
  type AgencyInboundMissedReason,
  type AgencyInboundStickyReason,
  type AgencyStationCustomerWaitingFrame,
} from '@magick-agency/contracts/agency';
import { createChildLogger } from '@magick-agency/observability';
import {
  trackInboundCallEnded,
  trackInboundOffer,
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
  type AgencyInboundCallRecord,
  type AgencyInboundRouteRecord,
} from '../../db/repositories/agency.repository.js';
import type { InboundHoldResult, WebRtcBridgeManager, WebRtcLifecycleEvent } from '../../core/webrtc-bridge-manager.js';
import type { StationRegistry } from '../station-registry.js';
import { AGENT_LEASE_MS, type AgentStateMachine } from '../agent-state-machine.js';
import { publishPacingInvalidation, type PacingInvalidationEvent } from '../pacing/invalidation-bus.js';
import {
  RELEASE_STATES,
  anyoneCouldTake,
  callerForReleasedAgent,
  inStickyPhase,
  inboundIneligibility,
  searchOrder,
  stickyAgentOf,
  stickyAgentStatus,
  type InboundAgentView,
  type InboundCallerView,
  type StickyAgentStatus,
} from './eligibility.js';
import { InboundQueue, accountKeyOfCall, summarizeWaiting, type InboundQueueRouteSnapshot } from './inbound-queue.js';
import { inboundCallToWire, loadInboundPanelContext, type InboundPanelContext } from './inbound-call-wire.js';

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
 *     member; the hold loop follows. When the preamble is over (`onPreambleDone`, Q5) the spine
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
 *     reports (a busy sticky agent going away makes their caller the team's, Q6).
 *  3. The offer ({@link offer}, on the call's serial chain): the spine `offered` (guarded; a call
 *     that ended or a session that owes another outcome refuses and the reservation is given
 *     back), then SYNCHRONOUSLY the `agent_state: reserved` and the `inbound_call` frames (state
 *     `offered`, `connects_at`), so the panel and the chime come before any audio (IB1). The
 *     lease is renewed every 5 s; a lost lease cancels the offer.
 *  4. The bind, `AGENCY_INBOUND_CONNECT_DELAY_MS` after the offer (server-timed, Q4): the station
 *     socket must be OPEN (else the offer is cancelled), then `bindBorrowedBrowserLeg` stops the
 *     hold synchronously, re-arms the max duration, starts talk time and emits `bridged`. On
 *     `bridged`: the spine `connected` (`bridged_at`, the agent), the agent `on_call`, the frame.
 *     Audio flows from the bind whatever the database says: a `connected` write that fails leaves
 *     the call connected in memory (`connectOwed`) and is retried at its end, before `answered`.
 *  5. The end (the bridge's `ended`): connected → the spine `answered` (owed: `settled_at` NULL),
 *     the agent `wrapup` with the `inbound` field kept (no auto-return, Q11), the frame with
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
 * The router, at the answer, cancels an outbound dial still ringing the caller's number on a
 * carrier that can (the dialer's `supersedeForInbound`), after {@link expectHandover} promised
 * this call to that dial's session; it promises it only to a session the hook can take (a console
 * station on a campaign, OPEN), so a phone's or a soft-phone session's dial is never cancelled
 * for nothing. No other agent is offered the call meanwhile. The cancelled
 * dial's end releases the session, and the release hook ({@link takeOnRelease}) takes it for the
 * call first, CAS from `reserved`, so the agent who had the customer's panel gets their call with
 * no `available` instant between: offered at once when the call is queued, else HELD for it
 * (reserved, the `inbound` field set) until its preamble ends, then offered ({@link onQueued}).
 * A hand-over the release did not take (a queued break, the station gone, the carrier answering
 * the dial first) is dropped and the caller queues normally; {@link INBOUND_HANDOVER_TIMEOUT_MS}
 * bounds the wait.
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
  stations: Pick<StationRegistry, 'all' | 'get' | 'socketFor' | 'send' | 'isLocallyOwned'>;
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
}

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
  /** The agent whose cancelled outbound dial this call superseded (the clash, §5.4), until offered or dropped. */
  handover: Handover | null;
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
  /** Resolves `take`'s promise: the call has left the connector. */
  finish: () => void;
  /** `take`'s promise ({@link InboundConnector.whenLeft}). */
  left: Promise<void>;
}

/**
 * A call promised to the agent of the outbound dial it superseded ({@link InboundConnector.expectHandover}).
 * `held`: that agent is already reserved for it (their dial ended while the call was still in its
 * preamble), and is offered it the moment it queues. Not `held`: the dial is still ending; no other
 * agent is offered the call meanwhile, and {@link INBOUND_HANDOVER_TIMEOUT_MS} bounds the wait.
 */
interface Handover {
  sessionId: string;
  held: boolean;
  timer: NodeJS.Timeout | null;
}

/**
 * How long a call waits for the agent of the dial it superseded to be released before it is
 * offered to anyone (a backstop: the cancelled dial's end releases them within moments).
 */
export const INBOUND_HANDOVER_TIMEOUT_MS = 15_000;

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
  /** sessionId → the inbound call a cancelled outbound attempt hands it (the clash, §5.4). */
  private readonly handovers = new Map<string, string>();
  /** Accounts whose last `inbound_waiting` said someone waits. */
  private readonly holding = new Set<string>();
  private readonly routesWaiting = new Map<string, number>();
  private readonly queue: InboundQueue;
  private readonly now: () => number;
  private readonly connectDelayMs: number;
  private readonly publish: (event: PacingInvalidationEvent) => void;
  private readonly members: NonNullable<InboundConnectorDeps['members']>;
  private unsubscribe: (() => void) | null = null;
  /** {@link stop} ran: no new work; the listener stays for the calls still held. */
  private stopped = false;
  private republishTimer: NodeJS.Timeout | null = null;

  constructor(private readonly deps: InboundConnectorDeps) {
    this.now = deps.now ?? Date.now;
    this.connectDelayMs = deps.connectDelayMs ?? AGENCY_INBOUND_CONNECT_DELAY_MS;
    this.publish = deps.publish ?? publishPacingInvalidation;
    this.members = deps.members ?? ((tenantId, accountId, userIds) =>
      agencyInboundAnswerRepository.filterAccountMembers(tenantId, accountId, userIds));
    this.queue = new InboundQueue({
      now: this.now,
      onMaxWait: (callId) => this.onTimer(callId, 'max_wait'),
      onStickyLapse: (callId) => this.onTimer(callId, 'sticky_lapse'),
    });
  }

  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.deps.bridge.onLifecycle((ev) => {
      const held = ev.correlationId ? this.calls.get(ev.correlationId) : undefined;
      if (!held) return; // not an inbound call this connector holds
      void this.serial(held.id, () => this.onLifecycle(held, ev));
    });
    // While callers wait: `inbound_waiting` republished, and the account searched again. The
    // search is the backstop for a change no event reports: a busy sticky agent going away
    // (a queued break applied, the station gone) makes their caller the team's at once (Q6),
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
   * {@link drain}, which settles a caller nobody took `failed` with its follow-up and callback (Q18)
   * and leaves an answered one owing its outcome. A process that dies instead leaves them to the
   * next start's sweep.
   */
  stop(): void {
    this.stopped = true;
    if (this.republishTimer) clearInterval(this.republishTimer);
    this.republishTimer = null;
    for (const held of this.calls.values()) {
      this.clearTimers(held);
      if (held.handover?.timer) clearTimeout(held.handover.timer);
    }
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

  /** Wait for every event queued on this call so far. */
  async settled(callId: string): Promise<void> {
    await (this.chains.get(callId) ?? Promise.resolve());
  }

  // ─── Reads ────────────────────────────────────────────────────────────────

  /** The calls this connector holds (tests, the router's drain). */
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
    if (held.phase === 'preamble' && held.handover?.held && held.handover.sessionId === sessionId) return { callId: held.id, phase: 'offered' };
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
   *    nothing) who may take at least one of them, each caller judged by ITS account (Q21: a caller
   *    matched into another account is that account's agents' alone, and the route's pool applies
   *    only to callers of the route's account); with nobody waiting, those who may take the route's
   *    next caller (one of the route's account);
   *  - `noneCouldTake`: no session could take the route's next caller now or once their current
   *    work ends ({@link anyoneCouldTake}, PM-M6): such a caller is overflowed at once.
   */
  async routeAgents(route: Pick<AgencyInboundRouteRecord, 'id' | 'tenant_id' | 'account_id' | 'pool_campaign_ids'>): Promise<{ eligible: number; noneCouldTake: boolean }> {
    const viewsOf = new Map<string, Promise<InboundAgentView[]>>();
    const views = (key: string): Promise<InboundAgentView[]> => {
      let v = viewsOf.get(key);
      if (!v) {
        v = this.agentViews(key);
        viewsOf.set(key, v);
      }
      return v;
    };
    const next: InboundCallerView = {
      callId: '', tenantId: route.tenant_id, accountId: route.account_id, routeAccountId: route.account_id,
      poolCampaignIds: route.pool_campaign_ids, stickyMode: 'off', stickyUserId: null, stickyWaitMs: 0, queuedAt: 0,
    };
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
      connectOwed: null,
      bindTimer: null,
      lease: null,
      // Read once, while the preamble plays, so the offer frame is built with no await.
      panel: loadInboundPanelContext(call, { stickyCandidates: input.stickyCandidates }),
      stickyCandidates: input.stickyCandidates,
      waitingNotified: null,
      stickyStatus: null,
      hold: null,
      handover: null,
      leaving: false,
      declined: new Set(),
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
    if (this.queue.waiting(key).length > 0) this.searchInBackground(key);
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
    if (!this.handovers.has(sessionId) && this.queue.waiting(key).length === 0) return false;
    return this.withAccountLock(key, async () => {
      const handover = this.handovers.get(sessionId);
      if (handover) {
        const taken = await this.takeHandover(sessionId, handover, station.agentUserId);
        if (taken) return true;
      }
      const callers = this.callerViews(key);
      if (callers.length === 0) return false;
      const views = await this.agentViews(key);
      const self = views.find((v) => v.sessionId === sessionId);
      if (!self) return false;
      const callId = callerForReleasedAgent(self, callers, views, this.now());
      if (!callId) return false;
      const held = this.calls.get(callId);
      if (!held || held.leaving) return false;
      const reserved = await this.deps.agents.reserveForInbound(sessionId, callId, RELEASE_STATES);
      if (!reserved.ok) return false;
      // Re-checked after the CAS and queued with no await between: a caller marked leaving
      // meanwhile would put this offer behind their whole overflow message (the header).
      if (held.leaving) {
        await this.giveBack(sessionId, callId, 'call_gone');
        return false;
      }
      const offered = await this.serial(callId, () => this.offer(held, sessionId));
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
   * {@link INBOUND_HANDOVER_TIMEOUT_MS}: the caller then queues normally.
   *
   * False, and nothing promised: the call is not held here waiting (ended, offered, overflowing),
   * or one of the two already has a hand-over.
   */
  expectHandover(sessionId: string, callId: string): boolean {
    if (this.stopped || this.handovers.has(sessionId)) return false;
    // Only a session the release hook can take: a phone (Q20), a soft-phone session or a station
    // not OPEN never takes an inbound call, so its dial is left to ring (cancelled, the agent
    // would lose it for nothing and the caller would queue for someone else all the same).
    if (!this.releasableStation(sessionId)) return false;
    const held = this.calls.get(callId);
    if (!held || held.handover || held.leaving || (held.phase !== 'preamble' && held.phase !== 'queued')) return false;
    if (held.phase === 'queued' && this.queue.offeredTo(callId) !== null) return false;
    const timer = setTimeout(() => this.dropHandover(sessionId), INBOUND_HANDOVER_TIMEOUT_MS);
    timer.unref?.();
    held.handover = { sessionId, held: false, timer };
    this.handovers.set(sessionId, callId);
    log.info({ inboundCallId: callId, sessionId }, 'Inbound call promised to the agent of the dial it superseded');
    return true;
  }

  /**
   * Drop a hand-over not yet taken by the session's release ({@link expectHandover}): the call
   * queues normally and the account is searched. A no-op once the release took it (the session
   * is reserved for the call then) or when none is pending.
   */
  dropHandover(sessionId: string): void {
    const callId = this.handovers.get(sessionId);
    if (callId === undefined) return;
    this.handovers.delete(sessionId);
    const held = this.calls.get(callId);
    if (!held || held.handover?.sessionId !== sessionId || held.handover.held) return;
    if (held.handover.timer) clearTimeout(held.handover.timer);
    held.handover = null;
    log.info({ inboundCallId: callId, sessionId }, 'Hand-over of a superseding inbound call dropped — the caller queues normally');
    if (held.phase === 'queued') this.searchInBackground(held.accountKey);
  }

  /**
   * The release hook's hand-over (under the account's lock): reserve `sessionId` for the call
   * promised to it (CAS from `reserved` / `on_call` / `wrapup`) and offer it, or hold the session
   * for it while the call's preamble plays. True: the session was taken; false: the hand-over is
   * gone (the call left, or the CAS lost) and the release goes on as it would have.
   */
  private async takeHandover(sessionId: string, callId: string, agentUserId: string): Promise<boolean> {
    this.handovers.delete(sessionId);
    const held = this.calls.get(callId);
    if (!held || held.handover?.sessionId !== sessionId) return false;
    if (held.handover.timer) clearTimeout(held.handover.timer);
    const reserved = held.phase === 'preamble' || held.phase === 'queued'
      ? await this.deps.agents.reserveForInbound(sessionId, callId, RELEASE_STATES)
      : null;
    if (!reserved?.ok) {
      held.handover = null;
      if (reserved) log.warn({ inboundCallId: callId, sessionId, reserved }, 'Could not take the superseded dial\'s agent for its customer\'s call');
      if (held.phase === 'queued') this.searchInBackground(held.accountKey);
      return false;
    }
    if (held.leaving) {
      // Overflowing meanwhile (the maximum wait): never wait on its chain under the lock.
      held.handover = null;
      await this.deps.agents.releaseInbound(sessionId, callId);
      return false;
    }
    // On the call's chain: the preamble's end (`onQueued`) and the call's end are serialised with it.
    return this.serial(callId, async () => {
      if (held.phase === 'queued') {
        held.handover = null;
        const offered = await this.offer(held, sessionId);
        if (offered === 'offered') return true;
        await this.giveBack(sessionId, callId, offered);
        return false;
      }
      if (held.phase !== 'preamble') {
        held.handover = null;
        await this.deps.agents.releaseInbound(sessionId, callId);
        return false;
      }
      // Held through the preamble (Q5: no agent is bound during the greeting or the notice).
      held.handover = { sessionId, held: true, timer: null };
      held.sessionId = sessionId;
      held.agentUserId = agentUserId;
      this.bySession.set(sessionId, callId);
      this.deps.stations.send(sessionId, { event: 'agent_state', state: 'reserved', since: new Date(this.now()).toISOString() });
      this.startLease(held, 'reserved');
      await agencyAgentSessionRepository.setState(sessionId, 'reserved')
        .catch((err: unknown) => log.warn({ err, sessionId }, 'Could not mirror an inbound reservation'));
      log.info({ inboundCallId: callId, sessionId }, 'Superseded dial\'s agent held for its customer\'s call until the preamble ends');
      return true;
    });
  }

  /**
   * Let go of a session held for this call through its preamble (the hand-over), if any: the
   * reservation's `inbound` field cleared and, with `returnAgent`, the agent returned to the pool
   * in the background. A hand-over not yet taken is just dropped. On the call's chain.
   */
  private async releaseHandover(held: HeldCall, opts: { returnAgent: boolean }): Promise<void> {
    const handover = held.handover;
    if (!handover) return;
    held.handover = null;
    if (handover.timer) clearTimeout(handover.timer);
    if (this.handovers.get(handover.sessionId) === held.id) this.handovers.delete(handover.sessionId);
    if (!handover.held) return;
    this.stopLease(held);
    if (this.bySession.get(handover.sessionId) === held.id) this.bySession.delete(handover.sessionId);
    held.sessionId = null;
    held.agentUserId = null;
    await this.deps.agents.releaseInbound(handover.sessionId, held.id);
    if (opts.returnAgent) this.releaseInBackground(handover.sessionId);
  }

  /**
   * The session's station socket closed (the runtime's close handler, before it writes
   * `offline`): an offer whose audio has not bound is cancelled and the caller goes back to the
   * head of the queue. A bound call is the bridge's (its deferred hangup). Synchronous: the
   * cancel runs on the call's chain.
   */
  onStationClosed(sessionId: string): void {
    const held = this.forSession(sessionId);
    if (held && held.phase === 'offered' && !held.bound) {
      void this.serial(held.id, () => this.cancelOffer(held, sessionId, 'station_lost'));
    } else if (held?.handover?.held && held.handover.sessionId === sessionId) {
      // Held for a superseding call still in its preamble: let go (the runtime writes `offline`).
      void this.serial(held.id, () => this.releaseHandover(held, { returnAgent: false }));
    }
    // Presence changed: the account's waiting callers may have nobody left who could take them
    // (PM-M6). The search decides; this socket is no longer OPEN, so its station no longer counts.
    const station = this.deps.stations.get(sessionId);
    if (station && !this.stopped) {
      const key = accountKeyOfCall(station.tenantId, station.accountId);
      if (this.queue.waiting(key).length > 0) this.searchInBackground(key);
    }
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
    if (held.handover?.held) {
      // The superseded dial's agent, held for this call through the preamble (§5.4): offered now.
      const sessionId = held.handover.sessionId;
      held.handover = null;
      this.stopLease(held);
      held.sessionId = null;
      held.agentUserId = null;
      if (this.bySession.get(sessionId) === held.id) this.bySession.delete(sessionId);
      const offered = await this.offer(held, sessionId);
      if (offered === 'offered') return;
      // The session owes another call, or the call went: the reservation is given back, the
      // agent returned, and the caller (if still here) searched for like any other.
      void this.trackBackground(this.giveBack(sessionId, held.id, offered, { release: true }));
    } else if (held.handover) {
      // Promised to the superseded dial's agent, whose release is on its way: kept for them.
      return;
    }
    if (admitted === 'over_cap') {
      // Over `max_waiting`: only an agent free right now keeps this caller.
      void this.trackBackground(this.search(held.accountKey).then(() => {
        // Marked before the exit is queued, as every exit is (the header): no search reserves for a
        // caller whose overflow message is about to play.
        if (held.phase === 'queued' && this.queue.offeredTo(held.id) === null) held.leaving = true;
        return this.serial(held.id, async () => {
          if (held.phase === 'queued') await this.leave(held, 'over_cap');
        });
      }));
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
      await this.releaseHandover(held, { returnAgent: true });
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
    // An offer in flight runs to its bind or its cancel (the cancel overflows a lapsed caller). A
    // caller still waiting is marked leaving NOW, before the chain gets to it: from this instant no
    // search or release hook reserves an agent for them (M4: none waits behind their message).
    if (held.phase === 'queued' && this.queue.offeredTo(callId) === null) held.leaving = true;
    void this.serial(callId, async () => {
      if (held.phase === 'queued') await this.leave(held, 'max_wait');
    });
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
    await this.releaseHandover(held, { returnAgent: true });
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
  private async offer(held: HeldCall, sessionId: string): Promise<'offered' | 'call_gone' | 'session_busy'> {
    if (this.stopped || held.phase !== 'queued' || this.queue.offeredTo(held.id) !== null) return 'call_gone';
    // Promised to the superseded dial's agent meanwhile (§5.4): not this session's to take.
    if (held.handover && held.handover.sessionId !== sessionId) return 'call_gone';
    // Its maximum wait passed while this offer waited on the chain: it overflows instead.
    if (held.leaving) return 'call_gone';
    const at = new Date(this.now());
    const res = await agencyInboundCallRepository.offer(held.id, sessionId, { at });
    if (!res.ok) {
      trackInboundOffer('refused');
      return res.reason === 'session_busy' ? 'session_busy' : 'call_gone';
    }
    const ctx = await held.panel;
    const station = this.deps.stations.get(sessionId);
    // ── From here to the frames, no await (IB1) ─────────────────────────────
    held.record = res.call;
    held.phase = 'offered';
    held.sessionId = sessionId;
    held.agentUserId = station?.agentUserId ?? null;
    held.bound = false;
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

  /** The bind, at `connects_at` (see the header, step 4). On the call's chain. */
  private async bind(held: HeldCall): Promise<void> {
    if (held.phase !== 'offered' || held.bound || !held.sessionId) return;
    const sessionId = held.sessionId;
    const ws = this.deps.stations.socketFor(sessionId);
    if (!ws || ws.readyState !== 1 /* OPEN */) {
      await this.cancelOffer(held, sessionId, 'station_lost');
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
      const row = await this.cancelOffer(held, sessionId, stillOpen ? 'bind_refused' : 'station_lost');
      if (row && stillOpen) this.releaseInBackground(sessionId);
      return;
    }
    held.bound = true;
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
    trackInboundOffer('connected');
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
    await this.releaseHandover(held, { returnAgent: true });
    await this.deps.exits.settleCall(held.record, outcome);
    if (phase === 'offered' && held.sessionId) {
      const sessionId = held.sessionId;
      trackInboundOffer('caller_left');
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
    // An outcome is owed (Q11): `wrapup`, the `inbound` field kept, no auto-return. An agent whose
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
    held.phase = 'done';
    this.calls.delete(held.id);
    held.finish();
    this.unsubscribeWhenIdle();
    log.info({ inboundCallId: held.id, sessionId, talkSeconds }, 'Inbound call ended — its outcome is owed');
  }

  /**
   * Cancel an offer whose audio has not bound (see the header). On the call's chain. `why` names
   * the offer's end for the metric.
   */
  private async cancelOffer(
    held: HeldCall,
    sessionId: string,
    why: Extract<InboundOfferResult, 'station_lost' | 'lease_lost' | 'declined' | 'bind_refused'>,
  ): Promise<AgencyInboundCallRecord | null> {
    if (held.phase !== 'offered' || held.sessionId !== sessionId || held.bound) return null;
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
    trackInboundOffer(why);
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
      await this.leave(held, 'max_wait');
      return row;
    }
    this.publishWaiting(held.accountKey);
    this.searchInBackground(held.accountKey);
    return row;
  }

  // ─── Internals: the search ────────────────────────────────────────────────

  private searchInBackground(accountKey: string): void {
    void this.trackBackground(this.search(accountKey));
  }

  /** One search of the account's waiting callers (see the header, step 2). */
  private async search(accountKey: string): Promise<void> {
    if (this.stopped) return;
    const giveBacks: Array<() => Promise<void>> = [];
    await this.withAccountLock(accountKey, async () => {
      const callers = this.callerViews(accountKey);
      if (callers.length === 0) return;
      const views = await this.agentViews(accountKey);
      this.overflowWhomNobodyCanTake(callers, views);
      this.notifyBusyStickyAgents(callers, views);
      if (this.noteStickyStatus(callers, views)) this.publishWaiting(accountKey);
      const taken = new Set<string>();
      for (const step of searchOrder(callers, views, this.now())) {
        const held = this.calls.get(step.callId);
        if (!held || held.phase !== 'queued' || held.handover || held.leaving || this.queue.offeredTo(step.callId) !== null) continue;
        for (const sessionId of step.candidates) {
          if (taken.has(sessionId)) continue;
          const reserved = await this.deps.agents.reserveForInbound(sessionId, step.callId, ['available']);
          if (!reserved.ok) continue;
          taken.add(sessionId);
          // Re-checked after the CAS, and the offer queued with no await between (M4): a caller
          // marked leaving (or promised elsewhere) meanwhile is not waited for under the lock;
          // its chain may be playing a message or recording a voicemail for minutes.
          if (held.leaving || held.handover) {
            giveBacks.push(() => this.giveBack(sessionId, step.callId, 'call_gone', { release: true }));
            break;
          }
          const offered = await this.serial(step.callId, () => this.offer(held, sessionId));
          if (offered === 'offered') break;
          // Given back after the lock: `releaseAgent` runs the release hook, which takes it.
          giveBacks.push(() => this.giveBack(sessionId, step.callId, offered, { release: true }));
          if (offered === 'call_gone') break;
        }
      }
    });
    for (const giveBack of giveBacks) await giveBack();
  }

  /**
   * PM-M6: a waiting caller nobody in their pool could take, now or once their current work ends
   * ({@link anyoneCouldTake}: everyone on a break, offline, on the phone app, outside the pool or
   * gone from the account), is overflowed at once instead of being held to the maximum wait. Asked
   * at every search: when the caller queues, and while they wait at every presence change the
   * connector hears of (a station closing, an agent available) and at the 2 s republish (a break,
   * which no event reports). Marked leaving synchronously (the header), so this search and every
   * later one skip them; the exit runs on the call's chain, never under the lock.
   */
  private overflowWhomNobodyCanTake(callers: readonly InboundCallerView[], views: readonly InboundAgentView[]): void {
    for (const caller of callers) {
      if (anyoneCouldTake(caller, views)) continue;
      const held = this.calls.get(caller.callId);
      if (!held || held.phase !== 'queued' || held.leaving || held.handover || this.queue.offeredTo(held.id) !== null) continue;
      held.leaving = true;
      log.info({ inboundCallId: held.id }, 'Nobody in the pool could take this inbound caller — overflowing now');
      void this.serial(held.id, async () => {
        if (held.phase === 'queued') await this.leave(held, 'no_agents');
      });
    }
  }

  /**
   * Undo a reservation whose offer was refused: the `inbound` field cleared, and (from the
   * search, where the agent was `available`) the agent returned. A session the spine says holds
   * another unsettled inbound call (`session_busy`: its Redis field was lost) never goes to the
   * pool (SWE-M1): it is put on `break`, re-claimed for that call when its outcome is owed; the
   * same when the spine cannot be read (fails closed). The settle that follows never lifts that
   * break (`InboundCallService.returnAgent`): the agent's own "Go available" does.
   */
  private async giveBack(sessionId: string, callId: string, why: 'call_gone' | 'session_busy', opts: { release?: boolean } = {}): Promise<void> {
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
      return !held?.handover && !held?.leaving;
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
    const stations = this.deps.stations.all().filter((s) => accountKeyOfCall(s.tenantId, s.accountId) === accountKey);
    if (stations.length === 0) return [];
    const [tenantId, accountId] = accountKey.split(':') as [string, string];
    const [states, members] = await Promise.all([
      this.deps.agents.getMany(stations.map((s) => s.sessionId)),
      this.members(tenantId, accountId, [...new Set(stations.map((s) => s.agentUserId))]),
    ]);
    return stations.map((s, i) => ({
      sessionId: s.sessionId,
      agentUserId: s.agentUserId,
      tenantId: s.tenantId,
      accountId: s.accountId,
      campaignId: s.campaignId,
      clientKind: s.clientKind,
      stationOpen: s.ws.readyState === 1,
      member: members.has(s.agentUserId),
      live: states[i] ?? null,
    }));
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
   * free to (Q2's accepted over-hold).
   */
  private notTheTeams(entry: InboundCallerView): boolean {
    const held = this.calls.get(entry.callId);
    if (!held) return false;
    if (held.handover) return true;
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
    const preferred = this.deps.stations.all()
      .filter((s) => sticky.has(s.agentUserId) && s.tenantId === tenantId && s.accountId === accountId)
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
    if (held.handover) {
      // Every path that ends a held hand-over lets its session go first (`releaseHandover`).
      if (held.handover.timer) clearTimeout(held.handover.timer);
      if (this.handovers.get(held.handover.sessionId) === held.id) this.handovers.delete(held.handover.sessionId);
      held.handover = null;
    }
    if (held.record.queued_at) trackInboundWait(result, (this.now() - held.record.queued_at.getTime()) / 1000);
    held.phase = 'done';
    if (held.sessionId && this.bySession.get(held.sessionId) === held.id) this.bySession.delete(held.sessionId);
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
          if (held.phase === 'preamble' && held.handover?.held) await this.releaseHandover(held, { returnAgent: true });
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
  }

  private forSession(sessionId: string): HeldCall | undefined {
    const id = this.bySession.get(sessionId);
    return id === undefined ? undefined : this.calls.get(id);
  }

  /**
   * The session's station if the release hook may take it for an inbound call: held here, OPEN, a
   * console (a phone has no inbound frame yet, Q20) on a campaign (not the soft phone). The one
   * predicate {@link takeOnRelease} and {@link expectHandover} share.
   */
  private releasableStation(sessionId: string) {
    const station = this.deps.stations.get(sessionId);
    if (!station || station.campaignId === null || station.clientKind === 'mobile' || station.ws.readyState !== 1) return null;
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

  /** Return an agent to the pool off the caller's chain (it may take an account's lock: the header). */
  private releaseInBackground(sessionId: string): void {
    void this.trackBackground(this.deps.releaseAgent(sessionId).catch((err: unknown) =>
      log.error({ err, sessionId }, 'Could not return an agent after an inbound offer')));
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
 * How a call nobody took ends, from the bridge's outcome: our shutdown is `failed` (Q18: our side,
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

/** A display name from a roster contact's context (the CSV's name columns), if any. */
function matchName(context: Record<string, unknown>): string | undefined {
  for (const key of ['name', 'full_name', 'customer_name', 'first_name']) {
    const v = context[key];
    if (typeof v === 'string' && v.trim()) return v.trim().slice(0, 100);
  }
  return undefined;
}
