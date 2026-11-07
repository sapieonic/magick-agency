import type WebSocket from 'ws';
import { createChildLogger } from '@magick-agency/observability';
import {
  DIAL_OUTCOME_UNKNOWN_ERROR_CODE,
  DIAL_OUTCOME_UNKNOWN_REDIAL_DELAY_MS,
  isDialOutcomeUnknown,
} from '../telephony/carrier-errors.js';
import type { UnrecordedEnd } from './reaper.js';
import type { WebRtcBridgeManager, WebRtcLifecycleEvent } from '../core/webrtc-bridge-manager.js';
import {
  agencyAgentSessionRepository,
  agencyAttemptRepository,
  agencyContactRepository,
} from '../db/repositories/agency.repository.js';
import type { StationRegistry } from './station-registry.js';
import { AgentStateMachine, AGENT_LEASE_MS, type AgentSetResult } from './agent-state-machine.js';
import type { DialCommand, DialOptions } from './dial-dispatcher.js';
import { buildPanel, isUnannounced, type LiveAttempt } from './dialer/live-attempt.js';
import { holdOutcomeUnknownContact, parkRedialContact, settleContact } from './dialer/contact-settlement.js';
import { wrapupRedialRemaining } from './wrapup-redial-rules.js';
import {
  classifyAttemptOutcome,
  releaseMessageFor,
  releaseReasonFor,
  requiresDisposition,
} from './outcome-classifier.js';
import { SOFTPHONE_BREAK_REASON } from '@magick-agency/contracts/agency';
import type {
  AgencyActiveAttempt,
  AgencyAgentState,
  AgencyAttemptOutcome,
  AgencyMissedRelease,
  AgencyPriorAttempt,
  AgencyReleaseReason,
  AgencyAbandonReason,
} from '@magick-agency/contracts/agency';
import type { WrapupManager } from './wrapup-manager.js';
import { isCampaignSession, type AgencyCampaignRecord } from '../db/models/agency.model.js';
import { SYSTEM_AUDIT_ACTOR } from '../audit/platform/audit-actor.js';
import { auditSoftphoneStarted } from './softphone/softphone-audit.js';
import { pauseCampaignForCarrierAccount } from './carrier-account-pause.js';
import { CarrierRefusalBreaker, countsTowardBreaker } from './carrier-refusal-breaker.js';
import { classifyDialRefusal, dialWasSent } from '../core/bridge/dial-refusals.js';
import type { BreakRegistry } from '@magick-agency/domain/break-manager';
import { DEFERRED_HANGUP_MS, elapsedSeconds } from '@magick-agency/domain/timers';
import { resolveAbandonClip } from './abandon-clip.js';
import { isAbandonedAttempt } from '@magick-agency/domain/abandonment-predicate';
import { FLAGS, getFeatureFlagService } from '../feature-flags/index.js';
import {
  agencyAnsweredTotal,
  agencyAbandonedTotal,
  agencyAttemptHoldSeconds,
  agencyAnswerLatencySeconds,
  agencyBindLatencySeconds,
  agencyBindTotal,
  agencyAbandonedReasonTotal,
} from '@magick-agency/observability/metrics/agency';

/**
 * What {@link AgencyDialer.releaseAgent} did: the state it wrote (`offline` for a
 * departed agent, else `break` for a queued break or `available`) and the write's
 * result. A refused `available` (`manual_call_live`, `softphone_session`) moved nothing.
 */
export interface AgentReleaseResult {
  state: 'available' | 'break' | 'offline';
  result: AgentSetResult;
}

const log = createChildLogger({ component: 'agency-dialer' });

/** What the `ended` arm decided (`AgencyDialer.settleEnded`), for the contact's settlement. */
interface EndedSettlement {
  /** Wrap-up took the agent, so the `ended` arm must not release them. */
  handedToWrapup: boolean;
  /** The attempt row was written `ended`. */
  rowEnded: boolean;
  outcome: AgencyAttemptOutcome;
  needsDisposition: boolean;
}

/** Defined beside the errors that carry the rule; re-exported for the dial path's callers. */
export { DIAL_OUTCOME_UNKNOWN_REDIAL_DELAY_MS };

/**
 * How long a contact waits after its dial failed in the bridge before the carrier was asked
 * (the bridge rejected with no `ended`: the call row INSERT, the carrier tokens, the carrier
 * request's own inputs). Default, pending Manas (`docs/decisions.md`, "Dial failed before the
 * carrier"). Not an admission refusal (`capacity`, `classifyDialRefusal`): that is
 * back-pressure, not a fault, and its contact goes back at once.
 *
 * Without it the contact went back dialable at once, uncharged, and a failure that repeats
 * (a missing webhook base, a database refusing the INSERT) redialled the same contact on
 * every pacing tick once the roster had nothing older to offer: a tight loop of attempt
 * rows, agent reservations and bridge setups, bounded by nothing.
 *
 * A delay rather than a charge to the our-fault ledger, deliberately. Nobody was called, so
 * the repeat-dial ceiling that ledger enforces has nothing to protect, and its bound would
 * RETIRE contacts: a systemic failure (every INSERT failing, a config error) fails dials in
 * milliseconds, and at a bound of 3 it would exhaust the whole roster within seconds,
 * permanently, for a fault in this process. The delay costs a working contact a minute and
 * caps the rate at which any one contact can be retried; nothing is lost when the fault
 * clears. A minute: well past the pacing tick, short beside every retry the policy sets.
 */
export const PRE_CARRIER_FAILURE_REDIAL_DELAY_MS = 60_000;

/**
 * What becomes of the contact of a dial abandoned before it was placed
 * (`AgencyDialer.abandonBeforeDial`), decided once by the caller. A wrap-up redial's
 * contact is parked for the outcome its agent still owes whatever the fate; only
 * `hold_unknown` changes its reopened wrap-up (no further redial is offered).
 *
 *  - `hold_unknown`: the carrier may have queued the failed dial. The contact is held back
 *    {@link DIAL_OUTCOME_UNKNOWN_REDIAL_DELAY_MS} and charged to the our-fault ledger
 *    (`holdOutcomeUnknownContact`).
 *  - `suppress_invalid`: the carrier will never dial this contact's number
 *    (`carrier_dial_not_sent`, `destination`). Suppressed `invalid`, uncharged, as the
 *    pre-dial gate's `phone_invalid` does.
 *  - `return_now`: back dialable at once, uncharged: a dial called off before it
 *    (`reservation_expired`), refused admission or a calls-per-second slot, or refused for
 *    the campaign's carrier account, which pauses the campaign.
 *  - `return_delayed`: back uncharged after {@link PRE_CARRIER_FAILURE_REDIAL_DELAY_MS}: a
 *    dial that failed in the bridge before the carrier was asked (`failed`).
 */
type AbandonedContactFate = 'hold_unknown' | 'suppress_invalid' | 'return_now' | 'return_delayed';

/**
 * How long a `released` the agent never saw is kept for them to collect on
 * reconnect. Generous relative to the deferred-hangup window on purpose: the
 * agent who missed it is by definition the one whose network just failed, and a
 * console that comes back with an empty panel and no account of the call the
 * agent was just on reads as data loss.
 *
 * In-process, like every other business timer here. Losing these on a
 * restart is correct — after a restart the agent is landed in `break` and shown a
 * clean console anyway.
 */
const MISSED_RELEASE_TTL_MS = 5 * 60_000;

/**
 * Await a write to the durable agent-session mirror without letting it fail the
 * caller: Redis is the authority on agent state, so a mirror that could not be
 * written is a stale dashboard column, logged and never a reason to stop.
 */
async function mirrored(write: Promise<unknown>, sessionId: string, failure: string): Promise<void> {
  await write.catch((err) => log.warn({ err, sessionId }, failure));
}

/**
 * Places one attempt's call and owns it until it ends.
 *
 * Its single most important property is an ORDERING one, so it is stated up front:
 * the `reserved` frame — which carries the contact's full context row — reaches
 * the agent's socket **before the `bridged` frame**, always, in both binding
 * modes. Under early binding it goes out before the dial; under late binding
 * both frames leave inside the answer turn, `reserved` first. See
 * {@link executeDial} for how that is made structural rather than a race we
 * usually win.
 */
export class AgencyDialer {
  /** attemptId → the renewer keeping its agent lease alive. */
  private readonly leaseRenewers = new Map<string, NodeJS.Timeout>();
  /**
   * attemptId → attempt context, for correlating bridge lifecycle events.
   *
   * Keyed on the ATTEMPT id, not the webrtc call id, and registered BEFORE the
   * dial. A call's id only exists once `createBridgedCall` resolves, so a
   * call-id-keyed map is necessarily empty while the dial is in flight — and a
   * carrier that answers during the dial would have its `bridged` event silently
   * dropped. The agent would then sit on a live call with a panel still showing
   * "connecting".
   */
  private readonly liveByAttempt = new Map<string, LiveAttempt>();
  /**
   * sessionId → the `released` frame that session's socket was not there to
   * receive, delivered on the `ready` frame when it comes back
   * (`AgencyStationReadyFrame.missed_release`).
   */
  private readonly missedReleases = new Map<string, { release: AgencyMissedRelease; expiresAt: number }>();
  /**
   * Attempts this replica saw end (or abandoned) whose `ended` row write failed.
   *
   * The row is left non-terminal and nothing on this replica drives it any more,
   * but the agent is back in the pool with their station connected — which is
   * exactly what the reaper's periodic sweep reads as "still owned somewhere" and
   * skips. So the reaper is handed these ids directly
   * ({@link unrecordedEndedAttempts}) and ends them `orphaned`. Process-local
   * on purpose: after a restart the startup reaper ends every non-terminal row.
   *
   * attemptId → whether the dial's outcome is unknown (the carrier may have queued it;
   * {@link DIAL_OUTCOME_UNKNOWN_REDIAL_DELAY_MS}). Every other end here is one this
   * replica saw happen, so the reaper requeues its contact without the carrier rule's
   * delay, as this replica would have had the write succeeded.
   */
  private readonly unrecordedEnds = new Map<string, boolean>();
  /**
   * Grace timers for a station that dropped while an UNANNOUNCED dial was ringing,
   * keyed by session id.
   *
   * ── Why late binding needs its own timer here ──────────────────────────────
   *
   * `releaseStationOnClose` refuses to write `offline` mid-attempt on an explicit
   * premise: the deferred hangup owns the outcome, the agent re-attaches or the
   * call expires, and either way `releaseAgent` runs. **That premise does not hold
   * before the bind.** The deferred hangup it names is
   * `hangUpForBrowserClose`, installed by `registerBrowserLegHandlers` on the
   * BROWSER socket — and an unbound dial has none (`createUnboundBridgedCall`
   * takes `Omit<…, 'browserSocket'>`). `browserCloseGraceMs` is carried on the
   * unbound dial, but the bridge only reads it back at the bind, so during the
   * ring nothing anywhere is watching.
   *
   * Left alone the dial therefore runs to the carrier's own answer, `stations.send`
   * fails on the closed socket, `bindFailed` is set, and `abandonAnsweredCall`
   * plays an apology to a real customer and records an **`abandoned`** attempt —
   * counted in `ABANDONED_ATTEMPT_PREDICATE_SQL`, charged against the 3%
   * regulatory ceiling and feeding the auto-pause guardrail. The identical
   * network blip under EARLY binding produces `hangUpForBrowserClose` after
   * `DEFERRED_HANGUP_MS`, an unanswered dial, and a `canceled` attempt that harms
   * nobody. So without this timer late binding would introduce an abandonment
   * source of its own — against the very ceiling that is its hardest constraint.
   *
   * A timer rather than an immediate hangup because the self-healing property is
   * worth keeping: the `answered` arm reads `socketFor` FRESH, so an agent whose
   * socket blips for a moment and reconnects still gets the call. This gives the
   * pre-bind window the same `DEFERRED_HANGUP_MS` the post-bind one already has,
   * which is what makes the two binding modes agree.
   */
  private readonly unboundStationGrace = new Map<string, NodeJS.Timeout>();
  private unsubscribeLifecycle: (() => void) | null = null;

  constructor(
    private readonly bridge: WebRtcBridgeManager,
    private readonly stations: StationRegistry,
    private readonly agents: AgentStateMachine,
    private readonly wrapup: WrapupManager,
    private readonly breaks: BreakRegistry,
    /**
     * Counts a credential-pinned campaign's carrier refusals in a row and says when to pause
     * it (`carrier-refusal-breaker.ts`, PL11). The runtime hands the Redis-backed one; the
     * default counts in this process.
     */
    private readonly refusalBreaker: CarrierRefusalBreaker = new CarrierRefusalBreaker(null, ''),
  ) {}

  /** Subscribe to bridge lifecycle. Call once at wiring time. */
  start(): void {
    if (this.unsubscribeLifecycle) return;
    this.unsubscribeLifecycle = this.bridge.onLifecycle((ev) => {
      // The listener is called synchronously inside bridge teardown; never block
      // it and never let a rejection escape into the path that settles credit.
      void this.onBridgeLifecycle(ev).catch((err) =>
        log.error({ err, callId: ev.callId, phase: ev.phase }, 'Agency lifecycle handling failed'));
    });
  }

  stop(): void {
    this.unsubscribeLifecycle?.();
    this.unsubscribeLifecycle = null;
    for (const timer of this.leaseRenewers.values()) clearInterval(timer);
    this.leaseRenewers.clear();
    for (const timer of this.unboundStationGrace.values()) clearTimeout(timer);
    this.unboundStationGrace.clear();
    this.missedReleases.clear();
  }

