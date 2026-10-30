import { createChildLogger } from '@magick-agency/observability';
import {
  agencyAgentSessionRepository,
  agencyAttemptRepository,
  agencyContactRepository,
  agencyManualCallRepository,
} from '../db/repositories/agency.repository.js';
import type { AgencyManualCallRecord } from '../db/models/agency.model.js';
import { auditLogger } from '../audit/audit-logger.js';
import { AUTO_DISPOSITION_CODE } from './disposition.js';
import { requiresDisposition } from './outcome-classifier.js';
import { resolveOurFaultRedial, resolveRetryDecision } from './retry-policy.js';
import {
  agencyOurFaultRetirementTotal,
} from '@magick-agency/observability/metrics/agency';

const log = createChildLogger({ component: 'agency-reaper' });

/** How often the periodic sweep runs. */
const SWEEP_INTERVAL_MS = 60_000;

/**
 * How long a non-terminal attempt must have existed before the periodic sweep
 * will even consider it.
 *
 * **5 minutes, and this number guards exactly one window: attempt row INSERT →
 * the dialer's in-process registration.** `PacingEngine` creates the row, then
 * dispatches; `AgencyDialer.executeDial` puts it in `liveByAttempt`. Between
 * those two an attempt is genuinely owned by nobody observable, so a sweep
 * running in that instant would reap a dial that is about to happen. In-process
 * that gap is sub-millisecond; 5 minutes is slack for a dispatcher that is one
 * day not in-process, and it also means a dispatch that threw leaves a `queued`
 * row recoverable within two cycles rather than at the next restart.
 *
 * **It is emphatically NOT a proxy for "longer than a call could last".** There is
 * no `max_ring` or `max_call_duration` column on any agency table to build such a
 * bound from, and agency calls inherit `webrtc_max_duration_seconds`, whose
 * declared ceiling is 14400s (4h) — so an age-only guard would sweep healthy calls
 * mid-sentence on any tenant configured above it. Liveness is decided by asking who
 * owns the attempt (see {@link AgencyReaper.sweepOnce}), which is the question the
 * reaper's rule actually specifies, and the age floor is short *because* it is not
 * load-bearing. Do not grow it back to compensate for
 * something; if the ownership check is not enough, fix the ownership check.
 */
const LEAK_THRESHOLD_MS = 5 * 60 * 1000;

/**
 * How long past a lapsed wrap-up before the auto-disposition sweep closes it.
 *
 * The window the agent was promised is per-attempt (`wrapup_seconds` on the row),
 * so this is only the margin on top: enough that an agent submitting at the very
 * end of a legitimate countdown is never beaten to it by a sweep tick, and enough
 * to absorb one missed tick. It must exceed {@link SWEEP_INTERVAL_MS} or a
 * disposition landing in the same minute as expiry races the sweep for the row —
 * a race the guarded UPDATE makes safe, but which would still cost the agent
 * their write-up half the time.
 */
const WRAPUP_LAPSE_GRACE_MS = 120_000;

/**
 * How long a contact must have sat `in_flight`, with no live attempt and no write
 * to it or its attempts, before the stranded-contact sweep requeues it.
 *
 * Guards the two legitimate windows in which a contact is `in_flight` with no live
 * attempt: claim → attempt INSERT in the pacing tick, and the attempt row's
 * `ended` write → the contact settlement in the dialer. Both are milliseconds in
 * process; the margin is the same as {@link LEAK_THRESHOLD_MS}'s, for the same
 * reason.
 */
const STRANDED_CONTACT_THRESHOLD_MS = 5 * 60 * 1000;

