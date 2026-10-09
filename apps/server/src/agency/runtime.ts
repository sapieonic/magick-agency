import crypto from 'node:crypto';
import type Redis from 'ioredis';
import type WebSocket from 'ws';
import { createChildLogger } from '@magick-agency/observability';
import type { WebRtcBridgeManager } from '../core/webrtc-bridge-manager.js';
import { agencyAgentSessionRepository } from '../db/repositories/agency.repository.js';
import type { AgencyAgentState } from '@magick-agency/contracts/agency';
import { StationRegistry } from './station-registry.js';
import { AgentStateMachine, AGENT_LEASE_MS } from './agent-state-machine.js';
import { AgencyDialer } from './agency-dialer.js';
import { LocalDialDispatcher } from './dial-dispatcher.js';
import { PacingEngine } from './pacing-engine.js';
import { AgencyReaper } from './reaper.js';
import { refreshAbandonmentWindow, startAbandonmentMetricsRefresh } from './abandonment-metrics.js';
import { refreshLiveConcurrency, startLiveConcurrencyRefresh } from './live-concurrency-metrics.js';
// PORT NOTE (magick-agency): core also imported `AgencyAttemptBatcher` (billing, plan §8
// Phase 6 "no attempt batcher"), `AgencyDncOutboxSweeper` and `createDncResyncRequester` /
// `warnIfDncSelfHealUnavailable` (the DNC outbox and Redis-set resync, decision B8), and
// the timers `ATTEMPT_BATCH_SWEEP_MS` / `DNC_OUTBOX_SWEEP_MS` that only they read. All
// deleted; see PORTING.md Phase 6. The completion notice is new wiring (see its module).
import {
  ABANDONMENT_REFRESH_MS, AGENCY_LIVE_CONCURRENCY_REFRESH_MS,
  STATION_HEARTBEAT_GRACE_MS, STATION_HEARTBEAT_SWEEP_MS,
  STATION_SWEEP_IDLE_PASSES_BEFORE_DORMANT,
} from '@magick-agency/domain/timers';
import { StationTokenStore } from './station-token.js';
import { DncRegistry } from './dnc-registry.js';
import { notifyAgencyCampaignFinished } from './campaign-completion-notice.js';
import { WrapupManager } from './wrapup-manager.js';
import { BreakRegistry } from '@magick-agency/domain/break-manager';

