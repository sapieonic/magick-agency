import { describe, it, expect } from 'vitest';
import {
  DEFAULT_OUR_FAULT_REDIAL_DELAY_MINUTES,
  DEFAULT_RETRY_POLICY,
  OUR_FAULT_REDIAL_BOUND,
  resolveOurFaultRedial,
  resolveRetryDecision,
} from '../../../src/agency/retry-policy.js';

// ---------------------------------------------------------------------------
// The outcome retry policy.
//
// A pure function, so there is nothing to mock and every assertion is on the
// answer itself rather than on a call being made. Two things this file is
// deliberately built around:
//
// 1. **The empty policy is the ORDINARY case.** `agency_campaigns.retry_policy` is
//    `JSONB NOT NULL DEFAULT '{}'` and nothing in either repo seeds it, so the
//    fallback path is what production runs. Testing only explicit policies would
//    have left the shipped behaviour — retry nothing, ever — entirely unasserted
//    while the suite went green.
// 2. **Exact values on everything clock-derived.** `nextAttemptAt` is computed from
//    an injected `now`, so it is asserted as an exact instant. A `toBeGreaterThan`
//    here would pass on a delay of 15 minutes, 15 hours or a doubled clock.
// ---------------------------------------------------------------------------

/** A fixed instant, so every delay assertion is exact arithmetic. */
const NOW = new Date('2026-08-11T14:00:00.000Z');
const MIN = 60_000;

describe('the built-in default policy', () => {
  it('is the documented block, and models every outcome except `machine`', () => {
    // Pinned as a whole object. These numbers are a product decision an operator
    // inherits silently when they configure nothing, so a drift in any of them is a
    // change to how often a real customer's phone rings — not an implementation
    // detail. Asserting the whole shape also catches an ADDED key, which is how a
    // `machine` entry would creep back in.
    expect(DEFAULT_RETRY_POLICY).toEqual({
      no_answer: { delay_minutes: 60, max_attempts: 3 },
      busy: { delay_minutes: 15, max_attempts: 4 },
      failed: { delay_minutes: 120, max_attempts: 2 },
      abandoned: { delay_minutes: 5, max_attempts: 2 },
      invalid: { max_attempts: 0 },
      connected: { max_attempts: 0 },
      // Both were ABSENT, and their absence was the
      // defect: an unmodelled key falls to `no_policy_for_outcome` → `completed`,
      // which retired a customer whose attempt died of our own dropped socket or
      // our own restart. Campaigns that configure no `retry_policy` leave it empty, so that was the
      // ordinary path for every campaign, not an edge case.
      //
      // These caps are the CUSTOMER's allowance and bind only an
      // `agent_disconnected` that happened AFTER bridging — the customer was
      // reached, so the attempt was real. A drop before the bridge is charged to
      // the separate `our_fault_attempts` ledger and never reaches these numbers.
      agent_disconnected: { delay_minutes: 5, max_attempts: 3 },
      orphaned: { delay_minutes: 0, max_attempts: 3 },
      // `orphaned`'s shape for `orphaned`'s reason: nobody was reached,
      // so nothing has been learned about the number and there is nothing to wait
      // out. Pinned here like the rest even though no path reads these two
      // numbers today (the dial site sends `canceled` to the our-fault ledger
      // instead, and the reaper's sweep selects `outcome = 'connected'` only) —
      // because the value of the key is that it is PRESENT: an absent one falls
      // to `no_policy_for_outcome` → `completed`, retiring a customer nobody
      // spoke to, which is exactly that defect.
      canceled: { delay_minutes: 0, max_attempts: 3 },
    });
    // With AMD off the system can never classify an outcome as `machine`, so a
    // key for it would be dead configuration that looks live. Voicemail retry is
    // disposition-driven.
    expect(DEFAULT_RETRY_POLICY).not.toHaveProperty('machine');
  });
});

