/**
 * The customer-history search box's number rule: the raw text a person types (or pastes) and
 * the country picked next to it, cleaned up to ONE E.164 number, or refused with a reason that
 * tells them what to do.
 *
 * A LEAF module: no I/O; it imports only the refusal codes from the contract. The console runs it for the live preview ("We'll search
 * for +91 98765 43210"), the server runs it for the search itself, and the agent app carries a
 * hand-written Dart port (`apps/mobile/packages/agency_wire/lib/src/customer_search_number.dart`).
 * All three are held to one test table, `packages/contracts/fixtures/agent/customer-search-numbers.json`,
 * so the preview never promises a number the server does not search. The server's answer is
 * final: it echoes the number it searched.
 *
 * Full numbers only (decision CH4): a number shorter than the country's national length is
 * refused with the "full number" message. Nothing here, or behind it, searches by the ending of
 * a number.
 *
 * What it accepts, for the default country India (+91):
 *   `98765 43210`, `9876543210`, `098765-43210`, `+91 98765 43210`, `+919876543210`,
 *   `0091 98765 43210`, `91 9876543210` (the country code without the `+`, only when the digits
 *   are too long for a national number and the rest is a whole national number);
 * and, as the soft phone does, a bracketed trunk `(0)` directly after the country code is
 * dropped: `+44 (0)20 7946 0018` → `+442079460018`.
 *
 * The result matches what the roster ingest stores (`normalizePhoneToE164` then
 * `normalizeE164` on the server) for every Indian form above, which is what lets the search use
 * the `(tenant_id, phone_e164)` index with an exact match. One known difference: the ingest keeps
 * a bracketed trunk `(0)` (`+44 (0)20 7946 0018` → `+4402079460018`) where this rule and the soft
 * phone drop it, so a roster row written that way is not found (CH12 e; pinned `it.fails` in
 * `apps/server/test/unit/agency/customer-history/search-number-agreement.test.ts`).
 */

import {
  CUSTOMER_SEARCH_NUMBER_ERRORS,
  type CustomerSearchNumberError,
} from '@magick-agency/contracts/api/agency/customer-history';

/** A country the picker offers. `nationalLengths` is the national significant number's length range. */
export interface SearchCountry {
  /** ISO 3166-1 alpha-2, as the request's `country` carries it. */
  iso: string;
  name: string;
  /** Digits only, no `+`. */
  callingCode: string;
  minNationalLength: number;
  maxNationalLength: number;
  /** How the "not valid" message names a number of this country. */
  numberLabel: string;
  /** Digit groups for the formatted number, keyed by national length. */
  groups: Readonly<Record<number, readonly number[]>>;
}

/**
 * The countries the picker offers. A number typed with `+` and a calling code not listed here is
 * still searched, held only to E.164's own bounds. Order is the picker's order.
 */
