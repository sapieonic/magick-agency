import type WebSocket from 'ws';
import { createChildLogger } from '@magick-agency/observability';
import { WebRtcCallError } from '../core/webrtc-bridge-manager.js';
import type { WebRtcBridgeManager, WebRtcLifecycleEvent } from '../core/webrtc-bridge-manager.js';
import {
  agencyAgentSessionRepository,
  agencyAttemptRepository,
  agencyContactRepository,
} from '../db/repositories/agency.repository.js';
import type { StationRegistry } from './station-registry.js';
import { AgentStateMachine, AGENT_LEASE_MS } from './agent-state-machine.js';
import type { DialCommand } from './dial-dispatcher.js';
import {
  classifyAttemptOutcome,
  releaseMessageFor,
  releaseReasonFor,
  requiresDisposition,
} from './outcome-classifier.js';
import type {
  AgencyActiveAttempt,
  AgencyAttemptState,
  AgencyMissedRelease,
  AgencyPriorAttempt,
  AgencyReleaseReason,
  AgencyReservedAttempt,
  AgencyAbandonReason,
} from '@magick-agency/contracts/agency';
import type { WrapupManager } from './wrapup-manager.js';
import type { BreakRegistry } from '@magick-agency/domain/break-manager';
import { DEFERRED_HANGUP_MS } from '@magick-agency/domain/timers';
import { resolveOurFaultRedial, resolveRetryDecision } from './retry-policy.js';
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
  agencyOurFaultRetirementTotal,
} from '@magick-agency/observability/metrics/agency';

const log = createChildLogger({ component: 'agency-dialer' });

/**
 * How long a `released` the agent never saw is kept for them to collect on
 * reconnect. Generous relative to the deferred-hangup window on purpose: the
 * agent who missed it is by definition the one whose network just failed, and a
 * console that comes back with an empty panel and no account of the call the
 * agent was just on reads as data loss.
 *
 * In-process, like every other business timer here (§6.1). Losing these on a
 * restart is correct — after a restart the agent is landed in `break` and shown a
 * clean console anyway.
 */
const MISSED_RELEASE_TTL_MS = 5 * 60_000;

/** An attempt this replica is currently driving, and what a reconnect needs to know. */
interface LiveAttempt {
  cmd: DialCommand;
  /**
   * When the dial went out — the start of the interval that matters for pacing.
   *
   * Held here rather than read back from `agency_call_attempts.dialed_at` because
   * every consumer is on a hot path that must not take a DB round trip: the answer
   * arm has a 1000ms compliance budget, and the settle site is the one place that
   * knows both this instant and the outcome the seat time should be attributed to.
   * The column stays the durable record; this is the in-process twin, on the same
   * pattern as `answeredAt` above it.
   */
  dialedAt: Date;
  /**
   * Why this attempt reached no agent, decided at the ANSWER and read at the
   * settle site (migration 119).
   *
   * Set here rather than re-derived below because the three causes are only
   * distinguishable in the instant they happen: by the time the attempt settles,
   * "the station was gone before we reached for it", "the send was refused" and
   * "the bridge refused the bind" all look identical — no socket and no bridge.
   * That collapse is exactly what made a bind failure indistinguishable from a
   * genuine no-agent abandonment in the one series that counts them (§11).
   *
   * Null means no cause has been observed, NOT "not abandoned" — the settle site
   * still has to ask the predicate, and falls back to `bridge_late` (a bridge
   * timestamp exists, so it did connect, merely late) or `unattributed` (no
   * timestamp and no arm claimed a cause) there.
   *
   * ⚠️ These two names must stay in step with the settle site. An earlier version
   * named `no_agent_available` as the second fallback, which is now documented as
   * unproducible — and a reader matching this comment to the code would
   * "restore" the pacing residual onto the default path, which is exactly how
   * station losses came to be mislabelled in the first place.
   */
  abandonReason: AgencyAbandonReason | null;
  /** Mirrors the attempt row, so a reconnect is answered without a DB read. */
  state: AgencyAttemptState;
  /** Non-null ⇒ media is live and the customer may already be speaking. */
  bridgedAt: Date | null;
  /**
   * Mirrors the `answered_at` column — **the value we wrote**, not a second
   * derivation of it, so the settle site's abandonment predicate reads the same
   * instant the table does (`AD-P2-C-06`). Null until the carrier answers.
   */
  answeredAt: Date | null;
  /** Fetched once at dial; replayed verbatim so a resumed panel is identical. */
  priors: AgencyPriorAttempt[];
  /**
   * `FLAGS.agency_late_binding` as **this replica resolved it at the moment it
   * dialed** (`executeDial`), not as it reads now.
   *
   * Carried on the record rather than re-read at the answer because every arm
   * below has to agree with the arm that placed the call: a flag flipped mid-ring
   * would otherwise have the `answered` arm binding a socket the dial never
   * withheld, or the `ended` arm suppressing a `released` for a panel the agent is
   * looking at. It is also not on {@link DialCommand} — see `executeDial`'s
   * header for why the dialing replica is the one entitled to the decision.
   */
  lateBinding: boolean;
  /**
   * The agent's panel, built at dial time and sent at dial (early binding) or at
   * the carrier answer (late binding).
   *
   * Held here rather than rebuilt at the answer because the bind has a 1000ms
   * budget (`ABANDONMENT_BRIDGE_GRACE_MS`) measured from the answer, and the
   * priors read behind this panel is two joins over a contact lineage. Building
   * it at dial time is what makes late binding affordable at all.
   */
  panel: AgencyReservedAttempt;
  /**
   * Has the agent actually SEEN this call — i.e. did a `reserved` frame reach
   * their socket?
   *
   * True from before the dial under early binding, and only from a successful
   * bind under late binding. Every frame that refers to the call reads it: an
   * agent who was never shown a call must not be told it ended (see the `ended`
   * arm and {@link isUnannounced}).
   */
  panelDelivered: boolean;
  /**
   * Set when the answered call found no agent and took the abandoned path.
   *
   * Recorded so the `ended` handler can tell an abandoned teardown from an
   * ordinary one without re-deriving it from the outcome string — and so a
   * reconnecting socket is never offered an attempt that is already being
   * apologised to.
   */
  abandoned?: boolean;
}