describe('the default applies when a campaign configures nothing', () => {
  // ── THE ASSERTION THAT KEEPS THE DEFAULT FROM BEING INERT ──────────────────
  // `retry_policy` defaults to `'{}'`, `create` COALESCEs a missing value to
  // `'{}'`, and campaigns that configure nothing never send the field. So if an absent key meant "no retry",
  // every campaign that exists would retry nothing while every test that passed an
  // explicit policy stayed green — the `heartbeat()`-with-zero-callers shape.
  for (const policy of [null, {}] as const) {
    it(`retries a no_answer on the built-in delay when the policy is ${JSON.stringify(policy)}`, () => {
      const decision = resolveRetryDecision(policy, 'no_answer', NOW, 1);
      expect(decision.contactState).toBe('pending');
      expect(decision.reason).toBe('retry_scheduled');
      expect(decision.nextAttemptAt).toEqual(new Date(NOW.getTime() + 60 * MIN));
    });
  }

  it('falls back PER KEY, so a partial policy keeps the defaults for the rest', () => {
    // An operator tuning only `busy` must not silently lose retries on every other
    // outcome. All-or-nothing fallback would do exactly that, and it would look like
    // a deliberate configuration rather than a bug.
    const partial = { busy: { delay_minutes: 1, max_attempts: 9 } };

    expect(resolveRetryDecision(partial, 'busy', NOW, 1).nextAttemptAt)
      .toEqual(new Date(NOW.getTime() + 1 * MIN));
    // `no_answer` is absent from `partial` → the built-in 60 minutes, not "no retry".
    expect(resolveRetryDecision(partial, 'no_answer', NOW, 1).nextAttemptAt)
      .toEqual(new Date(NOW.getTime() + 60 * MIN));
  });

  it('lets an operator disable an outcome explicitly with max_attempts: 0', () => {
    // The escape hatch that makes per-key fallback acceptable: "never retry busy" is
    // expressible, it just has to be said rather than implied by omission.
    const decision = resolveRetryDecision({ busy: { max_attempts: 0 } }, 'busy', NOW, 1);
    expect(decision.contactState).toBe('completed');
    expect(decision.reason).toBe('outcome_not_retryable');
    expect(decision.nextAttemptAt).toBeNull();
  });
});

describe('the attempts boundary', () => {
  const policy = { no_answer: { delay_minutes: 30, max_attempts: 3 } };

  it('retries below the max and exhausts exactly AT it', () => {
    // The off-by-one that matters, asserted on both sides of the boundary rather than
    // in the middle of a range. `max_attempts: 3` must mean three dials — so the
    // third one exhausts, and a fourth must never be scheduled.
    expect(resolveRetryDecision(policy, 'no_answer', NOW, 1).contactState).toBe('pending');
    expect(resolveRetryDecision(policy, 'no_answer', NOW, 2).contactState).toBe('pending');
    expect(resolveRetryDecision(policy, 'no_answer', NOW, 3).contactState).toBe('exhausted');
  });

  it('never schedules a retry once exhausted, however far past the max', () => {
    for (const used of [3, 4, 99]) {
      const decision = resolveRetryDecision(policy, 'no_answer', NOW, used);
      expect(decision.contactState).toBe('exhausted');
      expect(decision.nextAttemptAt).toBeNull();
      expect(decision.reason).toBe('max_attempts_reached');
    }
  });

  it('distinguishes "ran out of tries" from "never retryable"', () => {
    // Both mean "no more dials", and collapsing them would make a supervisor's
    // dashboard lie in one direction or the other: `exhausted` says the list was
    // worked, `completed` says the outcome was terminal by policy. They get
    // separate states for that reason.
    expect(resolveRetryDecision(policy, 'no_answer', NOW, 3).reason).toBe('max_attempts_reached');
    expect(resolveRetryDecision({ no_answer: { max_attempts: 0 } }, 'no_answer', NOW, 3).reason)
      .toBe('outcome_not_retryable');
    expect(resolveRetryDecision({ no_answer: { max_attempts: 0 } }, 'no_answer', NOW, 3).contactState)
      .toBe('completed');
  });
});

