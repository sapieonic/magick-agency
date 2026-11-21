/**
 * Reads a roster value as money, a date, a number, a phone number or a yes / no (agent station
 * redesign, BE-6; the last three AS19): the ONE parse rule
 * behind `AgencyFactTile.value` (`@magick-agency/contracts`, `agency/customer-facts.ts`). The
 * server parses once, at dial time, and sends the answer beside the raw text, so the console and
 * the app never each write a money or date parser. A LEAF: no I/O, no imports.
 *
 * ── The rule: when in doubt, null ───────────────────────────────────────────
 * A wrong amount shown to a collections agent is worse than the raw text, so every reading that
 * is not certain answers `null` and the client shows `raw`.
 *
 * Money ({@link parseMoneyFact}): an optional rupee sign or word before (`₹`, `Rs`, `Rs.`, `INR`)
 * and after (`/-`, `INR`, `only`), spaces around them, then digits grouped the Indian way
 * (`1,25,000`) or the western way (`125,000`) or not at all (`125000`), a single space standing
 * for a grouping comma (`1 25 000`, `125 000`) but only where the comma would stand, then at
 * most two decimals. Answers a plain decimal string: no sign, no grouping, no leading zeros, the decimals
 * as written (`"125000"`, `"125000.50"`). Refused (null): a minus sign or brackets, a decimal
 * comma (`12,50`), a grouping that is neither form (`1,2,3`), spaces that are not a grouping
 * (`5000 2500` is two amounts, not 50,002,500), spaces and commas mixed, three or more decimals,
 * words (`1.25 lakh`), an exponent.
 *
 * Date ({@link parseDateFact}): year first (`2026-11-25`, `2026/11/25`, with a time of day after
 * it and no zone), then day first (`25/11/2026`, `25-11-26`, `25.11.2026`, `25 Nov 2026`,
 * `25th November 2026`, `25-Nov-26`), and a named month first (`Nov 25, 2026`), whose order a
 * month name makes certain. Answers `YYYY-MM-DD`, a calendar day: no zone conversion, ever. A
 * two-digit year is the century that puts the date nearest today, within 50 years either side
 * (`15/08/85` is 1985, `25/11/26` is 2026; `fullYear`). Refused (null): month first with numbers (`11/25/2026` is never read
 * as 25 Nov; `03/04/2026` is read as 3 Apr, day first, as the roster's own country writes it),
 * a day the calendar does not have (`31/02/2026`), a time with a zone (`…T18:30:00Z`: which day
 * it is depends on where you stand), a spreadsheet serial number (`46351`), anything else.
 *
 * Number ({@link parseNumberFact}, AS19): money's reading without the rupee sign or word: digits
 * grouped the Indian or the western way or not at all, a space standing for a grouping comma only
 * where the comma would stand, then any number of decimals. Answers a plain decimal string, no
 * grouping and no leading zeros (`"125000"`, `"10.375"`). Refused (null): a sign, a currency, a
 * percent, a decimal comma, a grouping that is neither form, words, an exponent.
 *
 * Phone ({@link parsePhoneFact}, AS19): digits with an optional leading `+`, spaces, dashes and
 * brackets ignored. Answers the digits, the `+` kept when it was there (`"+919876543210"`,
 * `"09876543210"`). Refused (null): fewer than 6 or more than 15 digits, a `+` anywhere but first,
 * any other character (letters, dots, `/`, an extension). Display only: never dialled from.
 *
 * Yes / no ({@link parseYesNoFact}, AS19): `yes`, `y`, `true`, `1`, `haan`, `ha` answer `"yes"`;
 * `no`, `n`, `false`, `0`, `nahi`, `nahin` answer `"no"`; case and surrounding space ignored.
 * Anything else: null.
 */

/** The longest value read at all; anything longer is not a single amount or date. */
const MAX_FACT_CHARS = 64;

/** Every kind of space a spreadsheet export puts in a value (no-break, narrow no-break, thin). */
const SPACES = /[\s   ]+/g;

const MONEY_PREFIX = /^(?:₹|rs\.?|inr)\s*/i;
const MONEY_SUFFIX = /\s*(?:\/-|inr|only|₹)$/i;

/** Indian grouping (`1,25,000`), western grouping (`125,000`), or none (`125000`). */
const MONEY_INTEGER = /^(?:\d{1,2}(?:,\d{2})*,\d{3}|\d{1,3}(?:,\d{3})+|\d+)$/;

/**
 * A money value as a plain decimal string (`"125000"`, `"12500.50"`), or `null` when it cannot be
 * read for certain. See the module header for the rule.
 */
