import { ENDPOINTS } from '../config';
import { apiFetch } from './client';
import type {
  CallAnalysisProfile,
  CallAnalysisProfilesListResponse,
  CreateCallAnalysisProfileInput,
  UpdateCallAnalysisProfileInput,
} from '../types/call-analysis-profile';

/**
 * Call-analysis profiles CRUD, proxied through the server
 * (`/proxy/call-analysis-profiles`, capability `calls.dialer.analytics`).
 *
 * Note `PUT` is copy-on-write upstream: it returns a NEW row with a new `id` and
 * an incremented `version`, superseding the one you passed. Callers must use the
 * returned record rather than assuming the id they sent is still live.
 */

/** Paginated list of the account's active profiles. */
export function listCallAnalysisProfiles(
  tenantId: string,
  limit = 100,
  offset = 0,
  accountId?: string,
): Promise<CallAnalysisProfilesListResponse> {
  const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
  return apiFetch(
    `${ENDPOINTS.proxy.callAnalysisProfiles.base}?${params}`,
    {},
    tenantId,
    accountId,
  );
}

/** Single profile detail (scoped 404 upstream). */
export function getCallAnalysisProfile(
  tenantId: string,
  id: string,
  accountId?: string,
): Promise<CallAnalysisProfile> {
  return apiFetch(ENDPOINTS.proxy.callAnalysisProfiles.get(id), {}, tenantId, accountId);
}

/** Create a profile. 409 upstream when an active profile already owns the name. */
export function createCallAnalysisProfile(
  tenantId: string,
  data: CreateCallAnalysisProfileInput,
  accountId?: string,
): Promise<CallAnalysisProfile> {
  return apiFetch(
    ENDPOINTS.proxy.callAnalysisProfiles.base,
    { method: 'POST', body: JSON.stringify(data) },
    tenantId,
    accountId,
  );
}

/** Copy-on-write update — resolves to the NEW version, not the one passed in. */
export function updateCallAnalysisProfile(
  tenantId: string,
  id: string,
  data: UpdateCallAnalysisProfileInput,
  accountId?: string,
): Promise<CallAnalysisProfile> {
  return apiFetch(
    ENDPOINTS.proxy.callAnalysisProfiles.get(id),
    { method: 'PUT', body: JSON.stringify(data) },
    tenantId,
    accountId,
  );
}

/** Soft delete. In-flight analyses are unaffected (they carry a snapshot). */
export function deleteCallAnalysisProfile(
  tenantId: string,
  id: string,
  accountId?: string,
): Promise<void> {
  return apiFetch(
    ENDPOINTS.proxy.callAnalysisProfiles.get(id),
    { method: 'DELETE' },
    tenantId,
    accountId,
  );
}
