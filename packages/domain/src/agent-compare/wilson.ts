/**
 * ─── COMPARE AGENTS — THE LIKELY RANGE OF A RATE ────────────────────────────
 *
 * A LEAF module: one pure function, importing only a contract constant. No I/O.
 *
 * Every rate on the Compare page carries the 95% Wilson score interval around it, and a finding
 * names an agent only when that whole interval lies on the worse side of the rest of the cohort
 * (CP11, docs/compare-agents.md §6). Wilson rather than the normal ("p ± 1.96·√(p(1−p)/n)")
 * interval because the agents this page is about are the ones with few calls or extreme rates,
 * exactly where the normal interval misbehaves: at 0 of 25 it collapses to [0, 0] and claims
 * certainty, and near 0 or 1 it runs outside [0, 1]. Wilson stays inside [0, 1] and is wide where
 * the evidence is thin, so "chance cannot explain it" means what it says.
 */
import { COMPARE_INTERVAL_Z } from '@magick-agency/contracts/api/agency/compare';

/**
 * The Wilson score interval `[low, high]` for `successes` of `trials`, as fractions in [0, 1].
 *
 * Null when there is nothing to measure: `trials` is not a positive finite number, or `successes`
 * is negative, non-finite or more than `trials` (a broken read, which must not be dressed as a
 * range). `z` defaults to {@link COMPARE_INTERVAL_Z} (two-sided 95%).
 *
 *   centre = (p + z²/2n) / (1 + z²/n)
 *   half   = z · √(p(1−p)/n + z²/4n²) / (1 + z²/n)
 */
export function wilsonInterval(successes: number, trials: number, z: number = COMPARE_INTERVAL_Z): [number, number] | null {
  if (!Number.isFinite(trials) || trials <= 0) return null;
  if (!Number.isFinite(successes) || successes < 0 || successes > trials) return null;
  const p = successes / trials;
  const z2 = z * z;
  const denominator = 1 + z2 / trials;
  const centre = (p + z2 / (2 * trials)) / denominator;
  const half = (z * Math.sqrt((p * (1 - p)) / trials + z2 / (4 * trials * trials))) / denominator;
  // Clamped only against floating-point overshoot: mathematically both ends are already in [0, 1].
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}
