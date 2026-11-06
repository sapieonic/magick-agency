// The customer-history search box's number rule, held to the ONE table the console preview,
// the server and the agent app's Dart port all run (decision CH5): a preview never promises a
// number the server does not search.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  SEARCH_COUNTRIES,
  SEARCH_NUMBER_ERROR_CODES,
  formatSearchNumber,
  parseSearchNumber,
  resolveSearchCountry,
  searchCountryByIso,
  searchNumberErrorMessage,
} from '../../../src/customer-search-number';

interface TableCase {
  input: string;
  country: string;
  e164?: string;
  formatted?: string;
  countryIso?: string | null;
  error?: string;
  message?: string;
}

const TABLE = JSON.parse(
  readFileSync(resolve(__dirname, '../../../../contracts/fixtures/agent/customer-search-numbers.json'), 'utf8'),
) as { countries: unknown[]; cases: TableCase[] };

describe('parseSearchNumber — the shared table', () => {
  it.each(TABLE.cases.map((c) => [JSON.stringify(c.input), c.country, c] as const))('%s (%s)', (_label, iso, c) => {
    const result = parseSearchNumber(c.input, searchCountryByIso(iso)!);
    if (c.e164) {
      expect(result).toEqual({ ok: true, e164: c.e164, formatted: c.formatted, countryIso: c.countryIso });
    } else {
      expect(result).toEqual({ ok: false, code: c.error, message: c.message });
    }
  });

  it('the table covers every refusal code', () => {
    const seen = new Set(TABLE.cases.map((c) => c.error).filter(Boolean));
    expect([...seen].sort()).toEqual([...SEARCH_NUMBER_ERROR_CODES].sort());
  });

  it('every way the spec lists to write one Indian number gives the same E.164', () => {
    const same = ['98765 43210', '9876543210', '098765-43210', '+91 98765 43210', '+919876543210', '0091 98765 43210', '91 9876543210'];
    const india = searchCountryByIso('IN')!;
    for (const raw of same) expect(parseSearchNumber(raw, india)).toMatchObject({ ok: true, e164: '+919876543210' });
  });

  it('the country list in the table is the module’s (the Dart port reads the table)', () => {
    const asJson = JSON.parse(JSON.stringify(SEARCH_COUNTRIES)) as unknown[];
    expect(TABLE.countries).toEqual(asJson);
  });
});

describe('partial numbers', () => {
  it('a number shorter than a full national number is refused with the full-number message, never searched', () => {
    const india = searchCountryByIso('IN')!;
    for (const partial of ['3210', '43210', '543210', '87654321', '876543210', '+91 876543210']) {
      const r = parseSearchNumber(partial, india);
      expect(r).toEqual({ ok: false, code: 'too_short', message: "Enter the full number. Searching by the last few digits isn't supported." });
    }
  });
});

describe('resolveSearchCountry', () => {
  it('takes a listed ISO code, any case', () => {
    expect(resolveSearchCountry('gb', '91').iso).toBe('GB');
  });
  it('falls back to the platform default calling code, then India', () => {
    expect(resolveSearchCountry(undefined, '44').iso).toBe('GB');
    expect(resolveSearchCountry('ZZ', '+1').iso).toBe('US');
    expect(resolveSearchCountry(null, '999').iso).toBe('IN');
  });
});

describe('messages', () => {
  it('name the country the number was judged against', () => {
    expect(searchNumberErrorMessage('invalid_for_country', searchCountryByIso('IN'))).toBe(
      "This doesn't look like a valid Indian mobile number. Check the digits, or pick another country.",
    );
    expect(searchNumberErrorMessage('invalid_for_country', null)).toBe(
      "This doesn't look like a valid phone number. Check the digits, or pick another country.",
    );
  });
  it('are British English', () => {
    for (const code of SEARCH_NUMBER_ERROR_CODES) {
      expect(searchNumberErrorMessage(code, searchCountryByIso('IN'))).not.toMatch(/\b(dialed|canceled|color|recognize)\b/i);
    }
  });
});

describe('formatSearchNumber', () => {
  it('groups a listed country, leaves an unknown code whole', () => {
    expect(formatSearchNumber('+919876543210')).toBe('+91 98765 43210');
    expect(formatSearchNumber('+14155552671')).toBe('+1 415 555 2671');
    expect(formatSearchNumber('+99912345678')).toBe('+99912345678');
  });
});
