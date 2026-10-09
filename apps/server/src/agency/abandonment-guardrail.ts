import { createChildLogger } from '@magick-agency/observability';
import { agencyCampaignRepository } from '../db/repositories/agency.repository.js';
import { abandonmentRatePct, type AgencyAbandonmentWindowRow } from '@magick-agency/domain/abandonment-predicate';
import { auditLogger } from '../audit/audit-logger.js';

const log = createChildLogger({ component: 'agency-abandonment-guardrail' });

/**
 * ─── AUTO-PAUSE ON THE ABANDONMENT CEILING ──────────────────────────────────
 *
 * **A hard guardrail, not a dashboard number.** Abandonment is a compliance
 * control alongside DNC and calling hours: a campaign dialing faster than its agents can
 * answer is abandoning live customers, and the regulator's remedy is that it
 * stops — not that a percentage turns amber on a screen nobody is watching at
 * 2am.
 *
 * ── Why this lives beside the metrics refresh rather than in the pacing tick ──
 *
 * The rate is a rolling 24h SQL aggregate over `agency_call_attempts`, and
 * `ABANDONMENT_REFRESH_MS` (60s) already reads exactly that number, for every
 * campaign, in one grouped statement. Its own doc comment sizes the cadence so
 * this guardrail never acts on a rate more than that stale.
 *
 * The pacing tick would be the wrong home twice over: the leader evaluates each
 * campaign it leads every 250 ms (`TICK_INTERVAL_MS`), so it would multiply a
 * table-wide aggregate by the number of campaigns and the tick rate; and a
 * campaign that has stalled for some other reason stops ticking, which is
 * exactly when a breach must still be noticed.
 *
 * ── Four refusals, each of which was a plausible-looking bug ─────────────────
 *
 * 1. **`null` is not a breach.** `abandonmentRatePct` returns `null` when the
 *    window answered nothing, and the tempting `rate > ceiling` reads `null > 3`
 *    as `false` by accident rather than by decision. It is written as an
 *    explicit early return so that the reason survives a refactor: a campaign
 *    with no answered calls has no evidence either way, and pausing on it would
 *    stop a campaign that has not yet abandoned anything.
 *
 * 2. **The ceiling is the campaign's, never the constant.** Reading
 *    `DEFAULT_ABANDONMENT_CEILING_PCT` here would silently ignore the
 *    per-campaign setting while still passing every test written against a
 *    default-3 campaign. The column's DEFAULT is where the constant applies.
 *
 * 3. **It never resumes.** Resuming is a deliberate supervisor
 *    action. There is no arm here that moves a campaign out of `paused`, and
 *    there must never be one — a guardrail that un-pauses when the sliding
 *    window drops back under the ceiling would restart dialing on its own, with
 *    nobody having decided anything, and would then oscillate across the
 *    threshold. This is held by a test rather than only by this paragraph,
 *    because "the absence of a feature" is the easiest property to lose.
 *
 * 4. **A single abandoned call in too coarse a sample is not a breach.** Without
 *    it, `1 of 1` reads 100% and pauses the campaign for good. The
 *    full argument, the cases it does and does not suppress, and why a
 *    denominator floor and a Wilson bound are both worse, are on the branch
 *    itself in {@link breachedRows}.
 */

/**
 * The smallest answered-call count in which ONE abandoned call does not, by
 * itself, exceed the ceiling.
 *
 * At the default 3% ceiling this is 34: one abandon out of 34 answered is 2.94%
 * and clears, one out of 33 is 3.03% and breaches. Below that threshold the rate
 * is too coarse to express the ceiling at all — a single call necessarily
 * overshoots it — so a one-call breach there is an artefact of the sample size
 * rather than evidence about how the campaign is pacing.
 *
 * Derived from the campaign's OWN ceiling rather than a constant, so a campaign
 * configured at 1% gets a floor of 100 and one at 10% gets 10. A fixed number
 * would be right for exactly one ceiling.
 *
 * ⚠️ **The `ceilingPct <= 0` guard is defensive, NOT a supported setting.** A
 * zero ceiling is refused in two places: the schema CHECKs
 * `abandonment_ceiling_pct > 0`, and the campaign-config validation
 * (`campaign-config.ts`) rejects it with the rationale written out — *"a ceiling of
 * 0 would read as a strict setting and behave as a kill switch. An operator who
 * wants no dialing has `pause`."*
 *
 * The guard stays regardless, because what it protects against is not a setting:
 * `100 / 0` is `Infinity`, which would make the floor infinite and suppress the
 * pause for **every** breach — a compliance guardrail silently disabled, and the
 * kind of thing found in an audit rather than by a test. `ceiling_pct` also
 * arrives here from a LEFT JOIN and is typed nullable, so a non-positive value
 * reaching this function is a real possibility even though no row can hold one.
 * Returning 0 makes such a campaign pause on its first abandon, which is the
 * fail-closed direction.
 */