/** How the reaper learns what is still alive. Injected, never imported. */
export interface AgencyReaperDeps {
  /**
   * Attempt ids this replica is actively driving. `AgencyDialer.liveByAttempt`'s
   * key set — populated before the dial and deleted only when the attempt
   * settles, so it spans `dialing`/`ringing`/`answered`/`bridged` **and** the
   * whole deferred-hangup grace window.
   */
  activeAttemptIds: () => string[];
  /**
   * Which replica holds this agent's station socket, or null when none does.
   * `StationRegistry.ownerOf` — the Redis ownership key, 30s TTL, renewed from
   * the station socket's own ping.
   */
  ownerOf: (sessionId: string) => Promise<string | null>;
  /**
   * Attempts this replica stopped driving without managing to write them `ended`
   * (`AgencyDialer.unrecordedEndedAttemptIds` / `forgetUnrecordedEnds`).
   *
   * Neither ownership question can clear these: the dialer has dropped them from
   * `liveByAttempt`, and their agent is back in the pool with the station still
   * connected, so the `ownerOf` arm reads them as live for as long as the agent
   * stays. Absent ⇒ none (the reaper-only tests).
   */
  unrecordedEnds?: {
    ids: () => string[];
    forget: (attemptIds: readonly string[]) => void;
  };
  /**
   * The soft phone's half (docs/softphone.md §4.1 steps 8 and 10): this process's
   * live manual calls (the periodic orphan sweep spares them), and what to do with
   * calls the sweeps closed — clear each settled one's Redis claim and tell its
   * session. Absent, the periodic orphan sweep is skipped (it could not tell a
   * live call from an orphan); the startup sweep and the lapse still run.
   */
  manual?: {
    activeIds: () => string[];
    onClosed: (rows: readonly AgencyManualCallRecord[]) => Promise<void>;
  };
}

/**
 * Crash recovery.
 *
 * `gracefulShutdown()` handles SIGTERM. It does not handle SIGKILL, OOM, or a hard
 * crash, and those strand rows in states that are invisible to the pacing loop:
 * contacts in `in_flight` (not `pending`, so never re-claimed) and attempts in
 * `queued`/`dialing`/`ringing` (counted against the tick's occupied total, so they
 * permanently shrink the dialing target). Left alone a campaign silently loses
 * contacts and can never reach `completed`, which requires zero outstanding.
 *
 * **A single replica makes the startup case trivial and it should be exploited:** with one
 * replica, ANY non-terminal attempt found at boot is dead by definition — there is
 * no other process that could own it. When the server goes multi-replica only this rule
 * changes, narrowing to "non-terminal and owned by a replica whose heartbeat is
 * gone".
 *
 * **The periodic case is a different problem and must not borrow that argument**
 * — it runs inside a live process, where plenty of non-terminal attempts are
 * perfectly healthy. See {@link sweepOnce}.
 */
