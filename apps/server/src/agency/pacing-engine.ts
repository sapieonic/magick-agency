import type Redis from 'ioredis';
import { createChildLogger } from '@magick-agency/observability';
import { accountSettingsRepository } from '@magick-agency/db/repositories/account-settings.repository';
import {
  agencyAgentSessionRepository,
  agencyAttemptRepository,
  agencyCampaignRepository,
  agencyContactRepository,
} from '../db/repositories/agency.repository.js';
import type { AgencyCampaignRecord, AgencyContactRecord } from '../db/models/agency.model.js';
import type { AgencyOwnerClaimMode } from '../db/repositories/agency.repository.js';
import type { AgencyStationQueueFrame, AgencyStationServerFrame } from '@magick-agency/contracts/agency';

/**
 * What pacing needs from wherever the agents' station sockets are held: whether a
 * session's station is attached where this engine can have it dialled, which replica owns
 * it, its campaign, and a frame to every station on a campaign. `StationRegistry`
 * satisfies it in a single process. With media workers (`docs/scaling.md` §3.1) the
 * primary's directory of the workers' stations does: "locally owned" then means "attached
 * to a live worker", and the broadcast goes to every worker.
 *
 * `send` is one frame to one agent's station (the contact-assignment `queue` frame): true when
 * it was handed to a station that is there. With media workers it is forwarded to the worker
 * holding the station, and true means "a live worker holds it".
 */
export interface PacingStations {
  isLocallyOwned(sessionId: string): boolean;
  ownerOf(sessionId: string): Promise<string | null>;
  get(sessionId: string): { campaignId: string | null } | undefined;
  broadcast(campaignId: string, frame: AgencyStationServerFrame): number;
  send(sessionId: string, frame: AgencyStationServerFrame): boolean;
}

/**
 * How a reserved agent pacing could not use goes back: to the pool, or to the break they
 * queued meanwhile. In a single process the engine does it itself from the registered
 * {@link PacingEngine.registerQueuedBreakRelease}; with media workers the queued break
 * lives in the worker holding the agent, so the primary hands the whole decision there.
 */
export interface ReservedReturn {
  returnReserved(sessionId: string): Promise<void>;
}

/**
 * Told when the engine withdraws dial authority: one campaign's leadership given up
 * (`campaignId`, every grant up to `upTo`), or the engine stopping (`campaignId` null).
 * A media worker's synchronous `stillAuthorised` is built from these.
 */
export type AuthorisationRevokedListener = (campaignId: string | null, upTo: number) => void;
import type { AgentStateMachine } from './agent-state-machine.js';
import type { DialDispatcher } from './dial-dispatcher.js';
import { campaignChangeReasonFor } from './outcome-classifier.js';
import type { AgencyCampaignChangeReason, AgencyCampaignStatus } from '@magick-agency/contracts/agency';
import type { DncRegistry } from './dnc-registry.js';
import { evaluatePreDialGates, type PreDialDecision } from './pre-dial-gates.js';
import {
  agencyPacingMissedWakeupsTotal,
  agencyPacingTicksTotal,
  agencyPreDialGateTotal,
  agencyTickIdleTotal,
} from '@magick-agency/observability/metrics/agency';
import { safeEmit } from '../utils/safe-emit.js';
import { LeaderLease, LEADER_RENEW_MS } from './pacing/leader-lease.js';
import { InFlight } from './pacing/in-flight.js';
import { pickCallerId, usableCallerIds } from './pacing/caller-id-pool.js';
import { CampaignAnnouncer } from './pacing/campaign-announcer.js';
import {
  getPacingInvalidationBus,
  publishPacingInvalidation,
  type PacingInvalidationBus,
  type PacingInvalidationEvent,
} from './pacing/invalidation-bus.js';
import { GenerationTtlCache } from './pacing/read-cache.js';
import { PacingRound, accountKeyOf } from './pacing/round.js';
import { getFeatureFlagService, FLAGS } from '../feature-flags/index.js';
import { auditLogger } from '../audit/audit-logger.js';
import { ownerModeOf, queueStateKey, readAgentQueues, type AgentQueueReading } from './pacing/agent-queue.js';
import { CALLBACK_FALLBACK_SWEEP_MS, sweepCallbackFallback, sweepUnstaffedOwners } from './pacing/callback-fallback.js';

const log = createChildLogger({ component: 'agency-pacing-engine' });

/** How often the leader evaluates a campaign (one ROUND over every campaign it leads). */
export const TICK_INTERVAL_MS = 250;

/**
 * The longest a QUIESCENT campaign goes without a full tick. A campaign whose last
 * full tick could reserve nothing (no agent available, no account slot, no caller
 * IDs, not running) is skipped — no database, no Redis — until an invalidation
 * event wakes it (`pacing/invalidation-bus.ts`) or this much time has passed. The
 * bound on what a lost event can cost; `agency_pacing_missed_wakeups_total` counts
 * the safety ticks that found work.
 */
export const PACING_SAFETY_TICK_MS = 1_000;

/**
 * How long a cached campaign row or account limit may be served without an
 * invalidation. The backstop for a write that published nothing (raw SQL, a lost
 * event); every write through the repositories and the concurrency seam publishes.
 * Campaign rows are also re-primed by every supervise pass (`findActive`, 2 s).
 */
export const PACING_CACHE_TTL_MS = 2_000;
/** How often a replica tries to take leadership of campaigns it does not lead. */
const SUPERVISE_INTERVAL_MS = 2_000;

/**
 * How long `stop()` waits for completion notices still in flight. Bounded, so an
 * SMTP server that never answers cannot hold the process past its shutdown grace
 * period.
 */
export const COMPLETION_NOTICE_DRAIN_TIMEOUT_MS = 30_000;

/**
 * How long `stop()` waits for ticks still in flight before it drains the notices.
 * A healthy tick is a few round trips; one that outlives this is stuck on a dead
 * dependency, and shutdown carries on without it (logged). Its dial site still
 * re-checks `mayDial`, so a straggler cannot place a call afterwards.
 */
export const TICK_DRAIN_TIMEOUT_MS = 5_000;

/**
 * Written into the agent's Redis hash between reservation and dial.
 *
 * There is no attempt yet at reservation time — that is the whole point of
 * reserving first — and `executeDial` overwrites this with the real attempt id.
 * A marker rather than a synthesized id so anyone reading the hash mid-dial can
 * tell "reserved, attempt not created yet" from "an attempt id we lost track of".
 */
const RESERVING_MARKER = 'reserving';

/** An available agent and how long they have been waiting. */
interface AgentCandidate {
  sessionId: string;
  /**
   * The session's agent (user id), from the live session row. Contact assignment pairs a
   * contact with its owner by this; `pool` mode never reads it.
   */
  agentUserId: string;
  /** Epoch ms of their transition into `available` — the idle clock. */
  availableSince: number;
}

/** One reserved agent and the contact claimed for them. */
interface TickPair {
  sessionId: string;
  contact: AgencyContactRecord;
}

/**
 * Everything one tick decided, as a value.
 *
 * Deliberately returned rather than stashed on the instance. This used to be a
 * `candidateCache` map populated by one method and read by another, which is an
 * implicit contract between two call sites: nothing made the ordering safe, a
 * campaign that computed a target and then failed before dialing left a stale
 * candidate list behind for the next tick to act on, and the fairness ordering had
 * nowhere to live because the consumer only ever saw bare session ids.
 */
interface TickPlan {
  toDial: number;
  /** Reservation order — longest-idle first. */
  candidates: AgentCandidate[];
  /**
   * Why this tick will dial nothing, when it will.
   *
   * Recorded because the DNC gate can now also produce zero dials, and a
   * supervisor staring at a campaign placing no calls has to be able to tell a
   * compliance halt from the three states a healthy campaign spends most of its
   * day in. Absent ⇒ the tick intends to dial.
   */
  idle?: TickIdleReason;
  /** The account limit and live calls the plan used (absent when it stopped at `no_agents`). */
  accountLimit?: number;
  occupied?: number;
}

/**
 * Why a tick dialled nothing. Closed set — it is a metric label.
 *
 * The first four are the benign states a healthy campaign spends most of its day
 * in. `no_caller_ids` is **not** benign: it is a misconfiguration that cannot clear
 * without a human, and it is here rather than in a log-only path precisely because
 * "why is this campaign placing no calls" is the question this label answers.
 *
 * `nothing_due` is contact assignment's (`strict` / `preferred`): agents are available but
 * none has a contact due (own, or in `preferred` mode the pool), so none was reserved. Benign,
 * and NOT quiescent: time passing makes contacts due, and no event announces that.
 */
type TickIdleReason = 'no_agents' | 'no_slots' | 'no_contacts' | 'no_reservations' | 'no_caller_ids' | 'nothing_due';

/** Why a scheduled tick ran in full (a metric label, see `agencyPacingTicksTotal`). */
export type PacingWakeCause = 'first' | 'event' | 'active' | 'safety' | 'forced';

/**
 * What the skip logic knows about one led campaign. Created dirty by `beginLeading`,
 * dropped by `relinquish`.
 */
interface CampaignPacingState {
  /** An invalidation event arrived since the last full tick began. */
  dirty: boolean;
  /**
   * The last full tick could reserve nothing and ended in a state only an event can
   * change (see `runTick`). False after any tick that planned a dial, failed, or
   * was cut short.
   */
  quiescent: boolean;
  /** When the last full tick began (engine clock); {@link NEVER} before the first. */
  lastFullAt: number;
  /** The idle reason the last full tick recorded, replayed by a skipped tick. */
  idle?: TickIdleReason;
  /** The campaign's account, learned from its row: account events wake it. */
  accountKey: string | null;
}

const NEVER = Number.NEGATIVE_INFINITY;

/** Engine tunables. Production uses the defaults; tests shorten them. */
export interface PacingEngineOptions {
  /** The invalidation bus. Default: the process bus (`getPacingInvalidationBus()`). */
  bus?: PacingInvalidationBus;
  safetyTickMs?: number;
  cacheTtlMs?: number;
  /** The engine clock for the skip logic and the caches. Default `Date.now`. */
  now?: () => number;
}

/** One tick, as the engine saw it. For tests and the measurement harness only. */
export type PacingTickObservation =
  | { campaignId: string; mode: 'skipped' }
  | {
      campaignId: string;
      mode: 'full';
      cause: PacingWakeCause;
      /** Present when the tick planned (a running campaign with usable caller IDs). */
      plan?: { accountLimit: number | null; occupied: number | null; toDial: number; idle?: TickIdleReason };
      quiescent: boolean;
    };

/**
 * The pacing loop: one authoritative leader per campaign, dialing to human
 * availability.
 *
 * **Two independent safety mechanisms, because either alone has a failure mode we
 * cannot accept**. The Redis leader lease is the *efficiency* mechanism —
 * it stops N replicas doing the same work. The `FOR UPDATE SKIP LOCKED` contact
 * claim plus `uq_agency_attempt_live` is the *correctness* mechanism — it means
 * that even during a split-brain window (GC pause, partition, clock skew) two
 * leaders cannot dial the same contact. Never treat the lease as the thing that
 * prevents double-dialing; it is not, and it cannot be.
 */
