import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Auto-pause on the abandonment ceiling.
//
// A hard compliance guardrail, so the tests are written against the ways it
// could plausibly LOOK correct while never firing, or fire when it must not:
//
//   * a `null` rate silently comparing as `false` (`null > 3`);
//   * reading the module constant instead of the campaign's own column, which
//     passes every test written against a default-3 campaign;
//   * pausing something that is not `running`, which would restamp the frozen
//     evidence or drag a draining campaign backwards;
//   * N replicas each pausing the same breach and each raising an alert;
//   * and — the one that cannot be caught by adding a case later — an
//     auto-RESUME arm appearing, which acceptance (c) forbids.
// ---------------------------------------------------------------------------

vi.mock('@magick-agency/observability', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
  createChildLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const mocks = vi.hoisted(() => ({
  pauseForAbandonment: vi.fn(),
  transitionStatus: vi.fn(),
  update: vi.fn(),
  auditLog: vi.fn(),
}));

vi.mock('../../../src/db/repositories/agency.repository.js', () => ({
  agencyCampaignRepository: {
    pauseForAbandonment: mocks.pauseForAbandonment,
    transitionStatus: mocks.transitionStatus,
    update: mocks.update,
  },
}));

vi.mock('../../../src/audit/audit-logger.js', () => ({
  auditLogger: { log: mocks.auditLog },
}));

import {
  breachedRows,
  singleAbandonSampleFloor,
  enforceAbandonmentCeiling,
} from '../../../src/agency/abandonment-guardrail.js';
import { DEFAULT_ABANDONMENT_CEILING_PCT } from '../../../src/agency/campaign-config.js';
import type { AgencyAbandonmentWindowRow } from '@magick-agency/domain/abandonment-predicate';

function row(patch: Partial<AgencyAbandonmentWindowRow> = {}): AgencyAbandonmentWindowRow {
  return {
    tenant_id: 't1',
    campaign_id: 'camp-1',
    answered: 100,
    abandoned: 5,
    status: 'running',
    ceiling_pct: 3,
    ...patch,
  };
}

const CAMPAIGN = { id: 'camp-1', tenant_id: 't1', account_id: 'a1' };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.pauseForAbandonment.mockResolvedValue(CAMPAIGN);
});

describe('breachedRows — the decision, with no I/O', () => {
  it('breaches when the measured rate is over the ceiling', () => {
    // 5/100 = 5% against a 3% ceiling.
    expect(breachedRows([row()])).toEqual([
      { tenant_id: 't1', campaign_id: 'camp-1', measured_pct: 5, ceiling_pct: 3 },
    ]);
  });

  it('does NOT breach at exactly the ceiling', () => {
    // 3/100 = 3.0% against 3%. The ceiling is the highest ACCEPTABLE rate;
    // `>=` here would pause a campaign that is precisely compliant, and the
    // difference only ever shows up on round numbers — i.e. in front of an
    // auditor, on the one figure they will check by hand.
    expect(breachedRows([row({ abandoned: 3 })])).toEqual([]);
  });

  it('does NOT breach when nothing was answered — a null rate is not a low rate', () => {
    // `abandonmentRatePct` returns null here. Written as an explicit branch
    // rather than relying on `null > 3` being false, because the accidental
    // version reads identically and stops being true the moment someone
    // reorders the comparison or coerces.
    expect(breachedRows([row({ answered: 0, abandoned: 0 })])).toEqual([]);
  });

  it('honours the CAMPAIGN ceiling, not the module default', () => {
    // The regression this is for: a guardrail reading
    // DEFAULT_ABANDONMENT_CEILING_PCT passes every test written against a
    // default-3 campaign while silently ignoring acceptance (d).
    expect(DEFAULT_ABANDONMENT_CEILING_PCT).toBe(3);

    // 5% under a RAISED ceiling of 10 — the constant would have paused it.
    expect(breachedRows([row({ ceiling_pct: 10 })])).toEqual([]);

    // 2% under a LOWERED ceiling of 1 — the constant would have missed it.
    expect(breachedRows([row({ abandoned: 2, ceiling_pct: 1 })])).toEqual([
      { tenant_id: 't1', campaign_id: 'camp-1', measured_pct: 2, ceiling_pct: 1 },
    ]);
  });

  it.each(['paused', 'stopping', 'stopped', 'completed', 'draft'])(
    'does not auto-pause a campaign in %s',
    (status) => {
      expect(breachedRows([row({ status })])).toEqual([]);
    },
  );

  it('skips a row whose campaign is gone (the LEFT JOIN case)', () => {
    // Attempts outlive the campaign row. Metrics still publish for it; there is
    // nothing left to pause.
    expect(breachedRows([row({ status: null, ceiling_pct: null })])).toEqual([]);
  });

  it('decides each campaign on its own row', () => {
    const breaches = breachedRows([
      row({ campaign_id: 'over', abandoned: 9 }),
      row({ campaign_id: 'under', abandoned: 1 }),
      row({ campaign_id: 'over-2', ceiling_pct: 1 }),
    ]);
    expect(breaches.map((b) => b.campaign_id)).toEqual(['over', 'over-2']);
  });
});