  /**
   * Place the call for a reserved attempt.
   *
   * **The ordering guarantee, in both binding modes.** The guarantee has always
   * been "the panel is on the wire before the agent can hear the customer", and
   * `FF_AGENCY_LATE_BINDING` moves *where* that is enforced without weakening it.
   *
   *  - **Early binding (flag off, the original path).** Everything the panel needs
   *    is gathered first, the `reserved` frame is written to the socket
   *    synchronously, and only then is the dial placed. There is no `await`
   *    between the send and the dial, so no continuation can interleave — the
   *    carrier cannot answer before the panel is on the wire even if it answers in
   *    the same tick as the dial. Fetching context after the dial, or emitting
   *    `reserved` from a `.then()`, would both pass a test with a three-second
   *    ring and fail in production the first time a carrier answered instantly.
   *  - **Late binding (flag on).** The panel is still built here, before the dial,
   *    for exactly the same reason — but it is HELD, and the leg is placed with no
   *    browser socket at all ({@link WebRtcBridgeManager.createUnboundBridgedCall}).
   *    The agent therefore sees nothing while the phone rings. The guarantee
   *    relocates to the `answered` arm of {@link onBridgeLifecycle}, which sends
   *    `reserved` and binds the socket **synchronously, in one turn, before any
   *    await** — so `reserved` still precedes the `bridged` frame the bind itself
   *    provokes, and still precedes any audio the agent can hear.
   *
   * What the move costs, stated because it is the reason the panel is not simply
   * built at the answer: the bind runs inside the 1000ms
   * `ABANDONMENT_BRIDGE_GRACE_MS` budget, so nothing that can be done here may be
   * deferred to there. The priors read below is two joins over a contact lineage
   * and would spend that budget outright.
   *
   * The flag is resolved HERE, once, and stored on the `LiveAttempt` — never read
   * again from the arms that act on it. The decision belongs to the replica that
   * actually dials, at the instant it dials: it is the replica that chose whether
   * to hand the bridge a socket, so it is the only one whose answer can be right
   * about what it did. Putting it on {@link DialCommand} would date the decision
   * to the pacing tick instead, and a flag flipped in between would leave the
   * dial and the answer disagreeing about whether a socket was ever attached.
   */
  async executeDial(cmd: DialCommand, opts: DialOptions = {}): Promise<void> {
    const { attemptId, sessionId } = cmd;

    // Fails closed onto `false` (early binding, today's behaviour) whenever the
    // flag cannot be resolved: `getValue` catches everything and returns the
    // registry default. That is the safe direction — early binding is the shipped
    // path, and the worst it does is show the agent a ringing panel.
    //
    // A wrap-up redial is always EARLY-bound: the agent asked for this call and is
    // watching for it, so the ringing panel is the point (the console shows "Redial 1 of
    // 2 — calling…"), not the spurious popup late binding exists to remove.
    const lateBinding = cmd.redial
      ? false
      : await getFeatureFlagService().isEnabled(FLAGS.agency_late_binding, {
        tenantId: cmd.tenantId,
        accountId: cmd.accountId,
      });

    // Has a `reserved` frame reached this agent? Under early binding it is set in
    // step 2 below; under late binding not until the answer. Every abandon path
    // out of this method passes it to `abandonBeforeDial`, because an agent who
    // was shown a panel is owed an explanation for it clearing and an agent who
    // was shown nothing must be told nothing.
    let panelDelivered = false;

    // The socket must still be here — in BOTH modes. Under late binding nothing
    // is attached to it yet, but dialing a customer for an agent who has already
    // gone manufactures precisely the abandoned call reserve-before-dial exists to
    // prevent, and the answer-time bind cannot un-ring a phone. What late binding
    // gives up is the bridge's own pre-flight check (`createBridgedCall` refuses a
    // dead socket); this check and the re-check at the bind replace it.
    const socket = this.stations.socketFor(sessionId);
    if (!socket || socket.readyState !== 1 /* OPEN */) {
      log.warn({ attemptId, sessionId, lateBinding }, 'Agent socket gone before dial — releasing');
      await this.abandonBeforeDial(cmd, 'reservation_expired', panelDelivered, 'return_now');
      return;
    }

    // ── 1. Gather EVERYTHING the panel needs, before any dial. ──────────────
    //
    // The read is LINEAGE-scoped since retry campaigns landed: a retry copies its
    // contacts rather than sharing them, so the previous pass's attempts
    // hang off a different `agency_contacts` row and a `contact_id` read would
    // show the agent an empty history on exactly the calls where history matters
    // most. `root_contact_id` is the chain head, stamped on every row by a database
    // trigger.
    //
    // `?? cmd.contactId` is a defensive fallback and is expected to be
    // unreachable: `trg_agency_contacts_root` stamps the column on every row. It
    // is here because a `null` would reach `WHERE root_contact_id =
    // $1` and match nothing (NULL is never equal to anything) — the fallback makes
    // that case degrade to "this contact's own history" instead of silently to
    // "no history", which is the same class of answer the catch below produces.
    let priors: AgencyPriorAttempt[] = [];
    try {
      const rows = await agencyAttemptRepository.findPriorForContactLineage(
        cmd.contact.root_contact_id ?? cmd.contactId,
        attemptId,
      );
      priors = rows.map((r) => ({
        attempt_number: r.attempt_number,
        outcome: r.outcome,
        disposition_code: r.disposition_code,
        notes: r.notes,
        ended_at: r.ended_at ? r.ended_at.toISOString() : null,
        campaign_id: r.campaign_id,
        campaign_name: r.campaign_name,
        // Distinct from `ended_at`: an attempt reaped mid-flight has no end, and
        // `attempt_number` is no longer a global ordering (it resets per retry
        // campaign), so without this such a row would carry no time at all.
        dialed_at: r.dialed_at ? r.dialed_at.toISOString() : null,
      }));
    } catch (err) {
      // History is nice-to-have; its absence must not cost the call. The panel
      // renders without it rather than the customer never being dialed.
      //
      // ⚠️ Do not "improve" this by letting the error propagate now that the read
      // spans a lineage and two joins. A bigger read is a bigger thing to fail,
      // which makes this guard more important, not less — the customer is dialled
      // either way and the agent simply sees no prior attempts.
      log.warn({ err, attemptId }, 'Could not load prior attempts — sending panel without history');
    }

    const attempt = buildPanel(cmd, priors);

    // ── 2. Push the panel. SYNCHRONOUS, and before the dial. ────────────────
    //
    // …unless late binding is on, in which case the panel is HELD on the
    // `LiveAttempt` and the `answered` arm sends it. Nothing else about the dial
    // changes: the socket check above, the CAS lease upgrade below, the `dialing`
    // write and the `liveByAttempt` registration all still happen in this order
    // and still happen before the dial.
    if (!lateBinding) {
      const delivered = this.stations.send(sessionId, { event: 'reserved', attempt });
      if (!delivered) {
        log.warn({ attemptId, sessionId }, 'Could not deliver reserved frame — releasing');
        await this.abandonBeforeDial(cmd, 'reservation_expired', panelDelivered, 'return_now');
        return;
      }
      panelDelivered = true;
    }

    // ── The dial can still be called off, and nothing is stamped yet ────────
    //
    // Everything above yields (the flag read, the priors read), and inside any of
    // it the station may have closed, or the pacing engine may have given up the
    // campaign's lease or begun shutting down. Both are asked HERE, before the
    // lease is extended, the attempt is stamped `dialing` and the live record is
    // registered: `dialed_at IS NOT NULL` reads as "the call was placed" (campaign
    // stats, the agent stats aggregate, the series), and the abandon path observes
    // seat time for a registered attempt, so a refusal after those would record a
    // dial the carrier never saw.
    //
    // The socket half is late binding's: early binding's dial carries the socket,
    // and the bridge refuses a dead one (the `catch` below).
    if (lateBinding && this.stations.socketFor(sessionId) !== socket) {
      log.warn(
        { attemptId, sessionId },
        'Station socket went away while the dial was being prepared — abandoning before placing an unbound call nobody is watching',
      );
      await this.abandonBeforeDial(cmd, 'reservation_expired', panelDelivered, 'return_now');
      return;
    }
    // Two short writes (the lease CAS, the `dialing` stamp) still sit between this
    // and the carrier. A stop landing inside them does not call the dial off; it
    // goes out like any dial placed before the stop.
    if (opts.stillAuthorised && !opts.stillAuthorised()) {
      log.warn(
        { attemptId, sessionId, campaignId: cmd.campaignId },
        'Pacing stopped or lost the campaign lease while the dial was being prepared — abandoning before the carrier is contacted',
      );
      await this.abandonBeforeDial(cmd, 'reservation_expired', panelDelivered, 'return_now');
      return;
    }

    // ── 3. Dial. Under early binding, no await between the send above and this
    //    point — under late binding there is no send to be ahead of, and the
    //    guarantee is the `answered` arm's. ─────────────────────────────────
    // Extend the agent's lease from the short pre-dial window to the dialing one
    // and start renewing it, because from here the dial owns the agent.
    //
    // **The CAS result decides whether we dial at all.** It was discarded, and the
    // dial went out regardless — which recreates precisely the reserved-then-
    // abandoned failure the lease split exists to prevent. `transition` returns
    // false when the short pre-dial lease expired while prior attempts were
    // loading, when the agent moved underneath us, AND when Redis is unreachable
    // (it fails closed). In every one of those cases the renewal below would never
    // stick, so the call would ring a real customer with no agent committed to it.
    const stillReserved = await this.agents.transition(sessionId, 'reserved', 'reserved', {
      attemptId,
      leaseMs: AGENT_LEASE_MS.reserved_dialing,
    });
    if (!stillReserved) {
      log.warn(
        { attemptId, sessionId },
        'Lost the agent lease before dialing — abandoning rather than calling with no agent',
      );
      await this.abandonBeforeDial(cmd, 'reservation_expired', panelDelivered, 'return_now');
      return;
    }
    this.startLeaseRenewal(attemptId, sessionId, 'reserved');

    // One instant for the column and its in-process twin below (`LiveAttempt.dialedAt`
    // documents itself as the same value), not two `new Date()`s a few ms apart.
    const dialedAt = new Date();
    await agencyAttemptRepository.setState(attemptId, 'dialing', { dialed_at: dialedAt });

    // Registered BEFORE the dial: a carrier can answer inside createBridgedCall —
    // and under late binding that is no longer the rare case the map was built
    // for. The `answered` arm is where the socket gets bound, so an event that
    // arrived before this line existed would leave a live customer with no agent
    // and no record of the attempt to abandon.
    // Held as a local too: the dial's failure path below asks whether the `ended` arm
    // has settled THIS record meanwhile (`liveByAttempt` no longer holds it).
    let dialReturned!: (outcomeUnknown: boolean) => void;
    const live: LiveAttempt = {
      cmd, state: 'dialing', bridgedAt: null, answeredAt: null, priors,
      lateBinding, panel: attempt, panelDelivered, dialedAt,
      abandonReason: null, placing: false, outcomeUnknownEnd: false,
      dialSettled: new Promise<boolean>((resolve) => { dialReturned = resolve; }),
    };
    this.liveByAttempt.set(attemptId, live);
    // A wrap-up redial's set-up ends here: from now on `hasLiveRedial` answers for it.
    if (cmd.redial) this.wrapup.endRedialSetup(sessionId);

    /**
     * Only the DIAL is inside this try.
     *
     * `attachWebrtcCall` used to sit here too, and its catch ran
     * `abandonBeforeDial` — which is a lie once `createBridgedCall` has returned:
     * the PSTN leg is live, the agent may already be talking, and that path
     * deletes the attempt from `liveByAttempt`, stops lease renewal and settles the
     * attempt `orphaned`. The conversation carries on with no agency lifecycle
     * attached to it and the concurrency slot is held until an unrelated sweep
     * notices. A failed bookkeeping write must never end a live call.
     */
    // One params object for both creation modes, so the two dials cannot drift in
    // anything but the browser socket — which is the whole of the difference.
    const dialParams = {
      tenantId: cmd.tenantId,
      accountId: cmd.accountId,
      callerId: cmd.callerId,
      destinationPhone: cmd.contact.phone_e164,
      provider: cmd.campaign.telephony_provider,
      // The tenant carrier credential the campaign is pinned to (null: the service's own
      // account). The bridge pins it on the call row and dials on it, never on another.
      telephonyCredentialId: cmd.campaign.telephony_credential_id ?? null,
      // No SIP connection: there is no BYO-SIP egress, so `WebRtcOutboundParams` has no
      // such field (`docs/seams.md`).
      record: cmd.campaign.record_calls,
      analysisProfileId: cmd.campaign.analysis_profile_id,
      initiatedBy: cmd.sessionId,
      // The attempt is the correlation: lifecycle events, the bind, the re-attach
      // and every forced end are keyed on `attemptId` (docs/seams.md §3.1).
      correlation: { kind: 'attempt' as const, campaignId: cmd.campaignId, agencyAttemptId: attemptId },
      // The deferred-hangup grace. Supplied by us, never chosen by the bridge — the
      // dialer depends on the bridge and never the reverse, so the bridge must stay
      // ignorant of what an agency reconnect is worth, and the browser dialer keeps
      // its immediate hangup.
      //
      // Carried on the unbound dial too, even though there is nothing to detach
      // until the bind: the bridge stores it on the session at dial time and the
      // bind reads it back (`session.browserLegGraceMs`), so a socket that drops
      // after the answer gets the same window an early-bound one would.
      browserCloseGraceMs: DEFERRED_HANGUP_MS,
    };

    // ── Re-ask for the socket now the attempt is registered ─────────────────
    //
    // Late binding loses the bridge's own preflight: `createBridgedCall` throws
    // `station_socket_unavailable` for a dead socket, and `createUnboundBridgedCall`
    // has no socket to check. The replacement check ran above, before the lease CAS
    // and the `dialing` write, and a station closing inside those two arms
    // nothing: `noteStationClosed` asks `hasUnannouncedAttempt`, which reads
    // `liveByAttempt`, which had no entry yet. The dial would go out unbound with
    // no socket and no timer, and run to the carrier's answer.
    //
    // So the question is asked once more, on the near side of the registration:
    // from here on a close is covered, because the entry the grace looks for
    // exists. A refusal here is the one abandon of an unplaced dial that leaves
    // `dialed_at` set, exactly like early binding's bridge preflight refusing in
    // the `catch` below; both are confined to those two writes.
    if (lateBinding && this.stations.socketFor(sessionId) !== socket) {
      log.warn(
        { attemptId, sessionId },
        'Station socket went away while the dial was being prepared — abandoning before placing an unbound call nobody is watching',
      );
      await this.abandonBeforeDial(cmd, 'reservation_expired', panelDelivered, 'return_now');
      return;
    }

    let record: Awaited<ReturnType<typeof this.bridge.createBridgedCall>>;
    live.placing = true;
    try {
      // The one line late binding changes about the dial: no socket goes to the
      // carrier leg, so `attachBrowserLeg`'s token-less fallback cannot reach this
      // call and the bridge emits no `bridged` at the answer. Everything after the
      // answer is the `answered` arm's job.
      record = lateBinding
        ? await this.bridge.createUnboundBridgedCall(dialParams)
        : await this.bridge.createBridgedCall({ ...dialParams, browserSocket: socket });

    } catch (err) {
      live.placing = false;
      // The bridge wraps the adapter's error as `cause`; read through it. The `ended` arm
      // may have seen the bridge's outcome-unknown end first (`onEnded`), which says the
      // same thing whatever the rejection carries.
      const outcomeUnknown = isDialOutcomeUnknown(err) || live.outcomeUnknownEnd;
      // Before the check below: an `ended` arm that settled this attempt while the dial
      // was in flight is waiting on this answer to settle its contact.
      dialReturned(outcomeUnknown);
      // The refusal breaker (PL11), before the check below too: a carrier refusal
      // (`telephony_init_failed`) has already been settled by the `ended` arm, and still counts.
      const refusalStreakTripped = await this.noteCarrierRefusal(cmd, err);
      // ── Settled exactly once ─────────────────────────────────────────────────
      //
      // A dial the bridge got as far as the carrier with is ended by the bridge before
      // this rejection reaches us: its `endCall` emits `ended` and then throws. Every
      // such end except an outcome-unknown one is the `ended` arm's to settle (the
      // attempt row, the `released` frame, the agent, and the contact once it has this
      // dial's answer, `dialSettled`), and it has started to: it forgets the record
      // synchronously, inside the emit. Abandoning it again here wrote the row a second
      // time, sent the agent a second `released`, and released the agent a second time,
      // after pacing may already have reserved them for their next call. The same holds
      // for a teardown that raced the dial (the agent hung up while `add_lead` was in
      // flight): the `ended` arm holds the contact back if this answer is outcome-unknown.
      if (this.liveByAttempt.get(attemptId) !== live) {
        log.warn({ err, attemptId, outcomeUnknown }, 'Agency dial failed after its end was settled — the ended arm settles its contact');
        return;
      }
      const refusal = classifyDialRefusal(err);
      const reason: AgencyReleaseReason = refusal.kind === 'station_unavailable' ? 'reservation_expired' : 'failed';
      // The campaign's carrier account cannot dial: the carrier refused its credential
      // (HTTP 401, `carrier_auth`), or the credential is no longer active (disabled,
      // invalid or revoked since the campaign started, refused before the carrier:
      // `carrier_account_unavailable`). A keyring fault (a master key missing) is not one:
      // the bridge rethrows it as its own failure (`other`), held a minute, nothing paused. Every further dial on it would be refused
      // too, so the campaign is paused before this attempt is settled. Nothing was placed
      // and the contact did nothing wrong: it goes back at once, uncharged, and waits for
      // the resume.
      if (refusal.kind === 'carrier_account') await pauseCampaignForCarrierAccount(cmd.campaign, refusal.pause);
      // An admission or calls-per-second refusal is back-pressure: pacing caps its dials by
      // the account limit, so it is bounded by the next tick's capacity, not a loop, and
      // holding the contact a minute would only stall a floor that frees capacity within
      // seconds (`integration/load/concurrency-cap.test.ts`). A dial not sent for the
      // carrier's configuration that tripped the breaker: the campaign is paused, so its
      // contact goes back at once like any carrier-account pause's.
      const capacityRefused =
        refusal.kind === 'capacity' || refusal.kind === 'carrier_account' || refusalStreakTripped;
      // The carrier cannot dial this contact's number at all (it passed our E.164 gate but
      // not the carrier's own check): terminal for the contact, as the pre-dial gate's
      // `phone_invalid` is, never a minute's hold that repeats for as long as the campaign runs.
      const fate: AbandonedContactFate =
        refusal.kind === 'not_sent' && refusal.reason === 'destination' ? 'suppress_invalid'
          : outcomeUnknown ? 'hold_unknown'
            : reason !== 'failed' || capacityRefused ? 'return_now'
              : 'return_delayed';
      log.warn({ err, attemptId, outcomeUnknown, fate }, 'Agency dial failed');
      await this.abandonBeforeDial(cmd, reason, panelDelivered, fate);
      return;
    }
    live.placing = false;
    dialReturned(false);
    // Placed: the carrier took the create-call, so any refusal streak is broken (PL11). Not
    // awaited: the reset is off the dial path. Its Redis DEL is queued on the connection
    // before this returns, so a later refusal's INCR still lands after it. `notePlaced`
    // never throws; the catch only makes an unhandled rejection impossible.
    //
    // Only a dial that was sent: a teardown while the dial waited for a calls-per-second
    // slot (or before it) resolves too, with no carrier handle (`dialWasSent`). Nothing
    // reached the carrier, so it says nothing about the account and must not end a streak.
    // Its `ended` arm has settled the attempt already; the attach below still correlates
    // the row with its (terminal) call.
    if (cmd.campaign.telephony_credential_id && dialWasSent(record)) {
      void this.refusalBreaker.notePlaced(cmd.campaignId).catch((err) =>
        log.warn({ err, campaignId: cmd.campaignId }, 'Carrier refusal streak not reset — it lapses with its TTL'));
    }

    // Id only — NEVER the state. By the time this runs the carrier may already
    // have answered and `onBridgeLifecycle` may already have written `bridged`
    // (it fires from inside createBridgedCall on a fast carrier). Re-asserting
    // `dialing` here would clobber it, and the row would read `dialing` for the
    // entire duration of a live conversation.
    //
    // Failure here is a correlation gap, not a call-ending event: the attempt row
    // loses its `webrtc_call_id`, so settlement cannot join the leg back to the
    // attempt. Logged at ERROR because that gap is silent everywhere else, and
    // deliberately not fatal — the call is live and the bridge lifecycle owns it.
    await agencyAttemptRepository.attachWebrtcCall(attemptId, record.id).catch((err) =>
      log.error(
        { err, attemptId, webrtcCallId: record.id },
        'Could not attach the media leg to the agency attempt — call is live but uncorrelated',
      ),
    );
  }

