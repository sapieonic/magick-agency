/**
 * Contact assignment: THE one definition of where a contact stands for its owner (its
 * {@link AgencyMyContactBucket}) and of whether its agent may retry it now. The agent's list and
 * counts (`GET /my-contacts*`), the supervisor's progress per agent, the "Retry not reached (N)"
 * count, the reopen and the per-contact call all read these fragments, so they cannot disagree
 * (the same single-definition rule as `contactFilterConditions`).
 *
 * Every fragment takes the alias of an `agency_contacts` row and the positional parameters it
 * needs, bound by the caller through `params()` (`query-builders.ts`). The terms the claims and
 * the assignment writes share (open, the number's busy probe, the return to the pool) are here
 * for the same reason.
 */
import type { AgencyAssignmentReason, AgencyDisposition } from '@magick-agency/contracts/agency';
import type { AgencyCampaignRecord } from '../../models/agency.model.js';
import type { params } from './query-builders.js';
import { contactPhoneDigitsSql } from './sql-fragments.js';

/** The states of a contact on a call or held for its write-up, as an `IN` list. */
export const LIVE_STATES_SQL = `('in_flight', 'connected')`;

/**
 * Whether contact `c` is open (CA2): `pending` and not DNC-suppressed, a contact something will
 * still dial. `IS DISTINCT FROM`, never `<> 'dnc'`: the column is NULL for almost every row.
 * Unparenthesised: wrap it inside an `OR`.
 */
export function openContactSql(alias: string): string {
  return `${alias}.state = 'pending' AND ${alias}.suppressed_reason IS DISTINCT FROM 'dnc'`;
}

/**
 * Whether agent session `s` is present on its campaign: joined (`left_at IS NULL`) and not
 * `offline`. A station that closed writes its row `offline` (`releaseStationOnClose`), and so do
 * the startup reaper and a dead media worker's reap, while the session stays joined until the
 * agent leaves. An agent on break or in a call is present; one whose station is gone is not.
 * The ONE rule the callback fallback (CA5) and the supervisor's progress (`live`,
 * `due_while_absent`) read, so the two never disagree about the same agent. Parenthesised.
 */
export function presentSessionSql(alias: string): string {
  return `(${alias}.left_at IS NULL AND ${alias}.state <> 'offline')`;
}

/**
 * Whether contact `c`'s number is live on its campaign: some contact of `campaignSql` (a
 * parameter or a column) on the same digits (`CONTACT_PHONE_DIGITS_SQL`, one
 * `idx_agency_contacts_campaign_phone_digits` probe) is `in_flight` or `connected`, `c` itself
 * included. Every claim refuses a contact whose number is live (`NOT` this), so one number never
 * carries two calls at once (`claimDialable`).
 */
export function numberLiveSql(alias: string, campaignSql: string): string {
  return `EXISTS (
              SELECT 1 FROM agency_contacts live
               WHERE live.campaign_id = ${campaignSql}
                 AND ${contactPhoneDigitsSql('live')} = ${contactPhoneDigitsSql(alias)}
                 AND live.state IN ${LIVE_STATES_SQL})`;
}

/**
 * The codes in a campaign's catalog that book a callback (`requires_datetime`). A contact whose
 * last disposition is one of them, and still open, is a callback, and in strict / preferred mode
 * it stays with its owner. Defensive on shape, as `resolveDisposition` is.
 */
export function callbackCodes(catalog: readonly AgencyDisposition[] | null | undefined): string[] {
  if (!Array.isArray(catalog)) return [];
  return catalog
    .filter((d) => !!d && typeof d === 'object' && typeof d.code === 'string' && d.requires_datetime === true)
    .map((d) => d.code);
}

/**
 * Whether contact `c` is waiting on a callback: its last disposition booked one AND that call is
 * still its latest outcome (`last_outcome = 'connected'`). The disposition column keeps its last
 * value across later settlements that carry none (`COALESCE(new, old)`), so without the second
 * half a callback that was dialled and NOT answered would read as a callback for ever: kept from
 * the agent's retry, swept by the callback fallback, and told to the station as
 * `callbacks_later`. Once a later call settles not-connected, it is not reached like any other.
 */
export function isCallbackSql(alias: string, callbackCodesParam: string): string {
  return `(${alias}.last_disposition = ANY(${callbackCodesParam}::text[]) AND ${alias}.last_outcome IS NOT DISTINCT FROM 'connected')`;
}

