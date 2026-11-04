/**
 * The campaign insights page's roster buckets (`AgencyInsightsRoster`, docs/insights.md): THE one
 * definition of where a contact stands "as of now", as SQL predicates over an `agency_contacts`
 * alias. The insights summary counts with them, and the contacts list's drill-down filters
 * (`waiting=due_now|retry|callback`, `attempted=0|1`) are meant to filter with them, so a number on
 * the page and the list it opens cannot disagree (the single-definition rule `assignment-sql.ts`
 * follows for the owner's buckets).
 *
 * ── The partition ────────────────────────────────────────────────────────────
 * The ten predicates of {@link ROSTER_BUCKETS} are mutually exclusive and cover every row: the
 * summary's `contact_states_vs_total` reconciliation sums their counts against `count(*)` in the
 * same statement, so a gap or an overlap is a visible `ok: false`, never an assumption.
 *
 *  - Waiting = open (`openContactSql`: `pending` and not DNC-suppressed, a contact something will
 *    still dial), split by `next_attempt_at`:
 *    - due now: `next_attempt_at <= now()`, a callback whose time has come included. The same
 *      "due now" as the supervisor's progress read (`assignment-reads.repository.ts`), so the
 *      roster's due-now count and the allocation table's agree;
 *    - callback: in the future, and the latest disposition booked a callback (`isCallbackSql`:
 *      a callback code AND that call is still the latest outcome);
 *    - retry: in the future and not a callback.
 *  - on a call = `in_flight`; in wrap-up = `connected`; `completed`; `exhausted`.
 *  - suppressed, by reason: `dnc` (a `suppressed` row, or a `pending` row DNC-frozen before the
 *    fix the claim refuses, which is not open), `invalid`, and every other reason
 *    (`max_attempts`, `manual`, none).
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
import { isCallbackSql, openContactSql } from './assignment-sql.js';

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

/** Open and due now (callbacks whose time has come included). Parenthesised. */
export function waitingDueNowSql(alias: string): string {
  return `(${openContactSql(alias)} AND ${alias}.next_attempt_at <= now())`;
}

/** Open, scheduled for later, and waiting on a booked callback. Parenthesised. */
export function waitingCallbackSql(alias: string, callbackCodesParam: string): string {
  return `(${openContactSql(alias)} AND ${alias}.next_attempt_at > now() AND ${isCallbackSql(alias, callbackCodesParam)})`;
}

/** Open, scheduled for later, and not a callback (a retry's delay). Parenthesised. */
export function waitingRetrySql(alias: string, callbackCodesParam: string): string {
  return `(${openContactSql(alias)} AND ${alias}.next_attempt_at > now()
           AND NOT COALESCE(${isCallbackSql(alias, callbackCodesParam)}, false))`;
}

/** Any open contact that is waiting on a callback, due or not. Parenthesised. */
export function openCallbackSql(alias: string, callbackCodesParam: string): string {
  return `(${openContactSql(alias)} AND ${isCallbackSql(alias, callbackCodesParam)})`;
}

/** DNC: suppressed for it, or a `pending` row frozen DNC (not open). Parenthesised. */
export function suppressedDncSql(alias: string): string {
  return `(${alias}.state IN ('suppressed', 'pending') AND ${alias}.suppressed_reason = 'dnc')`;
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
