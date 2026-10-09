import { createChildLogger } from '@magick-agency/observability';
import { agencyAgentSessionRepository, agencyAttemptRepository } from '../db/repositories/agency.repository.js';
import type { StationRegistry } from './station-registry.js';
import { AgentStateMachine, AGENT_LEASE_MS } from './agent-state-machine.js';
import type { AgencyBreakReason, AgencyWrapupHoldReason, AgencyWrapupState } from '@magick-agency/contracts/agency';
import { agencyWrapupSeconds } from '@magick-agency/observability/metrics/agency';

const log = createChildLogger({ component: 'agency-wrapup' });

/** Why a wrap-up ended, for the log and for the caller's own bookkeeping. */
export type WrapupResolution =
  | 'auto_return'
  | 'disposition_submitted'
  /**
   * The agent went available themselves, before the window ran out.
   *
   * It is genuinely distinct from `disposition_submitted`:
   * submitting a disposition already resolves the wrap-up (see `submitDisposition`),
   * so by the time the go-available route runs, this arm is reached only when NO
   * disposition was submitted and none was required — an agent finishing early and
   * saying so.
   *
   * It exists because these are the FASTEST wrap-ups, and without it they would be
   * the ones that vanished: `cancel()` would record nothing, so the average would be built
   * from `auto_return` (agents who used the entire window) and little else, and
   * would have argued for a longer allotment on evidence that excluded everyone who
   * needed less time.
   */
  | 'agent_returned'
  | 'forced'
  | 'agent_left'
  | 'campaign_stopped';

interface WrapupEntry {
  sessionId: string;
  attemptId: string;
  campaignId: string;
  /** Only for the duration series' label set — never read as authority. */
  tenantId: string;
  secondsTotal: number;
  autoReturn: boolean;
  requiresDisposition: boolean;
  dispositionSubmitted: boolean;
  /**
   * When this wrap-up began, for the duration series.
   *
   * Deliberately not `secondsTotal` and not derived from `endsAt`: the allotment
   * is what was OWED and a timerless wrap-up has no deadline at all, while what
   * a pacing decision needs is how long the agent actually took. The durable
   * pairing (`wrapup_started_at` / `wrapup_ended_at`) says the same thing to SQL;
   * this is the in-process twin that lets the histogram be observed without a
   * read-back on the path that returns an agent to the pool.
   */
  startedAt: Date;
  /** Null once the timer has fired and the agent is being held. */
  endsAt: Date | null;
  heldReason: AgencyWrapupHoldReason | null;
  timer: NodeJS.Timeout | null;
}

/**
 * Wrap-up: the window after a conversation in which the agent is out of the pool,
 * writing up the call.
 *
 * **The countdown is an in-process timer plus the attempt row. It is never a Redis
 * TTL, and the lease rule is not negotiable on this.** The `wrapup` lease is the flat 15s
 * heartbeat lease, byte-identical to `available`, and its expiry means *the process
 * died* — not that wrap-up finished. A TTL cannot tell those apart, and if wrap-up
 * expiry were a TTL then a campaign configured with a 60-minute wrap-up would also
 * be configuring a 60-minute liveness window, during which a dead agent would still
 * be counted by the pacing tick.
 *
 * The durable half is `agency_call_attempts.wrapup_seconds` alongside `ended_at`:
 * together they say what was owed and from when, which is what lets the
 * reaper's `no_disposition` sweep finish a wrap-up this process is no longer
 * around to finish. Deliberately not resumed after a restart — a restart lands every
 * returning agent in `break`, so there is no live socket to run a countdown for,
 * and the sweep is the thing that closes the attempt.
 */
export class WrapupManager {
  private readonly entries = new Map<string, WrapupEntry>();

  constructor(
    private readonly stations: StationRegistry,
    private readonly agents: AgentStateMachine,
    /** Called when an agent leaves wrap-up and should re-enter the pool. */
    private readonly onReturn: (sessionId: string, resolution: WrapupResolution) => Promise<void>,
  ) {}

