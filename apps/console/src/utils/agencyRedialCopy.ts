import type { AgencyRedialInfo } from '@magick-agency/contracts/agency';
import type { AgencyActionErrorCode } from '../types/agency';
import { errorBody } from './agencyErrors';

/**
 * Wrap-up redial copy: the button's remaining-count line, the live call's
 * "Redial 1 of 2" tag, and what each refusal of `POST /sessions/:id/redial` says.
 *
 * Every refusal leaves the agent in wrap-up with the outcome pad usable, so each
 * sentence says why the redial did not happen and, where it is the only way on,
 * that the outcome can still be saved.
 */

/** The `AgencyActionErrorCode`s the redial route refuses with (409). */
export const REDIAL_REFUSAL_CODES = [
  'redial_not_allowed',
  'redial_limit_reached',
  'disposition_already_submitted',
  'redial_blocked_dnc',
  'redial_blocked_calling_hours',
  'redial_blocked',
] as const satisfies readonly AgencyActionErrorCode[];

export type RedialRefusalCode = (typeof REDIAL_REFUSAL_CODES)[number];

/** Exhaustive: a code added to {@link REDIAL_REFUSAL_CODES} fails lint until it has copy. */
export const REDIAL_REFUSAL_COPY: Record<RedialRefusalCode, string> = {
  redial_not_allowed: 'Redial isn’t available for this call. Save the outcome instead.',
  redial_limit_reached: 'No redials left for this call. Save the outcome.',
  disposition_already_submitted: 'The outcome for this call is already saved, so it can’t be redialed.',
  redial_blocked_dnc: 'This number is on a Do Not Call list, so it can’t be redialed. Save the outcome.',
  redial_blocked_calling_hours:
    'It’s outside this contact’s calling hours, so it can’t be redialed now. Save the outcome.',
  redial_blocked: 'Couldn’t redial this call. Save the outcome.',
};

/** Any failure that is not one of the route's refusals (network, 5xx, an unexpected code). */
export const REDIAL_FAILED_COPY = 'Couldn’t redial. Try again, or save the outcome.';

/** Shown in place of the remaining count while the request is out. */
export const REDIAL_IN_FLIGHT_COPY = 'Redialing…';

/** The pad's stated reason while a redial is in flight. */
export const PAD_REDIALING_COPY = 'Redialing — the outcome opens again if the call doesn’t go through.';

function isRefusalCode(code: string | null | undefined): code is RedialRefusalCode {
  return (REDIAL_REFUSAL_CODES as readonly string[]).includes(code ?? '');
}

/**
 * What a failed redial says. `redial_blocked` covers several causes (an invalid
 * number, the DNC registry unreachable, no usable caller ID, the station not
 * connected) and its `message` says which, so that one is shown as received.
 */
export function redialRefusalCopy(err: unknown): string {
  const body = errorBody(err);
  const code = body?.code ?? null;
  if (code === 'redial_blocked' && body?.message) {
    return `Couldn’t redial: ${body.message}`;
  }
  return isRefusalCode(code) ? REDIAL_REFUSAL_COPY[code] : REDIAL_FAILED_COPY;
}

/** The line beside the Redial button: `2 redials left`, `1 redial left`, `No redials left`. */
export function redialRemainingCopy(remaining: number): string {
  if (remaining <= 0) return 'No redials left';
  return `${remaining} redial${remaining === 1 ? '' : 's'} left`;
}

/**
 * `Redial 1 of 2` — which redial this live call is. The total is the server's
 * statement (`number + remaining`), not a constant this client holds.
 */
export function redialTag(redial: AgencyRedialInfo): string {
  return `Redial ${redial.number} of ${redial.number + redial.remaining}`;
}
