/**
 * The super-admin console's wire shapes.
 *
 * A separate login (its own JWT and `super_admins` table, never Firebase), and a
 * deliberately narrow surface: tenants, users, phone numbers for agency's one
 * VoiceLink account, per-account concurrency limits, per-account settings
 * (`./settings`), feature-flag overrides, the super-admin list and login, the
 * super-admin audit trail, and read-only usage counts (`./super-admin-usage`).
 * Left out: credits, telephony providers, SIP, bulk dispatch, dispatch lanes.
 *
 * Shapes marked **NEW** are specific to Magick Agency.
 */

import type { Membership, Tenant } from './auth';
import type { Role } from '../../rbac';

// ─── Super-admins and login ─────────────────────────────────────────────────

export interface SuperAdmin {
  id: string;
  email: string;
  name: string;
  status: 'active' | 'inactive';
  is_system: boolean;
  created_at: string;
  updated_at: string;
}

export interface SuperAdminLoginResponse {
  token: string;
  admin: Pick<SuperAdmin, 'id' | 'email' | 'name'>;
}

/** `POST /super-admin/login` — `superAdminLoginSchema`. Rate-limited 5/min. */
export interface SuperAdminLoginBody {
  email: string;
  password: string;
}

/** `POST /super-admin/admins` — `createSuperAdminSchema` (password ≥ 8, name 1..100). */
export interface CreateSuperAdminBody {
  email: string;
  password: string;
  name: string;
}

/** `GET /super-admin/admins`. */
export interface SuperAdminListResponse {
  admins: SuperAdmin[];
}

// ─── Tenants ────────────────────────────────────────────────────────────────

/**
 * There is no `credit_balance` / `credit_reserved`: v1 has no credits.
 */
export interface SuperAdminTenant {
  id: string;
  name: string;
  slug: string;
  status: string;
  settings: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
  member_count: number;
}

export interface SuperAdminTenantMember {
  id: string;
  user_id: string;
  tenant_id: string;
  role: string;
  status: string;
  email: string;
  phone_number: string;
  display_name: string | null;
  avatar_url: string | null;
  user_status: string;
  created_at: string;
}

/**
 * `GET /super-admin/tenants/:id`.
 *
 * There is no `credits` block or credit-cache drift read: v1 has no credit ledger.
 */
export interface SuperAdminTenantDetail {
  tenant: SuperAdminTenant;
  members: SuperAdminTenantMember[];
}

/** `GET /super-admin/tenants`. */
export interface SuperAdminTenantsResponse {
  tenants: SuperAdminTenant[];
}

/** `POST /super-admin/tenants` — `createTenantSchema` (name 1..200, owner_name 1..100). */
export interface CreateTenantBody {
  name: string;
  owner_email: string;
  owner_name?: string;
}

/**
 * The 201 body.
 *
 * The body is `{ tenant, owner_email }`. There is no per-tenant internal-handler
 * API key and no pooled number, so creation writes a `pending_` owner stub and
 * nothing else. `tenant` is the raw tenant row — typed `Tenant`, not
 * `SuperAdminTenant`, which it is not (no `member_count`).
 */
export interface CreateTenantResponse {
  tenant: Tenant;
  owner_email: string;
}

// ─── Users and memberships ──────────────────────────────────────────────────

export interface SuperAdminUser {
  id: string;
  email: string;
  phone_number: string;
  display_name: string | null;
  avatar_url: string | null;
  status: string;
  firebase_uid: string;
  is_pending: boolean;
  created_at: string;
  updated_at: string;
  memberships: Array<{
    tenant_id: string;
    tenant_name: string;
    role: string;
    membership_status: string;
  }>;
}

/** `GET /super-admin/users`. */
export interface SuperAdminUsersResponse {
  users: SuperAdminUser[];
}

/**
 * `POST /super-admin/tenants/:id/users` — `addUserToTenantSchema`.
 *
 * `account_id` is optional: a user can be added to a tenant **or account** with a
 * role. Absent ⇒ tenant-wide. The write
 * creates a `pending_` stub plus membership and sends an invite; the person is
 * later matched by session path 2 (verified email) or by claiming the invite.
 */
export interface AddUserToTenantBody {
  email: string;
  role: Role;
  name?: string;
  account_id?: string;
}

/** The 201 body. */
export interface AddUserToTenantResponse {
  membership: Membership;
}

/**
 * **NEW** — `PUT /super-admin/tenants/:id/memberships/:membershipId/role`.
 * Super-admins can also change roles (the tenant-side `PUT /users/:id/role`
 * floors at `user.update_role`).
 */
