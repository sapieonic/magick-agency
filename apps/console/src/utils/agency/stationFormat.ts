/**
 * How the agent station writes numbers, money, dates and times (AS15, spec §6.6): ₹ with Indian
 * grouping and no decimals unless they are not zero, "20 Nov" (with the day when it helps,
 * "Fri 20 Nov"), "3:00 PM", "0:25" for a running clock and "1h 52m" for a total. Pure, and on
 * the reader's own clock: the station has no customer time zone (spec 8, the timezone caveat).
 */

import { formatPhone } from '@magick-agency/web-ui/format';

const INDIAN_GROUPING = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
const DAY_MONTH = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' });
const WEEKDAY = new Intl.DateTimeFormat('en-GB', { weekday: 'short' });
const UTC_DAY_MONTH = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });

/** A plain decimal ("12500", "12,500", "12500.50"), else null. */
function parseAmount(raw: string): { whole: string; frac: string } | null {
  const text = raw.trim().replace(/^₹\s*/, '').replace(/,/g, '');
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(text);
  if (!m) return null;
  return { whole: m[1]!, frac: (m[2] ?? '').padEnd(2, '0') };
}

/** `₹12,500`, `₹1,25,000`, `₹6,250.50`; null when the text is not an amount. */
export function rupees(raw: string | number): string | null {
  const parsed = parseAmount(String(raw));
  if (!parsed) return null;
  // `format` takes the digit string (Intl.NumberFormat v3), so nothing rounds through a float.
  const whole = INDIAN_GROUPING.format(parsed.whole as unknown as number);
  return parsed.frac === '00' ? `₹${whole}` : `₹${whole}.${parsed.frac}`;
}

/**
 * A promised amount (PT5): Indian grouping with no symbol, `12,500`, `1,25,000`, `6,250.50`. No
 * currency is stored with a promise, so it never carries ₹; null when the text is not an amount.
 */
export function promisedAmount(raw: string | number): string | null {
  return rupees(raw)?.replace(/^₹/, '') ?? null;
}

/**
 * A plain number fact (AS19, `number`): Indian grouping, `1,25,000`; its decimals as read, and
 * none when they are all zero (`12.50` stays, `12.00` is `12`). Null when the text is not a plain
 * decimal (the domain's parse answers one).
 */
export function groupedNumber(raw: string): string | null {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(raw.trim());
  if (!m) return null;
  const whole = INDIAN_GROUPING.format(m[1]!.replace(/^0+(?=\d)/, '') as unknown as number);
  const frac = m[2] ?? '';
  return /^0*$/.test(frac) ? whole : `${whole}.${frac}`;
}

/**
 * A read date fact (`YYYY-MM-DD`) as `20 Nov`, or `20 Nov 2027` when its year is not the
 * reader's this year; the text as given when it is not a calendar day.
 */
export function factDay(day: string, now: Date | number = Date.now()): string {
  const m = /^(\d{4})-\d{2}-\d{2}$/.exec(day.trim());
  if (!m) return day;
  const shown = calendarDay(day);
  return Number(m[1]) === new Date(now).getFullYear() ? shown : `${shown} ${m[1]}`;
}

/**
 * A read phone fact (the domain's parse: digits, `+` kept when written) the way the card shows
 * the customer's own number (AS9, {@link phoneForDisplay}): ten digits, or twelve starting 91, are
 * an Indian mobile (`+91 98765 43321`, masked `98••• ••321`); any other number as read in full,
 * its digits masked. Masked never shows more than the first two and last three digits.
 */
export function factPhone(digits: string, display: 'full' | 'masked' = 'full'): string {
  const text = digits.trim();
  const bare = text.replace(/\D/g, '');
  const indian = !text.startsWith('+') && bare.length === 10
    ? bare
    : !text.startsWith('+') && bare.length === 12 && bare.startsWith('91')
      ? bare.slice(2)
      : null;
  return phoneForDisplay(indian ? `+91${indian}` : text, display);
}

/** Half of an amount as a plain decimal string, for the "Half" chip; null when not an amount. */
export function halfAmount(raw: string): string | null {
  const parsed = parseAmount(raw);
  if (!parsed) return null;
  const paise = Number(parsed.whole) * 100 + Number(parsed.frac);
  const half = Math.floor(paise / 2);
  const rest = half % 100;
  return rest === 0 ? String(half / 100) : `${Math.floor(half / 100)}.${String(rest).padStart(2, '0')}`;
}

/** `20 Nov`, on the reader's calendar. */
export function dayMonth(at: Date | number): string {
  return DAY_MONTH.format(at);
}

/** `Fri 20 Nov`, on the reader's calendar. */
export function weekdayDayMonth(at: Date | number): string {
  return `${WEEKDAY.format(at)} ${DAY_MONTH.format(at)}`;
}

/** A calendar day (`YYYY-MM-DD`) as `20 Nov`, or the text as given when it is not one. */
export function calendarDay(day: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day.trim());
  if (!m) return day;
  return UTC_DAY_MONTH.format(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
}

/** `3:00 PM`, on the reader's clock. */
export function clockTime(at: Date | number): string {
  const d = new Date(at);
  const hours = d.getHours();
  const minutes = String(d.getMinutes()).padStart(2, '0');
  const h12 = hours % 12 === 0 ? 12 : hours % 12;
  return `${h12}:${minutes} ${hours < 12 ? 'AM' : 'PM'}`;
}

/** A running clock: `0:25`, `12:05`, `1:02:03`. Never negative. */
export function runningClock(ms: number): string {
  const total = Math.floor(Math.max(0, ms) / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** A total: `1h 52m`, `45m`, `0m`. */
export function hoursMinutes(seconds: number): string {
  const minutes = Math.floor(Math.max(0, seconds) / 60);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

/** Initials for the customer's avatar: "Ramesh Goud" → "RG"; one word → its first two letters. */
export function initials(name: string | null): string {
  const words = (name ?? '').trim().split(/\s+/).filter((w) => /\p{L}/u.test(w));
  if (words.length === 0) return '';
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return `${words[0]![0]}${words[words.length - 1]![0]}`.toUpperCase();
}

/** The same calendar day on the reader's clock. */
export function sameDay(a: Date | number, b: Date | number): boolean {
  return new Date(a).toDateString() === new Date(b).toDateString();
}

/**
 * The customer's number as every station screen and panel shows it, and as campaign Settings'
 * preview shows it (AS9): `+91 98765 43321` in full, `98••• ••321` masked. The same rule as the
 * agent app's `stationPhone` (`apps/mobile/lib/features/station/logic/format.dart`): full is
 * web-ui's `formatPhone` (an Indian mobile in two groups of five, anything else as given); masked
 * keeps the first two and the last three digits of the ten after +91 (of all the digits for any
 * other number), and a number too short to mask shows no digit at all.
 */
export function phoneForDisplay(phoneE164: string, display: 'full' | 'masked' = 'full'): string {
  if (display === 'full') return formatPhone(phoneE164);
  const indian = /^\+91(\d{10})$/.exec(phoneE164.trim());
  const digits = indian?.[1] ?? phoneE164.replace(/\D/g, '');
  if (digits.length < 7) return '•••';
  return `${digits.slice(0, 2)}••• ••${digits.slice(-3)}`;
}