  /** Wrap-ups currently running on this replica (observability + tests). */
  active(): number {
    return this.entries.size;
  }

  stateFor(sessionId: string): AgencyWrapupState | null {
    const e = this.entries.get(sessionId);
    return e ? this.snapshot(e) : null;
  }

  /**
   * Put an agent into wrap-up after a conversation.
   *
   * Returns false when there is nothing to hold the agent for, which the caller
   * must treat as "send them straight back to `available`".
   * Deliberately reported rather than silently handled here: the caller owns the
   * agent's return path, and a wrap-up manager that sometimes returned agents
   * itself and sometimes did not would be two code paths for one transition.
   *
   * ── `wrapup_seconds = 0` WITH a required disposition ────────────────────────
   * **`wrapup_seconds = 0` means "no timer", not "no wrap-up".** Two rules read as
   * contradictory in this one combination — zero returns the agent immediately,
   * and an outstanding required disposition must not auto-return — and the second
   * is the one that wins, because it is stated unconditionally.
   *
   * The alternative is not a race a fast agent loses; it is structural data loss.
   * With no window there is nothing protecting the disposition: the attempt ends,
   * the agent is `available`, the tick reserves them within 250ms, and the record
   * of what was said to a customer is never captured. Worse, it fails silently
   * *and* poisons the retry policy — the reaper's lapsed-wrap-up sweep would stamp
   * `no_disposition` on every single attempt of such a campaign.
   *
   * So a required disposition opens a **timerless** wrap-up: held from the instant
   * it starts, `ends_at: null`, ended only by the agent submitting or a supervisor
   * forcing. That is the same path `wrapup_auto_return = false` already takes, so
   * this unifies two configurations rather than adding a third. It is also the
   * most efficient honest reading of the operator's intent — no fixed delay, and
   * the agent returns the instant they are done.
   *
   * Rejecting the combination at campaign config was the other candidate. It would
   * have made a legitimate and desirable setup impossible, and it needed the same
   * validation duplicated in the campaign-config surface to be worth anything.
   */
  async enter(params: {
    sessionId: string;
    attemptId: string;
    campaignId: string;
    /** Label only, for `agency_wrapup_seconds` — this class reads no tenancy. */
    tenantId: string;
    wrapupSeconds: number;
    autoReturn: boolean;
    requiresDisposition: boolean;
    /**
     * A **reader** for the break the agent has queued mid-call, if any — peeked,
     * never taken.
     *
     * A function rather than a `BreakRegistry` this class would otherwise have to
     * hold: the queue's whole lifecycle (queue → peek → take) belongs to the dialer,
     * which consumes it in `releaseAgent`, and a wrap-up manager that could reach the
     * registry is one edit away from consuming it here — which would silently drop
     * the agent's break, since `take()` applies exactly once.
     *
     * ── Why a function and not the value ────────────────────────────────────────
     * It *was* the value, and that was a race. `enter` performs several awaited
     * Redis and DB writes before it can announce the transition, and the break
     * routes emit their own `agent_state` frames: an agent queueing or cancelling a
     * break inside that window got their frame first, and this one then landed
     * afterwards carrying a snapshot taken before it — clearing a badge that should
     * be lit, or lighting one the agent had just cancelled. Read immediately before
     * the frame is built, with no await in between, the last read wins because it
     * happens last.
     *
     * Announced on the state frame only. Nothing here queues, cancels or consumes it.
     */
    readPendingBreak?: () => AgencyBreakReason | null;
  }): Promise<boolean> {
    const timed = params.wrapupSeconds > 0;
    if (!timed && !params.requiresDisposition) return false;

    // A second `enter` for one session would leak the first timer and leave two
    // timers racing to return one agent. Cancel rather than stack.
    this.cancel(params.sessionId);

    // Nothing will end this on its own unless there is BOTH a window to count down
    // and auto-return switched on. Reported honestly rather than echoing campaign
    // config: a console shown `auto_return: true` with `ends_at: null` cannot tell
    // "waiting for you" from "the countdown failed to arrive".
    const willAutoReturn = timed && params.autoReturn;
    const entry: WrapupEntry = {
      sessionId: params.sessionId,
      attemptId: params.attemptId,
      campaignId: params.campaignId,
      tenantId: params.tenantId,
      secondsTotal: params.wrapupSeconds,
      autoReturn: willAutoReturn,
      requiresDisposition: params.requiresDisposition,
      dispositionSubmitted: false,
      startedAt: new Date(),
      // No deadline at all when nothing will end it on its own. The console renders
      // `ends_at: null` as "ends when you act", not as an expired countdown.
      endsAt: willAutoReturn ? new Date(Date.now() + params.wrapupSeconds * 1000) : null,
      // A timerless wrap-up is held from the instant it starts — there is no
      // countdown for the console to show, and the agent needs the reason NOW
      // rather than after a timer that will never fire.
      heldReason: !timed ? 'disposition_required' : null,
      timer: null,
    };
    this.entries.set(params.sessionId, entry);

    await this.agents.set(params.sessionId, 'wrapup', {
      attemptId: params.attemptId,
      // The FLAT heartbeat lease — never `wrapupSeconds`. See the class comment.
      leaseMs: AGENT_LEASE_MS.wrapup,
    });
    await agencyAgentSessionRepository.setState(params.sessionId, 'wrapup')
      .catch((err) => log.warn({ err, sessionId: params.sessionId }, 'Could not mirror wrapup state'));
    // The durable half: what was owed, and from when.
    //
    // `wrapup_started_at` is stamped HERE rather than read off `ended_at`, even
    // though the two are equal today. `ended_at` is written by whoever settles the
    // attempt, through a patch this call does not send, so treating it as the wrap-up
    // anchor is an inference about two writers agreeing — the abandonment predicate
    // once went vacuous exactly that way, when `answered_at` written from `bridgedAt`
    // made it read 0 while its test passed. The average wrap-up the supervisor tunes
    // against measures this anchor, so it owns one.
    const attempt = await agencyAttemptRepository.setState(params.attemptId, 'ended', {
      wrapup_seconds: params.wrapupSeconds,
      wrapup_started_at: new Date(),
    }).catch((err) => {
      log.warn({ err, attemptId: params.attemptId }, 'Could not persist wrapup window');
      return null;
    });

    /**
     * **The disposition may already be in, and if it is this wrap-up is over
     * before it starts.**
     *
     * `noteDisposition` resolves a *live* entry, and the entry does not exist
     * until this method creates it — so a disposition submitted before the call
     * ended found no entry, returned false, and was discarded. Filling the form
     * and *then* hanging up is an ordinary agent habit, so this is not an edge
     * case: an agent who dispositioned and hung up three seconds later would, 60 s
     * later, have `onExpiry` find `dispositionSubmitted` false and **be held,
     * demanded a disposition the system had already accepted**. The only ways out of
     * that hold are a supervisor force or re-submitting.
     *
     * Read from the attempt row rather than an in-process record of early
     * submissions, for two reasons. It is the **durable** fact — `setDisposition`
     * writes `disposition_code` before the route calls `noteDisposition` — so it
     * is also correct when the disposition's HTTP request landed on a **different
     * replica** than the one holding the wrap-up, which an in-process map cannot
     * be. And it costs nothing: this is the row we are already writing, and
     * `setState` returns it.
     *
     * Resolving (rather than merely marking submitted) is what `noteDisposition`
     * does for the same fact one millisecond later, and for the same reason:
     * holding an agent for the remainder of a window they no longer need is time
     * the pool cannot use.
     *
     * ── Known residual: the agent does not see the release copy ────────────────
     * Returning here skips both the `agent_state{wrapup}` frame and the `wrapup`
     * frame below. Traced through the console, and the client handles the truncated
     * sequence cleanly — `released` clears `live`, the following `agent_state`
     * clears `wrapup`/`retainedAttempt`, the pad re-locks, notes reset. What is
     * lost is cosmetic: the "Call ended." / "The customer hung up." headline is
     * rendered in the wrap-up rail, and on this path there is no wrap-up to
     * render it in, so the panel simply empties instead of explaining itself.
     * Fixing that is a console-side change (surface release copy outside the
     * wrap-up rail) and is deliberately not smuggled into this one.
     */
    if (params.requiresDisposition && attempt?.disposition_code) {
      entry.dispositionSubmitted = true;
      log.info(
        { sessionId: params.sessionId, attemptId: params.attemptId },
        'Disposition already recorded when wrap-up began — returning the agent',
      );
      await this.resolve(params.sessionId, 'disposition_submitted');
      return true;
    }

    if (willAutoReturn) {
      entry.timer = setTimeout(() => {
        void this.onExpiry(params.sessionId).catch((err) =>
          log.error({ err, sessionId: params.sessionId }, 'Wrap-up expiry failed'));
      }, params.wrapupSeconds * 1000);
      entry.timer.unref?.();
    }

    // ── Announce the transition, not just the wrap-up's contents. ─────────────
    // `wrapup` is a real state in the agent state machine and every OTHER entry into it is
    // announced (`AgencyStationAgentStateFrame` is the console's only authorised
    // source — "the console must not infer state"). This one was not, so the
    // console's disposition pad — which unlocks on `agent_state === 'wrapup'` —
    // greyed out the instant the call ended and stayed grey: `/available` then 409s
    // `attempt_not_dispositionable`, and the agent is stuck until the
    // `no_disposition` sweep closes the attempt. Every disposition on a
    // `requires_disposition` campaign was lost that way.
    //
    // The deadline deliberately does NOT ride on this frame. `AgencyWrapupState`
    // already carries `ends_at`/`seconds_total`/`held_reason` on the `wrapup` frame
    // pushed immediately below, and duplicating a countdown onto the state frame
    // would give the console two sources for one number that can disagree on a
    // held wrap-up (where `push` re-fires and this frame does not).
    //
    // A queued break DOES ride on it, and must. `pending_state` exists on the frame
    // rather than only on the HTTP response precisely so the queue survives a lost
    // socket — and a break queued mid-call stays pending for the whole wrap-up
    // window, consumed only by `releaseAgent` at the end of it. Since this is now
    // the ONLY transition frame in that window, omitting it would leave the console
    // unable to answer the agent's live question: am I getting another call after
    // this one?
    //
    // **The break is read HERE, not at the top of the method.** Every await is
    // already behind us and `StationRegistry.send` is synchronous, so nothing can
    // run between the read and the frame it rides on — which is what makes the last
    // writer the winner instead of whichever `agent_state` happened to be emitted
    // last. See `readPendingBreak` for the race this closes.
    const pendingBreak = params.readPendingBreak?.() ?? null;
    this.stations.send(params.sessionId, {
      event: 'agent_state',
      state: 'wrapup',
      since: new Date().toISOString(),
      ...(pendingBreak
        ? { pending_state: 'break' as const, pending_break_reason: pendingBreak.code }
        : {}),
    });
    this.push(entry);
    return true;
  }