export interface ChangeMembershipRoleBody {
  role: Role;
  /** Recorded on the super-admin audit row. */
  reason?: string;
}

export interface ChangeMembershipRoleResponse {
  membership: Membership;
}

/**
 * **NEW** — `DELETE /super-admin/tenants/:id/memberships/:membershipId`.
 * Super-admins can also revoke memberships; offboarding closes the person's
 * campaign staffing in the same place.
 */
export interface RevokeMembershipResponse {
  /** The row after the write; `status` is `'revoked'`. */
  membership: Membership;
  /** Campaign assignments closed by the same write. */
  staffing_closed: number;
}

// ─── Super-admin audit ──────────────────────────────────────────────────────

export interface SuperAdminAuditEntry {
  id: string;
  admin_id: string;
  admin_email: string;
  action: string;
  resource_type: string;
  resource_id: string | null;
  details: Record<string, unknown>;
  created_at: string;
}

export interface SuperAdminAuditListParams {
  limit?: number;
  offset?: number;
  actor?: string;
  action?: string;
  resource_type?: string;
  resource_id?: string;
  q?: string;
  from?: string;
  to?: string;
}

export interface SuperAdminAuditListResponse {
  entries: SuperAdminAuditEntry[];
  total: number;
  actions: string[];
}

// ─── Phone numbers (agency's one VoiceLink account) ─────────────────────────
//
// Campaign `caller_ids` are validated against this inventory when a campaign is
// saved.

/**
 * There is no `pool_eligible` flag: Magick Agency has no signup pool and no
 * pooled number. `provider_*` is kept
 * (it is how the row names its carrier) although only VoiceLink can appear.
 */
export interface PhoneNumber {
  id: string;
  phone_number: string;
  provider_id: string;
  provider_name: string;
  provider_display_name: string;
  label: string | null;
  capabilities: string[];
  region: string | null;
  max_concurrent_calls: number;
  status: 'active' | 'retired' | 'deleted';
  notes: string | null;
  created_at: string;
  updated_at: string;
  assignment_count?: number;
}

/**
 * There is no `is_byoc`: bring-your-own carrier is out of scope (VoiceLink is
 * the only carrier).
 */
export interface TenantPhoneAssignment {
  id: string;
  phone_number: string;
  phone_number_id: string;
  provider_name: string;
  provider_display_name: string;
  label: string | null;
  is_default: boolean;
  max_concurrent_calls: number;
  capabilities: string[];
  region: string | null;
  account_tags?: Array<{
    account_id: string;
    account_name: string;
    is_default: boolean;
  }>;
}

/** `GET /super-admin/phone-numbers?status=`. */
export interface PhoneNumbersResponse {
  phone_numbers: PhoneNumber[];
}

/** `GET /super-admin/phone-numbers/:id`. */
export interface PhoneNumberDetailResponse {
  phone_number: PhoneNumber;
  assignments: Array<{ tenant_id: string; tenant_name: string; is_default: boolean; assigned_at: string }>;
}

/**
 * `POST /super-admin/phone-numbers`.
 */
export interface CreatePhoneNumberBody {
  phone_number: string;
  provider_id: string;
  label?: string;
  region?: string;
  max_concurrent_calls: number;
  capabilities?: string[];
}

/**
 * `PUT /super-admin/phone-numbers/:id`.
 */
export interface UpdatePhoneNumberBody {
  label?: string;
  notes?: string;
  max_concurrent_calls?: number;
}

/** `POST /super-admin/phone-numbers/:id/assign`. */
export interface AssignPhoneNumberBody {
  tenant_id: string;
  is_default?: boolean;
}

/** `GET /super-admin/tenants/:id/phone-numbers`. */
export interface TenantPhoneNumbersResponse {
  phone_numbers: TenantPhoneAssignment[];
}

// ─── Per-account concurrency limits ─────────────────────────────────────────
//
// Agency is both system of record and enforcer of concurrency allocations, and
// the guard keeps its global, account and provider scopes.

export type ConcurrencyAllocationMode = 'legacy_total' | 'provider_breakdown';

export interface ProviderConcurrencyAllocation {
  provider: string;
  max_concurrent_calls: number;
}

export interface AccountConcurrencyAllocation {
  tenant_id: string;
  account_id: string;
  mode: ConcurrencyAllocationMode;
  version: number;
  total_concurrency: number;
  providers: ProviderConcurrencyAllocation[];
}

export interface AccountConcurrencyUtilization {
  mode: ConcurrencyAllocationMode;
  version: number;
  status: 'available' | 'unavailable';
  observed_at: string;
  total: { allocated: number; in_use: number | null; available: number | null };
  providers: Array<ProviderConcurrencyAllocation & {
    allocated: number;
    in_use: number | null;
    available: number | null;
    over_limit: number | null;
    saturated: boolean | null;
    draining: boolean;
  }>;
}

