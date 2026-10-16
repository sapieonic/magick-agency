/**
 * Campaign thresholds that both the campaign-management modules and the agency
 * repository read.
 *
 * A LEAF, with no imports, so the dependency points the right way: the repository
 * (data access) and `campaign-health.ts` / `campaign-config.ts` (the logic built on
 * it) both import these from here, rather than the repository reaching up into the
 * modules that consume its rows. Both of those modules re-export them, so their
 * existing import paths keep working.
 */

/**
 * The window the failure-rate message names ("in the last 10 minutes").
 *
 * Imported by the repository rather than restated in the SQL, so the number the
 * query measures over and the number the console prints cannot drift — a strip
 * that says "10 minutes" over a 30-minute window is a lie a supervisor would act on.
 */
export const RECENT_FAILURE_WINDOW_MINUTES = 10;

/**
 * The default abandonment ceiling, as a percentage: the `abandonment_ceiling_pct`
 * column's DEFAULT, and what the repository applies when a create omits the field.
 * The per-campaign value is validated by `validateAbandonmentCeiling` in
 * `campaign-config.ts`.
 *
 * One exported value rather than a copy beside each of its readers — the
 * supervisor payload's `abandonment_ceiling_pct` and the auto-pause guardrail —
 * because a compliance threshold with two copies is a compliance threshold that
 * drifts, and the dashboard drawing a gauge against one number while the
 * guardrail fires on another is the specific failure that is invisible until an
 * audit.
 */
export const DEFAULT_ABANDONMENT_CEILING_PCT = 3;
