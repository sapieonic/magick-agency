import type { AgencyRetryPolicy } from '../db/models/agency.model.js';
import type { AgencyAttemptOutcome, AgencyContactState } from '@magick-agency/contracts/agency';

/**
 * ─── AGENCY DIALER — THE OUTCOME RETRY POLICY (§2.4, `AD-P3-C-01`) ───────────
 *
 * §2.4 fixes the precedence rule this module implements one half of:
 *
 * > a disposition's `retry`/`terminal`/`suppress` always overrides the outcome
 * > policy; the outcome policy applies only when no disposition was recorded —
 * > **every non-answered call, plus the reaper's `no_disposition`**.
 *
 * **This module is the outcome half only.** The disposition half is `AD-P3-C-02`,
 * and it *wins* where both apply — so nothing here may be written in a way that a
 * disposition cannot override.
 *
 * Pure: no clock beyond an injected `now`, no I/O, no repository. `now` is a
 * parameter rather than `new Date()` because a delay computed off an ambient clock
 * cannot be asserted with an exact value, and §16.6 wants exact values on anything
 * clock-derived.
 *
 * There is deliberately **no `machine` key** anywhere here. With AMD off (D1) the
 * system can never classify an outcome as `machine`: a call answered by voicemail is
 * `outcome='connected'`, and the only signal it was a machine is the agent's
 * disposition. Voicemail retry is therefore disposition-driven and belongs to C-02.
 */

/**
 * Core's built-in outcome policy — §2.4's block, verbatim.
 *
 * ⚠️ **This default is load-bearing, and shipping without it would have made the
 * whole ticket inert.** `agency_campaigns.retry_policy` is `JSONB NOT NULL DEFAULT
 * '{}'` (migration 072) and **nothing in either repo seeds it** — core's `create`
 * COALESCEs a missing value to `'{}'` and master never sends the field at all. So
 * the empty policy is the *ordinary* case, not an edge case, and reading an absent
 * key as "no retry" would mean every campaign in existence retries nothing while
 * every test that passed an explicit policy stayed green. That is the
 * `heartbeat()`-with-zero-callers shape: correct-looking code, green suite, dead in
 * production.
 *
 * The precedent for resolving it this way is already in the codebase — migration
 * 078's `break_reasons` is documented as *"Empty ⇒ core's built-ins"* — so an
 * absent key falling back to the documented default is the house convention rather
 * than an invention here.
 *
 * Fallback is **per key**, not all-or-nothing: a campaign that configures only
 * `busy` still gets the defaults for the rest. An operator who genuinely wants an
 * outcome never retried writes `max_attempts: 0`, exactly as §2.4's own block does
 * for `invalid` and `connected`.
 */
