import { describe, it, expect } from 'vitest';
import {
  ABANDONMENT_CEILING_MAX_PCT,
  ABANDONMENT_CEILING_MIN_PCT,
  ABANDONMENT_CEILING_REFERENCE_PCT,
  ABANDONMENT_CEILING_STEP_PCT,
  ABANDONMENT_SCALE_MAX_PCT,
  ABANDONMENT_SCALE_TICKS,
  DEFAULT_ABANDONMENT_CEILING_PCT,
  abandonmentCeilingError,
  ceilingAboveReference,
  ceilingAfterKey,
  ceilingFromTrackFraction,
  ceilingLabelAlign,
  ceilingSummary,
  ceilingValueText,
  clampCeiling,
  meterPosition,
} from '../../utils/agency/abandonmentCeiling';

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
    expect(ABANDONMENT_SCALE_TICKS).toEqual([0, 2, 4, 6, 8, 10]);
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

  it('brings an out-of-range stored value into range on the first key', () => {
    expect(ceilingAfterKey(25, 'ArrowDown')).toBe(10);
    expect(ceilingAfterKey(0.2, 'ArrowUp')).toBe(0.5);
    // A cleared field steps from the default.
    expect(ceilingAfterKey(Number.NaN, 'ArrowUp')).toBe(3.1);
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
  it('summarises the limit for the builder’s rail and review', () => {
    expect(ceilingSummary(3)).toBe('Pauses above 3%');
    expect(ceilingSummary(4.5)).toBe('Pauses above 4.5%');
    expect(ceilingSummary(Number.NaN)).toBe('Not set');
  });

  it('gives the slider a value text that says what the number does', () => {
    expect(ceilingValueText(3)).toBe(
      '3%: the campaign pauses when more than 3% of answered calls are abandoned',
    );
    expect(ceilingValueText(Number.NaN)).toBe('Not set');
  });
});
