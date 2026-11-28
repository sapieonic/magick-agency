import { API_BASE } from '../config';
import { apiFetch } from './client';
import { toQuery } from './agencySpine';
import { errorFamily } from './errorFamily';
import type { AgencyTeamPerformance, AgencyTeamPerformanceQuery } from '@magick-agency/contracts/api/agency/team-performance';
import { TEAM_ERROR_MESSAGES, TEAM_FORBIDDEN_MESSAGE, type TeamRefusalCode } from '../utils/agency/team/teamCopy';

/**
 * Team performance (`docs/team-performance.md` §4): `GET /proxy/agency/team-performance`.
 * Account-scoped (the account header), floored at `agency.supervise` (TP3) and behind
 * `agency_team_performance_enabled`. Refusals are `ApiError`s whose body is `{ error, code,
 * message }`; `teamErrors.message` turns one into the console's words, keyed off `code`.
 */

const TEAM_PERFORMANCE = `${API_BASE}/proxy/agency/team-performance`;

/** The team's figures for a window and a campaign (absent: All campaigns). */
export function getTeamPerformance(
  query: AgencyTeamPerformanceQuery,
  tenantId?: string,
  accountId?: string,
  signal?: AbortSignal,
): Promise<AgencyTeamPerformance> {
  return apiFetch<AgencyTeamPerformance>(
    `${TEAM_PERFORMANCE}${toQuery({ from: query.from, to: query.to, timezone: query.timezone, campaign_id: query.campaign_id })}`,
    signal ? { signal } : {},
    tenantId,
    accountId,
  );
}

/**
 * The family's helpers ({@link errorFamily}): Try again only for `team_busy` and
 * `team_timed_out` among the codes (Compare's rule, §2 States).
 */
export const teamErrors = errorFamily<TeamRefusalCode>({
  messages: TEAM_ERROR_MESSAGES,
  retryable: ['team_busy', 'team_timed_out'],
  forbidden: TEAM_FORBIDDEN_MESSAGE,
});