export const DEFAULT_RETRY_POLICY: AgencyRetryPolicy = {
  no_answer: { delay_minutes: 60, max_attempts: 3 },
  busy: { delay_minutes: 15, max_attempts: 4 },
  failed: { delay_minutes: 120, max_attempts: 2 },
  abandoned: { delay_minutes: 5, max_attempts: 2 },
  // Never retried: a bad number does not become good, and a connected call is
  // terminal unless the agent's disposition says otherwise (C-02).
  invalid: { max_attempts: 0 },
  connected: { max_attempts: 0 },
  // ── `AD-P3-C-09` / MAG-97: OUR faults get defaults too ───────────────────
  //
  // Both of these are genuinely produced — `agency-dialer.ts` settles an agent's
  // dropped station socket `agent_disconnected`, and `reaper.ts` writes
  // `orphaned` for an attempt its owning replica died holding — and both used to
  // be ABSENT here. An absent key falls to `no_policy_for_outcome`, which marks
  // the contact `completed`: a customer nobody ever spoke to, retired by our own
  // network fault or our own restart.
  //
  // Leaving them absent and requiring an operator to configure the key is the
  // failure mode this file's header already warns about one paragraph up. Master
  // never sends `retry_policy` at all, so `{}` is the ordinary case — a fix that
  // only works when a key is set would be green in every configured test and
  // inert on every real campaign.
  //
  // ⚠️ These caps are the CUSTOMER's allowance and apply only to an attempt that
  // actually reached them (a drop *after* bridging). An our-fault drop *before*
  // the bridge is not charged here at all — it goes to {@link resolveOurFaultRedial}
  // and the separate `our_fault_attempts` ledger, so no operator retry rule can
  // spend a customer's allowance on our failure.
  agent_disconnected: { delay_minutes: 5, max_attempts: 3 },
  orphaned: { delay_minutes: 0, max_attempts: 3 },
  // ── `canceled` — A FAIL-SAFE, NOT A LIVE RULE (pilot 2026-09-08) ─────────
  //
  // ⚠️ **Read this before treating the entry below as a peer of the two above
  // it.** Those are live: an `agent_disconnected` after bridging and an
  // `orphaned` from the reaper both reach {@link resolveRetryDecision}, which
  // reads this table. **No live path reads these two numbers.** Traced, because
  // the routing is not obvious from either function alone:
  //
  //   * `agency-dialer.ts`'s `ended` handler sends `canceled` to
  //     {@link resolveOurFaultRedial} and the `our_fault_attempts` ledger — a
  //     dial we stopped is our decision, not the customer's failure to answer —
  //     and the gate's other half (`bridgedAt === null`) is satisfied *by
  //     construction*, since the classifier returns `connected` for any bridged
  //     teardown whatever its status. So that branch always takes it; there is no
  //     `canceled` path to `resolveRetryDecision` from the dial site at all.
  //   * {@link resolveOurFaultRedial} then consults **only the campaign's own**
  //     `policy?.[outcome]` — for a stricter cap and for the delay — and falls
  //     back to {@link OUR_FAULT_REDIAL_BOUND} and
  //     {@link DEFAULT_OUR_FAULT_REDIAL_DELAY_MINUTES}. It never reads this table,
  //     so neither number below is its fallback.
  //   * the only other reader, the reaper's lapsed-wrap-up sweep, selects
  //     `outcome = 'connected'` in SQL (`agency.repository.ts`
  //     `findLapsedWrapups`), so it cannot see this outcome either.
  //
  // **THE LIVE LEVER IS THE CAMPAIGN KEY**, `retry_policy.canceled`, which
  // `resolveOurFaultRedial` does read and which can only lower the bound
  // (`min(configured, OUR_FAULT_REDIAL_BOUND)`) — never raise it.
  // `campaign-config.ts`'s `RETRY_POLICY_OUTCOMES` accepts it for that reason.
  //
  // So why keep it? Because the two failure modes are not symmetric. An unread
  // key is inert. An ABSENT key is `no_policy_for_outcome` → `contactState:
  // 'completed'` — the trap this file's own header names one screen up, "a
  // customer nobody ever spoke to, retired by our own network fault". If the
  // our-fault gate at the dial site is ever narrowed, or a second settle path
  // starts producing `canceled`, that retirement arrives **silently**: no error,
  // a plausible audit trail, and a real person who was never reached taken off
  // the list for good. The entry costs nothing and closes that.
  //
  // ── Why this is not the `machine` case ───────────────────────────────────
  //
  // This file argues the opposite way about `machine` — deliberately no key at
  // all — and the distinction is which kind of silence each absence buys.
  // `machine` is **unproducible**: with AMD off (D1) nothing can classify an
  // outcome as `machine`, so a key would be dead configuration that looks live,
  // and its absence costs nothing because the lookup never happens. `canceled`
  // is produced **constantly** and merely routed elsewhere, so its absence is a
  // live lookup away from retiring customers. Same table, opposite answers, for
  // the reason that decides both: whether the outcome can occur.
  //
  // The values, if it is ever read: `orphaned`'s shape, for `orphaned`'s reason.
  // Nobody was reached, so nothing about the number has been learned and there is
  // nothing to wait out — a delay would penalise a contact that has not been
  // dialled in any sense the customer could notice.
  canceled: { delay_minutes: 0, max_attempts: 3 },
};