describe('outcomes with their own rules', () => {
  it('suppresses an invalid number rather than exhausting it, whatever the count', () => {
    // `invalid` routes to `suppressed`, not `exhausted`: "this number does not
    // work" and "we ran out of tries" are different facts to someone cleaning a list.
    // Checked at a count BELOW any max, so it is the outcome doing the work and not
    // the attempts arithmetic reaching the same answer by luck.
    const decision = resolveRetryDecision({ invalid: { max_attempts: 5, delay_minutes: 1 } }, 'invalid', NOW, 0);
    expect(decision.contactState).toBe('suppressed');
    expect(decision.suppressedReason).toBe('invalid');
    expect(decision.reason).toBe('invalid_number');
    expect(decision.nextAttemptAt).toBeNull();
  });

  it('treats a connected call as terminal, leaving the disposition to override', () => {
    // Precedence: a disposition beats the outcome policy. This is the outcome
    // half's answer when no disposition was recorded, and it must not be `pending` —
    // re-dialling someone an agent already spoke to, because nobody wrote up the
    // call, is the worst available failure.
    const decision = resolveRetryDecision(null, 'connected', NOW, 1);
    expect(decision.contactState).toBe('completed');
    expect(decision.nextAttemptAt).toBeNull();
  });

  it('`connected` is policy-reachable but `invalid` is not — why only one is refused', () => {
    /**
     * The distinction the `invalid` rejection rests on, and the reason it refuses
     * `invalid` ALONE. Both read as "fixed at 0" in the wizard, so it is tempting
     * to treat them the same and strip both. That would delete a live key.
     *
     *   - `invalid` short-circuits to `suppressed` BEFORE `policy?.[outcome]` is
     *     read, so no rule on it can ever be observed. Refused, and the console stops
     *     sending it.
     *   - `connected` has no such branch: it falls through to the ordinary lookup,
     *     so a policy genuinely overrides the built-in `{max_attempts: 0}`. It
     *     stays a valid key in both validators and the console keeps sending it.
     */
    const tuned = {
      invalid: { max_attempts: 5, delay_minutes: 1 },
      connected: { max_attempts: 5, delay_minutes: 1 },
    };

    // `connected`: the SAME rule that `invalid` ignores demonstrably takes effect.
    // Without the policy this is `completed`/`outcome_not_retryable` (asserted
    // above), so `pending` can only have come from the rule.
    const connected = resolveRetryDecision(tuned, 'connected', NOW, 1);
    expect(connected.contactState).toBe('pending');
    expect(connected.reason).toBe('retry_scheduled');
    expect(connected.nextAttemptAt).toEqual(new Date(NOW.getTime() + 1 * MIN));

    // `invalid`: identical rule, no effect whatsoever.
    const invalid = resolveRetryDecision(tuned, 'invalid', NOW, 1);
    expect(invalid.contactState).toBe('suppressed');
    expect(invalid.nextAttemptAt).toBeNull();

    // And the built-in default for `invalid` is equally unreachable, so removing
    // it would change no behaviour — which is why it can be dropped.
    expect(resolveRetryDecision(null, 'invalid', NOW, 1)).toEqual(invalid);
  });

  it('re-queues an abandoned call on the shortest delay in the policy', () => {
    // The customer picked up and reached nobody, so they are owed
    // another call quickly — 5 minutes, the shortest default, deliberately.
    const decision = resolveRetryDecision(null, 'abandoned', NOW, 1);
    expect(decision.contactState).toBe('pending');
    expect(decision.nextAttemptAt).toEqual(new Date(NOW.getTime() + 5 * MIN));
  });
});

