import { describe, it, expect } from 'vitest';
import {
  ABANDONMENT_CEILING_MAX_PCT,
  ABANDONMENT_CEILING_MIN_PCT,
  ABANDONMENT_CEILING_REFERENCE_PCT,
  ABANDONMENT_CEILING_STEP_PCT,
  ABANDONMENT_SCALE_MAX_PCT,
  DEFAULT_ABANDONMENT_CEILING_PCT,
  abandonmentCeilingError,
  abandonmentScaleTicks,
  abandonmentTone,
  ceilingAboveReference,
  ceilingAfterKey,
  ceilingFieldError,
  ceilingFromTrackFraction,
  ceilingLabelAlign,
  ceilingPctText,
  ceilingSliderBounds,
  ceilingSummary,
  ceilingValueText,
  clampCeiling,
  insightsScaleMaxPct,
  meterPosition,
  rateAboveCeiling,
} from '../../utils/agency/abandonmentCeiling';
import { AGENCY_DEFAULT_ABANDONMENT_CEILING_PCT } from '@magick-agency/contracts/agency';

/**
 * The abandonment ceiling's rules, pure. The drag, the slider's keys and the
 * typed value all go through these, so the meter's component tests only need to
 * show that each input reaches them; the rounding and the bounds are pinned here.
 */

describe('the constants', () => {
  it('defaults to the server’s 3%, on a 0–10% scale offering 0.5–10% in tenths', () => {
    expect(DEFAULT_ABANDONMENT_CEILING_PCT).toBe(3);
    expect(ABANDONMENT_CEILING_REFERENCE_PCT).toBe(3);
    expect(ABANDONMENT_CEILING_MIN_PCT).toBe(0.5);
    expect(ABANDONMENT_CEILING_MAX_PCT).toBe(10);
    expect(ABANDONMENT_CEILING_STEP_PCT).toBe(0.1);
    expect(ABANDONMENT_SCALE_MAX_PCT).toBe(10);
    expect(abandonmentScaleTicks()).toEqual([0, 2, 4, 6, 8, 10]);
  });
});

describe('meterPosition', () => {
  it('places a percentage on the fixed scale, not on the ceiling', () => {
    expect(meterPosition(0)).toBe(0);
    expect(meterPosition(3)).toBe(30);
    expect(meterPosition(2.1)).toBeCloseTo(21, 10);
    expect(meterPosition(10)).toBe(100);
  });

  it('never draws outside the track', () => {
    expect(meterPosition(15)).toBe(100);
    expect(meterPosition(-1)).toBe(0);
    expect(meterPosition(Number.NaN)).toBe(0);
    expect(meterPosition(Number.POSITIVE_INFINITY)).toBe(0);
  });

  it('places a percentage on a wider scale when given one', () => {
    expect(meterPosition(12, 15)).toBe(80);
    expect(meterPosition(25, 25)).toBe(100);
    expect(meterPosition(5, 25)).toBe(20);
    expect(meterPosition(30, 25)).toBe(100);
    expect(meterPosition(3, 0)).toBe(0);
  });
});

describe('insightsScaleMaxPct', () => {
  it('stays on the builder’s 0–10% while the ceiling and the rate both fit', () => {
    expect(insightsScaleMaxPct(3, 2.1)).toBe(10);
    expect(insightsScaleMaxPct(10, 10)).toBe(10);
    expect(insightsScaleMaxPct(3)).toBe(10);
    expect(insightsScaleMaxPct(3, Number.NaN)).toBe(10);
  });

  it('grows to the next multiple of 5 at or above the larger of the two', () => {
    expect(insightsScaleMaxPct(12, 11)).toBe(15);
    expect(insightsScaleMaxPct(25)).toBe(25);
    expect(insightsScaleMaxPct(30.1)).toBe(35);
    // A rate past a low ceiling grows it too, so the fill is not pinned at the end.
    expect(insightsScaleMaxPct(3, 12)).toBe(15);
    expect(insightsScaleMaxPct(10, 10.01)).toBe(15);
    expect(insightsScaleMaxPct(100, 4)).toBe(100);
  });
});