/**
 * Is this attempt one the agent has never been told about?
 *
 * Only reachable under late binding, where a dial that rings out, is busy, fails
 * or finds an unreachable handset must reach the console as **nothing at all**
 * — no `reserved`, no `released`, no state change. That silence is the product
 * ask behind `FF_AGENCY_LATE_BINDING`, and it is exactly the ringing popup the
 * 2026-09-08 pilot found agents dismissing (and, on VoiceLink,
 * dismissing without cancelling anything).
 *
 * ⚠️ **The question is "has the agent SEEN this call", not "did this call
 * bridge".** Those come apart in exactly one place — the `answered` arm, where
 * the `reserved` frame can reach the console and the bind can then be refused —
 * and conflating them there orphans the panel: the agent is shown a contact card
 * for a call they never hear and, because this predicate reported them
 * un-announced, are never told ended. The console is stuck. That is why
 * `panelDelivered` is set from the SEND rather than the bind; see the site.
 *
 * ONE function, because three sites have to give the same answer and all three
 * are asking the seen-it question, not the bridged one: the `ended` arm (send
 * `released`, or say nothing), `reattachStation` (resume the panel, or report no
 * live call) and `hasUnannouncedAttempt` (which message
 * `POST /sessions/:id/leave` refuses with). Two spellings of "has the agent seen
 * this" is how a console that shows no call and a route that talks about "your
 * current call" end up in one build.
 *
 * Inert under early binding by construction: `panelDelivered` is set before the
 * dial there, and `executeDial` abandons the attempt outright if that send fails,
 * so no live early-binding attempt can be unannounced. The `lateBinding` half is
 * kept anyway so the predicate reads as the fact it is rather than as an
 * invariant of another branch.
 */
