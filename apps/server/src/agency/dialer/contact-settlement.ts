/**
 * The contact's fate when an attempt ends: which ledger the attempt is charged to,
 * and what the retry policy then makes of the contact. The last durable step of
 * the dialer's `ended` arm (`AgencyDialer.recordEndedAttempt`), split out of
 * `agency-dialer.ts`; its log lines keep the dialer's component name.
 */
import { createChildLogger } from '@magick-agency/observability';
import type { AgencyAttemptOutcome } from '@magick-agency/contracts/agency';
import { agencyOurFaultRetirementTotal } from '@magick-agency/observability/metrics/agency';
import { agencyContactRepository } from '../../db/repositories/agency.repository.js';
import type { DialCommand } from '../dial-dispatcher.js';
import { resolveOurFaultRedial, resolveRetryDecision } from '../retry-policy.js';

const log = createChildLogger({ component: 'agency-dialer' });

/**
 * Route the contact of an ended attempt. `needsDisposition` is the `ended` arm's
 * one answer to "is a disposition owed"; `bridgedAt` is the dialer's in-process
 * bridge stamp (`LiveAttempt.bridgedAt`).
 */
export async function settleContact(
  cmd: DialCommand,
  outcome: AgencyAttemptOutcome,
  needsDisposition: boolean,
  bridgedAt: Date | null,
): Promise<void> {
  // ── Our fault, before the bridge ─────────────────────────────────────────
  //
  // An agent's station socket dropping is OUR failure. If it happened before
  // the call bridged, the customer was never spoken to — their phone may not
  // even have been answered — so charging it to `attempt_count` retires
  // someone we never reached, and with `max_attempts: 3` three dropped sockets
  // do it silently, behind a plausible audit trail.
  //
  // The reaper has held the opposite principle from the start: it requeues a
  // crash-orphaned contact with NO bump, because "our crash must not consume
  // the customer's retry allowance". Same category of fault, so the same
  // handling: this is that principle applied in the second place rather than a
  // new rule invented here.
  //
  // ⚠️ The gate is `bridgedAt`, NOT `answeredAt`. A call the customer picked up
  // and that never bridged to an agent is an ABANDONED call — already its own
  // outcome, already counted against the compliance rate, and it must keep
  // being charged. Widening this to "never answered" would quietly zero the
  // abandonment ledger's retry consequences.
  //
  // `bridgedAt` is in-process and that is sound here for the same reason
  // the abandonment counter above relies on it: this handler returned early
  // unless `liveByAttempt` held the attempt, so we are by construction the
  // replica that watched both phases. The path with no live record at all is
  // the reaper's, which charges its own our-fault ledger.
  //
  // ── `canceled` joins the same ledger ────────────────────────────────────
  //
  // A dial we stopped before anyone picked up is not a *failure* on our side,
  // and it is not the customer's doing either — it is entirely OUR decision,
  // and it tells us nothing at all about the number. Charging it to
  // `attempt_count` retires someone we never spoke to, and at
  // `max_attempts: 3` three cancelled rings do it silently: exactly the
  // dropped-socket shape above, arriving through a different door.
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
   * QUESTION rather than a settled one**.
   *
   * The case for leaving it here is on the test that holds it
   * (`canceled-outcome-ledger.test.ts`, the ring-cancel shape): the customer
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
    && bridgedAt === null;
  if (outcome === 'connected' && needsDisposition) {
    await agencyContactRepository.markState(cmd.contactId, 'connected', {
      last_outcome: outcome, bump_attempt: true,
    });
  } else if (ourFaultBeforeBridge) {
    // Charged to the SEPARATE ledger. `attempt_count` is untouched, and the
    // bound below is what keeps that safe rather than free: without it, one
    // flapping agent workstation redials the
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
     * The our-fault ledger's bound is an unresearched placeholder
     * (`OUR_FAULT_REDIAL_BOUND`), and without this counter **nothing anywhere shows
     * a contact retired by it** — a real person permanently removed from the list
     * because of our dropped sockets and cancelled dials, invisible in every view.
     * This is that surface.
     *
     * ⚠️ **AFTER the `markState` above, never before.** Incremented on the
     * decision, a rejected write would report a permanently retired contact that
     * was still pending. This
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
}
