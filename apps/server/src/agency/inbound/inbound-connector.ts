import type WebSocket from 'ws';
import {
  AGENCY_INBOUND_CONNECT_DELAY_MS,
  type AgencyInboundCall,
  type AgencyInboundCallOutcome,
  type AgencyInboundClipSlot,
  type AgencyInboundStickyReason,
  type AgencyStationCustomerWaitingFrame,
} from '@magick-agency/contracts/agency';
import { createChildLogger } from '@magick-agency/observability';
import {
  trackInboundCallEnded,
  trackInboundOffer,
  trackInboundQueueWaiting,
  trackInboundWait,
  type InboundOfferResult,
  type InboundWaitResult,
} from '@magick-agency/observability/metrics/agency';
import {
  agencyAgentSessionRepository,
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
  callerForReleasedAgent,
  inboundIneligibility,
  searchOrder,
  stickyAgentOf,
  stickyAgentStatus,
  type InboundAgentView,
  type InboundCallerView,
} from './eligibility.js';
import { InboundQueue, accountKeyOfCall, type InboundQueueRouteSnapshot } from './inbound-queue.js';
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
 *     an agent frees: `onAgentAvailable` (an `available` write) or the release hook
 *     ({@link takeOnRelease}: `releaseAgent` asks before writing `available`, so an agent coming
 *     out of a call or a wrap-up is offered the caller with no `available` instant in between).
 *  3. The offer ({@link offer}, on the call's serial chain): the spine `offered` (guarded; a call
 *     that ended or a session that owes another outcome refuses and the reservation is given
 *     back), then SYNCHRONOUSLY the `agent_state: reserved` and the `inbound_call` frames (state
 *     `offered`, `connects_at`), so the panel and the chime come before any audio (IB1). The
 *     lease is renewed every 5 s; a lost lease cancels the offer.
 *  4. The bind, `AGENCY_INBOUND_CONNECT_DELAY_MS` after the offer (server-timed, Q4): the station
 *     socket must be OPEN (else the offer is cancelled), then `bindBorrowedBrowserLeg` stops the
 *     hold synchronously, re-arms the max duration, starts talk time and emits `bridged`. On
 *     `bridged`: the spine `connected` (`bridged_at`, the agent), the agent `on_call`, the frame.
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
 * ({@link releaseInBackground}), and a task that wants a search schedules one. The search awaits
 * the chain of the caller it offers, which holds no such task while the caller waits.
 *
 * ── Extension points (the follow-up packages) ─────────────────────────────────────
 *  - The in-flight clash (§5.4): {@link expectHandover} names the session a cancelled outbound
 *    attempt is about to release; {@link takeOnRelease} then offers that session THIS call before
 *    anything else, from `reserved`.
 *  - Voicemail (§7): a caller who reaches nobody leaves through {@link InboundCallExits.overflow},
 *    the router's, which picks what the route's overflow action plays.
 */

/** How long a published `inbound_waiting` holds pacing back unless republished. */
export const INBOUND_WAITING_TTL_MS = 5_000;
/** How often the connector republishes `inbound_waiting` while callers wait. */
export const INBOUND_WAITING_REPUBLISH_MS = 2_000;

/** What a call that reaches nobody does, and how its end is written: the router's. */
export interface InboundCallExits {
  /**
   * End an unconnected call as `outcome` with its Missed row and callback (`settle`), once: a
   * second end of the same call is a no-op (the spine's terminal guard).
   */
  settleCall(call: AgencyInboundCallRecord, outcome: AgencyInboundCallOutcome): Promise<void>;
  /**
   * The caller reached nobody (the maximum wait, over `max_waiting`): stop the hold and play the
   * route's overflow action, which ends the call. Resolves with the outcome to settle the call
   * with; never throws.
   */
  overflow(call: AgencyInboundCallRecord, route: AgencyInboundRouteRecord): Promise<AgencyInboundCallOutcome>;
  /** The route's clips for `slots` as hashes, the slots with nothing to play left out. Never throws. */
  clips(route: AgencyInboundRouteRecord, slots: readonly AgencyInboundClipSlot[]): Promise<string[]>;
}

