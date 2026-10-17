import type { AgencyAgentLiveState } from '../../types/agency-campaign';

/**
 * The few figures this console derives itself rather than reading off a
 * payload: a rate from a part and a whole, and each live state's share of the
 * agents (or seconds) on shift.
 *
 * ── Why there is exactly one of each ───────────────────────────────────────
 * Almost every rate on these surfaces is SERVED, and that is deliberate: two
 * places dividing is two answers that round differently. The exceptions are the
 * figures no payload carries — the floor's pooled utilisation, one agent's share
 * of a campaign's conversions, a per-day point on the campaign series, a
 * per-campaign connect rate — and every one of them routes through here rather
 * than through a hand-rolled `n / d * 100`. There were four copies of the
 * division and three of the share-of-shift sum, and they had drifted on what a
 * non-number does.
 */

/**
 * `part / whole`, or **`null` on a zero denominator or a non-finite input**.
 *
 * The guard is the whole point. `0 / 0` is `NaN`, `NaN.toFixed(1)` is `"NaN"`,
 * and `NaN` serialises to `null` — so a hand-rolled rate is wrong in a way that
 * is invisible on the wire and legible only as a broken cell on screen. Here a
 * zero denominator is `null`, which this codebase's null-not-zero rule then
 * renders as an em dash and a phrase naming what has not happened. **A real `0`
 * numerator over a real denominator still returns `0`** — measured-and-zero is a
 * finding, and softening it would be the same dishonesty in the other direction.
 *
 * A non-finite numerator is `null` too, and that is load-bearing for the
 * campaign series: an absent `successes` on one day makes that day a GAP in the
 * conversion line, where coercing it to 0 drew a cliff into the middle of a
 * campaign.
 */
export function ratio(part: number | undefined, whole: number | undefined): number | null {
  if (typeof part !== 'number' || typeof whole !== 'number') return null;
  if (!Number.isFinite(part) || !Number.isFinite(whole)) return null;
  if (whole <= 0) return null;
  return part / whole;
}

/** {@link ratio} as a percentage, 0–100 for a part no larger than its whole. */
export function ratePct(part: number | undefined, whole: number | undefined): number | null {
  const r = ratio(part, whole);
  return r === null ? null : r * 100;
}

/**
 * The live states that make up a SHIFT, busiest first — every state except
 * `offline`.
 *
 * An agent who signed out is not on shift: the server's `shift_seconds` is the
 * sum of these states and nothing else, the Overview rail's floor bar is drawn
 * over them, and the Agents tab's stacked bar is too. Including `offline` dilutes
 * every share by signed-out time and makes "3 of 9 free" a fraction of a floor
 * that is not there. It used to be declared three times, in two orders.
 */
export const ON_SHIFT_STATES: readonly AgencyAgentLiveState[] = [
  'on_call',
  'wrapup',
  'reserved',
  'available',
  'break',
];

export interface StateShare {
  state: AgencyAgentLiveState;
  /** The state's own count (agents, or seconds). */
  value: number;
  /** Share of {@link StateShares.total}, 0–100. */
  share: number;
}

export interface StateShares {
  /** The sum of the counted states — the shares' denominator. */
  total: number;
  /** Positive states only, in `order`. */
  shares: StateShare[];
}

/**
 * Each state's share of the states in `order`, dropping the ones at zero.
 *
 * **A value that is not a finite number is skipped**, never summed. The three
 * copies this replaces disagreed: one skipped non-numbers, two used `?? 0`, which
 * lets a `NaN` poison every share and a string concatenate into the total
 * (`0 + '3'` is `'03'`). The payload is typed as numbers, but it crossed the API
 * boundary, and the skip is what the Agents tab already did — so the rail and the
 * tab now read the same floor off one payload.
 *
 * Zero-length states are dropped rather than returned as a 0% share: unlike a
 * zero rate, an unused state is not a withheld measurement, and a zero-width band
 * is a rounding accident away from a 1px sliver of a colour nobody is in.
 */
export function stateShares(
  byState: Partial<Record<AgencyAgentLiveState, number>> | null | undefined,
  order: readonly AgencyAgentLiveState[] = ON_SHIFT_STATES,
): StateShares {
  if (!byState) return { total: 0, shares: [] };
  const counted = order.flatMap((state) => {
    const value = byState[state];
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return [];
    return [{ state, value }];
  });
  const total = counted.reduce((sum, entry) => sum + entry.value, 0);
  if (total <= 0) return { total: 0, shares: [] };
  return {
    total,
    shares: counted.map(({ state, value }) => ({ state, value, share: (value / total) * 100 })),
  };
}
