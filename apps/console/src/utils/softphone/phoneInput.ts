/**
 * The soft phone's number field: what a key press, a keystroke and a paste do to
 * it, and when it is worth pressing Call.
 *
 * ── The browser does not decide what the number IS ───────────────────────────
 * `POST /calls` takes the number **as typed** and the server normalises it to
 * E.164 in the account's default region (`normalizeE164`, `+91` by default —
 * `docs/softphone.md` §4.1 step 2). So nothing here guesses a country for a bare
 * national number: "98204 61733" goes to the server as `9820461733` and the
 * server, which knows the account's country, reads it. What this module does is
 * the part only the browser can: strip what a paste drags in (spaces, dashes,
 * brackets, a `tel:` prefix, the trunk `0`, an international `00`) so the field
 * shows the number the agent meant, and refuse a Call that cannot be a number.
 * Typing gets the two prefix rules too (`normaliseTypedNumber`): the field sits
 * beside the account's country-code chip, so whatever it holds is read after it.
 */

/** The pad's keys, in the order a phone draws them. */
export const DIAL_KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#'] as const;
export type DialKey = (typeof DIAL_KEYS)[number];

/** The letters under each key, as a phone prints them. `0` carries the `+` (long-press on a handset). */
export const DIAL_KEY_LETTERS: Record<DialKey, string> = {
  '1': '',
  '2': 'ABC',
  '3': 'DEF',
  '4': 'GHI',
  '5': 'JKL',
  '6': 'MNO',
  '7': 'PQRS',
  '8': 'TUV',
  '9': 'WXYZ',
  '*': '',
  '0': '+',
  '#': '',
};

/** E.164 allows 15 digits; a few more leave room for a `+` and a stray key without truncating silently. */
export const MAX_DIAL_LENGTH = 20;

/** The shortest number worth sending: below this it is a keypress, not a phone number. */
export const MIN_DIAL_DIGITS = 6;
/** E.164's ceiling. */
export const MAX_DIAL_DIGITS = 15;

