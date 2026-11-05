import { AGENCY_DEFAULT_ABANDONMENT_CEILING_PCT } from '@magick-agency/contracts/agency';
import { clampPercent, pct } from '../format/number';

/**
 * The abandonment ceiling (`abandonment_ceiling_pct`): the rolling 24-hour
 * abandonment rate (abandoned ÷ answered) above which a campaign pauses itself.
 *
 * Pure, so the drag, the keyboard and the typed value all go through the same
 * rounding and the same bounds, and every one of them is tested here rather than
 * through pointer events.
 *
 * ── One scale, and when it grows ────────────────────────────────────────────
 * The meter the supervisor drags in the builder and the meter Insights draws
 * against the measured rate are one component on one scale,
 * {@link ABANDONMENT_SCALE_MAX_PCT}. So the line they place at 4% is the line
 * they later see the rate approach, at the same spot. An earlier meter was scaled
 * to the ceiling itself (full = the ceiling); that cannot show a line that moves.
 *
 * The editable meter never leaves 0–10%: it offers nothing above 10%, and a scale
 * that moved under the pointer mid-drag would be a slider that fights back. A
 * stored value above 10% (set through the API) pins its line at the right-hand end
 * and its label still says what it is. Insights only reads, and there a fixed
 * scale would lie: a 12% ceiling and an 11% rate would both draw at the end, a
 * full bar touching the line. So Insights grows the scale to fit
 * ({@link insightsScaleMaxPct}) only when one of the two is above 10%; every
 * campaign in the offered range still reads on the builder's own scale.
 *
 * ── The range ───────────────────────────────────────────────────────────────
 * The server accepts `> 0` and `<= 100` (`validateAbandonmentCeiling`, the column
 * CHECK). The console offers {@link ABANDONMENT_CEILING_MIN_PCT} to
 * {@link ABANDONMENT_CEILING_MAX_PCT}: below 0.5% one abandoned call in 200
 * answered pauses the campaign, and above 10% the guardrail is no longer a
 * guardrail. Above {@link ABANDONMENT_CEILING_REFERENCE_PCT} the field warns but
 * does not refuse: 3% is the limit most dropped-call rules set, and whether a
 * campaign falls under one is the account's call, not the form's.
 *
 * The range is what the console lets a supervisor CHOOSE, not what it will
 * re-save. A campaign PATCHed through the API to 7.25 or 25 is legal on the
 * server, and refusing it as stored would leave Save disabled for every other
 * edit on the page (a calling-hours fix included) until the supervisor changed a
 * number they never meant to touch. So {@link ceilingFieldError} accepts the
 * stored value exactly as loaded, and only a new value has to land in the range.
 */

/** The contract's default, which the server applies and the column defaults to. */
export const DEFAULT_ABANDONMENT_CEILING_PCT = AGENCY_DEFAULT_ABANDONMENT_CEILING_PCT;
/** The common regulatory dropped-call limit. Above it the field warns. */
export const ABANDONMENT_CEILING_REFERENCE_PCT = 3;
export const ABANDONMENT_CEILING_MIN_PCT = 0.5;
export const ABANDONMENT_CEILING_MAX_PCT = 10;
/** One decimal place: the step the slider, the keys and the box offer. */
export const ABANDONMENT_CEILING_STEP_PCT = 0.1;
/** The right-hand end of the editable meter, and of Insights' while nothing is above it. */
export const ABANDONMENT_SCALE_MAX_PCT = 10;
/** How many labelled intervals the scale has: six ticks, 0 to the end. */
const SCALE_INTERVALS = 5;

/** The labelled ticks under a meter whose scale ends at `scaleMaxPct`: six, evenly spaced from 0. */
export function abandonmentScaleTicks(scaleMaxPct: number = ABANDONMENT_SCALE_MAX_PCT): number[] {
  return Array.from({ length: SCALE_INTERVALS + 1 }, (_, i) => (scaleMaxPct * i) / SCALE_INTERVALS);
}

/**
 * The right-hand end of the read-only Insights meter: the builder's 10% while the
 * ceiling and the rate both fit on it, otherwise the next multiple of 5 at or above
 * the larger of the two (12 → 15, 25 → 25, 30.1 → 35), so neither is pinned at the
 * end and the gap between them is drawn to scale. Multiples of 5 keep the six ticks
 * on whole percents. A missing or non-finite rate (withheld) does not count.
 */
