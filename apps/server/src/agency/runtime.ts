import crypto from 'node:crypto';
import { AsyncResource } from 'node:async_hooks';
import type Redis from 'ioredis';
import type WebSocket from 'ws';
import { createChildLogger } from '@magick-agency/observability';
import { trackAwayRingEnded } from '@magick-agency/observability/metrics/agency';
import type { WebRtcBridgeManager } from '../core/webrtc-bridge-manager.js';
import {
  agencyAgentSessionRepository,
  agencyInboundCallRepository,
  agencyManualCallRepository,
} from '../db/repositories/agency.repository.js';
import type { AgencyAgentSessionRecord } from '../db/models/agency.model.js';
import {
  AGENCY_STATION_CLOSE,
  DEVICE_AWAY_BREAK_REASON,
  SOFTPHONE_BREAK_REASON,
  type AgencyAgentState,
} from '@magick-agency/contracts/agency';
import { StationRegistry, stationGraceFor } from './station-registry.js';
import { AgentStateMachine, AGENT_LEASE_MS, type AgentLiveState } from './agent-state-machine.js';
import { AgencyDialer } from './agency-dialer.js';
import { CarrierRefusalBreaker } from './carrier-refusal-breaker.js';
import { LocalDialDispatcher, type DialDispatcher } from './dial-dispatcher.js';
import { PacingEngine, type PacingStations, type ReservedReturn } from './pacing-engine.js';
import { AgencyReaper, type AgencyReaperDeps } from './reaper.js';
import { refreshAbandonmentWindow, startAbandonmentMetricsRefresh } from './abandonment-metrics.js';
import { refreshLiveConcurrency, startLiveConcurrencyRefresh } from './live-concurrency-metrics.js';
import {
  ABANDONMENT_REFRESH_MS, AGENCY_LIVE_CONCURRENCY_REFRESH_MS,
  STATION_HEARTBEAT_SWEEP_MS,
  STATION_SWEEP_IDLE_PASSES_BEFORE_DORMANT,
} from '@magick-agency/domain/timers';
import { StationTokenStore } from './station-token.js';
import { DncRegistry } from './dnc-registry.js';
import { notifyAgencyCampaignFinished } from './campaign-completion-notice.js';
import { WrapupManager } from './wrapup-manager.js';
import { BreakRegistry } from '@magick-agency/domain/break-manager';
import { ManualDialer } from './softphone/manual-dialer.js';
import { SoftphoneService } from './softphone/softphone-service.js';
import { publishPacingInvalidation } from './pacing/invalidation-bus.js';
import { DedicatedCallerIdCache } from './pacing/dedicated-caller-ids.js';
import { queuedBreakReleaseOf } from './reserved-agent.js';
import type { InboundConnector } from './inbound/inbound-connector.js';
import { InboundCallService } from './inbound/inbound-disposition.js';
import { AwayRingService, returnFromAwayRing } from './away-ring.js';

const log = createChildLogger({ component: 'agency-runtime' });

/**
 * How the runtime is assembled in the primary of a multi-process server
 * (`docs/scaling.md` §3): where pacing reads the stations from, how it dispatches a dial
 * and hands back a reserved agent, and what the reaper asks about liveness. Absent (one
 * process): the runtime's own registry, `LocalDialDispatcher`, the queued-break check and
 * the reaper's in-process questions, exactly as before.
 */
export interface AgencyRuntimeOptions {
  pacingStations?: PacingStations;
  dispatcher?: DialDispatcher;
  reservedReturn?: ReservedReturn;
  reaper?: Partial<Pick<AgencyReaperDeps, 'activeAttemptIds' | 'ownerOf' | 'unrecordedEnds' | 'manual' | 'beforeSweep'>>;
  /**
   * True when other processes dial this process's campaigns too (media workers: each runs the
   * dials of its own agents), so the carrier refusal breaker clears the shared streak on every
   * placed call. Unset (one process): it is the sole counter and skips a clear it knows is
   * moot (`carrier-refusal-breaker.ts`).
   */
  refusalCountShared?: boolean;
}

/** A registry entry, as the sweep sees it (`StationRegistry.silentSince`). */
type StationEntry = ReturnType<StationRegistry['silentSince']>[number];

/**
 * Assembles the agency dialer and owns its lifecycle.
 *
 * Startup order is load-bearing: **the reaper runs before the pacing supervisor**.
 * A crash leaves attempts non-terminal and contacts `in_flight`, and those count
 * against the tick's occupied total — so a supervisor started first would compute
 * a fabricated occupancy from dead rows and quietly dial nothing, forever, on a
 * campaign that looks healthy.
 */
export class AgencyRuntime {
  readonly replicaId: string;
  readonly stations: StationRegistry;
  readonly agents: AgentStateMachine;
  readonly dialer: AgencyDialer;
  readonly wrapup: WrapupManager;
  readonly breaks: BreakRegistry;
  readonly pacing: PacingEngine;
  readonly reaper: AgencyReaper;
  /** The compliance-window refresh handle, live only between start and stop. */
  private abandonmentMetrics: { stop: () => void } | null = null;
  /** The live-concurrency refresh handle, live only between start and stop. */
  private liveConcurrencyMetrics: { stop: () => void } | null = null;
  /**
   * The silent-station sweep. Armed by {@link wakeStationSweep} on every attach,
   * and dormant whenever this replica holds no stations.
   */
  private stationSweepTimer: NodeJS.Timeout | null = null;
  private stationSweepIdlePasses = 0;
  /**
   * The async context the runtime was built in (bootstrap, outside any request), captured
   * once. {@link wakeStationSweep} arms its timer inside it, because the first call comes
   * from a station's upgrade request: a timer armed there would carry that request's
   * AsyncLocalStorage stores for its whole life — the ambient log context
   * (`client-log-context.ts` seeds it with `enterWith`, plus tenant/account) and the trace
   * context — stamping one agent's `client`/`clientVersion`/tenant on every sweep line for
   * every station.
   */
  private readonly ownScope = new AsyncResource('AgencyRuntime');
  readonly tokens: StationTokenStore;
  /**
   * The Do Not Call registry the pre-dial gate reads (decision B8). Exposed so the
   * campaign stats' DNC probe and the tests go through the same object the pacing
   * engine uses — a test-only path would mean the suites prove something production
   * never does.
   */
  readonly dnc: DncRegistry;
  /** The soft phone's dialer: places manual calls and owns them until they end (docs/softphone.md §4.1). */
  readonly manualDialer: ManualDialer;
  /**
   * The soft phone's runtime surface for the public API layer (docs/softphone.md
   * §4, §6): typed methods answering refusals that map 1:1 onto
   * `AgencySoftphoneErrorCode`. See `softphone/softphone-service.ts`.
   */
  readonly softphone: SoftphoneService;
  /**
   * The one dial dispatcher: the pacing engine's, and the wrap-up redial's
   * (`wrapup-redial.ts`), so a redial passes the same clearance and ownership checks.
   */
  readonly dispatcher: DialDispatcher;
  /**
   * The campaigns' dedicated caller IDs, as every dial path reads them (DN4,
   * `pacing/dedicated-caller-ids.ts`): pacing, the agent's own call, the wrap-up redial and the
   * tagged soft phone. Cached while this process's pacing engine listens to the bus (it leads a
   * campaign), read through otherwise: always, in a media worker, whose bus delivers nothing.
   */
  readonly dedications: DedicatedCallerIdCache;
  /**
   * The inbound connector (docs/inbound.md §2, P2): who is put through to which waiting inbound
   * caller. Attached by `startInboundCalls` ({@link attachInbound}) in the process that answers
   * inbound calls; null before, after its stop, and in a media worker.
   */
  inbound: InboundConnector | null = null;
  /** The answered inbound call's finish (read, notes, hang up, outcome, DNC) and the outcome lapse. */
  readonly inboundCalls: InboundCallService;
  /**
   * Mode B's away break whose phone rings for inbound callers (`away-ring.ts`, IQ66/IQ67): entering
   * it, ending it, the inbound connector's return to it after an unanswered ring
   * (`releaseInbound`), and the reconcile the agency bootstrap runs.
   */
  readonly awayRing: AwayRingService;

