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
  platformDefaultSearchCountry,
  resolveSearchCountry,
  searchCountryByIso,
  searchCountryOptions,
  searchNumberErrorMessage,
  type SearchCountry,
} from '../../../src/customer-search-number';

interface TableCase {
  input: string;
  /** A listed country's ISO; null = the platform default `defaultCallingCode` names, one the picker does not list. */
  country: string | null;
  defaultCallingCode?: string;
  e164?: string;
  formatted?: string;
  countryIso?: string | null;
  error?: string;
  message?: string;
}

const TABLE = JSON.parse(
  readFileSync(resolve(__dirname, '../../../../contracts/fixtures/agent/customer-search-numbers.json'), 'utf8'),
) as { countries: unknown[]; cases: TableCase[] };

/** The country a case runs in, refusing a typo rather than falling back to a default. */
function caseCountry(c: TableCase): SearchCountry {
  if (c.country !== null) {
    const listed = searchCountryByIso(c.country);
    if (!listed) throw new Error(`${c.country} is not a listed country`);
    return listed;
  }
  const own = platformDefaultSearchCountry(c.defaultCallingCode!);
  if (!own.unlisted) throw new Error(`${c.defaultCallingCode} is a listed calling code`);
  return own;
}

describe('parseSearchNumber — the shared table', () => {
  it.each(TABLE.cases.map((c) => [JSON.stringify(c.input), c.country ?? c.defaultCallingCode, c] as const))('%s (%s)', (_label, _where, c) => {
    const result = parseSearchNumber(c.input, caseCountry(c));
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

  it('has cases for a platform default the picker does not list', () => {
    const unlisted = TABLE.cases.filter((c) => c.country === null);
    expect(unlisted.filter((c) => c.e164).length).toBeGreaterThanOrEqual(3);
    expect(new Set(unlisted.map((c) => c.error).filter(Boolean))).toEqual(new Set(['too_short', 'invalid_for_country']));
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
  it('falls back to the listed country of the platform default calling code', () => {
    expect(resolveSearchCountry(undefined, '44').iso).toBe('GB');
    expect(resolveSearchCountry('ZZ', '+1').iso).toBe('US');
    expect(resolveSearchCountry(null, '+91').unlisted).toBeUndefined();
  });
  it('an unlisted default calling code is a country of its own, never India', () => {
    for (const code of ['27', '+27']) {
      expect(resolveSearchCountry(undefined, code)).toEqual({
        iso: '',
        name: '+27',
        callingCode: '27',
        minNationalLength: 10,
        maxNationalLength: 10,
        numberLabel: '+27 number',
        groups: {},
        unlisted: true,
      });
    }
    expect(resolveSearchCountry('', '+27').callingCode).toBe('27');
    // A picked listed country still wins.
    expect(resolveSearchCountry('IN', '+27').iso).toBe('IN');
  });
  it('a default that is not a calling code at all: India', () => {
    for (const code of ['', '+', '0', '044', '1234', 'abc']) expect(resolveSearchCountry(null, code).iso).toBe('IN');
  });
});

describe('searchCountryOptions', () => {
  it('the listed countries, after the platform default when the picker does not list it', () => {
    expect(searchCountryOptions('+91')).toBe(SEARCH_COUNTRIES);
    expect(searchCountryOptions('+44')).toBe(SEARCH_COUNTRIES);
    const options = searchCountryOptions('+27');
    expect(options.map((c) => c.name)).toEqual(['+27', ...SEARCH_COUNTRIES.map((c) => c.name)]);
    expect(options[0]).toEqual(platformDefaultSearchCountry('+27'));
  });
});

describe('an unlisted default: national numbers by the roster ingest\'s rule', () => {
  const za = platformDefaultSearchCountry('+27');
  it('names the default in the "not valid" refusal', () => {
    expect(searchNumberErrorMessage('invalid_for_country', za)).toBe(
      "This doesn't look like a valid +27 number. Check the digits, or pick another country.",
    );
  });
  it('a listed country\'s rule is not changed by it', () => {
    expect(parseSearchNumber('9876543210', resolveSearchCountry('IN', '+27'))).toMatchObject({ ok: true, e164: '+919876543210' });
  });
  it('7 to 15 digits in all, as the ingest checks E.164', () => {
    expect(parseSearchNumber('2712345', za)).toMatchObject({ ok: true, e164: '+2712345' });
    expect(parseSearchNumber('271234', za)).toMatchObject({ ok: false, code: 'too_short' });
    expect(parseSearchNumber('278212345678901', za)).toMatchObject({ ok: true, e164: '+278212345678901' });
    expect(parseSearchNumber('2782123456789012', za)).toMatchObject({ ok: false, code: 'invalid_for_country' });
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
