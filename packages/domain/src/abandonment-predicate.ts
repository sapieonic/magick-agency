/**
 * ─── WHAT "ABANDONED" MEANS, AS DATA ──────────────────────────────────
 *
 * Deliberately a leaf module: no repository, no metrics registry, no imports at
 * all. Both the SQL that reads the window and the code that publishes it need
 * these definitions, and if they lived with either one the other would have to
 * import through it — which is how the independent audit half of the compliance metric
 * would quietly acquire a dependency on the thing it audits.
 */

/**
 * How long after the carrier answers a bridge may still arrive before the call
 * counts as abandoned: the **abandonment grace**, a per-campaign setting.
 *
 * AG1 (Manas, 2026-11-24): 3000ms by default (it was one 1000ms constant). The
 * carrier's own media setup lands inside it: on VoiceLink the audio stream can
 * connect a second or more after the answer event, and at 1000ms those calls,
 * which reached an agent and were talked through, were counted against the
 * ceiling and auto-paused campaigns. Then "configurable, but default to 3":
 * each campaign holds its own (`agency_campaigns.abandonment_grace_ms`, 0075),
 * in whole seconds from {@link MIN_ABANDONMENT_GRACE_MS} to
 * {@link MAX_ABANDONMENT_GRACE_MS} (AG2).
 *
 * **The grace a call is judged by is stamped on its attempt** when the attempt
 * row is created (`agency_call_attempts.bridge_grace_ms`, from the campaign's
 * setting at that moment; AG3). So a change to a campaign's setting applies to
 * new calls only and never rewrites the compliance figures of calls already
 * made, and the predicate below stays a predicate over ONE attempt row with no
 * join, which is what makes it an independent audit. It is a **business
 * threshold**, so it lives in a column and here, never expressed as a key TTL.
 * Existing rows took 3000 from the column default, the grace they were already
 * counted with (0074 rebuilt the Insights rollup for it).
 *
 * Whole seconds so every allowed value is a bucket boundary of
 * `agency_answer_to_bridge_seconds` (`packages/observability/src/metrics/agency.ts`),
 * and the share past a campaign's grace is read exactly from one bucket.
 */
export const DEFAULT_ABANDONMENT_GRACE_MS = 3000;

/** The shortest grace a campaign may set (AG2): 1 s, the value before AG1. */
export const MIN_ABANDONMENT_GRACE_MS = 1000;

/** The longest grace a campaign may set (AG2): 5 s. */
export const MAX_ABANDONMENT_GRACE_MS = 5000;

/** The grace moves in whole seconds (AG2): every allowed value is a histogram bucket boundary. */
export const ABANDONMENT_GRACE_STEP_MS = 1000;

/**
 * Every grace a campaign may hold, in milliseconds: `[1000, 2000, 3000, 4000, 5000]`. The
 * `ck_agency_campaign_abandonment_grace` and `ck_agency_attempt_bridge_grace` CHECKs (0075) list
 * the same values; the server's campaign-config validation reads {@link isAllowedAbandonmentGraceMs}.
 */
export const ALLOWED_ABANDONMENT_GRACE_MS: readonly number[] = Object.freeze(
  Array.from(
    { length: (MAX_ABANDONMENT_GRACE_MS - MIN_ABANDONMENT_GRACE_MS) / ABANDONMENT_GRACE_STEP_MS + 1 },
    (_, i) => MIN_ABANDONMENT_GRACE_MS + i * ABANDONMENT_GRACE_STEP_MS,
  ),
);

/** Whether `value` is a grace a campaign may hold: a whole number of seconds from 1 to 5, in ms. */
export function isAllowedAbandonmentGraceMs(value: unknown): value is number {
  return typeof value === 'number' && ALLOWED_ABANDONMENT_GRACE_MS.includes(value);
}

/** The regulatory window. Ofcom and the design's default ceiling both use 24h. */
export const ABANDONMENT_WINDOW_HOURS = 24;