  constructor(bridge: WebRtcBridgeManager, redis: Redis | null, keyPrefix: string, options: AgencyRuntimeOptions = {}) {
    // Stable for the life of the process. There is one replica in v1, but the
    // ownership key is written and read from day one so the invariant is exercised
    // continuously rather than being dead code that rots until we scale out.
    this.replicaId = process.env.REPLICA_ID || `${process.pid}-${crypto.randomUUID().slice(0, 8)}`;

    this.stations = new StationRegistry(redis, keyPrefix, this.replicaId);
    this.agents = new AgentStateMachine(redis, keyPrefix);
    this.breaks = new BreakRegistry();
    // The wrap-up manager returns agents through the dialer's own release path, so
    // there is exactly one place an agent re-enters the pool — whether they got
    // there by finishing a wrap-up, skipping one, or never having had one.
    this.wrapup = new WrapupManager(this.stations, this.agents, (sessionId) =>
      this.dialer.releaseAgent(sessionId));
    this.dialer = new AgencyDialer(
      bridge, this.stations, this.agents, this.wrapup, this.breaks,
      new CarrierRefusalBreaker(redis, keyPrefix, { soleCounter: !options.refusalCountShared }),
    );
    // Both liveness questions the periodic sweep needs, and the attempts the
    // dialer could not write `ended`, as lazy closures rather than references: `this.dialer` is assigned above but the arrow keeps the
    // reaper independent of construction order, and re-reading on every sweep is
    // the point — a snapshot taken here would be empty forever.
    //
    // Same shape as the telephony guard host's `registerWebrtcActiveIdsProvider`: the sweeper
    // asks what is live rather than being told, so nothing has to remember to
    // update it.
    this.manualDialer = new ManualDialer(bridge, this.stations, this.agents);
    this.reaper = new AgencyReaper({
      activeAttemptIds: () => this.dialer.activeAttemptIds(),
      // The soft phone's orphan sweep spares this process's live manual calls; a
      // call the sweeps close has its Redis claim cleared and its session told.
      manual: {
        activeIds: () => this.manualDialer.activeManualCallIds(),
        onClosed: (rows) => this.manualDialer.onCallsClosedBySweep(rows),
      },
      ownerOf: (sessionId) => this.stations.ownerOf(sessionId),
      unrecordedEnds: {
        entries: () => this.dialer.unrecordedEndedAttempts(),
        forget: (attemptIds) => this.dialer.forgetUnrecordedEnds(attemptIds),
      },
      clearAgent: (sessionId) => this.agents.clear(sessionId),
      ...options.reaper,
    });
    this.tokens = new StationTokenStore(redis, keyPrefix);

    // Decision B8: the registry is one indexed read of `dnc_entries` and fails closed
    // on any read fault. The default argument is the shared `dncRepository`.
    this.dnc = new DncRegistry();
    this.dedications = new DedicatedCallerIdCache();
    this.softphone = new SoftphoneService({
      agents: this.agents,
      stations: this.stations,
      breaks: this.breaks,
      dialer: this.dialer,
      dnc: this.dnc,
      manual: this.manualDialer,
      dedications: this.dedications,
    });
    const dispatcher = options.dispatcher
      ?? new LocalDialDispatcher(this.replicaId, (cmd, opts) => this.dialer.executeDial(cmd, opts));
    this.dispatcher = dispatcher;
    this.pacing = new PacingEngine(
      redis, keyPrefix, this.replicaId, options.pacingStations ?? this.stations, this.agents, dispatcher, this.dnc,
      { dedications: this.dedications },
    );
    if (options.reservedReturn) this.pacing.registerReservedReturn(options.reservedReturn);
    // The engine's "something may want to know a campaign finished" seam carries the
    // supervisors' completion notice. See `campaign-completion-notice.ts`.
    this.pacing.registerCompletionNotifier({ notifyCampaignFinished: notifyAgencyCampaignFinished });
    // A break (or a switch to the soft phone) queued while pacing held the agent
    // `reserved` is applied by the one release path when pacing hands them back.
    this.pacing.registerQueuedBreakRelease(queuedBreakReleaseOf({ breaks: this.breaks, dialer: this.dialer }));
    // The pacing engine skips a campaign whose last tick found no available agent
    // until something can change that (`pacing/invalidation-bus.ts`). These are the
    // two ways an agent becomes dialable: a state write into `available` (a join,
    // a wrap-up or break ending, a reservation handed back) and a station attaching
    // over a lease that is still `available`. The campaign is resolved HERE, where
    // the station lives, so the event means the same to an engine in another process.
    const stationsForCampaign = options.pacingStations ?? this.stations;
    this.agents.onAvailable((sessionId) => publishPacingInvalidation({
      type: 'agent_available', sessionId,
      campaignId: this.stations.get(sessionId)?.campaignId ?? stationsForCampaign.get(sessionId)?.campaignId ?? null,
    }));
    // An agent entering `available` is offered a waiting inbound caller at once (synchronously
    // here, where pacing waits for its next tick): docs/inbound.md §2, "Pacing and inbound".
    this.agents.onAvailable((sessionId) => this.inbound?.onAgentAvailable(sessionId));
    this.inboundCalls = new InboundCallService({
      bridge,
      agents: this.agents,
      stations: this.stations,
      releaseAgent: (sessionId) => this.dialer.releaseAgent(sessionId),
      connector: () => this.inbound,
    });
    this.stations.onAttached(({ sessionId, campaignId }) => {
      // A soft-phone session (no campaign) is never `available`; nothing to wake.
      if (campaignId) publishPacingInvalidation({ type: 'agent_available', sessionId, campaignId });
    });
    this.awayRing = new AwayRingService({ agents: this.agents, stations: this.stations, inbound: () => this.inbound, breaks: this.breaks });
    // A queued `away_ring` applied by the one release path (a break asked for while hidden during a
    // call or wrap-up, IQ72), with or without a station socket.
    this.dialer.registerAwayRing({ applyQueued: (sessionId) => this.awayRing.applyQueued(sessionId) });
  }