describe('refusal 4 — one abandoned call in too coarse a sample', () => {
  // ⚠️ This was a LIVE defect, not a bug avoided. `breachedRows` read only the
  // rate and never either term of the fraction, so 1-of-1 read 100% and paused
  // the campaign — permanently, because the guardrail deliberately never resumes.
  //
  // Every case below is stated as a rate AND as a fraction on purpose: the whole
  // defect was that the two were treated as interchangeable.

  it('does NOT pause on the very first answered call being abandoned', () => {
    // 1/1 = 100%. The pathology in its purest form: one dropped station socket at
    // the wrong moment took a campaign off the air until somebody noticed.
    expect(breachedRows([row({ answered: 1, abandoned: 1 })])).toEqual([]);
  });

  it('does NOT pause on one call in a sample where one call cannot clear the ceiling', () => {
    // 1/33 = 3.03% against a 3% ceiling. It genuinely exceeds the ceiling — and is
    // still suppressed, because in a 33-call sample no pacing decision could have
    // produced a passing number once one call was abandoned. The rate is too
    // coarse to express the ceiling.
    expect(breachedRows([row({ answered: 33, abandoned: 1 })])).toEqual([]);
    // One more answered call and the sample CAN express it — at which point the
    // same single abandon is 2.94% and clears on its own merits rather than by
    // suppression. The floor and the ceiling agree at the boundary by
    // construction, which is why the floor is derived from the ceiling.
    expect(breachedRows([row({ answered: 34, abandoned: 1 })])).toEqual([]);
  });

  it('DOES pause on two abandoned calls, however small the sample', () => {
    // 2/2 = 100%. Two in a row is not a coincidence, and the suppression must not
    // extend to it — this is the case a plain minimum-sample floor would let run.
    expect(breachedRows([row({ answered: 2, abandoned: 2 })])).toEqual([
      { tenant_id: 't1', campaign_id: 'camp-1', measured_pct: 100, ceiling_pct: 3 },
    ]);
  });

  it('DOES pause a catastrophic small campaign', () => {
    // 20/25 = 80%. The reason the guard is scoped to a SINGLE-call numerator
    // rather than to a small denominator: a campaign abandoning four fifths of its
    // calls must stop, and it stops well before any sample-size threshold.
    expect(breachedRows([row({ answered: 25, abandoned: 20 })])).toEqual([
      { tenant_id: 't1', campaign_id: 'camp-1', measured_pct: 80, ceiling_pct: 3 },
    ]);
  });

  it('leaves the real case completely unchanged', () => {
    // 4/100 = 4%. The case the guardrail exists for, and the one a Wilson
    // lower-bound test would have REFUSED to pause (its 95% bound is ~1.6%) —
    // loosening the guardrail on the only shape that matters, in exchange for not
    // fixing the one that hurts.
    expect(breachedRows([row({ answered: 100, abandoned: 4 })])).toEqual([
      { tenant_id: 't1', campaign_id: 'camp-1', measured_pct: 4, ceiling_pct: 3 },
    ]);
  });

  it('scales the floor to the campaign ceiling rather than a constant', () => {
    // A fixed threshold would be correct for exactly one ceiling. At 1% one call
    // needs 100 answered before it can clear; at 10% it needs 10.
    expect(singleAbandonSampleFloor(3)).toBe(34);
    expect(singleAbandonSampleFloor(1)).toBe(100);
    expect(singleAbandonSampleFloor(10)).toBe(10);
    // 1/50 = 2% against a 1% ceiling: breaches, and is suppressed because 50 is
    // below that ceiling's own floor of 100.
    expect(breachedRows([row({ answered: 50, abandoned: 1, ceiling_pct: 1 })])).toEqual([]);
  });

  it('never suppresses a breach when the ceiling is non-positive', () => {
    // ⚠️ `100 / 0` is `Infinity`, so a naive floor would be infinite and such a
    // campaign could NEVER be auto-paused — a compliance guardrail silently
    // disabled, found in an audit rather than by a test.
    //
    // NOT a supported setting: the schema CHECKs `> 0` and the public API
    // layer's config validation rejects it. But `ceiling_pct` arrives from a LEFT JOIN and is
    // typed nullable, so this is defence against a value that cannot be stored
    // rather than against an operator choice — an earlier version of this test
    // name claimed the latter.
    expect(singleAbandonSampleFloor(0)).toBe(0);
    expect(breachedRows([row({ answered: 1, abandoned: 1, ceiling_pct: 0 })])).toEqual([
      { tenant_id: 't1', campaign_id: 'camp-1', measured_pct: 100, ceiling_pct: 0 },
    ]);
  });

  /**
   * The invariant the two-term gate rests on, pinned as a property rather than
   * as examples.
   *
   * `singleAbandonSampleFloor` is defined as the sample size from which ONE
   * abandoned call can no longer breach the ceiling. If that is true, then every
   * single-abandon row that reaches refusal 4 is already below the floor — the
   * denominator term is implied by the numerator term, and the gate is today
   * exactly "a single abandoned call never pauses a campaign".
   *
   * This is asserted because it is load-bearing and invisible. The floor is
   * derived from the ceiling while the rate is derived from `answered`, and the
   * implication holds only because those are the same denominator. If
   * `abandonmentRatePct` is ever re-based (onto dials, or onto a window that
   * differs from the one the floor assumes), the two stop agreeing and the
   * conjunct silently starts rejecting rows the comment says it suppresses.
   * Better to fail here than to discover it as a campaign that paused on one
   * call after all.
   */
  it('the sample floor IS the point one abandon stops breaching — so the second term is implied', () => {
    for (const ceiling of [0.1, 0.5, 1, 2, 3, 5, 10, 25, 50, 99, 100]) {
      const floor = singleAbandonSampleFloor(ceiling);

      // At the floor and above, one abandoned call cannot breach at all, so the
      // row never reaches refusal 4 — it exits at the `measured <= ceiling`
      // check. This is what makes the floor the right name for the number.
      expect(
        breachedRows([row({ answered: floor, abandoned: 1, ceiling_pct: ceiling })]),
        `one abandon in ${floor} answered should not breach a ${ceiling}% ceiling`,
      ).toEqual([]);

      // Below the floor, one abandoned call DOES breach — and is suppressed.
      // Both halves matter: if it did not breach, the suppression would be
      // untested; if it were not suppressed, the n=1 defect would be back.
      if (floor > 1) {
        const justUnder = floor - 1;
        expect((1 / justUnder) * 100).toBeGreaterThan(ceiling);
        expect(
          breachedRows([row({ answered: justUnder, abandoned: 1, ceiling_pct: ceiling })]),
          `one abandon in ${justUnder} answered breaches ${ceiling}% and must be suppressed`,
        ).toEqual([]);
      }

      // TWO abandoned calls are where the denominator term earns its place for a
      // real ceiling: the same floor now separates a suppressed row from a
      // paused one, which is why the conjunct stays even though it is implied
      // for the single-abandon case.
      const twoAbandonBreaches = breachedRows([
        row({ answered: floor, abandoned: 2, ceiling_pct: ceiling }),
      ]);
      if ((2 / floor) * 100 > ceiling) {
        expect(
          twoAbandonBreaches,
          `two abandons in ${floor} answered must still pause a ${ceiling}% ceiling`,
        ).toHaveLength(1);
      }
    }
  });

  /**
   * The EXCEPTION to the implication above, and the reason the denominator term
   * must not be deleted as dead weight.
   *
   * The proof that `answered < floor` is implied divides by the ceiling, so it
   * says nothing at `ceiling <= 0` or a non-finite ceiling — and there the floor
   * short-circuits to `0`, making `answered < 0` false, so the breach is NOT
   * suppressed and the campaign pauses on its first abandoned call. That is the
   * fail-closed direction and it is the correct one.
   *
   * ⚠️ This is asserted separately because of how it fails. Removing
   * `row.answered < singleAbandonSampleFloor(...)` leaves every real ceiling
   * behaving identically — the implication guarantees it — so a reviewer
   * checking the suppression cases sees a clean suite. The ONLY thing that reds
   * is the non-positive-ceiling path, which is exactly the path a reader who has
   * just been told the term is "implied" would not think to check. Verified by
   * deleting the conjunct: one test fails, and it is this behaviour.
   */
  it('the implication does NOT hold at a non-positive or NaN ceiling — so the term is load-bearing', () => {
    for (const ceiling of [0, -1, Number.NaN]) {
      expect(singleAbandonSampleFloor(ceiling)).toBe(0);
      // A single abandoned call in a sample of one. Suppressed at every real
      // ceiling; must PAUSE here, because a floor of 0 means there is no
      // coarseness to forgive.
      //
      // `NaN` reaches refusal 4 for a reason worth knowing: every comparison
      // with `NaN` is false, so `measured <= ceiling_pct` does NOT short-circuit
      // and the row falls through to here. The floor guard is what makes it
      // fail closed.
      expect(
        breachedRows([row({ answered: 1, abandoned: 1, ceiling_pct: ceiling })]),
        `a ${String(ceiling)} ceiling must not suppress its first abandoned call`,
      ).toHaveLength(1);
    }
  });

  /**
   * `Infinity` is the one non-finite ceiling that behaves in the OPPOSITE
   * direction, and the asymmetry is not obvious enough to leave unwritten.
   *
   * `singleAbandonSampleFloor` returns 0 for it, like the cases above — but the
   * row never gets that far: `measured <= Infinity` is true for any rate, so it
   * exits at the ceiling comparison and no breach is ever recorded. An infinite
   * ceiling means "any abandonment rate is acceptable", so never pausing is the
   * right reading of it, and it is reached by a different mechanism than the
   * fail-closed cases above.
   *
   * Pinned so nobody "fixes" the `!Number.isFinite` guard into treating this
   * like `NaN` and gives an infinite ceiling a pause it never asked for.
   */
  it('an infinite ceiling never breaches at all — a different mechanism from the fail-closed cases', () => {
    expect(singleAbandonSampleFloor(Number.POSITIVE_INFINITY)).toBe(0);
    expect(
      breachedRows([row({ answered: 1, abandoned: 1, ceiling_pct: Number.POSITIVE_INFINITY })]),
    ).toEqual([]);
    expect(
      breachedRows([row({ answered: 100, abandoned: 99, ceiling_pct: Number.POSITIVE_INFINITY })]),
    ).toEqual([]);
  });
});