/**
 * ─── THE OUR-FAULT REDIAL BOUND (`AD-P3-C-09` criterion 3) ──────────────────
 *
 * How many times OUR OWN failures may put one contact's number back on the
 * roster. Deliberately a module constant and **not** a campaign setting.
 *
 * The reasoning is the whole point of the bound: skipping the attempt charge for
 * an our-fault drop is what stops us retiring customers we never reached, but on
 * its own it makes our-fault redials **free** — one persistently broken agent
 * workstation would redial the same number without limit, which is regulated.
 * The bound is what makes the skip safe.
 *
 * ⚠️ **A limit an operator can raise is not a limit.** This is enforced BELOW the
 * retry policy: {@link resolveOurFaultRedial} checks it before consulting any
 * configuration, and a policy may only lower it. That asymmetry is deliberate —
 * an operator who wants to be *more* cautious than the platform should be able
 * to, and one who wants to be less cautious than a repeat-dial regulation should
 * not.
 *
 * ── ⚠️ WHY 3: it is a placeholder, and saying so is the point ───────────────
 *
 * **This number is NOT derived from any regulation.** Nobody has yet established
 * which repeat-dial rule binds this product, in which jurisdictions, or what it
 * caps. `3` was chosen for two weak reasons, both stated plainly so neither is
 * mistaken for research:
 *
 *   1. it matches `DEFAULT_RETRY_POLICY`'s customer-facing `max_attempts` for the
 *      common outcomes, so our-fault redials cannot exceed the customer's own
 *      allowance and the total dial count for one contact stays intuitively
 *      bounded by roughly double it rather than by something unbounded;
 *   2. it is small enough that being wrong is conservative — the failure mode of
 *      too low is a contact retired early with `our_fault_bound_reached` in its
 *      `last_outcome`, which is visible and auditable, while the failure mode of
 *      too high is repeat-dialling a real person.
 *
 * **Revisit before the pilot dials a real customer list**, and replace this
 * comment with the actual rule and its citation. A bare number on a regulated
 * limit becomes a fact by age: the next reader assumes someone checked. Nobody
 * has. If the real cap turns out to be lower, this constant is the only line that
 * changes — which is the other reason the bound is not spread across config.
 */
export const OUR_FAULT_REDIAL_BOUND = 3;

/** Delay before an our-fault redial when the policy names none. */
export const DEFAULT_OUR_FAULT_REDIAL_DELAY_MINUTES = 5;

/** Why a contact landed where it did — readable by a log line and a test alike. */
export type RetryReason =
  /** Policy allows another attempt; `nextAttemptAt` is set. */
  | 'retry_scheduled'
  /** `attemptsUsed >= max_attempts` with a positive max — we tried and ran out. */
  | 'max_attempts_reached'
  /** `max_attempts: 0` — this outcome is never retried, so nothing was "used up". */
  | 'outcome_not_retryable'
  /** An unreachable number. Suppressed rather than exhausted (§5.3). */
  | 'invalid_number'
  /** No policy entry and no built-in default — an outcome §2.4 does not model. */
  | 'no_policy_for_outcome'
  /**
   * `AD-P3-C-09`: our own failures have redialled this contact as many times as
   * {@link OUR_FAULT_REDIAL_BOUND} permits. Distinct from `max_attempts_reached`
   * because the customer's allowance is UNTOUCHED — we simply may not keep
   * dialling one number to work around a fault on our side.
   */
  | 'our_fault_bound_reached';

/** What the policy says happens to the contact now this attempt is over. */
export interface RetryDecision {
  /** Where the contact goes. */
  contactState: AgencyContactState;
  /** When it may be dialed again, or null when nothing will re-dial it. */
  nextAttemptAt: Date | null;
  /**
   * Written to `agency_contacts.suppressed_reason`, or null.
   *
   * Only ever set alongside `contactState: 'suppressed'`. Note migration 073's
   * column comment lists `max_attempts` as a possible value, but §5.3's state
   * diagram makes running out of attempts its own STATE (`exhausted`) and reserves
   * `suppressed` for *"DNC / invalid / manual"*. The state carries that fact, so
   * writing the reason too would put one fact in two columns that can disagree.
   * The enum value in that comment is unused; the diagram wins.
   */
  suppressedReason: 'invalid' | 'dnc' | null;
  reason: RetryReason;
}