  // ─── Inbound calls (docs/inbound.md §2, P2) ───────────────────────────────

  /**
   * Put the inbound connector in the runtime: the release hook in `releaseAgent` (a waiting
   * caller before `available`), the `available` listener, the station close and the sweeps.
   * `startInboundCalls` calls it once the connector exists; null detaches it (its stop).
   */
  attachInbound(connector: InboundConnector | null): void {
    this.inbound = connector;
    this.dialer.registerInboundTake(connector ? (sessionId) => connector.takeOnRelease(sessionId) : null);
  }

  // ─── Presence resilience ──────────────────────────────────────────────────

  /**
   * What state a station socket's owner comes back in. **Redis, or `break`.**
   *
   * These two lines are the whole of the rule, and they live here
   * rather than in the route because the rule is a runtime invariant that a
   * transport must not be able to get subtly wrong.
   *
   * **The DB row is never consulted, and that is the fix.** The route used to
   * rehydrate from `agency_agent_sessions.state`, which is a mirror written
   * best-effort alongside the authoritative Redis lease. An agent who dropped
   * mid-call and reconnected inside the deferred-hangup window had a live
   * `on_call` lease and a row still reading `available` — so rehydration
   * overwrote the lease with `available`, and the next pacing tick reserved an
   * agent who was already talking to a customer.
   *
   * The one exception is a wrap-up this replica still holds (`WrapupManager.stateFor`):
   * the agent comes back in `wrapup`, over an `offline` or a lapsed lease (see below).
   *
   * A **lapsed** lease means either a genuine absence or a process restart, and
   * both must land in `break`: after a restart the reaper has written
   * `offline`, and before one the row may say `available`, so no row-derived rule
   * is safe. `break` is the one answer that is correct in every case — the agent
   * chooses to go available, and nothing dials into them until they do.
   *
   * ── The soft phone (docs/softphone.md §2, §4.1) ─────────────────────────────
   * A soft-phone session, or a campaign session whose row is on the `soft_phone`
   * break, rehydrates through `AgentStateMachine.rehydrateSoftphone`: a lapsed or
   * `offline` lease becomes `break` and the row keeps `break_reason = soft_phone`
   * (the plain path below would null it), the session is marked soft-phone in
   * Redis (never `available`), and a call it still holds — live, or awaiting its
   * outcome — re-claims the `manual` field, so the guard on `available` holds
   * again after a lease lapsed.
   *
   * **The unsettled call alone makes a session soft-phone flavoured**, whatever
   * its row's `kind` and `break_reason` say. The `manual` field is the guard on
   * `available`, and it lives in the lease: a lease that lapsed while an outcome
   * was owed took it, and a row whose break reason was lost (an `offline` write
   * from an older build, a restart) must not be the gap through which the plain
   * path below rehydrates the session as an ordinary break and the agent goes
   * `available` with a soft-phone outcome owed. So the session's unsettled call is
   * read on every rehydrate, not only for a row already known to be on the soft
   * phone.
   *
   * @param session The row the caller already read (the join and the station
   *   socket both have). Its `kind` and `break_reason` say whether the soft-phone
   *   path applies (as does an unsettled call); its `state` is still never
   *   consulted. Omitted, only the unsettled call can make it soft-phone flavoured.
   */
  async rehydrateAgent(
    sessionId: string,
    session?: Pick<AgencyAgentSessionRecord, 'kind' | 'break_reason'> & Partial<Pick<AgencyAgentSessionRecord, 'away_ring_since'>> | null,
  ): Promise<AgencyAgentState> {
    const row = session ?? null;
    // ── An inbound call's outcome owed (docs/inbound.md §2, "Server restart") ─────────
    // The session's unsettled inbound call is the authority: one that ended after it bridged
    // owes its outcome, so the session lands in `break` (or keeps a live state) with the
    // `inbound` field re-claimed, and `available` stays refused until the outcome is saved or
    // lapses. A call still offered or connected in this process is the connector's (a station
    // blip): Redis is left as it is. A field naming no unsettled call is stale and cleared.
    const inboundState = await this.rehydrateInboundOf(sessionId);
    if (inboundState) return inboundState;
    const unsettled = await Promise.resolve()
      .then(() => agencyManualCallRepository.findUnsettledForSession(sessionId)).catch((err) => {
        log.warn({ err, sessionId }, 'Could not read the session\'s soft-phone call to rehydrate');
        return null;
      });
    const softphoneFlavoured = unsettled !== null
      || (!!row && (row.kind === 'softphone' || row.break_reason === SOFTPHONE_BREAK_REASON));
    if (softphoneFlavoured) {
      const rehydrated = await this.agents.rehydrateSoftphone(sessionId, {
        softphoneSession: row?.kind === 'softphone',
        unsettledManualCallId: unsettled?.id ?? null,
      });
      if (rehydrated) {
        // Mirrored when the lease was rewritten, and also when the row had lost its
        // soft-phone reason (an unsettled call found it): the bootstrap's
        // `on_softphone` and the return route read the row.
        if (rehydrated.changed || (rehydrated.state === 'break' && row?.break_reason !== SOFTPHONE_BREAK_REASON)) {
          await agencyAgentSessionRepository.setState(sessionId, 'break', SOFTPHONE_BREAK_REASON)
            .catch((err) => log.warn({ err, sessionId }, 'Could not mirror rehydrated agent state'));
        }
        return rehydrated.state;
      }
      // Redis could not answer: fall through to the plain rule, which also fails
      // toward `break`.
    }
    const live = await this.agents.get(sessionId);
    // ── A wrap-up this replica still holds comes back as `wrapup` ───────────────
    //
    // The countdown is in-process and survives a socket drop, but the close wrote the
    // agent `offline` (`releaseStationOnClose`: no live attempt), and a lease that then
    // lapsed would land them in `break` below. Either way Redis no longer said `wrapup`
    // while the wrap-up (and its outcome pad, and its Redial) was still on screen: the
    // first Redial after a reconnect lost its `wrapup → reserved` CAS and was refused,
    // and the agent was announced `offline`/`break` mid write-up. Restored only over
    // `offline` or nothing, never over a state something else wrote (pacing never
    // reserves from either, so no call can have been placed on this agent meanwhile).
    const wrapup = this.wrapup.stateFor(sessionId);
    if (wrapup && (!live || live.state === 'offline')) {
      await this.agents.set(sessionId, 'wrapup', { attemptId: wrapup.attempt_id, leaseMs: AGENT_LEASE_MS.wrapup });
      await agencyAgentSessionRepository.setState(sessionId, 'wrapup')
        .catch((err) => log.warn({ err, sessionId }, 'Could not mirror rehydrated agent state'));
      return 'wrapup';
    }
    // A `wrapup` lease nothing here holds (no wrap-up in this process, no inbound outcome owed:
    // the inbound arm above answered for that) was left by a previous process. Nothing would
    // ever end it, and the heartbeat does not renew it (`heartbeatLeaseMs`), so it is a lapsed
    // lease that has not lapsed yet: `break`, as below.
    const orphanedWrapup = live?.state === 'wrapup' && !wrapup && !live.inboundCallId;
    // ── Mode B: the agent is back from `away_ring` (N5) ─────────────────────────────────
    // A station attaching (or a join) over `break, ring = 1` is the agent opening the app: the
    // absence is over, so `away_ring` ends as `device_away` (the station is about to show it; the
    // app's return sends `/available`). Only on `break`: an attach during a ring or an accepted
    // ring finds `reserved` (the reservation cleared `ring`), and that is the connector's.
    //
    // The caller's row is told the agent is back only when the end happened. Any other outcome
    // (Redis did not answer, a ring got there first, something else moved the key) leaves the
    // answer to Redis, read again: the session may still be on `away_ring` (and the row says so,
    // so the agent is not told otherwise), or a ring holds it (`reserved`: the connector's attach
    // path decides, N5). `since` is Redis's either way: the end keeps the absence's start (IQ76).
    let current: AgentLiveState | null = live;
    if (live?.state === 'break' && live.ring) {
      const ended = await this.awayRing.endOnReturn(sessionId, row?.away_ring_since).catch((err: unknown) => {
        log.warn({ err, sessionId }, 'Could not end away-ring on the agent\'s return');
        return 'unavailable' as const;
      });
      if (ended === 'ended') {
        returnFromAwayRing(row);
        return 'break';
      }
      current = await this.agents.get(sessionId);
      log.info({ sessionId, outcome: ended, state: current?.state ?? null, ring: current?.ring ?? null },
        'Away-ring not ended on the agent\'s return; answered from Redis');
      if (current) {
        // Something else ended the absence meanwhile (a break with no `ring`): the agent is back.
        if (current.state === 'break' && !current.ring) returnFromAwayRing(row);
        return current.state;
      }
      // No key now: the lapsed-lease rule below, as for a key that was never there.
    }
    if (current && !orphanedWrapup) return current.state;

    // A row still on an absence whose key lapsed (its maximum age, or a re-seed not run yet) comes
    // back as `device_away` (the agent is on screen, and `break` with no `ring` is not `away_ring`),
    // keeping the absence's start as `since`, as every end of `away_ring` does.
    const absenceSince = !softphoneFlavoured ? row?.away_ring_since ?? null : null;
    if (absenceSince) trackAwayRingEnded('returned');
    // The break the mirror is written with below, in Redis too: the session row's reason is the one
    // durable record of which break a lapsed lease was on.
    const breakReason = softphoneFlavoured ? SOFTPHONE_BREAK_REASON : absenceSince ? DEVICE_AWAY_BREAK_REASON : row?.break_reason ?? null;
    await this.agents.set(sessionId, 'break', {
      leaseMs: AGENT_LEASE_MS.break,
      breakReason,
      ...(absenceSince ? { sinceMs: absenceSince.getTime() } : {}),
    });
    returnFromAwayRing(row);
    // Best-effort mirror. Redis is the authority; a failed write here costs a
    // durable record, never correctness. The caller's row keeps its break reason:
    // a phone Android killed while paused (`device_away`) or on a named break comes
    // back to that break, not an unnamed one (`ready` and the bootstrap carry it).
    await (softphoneFlavoured
      ? agencyAgentSessionRepository.setState(sessionId, 'break', SOFTPHONE_BREAK_REASON)
      : agencyAgentSessionRepository.setState(sessionId, 'break', absenceSince ? DEVICE_AWAY_BREAK_REASON : row?.break_reason ?? null,
        { stateSince: absenceSince }))
      .catch((err) => log.warn({ err, sessionId }, 'Could not mirror rehydrated agent state'));
    return 'break';
  }

