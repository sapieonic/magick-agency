/**
 * The soft-phone runtime's refusals and actor (docs/softphone.md §4, §6): what
 * `AgencyRuntime.softphone` answers instead of throwing.
 *
 * **Every refusal's `code` is an `AgencySoftphoneErrorCode`** (pinned below at
 * compile time), and its other fields are already the WIRE names of the refusal
 * body that code is narrowed to (`AgencySoftphoneDncListedRefusal`,
 * `AgencySoftphoneOutsideHoursRefusal`, …), so the public API layer answers
 * `{ error, message, ...refusal }` with the HTTP status the contract names beside
 * the code (`errors.ts`). No HTTP here, and no RBAC: the API layer vouches for the
 * actor's flags as it does for `on_behalf`.
 */
import type {
  AgencyCallingWindow,
  AgencyManualCall,
  AgencySoftphoneDncListedRefusal,
  AgencySoftphoneErrorCode,
} from '@magick-agency/contracts/agency';
import type { CallFieldIssue } from './call-fields.js';

/** Who is acting, and where, as the public API layer resolved and vouched for it. */
export interface SoftphoneActor {
  /** The request's tenant and account: every session and call is scoped to both. */
  tenantId: string;
  accountId: string;
  /** The authenticated user (`agent_user_id`). */
  userId: string;
  /**
   * The API layer has checked `agency.supervise`. On a call, it lets the actor act
   * on another agent's call (`on_behalf`); on `placeCall`, it lets them tag any
   * campaign of the account rather than only the ones they are staffed on.
   */
  supervise: boolean;
}

/** The refusal a soft-phone operation answers, by code. */
export type SoftphoneRefusal =
  | { code: 'session_not_found' }
  | { code: 'wrong_session_kind' }
  | { code: 'not_on_softphone' }
  | { code: 'invalid_number' }
  | { code: 'caller_id_not_allowed'; allowed_codes: string[] }
  | { code: 'campaign_not_taggable' }
  | { code: 'override_note_invalid'; details: CallFieldIssue[] }
  | { code: 'fields_invalid'; details: CallFieldIssue[] }
  | { code: 'contact_in_flight'; campaign_id: string; contact_id: string }
  | {
    code: 'outside_calling_hours';
    window: AgencyCallingWindow;
    timezone_source: 'contact' | 'campaign_default';
    next_open_at: string | null;
  }
  | { code: 'dnc_listed'; entry: AgencySoftphoneDncListedRefusal['entry'] }
  | { code: 'dnc_unavailable' }
  | { code: 'manual_call_live'; call: AgencyManualCall }
  | { code: 'outcome_pending'; call: AgencyManualCall }
  | { code: 'concurrency_limit' }
  | { code: 'station_unavailable' }
  | { code: 'call_not_found' }
  | { code: 'call_settled'; call: AgencyManualCall }
  | {
    code: 'disposition_invalid';
    /** Which rule refused: the code is not in the catalog, or its note / callback is missing or invalid. */
    reason: 'unknown_code' | 'note_required' | 'datetime_required' | 'invalid_callback_at';
    /** `unknown_code`: the codes the call's catalog accepts. */
    allowed_codes?: string[];
  };

// Every refusal code is a contract code (the reverse is not required: the API
// layer owns `softphone_disabled`, `session_on_campaign`, `session_on_softphone`
// and `settings_invalid`).
type _UnlistedRefusal = Exclude<SoftphoneRefusal['code'], AgencySoftphoneErrorCode>;
const _everyRefusalIsAContractCode: _UnlistedRefusal extends never ? true : _UnlistedRefusal = true;
void _everyRefusalIsAContractCode;

/** An operation's answer. */
export type SoftphoneResult<T> = ({ ok: true } & T) | { ok: false; refusal: SoftphoneRefusal };

/** The floor copy for each refusal — the `message` a client that does not know the code can show. */
export function softphoneRefusalMessage(refusal: SoftphoneRefusal): string {
  switch (refusal.code) {
    case 'session_not_found': return 'That session is not your live session.';
    case 'wrong_session_kind': return 'This action is not available on this kind of session.';
    case 'not_on_softphone': return 'Switch to the soft phone before dialling.';
    case 'invalid_number': return 'That is not a dialable phone number.';
    case 'caller_id_not_allowed': return 'That caller ID is not allowed for this call.';
    case 'campaign_not_taggable': return 'You cannot log a call to that campaign.';
    case 'override_note_invalid': return 'An override note must be 10 to 500 characters.';
    case 'fields_invalid': return 'Some call details are invalid.';
    case 'contact_in_flight': return 'A campaign call to this contact is in progress.';
    case 'outside_calling_hours': return 'The campaign\'s calling hours are closed for this number.';
    case 'dnc_listed': return 'This number is on the Do Not Call list.';
    case 'dnc_unavailable': return 'The Do Not Call list could not be checked. Try again shortly.';
    case 'manual_call_live': return 'You have a soft-phone call in progress or awaiting its outcome.';
    case 'outcome_pending': return 'Save the outcome of your last call before dialling again.';
    case 'concurrency_limit': return 'All lines are busy. Try again shortly.';
    case 'station_unavailable': return 'Your station is not connected.';
    case 'call_not_found': return 'Call not found.';
    case 'call_settled': return 'This call\'s outcome is already saved or has lapsed.';
    case 'disposition_invalid': return 'That outcome cannot be saved as submitted.';
    default: return 'The request was refused.';
  }
}
