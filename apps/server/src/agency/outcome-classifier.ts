import type { WebRtcCallStatus } from '@magick-agency/db/models/agency-call.model';
import type {
  AgencyAttemptOutcome,
  AgencyCampaignChangeReason,
  AgencyCampaignStatus,
  AgencyReleaseReason,
} from '@magick-agency/contracts/agency';

/**
 * Carrier/bridge terminal state → agency attempt outcome.
 *
 * Phase 1 cannot skip this even though retries are out of scope: without an
 * outcome a non-answered call never leaves `in_flight`, the contact is never
 * returned to the roster, and the campaign can never reach `completed` (which
 * requires zero outstanding contacts). Outcome classification is what makes a
 * campaign terminate at all.
 *
 * There is deliberately no path to `machine`. With AMD off (D1) the carrier
 * cannot tell us a human did not answer, so a call picked up by voicemail is
 * `connected` and the only signal it was a machine is the agent's disposition.
 * Inventing a `machine` outcome here would be a lie the retry engine would act on.
 *
 * ── `answered` AND `bridged`, as two parameters (pilot 2026-09-08) ──────────
 *
 * This function used to take one `bridged` flag, and **every caller fed it the
 * carrier's `answered`** — `agency-dialer.ts`'s `ended` handler passed
 * `bridged: ev.answered` verbatim. The two are genuinely different facts (the
 * whole abandonment definition is the gap between them) and conflating them was
 * wrong in BOTH directions, which is why the 2026-09-08 pilot's "33 bridged /
 * 32% bridge rate" is unreadable rather than merely imprecise:
 *
 *   1. a ring the agent cancelled (`status: 'canceled'`, never answered) had
 *      `bridged: false` and fell to the `canceled` arm's `abandoned` — ~19
 *      phantom abandoned rows, calls no customer ever picked up;
 *   2. a call the customer answered and that never reached an agent
 *      (`status: 'completed'`, `answered: true`, no bridge — the VoiceLink
 *      ring-cancel shape traced on callId `064836f1-8915-49f8-9c5a-c741f3cdd2af`)
 *      had `bridged: true` and came out `connected`, and was billed as a
 *      conversation nobody had.
 *
 * So the parameters are now separate and **both are required**: an optional
 * `answered` would let exactly the old call site compile unchanged, and the
 * compiler is the only thing that can force a caller to think about which fact
 * it holds. `bridged` must come from the bridge's own `bridged_at` stamp
 * (`live.bridgedAt !== null` at the dial site), never re-derived from a status.
 *
 * ── It now AGREES with the SQL abandonment predicate ────────────────────────
 *
 * `ABANDONED_ATTEMPT_PREDICATE_SQL` (`abandonment-predicate.ts:44`) is
 * `answered_at IS NOT NULL AND (… OR bridged_at IS NULL OR …)`, i.e. **answered
 * and not bridged**. Both status arms below now spell exactly that, so the label
 * in `agency_call_attempts.outcome` and the row set the compliance query selects
 * finally say the same thing about the same attempt. Previously the label
 * disagreed with the table in both directions at once.
 *
 * ⚠️ **This moves no metric, and that is deliberate.** The compliance numerator
 * is incremented off `isAbandonedAttempt` (`abandonment-predicate.ts:100`) — the
 * predicate itself, deliberately not routed through this module — and not off
 * this function's return value, precisely because the label was never trustworthy
 * enough to key a regulated number on (see the `ended` handler's note at its
 * `agencyAbandonedTotal.inc` site). Case 1 above was already excluded from the
 * numerator by the predicate's `answeredAt === null` arm and case 2 was already
 * included by its `bridgedAt === null` arm, so `agency_abandoned_total` reads
 * identically before and after. What changes is the *outcome string*, and with it
 * which retry rule the contact gets and which sentence the agent is shown.
 */