export const SEARCH_COUNTRIES: readonly SearchCountry[] = [
  { iso: 'IN', name: 'India', callingCode: '91', minNationalLength: 10, maxNationalLength: 10, numberLabel: 'Indian mobile number', groups: { 10: [5, 5] } },
  { iso: 'AE', name: 'United Arab Emirates', callingCode: '971', minNationalLength: 8, maxNationalLength: 9, numberLabel: 'UAE number', groups: { 9: [2, 3, 4], 8: [1, 3, 4] } },
  { iso: 'AU', name: 'Australia', callingCode: '61', minNationalLength: 9, maxNationalLength: 9, numberLabel: 'Australian number', groups: { 9: [3, 3, 3] } },
  { iso: 'BD', name: 'Bangladesh', callingCode: '880', minNationalLength: 10, maxNationalLength: 10, numberLabel: 'Bangladeshi number', groups: { 10: [4, 6] } },
  { iso: 'GB', name: 'United Kingdom', callingCode: '44', minNationalLength: 9, maxNationalLength: 10, numberLabel: 'UK number', groups: { 10: [2, 4, 4], 9: [3, 3, 3] } },
  { iso: 'LK', name: 'Sri Lanka', callingCode: '94', minNationalLength: 9, maxNationalLength: 9, numberLabel: 'Sri Lankan number', groups: { 9: [2, 3, 4] } },
  { iso: 'NP', name: 'Nepal', callingCode: '977', minNationalLength: 8, maxNationalLength: 10, numberLabel: 'Nepali number', groups: { 10: [3, 7] } },
  { iso: 'SA', name: 'Saudi Arabia', callingCode: '966', minNationalLength: 9, maxNationalLength: 9, numberLabel: 'Saudi number', groups: { 9: [2, 3, 4] } },
  { iso: 'SG', name: 'Singapore', callingCode: '65', minNationalLength: 8, maxNationalLength: 8, numberLabel: 'Singapore number', groups: { 8: [4, 4] } },
  { iso: 'US', name: 'United States / Canada', callingCode: '1', minNationalLength: 10, maxNationalLength: 10, numberLabel: 'US or Canadian number', groups: { 10: [3, 3, 4] } },
] as const;

/** The closed set of refusals: the contract's `number_error` (wire codes, never respelled). */
export const SEARCH_NUMBER_ERROR_CODES = CUSTOMER_SEARCH_NUMBER_ERRORS;

export type SearchNumberResult =
  | {
    ok: true;
    /** The number searched, E.164 (`+919876543210`). */
    e164: string;
    /** For display: `+91 98765 43210`. */
    formatted: string;
    /** The country the number belongs to, when it is one the picker lists. */
    countryIso: string | null;
  }
  | { ok: false; code: CustomerSearchNumberError; message: string };

/** E.164's own bounds for a calling code the table does not list. */
const UNKNOWN_MIN_DIGITS = 8;
const UNKNOWN_MAX_DIGITS = 15;

/** Excel's scientific notation for a long number: `9.18765E+11`, `9.19876E11`. */
const SPREADSHEET = /^\+?\d+(\.\d+)?e\+?\d+$/i;
/** Digits, spaces, `+`, dashes, brackets; dots are tolerated as separators. */
const ALLOWED = /^[\d\s+\-().]+$/;
/** A bracketed trunk `(0)` directly after `+cc` or `00cc`, as the soft phone drops it. */
const TRUNK_AFTER_COUNTRY_CODE = /^(\s*(?:\+|00)\s*\d{1,3})\s*\(\s*0\s*\)/;

/** The country the picker defaults to: the one whose calling code is the platform default. */
function searchCountryForCallingCode(callingCode: string): SearchCountry | null {
  const cc = callingCode.replace(/^\+/, '');
  return SEARCH_COUNTRIES.find((c) => c.callingCode === cc) ?? null;
}

export function searchCountryByIso(iso: string): SearchCountry | null {
  const upper = iso.toUpperCase();
  return SEARCH_COUNTRIES.find((c) => c.iso === upper) ?? null;
}

/** The message shown for a refusal. British English. */
export function searchNumberErrorMessage(code: CustomerSearchNumberError, country: SearchCountry | null): string {
  switch (code) {
    case 'empty':
      return 'Type a phone number to search.';
    case 'invalid_characters':
      return 'Only digits, spaces, +, dashes and brackets are allowed.';
    case 'spreadsheet_number':
      return 'This looks like a number Excel shortened. Copy it from the cell as text.';
    case 'too_short':
      return "Enter the full number. Searching by the last few digits isn't supported.";
    case 'invalid_for_country':
      return `This doesn't look like a valid ${country ? country.numberLabel : 'phone number'}. Check the digits, or pick another country.`;
  }
}

function refuse(code: CustomerSearchNumberError, country: SearchCountry | null): SearchNumberResult {
  return { ok: false, code, message: searchNumberErrorMessage(code, country) };
}

