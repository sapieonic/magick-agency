import { describe, expect, it } from 'vitest';
import { AGENCY_TILE_ICONS } from '@magick-agency/contracts/agency';
import {
  dispositionsWithKnownIcons,
  phoneDisplayIssues,
  phoneDisplayOf,
  stationTileIssues,
  tileIconIssues,
} from '../../../src/agency/station-tiles.js';
import { validateAgencyCampaignConfig as internalValidate } from '../../../src/agency/campaign-config.js';
import { validateAgencyCampaignConfig as publicValidate } from '../../../src/agency/agency-campaign-config.js';

/**
 * The agent station's tile pictures (BE-13) and number display (AS9), pure (`agency/station-tiles.ts`):
 * the write's rules, refusing with the entry named, in both campaign-config validators; the reads
 * that drop an icon the contract does not list and read an unknown display as `full`.
 */

describe('tile icons, the write (BE-13)', () => {
  it('every listed icon is accepted on an outcome and a break reason; absent is none', () => {
    const catalog = AGENCY_TILE_ICONS.map((icon, i) => ({ code: `c${i}`, label: 'x', icon }));
    expect(tileIconIssues({ disposition_catalog: catalog, break_reasons: catalog })).toEqual([]);
    expect(tileIconIssues({ disposition_catalog: [{ code: 'a', label: 'A' }], break_reasons: [{ code: 'tea', label: 'Tea' }] })).toEqual([]);
  });

  it('anything else is refused, the entry named: an unknown key, null, a number, a different case', () => {
    // FALSIFIED: with the `isAgencyTileIcon` check removed, these return no issues and red.
    for (const icon of ['skull', null, 7, 'Rupee']) {
      expect(tileIconIssues({ disposition_catalog: [{ code: 'a', label: 'A' }, { code: 'b', label: 'B', icon }] }), String(icon))
        .toEqual([{ field: 'disposition_catalog[1].icon', message: 'Choose one of the tile pictures, or no picture.' }]);
      expect(tileIconIssues({ break_reasons: [{ code: 'tea', label: 'Tea', icon }] }), String(icon))
        .toEqual([{ field: 'break_reasons[0].icon', message: 'Choose one of the tile pictures, or no picture.' }]);
    }
  });

  it('both campaign-config validators refuse them, with the same field', () => {
    const body = { disposition_catalog: [{ code: 'a', label: 'A', icon: 'skull' }], break_reasons: [{ code: 'tea', label: 'Tea', icon: 'mug' }], phone_display: 'blur' };
    for (const issues of [internalValidate(body), publicValidate(body)]) {
      const fields = issues.map((i) => i.field);
      expect(fields).toEqual(expect.arrayContaining(['disposition_catalog[0].icon', 'break_reasons[0].icon', 'phone_display']));
    }
  });
});

describe('phone_display, the write (AS9)', () => {
  it('full or masked, or absent; anything else refused', () => {
    expect(phoneDisplayIssues({})).toEqual([]);
    expect(phoneDisplayIssues({ phone_display: 'full' })).toEqual([]);
    expect(phoneDisplayIssues({ phone_display: 'masked' })).toEqual([]);
    for (const v of [null, 'hidden', 'Masked', 0]) {
      expect(phoneDisplayIssues({ phone_display: v }), String(v)).toEqual([{ field: 'phone_display', message: 'Choose how agents see the customer’s number: in full, or with the middle digits hidden.' }]);
    }
    expect(stationTileIssues({ phone_display: 'x', disposition_catalog: [{ code: 'a', label: 'A', icon: 'x' }] }).map((i) => i.field))
      .toEqual(['disposition_catalog[0].icon', 'phone_display']);
  });
});

describe('the reads', () => {
  it('an outcome keeps a listed icon, loses an unknown one (no icon at all), and is otherwise untouched', () => {
    const catalog = [
      { code: 'pay', label: 'Will pay', is_success: true, icon: 'rupee' as const },
      { code: 'no', label: 'Refused', icon: 'skull' as never },
      { code: 'later', label: 'Call later', requires_datetime: true },
    ];
    expect(dispositionsWithKnownIcons(catalog)).toEqual([catalog[0], { code: 'no', label: 'Refused' }, catalog[2]]);
    expect(dispositionsWithKnownIcons(null)).toEqual([]);
  });

  it('phone_display: an unknown or missing value reads as full', () => {
    expect(phoneDisplayOf('masked')).toBe('masked');
    expect(phoneDisplayOf('full')).toBe('full');
    expect(phoneDisplayOf(undefined)).toBe('full');
    expect(phoneDisplayOf('blur')).toBe('full');
  });
});
