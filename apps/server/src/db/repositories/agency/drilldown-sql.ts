/**
 * The drill-down predicates: THE one definition of each roster bucket and each attempt slice
 * that the campaign insights page counts and the Contacts / Call attempts lists filter on.
 *
 * Every number on the Insights tab opens a list, and the list's total must equal the number
 * that was clicked (docs/insights.md, WS F). That holds only if the count and the list read
 * the same predicate, so both import it from here: the lists (`listForCampaign` /
 * `countListed` on the contact and attempt repositories) and the insights reads. A second
 * spelling of "due now" is how the two drift, the same single-definition rule as
 * `contactFilterConditions` and `assignment-sql.ts`.
 *
 * A leaf: SQL text over a caller's alias and the positional parameters the caller bound with
 * `params()` (`query-builders.ts`). Nothing here binds a value itself except where the
 * fragment needs one that is not the caller's (none today), so a fragment can sit inside any
 * statement, including a `count(*) FILTER (WHERE …)`.
 *
 * ── Index use, on a 1M-contact campaign ─────────────────────────────────────
 * Every contact fragment reads only columns that `idx_agency_contacts_insights`
 * (`(campaign_id, state) INCLUDE (next_attempt_at, suppressed_reason, attempt_count,
 * dials_placed, last_outcome, last_disposition, assigned_user_id)`, migration 0011) carries,
 * and the waiting buckets pin `state = 'pending'`, so a count over one campaign is a range
 * scan of that index's `(campaign_id, 'pending')` prefix and never touches a row the bucket
 * cannot hold. The dialled-range fragment is shaped for `idx_agency_attempts_campaign_dialed
 * (campaign_id, dialed_at) WHERE dialed_at IS NOT NULL`: it states `dialed_at IS NOT NULL`
 * literally, so the partial index's predicate is implied without the planner having to prove
 * it. Plans: `test/integration/agency/agency-drilldown-filters.test.ts`.
 */
import type { AgencyContactWaiting } from '@magick-agency/contracts/api/agency/agency-spine';
import { attemptedSql, waitingCallbackSql, waitingDueNowSql, waitingRetrySql } from './insights-sql.js';

// ─── Contacts ───────────────────────────────────────────────────────────────

/** The waiting buckets of the insights roster (`AgencyInsightsRoster.waiting_*`), `?waiting=`. */
export type ContactWaitingBucket = AgencyContactWaiting;

/**
 * Whether contact `alias` is in waiting bucket `bucket`, as of `now()` (the statement's
 * transaction start, so every bucket in one statement is cut at one instant).
 *
 * Delegates to the roster predicates of `insights-sql.ts`, which the insights summary and
 * allocation count with. The three buckets PARTITION the pending contacts, so `waiting_due_now + waiting_retry +
 * waiting_callback` is the pending count and the roster's reconciliation holds:
 *
 *  - `due_now`:  pending ∧ `next_attempt_at <= now()`. Every pending contact the dialler may
 *    take now, a callback whose time has come included (it is due; pacing dials it). The same
 *    "due now" as the assignment reads (`assignment-reads.repository.ts`).
 *  - `callback`: pending ∧ `next_attempt_at > now()` ∧ waiting on a callback
 *    (`isCallbackSql` in `assignment-sql.ts`: the latest disposition booked one and that call is still the
 *    latest outcome). A callback booked for later.
 *  - `retry`:    pending ∧ `next_attempt_at > now()` ∧ NOT waiting on a callback. Scheduled
 *    for a later retry.
 *
 * `isCallbackSql` is NULL when `last_disposition` is NULL, so retry COALESCEs it: under `NOT` a
 * NULL would reject every contact that was never written up, which is most of the retry
 * bucket (the NULL trap `neverSeededSuppressionSql` documents).
 *
 * @param callbackCodesParam a `text[]` parameter holding `callbackCodes(campaign.
 *   disposition_catalog)`. Required for `retry` and `callback`; `due_now` does not read it.
 */
export function waitingContactSql(
  bucket: ContactWaitingBucket,
  alias: string,
  callbackCodesParam?: string,
): string {
  // The roster's own predicates (`insights-sql.ts`): the list filter and the insights count are
  // one definition, so a number on the page and the list it opens cannot disagree.
  if (bucket === 'due_now') return waitingDueNowSql(alias);
  if (!callbackCodesParam) {
    throw new Error(`waitingContactSql(${bucket}) needs the campaign's callback codes`);
  }
  return bucket === 'callback'
    ? waitingCallbackSql(alias, callbackCodesParam)
    : waitingRetrySql(alias, callbackCodesParam);
}