export class PacingEngine {
  /** Campaigns this engine leads, with their lease-renewal timer. Ticks come from the one round timer. */
  private readonly led = new Map<string, { renew: NodeJS.Timeout }>();
  private superviseTimer: NodeJS.Timeout | null = null;
  /**
   * The round timer: every `TICK_INTERVAL_MS` it starts a tick for each led campaign
   * that needs one ({@link runRound}). Armed by the first `beginLeading`, disarmed
   * when the engine leads nothing or stops.
   */
  private roundTimer: NodeJS.Timeout | null = null;
  /** The bus subscription: live from the first `beginLeading` until the engine leads nothing or stops. */
  private unsubscribeBus: (() => void) | null = null;
  /** Skip-logic state per led campaign. */
  private readonly pacingState = new Map<string, CampaignPacingState>();
  /**
   * Campaign rows between full ticks, invalidated by `campaign_changed` and re-primed
   * by every supervise pass. Read by scheduled ticks; a forced tick reads through.
   */
  private readonly campaignCache: GenerationTtlCache<AgencyCampaignRecord>;
  /** `max_concurrent_calls` per account, invalidated by `account_limit_changed`. */
  private readonly limitCache: GenerationTtlCache<number>;
  private readonly bus: PacingInvalidationBus;
  private readonly safetyTickMs: number;
  private readonly now: () => number;
  private tickObserver: ((o: PacingTickObservation) => void) | null = null;
  /** Whether {@link armRounds} starts the round timer. See {@link setAutoRounds}. */
  private autoRounds = true;
  private stopped = false;
  /** Guards against a slow tick overlapping the next one. */
  private readonly ticking = new Set<string>();
  /** The same guard for the supervise pass, which does per-campaign Redis I/O. */
  private supervising = false;
  /**
   * Campaigns whose leadership has been given up while a tick may still be in
   * flight. Checked at every await boundary a dial could follow, so a tick that
   * outlived its lease cannot place a call. Cleared by `beginLeading`.
   */
  private readonly revoked = new Set<string>();

  constructor(
    private readonly redis: Redis | null,
    private readonly keyPrefix: string,
    private readonly replicaId: string,
    private readonly stations: PacingStations,
    private readonly agents: AgentStateMachine,
    private readonly dispatcher: DialDispatcher,
    /**
     * The DNC registry. Required, not optional — an optional compliance gate is one
     * that is off wherever somebody forgot, which is every construction site a
     * test ever wrote.
     */
    private readonly dnc: DncRegistry,
    options: PacingEngineOptions = {},
  ) {
    this.lease = new LeaderLease(redis, keyPrefix, replicaId);
    this.announcer = new CampaignAnnouncer(stations);
    this.bus = options.bus ?? getPacingInvalidationBus();
    this.safetyTickMs = options.safetyTickMs ?? PACING_SAFETY_TICK_MS;
    this.now = options.now ?? Date.now;
    const ttl = options.cacheTtlMs ?? PACING_CACHE_TTL_MS;
    this.campaignCache = new GenerationTtlCache(ttl, this.now);
    this.limitCache = new GenerationTtlCache(ttl, this.now);
  }

  /** See every tick the engine runs or skips (tests, the measurement harness). */
  registerTickObserver(observer: ((o: PacingTickObservation) => void) | null): void {
    this.tickObserver = observer;
  }

  /**
   * Tests and the measurement harness only: `false` keeps the round timer off (the
   * bus subscription and the skip logic stay live) so the caller drives
   * {@link runRound} itself, deterministically.
   */
  setAutoRounds(enabled: boolean): void {
    this.autoRounds = enabled;
    if (!enabled && this.roundTimer) {
      clearInterval(this.roundTimer);
      this.roundTimer = null;
    } else if (enabled && this.unsubscribeBus && !this.roundTimer) {
      this.startRoundTimer();
    }
  }

  private observe(o: PacingTickObservation): void {
    if (!this.tickObserver) return;
    try { this.tickObserver(o); } catch (err) { log.warn({ err }, 'Pacing tick observer threw'); }
  }

  /** The per-campaign leader lease — `pacing/leader-lease.ts`. */
  private readonly lease: LeaderLease;

  /**
   * The engine's "something may want to know a campaign finished" seam. What wants to
   * know is the supervisors' completion notice (`campaign-completion-notice.ts`, which
   * sends `sendAgencyCampaignCompletionEmail`); `maybeFinalize` calls it inside its
   * `if (updated)` block. A registration rather than a 7th positional constructor
   * parameter, and optional — an engine with nothing registered finalizes campaigns
   * exactly the same, it just tells nobody's inbox.
   */
  private completionNotifier: {
    notifyCampaignFinished(campaign: AgencyCampaignRecord, status: 'completed' | 'stopped'): Promise<void>;
  } | null = null;

  registerCompletionNotifier(notifier: {
    notifyCampaignFinished(campaign: AgencyCampaignRecord, status: 'completed' | 'stopped'): Promise<void>;
  }): void {
    this.completionNotifier = notifier;
  }

  /**
   * How a reserved agent with a QUEUED break is handed back: the dialer's
   * `releaseAgent`, which is the single place a queued break is applied (and audited,
   * for a queued switch to the soft phone). An agent who presses Break — or Switch to
   * soft phone — while pacing holds them `reserved` has the break queued
   * (`breakMustWait`); a tick that then returns them to the pool as surplus, or
   * because the contact was deferred or suppressed, used to write `available` and
   * strand the queue until their next call. A registration, as the completion
   * notifier is; without one (the unit suites) every return is the plain write.
   */
  private queuedBreakRelease: {
    hasQueuedBreak(sessionId: string): boolean;
    release(sessionId: string): Promise<unknown>;
  } | null = null;

  registerQueuedBreakRelease(release: {
    hasQueuedBreak(sessionId: string): boolean;
    release(sessionId: string): Promise<unknown>;
  }): void {
    this.queuedBreakRelease = release;
  }

  /**
   * Hand a reserved agent back: to the pool, unless a break was queued while they
   * were reserved, in which case `releaseAgent` applies it (`break`, mirrored, with
   * its `agent_state` frame). Only that rare case pays for a mirror write and a frame;
   * the ordinary surplus return stays the one Redis write the tick has always made
   * (see the note in {@link dialUpTo} on why reservations are not mirrored).
   */
  private reservedReturn: ReservedReturn | null = null;

  /** Hand every reserved-agent return to `r` instead (media workers: the agent's own worker). */
  registerReservedReturn(r: ReservedReturn | null): void {
    this.reservedReturn = r;
  }

  private async returnReserved(sessionId: string): Promise<void> {
    if (this.reservedReturn) {
      await this.reservedReturn.returnReserved(sessionId);
      return;
    }
    if (this.queuedBreakRelease?.hasQueuedBreak(sessionId)) {
      await this.queuedBreakRelease.release(sessionId);
      return;
    }
    await this.agents.set(sessionId, 'available');
  }

  /**
   * Completion notices requested but not yet settled.
   *
   * The notice is fire-and-forget at the call site (see `maybeFinalize`), so a campaign
   * finalized on the last tick before SIGTERM would otherwise lose its mail and its
   * `agency_campaign_notifications_total` increment when the process exits. `stop()`
   * drains this set, bounded by
   * {@link noticeDrainTimeoutMs}.
   */
  private readonly inFlightNotices = new InFlight();

  /** The drain bound `stop()` uses. A field only so tests can shorten it. */
  noticeDrainTimeoutMs = COMPLETION_NOTICE_DRAIN_TIMEOUT_MS;

  /** How many completion notices are still in flight. */
  pendingNoticeCount(): number {
    return this.inFlightNotices.size;
  }

  /** Settle the completion notices requested so far, bounded by {@link noticeDrainTimeoutMs}. */
  async drainNotices(): Promise<void> {
    if (await this.inFlightNotices.settle(this.noticeDrainTimeoutMs)) return;
    log.error(
      { pending: this.inFlightNotices.size, timeoutMs: this.noticeDrainTimeoutMs },
      'Campaign completion notices did not settle before shutdown — those notices are lost',
    );
  }

  /**
   * Ticks started but not yet settled, so `stop()` can wait for them.
   *
   * Clearing the tick interval stops the NEXT tick, not one already parked on an
   * await: that one would resume after the runtime came down and could reach the
   * bridge after its shutdown snapshot (a carrier leg nobody tears down), or
   * finalize a campaign and request a notice after `drainNotices` had already run.
   */
  private readonly inFlightTicks = new InFlight();

  /** The tick-drain bound `stop()` uses. A field only so tests can shorten it. */
  tickDrainTimeoutMs = TICK_DRAIN_TIMEOUT_MS;

  private async drainTicks(): Promise<void> {
    if (await this.inFlightTicks.settle(this.tickDrainTimeoutMs)) return;
    log.error(
      { pending: this.inFlightTicks.size, timeoutMs: this.tickDrainTimeoutMs },
      'Agency ticks did not settle before shutdown — continuing; their dial sites refuse to dial',
    );
  }

  /**
   * May a tick for this campaign still place a call? False once leadership was
   * given up (`revoked`) or the engine is stopping. Asked at every await boundary
   * a dial could follow, and handed to the dispatcher so the dialer can ask it
   * once more immediately before the carrier is contacted.
   */
  private mayDial(campaignId: string): boolean {
    return !this.stopped && !this.revoked.has(campaignId);
  }

  /**
   * Leadership grants: a number per campaign, new each time leadership is taken. A dial
   * sent to another process carries the grant it was issued under, and the listeners
   * below hear every withdrawal, so that process can answer `stillAuthorised`
   * synchronously from a value it was pushed (`docs/scaling.md` §3.1). Nothing in a single
   * process reads them: `stillAuthorised` there is `mayDial` itself.
   */
  private grantSeq = 0;
  private readonly grants = new Map<string, number>();
  private readonly revokeListeners = new Set<AuthorisationRevokedListener>();

  /** The grant the campaign is led under now; null when this engine does not lead it. */
  leadershipGrant(campaignId: string): number | null {
    return this.mayDial(campaignId) ? this.grants.get(campaignId) ?? null : null;
  }

  onAuthorisationRevoked(listener: AuthorisationRevokedListener): () => void {
    this.revokeListeners.add(listener);
    return () => { this.revokeListeners.delete(listener); };
  }

  private announceRevoked(campaignId: string | null, upTo: number): void {
    for (const listener of [...this.revokeListeners]) {
      try { listener(campaignId, upTo); } catch (err) { log.warn({ err, campaignId }, 'Authorisation-revoked listener threw'); }
    }
  }