function isUnannounced(live: LiveAttempt): boolean {
  return live.lateBinding && !live.panelDelivered;
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
   * receive, delivered on the `ready` frame when it comes back (§ contract,
   * `AgencyStationReadyFrame.missed_release`).
   */
  private readonly missedReleases = new Map<string, { release: AgencyMissedRelease; expiresAt: number }>();
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
   * regulatory ceiling and feeding the `AD-P4-C-02` auto-pause. The identical
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
  async executeDial(cmd: DialCommand): Promise<void> {
    const { attemptId, sessionId } = cmd;

    // Fails closed onto `false` (early binding, today's behaviour) whenever the
    // flag cannot be resolved: `getValue` catches everything and returns the
    // registry default. That is the safe direction — early binding is the shipped
    // path, and the worst it does is show the agent a ringing panel.
    const lateBinding = await getFeatureFlagService().isEnabled(FLAGS.agency_late_binding, {
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
      await this.abandonBeforeDial(cmd, 'reservation_expired', panelDelivered);
      return;
    }

    // ── 1. Gather EVERYTHING the panel needs, before any dial. ──────────────
    //
    // The read is LINEAGE-scoped since retry campaigns landed: a retry copies its
    // contacts rather than sharing them (DR-2), so the previous pass's attempts
    // hang off a different `agency_contacts` row and a `contact_id` read would
    // show the agent an empty history on exactly the calls where history matters
    // most. `root_contact_id` is the chain head, stamped on every row by migration
    // 112's trigger.
    //
    // `?? cmd.contactId` is the pre-backfill fallback and is expected to be
    // unreachable: migrations run in the container entrypoint before the app
    // boots, so 113 has populated the column for every row by the time this line
    // executes. It is here because a `null` would reach `WHERE root_contact_id =
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

    const attempt: AgencyReservedAttempt = {
      attempt_id: attemptId,
      campaign_id: cmd.campaignId,
      campaign_name: cmd.campaign.name,
      contact_id: cmd.contactId,
      phone_e164: cmd.contact.phone_e164,
      caller_id: cmd.callerId,
      attempt_number: cmd.attemptNumber,
      context: cmd.contact.context,
      prior_attempts: priors,
    };

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
        await this.abandonBeforeDial(cmd, 'reservation_expired', panelDelivered);
        return;
      }
      panelDelivered = true;
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
      await this.abandonBeforeDial(cmd, 'reservation_expired', panelDelivered);
      return;
    }
    this.startLeaseRenewal(attemptId, sessionId, 'reserved');

    await agencyAttemptRepository.setState(attemptId, 'dialing', { dialed_at: new Date() });

    // Registered BEFORE the dial: a carrier can answer inside createBridgedCall —
    // and under late binding that is no longer the rare case the map was built
    // for. The `answered` arm is where the socket gets bound, so an event that
    // arrived before this line existed would leave a live customer with no agent
    // and no record of the attempt to abandon.
    this.liveByAttempt.set(attemptId, {
      cmd, state: 'dialing', bridgedAt: null, answeredAt: null, priors,
      lateBinding, panel: attempt, panelDelivered, dialedAt: new Date(),
      abandonReason: null,
    });

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
      // PORT NOTE (magick-agency): core passed `sipConnectionId: cmd.campaign.sip_connection_id`
      // here (BYO-SIP egress). SIP is deleted (plan §5): the column is not in the baseline
      // and `WebRtcOutboundParams` no longer carries the field (docs/seams.md §3.1).
      record: cmd.campaign.record_calls,
      analysisProfileId: cmd.campaign.analysis_profile_id,
      initiatedBy: cmd.sessionId,
      campaignId: cmd.campaignId,
      agencyAttemptId: attemptId,
      // `AD-P2-C-07`. Supplied by us, never chosen by the bridge — §7's one-way
      // dependency means the bridge must stay ignorant of what an agency
      // reconnect is worth, and the browser dialer keeps its immediate hangup.
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
    // has no socket to check. The replacement check happened above — but it ran
    // BEFORE `await setState(…, 'dialing')` and before the `liveByAttempt.set`
    // just above, and a station closing inside that window arms nothing:
    // `noteStationClosed` asks `hasUnannouncedAttempt`, which reads
    // `liveByAttempt`, which had no entry yet. The dial then went out unbound with
    // no socket and no timer, and ran to the carrier's answer.
    //
    // So the question is asked once more, on the near side of the registration:
    // from here on a close is covered, because the entry the grace looks for
    // exists. Scoped to late binding because early binding's dial carries the
    // socket and the bridge's throw already covers it — the `catch` below turns
    // that into the same `reservation_expired`.
    if (lateBinding && this.stations.socketFor(sessionId) !== socket) {
      log.warn(
        { attemptId, sessionId },
        'Station socket went away while the dial was being prepared — abandoning before placing an unbound call nobody is watching',
      );
      await this.abandonBeforeDial(cmd, 'reservation_expired', panelDelivered);
      return;
    }

    let record: Awaited<ReturnType<typeof this.bridge.createBridgedCall>>;
    try {
      // The one line late binding changes about the dial: no socket goes to the
      // carrier leg, so `attachBrowserLeg`'s token-less fallback cannot reach this
      // call and the bridge emits no `bridged` at the answer. Everything after the
      // answer is the `answered` arm's job.
      record = lateBinding
        ? await this.bridge.createUnboundBridgedCall(dialParams)
        : await this.bridge.createBridgedCall({ ...dialParams, browserSocket: socket });

    } catch (err) {
      const reason: AgencyReleaseReason =
        err instanceof WebRtcCallError && err.code === 'station_socket_unavailable'
          ? 'reservation_expired'
          : 'failed';
      log.warn({ err, attemptId }, 'Agency dial failed');
      await this.abandonBeforeDial(cmd, reason, panelDelivered);
      return;
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
   * The dial never happened (or never will). End the attempt, return the contact,
   * release the agent, and — if they were ever shown a panel — TELL THEM WHY: a
   * panel that clears with no explanation reads as a broken app.
   *
   * `notifyAgent` is an explicit parameter and deliberately not inferred here.
   * This method has four call sites in {@link executeDial}, on both sides of the
   * `reserved` send, and under late binding the send has not happened at ANY of
   * them — so the caller is the only place that knows whether there is a panel to
   * explain. Inferring it from `lateBinding` alone would be wrong for the early
   * path's pre-send abandons, and inferring it from the live record is not
   * possible: the first thing this method does is delete it.
   *
   * With `false` the agent is told nothing, which is the point of late binding: a
   * dial that was abandoned before it was ever placed is a call the agent never
   * knew about, and a bare `released` for it is the same spurious popup the
   * 2026-09-08 pilot found agents dismissing.
   */
  private async abandonBeforeDial(
    cmd: DialCommand,
    reason: AgencyReleaseReason,
    notifyAgent: boolean,
  ): Promise<void> {
    const outcome = reason === 'failed' ? 'failed' : 'orphaned';
    /**
     * ── Seat time on the abandon-before-dial paths (added by review) ─────────
     *
     * `agency_attempt_hold_seconds` is observed at the settle site, which these
     * paths never reach: they delete the live record and write the attempt
     * `ended` themselves. Two of the five callers run AFTER `liveByAttempt.set`
     * — the late-binding socket recheck and `createBridgedCall` throwing — and
     * on both of those **the agent was genuinely held**: the lease had been
     * extended to `reserved_dialing`, the attempt row says `dialing`, and
     * `releaseAgent` runs at the bottom of this method. Those seconds are in the
     * population the pivotal series claims to cover and were appearing nowhere,
     * so `failed` and `orphaned` were silently under-reported.
     *
     * `dialedAt` is the discriminator rather than the call site, and it is the
     * honest one: the three callers that run BEFORE the registration have no
     * live record, so there is no dial instant to measure from and nothing to
     * observe — which is correct, because on those paths no dial went out. Read
     * before the `delete` below, for the obvious reason.
     */
    const live = this.liveByAttempt.get(cmd.attemptId);
    if (live) {
      const holdSeconds = Math.max(0, (Date.now() - live.dialedAt.getTime()) / 1000);
      // No `campaign_id` on the histograms (series cost) — see metrics.ts.
      const labels = { tenant_id: cmd.tenantId, outcome };
      agencyAttemptHoldSeconds.observe(labels, holdSeconds);
    }
    this.liveByAttempt.delete(cmd.attemptId);
    this.stopLeaseRenewal(cmd.attemptId);
    // Paired with the lease renewer: the attempt is gone, so a pre-bind grace armed
    // against it has nothing left to end and must not outlive it into the next dial.
    this.clearUnboundStationGrace(cmd.sessionId);
    await agencyAttemptRepository.setState(cmd.attemptId, 'ended', {
      // Same `outcome` the hold observation above is labelled with, so the
      // histogram bucket and the attempt row cannot disagree about what happened.
      outcome,
      ended_at: new Date(),
    }).catch((err) => log.error({ err, attemptId: cmd.attemptId }, 'Failed to end abandoned attempt'));

    // The condition genuinely cleared, so `now()` is correct here — unlike an
    // out-of-hours unclaim, which must move the clock forward (§4.2).
    await agencyContactRepository.unclaim(cmd.contactId, new Date())
      .catch((err) => log.error({ err, contactId: cmd.contactId }, 'Failed to unclaim contact'));

    if (notifyAgent) {
      this.stations.send(cmd.sessionId, {
        event: 'released',
        attempt_id: cmd.attemptId,
        reason,
        requires_disposition: false,
        message: releaseMessageFor(reason),
      });
    }
    // Runs either way — the agent goes back to the pool (or `offline`) whether or
    // not they were told a call had been reserved for them. Suppressing the frame
    // must never suppress the release, or a silent abandon would leave the agent
    // `reserved` against an attempt that no longer exists until the lease lapsed.
    await this.releaseAgent(cmd.sessionId);
  }

  /** Bridge told us something happened to a call we placed. */
  private async onBridgeLifecycle(ev: WebRtcLifecycleEvent): Promise<void> {
    // Correlate on the caller-supplied id, which we registered before dialing.
    const live = ev.correlationId ? this.liveByAttempt.get(ev.correlationId) : undefined;
    if (!live) return; // not ours — an ordinary browser dialer call
    const cmd = live.cmd;

    // Switch on the phase EXPLICITLY. This used to read "if bridged … else it must
    // be ended", and a phase added to the bridge's union would have fallen straight
    // into teardown — ending a live call the instant the carrier answered it.
    if (ev.phase === 'answered') {
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
      // §10 cross-check fail for a reason that is not a bug.
      const answeredAt = ev.answeredAt ?? new Date();
      live.answeredAt = answeredAt;

      // Dial → answer. Prices a ring timeout (where the curve flattens, and what
      // the tail beyond it would forgo) and supplies the clustering half of the
      // over-dial arithmetic, which §11's flat `p` cannot. Observed HERE, before
      // the bind, so a refused bind never costs us the reading.
      const answerLatencySeconds = Math.max(0, (answeredAt.getTime() - live.dialedAt.getTime()) / 1000);
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
          // never told about: the "connected but silent" complaint from the pilot
          // debrief, manufactured by the fix for it. `hasUnannouncedAttempt` would
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
         * §7.3 gates the week-long hold on "bind-latency p99 <150ms and zero bind
         * failures", and §11 has carried that criterion as NOT INSTRUMENTED since
         * the flag shipped — a refused bind was a WARN line and nothing else.
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
          const bindSeconds = Math.max(0, (Date.now() - answeredAt.getTime()) / 1000);
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
      await agencyAttemptRepository.setState(cmd.attemptId, 'answered', {
        answered_at: answeredAt,
        only_from: ['dialing'],
      });

      // The compliance DENOMINATOR (`AD-P2-C-06`), counted here and nowhere else.
      // This is the only site that observes a carrier answer, and it is reached by
      // both the bridged and the abandoned path — which is what makes the ratio
      // below it meaningful. Counting on `bridged` instead would exclude every
      // abandoned call from the denominator and understate the rate.
      agencyAnsweredTotal.inc({ tenant_id: cmd.tenantId, campaign_id: cmd.campaignId });

      // ── The abandoned path (`AD-P2-C-05`, design §6.2) ────────────────────
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
      return;
    }

    if (ev.phase === 'bridged') {
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

      // ── The COMPLIANCE write goes before the agent-state writes ────────────
      //
      // Same discipline as the frame above, for a stronger reason. `bridged_at` is
      // not bookkeeping: with late binding it is the SOLE discriminator between a
      // conversation and an abandoned call. `ABANDONED_ATTEMPT_PREDICATE_SQL`
      // counts `bridged_at IS NULL` as abandoned, so an attempt that never gets
      // this write is a fully-conversed call charged against the 3% regulatory
      // ceiling — and it feeds the auto-pause, so it can stop a campaign.
      //
      // It used to sit third, behind `agents.set` (Redis) and the `on_call` mirror
      // (a `SELECT … FOR UPDATE` + UPDATE + a `recordTransitions` INSERT, on a pool
      // with `connectionTimeoutMillis` but NO `statement_timeout`). Neither can
      // fail in a way that skips this write — the mirror is `.catch`-guarded and
      // `AgentStateMachine.set` swallows internally — but both can BLOCK it for an
      // unbounded time under row-lock contention, and anything that ends the
      // process in that window (SIGTERM on a deploy, an OOM, a starved event loop)
      // loses `bridged_at` permanently. Nothing retries it: the `bridged` phase
      // fires once.
      //
      // Moving it first costs nothing. It depends only on `ev` and `bridgedAt`,
      // both already in hand, and none of the writes below it depend on this one.
      // The ordering is therefore: the agent's ears, then the regulator's record,
      // then the bookkeeping.
      // `answered_at` comes from the bridge's own anchor, never from `bridgedAt`.
      //
      // **The protection here is the ARGUMENT, not the column's write rule, and the
      // comment that used to sit here credited the wrong one.** The column is
      // `answered_at = COALESCE($6, answered_at)` where `$6` is the INCOMING value —
      // so a non-null argument WINS over whatever is stored. That is
      // last-non-null-wins, not first-write-wins. Passing `bridgedAt` from this site
      // would therefore *overwrite* the carrier's answer instant rather than being
      // ignored by the mechanism, collapsing the two timestamps and making the
      // abandonment predicate vacuous — the `AD-P2-C-11` defect that returned 0 for
      // months. What actually keeps that from happening is that this caller passes
      // `ev.answeredAt` (the bridge's own anchor, undefined when there is nothing to
      // say) and nothing else. Any second caller of this write must do the same;
      // the SQL will not stop it.
      //
      // `ev.answeredAt` is still passed rather than omitted so a MISSED `answered`
      // event is back-filled with the correct instant.
      //
      // Mirror it into our own record for the same reason (`AD-P2-C-06`): if the
      // `answered` phase never arrived, the settle site would otherwise see
      // `answeredAt: null`, read "never answered", and skip a call the table counts.
      // `??=` so a real `answered` phase's value is never displaced.
      live.answeredAt ??= ev.answeredAt ?? null;
      // ── `MAG-137`: this write must not RESURRECT a settled attempt ──────────
      //
      // It had no `only_from` while the `answered` write above it carried one, on
      // the same row, against the same race — and the missing half is the one that
      // can write a live state over a TERMINAL one. The orderings are ordinary
      // rather than exotic: lifecycle listeners are invoked fire-and-forget, so on
      // a call the customer picks up and immediately drops, the `ended` arm can
      // run to completion while this statement is still in flight. `state` then
      // goes back to `bridged` on a row that already holds its real `outcome` and
      // `ended_at`, and nothing anywhere goes red.
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
      // `['dialing']` alone — mirroring the write above verbatim — would therefore
      // leave every connected late-binding attempt reading `answered` for the
      // whole conversation, which is the `AD-P2-C-11` shape with the sign flipped.
      await this.agents.set(cmd.sessionId, 'on_call', {
        attemptId: cmd.attemptId,
        leaseMs: AGENT_LEASE_MS.on_call,
      });
      this.startLeaseRenewal(cmd.attemptId, cmd.sessionId, 'on_call');
      await agencyAgentSessionRepository.setState(cmd.sessionId, 'on_call')
        .catch((err) => log.warn({ err, sessionId: cmd.sessionId }, 'Could not mirror on_call state'));
      await agencyAttemptRepository.setState(cmd.attemptId, 'bridged', {
        answered_at: ev.answeredAt,
        bridged_at: bridgedAt,
        only_from: ['dialing', 'answered'],
      });

      // ── `MAG-88`: the SEAM, and the site that actually parks the contact ────
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
      return;
    }

    // ── ended ──
    this.liveByAttempt.delete(cmd.attemptId);
    this.stopLeaseRenewal(cmd.attemptId);
    // Paired with the lease renewer: the attempt is gone, so a pre-bind grace armed
    // against it has nothing left to end and must not outlive it into the next dial.
    this.clearUnboundStationGrace(cmd.sessionId);

    // ── `bridged` means BRIDGED, from the bridge's own stamp ─────────────────
    //
    // Pilot 2026-09-08. No ticket: the defect was found by tracing the pilot's
    // own attempt rows against Loki, and the debrief is the record.
    //
    // One local, read by the classifier and by the log line below, and its source
    // is `live.bridgedAt` — written by the `bridged` arm above and by nothing
    // else. Both previous spellings were wrong in ways that could not be seen
    // from here:
    //
    //  - the classifier was handed `bridged: ev.answered`, i.e. the CARRIER's
    //    pickup. That labelled a cancelled ring `abandoned` (~19 phantom rows in
    //    the 2026-09-08 pilot) and an answered-but-unbridged call `connected`
    //    and billable (the `064836f1` shape). See `classifyAttemptOutcome`'s
    //    header for both, and for why `answered` and `bridged` are now two
    //    parameters that a caller cannot satisfy with one fact.
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
     * `outcome` split is the whole value: the pilot's largest block of dead time
     * was busy signals, and a busy phone never rings — so an aggregate "average
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
    const holdSeconds = Math.max(0, (Date.now() - live.dialedAt.getTime()) / 1000);
    // No `campaign_id` on the histogram (series cost) — see metrics.ts.
    agencyAttemptHoldSeconds.observe({ tenant_id: cmd.tenantId, outcome }, holdSeconds);

    // The compliance NUMERATOR (`AD-P2-C-06`). Incremented AFTER the row write, so
    // the counter means "attempts we believe are recorded abandoned" — which is
    // what makes the §10 cross-check able to find a write that silently did not
    // take. Incrementing before the write would make the two agree by
    // construction, and a cross-check that cannot disagree is not a check.
    //
    // ── Keyed on the PREDICATE, not on `outcome` (decided; §10's equality) ────
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
    // than merely tolerable-under-D2: this handler returns early unless
    // `liveByAttempt` holds the attempt, so we are by construction the replica that
    // observed both phases for it. What in-process state cannot cover is an attempt
    // settled with no live record at all — the reaper's post-crash sweep — which no
    // process-local counter can, and which is why the audited compliance number is
    // the SQL window gauge.
    if (abandoned) {
      agencyAbandonedTotal.inc({ tenant_id: cmd.tenantId, campaign_id: cmd.campaignId });
      // ⚠️ A SEPARATE series, not a `reason` label on the two counters above.
      // Labelling a live series terminates it, and those two are the compliance
      // numerator and denominator that the §10 cross-check and the auto-pause
      // guardrail both read. A diagnostic split does not earn that migration, so
      // it rides alongside and `sum(rate(...))` of the two should track.
      if (abandonReason) {
        agencyAbandonedReasonTotal.inc({
          tenant_id: cmd.tenantId, campaign_id: cmd.campaignId, reason: abandonReason,
        });
      }
    }

    // ── Contact release (`AD-P3-C-01`) ──────────────────────────────────────
    // `connected` still parks the contact awaiting the agent's write-up: §2.4 gives
    // a disposition precedence over the outcome policy, so evaluating the outcome
    // policy now would decide a question the disposition is entitled to answer. The
    // wrap-up route settles it, and the reaper's `no_disposition` auto-close is the
    // backstop that routes it back here.
    //
    // Everything else has no disposition coming, so the outcome policy decides —
    // which now means a real retry rather than Phase 2's flat `completed`.
    //
    // ── `MAG-88`: parked in `connected` FOREVER when none is owed ────────────
    // Computed here rather than at its old site below the block, so ONE function
    // answers "is a disposition owed" for both the contact's fate and the
    // `released` frame's `requires_disposition`. Two readings of that question is
    // how a route that demands a write-up and a console told none is needed end up
    // in the same build.
    //
    // The defect: `connected` parks the contact awaiting an agent's write-up, and
    // the ONLY things that release it are the disposition route and the reaper's
    // `no_disposition` sweep. On a campaign with an empty `disposition_catalog` —
    // which is every campaign today, since master never sends the field, and which
    // is a LEGITIMATE configuration meaning "outcome-driven retry, no human
    // write-up step" — no disposition is owed, none is ever submitted, and the
    // contact sits in `connected` until the reaper eventually auto-closes it.
    // `MAG-88` option (1): when none is owed, let the outcome policy decide now.
    //
    // Note the else-branch already produces the right answer without a special
    // case: `connected`'s default policy is `max_attempts: 0`, so it resolves to
    // `completed` with reason `outcome_not_retryable`. Only the CONDITION moved.
    //
    // ⚠️ This gate is HALF the fix and does not stand alone. The `bridged` handler
    // above parks the contact in `connected` while the call is live, and its write
    // can land after this one — see the note at that site. Both ask the same
    // function; removing either one puts the contact back in `connected` forever.
    const needsDisposition = requiresDisposition(outcome, cmd.campaign.disposition_catalog);
    // ── `AD-P3-C-09` / MAG-97: our fault, before the bridge ──────────────────
    //
    // An agent's station socket dropping is OUR failure. If it happened before
    // the call bridged, the customer was never spoken to — their phone may not
    // even have been answered — so charging it to `attempt_count` retires
    // someone we never reached, and with `max_attempts: 3` three dropped sockets
    // do it silently, behind a plausible audit trail.
    //
    // The reaper has held the opposite principle from the start: it requeues a
    // crash-orphaned contact with NO bump, because "our crash must not consume
    // the customer's retry allowance". Same category of fault, and until now the
    // opposite handling. This is that principle applied in the second place
    // (criterion 4) rather than a new rule invented here.
    //
    // ⚠️ The gate is `bridgedAt`, NOT `answeredAt`. A call the customer picked up
    // and that never bridged to an agent is an ABANDONED call — already its own
    // outcome, already counted against the compliance rate, and it must keep
    // being charged. Widening this to "never answered" would quietly zero the
    // abandonment ledger's retry consequences.
    //
    // `live.bridgedAt` is in-process and that is sound here for the same reason
    // the abandonment counter above relies on it: this handler returned early
    // unless `liveByAttempt` held the attempt, so we are by construction the
    // replica that watched both phases. The path with no live record at all is
    // the reaper's, which charges its own our-fault ledger.
    //
    // ── `canceled` joins the same ledger (pilot 2026-09-08) ─────────────────
    //
    // A dial we stopped before anyone picked up is not a *failure* on our side,
    // and it is not the customer's doing either — it is entirely OUR decision,
    // and it tells us nothing at all about the number. Charging it to
    // `attempt_count` retires someone we never spoke to, and at
    // `max_attempts: 3` three cancelled rings do it silently: exactly the shape
    // MAG-97 fixed for a dropped socket, arriving through a different door. The
    // pilot makes it concrete — 26 agent cancels in one window, against a
    // 2-agent floor.
    //
    // The un-charged path is also the more CONSERVATIVE one on repeat-dialling,
    // which is the half that is easy to get backwards: `OUR_FAULT_REDIAL_BOUND`
    // is a hard ceiling `resolveOurFaultRedial` applies as `min(configured,
    // BOUND)` and no campaign config can raise, whereas `max_attempts` is a
    // number an operator can set to anything. So routing here is both fairer to
    // the customer's allowance and stricter on how often we may re-dial them.
    //
    // A `canceled` outcome is never bridged BY CONSTRUCTION — the classifier
    // returns `connected` for any bridged teardown, whatever the status — so the
    // `bridgedAt === null` half of the gate is already satisfied for it. Kept in
    // the shared condition rather than special-cased: a second, outcome-specific
    // spelling of "did this reach the customer" is how the two halves of a rule
    // like this drift apart, and the redundant check costs nothing.
    /**
     * ── Whose allowance pays for this attempt ───────────────────────────────
     *
     * ⚠️ **`abandoned` is deliberately NOT on this gate, and that is an OPEN
     * QUESTION rather than a settled one** (reviewed 2026-09-10).
     *
     * The case for leaving it here is on the test that pins it
     * (`canceled-outcome-ledger.test.ts`, the `064836f1` shape): the customer
     * picked up and was inconvenienced, so it is a real attempt against them and
     * `abandoned`'s own retry rule applies — the our-fault ledger is for calls
     * that never reached anybody.
     *
     * The case against is that this file's retry table states the opposite rule
     * one screen up: those caps "are the CUSTOMER's allowance and apply only to
     * an attempt that actually reached them (a drop *after* bridging)", and an
     * abandoned attempt has `bridged_at IS NULL` by definition. The consequence
     * is live: `abandoned: { max_attempts: 2 }` with `bump_attempt: true` means
     * **we hang up on a customer twice and then retire them `exhausted`.**
     *
     * Both readings are defensible and the tie-breaker is a repeat-dial
     * judgement, not a code one — moving it here RAISES the maximum number of
     * times one person can be called (our-fault bound 3, and their own allowance
     * left unspent). So it is not a change to make from inside a pacing task.
     *
     * What ships instead is the evidence to decide it:
     * `agency_abandoned_reason_total` now splits the causes, and
     * `agency_our_fault_retirement_total` makes retirements visible for the first
     * time. If `no_agent_available` turns out to dominate — i.e. we are retiring
     * people because of OUR pacing rather than their unavailability — the answer
     * is clear and the change is one clause.
     */
    const ourFaultBeforeBridge = (outcome === 'agent_disconnected' || outcome === 'canceled')
      && live.bridgedAt === null;
    if (outcome === 'connected' && needsDisposition) {
      await agencyContactRepository.markState(cmd.contactId, 'connected', {
        last_outcome: outcome, bump_attempt: true,
      });
    } else if (ourFaultBeforeBridge) {
      // Charged to the SEPARATE ledger. `attempt_count` is untouched — criterion
      // 1 — and the bound below is what keeps that safe rather than free
      // (criterion 3): without it, one flapping agent workstation redials the
      // same number forever, which is regulated.
      const ourFaultUsed = await agencyContactRepository
        .chargeOurFaultAttempt(cmd.contactId, outcome);
      const decision = resolveOurFaultRedial(
        cmd.campaign.retry_policy, outcome, new Date(), ourFaultUsed,
      );
      const retirementLanded = await agencyContactRepository.markState(
        cmd.contactId, decision.contactState, {
          // No `bump_attempt`, and no `last_outcome` — `chargeOurFaultAttempt`
          // already wrote it, exactly as `chargeAttempt` does on the path below.
          ...(decision.nextAttemptAt ? { next_attempt_at: decision.nextAttemptAt } : {}),
        },
      );
      /**
       * ── The surface this ledger never had ─────────────────────────────────
       *
       * §11 records that the our-fault ledger's bound is an unresearched
       * placeholder AND that **nothing anywhere shows a contact retired by it** —
       * a real person permanently removed from the list because of our dropped
       * sockets and cancelled dials, invisible in every view. This is that
       * surface, and it ships in the same change that adds a third producer to
       * that ledger rather than making the invisibility worse.
       *
       * ⚠️ **AFTER the `markState` above, never before** (corrected by review).
       * The first version incremented on the decision, so a rejected write would
       * have reported a permanently retired contact that was still pending. This
       * is the same rule the compliance counters follow one screen up and for the
       * same reason: a counter that means "we believe this was recorded" can find
       * a write that silently did not take, and one incremented on intent cannot.
       *
       * ⚠️⚠️ **And gated on `retirementLanded`, because "the await did not
       * reject" is NOT proof the retirement happened** (second review round, and
       * this was a live mis-attribution rather than a nit). `markState` resolves
       * when its DNC guard refuses the transition — the `CASE` keeps a
       * `dnc`-suppressed row `suppressed`, the statement succeeds, and a warn
       * line is the only trace — and it resolves when no row matched at all. A
       * contact marked DNC mid-call is the headline case in `markState`'s own
       * header, and on that path `our_fault_bound_reached` still fires. So the
       * unguarded version reported *"we permanently retired someone we failed to
       * reach"* for a row that stayed `suppressed` by the customer's own request:
       * the alert fires, an engineer goes looking for dropped sockets, and the
       * contact was never retired by this ledger at all. `markState` now returns
       * whether the requested state landed, and only that increments.
       *
       * `outcome` is what makes it actionable: `agent_disconnected` points at
       * agent workstations, `canceled` at our teardown paths. Alert on any
       * sustained non-zero — it is a revenue loss and a list-quality lie at once.
       */
      if (decision.reason === 'our_fault_bound_reached' && retirementLanded) {
        agencyOurFaultRetirementTotal.inc({
          tenant_id: cmd.tenantId, campaign_id: cmd.campaignId, outcome,
        });
        // WARN rather than INFO, and deliberately thin: the `log.info` below
        // already carries the full decision. What this adds is a severity an alert
        // can key on — and it names no `bound`, because the effective one is
        // `min(campaign config, OUR_FAULT_REDIAL_BOUND)` and logging either half
        // alone would put a number in Loki that is not the number that fired.
        log.warn(
          { contactId: cmd.contactId, attemptId: cmd.attemptId, outcome, ourFaultUsed },
          'Contact retired by the our-fault redial bound — we never reached them',
        );
      }
      log.info(
        {
          contactId: cmd.contactId, attemptId: cmd.attemptId, outcome,
          ourFaultUsed, contactState: decision.contactState, retryReason: decision.reason,
          nextAttemptAt: decision.nextAttemptAt,
        },
        // Deliberately does not name the cause — `outcome` is on the line and
        // this branch now serves two of them (`canceled` joined
        // `agent_disconnected` here). "an agent-side drop" would be false for
        // half the lines an operator greps, and the grep is the point.
        decision.reason === 'our_fault_bound_reached'
          ? 'Our-fault redial bound reached — contact retired without spending its retry allowance'
          : 'Contact requeued without charging an attempt — the customer was never reached',
      );
    } else {
      // Charge the budget FIRST and decide on what Postgres returns. The policy is
      // defined on attempts INCLUDING this one, and passing the pre-bump count would
      // grant every contact one dial more than the operator configured.
      const attemptsUsed = await agencyContactRepository.chargeAttempt(cmd.contactId, outcome);
      const decision = resolveRetryDecision(
        cmd.campaign.retry_policy, outcome, new Date(), attemptsUsed,
      );
      // ⚠️ `decision.contactState` is `'pending'` for every retryable outcome under
      // its cap, and this contact may have been marked DNC mid-call. `markState`
      // refuses that transition in SQL — see its header for why the guard is there
      // and not here, and for the enumeration this site is the headline of. Do not
      // add a second, local check: two guards that can disagree is worse than one.
      await agencyContactRepository.markState(cmd.contactId, decision.contactState, {
        // `last_outcome` was already written by `chargeAttempt`; no `bump_attempt`
        // here, or the contact would be charged twice for one dial.
        ...(decision.nextAttemptAt ? { next_attempt_at: decision.nextAttemptAt } : {}),
        ...(decision.suppressedReason ? { suppressed_reason: decision.suppressedReason } : {}),
      });
      log.info(
        {
          contactId: cmd.contactId, attemptId: cmd.attemptId, outcome, attemptsUsed,
          contactState: decision.contactState, retryReason: decision.reason,
          nextAttemptAt: decision.nextAttemptAt,
        },
        'Contact released by the outcome retry policy',
      );
    }

    /**
     * **Both** vocabularies, because there are two agent-initiated hang-ups and
     * they arrive under different names. The browser leg closing yields
     * `ended_by_user`; the HTTP route added by `MAG-112` calls
     * `forceEndWithOutcome(attemptId, 'agent_hangup')`, which reaches this handler
     * as `ev.outcome === 'agent_hangup'`. Matching only the first meant the
     * *supported* hang-up API classified as an ordinary `completed` release, so the
     * agent pressed hang up and the console told them the call had simply ended —
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
    // the console's screen, which is the ringing popup agents spent the
    // 2026-09-08 pilot dismissing. There is nothing to explain, because nothing
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
      const delivered = this.stations.send(cmd.sessionId, {
        event: 'released',
        attempt_id: cmd.attemptId,
        reason,
        requires_disposition: needsDisposition,
        message,
      });
      // The agent whose socket dropped is exactly the agent this frame explains the
      // most to, and exactly the one who cannot receive it. Hold it for their
      // reconnect rather than letting the console come back to an empty panel with
      // no account of the call they were just on.
      if (!delivered) {
        this.missedReleases.set(cmd.sessionId, {
          release: {
            attempt_id: cmd.attemptId,
            reason,
            requires_disposition: needsDisposition,
            message,
            ended_at: new Date().toISOString(),
          },
          expiresAt: Date.now() + MISSED_RELEASE_TTL_MS,
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
    if (this.stations.isLocallyOwned(cmd.sessionId) && outcome === 'connected') {
      const entered = await this.wrapup.enter({
        sessionId: cmd.sessionId,
        attemptId: cmd.attemptId,
        campaignId: cmd.campaignId,
        tenantId: cmd.tenantId,
        wrapupSeconds: cmd.campaign.wrapup_seconds,
        autoReturn: cmd.campaign.wrapup_auto_return,
        requiresDisposition: needsDisposition,
        // PEEKED, not taken — `releaseAgent` below is the single place a queued
        // break is consumed (`AD-P2-C-03` (a)), and taking it here would apply it
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
      });
      // `false` ⇒ `wrapup_seconds = 0`, so the agent goes straight to `available`
      // (acceptance (a)). Falling through is that path.
      if (entered) return;
    }

    await this.releaseAgent(cmd.sessionId);
  }

  /**
   * Return an agent to the pool, if their socket is still live.
   *
   * **This is the single place a queued break is applied** (`AD-P2-C-03` (a)): an
   * agent who asked for a break mid-call goes to `break` here rather than
   * `available`, at the end of wrap-up, without their conversation having been
   * interrupted. Doing it here and nowhere else is what makes "queued" mean one
   * thing — every route into the pool, whether the agent had a wrap-up, skipped
   * one, or had one forced, passes through this method.
   */
  async releaseAgent(sessionId: string): Promise<void> {
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
    // out of the pool, and they rehydrate into `break` anyway (D2).
    if (!stillHere) {
      this.breaks.cancel(sessionId);
      await this.agents.set(sessionId, 'offline', { leaseMs: AGENT_LEASE_MS.available });
      await agencyAgentSessionRepository.setState(sessionId, 'offline')
        .catch((err) => log.warn({ err, sessionId }, 'Could not mirror released agent state'));
      return;
    }

    // Consumed, not peeked: a queued break applies exactly once, so an agent who
    // takes a break and later goes available is not silently pulled back out of the
    // pool on their next call's release.
    const queuedBreak = this.breaks.take(sessionId);
    const state = queuedBreak ? 'break' : 'available';
    const since = new Date();

    await this.agents.set(sessionId, state, {
      leaseMs: queuedBreak ? AGENT_LEASE_MS.break : AGENT_LEASE_MS.available,
    });
    await agencyAgentSessionRepository.setState(sessionId, state, queuedBreak?.code ?? null)
      .catch((err) => log.warn({ err, sessionId }, 'Could not mirror released agent state'));

    this.stations.send(sessionId, {
      event: 'agent_state',
      state,
      since: since.toISOString(),
      ...(queuedBreak ? { break_reason: queuedBreak.code } : {}),
    });
    if (queuedBreak) {
      log.info({ sessionId, reason: queuedBreak.code }, 'Queued break applied after wrap-up');
    }
  }

  /**
   * A customer answered and there is no agent (`AD-P2-C-05`).
   *
   * **Why this fires even inside a deferred-hangup window, which looks like a
   * conflict with `AD-P2-C-07` and is not.** The two mechanisms cover different
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

  // ─── Presence resilience (`AD-P2-C-07`) ───────────────────────────────────

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
   * exclusion arm (`AD-P2-C-08`).
   *
   * **This is the authoritative "alive" set, and it is deliberately not derived
   * from the bridge.** An entry is written before the dial is placed and deleted
   * only when the attempt settles, so it covers `dialing` through `bridged` *and*
   * the whole `AD-P2-C-07` deferred-hangup window — during which the agent's
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
   * The agent hangs up the call they are on (`MAG-112`).
   *
   * Returns `false` when this replica holds no live attempt by that id — which is
   * the honest answer for **both** "the call already ended" and "another replica
   * is bridging it", and the caller distinguishes them from the attempt row. It
   * deliberately does not guess: the bridge session is in-process memory (§6.1),
   * so a `true` from somewhere that does not hold it would be a fabrication.
   *
   * `agent_hangup` rather than a generic outcome because the outcome vocabulary is
   * what the retry policy keys on: an agent ending a conversation is a completed
   * call, not a failure to reach anybody, and classifying it as the latter would
   * feed the contact straight back into the roster for a redial.
   *
   * ── Why this exists at all, given the contract describes a socket frame ──────
   * It did not, and neither did the frame. Enumerated 2026-08-12: the station
   * socket carries exactly two `message` listeners for the duration of an attempt
   * — this file's borrowed-leg listener via `registerBrowserLegHandlers`
   * (`webrtc-bridge-manager.ts:975`), which acts only on `event === 'media'`, and
   * `agency.routes.ts`'s own, which acts only on `event === 'ping'`. **A `hangup`
   * frame fell off the end of both**, and core registered no HTTP route either, so
   * master's proxy 404'd. Both documented paths were dead and three comments said
   * otherwise.
   */
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

  /** Disarm the pre-bind grace — the station came back, or the attempt settled. */
  private clearUnboundStationGrace(sessionId: string): void {
    const timer = this.unboundStationGrace.get(sessionId);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.unboundStationGrace.delete(sessionId);
  }

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
    return {
      attempt_id: attemptId,
      campaign_id: live.cmd.campaignId,
      campaign_name: live.cmd.campaign.name,
      contact_id: live.cmd.contactId,
      phone_e164: live.cmd.contact.phone_e164,
      caller_id: live.cmd.callerId,
      attempt_number: live.cmd.attemptNumber,
      context: live.cmd.contact.context,
      prior_attempts: live.priors,
      bridged_at: live.bridgedAt ? live.bridgedAt.toISOString() : null,
      state: live.state,
    };
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
   * honestly give (§6.1).
   */
  private startLeaseRenewal(attemptId: string, sessionId: string, state: 'reserved' | 'on_call'): void {
    this.stopLeaseRenewal(attemptId);
    const leaseMs = state === 'on_call' ? AGENT_LEASE_MS.on_call : AGENT_LEASE_MS.reserved_dialing;
    const timer = setInterval(() => {
      void this.agents.renew(sessionId, state, leaseMs).then((ok) => {
        if (!ok) {
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
