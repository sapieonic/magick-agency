import { describe, it, expect } from 'vitest';
import {
  CONNECTED_TILE_HINT,
  CONNECTED_WITH_REDIALS_HINT,
  CONNECTED_WITH_REDIALS_LABEL,
  connectRateLine,
  peopleReachedOfFirstDials,
} from '../../utils/agency/insights/copy';

/**
 * The two "Connected" counts on Calls and outcomes, said so they cannot be
 * read as one number. The tile leaves wrap-up redials out; the By outcome row
 * counts them; the rate is people reached over first dials.
 */
describe('connected copy', () => {
  it('names the By outcome row as including wrap-up redials, and the tile as leaving them out', () => {
    expect(CONNECTED_WITH_REDIALS_LABEL).toBe('Connected (including wrap-up redials)');
    expect(CONNECTED_WITH_REDIALS_HINT).toContain('including wrap-up redials');
    expect(CONNECTED_WITH_REDIALS_HINT).toContain('The Connected tile leaves those redials out.');
    expect(CONNECTED_TILE_HINT).toContain('not counting wrap-up redials');
    expect(CONNECTED_TILE_HINT).toContain('not this number over dials');
  });

  it('states the connect rate as people reached of first dials, named as the dialler’s beside the soft phone', () => {
    expect(peopleReachedOfFirstDials(70, 433)).toBe('70 people reached of 433 first dials');
    expect(peopleReachedOfFirstDials(1199, 1240)).toBe('1,199 people reached of 1,240 first dials');
    expect(connectRateLine('16.2%', 70, 433, false)).toBe('Connect rate 16.2% · 70 people reached of 433 first dials');
    expect(connectRateLine('30%', 360, 1199, true)).toBe('Dialler connect rate 30% · 360 people reached of 1,199 first dials');
    expect(connectRateLine('Not enough calls yet', 5, 20, false)).toBe(
      'Connect rate Not enough calls yet · 5 people reached of 20 first dials',
    );
  });
});