describe('abandonmentScaleTicks', () => {
  it('labels six evenly spaced ticks from 0 to the end of the scale', () => {
    expect(abandonmentScaleTicks()).toEqual([0, 2, 4, 6, 8, 10]);
    expect(abandonmentScaleTicks(15)).toEqual([0, 3, 6, 9, 12, 15]);
    expect(abandonmentScaleTicks(25)).toEqual([0, 5, 10, 15, 20, 25]);
    expect(abandonmentScaleTicks(35)).toEqual([0, 7, 14, 21, 28, 35]);
  });
});

describe('ceilingLabelAlign', () => {
  it('centres the number on the line in the middle of the track', () => {
    expect(ceilingLabelAlign(12)).toBe('center');
    expect(ceilingLabelAlign(30)).toBe('center');
    expect(ceilingLabelAlign(88)).toBe('center');
  });

  it('keeps the number over the track at either end', () => {
    // 0.5% is 5% of the track; 10% is the right-hand edge.
    expect(ceilingLabelAlign(meterPosition(ABANDONMENT_CEILING_MIN_PCT))).toBe('start');
    expect(ceilingLabelAlign(11.9)).toBe('start');
    expect(ceilingLabelAlign(88.1)).toBe('end');
    expect(ceilingLabelAlign(meterPosition(ABANDONMENT_CEILING_MAX_PCT))).toBe('end');
  });
});

describe('clampCeiling', () => {
  it('holds a value at the offered bounds', () => {
    expect(clampCeiling(0.1)).toBe(0.5);
    expect(clampCeiling(0)).toBe(0.5);
    expect(clampCeiling(-4)).toBe(0.5);
    expect(clampCeiling(12)).toBe(10);
    expect(clampCeiling(100)).toBe(10);
  });

  it('snaps to the 0.1 grid', () => {
    expect(clampCeiling(3.04)).toBe(3);
    expect(clampCeiling(3.05)).toBe(3.1);
    expect(clampCeiling(4.449)).toBe(4.4);
    // Exactly the double `pct()` prints, not 3.0000000000000004.
    expect(clampCeiling(2.9 + 0.1)).toBe(3);
  });

  it('falls back to the default for a value that is not a number', () => {
    expect(clampCeiling(Number.NaN)).toBe(3);
    expect(clampCeiling(Number.POSITIVE_INFINITY)).toBe(3);
  });
});

describe('ceilingFromTrackFraction', () => {
  it('maps the pointer’s place on the track to the scale, snapped', () => {
    expect(ceilingFromTrackFraction(0.3)).toBe(3);
    expect(ceilingFromTrackFraction(0.452)).toBe(4.5);
    expect(ceilingFromTrackFraction(0.4567)).toBe(4.6);
    expect(ceilingFromTrackFraction(1)).toBe(10);
  });

  it('holds at the bound when the drag runs past either end', () => {
    expect(ceilingFromTrackFraction(0)).toBe(0.5);
    expect(ceilingFromTrackFraction(0.02)).toBe(0.5);
    expect(ceilingFromTrackFraction(-0.4)).toBe(0.5);
    expect(ceilingFromTrackFraction(1.7)).toBe(10);
  });
});