export class AgencyReaper {
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly deps: AgencyReaperDeps) {}

  /**
   * Reap everything stranded by the previous process, then mark every agent
   * offline. Must run BEFORE the pacing supervisor starts, or the first tick sees
   * a fabricated occupied count and dials nothing.
   */
  async reapOnStartup(): Promise<{ attempts: number; agents: number }> {
    // `null` threshold = every non-terminal row, regardless of age. No
    // ownership check, and none is needed: nothing can be alive yet in a process
    // that has not finished starting. This is the one caller for which
    // `reapNonTerminal`'s "dead by definition" is true.
    const attempts = await agencyAttemptRepository.reapNonTerminal(null);
    for (const attempt of attempts) {
      await this.requeueOrphanedContact(attempt.contact_id, 'startup', {
        tenantId: attempt.tenant_id, campaignId: attempt.campaign_id,
      });
    }

    // Every station socket died with the process, so no agent is really available.
    // They rehydrate into `break` on reconnect, never `available`.
    // Soft-phone calls nothing can own any more (step 10): ended `orphaned`; one
    // that never bridged is settled and its contact claim released, one that bridged
    // is left awaiting its outcome. Before pacing starts, as the attempts are: a
    // live manual row holds an account concurrency slot in pacing's headroom.
    const manual = await this.sweepManualCalls({ startup: true });

    const agents = await agencyAgentSessionRepository.markAllOffline();

    if (attempts.length > 0 || agents > 0 || manual.orphaned > 0 || manual.lapsed > 0) {
      log.warn({ attempts: attempts.length, agents, manualCalls: manual }, 'Agency startup reaper recovered stranded rows');
    }
    return { attempts: attempts.length, agents };
  }

  /** Periodic sweeps: leaked attempts, lapsed wrap-ups and stranded contacts. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      // Independently caught. One sweep throwing must not skip the other — they
      // repair unrelated damage, and a failing leak sweep silently disabling the
      // auto-disposition sweep is how the 5pm-laptop case comes back.
      void this.sweepOnce().catch((err) => log.error({ err }, 'Agency reaper sweep failed'));
      void this.sweepLapsedWrapups().catch((err) =>
        log.error({ err }, 'Agency auto-disposition sweep failed'));
      void this.sweepStrandedContacts().catch((err) =>
        log.error({ err }, 'Agency stranded-contact sweep failed'));
      void this.sweepManualCalls().catch((err) =>
        log.error({ err }, 'Agency soft-phone sweep failed'));
    }, SWEEP_INTERVAL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Sweep attempts that leaked in-process.
   *
   * **Age is a filter, not the decision.** An attempt is leaked when nothing owns
   * it, and there are two owners to ask, because there are two ways an attempt can
   * be legitimately alive:
   *
   * 1. **This replica is driving it** — `liveByAttempt`. Authoritative and free
   *    locally, and it is what makes a call inside the deferred-hangup grace
   *    window survive: the deferred hangup drops the agent's socket and keeps the carrier
   *    leg, so such a call has no browser leg attached and would look bridgeless
   *    to any check that asked about media instead of about ownership. The entry is
   *    removed only when the attempt settles, so the grace window is covered
   *    without a special case for it.
   * 2. **Some replica still holds the agent's station socket** — the Redis
   *    ownership key, via `ownerOf`. This is the arm that survives scale-out:
   *    `liveByAttempt` is per-process, so on the day there are two replicas a
   *    map-only check would have replica A reap replica B's live conversations.
   *    The reaper's rule is "non-terminal and owned by a replica whose heartbeat is
   *    gone", and this is that clause.
   *
   * Redis is asked rather than `agency_agent_sessions.last_heartbeat` **because
   * that column is never renewed** — `AgencyAgentSessionRepository.heartbeat()`
   * exists and has no callers; the station ping renews the Redis key and the Redis
   * lease and never touches the row: liveness does not come from that table, the
   * authority is the Redis ownership key. A sweep
   * built on that column would have excluded almost nothing while looking exactly
   * like a working guard.
   *
   * The owned set is snapshotted **before** the query on purpose. Anything that
   * stops being owned between the snapshot and the write survives one more cycle,
   * which is the harmless direction; the reverse ordering would let an attempt
   * registered in that instant be reaped.
   *
   * First, and outside both arms, the attempts the dialer reported it could not
   * end ({@link AgencyReaperDeps.unrecordedEnds}).
   */
  async sweepOnce(): Promise<number> {
    const unrecorded = await this.reapUnrecordedEnds();
    const owned = new Set(this.deps.activeAttemptIds());
    const cutoff = new Date(Date.now() - LEAK_THRESHOLD_MS);
    const candidates = await agencyAttemptRepository.findNonTerminalOlderThan(cutoff);
    if (candidates.length === 0) return unrecorded;

    const leaked: string[] = [];
    for (const attempt of candidates) {
      if (owned.has(attempt.id)) continue;
      if (attempt.reserved_agent_id && (await this.isAgentHeldSomewhere(attempt.reserved_agent_id))) {
        continue;
      }
      leaked.push(attempt.id);
    }
    if (leaked.length === 0) return unrecorded;

    // Re-guarded on `state` inside the UPDATE, so an attempt that settled between
    // the SELECT above and this write is left alone (the bridge lifecycle's
    // `ended` handler is the single writer of a terminal row, and this must never
    // be a second one).
    const reaped = await agencyAttemptRepository.reapByIds(leaked);
    for (const attempt of reaped) {
      await this.requeueOrphanedContact(attempt.contact_id, 'leak', {
        tenantId: attempt.tenant_id, campaignId: attempt.campaign_id,
      });
    }
    if (reaped.length > 0) {
      log.warn(
        { count: reaped.length, candidates: candidates.length, skippedAsLive: candidates.length - leaked.length },
        'Agency reaper swept leaked attempts',
      );
    }
    return unrecorded + reaped.length;
  }

  /**
   * End the attempts the dialer could not write `ended`, whatever their age and
   * whoever holds their agent's station: the dialer saw them end, so nothing is
   * driving them. `reapByIds`' live-state guard leaves alone any that was written
   * terminal meanwhile. The ids are forgotten only once the write succeeded, so a
   * database still failing keeps them for the next sweep.
   */
  private async reapUnrecordedEnds(): Promise<number> {
    const ids = this.deps.unrecordedEnds?.ids() ?? [];
    if (ids.length === 0) return 0;
    const reaped = await agencyAttemptRepository.reapByIds(ids);
    this.deps.unrecordedEnds?.forget(ids);
    for (const attempt of reaped) {
      await this.requeueOrphanedContact(attempt.contact_id, 'leak', {
        tenantId: attempt.tenant_id, campaignId: attempt.campaign_id,
      });
    }
    if (reaped.length > 0) {
      log.warn({ count: reaped.length }, 'Agency reaper ended attempts the dialer could not record');
    }
    return reaped.length;
  }

  /**
   * Is this agent's station socket held by *any* replica?
   *
   * Fails **closed** — a Redis error is reported as "held", so the attempt is not
   * reaped. The cost of that is a leaked attempt surviving until Redis recovers;
   * the cost of the other choice is hanging up on live customers whenever Redis
   * hiccups, and returning their contacts to the roster to be called again.
   */
  private async isAgentHeldSomewhere(sessionId: string): Promise<boolean> {
    try {
      return (await this.deps.ownerOf(sessionId)) !== null;
    } catch (err) {
      log.warn({ err, sessionId }, 'Could not resolve station ownership — treating agent as live');
      return true;
    }
  }

  /**
   * Close conversations whose wrap-up lapsed with nothing written up.
   *
   * **Otherwise one agent closing their laptop at 5pm strands a contact forever**,
   * and nothing else in the system releases a contact from `connected`: the
   * disposition route is the only path out, so an un-dispositioned contact is
   * parked permanently and the campaign can never reach `completed`.
   *
   * Two arms, and the distinction between them is the point:
   *
   * - **A disposition was owed and never came** ⇒ stamp `no_disposition`. It is an
   *   admission of absence, which is why `dispositionRefusal` treats it as
   *   "auto-closed" rather than "already dispositioned" and tells the agent a
   *   different thing.
   * - **A disposition was never owed** ⇒ release the contact and write **no**
   *   code. `requiresDisposition` returns false for a campaign with an empty
   *   catalog, and stamping such a contact `no_disposition` would record an
   *   agent's failure to do something nobody asked of them, and would poison the
   *   retry decision that reads it.
   *
   *   This arm is mostly a **safety net rather than a rescue**, and
   *   the difference is worth knowing before trusting it: an empty-catalog
   *   campaign does not park its contacts in `connected` at bridge time, so by
   *   the time a wrap-up lapses the `ended` handler's outcome policy has normally
   *   released the contact already and this write is idempotent. What it still
   *   genuinely rescues is the contact stranded by a catalog that changed
   *   mid-flight — parked `connected` under the old one, owed nothing under the
   *   new — which no other path would ever release.
   *
   * The catalog comes off the joined campaign row and is **never defaulted**:
   * `requiresDisposition(outcome, undefined)` returns *true*, so passing nothing
   * would auto-disposition every campaign including those that never wanted one.
   */
  async sweepLapsedWrapups(): Promise<number> {
    const rows = await agencyAttemptRepository.findLapsedWrapups(WRAPUP_LAPSE_GRACE_MS / 1000);
    if (rows.length === 0) return 0;
    const now = new Date();
    let closed = 0;

    for (const row of rows) {
      // Explicitly the campaign's own catalog. `?? undefined` would flip an
      // unconfigured campaign from "never owed one" to "owed one".
      const owed = requiresDisposition(row.outcome, row.campaign_disposition_catalog ?? []);

      if (owed) {
        const stamped = await agencyAttemptRepository
          .recordAutoDisposition(row.id, AUTO_DISPOSITION_CODE)
          .catch((err) => {
            log.error({ err, attemptId: row.id }, 'Failed to write auto-disposition');
            return null;
          });
        // Null means an agent wrote their real disposition in the meantime. Their
        // record stands and the route already released the contact, so there is
        // nothing here to repair.
        if (!stamped) continue;
      }

      // With no disposition recorded, the OUTCOME policy decides. The auto-close is
      // one of exactly two cases the precedence rule names as falling to the outcome
      // policy, which is why it routes here rather than hard-coding a state.
      //
      // `contact_attempt_count` is passed WITHOUT adding one: this path does not
      // bump (see below), so the stored budget is already the post-attempt count the
      // policy is defined on. The dial path is the opposite — it bumps, and passes
      // the post-bump value.
      const decision = resolveRetryDecision(
        row.campaign_retry_policy, row.outcome, now, row.contact_attempt_count,
      );
      await agencyContactRepository
        .markState(row.contact_id, decision.contactState, {
          last_outcome: row.outcome,
          // No `bump_attempt`: the attempt was counted when it ended. Bumping here
          // would charge a contact twice for one dial — the same reason the
          // disposition route does not bump either.
          ...(owed ? { last_disposition: AUTO_DISPOSITION_CODE } : {}),
          ...(decision.nextAttemptAt ? { next_attempt_at: decision.nextAttemptAt } : {}),
          ...(decision.suppressedReason ? { suppressed_reason: decision.suppressedReason } : {}),
        })
        .catch((err) => log.error({ err, contactId: row.contact_id }, 'Failed to release auto-closed contact'));
      closed++;
      log.info(
        {
          attemptId: row.id,
          contactId: row.contact_id,
          dispositionOwed: owed,
          contactState: decision.contactState,
          retryReason: decision.reason,
        },
        owed ? 'Wrap-up lapsed — auto-dispositioned' : 'Wrap-up lapsed with no disposition owed — contact released',
      );
    }

    if (closed > 0) log.warn({ count: closed }, 'Agency reaper closed lapsed wrap-ups');
    return closed;
  }

  /**
   * Requeue contacts stranded `in_flight` behind terminal attempts.
   *
   * The attempt sweeps start from an attempt: a non-terminal one (`sweepOnce`) or
   * an ended `connected` one whose wrap-up lapsed. A contact whose attempt WAS
   * ended but whose own settlement never landed — the dialer's contact write
   * throwing after the attempt row was written, or a process dying in between —
   * is visible to neither, and stays `in_flight` forever: `claimDialable` never
   * re-claims it and the campaign can never reach zero outstanding. So this sweep
   * starts from the contact (`findStrandedInFlight`).
   *
   * Requeued exactly as a reaped attempt's contact is ({@link requeueOrphanedContact}):
   * on the our-fault ledger, never the customer's allowance, because whether the
   * failed settlement had already charged it is not knowable from here, and the
   * our-fault bound is what keeps a repeatedly failing write from redialling
   * someone without limit.
   */
  async sweepStrandedContacts(): Promise<number> {
    const cutoff = new Date(Date.now() - STRANDED_CONTACT_THRESHOLD_MS);
    const stranded = await agencyContactRepository.findStrandedInFlight(cutoff);
    for (const contact of stranded) {
      await this.requeueOrphanedContact(contact.id, 'stranded', {
        tenantId: contact.tenant_id, campaignId: contact.campaign_id,
      });
    }
    if (stranded.length > 0) {
      log.warn({ count: stranded.length }, 'Agency reaper requeued contacts stranded in_flight');
    }
    return stranded.length;
  }

  /**
   * The soft phone's two sweeps (docs/softphone.md §4.1 steps 8 and 10).
   *
   * - **Orphans** (`reapOrphaned`): at startup every non-terminal manual call (no
   *   process can own one); periodically the ones this process is not driving
   *   (`manual.activeIds()`) and older than {@link LEAK_THRESHOLD_MS}, so a call
   *   being placed right now is never reaped. One that never bridged is settled in
   *   the same statement; one that bridged stays awaiting its outcome (the agent
   *   can still write it up after reconnecting), its contact claim KEPT.
   * - **Lapses** (`lapseUnsettled`): an ended call with no outcome after
   *   `SOFTPHONE_OUTCOME_LAPSE_MS`, or whose session left, is closed (a bridged one
   *   `no_disposition`).
   *
   * Both return rows and release nothing; here, for every row that is now settled,
   * its contact claim goes back to the recorded prior state (`releaseManualClaim`:
   * no attempt charged), and `manual.onClosed` clears the Redis claim. Each closed
   * row gets an `audit_logs` system event (`agency_manual_call.orphaned` /
   * `.lapsed`, actor `system:agency-reaper`): nobody pressed anything, and the
   * record of why a call ended or a contact was given back is the audit question.
   *
   * Never throws: a failing half is logged and the other half still runs.
   */
  async sweepManualCalls(opts: { startup?: boolean } = {}): Promise<{ orphaned: number; lapsed: number }> {
    let orphaned: AgencyManualCallRecord[] = [];
    let lapsed: AgencyManualCallRecord[] = [];
    try {
      if (opts.startup) {
        orphaned = await agencyManualCallRepository.reapOrphaned({ liveIds: [] });
      } else if (this.deps.manual) {
        orphaned = await agencyManualCallRepository.reapOrphaned({
          liveIds: this.deps.manual.activeIds(),
          createdBefore: new Date(Date.now() - LEAK_THRESHOLD_MS),
        });
      }
    } catch (err) {
      log.error({ err }, 'Soft-phone orphan sweep failed');
    }
    try {
      lapsed = await agencyManualCallRepository.lapseUnsettled();
    } catch (err) {
      log.error({ err }, 'Soft-phone lapse sweep failed');
    }
    await this.closeManualRows(orphaned, 'orphaned');
    await this.closeManualRows(lapsed, 'lapsed');
    if (orphaned.length > 0 || lapsed.length > 0) {
      log.warn({ orphaned: orphaned.length, lapsed: lapsed.length }, 'Agency reaper closed soft-phone calls');
    }
    return { orphaned: orphaned.length, lapsed: lapsed.length };
  }

  private async closeManualRows(rows: readonly AgencyManualCallRecord[], why: 'orphaned' | 'lapsed'): Promise<void> {
    if (rows.length === 0) return;
    for (const row of rows) {
      let released: { contactId: string; state: string } | null = null;
      if (row.settled_at !== null && row.contact_claimed) {
        released = await agencyContactRepository.releaseManualClaim(row.id).catch((err) => {
          log.error({ err, manualCallId: row.id }, 'Failed to release a soft-phone contact claim — the stranded-contact sweep requeues it');
          return null;
        });
      }
      auditLogger.log({
        ...(row.webrtc_call_id ? { callId: row.webrtc_call_id } : {}),
        tenantId: row.tenant_id,
        accountId: row.account_id,
        eventType: `agency_manual_call.${why}`,
        eventCategory: 'call',
        severity: 'warn',
        actor: 'system:agency-reaper',
        eventData: {
          manual_call_id: row.id,
          session_id: row.session_id,
          agent_user_id: row.agent_user_id,
          campaign_id: row.campaign_id,
          contact_id: row.contact_id,
          settled: row.settled_at !== null,
          bridged: row.bridged_at !== null,
          disposition_code: row.disposition_code,
          contact_released_to: released?.state ?? null,
        },
      });
    }
    await this.deps.manual?.onClosed(rows).catch((err) =>
      log.error({ err, count: rows.length }, 'Failed to release the Redis claims of swept soft-phone calls'));
  }

  /**
   * Return a reaped attempt's contact to the roster.
   *
   * Shared by every reap path (and the stranded-contact sweep) so the
   * retry-allowance rule below cannot be true in one and quietly absent in another.
   */
  private async requeueOrphanedContact(
    contactId: string,
    source: 'startup' | 'leak' | 'stranded',
    /**
     * Label set for {@link agencyOurFaultRetirementTotal}, taken from the attempt
     * (or, for the stranded-contact sweep, contact) row the caller is already
     * holding.
     *
     * Threaded rather than looked up: this runs in a loop over reaped attempts,
     * and a per-contact query to label a counter would put a read on the crash
     * recovery path to serve telemetry.
     *
     * **Required, and it was briefly optional for a reason that did not survive
     * review.** The first version declared it `scope?` and fell back to
     * `'unknown'` labels, on the argument that an unlabelled increment beats a
     * missing one. That fallback was unreachable: this method is private, and
     * every call site iterates rows that carry both fields. So the option only
     * bought a dead branch and a
     * commit message describing behaviour that cannot occur. If a future caller
     * genuinely cannot supply the scope, make that a deliberate decision here
     * rather than inheriting a silent `'unknown'` series.
     */
    scope: { tenantId: string; campaignId: string },
  ): Promise<void> {
    // ── The our-fault bound belongs here too ─────────────────────────────────
    //
    // Not bumping `attempt_count` is right. The other half is the bound: if our
    // crashes cost the contact NOTHING, a replica
    // crash-looping on one contact requeues that number without limit — the same
    // unbounded repeat-dial exposure the dial path's agent-drop skip opens, and
    // it is regulated regardless of which of our faults caused it.
    //
    // ONE principle applies in both places. Skipping the
    // customer's allowance while charging a separate our-fault ledger IS that
    // principle; applying it only to agent drops would leave the reaper as the
    // way around the bound.
    const ourFaultUsed = await agencyContactRepository
      .chargeOurFaultAttempt(contactId, 'orphaned')
      .catch((err) => {
        log.error({ err, contactId, source }, 'Failed to charge the our-fault ledger');
        // Fail OPEN toward requeueing. A bookkeeping failure must not strand a
        // contact: `0` requeues it, which is the safe direction — the bound is a
        // ceiling on repeat dialling, and a
        // single uncounted requeue cannot breach it on its own.
        return 0;
      });
    // Only the BOUND is taken from the decision. The requeue below deliberately
    // keeps its immediate `next_attempt_at`: crash recovery wants the contact
    // dialable as soon as the roster reaches it, and adding the dial path's
    // cool-off here would delay every contact after a routine deploy. The
    // shared function is still the right home for the ceiling — one place
    // decides how many our-fault redials a contact may have, both callers obey it.
    const decision = resolveOurFaultRedial(null, 'orphaned', new Date(), ourFaultUsed);

    if (decision.contactState !== 'pending') {
      // Terminal and observable, never a silent stall. The contact is retired
      // with its retry allowance intact, so an operator can see it was our
      // faults — not the customer's number — that ended the attempt.
      const retired = await agencyContactRepository
        .markState(contactId, decision.contactState, { last_outcome: 'orphaned' })
        // ⚠️ The boolean is `markState`'s OWN answer to "did the requested state
        // land", not `.then(() => true)`. The first version used the latter,
        // which reports success whenever the query did not throw — and
        // `markState` resolves when its DNC guard refuses the transition. This
        // method's own comment below already records that a DNC'd contact can be
        // sitting here, so crash recovery colliding with a mid-call DNC was
        // incrementing a retirement that never happened.
        .catch((err) => {
          log.error({ err, contactId, source }, 'Failed to retire an our-fault-bounded contact');
          return false;
        });
      /**
       * ── The SECOND producer of our-fault retirements ──────────────────────
       *
       * `agency_our_fault_retirement_total` shipped with the dialer as its only
       * producer, and its help claimed to count every contact retired by this
       * ledger. It did not: **this path retires them too**, after a crash or a
       * leaked attempt, and those were invisible — so the series undercounted
       * exactly the population it named. That is the same defect class the
       * counter was added to fix, reintroduced one module over.
       *
       * `outcome: 'orphaned'` is what separates the two causes on the dashboard:
       * `agent_disconnected`/`canceled` point at agent workstations and our
       * teardown paths, `orphaned` points at replica crashes and leaks. Both
       * retire a real person we never reached.
       *
       * Counted only when the retirement actually LANDED, matching the dial
       * site. Two distinct ways it can fail to, and the `.catch` above covers
       * only the first: `markState` can reject (a bookkeeping failure must not
       * break crash recovery, hence the guard and the explicit boolean rather
       * than control flow), and it can RESOLVE while refusing the transition,
       * because its DNC guard keeps a suppressed row suppressed in SQL and
       * merely warns. `markState` returns which happened; this gates on it.
       */
      if (retired) {
        const labels = {
          tenant_id: scope.tenantId,
          campaign_id: scope.campaignId,
          outcome: 'orphaned',
        };
        agencyOurFaultRetirementTotal.inc(labels);
      }
      log.warn(
        { contactId, source, ourFaultUsed, retryReason: decision.reason },
        'Our-fault redial bound reached — orphaned contact retired without spending its retry allowance',
      );
      return;
    }

    await agencyContactRepository
      // NO `bump_attempt`, and that is a product decision rather than an
      // oversight: **our crash must not consume the customer's retry allowance.**
      // With `max_attempts: 3`, three server restarts would otherwise exhaust a
      // contact and mark them `exhausted` having never been spoken to — silent
      // contact loss behind a plausible-looking audit trail.
      //
      // This used to interact with attempt-number derivation to make a recovered
      // contact permanently undialable. That is fixed at the root:
      // `attempt_number` is now derived from the attempts table, so `attempt_count`
      // is purely the retry budget and the two can no longer diverge. Do not
      // "fix" a future numbering problem by bumping here.
      //
      // Note for the disposition policy: an orphaned attempt is not uniformly "never
      // happened". The reaper sweeps `ringing`/`answered`/`bridged` too, and those
      // customers' phones did ring. Reaping overwrites `state`, but `dialed_at`,
      // `answered_at` and `bridged_at` survive — so the retry policy can charge
      // for an attempt that reached the customer and spare one that never left.
      //
      // ⚠️ This `'pending'` is a LITERAL, not a decision, and a contact marked DNC
      // before the replica died would be requeued by it. `markState` refuses the
      // transition in SQL — the guard is in the repository precisely because this
      // site takes no decision it could have been attached to. See its header.
      .markState(contactId, 'pending', {
        last_outcome: 'orphaned',
        next_attempt_at: new Date(),
      })
      .catch((err) => log.error({ err, contactId, source }, 'Failed to requeue orphaned contact'));
  }
}