/**
 * Bridge outcomes that mean **this platform ended the call**, as opposed to the
 * carrier or the far end.
 *
 * An ALLOW-LIST rather than a deny-list, deliberately: a carrier outcome nobody
 * has seen yet must not be mistaken for one of ours, because that direction of
 * error puts a real customer's decline on the our-fault ledger and redials them
 * on a bound they never spend. An unrecognised outcome falling to "not ours" is
 * the safe failure — it spends the customer's own allowance, which is what every
 * other unclassified teardown already does.
 *
 *  - `agent_hangup` — the agent dismissed the ringing panel (`hangupAttempt`).
 *  - `agent_disconnected` — their station socket dropped: `browserHangupOutcome`
 *    on both dial paths, and the pre-bind grace's own teardown. Listed for
 *    completeness only: it has its own attempt outcome and short-circuits above
 *    the status switch, so this set is never consulted for it. Kept so the set
 *    stays a truthful answer to "did we end this call" if that arm ever moves.
 *  - `ended_by_user` — `forceEndByUser`, a supervisor or an API caller.
 *  - `browser_hangup` — the non-agency browser dialer's own hangup.
 */
const LOCALLY_ENDED_OUTCOMES = new Set([
  'agent_hangup',
  'agent_disconnected',
  'ended_by_user',
  'browser_hangup',
]);

function isLocallyEndedOutcome(outcome?: string | null): boolean {
  return outcome != null && LOCALLY_ENDED_OUTCOMES.has(outcome);
}

