import { API_BASE, ORIGINATOR_HEADER, ORIGINATOR } from '../config';
import { appendRequestId, extractRequestId, isMaskedErrorBody } from '../utils/errors';
import type {
  SuperAdminLoginResponse,
  SuperAdminTenant,
  SuperAdminTenantDetail,
  SuperAdminUser,
  SuperAdmin,
  SuperAdminAuditListParams,
  SuperAdminAuditListResponse,
  CreateTenantBody,
  CreateTenantResponse,
  AddUserToTenantBody,
  AddUserToTenantResponse,
  ChangeMembershipRoleBody,
  ChangeMembershipRoleResponse,
  RevokeMembershipResponse,
  AccountConcurrencyAllocation,
  AccountConcurrencyDetail,
  TenantAccountWithConcurrency,
  UpdateAccountConcurrencyBody,
  FeatureFlagCatalogResponse,
  FeatureFlagResolveResponse,
  UpsertFlagOverrideBody,
  DeleteFlagOverrideBody,
  BulkFlagOverrideResult,
  PhoneNumber,
  TenantPhoneAssignment,
  PhoneNumberDetailResponse,
  CreatePhoneNumberBody,
  UpdatePhoneNumberBody,
  AssignPhoneNumberBody,
} from '@magick-agency/contracts/api/platform/super-admin';
import type {
  AgencyAccountSettingsResponse,
  UpdateAgencyAccountSettingsBody,
} from '@magick-agency/contracts/api/platform/settings';
import type { UsageCountsQuery, UsageCountsResponse } from '@magick-agency/contracts/api/platform/super-admin-usage';

const SA_TOKEN_KEY = 'sa_token';
const SA_BASE = `${API_BASE}/super-admin`;

function getToken(): string | null {
  return sessionStorage.getItem(SA_TOKEN_KEY);
}

export function setToken(token: string): void {
  sessionStorage.setItem(SA_TOKEN_KEY, token);
}

export function clearToken(): void {
  sessionStorage.removeItem(SA_TOKEN_KEY);
}

export function hasToken(): boolean {
  return !!sessionStorage.getItem(SA_TOKEN_KEY);
}

/**
 * Build an `Error` from a non-ok super-admin response. For masked errors (same
 * contract as the customer API client) the support correlation id is embedded
 * in the message so the shared display primitives can render it as a copyable
 * chip; validation/business errors keep their original message untouched.
 */
export class SuperAdminApiError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly details: unknown,
    message: string,
  ) {
    super(message);
    this.name = 'SuperAdminApiError';
  }
}

/**
 * First usable message out of a Zod issue list.
 *
 * magic-voice-core answers a validation failure with
 * `{ error: 'Validation Error', details: [...zod issues] }` and **no top-level
 * `message`** — so its carefully-worded messages ("Unknown status \"canceled\"
 * for offering \"ai_calls\". Valid values: …") all rendered as "API error 400".
 * Defensive throughout: `details` is whatever the server sent, and this runs
 * inside an error path that must never throw one of its own.
 */
function firstIssueMessage(details: unknown): string | undefined {
  if (!Array.isArray(details)) return undefined;
  for (const issue of details) {
    if (typeof issue === 'string' && issue.length > 0) return issue;
    if (typeof issue === 'object' && issue !== null) {
      const m = (issue as { message?: unknown }).message;
      if (typeof m === 'string' && m.length > 0) return m;
    }
  }
  return undefined;
}

function saError(res: Response, details: unknown): SuperAdminApiError {
  const body = typeof details === 'object' && details !== null
    ? (details as Record<string, unknown>)
    : undefined;
  // A top-level `message` still wins — masked bodies always carry one, so the
  // masked-error contract below is untouched.
  const topLevel = typeof body?.['message'] === 'string' && body['message'] ? body['message'] : undefined;
  const msg = topLevel ?? firstIssueMessage(body?.['details']) ?? `API error ${res.status}`;
  if (isMaskedErrorBody(res.status, details)) {
    const requestId = res.headers.get('x-request-id') ?? extractRequestId(details);
    return new SuperAdminApiError(res.status, details, appendRequestId(msg, requestId));
  }
  return new SuperAdminApiError(res.status, details, msg);
}

