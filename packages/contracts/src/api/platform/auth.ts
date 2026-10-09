/**
 * Identity, tenancy and the session payload.
 */

import type { Role } from '../../rbac';
import type { AgencyAccountSettingsMap } from './settings';

// `Role` is declared once, in `../../rbac`, and re-exported so this file's
// consumers can import it from here.
export type { Role } from '../../rbac';

export interface User {
  id: string;
  firebase_uid: string;
  email: string;
  display_name: string | null;
  avatar_url: string | null;
  status: 'active' | 'inactive' | 'deleted';
  created_at: string;
  updated_at: string;
}

export interface Tenant {
  id: string;
  name: string;
  slug: string;
  settings: Record<string, unknown>;
  status: 'active' | 'suspended' | 'deleted';
  created_at: string;
  updated_at: string;
}

export interface Account {
  id: string;
  tenant_id: string;
  name: string;
  slug: string;
  settings: Record<string, unknown>;
  status: 'active' | 'suspended' | 'deleted';
  created_at: string;
  updated_at: string;
}

/**
 * An account as the **tenant switcher** knows it, which is not always a whole
 * `Account`.
 *
 * `GET /accounts` returns full rows and floors at `account.read` (`viewer`, 10).
 * The Agency Dialer's `agent` role is deliberately 5, below that floor, so an
 * agent 403s and falls back to `GET /accounts/mine` — which answers `{id, name,
 * tenant_id}` and deliberately nothing more, because it skips the permission
 * check and must not become a way to read a tenant's account configuration
 * without one.
 *
 * Modelled as "the three fields always, the rest maybe" rather than as two
 * unrelated types: every consumer that only needs to name and select an account
 * (`AccountSwitcher`, `AgencyLayout`) is unaffected, while the one screen that
 * reads `slug` is forced by the compiler to admit it may not have it.
 */
export type TenantAccount = Pick<Account, 'id' | 'name' | 'tenant_id'> &
  Partial<Omit<Account, 'id' | 'name' | 'tenant_id'>>;

// There are no tenant-level service settings (AI pipelines, carrier choice, a
// tenant-level recording default): recording is per account (`./settings`).

/**
 * `GET /accounts` (floor `account.read`).
 */
export interface AccountsListResponse {
  accounts: Account[];
}

/**
 * `GET /accounts/mine`. Authentication
 * only, NO permission check, membership-scoped (every account in the tenant for
 * a tenant-wide membership), three fields per row, refused for a platform API
 * key. This is what an `agent` (level 5, below `account.read`) bootstraps from.
 */
export interface MyAccountsResponse {
  accounts: Array<Pick<Account, 'id' | 'name' | 'tenant_id'>>;
}

// `agent` is the Agency Dialer role. It sits BELOW `viewer` in ROLE_LEVELS
// so it grants nothing that predates the agency feature. See `ROLE_HIERARCHY` in
// `../../rbac`, the one place the levels are declared.

export interface Membership {
  id: string;
  user_id: string;
  tenant_id: string;
  account_id: string | null;
  role: Role;
  status: 'active' | 'inactive' | 'revoked';
  invited_by: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * `POST /auth/session` (paths 1–3) and `POST /invites/:token/claim` — the same
 * body, byte-identical, so the console uses one type for both.
 *
 *   1. `settings: AgencyAccountSettingsMap` carries the per-account settings of
 *      every account the memberships reach, keyed by account id.
 *   2. `is_new` is the literal `false`. A brand-new user (no tenant, no
 *      membership) is REFUSED with 403 `no_membership`, so an `is_new: true`
 *      body cannot occur.
 *   3. There is no `needs_phone` or `default_account`: both belong to the
 *      self-signup path, which does not exist.
 */
export interface SessionResponse {
  user: User;
  tenants: Tenant[];
  memberships: Membership[];
  is_new: false;
  settings: AgencyAccountSettingsMap;
}

/**
 * `GET /auth/me`. Carries `settings`, as on {@link SessionResponse}.
 */
export interface MeResponse {
  user: User;
  tenants: Tenant[];
  memberships: Membership[];
  settings: AgencyAccountSettingsMap;
}

/** `POST /auth/session` request — the public API layer `auth.validator.ts` (`sessionRequestSchema`). */
export interface SessionRequest {
  id_token: string;
  /**
   * The public API layer accepts an optional `phone_number` (min 10) and writes
   * it on path 1 over the `'0000000000'` placeholder. Candidate deletion if
   * agency drops `users.phone_number`.
   */
  phone_number?: string;
}

/**
 * Why `POST /auth/session` refused to sign someone in.
 *
 * - `email_unverified`
 *   (`EMAIL_UNVERIFIED_CODE`): an unverified token on a UID miss. Path 1 (the uid
 *   is already bound) deliberately admits an unverified user; nothing else does.
 * - `no_membership` — NEW: path 4, a verified identity agency has no
 *   user, stub or invite for. Agency has no self-serve sign-up.
 */
export type SessionRefusalCode = 'email_unverified' | 'no_membership';

export const SESSION_REFUSAL_CODES = [
  'email_unverified',
  'no_membership',
] as const satisfies readonly SessionRefusalCode[];

type MissingSessionRefusalCode = Exclude<
  SessionRefusalCode,
  (typeof SESSION_REFUSAL_CODES)[number]
>;
const _allSessionRefusalCodesListed: MissingSessionRefusalCode extends never
  ? true
  : MissingSessionRefusalCode = true;
void _allSessionRefusalCodesListed;

/** The 403 body. Shape follows the public API layer's. */
export interface SessionRefusal {
  error: 'Forbidden';
  code: SessionRefusalCode;
  message: string;
}

export interface TenantMember {
  membership: Membership;
  user: User;
}