export interface InboundConnectorDeps {
  bridge: Pick<WebRtcBridgeManager,
    'onLifecycle' | 'playInboundHold' | 'stopInboundHold' | 'bindBorrowedBrowserLeg' | 'reattachBorrowedBrowserLeg' | 'forceEndWithOutcome'>;
  stations: Pick<StationRegistry, 'all' | 'get' | 'socketFor' | 'send' | 'isLocallyOwned'>;
  agents: Pick<AgentStateMachine,
    'getMany' | 'get' | 'reserveForInbound' | 'releaseInbound' | 'rehydrateInbound' | 'transition' | 'set' | 'renewLease'>;
  /** Return an agent to the pool: `AgencyDialer.releaseAgent` (a queued break, this connector's hook, else `available`). */
  releaseAgent: (sessionId: string) => Promise<unknown>;
  exits: InboundCallExits;
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
  bindTimer: NodeJS.Timeout | null;
  lease: NodeJS.Timeout | null;
  panel: Promise<InboundPanelContext>;
  stickyCandidates: InboundTakeInput['stickyCandidates'];
  /** The session told "Your customer is waiting" for this caller, until cleared. */
  waitingNotified: string | null;
  /** The hold's promise, once started. */
  hold: Promise<InboundHoldResult> | null;
  /** Resolves `take`'s promise: the call has left the connector. */
  finish: () => void;
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
  /** sessionId → the inbound call a cancelled outbound attempt hands it (the clash, §5.4). */
  private readonly handovers = new Map<string, string>();
  /** Accounts whose last `inbound_waiting` said someone waits. */
  private readonly holding = new Set<string>();
  private readonly routesWaiting = new Map<string, number>();
  private readonly queue: InboundQueue;
  private readonly now: () => number;
  private readonly connectDelayMs: number;
  private readonly publish: (event: PacingInvalidationEvent) => void;
  private unsubscribe: (() => void) | null = null;
  /** {@link stop} ran: no new work; the listener stays for the calls still held. */
  private stopped = false;
  private republishTimer: NodeJS.Timeout | null = null;

  constructor(private readonly deps: InboundConnectorDeps) {
    this.now = deps.now ?? Date.now;
    this.connectDelayMs = deps.connectDelayMs ?? AGENCY_INBOUND_CONNECT_DELAY_MS;
    this.publish = deps.publish ?? publishPacingInvalidation;
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
    this.republishTimer = setInterval(() => {
      for (const key of [...this.holding]) this.publishWaiting(key);
    }, this.deps.republishMs ?? INBOUND_WAITING_REPUBLISH_MS);
    this.republishTimer.unref?.();
  }

