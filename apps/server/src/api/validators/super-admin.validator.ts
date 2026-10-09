import { z } from 'zod';
import {
  WEBRTC_MAX_DURATION_MAX_SECONDS,
  WEBRTC_MAX_DURATION_MIN_SECONDS,
} from '../../settings/agency-account-settings.js';

export const superAdminLoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export const createSuperAdminSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  name: z.string().min(1).max(100),
});

export const createTenantSchema = z.object({
  name: z.string().min(1).max(200),
  owner_email: z.string().email(),
  owner_name: z.string().min(1).max(100).optional(),
});

/**
 * The assignable role list, a const so the role-change schema below uses the
 * same six (the set `ROLES` in `@magick-agency/contracts/rbac` names).
 */
const membershipRoleSchema = z.enum(['tenant_owner', 'tenant_admin', 'account_admin', 'operator', 'viewer', 'agent']);

export const addUserToTenantSchema = z.object({
  email: z.string().email(),
  // `agent` (Agency Dialer) — below `viewer` in ROLE_HIERARCHY, so
  // assigning it grants nothing that predates the agency feature.
  role: membershipRoleSchema,
  name: z.string().min(1).max(100).optional(),
  /**
   * Add a user to a tenant **or account** (contract
   * `AddUserToTenantBody.account_id`). Absent ⇒ a tenant-wide membership.
   * `.uuid()` because `accounts.id` is a UUID column and a malformed id would
   * otherwise reach Postgres as `22P02` (a 500 for a bad request).
   */
  account_id: z.string().uuid().optional(),
});

// No credit schemas: there are no credits in v1 (decision S6).

export const changePasswordSchema = z.object({
  current_password: z.string().min(1, 'Current password is required'),
  new_password: z.string().min(8, 'New password must be at least 8 characters'),
});

export const resetAdminPasswordSchema = z.object({
  admin_password: z.string().min(1, 'Your password is required'),
  new_password: z.string().min(8, 'New password must be at least 8 characters'),
});

/**
 * Super-admin audit search. `.strict()` so a misspelled filter cannot silently
 * vanish and return an unfiltered page that looks like a valid empty result.
 */
export const superAdminAuditQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  actor: z.string().min(1).max(200).optional(),
  action: z.string().min(1).max(100).optional(),
  resource_type: z.string().min(1).max(100).optional(),
  resource_id: z.string().min(1).max(200).optional(),
  q: z.string().min(1).max(200).optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
}).strict();

/**
 * `PUT /super-admin/tenants/:id/memberships/:membershipId/role` (contract
 * `ChangeMembershipRoleBody`). The role set is the add-user one: a super admin
 * may assign any of the six, including `tenant_owner` (the tenant-side route
 * cannot). `reason` is recorded on the super-admin audit row; its bound is the
 * flag-override `reason`'s (500).
 */
export const changeMembershipRoleSchema = z.object({
  role: membershipRoleSchema,
  reason: z.string().max(500).optional(),
});

/**
 * `PUT /super-admin/tenants/:tenantId/accounts/:accountId/settings` (contract
 * `UpdateAgencyAccountSettingsBody`). A PATCH: an omitted field keeps its value. `.strict()` so the one field this
 * route deliberately does NOT write — `max_concurrent_calls`, which belongs to
 * the concurrency route so the guard's invalidation has one writer — is a 400
 * rather than silently ignored.
 *
 * `webrtc_max_duration_seconds` is an integer in 60..14400.
 * At least one setting must be present: an empty PATCH would write nothing and
 * audit a change that did not happen.
 */
export const updateAgencyAccountSettingsSchema = z.object({
  allow_recording: z.boolean().optional(),
  analyze_calls: z.boolean().optional(),
  webrtc_max_duration_seconds: z.number().int()
    .min(WEBRTC_MAX_DURATION_MIN_SECONDS)
    .max(WEBRTC_MAX_DURATION_MAX_SECONDS)
    .optional(),
  reason: z.string().max(500).optional(),
}).strict().refine(
  (body) => body.allow_recording !== undefined
    || body.analyze_calls !== undefined
    || body.webrtc_max_duration_seconds !== undefined,
  { message: 'At least one of allow_recording, analyze_calls, webrtc_max_duration_seconds is required' },
);

/**
 * `GET /super-admin/usage` (contract `UsageCountsQuery`). `[from, to)` on
 * `agency_call_attempts.dialed_at`.
 * The ids are UUID columns, so they are validated as UUIDs here rather than
 * reaching Postgres as `22P02`. The window refinement parses dates only after
 * guarding them: `.refine` runs on a dirty result when `.datetime()` failed.
 */
/**
 * The widest `[from, to)` the usage-counts read accepts.
 * The read range-scans `idx_agency_attempts_billing` over the whole window across
 * every campaign; bounding it keeps one request from scanning the table's whole
 * history. A little over a year, so a full calendar year (366 days) fits.
 */
export const USAGE_COUNTS_MAX_WINDOW_DAYS = 400;

export const usageCountsQuerySchema = z.object({
  from: z.string().datetime({ offset: true }),
  to: z.string().datetime({ offset: true }),
  tenant_id: z.string().uuid().optional(),
  account_id: z.string().uuid().optional(),
}).strict().refine(
  (q) => q.account_id === undefined || q.tenant_id !== undefined,
  { message: 'account_id requires tenant_id', path: ['account_id'] },
).refine(
  (q) => {
    const from = typeof q.from === 'string' ? Date.parse(q.from) : NaN;
    const to = typeof q.to === 'string' ? Date.parse(q.to) : NaN;
    if (Number.isNaN(from) || Number.isNaN(to)) return true; // `.datetime()` already reported it
    return from < to;
  },
  { message: '`from` must be before `to`', path: ['to'] },
).refine(
  (q) => {
    const from = typeof q.from === 'string' ? Date.parse(q.from) : NaN;
    const to = typeof q.to === 'string' ? Date.parse(q.to) : NaN;
    if (Number.isNaN(from) || Number.isNaN(to)) return true; // reported above
    return to - from <= USAGE_COUNTS_MAX_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  },
  { message: `The window may span at most ${USAGE_COUNTS_MAX_WINDOW_DAYS} days`, path: ['to'] },
);
