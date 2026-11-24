import { describe, expect, it } from 'vitest';
import { AGENCY_MORE_DETAILS_MAX } from '@magick-agency/contracts/agency';
import { moreDetailTiles, moreDetailTypeOf } from '../../../src/more-details';

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

  it('a stored type that is not one of the six is no declaration: a phone-looking value is still a phone', () => {
    expect(moreDetailTypeOf('Alt', '9876543210', { Alt: null })).toBe('phone');
    expect(moreDetailTypeOf('Alt', '9876543210', { alt: 'mobile' })).toBe('phone');
    expect(moreDetailTypeOf('Alt', '9876543210', { ALT: 'text' })).toBe('text');
  });

  it('on a card that has not chosen its facts, the amount-due and due-date role columns read as on the card', () => {
    const row = { 'Amount Due': '₹1,25,000', 'Due Date': '25/11/2026', Note: 'ok' };
    const display = { roles: { amount_due: 'amount due', due_date: 'Due Date' }, types: { 'Due Date': 'text' } };
    const now = new Date('2026-11-20T06:00:00Z');
    expect(moreDetailTiles(row, display, null, now)).toEqual([
      { column: 'Amount Due', type: 'money', raw: '₹1,25,000', value: '125000' },
      { column: 'Due Date', type: 'date', raw: '25/11/2026', value: '2026-11-25' },
      { column: 'Note', type: 'text', raw: 'ok', value: null },
    ]);
    // With chosen facts the roles are not read for types.
    expect(moreDetailTiles(row, { ...display, facts: [] }, null, now)[0]!.type).toBe('text');
  });
});