export function classifyAttemptOutcome(opts: {
  status: WebRtcCallStatus;
  /** The bridge's own outcome string, e.g. `browser_hangup`, `no_answer`. */
  outcome?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  /**
   * Whether the CARRIER answered — the far end picked up. Says nothing about
   * whether an agent was ever attached; that is `bridged`.
   */
  answered: boolean;
  /** Whether the media legs ever actually bridged, from `bridged_at`. */
  bridged: boolean;
}): AgencyAttemptOutcome {
  const raw = `${opts.outcome ?? ''} ${opts.errorCode ?? ''} ${opts.errorMessage ?? ''}`.toLowerCase();

  // The agent's station socket dropping is its own outcome — it is not the
  // customer's fault and must not be retried as though the number were bad.
  if (opts.outcome === 'agent_disconnected') return 'agent_disconnected';
  if (opts.outcome === 'orphaned') return 'orphaned';
  // A teardown the SERVICE initiated is the same fact as the reaper's `orphaned`,
  // arriving under the bridge's own vocabulary instead. `webrtc-bridge-manager.ts`
  // settles every session it owns as `service_shutdown` on SIGTERM (`:315`),
  // `ws-static-call-manager.ts` does the same (`:1613`), and
  // `webrtc-call.repository.ts`'s stale sweep writes `stuck_active_call` (`:305`)
  // for a row whose owning replica died — all three sitting in the `system` arm
  // of `webrtcEndedBy`. Without this they fell through to the status switch and came
  // out `failed`, which is the customer's fault as far as the retry policy is
  // concerned: `failed` gets 2 attempts on the CUSTOMER's ledger, whereas
  // `orphaned` has an our-fault default and is routed to `resolveOurFaultRedial`
  // by the dial site — the whole point of `AD-P3-C-09` being that our restarts
  // must not retire contacts we never spoke to. `releaseMessageFor('orphaned')`
  // already reads "The call was interrupted by a service restart", i.e. the copy
  // for this case was written before the classifier could produce it.
  //
  // `max_duration_reached` is deliberately NOT here even though it shares the
  // `system` analytics dimension: that call happened, was answered and was billed
  // — it is a conversation we cut short, not one the platform lost.
  if (
    opts.outcome === 'service_shutdown'
    || opts.outcome === 'system_rebooted'
    || opts.outcome === 'stuck_active_call'
  ) {
    // ⚠️ ONLY before the bridge. A lifecycle interruption of a call that was
    // actually bridged is a CONVERSATION WE CUT SHORT, not one the platform lost
    // — the identical argument the `max_duration_reached` note directly above
    // makes, and this arm originally contradicted it.
    //
    // What it cost: `gracefulShutdown` settles every owned session
    // `service_shutdown`, so an ordinary deploy landing mid-conversation
    // classified `orphaned`. `orphaned` is `{delay_minutes: 0, max_attempts: 3}`
    // and `connected` is `{max_attempts: 0}`, so a customer we had just finished
    // speaking to was redialled immediately — up to three times — and the
    // disposition the agent owed was never asked for. Pre-bridge, `orphaned` is
    // exactly right and is the whole point of `AD-P3-C-09`: our restarts must not
    // spend a contact's allowance on a call they never received.
    if (opts.bridged) return 'connected';
    return 'orphaned';
  }
  // An abandoned call (`AD-P2-C-05`) MUST short-circuit here, and this line is
  // load-bearing rather than defensive. `abandonAnsweredCall` hangs the customer
  // up itself, so the teardown it produces can carry either terminal status, and
  // it is answered-but-unbridged by construction — meaning the arms below would
  // reach the same verdict for it now that they read `answered` separately. It
  // stays because it is the one path that KNOWS, rather than infers, that no agent
  // was there: it survives a `bridged_at` written by a bind that raced the
  // apology, and it keeps the outcome stable if either status arm is ever changed.
  if (opts.outcome === 'abandoned') return 'abandoned';

  // An unroutable / unallocated number is permanently bad. It is classified apart
  // from `failed` because the retry policy treats it as terminal (max_attempts 0)
  // — retrying a number that does not exist burns caller-ID reputation for nothing.
  if (isInvalidNumber(raw)) return 'invalid';

  switch (opts.status) {
    case 'no_answer':
      return 'no_answer';
    case 'busy':
      return 'busy';
    case 'completed':
      // Bridged ⇒ a human (or a machine — we cannot tell, D1) was on the line.
      if (opts.bridged) return 'connected';
      // Answered, never bridged: a customer who spoke to nobody. This is the
      // `064836f1` shape — a cancel that VoiceLink could not act on, so the phone
      // kept ringing, the customer picked up, and the relay opened into a console
      // the agent had already dismissed. It ends `completed` with real talk time,
      // so status and duration both read "connected"; only the missing
      // `bridged_at` says otherwise, and it is the same fact the SQL predicate
      // reads. Being `abandoned` is also what makes master zero-charge it
      // (`AGENCY_NON_CONNECTED_OUTCOMES`) instead of billing the flat rate.
      return opts.answered ? 'abandoned' : 'no_answer';
    case 'canceled':
      if (opts.bridged) return 'connected';
      if (opts.answered) return 'abandoned';
      // ── `canceled` the STATUS is not `canceled` the ATTEMPT OUTCOME ─────────
      //
      // The status only says the call ended without a pickup. WHO ended it is in
      // `opts.outcome`, and the two cases want opposite ledgers:
      //
      //  * WE stopped it (the agent dismissed the ring, their station dropped, a
      //    supervisor hung it up) — nobody was reached and nothing was learned
      //    about the number, so it must not spend the customer's `attempt_count`.
      //    That is the our-fault ledger, and `'canceled'` is its outcome.
      //  * THE FAR END stopped it — VoiceLink maps `reject`, `declin*` and SIP
      //    487 onto `{status: 'canceled', outcome: 'canceled'}`. A decline IS
      //    information about the number: they are screening. It belongs on the
      //    customer's ledger, and calling it our fault would redial a screening
      //    customer indefinitely on a bound they never consume.
      //
      // This arm used to return `'canceled'` for both, which inverted the second
      // case — and on VoiceLink specifically that is the more common one, because
      // `cancelRinging` is false there, so a local cancel often does NOT produce a
      // carrier `canceled` at all while a far-end 487 always does.
      //
      // Declines classify `no_answer`: they did not answer, it is the customer's
      // ledger, and its policy (retry later, a few times) is the right treatment
      // for a number that is screening right now. `AgencyAttemptOutcome` has no
      // `rejected` member and adding one is a three-repo change plus the fixture.
      return isLocallyEndedOutcome(opts.outcome) ? 'canceled' : 'no_answer';
    case 'failed':
    default:
      return 'failed';
  }
}

