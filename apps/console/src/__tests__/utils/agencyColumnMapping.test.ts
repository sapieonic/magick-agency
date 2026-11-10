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
  setDedupe,
  setDedupeKey,
  removeDedupeKey,
  addDedupeKey,
  canAddDedupeKey,
  dedupeKeyOptions,
  dedupeColumnOptions,
  combinationLine,
  uniquenessLine,
  PHONE_DEDUPE,
  MAX_DEDUPE_KEYS,
  phoneUniquenessLine,
  MAPPING_BLOCK_COPY,
  MAX_HERO_FIELDS,
} from '../../utils/agencyColumnMapping';
import type { AgencyColumnAnalysis, AgencyColumnStat } from '../../types/agency-campaign';

/**
 * requirement: *the operator can map any column as the phone
 * number*. The file below is the spec's own — no column is called `phone`, the
 * timezone column is called `TZ`, and one column holds an internal score an
 * agent must never see.
 */

function column(name: string, over: Partial<AgencyColumnStat> = {}): AgencyColumnStat {
  return { name, index: 0, samples: [], non_empty: 100, phone_score: 0, distinct: 100, distinct_phones: 0, ...over };
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

describe('seeding the mapping from the API analysis', () => {
  it('preselects the suggested phone column and leaves everything else Detail', () => {
    const state = initialMapping(analysis());
    expect(state.roles['Cust Mobile']).toBe('phone');
    expect(state.roles['Full Name']).toBe('detail');
    expect(state.roles['TZ']).toBe('detail');
  });

  it('preselects NOTHING when the API withheld the suggestion as ambiguous', () => {
    // The API withholds when two columns score within 10% of each other. Picking
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
    // An unmapped contact uses the campaign default. A column called `TZ`
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
 * "Check duplicates on". One borrower with two loans is two rows on one number,
 * so a loan book dedupes on the loan number, not the phone.
 */
describe('the duplicate check', () => {
  const build = (state: ReturnType<typeof initialMapping>) =>
    buildIngestRequest(state, { s3Key: 'k', fileName: 'f.csv', campaignId: 'camp-1' })!;

  const phone = { kind: 'phone' } as const;
  const col = (column: string) => ({ kind: 'column', column }) as const;
  const keys = (...k: Array<ReturnType<typeof col> | typeof phone>) => ({ mode: 'keys', keys: k }) as const;

  it('starts on the phone and sends exactly the request it sent before the control existed', () => {
    const state = initialMapping(analysis());
    expect(state.dedupe).toEqual(PHONE_DEDUPE);
    expect(state.dedupe).toEqual({ mode: 'keys', keys: [{ kind: 'phone' }] });
    expect(build(state)).toEqual({ s3_key: 'k', file_name: 'f.csv', phone_column: 'Cust Mobile', campaign_id: 'camp-1' });
  });

  it('sends dedupe_columns for a chosen column, and dedupe_phones: false for none', () => {
    const base = initialMapping(analysis());
    const byLoan = build(setDedupe(base, keys(col('Full Name'))));
    expect(byLoan.dedupe_columns).toEqual(['Full Name']);
    expect(byLoan).not.toHaveProperty('dedupe_phones');
    expect(byLoan).not.toHaveProperty('dedupe_column');

    const none = build(setDedupe(base, { mode: 'none' }));
    expect(none.dedupe_phones).toBe(false);
    expect(none).not.toHaveProperty('dedupe_columns');
  });

  it('treats the phone column chosen as a column as the phone key', () => {
    const state = setDedupe(initialMapping(analysis()), keys(col('Cust Mobile')));
    expect(state.dedupe).toEqual(PHONE_DEDUPE);
  });

  it('ignores a column the file does not have, and a choice with no key', () => {
    const state = initialMapping(analysis());
    expect(setDedupe(state, keys(col('Loan No')))).toBe(state);
    expect(setDedupe(state, keys(col('Full Name'), col('Loan No')))).toBe(state);
    expect(setDedupe(state, keys())).toBe(state);
  });

  it('falls back to the phone when the duplicate column is made the phone column', () => {
    let state = setDedupe(initialMapping(analysis()), keys(col('Internal Score')));
    state = setRole(state, 'Internal Score', 'phone');
    expect(state.dedupe).toEqual(PHONE_DEDUPE);
    expect(build(state)).not.toHaveProperty('dedupe_columns');
  });

  it('blocks the import when a duplicate column is set to Ignore', () => {
    // An ignored column is not in the roster's row fingerprint, so two loans that
    // differ only there would still collapse into one contact at the insert.
    let state = setDedupe(initialMapping(analysis()), keys(col('Full Name'), col('Internal Score')));
    state = setRole(state, 'Internal Score', 'ignore');
    expect(mappingBlockReason(state)).toBe('dedupe_column_ignored');
    expect(MAPPING_BLOCK_COPY.dedupe_column_ignored).toContain('cannot be set to Ignore');
    expect(buildIngestRequest(state, { s3Key: 'k', fileName: 'f.csv' })).toBeNull();

    // Setting it back to Detail unblocks it.
    expect(build(setRole(state, 'Internal Score', 'detail')).dedupe_columns).toEqual(['Full Name', 'Internal Score']);
  });

  it('offers every column except the phone one and ignored ones, in file order', () => {
    const state = setRole(initialMapping(analysis()), 'Internal Score', 'ignore');
    expect(dedupeColumnOptions(analysis(), state)).toEqual(['Full Name', 'TZ']);
  });

  it('still lists a chosen column after it is ignored, so the select can show what is blocking', () => {
    let state = setDedupe(initialMapping(analysis()), keys(col('Internal Score')));
    state = setRole(state, 'Internal Score', 'ignore');
    expect(dedupeColumnOptions(analysis(), state)).toEqual(['Full Name', 'TZ', 'Internal Score']);
  });

  describe('combining up to three columns', () => {
    it('sends the columns in the operator\'s order, the phone key by its column', () => {
      const state = setDedupe(initialMapping(analysis()), keys(col('Full Name'), phone, col('TZ')));
      expect(build(state).dedupe_columns).toEqual(['Full Name', 'Cust Mobile', 'TZ']);
    });

    it('the phone key follows the phone to its new column', () => {
      let state = setDedupe(initialMapping(analysis()), keys(phone, col('Full Name')));
      state = setRole(state, 'TZ', 'phone');
      expect(build(state).dedupe_columns).toEqual(['TZ', 'Full Name']);
    });

    it('a key column made the phone column merges into the phone key', () => {
      let state = setDedupe(initialMapping(analysis()), keys(phone, col('Full Name'), col('TZ')));
      state = setRole(state, 'Full Name', 'phone');
      expect(state.dedupe).toEqual(keys(phone, col('TZ')));
    });

    it('keeps a key named twice once, and at most the maximum', () => {
      const state = initialMapping(analysis());
      expect(setDedupe(state, keys(col('TZ'), col('TZ'), phone)).dedupe).toEqual(keys(col('TZ'), phone));
      expect(MAX_DEDUPE_KEYS).toBe(3);
      expect(setDedupe(state, keys(phone, col('Full Name'), col('TZ'), col('Internal Score'))).dedupe)
        .toEqual(keys(phone, col('Full Name'), col('TZ')));
    });

    it('adds the first key not already chosen, until the maximum or nothing is left', () => {
      const a = analysis();
      let state = initialMapping(a);
      state = addDedupeKey(a, state);
      expect(state.dedupe).toEqual(keys(phone, col('Full Name')));
      state = addDedupeKey(a, state);
      expect(state.dedupe).toEqual(keys(phone, col('Full Name'), col('TZ')));
      expect(canAddDedupeKey(a, state)).toBe(false);
      expect(addDedupeKey(a, state)).toBe(state);

      // Two columns besides the phone, both chosen: nothing left to add.
      const small = analysis({ columns: [column('Cust Mobile', { phone_score: 0.95 }), column('Loan No')] });
      const full = setDedupe(initialMapping(small), keys(phone, col('Loan No')));
      expect(canAddDedupeKey(small, full)).toBe(false);
      // "Don't remove duplicates" has nothing to combine.
      expect(canAddDedupeKey(a, setDedupe(initialMapping(a), { mode: 'none' }))).toBe(false);
    });

    it('each select offers the keys the other selects do not hold', () => {
      const a = analysis();
      const state = setDedupe(initialMapping(a), keys(phone, col('Full Name')));
      expect(dedupeKeyOptions(a, state, 0)).toEqual([phone, col('TZ'), col('Internal Score')]);
      expect(dedupeKeyOptions(a, state, 1)).toEqual([col('Full Name'), col('TZ'), col('Internal Score')]);
    });

    it('setting a key in place keeps the order, and moves a key already elsewhere rather than repeating it', () => {
      const state = setDedupe(initialMapping(analysis()), keys(phone, col('Full Name'), col('TZ')));
      expect(setDedupeKey(state, 1, col('Internal Score')).dedupe).toEqual(keys(phone, col('Internal Score'), col('TZ')));
      expect(setDedupeKey(state, 0, col('TZ')).dedupe).toEqual(keys(col('TZ'), col('Full Name')));
    });

    it('removes a key, but never the last one', () => {
      const state = setDedupe(initialMapping(analysis()), keys(phone, col('Full Name')));
      const one = removeDedupeKey(state, 0);
      expect(one.dedupe).toEqual(keys(col('Full Name')));
      expect(removeDedupeKey(one, 0)).toBe(one);
    });

    it('says a combination drops a row only on a full match, and when nothing can be dropped', () => {
      const a = analysis({
        columns: [
          column('Cust Mobile', { phone_score: 0.95, distinct_phones: 80 }),
          column('Full Name', { distinct: 60 }),
          column('TZ', { distinct: 3 }),
          column('Internal Score', { distinct: 100 }),
        ],
      });
      expect(combinationLine(a, setDedupe(initialMapping(a), keys(col('Full Name'), col('TZ'))))).toBe(
        'A row is dropped only when its Full Name and TZ both match an earlier row; a row with any of them blank is always kept.',
      );
      expect(combinationLine(a, setDedupe(initialMapping(a), keys(phone, col('TZ'), col('Internal Score'))))).toBe(
        'A row is dropped only when its Cust Mobile, TZ and Internal Score all match an earlier row; a row with any of them blank is always kept. Internal Score has no repeats in this file, so no row will be dropped as a duplicate.',
      );
      expect(combinationLine(a, initialMapping(a))).toBeNull();
    });
  });

  describe('the uniqueness line', () => {
    const loans = analysis({
      rows_sampled: 100,
      columns: [
        column('Cust Mobile', { non_empty: 100, distinct: 82 }),
        column('Loan No', { non_empty: 100, distinct: 100 }),
        column('Ref', { non_empty: 90, distinct: 89 }),
      ],
    });

    it('says a column is fully unique', () => {
      expect(uniquenessLine(loans, 'Loan No')).toBe('Loan No: 100% unique in this file.');
    });

    it('says how many rows would be dropped', () => {
      expect(uniquenessLine(loans, 'Cust Mobile')).toBe(
        'Cust Mobile: 82% unique in this file; 18 rows repeat an earlier value and will be dropped.',
      );
    });

    it('counts blanks, which are never duplicates, and scopes a truncated sample', () => {
      expect(uniquenessLine({ ...loans, truncated: true }, 'Ref')).toBe(
        'Ref: 98% unique in the rows we sampled; 1 row repeats an earlier value and will be dropped. 10 blank, and a blank value is never a duplicate.',
      );
    });

    it('is null for no column or an empty one', () => {
      expect(uniquenessLine(loans, null)).toBeNull();
      expect(uniquenessLine(analysis({ columns: [column('X', { non_empty: 0, distinct: 0 })] }), 'X')).toBeNull();
    });

    it('is null, not NaN, for an analysis served without the count', () => {
      const old = analysis({ columns: [{ name: 'X', index: 0, samples: [], non_empty: 5, phone_score: 1 } as never] });
      expect(uniquenessLine(old, 'X')).toBeNull();
      expect(phoneUniquenessLine(old, 'X')).toBeNull();
    });
  });

  describe('the phone uniqueness line', () => {
    it('counts normalised numbers over the valid ones, never blanks', () => {
      // 100 sampled, 90 non-empty, 80 valid numbers, 76 distinct numbers.
      const file = analysis({
        rows_sampled: 100,
        columns: [column('Mobile', { non_empty: 90, phone_score: 80 / 90, distinct: 90, distinct_phones: 76 })],
      });
      expect(phoneUniquenessLine(file, 'Mobile')).toBe(
        'Mobile: 95% of valid numbers are unique in this file; 4 rows repeat an earlier number and will be dropped.',
      );
    });

    it('says every valid number is unique when none repeat', () => {
      const file = analysis({ columns: [column('Mobile', { non_empty: 10, phone_score: 1, distinct_phones: 10 })] });
      expect(phoneUniquenessLine(file, 'Mobile')).toBe('Mobile: every valid number is unique in this file.');
    });

    it('is null when no value is a valid number', () => {
      expect(phoneUniquenessLine(analysis({ columns: [column('Mobile', { phone_score: 0 })] }), 'Mobile')).toBeNull();
    });
  });
});

/**
 * The country code applied to a number written without one.
 *
 * It was plumbed the whole way — the console's request type, the API's schema, the API's
 * job column, the API's normalizer — and no UI ever set it, so every roster
 * inherited the API's `DEFAULT_PHONE_COUNTRY_CODE` (`91` unset). A US list
 * therefore imported as "100% accepted" and dialed India, and the carrier bill
 * was the first place anyone could have found out.
 */
describe('the default country code', () => {
  it('starts empty, because only the server knows what its default is', () => {
    // Not `'91'`. Pre-filling would turn an inherited server default into a value
    // the console asserts, which changes what is dialed anywhere the env differs.
    expect(initialMapping(analysis()).defaultCountryCode).toBe('');
  });

  it('sends nothing at all when untouched — byte-identical to the old request', () => {
    // The zero-behaviour-change claim, asserted as an exact request rather than
    // as an absent key: an extra field with an empty value would still reach
    // the API's schema and be a change.
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

  it('mirrors the API’s own rule rather than inventing a stricter one', () => {
    // The API validates `/^\+?\d{1,3}$/` on both the analyze and ingest schemas.
    for (const good of ['1', '91', '+91', '971']) expect(countryCodeError(good)).toBeNull();
    for (const bad of ['1234', 'abc', '9a', '+', '++91', '9 1']) {
      expect(countryCodeError(bad)).toContain('1 to 3 digits');
    }
    // Empty is the legitimate "leave it to the platform" choice, not an omission.
    expect(countryCodeError('')).toBeNull();
  });

  it('blocks the import on a bad code instead of letting the API 400 after upload', () => {
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