  /**
   * {@link rehydrateAgent}'s inbound arm: the state to come back in when the session owes an
   * inbound call's outcome, else null (and a stale `inbound` field cleared).
   */
  private async rehydrateInboundOf(sessionId: string): Promise<AgencyAgentState | null> {
    const owed = await Promise.resolve()
      .then(() => agencyInboundCallRepository.findUnsettledForSession(sessionId)).catch((err) => {
        log.warn({ err, sessionId }, 'Could not read the session\'s inbound call to rehydrate');
        return undefined;
      });
    if (owed === undefined) return null;
    if (owed && owed.state === 'ended' && owed.bridged_at !== null) {
      const rehydrated = await this.agents.rehydrateInbound(sessionId, owed.id);
      if (!rehydrated) return null;
      if (rehydrated.changed) {
        await agencyAgentSessionRepository.setState(sessionId, 'break')
          .catch((err) => log.warn({ err, sessionId }, 'Could not mirror rehydrated agent state'));
      }
      return rehydrated.state;
    }
    if (owed) return null; // offered or connected: the connector's
    const held = await this.agents.get(sessionId);
    if (held?.inboundCallId && !this.inbound?.findCallForSession(sessionId)) {
      log.warn({ sessionId, inboundCallId: held.inboundCallId }, 'Stale inbound claim on a reconnecting session — clearing it');
      await this.agents.releaseInbound(sessionId, held.inboundCallId);
    }
    return null;
  }