describe('ceilingAfterKey', () => {
  it('moves one tenth on the arrows', () => {
    expect(ceilingAfterKey(3, 'ArrowRight')).toBe(3.1);
    expect(ceilingAfterKey(3, 'ArrowUp')).toBe(3.1);
    expect(ceilingAfterKey(3, 'ArrowLeft')).toBe(2.9);
    expect(ceilingAfterKey(3, 'ArrowDown')).toBe(2.9);
  });

  it('moves one whole percent on Page Up and Page Down', () => {
    expect(ceilingAfterKey(3, 'PageUp')).toBe(4);
    expect(ceilingAfterKey(3, 'PageDown')).toBe(2);
  });

  it('goes to the bounds on Home and End', () => {
    expect(ceilingAfterKey(3, 'Home')).toBe(0.5);
    expect(ceilingAfterKey(3, 'End')).toBe(10);
  });

  it('stops at the bounds rather than passing them', () => {
    expect(ceilingAfterKey(10, 'ArrowRight')).toBe(10);
    expect(ceilingAfterKey(9.5, 'PageUp')).toBe(10);
    expect(ceilingAfterKey(0.5, 'ArrowLeft')).toBe(0.5);
    expect(ceilingAfterKey(1, 'PageDown')).toBe(0.5);
  });

  it('brings an out-of-range stored value into range on the first key towards it', () => {
    expect(ceilingAfterKey(25, 'ArrowDown')).toBe(10);
    expect(ceilingAfterKey(25, 'PageDown')).toBe(10);
    expect(ceilingAfterKey(25, 'Home')).toBe(0.5);
    expect(ceilingAfterKey(0.2, 'ArrowUp')).toBe(0.5);
    expect(ceilingAfterKey(0.2, 'PageUp')).toBe(0.5);
    expect(ceilingAfterKey(0.2, 'End')).toBe(10);
    // A cleared field steps from the default.
    expect(ceilingAfterKey(Number.NaN, 'ArrowUp')).toBe(3.1);
  });

  it('leaves an out-of-range stored value alone on a key away from the range', () => {
    // ArrowUp on 25 used to drop it to 10: an "increase" that lowered the limit.
    for (const key of ['ArrowUp', 'ArrowRight', 'PageUp', 'End']) {
      expect(ceilingAfterKey(25, key), key).toBe(25);
    }
    for (const key of ['ArrowDown', 'ArrowLeft', 'PageDown', 'Home']) {
      expect(ceilingAfterKey(0.2, key), key).toBe(0.2);
    }
  });

  it('leaves every other key to the browser', () => {
    expect(ceilingAfterKey(3, 'Tab')).toBeNull();
    expect(ceilingAfterKey(3, 'Enter')).toBeNull();
    expect(ceilingAfterKey(3, 'a')).toBeNull();
  });
});

describe('abandonmentCeilingError', () => {
  it('accepts the bounds, the default and a value on the grid', () => {
    expect(abandonmentCeilingError(0.5)).toBeNull();
    expect(abandonmentCeilingError(3)).toBeNull();
    expect(abandonmentCeilingError(10)).toBeNull();
    // 2.3 is not exactly representable; the grid check has a tolerance.
    expect(abandonmentCeilingError(2.3)).toBeNull();
    expect(abandonmentCeilingError(4.5)).toBeNull();
  });

  it('refuses a value below the minimum or above the maximum, naming the range', () => {
    expect(abandonmentCeilingError(0.4)).toBe('Set the limit between 0.5% and 10%.');
    expect(abandonmentCeilingError(0)).toBe('Set the limit between 0.5% and 10%.');
    expect(abandonmentCeilingError(10.1)).toBe('Set the limit between 0.5% and 10%.');
    expect(abandonmentCeilingError(15)).toBe('Set the limit between 0.5% and 10%.');
  });

  it('asks for a value when there is none', () => {
    expect(abandonmentCeilingError(Number.NaN)).toBe('Enter a limit between 0.5% and 10%.');
  });

  it('refuses a second decimal place', () => {
    expect(abandonmentCeilingError(2.25)).toBe('Use at most one decimal place, like 3.5.');
    expect(abandonmentCeilingError(3.01)).toBe('Use at most one decimal place, like 3.5.');
  });
});