export function singleAbandonSampleFloor(ceilingPct: number): number {
  if (!Number.isFinite(ceilingPct) || ceilingPct <= 0) return 0;
  return Math.ceil(100 / ceilingPct);
}

/** One breach, as decided. Returned so the caller can report without re-deriving. */
export interface AbandonmentBreach {
  tenant_id: string;
  campaign_id: string;
  measured_pct: number;
  ceiling_pct: number;
}

/**
 * Decide, per row, whether the campaign has breached its own ceiling.
 *
 * Pure and total — no I/O — so the policy can be exercised without a database.
 * Every skip is a named branch rather than a falsy comparison.
 */
export function breachedRows(rows: readonly AgencyAbandonmentWindowRow[]): AbandonmentBreach[] {
  const breaches: AbandonmentBreach[] = [];
  for (const row of rows) {
    // The campaign row is gone (LEFT JOIN) — nothing left to pause.
    if (row.status === null || row.ceiling_pct === null) continue;
    // Only a RUNNING campaign can be auto-paused. A `paused` one is already
    // stopped (and re-stamping it would move `paused_at` and overwrite the
    // frozen evidence with a later, smaller number); `stopping`/`completed`/
    // `stopped` are terminal or draining and must not be dragged back.
    if (row.status !== 'running') continue;

    const measured = abandonmentRatePct(row);
    if (measured === null) continue;
    if (measured <= row.ceiling_pct) continue;

    /**
     * ── Refusal 4: ONE abandoned call in a sample too coarse to measure ─────
     *
     * Reading only `measured` and `ceiling_pct`, without either term of the
     * fraction, **one abandoned call out of one answered call reads 100% and
     * pauses the campaign**, permanently, because refusal 3 above means nothing
     * ever un-pauses it. A single dropped station socket at the wrong moment would
     * take a campaign off the air until a supervisor noticed.
     *
     * The block comment on the gauges in `metrics.ts` justifies exporting the
     * numerator and the denominator as separate series with "a rate alone cannot
     * distinguish 1-abandoned-of-1 from 30-of-3000, and the auto-pause guardrail
     * reads this: pausing a campaign because its first call of the day was
     * abandoned would be a self-inflicted outage." This branch is what makes that
     * true.
     *
     * **Scoped as narrowly as the pathology.** It suppresses only a breach whose
     * numerator is a SINGLE call AND whose denominator is below the point where
     * one call can clear the ceiling. Everything else pauses exactly as before:
     *
     *   1 of 1   (100%) → suppressed. No evidence about pacing.
     *   1 of 33  (3.03%) → suppressed. One call, in a sample where one call
     *                      cannot come in under 3% however well we paced.
     *   2 of 2   (100%) → PAUSES. Two in a row is not a coincidence.
     *   20 of 25 (80%)  → PAUSES. A catastrophic small campaign must still stop.
     *   4 of 100 (4%)   → PAUSES. Unchanged, and this is the real case.
     *
     * ⚠️ **DO NOT DELETE THE DENOMINATOR TERM.** For a *positive, finite*
     * ceiling it is implied by the numerator term rather than independent, and
     * that is worth knowing because the sentence above reads as though two
     * separate things are checked. The algebra: reaching this line means
     * `abandoned/answered*100 > ceiling`, and `abandoned <= 1` with a positive
     * rate means `abandoned === 1`, so `answered < 100/ceiling`. The floor is
     * `ceil(100/ceiling) >= 100/ceiling`. Therefore `answered < floor` holds for
     * every such row — verified exhaustively over ceilings 0.1-100 and samples
     * 1-5000, zero counterexamples. So for a real campaign, refusal 4 is exactly
     * *"a single abandoned call never pauses a campaign"*, and `1 of 33` is
     * suppressed because one call cannot breach 3% above 33 answered at all, not
     * because 33 is under some separate floor.
     *
     * **But it is NOT redundant at `ceiling <= 0` or a non-finite ceiling, and
     * there it is the only thing keeping this path correct** (the sweep above
     * excluded those ceilings and the division step in the proof is undefined at
     * zero). `singleAbandonSampleFloor` short-circuits to `0`
     * there, so `answered < 0` is false, the breach is NOT suppressed, and such
     * a campaign pauses on its first abandoned call — the fail-closed direction,
     * held by 'never suppresses a breach when the ceiling is non-positive'.
     * Drop the conjunct and that test is the one and only thing that reds, which
     * is exactly how a guardrail gets silently disabled for the setting the
     * zero-ceiling branch exists to protect. (The DB `CHECK` makes a stored zero
     * unreachable, but `ceiling_pct` arrives via a LEFT JOIN typed nullable, so
     * the code path is live and tested — the two statements must not disagree.)
     *
     * Two further reasons it stays. The conjunct becomes operative for real
     * ceilings the instant the numerator gate widens — at `abandoned <= 2` it
     * does work at every ceiling (at 3%: it separates `2 of 66` from `2 of 67`)
     * — so writing the rule as intended keeps that a one-token edit rather than
     * a re-derivation. And the floor is the value the console mirrors to decide whether
     * to promise a supervisor the pause will happen, so it has to exist as a
     * named, exported function regardless. Both the implication and its
     * exception are asserted in `abandonment-guardrail.test.ts`, so if the rate's
     * denominator ever stops being `answered` it breaks loudly.
     *
     * The alternatives were both worse and both look reasonable. A plain
     * denominator floor lets `20 of 25` run. A Wilson lower-bound test still
     * fires on `1 of 1` (its 95% bound is ~21%) while REFUSING `4 of 100` (bound
     * ~1.6%) — it would have loosened the guardrail on the only case that
     * matters, in exchange for not fixing the one that hurts.
     *
     * The worst case this admits is bounded and small: at most ONE abandoned
     * customer before the guardrail can act, against the status quo's zero. That
     * is the price of not pausing campaigns on noise, and it is worth paying.
     *
     * Logged rather than silent. A suppressed breach is a real event — it is the
     * one moment where the guardrail declined to act — and "the campaign kept
     * dialing at 100% abandonment" is not something to discover from a table.
     */
    if (row.abandoned <= 1 && row.answered < singleAbandonSampleFloor(row.ceiling_pct)) {
      log.info(
        {
          campaignId: row.campaign_id,
          tenantId: row.tenant_id,
          measuredPct: measured,
          ceilingPct: row.ceiling_pct,
          answered: row.answered,
          abandoned: row.abandoned,
          sampleFloor: singleAbandonSampleFloor(row.ceiling_pct),
        },
        'Abandonment ceiling breached by a single call in too small a sample — not pausing',
      );
      continue;
    }

    breaches.push({
      tenant_id: row.tenant_id,
      campaign_id: row.campaign_id,
      measured_pct: measured,
      ceiling_pct: row.ceiling_pct,
    });
  }
  return breaches;
}