  start(): void {
    if (this.superviseTimer) return;
    this.stopped = false;
    this.halted = null;
    const supervise = (): void => {
      void this.superviseOnce().catch((err) => log.error({ err }, 'Agency supervise pass failed'));
    };
    this.superviseTimer = setInterval(supervise, SUPERVISE_INTERVAL_MS);
    this.superviseTimer.unref?.();
    supervise();
  }

  async stop(): Promise<void> {
    await this.halt();
    // Only then settle the completion notices, so a notice the final tick requested is
    // in the set being drained rather than added after it. See `inFlightNotices`.
    await this.drainNotices();
  }

  /**
   * The first half of {@link stop}: no new tick, every lease given up, and (bounded) the
   * ticks already in flight waited for. After it no dial is prepared or sent. With media
   * workers the primary halts pacing, then drains the notices beside the workers'
   * shutdown (`docs/scaling.md` §6.4); `stop()` afterwards finds both done. Idempotent.
   */
  async halt(): Promise<void> {
    if (this.halted) return this.halted;
    this.halted = (async () => {
      this.stopped = true;
      this.announceRevoked(null, this.grantSeq);
      if (this.superviseTimer) clearInterval(this.superviseTimer);
      this.superviseTimer = null;
      for (const campaignId of [...this.led.keys()]) await this.relinquish(campaignId);
      this.disarmRounds();
      // Wait (bounded) for any tick already in flight — see `inFlightTicks`.
      await this.drainTicks();
    })();
    return this.halted;
  }

  private halted: Promise<void> | null = null;

  /**
   * Campaigns led **to drain, never to dial**.
   *
   * A `stopping` campaign is led without consulting the dialer flag (see
   * `superviseInner`), so for these — and only these — this replica genuinely does
   * not know whether the tenant's dialer is switched on. The invariant that a
   * disabled tenant places no calls therefore cannot come from the flag read that
   * did not happen; it is enforced at the dial site instead, by this set.
   *
   * Membership currently implies `status === 'stopping'`, which `tickOnce` already
   * refuses to dial — so the guard is redundant today, deliberately. The two
   * previous attempts at this defect were both edits to a *status list*, and a
   * status list is precisely the thing a later change widens without knowing what
   * it was holding up. This makes "led without a flag decision ⇒ never dials" a
   * property of the dial branch rather than of a status happening to be excluded
   * from it.
   */
  private readonly drainOnly = new Set<string>();

  /** The campaign-state broadcasts and their latches — `pacing/campaign-announcer.ts`. */
  private readonly announcer: CampaignAnnouncer;
  private get flagGated(): Set<string> { return this.announcer.flagGated; }
  private get reportedStuck(): Set<string> { return this.announcer.reportedStuck; }
  private announceCampaignState(
    campaign: AgencyCampaignRecord,
    reason: AgencyCampaignChangeReason,
    opts: { dialing?: boolean } = {},
  ): void {
    this.announcer.announceCampaignState(campaign, reason, opts);
  }
  private announceDialingResumed(campaign: AgencyCampaignRecord, why: string): void {
    this.announcer.announceDialingResumed(campaign, why);
  }
  private noteMisconfigured(campaign: AgencyCampaignRecord, what: string): void {
    this.announcer.noteMisconfigured(campaign, what);
  }
  private clearStuck(campaign: AgencyCampaignRecord): void {
    this.announcer.clearStuck(campaign);
  }

  /**
   * Whether this campaign's tenant still has the agency dialer switched on.
   *
   * **The flag has to be re-read here, not only at the routes.** Every campaign
   * *control* is gated (`agency-campaigns.routes.ts`'s `gate`), which means turning
   * `agency_dialer_enabled` off takes the operator's stop button away and left the
   * engine dialing — the one combination where the kill switch makes the situation
   * worse. A campaign already in `running` kept placing calls, on a tenant the
   * platform believes has no dialer, until someone re-enabled the flag to press
   * stop.
   *
   * Read on the 2s supervise pass rather than the 250ms tick — an 8× reduction for
   * a value that changes about once a quarter.
   *
   * **The cost is two Redis GETs per campaign per pass, not a free cache hit.**
   * `FeatureFlagService.getSnapshot` has no in-process memo on the healthy path: it
   * issues a real `redis.get` for each of the global and per-tenant snapshots, and
   * `getValue` reads both. The 60s TTL bounds the DB, not Redis — so 100 running
   * campaigns is ~200 sequential Redis round trips every 2s, plus one DB read per
   * tenant per minute when a TTL lapses. That is affordable (Redis serves it in
   * well under the 2s budget at any plausible campaign count, and
   * `uq_agency_campaign_running` caps running campaigns at one per account) but it
   * is not nothing, and `superviseOnce` is re-entrancy-guarded partly because of it.
   * If campaign counts grow an order of magnitude, memoise the decision here rather
   * than moving the read.
   *
   * **Fails closed onto the flag service's own default** (`false`), which is what
   * `getValue` already returns when every layer fails. That is the safe direction:
   * a campaign that stops dialing during a Redis outage resumes on the next pass,
   * whereas one that keeps dialing for a disabled tenant cannot be un-dialed.
   */
  private async campaignEnabled(campaign: AgencyCampaignRecord): Promise<boolean> {
    const enabled = await getFeatureFlagService().isEnabled(FLAGS.agency_dialer_enabled, {
      tenantId: campaign.tenant_id,
      accountId: campaign.account_id,
    });
    if (enabled) {
      // Same recovery problem as `clearStuck`, same fix: we announced
      // `dialing: false` when the flag went off, the status never changed, so
      // nothing else will ever tell the console dialing resumed. Leadership being
      // re-acquired is invisible to the agents.
      if (this.flagGated.delete(campaign.id)) {
        this.announceDialingResumed(campaign, 'dialer re-enabled for this account');
      }
      return true;
    }
    if (!this.flagGated.has(campaign.id)) {
      this.flagGated.add(campaign.id);
      // Warn, not info: the campaign row still reads `running` and its stats keep
      // reporting outstanding contacts, so without this line the only symptom is a
      // healthy-looking campaign that dials nothing — the same diagnostic shape the
      // DNC cold start produces, and the reason that one is logged loudly too.
      log.warn(
        { campaignId: campaign.id, tenantId: campaign.tenant_id, accountId: campaign.account_id, status: campaign.status },
        'Agency dialer is disabled for this account — not leading this campaign, and it will place no calls while it stays in this status',
      );
      // The agents are the ones left with no other signal: the row still reads
      // `running`, and once leadership is relinquished nothing else will ever tell
      // their console otherwise. `tickOnce` is dead for this campaign, so this is
      // the ONLY place the frame can come from.
      this.announceCampaignState(campaign, 'auto_paused', { dialing: false });
    }
    return false;
  }

  /** Take leadership of any running campaign we do not already lead. */
  private async superviseOnce(): Promise<void> {
    if (this.stopped) return;
    // Re-entrancy guard, matching `ticking`'s. The pass does per-campaign Redis I/O
    // (see `campaignEnabled`) on a fixed 2s `setInterval`, so a slow Redis or a
    // large roster can make one pass outlast its interval — and two overlapping
    // passes would race `tryAcquireLeadership` and `relinquish` for the same
    // campaigns.
    if (this.supervising) return;
    this.supervising = true;
    try {
      await this.superviseInner();
    } finally {
      this.supervising = false;
    }
  }

  private async superviseInner(): Promise<void> {
    // The cache generation of every campaign we lead, read BEFORE the query, so a
    // row an invalidation overtook is not primed (see `GenerationTtlCache`).
    const generations = new Map([...this.pacingState.keys()].map((id) => [id, this.campaignCache.generation(id)]));
    const all = await agencyCampaignRepository.findActive();
    for (const row of all) {
      const generation = generations.get(row.id);
      if (generation !== undefined) this.primeCampaign(row, generation);
    }
    // Filtered here rather than in `findActive`'s SQL: the flag lives in Redis and
    // the override table, not on the campaign row, so this cannot be a predicate.
    //
    // Sequential rather than `Promise.all`, and each resolve is individually
    // try/caught so one campaign's failure genuinely cannot abort the pass. Without
    // the catch a `for…of` with `await` propagates exactly as `Promise.all` would,
    // so the comment that used to sit here claimed an isolation the code did not
    // have. `isEnabled` swallows its own infra errors, but the log/announce arms
    // below can throw, and a throw here would strand every campaign after this one.
    const campaigns: AgencyCampaignRecord[] = [];
    for (const campaign of all) {
      try {
        // ── A `stopping` campaign is led WITHOUT asking the flag ──────────────
        //
        // The gate used to drop these along with everything else, and that is what
        // made the off button conditional on the feature it turns off. `stopping`
        // is left only by `maybeFinalize`; `maybeFinalize` runs only on a leader's
        // tick; a gated-out campaign has no leader. So an operator who switched the
        // dialer off and pressed Stop got a row parked in `stopping` until somebody
        // re-enabled the dialer — and the reads that would have shown them that are
        // still 403-gated, by design. Narrowing `/stop`'s source statuses (twice)
        // could never have fixed it: the gate is what withholds finalization, and
        // it does so whatever status the campaign came from.
        //
        // Leading one places no calls — see `drainOnly`, which is where that is
        // enforced rather than inferred.
        if (campaign.status === 'stopping') {
          this.drainOnly.add(campaign.id);
          campaigns.push(campaign);
          continue;
        }
        if (await this.campaignEnabled(campaign)) {
          this.drainOnly.delete(campaign.id);
          campaigns.push(campaign);
        }
      } catch (err) {
        // Fail closed, consistent with the flag service's own default: an
        // unresolvable campaign is not led this pass and is retried on the next.
        log.error({ err, campaignId: campaign.id }, 'Agency dialer flag check failed — not leading this campaign this pass');
      }
    }
    // A campaign gated out is absent from `active`, so the loop below relinquishes
    // it exactly as it would a campaign that had been stopped — the flag going off
    // mid-run stops the dialing within one supervise pass, not at the next restart.
    const active = new Set(campaigns.map((c) => c.id));

    // All three latches (and `revoked`, below) are keyed by campaign id and are otherwise only cleared on
    // the way back to healthy, so a campaign that is deleted, completed or stopped
    // while gated would leak its id for the life of the process. Pruned against the
    // rows that actually came back — which is also what retires a `drainOnly` mark
    // the moment the campaign reaches `stopped` and leaves `findActive`.
    const known = new Set(all.map((c) => c.id));
    for (const id of this.flagGated) if (!known.has(id)) this.flagGated.delete(id);
    for (const id of this.reportedStuck) if (!known.has(id)) this.reportedStuck.delete(id);
    for (const id of this.drainOnly) if (!known.has(id)) this.drainOnly.delete(id);
    for (const id of this.queueSent.keys()) if (!known.has(id)) this.queueSent.delete(id);
    for (const id of this.fallbackSweptAt.keys()) if (!known.has(id)) this.fallbackSweptAt.delete(id);
    // `revoked` too, which `beginLeading` alone used to clear — except under a tick
    // still in flight, whose dial sites are what the mark exists to stop. A campaign
    // absent from `findActive` is neither running nor stopping, so no later tick of
    // it can reach a dial without being led again (which clears the mark anyway).
    for (const id of this.revoked) if (!known.has(id) && !this.ticking.has(id)) this.revoked.delete(id);

    // Drop leadership of anything no longer running.
    for (const id of [...this.led.keys()]) {
      if (!active.has(id)) await this.relinquish(id);
    }

    for (const campaign of campaigns) {
      // A pass already in flight when `stop()` ran must not start leading again:
      // that would arm a tick interval nothing will ever clear.
      if (this.stopped) return;
      if (this.led.has(campaign.id)) continue;
      if (!(await this.tryAcquireLeadership(campaign.id))) continue;
      if (this.stopped) {
        await this.relinquish(campaign.id);
        return;
      }
      this.beginLeading(campaign);
    }
  }

