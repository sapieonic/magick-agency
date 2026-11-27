import { API_BASE } from '../config';
import { apiFetch, ApiError } from './client';
import { toQuery } from './agencySpine';
import { errorCode } from '../utils/agencyErrors';
import { getErrorMessage } from '@magick-agency/web-ui/errors';
import {
  AGENCY_TEAM_PERFORMANCE_ERROR_CODES,
  type AgencyTeamPerformance,
  type AgencyTeamPerformanceQuery,
} from '@magick-agency/contracts/api/agency/team-performance';
import {
  TEAM_ERROR_MESSAGES,
  TEAM_FORBIDDEN_MESSAGE,
  TEAM_NETWORK_MESSAGE,
  type TeamRefusalCode,
} from '../utils/agency/team/teamCopy';

/**
 * Team performance (`docs/team-performance.md` §4): `GET /proxy/agency/team-performance`.
 * Account-scoped (the account header), floored at `agency.supervise` (TP3) and behind
 * `agency_team_performance_enabled`. Refusals are `ApiError`s whose body is `{ error, code,
 * message }`; {@link teamErrorMessage} turns one into the console's words, keyed off `code`.
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

const TEAM_CODES: ReadonlySet<string> = new Set<string>([...AGENCY_TEAM_PERFORMANCE_ERROR_CODES, 'feature_disabled']);

/** The refusal code of an error from this client, when it is one of the family's (or the flag gate's). */
export function teamErrorCode(err: unknown): TeamRefusalCode | null {
  const code = errorCode(err);
  return code !== null && TEAM_CODES.has(code) ? (code as TeamRefusalCode) : null;
}

/**
 * A failure that can clear by itself, so the page offers Try again (Compare's rule, §2 States):
 * `team_busy` and `team_timed_out`, any other 429 or 5xx, and a failure with no answer at all.
 * Every other refusal stays until the reader changes something.
 */
export function isRetryableTeamError(err: unknown): boolean {
  const code = teamErrorCode(err);
  if (code === 'team_busy' || code === 'team_timed_out') return true;
  if (code !== null) return false;
  if (err instanceof ApiError) return err.statusCode === 429 || err.statusCode >= 500;
  return !(err instanceof DOMException && err.name === 'AbortError');
}

/** Any error from this client as the words to show (the browser's own fetch words never). */
export function teamErrorMessage(err: unknown, fallback: string): string {
  const code = teamErrorCode(err);
  if (code !== null) return TEAM_ERROR_MESSAGES[code];
  if (err instanceof ApiError) {
    if (err.statusCode === 403) return TEAM_FORBIDDEN_MESSAGE;
    return getErrorMessage(err, fallback);
  }
  return TEAM_NETWORK_MESSAGE;
}
