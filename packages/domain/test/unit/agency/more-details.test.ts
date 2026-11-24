import { describe, expect, it } from 'vitest';
import { AGENCY_MORE_DETAILS_MAX } from '@magick-agency/contracts/agency';
import { moreDetailTiles } from '../../../src/more-details';

/** AS20: the bounds the shared cases (`fact-rules.json`, `more_detail_tiles`) do not reach. */
describe('moreDetailTiles', () => {
  it(`stops at AGENCY_MORE_DETAILS_MAX (${AGENCY_MORE_DETAILS_MAX}) columns, in order`, () => {
    const row = Object.fromEntries(Array.from({ length: AGENCY_MORE_DETAILS_MAX + 20 }, (_, i) => [`col ${i}`, `v${i}`]));
    const tiles = moreDetailTiles(row, { facts: [] });
    expect(tiles).toHaveLength(AGENCY_MORE_DETAILS_MAX);
    expect(tiles[0]!.column).toBe('col 0');
    expect(tiles.at(-1)!.column).toBe(`col ${AGENCY_MORE_DETAILS_MAX - 1}`);
  });

  it('counts only the columns it sends against the cap', () => {
    const row: Record<string, unknown> = { Name: 'Asha' };
    for (let i = 0; i < AGENCY_MORE_DETAILS_MAX; i++) row[`blank ${i}`] = '';
    row['Last'] = 'shown';
    expect(moreDetailTiles(row, { facts: [] }).map((t) => t.column)).toEqual(['Last']);
  });

  it('reads a hand-edited display leniently: a more_hidden that is not a list hides nothing', () => {
    const tiles = moreDetailTiles({ Branch: 'Kothrud' }, { facts: [], more_hidden: 'Branch', order: 'Branch' });
    expect(tiles.map((t) => t.column)).toEqual(['Branch']);
  });
});