  private async tryAcquireLeadership(campaignId: string): Promise<boolean> {
    return this.lease.tryAcquire(campaignId);
  }

  private beginLeading(campaign: AgencyCampaignRecord): void {
    log.info({ campaignId: campaign.id, name: campaign.name }, 'Took agency campaign leadership');
    // We hold the lease again, so ticks are authorised again.
    this.revoked.delete(campaign.id);
    this.grants.set(campaign.id, ++this.grantSeq);
    this.armRounds();

    // Dirty, so the first round ticks it in full whatever happened before.
    this.pacingState.set(campaign.id, {
      dirty: true, quiescent: false, lastFullAt: NEVER, accountKey: accountKeyOf(campaign.tenant_id, campaign.account_id),
    });

    const renew = setInterval(() => {
      void this.renewLeadership(campaign.id);
    }, LEADER_RENEW_MS);
    renew.unref?.();

    this.led.set(campaign.id, { renew });
  }

  /**
   * Start the round timer and the bus subscription, if they are not running. The
   * caches start empty: what they held while nothing listened for invalidations
   * cannot be trusted.
   */
  private armRounds(): void {
    if (this.unsubscribeBus) return;
    this.campaignCache.clear();
    this.limitCache.clear();
    this.unsubscribeBus = this.bus.subscribe((event) => this.onInvalidation(event));
    if (this.autoRounds) this.startRoundTimer();
  }

  private startRoundTimer(): void {
    this.roundTimer = setInterval(() => {
      void this.runRound().catch((err) => log.error({ err }, 'Agency pacing round failed'));
    }, TICK_INTERVAL_MS);
    this.roundTimer.unref?.();
  }

  private disarmRounds(): void {
    if (this.roundTimer) clearInterval(this.roundTimer);
    this.roundTimer = null;
    this.unsubscribeBus?.();
    this.unsubscribeBus = null;
    this.campaignCache.clear();
    this.limitCache.clear();
  }

  private async renewLeadership(campaignId: string): Promise<void> {
    if ((await this.lease.renew(campaignId)) === 'lost') {
      log.warn({ campaignId }, 'Lost agency campaign leadership — stopping within one tick');
      await this.relinquish(campaignId, { alreadyLost: true });
    }
  }

  private async relinquish(campaignId: string, opts: { alreadyLost?: boolean } = {}): Promise<void> {
    // ── Stop a tick that is ALREADY RUNNING, not just the next one ─────────────
    //
    // Clearing the interval stops future ticks. It does nothing about a tick that
    // entered 200ms ago and is parked on an await: it resumes and dispatches real
    // outbound calls — after the leader lease was released, and after the flag gate
    // told every console that dialing had stopped. The kill switch is documented as
    // "dropped within one supervise pass", so a call placed for a tenant the
    // platform has just decided has no dialer is exactly what it promises not to do.
    //
    // A revocation set rather than testing `this.led`, deliberately: `tickOnce` is
    // called directly (by tests, and it is a public method), and gating it on
    // leadership would make every such call a no-op. `beginLeading` clears the mark,
    // so a re-led campaign ticks normally.
    this.revoked.add(campaignId);
    this.announceRevoked(campaignId, this.grants.get(campaignId) ?? this.grantSeq);
    const timers = this.led.get(campaignId);
    if (timers) {
      clearInterval(timers.renew);
      this.led.delete(campaignId);
    }
    this.pacingState.delete(campaignId);
    this.campaignCache.invalidate(campaignId);
    this.queueSent.delete(campaignId);
    this.fallbackSweptAt.delete(campaignId);
    if (this.led.size === 0) this.disarmRounds();
    if (!opts.alreadyLost) await this.lease.release(campaignId);
  }

  /**
   * One pass of the closed-loop controller.
   *
   * ```
   * idle     = agents in `available` on this campaign  (busy agents excluded)
   * occupied = ALL non-terminal attempts   (a bridged call still holds a slot)
   * to_dial  = MAX(0, MIN(account max_concurrent_calls - occupied, idle))
   * ```
   *
   * **The two terms bound different quantities and must not be subtracted from
   * one another.** The account limit caps total concurrency, so `occupied`
   * counts against it; `idle` caps how many *new* dials can be placed, because
   * only an idle agent can take one. This note previously stated
   * `MIN(accountLimit, idle) - occupied`, which charged every busy agent twice —
   * once by being absent from `idle`, once as `occupied` — and stalled any
   * campaign where a single agent was on a call. See the note in `planTick`.
   *
   * `to_dial == 0` IS the paused state — and the same expression resumes it, so
   * there is no pause flag anywhere that can be left stale. `occupied` counts
   * answered and bridged attempts deliberately: excluding them would make the
   * engine reserve agents and claim contacts only to be refused by the concurrency
   * guard, every tick, forever, whenever agents outnumber the account limit.
   */
  async tickOnce(campaignId: string): Promise<void> {
    // A FORCED full tick: never skipped, and every read goes to the database (a
    // round of its own, `fresh`), exactly as a tick always did. The scheduled path
    // is `runRound`. Tracked so `stop()` can wait for it — see `inFlightTicks`.
    await this.inFlightTicks.track(this.runTick(campaignId, new PacingRound(true), 'forced'));
  }

  /**
   * One scheduled round: a tick for every led campaign that needs one, all started
   * together so campaigns of one account share their account reads
   * (`pacing/round.ts`). A campaign is SKIPPED — no database, no Redis — when its
   * last full tick was quiescent, no invalidation event has arrived since, and the
   * safety tick is not due ({@link wakeCause}).
   *
   * Resolves when every tick it started has settled (the timer does not wait; tests
   * and the harness do).
   */
  async runRound(): Promise<void> {
    if (this.stopped) return;
    const round = new PacingRound(false);
    const now = this.now();
    const started: Promise<void>[] = [];
    for (const campaignId of this.led.keys()) {
      // A tick still in flight from an earlier round keeps the campaign; this round
      // passes it by, as the per-campaign guard in `runTick` always has.
      if (this.ticking.has(campaignId)) continue;
      const state = this.pacingState.get(campaignId);
      const cause = this.wakeCause(state, now);
      if (cause === null) {
        // Replay the idle reason the last full tick found, so `agency_tick_idle_total`
        // keeps counting idle ticks, not only the full ones.
        if (state?.idle) this.recordIdle(campaignId, state.idle);
        safeEmit('agency-pacing-ticks', () => agencyPacingTicksTotal.inc({ mode: 'skipped', cause: 'none' }));
        this.observe({ campaignId, mode: 'skipped' });
        continue;
      }
      started.push(this.inFlightTicks.track(this.runTick(campaignId, round, cause)).catch((err) => {
        log.error({ err, campaignId }, 'Agency tick failed');
      }));
    }
    await Promise.all(started);
  }

  /**
   * Whether a scheduled tick runs in full, and why; null to skip it.
   *
   * Skipping is safe only from a QUIESCENT state: one whose plan reserved nothing
   * and which no time passing can change — no agent `available`, no account slot,
   * no usable caller ID, or not `running`. Each leaves it only through an event the
   * bus carries: an agent entering `available` or attaching a station, a call on
   * the account ending, the campaign row or the account limit changing, contacts
   * arriving. A campaign that planned a dial (`active`) ticks every round, as before.
   * The safety tick bounds what a lost event can cost.
   */
  private wakeCause(state: CampaignPacingState | undefined, now: number): PacingWakeCause | null {
    if (!state || state.lastFullAt === NEVER) return 'first';
    if (state.dirty) return 'event';
    if (!state.quiescent) return 'active';
    if (now - state.lastFullAt >= this.safetyTickMs) return 'safety';
    return null;
  }

  /** The campaign row: cached between scheduled ticks, read through on a forced one. */
  private async loadCampaign(campaignId: string, round: PacingRound): Promise<AgencyCampaignRecord | null> {
    if (!round.fresh) {
      const hit = this.campaignCache.get(campaignId);
      if (hit) return hit;
    }
    const generation = this.campaignCache.generation(campaignId);
    const row = await agencyCampaignRepository.findById(campaignId);
    if (row) this.campaignCache.setIf(campaignId, generation, row);
    else this.campaignCache.invalidate(campaignId);
    return row;
  }

  /**
   * A row the supervise pass read (fresher than any cached one, generation
   * permitting). A row that differs from the cached one is a change no event
   * announced, so the campaign is woken as an event would.
   */
  private primeCampaign(row: AgencyCampaignRecord, generation: number): void {
    const cached = this.campaignCache.get(row.id);
    if (!this.campaignCache.setIf(row.id, generation, row)) return;
    if (cached && rowVersion(cached) !== rowVersion(row)) this.markDirty(row.id);
  }

  // ─── Invalidation events ────────────────────────────────────────────────

  private onInvalidation(event: PacingInvalidationEvent): void {
    switch (event.type) {
      case 'campaign_changed':
        this.campaignCache.invalidate(event.campaignId);
        this.markDirty(event.campaignId);
        return;
      case 'contacts_changed':
        this.markDirty(event.campaignId);
        return;
      case 'account_limit_changed': {
        const key = accountKeyOf(event.tenantId, event.accountId);
        this.limitCache.invalidate(key);
        this.markAccountDirty(key);
        return;
      }
      case 'account_capacity_freed':
        this.markAccountDirty(accountKeyOf(event.tenantId, event.accountId));
        return;
      case 'agent_available': {
        const campaignId = event.campaignId ?? this.localCampaignOf(event.sessionId);
        if (campaignId) this.markDirty(campaignId);
        // Unknown: wake everything rather than guess. Rare (a session this process
        // holds no station for cannot be dialed here anyway).
        else for (const state of this.pacingState.values()) state.dirty = true;
        return;
      }
    }
  }

  private localCampaignOf(sessionId: string): string | null {
    const stations = this.stations as Partial<Pick<PacingStations, 'get'>>;
    return typeof stations.get === 'function' ? stations.get.call(this.stations, sessionId)?.campaignId ?? null : null;
  }

