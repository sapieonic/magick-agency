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

/** A plain decimal amount: whole units and up to two decimals (`12500`, `12500.5`, `12500.50`). */
const AMOUNT = /^(\d+)(?:\.(\d{1,2}))?$/;

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
  const m = AMOUNT.exec(amount.trim());
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

// ── Sums of amounts (Live floor's Will pay tile) ────────────────────────────

/** An amount in paise (hundredths), exactly; null when it is not a plain decimal. */
function minorUnits(amount: string): bigint | null {
  const m = AMOUNT.exec(amount.trim());
  if (!m) return null;
  return BigInt(m[1]!) * 100n + BigInt((m[2] ?? '').padEnd(2, '0'));
}

function fromMinor(minor: bigint): string {
  const whole = minor / 100n;
  const frac = (minor % 100n).toString().padStart(2, '0');
  return `${whole.toString()}.${frac}`;
}

/**
 * The sum of decimal amounts (`"240000.00"`), exact: added as whole hundredths in `BigInt`, never
 * through a float, so a total past what a float holds is still right to the paisa. A value that is
 * not a plain decimal is left out.
 */
export function sumPromiseAmounts(amounts: readonly string[]): string {
  let total = 0n;
  for (const amount of amounts) {
    const minor = minorUnits(amount);
    if (minor !== null) total += minor;
  }
  return fromMinor(total);
}

const LAKH = 100_000n;
const CRORE = 10_000_000n;

/** `value / unit` to one decimal, rounded half up, "2.4" or "2" (a trailing `.0` dropped). */
function tenthsOf(minor: bigint, unit: bigint): { tenths: bigint; text: string } {
  const denominator = unit * 100n;
  const tenths = (minor * 10n + denominator / 2n) / denominator;
  const whole = tenths / 10n;
  const frac = tenths % 10n;
  const wholeText = WHOLE.format(whole.toString() as unknown as number);
  return { tenths, text: frac === 0n ? wholeText : `${wholeText}.${frac.toString()}` };
}

/**
 * A total in the words an Indian reader uses, with no currency (none is stored, PT5 and LF2):
 * under a lakh as the amount itself (`45,000`, `45,000.50`), then `2.4 lakh`, then `1.2 crore`,
 * to one decimal. Worked from the decimal string, never a float. The raw value when it is not a
 * plain decimal.
 */
export function formatAmountShort(amount: string): string {
  const minor = minorUnits(amount);
  if (minor === null) return amount;
  const whole = minor / 100n;
  if (whole < LAKH) return formatPromiseAmount(fromMinor(minor));
  if (whole < CRORE) {
    const lakh = tenthsOf(minor, LAKH);
    // 99.96 lakh rounds to 100 lakh: say it as a crore.
    if (lakh.tenths < 1000n) return `${lakh.text} lakh`;
  }
  return `${tenthsOf(minor, CRORE).text} crore`;
}
