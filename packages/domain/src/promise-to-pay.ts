/**
 * ─── PROMISE TO PAY — THE SHARED RULES (PT1–PT7) ───────────────────────────
 *
 * A LEAF module, read by the server (the disposition routes' validation, the contact's
 * promise columns, the follow-up) and the console (the outcome pad's checks, the catalogue
 * editor), so the rule an agent is shown and the rule the server enforces are one definition.
 * Imports nothing beyond the contracts and the zone clock. The app ports it by hand
 * (`apps/mobile/lib/core/station/promise_rules.dart`). Decisions PT1–PT14 (`docs/decisions.md`).
 *
 * Total: nothing here throws. Every reader answers null (or a refusal) and the caller decides.
 */
import {
  AGENCY_PROMISE_AMOUNT_MAX_INTEGER_DIGITS,
  AGENCY_PROMISE_MAX_DAYS_AHEAD,
  type AgencyPromiseState,
} from '@magick-agency/contracts/agency';
import { instantForLocalTime, localParts } from './zone-clock';

/** A calendar date, as the customer reads it. */
export interface PromiseDay {
  year: number;
  month: number;
  day: number;
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Read a `YYYY-MM-DD` string as a real calendar date, or null. Strict: no time part, no
 * other separator, and a date that does not exist (`2026-02-30`) is null rather than rolled
 * over into March, which is what `new Date('2026-02-30')` would quietly do.
 */
export function parsePromiseDate(value: unknown): PromiseDay | null {
  if (typeof value !== 'string') return null;
  const m = DATE_RE.exec(value);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (year < 1970 || month < 1 || month > 12 || day < 1) return null;
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) {
    return null;
  }
  return { year, month, day };
}