  /**
   * Count a dial's rejection toward the campaign's refusal breaker (PL11), and pause the
   * campaign `carrier_refusing_calls` when the streak reaches the threshold. Only a campaign
   * pinned to a tenant credential is counted: the service's own account is not a tenant's
   * to fix. True when this rejection tripped the breaker. Never throws.
   */
  private async noteCarrierRefusal(cmd: DialCommand, err: unknown): Promise<boolean> {
    if (!cmd.campaign.telephony_credential_id || !countsTowardBreaker(err)) return false;
    try {
      if (!(await this.refusalBreaker.noteRefusal(cmd.campaignId))) return false;
      log.warn({ campaignId: cmd.campaignId, attemptId: cmd.attemptId }, 'The carrier refused this campaign\'s dials several times in a row — pausing it');
      await pauseCampaignForCarrierAccount(cmd.campaign, 'carrier_refusing_calls');
      return true;
    } catch (breakerErr) {
      log.error({ err: breakerErr, campaignId: cmd.campaignId }, 'Carrier refusal breaker failed — the dial settles as usual');
      return false;
    }
  }

  /**
   * The dial never happened (or never will). End the attempt, return the contact,
   * release the agent, and — if they were ever shown a panel — TELL THEM WHY: a
   * panel that clears with no explanation reads as a broken app.
   *
   * `notifyAgent` is an explicit parameter and deliberately not inferred here.
   * This method has seven call sites in {@link executeDial}, on both sides of the
   * `reserved` send, and under late binding the send has not happened at ANY of
   * them — so the caller is the only place that knows whether there is a panel to
   * explain. Inferring it from `lateBinding` alone would be wrong for the early
   * path's pre-send abandons, and inferring it from the live record is not
   * possible: the first thing this method does is delete it.
   *
   * With `false` the agent is told nothing, which is the point of late binding: a
   * dial that was abandoned before it was ever placed is a call the agent never
   * knew about, and a bare `released` for it is the same spurious popup the
   * agents dismiss.
   */
  private async abandonBeforeDial(
    cmd: DialCommand,
    reason: AgencyReleaseReason,
    notifyAgent: boolean,
    /** What becomes of the contact ({@link AbandonedContactFate}). */
    fate: AbandonedContactFate,
  ): Promise<void> {
    const outcome = reason === 'failed' ? 'failed' : 'orphaned';
    const dialOutcomeUnknown = fate === 'hold_unknown';
    /**
     * ── Seat time on the abandon-before-dial paths (added by review) ─────────
     *
     * `agency_attempt_hold_seconds` is observed at the settle site, which these
     * paths never reach: they delete the live record and write the attempt
     * `ended` themselves. Two of the seven callers run AFTER `liveByAttempt.set`
     * — the late-binding socket recheck and `createBridgedCall` throwing — and on
     * both **the agent was genuinely held**: the lease had been extended to
     * `reserved_dialing`, the attempt row says `dialing`, and `releaseAgent` runs
     * at the bottom of this method. Those seconds are in the
     * population the pivotal series claims to cover and were appearing nowhere,
     * so `failed` and `orphaned` were silently under-reported.
     *
     * `dialedAt` is the discriminator rather than the call site, and it is the
     * honest one: the five callers that run BEFORE the registration (the pacing
     * re-authorisation among them) have no live record, so there is no dial
     * instant to measure from and nothing to observe — which is correct, because
     * on those paths no dial went out. Read before the `delete` below, for the
     * obvious reason.
     */
    const live = this.liveByAttempt.get(cmd.attemptId);
    if (live) {
      const holdSeconds = elapsedSeconds(live.dialedAt);
      // No `campaign_id` on the histograms (series cost) — see metrics.ts.
      const labels = { tenant_id: cmd.tenantId, outcome };
      agencyAttemptHoldSeconds.observe(labels, holdSeconds);
    }
    this.forgetAttempt(cmd);
    await agencyAttemptRepository.setState(cmd.attemptId, 'ended', {
      // Same `outcome` the hold observation above is labelled with, so the
      // histogram bucket and the attempt row cannot disagree about what happened.
      outcome,
      ended_at: new Date(),
    }).catch((err) => {
      this.noteUnrecordedEnd(cmd.attemptId, dialOutcomeUnknown);
      log.error({ err, attemptId: cmd.attemptId }, 'Failed to end abandoned attempt — the reaper ends it');
    });

    if (cmd.redial) {
      // A wrap-up redial that never reached the carrier (or failed in the bridge): the
      // customer goes back to being held for the outcome the agent still owes on this
      // conversation, uncharged, and the agent back to wrap-up below. An outcome-unknown
      // dial is no exception for the contact: it is parked `connected`, which pacing
      // never claims, so no paced dial follows it. But the carrier may still ring the
      // customer, so the reopened wrap-up offers NO further redial (below).
      await parkRedialContact(cmd, outcome);
    } else if (fate === 'suppress_invalid') {
      // Terminal and uncharged: no dial was placed, so no `bump_attempt` (see the pacing
      // engine's `suppress` gate, which this mirrors).
      await agencyContactRepository.markState(cmd.contactId, 'suppressed', { suppressed_reason: 'invalid' })
        .catch((err) => log.error({ err, contactId: cmd.contactId }, 'Failed to suppress a contact the carrier cannot dial'));
    } else if (fate === 'hold_unknown') {
      // Not to be dialled again yet, and counted: the hold and the our-fault charge are
      // one statement, so a contact whose dials keep ending this way is retired at the
      // our-fault bound rather than redialled every 15 minutes for ever.
      await holdOutcomeUnknownContact(cmd, outcome);
    } else {
      // Called off before the dial (the agent's socket or lease went, pacing stopped): the
      // condition was the agent's or ours and has cleared, so `now()`. A dial the bridge
      // failed before the carrier waits PRE_CARRIER_FAILURE_REDIAL_DELAY_MS, so a failure
      // that repeats cannot redial the same contact on every tick (see the constant). Only
      // such a dial reaches here as `failed`: a carrier refusal is the `ended` arm's (except
      // the two that placed nothing, a rate limit and a refused credential, which the bridge
      // rejects with no `ended`). An admission or rate-limit refusal is back-pressure, not a
      // failure, and a refused credential paused the campaign: at once (`return_now`).
      const notBefore = fate === 'return_delayed'
        ? new Date(Date.now() + PRE_CARRIER_FAILURE_REDIAL_DELAY_MS)
        : new Date();
      await agencyContactRepository.unclaim(cmd.contactId, notBefore)
        .catch((err) => log.error({ err, contactId: cmd.contactId }, 'Failed to unclaim contact'));
    }

    if (notifyAgent) this.sendReleased(cmd, reason, !!cmd.redial, releaseMessageFor(reason));
    // A redial's agent goes back to wrap-up with the outcome pad (a fresh window, or
    // none when an outcome is required), never to the pool with an outcome owed: when
    // the wrap-up cannot be reopened, `releaseOwingOutcome` holds them out of the pool.
    if (cmd.redial) {
      if (!await this.enterRedialWrapup(cmd, { offerRedial: !dialOutcomeUnknown })) {
        await this.releaseOwingOutcome(cmd.sessionId);
      }
      return;
    }
    // Runs either way — the agent goes back to the pool (or `offline`) whether or
    // not they were told a call had been reserved for them. Suppressing the frame
    // must never suppress the release, or a silent abandon would leave the agent
    // `reserved` against an attempt that no longer exists until the lease lapsed.
    await this.releaseAgent(cmd.sessionId);
  }

  /**
   * A wrap-up redial the pacing path never saw could not be dispatched (the dispatcher
   * refused it before {@link executeDial} ran): end it and put the agent back in wrap-up,
   * as a dial that failed before the carrier. For `wrapup-redial.ts` only.
   */
  async abandonUndispatchedRedial(cmd: DialCommand): Promise<void> {
    await this.abandonBeforeDial(cmd, 'failed', true, 'return_delayed');
  }

  /**
   * Put the agent of a wrap-up attempt (a redial's, or the one a refused redial was
   * taken from) back in wrap-up, owing the outcome: the campaign's window (no timer when
   * none is configured, since an outcome is owed), with the redials the attempt's place in
   * its chain leaves. False when there is no live station to hold them in wrap-up for, or
   * the entry could not be opened: the caller releases them (`releaseAgent`) instead.
   */
  async enterRedialWrapup(target: {
    sessionId: string;
    attemptId: string;
    campaignId: string;
    tenantId: string;
    campaign: AgencyCampaignRecord;
    /** 0 for the attempt a refused redial was taken from when it was a paced dial. */
    redialNumber?: number;
    redial?: { number: number };
  }, opts: {
    /**
     * False: offer no further redial on the reopened wrap-up. A redial whose own dial
     * outcome is unknown (the carrier may have queued it and may still ring the
     * customer) must not be followed by a second call to the same person.
     */
    offerRedial?: boolean;
  } = {}): Promise<boolean> {
    if (!this.stations.isLocallyOwned(target.sessionId)) return false;
    const number = target.redial?.number ?? target.redialNumber ?? 0;
    try {
      return await this.wrapup.enter({
        sessionId: target.sessionId,
        attemptId: target.attemptId,
        campaignId: target.campaignId,
        tenantId: target.tenantId,
        wrapupSeconds: target.campaign.wrapup_seconds,
        autoReturn: target.campaign.wrapup_auto_return,
        requiresDisposition: true,
        readPendingBreak: () => this.breaks.peek(target.sessionId),
        redialRemaining: opts.offerRedial === false ? null : wrapupRedialRemaining(target.campaign, true, number),
      });
    } catch (err) {
      log.error({ err, sessionId: target.sessionId, attemptId: target.attemptId }, 'Could not put the agent back in wrap-up after a redial — holding them out of the pool');
      return false;
    }
  }

