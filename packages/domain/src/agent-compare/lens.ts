/**
 * ─── COMPARE AGENTS — LENSES ────────────────────────────────────────────────
 *
 * A LEAF module: pure functions over contract types. No I/O.
 *
 * A lens is the starting set of metrics for a kind of campaign (docs/compare-agents.md §4). Each
 * lens has fixed built-ins and one slot for the campaign's MAIN OUTCOME, an outcome set built from
 * the campaign's current catalog (CP17), which is also the per-day trend:
 *
 * | Lens | Metrics | Main outcome (and trend) |
 * |---|---|---|
 * | collections | calls handled, main, time to choose outcome, no outcome chosen, average call, breaks over limit | "Will pay": the `requires_promise` codes, higher is better |
 * | sales | calls handled, main, call-backs booked, call-backs kept on time, average call, calls per hour | "Success": the `is_success` codes, higher is better |
 * | verification | calls handled, calls per hour, main, no outcome chosen, average call, time to choose outcome | "Success", as sales |
 *
 * The main outcome slot, by catalog:
 * - 1 to `COMPARE_OUTCOME_SET_MAX_CODES` qualifying codes: the outcome set, labelled as above;
 * - more than that: the built-in that counts all of them, never a silently cut list:
 *   `promises_rate` for "Will pay" (countable, so it stays the trend), `success_rate` for
 *   "Success" (not countable: no trend);
 * - none: collections falls back to the "Success" rule; sales and verification leave the slot
 *   out (five metrics, no trend). A catalog with no success code has nothing to call success.
 *
 * The catalog has no refusal category (CP18), so no lens starts with a lower-is-better outcome
 * set: a supervisor who wants "Refused" adds it and chooses its direction.
 *
 * The labels "Will pay" and "Success" are the set's name as a supervisor would type it (stored in
 * a saved view like any other label), in the console's English (AS15).
 */
import {
  COMPARE_OUTCOME_SET_MAX_CODES,
  type AgencyCompareMetricRef,
  type AgencyCompareOutcomeCode,
  type CompareBuiltinMetricKey,
  type CompareLens,
} from '@magick-agency/contracts/api/agency/compare';

/** The main outcome's place among a lens's built-ins. */
const MAIN = 'main' as const;

/** Each lens's metrics in page order; `main` is the main-outcome slot. */
export const COMPARE_LENS_LAYOUT: Readonly<Record<CompareLens, ReadonlyArray<CompareBuiltinMetricKey | typeof MAIN>>> = Object.freeze({
  collections: ['calls_handled', MAIN, 'choose_time', 'no_outcome_rate', 'avg_call', 'breaks_over_limit'],
  sales: ['calls_handled', MAIN, 'callbacks_booked', 'callbacks_kept_rate', 'avg_call', 'calls_per_hour'],
  verification: ['calls_handled', 'calls_per_hour', MAIN, 'no_outcome_rate', 'avg_call', 'choose_time'],
});

/** The label of the collections lens's main outcome set. */
export const COMPARE_WILL_PAY_LABEL = 'Will pay';
/** The label of the sales and verification lenses' main outcome set. */
export const COMPARE_SUCCESS_LABEL = 'Success';

/** A lens's starting metrics and trend for one campaign. */
export interface CompareLensDefaults {
  metrics: AgencyCompareMetricRef[];
  /** Null when the lens has no countable main outcome on this catalog. */
  trend: AgencyCompareMetricRef | null;
}

/** The campaign's starting lens (§4): `collections` when its catalog records promises, else `sales`. */
export function compareStartingLens(codes: readonly AgencyCompareOutcomeCode[]): CompareLens {
  return codes.some((c) => c.requires_promise) ? 'collections' : 'sales';
}

function successMain(codes: readonly AgencyCompareOutcomeCode[]): AgencyCompareMetricRef | null {
  const success = codes.filter((c) => c.is_success).map((c) => c.code);
  if (success.length === 0) return null;
  if (success.length > COMPARE_OUTCOME_SET_MAX_CODES) return { kind: 'builtin', key: 'success_rate' };
  return { kind: 'outcomes', codes: success, better: 'higher', label: COMPARE_SUCCESS_LABEL };
}

/** The main outcome of `lens` on this catalog, or null when there is none. */
export function compareLensMainOutcome(lens: CompareLens, codes: readonly AgencyCompareOutcomeCode[]): AgencyCompareMetricRef | null {
  if (lens === 'collections') {
    const promise = codes.filter((c) => c.requires_promise).map((c) => c.code);
    if (promise.length > COMPARE_OUTCOME_SET_MAX_CODES) return { kind: 'builtin', key: 'promises_rate' };
    if (promise.length > 0) return { kind: 'outcomes', codes: promise, better: 'higher', label: COMPARE_WILL_PAY_LABEL };
  }
  return successMain(codes);
}

/** The lens's metrics (at most `COMPARE_MAX_METRICS`, distinct ids) and trend on this catalog. */
export function compareLensDefaults(lens: CompareLens, codes: readonly AgencyCompareOutcomeCode[]): CompareLensDefaults {
  const main = compareLensMainOutcome(lens, codes);
  const metrics: AgencyCompareMetricRef[] = [];
  for (const slot of COMPARE_LENS_LAYOUT[lens]) {
    if (slot !== MAIN) metrics.push({ kind: 'builtin', key: slot });
    else if (main !== null) metrics.push(main);
  }
  const trend = main !== null && (main.kind === 'outcomes' || main.key === 'promises_rate') ? main : null;
  return { metrics, trend };
}