/** `YYYY-MM-DD`. */
export function formatPromiseDay(d: PromiseDay): string {
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${pad(d.year, 4)}-${pad(d.month)}-${pad(d.day)}`;
}

/** Whole days from `a` to `b` (negative when `b` is earlier), by the calendar alone. */
export function daysBetween(a: PromiseDay, b: PromiseDay): number {
  return Math.round((Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day)) / 86_400_000);
}

/** `d` plus `n` calendar days (month and year roll over). */
export function addDays(d: PromiseDay, n: number): PromiseDay {
  const t = new Date(Date.UTC(d.year, d.month - 1, d.day + n));
  return { year: t.getUTCFullYear(), month: t.getUTCMonth() + 1, day: t.getUTCDate() };
}

/** The customer's today in `timezone` at `now`, or null when the zone cannot be read. */
export function todayIn(timezone: string, now: Date): PromiseDay | null {
  const p = localParts(timezone, now);
  return p ? { year: p.year, month: p.month, day: p.day } : null;
}

/**
 * The instant `d` begins in `timezone` (its first local instant, normally 00:00), or null.
 * `instantForLocalTime` can land an hour off when midnight falls in a DST gap (a few zones
 * spring forward at 00:00, so the day starts at 01:00); the result is walked onto the day and
 * back to its first hour, so a day's start is never placed on the evening before or an hour
 * into the day.
 */
export function dayStartIn(timezone: string, d: PromiseDay): Date | null {
  let t = instantForLocalTime(timezone, d.year, d.month, d.day, 0);
  if (!t) return null;
  const onDay = (x: Date): boolean => {
    const p = localParts(timezone, x);
    return p !== null && p.year === d.year && p.month === d.month && p.day === d.day;
  };
  for (let i = 0; i < 4 && !onDay(t); i++) t = new Date(t.getTime() + 3_600_000);
  if (!onDay(t)) return null;
  for (let i = 0; i < 4 && onDay(new Date(t.getTime() - 3_600_000)); i++) t = new Date(t.getTime() - 3_600_000);
  const p = localParts(timezone, t);
  if (!p) return null;
  const trimmed = new Date(t.getTime() - (p.minute * 60_000 + p.second * 1000));
  return onDay(trimmed) ? trimmed : t;
}

/** Why a promised date is refused, or null when it is accepted (PT4). */
export type PromiseDateRefusal = 'invalid' | 'past' | 'too_far';

/**
 * Is `value` a promised date the customer could have given today: a real `YYYY-MM-DD` date,
 * not before `today` (the customer's, from {@link todayIn}) and at most
 * `AGENCY_PROMISE_MAX_DAYS_AHEAD` days after it. Today itself is accepted: "I'll pay this
 * evening" is a promise for today.
 */
export function promiseDateRefusal(value: unknown, today: PromiseDay): PromiseDateRefusal | null {
  const d = parsePromiseDate(value);
  if (!d) return 'invalid';
  const ahead = daysBetween(today, d);
  if (ahead < 0) return 'past';
  if (ahead > AGENCY_PROMISE_MAX_DAYS_AHEAD) return 'too_far';
  return null;
}

const AMOUNT_RE = new RegExp(`^(\\d{1,${AGENCY_PROMISE_AMOUNT_MAX_INTEGER_DIGITS}})(?:\\.(\\d{1,2}))?$`);

/**
 * Read a promised amount (PT5) as its exact two-place decimal string (`"12500"` →
 * `"12500.00"`, `"0.5"` → `"0.50"`), or null when it is not one: negative, more than two
 * places, more than twelve digits before them, a thousands separator, an exponent, a number
 * that is not finite. Never parsed through a float: the string's own digits are kept. A JS
 * number is accepted only when its shortest decimal form passes the same rule.
 */
export function normalisePromiseAmount(value: unknown): string | null {
  let text: string;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    text = String(value);
  } else if (typeof value === 'string') {
    text = value.trim();
  } else {
    return null;
  }
  const m = AMOUNT_RE.exec(text);
  if (!m) return null;
  const whole = m[1]!.replace(/^0+(?=\d)/, '');
  const frac = (m[2] ?? '').padEnd(2, '0');
  return `${whole}.${frac}`;
}

/** Was an amount given at all? Absent, null and the empty string mean "no amount". */
export function hasPromiseAmount(value: unknown): boolean {
  return !(value === undefined || value === null || (typeof value === 'string' && value.trim() === ''));
}

/**
 * Where a promise stands (PT7), from instants only, so the Contacts list's SQL and every
 * client agree without a timezone of their own:
 *  - `dueFrom` / `dueUntil`: the promised day's start and the next day's start in the
 *    customer's zone ({@link dayStartIn}), stored with the promise;
 *  - `followedUp`: whether an outcome was recorded on the contact by a call made after the
 *    promise and on or after `dueFrom`.
 */
export function promiseState(
  input: { dueFrom: Date; dueUntil: Date; followedUp: boolean },
  now: Date,
): AgencyPromiseState {
  const t = now.getTime();
  if (t < input.dueFrom.getTime()) return 'upcoming';
  if (t < input.dueUntil.getTime()) return 'due_today';
  return input.followedUp ? 'followed_up' : 'missed';
}

/**
 * The day a follow-up is booked for (PT2): `promiseDay` plus `followUpDays`. The caller
 * turns it into the day's start in the customer's zone and defers that into the calling
 * window, as any callback is deferred.
 */
export function followUpDay(promiseDay: PromiseDay, followUpDays: number): PromiseDay {
  return addDays(promiseDay, followUpDays);
}

/** Why a submission's promise fields are refused (the action error codes, PT8). */
export type PromiseFieldRefusal =
  | 'promise_required'
  | 'invalid_promise_date'
  | 'invalid_promise_amount'
  | 'promise_not_expected';

/** A validated promise: the day and the amount's exact two-place string (or null). */
export interface ValidPromise {
  day: PromiseDay;
  /** `YYYY-MM-DD`. */
  date: string;
  amount: string | null;
}

/**
 * A submission's promise fields against its catalog entry (PT1, PT4, PT5, PT8), in the order
 * an agent fixes them:
 *  - an entry without `requires_promise` takes no promise: a date or an amount sent with it
 *    is `promise_not_expected` (a sticky field from a previous selection would otherwise
 *    record a promise against "Not interested");
 *  - an entry with it needs a date (`promise_required`; an amount alone is still that);
 *  - the date must pass {@link promiseDateRefusal} against the customer's `today`;
 *  - the amount, when given, must pass {@link normalisePromiseAmount}.
 *
 * `recordedDate` is the promised date already stored on the call when this submission is a
 * same-code replay of its outcome (a corrected amount, a retry queued across midnight, a
 * supervisor re-filing from history). Sending that date again is not a new promise: it was
 * checked against the customer's today when it was first saved, so it is not refused for
 * having since become the past. Only the past-date check is waived, and only for that exact
 * date; a changed date is checked in full, and the forward bound always holds.
 */
export function validatePromiseFields(
  entry: { requires_promise?: unknown },
  body: { promise_date?: unknown; promise_amount?: unknown },
  today: PromiseDay,
  recordedDate?: string | null,
): { ok: true; promise: ValidPromise | null } | { ok: false; code: PromiseFieldRefusal } {
  const hasDate = !(body.promise_date === undefined || body.promise_date === null || body.promise_date === '');
  const hasAmount = hasPromiseAmount(body.promise_amount);
  if (entry.requires_promise !== true) {
    return hasDate || hasAmount ? { ok: false, code: 'promise_not_expected' } : { ok: true, promise: null };
  }
  if (!hasDate) return { ok: false, code: 'promise_required' };
  const dateRefusal = promiseDateRefusal(body.promise_date, today);
  const kept = dateRefusal === 'past' && typeof recordedDate === 'string' && body.promise_date === recordedDate;
  if (dateRefusal !== null && !kept) return { ok: false, code: 'invalid_promise_date' };
  let amount: string | null = null;
  if (hasAmount) {
    amount = normalisePromiseAmount(body.promise_amount);
    if (amount === null) return { ok: false, code: 'invalid_promise_amount' };
  }
  const day = parsePromiseDate(body.promise_date)!;
  return { ok: true, promise: { day, date: formatPromiseDay(day), amount } };
}