  /**
   * Stop taking work: no more queueing, searching, offering or release hook, every timer dropped
   * (a bind not yet made never will be). The lifecycle listener stays until the calls still held
   * have ended: the bridge's graceful shutdown ends them `service_shutdown`, which settles a caller
   * nobody took `failed` with its follow-up and callback (Q18) and leaves an answered one owing its
   * outcome. A process that dies instead leaves them to the next start's sweep.
   */
  stop(): void {
    this.stopped = true;
    if (this.republishTimer) clearInterval(this.republishTimer);
    this.republishTimer = null;
    for (const held of this.calls.values()) this.clearTimers(held);
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
   * The call offered to or connected with this session, with its phase: what `/leave` refuses
   * on (an agent with a call on offer or connected cannot leave the station).
   */
  findCallForSession(sessionId: string): { callId: string; phase: 'offered' | 'connected' } | null {
    const held = this.forSession(sessionId);
    if (!held || (held.phase !== 'offered' && held.phase !== 'connected')) return null;
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
   * The agents who could take the next caller of a route with this pool now: the account's live
   * console campaign sessions on this process, OPEN, in the pool, `available` and holding nothing
   * (`inboundIneligibility`). The tile's `eligible_agents`.
   */
  async eligibleAgents(tenantId: string, accountId: string, poolCampaignIds: readonly string[]): Promise<number> {
    const views = await this.agentViews(accountKeyOfCall(tenantId, accountId));
    const probe: InboundCallerView = {
      callId: '', tenantId, accountId, routeAccountId: accountId, poolCampaignIds,
      stickyMode: 'off', stickyUserId: null, stickyWaitMs: 0, queuedAt: 0,
    };
    return views.filter((v) => inboundIneligibility(v, probe) === null).length;
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
      bindTimer: null,
      lease: null,
      // Read once, while the preamble plays, so the offer frame is built with no await.
      panel: loadInboundPanelContext(call, { stickyCandidates: input.stickyCandidates }),
      stickyCandidates: input.stickyCandidates,
      waitingNotified: null,
      hold: null,
      finish,
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
    const station = this.deps.stations.get(sessionId);
    if (!station || station.campaignId === null || station.clientKind === 'mobile' || station.ws.readyState !== 1) return false;
    const key = accountKeyOfCall(station.tenantId, station.accountId);
    const handover = this.handovers.get(sessionId);
    if (!handover && this.queue.waiting(key).length === 0) return false;
    return this.withAccountLock(key, async () => {
      this.handovers.delete(sessionId);
      const callers = this.callerViews(key);
      if (callers.length === 0) return false;
      const views = await this.agentViews(key);
      const self = views.find((v) => v.sessionId === sessionId);
      if (!self) return false;
      const callId = handover && callers.some((c) => c.callId === handover)
        ? handover
        : callerForReleasedAgent(self, callers, views, this.now());
      if (!callId) return false;
      const held = this.calls.get(callId);
      if (!held) return false;
      const reserved = await this.deps.agents.reserveForInbound(sessionId, callId, RELEASE_STATES);
      if (!reserved.ok) return false;
      const offered = await this.serial(callId, () => this.offer(held, sessionId));
      if (offered === 'offered') return true;
      await this.giveBack(sessionId, callId, offered);
      return false;
    });
  }

  /**
   * The in-flight clash (§5.4; the follow-up package): the outbound attempt ringing on
   * `sessionId` is being cancelled because its customer rang in on `callId`. When `releaseAgent`
   * then runs for the session, the hook offers it this call first. Dropped by that release, or
   * by {@link dropHandover} when the cancel did not land.
   */
  expectHandover(sessionId: string, callId: string): void {
    this.handovers.set(sessionId, callId);
  }

  dropHandover(sessionId: string): void {
    this.handovers.delete(sessionId);
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
    if (admitted === 'over_cap') {
      // Over `max_waiting`: only an agent free right now keeps this caller.
      void this.trackBackground(this.search(held.accountKey).then(() => this.serial(held.id, async () => {
        if (held.phase === 'queued') await this.leave(held, 'overflow');
      })));
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
      await this.deps.exits.settleCall(held.record, 'failed');
      this.finishCall(held, 'failed');
    }
  }

  private onTimer(callId: string, which: 'max_wait' | 'sticky_lapse'): void {
    const held = this.calls.get(callId);
    if (!held) return;
    if (which === 'sticky_lapse') {
      this.searchInBackground(held.accountKey);
      return;
    }
    // An offer in flight runs to its bind or its cancel (the cancel overflows a lapsed caller).
    void this.serial(callId, async () => {
      if (held.phase === 'queued') await this.leave(held, 'overflow');
    });
  }

  /**
   * The caller reached nobody: out of the queue, the route's overflow action (the router's), then
   * the call settled with what it returned. On the call's chain.
   */
  private async leave(held: HeldCall, why: 'overflow'): Promise<void> {
    if (held.phase !== 'queued') return;
    held.phase = 'leaving';
    this.queue.remove(held.id);
    this.noteRouteWaiting(held.route.id);
    this.clearWaitingNotice(held);
    this.publishWaiting(held.accountKey);
    log.info({ inboundCallId: held.id, why }, 'Inbound caller reached nobody — overflow');
    const outcome = await this.deps.exits.overflow(held.record, held.route);
    await this.deps.exits.settleCall(held.record, outcome);
    this.finishCall(held, outcome === 'overflow' ? 'overflow' : outcome === 'abandoned_in_queue' ? 'abandoned' : 'failed');
  }

  /**
   * Offer the call to `sessionId`, already reserved for it in Redis (see the header, step 3). On
   * the call's chain. `offered`, else why not (the caller gives the reservation back).
   */
  private async offer(held: HeldCall, sessionId: string): Promise<'offered' | 'call_gone' | 'session_busy'> {
    if (this.stopped || held.phase !== 'queued' || this.queue.offeredTo(held.id) !== null) return 'call_gone';
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
      // The call is ending (its `ended` is on this chain next) or cannot take an agent.
      log.warn({ inboundCallId: held.id, sessionId }, 'Inbound bind refused by the bridge');
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
    const row = await agencyInboundCallRepository.connect(held.id, {
      sessionId, answeredByUserId: held.agentUserId ?? (await this.agentOf(sessionId)), at,
    });
    if (!row) return;
    held.record = row;
    held.phase = 'connected';
    this.stopLease(held);
    trackInboundOffer('connected');
    trackInboundWait('connected', (at.getTime() - (row.queued_at ?? row.arrived_at).getTime()) / 1000);
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
    this.finishCall(held, outcome === 'abandoned_in_queue' ? 'abandoned' : outcome === 'overflow' ? 'overflow' : 'failed');
    this.publishWaiting(held.accountKey);
  }

  private async endConnected(held: HeldCall, ev: WebRtcLifecycleEvent): Promise<void> {
    const sessionId = held.sessionId!;
    const talkSeconds = typeof ev.talkTimeSeconds === 'number' ? Math.max(0, Math.round(ev.talkTimeSeconds)) : null;
    const res = await agencyInboundCallRepository.end(held.id, {
      outcome: 'answered', talkSeconds, followUp: null, callbackDueAt: null, voicemailKey: null,
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
  private async cancelOffer(held: HeldCall, sessionId: string, why: Extract<InboundOfferResult, 'station_lost' | 'lease_lost'>): Promise<void> {
    if (held.phase !== 'offered' || held.sessionId !== sessionId || held.bound) return;
    this.clearTimers(held);
    const row = await agencyInboundCallRepository.requeue(held.id, sessionId, { at: new Date(this.now()) });
    await this.deps.agents.releaseInbound(sessionId, held.id);
    this.bySession.delete(sessionId);
    held.sessionId = null;
    held.agentUserId = null;
    if (!row) {
      // Not on offer to this session any more: it ended (its `ended` is next on this chain).
      held.phase = 'queued';
      return;
    }
    trackInboundOffer(why);
    held.record = row;
    held.phase = 'queued';
    // The session's last frame of this call says it is no longer theirs (if the socket is still there).
    const ctx = await held.panel;
    this.deps.stations.send(sessionId, { event: 'inbound_call', call: { ...inboundCallToWire(row, ctx, null, this.connectDelayMs), session_id: sessionId } });
    this.queue.requeueHead(held.id);
    this.noteRouteWaiting(held.route.id);
    log.info({ inboundCallId: held.id, sessionId, why }, 'Inbound offer cancelled before audio bound — the caller is back at the head of the queue');
    if (this.queue.maxWaitLapsed(held.id)) {
      await this.leave(held, 'overflow');
      return;
    }
    this.publishWaiting(held.accountKey);
    this.searchInBackground(held.accountKey);
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
      this.notifyBusyStickyAgents(callers, views);
      const taken = new Set<string>();
      for (const step of searchOrder(callers, views, this.now())) {
        const held = this.calls.get(step.callId);
        if (!held || held.phase !== 'queued' || this.queue.offeredTo(step.callId) !== null) continue;
        for (const sessionId of step.candidates) {
          if (taken.has(sessionId)) continue;
          const reserved = await this.deps.agents.reserveForInbound(sessionId, step.callId, ['available']);
          if (!reserved.ok) continue;
          taken.add(sessionId);
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
   * Undo a reservation whose offer was refused: the `inbound` field cleared, and (from the
   * search, where the agent was `available`) the agent returned. A session the spine says owes
   * another inbound call's outcome (its Redis field was lost) is put back on that call instead
   * (`break`, the field re-claimed), never into the pool.
   */
  private async giveBack(sessionId: string, callId: string, why: 'call_gone' | 'session_busy', opts: { release?: boolean } = {}): Promise<void> {
    await this.deps.agents.releaseInbound(sessionId, callId);
    if (why === 'session_busy') {
      const owed = await agencyInboundCallRepository.findUnsettledForSession(sessionId).catch(() => null);
      if (owed && owed.state === 'ended' && owed.bridged_at !== null) {
        log.warn({ sessionId, owedInboundCallId: owed.id }, 'Session reserved for an inbound call while it owes another one\'s outcome — re-claiming that call');
        await this.deps.agents.set(sessionId, 'break', { leaseMs: AGENT_LEASE_MS.break });
        await this.deps.agents.rehydrateInbound(sessionId, owed.id);
        await agencyAgentSessionRepository.setState(sessionId, 'break').catch(() => undefined);
        this.deps.stations.send(sessionId, { event: 'agent_state', state: 'break', since: new Date(this.now()).toISOString() });
        return;
      }
    }
    if (opts.release) await this.deps.releaseAgent(sessionId);
  }

  /** The account's waiting callers as the search sees them, in service order. */
  private callerViews(accountKey: string): InboundCallerView[] {
    return this.queue.waiting(accountKey);
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
    };
  }

  /** The account's sessions on this process with their Redis state (one pipelined read). */
  private async agentViews(accountKey: string): Promise<InboundAgentView[]> {
    const stations = this.deps.stations.all().filter((s) => accountKeyOfCall(s.tenantId, s.accountId) === accountKey);
    const states = await this.deps.agents.getMany(stations.map((s) => s.sessionId));
    return stations.map((s, i) => ({
      sessionId: s.sessionId,
      agentUserId: s.agentUserId,
      tenantId: s.tenantId,
      accountId: s.accountId,
      campaignId: s.campaignId,
      clientKind: s.clientKind,
      stationOpen: s.ws.readyState === 1,
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
   * {@link INBOUND_WAITING_REPUBLISH_MS} while anyone waits, and once more with `n = 0`.
   */
  private publishWaiting(accountKey: string): void {
    const summary = this.queue.waitingSummary(accountKey);
    const [tenantId, accountId] = accountKey.split(':') as [string, string];
    if (summary.n === 0) {
      if (!this.holding.delete(accountKey)) return;
      this.publish({ type: 'inbound_waiting', tenantId, accountId, n: 0, preferredSessionIds: [], poolCampaignIds: null, ttlMs: INBOUND_WAITING_TTL_MS });
      return;
    }
    this.holding.add(accountKey);
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
        if (state === 'reserved') void this.serial(held.id, () => this.cancelOffer(held, sessionId, 'lease_lost'));
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