/**
 * The single definition of "this attempt was abandoned", as SQL over raw columns.
 *
 * Exported so the metric's numerator and any audit query are the *same* predicate
 * — a second copy is how two numbers that should be identical drift. It reads
 * `outcome`, `bridged_at`, `answered_at` and the grace stamped on the attempt
 * (`bridge_grace_ms`, AG3) directly and depends on no counter, no cache, no
 * other table and no in-process state, which is what makes it usable as an
 * independent audit of `agency_abandoned_total`.
 *
 * ⚠️ **Its column names are unqualified**, so it must be evaluated where
 * `agency_call_attempts` (or a projection of it carrying all five columns,
 * `state`, `answered_at`, `bridged_at`, `outcome` and `bridge_grace_ms`) is the
 * only relation that has them. That is why the attempt's column is
 * `bridge_grace_ms` and the campaign's `abandonment_grace_ms`: one shared name
 * would make every query that joins the two ambiguous.
 *
 * ⚠️ **The predicate includes `state = 'ended'`, and any independent cross-check
 * query must include it too.** Without a terminal filter, the `bridged_at IS NULL` arm is true of an attempt that is answered and *still
 * being bridged*, and of one mid-apology on the abandoned path. Without the
 * filter, live traffic inflates the compliance rate in real time and the
 * auto-pause guardrail would fire on a healthy campaign at concurrency —
 * pausing a campaign for calls that were about to connect. Abandonment is a
 * property of a call that is OVER, so only terminal attempts are counted. A cross-check
 * query that omits it would disagree for a reason that is not a bug.
 */
export const ABANDONED_ATTEMPT_PREDICATE_SQL = `
  state = 'ended'
  AND answered_at IS NOT NULL
  AND (
    outcome = 'abandoned'
    OR bridged_at IS NULL
    OR bridged_at - answered_at > bridge_grace_ms * interval '1 millisecond'
  )
`;

/**
 * The facts the predicate needs, as an attempt's own in-process record.
 *
 * `answeredAt`/`bridgedAt` are `null` for "not stamped", mirroring the columns.
 */
export interface AbandonedAttemptFacts {
  answeredAt: Date | null;
  bridgedAt: Date | null;
  outcome: string | null;
  /**
   * The grace this attempt is judged by, in milliseconds: the `bridge_grace_ms` stamped on its
   * row when it was created (AG3), never the campaign's setting now. Required, so no caller can
   * fall back to a default the row does not hold.
   */
  bridgeGraceMs: number;
}

/**
 * {@link ABANDONED_ATTEMPT_PREDICATE_SQL}, evaluated in process.
 *
 * **The two must agree on the arms they share — which is NOT all of them — and
 * living beside each other is the only reason they will.** An earlier draft of this
 * header said "byte-for-byte equivalent", which is false eight lines below its own
 * claim (`state = 'ended'` has no counterpart here) and is exactly the sentence a
 * reviewer would lean on while editing one side. The accurate statement:
 * `answered_at`, `bridged_at`, `outcome` and the grace comparison (against the
 * attempt's own stamped grace) must match exactly; the terminal filter is the SQL's alone, and the paragraph below says why
 * that is safe rather than an omission.
 *
 * They exist because `agency_abandoned_total` has to
 * be keyed on the same DEFINITION the table is, not on the classifier's label:
 * `outcome === 'abandoned'` is stamped only by `abandonAnsweredCall`, which runs
 * only when no live station owns the agent at answer time, so an answered call
 * whose bridge failed for any *other* reason (bridge failure, carrier hangup
 * between answer and bridge, a socket that died in the same window) was abandoned
 * in the table and invisible to the counter — under-reporting in the direction
 * that looks compliant.
 *
 * `state = 'ended'` is deliberately **not** a field here: the sole caller is the
 * settle site, which by construction is the moment the attempt becomes terminal.
 * Adding a `state` parameter would invite a call from somewhere that is not that
 * moment, which is the arm of the SQL predicate that keeps live traffic out of the
 * compliance rate.
 *
 * ⚠️ **What this can and cannot see.** Its inputs are one replica's in-process
 * record of an attempt it owns, so it is exact for every attempt settled by the
 * owning replica's `ended` handler and blind to any attempt settled by a path with
 * no in-process record — the reaper's orphan sweep after a crash, most of all.
 * That residue is irreducible for a process-local counter and is the reason the
 * SQL window gauge, not this, is what the auto-pause guardrail reads.
 */
