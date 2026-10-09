import { ENDPOINTS } from '../config';
import type { FeatureFlagMap } from '../types/feature-flags';
import { apiFetch } from './client';

/**
 * Fetch the resolved client-exposed feature flags for a tenant/account. Mirrors
 * `api/metadata.ts`, but passes the account too so account-scoped flags resolve
 * correctly (the endpoint is account-scopable; metadata is tenant-only).
 */
export function fetchFeatureFlags(tenantId: string, accountId?: string): Promise<FeatureFlagMap> {
  return apiFetch(ENDPOINTS.featureFlags, {}, tenantId, accountId);
}