describe('ceilingFieldError', () => {
  it('accepts the stored value as stored, in range or not (AC1)', () => {
    expect(ceilingFieldError(25, 25)).toBeNull();
    expect(ceilingFieldError(7.25, 7.25)).toBeNull();
    expect(ceilingFieldError(0.2, 0.2)).toBeNull();
  });

  it('holds a new value to the offered range and one decimal', () => {
    expect(ceilingFieldError(26, 25)).toBe('Set the limit between 0.5% and 10%.');
    expect(ceilingFieldError(7.15, 7.25)).toBe('Use at most one decimal place, like 3.5.');
    expect(ceilingFieldError(4, 25)).toBeNull();
    expect(ceilingFieldError(Number.NaN, 25)).toBe('Enter a limit between 0.5% and 10%.');
  });

  it('holds every value to the range on a campaign with nothing stored', () => {
    expect(ceilingFieldError(25, null)).toBe('Set the limit between 0.5% and 10%.');
    expect(ceilingFieldError(3, null)).toBeNull();
  });
});

describe('ceilingSliderBounds', () => {
  it('is the offered range, widened to take in a stored value outside it', () => {
    expect(ceilingSliderBounds(3)).toEqual({ min: 0.5, max: 10 });
    expect(ceilingSliderBounds(25)).toEqual({ min: 0.5, max: 25 });
    expect(ceilingSliderBounds(0.2)).toEqual({ min: 0.2, max: 10 });
    expect(ceilingSliderBounds(Number.NaN)).toEqual({ min: 0.5, max: 10 });
  });
});

describe('ceilingAboveReference', () => {
  it('warns above 3% and not at it', () => {
    expect(ceilingAboveReference(3)).toBe(false);
    expect(ceilingAboveReference(2.5)).toBe(false);
    expect(ceilingAboveReference(3.1)).toBe(true);
    expect(ceilingAboveReference(10)).toBe(true);
    expect(ceilingAboveReference(Number.NaN)).toBe(false);
  });
});

describe('the copy', () => {
  it('prints the ceiling to two decimals, trimmed, where pct() would round it', () => {
    expect(ceilingPctText(3)).toBe('3%');
    expect(ceilingPctText(4.5)).toBe('4.5%');
    expect(ceilingPctText(7.25)).toBe('7.25%');
    expect(ceilingPctText(25)).toBe('25%');
    expect(ceilingPctText(2.3)).toBe('2.3%');
  });

  it('summarises the limit for the builder’s rail and review', () => {
    expect(ceilingSummary(3)).toBe('Pauses above 3%');
    expect(ceilingSummary(4.5)).toBe('Pauses above 4.5%');
    expect(ceilingSummary(7.25)).toBe('Pauses above 7.25%');
    expect(ceilingSummary(Number.NaN)).toBe('Not set');
  });

  it('gives the slider a value text that says what the number does', () => {
    expect(ceilingValueText(3)).toBe(
      '3%: the campaign pauses when more than 3% of answered calls are abandoned',
    );
    expect(ceilingValueText(7.25)).toBe(
      '7.25%: the campaign pauses when more than 7.25% of answered calls are abandoned',
    );
    expect(ceilingValueText(Number.NaN)).toBe('Not set');
  });
});

describe('the default', () => {
  it('is the contract’s, the one the server applies', () => {
    expect(DEFAULT_ABANDONMENT_CEILING_PCT).toBe(AGENCY_DEFAULT_ABANDONMENT_CEILING_PCT);
    expect(AGENCY_DEFAULT_ABANDONMENT_CEILING_PCT).toBe(3);
  });
});

describe('a rate against the ceiling', () => {
  it('is over only above it, as the guardrail pauses', () => {
    expect(rateAboveCeiling(3, 3)).toBe(false);
    expect(rateAboveCeiling(3.01, 3)).toBe(true);
    expect(rateAboveCeiling(2.9, 3)).toBe(false);
  });

  it('warns from 80% of the ceiling up to and including it, and is bad only above it', () => {
    expect(abandonmentTone(2.3, 3)).toBeUndefined();
    // Exactly 80%: `3 * 0.8` is 2.4000000000000004, which a naive compare would miss.
    expect(abandonmentTone(2.4, 3)).toBe('warn');
    expect(abandonmentTone(3, 3)).toBe('warn');
    expect(abandonmentTone(3.1, 3)).toBe('bad');
    expect(abandonmentTone(4, 5)).toBe('warn');
    expect(abandonmentTone(3.9, 5)).toBeUndefined();
  });
});