/**
 * Evaluate a finished attempt against its campaign's outcome retry policy.
 *
 * @param policy   the campaign's `retry_policy`; `null`/`{}`/a missing key all fall
 *                 back to {@link DEFAULT_RETRY_POLICY} per key.
 * @param outcome  how the attempt finished.
 * @param now      injected clock — the base for `nextAttemptAt`.
 * @param attemptsUsed **attempts consumed INCLUDING the one that just finished.**
 *
 * ⚠️ `attemptsUsed` is the parameter to get wrong, and it is off by one in opposite
 * directions at the two call sites, so it is the caller's job to normalise rather
 * than this function's to guess:
 *
 *   - the **dial path** bumps `agency_contacts.attempt_count` as part of ending the
 *     attempt, so it must pass the **post-bump** count;
 *   - the **reaper's lapsed-wrap-up path** does not bump (the attempt was counted
 *     when it ended), so the stored count is already correct.
 *
 * Passing a pre-bump count from the dial path would grant every contact exactly one
 * extra dial — over the configured `max_attempts`, invisibly, on a compliance-
 * sensitive product.
 */
export function resolveRetryDecision(
  policy: AgencyRetryPolicy | null,
  outcome: AgencyAttemptOutcome | null,
  now: Date,
  attemptsUsed: number,
): RetryDecision {
  // An unreachable number is suppressed regardless of what any policy says, and
  // BEFORE the attempts arithmetic: §5.3 routes `invalid` to `suppressed`, not to
  // `exhausted`, because "this number does not work" and "we ran out of tries" are
  // different facts to an operator cleaning a list.
  if (outcome === 'invalid') {
    return {
      contactState: 'suppressed',
      nextAttemptAt: null,
      suppressedReason: 'invalid',
      reason: 'invalid_number',
    };
  }

  const rule = (outcome ? policy?.[outcome] : undefined) ?? (outcome ? DEFAULT_RETRY_POLICY[outcome] : undefined);

  // An outcome §2.4 does not model, or none at all. `completed` rather than
  // `pending`: a contact left `pending` with no scheduled retry is claimable
  // immediately and would be re-dialed in a tight loop, and one left `in_flight`
  // blocks its campaign from ever completing.
  if (!rule) {
    return {
      contactState: 'completed', nextAttemptAt: null, suppressedReason: null,
      reason: 'no_policy_for_outcome',
    };
  }

  const maxAttempts = Number.isFinite(rule.max_attempts) ? Math.max(0, Math.trunc(rule.max_attempts)) : 0;

  // `max_attempts: 0` is "never retried", which is NOT the same fact as having run
  // out — nothing was used up. Kept distinct because `exhausted` tells a supervisor
  // the list was worked and `completed` tells them it was not retryable, and
  // conflating them makes a dashboard lie in one direction or the other.
  if (maxAttempts === 0) {
    return {
      contactState: 'completed', nextAttemptAt: null, suppressedReason: null,
      reason: 'outcome_not_retryable',
    };
  }

  if (attemptsUsed >= maxAttempts) {
    return {
      contactState: 'exhausted', nextAttemptAt: null, suppressedReason: null,
      reason: 'max_attempts_reached',
    };
  }

  // A missing `delay_minutes` means "as soon as the roster reaches it" — 0, not a
  // fabricated default. `claimDialable`'s predicate is `next_attempt_at <= now()`,
  // so this is re-claimable on the very next tick, which is §4.2's stated behaviour
  // for a retry with no delay.
  const delayMinutes = Number.isFinite(rule.delay_minutes) ? Math.max(0, rule.delay_minutes!) : 0;
  return {
    contactState: 'pending',
    nextAttemptAt: new Date(now.getTime() + delayMinutes * 60_000),
    suppressedReason: null,
    reason: 'retry_scheduled',
  };
}