  /**
   * Resolve an agent's presence when their station socket closes. Returns whether
   * they were written `offline`.
   *
   * `false` means the drop happened **mid-attempt** and the deferred hangup now
   * owns the outcome. Writing `offline` there would clear the `on_call` lease's
   * attempt binding, so the owning replica's state-matched renewal starts failing
   * and the lease lapses — and the agent's own reconnect, moments later, would
   * find nothing to resume onto. Re-attach restores them; expiry ends the call and
   * reaches `releaseAgent`, which writes `offline` there because the socket is
   * gone. Either way the agent is undialable in the meantime, because `on_call` is
   * not `available`.
   */
  async releaseStationOnClose(sessionId: string, ws?: WebSocket): Promise<boolean> {
    // Before the early return, because the return is the whole problem for an
    // unbound dial: the premise documented above — "the deferred hangup now owns
    // the outcome" — is true only once a browser leg is bound. During the ring
    // there is no browser leg and nothing is watching, so a station that stays
    // gone would let the dial run to a carrier answer and become an ABANDONED
    // call against the 3% ceiling. This arms the pre-bind grace that early binding
    // already gets from the bridge; it is a no-op for every announced attempt.
    this.dialer.noteStationClosed(sessionId);
    if (this.dialer.hasLiveAttempt(sessionId)) return false;
    // The same rule for a live soft-phone call: the station socket is its media leg,
    // and the bridge's grace (after the answer) or its immediate hangup (before)
    // owns the outcome.
    if (this.manualDialer.hasLiveCall(sessionId)) return false;
    // And for an inbound call whose audio is bound to this socket (docs/inbound.md §2, "The
    // station drops after the bind"): the bridge's deferred hangup decides, as for a campaign call.
    if (this.inbound?.hasLiveCall(sessionId)) return false;
    // ── BELT AND BRACES: THE SUPERSEDE GATE, RE-ASKED AT THE WRITE ──────────
    //
    // The close handler's own `socketFor` check might look as though it races this
    // method's awaits — a replacement attaching mid-flight being written
    // `offline` moments after reporting `available`. **It does not race, and the
    // reason is worth writing down because it is invisible from the call site:**
    // that read, the `superseded` test, this call, `hasLiveAttempt`, the read
    // below and `agents.set`'s `redis.eval` are ALL one synchronous run. Calling
    // an async function runs its body to its first `await`, and the first await
    // on this path IS the eval. Nothing can interleave between the decision and
    // the write being issued, so no `attach` can land in it.
    //
    // What lands during the write's FLIGHT is harmless: Redis applies commands
    // per connection in issue order, so a replacement's `rehydrateAgent` reads
    // our `offline` rather than racing it, and its own `ready` then corrects the
    // console. Stale by one frame, not stomped.
    //
    // So this read is unreachable by construction today, and it is here anyway
    // because that construction is ONE `await` away from being false and nothing
    // else would notice. Put an await anywhere above this line — inside
    // `hasLiveAttempt`, in the close handler between its read and this call, at
    // the top of this method — and that presence stomp is live
    // again, in a window no test covers and no type checks. It is a guard against
    // a future edit, not against a schedule, which is why the test that holds it
    // calls this method directly: through the route it cannot be reached.
    //
    // The genuine residual is cross-replica: a replacement attaching on ANOTHER
    // replica is invisible to this in-process Map. Pre-existing, arbitrated by
    // the station ownership key, not narrowed here.
    //
    // `ws` is optional exactly as on `detach`/`heartbeat`/`send`, so a caller
    // holding only a session id keeps the old behaviour.
    const holder = this.stations.socketFor(sessionId);
    if (ws !== undefined && holder !== undefined && holder !== ws) return false;
    // An inbound call on offer whose audio has not bound goes back to the head of the queue
    // (docs/inbound.md §5.1). Synchronous: the cancel runs on the call's own chain, so nothing
    // is awaited between the supersede read above and the write below.
    this.inbound?.onStationClosed(sessionId);
    // ── Mode B: the decision is ONE script, and it is still the first await (IQ67) ──────
    // `offline`, unless the session is on `away_ring` (the app parked its socket on purpose: the
    // phone rings for inbound callers with no socket) or holds a push offer (an answered ring
    // keeps its accept grace across a socket drop). `holdsPushOffer` is the connector's
    // synchronous answer, read here with nothing awaited, and the script reads `ring` and
    // `inbound` in the same step as the write, so no ring CAS can land between the decision and
    // the write.
    const holdsPushOffer = this.inbound?.holdsPushOffer(sessionId) ?? false;
    const wrote = await this.agents.setOfflineUnlessAway(sessionId, holdsPushOffer);
    if (wrote.outcome === 'kept') return false;
    await agencyAgentSessionRepository.setState(sessionId, 'offline')
      .catch((err) => log.warn({ err, sessionId }, 'Could not mirror offline agent state'));
    return true;
  }

  // ─── The heartbeat grace ─────────────────────────────────────────────

