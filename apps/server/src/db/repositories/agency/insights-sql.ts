/**
 * The campaign insights page's roster buckets (`AgencyInsightsRoster`, docs/insights.md): THE one
 * definition of where a contact stands "as of now", as SQL predicates over an `agency_contacts`
 * alias. The insights summary and allocation count with them, and the contacts list's drill-down
 * filters (`waiting=due_now|retry|callback`, `attempted=0|1`) filter with them through
 * `drilldown-sql.ts`'s `waitingContactSql` / `attemptedContactSql`, so a number on
 * the page and the list it opens cannot disagree (the single-definition rule `assignment-sql.ts`
 * follows for the owner's buckets).
 *
 * ── The partition ────────────────────────────────────────────────────────────
 * The ten predicates of {@link ROSTER_BUCKETS} are mutually exclusive and cover every row: the
 * summary's `contact_states_vs_total` reconciliation sums their counts against `count(*)` in the
 * same statement, so a gap or an overlap is a visible `ok: false`, never an assumption.
 *
 *  - Waiting = `pending` (every pending contact, whatever `suppressed_reason` says), split by
 *    `next_attempt_at` (the three sum to the pending count):
 *    - due now: `next_attempt_at <= now()`, a callback whose time has come included;
 *    - callback: `next_attempt_at > now()`, and the latest disposition booked a callback
 *      (`isCallbackSql`: a callback code AND that call is still the latest outcome);
 *    - retry: `next_attempt_at > now()` and not a callback (`COALESCE`d, so a connected contact
 *      with no write-up is a retry).
 *  - on a call = `in_flight`; in wrap-up = `connected`; `completed`; `exhausted`.
 *  - suppressed (`state = 'suppressed'`), by reason: `dnc`, `invalid`, and every other reason
 *    (`max_attempts`, `manual`, none: the contacts list's `suppressed_reason=max_attempts,manual,none`).
 *    A `pending` row frozen DNC before the claim refused them is waiting here, as it is in the
 *    contacts list's `state=pending` filter, and the allocation's `dnc` column counts
 *    {@link suppressedDncSql} too, never a bare `suppressed_reason = 'dnc'`.
 *
 * `attempted` (penetration's numerator) is `dials_placed > 0`: a contact we placed a dial to,
 * whoever's fault the call ended on (an our-fault redial charges `our_fault_attempts`, never
 * `attempt_count`) and while its first call is still ringing (`attempt_count` is charged when the
 * call settles). Decision IN6: attempts per contact count every placed dial.
 *
 * Every predicate reads only columns of `idx_agency_contacts_insights` (key `campaign_id, state`;
 * INCLUDE `next_attempt_at, suppressed_reason, attempt_count, dials_placed, last_outcome,
 * last_disposition, assigned_user_id`), so a count over them is an Index Only Scan.
 *
 * `now()` is the statement's (the transaction's) instant: every bucket of one statement is cut at
 * the same moment.
 */
import { isCallbackSql } from './assignment-sql.js';

/** The roster buckets, in the contract's order. */
export const ROSTER_BUCKETS = [
  'waiting_due_now',
  'waiting_retry',
  'waiting_callback',
  'on_call',
  'in_wrapup',
  'completed',
  'exhausted',
  'suppressed_dnc',
  'suppressed_invalid',
  'suppressed_other',
] as const;
export type RosterBucket = (typeof ROSTER_BUCKETS)[number];

/** Waiting, any of the three. Parenthesised. */
export function waitingSql(alias: string): string {
  return `(${alias}.state = 'pending')`;
}

/** Pending and due now (callbacks whose time has come included). Parenthesised. */
export function waitingDueNowSql(alias: string): string {
  return `(${alias}.state = 'pending' AND ${alias}.next_attempt_at <= now())`;
}

/** Pending, scheduled for later, and waiting on a booked callback. Parenthesised. */
export function waitingCallbackSql(alias: string, callbackCodesParam: string): string {
  return `(${alias}.state = 'pending' AND ${alias}.next_attempt_at > now() AND ${isCallbackSql(alias, callbackCodesParam)})`;
}

/** Pending, scheduled for later, and not a callback (a retry's delay). Parenthesised. */
export function waitingRetrySql(alias: string, callbackCodesParam: string): string {
  return `(${alias}.state = 'pending' AND ${alias}.next_attempt_at > now()
           AND NOT COALESCE(${isCallbackSql(alias, callbackCodesParam)}, false))`;
}

/** Any pending contact waiting on a callback, due or not (overdue, missed, due today). Parenthesised. */
export function pendingCallbackSql(alias: string, callbackCodesParam: string): string {
  return `(${alias}.state = 'pending' AND ${isCallbackSql(alias, callbackCodesParam)})`;
}

/** Suppressed for DNC. Parenthesised. */
export function suppressedDncSql(alias: string): string {
  return `(${alias}.state = 'suppressed' AND ${alias}.suppressed_reason = 'dnc')`;
}

/** Suppressed as an invalid number. Parenthesised. */
export function suppressedInvalidSql(alias: string): string {
  return `(${alias}.state = 'suppressed' AND ${alias}.suppressed_reason = 'invalid')`;
}

/** Suppressed for any other reason (`max_attempts`, `manual`, none). Parenthesised. */
export function suppressedOtherSql(alias: string): string {
  return `(${alias}.state = 'suppressed' AND ${alias}.suppressed_reason IS DISTINCT FROM 'dnc'
           AND ${alias}.suppressed_reason IS DISTINCT FROM 'invalid')`;
}

/** A dial was placed to the contact at least once (decision IN6). Parenthesised. */
export function attemptedSql(alias: string): string {
  return `(${alias}.dials_placed > 0)`;
}

/** Each bucket's predicate, for a statement that counts them all. */
export function rosterBucketPredicates(alias: string, callbackCodesParam: string): Record<RosterBucket, string> {
  return {
    waiting_due_now: waitingDueNowSql(alias),
    waiting_retry: waitingRetrySql(alias, callbackCodesParam),
    waiting_callback: waitingCallbackSql(alias, callbackCodesParam),
    on_call: `(${alias}.state = 'in_flight')`,
    in_wrapup: `(${alias}.state = 'connected')`,
    completed: `(${alias}.state = 'completed')`,
    exhausted: `(${alias}.state = 'exhausted')`,
    suppressed_dnc: suppressedDncSql(alias),
    suppressed_invalid: suppressedInvalidSql(alias),
    suppressed_other: suppressedOtherSql(alias),
  };
}