export async function saFetch<T>(url: string, options: RequestInit = {}): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = {
    [ORIGINATOR_HEADER]: ORIGINATOR,
    ...((options.headers as Record<string, string>) || {}),
  };
  if (options.body) {
    headers['Content-Type'] = headers['Content-Type'] || 'application/json';
  }
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const res = await fetch(url, { ...options, headers });

  if (res.status === 401) {
    clearToken();
    window.location.href = '/login';
    throw new Error('Session expired');
  }

  if (!res.ok) {
    let details: unknown;
    try {
      details = await res.json();
    } catch {
      details = { message: res.statusText };
    }
    throw saError(res, details);
  }

  if (res.status === 204) return undefined as T;
  return res.json();
}

// ── Auth ──────────────────────────────────────────────────

export async function superAdminLogin(email: string, password: string): Promise<SuperAdminLoginResponse> {
  const res = await fetch(`${SA_BASE}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', [ORIGINATOR_HEADER]: ORIGINATOR },
    body: JSON.stringify({ email, password }),
  });

  if (!res.ok) {
    let details: unknown;
    try {
      details = await res.json();
    } catch {
      details = { message: res.statusText };
    }
    const msg = typeof details === 'object' && details !== null && 'message' in details
      ? (details as { message: string }).message
      : 'Login failed';
    throw new Error(msg);
  }

  return res.json();
}

export async function getSuperAdminMe(): Promise<{ admin: SuperAdmin }> {
  return saFetch(`${SA_BASE}/me`);
}

// ── Tenants ───────────────────────────────────────────────

export async function listTenants(): Promise<{ tenants: SuperAdminTenant[] }> {
  return saFetch(`${SA_BASE}/tenants`);
}

export async function getTenantDetail(id: string): Promise<SuperAdminTenantDetail> {
  return saFetch(`${SA_BASE}/tenants/${id}`);
}

export async function createTenant(data: CreateTenantBody): Promise<CreateTenantResponse> {
  return saFetch(`${SA_BASE}/tenants`, {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function addUserToTenant(tenantId: string, data: AddUserToTenantBody): Promise<AddUserToTenantResponse> {
  return saFetch(`${SA_BASE}/tenants/${tenantId}/users`, {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

/** NEW (plan §3.4): change a membership's role. */
export async function changeMembershipRole(
  tenantId: string,
  membershipId: string,
  data: ChangeMembershipRoleBody,
): Promise<ChangeMembershipRoleResponse> {
  return saFetch(`${SA_BASE}/tenants/${tenantId}/memberships/${membershipId}/role`, {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}

/** NEW (plan §3.4): revoke a membership; the server also closes its campaign staffing. */
export async function revokeMembership(tenantId: string, membershipId: string): Promise<RevokeMembershipResponse> {
  return saFetch(`${SA_BASE}/tenants/${tenantId}/memberships/${membershipId}`, { method: 'DELETE' });
}

// ── Users ─────────────────────────────────────────────────

export async function listAllUsers(): Promise<{ users: SuperAdminUser[] }> {
  return saFetch(`${SA_BASE}/users`);
}

// ── Account Concurrency ──────────────────────────────────

export async function getTenantAccounts(tenantId: string): Promise<TenantAccountWithConcurrency[]> {
  const res = await saFetch<{ accounts: TenantAccountWithConcurrency[] }>(`${SA_BASE}/tenants/${tenantId}/accounts`);
  return res.accounts;
}

export async function updateAccountConcurrency(
  tenantId: string,
  accountId: string,
  maxConcurrentCalls: number,
): Promise<unknown> {
  return saFetch(`${SA_BASE}/tenants/${tenantId}/accounts/${accountId}/concurrency`, {
    method: 'PUT',
    body: JSON.stringify({ max_concurrent_calls: maxConcurrentCalls }),
  });
}

export async function getAccountConcurrency(
  tenantId: string,
  accountId: string,
): Promise<AccountConcurrencyDetail> {
  return saFetch(`${SA_BASE}/tenants/${tenantId}/accounts/${accountId}/concurrency`);
}

export async function updateProviderConcurrency(
  tenantId: string,
  accountId: string,
  body: Extract<UpdateAccountConcurrencyBody, { mode: string }>,
): Promise<AccountConcurrencyAllocation> {
  return saFetch(`${SA_BASE}/tenants/${tenantId}/accounts/${accountId}/concurrency`, {
    method: 'PUT',
    body: JSON.stringify(body),
  });
}

// ── Per-account settings (NEW, plan §3.2) ────────────────

export async function getAccountSettings(
  tenantId: string,
  accountId: string,
): Promise<AgencyAccountSettingsResponse> {
  return saFetch(`${SA_BASE}/tenants/${tenantId}/accounts/${accountId}/settings`);
}

export async function updateAccountSettings(
  tenantId: string,
  accountId: string,
  body: UpdateAgencyAccountSettingsBody,
): Promise<AgencyAccountSettingsResponse> {
  return saFetch(`${SA_BASE}/tenants/${tenantId}/accounts/${accountId}/settings`, {
    method: 'PUT',
    body: JSON.stringify(body),
  });
}

// ── Usage counts (NEW, plan §3.3) ────────────────────────

export async function getUsageCounts(query: UsageCountsQuery): Promise<UsageCountsResponse> {
  const qs = new URLSearchParams({ from: query.from, to: query.to });
  if (query.tenant_id) qs.set('tenant_id', query.tenant_id);
  if (query.account_id) qs.set('account_id', query.account_id);
  return saFetch(`${SA_BASE}/usage?${qs.toString()}`);
}

// ── Feature flags ────────────────────────────────────────

export async function getFeatureFlagCatalog(): Promise<FeatureFlagCatalogResponse> {
  return saFetch(`${SA_BASE}/feature-flags`);
}

export async function resolveFeatureFlags(
  tenantId: string,
  accountId?: string,
): Promise<FeatureFlagResolveResponse> {
  const params = new URLSearchParams({ tenant_id: tenantId });
  if (accountId) params.set('account_id', accountId);
  return saFetch(`${SA_BASE}/feature-flags/resolve?${params.toString()}`);
}

export async function putFeatureFlagOverride(
  flagKey: string,
  body: UpsertFlagOverrideBody,
): Promise<unknown> {
  return saFetch(`${SA_BASE}/feature-flags/${encodeURIComponent(flagKey)}/overrides`, {
    method: 'PUT',
    body: JSON.stringify(body),
  });
}

export async function deleteFeatureFlagOverride(
  flagKey: string,
  body: DeleteFlagOverrideBody,
): Promise<unknown> {
  return saFetch(`${SA_BASE}/feature-flags/${encodeURIComponent(flagKey)}/overrides`, {
    method: 'DELETE',
    body: JSON.stringify(body),
  });
}

export async function bulkFeatureFlagOverride(
  flagKey: string,
  body: { tenant_ids: string[]; value: unknown; reason?: string | null },
): Promise<BulkFlagOverrideResult> {
  return saFetch(`${SA_BASE}/feature-flags/${encodeURIComponent(flagKey)}/overrides/bulk`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

// ── Password ─────────────────────────────────────────────

export async function changePassword(currentPassword: string, newPassword: string): Promise<{ success: boolean }> {
  return saFetch(`${SA_BASE}/change-password`, {
    method: 'PUT',
    body: JSON.stringify({ current_password: currentPassword, new_password: newPassword }),
  });
}

// ── Admins ────────────────────────────────────────────────

export async function listAdmins(): Promise<{ admins: SuperAdmin[] }> {
  return saFetch(`${SA_BASE}/admins`);
}

export async function createAdmin(data: { email: string; password: string; name: string }): Promise<{ admin: SuperAdmin }> {
  return saFetch(`${SA_BASE}/admins`, {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function removeAdmin(id: string): Promise<{ success: boolean }> {
  return saFetch(`${SA_BASE}/admins/${id}`, { method: 'DELETE' });
}

export async function reactivateAdmin(id: string): Promise<{ admin: SuperAdmin }> {
  return saFetch(`${SA_BASE}/admins/${id}/reactivate`, { method: 'POST' });
}

export async function resetAdminPassword(
  id: string,
  body: { admin_password: string; new_password: string },
): Promise<{ success: boolean }> {
  return saFetch(`${SA_BASE}/admins/${id}/password`, {
    method: 'PUT',
    body: JSON.stringify(body),
  });
}

// ── Audit ─────────────────────────────────────────────────

export async function listAuditLog(
  params: SuperAdminAuditListParams = {},
): Promise<SuperAdminAuditListResponse> {
  const qs = new URLSearchParams();
  qs.set('limit', String(params.limit ?? 50));
  qs.set('offset', String(params.offset ?? 0));
  if (params.actor) qs.set('actor', params.actor);
  if (params.action) qs.set('action', params.action);
  if (params.resource_type) qs.set('resource_type', params.resource_type);
  if (params.resource_id) qs.set('resource_id', params.resource_id);
  if (params.q) qs.set('q', params.q);
  if (params.from) qs.set('from', params.from);
  if (params.to) qs.set('to', params.to);
  return saFetch(`${SA_BASE}/audit?${qs.toString()}`);
}

// ── Telephony providers (read-only) ──────────────────────

/**
 * PORT NOTE (magick-agency): cusui's `TelephonyProvider` minus
 * `live_transfer_enabled` (AI escalation, not carried). Only the read survives:
 * the baseline seeds one `voicelink` row and the add-number form picks its id.
 */
export interface TelephonyProvider {
  id: string;
  name: string;
  display_name: string;
  status: 'active' | 'inactive';
  created_at: string;
  updated_at: string;
}

export async function listTelephonyProviders(): Promise<TelephonyProvider[]> {
  const res = await saFetch<{ providers: TelephonyProvider[] }>(`${SA_BASE}/telephony-providers`);
  return res.providers;
}

// ── Phone Numbers ────────────────────────────────────────

export async function listPhoneNumbers(filters?: { provider_id?: string; status?: string }): Promise<PhoneNumber[]> {
  const params = new URLSearchParams();
  if (filters?.provider_id) params.set('provider_id', filters.provider_id);
  if (filters?.status) params.set('status', filters.status);
  const qs = params.toString();
  const res = await saFetch<{ phone_numbers: PhoneNumber[] }>(
    `${SA_BASE}/phone-numbers${qs ? `?${qs}` : ''}`,
  );
  return res.phone_numbers;
}

export async function getPhoneNumberDetail(id: string): Promise<PhoneNumberDetailResponse> {
  return saFetch(`${SA_BASE}/phone-numbers/${id}`);
}

export async function createPhoneNumber(data: CreatePhoneNumberBody): Promise<{ phone_number: PhoneNumber }> {
  return saFetch<{ phone_number: PhoneNumber }>(`${SA_BASE}/phone-numbers`, {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function updatePhoneNumber(id: string, data: UpdatePhoneNumberBody): Promise<{ phone_number: PhoneNumber }> {
  return saFetch<{ phone_number: PhoneNumber }>(`${SA_BASE}/phone-numbers/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}

export async function retirePhoneNumber(id: string): Promise<void> {
  await saFetch(`${SA_BASE}/phone-numbers/${id}`, { method: 'DELETE' });
}

export async function reactivatePhoneNumber(id: string): Promise<void> {
  await saFetch(`${SA_BASE}/phone-numbers/${id}/reactivate`, { method: 'POST' });
}

export async function deletePhoneNumber(id: string): Promise<void> {
  await saFetch(`${SA_BASE}/phone-numbers/${id}/delete`, { method: 'POST' });
}

export async function assignPhoneNumber(phoneNumberId: string, data: AssignPhoneNumberBody): Promise<void> {
  await saFetch(`${SA_BASE}/phone-numbers/${phoneNumberId}/assign`, {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function unassignPhoneNumber(phoneNumberId: string, tenantId: string): Promise<void> {
  await saFetch(`${SA_BASE}/phone-numbers/${phoneNumberId}/assign/${tenantId}`, {
    method: 'DELETE',
  });
}

export async function getTenantPhoneNumbers(tenantId: string): Promise<TenantPhoneAssignment[]> {
  const res = await saFetch<{ phone_numbers: TenantPhoneAssignment[] }>(
    `${SA_BASE}/tenants/${tenantId}/phone-numbers`,
  );
  return res.phone_numbers;
}
