import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// `AD-P3-C-09` / MAG-97 — an agent-side drop must not consume the customer's
// `max_attempts`.
//
// The decision has two halves and BOTH are required. Skipping the attempt charge
// stops us retiring customers we never spoke to; the bound is what stops that
// skip from making our-fault redials free, which would let one broken agent
// workstation redial the same number without limit. Shipping either half alone
// is not the decision.
//
// The structural claim these tests exist to protect: there are TWO LEDGERS and
// they cannot reach each other. `attempt_count` is the customer's allowance;
// `our_fault_attempts` bounds how often our own failures may put their number
// back on the roster. "Independent of `max_attempts`" is a property of the
// schema, not a naming convention — so no arithmetic here can retire a customer
// and no `max_attempts` change can loosen a repeat-dial limit.
// ---------------------------------------------------------------------------

vi.mock('@magick-agency/observability', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
  createChildLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const { pool } = vi.hoisted(() => ({ pool: { query: vi.fn(), connect: vi.fn() } }));
vi.mock('@magick-agency/db', () => ({ getPool: () => pool }));

import {
  DEFAULT_RETRY_POLICY,
  OUR_FAULT_REDIAL_BOUND,
  resolveOurFaultRedial,
  resolveRetryDecision,
} from '../../../src/agency/retry-policy.js';
import { AgencyContactRepository } from '../../../src/db/repositories/agency.repository.js';

/** Fixed instant, so every delay assertion is exact arithmetic, never a range. */
const NOW = new Date('2026-08-11T14:00:00.000Z');
const MIN = 60_000;

beforeEach(() => {
  vi.clearAllMocks();
  pool.query.mockResolvedValue({ rows: [{ our_fault_attempts: 1 }], rowCount: 1 });
});

// ─── criterion 5, first: the DEFAULT path is the ordinary one ───────────────

describe('AD-P3-C-09 (5): the default path — no configuration supplied', () => {
  // This block comes first deliberately. `retry_policy` is `JSONB NOT NULL
  // DEFAULT '{}'`, core COALESCEs a missing value to `'{}'`, and master never
  // sends the field — so `null`/`{}` is what every campaign in existence runs.
  // A fix that only worked under an explicit policy would be green in every
  // configured test here and inert in production.

  it('bounds an unconfigured campaign, with no policy key set', () => {
    // `null` policy, i.e. the ordinary case.
    const first = resolveOurFaultRedial(null, 'agent_disconnected', NOW, 1);
    expect(first.contactState).toBe('pending');
    expect(first.reason).toBe('retry_scheduled');

    const atBound = resolveOurFaultRedial(null, 'agent_disconnected', NOW, OUR_FAULT_REDIAL_BOUND);
    expect(atBound.contactState).toBe('exhausted');
    expect(atBound.reason).toBe('our_fault_bound_reached');
  });

  it('an EMPTY policy object behaves identically to a null one', () => {
    // `{}` is what the column actually stores, so the two must not diverge.
    for (const used of [0, 1, 2, 3, 4]) {
      expect(resolveOurFaultRedial({}, 'agent_disconnected', NOW, used))
        .toEqual(resolveOurFaultRedial(null, 'agent_disconnected', NOW, used));
    }
  });

  it('schedules the default cool-off exactly, not a range', () => {
    const d = resolveOurFaultRedial(null, 'agent_disconnected', NOW, 1);
    // Exact instant: the delay is clock-derived, and `toBeGreaterThan` would pass
    // on 5 minutes, 5 hours, or a doubled clock.
    expect(d.nextAttemptAt).toEqual(new Date(NOW.getTime() + 5 * MIN));
  });

  it('gives BOTH our-fault outcomes a default retry rule, so neither retires a contact', () => {
    // The absence of these two keys WAS the defect: an unmodelled outcome falls
    // to `no_policy_for_outcome` → `completed`, retiring a customer whose attempt
    // died of our dropped socket or our own restart. Both are genuinely produced.
    expect(DEFAULT_RETRY_POLICY).toHaveProperty('agent_disconnected');
    expect(DEFAULT_RETRY_POLICY).toHaveProperty('orphaned');
    for (const outcome of ['agent_disconnected', 'orphaned'] as const) {
      const d = resolveRetryDecision(null, outcome, NOW, 1);
      expect(d.contactState, `${outcome} still retires an unreached customer`).toBe('pending');
      expect(d.reason).not.toBe('no_policy_for_outcome');
    }
  });
});

// ─── criterion 3: the bound, and that no operator can raise it ──────────────

describe('AD-P3-C-09 (3): the bound is a ceiling an operator cannot raise', () => {
  it('REFUSES a policy that tries to exceed the bound — the regulated case', () => {
    // ⚠️ Do not relax this test. It is the entire reason the bound lives below
    // the policy rather than in it: a repeat-dial limit a config field can
    // override is not a limit. An operator asking for 10 gets the bound.
    const greedy = { agent_disconnected: { max_attempts: 10 } };
    const atBound = resolveOurFaultRedial(greedy, 'agent_disconnected', NOW, OUR_FAULT_REDIAL_BOUND);

    expect(atBound.contactState, 'a campaign config raised a regulated repeat-dial limit')
      .toBe('exhausted');
    expect(atBound.reason).toBe('our_fault_bound_reached');
  });

  it('HONOURS a policy that is stricter than the bound', () => {
    // The asymmetry is deliberate and is what makes the test above meaningful:
    // if configuration were ignored outright, "cannot raise" would be trivially
    // true and would prove nothing about precedence.
    const strict = { agent_disconnected: { max_attempts: 1 } };
    const d = resolveOurFaultRedial(strict, 'agent_disconnected', NOW, 1);

    expect(d.contactState).toBe('exhausted');
    expect(d.reason).toBe('our_fault_bound_reached');
    // …and the unconfigured campaign at the same count is still retrying, so the
    // stricter cap demonstrably did something.
    expect(resolveOurFaultRedial(null, 'agent_disconnected', NOW, 1).contactState).toBe('pending');
  });

  it('exceeding the bound is TERMINAL and OBSERVABLE, never a silent stall', () => {
    const d = resolveOurFaultRedial(null, 'agent_disconnected', NOW, OUR_FAULT_REDIAL_BOUND + 5);

    // `exhausted`, not `pending` — a pending contact with a past instant is
    // re-claimable on the next tick, which is the unbounded redial this bound
    // exists to prevent. And not `in_flight`, which would block the campaign
    // from ever completing: a stall that looks like nothing at all.
    expect(d.contactState).toBe('exhausted');
    expect(d.nextAttemptAt).toBeNull();
    // A distinct reason from `max_attempts_reached`, so a supervisor can tell
    // "we ran out of tries on the customer" from "we ran out of tolerance for
    // our own faults" — two different operational problems, one state.
    expect(d.reason).toBe('our_fault_bound_reached');
    expect(d.suppressedReason).toBeNull();
  });

  it('a malformed cap is ignored rather than read as zero', () => {
    // `max_attempts: NaN` from hand-written JSONB must not retire every
    // our-fault contact on its first drop.
    for (const bad of [NaN, Infinity, undefined]) {
      const d = resolveOurFaultRedial(
        { agent_disconnected: { max_attempts: bad as number } }, 'agent_disconnected', NOW, 1,
      );
      expect(d.contactState, `max_attempts: ${String(bad)} retired a contact`).toBe('pending');
    }
  });

  it('the bound is exact at its boundary, not off by one', () => {
    // Boundary-chosen, since the comparison is `>=`. One redial below the bound
    // still retries; landing exactly on it does not.
    expect(resolveOurFaultRedial(null, 'agent_disconnected', NOW, OUR_FAULT_REDIAL_BOUND - 1).contactState)
      .toBe('pending');
    expect(resolveOurFaultRedial(null, 'agent_disconnected', NOW, OUR_FAULT_REDIAL_BOUND).contactState)
      .toBe('exhausted');
  });
});

// ─── criteria 1 & 2: the two ledgers ────────────────────────────────────────

describe('AD-P3-C-09 (1): the our-fault ledger never touches attempt_count', () => {
  it('chargeOurFaultAttempt bumps our_fault_attempts and NOTHING else', async () => {
    await new AgencyContactRepository().chargeOurFaultAttempt('c1', 'agent_disconnected');
    const sql = String(pool.query.mock.calls[0]![0]).replace(/\s+/g, ' ');

    expect(sql).toContain('our_fault_attempts = our_fault_attempts + 1');
    // The load-bearing absence, and the whole ticket. If this ever writes
    // `attempt_count`, our own network fault starts retiring customers again.
    expect(sql, 'the our-fault ledger spent the customer\'s retry allowance')
      .not.toContain('attempt_count');
    expect(sql).toContain('RETURNING our_fault_attempts');
  });

  it('returns the POST-bump count, which is what the bound is evaluated on', async () => {
    pool.query.mockResolvedValue({ rows: [{ our_fault_attempts: 3 }] });
    const used = await new AgencyContactRepository().chargeOurFaultAttempt('c1', 'agent_disconnected');

    // Postgres does the arithmetic and returns it, so a concurrent settle cannot
    // race a read-then-add in TypeScript — the same reason `chargeAttempt` exists.
    expect(used).toBe(3);
    expect(resolveOurFaultRedial(null, 'agent_disconnected', NOW, used).reason)
      .toBe('our_fault_bound_reached');
  });

  it('a missing row reports 0 rather than undefined', async () => {
    pool.query.mockResolvedValue({ rows: [] });
    expect(await new AgencyContactRepository().chargeOurFaultAttempt('gone', 'agent_disconnected'))
      .toBe(0);
  });

  it('the two ledgers cannot reach each other, whatever max_attempts says', () => {
    // `max_attempts` is the customer's allowance. Raising or lowering it must not
    // move the our-fault bound, because a compliance limit that drifts with an
    // unrelated retry setting is not a limit.
    const generous = { agent_disconnected: { max_attempts: 99 }, no_answer: { max_attempts: 99 } };
    expect(resolveOurFaultRedial(generous, 'agent_disconnected', NOW, OUR_FAULT_REDIAL_BOUND).contactState)
      .toBe('exhausted');

    // And the reverse direction: our-fault redials are not counted by the
    // customer-allowance resolver, which never sees `our_fault_attempts` at all.
    expect(resolveRetryDecision(null, 'no_answer', NOW, 1).contactState).toBe('pending');
  });
});

describe('AD-P3-C-09 (2): a drop AFTER bridging does consume the attempt', () => {
  it('the customer-allowance resolver still governs a bridged agent drop', () => {
    // The customer was reached, so the attempt was real. This is the path the
    // dialer takes when `live.bridgedAt` is non-null — it charges `attempt_count`
    // via `chargeAttempt` and decides with `resolveRetryDecision`, unchanged.
    const d = resolveRetryDecision(null, 'agent_disconnected', NOW, 1);
    expect(d.contactState).toBe('pending');
    expect(d.nextAttemptAt).toEqual(new Date(NOW.getTime() + 5 * MIN));

    // And it exhausts against the CUSTOMER's cap, not the our-fault bound.
    expect(resolveRetryDecision(null, 'agent_disconnected', NOW, 3).contactState).toBe('exhausted');
    expect(resolveRetryDecision(null, 'agent_disconnected', NOW, 3).reason).toBe('max_attempts_reached');
  });

  it('the two resolvers give DIFFERENT reasons at the same count, so they are distinguishable', () => {
    // If both said `max_attempts_reached`, an operator could not tell a customer
    // worked to their cap from one retired by our own faults — and the audit
    // trail for a compliance question would be the same string either way.
    const byAllowance = resolveRetryDecision(null, 'agent_disconnected', NOW, 3);
    const byOurFault = resolveOurFaultRedial(null, 'agent_disconnected', NOW, 3);

    expect(byAllowance.contactState).toBe(byOurFault.contactState);       // both terminal
    expect(byAllowance.reason).toBe('max_attempts_reached');
    expect(byOurFault.reason).toBe('our_fault_bound_reached');
    expect(byAllowance.reason).not.toBe(byOurFault.reason);
  });
});

// ─── criterion 4: one principle, both places ────────────────────────────────

describe('AD-P3-C-09 (4): the dial path and the reaper hold ONE principle', () => {
  it('the reaper\'s orphaned outcome is bounded by the same function and constant', () => {
    // The reaper passes `null` policy and `'orphaned'`. If the bound lived only
    // in the dial path, a crash-looping replica would be the way around it —
    // which is the same unbounded repeat-dial exposure, reached by our other
    // fault. One principle means one ceiling, not two that happen to match.
    expect(resolveOurFaultRedial(null, 'orphaned', NOW, 1).contactState).toBe('pending');
    expect(resolveOurFaultRedial(null, 'orphaned', NOW, OUR_FAULT_REDIAL_BOUND).contactState)
      .toBe('exhausted');
    expect(resolveOurFaultRedial(null, 'orphaned', NOW, OUR_FAULT_REDIAL_BOUND).reason)
      .toBe('our_fault_bound_reached');
  });

  it('both our-fault outcomes bound identically — neither is a loophole', () => {
    for (const used of [0, 1, 2, 3, 4]) {
      const agent = resolveOurFaultRedial(null, 'agent_disconnected', NOW, used);
      const orphan = resolveOurFaultRedial(null, 'orphaned', NOW, used);
      expect(orphan.contactState, `orphaned diverged from agent_disconnected at ${used}`)
        .toBe(agent.contactState);
      expect(orphan.reason).toBe(agent.reason);
    }
  });
});

// ===========================================================================
// MAG-100 — the keys become REACHABLE, so the ledger split becomes load-bearing
//
// Master's `RETRY_POLICY_OUTCOMES` was missing `agent_disconnected` and
// `orphaned`, so master 400'd both keys and NO operator could ever store a rule
// on either through the platform. MAG-100 adds them. Two consequences, and this
// block pins one of each:
//
//   1. The key must be REAL — core must genuinely act on a rule master now
//      accepts. Accepting a key core does not honour is worse than rejecting it,
//      because the operator sees it stored and believes it configured.
//   2. The key must NOT be a way around the our-fault bound. Until MAG-100 that
//      was unreachable in practice; now a wizard field feeds
//      `resolveOurFaultRedial`'s `configured`, and `min(configured, BOUND)` is
//      the only thing standing between it and a regulated repeat-dial limit.
// ===========================================================================
describe('MAG-100: the new keys tune the customer ledger and NOT the our-fault bound', () => {
  it('HONOURS a configured rule on both keys, rather than storing an inert one', () => {
    // Criterion 2 — the round trip. Every assertion here is chosen so the
    // DEFAULT would give a DIFFERENT answer: `agent_disconnected` defaults to
    // 5min/3 and `orphaned` to 0min/3, so a silent fallback to the built-ins
    // (the failure this test exists to catch) fails every line below.
    const policy = {
      agent_disconnected: { delay_minutes: 45, max_attempts: 7 },
      orphaned: { delay_minutes: 90, max_attempts: 6 },
    };

    const ad = resolveRetryDecision(policy, 'agent_disconnected', NOW, 1);
    expect(ad.contactState).toBe('pending');
    expect(ad.reason).toBe('retry_scheduled');
    // Exact instant, and 45 ≠ the built-in 5.
    expect(ad.nextAttemptAt).toEqual(new Date(NOW.getTime() + 45 * MIN));

    const orph = resolveRetryDecision(policy, 'orphaned', NOW, 1);
    expect(orph.nextAttemptAt).toEqual(new Date(NOW.getTime() + 90 * MIN));

    // The configured cap is what exhausts. At 3 the BUILT-IN would already be
    // exhausted for both, so `pending` here can only come from the policy.
    expect(resolveRetryDecision(policy, 'agent_disconnected', NOW, 3).contactState).toBe('pending');
    expect(resolveRetryDecision(policy, 'orphaned', NOW, 3).contactState).toBe('pending');
    expect(resolveRetryDecision(policy, 'agent_disconnected', NOW, 7).contactState).toBe('exhausted');
    expect(resolveRetryDecision(policy, 'agent_disconnected', NOW, 7).reason).toBe('max_attempts_reached');
    expect(resolveRetryDecision(policy, 'orphaned', NOW, 6).contactState).toBe('exhausted');
  });

  it('a 50-attempt rule an operator can NOW save does not move the bound off 3', () => {
    /**
     * Criterion 5. `50` is the point: it is a value the wizard will accept once
     * MAG-100 ships, and it is far past the bound, so `min(configured, BOUND)`
     * is the only reason this contact stops being redialled. Change that `min`
     * to `max`, or drop it and use `configured` directly, and both boundary
     * assertions below go red.
     */
    const greedy = {
      agent_disconnected: { max_attempts: 50 },
      orphaned: { max_attempts: 50 },
    };

    for (const outcome of ['agent_disconnected', 'orphaned'] as const) {
      // The bound is EXACTLY 3 under a 50-attempt policy: still retrying at 2,
      // terminal at 3. Asserting only the terminal end would pass on a bound of
      // 1, and asserting only the pending end would pass on a bound of 50.
      expect(resolveOurFaultRedial(greedy, outcome, NOW, 2).contactState, outcome).toBe('pending');
      expect(resolveOurFaultRedial(greedy, outcome, NOW, 3).contactState, outcome).toBe('exhausted');
      expect(resolveOurFaultRedial(greedy, outcome, NOW, 3).reason, outcome)
        .toBe('our_fault_bound_reached');
    }

    // The ticket's claim is the literal 3, so pin the constant too — otherwise a
    // change to the placeholder silently rewrites what "capped at 3" means and
    // every assertion above follows it.
    expect(OUR_FAULT_REDIAL_BOUND).toBe(3);
  });

  it('that SAME policy DOES raise the customer allowance — the ledgers diverge', () => {
    /**
     * The discriminating case. Without it, the test above is equally satisfied by
     * `resolveOurFaultRedial` ignoring configuration outright — which would make
     * "an operator cannot raise the bound" trivially true and prove nothing about
     * precedence. Same policy, same count, two resolvers, two answers.
     */
    const greedy = { agent_disconnected: { max_attempts: 50 } };

    // Our own faults stopped at the bound seven redials ago…
    expect(resolveOurFaultRedial(greedy, 'agent_disconnected', NOW, 10).contactState).toBe('exhausted');
    // …while the customer's allowance genuinely went to 50 and is still retrying.
    expect(resolveRetryDecision(greedy, 'agent_disconnected', NOW, 10).contactState).toBe('pending');
  });
});
