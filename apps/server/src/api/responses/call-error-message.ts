import {
  CARRIER_AUTH_REJECTED,
  CARRIER_DIAL_INVALID_NUMBER_ERROR_CODE,
  CARRIER_DIAL_NOT_SENT_ERROR_CODE,
  CARRIER_RATE_LIMITED,
  CREDENTIAL_UNAVAILABLE,
} from '../../core/bridge/dial-refusals.js';
import { DIAL_OUTCOME_UNKNOWN_ERROR_CODE } from '../../telephony/carrier-errors.js';

/**
 * What a tenant is told about a failed call, from the row's `error_code` alone.
 *
 * The call row's `error_message` holds the raw text of whatever failed (a carrier's response
 * body, an env variable's name, an adapter's own wording): the record an operator debugs
 * from, kept in the row and the logs. It is never sent to a tenant: it can name the carrier
 * (a vendor the console never names), carry the carrier's JSON, or name the server's
 * configuration. The tenant-facing call responses (`formatWebRtcCallResponse`) send this
 * sentence instead: British English, vendor-free, and saying what the supervisor can do.
 * The super-admin surfaces may keep the raw text.
 *
 * Keyed by the constants the codes are written from where one exists, so a renamed code
 * cannot leave its sentence behind.
 */
const MESSAGES: Readonly<Record<string, string>> = {
  TELEPHONY_INIT_FAILED: 'The carrier refused the call.',
  [DIAL_OUTCOME_UNKNOWN_ERROR_CODE]: 'The carrier did not confirm the call, so it may still have rung the customer.',
  TELEPHONY_ERROR: 'The carrier ended the call with an error.',
  [CARRIER_DIAL_NOT_SENT_ERROR_CODE]: 'The call was not placed: the carrier account could not be reached or is not set up to place calls. Contact support if it keeps happening.',
  [CARRIER_DIAL_INVALID_NUMBER_ERROR_CODE]: 'The call was not placed: the number is not one the carrier can dial.',
  [CARRIER_RATE_LIMITED.errorCode]: 'The call was not placed: the carrier account’s limit on new calls a second was reached.',
  [CARRIER_AUTH_REJECTED.errorCode]: 'The call was not placed: the carrier refused this account’s credentials. Contact support to have them checked.',
  [CREDENTIAL_UNAVAILABLE.errorCode]: 'The call was not placed: this carrier account is no longer active. Contact support to have it re-enabled.',
  BRIDGE_SETUP_FAILED: 'The call could not be set up. Please try again.',
  UNSUPPORTED_MEDIA_FORMAT: 'The carrier sent audio in a format the platform cannot play, so the call was ended.',
  STUCK_ACTIVE_CALL: 'The call was closed by the platform after it stopped reporting progress.',
};

/** The sentence for an error code this build does not know, or a message with no code. */
export const UNKNOWN_CALL_ERROR_MESSAGE = 'The call failed.';

/**
 * The tenant-facing message for a call row's error, or null when the row records no error
 * (neither a code nor a message).
 */
export function tenantCallErrorMessage(errorCode: string | null | undefined, errorMessage: string | null | undefined): string | null {
  if (!errorCode && !errorMessage) return null;
  return (errorCode && MESSAGES[errorCode]) || UNKNOWN_CALL_ERROR_MESSAGE;
}