  /**
   * Act on every station whose client heartbeat has lapsed past its grace: close it
   * if it is still open, detach it if the socket is already gone. Returns how many
   * were acted on.
   *
   * `heartbeat_grace_ms` has been advertised in the bootstrap contract since the
   * contract landed and was enforced by nothing: `lastSeen` was written at attach
   * and on every ping and read nowhere, and no sweep existed. A socket whose
   * client-side heartbeat timer had been orphaned therefore stayed attached
   * **forever** — `isLocallyOwned` answering true, so `POST /sessions/:id/available`
   * kept succeeding on it — while the Redis ownership key that heartbeat renews had
   * expired thirty seconds in. The agent's console looked connected, the pacing
   * tick could not dial them, and there was no event that would ever make either
   * side notice. Closing the socket is what turns that into a reconnect.
   *
   * Two rules decide what is safe to close, and both are about not curing a
   * diagnostic with an outage:
   *
   * 1. **Never a socket that is mid-attempt** (one exception for a phone, below). This socket IS the media leg,
   *    and media frames do not renew `lastSeen` — only `ping` does — so a console
   *    whose heartbeat timer died while its audio kept flowing is exactly the shape
   *    that would be closed here. That would put a live customer on silence and arm
   *    the deferred hangup, on the strength of a timer the *client* stopped. The
   *    guard is `dialer.hasLiveAttempt`, the same authority
   *    {@link releaseStationOnClose} uses and the one that spans `dialing` through
   *    the deferred-hangup window. An agent in wrap-up has no live attempt and IS
   *    closable: the call is already over and `ready` will restore their countdown.
   * 2. **Never a web socket that is already CLOSING.** `close()` starts a handshake and
   *    the entry stays in the registry until `close` fires, so an unguarded sweep
   *    would re-close and re-log the same socket every tick and never go dormant. (A
   *    phone is terminated instead, CLOSING or not: below.)
   *
   * A socket that is already **CLOSED** is the third case, and it is the only one
   * this sweep acts on by detaching rather than closing. The rule above used to be
   * written as `readyState !== 1`, which folded CLOSED in with CLOSING and is what
   * made a lost `close` event *unrecoverable*: the station route registered its
   * `close` handler below every setup await, `ws` buffers nothing for an event with
   * no listener, and `close` is emitted once — so a close inside that window left
   * an entry that `detach` (the registry's only `delete` caller) would never be
   * asked to remove, `isLocallyOwned` answering true forever and `stations.size()`
   * never returning to zero, so this sweep could not even go dormant. The route now
   * registers that handler before the awaits, which leaves one window — a close
   * during `verifyAndConsume`, before there is a listener at all — so this arm
   * should be unreachable in practice. It logs at **warn** for exactly that reason:
   * if it ever fires, the route's registration has a hole.
   *
   * It **detaches** rather than re-closing, because closing a socket that is
   * already CLOSED cannot produce the `close` event the entry is waiting for.
   * Detach is what stops `isLocallyOwned` lying, and it drops the Redis ownership
   * key, which is what the dial path actually consults.
   *
   * It deliberately does **not** release the agent, and there is no race to worry
   * about in either direction. No race: `ws` sets CLOSED as it emits `close`, in
   * one synchronous step, and this sweep runs on a timer — so a CLOSED entry means
   * that event has already been emitted and nothing further is coming. No release:
   * detach removes them from the dial path immediately, and their `available` /
   * `break` lease is renewed only by the station heartbeat, so with no station it
   * lapses on its own within {@link AGENT_LEASE_MS}. Writing `offline` from here
   * would be the sweep claiming a responsibility that belongs to the close handler,
   * for no gain over a lease that expires anyway.
   *
   * `ws` emits `close` off its own closing timeout even when the peer never
   * answers, so a wedged socket still reaches its handler and the CLOSED arm stays
   * a backstop. That timeout is **30 s**: a `close()` on a dead transport leaves the
   * entry CLOSING, still attached and `isLocallyOwned`, for that long. For the web
   * console that is acceptable (its silence may be a stalled timer on a live socket,
   * and the close frame lets it re-mint at once); for a phone it is not, see below.
   *
   * ── The grace is per station ──────────────────────────────────────────────
   *
   * Each entry is held to its own client kind's grace ({@link stationGraceFor}): 30s
   * for the web console, unchanged, and `MOBILE_STATION_HEARTBEAT_GRACE_MS` (10s) for
   * the mobile app, whose `lastSeen` is also renewed by protocol pongs (the registry's
   * probe). A number passed in applies to every entry, as it always did.
   *
   * ── How the mobile probe and rule 1 interact ──────────────────────────────
   *
   * Rule 1 exists because on the web "silent" can be a lie: the console's heartbeat is
   * an app timer, audio does not renew `lastSeen`, so a socket can be carrying a live
   * conversation while it looks silent. On a mobile station that lie is much rarer:
   * the pong is answered by the client's WebSocket stack whenever the transport and
   * the process are alive, so a mobile station mid-call that is silent past 10s is
   * almost certainly a dead transport or a suspended app, not a stalled timer.
   *
   * So rule 1 has one exception, for a phone only (decision M1): a mobile station silent
   * past its grace on a call the agent can see is dropped (`terminate`). The sweep still
   * does not decide the call is over: dropping the socket is exactly a network drop, and
   * the bridge's deferred hangup (8 s) decides, so a phone that comes back in time
   * resumes the call. Without it, a suspended app or a dead transport left the customer
   * on silence until TCP gave up. An unbound dial still gets its pre-bind grace armed
   * here, exactly as on the web: that is the case that otherwise becomes an abandoned
   * call.
   *
   * The same holds on a live soft-phone call (`manualDialer.hasLiveCall`), whose leg is
   * bound to this socket before the dial, so there is no pre-bind case. The close the
   * terminate produces meets the bridge's rule for a manual leg: before the answer it
   * hangs up at once, after it the 8 s deferred hangup decides and a phone back in time
   * re-adopts the leg. A web console on a live soft-phone call is never closed, as on a
   * campaign call.
   *
   * And on a live inbound call (`inbound.hasLiveCall`: the session holds a call whose
   * caller's audio is bound): dropped the same way, and the bridge's 8 s deferred hangup
   * decides as for a campaign call (IQ17). The audio is bound to this socket when a phone that
   * declared `caps=inbound` took the call (IQ46); an older build that took the session over
   * mid-call holds it only until that hangup ends it, its socket never bound (the call is not
   * re-adopted onto it), so dropping it changes nothing for the call. An inbound offer not yet
   * bound is not a call: the idle arm drops the phone and the close cancels the offer (the
   * caller back at the head of the queue, §5.1).
   *
   * ── A silent phone is always dropped with `terminate`, never `close` ──────────
   *
   * On a call and off one alike ({@link dropSilentPhone}). A phone silent past 10 s is
   * almost always a dead transport, and on a dead transport `close(4408)` gets no
   * answer: the entry would sit CLOSING for ws's 30 s closing timeout, still
   * `isLocallyOwned`, so pacing kept admitting the agent and every tick reserved them,
   * claimed a contact, inserted an attempt that `dispatch` then refused (the socket is
   * not OPEN), wrote it `orphaned` and released the agent `available` again — several
   * orphaned attempt rows a second per phone, each one bumping the contact's
   * attempt_number. `terminate` destroys the transport, so `close` follows at once and
   * the station's close handler detaches it and resolves presence. The app treats any
   * close as a reconnect, so it loses nothing the 4408 told it. A CLOSING phone is
   * terminated too, for the same reason. So an `available` phone that stops answering
   * leaves the pool 10–15 s after its last sign of life, instead of 30–40 s, which is the
   * window in which a customer could be bridged to it.
   */
  sweepSilentStations(
    graceMs: number | ((entry: Parameters<typeof stationGraceFor>[0]) => number) = stationGraceFor,
    now = Date.now(),
  ): number {
    let acted = 0;
    for (const entry of this.stations.silentSince(graceMs, now)) {
      // Rule 1, and it guards the detach arm as well as the close arm: an attempt
      // still in its deferred-hangup window is the reaper's to resolve, and
      // dropping the ownership key from under it would remove the very exclusion
      // that keeps the reaper off a call the agent is about to get back. A leak
      // held for the length of one attempt is bounded — `hasLiveAttempt` goes false
      // when the attempt settles and the next tick detaches it.
      // ⚠️ …but rule 1's premise is FALSE before the bind, and this is the only
      // place that sees a socket which died without a close frame — the ordinary
      // shape of a dropped mobile connection. The "deferred-hangup window" it
      // defers to is `hangUpForBrowserClose`, installed on the BROWSER socket, and
      // an unbound dial has none: this socket is not the media leg, because there
      // is no media leg yet. Skipping unconditionally therefore left an OPEN
      // zombie socket holding a ringing dial that nothing would ever end, until
      // the carrier answered and `abandonAnsweredCall` charged it against the 3%
      // ceiling.
      //
      // So the grace is armed here rather than the entry skipped. The rest of rule
      // 1 still applies — the entry is left attached and the ownership key intact,
      // because the reaper exclusion it provides is exactly what must not be
      // dropped from under an attempt that may still bind.
      if (this.dialer.hasLiveAttempt(entry.sessionId)) {
        // The one exception (decision M1): a phone silent past its grace on a call the
        // agent can see is dropped, so the bridge's deferred hangup starts now instead of
        // the customer waiting on silence until TCP gives up. `terminate`, not `close`:
        // on a dead transport `close` emits `close` only after ws's 30 s closing timeout,
        // and that event is what arms the deferred hangup. A pre-bind dial falls through
        // to its own grace below; once it binds, the next tick lands here.
        if (entry.clientKind === 'mobile' && !this.dialer.hasUnannouncedAttempt(entry.sessionId)
          && entry.ws.readyState !== 3 /* CLOSED */) {
          this.dropSilentPhone(entry, now, 'on_call');
          acted++;
          continue;
        }
        this.dialer.noteStationClosed(entry.sessionId);
        continue;
      }
      // A live soft-phone call: this socket IS its media leg (bound before the dial,
      // so there is no pre-bind case), and rule 1 holds as written for the web. A
      // phone gets the same M1 exception as a campaign call: dropped with `terminate`,
      // so the station's close handler runs now and the bridge's own close rule
      // decides the call — an immediate hangup before the answer, the 8 s deferred
      // hangup after it. `releaseStationOnClose` leaves presence alone while the call
      // is live, and a phone back in time re-adopts the leg (`reattachStation`).
      if (this.manualDialer.hasLiveCall(entry.sessionId)) {
        if (entry.clientKind === 'mobile' && entry.ws.readyState !== 3 /* CLOSED */) {
          this.dropSilentPhone(entry, now, 'on_manual_call');
          acted++;
        }
        continue;
      }
      // A live inbound call (docs/inbound.md §2): rule 1 as written for the web. A phone gets the
      // campaign call's M1 exception (one that took it declared `caps=inbound`, IQ46; an older
      // build that took the session over mid-call is never bound to it, see the doc comment):
      // dropped with `terminate`, so the bridge's 8 s deferred hangup starts now (a phone back in
      // time re-adopts the leg; else the call ends `answered`, its outcome owed, IQ17) instead of the
      // caller waiting on silence until TCP gives up. An offer not yet bound is not a live call: it
      // falls through to the idle arm below, whose close cancels it (back to the head of the queue).
      if (this.inbound?.hasLiveCall(entry.sessionId)) {
        if (entry.clientKind === 'mobile' && entry.ws.readyState !== 3 /* CLOSED */) {
          this.dropSilentPhone(entry, now, 'on_inbound_call');
          acted++;
        }
        continue;
      }

      if (entry.ws.readyState === 3 /* CLOSED */) {
        log.warn({
          sessionId: entry.sessionId,
          campaignId: entry.campaignId,
          silentForMs: now - entry.lastSeen,
        }, 'Station socket is closed but still attached — detaching it');
        // Synchronous where it counts: `detach` removes the map entry before its
        // first await, so `isLocallyOwned` stops lying on this tick. Fire-and-forget
        // for the ownership-key delete only, and caught because an unhandled
        // rejection exits the process.
        void this.stations.detach(entry.sessionId, entry.ws).catch((err) =>
          log.warn({ err, sessionId: entry.sessionId }, 'Failed to detach a closed station'));
        acted++;
        continue;
      }

      // A phone, OPEN or CLOSING: `terminate`, never `close` — see the doc comment.
      // `close` here would hold the entry CLOSING (and the agent dialable) for 30 s.
      if (entry.clientKind === 'mobile') {
        this.dropSilentPhone(entry, now, 'idle');
        acted++;
        continue;
      }

      // Rule 2 (the web): CLOSING (and a socket somehow still CONNECTING) is left alone.
      if (entry.ws.readyState !== 1 /* OPEN */) continue;

      log.warn({
        sessionId: entry.sessionId,
        campaignId: entry.campaignId,
        clientKind: entry.clientKind,
        silentForMs: now - entry.lastSeen,
      }, 'Station heartbeat lapsed past its grace — closing the socket');
      // 4408: re-mint and retry, exactly as 4401 is. The console must come back.
      try { entry.ws.close(AGENCY_STATION_CLOSE.HEARTBEAT_TIMEOUT, 'station_heartbeat_timeout'); } catch { /* already gone */ }
      acted++;
    }
    return acted;
  }