export function insightsScaleMaxPct(ceilingPct: number, ratePct?: number): number {
  const largest = Math.max(
    Number.isFinite(ceilingPct) ? ceilingPct : 0,
    ratePct !== undefined && Number.isFinite(ratePct) ? ratePct : 0,
  );
  if (largest <= ABANDONMENT_SCALE_MAX_PCT) return ABANDONMENT_SCALE_MAX_PCT;
  return Math.ceil(largest / 5) * 5;
}

const round1 = (value: number) => Math.round(value * 10) / 10;

/**
 * Where a percentage sits on a meter whose scale ends at `scaleMaxPct`, 0–100 (%
 * of the track's width), clamped to the track.
 */
export function meterPosition(valuePct: number, scaleMaxPct: number = ABANDONMENT_SCALE_MAX_PCT): number {
  return scaleMaxPct > 0 ? clampPercent((valuePct / scaleMaxPct) * 100) : 0;
}

/**
 * The ceiling as text, to two decimals: `3%`, `4.5%`, `7.25%`. The console only
 * offers tenths, but the server stores any decimal, and a ceiling of 7.25 printed
 * as `7.3%` would name a limit the guardrail does not use. Measured RATES stay on
 * one decimal.
 */
export function ceilingPctText(valuePct: number): string {
  return pct(valuePct, 2);
}

/**
 * Whether a measured rate is over the ceiling: ABOVE it, not at it, because the
 * guardrail pauses only then (`measured <= ceiling` keeps dialling) and every line
 * of copy says "more than". The one comparison the meter and the headline share.
 */
export function rateAboveCeiling(ratePct: number, ceilingPct: number): boolean {
  return ratePct > ceilingPct;
}

/**
 * The tone for a measured rate against the ceiling: `bad` above it, `warn` from
 * 80% of it up to and including it, otherwise none. The band is compared as
 * `5 × rate ≥ 4 × ceiling`: `3 * 0.8` is 2.4000000000000004, which would miss a
 * rate of exactly 2.4.
 */
export function abandonmentTone(ratePct: number, ceilingPct: number): 'bad' | 'warn' | undefined {
  if (rateAboveCeiling(ratePct, ceilingPct)) return 'bad';
  return ratePct * 5 >= ceilingPct * 4 ? 'warn' : undefined;
}

/**
 * How the number beside the line is anchored to it, from the line's position on
 * the track (0–100). Centred on the line in the middle of the track; near either
 * end it sits on the inner side of the line instead, so `0.5%` and `10%` stay over
 * the track rather than hanging off its edge (or off a narrow Insights tile).
 * Twelve percent of the track is more than half the widest label (`0.5%`) on the
 * narrowest track the meter is drawn on (a 170px Insights tile, less its padding).
 */
export function ceilingLabelAlign(positionPct: number): 'start' | 'center' | 'end' {
  if (positionPct < 12) return 'start';
  if (positionPct > 88) return 'end';
  return 'center';
}

/** A value forced into the offered range, on the 0.1 grid. */
export function clampCeiling(valuePct: number): number {
  if (!Number.isFinite(valuePct)) return DEFAULT_ABANDONMENT_CEILING_PCT;
  return round1(Math.min(ABANDONMENT_CEILING_MAX_PCT, Math.max(ABANDONMENT_CEILING_MIN_PCT, valuePct)));
}

/**
 * The ceiling under a pointer at `fraction` of the track's width (0 = left edge,
 * 1 = right edge), snapped and clamped. A drag past either end holds at the bound.
 */
export function ceilingFromTrackFraction(fraction: number): number {
  return clampCeiling(fraction * ABANDONMENT_SCALE_MAX_PCT);
}

/**
 * The slider's `aria-valuemin` / `aria-valuemax`: the offered range, widened to
 * take in a stored value outside it, so `aria-valuenow` is never outside its own
 * bounds (25 with a maximum of 10 is an invalid slider). A cleared field claims
 * no value and keeps the offered range.
 */
export function ceilingSliderBounds(valuePct: number): { min: number; max: number } {
  if (!Number.isFinite(valuePct)) return { min: ABANDONMENT_CEILING_MIN_PCT, max: ABANDONMENT_CEILING_MAX_PCT };
  return {
    min: Math.min(ABANDONMENT_CEILING_MIN_PCT, valuePct),
    max: Math.max(ABANDONMENT_CEILING_MAX_PCT, valuePct),
  };
}

