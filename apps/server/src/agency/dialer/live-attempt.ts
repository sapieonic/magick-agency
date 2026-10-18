/**
 * The record the dialer keeps for an attempt it is driving, and the two pure
 * questions asked of it: what the agent's panel shows, and whether the agent has
 * ever been shown the call. Split out of `agency-dialer.ts`, which re-exports
 * nothing from here: these are the dialer's own internals.
 */
import type {
  AgencyAbandonReason,
  AgencyAttemptState,
  AgencyPriorAttempt,
  AgencyReservedAttempt,
} from '@magick-agency/contracts/agency';
import type { DialCommand } from '../dial-dispatcher.js';

/** An attempt this replica is currently driving, and what a reconnect needs to know. */
export interface LiveAttempt {
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
   * settle site.
   *
   * Set here rather than re-derived below because the three causes are only
   * distinguishable in the instant they happen: by the time the attempt settles,
   * "the station was gone before we reached for it", "the send was refused" and
   * "the bridge refused the bind" all look identical — no socket and no bridge.
   * That collapse is exactly what made a bind failure indistinguishable from a
   * genuine no-agent abandonment in the one series that counts them.
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
   * instant the table does. Null until the carrier answers.
   */
  answeredAt: Date | null;
  /** Fetched once at dial; replayed unchanged so a resumed panel is identical. */
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
 * ask behind `FF_AGENCY_LATE_BINDING`: a ringing popup is one agents dismiss
 * (and, on VoiceLink, dismiss without cancelling anything).
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
export function isUnannounced(live: LiveAttempt): boolean {
  return live.lateBinding && !live.panelDelivered;
}

/**
 * The agent's panel for an attempt: everything the console shows about the call.
 * Built once at dial time (see `LiveAttempt.panel`) and reused for the resume.
 */
export function buildPanel(cmd: DialCommand, priors: AgencyPriorAttempt[]): AgencyReservedAttempt {
  return {
    attempt_id: cmd.attemptId,
    campaign_id: cmd.campaignId,
    campaign_name: cmd.campaign.name,
    contact_id: cmd.contactId,
    phone_e164: cmd.contact.phone_e164,
    caller_id: cmd.callerId,
    attempt_number: cmd.attemptNumber,
    context: cmd.contact.context,
    prior_attempts: priors,
  };
}
