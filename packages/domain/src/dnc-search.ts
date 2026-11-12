/**
 * The Do Not Call list search box's digit floors: when typed text is too short to run as a search,
 * and the words that say so. The server refuses such text with a 400 (`dncPhoneSearch` in
 * `apps/server/src/dnc/dnc.service.ts`) and the console's DNC page checks it before it sends, so
 * the page's inline message and the server's refusal are one rule.
 *
 * A LEAF module: no I/O; it imports only the customer-history number rule
 * (`customer-search-number.ts`), whose parse decides what is a whole number.
 *
 *  - An ending (digits typed without `+`) needs {@link DNC_SEARCH_MIN_DIGITS}: one digit matched a
 *    tenth of the list.
 *  - A `+` number cut short (`+91 99088`) matches as the START of a number, so it needs its calling
 *    code and {@link DNC_SEARCH_MIN_DIGITS} more ({@link dncSearchPrefixMinDigits}): `+1 5551`,
 *    `+44 2079` and `+91 9908` all run. A calling code the number rule's table does not list has
 *    no known length, so it needs {@link DNC_SEARCH_MIN_PREFIX_DIGITS} in all (the longest code,
 *    three digits, and four more).
 *  - Text typed with `00` is an ending as typed (`0060`), and also the start of a number when what
 *    follows the `00` clears the `+` floor ({@link dncSearchInternationalDigits}); it is refused
 *    only as an ending.
 *
 * Text that is no number at all (empty, letters, a spreadsheet's `9.19E+11`) is never "too short":
 * the server runs it and it matches nothing. A whole number is never too short either: every
 * whole number the rule reads, in any country, carries more digits than either floor.
 */
import { SEARCH_COUNTRIES, parseSearchNumber } from './customer-search-number';

/** The fewest digits an ending may carry. */
export const DNC_SEARCH_MIN_DIGITS = 4;

/** The fewest digits a `+` number cut short may carry when its calling code is not a listed one. */
export const DNC_SEARCH_MIN_PREFIX_DIGITS = 3 + DNC_SEARCH_MIN_DIGITS;

/** The refusal's words for an ending; the console shows them as they are. */
export const DNC_SEARCH_TOO_SHORT = `Type at least ${DNC_SEARCH_MIN_DIGITS} digits of the number.`;

/** Why typed text is too short to search, as the 400's `code` and `message`. */
export interface DncSearchShortfall {
  code: 'search_too_short' | 'search_prefix_too_short';
  message: string;
}

/** A bracketed trunk `(0)` straight after `+cc` or `00cc`, as the number rule drops it (`+44 (0)20 79…`). */
const TRUNK_AFTER_CALLING_CODE = /^(\s*(?:\+|00)\s*\d{1,3})\s*\(\s*0\s*\)/;

/** The listed calling code these international digits start with (calling codes are prefix-free). */
function listedCallingCode(digits: string): string | null {
  return SEARCH_COUNTRIES.find((c) => digits.startsWith(c.callingCode))?.callingCode ?? null;
}

/**
 * The international digits of text typed with `+` or `00` (calling code first, no `+`, a bracketed
 * trunk after the code dropped); null for text typed with neither.
 */
export function dncSearchInternationalDigits(raw: string): string | null {
  const text = raw.trim();
  const digits = text.replace(TRUNK_AFTER_CALLING_CODE, '$1').replace(/\D/g, '');
  if (text.startsWith('+')) return digits;
  return digits.startsWith('00') ? digits.slice(2) : null;
}

/** How many international digits a number cut short needs: its listed calling code and 4 more, else 7. */
export function dncSearchPrefixMinDigits(digits: string): number {
  const code = listedCallingCode(digits);
  return code === null ? DNC_SEARCH_MIN_PREFIX_DIGITS : code.length + DNC_SEARCH_MIN_DIGITS;
}

/** The refusal's words for a `+` number cut short, naming what is still needed. */
export function dncSearchPrefixTooShortMessage(digits: string): string {
  const code = listedCallingCode(digits);
  const need = code === null
    ? `at least ${DNC_SEARCH_MIN_PREFIX_DIGITS} digits after the +`
    : `at least ${DNC_SEARCH_MIN_DIGITS} digits after +${code}`;
  return `Type ${need}, or leave off the + to search by the last digits.`;
}

/** Why `raw` is too short to search, or null when it may be sent. */
export function dncSearchShortfall(raw: string): DncSearchShortfall | null {
  // The country only decides which whole numbers parse, and none of them is short; the first
  // listed one stands in.
  const parsed = parseSearchNumber(raw, SEARCH_COUNTRIES[0]!);
  if (parsed.ok) return null;
  if (parsed.code === 'empty' || parsed.code === 'invalid_characters' || parsed.code === 'spreadsheet_number') {
    return null;
  }
  if (raw.trim().startsWith('+')) {
    const digits = dncSearchInternationalDigits(raw)!;
    return digits.length < dncSearchPrefixMinDigits(digits)
      ? { code: 'search_prefix_too_short', message: dncSearchPrefixTooShortMessage(digits) }
      : null;
  }
  return raw.replace(/\D/g, '').length < DNC_SEARCH_MIN_DIGITS
    ? { code: 'search_too_short', message: DNC_SEARCH_TOO_SHORT }
    : null;
}
