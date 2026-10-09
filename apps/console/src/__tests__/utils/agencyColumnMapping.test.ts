import { describe, it, expect } from 'vitest';
import {
  initialMapping,
  setRole,
  setDefaultCountryCode,
  countryCodeError,
  mappingBlockReason,
  buildIngestRequest,
  buildContextDisplay,
  phoneValidityLine,
  heroLimitReached,
  phoneColumn,
  timezoneColumn,
  ignoredColumns,
  MAX_HERO_FIELDS,
} from '../../utils/agencyColumnMapping';
import type { AgencyColumnAnalysis, AgencyColumnStat } from '../../types/agency-campaign';

/**
 * `AD-P3-U-01` acceptance (a): *the operator can map any column as the phone
 * number*. The file below is the spec's own — no column is called `phone`, the
 * timezone column is called `TZ`, and one column holds an internal score an
 * agent must never see.
 */

function column(name: string, over: Partial<AgencyColumnStat> = {}): AgencyColumnStat {
  return { name, index: 0, samples: [], non_empty: 100, phone_score: 0, ...over };
}

function analysis(over: Partial<AgencyColumnAnalysis> = {}): AgencyColumnAnalysis {
  return {
    headers: ['Cust Mobile', 'Full Name', 'TZ', 'Internal Score'],
    columns: [
      column('Cust Mobile', { index: 0, phone_score: 0.95, samples: ['9820041772'] }),
      column('Full Name', { index: 1 }),
      column('TZ', { index: 2, samples: ['Asia/Kolkata'] }),
      column('Internal Score', { index: 3 }),
    ],
    rows_sampled: 100,
    truncated: false,
    suggested_phone_column: 'Cust Mobile',
    phone_column_ambiguous: false,
    phone_column_candidates: [],
    ...over,
  };
}

describe('seeding the mapping from master analysis', () => {
  it('preselects the suggested phone column and leaves everything else Detail', () => {
    const state = initialMapping(analysis());
    expect(state.roles['Cust Mobile']).toBe('phone');
    expect(state.roles['Full Name']).toBe('detail');
    expect(state.roles['TZ']).toBe('detail');
  });

  it('preselects NOTHING when master withheld the suggestion as ambiguous', () => {
    // Master withholds when two columns score within 10% of each other. Picking
    // the higher one anyway dials the wrong people, and the operator never sees
    // that a choice was made for them.
    const state = initialMapping(
      analysis({
        suggested_phone_column: null,
        phone_column_ambiguous: true,
        phone_column_candidates: ['Cust Mobile', 'Alt Mobile'],
      }),
    );
    expect(phoneColumn(state)).toBeNull();
    expect(mappingBlockReason(state)).toBe('no_phone_column');
  });

  it('never auto-detects a timezone column', () => {
    // D4: an unmapped contact uses the campaign default. A column called `TZ`
    // holding something else, silently mapped, is worse than asking.
    expect(timezoneColumn(initialMapping(analysis()))).toBeNull();
  });
});

describe('role arity', () => {
  it('moves the phone role rather than allowing two phone columns', () => {
    const state = setRole(initialMapping(analysis()), 'Full Name', 'phone');
    expect(phoneColumn(state)).toBe('Full Name');
    expect(state.roles['Cust Mobile']).toBe('detail');
  });

  it('allows at most one timezone column, demoting the previous holder', () => {
    let state = setRole(initialMapping(analysis()), 'TZ', 'timezone');
    state = setRole(state, 'Full Name', 'timezone');
    expect(timezoneColumn(state)).toBe('Full Name');
    expect(state.roles['TZ']).toBe('detail');
  });

  it('caps hero fields and reports the cap instead of silently dropping the pick', () => {
    const wide = analysis({
      columns: ['a', 'b', 'c', 'd', 'e'].map((n, i) => column(n, { index: i })),
    });
    let state = initialMapping(wide);
    for (const name of ['a', 'b', 'c', 'd']) state = setRole(state, name, 'hero');
    expect(heroLimitReached(state)).toBe(true);

    const after = setRole(state, 'e', 'hero');
    expect(after.heroOrder).toHaveLength(MAX_HERO_FIELDS);
    expect(after.roles['e']).not.toBe('hero');
  });

  it('keeps hero order as the operator picked it, not file order', () => {
    // This is the agent's reading order — the first hero is what they read while
    // the phone is ringing — so it is a real decision, not cosmetic.
    let state = initialMapping(analysis());
    state = setRole(state, 'Internal Score', 'hero');
    state = setRole(state, 'Full Name', 'hero');
    expect(state.heroOrder).toEqual(['Internal Score', 'Full Name']);
    expect(buildContextDisplay(state).hero).toEqual(['Internal Score', 'Full Name']);
  });

  it('drops a column out of hero order when it is re-roled', () => {
    let state = setRole(initialMapping(analysis()), 'Full Name', 'hero');
    state = setRole(state, 'Full Name', 'ignore');
    expect(state.heroOrder).toEqual([]);
    expect(buildContextDisplay(state).hero).toBeUndefined();
  });

  it('ignores a role change for a column that is not in the file', () => {
    const state = initialMapping(analysis());
    expect(setRole(state, 'Not A Column', 'phone')).toBe(state);
  });
});