  /**
   * The timer fired.
   *
   * Either the agent goes back to the pool — exactly once, because
   * the entry is removed before anything awaits) or they are **held** with a reason
   * the console can render — an agent whose countdown hits zero and
   * whose screen does not change concludes the app has hung).
   */
  private async onExpiry(sessionId: string): Promise<void> {
    const entry = this.entries.get(sessionId);
    if (!entry) return; // already resolved by a disposition or a forced return
    entry.timer = null;

    if (entry.requiresDisposition && !entry.dispositionSubmitted) {
      entry.endsAt = null;
      entry.heldReason = 'disposition_required';
      this.push(entry);
      log.info({ sessionId, attemptId: entry.attemptId }, 'Wrap-up held — disposition outstanding');
      return;
    }

    await this.resolve(sessionId, 'auto_return');
  }

  /** A disposition landed for this attempt (called by the disposition route). */
  async noteDisposition(sessionId: string, attemptId: string): Promise<boolean> {
    const entry = this.entries.get(sessionId);
    if (!entry || entry.attemptId !== attemptId) return false;
    entry.dispositionSubmitted = true;
    // The agent state machine: `wrapup → available` on a submitted disposition. The agent is done —
    // holding them for the remainder of a 60s window they no longer need is time
    // the pool cannot use.
    await this.resolve(sessionId, 'disposition_submitted');
    return true;
  }