/** Whether one typed character belongs in the field at all. */
export function isDialChar(ch: string): boolean {
  return /^[0-9*#+]$/.test(ch);
}

/**
 * Keep what a number can hold: digits, `*`, `#`, and a `+` only in first place.
 * Used for every keystroke into the field, so a letter typed by accident never
 * lands in it.
 */
export function sanitiseDialInput(raw: string): string {
  let out = '';
  for (const ch of raw) {
    if (ch === '+') {
      if (out.length === 0) out = '+';
      continue;
    }
    if (/[0-9*#]/.test(ch)) out += ch;
  }
  return out.slice(0, MAX_DIAL_LENGTH);
}

/**
 * What a typed number means, beside the country-code chip.
 *
 * A number without a `+` is shown after the chip ("+91"), so a typed trunk `0`
 * read "+91 098204 61733" — a number nobody has. The server strips the trunk
 * `0` from a national number anyway (`normalizePhoneToE164`), so dropping it here
 * changes nothing that is dialled and makes the field read as the call will.
 * A typed `00` is the international prefix, as on paste: it becomes the `+`
 * (the server would otherwise strip both zeros and read the rest in the
 * account's country).
 *
 * A lone `0` is kept: until the next key it could be either.
 */
export function normaliseTypedNumber(value: string): string {
  if (value.startsWith('00')) return sanitiseDialInput(`+${value.slice(2)}`);
  if (/^0[1-9]/.test(value)) return value.slice(1);
  return value;
}

/** One pad key (or typed character) onto the end of the number. */
export function appendDialKey(value: string, key: string): string {
  if (key === '+') return value.length === 0 ? '+' : value;
  if (!isDialChar(key)) return value;
  return normaliseTypedNumber(sanitiseDialInput(value + key));
}

/** Backspace: the last character, whatever it was. */
export function deleteLastDialChar(value: string): string {
  return value.slice(0, -1);
}

/**
 * A pasted number, cleaned the way the agent meant it.
 *
 *  - `+91 98204 61733`, `+91-98204-61733`, `(+91) 98204 61733` → `+919820461733`
 *  - `0091 98204 61733` → `+919820461733` (the international `00`)
 *  - `+44 (0)20 7946 0018` → `+442079460018`: the bracketed trunk `0` written
 *    after a country code is for dialling inside the country, never after it
 *  - `098204 61733`, `022 2659 4410` → `+919820461733`, `+912226594410`: a leading
 *    trunk `0` is the national format, so the account's country code replaces it
 *  - `tel:+919820461733` → `+919820461733`
 *  - `+44 (0)20 7946 0018` → `+442079460018`: a bracketed trunk `0` after the country
 *    code is dialled only from inside the country, so it is dropped (the server does
 *    the same for a typed one)
 *  - `98204 61733` → `9820461733`: a bare national number is left for the server,
 *    which normalises it in the account's region (see the module note)
 *
 * `defaultCountryCode` is the bootstrap's `default_country_code` (`+91` unless the
 * account says otherwise), accepted with or without its `+`.
 */
export function normalisePastedNumber(raw: string, defaultCountryCode: string): string {
  const withoutScheme = raw
    .trim()
    .replace(/^tel:/i, '')
    // `+44 (0)20…`, `(+91) (0) 98204…`, `0044 (0)20…`: drop the "(0)" while it is
    // still bracketed — once the brackets go it is indistinguishable from a digit.
    .replace(/^(\(?\s*(?:\+|00)\s*\d{1,3}\s*\)?)[\s.-]*\(\s*0\s*\)/, '$1 ');
  // Digits and a plus; everything else a paste drags in is formatting.
  let compact = withoutScheme.replace(/[^\d+]/g, '');
  const leadingPlus = compact.startsWith('+');
  compact = compact.replace(/\+/g, '');
  if (leadingPlus) return sanitiseDialInput(`+${compact}`);
  if (compact.startsWith('00')) return sanitiseDialInput(`+${compact.slice(2)}`);
  if (compact.startsWith('0')) {
    const cc = defaultCountryCode.replace(/[^\d]/g, '');
    const national = compact.replace(/^0+/, '');
    return sanitiseDialInput(cc ? `+${cc}${national}` : national);
  }
  return sanitiseDialInput(compact);
}

/** How many digits the field holds (the `+`, `*` and `#` are not digits). */
export function dialDigitCount(value: string): number {
  return value.replace(/[^\d]/g, '').length;
}

export type DialBlockReason = 'empty' | 'too_short' | 'too_long' | 'not_a_number';

/** Why Call is refused for this value, or null when it may be sent. */
export function dialBlockReason(value: string): DialBlockReason | null {
  if (value.length === 0) return 'empty';
  // `*` and `#` are tones, not part of a phone number; they belong to a keypad
  // during a call, which the soft phone does not have yet.
  if (/[*#]/.test(value)) return 'not_a_number';
  const digits = dialDigitCount(value);
  if (digits < MIN_DIAL_DIGITS) return 'too_short';
  if (digits > MAX_DIAL_DIGITS) return 'too_long';
  return null;
}

export const DIAL_BLOCK_COPY: Record<DialBlockReason, string> = {
  empty: 'Type or paste a number to call.',
  too_short: 'That number is too short to call.',
  too_long: 'That number is too long — a phone number has at most 15 digits.',
  not_a_number: '* and # are tones, not part of a number. Remove them to call.',
};

/**
 * A number laid out for reading: `+91 98204 61733` for an Indian mobile, the
 * country code split off for other `+` numbers we can recognise, and the value
 * unchanged otherwise. Display only — what is sent is never re-spaced.
 */
export function formatDialNumber(value: string | null | undefined): string {
  if (!value) return '';
  const compact = value.replace(/\s+/g, '');
  const india = /^\+91(\d{10})$/.exec(compact);
  if (india) return `+91 ${india[1]!.slice(0, 5)} ${india[1]!.slice(5)}`;
  const nanp = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(compact);
  if (nanp) return `+1 ${nanp[1]} ${nanp[2]} ${nanp[3]}`;
  const national = /^(\d{5})(\d{5})$/.exec(compact);
  if (national) return `${national[1]} ${national[2]}`;
  return compact;
}