  /**
   * The release for an agent who still owes a conversation's outcome but could not be
   * put back in wrap-up (a wrap-up redial's fallback, when {@link enterRedialWrapup}
   * returned false). Never `available`:
   *
   *  - the station is gone: `offline`, exactly as {@link releaseAgent} writes it (they
   *    rehydrate into `break`);
   *  - the station is here but the wrap-up could not be opened (`WrapupManager.enter`
   *    threw): `break`, with the break they queued if any, so pacing cannot dial into
   *    an agent with an outcome owed. The outcome stays owed on the attempt row: the
   *    agent can still save it (the disposition route does not need a wrap-up), and the
   *    lapsed-wrap-up sweep closes it `no_disposition` otherwise. They go available
   *    themselves.
   *
   * A paced conversation whose `enter` throws is released through {@link releaseAgent}
   * (to the pool): that is the documented fallback of the `ended` arm and is unchanged.
   */
  async releaseOwingOutcome(sessionId: string): Promise<AgentReleaseResult> {
    this.wrapup.endRedialSetup(sessionId);
    if (!this.stations.isLocallyOwned(sessionId)) return this.releaseAgent(sessionId);
    const queuedBreak = this.breaks.take(sessionId);
    const set = await this.agents.set(sessionId, 'break', { leaseMs: AGENT_LEASE_MS.break });
    await mirrored(
      agencyAgentSessionRepository.setState(sessionId, 'break', queuedBreak?.code ?? null),
      sessionId, 'Could not mirror held agent state',
    );
    this.stations.send(sessionId, {
      event: 'agent_state',
      state: 'break',
      since: new Date().toISOString(),
      ...(queuedBreak ? { break_reason: queuedBreak.code } : {}),
    });
    log.warn({ sessionId }, 'Could not reopen wrap-up with an outcome owed — agent held on break, out of the pool');
    return { state: 'break', result: set };
  }

  /**
   * Is a wrap-up redial in flight for this agent: being set up (its wrap-up taken, its
   * attempt not yet registered here), or registered and live (queued, ringing, on the
   * call, or in its deferred hangup)? While it is, the conversation's outcome is owed and
   * no wrap-up entry exists to say so, so `/available`, force-available and `/leave`
   * refuse on this.
   */
  hasRedialInFlight(sessionId: string): boolean {
    if (this.wrapup.redialBeingSetUp(sessionId)) return true;
    const attemptId = this.attemptIdFor(sessionId);
    return attemptId !== null && !!this.liveByAttempt.get(attemptId)?.cmd.redial;
  }

  /** Bridge told us something happened to a call we placed. */
  private async onBridgeLifecycle(ev: WebRtcLifecycleEvent): Promise<void> {
    // Correlate on the caller-supplied id, which we registered before dialing.
    const live = ev.correlationId ? this.liveByAttempt.get(ev.correlationId) : undefined;
    if (!live) return; // not ours — an ordinary browser dialer call

    // Switch on the phase EXPLICITLY. This used to read "if bridged … else it must
    // be ended", and a phase added to the bridge's union would have fallen straight
    // into teardown — ending a live call the instant the carrier answered it.
    if (ev.phase === 'answered') {
      await this.onAnswered(live, ev);
      return;
    }
    if (ev.phase === 'bridged') {
      await this.onBridged(live, ev);
      return;
    }

    // ── ended ──
    await this.onEnded(live, ev);
  }

  /**
   * The `answered` arm: the carrier picked up. Records the answer, binds the
   * agent's socket under late binding, and takes the abandoned path when there is
   * no agent behind the call.
   */
  private async onAnswered(live: LiveAttempt, ev: WebRtcLifecycleEvent): Promise<void> {
    const cmd = live.cmd;
    // The carrier answered. Media is NOT necessarily bridged, and on a lost-agent
    // call never will be — which is exactly why this is recorded separately
    // rather than back-filled at bridge time. `answered_at` and `bridged_at`
    // being the same instant by construction makes the abandonment predicate
    // (answered, and no bridge within N ms) vacuous, and leaves the compliance
    // denominator with no source at all.
    live.state = 'answered';
    // Bound to a local first, then written to both the row and our own record —
    // NOT `ev.answeredAt ?? new Date()` evaluated twice. Two evaluations of the
    // fallback are two different instants, and the settle site's predicate
    // subtracts one from `bridged_at`: a millisecond of disagreement between the
    // counter's view and the column's is exactly the kind of drift that makes the
    // counter-versus-table cross-check fail for a reason that is not a bug.
    const answeredAt = ev.answeredAt ?? new Date();
    live.answeredAt = answeredAt;

    // Dial → answer. Prices a ring timeout (where the curve flattens, and what
    // the tail beyond it would forgo) and supplies the clustering half of the
    // over-dial arithmetic, which a flat answer probability cannot. Observed HERE, before
    // the bind, so a refused bind never costs us the reading.
    const answerLatencySeconds = elapsedSeconds(live.dialedAt, answeredAt);
    // Tenant-scoped only: `campaign_id` is kept off the histograms (series cost).
    agencyAnswerLatencySeconds.observe({ tenant_id: cmd.tenantId }, answerLatencySeconds);

    /**
     * The abandon DECISION is taken here, synchronously, before any await.
     *
     * `bridged` follows `answered` within the same turn on a fast carrier, and
     * lifecycle listeners are invoked fire-and-forget — so the `bridged` handler
     * can run to completion inside the await below. Deciding after it meant
     * reading a station that had already `detach`ed for a deferred hangup and
     * calling `abandonAnsweredCall` on a call that was by then bridged: the
     * apology clip plays over a live conversation and the customer is hung up on
     * mid-sentence. Whether an agent was there is a fact about THIS instant.
     */
    const lostTheAgent = !this.stations.isLocallyOwned(cmd.sessionId);
    /**
     * ⚠️ **Set HERE, outside every `lateBinding` branch, and that is the whole
     * point of this line** (second review pass).
     *
     * The first version set the reason only inside the two late-binding arms
     * below. `agency_late_binding` defaults to **false**, so on the path that
     * actually runs today a station loss reached the settle site with no reason
     * at all and the fallback stamped it `no_agent_available` — a dropped
     * workstation reported as a pacing problem. That is the exact conflation
     * the previous review round flagged and this vocabulary exists to end; the
     * fix had been applied to the flag-on branch only, which is the branch
     * nobody is running.
     *
     * `lostTheAgent` is flag-independent (it is read one line up, whatever the
     * binding mode), so the reason that follows from it must be too. The bind
     * arms below only ever REFINE this — `bind_failed` when a panel reached the
     * agent and the bridge then refused — and they are unreachable when this is
     * already true, because they are gated on `!lostTheAgent`.
     */
    if (lostTheAgent) live.abandonReason = 'station_lost';

    /**
     * ── LATE BINDING: the panel and the socket, both inside this turn ───────
     *
     * The whole of the change, and its ORDERING is the change. Everything here
     * is synchronous — no `await`, nothing read from Redis or the DB, the panel
     * already built at dial time — because the abandonment predicate measures
     * from the instant above and gives the entire path a 1000ms budget
     * (`ABANDONMENT_BRIDGE_GRACE_MS`). A connected call that spends more than
     * that between the answer and the bind is recorded as a call that reached
     * nobody, against a 3% regulatory ceiling.
     *
     * The order is `reserved` → bind, and it is not interchangeable:
     *
     *  1. `reserved` first, because the bind emits `bridged` **synchronously**
     *     (`WebRtcBridgeManager.emitBridgedIfLive`, reached from
     *     `bindBorrowedBrowserLeg`). Lifecycle listeners are invoked inline, so
     *     THIS HANDLER RE-ENTERS on the `bridged` phase inside the bind call
     *     below: `live.state`, `live.bridgedAt` and the console's `bridged`
     *     frame are all written before `bindBorrowedBrowserLeg` returns, and
     *     `live.state` is already `'bridged'` by the time control comes back to
     *     the next line. That re-entrancy is intended and is precisely what puts
     *     `reserved` and then `bridged` on the wire in that order. Binding first
     *     would deliver the connect cue for a call the console has never heard
     *     of — the console has no panel to attach it to and drops it.
     *  2. `stations.send(…, socket)` with the socket we are about to bind, not
     *     the bare two-argument form. The two must be the SAME socket or we
     *     announce the call to one console and relay its audio to another; the
     *     third argument is the registry's "answer this socket, or answer
     *     nobody" guard.
     *
     * A failure on either half means a real customer is on the line with no
     * agent behind it, which is the abandoned path — not an error to log. It is
     * reached through the shared fence below rather than returning early here,
     * because the `answered` row write and the compliance DENOMINATOR must
     * still land: an abandoned call that is missing from the denominator
     * understates the very rate it is an instance of.
     *
     * The two failures are NOT the same event for the agent, though, and
     * `panelDelivered` is what keeps them apart. Send failed ⇒ they saw nothing
     * and are told nothing. Send succeeded and the bind was refused ⇒ the panel
     * is on their screen, so the `ended` arm owes them the `released` that
     * clears it — reason `abandoned`, "The call was answered but could not be
     * connected to you", which is exactly true of that case.
     */
    let bindFailed = false;
    if (live.lateBinding && !lostTheAgent) {
      const socket = this.stations.socketFor(cmd.sessionId);
      // `socket` is undefined only in the race `lostTheAgent` already names (the
      // station detached between the two reads); `send` refuses a socket that is
      // not OPEN or not the incumbent, and `bindBorrowedBrowserLeg` refuses a
      // closed one, an already-bound one and an ending call. So every way this
      // can fail lands on the same answer, and none of them is checked twice.
      if (socket && this.stations.send(cmd.sessionId, { event: 'reserved', attempt: live.panel }, socket)) {
        // ⚠️ Set from the SEND, never from the bind, and the two facts are kept
        // independent because they are independent: whether the agent has SEEN
        // this call, and whether their audio got attached to it.
        //
        // Conflating them orphans the panel. Sending succeeds, the bind is
        // refused, `panelDelivered` stays false — and the `ended` arm then reads
        // `isUnannounced` as true and SUPPRESSES the `released`. The agent is
        // left staring at a contact card for a call they never heard and are
        // never told about: a "connected but silent" console, manufactured by the
        // fix for exactly that complaint. `hasUnannouncedAttempt` would
        // mis-word `/leave`'s refusal for the same reason.
        live.panelDelivered = true;
        bindFailed = !this.bridge.bindBorrowedBrowserLeg(cmd.attemptId, socket);
      } else {
        // No panel on the wire ⇒ no bind attempted. Nothing was announced, so
        // nothing is owed an explanation.
        bindFailed = true;
      }
      if (bindFailed) {
        log.warn(
          { attemptId: cmd.attemptId, sessionId: cmd.sessionId, announced: live.panelDelivered },
          'Late bind failed at the carrier answer — customer is on the line with no agent',
        );
      }

      /**
       * ── The rollout's abort criterion, finally measurable ──────────────────
       *
       * The late-binding rollout's abort criterion is "bind-latency p99 <150ms and
       * zero bind failures"; without these series a refused bind is a WARN line and
       * nothing else.
       *
       * `answeredAt` is the CARRIER's instant, not ours, so this interval
       * includes webhook transit. That is deliberate and it is the honest
       * measure: `ABANDONMENT_BRIDGE_GRACE_MS` counts that time too, so a
       * latency measured from our own receipt would clear a budget the
       * compliance predicate says we blew.
       *
       * **The counter is not derivable from the histogram.** A bind that never
       * happened records no latency, so a rollout watching only the p99 would
       * see it IMPROVE as binds began to fail. `bind_failed` vs `station_lost`
       * splits on `panelDelivered` because that is already the discriminator
       * the `ended` arm uses to decide whether the agent is owed a `released`:
       * the panel reached them and the bind was refused, or nothing was ever
       * announced.
       */
      // ⚠️ **ONE discrimination, one vocabulary.** The cause is decided here and
      // then reused as the metric label, rather than computed twice — the first
      // draft named the same event `refused` on the counter and `bind_failed` on
      // the row, so an operator correlating the two panels had to know they meant
      // the same thing, and either could drift without the other noticing.
      //
      // `panelDelivered` is the discriminator because it is already the one the
      // `ended` arm uses to decide whether the agent is owed a `released`: the
      // panel reached them and the bind was refused, or nothing was announced at
      // all. So bind results are `bound` plus a subset of the abandon reasons,
      // and `agency_bind_total` joins to `agency_abandoned_reason_total` on the
      // label value.
      if (bindFailed) {
        live.abandonReason = live.panelDelivered ? 'bind_failed' : 'station_lost';
      }
      const bindResult = live.abandonReason ?? 'bound';
      agencyBindTotal.inc({ tenant_id: cmd.tenantId, campaign_id: cmd.campaignId, result: bindResult });
      if (!bindFailed) {
        const bindSeconds = elapsedSeconds(answeredAt);
        // `agency_bind_total` above keeps `campaign_id`; the latency histogram
        // does not (series cost) — see metrics.ts.
        agencyBindLatencySeconds.observe({ tenant_id: cmd.tenantId }, bindSeconds);
      }
    } else if (live.lateBinding) {
      /**
       * Late binding was on and we never reached for a socket, because the agent
       * was already gone at the instant above.
       *
       * ⚠️ **`station_lost`, NOT `no_agent_available`** (corrected by review).
       * `lostTheAgent` is `!isLocallyOwned(sessionId)` — a station-map check. We
       * HAD an agent, we reserved them, we dialed for them, and their socket went
       * away before the carrier answered. That is a workstation fact.
       *
       * The first version wrote `no_agent_available` here and justified it as "a
       * pacing fact (we dialed for somebody who left)". That is precisely the
       * conflation this whole reason vocabulary exists to end: `no_agent_available`
       * is what a pacing controller produces when it dials with nobody free, and
       * an operator seeing it should slow the pacing down. Reporting a dropped
       * laptop under that label sends them to tune a dialer over a wifi problem.
       *
       * It therefore shares `station_lost` with the send-refused case below-right,
       * which is correct — both mean "the station was not there". The finer split
       * (gone before we reached, versus the send being refused) stays in the WARN
       * line, which already carries `announced`; it does not earn a label whose
       * two values an operator cannot act on differently.
       */
      live.abandonReason = 'station_lost';
      agencyBindTotal.inc({
        tenant_id: cmd.tenantId, campaign_id: cmd.campaignId, result: live.abandonReason,
      });
    }

    // `only_from: ['dialing']` because this write races the `bridged` one. Both
    // are in flight at once and Postgres does not order them for us; without the
    // guard the loser's `state` wins and a bridged call reads `answered`. The
    // `answered_at` patch is deliberately outside the guard — the abandonment
    // predicate has no other source for it.
    //
    // Caught, because the abandon decision below must not depend on it: a
    // rejection here used to skip the apology and the hangup, leaving a customer
    // with no agent behind them on silence until the PSTN leg closed or the
    // max-duration timer fired. The row is the reaper's to repair; the customer
    // on the line is not.
    await agencyAttemptRepository.setState(cmd.attemptId, 'answered', {
      answered_at: answeredAt,
      only_from: ['dialing'],
    }).catch((err) => log.error(
      { err, attemptId: cmd.attemptId },
      'Could not record the carrier answer on the attempt row — still evaluating the abandon branch',
    ));

    // The compliance DENOMINATOR, counted here and nowhere else.
    // This is the only site that observes a carrier answer, and it is reached by
    // both the bridged and the abandoned path — which is what makes the ratio
    // below it meaningful. Counting on `bridged` instead would exclude every
    // abandoned call from the denominator and understate the rate.
    agencyAnsweredTotal.inc({ tenant_id: cmd.tenantId, campaign_id: cmd.campaignId });

    // ── The abandoned path ────────────────────────────────────────────────
    // A real customer is on the line RIGHT NOW and there is no agent to bridge
    // them to. Recorded before anything is played, so an attempt is never left
    // looking merely `answered` if the clip or the hangup goes wrong.
    // Second half of the fence: `bridged` sets `live.state` synchronously before
    // its own awaits, so a phase that moved on during the write above is visible
    // here. Agent gone AND still un-bridged is the only state an apology belongs
    // in — anything else is a conversation in progress.
    //
    // `bindFailed` is the late-binding arrival at the same fact: the agent was
    // there a few microseconds ago and the socket could not be joined to the
    // call, so nobody is behind it. It is ORed rather than folded into
    // `lostTheAgent` because the two are different observations and the log line
    // above distinguishes them.
    //
    // The `live.state === 'answered'` half also does the work of "did the bind
    // succeed": a successful bind has already re-entered this handler on the
    // `bridged` phase and left `live.state === 'bridged'`, so it cannot reach
    // the apology. The one case it correctly lets through is a bind that
    // attached but whose media is not negotiated yet (`emitBridgedIfLive` is a
    // no-op until `providerMediaReady`) — there `bindFailed` is false and
    // `lostTheAgent` is false, so nothing fires and the real `bridged` event
    // arrives later.
    if ((lostTheAgent || bindFailed) && live.state === 'answered') {
      await this.abandonAnsweredCall(live);
    }
  }