  private markDirty(campaignId: string): void {
    const state = this.pacingState.get(campaignId);
    if (state) state.dirty = true;
  }

  private markAccountDirty(accountKey: string): void {
    for (const state of this.pacingState.values()) if (state.accountKey === accountKey) state.dirty = true;
  }

  private async runTick(campaignId: string, round: PacingRound, cause: PacingWakeCause): Promise<void> {
    if (this.ticking.has(campaignId)) return;
    this.ticking.add(campaignId);
    const startedAt = this.now();
    // Cleared BEFORE the reads: an event that lands while this tick runs re-arms it,
    // so the next round ticks again rather than trusting reads that predate it.
    const startState = this.pacingState.get(campaignId);
    if (startState) startState.dirty = false;
    let quiescent = false;
    let idle: TickIdleReason | undefined;
    let planned: TickPlan | undefined;
    safeEmit('agency-pacing-ticks', () => agencyPacingTicksTotal.inc({ mode: 'full', cause }));
    try {
      const campaign = await this.loadCampaign(campaignId, round);
      if (!campaign) {
        this.lastStatus.delete(campaignId);
        await this.relinquish(campaignId);
        return;
      }
      if (startState) startState.accountKey = accountKeyOf(campaign.tenant_id, campaign.account_id);

      // A status change must reach idle agents, who are outside every per-attempt
      // frame's reach. Detected here because the tick already loads the row.
      //
      // **`paused` is two different events and the status alone cannot tell them
      // apart** — which is exactly what `AgencyCampaignChangeReason`'s own doc
      // comment predicted ("`paused` by a supervisor and `paused` by the
      // abandonment guardrail are the same status and very different messages to a
      // human, and they will coexist"). The guardrail pauses out-of-band, from the
      // abandonment refresh, and never announces anything itself; this tick is the
      // only thing that tells the floor. Reading the status alone announced every
      // compliance stop as "A supervisor paused this campaign", which is a false
      // statement to every agent on the campaign about why their calls stopped.
      //
      // `pause_reason` is the discriminator rather than a flag the guardrail sets
      // here, because the pause and the announcement happen on different replicas
      // in different processes; the column is the only thing both can see.
      const lastStatus = this.lastStatus.get(campaignId);
      if (lastStatus && lastStatus !== campaign.status) {
        this.announceCampaignState(campaign, campaignChangeReasonFor(campaign));
      }
      // A terminal status is never left, so there is no later change to detect
      // and nothing to hold: keeping it would leak one entry per campaign that
      // ended under another writer (`maybeFinalize` deletes its own).
      if (campaign.status === 'completed' || campaign.status === 'stopped') this.lastStatus.delete(campaignId);
      else this.lastStatus.set(campaignId, campaign.status);

      // ── Refuse BEFORE reserving anything, not after. ────────────────────────
      //
      // An empty caller-ID pool cannot produce a dial, and it cannot clear without
      // a human editing the campaign. Discovering that inside `dialUpTo` — after
      // `planTick` reserved agents and `claimDialable` wrote N rows to `in_flight`
      // — meant `abortRemainder` unclaimed them at `now()` and the next tick did
      // the identical thing 250 ms later: exactly the 4-claims-a-second spin
      // `AgencyContactRepository.unclaim` documents as the thing to avoid. It also
      // restamped every agent's `availableSince` each tick, collapsing the
      // longest-idle fairness ordering depends on, and emitted an
      // unthrottled error log (~345k lines/day at 4 Hz).
      //
      // Checked here because `findById` has already loaded the row, so the guard
      // is free — and because a tick that reserves nothing has nothing to unwind.
      //
      // **Deliberately NOT applied to the shared `halt` gate** (`dnc_unavailable`),
      // which has the same abort-the-batch shape but a genuinely different cause:
      // that condition clears the instant the `dnc_entries` read succeeds again, and
      // the claim reads the same database, so a DNC halt from an unavailable database
      // usually cannot reach a claim in the first place. This one has a healthy
      // database, reserves fine, claims fine, and stays broken until someone edits
      // the campaign.
      // `usableCallerIds`, NOT `caller_ids.length`: a stored `['']` is length 1 and
      // dials nothing. Testing length here while the picker tested truthiness is
      // what let a junk pool past this guard and into an unlatched 4 Hz spin.
      if (campaign.status === 'running' && usableCallerIds(campaign).length === 0) {
        this.recordIdle(campaign.id, 'no_caller_ids');
        this.noteMisconfigured(campaign, 'has no usable caller IDs — every tick will dial nothing until one is added');
        // Only a campaign edit clears it, and an edit publishes `campaign_changed`.
        quiescent = true;
        idle = 'no_caller_ids';
        return;
      }
      // Reached only when the pool is genuinely usable, so this cannot wipe the
      // latch out from under a campaign that is still broken.
      this.clearStuck(campaign);

      // `drainOnly` as well as the status, and the redundancy is the point: a
      // drain-led campaign was taken on without a flag read, so "this tenant may
      // have no dialer" has to be answered where the dial happens. Today every
      // member is `stopping` and the status alone would do — which is exactly what
      // was true of the last two fixes for this bug, right up until it wasn't.
      // Quiescent unless the plan below finds work: a campaign that is not running
      // (paused, or stopping and draining) changes only through a campaign event, or
      // — for the drain — a call on its account ending.
      let willBeQuiescent = true;
      if (campaign.status === 'running' && !this.drainOnly.has(campaignId)) {
        // Owner-mode campaigns: hand overdue callbacks of absent owners to the pool first, so
        // a `preferred` agent can be given one on this very tick (throttled, never throws).
        await this.maybeSweepCallbackFallback(campaign);
        const plan = await this.planTick(campaign, round);
        planned = plan;
        if (plan.idle) this.recordIdle(campaign.id, plan.idle);
        if (plan.toDial > 0) {
          willBeQuiescent = false;
          // `planTick` awaited on Redis and the DB; leadership may have been given
          // up in that window. Reserving and dialing past this point would place
          // calls without a lease.
          if (!this.mayDial(campaignId)) return;
          const dialed = await this.dialUpTo(campaign, plan);
          if (dialed > 0) return; // did work; completion is only checked on an idle tick
        } else if (plan.idle === 'nothing_due') {
          // Agents are available and nothing is due for them: time passing makes contacts
          // due and nothing publishes that, so this tick is not quiescent (like a claim
          // that came back empty).
          willBeQuiescent = false;
        } else {
          // `no_agents` or `no_slots`: only an agent entering `available`, a call
          // ending or the limit rising can change it, and each publishes.
          idle = plan.idle;
        }
      }

      // Idle tick (or a stopping campaign draining): the leader — and ONLY the
      // leader — evaluates completion, so there is exactly one writer of these two
      // transitions and no race with the supervisor's controls.
      await this.maybeFinalize(campaign);
      quiescent = willBeQuiescent;
    } finally {
      this.ticking.delete(campaignId);
      const state = this.pacingState.get(campaignId);
      if (state) {
        state.lastFullAt = startedAt;
        state.quiescent = quiescent;
        state.idle = quiescent ? idle : undefined;
      }
      // A safety tick that found work is a wake-up the bus missed.
      if (cause === 'safety' && planned && planned.toDial > 0) {
        safeEmit('agency-pacing-missed-wakeup', () => agencyPacingMissedWakeupsTotal.inc());
        log.info({ campaignId }, 'Pacing safety tick found work no invalidation event announced');
      }
      this.observe({
        campaignId, mode: 'full', cause, quiescent,
        ...(planned ? {
          plan: {
            accountLimit: planned.accountLimit ?? null,
            occupied: planned.occupied ?? null,
            toDial: planned.toDial,
            ...(planned.idle ? { idle: planned.idle } : {}),
          },
        } : {}),
      });
    }
  }