/**
 * `GET /super-admin/tenants/:id/accounts/:accountId/concurrency`.
 *
 * There is no provider catalog, no purchased-quantity `entitlements` and no
 * `synchronization` status: there is one carrier, no billing, and no second
 * service to sync to.
 */
export interface AccountConcurrencyDetail {
  allocation: AccountConcurrencyAllocation;
  utilization: AccountConcurrencyUtilization | null;
}

/** `GET /super-admin/tenants/:id/accounts` row. */
export interface TenantAccountWithConcurrency {
  id: string;
  name: string;
  slug: string;
  status: string;
  max_concurrent_calls: number | null;
  concurrency_status?: 'available' | 'unavailable';
  concurrency?: AccountConcurrencyAllocation;
}

/**
 * `PUT /super-admin/tenants/:id/accounts/:accountId/concurrency` — the public API layer's two
 * accepted bodies: the legacy flat total
 * (1..1000), or the versioned allocation (`legacy_total` / `provider_breakdown`,
 * optimistic-lock `version`, `change_reason` 3..1000 chars).
 *
 * `force_migration` (the legacy→breakdown migration switch) is a candidate for
 * deletion with the provider breakdown if agency settles on one carrier for good.
 */
export type UpdateAccountConcurrencyBody =
  | { max_concurrent_calls: number }
  | { mode: 'legacy_total'; version: number; max_concurrent_calls: number; change_reason: string }
  | {
      mode: 'provider_breakdown';
      version: number;
      providers: ProviderConcurrencyAllocation[];
      change_reason: string;
      force_migration?: boolean;
    };

// ── Feature flags ────────────────────────────────────────

export type FlagScopeType = 'global' | 'tenant' | 'account';
export type FlagValueType = 'boolean' | 'number' | 'string' | 'json';

/**
 * The public API layer's handling policy for a flag that needs more than a toggle
 * (the flag-policies registry). Present only on the
 * few flags that have one — today `ai_turn_transcript_logging`. The public API layer also
 * ENFORCES it (bulk refused, enable without a reason refused); the UI reads it
 * so the warning and the missing bulk affordance come from data, not a second
 * hand-kept list. Absent from an older public API layer: render the flag as ordinary.
 */
export interface FeatureFlagPolicy {
  /** Operator-facing warning shown next to every control for the flag. */
  warning: string;
  /** False ⇒ never offer the flag in a cross-tenant bulk rollout. */
  bulk_allowed: boolean;
  /** True ⇒ switching it ON needs a reason (the UI already asks for one on every override). */
  reason_required_to_enable: boolean;
}

/** One entry in the registry catalog (GET /super-admin/feature-flags). */
export interface FeatureFlagCatalogEntry {
  key: string;
  type: FlagValueType;
  default: unknown;
  env_default: unknown;
  scopes: FlagScopeType[];
  client_exposed: boolean;
  owner: string;
  description: string;
  global_override: unknown;
  /** Added by the public API layer for flags with a handling policy; absent otherwise. */
  policy?: FeatureFlagPolicy;
}

export interface FeatureFlagCatalogResponse {
  flags: FeatureFlagCatalogEntry[];
}

/** A persisted override row. */
export interface FeatureFlagOverride {
  id: string;
  flag_key: string;
  scope_type: FlagScopeType;
  tenant_id: string | null;
  account_id: string | null;
  value: unknown;
  reason: string | null;
  expires_at: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
}

/** Which layer a resolved value came from (the server's /resolve `source`). */
export type FlagResolutionSource = 'account' | 'tenant' | 'global' | 'env' | 'default' | 'rollout';

/** Effective resolution for a tenant/account (GET …/feature-flags/resolve). */
export interface FeatureFlagResolveResponse {
  tenant_id: string;
  account_id: string | null;
  effective: Record<string, unknown>;
  /** Per-flag winning layer, so the UI can attribute the inherited default precisely. */
  source: Record<string, FlagResolutionSource>;
  defaults: Record<string, unknown>;
  overrides: FeatureFlagOverride[];
}

export interface UpsertFlagOverrideBody {
  scope_type: FlagScopeType;
  tenant_id?: string;
  account_id?: string;
  value: unknown;
  reason?: string | null;
  expires_at?: string | null;
}

export interface DeleteFlagOverrideBody {
  scope_type: FlagScopeType;
  tenant_id?: string;
  account_id?: string;
}

export interface BulkFlagOverrideResult {
  applied: string[];
  failed: Array<{ tenant_id: string; error: string }>;
}