describe('degenerate policies never produce an unclaimable or hot-looping contact', () => {
  it('sends an unmodelled outcome to a terminal state, not to pending', () => {
    // A `pending` contact with no delay is re-claimable on the very next tick, so
    // guessing "retry" here would produce a dial loop; leaving it `in_flight` would
    // block the campaign from ever completing. `completed` is the only safe answer.
    //
    // ⚠️ This case used `orphaned` until it was given a default — which is
    // the point of the fix, not a weakening of this one. `machine` is the honest
    // replacement and the ONLY remaining unmodelled key: it is declared in
    // `AgencyAttemptOutcome` because it is a legal column value, but
    // with AMD off nothing can ever produce it. So this still exercises a
    // real declared outcome with no policy entry, rather than a fabricated one.
    const decision = resolveRetryDecision(null, 'machine', NOW, 1);
    expect(decision.contactState).toBe('completed');
    expect(decision.reason).toBe('no_policy_for_outcome');
    expect(decision.nextAttemptAt).toBeNull();
  });

  it('sends a null outcome to a terminal state', () => {
    expect(resolveRetryDecision(null, null, NOW, 1).contactState).toBe('completed');
  });

  it('treats a missing delay as "immediately", not as a fabricated default', () => {
    // A retry with no delay is re-claimable on the next tick, because
    // `claimDialable`'s predicate is `next_attempt_at <= now()`. Inventing a delay
    // would be a policy decision smuggled into a null check.
    const decision = resolveRetryDecision({ busy: { max_attempts: 3 } }, 'busy', NOW, 1);
    expect(decision.contactState).toBe('pending');
    expect(decision.nextAttemptAt).toEqual(NOW);
  });

  it('refuses to turn a malformed policy into a retry loop or a negative delay', () => {
    // These arrive from raw JSONB, which no validator guards — the column's only
    // constraint is `jsonb_typeof = 'object'`. A negative delay would schedule a
    // retry in the past, i.e. an instant re-dial.
    const negative = resolveRetryDecision(
      { busy: { max_attempts: 3, delay_minutes: -60 } } as never, 'busy', NOW, 1,
    );
    expect(negative.nextAttemptAt).toEqual(NOW);

    for (const bad of [NaN, undefined, null, 'three'] as const) {
      const decision = resolveRetryDecision(
        { busy: { max_attempts: bad } } as never, 'busy', NOW, 0,
      );
      // A max nobody can interpret must not become an unbounded retry.
      expect(decision.contactState).toBe('completed');
      expect(decision.nextAttemptAt).toBeNull();
    }
  });

  it('does not let a fractional max_attempts grant an extra dial', () => {
    // `max_attempts: 3.9` truncates to 3, so the third attempt exhausts. Rounding up
    // would hand out a dial the operator never configured.
    const policy = { busy: { max_attempts: 3.9, delay_minutes: 1 } };
    expect(resolveRetryDecision(policy, 'busy', NOW, 3).contactState).toBe('exhausted');
  });
});