  /**
   * The `bridged` arm: both legs are live. Tells the console first, then moves the
   * agent to `on_call` and records the bridge.
   */
  private async onBridged(live: LiveAttempt, ev: WebRtcLifecycleEvent): Promise<void> {
    const cmd = live.cmd;
    const bridgedAt = new Date();
    // Recorded before the frame: a reconnect racing this handler must find the
    // attempt already `bridged`, or the resumed panel would say "ringing" while
    // the customer is mid-sentence.
    live.state = 'bridged';
    live.bridgedAt = bridgedAt;

    // ── The frame goes FIRST, synchronously, before any await. ────────────
    // Media is already live by the time the bridge emits this: the customer can
    // speak from this instant, and the agent is looking at a panel that still
    // says "connecting". The console schedules its audible connect cue inside
    // this frame's handler against a 150ms audibility budget, so anything ahead
    // of the send spends that budget on the agent's behalf.
    //
    // This used to sit after two DB round trips and a Redis write — 10–50ms on a
    // healthy stack and unbounded on a loaded one, for no benefit: none of those
    // writes make the audio any more live than it already is, and none of them
    // can fail in a way the agent should learn about by being told late. Same
    // ordering discipline as the `reserved` frame in executeDial, and for the
    // same reason: the wire first, the bookkeeping after.
    this.stations.send(cmd.sessionId, {
      event: 'bridged',
      attempt_id: cmd.attemptId,
      bridged_at: bridgedAt.toISOString(),
    });

    // ── The COMPLIANCE write goes LAST, after the agent-state writes ────────
    //
    // `bridged_at` is not bookkeeping: with late binding it is the SOLE
    // discriminator between a conversation and an abandoned call.
    // `ABANDONED_ATTEMPT_PREDICATE_SQL` counts `bridged_at IS NULL` as abandoned,
    // so an attempt that never gets this write is a fully-conversed call charged
    // against the 3% regulatory ceiling — and it feeds the auto-pause, so it can
    // stop a campaign. Nothing retries it: the `bridged` phase fires once.
    //
    // It still sits behind `agents.set` (Redis) and the `on_call` mirror, and
    // that is deliberate. Moving it first was tried and reverted: dispatching the
    // attempt UPDATE ahead of the mirror delays the mirror enough that it can land
    // after a teardown has already written the agent away, leaving an agent
    // durably `on_call` on a call that ended (the `restart-mid-bridge` chaos
    // suite fails on it). The trade is a rare lost `bridged_at` on an unclean
    // shutdown against a reproducible stuck agent; closing the gap needs the
    // mirror write made order-safe, not a reshuffle of these statements.
    // `late-binding.test.ts` ('keeps the compliance write LAST…') pins the order.
    //
    // `answered_at` comes from the bridge's own anchor, never from `bridgedAt`.
    //
    // **The protection here is the ARGUMENT, not the column's write rule, and the
    // comment that used to sit here credited the wrong one.** The column is
    // `answered_at = COALESCE($6, answered_at)` where `$6` is the INCOMING value —
    // so a non-null argument WINS over whatever is stored. That is
    // last-non-null-wins, not first-write-wins. Passing `bridgedAt` from this site
    // would therefore *overwrite* the carrier's answer instant rather than being
    // ignored by the mechanism, collapsing the two timestamps and making the
    // abandonment predicate vacuous — a defect that reads as a 0% rate. What
    // actually keeps that from happening is that this caller passes
    // `ev.answeredAt` (the bridge's own anchor, undefined when there is nothing to
    // say) and nothing else. Any second caller of this write must do the same;
    // the SQL will not stop it.
    //
    // `ev.answeredAt` is still passed rather than omitted so a MISSED `answered`
    // event is back-filled with the correct instant.
    //
    // Mirror it into our own record for the same reason: if the
    // `answered` phase never arrived, the settle site would otherwise see
    // `answeredAt: null`, read "never answered", and skip a call the table counts.
    // `??=` so a real `answered` phase's value is never displaced.
    live.answeredAt ??= ev.answeredAt ?? null;
    // ── This write must not RESURRECT a settled attempt ─────────────────────
    //
    // It carries `only_from` just as the `answered` write above it does, on the
    // same row, against the same race — without it, this is the write that can put
    // a live state over a TERMINAL one. The orderings are ordinary
    // rather than exotic: lifecycle listeners are invoked fire-and-forget, so on
    // a call the customer picks up and immediately drops, the `ended` arm can
    // run to completion while this statement is still in flight. `state` then
    // would go back to `bridged` on a row that already holds its real `outcome` and
    // `ended_at`, and nothing anywhere would go red.
    //
    // What that costs, beyond a wrong row: `agency_live_attempts_current`
    // counts on `state <> 'ended'`, so a resurrected attempt is counted live
    // FOREVER — the gauge is SQL-derived and has no other way to forget it. The
    // pacing engine and the reaper both key off the same live-state vocabulary.
    // And the reaper cannot clean it up: `findNonTerminalOlderThan` would find
    // it, but `liveByAttempt` no longer holds it and `reapByIds` would stamp
    // `orphaned` over a call that in fact completed.
    //
    // ⚠️ The guard is on `state`, not on the statement, and that distinction is
    // the reason `only_from` exists (see `setState`'s SQL: the CASE covers the
    // `state` column while every timestamp is a plain `COALESCE`). The
    // `bridged_at` patch must still land on a late-arriving `bridged` — it is
    // one of the two columns the abandonment predicate is built on, and dropping
    // it would relabel a bridged call abandoned. Guarding the whole UPDATE would
    // do exactly that.
    //
    // `['dialing', 'answered']` are the only live states reachable here, and
    // the list is deliberately not `AGENCY_ATTEMPT_LIVE_STATES`: `queued` is
    // impossible because `executeDial` awaits its `dialing` write before the
    // dial, and nothing in the codebase ever writes `ringing`. `ended` is
    // absent, which is the whole guard.
    //
    // **`'answered'` is load-bearing, not defensive.** Under late binding the
    // bind happens inside the `answered` arm, so that arm's own write is issued
    // BEFORE this one and normally wins the row: the incumbent state at this
    // statement is `answered` on essentially every late-bound call. A guard of
    // `['dialing']` alone — mirroring the write above exactly — would therefore
    // leave every connected late-binding attempt reading `answered` for the
    // whole conversation, which is the vacuous-predicate shape with the sign flipped.
    await this.agents.set(cmd.sessionId, 'on_call', {
      attemptId: cmd.attemptId,
      leaseMs: AGENT_LEASE_MS.on_call,
    });
    this.startLeaseRenewal(cmd.attemptId, cmd.sessionId, 'on_call');
    await mirrored(agencyAgentSessionRepository.setState(cmd.sessionId, 'on_call'), cmd.sessionId, 'Could not mirror on_call state');
    await agencyAttemptRepository.setState(cmd.attemptId, 'bridged', {
      answered_at: ev.answeredAt,
      bridged_at: bridgedAt,
      only_from: ['dialing', 'answered'],
    });

    // ── The SEAM, and the site that actually parks the contact ──────────────
    //
    // `connected` means "the conversation happened and the contact is waiting on
    // the agent's write-up". It is a HOLD, and the things that release it are the
    // disposition route and the reaper's lapsed-wrap-up sweep — so writing it for
    // a campaign that will never be asked for a write-up parks the contact behind
    // a demand nobody will ever satisfy.
    //
    // The gate below the `ended` handler already answers the same question for
    // the contact's fate at settle time. That answer alone is INERT against this
    // site, and the failure is an ordering one rather than a hypothetical:
    // lifecycle listeners are invoked fire-and-forget (see the `answered` handler's
    // note), so on a call that ends promptly — a customer who picks up and hangs
    // up — the `ended` handler runs to completion inside the awaits above while
    // this write is still in flight. This stale `connected` then lands LAST, on top
    // of the `completed` the outcome policy just wrote, and the contact is parked
    // permanently: the campaign never reaches `completed`, no error is raised, and
    // the attempt row reads like a clean successful call. The reaper eventually
    // rescues it, which is precisely the "backstop as the mechanism" this ticket
    // exists to end.
    //
    // So the question is asked HERE too, off the one function that owns it. The
    // outcome is `'connected'` by construction: this handler only runs because the
    // legs bridged, and a bridged call cannot classify as anything else.
    //
    // When nothing is owed the contact simply stays `in_flight` for the duration of
    // the call — its claimed state, already counted outstanding by
    // `countOutstanding`, already the state `chargeAttempt` leaves it in between the
    // charge and the release, and still un-claimable because `claimDialable` only
    // ever claims `pending`. Nothing observes it as free, and the `ended` handler's
    // outcome policy sends it straight to `completed`.
    if (requiresDisposition('connected', cmd.campaign.disposition_catalog)) {
      await agencyContactRepository.markState(cmd.contactId, 'connected');
    }
  }

  /**
   * The `ended` arm: settle the attempt, tell the agent, and return them to the
   * pool — or hand them to wrap-up.
   *
   * **The agent is released whatever fails in between.** The row and contact
   * writes used to be awaited uncaught ahead of the `released` frame and
   * `releaseAgent`, so one rejected statement left the agent `reserved`/`on_call`
   * in Redis with the renewer already stopped (so the lease lapsed into nothing),
   * the console still showing the panel, and only the generic lifecycle log line
   * in `start()` to say why. The release is now in a `finally`, and the writes
   * that can fail are caught where they are made (`settleEnded`).
   *
   * That includes `wrapup.enter` throwing: it then leaves no wrap-up entry or
   * timer behind and has not called its own return path (`WrapupManager.enter`'s
   * contract), so the release here is the only one.
   */
  private async onEnded(live: LiveAttempt, ev: WebRtcLifecycleEvent): Promise<void> {
    const cmd = live.cmd;
    // ── An outcome-unknown dial is the dial's own failure path's to settle ─────
    //
    // The bridge ends a dial the carrier may have queued (`add_lead` timed out, or a 2xx
    // whose body could not be read) with this end, from inside the dial call, and then
    // the dial call rejects. `executeDial`'s catch is the path that holds the contact
    // back for `DIAL_OUTCOME_UNKNOWN_REDIAL_DELAY_MS`, charging the our-fault ledger and
    // not `attempt_count` (`abandonBeforeDial`). Settling here as well recorded it through the `failed`
    // retry policy — charging `attempt_count` and choosing the campaign's own delay,
    // which can be shorter than the hold — and then the hold's `unclaim` found the
    // contact no longer `in_flight` and did nothing. So the record is left exactly as it
    // is (registered, lease renewed) for the catch, which runs as soon as the bridge has
    // released the call's slots.
    if (live.placing && ev.errorCode === DIAL_OUTCOME_UNKNOWN_ERROR_CODE) {
      live.outcomeUnknownEnd = true;
      log.info({ attemptId: cmd.attemptId, callId: ev.callId }, 'Outcome-unknown dial ended by the bridge — the dial\'s failure path settles it');
      return;
    }
    // ── An end that raced the dial: its contact waits for the dial's answer ──
    //
    // Any other end while the dial is still in flight and nothing answered: the agent
    // hung up during a slow `add_lead`, the station went away, the bridge ended the call.
    // The attempt row, the `released` frame and the agent are settled now, but the
    // contact cannot be yet: if the dial then fails outcome-unknown, the carrier may
    // still ring that customer, so the contact must be held back
    // (`DIAL_OUTCOME_UNKNOWN_REDIAL_DELAY_MS`), and the dial's failure path finds this
    // attempt already settled and leaves it alone. Settling the contact here through
    // the policy (the our-fault `canceled` path, a 5-minute delay by default and as
    // short as a campaign likes) lost the hold. It stays `in_flight` (claimed, so no
    // tick can take it) for the moment the dial takes to return (`dialSettled`).
    const contactAfterDial = live.placing && live.answeredAt === null && live.bridgedAt === null;
    this.forgetAttempt(cmd);

    let settled: EndedSettlement | null = null;
    try {
      settled = await this.settleEnded(live, ev, contactAfterDial);
    } finally {
      if (!settled?.handedToWrapup) {
        // A wrap-up redial owes the conversation's outcome whatever its own (unless the
        // catalog changed underneath it): never to the pool from here.
        if (cmd.redial && (settled?.needsDisposition ?? true)) await this.releaseOwingOutcome(cmd.sessionId);
        else await this.releaseAgent(cmd.sessionId);
      }
    }
    if (contactAfterDial) await this.settleContactAfterDial(live, settled);
  }