/**
 * Decide what happens to a contact whose attempt died of OUR fault before it ever
 * reached them (`AD-P3-C-09`, MAG-97).
 *
 * Applies to an agent's station socket dropping with `bridged_at IS NULL`, to the
 * reaper requeueing an attempt its owning replica died holding, and — since the
 * 2026-09-08 pilot — to a `canceled` attempt: a dial WE stopped before anyone
 * picked up. In all three the customer was never spoken to, so this function is
 * the one place that decides how many times our own failures may put their
 * number back on the roster.
 *
 * The third case is the one whose classification as "our fault" is a judgement
 * rather than a fact, so it is recorded here as well as at the gate that makes
 * it: a cancelled ring is not a *failure* on our side, but it is entirely OUR
 * decision, and it tells us nothing whatever about the contact. Charging it to
 * `attempt_count` would retire someone we never spoke to on three cancels —
 * which is also why the un-charged path is the more conservative one on
 * repeat-dialling, not the more permissive one: {@link OUR_FAULT_REDIAL_BOUND}
 * is a ceiling an operator cannot raise, whereas `max_attempts` is one they can.
 *
 * ── The two ledgers, and why they must not be the same one ──────────────────
 *
 * `attemptsUsed` is NOT passed here. This function reads `ourFaultAttemptsUsed`
 * — `agency_contacts.our_fault_attempts`, a column that exists precisely so our
 * failures cannot spend `attempt_count`. Keeping them separate is what makes
 * criterion 3's "independent of `max_attempts`" a structural property rather
 * than a naming convention: no arithmetic here can retire a customer, and no
 * `max_attempts` change can loosen the repeat-dial bound.
 *
 * ── The bound is checked BEFORE the policy, deliberately ────────────────────
 *
 * A regulated repeat-dial limit an operator can raise is not a limit. So
 * {@link OUR_FAULT_REDIAL_BOUND} is a hard ceiling and a campaign's
 * `retry_policy` may only lower it — `min(configured, BOUND)`. An operator who
 * wants to be more cautious than the platform may be; one who wants to be less
 * cautious than the bound may not, and no configuration path exists that would
 * let them.
 *
 * @param policy   the campaign's `retry_policy`; consulted ONLY for a stricter
 *                 cap and for the delay. `null`/`{}`/a missing key are the
 *                 ordinary case — master never sends the field.
 * @param outcome  the our-fault outcome, used to find the policy entry.
 * @param now      injected clock — the base for `nextAttemptAt`.
 * @param ourFaultAttemptsUsed our-fault redials consumed INCLUDING this one.
 */
export function resolveOurFaultRedial(
  policy: AgencyRetryPolicy | null,
  outcome: AgencyAttemptOutcome | null,
  now: Date,
  ourFaultAttemptsUsed: number,
): RetryDecision {
  const configured = outcome ? policy?.[outcome]?.max_attempts : undefined;
  // `min`, never the configured value alone. A campaign asking for 10 gets the
  // bound; a campaign asking for 1 gets 1. Non-finite/absent config is ignored
  // rather than treated as 0, or a malformed policy would silently retire every
  // our-fault contact on its first drop.
  const effectiveBound = Number.isFinite(configured)
    ? Math.min(Math.max(0, Math.trunc(configured as number)), OUR_FAULT_REDIAL_BOUND)
    : OUR_FAULT_REDIAL_BOUND;

  if (ourFaultAttemptsUsed >= effectiveBound) {
    // Terminal and OBSERVABLE, not a silent stall (criterion 3). `exhausted`
    // rather than `completed` because the list was genuinely worked; the caller
    // writes `last_outcome` to the our-fault outcome, so a supervisor querying
    // `state = 'exhausted' AND last_outcome = 'agent_disconnected'` can separate
    // "we ran out of tries on the customer" from "we ran out of tolerance for our
    // own faults" — two different operational problems with the same state.
    //
    // Note `suppressedReason` stays null: §5.3 reserves `suppressed` for
    // DNC/invalid/manual, and putting a reason on a non-suppressed row would put
    // one fact in two columns that can disagree.
    return {
      contactState: 'exhausted',
      nextAttemptAt: null,
      suppressedReason: null,
      reason: 'our_fault_bound_reached',
    };
  }

  const configuredDelay = outcome ? policy?.[outcome]?.delay_minutes : undefined;
  const delayMinutes = Number.isFinite(configuredDelay)
    ? Math.max(0, configuredDelay as number)
    : DEFAULT_OUR_FAULT_REDIAL_DELAY_MINUTES;

  // Back on the roster. A real delay rather than `now` because the fault that
  // just killed this attempt — a flapping agent workstation, a replica crash-
  // looping — is very likely still present, and an immediate requeue would burn
  // the whole bound inside a few seconds and retire the contact for a fault that
  // would have cleared on its own.
  return {
    contactState: 'pending',
    nextAttemptAt: new Date(now.getTime() + delayMinutes * 60_000),
    suppressedReason: null,
    reason: 'retry_scheduled',
  };
}
