/**
 * Team performance's request rules (docs/team-performance.md §4; the field rules are the contract's
 * doc comments, `packages/contracts/src/api/agency/team-performance.ts`). Pure: the route parses the
 * query with {@link teamPerformanceQuerySchema} (a query that fails it is the generic agency 400),
 * looks up the campaign, then asks {@link checkTeamWindow} which refusal, if any, applies, in the
 * contract's order. The zone and the window are Compare's rules (`checkReportWindow`), answered
 * with the team codes: one window rule for every Reports tab (TP11).
 *
 * The English fallback copy of every refusal is here too (`TEAM_ERROR_MESSAGES`): simple Indian
 * English, British spelling (AS15); the console keys off the code and shows its own words (TP17).
 */
import { z } from 'zod';
import { REPORT_MAX_WINDOW_DAYS } from '@magick-agency/contracts/api/agency/reports';
import type { AgencyTeamPerformanceErrorCode } from '@magick-agency/contracts/api/agency/team-performance';
import { UUID_RE } from '../../utils/uuid.js';
import { checkReportWindow } from '../compare/validate.js';

/** English fallback copy per code (AS15). The console shows its own words for a known code. */
export const TEAM_ERROR_MESSAGES: Readonly<Record<AgencyTeamPerformanceErrorCode, string>> = Object.freeze({
  team_campaign_not_found: 'Campaign not found in this account.',
  team_timezone_invalid: 'The time zone is missing or not recognised.',
  team_window_invalid: `Choose dates ending today or earlier, at most ${REPORT_MAX_WINDOW_DAYS} days or one calendar month.`,
  team_busy: 'Too many team reports are running right now. Try again in a moment.',
  team_timed_out: 'Too much to read at once. Try a shorter period.',
});

/**
 * `GET /team-performance` query, shape only. `timezone` is optional here because its absence has a
 * team code of its own (`team_timezone_invalid`); a malformed `campaign_id` is the generic 400 (the
 * contract's rule), lower-cased when it parses.
 */
export const teamPerformanceQuerySchema = z.object({
  from: z.string(),
  to: z.string(),
  timezone: z.string().optional(),
  campaign_id: z.string().regex(UUID_RE, 'must be a UUID').transform((id) => id.toLowerCase()).optional(),
});
export type TeamPerformanceQuery = z.infer<typeof teamPerformanceQuerySchema>;

/** {@link checkReportWindow} with the team codes (`team_timezone_invalid`, `team_window_invalid`). */
export function checkTeamWindow(
  q: { from: string; to: string; timezone: string | undefined },
  databaseZone: string | null,
  todayIn: (zone: string) => string,
): { ok: true; timezone: string; databaseTimezone: string } | { ok: false; code: AgencyTeamPerformanceErrorCode } {
  return checkReportWindow(q, databaseZone, todayIn, { zone: 'team_timezone_invalid', window: 'team_window_invalid' });
}