  /**
   * The contact of an attempt the `ended` arm settled while its dial was in flight, once
   * the dial has returned: held back and charged to the our-fault ledger when the dial
   * failed outcome-unknown (`holdOutcomeUnknownContact`, the dial failure path's rule),
   * else routed as the `ended` arm routes any contact (`settleContact`). A row that could
   * not be written goes to the reaper, told whether the dial's outcome is unknown.
   */
  private async settleContactAfterDial(live: LiveAttempt, settled: EndedSettlement | null): Promise<void> {
    const cmd = live.cmd;
    const dialOutcomeUnknown = await live.dialSettled;
    // `settleEnded` threw before it had classified anything: the contact stays
    // `in_flight` behind the attempt, for the reaper's sweeps.
    if (!settled) return;
    if (!settled.rowEnded) {
      this.noteUnrecordedEnd(cmd.attemptId, dialOutcomeUnknown);
      return;
    }
    if (dialOutcomeUnknown && !cmd.redial) {
      log.warn(
        { attemptId: cmd.attemptId, contactId: cmd.contactId, outcome: settled.outcome },
        'Dial ended while its outcome was unknown — holding the contact back',
      );
      await holdOutcomeUnknownContact(cmd, settled.outcome);
      return;
    }
    // A wrap-up redial's dial answered with a KNOWN outcome: the wrap-up it reopened
    // (with no redial offered while that answer was pending) offers the redials its
    // number leaves. Outcome-unknown keeps the offer withdrawn: the carrier may still
    // ring the customer, and the agent must not place a second call to them.
    if (cmd.redial && !dialOutcomeUnknown && settled.handedToWrapup) {
      this.wrapup.setRedialRemaining(
        cmd.sessionId, cmd.attemptId,
        wrapupRedialRemaining(cmd.campaign, settled.needsDisposition, cmd.redial.number),
      );
    }
    try {
      await settleContact(cmd, settled.outcome, settled.needsDisposition, live.bridgedAt);
    } catch (err) {
      log.error(
        { err, attemptId: cmd.attemptId, contactId: cmd.contactId, outcome: settled.outcome },
        'Could not settle the contact of an ended attempt — the reaper requeues a stranded contact',
      );
    }
  }

  /**
   * Classify the ended attempt, record it, and tell the agent. `handedToWrapup` is true
   * when wrap-up took the agent (so `onEnded` must not release them).
   *
   * `contactAfterDial`: the dial is still in flight, so the contact is left to
   * {@link settleContactAfterDial} (and so is reporting an unwritten row to the reaper,
   * which needs the dial's answer too).
   */
  private async settleEnded(
    live: LiveAttempt,
    ev: WebRtcLifecycleEvent,
    contactAfterDial: boolean,
  ): Promise<EndedSettlement> {
    const cmd = live.cmd;
    // ── `bridged` means BRIDGED, from the bridge's own stamp ─────────────────
    //
    // One local, read by the classifier and by the log line below, and its source
    // is `live.bridgedAt` — written by the `bridged` arm above and by nothing
    // else. Two other spellings are wrong in ways that cannot be seen from here:
    //
    //  - `bridged: ev.answered`, i.e. the CARRIER's pickup, labels a cancelled
    //    ring `abandoned` and an answered-but-unbridged call `connected` (the
    //    ring-cancel shape). See `classifyAttemptOutcome`'s header for both, and
    //    for why `answered` and `bridged` are two parameters that a caller cannot
    //    satisfy with one fact.
    //  - this local was `ev.answered && (ev.talkTimeSeconds ?? 0) >= 0 &&
    //    ev.status === 'completed'`, in which the middle clause is **vacuous** —
    //    `?? 0` makes it `>= 0` against a non-negative number, so it is always
    //    true and reads as a duration check that checks nothing. It only ever
    //    fed the log field, so it misled a reader in Loki rather than the code,
    //    which is why it survived: nothing downstream could go red on it.
    //
    // `live.bridgedAt` is in-process, and that is exact here for the same reason
    // the abandonment counter below relies on it: this handler returned early
    // unless `liveByAttempt` held the attempt, so we are by construction the
    // replica that observed every phase of it.
    const bridged = live.bridgedAt !== null;
    const outcome = classifyAttemptOutcome({
      status: ev.status ?? 'failed',
      outcome: ev.outcome,
      errorCode: ev.errorCode,
      errorMessage: ev.errorMessage,
      answered: ev.answered,
      bridged,
    });

    /**
     * ── The abandonment question, asked ONCE ────────────────────────────────
     *
     * Asked before the row write so the reason lands in the SAME statement as the
     * outcome. Two statements would mean a row that says `abandoned` with no
     * reason for as long as the second one takes, and a crash between them would
     * leave that permanently — on the row the compliance window reads.
     *
     * The predicate call is unchanged and still the only definition. `abandoned`
     * is now a local because it is read twice; it was previously inlined into the
     * `if` below, and duplicating the call would have been two evaluations of a
     * predicate over mutable in-process state.
     */
    const abandoned = isAbandonedAttempt({
      answeredAt: live.answeredAt,
      bridgedAt: live.bridgedAt,
      outcome,
    });
    /**
     * ⚠️ **The residual is `unattributed`, NOT `no_agent_available`** (corrected
     * on the second review pass, and this was a real defect rather than a wording
     * nit).
     *
     * An abandoned attempt WITH a bridge timestamp beat the grace, which we did
     * observe — `bridge_late`. One without it, where no arm above claimed a
     * cause, is a call we abandoned for a reason we did not see: the customer
     * answered, the station was fine, and media never came up. Reporting that as
     * `no_agent_available` asserted a *pacing* cause for what is a bridge or
     * media failure, and it did so for the whole default path — the exact
     * mislabel the arm above now prevents, reintroduced at the fallback.
     *
     * Asserting a cause we did not observe is worse than admitting we did not,
     * because the label is what an operator acts on. `no_agent_available` is
     * therefore reachable from nowhere in this file, which is correct: nothing in
     * a strictly 1:1 pacing engine can dial with nobody free (see the union).
     */
    const abandonReason: AgencyAbandonReason | null = abandoned
      ? (live.abandonReason ?? (live.bridgedAt !== null ? 'bridge_late' : 'unattributed'))
      : null;

    // ── Contact release ─────────────────────────────────────────────────────
    // `connected` still parks the contact awaiting the agent's write-up: the precedence rule gives
    // a disposition precedence over the outcome policy, so evaluating the outcome
    // policy now would decide a question the disposition is entitled to answer. The
    // wrap-up route settles it, and the reaper's `no_disposition` auto-close is the
    // backstop that routes it back here.
    //
    // Everything else has no disposition coming, so the outcome policy decides —
    // which means a real retry, not a flat `completed`.
    //
    // ── Parked in `connected` FOREVER when none is owed ─────────────────────
    // Computed here, so ONE function
    // answers "is a disposition owed" for both the contact's fate and the
    // `released` frame's `requires_disposition`. Two readings of that question is
    // how a route that demands a write-up and a console told none is needed end up
    // in the same build.
    //
    // The hazard: `connected` parks the contact awaiting an agent's write-up, and
    // the ONLY things that release it are the disposition route and the reaper's
    // `no_disposition` sweep. On a campaign with an empty `disposition_catalog` —
    // a LEGITIMATE configuration meaning "outcome-driven retry, no human write-up
    // step" — no disposition is owed, none is ever submitted, and the contact would
    // sit in `connected` until the reaper eventually auto-closed it. So when none
    // is owed, the outcome policy decides now.
    //
    // Note the else-branch already produces the right answer without a special
    // case: `connected`'s default policy is `max_attempts: 0`, so it resolves to
    // `completed` with reason `outcome_not_retryable`. Only the CONDITION moved.
    //
    // ⚠️ This gate is HALF the fix and does not stand alone. The `bridged` handler
    // above parks the contact in `connected` while the call is live, and its write
    // can land after this one — see the note at that site. Both ask the same
    // function; removing either one puts the contact back in `connected` forever.
    //
    // ── A wrap-up redial owes the CONVERSATION's outcome, whatever its own ──
    // The redial continues a call that connected (its predecessor closed `redialed`), so
    // the write-up owed is that conversation's: asked as `connected`. A redial that rang
    // out still owes it, and the agent writes it up on this attempt.
    const needsDisposition = requiresDisposition(cmd.redial ? 'connected' : outcome, cmd.campaign.disposition_catalog);

    // A failed write must not cost the agent their `released` frame or their
    // release: the classification above is in hand and the frame needs nothing
    // from the database. What each failure leaves behind is different, so the two
    // writes are caught separately.
    //
    // The row write failing leaves the attempt non-terminal. Nothing after it may
    // write the attempt or the contact: wrap-up would move the row to `ended` with
    // no outcome (which every sweep then skips), and a disposition or a contact
    // settlement would route a contact the reaper is about to requeue. The id goes
    // to the reaper, which ends the row `orphaned` and requeues the contact on the
    // our-fault ledger, as it does for any attempt it finds leaked.
    let rowEnded = true;
    try {
      await this.recordEndedAttempt(live, ev, { outcome, abandoned, abandonReason });
    } catch (err) {
      rowEnded = false;
      // The bridge saw this call end. Only a dial that failed with an unknown outcome
      // may still be placed by the carrier. (A backstop: that end, emitted while the dial
      // is in flight, is left to the dial's failure path above and never reaches here.)
      if (!contactAfterDial) this.noteUnrecordedEnd(cmd.attemptId, ev.errorCode === DIAL_OUTCOME_UNKNOWN_ERROR_CODE);
      log.error(
        { err, attemptId: cmd.attemptId, outcome },
        'Could not record the ended attempt — releasing the agent without wrap-up; the reaper ends the row and requeues the contact',
      );
    }
    // The contact write failing leaves the contact `in_flight` behind a terminal
    // attempt, which no attempt sweep can see; the reaper's stranded-contact sweep
    // requeues it. (A contact parked `connected` at the bridge keeps its wrap-up,
    // and the disposition route or the lapsed-wrap-up sweep releases it.)
    if (rowEnded && !contactAfterDial) {
      try {
        // Which ledger pays for this attempt and what the retry policy does with
        // the contact — `dialer/contact-settlement.ts`.
        await settleContact(cmd, outcome, needsDisposition, live.bridgedAt);
      } catch (err) {
        log.error(
          { err, attemptId: cmd.attemptId, contactId: cmd.contactId, outcome },
          'Could not settle the contact of an ended attempt — the reaper requeues a stranded contact',
        );
      }
    }
    // No row, no wrap-up, so no disposition can be taken for this attempt.
    const dispositionOwed = rowEnded && needsDisposition;

    /**
     * **Both** vocabularies, because there are two agent-initiated hang-ups and
     * they arrive under different names. The browser leg closing yields
     * `ended_by_user`; the HTTP hang-up route calls
     * `forceEndWithOutcome(attemptId, 'agent_hangup')`, which reaches this handler
     * as `ev.outcome === 'agent_hangup'`. Matching only the first would classify the
     * *supported* hang-up API as an ordinary `completed` release, so the agent
     * would press hang up and be told the call had simply ended —
     * `releaseMessageFor` never reaching "You ended the call."
     */
    const agentHungUp = ev.outcome === 'ended_by_user' || ev.outcome === 'agent_hangup';
    const reason = releaseReasonFor(outcome, { agentHungUp });
    const message = releaseMessageFor(reason);
    // ── An agent who was never shown this call is told NOTHING about it ───────
    //
    // Late binding only. This is the frame the whole change exists to remove: a
    // dial that rang out, was busy, failed or found an unreachable handset
    // produced a `released` — "Nobody answered." — for a panel that was never on
    // the console's screen, which is the ringing popup agents dismiss. There is
    // nothing to explain, because nothing
    // was announced.
    //
    // The missed-release record goes with it, and for a stronger reason: it is
    // replayed on the `ready` frame of the agent's NEXT connect, so a held
    // release for an unannounced attempt would surface a popup about an
    // unremembered call minutes later, on a fresh session — the same defect with a
    // delay on it.
    //
    // Everything else in this handler is unchanged and deliberately so: the row is
    // still settled, the contact still routed by the retry policy, the outcome
    // still classified, the compliance counters still incremented, and
    // `releaseAgent` below still returns the agent to the pool. Only the two
    // agent-facing announcements are suppressed.
    if (!isUnannounced(live)) {
      const delivered = this.sendReleased(cmd, reason, dispositionOwed, message);
      // The agent whose socket dropped is exactly the agent this frame explains the
      // most to, and exactly the one who cannot receive it. Hold it for their
      // reconnect rather than letting the console come back to an empty panel with
      // no account of the call they were just on.
      if (!delivered) {
        this.holdMissedRelease(cmd.sessionId, {
          attempt_id: cmd.attemptId,
          reason,
          requires_disposition: dispositionOwed,
          message,
          ended_at: new Date().toISOString(),
        });
      }
    }

    // `lateBinding`/`announced` are on the line because they are the only record
    // that a `released` was deliberately withheld — the suppression above is
    // otherwise invisible, and "the agent says the call vanished with no message"
    // is exactly the support question it produces.
    log.info(
      {
        attemptId: cmd.attemptId, outcome, reason, bridged,
        lateBinding: live.lateBinding, announced: !isUnannounced(live),
      },
      'Agency attempt ended',
    );

    // ── Wrap-up, or straight back to the pool. ──────────────────────────────
    // Only a conversation earns a wrap-up: `on_call` is reachable only through a
    // bridge, so an attempt that rang out never entered it and has nothing to write
    // up. Handing those agents a countdown would take the pool offline for
    // `wrapup_seconds` after every no-answer, which at power-dialing rates is most
    // of the shift.
    // A wrap-up redial earns one whatever its outcome when an outcome is owed: the
    // agent is back on the wrap-up screen with the same two choices (save, or redial
    // while redials are left).
    const earnsWrapup = outcome === 'connected' || (!!cmd.redial && needsDisposition);
    if (rowEnded && this.stations.isLocallyOwned(cmd.sessionId) && earnsWrapup) {
      const entered = await this.wrapup.enter({
        sessionId: cmd.sessionId,
        attemptId: cmd.attemptId,
        campaignId: cmd.campaignId,
        tenantId: cmd.tenantId,
        wrapupSeconds: cmd.campaign.wrapup_seconds,
        autoReturn: cmd.campaign.wrapup_auto_return,
        requiresDisposition: needsDisposition,
        // PEEKED, not taken — `releaseAgent` below is the single place a queued
        // break is consumed, and taking it here would apply it
        // to nothing and drop the agent's break silently. This only lets the
        // wrap-up state frame carry "break pending" through a window in which it
        // is the console's sole transition announcement.
        //
        // A closure rather than a peeked value: `enter` awaits several Redis and DB
        // writes before it can send that frame, and a break queued or cancelled
        // inside that window emits its own `agent_state`. Handing over the value
        // meant this frame arrived afterwards carrying a pre-window snapshot and
        // won — clearing a live badge, or resurrecting a cancelled one. The
        // registry still never leaves this class, so the `take()` hazard the value
        // form existed to avoid is unchanged.
        readPendingBreak: () => this.breaks.peek(cmd.sessionId),
        // A redial whose dial is still in flight (`contactAfterDial`: the end raced the
        // dial) may yet answer outcome-unknown, when the carrier may still ring the
        // customer: no further redial is offered until the dial's answer is in
        // (`settleContactAfterDial` restores the offer when it is known).
        redialRemaining: contactAfterDial && cmd.redial
          ? null
          : wrapupRedialRemaining(cmd.campaign, needsDisposition, cmd.redial?.number ?? 0),
      });
      // `false` ⇒ `wrapup_seconds = 0`, so the agent goes straight to `available`
      // Falling through is that path.
      if (entered) return { handedToWrapup: true, rowEnded, outcome, needsDisposition };
    }

    return { handedToWrapup: false, rowEnded, outcome, needsDisposition };
  }

