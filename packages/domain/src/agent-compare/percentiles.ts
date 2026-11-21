/**
 * ─── COMPARE AGENTS — THE COHORT'S BAND ─────────────────────────────────────
 *
 * A LEAF module: pure functions, importing only contract types. No I/O.
 *
 * p25 / median / p75 over a cohort's values, by **linear interpolation between the two
 * neighbouring values: Postgres's `percentile_cont`**, which is the method the roster benchmark
 * has always used (`apps/server/src/db/repositories/agency/agent-roster-stats.ts` calls it). One
 * implementation for both, so the Compare page's band and the roster's
 * benchmark cannot disagree (docs/compare-agents.md §5: "not a second percentile implementation").
 *
 * Why continuous, not discrete: the discrete reading snaps to an actual row, and on a floor of
 * four agents that makes the median one named person's number, which invites reading the band
 * as a comparison against THEM.
 *
 * ── The filtering is the CALLER's job ───────────────────────────────────────
 * These functions rank whatever they are handed. Which values are handed in (only those whose
 * denominator cleared the floor, never a null) is the rule at each call site. Passing a null
 * through would be the failure the floor exists to prevent: JavaScript sorts null as 0, so one
 * agent with no calls would sit at the bottom as a hard 0% and pull p25 down.
 */
import type { AgencyRosterPercentiles } from '@magick-agency/contracts/agency';

/**
 * The `fraction` quantile (0 to 1) of `sorted`, ascending and non-empty, by `percentile_cont`:
 * position `(n − 1) · fraction`, interpolated between the values either side. A single value is
 * every quantile of itself.
 */
export function percentileCont(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) throw new RangeError('percentileCont needs at least one value');
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const low = sorted[lower] as number;
  const high = sorted[upper] as number;
  return low + (high - low) * (position - lower);
}

/**
 * p25, median and p75 of `values` (any order; not mutated). All three null on empty input, never
 * 0: "nothing qualified" and "the cohort scores zero" are different facts.
 */
export function cohortPercentiles(values: readonly number[]): AgencyRosterPercentiles {
  if (values.length === 0) return { p25: null, median: null, p75: null };
  const sorted = [...values].sort((a, b) => a - b);
  return { p25: percentileCont(sorted, 0.25), median: percentileCont(sorted, 0.5), p75: percentileCont(sorted, 0.75) };
}
