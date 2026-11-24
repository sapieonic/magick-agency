import {
  ALLOWED_ABANDONMENT_GRACE_MS,
  DEFAULT_ABANDONMENT_GRACE_MS as DOMAIN_DEFAULT_ABANDONMENT_GRACE_MS,
  isAllowedAbandonmentGraceMs,
} from '@magick-agency/domain/abandonment-predicate';

/**
 * The abandonment grace (`abandonment_grace_ms`, decisions AG1–AG5): how long after the customer
 * answers the agent's audio may connect before the call counts as abandoned. Whole seconds from 1
 * to 5, 3 by default; the server refuses anything else and the column CHECK holds the same five
 * values, so a stored value is always one of the choices (unlike the ceiling, which the API can set
 * to values the console does not offer). The range, the default and the check are the domain
 * rule's own, imported, never restated.
 *
 * The wire carries milliseconds; the console speaks whole seconds.
 */

/** The default, in ms: 3000. */
export const DEFAULT_ABANDONMENT_GRACE_MS = DOMAIN_DEFAULT_ABANDONMENT_GRACE_MS;

/** The choices, in whole seconds: 1, 2, 3, 4, 5. */
export const ABANDONMENT_GRACE_SECONDS: readonly number[] = ALLOWED_ABANDONMENT_GRACE_MS.map((ms) => ms / 1000);

/** `3 seconds`, `1 second`. */
export function graceSecondsText(ms: number): string {
  const seconds = ms / 1000;
  return `${seconds} ${seconds === 1 ? 'second' : 'seconds'}`;
}

/** The field's error, or `null`. Keyed `abandonment_grace_ms`, as the server keys its `details`. */
export function abandonmentGraceError(ms: number): string | null {
  if (isAllowedAbandonmentGraceMs(ms)) return null;
  return `Choose ${ABANDONMENT_GRACE_SECONDS[0]} to ${ABANDONMENT_GRACE_SECONDS[ABANDONMENT_GRACE_SECONDS.length - 1]} seconds.`;
}

/** One line for the builder's summary and review, and a template's: `Abandoned after 3 seconds`. */
export function graceSummary(ms: number): string {
  return Number.isFinite(ms) ? `Abandoned after ${graceSecondsText(ms)}` : 'Not set';
}