  /**
   * The attempt half of the `ended` arm: the attempt row, and the seat-time and
   * abandonment series that follow it. The contact's fate is written after it, by
   * {@link settleEnded}.
   */
  private async recordEndedAttempt(
    live: LiveAttempt,
    ev: WebRtcLifecycleEvent,
    settled: {
      outcome: AgencyAttemptOutcome;
      abandoned: boolean;
      abandonReason: AgencyAbandonReason | null;
    },
  ): Promise<void> {
    const cmd = live.cmd;
    const { outcome, abandoned, abandonReason } = settled;
    await agencyAttemptRepository.setState(cmd.attemptId, 'ended', {
      outcome,
      ended_at: new Date(),
      talk_seconds: ev.talkTimeSeconds,
      // Only on an abandoned attempt: NULL in this column means "not abandoned",
      // and `COALESCE` in `setState` would keep a stale value rather than clear
      // it, so writing it unconditionally would be writing a claim.
      ...(abandonReason ? { abandon_reason: abandonReason } : {}),
    });

    /**
     * Seat time for this attempt, attributed to the outcome that consumed it.
     *
     * The single number every pacing argument needed and none of them had. The
     * `outcome` split is the whole value: if the largest block of dead time is
     * busy signals, a busy phone never rings — so an aggregate "average
     * wait" would have pointed at a ring timeout that could not have touched it.
     *
     * Measured dial → attempt settle. ⚠️ **So `connected` here is ring + talk,
     * not talk** — `dialedAt` is stamped before the carrier is called, so a 25s
     * ring and a 40s conversation land as one 65s observation. An earlier version
     * of this comment said "talk time and NOT waste", which is wrong in the
     * direction that matters: part of it IS waste, and the part that is sits in
     * `agency_answer_latency_seconds`. Subtract that to get conversation.
     * Wrap-up is deliberately a separate series, because folding it in would make
     * the one bucket an operator must not try to shrink look like the biggest
     * opportunity on the chart.
     *
     * Not measured to the agent's RELEASE, which is a later and — for a connected
     * call — a wrap-up away. The contact-policy writes and `releaseAgent` below
     * are therefore real seat time counted by neither series; see the note on the
     * metric for why that residual is left explicit rather than folded in here.
     */
    const holdSeconds = elapsedSeconds(live.dialedAt);
    // No `campaign_id` on the histogram (series cost) — see metrics.ts.
    agencyAttemptHoldSeconds.observe({ tenant_id: cmd.tenantId, outcome }, holdSeconds);

    // The compliance NUMERATOR. Incremented AFTER the row write, so
    // the counter means "attempts we believe are recorded abandoned" — which is
    // what makes the counter-versus-table cross-check able to find a write that silently did not
    // take. Incrementing before the write would make the two agree by
    // construction, and a cross-check that cannot disagree is not a check.
    //
    // ── Keyed on the PREDICATE, not on `outcome` (decided) ──────────────────
    // `outcome === 'abandoned'` is the classifier's LABEL, and it is stamped only
    // by `abandonAnsweredCall` — i.e. only when no live station owned the agent at
    // answer time. Every answered-but-never-bridged call that ended for some other
    // reason was abandoned by the ratified definition and invisible here. The table
    // is the definition, so the counter asks the table's question.
    //
    // **The `outcome` write above is deliberately untouched.** Only this condition
    // moved. Widening the outcome instead would relabel a dropped-socket call
    // `abandoned`, which changes the retry the contact gets AND tells the agent
    // their own connection failure "could not be connected to you".
    //
    // `live.bridgedAt`/`live.answeredAt` are in-process, and that is sound rather
    // than merely tolerable on one replica: this handler returns early unless
    // `liveByAttempt` holds the attempt, so we are by construction the replica that
    // observed both phases for it. What in-process state cannot cover is an attempt
    // settled with no live record at all — the reaper's post-crash sweep — which no
    // process-local counter can, and which is why the audited compliance number is
    // the SQL window gauge.
    if (abandoned) {
      agencyAbandonedTotal.inc({ tenant_id: cmd.tenantId, campaign_id: cmd.campaignId });
      // ⚠️ A SEPARATE series, not a `reason` label on the two counters above.
      // Labelling a live series terminates it, and those two are the compliance
      // numerator and denominator that the cross-check and the auto-pause
      // guardrail both read. A diagnostic split does not earn that migration, so
      // it rides alongside and `sum(rate(...))` of the two should track.
      if (abandonReason) {
        agencyAbandonedReasonTotal.inc({
          tenant_id: cmd.tenantId, campaign_id: cmd.campaignId, reason: abandonReason,
        });
      }
    }
  }

  /**
   * Return an agent to the pool, if their socket is still live.
   *
   * **This is the single place a queued break is applied**: an
   * agent who asked for a break mid-call goes to `break` here rather than
   * `available`, at the end of wrap-up, without their conversation having been
   * interrupted. Doing it here and nowhere else is what makes "queued" mean one
   * thing — every route into the pool, whether the agent had a wrap-up, skipped
   * one, or had one forced, passes through this method.
   *
   * Returns what it did: the state written and the write's {@link AgentSetResult}.
   * `manual_call_live` / `softphone_session` mean the soft phone's guard refused
   * `available` and NOTHING moved; the supervisor's force-available answers that
   * as a 409 rather than claiming the agent is back. The settle paths ignore it.
   */
  async releaseAgent(sessionId: string): Promise<AgentReleaseResult> {
    // ── NOT purely replica-local, contrary to an earlier version of this note ──
    //
    // On the settle path this does run on the bridging replica, and there the
    // in-process map is the right authority. But `releaseAgent` also has a
    // LOAD-BALANCED HTTP caller: `POST /sessions/:id/force-available`
    // (`agency.routes.ts`), where `wrapup.force` — another in-process Map — returns
    // false on a non-owning replica and falls through to here. On that path
    // `isLocallyOwned` is false for an agent who is perfectly fine, and the branch
    // below drives them `offline`: a supervisor pressing force-available knocks the
    // agent off the floor.
    //
    // Unreachable on one replica, which is the only supported deployment today, so
    // this is left as-is and recorded rather than fixed — the fix belongs with the
    // rest of the multi-replica work (making wrap-up and breaks cross-replica), not
    // bolted onto this line. An earlier annotation here asserted the site was
    // audited and replica-local, which was false for exactly the caller that
    // matters and made the site look safer than it is.
    const stillHere = this.stations.isLocallyOwned(sessionId);
    // An agent whose socket is gone must NOT return to `available` — the tick
    // would dial into them immediately and produce an abandoned call. A pending
    // break for a departed agent is dropped with them; `offline` already keeps them
    // out of the pool, and they rehydrate into `break` anyway.
    if (!stillHere) {
      this.breaks.cancel(sessionId);
      const set = await this.agents.set(sessionId, 'offline', { leaseMs: AGENT_LEASE_MS.available });
      await mirrored(agencyAgentSessionRepository.setState(sessionId, 'offline'), sessionId, 'Could not mirror released agent state');
      return { state: 'offline', result: set };
    }

    // Consumed, not peeked: a queued break applies exactly once, so an agent who
    // takes a break and later goes available is not silently pulled back out of the
    // pool on their next call's release.
    const queuedBreak = this.breaks.take(sessionId);
    const state = queuedBreak ? 'break' : 'available';
    const since = new Date();
    // A queued switch to the soft phone applying now is audited (SP7), with the state
    // it applied from; read only for that rare case.
    const switchFrom = queuedBreak?.code === SOFTPHONE_BREAK_REASON
      ? (await Promise.resolve().then(() => this.agents.get(sessionId)).catch(() => null))?.state ?? null
      : null;

    const set = await this.agents.set(sessionId, state, {
      leaseMs: queuedBreak ? AGENT_LEASE_MS.break : AGENT_LEASE_MS.available,
    });
    // The soft phone's guard (docs/softphone.md §4.1): `available` is refused while
    // the session holds a soft-phone call or is a soft-phone session. The agent
    // stays on their `soft_phone` break, so nothing is mirrored and no frame claims
    // a move that did not happen (a supervisor's force-available reaches here).
    if (set === 'manual_call_live' || set === 'softphone_session') {
      log.info({ sessionId, refused: set }, 'Release to available refused — the session is on the soft phone');
      return { state, result: set };
    }
    await mirrored(
      agencyAgentSessionRepository.setState(sessionId, state, queuedBreak?.code ?? null),
      sessionId, 'Could not mirror released agent state',
    );

    this.stations.send(sessionId, {
      event: 'agent_state',
      state,
      since: since.toISOString(),
      ...(queuedBreak ? { break_reason: queuedBreak.code } : {}),
    });
    if (queuedBreak) {
      log.info({ sessionId, reason: queuedBreak.code }, 'Queued break applied after wrap-up');
    }
    if (queuedBreak?.code === SOFTPHONE_BREAK_REASON && set === 'ok') {
      await this.auditQueuedSwitchApplied(sessionId, switchFrom);
    }
    return { state, result: set };
  }

  /**
   * `agency_session.softphone_started` with `queued: true, applied: true` for a switch
   * the agent queued and this release just applied: the request was audited when it
   * was made; this is the instant they actually moved. The `system` actor, because
   * nothing was pressed now. Best-effort: a session row that cannot be read costs the
   * row, never the release.
   */
  private async auditQueuedSwitchApplied(sessionId: string, fromState: AgencyAgentState | null): Promise<void> {
    const session = await Promise.resolve().then(() => agencyAgentSessionRepository.findById(sessionId)).catch((err) => {
      log.warn({ err, sessionId }, 'Could not read the session to audit an applied soft-phone switch');
      return null;
    });
    if (!session || !isCampaignSession(session)) return;
    auditSoftphoneStarted({
      tenantId: session.tenant_id,
      accountId: session.account_id,
      sessionId,
      campaignId: session.campaign_id,
      actor: SYSTEM_AUDIT_ACTOR,
      fromState,
      queued: true,
      applied: true,
    });
  }

  /**
   * A customer answered and there is no agent.
   *
   * **Why this fires even inside a deferred-hangup window, which looks like a
   * conflict with the deferred hangup and is not.** The two mechanisms cover different
   * moments. The grace window exists to preserve a *conversation already in
   * progress* — the customer has been talking to someone, so 8s of silence is
   * worth trading for the chance to resume. Here nothing has been said yet:
   * there is no conversation to preserve, so waiting buys the customer nothing
   * and costs them up to 8s of silence before the same apology. Answering with
   * an apology now is the honest outcome, and it keeps the abandonment metric
   * measuring what regulators mean by it rather than under-counting the cases
   * where an agent happened to come back.
   *
   * The attempt's terminal write is NOT done here — `localHangup` produces the
   * bridge's `ended` event and the ordinary lifecycle handler classifies it, so
   * there is exactly one place an attempt is settled. Writing it here as well
   * would race that handler for the same row.
   */
  private async abandonAnsweredCall(live: LiveAttempt): Promise<void> {
    const { cmd } = live;
    log.warn(
      { attemptId: cmd.attemptId, sessionId: cmd.sessionId, campaignId: cmd.campaignId },
      'Carrier answered with no live reserved station — abandoning',
    );
    live.abandoned = true;

    // Scoped against the CAMPAIGN's own tenancy, not the dial command's. They are
    // the same by construction, but the campaign row is what holds the reference,
    // so it is the authority on whose announcement the reference is allowed to be.
    const clip = await resolveAbandonClip(cmd.campaign.abandon_announcement_id, {
      tenantId: cmd.campaign.tenant_id,
      accountId: cmd.campaign.account_id,
    });
    if (clip.hash) {
      const played = await this.bridge.playClipToCarrierThenHangUp(cmd.attemptId, {
        clipHash: clip.hash,
        outcome: 'abandoned',
      });
      if (played) return;
      log.warn({ attemptId: cmd.attemptId }, 'Abandon clip could not be played — hanging up bare');
    }

    // No clip, or it could not reach the carrier. Hang up anyway: an open line
    // with nobody on it is worse than a short one, and the attempt is still
    // recorded `abandoned` by the lifecycle handler either way.
    await this.bridge.forceEndWithOutcome(cmd.attemptId, 'abandoned');
  }

