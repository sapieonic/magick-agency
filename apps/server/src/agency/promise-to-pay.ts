/**
 * Promise to pay (decisions PT1–PT14): what a recorded promise writes, beside the rules the
 * routes share with the console (`@magick-agency/domain/promise-to-pay`). Pure: the three
 * outcome paths (the station's disposition route, the soft phone's and the inbound call's)
 * own the I/O and call these in the same order.
 *
 *  1. Validate the fields against the entry in the customer's zone (`validateDispositionFields`
 *     with `promiseZoneFor`).
 *  2. Book the follow-up, only when the entry asks for one ({@link promiseFollowUpAt}). It is
 *     handed to the callback arm of the disposition decision and deferred into the calling
 *     window like any callback, so calling hours, DNC (checked at dial time), callback ownership
 *     (CA4) and the assignment rules apply to it unchanged. **Nothing else here schedules a
 *     dial: a promise alone never does (PT3).**
 *  3. Copy the promise onto the contact ({@link contactPromiseWrite}), or, for any other
 *     outcome, mark the contact's earlier promise followed up when this call qualifies (PT7).
 */
import type { AgencyDisposition } from '@magick-agency/contracts/agency';
import {
  AGENCY_PROMISE_FOLLOW_UP_DAYS_MAX,
  AGENCY_PROMISE_FOLLOW_UP_DAYS_MIN,
} from '@magick-agency/contracts/agency';
import {
  addDays,
  dayStartIn,
  followUpDay,
  type ValidPromise,
} from '@magick-agency/domain/promise-to-pay';

/** The entry's follow-up days when it is a usable value, else null (PT2). */
export function promiseFollowUpDays(entry: Pick<AgencyDisposition, 'requires_promise' | 'promise_follow_up_days'>): number | null {
  const n = entry.promise_follow_up_days;
  if (entry.requires_promise !== true || typeof n !== 'number' || !Number.isInteger(n)) return null;
  if (n < AGENCY_PROMISE_FOLLOW_UP_DAYS_MIN || n > AGENCY_PROMISE_FOLLOW_UP_DAYS_MAX) return null;
  return n;
}

/**
 * When the follow-up is due (PT2): the start of the promised day plus the entry's days, in the
 * customer's zone. The caller defers it into the calling window (`resolveCallbackDialTime`,
 * `scheduleCallbackInWindow`), which moves it to that day's window opening, or to the next
 * calling day's when the day has no window. Null without a promise or without follow-up days:
 * then nothing is booked and the contact goes where the entry and the retry policy send it.
 */
export function promiseFollowUpAt(
  entry: Pick<AgencyDisposition, 'requires_promise' | 'promise_follow_up_days'>,
  promise: ValidPromise | null,
  zone: string,
): Date | null {
  if (!promise) return null;
  const days = promiseFollowUpDays(entry);
  if (days === null) return null;
  return dayStartIn(zone, followUpDay(promise.day, days));
}

/** What the contact's promise columns take (`recordContactPromise`). */
export interface ContactPromiseWrite {
  date: string;
  amount: string | null;
  dueFrom: Date;
  dueUntil: Date;
  /** When the recording call started: orders promises across calls. */
  callAt: Date;
}

/**
 * The contact's copy of a promise (PT6): the day's bounds in the customer's zone, so the list
 * can tell upcoming, due today and missed apart by comparing instants. Null when the zone
 * cannot place the day (never for a zone `promiseZoneFor` chose, which falls back to UTC).
 */
export function contactPromiseWrite(promise: ValidPromise, zone: string, callAt: Date): ContactPromiseWrite | null {
  const dueFrom = dayStartIn(zone, promise.day);
  const dueUntil = dayStartIn(zone, addDays(promise.day, 1));
  if (!dueFrom || !dueUntil || dueUntil.getTime() <= dueFrom.getTime()) return null;
  return { date: promise.date, amount: promise.amount, dueFrom, dueUntil, callAt };
}
