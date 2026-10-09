/**
 * Identity, tenancy and the session payload.
 *
 * Ported from `magick-comms-cusui/src/types/auth.ts` (cusui v2.96.0,
 * ee5beb4400ec1fb5fdf6049871681ae6875e8d29) and checked against master's
 * producers: `src/api/routes/auth.routes.ts`, `src/auth/session-payload.ts`,
 * `src/api/routes/account.routes.ts` (master v3.24.0, a1f0756a…). Changes are
 * marked `PORT NOTE`.
 */

import type { Role } from '../../rbac';
import type { AgencyAccountSettingsMap } from './settings';

// PORT NOTE (magick-agency): cusui declared `Role` here as a hand mirror of
// master's `MembershipRole`. It is now declared once, in `../../rbac`, and
// re-exported so this file's consumers keep importing it from here.
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

// PORT NOTE (magick-agency): cusui's `TenantServiceSettings`
// (`allowed_pipelines`, `allowed_providers`, `default_pipeline`,
// `default_provider`, `enable_recording`) is removed — AI pipelines, carrier
// choice and the tenant-level recording default are not Magick Agency settings;
// recording is per account (`./settings`).

/**
 * `GET /accounts` (floor `account.read`) — master `account.routes.ts:88-96`.
 * PORT NOTE (magick-agency): NEW declaration; cusui typed this inline in
 * `src/api/accounts.ts`.
 */
export interface AccountsListResponse {
  accounts: Account[];
}

/**
 * `GET /accounts/mine` — master `account.routes.ts:138-175`. Authentication
 * only, NO permission check, membership-scoped (every account in the tenant for
 * a tenant-wide membership), three fields per row, refused for a platform API
 * key. This is what an `agent` (level 5, below `account.read`) bootstraps from.
 * PORT NOTE (magick-agency): NEW declaration; cusui typed this inline.
 */
export interface MyAccountsResponse {
  accounts: Array<Pick<Account, 'id' | 'name' | 'tenant_id'>>;
}

// `agent` is the Agency Dialer role. It sits BELOW `viewer` in ROLE_LEVELS
// (`src/utils/permissions.ts`), so it grants nothing that predates the agency
// feature. Hand-maintained mirror of master's `MembershipRole` — keep in
// lockstep with `magick-master/src/db/models/membership.model.ts`.
// PORT NOTE (magick-agency): no longer a mirror — see `ROLE_HIERARCHY` in
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
 * body, byte-identical, so the console uses one type for both (master
 * `session-payload.ts`, `buildSessionPayload`).
 *
 * PORT NOTE (magick-agency), three changes from cusui's `SessionResponse`:
 *   1. `governance: Record<string, boolean>` → `settings: AgencyAccountSettingsMap`
 *      (plan §3.2: one per-account settings row instead of governance).
 *      Governance was resolved for `memberships[0]` only; `settings` carries
 *      every account the memberships reach, keyed by account id.
 *   2. `is_new` is the literal `false`. Path 4 (brand-new user → auto-provisioned
 *      tenant, pooled number, signup credits) is REFUSED in Magick Agency with
 *      403 `no_membership` (plan §3.1), so master's `is_new: true` body cannot
 *      occur.
 *   3. `needs_phone` and `default_account` are removed — both were produced only
 *      by path 4 (master `auth.routes.ts:343-352`), as was the uncaptured
 *      `signup_bonus_credits`.
 */
export interface SessionResponse {
  user: User;
  tenants: Tenant[];
  memberships: Membership[];
  is_new: false;
  settings: AgencyAccountSettingsMap;
}

/**
 * `GET /auth/me`. PORT NOTE (magick-agency): `governance` → `settings`, as on
 * {@link SessionResponse}.
 */
export interface MeResponse {
  user: User;
  tenants: Tenant[];
  memberships: Membership[];
  settings: AgencyAccountSettingsMap;
}

/** `POST /auth/session` request — master `auth.validator.ts` (`sessionRequestSchema`). */
export interface SessionRequest {
  id_token: string;
  /**
   * PORT NOTE (magick-agency): master accepts an optional `phone_number` (min 10)
   * and writes it on path 1 over the `'0000000000'` placeholder. Kept because
   * path 1 is ported unchanged; candidate deletion if agency drops
   * `users.phone_number`.
   */
  phone_number?: string;
}

/**
 * Why `POST /auth/session` refused to sign someone in.
 *
 * - `email_unverified` — master `auth/session-email.ts:48`
 *   (`EMAIL_UNVERIFIED_CODE`): an unverified token on a UID miss. Path 1 (the uid
 *   is already bound) deliberately admits an unverified user; nothing else does.
 * - `no_membership` — NEW (plan §3.1): path 4, a verified identity agency has no
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

/** The 403 body. Shape follows master's (`auth.routes.ts:133-137`). */
export interface SessionRefusal {
  error: 'Forbidden';
  code: SessionRefusalCode;
  message: string;
}

export interface TenantMember {
  membership: Membership;
  user: User;
}
