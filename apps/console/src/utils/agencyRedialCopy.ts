import type { AgencyActionErrorCode } from '../types/agency';

/**
 * Wrap-up redial's codes: the refusals of `POST /sessions/:id/redial`, and which of them hold for
 * the rest of the wrap-up. What the agent reads for each is the station's own words
 * (`redialRefusedLine`, `utils/agency/stationCopy.ts`, AS15).
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

/** The pad's stated reason while a redial is in flight. */
export const PAD_REDIALING_COPY = 'Redialling — the outcome opens again if the call doesn’t go through.';