/**
 * The bucket of contact `c` (contract: `AgencyMyContactBucket`), as a SQL `CASE` yielding text.
 *
 *  - `in_progress`: `in_flight` / `connected`;
 *  - `reached` / `exhausted` / `suppressed`: the terminal states;
 *  - `callback`: open (`pending`) and waiting on a callback ({@link isCallbackSql});
 *  - `not_reached`: open, attempted, and its last call did not connect;
 *  - `pending`: open otherwise (never attempted, or rescheduled after a conversation).
 *
 * A DNC-suppressed `pending` row (a pre-fix leftover the claim refuses) is `suppressed`.
 *
 * @param callbackCodesParam a `text[]` parameter holding {@link callbackCodes}.
 */
export function contactBucketSql(alias: string, callbackCodesParam: string): string {
  const c = alias;
  return `(CASE
    WHEN ${c}.state IN ${LIVE_STATES_SQL} THEN 'in_progress'
    WHEN ${c}.state = 'completed' THEN 'reached'
    WHEN ${c}.state = 'exhausted' THEN 'exhausted'
    WHEN ${c}.state = 'suppressed' OR ${c}.suppressed_reason = 'dnc' THEN 'suppressed'
    WHEN ${isCallbackSql(c, callbackCodesParam)} THEN 'callback'
    WHEN ${c}.attempt_count > 0 AND ${c}.last_outcome IS DISTINCT FROM 'connected' THEN 'not_reached'
    ELSE 'pending'
  END)`;
}

/**
 * The latest attempt on contact `c` (any campaign attempt, paced, redialled or agent-dialled),
 * or NULL. One probe of `uq_agency_attempt_number`'s `contact_id` prefix.
 */
export function lastAttemptAtSql(alias: string): string {
  return `(SELECT max(a.created_at) FROM agency_call_attempts a WHERE a.contact_id = ${alias}.id)`;
}

/** The campaign settings the retry rule reads ({@link agentRetryBlockSql}). */
export interface AgentRetrySettings {
  allowed: boolean;
  rounds: number;
  cooldownMinutes: number;
  /** `callbackCodes(campaign.disposition_catalog)`. */
  callbackCodes: string[];
}

/** The retry settings {@link agentRetryBlockSql} reads, from the campaign row. */
export function agentRetrySettingsOf(campaign: AgencyCampaignRecord): AgentRetrySettings {
  return {
    allowed: campaign.allow_agent_retry === true,
    rounds: campaign.agent_retry_rounds,
    cooldownMinutes: campaign.agent_retry_cooldown_minutes,
    callbackCodes: callbackCodes(campaign.disposition_catalog),
  };
}

/** Bind the four settings parameters {@link agentRetryBlockSql} reads. */
export function bindAgentRetrySettings(p: ReturnType<typeof params>, s: AgentRetrySettings): AgentRetrySettingsParams {
  return {
    allowed: p.add(s.allowed),
    rounds: p.add(s.rounds),
    cooldownMinutes: p.add(s.cooldownMinutes),
    callbackCodes: p.add(s.callbackCodes),
  };
}

/** The settings the retry rule reads, bound as parameters. */
export interface AgentRetrySettingsParams {
  /** `boolean`: the campaign's `allow_agent_retry`. */
  allowed: string;
  /** `int`: the campaign's `agent_retry_rounds`. */
  rounds: string;
  /** `int`: the campaign's `agent_retry_cooldown_minutes`. */
  cooldownMinutes: string;
  /** `text[]`: {@link callbackCodes}. */
  callbackCodes: string;
}

/**
 * Why contact `c` cannot be retried by its agent now (contract: `AgencyAgentRetryBlock`), or
 * NULL when it can. "Not reached" is an `exhausted` contact, or an open one whose last call did
 * not connect and that is not a callback (`not_reached` in {@link contactBucketSql}), scheduled
 * for LATER: an open one already due now is in the queue as it is, so retrying it would change
 * nothing but spend a round (and two concurrent reopens would spend two).
 *
 * In order: the campaign must allow it (`retry_disabled`); a suppressed or DNC row never
 * (`suppressed`); it must be not reached (`not_retryable`); a round must be left
 * (`rounds_used`); and the cooldown since its last attempt must have passed (`cooldown`),
 * unless an outcome granted it a retry-delay override.
 *
 * @param lastAttemptAt the contact's latest attempt time; defaults to {@link lastAttemptAtSql}.
 *   A read that already has it (a lateral join) passes it so it is computed once per row.
 */