describe('the ingest request', () => {
  it('carries an arbitrarily-named phone column and the timezone column', () => {
    let state = initialMapping(analysis());
    state = setRole(state, 'TZ', 'timezone');
    state = setRole(state, 'Internal Score', 'ignore');

    const request = buildIngestRequest(state, {
      s3Key: 'agency-ingest/t1/u1/collections_aug.csv',
      fileName: 'collections_aug.csv',
      campaignId: 'camp-1',
    });

    expect(request).toEqual({
      s3_key: 'agency-ingest/t1/u1/collections_aug.csv',
      file_name: 'collections_aug.csv',
      phone_column: 'Cust Mobile',
      timezone_column: 'TZ',
      ignore_columns: ['Internal Score'],
      campaign_id: 'camp-1',
    });
  });

  it('excludes ignored columns from the contact context entirely', () => {
    // An `Internal Risk Score` left as Detail is a value on an agent's screen in
    // front of a customer. `ignore_columns` is what keeps it out of `context`,
    // not merely out of the display.
    const state = setRole(initialMapping(analysis()), 'Internal Score', 'ignore');
    expect(ignoredColumns(state)).toEqual(['Internal Score']);
    expect(
      buildIngestRequest(state, { s3Key: 'k', fileName: 'f.csv' })!.ignore_columns,
    ).toEqual(['Internal Score']);
  });

  it('omits the timezone key rather than sending null when nothing is mapped', () => {
    const request = buildIngestRequest(initialMapping(analysis()), {
      s3Key: 'k',
      fileName: 'f.csv',
    });
    expect(request).not.toBeNull();
    expect('timezone_column' in request!).toBe(false);
  });

  it('refuses to build a request with no phone column', () => {
    const state = setRole(initialMapping(analysis()), 'Cust Mobile', 'detail');
    expect(mappingBlockReason(state)).toBe('no_phone_column');
    expect(buildIngestRequest(state, { s3Key: 'k', fileName: 'f.csv' })).toBeNull();
  });

  it('marks a dry run explicitly, which is the only form that may omit a campaign', () => {
    const request = buildIngestRequest(initialMapping(analysis()), {
      s3Key: 'k',
      fileName: 'f.csv',
      dryRun: true,
    });
    expect(request!.dry_run).toBe(true);
    expect(request!.campaign_id).toBeUndefined();
  });

  it('reports an empty file as having no columns', () => {
    const state = initialMapping(analysis({ columns: [], headers: [] }));
    expect(mappingBlockReason(state)).toBe('no_columns');
  });
});

/**
 * The country code applied to a number written without one.
 *
 * It was plumbed the whole way — cusui's request type, master's schema, master's
 * job column, master's normalizer — and no UI ever set it, so every roster
 * inherited master's `DEFAULT_PHONE_COUNTRY_CODE` (`91` unset). A US list
 * therefore imported as "100% accepted" and dialed India, and the carrier bill
 * was the first place anyone could have found out.
 */
