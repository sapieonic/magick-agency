import { API_BASE } from '../config';
import { apiFetch } from './client';
import { errorStatus } from '../utils/agencyErrors';
import type {
  AgencyCallSettingsResponse,
  AgencyCallSettingsRouteRef,
  AgencyCampaignInboundDefaultRoutesResponse,
} from '../types/call-settings';

/**
 * The account's call settings (`docs/call-log.md` §5): "Every call must belong to a campaign".
 *
 *   GET /proxy/agency/call-settings                          → AgencyCallSettingsResponse
 *   PUT /proxy/agency/call-settings                          → AgencyCallSettingsResponse
 *   GET /proxy/agency/campaigns/:id/inbound-default-routes   → AgencyCampaignInboundDefaultRoutesResponse
 *
 * The read throws like the rest of the console's clients (its failure is a page state). The
 * write resolves to a result: switching the setting on is refused (`422
 * default_campaign_required`) while an inbound number has no campaign for unknown callers, and
 * that is something the admin acts on, so it is a value the page reads, with the routes named.
 */

const CALL_SETTINGS = `${API_BASE}/proxy/agency/call-settings`;

export function getCallSettings(tenantId?: string, accountId?: string): Promise<AgencyCallSettingsResponse> {
  return apiFetch<AgencyCallSettingsResponse>(CALL_SETTINGS, {}, tenantId, accountId);
}

export interface CallSettingsRefusal {
  /** `default_campaign_required`, or `unknown` (a network failure, a masked 5xx, an RBAC 403). */
  code: 'default_campaign_required' | 'unknown';
  status: number | null;
  /** The server's sentence: the floor when the page has no better copy. */
  message: string;
  /** `default_campaign_required`: the inbound routes with no campaign for unknown callers. */
  routes: AgencyCallSettingsRouteRef[];
}

export type CallSettingsResult = { ok: true; value: AgencyCallSettingsResponse } | { ok: false; refusal: CallSettingsRefusal };

/** Read a call-settings refusal off whatever `apiFetch` threw (`ApiError.details` / `.statusCode`). */
export function parseCallSettingsRefusal(err: unknown): CallSettingsRefusal {
  const raw = err && typeof err === 'object' ? (err as { details?: unknown }).details : undefined;
  const body = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const fallback = err instanceof Error && err.message ? err.message : 'That didn’t go through. Try again in a moment.';
  const routes = Array.isArray(body['routes'])
    ? (body['routes'] as unknown[]).filter(
        (r): r is AgencyCallSettingsRouteRef =>
          !!r && typeof r === 'object' && typeof (r as { route_id?: unknown }).route_id === 'string'
          && typeof (r as { name?: unknown }).name === 'string',
      )
    : [];
  return {
    code: body['code'] === 'default_campaign_required' ? 'default_campaign_required' : 'unknown',
    status: errorStatus(err),
    message: typeof body['message'] === 'string' && body['message'].trim() ? body['message'] : fallback,
    routes,
  };
}

/** `PUT /call-settings`: switch "Every call must belong to a campaign" on or off. */
export async function putCallSettings(requireCampaign: boolean, tenantId?: string, accountId?: string): Promise<CallSettingsResult> {
  try {
    const value = await apiFetch<AgencyCallSettingsResponse>(
      CALL_SETTINGS, { method: 'PUT', body: JSON.stringify({ require_campaign: requireCampaign }) }, tenantId, accountId,
    );
    return { ok: true, value };
  } catch (err) {
    return { ok: false, refusal: parseCallSettingsRefusal(err) };
  }
}

/**
 * The inbound routes that file unknown callers under campaign `campaignId` (`agency.supervise`),
 * asked before it is stopped or archived. Throws; the caller treats a failure as "none known"
 * and goes on, so a warning that could not be read never blocks Stop.
 */
export async function getCampaignInboundDefaultRoutes(
  campaignId: string,
  tenantId?: string,
  accountId?: string,
): Promise<AgencyCallSettingsRouteRef[]> {
  const body = await apiFetch<AgencyCampaignInboundDefaultRoutesResponse>(
    `${API_BASE}/proxy/agency/campaigns/${encodeURIComponent(campaignId)}/inbound-default-routes`, {}, tenantId, accountId,
  );
  return body.routes;
}