/**
 * Whether contact `alias` was attempted: at least one dial PLACED on it.
 *
 * `attempted` ⇔ `dials_placed > 0`. `dials_placed` counts every attempt row with `dialed_at`
 * set (wrap-up and our-fault redials included, IN6), kept by the two triggers migration 0011
 * added, so no writer can forget it. Not `attempt_count`: that is the customer's retry
 * allowance, which an our-fault failure does not spend and a reaper requeue does not bump, so
 * it undercounts the contacts somebody dialled. An attempt row that never left the building
 * (queued, then orphaned) does not make a contact attempted.
 */
export function attemptedContactSql(attempted: boolean, alias: string): string {
  return attempted ? attemptedSql(alias) : `(${alias}.dials_placed = 0)`;
}

// ─── Call attempts ──────────────────────────────────────────────────────────

/** A placed dial: the attempt's `dialed_at` is set (the definition 0011's counter uses). */
export function placedDialSql(alias: string): string {
  return `${alias}.dialed_at IS NOT NULL`;
}

/**
 * Placed dials whose `dialed_at` is in the half-open window `[from, to)`, either bound
 * optional. The insights range convention (`AgencyInsightsRange`: inclusive `from`, exclusive
 * `to`), so consecutive windows tile and every dial is counted once.
 *
 * NOT the attempt list's `from`/`to`, which are INCLUSIVE and bound `created_at` so an attempt
 * that never dialled still shows on the day it was queued (`attemptFilterConditions`). Both
 * conventions exist on purpose; this one is for counting dials.
 */
export function dialedRangeSql(alias: string, fromParam?: string, toParam?: string): string {
  const parts = [placedDialSql(alias)];
  if (fromParam) parts.push(`${alias}.dialed_at >= ${fromParam}::timestamptz`);
  if (toParam) parts.push(`${alias}.dialed_at < ${toParam}::timestamptz`);
  return `(${parts.join(' AND ')})`;
}

/**
 * A wrap-up redial: `redial_number > 0`. Not `redial_of_attempt_id IS NOT NULL`: that link is
 * `ON DELETE SET NULL`, so a redial whose original was purged loses it and keeps its number
 * (`ck_agency_attempt_redial_link`, migration 0008).
 */
export function redialAttemptSql(redial: boolean, alias: string): string {
  return redial ? `${alias}.redial_number > 0` : `${alias}.redial_number = 0`;
}

/** An agent dialled it from their own contact list (`agent_manual`, migration 0009). */
export function agentManualAttemptSql(manual: boolean, alias: string): string {
  return manual ? `${alias}.agent_manual` : `NOT ${alias}.agent_manual`;
}

/** It came from an agent-led reopen placed through pacing (`agent_reopened`, migration 0011). */
export function agentReopenedAttemptSql(reopened: boolean, alias: string): string {
  return reopened ? `${alias}.agent_reopened` : `NOT ${alias}.agent_reopened`;
}

/**
 * Attempts placed for agent USER `userParam` on campaign `campaignParam`: the attempt's
 * `reserved_agent_id` is one of that person's sessions on the campaign
 * (`agency_agent_sessions.agent_user_id`). Sessions are per shift, so the set is a handful of
 * ids, collected once by `ARRAY(…)` rather than joined per row.
 *
 * ── A subquery on `reserved_agent_id`, NOT `s.agent_user_id = $n` on a joined session ──
 * Both are correct; they plan very differently. Filtering on the joined column makes the
 * agent's identity a join condition, and the planner materialises the whole session table per
 * outer row: measured 6.3ms against 3.7ms for this form on a 1M-attempt campaign, and 590ms
 * against 343ms with no match. Campaign-scoped as well as agent-scoped, so an agent who has
 * worked several campaigns matches only their sessions on this one.
 */
export function attemptAgentUserSql(alias: string, campaignParam: string, userParam: string): string {
  return `${alias}.reserved_agent_id = ANY(ARRAY(
           SELECT id FROM agency_agent_sessions
            WHERE campaign_id = ${campaignParam}::uuid AND agent_user_id = ${userParam}::uuid))`;
}