export function isAbandonedAttempt(facts: AbandonedAttemptFacts): boolean {
  // No carrier answer ⇒ nothing was abandoned. This is the arm that keeps a call
  // that merely rang out of the numerator, and it mirrors `answered_at IS NOT NULL`.
  if (facts.answeredAt === null) return false;
  if (facts.outcome === 'abandoned') return true;
  if (facts.bridgedAt === null) return true;
  return facts.bridgedAt.getTime() - facts.answeredAt.getTime() > facts.bridgeGraceMs;
}

/** One campaign's slice of the rolling window. */
export interface AbandonmentWindowRow {
  tenant_id: string;
  campaign_id: string;
  answered: number;
  abandoned: number;
}

/**
 * A window row joined to the campaign it belongs to.
 *
 * The guardrail needs two campaign facts the attempts table cannot supply — is
 * the campaign still `running`, and what is ITS ceiling — and it must read them
 * from **the same aggregate** the metrics gauges are published from. A second
 * query would be a second definition of "the window", and this codebase already
 * carries the scar from that: `ABANDONED_ATTEMPT_PREDICATE_SQL` exists as one
 * exported string precisely so the audited number and the product number cannot
 * drift. The guardrail firing on a rate that disagrees with the gauge a
 * compliance alert reads would be invisible until someone reconciled them by
 * hand.
 *
 * Both fields are nullable because the join is a LEFT JOIN: attempts can outlive
 * the campaign row. Metrics still publish for such a row; the guardrail skips it,
 * because there is nothing left to pause.
 */
export interface AgencyAbandonmentWindowRow extends AbandonmentWindowRow {
  status: string | null;
  ceiling_pct: number | null;
}

/**
 * The rate for one window row, as a percentage.
 *
 * **Zero answered calls is `null`, not `0`.** A campaign that has answered nothing
 * has no abandonment rate — reporting 0% would tell a supervisor the campaign is
 * compliant when it has no evidence either way, and reporting 100% off a single
 * call would trip the guardrail. Callers decide what to do with `null`; the
 * guardrail's answer is "do not pause on it".
 */
export function abandonmentRatePct(row: Pick<AbandonmentWindowRow, 'answered' | 'abandoned'>): number | null {
  if (row.answered <= 0) return null;
  return (row.abandoned / row.answered) * 100;
}

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
 * `abandonment_ceiling_pct > 0`, and the server's campaign-config validation
 * rejects it with the rationale written out — *"a ceiling of 0 would read as a
 * strict setting and behave as a kill switch. An operator who wants no dialing
 * has `pause`."*
 *
 * The guard stays regardless, because what it protects against is not a setting:
 * `100 / 0` is `Infinity`, which would make the floor infinite and suppress the
 * pause for **every** breach — a compliance guardrail silently disabled, and the
 * kind of thing found in an audit rather than by a test. `ceiling_pct` also
 * arrives at the guardrail from a LEFT JOIN and is typed nullable, so a
 * non-positive value reaching this function is a real possibility even though no
 * row can hold one. Returning 0 makes such a campaign pause on its first abandon,
 * which is the fail-closed direction.
 *
 * Here rather than in the server's guardrail (`abandonment-guardrail.ts`, which
 * re-exports it) so the console's Resume warning (decision AW2) reads the same
 * floor the guardrail pauses by.
 */
export function singleAbandonSampleFloor(ceilingPct: number): number {
  if (!Number.isFinite(ceilingPct) || ceilingPct <= 0) return 0;
  return Math.ceil(100 / ceilingPct);
}

/**
 * Whether the abandonment guardrail would pause a RUNNING campaign with this rolling 24-hour
 * window: the rate is above the ceiling (not at it), and the breach is not a single abandoned call
 * in a sample too coarse to measure ({@link singleAbandonSampleFloor}). The rule the server's
 * `breachedRows` applies branch by branch, with a log line on the suppressed case; its unit test
 * holds the two equal over a sweep. The console reads it to say that a resumed campaign will be
 * paused again (decisions AW1, AW2); it never pauses anything itself.
 */
export function abandonmentBreachesCeiling(
  row: Pick<AbandonmentWindowRow, 'answered' | 'abandoned'>,
  ceilingPct: number,
): boolean {
  const measured = abandonmentRatePct(row);
  if (measured === null) return false;
  if (measured <= ceilingPct) return false;
  return !(row.abandoned <= 1 && row.answered < singleAbandonSampleFloor(ceilingPct));
}
