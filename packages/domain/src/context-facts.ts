/**
 * Reads a roster value as money or as a date (agent station redesign, BE-6): the ONE parse rule
 * behind `AgencyFactTile.value` (`@magick-agency/contracts`, `agency/customer-facts.ts`). The
 * server parses once, at dial time, and sends the answer beside the raw text, so the console and
 * the app never each write a money or date parser. A LEAF: no I/O, no imports.
 *
 * ── The rule: when in doubt, null ───────────────────────────────────────────
 * A wrong amount shown to a collections agent is worse than the raw text, so every reading that
 * is not certain answers `null` and the client shows `raw`.
 *
 * Money ({@link parseMoneyFact}): an optional rupee sign or word before (`₹`, `Rs`, `Rs.`, `INR`)
 * and after (`/-`, `INR`, `only`), spaces anywhere, then digits grouped the Indian way
 * (`1,25,000`) or the western way (`125,000`) or not at all (`125000`), then at most two
 * decimals. Answers a plain decimal string: no sign, no grouping, no leading zeros, the decimals
 * as written (`"125000"`, `"125000.50"`). Refused (null): a minus sign or brackets, a decimal
 * comma (`12,50`), a grouping that is neither form (`1,2,3`), three or more decimals, words
 * (`1.25 lakh`), an exponent.
 *
 * Date ({@link parseDateFact}): year first (`2026-11-25`, `2026/11/25`, with a time of day after
 * it and no zone), then day first (`25/11/2026`, `25-11-26`, `25.11.2026`, `25 Nov 2026`,
 * `25th November 2026`, `25-Nov-26`), and a named month first (`Nov 25, 2026`), whose order a
 * month name makes certain. Answers `YYYY-MM-DD`, a calendar day: no zone conversion, ever. A
 * two-digit year is 20YY. Refused (null): month first with numbers (`11/25/2026` is never read
 * as 25 Nov; `03/04/2026` is read as 3 Apr, day first, as the roster's own country writes it),
 * a day the calendar does not have (`31/02/2026`), a time with a zone (`…T18:30:00Z`: which day
 * it is depends on where you stand), a spreadsheet serial number (`46351`), anything else.
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
  text = text.replace(/ /g, '');
  const [integer, decimals, extra] = text.split('.');
  if (extra !== undefined || integer === undefined || !MONEY_INTEGER.test(integer)) return null;
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

/** A two-digit year is this century's; a four-digit one is taken as written. */
function fullYear(year: string): number {
  return year.length === 2 ? 2000 + Number(year) : Number(year);
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
 * with numbers. See the module header for the rule.
 */
export function parseDateFact(raw: string): string | null {
  if (typeof raw !== 'string') return null;
  const text = raw.replace(SPACES, ' ').trim();
  if (text.length === 0 || text.length > MAX_FACT_CHARS) return null;

  let m = YEAR_FIRST.exec(text);
  if (m) return calendarDay(Number(m[1]), Number(m[2]), Number(m[3]));

  m = DAY_FIRST.exec(text);
  if (m) return calendarDay(fullYear(m[3]!), Number(m[2]), Number(m[1]));

  m = DAY_FIRST_NAMED.exec(text);
  if (m) {
    const month = monthNumber(m[2]!);
    return month === null ? null : calendarDay(fullYear(m[3]!), month, Number(m[1]));
  }

  m = NAMED_FIRST.exec(text);
  if (m) {
    const month = monthNumber(m[1]!);
    return month === null ? null : calendarDay(Number(m[3]), month, Number(m[2]));
  }
  return null;
}

/** The field types a value is read as (`AgencyContextFieldType`). */
export type ContextFactType = 'text' | 'money' | 'date';

/**
 * A value read as its column's type: `parseMoneyFact` for `money`, `parseDateFact` for `date`,
 * and always `null` for `text` (the client shows `raw`).
 */
export function parseContextFact(raw: string, type: ContextFactType): string | null {
  if (type === 'money') return parseMoneyFact(raw);
  if (type === 'date') return parseDateFact(raw);
  return null;
}
