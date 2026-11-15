import { AGENCY_PROMISE_STATE_LABELS, type AgencyPromiseState } from '@magick-agency/contracts/agency';
import { dateFormatter } from './date';
import { DISPLAY_LOCALE } from './number';

/**
 * A promise to pay (PT1), as every console screen prints it: "Promised 18 Nov 2026 · 12,500".
 *
 * ── The date is the customer's calendar day, never an instant ───────────────
 * `YYYY-MM-DD` is formatted in UTC from its own parts, so no reader's zone can move it a day
 * (a `new Date('2026-11-18')` read in a zone west of UTC prints the 17th).
 *
 * ── The amount has no currency ──────────────────────────────────────────────
 * No currency is configured anywhere in the product (PT5, pending a decision), so the number
 * is printed as the agent typed it, grouped in the console's locale (`en-IN`: `12,500`,
 * `1,25,000`), and never with a symbol. It is formatted from its decimal STRING, so a value
 * past what a float holds exactly is still printed exactly; a whole amount drops `.00`.
 */

const DATE_FORMAT: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' };
const WHOLE = new Intl.NumberFormat(DISPLAY_LOCALE, { maximumFractionDigits: 0 });

/** `18 Nov 2026`, or the raw value when it is not a `YYYY-MM-DD` date. */
export function formatPromiseDate(date: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return date;
  return dateFormatter(DATE_FORMAT).format(new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))));
}

/** `12,500`, `12,500.50`, `0`; the raw value when it is not a plain decimal. */
export function formatPromiseAmount(amount: string): string {
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(amount.trim());
  if (!m) return amount;
  // `format` takes the digit string itself (Intl.NumberFormat v3), so nothing is rounded
  // through a float.
  const whole = WHOLE.format(m[1] as unknown as number);
  const frac = (m[2] ?? '').padEnd(2, '0');
  return frac === '00' ? whole : `${whole}.${frac}`;
}

/** `Promised 18 Nov 2026 · 12,500`, or without the amount when none was given. */
export function formatPromise(promise: { date: string; amount?: string | null }): string {
  const date = `Promised ${formatPromiseDate(promise.date)}`;
  return promise.amount ? `${date} · ${formatPromiseAmount(promise.amount)}` : date;
}

/** The state's word, as both consoles and the app show it. */
export function promiseStateLabel(state: AgencyPromiseState): string {
  return AGENCY_PROMISE_STATE_LABELS[state] ?? state;
}

/**
 * What each state means, for a hover and the filter's help. "Missed" is said plainly to be
 * about follow-up, not payment: nothing in the product knows whether anyone paid (PT7).
 */
export const PROMISE_STATE_HINTS: Readonly<Record<AgencyPromiseState, string>> = {
  upcoming: 'The promised date is still ahead.',
  due_today: 'The customer promised to pay today.',
  missed: 'The promised date has passed and nobody has recorded an outcome for this contact since. It does not mean unpaid: we have no payment records.',
  followed_up: 'The promised date has passed and an outcome has been recorded for this contact since.',
};
