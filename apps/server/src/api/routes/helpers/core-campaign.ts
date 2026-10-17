import type { FastifyRequest } from 'fastify';
import { callCore } from '../../core-dispatch.js';

/**
 * A string field of an internal handler's response body, or `null`.
 *
 * The public API layer keeps no campaign (or session, or attempt) schema — those bodies
 * are the dialer runtime's and are passed through untyped — so a field is read
 * defensively rather than trusted: a malformed or unexpected body must never throw out
 * of an audit call or an enrichment and take the request down with it.
 */
export function stringField(body: unknown, field: string): string | null {
  if (body && typeof body === 'object' && field in body) {
    const value = (body as Record<string, unknown>)[field];
    return typeof value === 'string' ? value : null;
  }
  return null;
}

/** What {@link fetchOwnedCoreCampaign} found: the campaign body, or the handler's refusal. */
export type OwnedCoreCampaign =
  | { ok: true; body: unknown }
  | { ok: false; status: number; body: unknown };

/**
 * The campaign ownership probe: the internal handler's `GET /agency-campaigns/:id`,
 * in-process, under the request's tenant and `accountId` (the request's own account
 * unless the caller names the one it has proved, e.g. a membership's).
 *
 * The handler applies the whole rule — its `gate` (the `agency_dialer_enabled` flag)
 * and its `requireOwned` (tenant AND account), answering its own 404
 * `campaign_not_found` — so this layer keeps no second copy of it. A refusal (any status
 * ≥ 400) is returned with the handler's status and body for the caller to forward or
 * map; a cross-tenant id and a nonexistent one are the same 404. A throw from `callCore`
 * (only a wiring defect) propagates.
 */
export async function fetchOwnedCoreCampaign(
  request: FastifyRequest,
  campaignId: string,
  accountId: string | undefined = request.accountId,
): Promise<OwnedCoreCampaign> {
  const result = await callCore({
    method: 'GET',
    path: `/agency-campaigns/${campaignId}`,
    tenantId: request.tenantId!,
    accountId,
  });
  return result.status >= 400
    ? { ok: false, status: result.status, body: result.body }
    : { ok: true, body: result.body };
}