  /**
   * Drop a mobile station silent past its grace: `terminate`, which destroys the
   * transport, so `ws` emits `close` at once and the station's close handler detaches
   * the entry and resolves presence (or, on a call, the bridge's close rule decides it).
   * Never `close()`: on a dead transport its `close` event waits out ws's 30 s closing
   * timeout. One place for every arm (on a campaign, soft-phone or inbound call, decision
   * M1; and idle), so they cannot drift apart.
   */
  private dropSilentPhone(
    entry: StationEntry,
    now: number,
    during: 'on_call' | 'on_manual_call' | 'on_inbound_call' | 'idle',
  ): void {
    log.warn({
      sessionId: entry.sessionId,
      campaignId: entry.campaignId,
      clientKind: entry.clientKind,
      silentForMs: now - entry.lastSeen,
      during,
    }, during === 'on_call'
      ? 'Mobile station silent past its grace on a live call — terminating it; the deferred hangup now decides the call'
      : during === 'on_manual_call'
        ? 'Mobile station silent past its grace on a live soft-phone call — terminating it; the bridge now ends the call, or after the answer its deferred hangup decides'
        : during === 'on_inbound_call'
          ? 'Mobile station silent past its grace on a live inbound call — terminating it; the deferred hangup now decides the call'
          : 'Mobile station silent past its grace — terminating it');
    try { entry.ws.terminate(); } catch { /* already gone */ }
  }