// ===========================================================================
// `canceled` is bounded, not budgeted (pilot 2026-09-08)
//
// A dial we stopped before anyone picked up is our decision and tells us nothing
// about the contact, so `agency-dialer.ts`'s `ended` handler routes it to
// `resolveOurFaultRedial` and the `our_fault_attempts` ledger rather than to
// `chargeAttempt`. That makes `OUR_FAULT_REDIAL_BOUND` — not `max_attempts` —
// the number that limits how often a cancelled contact is re-dialled, and the
// distinction is the whole point rather than a detail:
//
//   * `attempt_count` is the CUSTOMER's allowance. Spending it on a dial they
//     never saw retires them behind a plausible audit trail (three cancelled
//     rings, `last_outcome: 'canceled'`, contact `exhausted`).
//   * `OUR_FAULT_REDIAL_BOUND` is a ceiling a campaign's `retry_policy` can only
//     LOWER (`min(configured, BOUND)`). So the un-charged path is also the
//     STRICTER one on repeat-dialling, which is the half that reads backwards
//     until you check which limit an operator can raise.
//
// The gate itself is asserted at the dial site
// (`canceled-outcome-ledger.test.ts`); this file owns the arithmetic.
// ===========================================================================
describe('`canceled` resolves through the our-fault bound', () => {
  it('re-queues a cancelled contact with a real delay, off an empty policy', () => {
    // `{}` is the ordinary case — campaigns that configure nothing send no `retry_policy` — so this is
    // the path production takes. The delay comes from
    // `DEFAULT_OUR_FAULT_REDIAL_DELAY_MINUTES`, NOT from
    // `DEFAULT_RETRY_POLICY.canceled.delay_minutes` (0), and asserting the exact
    // instant is what tells the two apart: a fallback that reached into the
    // default policy would schedule this at `NOW`.
    for (const policy of [null, {}] as const) {
      const decision = resolveOurFaultRedial(policy, 'canceled', NOW, 1);
      expect(decision.contactState).toBe('pending');
      expect(decision.reason).toBe('retry_scheduled');
      expect(decision.nextAttemptAt)
        .toEqual(new Date(NOW.getTime() + DEFAULT_OUR_FAULT_REDIAL_DELAY_MINUTES * MIN));
    }
  });

  it('retires at OUR_FAULT_REDIAL_BOUND, observably and without suppressing', () => {
    // `exhausted`, not `completed`: the list was genuinely worked. And
    // `suppressedReason` stays null — `suppressed` is reserved for
    // DNC/invalid/manual, and a reason on a non-suppressed row is one fact in two
    // columns that can disagree.
    const at = resolveOurFaultRedial(null, 'canceled', NOW, OUR_FAULT_REDIAL_BOUND);
    expect(at.contactState).toBe('exhausted');
    expect(at.reason).toBe('our_fault_bound_reached');
    expect(at.nextAttemptAt).toBeNull();
    expect(at.suppressedReason).toBeNull();
    // Strictly below the bound is still re-dialled — the negative control, without
    // which "always exhausted" would pass the line above.
    expect(resolveOurFaultRedial(null, 'canceled', NOW, OUR_FAULT_REDIAL_BOUND - 1).contactState)
      .toBe('pending');
  });

  it('cannot be raised past the bound by a campaign policy, only lowered', () => {
    // The regulated half. An operator asking for 10 gets the bound; one asking
    // for 1 gets 1. `DEFAULT_RETRY_POLICY.canceled.max_attempts` is 3, which is
    // also the bound — so a rule of 10 must be clamped by the BOUND rather than
    // silently agreeing with the default by coincidence, and the assertion at
    // `BOUND` below is what distinguishes the two.
    const greedy = { canceled: { max_attempts: 10, delay_minutes: 1 } };
    expect(resolveOurFaultRedial(greedy, 'canceled', NOW, OUR_FAULT_REDIAL_BOUND).contactState)
      .toBe('exhausted');
    expect(resolveOurFaultRedial(greedy, 'canceled', NOW, OUR_FAULT_REDIAL_BOUND).reason)
      .toBe('our_fault_bound_reached');

    const cautious = { canceled: { max_attempts: 1, delay_minutes: 1 } };
    expect(resolveOurFaultRedial(cautious, 'canceled', NOW, 1).contactState).toBe('exhausted');
    // And the configured delay IS honoured on the re-queue arm — the policy is
    // consulted for a stricter cap and for the delay, and for nothing else.
    expect(resolveOurFaultRedial(greedy, 'canceled', NOW, 1).nextAttemptAt)
      .toEqual(new Date(NOW.getTime() + 1 * MIN));
  });

  it('bounds `canceled` identically to the other our-fault outcomes', () => {
    // Not a loophole and not a special case: whatever the bound does for a
    // dropped socket or a crashed replica, it does for a cancelled dial. A
    // divergence at any count would mean one of the three had acquired its own
    // arithmetic.
    for (const used of [0, 1, 2, 3, 4]) {
      const cancel = resolveOurFaultRedial(null, 'canceled', NOW, used);
      const orphan = resolveOurFaultRedial(null, 'orphaned', NOW, used);
      expect(cancel.contactState, `canceled diverged from orphaned at ${used}`)
        .toBe(orphan.contactState);
      expect(cancel.reason).toBe(orphan.reason);
      expect(cancel.nextAttemptAt).toEqual(orphan.nextAttemptAt);
    }
  });

  it('the customer-ledger fallback is present, so nothing retires a contact silently', () => {
    // `resolveRetryDecision` is not the path the dial site takes for `canceled`,
    // but any settle path that has no live in-process record would reach it — and
    // an outcome with no key there resolves to `no_policy_for_outcome` →
    // `contactState: 'completed'`, retiring a customer nobody spoke to. This
    // asserts the fallback exists and is a RETRY, not that it is reachable today.
    const decision = resolveRetryDecision(null, 'canceled', NOW, 1);
    expect(decision.contactState).toBe('pending');
    expect(decision.reason).toBe('retry_scheduled');
    expect(decision.reason).not.toBe('no_policy_for_outcome');
    // `delay_minutes: 0` — there is nothing to wait out on a number that was
    // never really dialled.
    expect(decision.nextAttemptAt).toEqual(NOW);
  });
});