/**
 * Carrier signals for a number that will never be reachable. Deliberately
 * conservative: a false `invalid` permanently suppresses a real customer, which
 * is far worse than one wasted retry, so anything ambiguous stays `failed`.
 */
function isInvalidNumber(raw: string): boolean {
  return (
    raw.includes('invalid')
    || raw.includes('unallocated')
    || raw.includes('not in service')
    || raw.includes('no_route')
    || raw.includes('no route')
    || raw.includes('unobtainable')
  );
}

/**
 * Attempt outcome → the `released` frame's reason.
 *
 * Every outcome must map to something the console can render copy for. The
 * mapping is total by construction: a `released` with no reason blanks the
 * agent's panel with no explanation, and an agent whose screen clears silently
 * concludes the app is broken.
 *
 * ── `canceled` reuses `connected`'s arm, and gets NO reason of its own ──────
 *
 * {@link AgencyReleaseReason} deliberately gains no `canceled` member, because
 * there is no agent to explain a cancelled ring TO. Under
 * `agency_late_binding` the agent's console is never shown a ringing dial at all,
 * so a pre-answer cancel is announced to nobody — the `ended` arm suppresses the
 * whole `released` frame when no panel was ever delivered. With the flag off, the
 * only thing that cancels a ring is the agent's own hangup, and `agent_hangup`
 * already carries copy for exactly that ("You ended the call."). A new reason
 * would therefore be a fifth mirror (`docs/reference/magickvoice-platform/agency.md` §6.2 — core's union, master's
 * mask allow-list, cusui's union, `releaseMessageFor`) bought for a frame that
 * either is not sent or already reads correctly.
 *
 * The `completed` fallback covers the residual case — a supervisor stop or a
 * campaign pause landing mid-ring with the flag off. "Call ended." is true and
 * uninformative, which is the right trade against inventing copy for a state the
 * agent was not watching.
 */
export function releaseReasonFor(
  outcome: AgencyAttemptOutcome | null,
  opts: { agentHungUp?: boolean } = {},
): AgencyReleaseReason {
  switch (outcome) {
    case 'connected':
    case 'canceled':
      return opts.agentHungUp ? 'agent_hangup' : 'completed';
    case 'no_answer':
      return 'no_answer';
    case 'busy':
      return 'busy';
    case 'invalid':
      return 'invalid';
    case 'abandoned':
      return 'abandoned';
    case 'agent_disconnected':
      return 'agent_disconnected';
    case 'orphaned':
      return 'orphaned';
    case 'machine':
    case 'failed':
      return 'failed';
    default:
      // No outcome recorded at all — the attempt never got far enough to have one.
      return 'reservation_expired';
  }
}

/**
 * Whether the agent is expected to disposition this release.
 *
 * Two conditions, and the second is easy to miss. **Only a call that actually
 * reached the agent is theirs to describe** — prompting for a disposition on a
 * number that rang out trains agents to click through the dialog without reading
 * it, which poisons the data the retry engine uses. **And there must be something
 * to submit:** a campaign with an empty `disposition_catalog` has no codes to pick,
 * so requiring one is a dead end — the console would show a form with no options
 * and block the agent's return to the pool behind it, and wrap-up would hold
 * forever on a demand that cannot be satisfied.
 *
 * The catalog argument is optional so a caller with no campaign in hand keeps the
 * pre-Phase-2 answer; pass it wherever the campaign is available.
 */