const INCREASE_KEYS = new Set(['ArrowRight', 'ArrowUp', 'PageUp', 'End']);
const DECREASE_KEYS = new Set(['ArrowLeft', 'ArrowDown', 'PageDown', 'Home']);

/**
 * The slider's keyboard, per the WAI-ARIA slider pattern: arrows move one step,
 * Page Up / Page Down one whole percent, Home / End to the bounds. `null` for any
 * other key, so the caller leaves it to the browser.
 *
 * A stored value outside the offered range (25, set through the API) is the
 * slider's own bound: the meter widens `aria-valuemin`/`aria-valuemax` to take it
 * in. So a key that would push further out leaves it where it is (ArrowUp on 25
 * is not a drop to 10), and a step towards the range brings it in at the nearer
 * bound (ArrowDown or Page Down on 25 lands on 10, ArrowUp or Page Up on 0.2 on
 * 0.5); Home and End still go to the far bound.
 */
export function ceilingAfterKey(valuePct: number, key: string): number | null {
  const dir = INCREASE_KEYS.has(key) ? 1 : DECREASE_KEYS.has(key) ? -1 : 0;
  if (dir === 0) return null;
  const from = Number.isFinite(valuePct) ? valuePct : DEFAULT_ABANDONMENT_CEILING_PCT;
  // Never pushed further out of the range than it already is.
  if (dir > 0 ? from >= ABANDONMENT_CEILING_MAX_PCT : from <= ABANDONMENT_CEILING_MIN_PCT) return from;
  if (key === 'Home') return ABANDONMENT_CEILING_MIN_PCT;
  if (key === 'End') return ABANDONMENT_CEILING_MAX_PCT;
  // A step from outside the range enters it at the nearer bound (only an increase
  // reaches the first line, only a decrease the second).
  if (from < ABANDONMENT_CEILING_MIN_PCT) return ABANDONMENT_CEILING_MIN_PCT;
  if (from > ABANDONMENT_CEILING_MAX_PCT) return ABANDONMENT_CEILING_MAX_PCT;
  return clampCeiling(from + dir * (key.startsWith('Page') ? 1 : ABANDONMENT_CEILING_STEP_PCT));
}

/** The field's error, or `null`. Keyed `abandonment_ceiling_pct`, as the server keys its `details`. */
export function abandonmentCeilingError(valuePct: number): string | null {
  const range = `${pct(ABANDONMENT_CEILING_MIN_PCT)} and ${pct(ABANDONMENT_CEILING_MAX_PCT)}`;
  if (!Number.isFinite(valuePct)) return `Enter a limit between ${range}.`;
  if (valuePct < ABANDONMENT_CEILING_MIN_PCT || valuePct > ABANDONMENT_CEILING_MAX_PCT) {
    return `Set the limit between ${range}.`;
  }
  // Compared on the 0.1 grid with a tolerance: 2.3 is not exactly representable.
  if (Math.abs(round1(valuePct) - valuePct) > 1e-9) return 'Use at most one decimal place, like 3.5.';
  return null;
}

/**
 * The field's error with the stored value taken as it was loaded: `null` when
 * `valuePct` is the campaign's stored ceiling (`storedPct`, `null` for a campaign
 * not yet saved), whatever it is, else {@link abandonmentCeilingError}. Compared
 * with `Object.is`, the comparison the form uses everywhere else for this value,
 * so moving the line away and back to 25 is "unchanged" again. See "The range".
 */
export function ceilingFieldError(valuePct: number, storedPct: number | null): string | null {
  if (storedPct !== null && Object.is(valuePct, storedPct)) return null;
  return abandonmentCeilingError(valuePct);
}

/** True when the ceiling is above the common regulatory limit, so the field warns. */
export function ceilingAboveReference(valuePct: number): boolean {
  return Number.isFinite(valuePct) && valuePct > ABANDONMENT_CEILING_REFERENCE_PCT;
}

/** One line for the builder's summary and review: `Pauses above 3%`. */
export function ceilingSummary(valuePct: number): string {
  return Number.isFinite(valuePct) ? `Pauses above ${ceilingPctText(valuePct)}` : 'Not set';
}

/** The slider's spoken value. */
export function ceilingValueText(valuePct: number): string {
  return Number.isFinite(valuePct)
    ? `${ceilingPctText(valuePct)}: the campaign pauses when more than ${ceilingPctText(valuePct)} of answered calls are abandoned`
    : 'Not set';
}
