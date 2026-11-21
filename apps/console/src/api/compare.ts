import { API_BASE } from '../config';
import { apiFetch, ApiError } from './client';
import { errorCode } from '../utils/agencyErrors';
import { getErrorMessage } from '@magick-agency/web-ui/errors';
import {
  AGENCY_COMPARE_ERROR_CODES,
  type AgencyCompareErrorCode,
  type AgencyCompareOptions,
  type AgencyCompareOptionsQuery,
  type AgencyCompareQuery,
  type AgencyCompareResponse,
  type AgencyCompareView,
  type AgencyCompareViewList,
  type AgencyCompareViewListQuery,
  type AgencyCreateCompareViewRequest,
  type AgencyUpdateCompareViewRequest,
} from '@magick-agency/contracts/api/agency/compare';

/**
 * Compare agents (`docs/compare-agents.md` §8): one function per route of the fixed surface.
 *
 *   POST   /proxy/agency/compare/query        → the comparison (a POST: the metric refs are structured; it changes nothing)
 *   GET    /proxy/agency/compare/options      → the cohort's agents, the outcome codes, the starting lens, the default view
 *   GET    /proxy/agency/compare/views        → the caller's views and the account's shared ones
 *   POST   /proxy/agency/compare/views        → 201 view
 *   PATCH  /proxy/agency/compare/views/:id    → view (only the owner)
 *   DELETE /proxy/agency/compare/views/:id    → 204 (only the owner)
 *
 * Every route is account-scoped (the account header), floored at `agency.supervise` (CP3) and
 * behind `agency_compare_enabled`: off, each answers the dialer gate's `403 feature_disabled`.
 * Refusals are `ApiError`s whose body is `{ error, code, message }`; {@link compareErrorMessage}
 * turns one into the console's words, keyed off `code` (the server's `message` is English
 * fallback copy and is never shown for a known code, AS15).
 */

const COMPARE = `${API_BASE}/proxy/agency/compare`;
const VIEWS = `${COMPARE}/views`;

const enc = encodeURIComponent;

/** The comparison itself. */
export function queryCompare(
  query: AgencyCompareQuery,
  tenantId?: string,
  accountId?: string,
  signal?: AbortSignal,
): Promise<AgencyCompareResponse> {
  return apiFetch<AgencyCompareResponse>(
    `${COMPARE}/query`,
    { method: 'POST', body: JSON.stringify(query), ...(signal ? { signal } : {}) },
    tenantId,
    accountId,
  );
}

/** `?campaign_id=&from=&to=&timezone=`, in that order. */
export function compareOptionsQueryString(query: AgencyCompareOptionsQuery): string {
  const qs = new URLSearchParams();
  qs.set('campaign_id', query.campaign_id);
  qs.set('from', query.from);
  qs.set('to', query.to);
  qs.set('timezone', query.timezone);
  return `?${qs.toString()}`;
}

/** What the filters and the agent chips need for one campaign and window. */
export function getCompareOptions(
  query: AgencyCompareOptionsQuery,
  tenantId?: string,
  accountId?: string,
  signal?: AbortSignal,
): Promise<AgencyCompareOptions> {
  return apiFetch<AgencyCompareOptions>(
    `${COMPARE}/options${compareOptionsQueryString(query)}`,
    signal ? { signal } : {},
    tenantId,
    accountId,
  );
}

/** The saved views; with `campaign_id`, that campaign's views and the views for any campaign. */
export function listCompareViews(
  query: AgencyCompareViewListQuery,
  tenantId?: string,
  accountId?: string,
): Promise<AgencyCompareViewList> {
  const qs = query.campaign_id ? `?campaign_id=${enc(query.campaign_id)}` : '';
  return apiFetch<AgencyCompareViewList>(`${VIEWS}${qs}`, {}, tenantId, accountId);
}