  /** Supervisor override — end a held wrap-up and return the agent. */
  async force(sessionId: string): Promise<boolean> {
    if (!this.entries.has(sessionId)) return false;
    await this.resolve(sessionId, 'forced');
    return true;
  }

  /**
   * Resolve exactly once.
   *
   * The entry is deleted **before** the first await, which is what makes "exactly
   * once" true rather than likely: a disposition landing in the same
   * tick as the timer firing would otherwise return the agent twice, and the second
   * return would move an agent who had already been reserved for a new call back to
   * `available` — putting two attempts on one agent.
   */
  private async resolve(sessionId: string, resolution: WrapupResolution): Promise<void> {
    const entry = this.entries.get(sessionId);
    if (!entry) return;
    this.entries.delete(sessionId);
    if (entry.timer) clearTimeout(entry.timer);

    log.info({ sessionId, attemptId: entry.attemptId, resolution }, 'Wrap-up ended');
    // NOT awaited, for the same reason `cancel()` does not await it.
    //
    // The entry is deleted before the first await so that a disposition landing in
    // the same tick as the timer cannot return one agent twice. Awaiting a DB round
    // trip here reopens that window from the OUTSIDE: `force()` and the
    // go-available route both test `entries.has()`, so during the round trip they
    // see no wrap-up, fall through to their own `releaseAgent`, and run it
    // concurrently with this one. `releaseAgent` is the single place a queued break
    // is applied — `breaks.take()` succeeds for exactly one of the two callers, and
    // if the loser lands second the agent's queued break is silently dropped and
    // the tick dials into someone who asked to go on break.
    //
    // On a degraded DB the same await would hold every finishing agent out of the
    // pool for a full statement timeout. The record is a statistic; returning the
    // agent is a correctness property, and `persistEnd` never rejects.
    void this.persistEnd(entry.attemptId, resolution, entry);
    await this.onReturn(sessionId, resolution);
  }

