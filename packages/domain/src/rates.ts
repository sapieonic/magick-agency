/**
 * ─── AGENCY DIALER — ONE RATE, ONE NULL RULE ────────────────────────────────
 *
 * A LEAF module: one pure function, no imports, no I/O.
 *
 * Every percentage the dialer reports is a count over a count, and every one of
 * them has a denominator that is legitimately zero for a while — a campaign that
 * has dialled nobody, an agent whose shift has not connected a call, a bucket in
 * the middle of the night. What happens at zero is the whole reason this
 * function exists, and it is stated once here rather than re-decided at each
 * call site.
 */

/**
 * `100 * numerator / denominator`, or **`null` when the denominator is zero**.
 *
 * **Null, never 0.** "Nothing has converted yet" and "nothing has been measured
 * yet" are different facts, and a `0` renders both as the same confident,
 * flattering number. That is how a metric gets trusted before it has measured
 * anything: a supervisor reads `success 0.0%` on a campaign whose first call has
 * not connected and concludes something about the script; a guardrail reads
 * `abandonment 0.0%` and concludes compliance from no evidence at all. `null` has
 * exactly one reading — "we cannot say" — and every consumer has to handle it
 * explicitly, which is the point.
 *
 * The rule is not new. `abandonmentRatePct` in `abandonment-predicate.ts` has
 * carried it since `AD-P2-C-06`, and the doc comment there says the same thing at
 * length. This function is the general form, extracted when a second and third
 * rate needed it — the campaign's `success_rate_pct` and the agent record's
 * `connect_rate_pct` / `success_rate_pct` — because three inline
 * `d <= 0 ? null : n / d * 100` expressions is three chances to write `0` in one
 * of them, and the one that gets it wrong will be the one nobody looks at.
 *
 * **`abandonmentRatePct` is deliberately NOT rewritten to call this.** Its module
 * header states, as a design invariant, that it imports nothing at all: it is the
 * independent audit of `agency_abandoned_total`, and "independent" is worth less
 * every time it acquires an import. It duplicates four lines of arithmetic to keep
 * a property that is load-bearing for a compliance number. The duplication is
 * noted at both ends so neither reads as an oversight.
 *
 * A negative or non-finite denominator takes the same branch as zero: there is no
 * meaningful rate over it, and inventing one would be the same failure in a
 * different disguise.
 */
export function ratePct(numerator: number, denominator: number): number | null {
  const value = ratio(numerator, denominator);
  return value === null ? null : value * 100;
}

/**
 * The same quotient, NOT scaled to a percentage — and the same `null`.
 *
 * For the averages rather than the rates: `aht_seconds` is seconds per connected
 * call, so multiplying it by 100 would be nonsense, but "no calls connected" and
 * "calls take no time" are the same two facts that must not collapse into one `0`.
 * Sharing the zero-denominator branch with {@link ratePct} is the whole point —
 * two functions, one rule, so a change to what counts as an empty denominator
 * cannot apply to the rates and miss the averages.
 */
export function ratio(numerator: number, denominator: number): number | null {
  if (!Number.isFinite(denominator) || denominator <= 0) return null;
  return numerator / denominator;
}