export function requiresDisposition(
  outcome: AgencyAttemptOutcome | null,
  dispositionCatalog?: readonly unknown[] | null,
): boolean {
  if (outcome !== 'connected') return false;
  return dispositionCatalog === undefined || (dispositionCatalog?.length ?? 0) > 0;
}

/**
 * Fallback copy for a campaign-state change. Same posture as
 * {@link releaseMessageFor}: the console should prefer its own per-reason copy,
 * but an agent must never be shown a blank idle screen with no explanation.
 */
export function campaignMessageFor(reason: AgencyCampaignChangeReason): string {
  switch (reason) {
    case 'list_exhausted': return 'This campaign has finished — there are no more contacts to call.';
    case 'paused_by_supervisor': return 'A supervisor paused this campaign.';
    case 'stopped_by_supervisor': return 'A supervisor stopped this campaign.';
    case 'auto_paused': return 'This campaign was paused automatically.';
    case 'resumed': return 'The campaign has resumed — calls will start again shortly.';
    case 'started': return 'The campaign is running.';
    default: return 'The campaign status changed.';
  }
}

/**
 * Why a campaign that just changed status changed it, from the row alone.
 *
 * **`paused` is the whole reason this exists.** A supervisor pause and the
 * `AD-P4-C-02` abandonment guardrail both write `status = 'paused'`, and they are
 * opposite messages to an agent: one is a person deciding, the other is a
 * regulatory stop the campaign will not leave until a human resumes it.
 * {@link AgencyCampaignChangeReason} was declared with both arms from the start;
 * the guardrail shipped without anything selecting between them, so every
 * compliance stop announced itself as a supervisor's doing.
 *
 * Pure and total over the record, so the pacing tick — which is the only thing
 * that observes the transition — does not have to hold the vocabulary itself, and
 * so this can be exercised without an engine.
 *
 * `pause_reason` is read, not `paused_at`: a supervisor pause stamps that too.
 */
export function campaignChangeReasonFor(campaign: {
  status: AgencyCampaignStatus;
  pause_reason: string | null;
}): AgencyCampaignChangeReason {
  if (campaign.status === 'running') return 'resumed';
  if (campaign.status !== 'paused') return 'stopped_by_supervisor';
  // Any pause we did not attribute to a supervisor is one the platform made. The
  // default deliberately falls to `paused_by_supervisor` only on the explicit
  // `'supervisor'` value, so a `pause_reason` added later without a matching arm
  // here degrades to "paused automatically" — vague but true — rather than to a
  // confident claim that a person did it.
  return campaign.pause_reason === 'supervisor' ? 'paused_by_supervisor' : 'auto_paused';
}

/** Whether the engine will still produce calls in a given campaign status. */
export function isDialingStatus(status: AgencyCampaignStatus): boolean {
  return status === 'running';
}

/** Fallback copy, used only for a reason the console does not recognise. */
export function releaseMessageFor(reason: AgencyReleaseReason): string {
  switch (reason) {
    case 'completed': return 'Call ended.';
    case 'agent_hangup': return 'You ended the call.';
    case 'remote_hangup': return 'The customer hung up.';
    case 'no_answer': return 'No answer.';
    case 'busy': return 'Line busy.';
    case 'failed': return 'The call could not be completed.';
    case 'invalid': return 'That number is not reachable.';
    case 'abandoned': return 'The call was answered but could not be connected to you.';
    case 'agent_disconnected': return 'Your connection dropped, so the call was ended.';
    case 'reservation_expired': return 'The call was cancelled before it was placed.';
    case 'campaign_paused': return 'The campaign was paused.';
    case 'campaign_stopped': return 'The campaign was stopped.';
    case 'supervisor_released': return 'A supervisor released this call.';
    case 'orphaned': return 'The call was interrupted by a service restart.';
    default: return 'The call ended.';
  }
}
