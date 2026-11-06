/**
 * Dedicated caller IDs: a supervisor gives an agent one of the campaign's caller IDs, and every
 * dial to a contact that agent owns on that campaign goes out from it (decisions DN1–DN10,
 * `docs/decisions.md`). The routes live beside the contact-assignment routes, under
 * `/proxy/agency`, behind `agency.supervise`.
 *
 *  - `GET    /campaigns/:id/agent-caller-ids`                → {@link AgencyAgentCallerIds}
 *  - `PUT    /campaigns/:id/agents/:userId/caller-id`        body {@link AgencySetAgentCallerIdRequest}
 *                                                            → 200 {@link AgencyAgentCallerId}
 *  - `DELETE /campaigns/:id/agents/:userId/caller-id`        → 204 (also when none was set)
 *
 * The flag (DN9): only the PUT is behind `agency_contact_assignment_enabled` (403
 * `assignment_disabled` when it is off). The GET and the DELETE answer whatever the flag says,
 * because the dial paths honour a stored dedication whatever it says and the campaign PATCH
 * still refuses to drop a dedicated number: with the flag off a client lists the dedications
 * and offers release only (putting a setting back to its default is always allowed, CA9).
 *
 * Refusals are {@link AgencyAgentCallerIdErrorResponse}. The campaign PATCH refuses to drop a
 * dedicated number from `caller_ids` with `409 caller_id_dedicated`
 * (`details.caller_ids`: the dedicated numbers it would drop).
 */

/** One agent's dedicated number on a campaign. */
export interface AgencyAgentCallerId {
  campaign_id: string;
  /** The agent (`users.id`). */
  user_id: string;
  /** The agent's display name, or null when the user no longer resolves. */
  agent_name: string | null;
  /** One of the campaign's `caller_ids`, trimmed, as stored. */
  caller_id: string;
  /**
   * False when the number is no longer among the campaign's usable caller IDs (a direct DB
   * write): the dial path then uses the rotation, and the console flags the row.
   */
  in_campaign: boolean;
  set_at: string;
  /** The supervisor who set it; null when that user is gone. */
  set_by_user_id: string | null;
}

/** `GET /campaigns/:id/agent-caller-ids`. */
export interface AgencyAgentCallerIds {
  campaign_id: string;
  /** The campaign's usable caller IDs, in stored order. */
  caller_ids: string[];
  /** Every dedicated number on the campaign, by agent name then user id. */
  dedicated: AgencyAgentCallerId[];
  /**
   * The numbers that contacts without a dedicated owner number rotate over: `caller_ids` minus
   * every dedicated number, or all of `caller_ids` when every one is dedicated (DN3).
   */
  rotation: string[];
  /** True when every usable caller ID is dedicated, so the rotation shares them (DN3). */
  all_dedicated: boolean;
}

/** `PUT /campaigns/:id/agents/:userId/caller-id`. */
export interface AgencySetAgentCallerIdRequest {
  /** One of the campaign's caller IDs. Surrounding whitespace is ignored. */
  caller_id: string;
}

/** Refusals of the dedicated caller ID routes. */
export type AgencyAgentCallerIdErrorCode =
  /** 403, PUT only. The `agency_contact_assignment_enabled` flag is off for this tenant / account. */
  | 'assignment_disabled'
  /** 400. The body is malformed (`details` per field). */
  | 'caller_id_invalid'
  /** 404. No such campaign in the caller's tenant and account. */
  | 'campaign_not_found'
  /** 404. The agent has no active staffing row on the campaign (PUT only). */
  | 'agent_not_staffed'
  /** 409. The number is not one of the campaign's caller IDs (`details.caller_ids`). */
  | 'caller_id_not_in_campaign'
  /** 409. The number is dedicated to another agent on this campaign (`details.user_id`, `details.agent_name`). */
  | 'caller_id_taken';
export const AGENCY_AGENT_CALLER_ID_ERROR_CODES = [
  'assignment_disabled',
  'caller_id_invalid',
  'campaign_not_found',
  'agent_not_staffed',
  'caller_id_not_in_campaign',
  'caller_id_taken',
] as const;

/** A refusal body, as every agency refusal: a short title, the code, readable copy, details. */
export interface AgencyAgentCallerIdErrorResponse {
  error: string;
  code: AgencyAgentCallerIdErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

/** The campaign PATCH's refusal code when the new `caller_ids` would drop a dedicated number. */
export const AGENCY_CALLER_ID_DEDICATED_CODE = 'caller_id_dedicated' as const;

/** The audit actions (ids and the number only). */
export const AGENCY_AGENT_CALLER_ID_AUDIT_ACTIONS = {
  set: 'agency_campaign.agent_caller_id_set',
  cleared: 'agency_campaign.agent_caller_id_cleared',
} as const;

/** Why a dedicated number was released (`agency_campaign.agent_caller_id_cleared` `cause`). */
export type AgencyAgentCallerIdClearCause = 'supervisor' | 'unstaff';

type AllListed<U extends string, L extends readonly string[]> = [U] extends [L[number]]
  ? [L[number]] extends [U]
    ? true
    : never
  : never;
const _codesListed: AllListed<AgencyAgentCallerIdErrorCode, typeof AGENCY_AGENT_CALLER_ID_ERROR_CODES> = true;
void _codesListed;
