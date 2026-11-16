/**
 * Promise to pay (decisions PT1–PT14): an outcome that asks the agent for the date the
 * customer promised to pay, and optionally how much.
 *
 * A catalog entry opts in with `requires_promise` ({@link AgencyDisposition}); the agent's
 * submission then carries `promise_date` (required) and `promise_amount` (optional). The
 * promise is stored on the call it was recorded on (history keeps every one) and the contact
 * carries its latest one, which the Contacts list shows, filters and exports.
 *
 * **A promise never makes the dialler call by itself** (PT3). Only the entry's own
 * `promise_follow_up_days` books a follow-up, and it books it through the callback path
 * (calling hours, DNC, callback ownership and the assignment rules apply as to any callback).
 * Without it the contact goes wherever the entry's flags and the retry policy send it, exactly
 * as for any other outcome.
 *
 * There is no payment signal: nothing here knows whether the customer paid. `missed` means the
 * promised day ended with no later outcome recorded on the contact, never "unpaid" (PT7).
 *
 * Part of the dialer contract; `../agency.ts` is the barrel and carries the contract's header.
 */

/** The fewest and most days after the promised date a follow-up may be booked (PT2). */
export const AGENCY_PROMISE_FOLLOW_UP_DAYS_MIN = 1;
export const AGENCY_PROMISE_FOLLOW_UP_DAYS_MAX = 14;

/**
 * How far ahead a promised date may be, in days after the customer's today (PT4). A date
 * further out is refused as a typo (a year keyed as 2062) rather than stored as a promise
 * nobody will be around to check.
 */
export const AGENCY_PROMISE_MAX_DAYS_AHEAD = 30;

/**
 * The amount's bounds (PT5): at most this many digits before the decimal point and two after
 * it, never negative. Stored exactly (`NUMERIC(14, 2)`), and always a decimal STRING on the
 * wire so no client rounds it through a float.
 */
export const AGENCY_PROMISE_AMOUNT_MAX_INTEGER_DIGITS = 12;

/**
 * Where a contact's latest promise stands (PT7), judged in the customer's timezone (the
 * contact's, else the campaign's, as calling hours pick it):
 *  - `upcoming`: the promised day is still ahead;
 *  - `due_today`: it is the promised day;
 *  - `missed`: the promised day has ended and no outcome has been recorded on the contact by a
 *    call made after the promise and on or after that day. NOT "unpaid": there is no payment
 *    signal;
 *  - `followed_up`: the promised day has ended and such an outcome was recorded.
 */
export type AgencyPromiseState = 'upcoming' | 'due_today' | 'missed' | 'followed_up';

export const AGENCY_PROMISE_STATES = ['upcoming', 'due_today', 'missed', 'followed_up'] as const;

/** The words both web consoles and the app show for each state. */
export const AGENCY_PROMISE_STATE_LABELS = {
  upcoming: 'Upcoming',
  due_today: 'Due today',
  missed: 'Missed',
  followed_up: 'Followed up',
} as const;

/**
 * A contact's latest promise, as the Contacts list, the contact detail and the agent's panel
 * read it.
 */
export interface AgencyContactPromise {
  /** The promised payment date, `YYYY-MM-DD`, the customer's calendar date. */
  date: string;
  /** A decimal string with two places (`"12500.00"`), or null when no amount was given. */
  amount: string | null;
  state: AgencyPromiseState;
}

/**
 * The `?promise=` filter of the Contacts list (repeated or comma-separated, ORed): `any`
 * (every contact holding a promise) or one of the states.
 */
export type AgencyPromiseFilter = 'any' | AgencyPromiseState;

export const AGENCY_PROMISE_FILTERS = ['any', 'upcoming', 'due_today', 'missed', 'followed_up'] as const;