  // ─── Presence resilience ──────────────────────────────────────────────────

  /**
   * Is this replica still driving an attempt for this agent?
   *
   * The station socket's `close` handler asks before writing the agent `offline`.
   * A socket that drops mid-call has NOT ended the agent's call — the deferred
   * hangup owns that decision now, and the agent is `on_call` with a lease this
   * replica is still renewing. Writing `offline` over it would clear the attempt
   * binding, fail the renewer's state-matched CAS, and lapse the lease that is the
   * only thing keeping a second attempt off this agent.
   */
  hasLiveAttempt(sessionId: string): boolean {
    return this.attemptIdFor(sessionId) !== null;
  }

  /**
   * Is this agent's live attempt one they have not been shown — a dial in flight
   * under late binding, still ringing, with no panel on their console?
   *
   * Exists for one caller, `POST /sessions/:id/leave`, and only to decide the
   * WORDING of a refusal. The refusal itself is {@link hasLiveAttempt}'s and does
   * not change: see the route for why leaving is still refused even though the
   * agent can see no call, and for the alternative that was not taken.
   *
   * `false` for "no live attempt at all" as well as for "a call they are on", so
   * a caller must ask {@link hasLiveAttempt} first. Folding the two into one
   * tri-state would put the leave route's whole decision in a method whose name
   * describes half of it.
   */
  hasUnannouncedAttempt(sessionId: string): boolean {
    const attemptId = this.attemptIdFor(sessionId);
    if (!attemptId) return false;
    return isUnannounced(this.liveByAttempt.get(attemptId)!);
  }

  /**
   * Every attempt this replica is currently driving — the reaper's first
   * exclusion arm.
   *
   * **This is the authoritative "alive" set, and it is deliberately not derived
   * from the bridge.** An entry is written before the dial is placed and deleted
   * only when the attempt settles, so it covers `dialing` through `bridged` *and*
   * the whole deferred-hangup window — during which the agent's
   * socket is gone and the carrier leg is live, so a bridge session lookup or any
   * "is a browser leg attached" test would call the call bridgeless and the reaper
   * would hang up on a customer who is about to get their agent back.
   *
   * A copy, not the live keys: a caller iterating this while an attempt settles
   * must not have the set mutate underneath it.
   */
  activeAttemptIds(): string[] {
    return [...this.liveByAttempt.keys()];
  }

  /**
   * Attempts this replica stopped driving without writing them `ended` — the
   * reaper's input for rows no ownership question can clear (see
   * {@link unrecordedEnds}). A copy, for the same reason as
   * {@link activeAttemptIds}.
   */
  unrecordedEndedAttempts(): UnrecordedEnd[] {
    return [...this.unrecordedEnds].map(([attemptId, dialOutcomeUnknown]) => ({ attemptId, dialOutcomeUnknown }));
  }

  /**
   * Hand an attempt whose `ended` write failed to the reaper. An outcome-unknown dial
   * ends on two paths (the bridge's `ended` event and the dial's own rejection), so either
   * saying "unknown" keeps it unknown.
   */
  private noteUnrecordedEnd(attemptId: string, dialOutcomeUnknown: boolean): void {
    this.unrecordedEnds.set(attemptId, dialOutcomeUnknown || (this.unrecordedEnds.get(attemptId) ?? false));
  }

  /** The reaper ended these (or found them already terminal): stop reporting them. */
  forgetUnrecordedEnds(attemptIds: readonly string[]): void {
    for (const id of attemptIds) this.unrecordedEnds.delete(id);
  }

  /**
   * The station socket for this session has closed. Arms the pre-bind grace when
   * the session is holding an attempt the agent was never told about.
   *
   * A no-op in every other case — an announced attempt has a bound browser leg and
   * the bridge's own deferred hangup owns it, which is the arrangement
   * `releaseStationOnClose` is written against. See {@link unboundStationGrace}.
   */
  noteStationClosed(sessionId: string): void {
    if (!this.hasUnannouncedAttempt(sessionId)) return;
    // Idempotent by NOT re-arming, deliberately. Two callers observe the same
    // loss — the station socket's `close` handler and `sweepSilentStations`, which
    // is the only thing that sees a socket that died without a close frame — and
    // re-arming on the second would slide the deadline forward, which is the one
    // behaviour a window meant to BOUND the wait must not have.
    if (this.unboundStationGrace.has(sessionId)) return;
    const timer = setTimeout(() => {
      this.unboundStationGrace.delete(sessionId);
      // Re-asked at fire time, not trusted from arm time: the agent may have
      // reconnected (in which case `attach` cancelled this timer, but a race is
      // cheap to rule out), the dial may have been answered and bound, or the
      // attempt may have settled on its own.
      const attemptId = this.attemptIdFor(sessionId);
      if (!attemptId || !this.hasUnannouncedAttempt(sessionId)) return;
      log.warn(
        { sessionId, attemptId },
        'Station stayed gone through the pre-bind grace — ending the unannounced dial as agent_disconnected, so a carrier answer cannot become an abandoned call',
      );
      // `agent_disconnected` is the outcome BOTH dial paths declare for a lost
      // browser leg (`browserHangupOutcome`), so the two binding modes record the
      // same fact. The attempt outcome is `agent_disconnected` too — that arm
      // short-circuits ahead of the status switch, so this does NOT become
      // `canceled`, and an earlier draft of this comment said it did. Either way
      // it is on the our-fault ledger (`ourFaultBeforeBridge` names both) and
      // never `abandoned`, which is the property that matters here; reporting the
      // dropped station rather than "we cancelled" is also the truer explanation
      // for the supervisor.
      void this.bridge.forceEndWithOutcome(attemptId, 'agent_disconnected')
        .catch((err) => log.error({ err, attemptId }, 'Could not end unannounced dial after station loss'));
    }, DEFERRED_HANGUP_MS);
    timer.unref?.();
    this.unboundStationGrace.set(sessionId, timer);
  }

  /**
   * Drop an attempt this replica no longer drives: its live record, its lease
   * renewer and — paired with the renewer — any pre-bind grace armed against it,
   * which has nothing left to end and must not outlive it into the next dial.
   */
  private forgetAttempt(cmd: DialCommand): void {
    this.liveByAttempt.delete(cmd.attemptId);
    this.stopLeaseRenewal(cmd.attemptId);
    this.clearUnboundStationGrace(cmd.sessionId);
  }

  /** Disarm the pre-bind grace — the station came back, or the attempt settled. */
  private clearUnboundStationGrace(sessionId: string): void {
    const timer = this.unboundStationGrace.get(sessionId);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.unboundStationGrace.delete(sessionId);
  }

  /**
   * The agent hangs up the call they are on.
   *
   * Returns `false` when this replica holds no live attempt by that id — which is
   * the honest answer for **both** "the call already ended" and "another replica
   * is bridging it", and the caller distinguishes them from the attempt row. It
   * deliberately does not guess: the bridge session is in-process memory,
   * so a `true` from somewhere that does not hold it would be a fabrication.
   *
   * `agent_hangup` rather than a generic outcome because the outcome vocabulary is
   * what the retry policy keys on: an agent ending a conversation is a completed
   * call, not a failure to reach anybody, and classifying it as the latter would
   * feed the contact straight back into the roster for a redial.
   *
   * ── Why an HTTP route, given the contract describes a socket frame ─────────
   * The station socket carries exactly two `message` listeners for the duration
   * of an attempt — the borrowed-leg listener via `registerBrowserLegHandlers`
   * (`webrtc-bridge-manager.ts`), which acts only on `event === 'media'`, and the
   * station socket's own (`station-socket.ts`), which acts only on
   * `event === 'ping'`. **A `hangup` frame is handled by neither**, so the
   * hang-up is `POST /agency/attempts/:id/hangup`.
   */
  async hangupAttempt(attemptId: string): Promise<boolean> {
    if (!this.liveByAttempt.has(attemptId)) return false;
    // Correlation id IS the attempt id here — the same key `executeDial` registers
    // and `onBridgeLifecycle` correlates on.
    return this.bridge.forceEndWithOutcome(attemptId, 'agent_hangup');
  }

  /**
   * Re-attach a reconnecting station socket to the attempt it dropped out of.
   *
   * Returns the resumed attempt when the drop landed inside the deferred-hangup
   * window, `null` when there was nothing live to resume — which is the honest
   * answer both when the window lapsed and when the agent simply had no call.
   * The caller renders the difference from {@link takeMissedRelease}.
   */
  reattachStation(sessionId: string, ws: WebSocket): AgencyActiveAttempt | null {
    // Reached on EVERY station attach, so it is the reconnect hook for the pre-bind
    // grace — disarmed before the `!attemptId` return below, because a session
    // whose attempt settled while the socket was away still has a timer to drop.
    this.clearUnboundStationGrace(sessionId);
    const attemptId = this.attemptIdFor(sessionId);
    if (!attemptId) return null;
    const live = this.liveByAttempt.get(attemptId)!;

    // ── An unannounced attempt has NOTHING to resume onto ────────────────────
    //
    // Late binding only, and the guard is the reconnect-shaped door into the
    // popup this change removes. Without it a socket that reconnects mid-ring is
    // handed an `AgencyActiveAttempt` with `state: 'dialing'` and
    // `bridged_at: null`, and the console renders exactly the ringing panel late
    // binding exists to suppress — from the resume path rather than the dial one.
    //
    // Returning `null` loses the agent nothing, which is the part worth stating
    // plainly: the attempt needs no resumption because it was never bound. The
    // `answered` arm reads `stations.socketFor(sessionId)` FRESH at the carrier
    // answer, so it binds to whatever socket the registry holds by then — the
    // reconnecting one included. All a mid-ring reconnect has to do is be
    // registered before the answer, and `attach` has already done that by the time
    // this runs.
    //
    // Checked here rather than relying on `reattachBorrowedBrowserLeg`'s own
    // never-been-bound refusal, which would also return false: that refusal logs
    // at WARN, and under late binding this is an ORDINARY event (every mid-ring
    // wifi blip on the cohort), so leaning on it would fill Loki with warnings
    // about correct behaviour.
    if (isUnannounced(live)) {
      log.info(
        { sessionId, attemptId, state: live.state },
        'Station reconnected during an unbound dial — nothing to resume; it binds at the answer',
      );
      return null;
    }

    // The bridge is the authority on whether the call is still there: its window
    // may have lapsed a millisecond ago, in which case the `ended` lifecycle event
    // is already in flight and re-adopting would resume media onto a dead call.
    if (!this.bridge.reattachBorrowedBrowserLeg(attemptId, ws)) return null;

    log.info({ sessionId, attemptId, state: live.state }, 'Station reconnected onto a live attempt');
    // The panel built at dial time, plus where the call has got to: a resumed
    // panel is identical to the one the agent was shown.
    return {
      ...live.panel,
      bridged_at: live.bridgedAt ? live.bridgedAt.toISOString() : null,
      state: live.state,
    };
  }

  /** The `released` frame that clears the agent's panel. False when it did not reach the socket. */
  private sendReleased(
    cmd: DialCommand,
    reason: AgencyReleaseReason,
    requiresDisposition: boolean,
    message: string,
  ): boolean {
    return this.stations.send(cmd.sessionId, {
      event: 'released',
      attempt_id: cmd.attemptId,
      reason,
      requires_disposition: requiresDisposition,
      message,
    });
  }

  /**
   * Hold a `released` for this session's reconnect. Expired holds are dropped
   * here as well as on `takeMissedRelease`, because an agent who never comes back
   * never takes theirs: without this the map grew by one entry per such agent for
   * the life of the process.
   */
  private holdMissedRelease(sessionId: string, release: AgencyMissedRelease): void {
    const now = Date.now();
    for (const [id, held] of this.missedReleases) if (held.expiresAt <= now) this.missedReleases.delete(id);
    this.missedReleases.set(sessionId, { release, expiresAt: now + MISSED_RELEASE_TTL_MS });
  }

  /** The `released` this session missed while away, consumed exactly once. */
  takeMissedRelease(sessionId: string): AgencyMissedRelease | null {
    const held = this.missedReleases.get(sessionId);
    if (!held) return null;
    this.missedReleases.delete(sessionId);
    // Expired ⇒ treated as never held. An hours-old release surfacing on a fresh
    // shift's first frame is worse than not surfacing at all.
    return held.expiresAt > Date.now() ? held.release : null;
  }

  private attemptIdFor(sessionId: string): string | null {
    // A scan over the attempts this replica is driving — one per busy agent, tens
    // at most. A reverse index would be a third place to keep in step with the two
    // that mutate `liveByAttempt`, and a stale entry there would hand a reconnect
    // an attempt that has already settled.
    for (const [attemptId, live] of this.liveByAttempt) {
      if (live.cmd.sessionId === sessionId) return attemptId;
    }
    return null;
  }

  /**
   * Renew the agent's lease every 5s while we own the attempt.
   *
   * This is what makes the lease a liveness detector rather than a business timer:
   * as long as this process is alive and owns the attempt, the lease never lapses,
   * however long the call runs. If the process dies, renewal stops and the lease
   * expires — which is exactly the signal we want, and the only signal a TTL can
   * honestly give.
   */
  private startLeaseRenewal(attemptId: string, sessionId: string, state: 'reserved' | 'on_call'): void {
    this.stopLeaseRenewal(attemptId);
    const leaseMs = state === 'on_call' ? AGENT_LEASE_MS.on_call : AGENT_LEASE_MS.reserved_dialing;
    // Stops only on `lost` (Redis answered: the lease is gone or moved on). A failed renew
    // (`unknown`: a Redis error or command timeout) keeps the renewer going: the lease
    // outlives two missed renewals, and a single slow Redis reply must not let a live
    // call's lease lapse and free the agent for a second customer.
    const timer = setInterval(() => {
      void this.agents.renewLease(sessionId, state, leaseMs).then((result) => {
        if (result === 'lost') {
          log.warn({ attemptId, sessionId, state }, 'Agent lease renewal lost — stopping renewer');
          this.stopLeaseRenewal(attemptId);
        }
      });
    }, AGENT_LEASE_MS.renew_interval);
    // Never hold the event loop open for a renewer.
    timer.unref?.();
    this.leaseRenewers.set(attemptId, timer);
  }

  private stopLeaseRenewal(attemptId: string): void {
    const timer = this.leaseRenewers.get(attemptId);
    if (timer) {
      clearInterval(timer);
      this.leaseRenewers.delete(attemptId);
    }
  }
}