  /**
   * Record that a wrap-up ended, and how.
   *
   * Never throws. Every caller is on a path whose real job is returning an agent to
   * the pool, and an agent stranded out of the pool because a stats column could not
   * be written is a strictly worse outcome than a gap in an average — the same
   * reasoning as the `.catch(log.warn)` on the state mirror above.
   *
   * The pairing with `wrapup_started_at` is what makes the duration measurable;
   * `wrapup_resolution` is what keeps it honest, because a `forced` or `agent_left`
   * wrap-up is not evidence about how long wrap-up work takes. The supervisor view
   * averages `disposition_submitted`, `auto_return` and `agent_returned` — the three
   * that are evidence of how long wrap-up work actually takes.
   */
  private async persistEnd(
    attemptId: string,
    resolution: WrapupResolution,
    // Required. It was `entry?` for one commit, and both call sites (`resolve`
    // and `cancel`) always pass it, so the `if (entry)` guard that used to wrap
    // the observation below was dead code — a histogram that looked conditional
    // and never was. This method is private; if a third exit path appears, it
    // has an entry too, because an entry is what a wrap-up IS.
    entry: WrapupEntry,
  ): Promise<void> {
    /**
     * The duration series, observed here because this is the ONE function both
     * exit paths (`resolve` and `cancel`) already share.
     *
     * The supervisor view averages this in SQL; the time series is what lets a
     * number like "18.5s mean against a 30s window" be re-checked over time.
     * `resolution` keeps it honest for the same reason `wrapup_resolution` is
     * recorded: a `forced` or `agent_left` wrap-up measures an interruption, not how
     * long write-up work takes.
     *
     * It is also the only measurement of disposition speed: a change to how fast
     * dispositions are filed (a hotkey, say) shows up in the `disposition_submitted`
     * series.
     *
     * ⚠️ **Observed BEFORE the write below, and that is deliberate — it is not
     * the rule the retirement counter follows one module over.** That counter
     * asserts *"a contact was permanently retired"*, a claim about persisted
     * state, so it must not fire on a write that silently did not take. This
     * observes *"an agent spent N seconds in wrap-up"*, a claim about elapsed
     * wall-clock time that is equally true whether or not the stats column
     * landed. Gating it on the write would drop real seat time from the series
     * on exactly the degraded-DB days when seat time matters most — and this
     * function is `void`-invoked precisely so a slow write cannot hold an agent
     * out of the pool, so there is no caller to report the failure to anyway.
     */
    {
      const seconds = Math.max(0, (Date.now() - entry.startedAt.getTime()) / 1000);
      // No `campaign_id` on the histogram (series cost) — see metrics.ts.
      agencyWrapupSeconds.observe({ tenant_id: entry.tenantId, resolution }, seconds);
    }
    await agencyAttemptRepository.setState(attemptId, 'ended', {
      wrapup_ended_at: new Date(),
      wrapup_resolution: resolution,
    }).catch((err) => {
      log.warn({ err, attemptId, resolution }, 'Could not persist wrap-up end');
      return null;
    });
  }

