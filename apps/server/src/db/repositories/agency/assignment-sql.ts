/**
 * Contact assignment: THE one definition of where a contact stands for its owner (its
 * {@link AgencyMyContactBucket}) and of whether its agent may retry it now. The agent's list and
 * counts (`GET /my-contacts*`), the supervisor's progress per agent, the "Retry not reached (N)"
 * count, the reopen and the per-contact call all read these fragments, so they cannot disagree
 * (the same single-definition rule as `contactFilterConditions`).
 *
 * Every fragment takes the alias of an `agency_contacts` row and the positional parameters it
 * needs, bound by the caller through `params()` (`query-builders.ts`).
 */
import type { AgencyDisposition } from '@magick-agency/contracts/agency';

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
 * The bucket of contact `c` (contract: `AgencyMyContactBucket`), as a SQL `CASE` yielding text.
 *
 *  - `in_progress`: `in_flight` / `connected`;
 *  - `reached` / `exhausted` / `suppressed`: the terminal states;
 *  - `callback`: open (`pending`) and its last disposition booked a callback;
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
    WHEN ${c}.state IN ('in_flight', 'connected') THEN 'in_progress'
    WHEN ${c}.state = 'completed' THEN 'reached'
    WHEN ${c}.state = 'exhausted' THEN 'exhausted'
    WHEN ${c}.state = 'suppressed' OR ${c}.suppressed_reason = 'dnc' THEN 'suppressed'
    WHEN ${c}.last_disposition = ANY(${callbackCodesParam}::text[]) THEN 'callback'
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
 * not connect and that is not a callback (`not_reached` in {@link contactBucketSql}).
 *
 * In order: the campaign must allow it (`retry_disabled`); a suppressed or DNC row never
 * (`suppressed`); it must be not reached (`not_retryable`); a round must be left
 * (`rounds_used`); and the cooldown since its last attempt must have passed (`cooldown`),
 * unless an outcome granted it a retry-delay override.
 */
export function agentRetryBlockSql(alias: string, p: AgentRetrySettingsParams): string {
  const c = alias;
  return `(CASE
    WHEN NOT ${p.allowed}::boolean THEN 'retry_disabled'
    WHEN ${c}.state = 'suppressed' OR ${c}.suppressed_reason = 'dnc' THEN 'suppressed'
    WHEN NOT (
      ${c}.state = 'exhausted'
      OR (${c}.state = 'pending' AND ${c}.attempt_count > 0
          AND ${c}.last_outcome IS DISTINCT FROM 'connected'
          AND NOT COALESCE(${c}.last_disposition = ANY(${p.callbackCodes}::text[]), false))
    ) THEN 'not_retryable'
    WHEN ${c}.agent_retry_rounds_used >= ${p.rounds}::int THEN 'rounds_used'
    WHEN NOT ${c}.override_retry_delay
         AND ${lastAttemptAtSql(c)} > now() - make_interval(mins => ${p.cooldownMinutes}::int) THEN 'cooldown'
    ELSE NULL
  END)`;
}

/** When the cooldown on contact `c` ends: last attempt + cooldown (NULL if never attempted). */
export function agentRetryAvailableAtSql(alias: string, cooldownMinutesParam: string): string {
  return `(${lastAttemptAtSql(alias)} + make_interval(mins => ${cooldownMinutesParam}::int))`;
}