  /**
   * Arm the silent-station sweep. Called after every station attach.
   *
   * Demand-driven and self-dormant, the same shape as the telephony guard host's
   * self-heal poll (`telephony-guard-host.ts`). The dormancy condition is a pass that closed
   * nothing **and** found no stations at all, twice over — not merely an idle pass:
   * a healthy station can fall silent at any moment, and its attach has already
   * happened, so nothing would re-arm the timer.
   */
  wakeStationSweep(): void {
    this.stationSweepIdlePasses = 0;
    if (this.stationSweepTimer) return;
    // Armed in the runtime's own context, not the caller's (an upgrade request): see
    // `ownScope`. A timer keeps the async context it was created in.
    this.stationSweepTimer = this.ownScope.runInAsyncScope(() => setInterval(() => {
      let acted = 0;
      try {
        acted = this.sweepSilentStations();
      } catch (err) {
        // A sweep that throws must not take the timer down with it.
        log.warn({ err }, 'Silent-station sweep failed');
        this.stationSweepIdlePasses = 0;
        return;
      }
      if (acted > 0 || this.stations.size() > 0) {
        this.stationSweepIdlePasses = 0;
        return;
      }
      if (++this.stationSweepIdlePasses >= STATION_SWEEP_IDLE_PASSES_BEFORE_DORMANT) {
        this.stopStationSweep();
      }
    }, STATION_HEARTBEAT_SWEEP_MS));
    this.stationSweepTimer.unref?.();
  }

  stopStationSweep(): void {
    if (this.stationSweepTimer) clearInterval(this.stationSweepTimer);
    this.stationSweepTimer = null;
  }

  /** Whether the sweep timer is currently armed. */
  isStationSweepArmed(): boolean {
    return this.stationSweepTimer !== null;
  }

  /**
   * A media worker's start (`docs/scaling.md` §1.3): the dialer and the soft phone's
   * dialer listen to the bridge, and nothing else starts. No startup reap (the primary
   * ran it before any worker existed; a startup reap here would end every other worker's
   * live calls), no reaper, no pacing, no metric refreshes: those run once, in the primary.
   */
  startShard(): void {
    this.dialer.start();
    this.manualDialer.start();
    log.info({ replicaId: this.replicaId }, 'Agency dialer runtime started as a media worker shard');
  }

  /** A media worker's stop: the shard's timers only (agents are not returned to the pool). */
  async stopShard(): Promise<void> {
    this.stopStationSweep();
    this.dialer.stop();
    this.manualDialer.stop();
    this.wrapup.stop();
    log.info('Agency dialer runtime shard stopped');
  }

  async start(): Promise<void> {
    this.dialer.start();
    this.manualDialer.start();
    await this.reaper.reapOnStartup();
    this.reaper.start();
    this.pacing.start();
    // The compliance window. Published on a timer because it is
    // read from the table, which is also what makes it correct across a restart —
    // and it is refreshed **once immediately**, not only on the first tick, so a
    // freshly booted replica does not serve an empty rate for a whole interval
    // while the guardrail is reading it.
    this.abandonmentMetrics = startAbandonmentMetricsRefresh(ABANDONMENT_REFRESH_MS);
    void refreshAbandonmentWindow().catch((err) =>
      log.warn({ err }, 'Initial abandonment window refresh failed — the timer will retry'));
    // The dialer's live-concurrency signal. Refreshed once immediately for a different
    // reason than the abandonment window: nothing reads this in process, so an
    // empty first interval costs no decision — but the series would be ABSENT
    // rather than zero for 15s after every deploy, and "the dialer is exporting
    // nothing" is exactly the shape of the staleness alarm this family is meant to
    // make meaningful. Publishing at boot keeps absence attributable to a failing
    // read rather than to a rollout.
    this.liveConcurrencyMetrics = startLiveConcurrencyRefresh(AGENCY_LIVE_CONCURRENCY_REFRESH_MS);
    void refreshLiveConcurrency().catch((err) =>
      log.warn({ err }, 'Initial agency live-concurrency refresh failed — the timer will retry'));
    log.info({ replicaId: this.replicaId }, 'Agency dialer runtime started');
  }

  async stop(): Promise<void> {
    // Pacing stops FIRST. `stop()` waits (bounded, `TICK_DRAIN_TIMEOUT_MS`) for any
    // tick already in flight, and every dial site re-checks the engine before it
    // dials, so no tick dials while the rest of the runtime is coming down; a tick
    // that outlives the bound is logged and can only finalize, never dial.
    await this.pacing.stop();
    this.reaper.stop();
    this.stopStationSweep();
    this.abandonmentMetrics?.stop();
    this.abandonmentMetrics = null;
    // Timer only, and the snapshot is deliberately NOT cleared: the process is on
    // its way out, and a final scrape reporting the last known floor is more useful
    // than one reporting nothing. Its own TTL bounds how long that can be believed
    // if the process somehow lingers.
    this.liveConcurrencyMetrics?.stop();
    this.liveConcurrencyMetrics = null;
    this.dialer.stop();
    this.manualDialer.stop();
    // Timers only — agents are NOT returned to the pool here. Their sockets die
    // with the process and a restart lands them in `break` on reconnect, so returning
    // them to `available` on the way out would be a lie the next boot inherits.
    this.wrapup.stop();
    // Station sockets are closed by the HTTP server's own shutdown; agents
    // rehydrate into `break` on reconnect, never `available`.
    log.info('Agency dialer runtime stopped');
  }
}