  private async planTick(campaign: AgencyCampaignRecord, round: PacingRound): Promise<TickPlan> {
    // Availability is read from Redis, not the DB: presence is the heartbeat, and
    // a DB row saying `available` for an agent whose socket died would put a real
    // customer through to nobody.
    const sessions = await agencyAgentSessionRepository.findLiveForCampaign(campaign.id);
    const now = Date.now();
    const candidates: AgentCandidate[] = [];
    const local: string[] = [];
    const userOf = new Map<string, string>();
    for (const s of sessions) {
      // ── `isLocallyOwned` is CORRECT here, and is ONE of the things holding the
      //    single-replica constraint ──────────────────────────────────────────────
      //
      // Unlike `POST /sessions/:id/available` — which asked this in-process map a
      // question only Redis can answer, and 409'd agents whose stations were held
      // by a sibling replica — a candidate for dialing genuinely must be an agent
      // THIS replica can bridge. `LocalDialDispatcher` refuses a command whose
      // `ownerReplica` is not us (loudly, because dialing anyway produces an
      // abandoned call), so admitting a remote agent here would only manufacture
      // attempts that die at dispatch.
      //
      // But note what the pair implies, because it is easy to read this fix as
      // more than it is: campaign leadership is a per-campaign Redis lease, so on
      // N replicas a campaign is led by one of them and this filter narrows its
      // candidates to the agents that replica happens to hold. Agents connected
      // elsewhere would go available successfully and then never be dialed for.
      //
      // So fixing that route does not lift the "run one replica" constraint, which
      // is why it was left alone: the constraint is held here AND by the
      // replica-local wrap-up/break/live-attempt state the agent-control routes
      // read. Lifting it needs the `PubSubDialDispatcher` the `DialDispatcher` seam
      // was created for, an advertised host on the bridge webhook URLs, and those
      // three pieces of state moved out of process. Separate work, not a comment.
      if (!this.stations.isLocallyOwned(s.id)) continue;
      local.push(s.id);
      userOf.set(s.id, s.agent_user_id);
    }
    // One pipelined round trip for every local agent, not one per agent.
    const states = await this.agents.getMany(local);
    local.forEach((sessionId, i) => {
      const live = states[i];
      if (live?.state === 'available') {
        candidates.push({ sessionId, agentUserId: userOf.get(sessionId)!, availableSince: live.since ?? now });
      }
    });
    // Contact assignment: forget the queue frames of sessions that left (before the early
    // return below, so a campaign whose agents all went away still drops them).
    const mode = ownerModeOf(campaign);
    this.pruneQueueSent(campaign.id, mode ? sessions.map((s) => s.id) : null);
    if (candidates.length === 0) return { toDial: 0, candidates: [], idle: 'no_agents' };

    // ── Fairness: longest-idle first. ───────────────────────────────────────
    // The requirement is that no agent's idle time diverges over a 200-call run,
    // which is a property of the ORDER, not of the count. Whatever order
    // `findLiveForCampaign` returns is a database artefact — stable across ticks
    // and unrelated to who has been waiting — so taking it as-is hands the
    // early rows most of the calls and lets a late row idle indefinitely on a pool
    // larger than the concurrency ceiling. Sorting by the Redis `since` (the last
    // transition, untouched by heartbeat renewal) makes "waited longest" the
    // selection rule, and because a released agent's `since` is restamped when
    // they return to `available`, the queue rotates on its own.
    //
    // Ties broken on session id, so the order is total and a tick is reproducible.
    candidates.sort((a, b) =>
      a.availableSince - b.availableSince || a.sessionId.localeCompare(b.sessionId));

    // ── Contact assignment: an agent with nothing due is not reserved (CA3). ──────
    // `strict` / `preferred`: one probe of every available agent's own queue (and the pool's,
    // in `preferred`), which also sends each agent their `queue` frame when it changed. Only
    // the agents with something due go on, in the same fairness order; reserving the others
    // would only hand them back at the claim, every tick. Before the account reads, so the
    // round's headroom is taken for the agents that can actually be dialled.
    let pickable = candidates;
    if (mode) {
      pickable = await this.agentsWithWorkDue(campaign, mode, candidates);
      if (pickable.length === 0) return { toDial: 0, candidates: [], idle: 'nothing_due' };
    }

    // Both account reads are per ROUND, not per tick (`pacing/round.ts`): the limit
    // through the engine's invalidated cache, the live calls read once per account
    // per round and never carried into the next.
    const accountKey = accountKeyOf(campaign.tenant_id, campaign.account_id);
    const accountLimit = await round.limit(accountKey, () => this.loadAccountLimit(campaign, round));
    // The WHOLE ACCOUNT's live calls: every campaign's attempts plus the soft
    // phone's live manual calls (docs/softphone.md §4.1). `accountLimit` is the
    // account's ceiling, and a manual call holds a carrier slot like any attempt
    // while belonging to no campaign, so no per-campaign count can see it.
    //
    // NOT the concurrency guard's Redis count, although it caps the same thing: the
    // guard counts a call from bridge admission to its release, this counts an
    // attempt from its insert (before admission) to `ended`, and the guard also
    // holds calls the dialer never made (another product's browser dial on the
    // account). The database count is the conservative one for pacing.
    const occupied = await round.liveCalls(accountKey, () =>
      agencyAttemptRepository.countLiveForAccount(campaign.tenant_id, campaign.account_id));

    /**
     * **The two limits constrain different things, and subtracting one from the
     * other counts every busy agent twice.**
     *
     * `candidates` is already only the *idle* agents — a busy one failed the
     * `state === 'available'` test above and is not in the list. `occupied` is
     * every non-terminal attempt on the campaign, which is those same busy
     * agents' calls. So `min(accountLimit, candidates.length) - occupied` would
     * remove each busy agent once by omission and again by subtraction, and dial
     * `idle − busy` instead of `idle`.
     *
     * With two agents and one on a call that is `1 − 1 = 0` **for every value of
     * `accountLimit`**, so the campaign could only ever dial when every agent was
     * simultaneously idle: an agent going available while a colleague's call rang
     * would wait, undialled, until both were idle.
     *
     * The correct reading is that they bound different quantities:
     *   • `accountLimit` caps **total concurrency**, so `occupied` counts against
     *     it — which is why `countLiveForAccount` includes bridged
     *     attempts (see the note on `tickOnce`).
     *   • `candidates.length` caps **new dials**, because only an idle agent can
     *     take one. Attempts already in flight have their agent and must not be
     *     charged against this half.
     */
    // `MAX(0, MIN(limit − occupied, idle))`, less whatever the account's other
    // campaigns planned this round — none, with one campaign per account.
    const toDial = round.takeHeadroom(accountKey, accountLimit, occupied, pickable.length);
    return {
      toDial, candidates: pickable, accountLimit, occupied, ...(toDial === 0 ? { idle: 'no_slots' as const } : {}),
    };
  }

  /**
   * The available agents worth reserving on an owner-mode campaign, in fairness order: those
   * with an own contact due, and (`preferred`) as many of the rest as the pool has due
   * contacts. Sends each candidate's `queue` frame on a change, from the same read.
   */
  private async agentsWithWorkDue(
    campaign: AgencyCampaignRecord,
    mode: AgencyOwnerClaimMode,
    candidates: AgentCandidate[],
  ): Promise<AgentCandidate[]> {
    // One live session per agent per tenant (`uq` on the session table) makes this a 1:1 map;
    // a repeat, or a row with no agent, is dropped rather than paired by guesswork.
    const seen = new Set<string>();
    const agents = candidates.filter((c) => {
      if (!c.agentUserId || seen.has(c.agentUserId)) return false;
      seen.add(c.agentUserId);
      return true;
    });
    if (agents.length === 0) return [];
    const { agents: readings, poolDue } = await readAgentQueues(
      campaign, mode, agents.map((c) => c.agentUserId), new Date(), agents.length,
    );
    this.sendQueueFrames(campaign.id, agents, readings);
    let poolLeft = mode === 'preferred' ? poolDue : 0;
    const out: AgentCandidate[] = [];
    for (const c of agents) {
      if (readings.get(c.agentUserId)?.ownDue) {
        out.push(c);
      } else if (poolLeft > 0) {
        out.push(c);
        poolLeft--;
      }
    }
    return out;
  }

  /** Send each agent's `queue` frame when it differs from the last one they were sent. */
  private sendQueueFrames(
    campaignId: string,
    agents: readonly AgentCandidate[],
    readings: ReadonlyMap<string, AgentQueueReading>,
  ): void {
    let sent = this.queueSent.get(campaignId);
    if (!sent) {
      sent = new Map();
      this.queueSent.set(campaignId, sent);
    }
    for (const agent of agents) {
      const reading = readings.get(agent.agentUserId);
      if (!reading) continue;
      const key = queueStateKey(reading.state);
      if (sent.get(agent.sessionId) === key) continue;
      const frame: AgencyStationQueueFrame = { event: 'queue', campaign_id: campaignId, ...reading.state };
      let delivered = false;
      try {
        delivered = this.stations.send(agent.sessionId, frame);
      } catch (err) {
        log.warn({ err, campaignId, sessionId: agent.sessionId }, 'Could not send a queue frame');
      }
      // Not remembered when it did not reach a station, so the next tick tries again.
      if (delivered) sent.set(agent.sessionId, key);
    }
  }

  /** Drop the `queue` frame memory of sessions no longer live; `live` null drops the campaign's. */
  private pruneQueueSent(campaignId: string, live: readonly string[] | null): void {
    const sent = this.queueSent.get(campaignId);
    if (!sent) return;
    if (live === null) {
      this.queueSent.delete(campaignId);
      return;
    }
    const keep = new Set(live);
    for (const sessionId of sent.keys()) if (!keep.has(sessionId)) sent.delete(sessionId);
  }

  /**
   * The owner sweeps (`pacing/callback-fallback.ts`): the unstaffed-owner return (CA6, with
   * `on_unstaff = 'return_to_pool'`) and the callback grace/fallback (CA5, with
   * `callback_fallback = 'pool'`), at most every {@link CALLBACK_FALLBACK_SWEEP_MS} per
   * campaign. A move wakes the campaign (and any other replica's view of it) as new contacts
   * would. A failure is logged and costs the tick nothing; one sweep's failure does not skip
   * the other.
   */
  private async maybeSweepCallbackFallback(campaign: AgencyCampaignRecord): Promise<void> {
    if (!ownerModeOf(campaign)) return;
    const returnUnstaffed = campaign.on_unstaff === 'return_to_pool';
    const fallBack = campaign.callback_fallback === 'pool';
    if (!returnUnstaffed && !fallBack) return;
    const now = this.now();
    const last = this.fallbackSweptAt.get(campaign.id);
    if (last !== undefined && now - last < CALLBACK_FALLBACK_SWEEP_MS) return;
    this.fallbackSweptAt.set(campaign.id, now);
    let moved = 0;
    if (returnUnstaffed) {
      try {
        moved += await sweepUnstaffedOwners(campaign);
      } catch (err) {
        log.error({ err, campaignId: campaign.id }, 'Unstaffed-owner sweep failed — retried on a later tick');
      }
    }
    if (fallBack) {
      try {
        moved += await sweepCallbackFallback(campaign);
      } catch (err) {
        log.error({ err, campaignId: campaign.id }, 'Callback fallback sweep failed — retried on a later tick');
      }
    }
    if (moved > 0) publishPacingInvalidation({ type: 'contacts_changed', campaignId: campaign.id });
  }

  /** `max_concurrent_calls`: cached between scheduled rounds, read through on a forced one. */
  private loadAccountLimit(campaign: AgencyCampaignRecord, round: PacingRound): Promise<number> {
    return this.limitCache.getOrLoad(
      accountKeyOf(campaign.tenant_id, campaign.account_id),
      () => accountSettingsRepository.getMaxConcurrentCalls(campaign.tenant_id, campaign.account_id),
      { fresh: round.fresh },
    );
  }