/** The listed country whose calling code begins these international digits (longest code first). */
function countryOfInternational(digits: string): SearchCountry | null {
  let best: SearchCountry | null = null;
  for (const c of SEARCH_COUNTRIES) {
    if (digits.startsWith(c.callingCode) && (!best || c.callingCode.length > best.callingCode.length)) best = c;
  }
  return best;
}

/** `+91 98765 43210`: the calling code, then the national number in the country's groups. */
export function formatSearchNumber(e164: string): string {
  const digits = e164.replace(/^\+/, '');
  const country = countryOfInternational(digits);
  if (!country) return e164;
  const national = digits.slice(country.callingCode.length);
  const groups = country.groups[national.length];
  if (!groups) return `+${country.callingCode} ${national}`;
  const parts: string[] = [];
  let at = 0;
  for (const g of groups) {
    parts.push(national.slice(at, at + g));
    at += g;
  }
  return `+${country.callingCode} ${parts.join(' ')}`;
}

/** Holds international digits (calling code first, no `+`) to the country's rule. */
function checkInternational(digits: string): SearchNumberResult {
  const country = countryOfInternational(digits);
  if (!country) {
    if (digits.length < UNKNOWN_MIN_DIGITS) return refuse('too_short', null);
    if (digits.length > UNKNOWN_MAX_DIGITS || digits.startsWith('0')) return refuse('invalid_for_country', null);
    return { ok: true, e164: `+${digits}`, formatted: `+${digits}`, countryIso: null };
  }
  const national = digits.slice(country.callingCode.length);
  if (national.length < country.minNationalLength) return refuse('too_short', country);
  if (national.length > country.maxNationalLength || national.startsWith('0')) return refuse('invalid_for_country', country);
  const e164 = `+${digits}`;
  return { ok: true, e164, formatted: formatSearchNumber(e164), countryIso: country.iso };
}

/**
 * The picked country: the ISO code when the picker lists it, else the country of the platform's
 * default calling code, else India.
 */
export function resolveSearchCountry(iso: string | null | undefined, defaultCallingCode: string): SearchCountry {
  return (iso ? searchCountryByIso(iso) : null) ?? searchCountryForCallingCode(defaultCallingCode) ?? SEARCH_COUNTRIES[0]!;
}

/** The raw search text and the picked country, as one E.164 number or a refusal. */
export function parseSearchNumber(raw: string, country: SearchCountry): SearchNumberResult {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (text.length === 0) return refuse('empty', country);
  if (SPREADSHEET.test(text.replace(/\s/g, ''))) return refuse('spreadsheet_number', country);
  if (!ALLOWED.test(text)) return refuse('invalid_characters', country);
  // A `+` only as the very first character.
  if (text.indexOf('+', 1) !== -1) return refuse('invalid_characters', country);

  const withoutTrunk = text.replace(TRUNK_AFTER_COUNTRY_CODE, '$1 ');
  const digits = withoutTrunk.replace(/\D/g, '');
  if (digits.length === 0) return refuse('empty', country);

  if (text.startsWith('+')) return checkInternational(digits);
  if (digits.startsWith('00')) return checkInternational(digits.slice(2));

  // National: a leading trunk 0 dropped.
  const national = digits.replace(/^0+/, '');
  if (national.length === 0) return refuse('too_short', country);
  // The country code typed without `+`: only when the digits are too long to be a national number
  // and what follows the code is a whole national number (`91 9876543210`).
  if (
    national.length > country.maxNationalLength &&
    national.startsWith(country.callingCode) &&
    national.length - country.callingCode.length >= country.minNationalLength &&
    national.length - country.callingCode.length <= country.maxNationalLength
  ) {
    return checkInternational(national);
  }
  if (national.length < country.minNationalLength) return refuse('too_short', country);
  if (national.length > country.maxNationalLength) return refuse('invalid_for_country', country);
  return checkInternational(`${country.callingCode}${national}`);
}