export function parseMoneyFact(raw: string): string | null {
  if (typeof raw !== 'string') return null;
  let text = raw.replace(SPACES, ' ').trim();
  if (text.length === 0 || text.length > MAX_FACT_CHARS) return null;
  text = text.replace(MONEY_PREFIX, '');
  // A suffix may come twice (`12,500/- only`); strip at most two.
  for (let i = 0; i < 2; i++) text = text.replace(MONEY_SUFFIX, '');
  text = text.trim();
  const [rawInteger, decimals, extra] = text.split('.');
  if (extra !== undefined || rawInteger === undefined) return null;
  // A space may stand where a grouping comma would (`1 25 000`, `125 000`), and only there: the
  // groups must then make one of the two forms, so two amounts side by side (`5000 2500`) are not
  // read as one. Never spaces and commas in one amount, never a space among the decimals.
  if (rawInteger.includes(' ') && rawInteger.includes(',')) return null;
  const integer = rawInteger.replace(/ /g, ',');
  if (!MONEY_INTEGER.test(integer)) return null;
  if (decimals !== undefined && !/^\d{1,2}$/.test(decimals)) return null;
  const digits = integer.replace(/,/g, '').replace(/^0+(?=\d)/, '');
  return decimals === undefined ? digits : `${digits}.${decimals}`;
}

const MONTHS: ReadonlyArray<readonly [string, string]> = [
  ['jan', 'january'], ['feb', 'february'], ['mar', 'march'], ['apr', 'april'],
  ['may', 'may'], ['jun', 'june'], ['jul', 'july'], ['aug', 'august'],
  ['sep', 'september'], ['oct', 'october'], ['nov', 'november'], ['dec', 'december'],
];

/** A month's number (1–12) from its name: the three-letter form, `Sept`, or the full name. */
function monthNumber(name: string): number | null {
  const word = name.toLowerCase();
  const index = MONTHS.findIndex(([short, full]) => word === short || word === full || (short === 'sep' && word === 'sept'));
  return index === -1 ? null : index + 1;
}

/**
 * The year a date names. A four-digit one is taken as written. A two-digit one is the century that
 * puts the date nearest `now`, so it lands within 50 years either side of today: on 20 Nov 2026,
 * `15/08/85` is 1985 (41 years back, not 59 ahead), `25/11/26` is 2026 and `01/01/70` is 2070
 * (about 43 years ahead; 1970 would be nearly 57 back). A date of birth more than 50 years ago written
 * with two digits therefore reads in the future: a roster that holds such dates should write four.
 */
