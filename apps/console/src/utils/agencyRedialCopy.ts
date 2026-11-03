import type { AgencyRedialInfo } from '@magick-agency/contracts/agency';
import type { AgencyActionErrorCode } from '../types/agency';
import { errorBody, errorStatus } from './agencyErrors';

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
  disposition_already_submitted: 'The outcome for this call is already saved, so it can’t be redialled.',
  redial_blocked_dnc: 'This number is on a Do Not Call list, so it can’t be redialled. Save the outcome.',
  redial_blocked_calling_hours:
    'It’s outside this contact’s calling hours, so it can’t be redialled now. Save the outcome.',
  redial_blocked: 'Couldn’t redial this call. Save the outcome.',
};

/**
 * The server answered, refused, and named no refusal this client knows (a 4xx with
 * an unexpected code). Nothing was placed.
 */
export const REDIAL_FAILED_COPY = 'Couldn’t redial. Try again, or save the outcome.';

/**
 * No usable answer (the request never got one, or a 5xx): the redial may have been
 * placed all the same, so this must not say it failed. If it was, its call arrives
 * on the socket and replaces the wrap-up.
 */
export const REDIAL_UNCERTAIN_COPY =
  'No answer from the server, so the redial may still go through. If no call starts, try again or save the outcome.';

/**
 * The refusals that hold for the rest of this wrap-up: pressing again would be
 * refused the same way, so the button stays disabled until the next wrap-up.
 * `redial_limit_reached` retires it too, through the count.
 */
export const PERMANENT_REDIAL_REFUSALS: ReadonlySet<string> = new Set<RedialRefusalCode>([
  'redial_not_allowed',
  'redial_blocked_dnc',
  'disposition_already_submitted',
]);

/** Shown in place of the remaining count while the request is out, and announced on the press. */
export const REDIAL_IN_FLIGHT_COPY = 'Redialling…';

/**
 * Why a disabled Redial is disabled, in place of the remaining count. A disabled
 * control always states a true reason: a disabled button beside "2 redials left"
 * says the opposite of what it is doing.
 */
export const REDIAL_DISABLED_COPY = {
  /** After a refusal that holds for this wrap-up (the refusal itself says why). */
  blocked: 'Redial isn’t available for this call',
  /** The outcome is being saved. */
  saving: 'Saving the outcome…',
  /** The outcome is saved: there is no call left to redial. */
  saved: 'Outcome saved',
  /** The pad itself is locked (another window holds the station). */
  locked: 'Redial isn’t available in this window',
  /** The station socket is not open: the redial would ring a customer the agent cannot hear. */
  connection: 'Redial is available when connected',
  /** `campaign_state.dialing` is false: the server refuses a redial on a campaign that is not running. */
  notDialing: 'The campaign isn’t dialing, so redial is off',
} as const;

/** The pad's stated reason while a redial is in flight. */
export const PAD_REDIALING_COPY = 'Redialling — the outcome opens again if the call doesn’t go through.';

function isRefusalCode(code: string | null | undefined): code is RedialRefusalCode {
  return (REDIAL_REFUSAL_CODES as readonly string[]).includes(code ?? '');
}

/**
 * What a failed redial says. `redial_blocked` and `redial_not_allowed` each cover
 * several causes (an invalid number, the DNC registry unreachable, no usable caller
 * ID; the campaign off or not running, the wrap-up already over, the customer no
 * longer held) and their `message` says which, so those are shown as received.
 */
export function redialRefusalCopy(err: unknown): string {
  const body = errorBody(err);
  const code = body?.code ?? null;
  if (code === 'redial_blocked' && body?.message) {
    return `Couldn’t redial: ${body.message}`;
  }
  if (code === 'redial_not_allowed' && body?.message) return body.message;
  if (isRefusalCode(code)) return REDIAL_REFUSAL_COPY[code];
  const status = errorStatus(err);
  return status === null || status >= 500 ? REDIAL_UNCERTAIN_COPY : REDIAL_FAILED_COPY;
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