  /**
   * Drop a wrap-up without going through `onReturn` — the caller is already
   * returning the agent itself, or nobody is coming back.
   *
   * **Stays synchronous.** Its caller clears the wrap-up and then immediately writes
   * the agent to `available`; making this await a DB round trip would open a window
   * where the timer is gone but the agent is not yet back, and a concurrent tick
   * could reserve a session the route is mid-way through moving. The durable write
   * is therefore fire-and-forget (`void`), which is the right trade here: the record
   * is a statistic, the ordering is a correctness property.
   */
  cancel(sessionId: string, resolution: WrapupResolution = 'agent_left'): void {
    const entry = this.entries.get(sessionId);
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    this.entries.delete(sessionId);
    // Deliberately not awaited — see above. `persistEnd` never rejects.
    void this.persistEnd(entry.attemptId, resolution, entry);
  }

  /** Every timer, for shutdown. Does not return anyone to the pool. */
  stop(): void {
    for (const entry of this.entries.values()) {
      if (entry.timer) clearTimeout(entry.timer);
    }
    this.entries.clear();
  }

  private snapshot(entry: WrapupEntry): AgencyWrapupState {
    return {
      attempt_id: entry.attemptId,
      ends_at: entry.endsAt ? entry.endsAt.toISOString() : null,
      seconds_total: entry.secondsTotal,
      auto_return: entry.autoReturn,
      requires_disposition: entry.requiresDisposition,
      disposition_submitted: entry.dispositionSubmitted,
      held_reason: entry.heldReason,
    };
  }

  /** One idempotent frame, re-sent whenever the wrap-up materially changes. */
  private push(entry: WrapupEntry): void {
    this.stations.send(entry.sessionId, { event: 'wrapup', wrapup: this.snapshot(entry) });
  }
}