export function createCompareView(
  request: AgencyCreateCompareViewRequest,
  tenantId?: string,
  accountId?: string,
): Promise<AgencyCompareView> {
  return apiFetch<AgencyCompareView>(VIEWS, { method: 'POST', body: JSON.stringify(request) }, tenantId, accountId);
}

/** Any subset of the create fields. Only the owner may (another supervisor's view is a 404). */
export function updateCompareView(
  viewId: string,
  patch: AgencyUpdateCompareViewRequest,
  tenantId?: string,
  accountId?: string,
): Promise<AgencyCompareView> {
  return apiFetch<AgencyCompareView>(
    `${VIEWS}/${enc(viewId)}`,
    { method: 'PATCH', body: JSON.stringify(patch) },
    tenantId,
    accountId,
  );
}

export function deleteCompareView(viewId: string, tenantId?: string, accountId?: string): Promise<void> {
  return apiFetch<void>(`${VIEWS}/${enc(viewId)}`, { method: 'DELETE' }, tenantId, accountId);
}

// ─── Refusals, in the console's words ──────────────────────────────────────

/** The codes a compare route can refuse with: the family's, plus the flag gate's. */
export type CompareRefusalCode = AgencyCompareErrorCode | 'feature_disabled';

/**
 * What the console says for each refusal (simple Indian English, British spelling, AS15). Keyed
 * by the wire code, so a code added to the contract fails to compile here until it has words.
 */
export const COMPARE_ERROR_MESSAGES: Record<CompareRefusalCode, string> = {
  compare_campaign_required: 'Choose a campaign to compare its agents.',
  compare_campaign_not_found: 'That campaign isn’t one of this account’s. Choose another campaign.',
  compare_too_many_agents: 'You can compare at most 3 agents at a time. Remove one to add another.',
  compare_too_many_metrics: 'You can show at most 6 metrics at a time. Remove one to add another.',
  compare_metric_invalid:
    'One of the metrics can’t be shown for this campaign. Its outcomes may have changed. Choose the metrics again.',
  compare_window_invalid:
    'Those dates don’t make a valid window. Choose up to 31 days, or one calendar month, ending no later than today.',
  compare_timezone_invalid: 'Your browser’s time zone isn’t recognised, so the days can’t be worked out.',
  compare_agent_not_in_cohort:
    'One of the agents didn’t take calls on this campaign in this window. Remove them or choose a longer window.',
  compare_busy: 'Your organisation is already running two comparisons. Try again in a moment.',
  compare_timed_out: 'This comparison took too long to work out. Try a shorter window, or try again.',
  compare_view_not_found: 'That saved view no longer exists, or isn’t yours to change.',
  compare_view_invalid:
    'The view couldn’t be saved. Check its name, and that a campaign default is shared and made for this campaign.',
  compare_view_limit: 'You already have 50 saved views. Delete one to save another.',
  feature_disabled: 'Compare agents isn’t turned on for this account.',
};

const COMPARE_CODES: ReadonlySet<string> = new Set<string>([...AGENCY_COMPARE_ERROR_CODES, 'feature_disabled']);

/** The refusal code of an error from this client, when it is one of the family's (or the flag gate's). */
export function compareErrorCode(err: unknown): CompareRefusalCode | null {
  const code = errorCode(err);
  return code !== null && COMPARE_CODES.has(code) ? (code as CompareRefusalCode) : null;
}

/** A refusal that clears by itself: the page offers Try again (§7). */
export function isRetryableCompareError(err: unknown): boolean {
  const code = compareErrorCode(err);
  return code === 'compare_busy' || code === 'compare_timed_out';
}

/**
 * Any error from this client, as the words to show: the family's copy for a known code, a plain
 * permission line for a 403 without one, otherwise the client's own message or `fallback`.
 */
export function compareErrorMessage(err: unknown, fallback: string): string {
  const code = compareErrorCode(err);
  if (code !== null) return COMPARE_ERROR_MESSAGES[code];
  if (err instanceof ApiError && err.statusCode === 403) return 'You don’t have permission to compare agents.';
  return getErrorMessage(err, fallback);
}