  /**
   * Reserve → claim → create attempt → dispatch.
   *
   * **Agents are reserved BEFORE any contact is claimed**, so that "a lost CAS
   * never consumes a claimed contact". Claiming a batch of contacts and then
   * hunting for agents would let a lost CAS move a real contact into `in_flight`
   * and back out again — recoverable,
   * but it made the contact's state a function of a race it had nothing to do with,
   * and every such round trip is a window where a crash strands the row for the
   * reaper. Reserving first means a lost CAS costs one Redis call and touches
   * nothing durable.
   */
  private async dialUpTo(campaign: AgencyCampaignRecord, plan: TickPlan): Promise<number> {
    // ── 1. Reserve agents first, strictly before the dial and now also
    //       strictly before the claim. The agent is committed before the carrier
    //       is contacted, which is what makes an answered call with no agent
    //       unreachable under strict power dialing.
    const reserved: AgentCandidate[] = [];
    for (const candidate of plan.candidates) {
      if (reserved.length >= plan.toDial) break;
      // A placeholder, not a fake attempt id: there is no attempt yet, and
      // `executeDial` overwrites this with the real one. Marked so a human reading
      // the Redis hash mid-dial can tell "reserving" from a lost attempt id.
      const res = await this.agents.reserve(candidate.sessionId, RESERVING_MARKER);
      if (res === 'reserved') reserved.push(candidate);
      // `reserved` is deliberately NOT mirrored to `agency_agent_sessions`
      // and the reason is worth keeping: a mirror here is
      // write-only. Every release path below — surplus, suppress, defer, no
      // station, the duplicate-dial backstop, dispatch failure, `abortRemainder`
      // — returns the agent through `this.agents.set(...)`, i.e. Redis alone
      // (`returnReserved`; only a break queued meanwhile goes through
      // `releaseAgent`, which mirrors the `break` it applies). So
      // a reservation written here is never written back, and an idle agent on a
      // campaign with nothing dialable (all contacts in retry backoff, or DNC-
      // suppressed) would be reserved and released every 250ms tick while the
      // supervisor's breakdown showed them stuck at `reserved` indefinitely.
      //
      // Two further costs made this a clear no: `setState` restamps
      // `state_since = now()`, which is the anchor the supervisor floor's risk ordering sorts on
      // — the same fairness-ordering harm documented at `recordIdle` above — and
      // it is an awaited round trip per reserved agent per tick on the dial path.
      //
      // The state is sub-second-to-15s transient and Redis owns it. `on_call` IS
      // mirrored, because `releaseAgent` mirrors the return.
      // 'lost' ⇒ another tick took them; 'unavailable' ⇒ Redis is unhappy and we
      // must not dial on a guess. Both just move to the next candidate.
    }
    if (reserved.length === 0) {
      this.recordIdle(campaign.id, 'no_reservations');
      return 0;
    }

    // ── 2. Claim exactly as many contacts as we hold agents for. ────────────
    //       `pool`: the shared queue, paired by index. `strict` / `preferred`: each agent's
    //       own (or, preferred, the pool's) contact, paired by the agent it was claimed for.
    const mode = ownerModeOf(campaign);
    const pairs = mode
      ? await this.claimForOwners(campaign, mode, reserved)
      : await this.claimPool(campaign, reserved);

    // Any agent we reserved and cannot pair with a contact goes straight back to
    // the pool — the roster ran out, which is not their fault and must not cost
    // them their place in the idle queue any longer than this tick.
    const paired = new Set(pairs.map((p) => p.sessionId));
    for (const surplus of reserved) {
      if (!paired.has(surplus.sessionId)) await this.returnReserved(surplus.sessionId);
    }
    if (pairs.length === 0) {
      this.recordIdle(campaign.id, 'no_contacts');
      return 0;
    }
    const contacts = pairs.map((p) => p.contact);
    const sessions = pairs.map((p) => p.sessionId);

    let dialed = 0;

    for (const [index, { sessionId, contact }] of pairs.entries()) {

      // ── 3. The compliance gates, in the tick: after the claim
      //       and BEFORE the attempt exists. Suppressing here costs no attempt row
      //       to unwind, and a `dial` decision carries the clearance the dispatcher
      //       refuses to place a call without.
      const gate = await evaluatePreDialGates(
        { campaign, contact, now: new Date() }, { dnc: this.dnc },
      );
      this.recordGate(campaign.id, gate);

      if (gate.action === 'halt') {
        // Campaign-wide, so the contacts claimed ALONGSIDE this one are abandoned
        // too: whatever stopped us answering for this number cannot answer for
        // them either, and dialing the rest of the batch is precisely the
        // "fail-open at volume" this gate exists to prevent.
        await this.abortRemainder(contacts.slice(index), sessions.slice(index));
        log.error(
          { campaignId: campaign.id, tenantId: campaign.tenant_id, gate: gate.gate, abandoned: contacts.length - index },
          'Agency pre-dial gate halted the tick — refusing to dial unchecked numbers',
        );
        return dialed;
      }

      if (gate.action === 'suppress') {
        // Terminal for the contact. No `bump_attempt`: no dial was placed, and
        // charging a retry for a call we declined to make would exhaust a contact
        // who was never called.
        this.logSkip(campaign, contact, gate);
        await this.returnReserved(sessionId);
        await agencyContactRepository.markState(contact.id, 'suppressed', {
          suppressed_reason: gate.suppressedReason,
        });
        continue;
      }

      if (gate.action === 'defer') {
        // The clock MUST move forward here. `deferUntil` is the next
        // window-open instant in the contact's own timezone, so the contact wakes
        // at the right local time with no scheduler — and does not spin.
        this.logSkip(campaign, contact, gate);
        await this.returnPair(sessionId, contact.id, gate.deferUntil);
        continue;
      }

      const ownerReplica = await this.stations.ownerOf(sessionId);
      if (!ownerReplica) {
        await this.returnPair(sessionId, contact.id, new Date(), 'offline');
        continue;
      }

      // Leadership can be given up at ANY await in this loop — the gates, the
      // ownership lookup and the attempt insert all yield. Checked per contact
      // rather than once, because a 5-contact batch spans several round trips and
      // each dial is a real call to a real person.
      if (!this.mayDial(campaign.id)) {
        await this.abortRemainder(contacts.slice(index), sessions.slice(index));
        log.warn(
          { campaignId: campaign.id, abandoned: contacts.length - index },
          'Agency campaign leadership was given up mid-tick — returning the remainder undialed',
        );
        return dialed;
      }

      // Campaign-wide and handled exactly like a `halt` gate: an unusable caller-ID
      // pool cannot be answered for this contact and cannot be answered for the ones
      // claimed alongside it either, so the whole remainder is returned rather than
      // half of it being carried out by a throw.
      const callerId = pickCallerId(usableCallerIds(campaign), dialed);
      if (!callerId) {
        await this.abortRemainder(contacts.slice(index), sessions.slice(index));
        // Latched, like the top-of-tick guard: this branch is only reachable if the
        // pool emptied between `findById` and here (a concurrent PATCH), and the
        // next tick's guard will catch it — so an unlatched log here would still
        // spin at 4 Hz for as long as the race kept losing.
        this.noteMisconfigured(campaign, 'lost its caller IDs mid-tick — returning every reserved agent');
        return dialed;
      }

      const attempt = await agencyAttemptRepository.create({
        campaignId: campaign.id,
        contactId: contact.id,
        tenantId: campaign.tenant_id,
        accountId: campaign.account_id,
        callerId,
        reservedAgentId: sessionId,
      });

      if (!attempt) {
        // The duplicate-dial backstop refused it. Something believed this contact
        // was dialable while a live attempt existed — release and move on. This is
        // the database doing its job, not an error.
        await this.returnPair(sessionId, contact.id, new Date());
        continue;
      }

      // The insert above yields too, and it is the last await before the dispatch:
      // a stop or a lost lease inside it must not become a call. The attempt row
      // exists by now, so it is ended `orphaned` (no dial went out) alongside the
      // remainder being returned.
      if (!this.mayDial(campaign.id)) {
        await agencyAttemptRepository.setState(attempt.id, 'ended', {
          outcome: 'orphaned', ended_at: new Date(),
        }).catch((err) => log.error({ err, attemptId: attempt.id }, 'Failed to end an undialed attempt'));
        await this.abortRemainder(contacts.slice(index), sessions.slice(index));
        log.warn(
          { campaignId: campaign.id, attemptId: attempt.id, abandoned: contacts.length - index },
          'Agency campaign stopped or lost its lease after the attempt insert — returning the remainder undialed',
        );
        return dialed;
      }

      try {
        await this.dispatcher.dispatch({
          attemptId: attempt.id,
          campaignId: campaign.id,
          contactId: contact.id,
          sessionId,
          ownerReplica,
          tenantId: campaign.tenant_id,
          accountId: campaign.account_id,
          callerId: attempt.caller_id,
          attemptNumber: attempt.attempt_number,
          campaign,
          contact,
          clearance: gate.clearance,
        }, {
          // The dial itself is several awaits away (flag read, priors); the dialer
          // asks this once more before it stamps the attempt dialled.
          stillAuthorised: () => this.mayDial(campaign.id),
        });
        dialed++;
      } catch (err) {
        log.error({ err, attemptId: attempt.id }, 'Dial dispatch failed');
        await agencyAttemptRepository.setState(attempt.id, 'ended', {
          outcome: 'failed', ended_at: new Date(),
        });
        await this.returnPair(sessionId, contact.id, new Date());
      }
    }
    return dialed;
  }

  /**
   * `pool` mode: `claimDialable` for as many contacts as agents are reserved, paired by index
   * (the claim returns them in due order and never more than asked; a longer answer would be
   * a claim bug, and its tail is handed back rather than dialled without an agent).
   */
  private async claimPool(campaign: AgencyCampaignRecord, reserved: readonly AgentCandidate[]): Promise<TickPair[]> {
    const contacts = await agencyContactRepository.claimDialable(campaign.id, reserved.length);
    if (contacts.length > reserved.length) {
      const extra = contacts.slice(reserved.length);
      log.error({ campaignId: campaign.id, asked: reserved.length, claimed: contacts.length },
        'Contact claim returned more rows than agents reserved — returning the extra undialled');
      await agencyContactRepository.unclaimMany(extra.map((c) => c.id), new Date());
    }
    return contacts.slice(0, reserved.length).map((contact, index) => ({ sessionId: reserved[index]!.sessionId, contact }));
  }

  /**
   * `strict` / `preferred`: one claim for every reserved agent (`claimForAgents`), each row
   * paired with the agent it was claimed FOR, never by position. The pairing is checked
   * again here, as defence in depth on the rule that matters most (a customer is never put
   * through to another agent's queue): a row whose owner is not the agent it names (strict:
   * owner = agent; preferred: owner = agent or nobody), names an agent not reserved, or names
   * one twice is handed back undialled and logged as the claim bug it would be. Pairs come
   * back in reservation order, so a tick's dial order is reproducible.
   */
  private async claimForOwners(
    campaign: AgencyCampaignRecord,
    mode: AgencyOwnerClaimMode,
    reserved: readonly AgentCandidate[],
  ): Promise<TickPair[]> {
    const claims = await agencyContactRepository.claimForAgents(
      campaign.id, reserved.map((r) => r.agentUserId), mode,
    );
    const byUser = new Map(reserved.map((r, order) => [r.agentUserId, { sessionId: r.sessionId, order }]));
    const taken = new Set<string>();
    const pairs: Array<TickPair & { order: number }> = [];
    const stray: string[] = [];
    for (const { agentUserId, contact } of claims) {
      const agent = byUser.get(agentUserId);
      const owner = contact.assigned_user_id ?? null;
      const ownerOk = owner === agentUserId || (mode === 'preferred' && owner === null);
      if (!agent || !ownerOk || taken.has(agent.sessionId)) {
        stray.push(contact.id);
        continue;
      }
      taken.add(agent.sessionId);
      pairs.push({ sessionId: agent.sessionId, contact, order: agent.order });
    }
    if (stray.length > 0) {
      log.error({ campaignId: campaign.id, mode, stray: stray.length },
        'Owner claim returned contacts it could not pair with their owner — returning them undialled');
      await agencyContactRepository.unclaimMany(stray, new Date());
    }
    pairs.sort((a, b) => a.order - b.order);
    return pairs.map(({ sessionId, contact }) => ({ sessionId, contact }));
  }

  /**
   * Hand back one reserved agent and the contact claimed for them: the agent to
   * `agentState` (the pool — or their queued break, {@link returnReserved} — or
   * `offline` when no replica owns their station) and the contact to `pending` at
   * `nextAttemptAt`. `set`'s default lease is the `available` one.
   */
  private async returnPair(
    sessionId: string,
    contactId: string,
    nextAttemptAt: Date,
    agentState: 'available' | 'offline' = 'available',
  ): Promise<void> {
    if (agentState === 'available') await this.returnReserved(sessionId);
    else await this.agents.set(sessionId, agentState);
    await agencyContactRepository.unclaim(contactId, nextAttemptAt);
  }