export function agentRetryBlockSql(
  alias: string,
  p: AgentRetrySettingsParams,
  lastAttemptAt: string = lastAttemptAtSql(alias),
): string {
  const c = alias;
  return `(CASE
    WHEN NOT ${p.allowed}::boolean THEN 'retry_disabled'
    WHEN ${c}.state = 'suppressed' OR ${c}.suppressed_reason = 'dnc' THEN 'suppressed'
    WHEN NOT (
      ${c}.state = 'exhausted'
      OR (${c}.state = 'pending' AND ${c}.attempt_count > 0
          AND ${c}.last_outcome IS DISTINCT FROM 'connected'
          AND NOT COALESCE(${isCallbackSql(c, p.callbackCodes)}, false)
          -- statement_timestamp(), not now(): now() is the TRANSACTION's start, and a reopen
          -- that began before a concurrent one committed (its next_attempt_at = that one's
          -- now()) would read the freshly reopened contact as scheduled for later.
          AND ${c}.next_attempt_at > statement_timestamp())
    ) THEN 'not_retryable'
    WHEN ${c}.agent_retry_rounds_used >= ${p.rounds}::int THEN 'rounds_used'
    WHEN NOT ${c}.override_retry_delay AND ${agentRetryCoolingSql(c, p.cooldownMinutes, lastAttemptAt)} THEN 'cooldown'
    ELSE NULL
  END)`;
}

/**
 * Whether contact `c`'s agent-retry cooldown is still running: its last attempt is more
 * recent than `cooldownMinutesParam` minutes (`int`). NULL-safe: a contact never attempted
 * is not cooling. {@link agentRetryBlockSql} blocks on it unless a retry-delay override is
 * held; a retry that goes ahead while it runs spends that override (the reopen and the
 * agent's own dial read this to know). `lastAttemptAt` as in {@link agentRetryBlockSql}.
 */
export function agentRetryCoolingSql(
  alias: string,
  cooldownMinutesParam: string,
  lastAttemptAt: string = lastAttemptAtSql(alias),
): string {
  return `COALESCE(${lastAttemptAt} > now() - make_interval(mins => ${cooldownMinutesParam}::int), false)`;
}

/**
 * When the cooldown on contact `c` ends: last attempt + cooldown (NULL if never attempted).
 * `lastAttemptAt` as in {@link agentRetryBlockSql}.
 */
export function agentRetryAvailableAtSql(
  alias: string,
  cooldownMinutesParam: string,
  lastAttemptAt: string = lastAttemptAtSql(alias),
): string {
  return `(${lastAttemptAt} + make_interval(mins => ${cooldownMinutesParam}::int))`;
}

/**
 * The tail shared by the sweeps that hand owned contacts back to the pool (the unstaff
 * catch-up, the callback fallback): after the caller's `due(id, assigned_user_id)` CTE (its
 * pick, `pending` rows locked `FOR UPDATE … SKIP LOCKED`), `moved` clears the owner of each row
 * still `pending` and still held by that owner, and every move writes its
 * `agency_contact_assignment_events` row (`reason`, actor NULL: the system, under the
 * `batchIdParam` batch). One statement, so a move without its history row cannot exist.
 * Returns `(contact_id, from_user_id)` per move.
 */
export function returnToPoolSql(reason: AgencyAssignmentReason, batchIdParam: string): string {
  return `moved AS (
         UPDATE agency_contacts c
            SET assigned_user_id = NULL, assigned_at = NULL, assigned_by_user_id = NULL, updated_at = now()
           FROM due
          WHERE c.id = due.id AND c.state = 'pending' AND c.assigned_user_id = due.assigned_user_id
         RETURNING c.id, c.tenant_id, c.campaign_id, due.assigned_user_id AS from_user_id
       )
       INSERT INTO agency_contact_assignment_events
         (tenant_id, campaign_id, contact_id, from_user_id, to_user_id, actor_user_id, reason, batch_id)
       SELECT tenant_id, campaign_id, id, from_user_id, NULL, NULL, '${reason}', ${batchIdParam}::uuid FROM moved
       RETURNING contact_id, from_user_id`;
}
