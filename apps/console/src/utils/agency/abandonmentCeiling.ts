import { pct } from '../format/number';

/**
 * The abandonment ceiling (`abandonment_ceiling_pct`): the rolling 24-hour
 * abandonment rate (abandoned ÷ answered) above which a campaign pauses itself.
 *
 * Pure, so the drag, the keyboard and the typed value all go through the same
 * rounding and the same bounds, and every one of them is tested here rather than
 * through pointer events.
 *
 * ── One scale ───────────────────────────────────────────────────────────────
 * The meter the supervisor drags in the builder and the meter Insights draws
 * against the measured rate are one component on one fixed scale,
 * {@link ABANDONMENT_SCALE_MAX_PCT}. So the line they place at 4% is the line
 * they later see the rate approach, at the same spot. An earlier meter was scaled
 * to the ceiling itself (full = the ceiling); that cannot show a line that moves.
 *
 * ── The range ───────────────────────────────────────────────────────────────
 * The server accepts `> 0` and `<= 100` (`validateAbandonmentCeiling`, the column
 * CHECK). The console offers {@link ABANDONMENT_CEILING_MIN_PCT} to
 * {@link ABANDONMENT_CEILING_MAX_PCT}: below 0.5% one abandoned call in 200
 * answered pauses the campaign, and above 10% the guardrail is no longer a
 * guardrail. Above {@link ABANDONMENT_CEILING_REFERENCE_PCT} the field warns but
 * does not refuse: 3% is the limit most dropped-call rules set, and whether a
 * campaign falls under one is the account's call, not the form's.
 */

/** The server's `DEFAULT_ABANDONMENT_CEILING_PCT` and the column's DEFAULT. */
export const DEFAULT_ABANDONMENT_CEILING_PCT = 3;
/** The common regulatory dropped-call limit. Above it the field warns. */
export const ABANDONMENT_CEILING_REFERENCE_PCT = 3;
export const ABANDONMENT_CEILING_MIN_PCT = 0.5;
export const ABANDONMENT_CEILING_MAX_PCT = 10;
/** One decimal place: what `pct()` prints, so a stored value is never shown rounded. */
export const ABANDONMENT_CEILING_STEP_PCT = 0.1;
/** The right-hand end of every abandonment meter. */
export const ABANDONMENT_SCALE_MAX_PCT = 10;
/** The labelled ticks under the meter. */
export const ABANDONMENT_SCALE_TICKS: readonly number[] = [0, 2, 4, 6, 8, 10];

const round1 = (value: number) => Math.round(value * 10) / 10;

/** Where a percentage sits on the meter, 0–100 (% of the track's width), clamped to the track. */
export function meterPosition(valuePct: number): number {
  if (!Number.isFinite(valuePct)) return 0;
  return Math.min(100, Math.max(0, (valuePct / ABANDONMENT_SCALE_MAX_PCT) * 100));
}

/**
 * How the number beside the line is anchored to it, from the line's position on
 * the track (0–100). Centred on the line in the middle of the track; near either
 * end it sits on the inner side of the line instead, so `0.5%` and `10%` stay over
 * the track rather than hanging off its edge (or off a narrow Insights tile).
 * Twelve percent of the track is more than half the widest label (`0.5%`) on the
 * narrowest track the meter is drawn on (a 170px Insights tile, less its padding).
 */
export type CeilingLabelAlign = 'start' | 'center' | 'end';
export function ceilingLabelAlign(positionPct: number): CeilingLabelAlign {
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
 * The slider's keyboard, per the WAI-ARIA slider pattern: arrows move one step,
 * Page Up / Page Down one whole percent, Home / End to the bounds. `null` for any
 * other key, so the caller leaves it to the browser.
 */
export function ceilingAfterKey(valuePct: number, key: string): number | null {
  // From an out-of-range stored value the first key brings it into range.
  const from = Number.isFinite(valuePct) ? valuePct : DEFAULT_ABANDONMENT_CEILING_PCT;
  switch (key) {
    case 'ArrowRight':
    case 'ArrowUp':
      return clampCeiling(from + ABANDONMENT_CEILING_STEP_PCT);
    case 'ArrowLeft':
    case 'ArrowDown':
      return clampCeiling(from - ABANDONMENT_CEILING_STEP_PCT);
    case 'PageUp':
      return clampCeiling(from + 1);
    case 'PageDown':
      return clampCeiling(from - 1);
    case 'Home':
      return ABANDONMENT_CEILING_MIN_PCT;
    case 'End':
      return ABANDONMENT_CEILING_MAX_PCT;
    default:
      return null;
  }
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

/** True when the ceiling is above the common regulatory limit, so the field warns. */
export function ceilingAboveReference(valuePct: number): boolean {
  return Number.isFinite(valuePct) && valuePct > ABANDONMENT_CEILING_REFERENCE_PCT;
}

/** One line for the builder's summary and review: `Pauses above 3%`. */
export function ceilingSummary(valuePct: number): string {
  return Number.isFinite(valuePct) ? `Pauses above ${pct(valuePct)}` : 'Not set';
}

/** The slider's spoken value. */
export function ceilingValueText(valuePct: number): string {
  return Number.isFinite(valuePct)
    ? `${pct(valuePct)}: the campaign pauses when more than ${pct(valuePct)} of answered calls are abandoned`
    : 'Not set';
}
