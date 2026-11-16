import { describe, it, expect } from 'vitest';
import {
  CONNECTED_TILE_HINT,
  CONNECTED_WITH_REDIALS_HINT,
  CONNECTED_WITH_REDIALS_LABEL,
  connectRateLine,
  connectRateName,
  peopleAnsweredOfFirstDials,
  peopleAnsweredRest,
} from '../../utils/agency/insights/copy';

/**
 * The two "Connected" counts on Calls and outcomes, said so they cannot be
 * read as one number. The tile leaves wrap-up redials out; the By outcome row
 * counts them; the rate is people answered over first dials placed, the
 * Performance card's words.
 */
describe('connected copy', () => {
  it('names the By outcome row as including wrap-up redials, and the tile as leaving them out', () => {
    expect(CONNECTED_WITH_REDIALS_LABEL).toBe('Connected (including wrap-up redials)');
    expect(CONNECTED_WITH_REDIALS_HINT).toContain('including wrap-up redials');
    expect(CONNECTED_WITH_REDIALS_HINT).toContain('The Connected tile leaves those redials out.');
    expect(CONNECTED_TILE_HINT).toContain('not counting wrap-up redials');
    expect(CONNECTED_TILE_HINT).toContain('people answered');
    expect(CONNECTED_TILE_HINT).toContain('not this number over dials');
  });

  it('states the connect rate as people answered, of first dials placed, and agrees in the singular', () => {
    expect(connectRateName(false)).toBe('Connect rate');
    expect(connectRateName(true)).toBe('Dialler connect rate');
    expect(peopleAnsweredRest(1509, 6737)).toBe('people answered, of 6,737 first dials placed');
    expect(peopleAnsweredOfFirstDials(70, 433)).toBe('70 people answered, of 433 first dials placed');
    expect(peopleAnsweredOfFirstDials(1, 1)).toBe('1 person answered, of 1 first dial placed');
    expect(peopleAnsweredOfFirstDials(1199, 1240)).toBe('1,199 people answered, of 1,240 first dials placed');
    expect(connectRateLine('16.2%', 70, 433, false)).toBe('Connect rate 16.2% · 70 people answered, of 433 first dials placed');
    expect(connectRateLine('30%', 360, 1199, true)).toBe('Dialler connect rate 30% · 360 people answered, of 1,199 first dials placed');
    expect(connectRateLine('Not enough calls yet', 5, 20, false)).toBe(
      'Connect rate Not enough calls yet · 5 people answered, of 20 first dials placed',
    );
  });
});