/**
 * Apply the guardrail to one refresh's worth of window rows.
 *
 * Never throws: this runs inside the metrics refresh, and a guardrail that can
 * take the gauges down with it has made observability worse in exactly the
 * conditions it exists for. Each campaign is isolated, so one failing pause does
 * not skip the rest.
 */
export async function enforceAbandonmentCeiling(
  rows: readonly AgencyAbandonmentWindowRow[],
): Promise<AbandonmentBreach[]> {
  const paused: AbandonmentBreach[] = [];

  for (const breach of breachedRows(rows)) {
    try {
      const campaign = await agencyCampaignRepository.pauseForAbandonment(
        breach.campaign_id,
        breach.measured_pct,
      );
      // Zero rows means another replica won the claim, or a supervisor moved the
      // campaign in the same window. Not an error, and deliberately silent —
      // logging it would produce one line per replica per minute for one event.
      if (!campaign) continue;

      paused.push(breach);

      log.error(
        {
          campaignId: breach.campaign_id,
          tenantId: breach.tenant_id,
          measuredPct: breach.measured_pct,
          ceilingPct: breach.ceiling_pct,
        },
        'Agency campaign auto-paused — rolling 24h abandonment rate is over its ceiling',
      );

      // `error` severity, and an audit row: this is a compliance event, and the
      // record of WHY a campaign stopped is the thing an audit asks for. The
      // frozen rate is on the campaign row too, but an audit trail that requires
      // joining to a mutable row to explain itself is not much of an audit trail.
      auditLogger.log({
        tenantId: campaign.tenant_id,
        accountId: campaign.account_id,
        eventType: 'agency_campaign.auto_paused',
        eventCategory: 'call',
        severity: 'error',
        actor: 'system:abandonment-guardrail',
        eventData: {
          campaign_id: breach.campaign_id,
          reason: 'abandonment_ceiling',
          measured_pct: breach.measured_pct,
          ceiling_pct: breach.ceiling_pct,
        },
      });
    } catch (err) {
      log.error(
        { err, campaignId: breach.campaign_id },
        'Failed to auto-pause agency campaign over its abandonment ceiling',
      );
    }
  }

  return paused;
}
