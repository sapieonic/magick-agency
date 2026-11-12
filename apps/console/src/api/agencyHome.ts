import { ENDPOINTS } from '../config';
import { apiFetch } from './client';
import type { AgencyHomeBoard } from '@magick-agency/contracts/api/agency/home';

/**
 * Home's board, `GET /proxy/agency/home` (decision B28a; the wire is
 * `contracts/api/agency/home.ts`): the account's active campaigns, at most 25, each with its
 * stall, abandonment, floor and what the campaign Overview's attention rules read. One request for Home's fast tick and for the
 * sidebar badge's slow one. `agency.supervise`, which Home's gate already requires.
 *
 * `accountId` must be given: `apiFetch` sends `X-Account-Id` only when it is, and the server
 * answers a board without it `400 account_scope_required`.
 */
export function getAgencyHomeBoard(tenantId: string, accountId: string): Promise<AgencyHomeBoard> {
  return apiFetch<AgencyHomeBoard>(ENDPOINTS.proxy.agency.home, {}, tenantId, accountId);
}