describe('enforceAbandonmentCeiling — applying the decision', () => {
  it('claims the pause with the measured rate, so the evidence is frozen', async () => {
    await enforceAbandonmentCeiling([row()]);
    expect(mocks.pauseForAbandonment).toHaveBeenCalledTimes(1);
    expect(mocks.pauseForAbandonment).toHaveBeenCalledWith('camp-1', 5);
  });

  it('writes a compliance audit row carrying both numbers', async () => {
    await enforceAbandonmentCeiling([row()]);
    expect(mocks.auditLog).toHaveBeenCalledTimes(1);
    expect(mocks.auditLog).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 't1',
      accountId: 'a1',
      eventType: 'agency_campaign.auto_paused',
      severity: 'error',
      actor: 'system:abandonment-guardrail',
      eventData: {
        campaign_id: 'camp-1',
        reason: 'abandonment_ceiling',
        measured_pct: 5,
        ceiling_pct: 3,
      },
    }));
  });

  it('stays silent when another replica won the claim', async () => {
    // Every replica evaluates the same window on its own timer. The loser gets
    // zero rows back — one event, one audit row, one alert.
    mocks.pauseForAbandonment.mockResolvedValue(null);
    const paused = await enforceAbandonmentCeiling([row()]);
    expect(paused).toEqual([]);
    expect(mocks.auditLog).not.toHaveBeenCalled();
  });

  it('never throws, and one failing campaign does not skip the rest', async () => {
    // It runs inside the metrics refresh; taking the gauges down with it would
    // make observability worse in exactly the conditions it exists for.
    mocks.pauseForAbandonment
      .mockRejectedValueOnce(new Error('deadlock detected'))
      .mockResolvedValueOnce({ ...CAMPAIGN, id: 'camp-2' });

    const paused = await enforceAbandonmentCeiling([
      row({ campaign_id: 'camp-1' }),
      row({ campaign_id: 'camp-2' }),
    ]);
    expect(paused.map((p) => p.campaign_id)).toEqual(['camp-2']);
  });

  it('does nothing at all when no row breaches', async () => {
    await enforceAbandonmentCeiling([row({ abandoned: 0 }), row({ answered: 0, abandoned: 0 })]);
    expect(mocks.pauseForAbandonment).not.toHaveBeenCalled();
    expect(mocks.auditLog).not.toHaveBeenCalled();
  });

  it('NEVER resumes — acceptance (c), pinned as the absence of a capability', async () => {
    // The failure mode this guards is a well-meaning addition: "the rate dropped
    // back under the ceiling, so un-pause it". That would restart dialing with
    // nobody having decided anything, and would oscillate across the threshold
    // as the 24h window slides. The guardrail is given a comfortably-compliant
    // paused campaign — the exact input such an arm would act on — and must not
    // touch it through ANY write path.
    const compliantButPaused = row({ status: 'paused', abandoned: 0 });
    await enforceAbandonmentCeiling([compliantButPaused]);

    expect(mocks.pauseForAbandonment).not.toHaveBeenCalled();
    expect(mocks.transitionStatus).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.auditLog).not.toHaveBeenCalled();
  });
});