describe('the default country code', () => {
  it('starts empty, because only the server knows what its default is', () => {
    // Not `'91'`. Pre-filling would turn an inherited server default into a value
    // cusui asserts, which changes what is dialed anywhere the env differs.
    expect(initialMapping(analysis()).defaultCountryCode).toBe('');
  });

  it('sends nothing at all when untouched — byte-identical to the old request', () => {
    // The zero-behaviour-change claim, asserted as an exact request rather than
    // as an absent key: an extra field with an empty value would still reach
    // master's schema and be a change.
    const request = buildIngestRequest(initialMapping(analysis()), {
      s3Key: 'k',
      fileName: 'f.csv',
      campaignId: 'camp-1',
    });
    expect(request).toEqual({
      s3_key: 'k',
      file_name: 'f.csv',
      phone_column: 'Cust Mobile',
      campaign_id: 'camp-1',
    });
    expect('default_country_code' in request!).toBe(false);
  });

  it('sends the operator’s code once they set one', () => {
    const state = setDefaultCountryCode(initialMapping(analysis()), '1');
    expect(buildIngestRequest(state, { s3Key: 'k', fileName: 'f.csv' })!.default_country_code)
      .toBe('1');
  });

  it('trims on the way in, so the validated string is the sent string', () => {
    // A trailing space is a validation failure the operator cannot see.
    const state = setDefaultCountryCode(initialMapping(analysis()), '  44 ');
    expect(state.defaultCountryCode).toBe('44');
    expect(countryCodeError(state.defaultCountryCode)).toBeNull();
  });

  it('clearing it goes back to sending nothing', () => {
    let state = setDefaultCountryCode(initialMapping(analysis()), '1');
    state = setDefaultCountryCode(state, '');
    const request = buildIngestRequest(state, { s3Key: 'k', fileName: 'f.csv' });
    expect('default_country_code' in request!).toBe(false);
  });

  it('mirrors master’s own rule rather than inventing a stricter one', () => {
    // Master validates `/^\+?\d{1,3}$/` on both the analyze and ingest schemas.
    for (const good of ['1', '91', '+91', '971']) expect(countryCodeError(good)).toBeNull();
    for (const bad of ['1234', 'abc', '9a', '+', '++91', '9 1']) {
      expect(countryCodeError(bad)).toContain('1 to 3 digits');
    }
    // Empty is the legitimate "leave it to the platform" choice, not an omission.
    expect(countryCodeError('')).toBeNull();
  });

  it('blocks the import on a bad code instead of letting master 400 after upload', () => {
    const state = setDefaultCountryCode(initialMapping(analysis()), '1234');
    expect(mappingBlockReason(state)).toBe('bad_country_code');
    expect(buildIngestRequest(state, { s3Key: 'k', fileName: 'f.csv' })).toBeNull();
  });

  it('still names the missing phone column first when both are wrong', () => {
    // The phone column is the one the operator has not set; the country code is
    // one they typed. Naming the typed field sends them to the wrong place.
    let state = setRole(initialMapping(analysis()), 'Cust Mobile', 'detail');
    state = setDefaultCountryCode(state, '1234');
    expect(mappingBlockReason(state)).toBe('no_phone_column');
  });

  it('survives every role change, including the one that refuses a pick', () => {
    // `setRole` used to rebuild the state object from two fields; anything added
    // to `MappingState` is silently dropped by that shape.
    const wide = analysis({ columns: ['a', 'b', 'c', 'd', 'e'].map((n, i) => column(n, { index: i })) });
    let state = setDefaultCountryCode(initialMapping(wide), '44');
    for (const name of ['a', 'b', 'c', 'd']) state = setRole(state, name, 'hero');
    expect(state.defaultCountryCode).toBe('44');
    // The hero-cap arm returns early — the one place a carried field goes missing.
    expect(setRole(state, 'e', 'hero').defaultCountryCode).toBe('44');
  });
});

describe('the pre-ingest validity line', () => {
  it('reports valid numbers against the ROWS SAMPLED, not against non-empty cells', () => {
    // A column that is 100% valid where present but empty half the time would
    // read as "100% valid" against non-empty cells, and the operator would be
    // surprised by 50 rejections. The denominator is the file.
    const line = phoneValidityLine(
      analysis({
        rows_sampled: 100,
        columns: [column('Cust Mobile', { non_empty: 50, phone_score: 1 })],
      }),
      'Cust Mobile',
    );
    expect(line).toContain('50 of 100');
    expect(line).toContain('50%');
  });

  it('says the number is from a sample when the file was truncated', () => {
    const line = phoneValidityLine(analysis({ truncated: true }), 'Cust Mobile');
    expect(line).toContain('sampled');
  });

  it('is absent with no column chosen', () => {
    expect(phoneValidityLine(analysis(), null)).toBeNull();
  });

  it('does not divide by zero on a header-only file', () => {
    const line = phoneValidityLine(analysis({ rows_sampled: 0 }), 'Cust Mobile');
    expect(line).toBe('This file has no data rows to check.');
  });
});