function fullYear(year: string, month: number, day: number, now: Date): number {
  if (year.length !== 2) return Number(year);
  const yy = Number(year);
  const century = Math.floor(now.getUTCFullYear() / 100) * 100;
  let best = century + yy;
  let bestDistance = Infinity;
  for (const candidate of [century - 100 + yy, century + yy, century + 100 + yy]) {
    const distance = Math.abs(Date.UTC(candidate, month - 1, day) - now.getTime());
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}

/** `YYYY-MM-DD` when the calendar has that day, else null. */
function calendarDay(year: number, month: number, day: number): string | null {
  if (year < 1900 || year > 2199 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** A time of day after a date, with no zone (a zone would make the day depend on where you stand). */
const TIME_OF_DAY = String.raw`(?:[T ]\d{1,2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:\s?[ap]\.?m\.?)?)?`;

const YEAR_FIRST = new RegExp(String.raw`^(\d{4})[-/](\d{1,2})[-/](\d{1,2})${TIME_OF_DAY}$`, 'i');
const DAY_FIRST = new RegExp(String.raw`^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4}|\d{2})${TIME_OF_DAY}$`, 'i');
const DAY_FIRST_NAMED = /^(\d{1,2})(?:st|nd|rd|th)?[\s\-/.,]+([a-z]{3,9})\.?[\s\-/.,]+(\d{4}|\d{2})$/i;
const NAMED_FIRST = /^([a-z]{3,9})\.?[\s\-]+(\d{1,2})(?:st|nd|rd|th)?,?[\s\-]+(\d{4})$/i;

/**
 * A date value as `YYYY-MM-DD`, or `null` when it cannot be read for certain. Never month first
 * with numbers. `now` (the clock by default) picks a two-digit year's century. See the module
 * header for the rule.
 */
export function parseDateFact(raw: string, now: Date = new Date()): string | null {
  if (typeof raw !== 'string') return null;
  const text = raw.replace(SPACES, ' ').trim();
  if (text.length === 0 || text.length > MAX_FACT_CHARS) return null;

  let m = YEAR_FIRST.exec(text);
  if (m) return calendarDay(Number(m[1]), Number(m[2]), Number(m[3]));

  m = DAY_FIRST.exec(text);
  if (m) return calendarDay(fullYear(m[3]!, Number(m[2]), Number(m[1]), now), Number(m[2]), Number(m[1]));

  m = DAY_FIRST_NAMED.exec(text);
  if (m) {
    const month = monthNumber(m[2]!);
    return month === null ? null : calendarDay(fullYear(m[3]!, month, Number(m[1]), now), month, Number(m[1]));
  }

  m = NAMED_FIRST.exec(text);
  if (m) {
    const month = monthNumber(m[1]!);
    return month === null ? null : calendarDay(Number(m[3]), month, Number(m[2]));
  }
  return null;
}

/**
 * A number value as a plain decimal string (`"125000"`, `"10.375"`), or `null` when it cannot be
 * read for certain. Money's grouping rule without a currency. See the module header for the rule.
 */
export function parseNumberFact(raw: string): string | null {
  if (typeof raw !== 'string') return null;
  const text = raw.replace(SPACES, ' ').trim();
  if (text.length === 0 || text.length > MAX_FACT_CHARS) return null;
  const [rawInteger, decimals, extra] = text.split('.');
  if (extra !== undefined || rawInteger === undefined) return null;
  if (rawInteger.includes(' ') && rawInteger.includes(',')) return null;
  const integer = rawInteger.replace(/ /g, ',');
  if (!MONEY_INTEGER.test(integer)) return null;
  if (decimals !== undefined && !/^\d+$/.test(decimals)) return null;
  const digits = integer.replace(/,/g, '').replace(/^0+(?=\d)/, '');
  return decimals === undefined ? digits : `${digits}.${decimals}`;
}

/** The fewest and most digits a phone number may have (E.164 allows 15). */
const PHONE_MIN_DIGITS = 6;
const PHONE_MAX_DIGITS = 15;

/**
 * A phone number as its digits, the leading `+` kept when present (`"+919876543210"`), or `null`
 * when it is not one. See the module header for the rule.
 */
export function parsePhoneFact(raw: string): string | null {
  if (typeof raw !== 'string') return null;
  const text = raw.replace(SPACES, ' ').trim();
  if (text.length === 0 || text.length > MAX_FACT_CHARS) return null;
  const plus = text.startsWith('+');
  const rest = plus ? text.slice(1) : text;
  if (!/^[\d\s\-()]+$/.test(rest)) return null;
  const digits = rest.replace(/\D/g, '');
  if (digits.length < PHONE_MIN_DIGITS || digits.length > PHONE_MAX_DIGITS) return null;
  return plus ? `+${digits}` : digits;
}

const YES_WORDS: ReadonlySet<string> = new Set(['yes', 'y', 'true', '1', 'haan', 'ha']);
const NO_WORDS: ReadonlySet<string> = new Set(['no', 'n', 'false', '0', 'nahi', 'nahin']);

/** A yes / no value as `"yes"` or `"no"`, or `null`. See the module header for the words. */
export function parseYesNoFact(raw: string): 'yes' | 'no' | null {
  if (typeof raw !== 'string') return null;
  const word = raw.replace(SPACES, ' ').trim().toLowerCase();
  if (YES_WORDS.has(word)) return 'yes';
  if (NO_WORDS.has(word)) return 'no';
  return null;
}

/** The field types a value is read as (`AgencyContextFieldType`; `context-facts.test.ts` holds them equal). */
export type ContextFactType = 'text' | 'money' | 'date' | 'number' | 'phone' | 'yes_no';

/**
 * A value read as its column's type: `parseMoneyFact` for `money`, `parseDateFact` for `date`,
 * `parseNumberFact` for `number`, `parsePhoneFact` for `phone`, `parseYesNoFact` for `yes_no`, and
 * always `null` for `text` or a type it does not know (the client shows `raw`).
 */
export function parseContextFact(raw: string, type: ContextFactType, now: Date = new Date()): string | null {
  switch (type) {
    case 'money':
      return parseMoneyFact(raw);
    case 'date':
      return parseDateFact(raw, now);
    case 'number':
      return parseNumberFact(raw);
    case 'phone':
      return parsePhoneFact(raw);
    case 'yes_no':
      return parseYesNoFact(raw);
    default:
      return null;
  }
}