  /**
   * Return every agent and contact a halted tick had already taken.
   *
   * Unclaimed at `now()`, deliberately rather than by oversight: the condition
   * that stopped us — the registry could not answer — genuinely clears the moment
   * it can, so pushing the clock forward would delay a recovered campaign for no
   * reason. It usually does not spin: a DNC read that fails because the database is
   * unavailable leaves the claim, which reads the same database, failing too, so
   * such a tick never reaches a claim.
   */
  private async abortRemainder(contacts: AgencyContactRecord[], sessions: string[]): Promise<void> {
    for (const sessionId of sessions) {
      await this.returnReserved(sessionId);
    }
    // One statement for the whole remainder, not one round trip per contact.
    await agencyContactRepository.unclaimMany(contacts.map((c) => c.id), new Date());
  }

  /**
   * Log one contact the gates declined to dial — the `suppress` and `defer` arms.
   *
   * The `halt` arm already logs (it is campaign-wide and abandons the batch); these
   * two did not, and that silence is the whole reason this exists. A campaign whose
   * every contact defers is indistinguishable from one that is working: the agent
   * console sits on "waiting for a call", no error is raised, and the only evidence
   * is `agency_predial_gate_total` — a counter with no contact on it, so it can say
   * *that* six were skipped but never *which* six or *why*. Diagnosing it meant
   * reading a campaign config out of the database by hand.
   *
   * **`info`, deliberately, not `debug`.** A debug line would not have helped: the
   * deployed log level is `info`, so the one question this answers — "the campaign
   * is running and dialing nothing, why?" — would still need a redeploy to ask.
   *
   * Volume is bounded by the dialer's own shape rather than by a sampler, which is
   * why per-contact logging is affordable here. `dialUpTo` claims exactly as many
   * contacts as it holds reserved agents, so the skip rate can never exceed the
   * agent count per tick; a deferred contact is then parked until `deferUntil`, so
   * it is not re-claimed on the next tick. The pathological case — a whole roster
   * out of hours — is self-limiting from the other side too: no agents online means
   * no reservations, which means no claims and no skips to log.
   *
   * `phone` is the field name **because that is the one pino redacts**. The logger
   * masks `phone`/`*.phone` through `maskPhone` (`REDACT_PATHS`, `src/utils/logger.ts`),
   * and `phone_e164` — the column's actual name, and the obvious thing to spread in
   * — is not on that list and would ship the customer's number to log storage in
   * cleartext. `csv_line_number` rides along so an operator can find the row in the
   * uploaded file without needing the number unmasked at all.
   */
  private logSkip(
    campaign: AgencyCampaignRecord,
    contact: AgencyContactRecord,
    decision: Extract<PreDialDecision, { action: 'suppress' | 'defer' }>,
  ): void {
    // The campaign's calling window, on the line, for the gates that turn on it.
    // Config rather than PII, and it is the answer to "why closed" — without it the
    // reader has the verdict and still has to go find the evidence in Postgres.
    const window = decision.gate === 'calling_hours' || decision.gate === 'calling_hours_unresolvable'
      ? {
          callingWindowStart: campaign.calling_window_start,
          callingWindowEnd: campaign.calling_window_end,
          callingDays: campaign.calling_days,
          campaignTimezone: campaign.default_timezone,
          contactTimezone: contact.timezone,
        }
      : {};

    log.info(
      {
        campaignId: campaign.id,
        tenantId: campaign.tenant_id,
        contactId: contact.id,
        // Masked by the logger's redaction — see the note above on the field name.
        phone: contact.phone_e164,
        csvLine: contact.csv_line_number,
        gate: decision.gate,
        action: decision.action,
        ...(decision.action === 'defer'
          ? { deferUntil: decision.deferUntil.toISOString() }
          : { suppressedReason: decision.suppressedReason }),
        ...window,
      },
      decision.action === 'defer'
        ? 'Agency pre-dial gate deferred a contact — no call placed'
        : 'Agency pre-dial gate suppressed a contact — no call placed',
    );
  }

  /**
   * Count a gate decision. **Wrapped, because it sits one line after a function
   * written specifically to be total.**
   *
   * `evaluatePreDialGates` never throws precisely so a compliance failure cannot
   * abort a tick with agents reserved and contacts claimed — the pacing engine's
   * error path would recover eventually, but the incident would read as a pacing
   * bug rather than a compliance one. An unguarded `inc()` on the very next line
   * can do exactly that damage: a throw from the metrics layer, and a telemetry
   * fault becomes a dialing outage.
   *
   * The general shape is worth remembering: care taken to make a function total
   * creates confidence that does not extend one line past it. Telemetry is what we
   * sacrifice; dialing is not.
   */
  private recordGate(campaignId: string, decision: PreDialDecision): void {
    // `dial` is counted too, so the gate's own throughput is visible: a `gate`
    // series with no `cleared` alongside it means everything is being stopped, and
    // a reviewer should be able to see that without a second query.
    const gate = decision.action === 'dial' ? 'cleared' : decision.gate;
    // `gate="dnc_unavailable"` is the signal that distinguishes a correct
    // compliance halt from a bug; it is exported over OTLP, the only view that
    // can be alerted on.
    safeEmit('agency-predial-gate', () => agencyPreDialGateTotal.inc({
      campaign_id: campaignId, gate, action: decision.action,
    }));
  }

  private recordIdle(campaignId: string, reason: TickIdleReason): void {
    // Same rule. This one is called from `planTick`'s result handling, where a
    // throw would abort the tick before it reserved anything — less damaging, and
    // still not a trade worth making for a counter.
    safeEmit('agency-tick-idle', () => agencyTickIdleTotal.inc({ campaign_id: campaignId, reason }));
  }

  /**
   * Finalize on an idle tick. `running → completed` and `stopping → stopped` have
   * exactly one writer — this — so a supervisor's pause cannot race it.
   *
   * ── Two transitions, two questions, two predicates ──────────────────────────
   *
   * `running → completed` asks **"is there any work left?"**, so it counts the
   * ROSTER: a `pending` contact whose retry is hours out is outstanding work and
   * has to hold the campaign open.
   *
   * `stopping → stopped` asks a different question — **"have the calls we already
   * placed finished?"** — and answering it with the roster count was a defect with
   * the same reach as the flag gate in `superviseInner`. Stop means stop dialing:
   * the contacts that will now never be dialed are not work in progress. A campaign
   * stopped at row 100 of a 50 000-row list still had 49 900 `pending` rows and
   * nothing ever clears them, so `countOutstanding` could not reach 0 and the row
   * could not leave `stopping` — with a leader, with the flag on, indefinitely.
   * Live ATTEMPTS are what "drain" means here, and they are what is counted.
   *
   * A wrap-up still open when the last attempt ends does NOT hold the campaign in
   * `stopping`: the attempt row is already `ended`, the disposition route works on
   * a terminal campaign, and wrap-up lives in one replica's memory where a leader
   * on another cannot see it. The observable is the attempt.
   */
  private async maybeFinalize(campaign: AgencyCampaignRecord): Promise<void> {
    if (campaign.status !== 'running' && campaign.status !== 'stopping') return;
    const outstanding = campaign.status === 'stopping'
      ? await agencyAttemptRepository.countLive(campaign.id)
      : await agencyCampaignRepository.countOutstanding(campaign.id);
    if (outstanding > 0) return;
    // A stopping campaign whose in-flight attempts have drained is stopped; a
    // running one that has run out of work is completed.
    const to = campaign.status === 'stopping' ? 'stopped' : 'completed';
    // No patch. `ended_at` (and its legacy twin `completed_at`) are derived from
    // the TARGET STATUS inside `transitionStatus`, so the leader carries no
    // opinion about them — and the actor is derived
    // there too: `stopping → stopped` inherits whoever pressed Stop, while
    // `running → completed` correctly clears to NULL, because nobody completed the
    // campaign, the list ran out.
    const updated = await agencyCampaignRepository.transitionStatus(
      campaign.id, [campaign.status], to,
    );
    if (updated) {
      log.info({ campaignId: campaign.id, status: to }, 'Agency campaign finalized');
      // The two terminal transitions have no HTTP actor. A NULL actor
      // reads as "attribution lost". This is the single writer of
      // running→completed and stopping→stopped, so the row is the record that
      // the campaign actually ended — not that a supervisor pressed Stop.
      auditLogger.log({
        tenantId: campaign.tenant_id,
        accountId: campaign.account_id,
        eventType: `agency_campaign.${to}`,
        eventCategory: 'call',
        severity: 'info',
        actor: 'system:pacing-leader',
        eventData: { campaign_id: campaign.id, from: campaign.status, to },
      });
      // The completion notice, inside `if (updated)` because this is where the
      // transition is known to have been WON, by the single writer of both terminal
      // transitions, so the notice is requested exactly once per campaign even if two
      // ticks race. NOT awaited: a mail fan-out to every supervisor must not hold the
      // floor announcement and the lease release below behind an SMTP round trip.
      // The notifier is total (every failure is a returned reason) and the `.catch` is
      // the backstop — a notice must never abort `relinquish`. Tracked in
      // `inFlightNotices` so `stop()` can drain it.
      if (this.completionNotifier) {
        const notice: Promise<void> = this.completionNotifier.notifyCampaignFinished(updated, to).catch((err) =>
          log.error({ err, campaignId: campaign.id }, 'Campaign completion notice failed'));
        this.inFlightNotices.track(notice);
      }
      // Tell every agent BEFORE we relinquish — after this the leader is gone and
      // nothing else knows the list drained. List exhaustion is the normal end of
      // every run, so this is the ordinary path, not an edge case.
      this.announceCampaignState(
        updated,
        to === 'completed' ? 'list_exhausted' : 'stopped_by_supervisor',
      );
      this.lastStatus.delete(campaign.id);
      await this.relinquish(campaign.id);
    }
  }

  /** Last status we told agents about, per led campaign. */
  private readonly lastStatus = new Map<string, AgencyCampaignStatus>();

  /**
   * The last `queue` frame each agent was sent, per campaign (`queueStateKey`), so a frame
   * goes out only on a change (contact assignment, CA3). An entry is dropped when its session
   * is no longer live on the campaign (left), and the campaign's map when the campaign is
   * `pool` or its leadership is given up. A `ready` frame or the bootstrap carries the state
   * at (re)connect, so a reconnect needs no resend.
   */
  private readonly queueSent = new Map<string, Map<string, string>>();

  /** When each led campaign was last swept for overdue callbacks (engine clock). */
  private readonly fallbackSweptAt = new Map<string, number>();

  /** Campaign ids this replica currently leads (observability + tests). */
  leading(): string[] {
    return [...this.led.keys()];
  }
}

/** What tells two reads of a campaign row apart: its `updated_at`, which every write stamps. */
function rowVersion(row: AgencyCampaignRecord): string {
  const at = (row as { updated_at?: Date | string | null }).updated_at;
  return at instanceof Date ? at.toISOString() : String(at ?? '');
}