const log = createChildLogger({ component: 'agency-runtime' });

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
  readonly tokens: StationTokenStore;
  /**
   * The Do Not Call set (`AD-P3-C-06`). Exposed because the S2S sync route and any
   * test that needs its tenant to be authoritative go through the same object — a
   * test-only seeding backdoor would mean the suites prove something production
   * never does.
   */
  readonly dnc: DncRegistry;

  constructor(bridge: WebRtcBridgeManager, redis: Redis | null, keyPrefix: string) {
    // Stable for the life of the process. Under D2 there is one replica, but the
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
    this.dialer = new AgencyDialer(bridge, this.stations, this.agents, this.wrapup, this.breaks);
    // Both liveness questions the periodic sweep needs, as lazy closures rather
    // than references: `this.dialer` is assigned above but the arrow keeps the
    // reaper independent of construction order, and re-reading on every sweep is
    // the point — a snapshot taken here would be empty forever.
    //
    // Same shape as `CallManager.registerWebrtcActiveIdsProvider`: the sweeper
    // asks what is live rather than being told, so nothing has to remember to
    // update it.
    this.reaper = new AgencyReaper({
      activeAttemptIds: () => this.dialer.activeAttemptIds(),
      ownerOf: (sessionId) => this.stations.ownerOf(sessionId),
    });
    this.tokens = new StationTokenStore(redis, keyPrefix);

    // PORT NOTE (magick-agency, decision B8): core built `new DncRegistry(redis,
    // keyPrefix, createDncResyncRequester())` — a Redis set master published into, plus
    // the self-heal trigger (`AD-P3-C-07`) that asked master for a resync when a tenant
    // had no baseline. Collapsed: the registry is one indexed read of `dnc_entries` and
    // fails closed on any read fault, so there is no set, no baseline and nothing to
    // resync. The default argument is the shared `dncRepository`.
    this.dnc = new DncRegistry();
    const dispatcher = new LocalDialDispatcher(this.replicaId, (cmd) => this.dialer.executeDial(cmd));
    this.pacing = new PacingEngine(
      redis, keyPrefix, this.replicaId, this.stations, this.agents, dispatcher, this.dnc,
    );
    // PORT NOTE (magick-agency): core registered the billing batcher here
    // (`AD-P2-C-09`, deleted) and constructed the DNC outbox sweeper (MAG-110,
    // deleted by B8). The engine's "something may want to know a campaign finished"
    // seam now carries the supervisors' completion notice instead — the in-process
    // form of master's `/webhooks/core/agency-campaign-completed`, which core never
    // called. See `campaign-completion-notice.ts`.
    this.pacing.registerCompletionNotifier({ notifyCampaignFinished: notifyAgencyCampaignFinished });
  }

  // ─── Presence resilience (`AD-P2-C-07`) ───────────────────────────────────

  /**
   * What state a station socket's owner comes back in. **Redis, or `break`.**
   *
   * These two lines are the whole of acceptance (c) and (d), and they live here
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
   * A **lapsed** lease means either a genuine absence or a process restart, and
   * both must land in `break` (D2): after a restart the reaper has written
   * `offline`, and before one the row may say `available`, so no row-derived rule
   * is safe. `break` is the one answer that is correct in every case — the agent
   * chooses to go available, and nothing dials into them until they do.
   */
  async rehydrateAgent(sessionId: string): Promise<AgencyAgentState> {
    const live = await this.agents.get(sessionId);
    if (live) return live.state;

    await this.agents.set(sessionId, 'break', { leaseMs: AGENT_LEASE_MS.break });
    // Best-effort mirror. Redis is the authority; a failed write here costs a
    // durable record, never correctness.
    await agencyAgentSessionRepository.setState(sessionId, 'break')
      .catch((err) => log.warn({ err, sessionId }, 'Could not mirror rehydrated agent state'));
    return 'break';
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
    // ── BELT AND BRACES: THE SUPERSEDE GATE, RE-ASKED AT THE WRITE ──────────
    //
    // A review flagged the close handler's own `socketFor` check as racing this
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
    // the top of this method — and the presence stomp of `86d44papk` is live
    // again, in a window no test covers and no type checks. It is a guard against
    // a future edit, not against a schedule, which is why the test that pins it
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
    await this.agents.set(sessionId, 'offline', { leaseMs: AGENT_LEASE_MS.available });
    await agencyAgentSessionRepository.setState(sessionId, 'offline')
      .catch((err) => log.warn({ err, sessionId }, 'Could not mirror offline agent state'));
    return true;
  }

  // ─── The heartbeat grace (D8) ─────────────────────────────────────────────

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
   * 1. **Never a socket that is mid-attempt.** This socket IS the media leg (§7),
   *    and media frames do not renew `lastSeen` — only `ping` does — so a console
   *    whose heartbeat timer died while its audio kept flowing is exactly the shape
   *    that would be closed here. That would put a live customer on silence and arm
   *    the deferred hangup, on the strength of a timer the *client* stopped. The
   *    guard is `dialer.hasLiveAttempt`, the same authority
   *    {@link releaseStationOnClose} uses and the one that spans `dialing` through
   *    the deferred-hangup window. An agent in wrap-up has no live attempt and IS
   *    closable: the call is already over and `ready` will restore their countdown.
   * 2. **Never a socket that is already CLOSING.** `close()` starts a handshake and
   *    the entry stays in the registry until `close` fires, so an unguarded sweep
   *    would re-close and re-log the same socket every tick and never go dormant.
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
   * a backstop.
   */
  sweepSilentStations(graceMs = STATION_HEARTBEAT_GRACE_MS, now = Date.now()): number {
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
        this.dialer.noteStationClosed(entry.sessionId);
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

      // Rule 2: CLOSING (and a socket somehow still CONNECTING) is left alone.
      if (entry.ws.readyState !== 1 /* OPEN */) continue;

      log.warn({
        sessionId: entry.sessionId,
        campaignId: entry.campaignId,
        silentForMs: now - entry.lastSeen,
      }, 'Station heartbeat lapsed past its grace — closing the socket');
      // 4408: re-mint and retry, exactly as 4401 is. The console must come back.
      try { entry.ws.close(4408, 'station_heartbeat_timeout'); } catch { /* already gone */ }
      acted++;
    }
    return acted;
  }

  /**
   * Arm the silent-station sweep. Called after every station attach.
   *
   * Demand-driven and self-dormant, the same shape as `KbIngestRecovery.wake` and
   * `CallManager`'s self-heal poll. The dormancy condition is a pass that closed
   * nothing **and** found no stations at all, twice over — not merely an idle pass:
   * a healthy station can fall silent at any moment, and its attach has already
   * happened, so nothing would re-arm the timer.
   */
  wakeStationSweep(): void {
    this.stationSweepIdlePasses = 0;
    if (this.stationSweepTimer) return;
    this.stationSweepTimer = setInterval(() => {
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
    }, STATION_HEARTBEAT_SWEEP_MS);
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

  async start(): Promise<void> {
    // PORT NOTE (magick-agency, decision B8): core first called
    // `warnIfDncSelfHealUnavailable()` — the DNC cold-start warning about the Redis
    // set's self-heal. There is no set and no self-heal: the table is always the
    // baseline. Deleted with `dnc-resync.ts`.

    this.dialer.start();
    await this.reaper.reapOnStartup();
    this.reaper.start();
    this.pacing.start();
    // The compliance window (`AD-P2-C-06`). Published on a timer because it is
    // read from the table, which is also what makes it correct across a restart —
    // and it is refreshed **once immediately**, not only on the first tick, so a
    // freshly booted replica does not serve an empty rate for a whole interval
    // while the guardrail is reading it.
    this.abandonmentMetrics = startAbandonmentMetricsRefresh(ABANDONMENT_REFRESH_MS);
    void refreshAbandonmentWindow().catch((err) =>
      log.warn({ err }, 'Initial abandonment window refresh failed — the timer will retry'));
    // The dialer's live-concurrency signal (pilot finding 4 — `calls_active_current`
    // reads flat 0 for the dialer). Refreshed once immediately for a different
    // reason than the abandonment window: nothing reads this in process, so an
    // empty first interval costs no decision — but the series would be ABSENT
    // rather than zero for 15s after every deploy, and "the dialer is exporting
    // nothing" is exactly the shape of the staleness alarm this family is meant to
    // make meaningful. Publishing at boot keeps absence attributable to a failing
    // read rather than to a rollout.
    this.liveConcurrencyMetrics = startLiveConcurrencyRefresh(AGENCY_LIVE_CONCURRENCY_REFRESH_MS);
    void refreshLiveConcurrency().catch((err) =>
      log.warn({ err }, 'Initial agency live-concurrency refresh failed — the timer will retry'));
    // PORT NOTE (magick-agency): core started the hourly billing sweep
    // (`attemptBatcher.start(ATTEMPT_BATCH_SWEEP_MS)`, deleted — no billing) and the
    // DNC outbox retry (`dncOutbox.start(DNC_OUTBOX_SWEEP_MS)`, deleted — B8) here.
    log.info({ replicaId: this.replicaId }, 'Agency dialer runtime started');
  }

  async stop(): Promise<void> {
    // Pacing stops FIRST, so `maybeFinalize`'s campaign-end flush has already run for
    // anything finalizing on the way down before the batcher's timer is cleared.
    // (PORT NOTE: the batcher is gone; pacing still stops first, so no tick can dial
    // or finalize while the rest of the runtime is coming down.)
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
    // PORT NOTE (magick-agency): core stopped the billing batcher's timer and
    // gracefully requeued the DNC outbox's claimed rows here; both are deleted.
    this.dialer.stop();
    // Timers only — agents are NOT returned to the pool here. Their sockets die
    // with the process and D2 lands them in `break` on reconnect, so returning
    // them to `available` on the way out would be a lie the next boot inherits.
    this.wrapup.stop();
    // Station sockets are closed by the HTTP server's own shutdown; agents
    // rehydrate into `break` on reconnect (D2), never `available`.
    log.info('Agency dialer runtime stopped');
  }
}
