/**
 * Roles and permissions — ONE source for the server and both UIs.
 *
 * The server and both UIs import this module, so there is no hand-kept mirror —
 * and none of the class of bug where the UI shows a control the API 403s, or
 * hides one it would allow.
 *
 * The permission set is limited to what Magick Agency uses; the agency
 * permissions carry `agency.` names.
 */

import type { AllListed } from './primitives';

/**
 * The six membership roles, declared once and shared by the server and both UIs.
 */
export type Role =
  | 'tenant_owner'
  | 'tenant_admin'
  | 'account_admin'
  | 'operator'
  | 'viewer'
  | 'agent';

/** The public API layer's name for the same union. */
export type MembershipRole = Role;

/**
 * Role hierarchy: higher number = more authority.
 *
 * `agent` (Agency Dialer) is deliberately placed at 5 — BELOW
 * `viewer`. The hierarchy is linear and PERMISSION_MATRIX maps each permission
 * to a *minimum* role, so a floor of `viewer` (10) or higher is unreachable at
 * level 5. Every permission that predates the agency feature floors at `viewer`
 * or above, which means an `agent` membership grants access to exactly the five
 * agent-floored `agency.*` action permissions below (the four station ones and
 * `agency.softphone.dial`), PLUS `agency.flags.read`, and to nothing else — no campaign list, no analytics, no contacts, no recordings, and no
 * other `/proxy/*` route. That is the design, not an oversight: agent actions
 * get agency-native routes that can additionally verify the caller is the
 * reserved agent for the attempt.
 *
 * The flag map is the single exception, and it is not a softening of the rule —
 * it is the read the rule forgot. the console must resolve it before it can render
 * ANY flag-gated route, so while it floored at `viewer` an agent was locked out
 * of the very product the action permissions exist to run. See its matrix
 * entry. `test/unit/rbac/roles.agent.test.ts` pins both halves.
 *
 * Do not raise this number to "make something work" — raising it silently grants
 * an agent every viewer-floored read on the platform.
 *
 * The pin is `test/rbac.test.ts`.
 */
export const ROLE_HIERARCHY: Record<MembershipRole, number> = {
  agent: 5,
  viewer: 10,
  operator: 20,
  account_admin: 30,
  tenant_admin: 40,
  tenant_owner: 50,
};

/** Every role, lowest first. */
export const ROLES = [
  'agent',
  'viewer',
  'operator',
  'account_admin',
  'tenant_admin',
  'tenant_owner',
] as const satisfies readonly Role[];

const _allRolesListed: AllListed<Role, typeof ROLES> = true;
void _allRolesListed;

export type Permission =
  // ── Platform permissions Magick Agency keeps, names unchanged ──────────────
  | 'tenant.read'
  | 'account.read'
  | 'user.invite' | 'user.update_role' | 'user.remove'
  | 'audit.read'
  // ── Renamed to agency names (the public API layer's name → here), floors unchanged ──────
  //   proxy.feature_flags.read   → agency.flags.read
  //   proxy.contact_lists.read   → agency.campaigns.read
  //   proxy.contact_lists.write  → agency.campaigns.write
  //   proxy.prompts.read         → agency.analysis_profiles.read
  //   proxy.prompts.write        → agency.analysis_profiles.write
  //   proxy.phone_numbers.read   → agency.phone_numbers.read
  // The client-exposed feature-flag map. Floors at `agent` — the only non-action
  // permission that does. See the matrix entry.
  | 'agency.flags.read'
  // Campaign reads (list, detail, stats, roster, analytics) and writes (create,
  // PATCH, roster upload).
  | 'agency.campaigns.read'
  | 'agency.campaigns.write'
  // Call-analysis profiles (CRUD).
  | 'agency.analysis_profiles.read'
  | 'agency.analysis_profiles.write'
  // The tenant's assigned caller IDs (`GET /phone-numbers`, the campaign
  // builder's caller-ID picker).
  | 'agency.phone_numbers.read'
  // Agency Dialer. The four agent-scoped permissions floor at
  // `agent`, so supervisors and admins inherit them and can take calls
  // themselves to cover or demo — desirable, not a leak.
  | 'agency.station.connect'
  | 'agency.attempts.handle'
  | 'agency.attempts.dispose'
  | 'agency.dnc.write'
  // Supervisory. Floors at `account_admin`, so an `agent` cannot reach it and
  // neither can an `operator` — see the matrix note below.
  | 'agency.supervise'
  // The DNC list as a MANAGED OBJECT, distinct from `agency.dnc.write` above.
  // `agency.dnc.write` is attempt-scoped: it suppresses the one number on the
  // agent's own line, and the dialer runtime verifies they are that attempt's reserved agent.
  // These two are number-scoped and list-scoped, so neither floors at `agent`.
  | 'agency.dnc.read'
  | 'agency.dnc.manage'
  // The soft phone (`docs/softphone.md`): dialling a typed number outside pacing,
  // and the account's soft-phone settings.
  | 'agency.softphone.dial'
  | 'agency.softphone.manage';

/** Minimum role required for each permission */
export const PERMISSION_MATRIX: Record<Permission, MembershipRole> = {
  // Behind `GET /tenants/:id/members` (the team page).
  'tenant.read': 'viewer',
  // Behind `GET /accounts` (full rows). NOTE:
  // `GET /accounts/mine` itself carries NO permission check in the public API layer — it is
  // membership-scoped and returns `{id, name, tenant_id}` only — which is how an
  // `agent` (below this floor) resolves its account (`TenantContext.tsx`).
  'account.read': 'viewer',
  'user.invite': 'account_admin',
  'user.update_role': 'tenant_admin',
  'user.remove': 'tenant_admin',
  // Supervisors (`account_admin`) read the trail they write. Rows are
  // account-scoped in `platform_audit_log` so this does not leak sibling accounts.
  'audit.read': 'account_admin',
  // ── The feature-flag map ─────────────────────────────────────────────────
  // Floored at `agent`, and the ONLY non-`agency.*` permission that is. Read the
  // hierarchy comment above first: this is not a relaxation of the "four
  // agent-scoped permissions and nothing else" rule, it is the read that rule overlooked.
  //
  // The route returns the client-exposed FLAG MAP, which the console must fetch before
  // it can render any flag-gated route. It used to carry `proxy.stats.read`
  // (floor `viewer`, level 10). An `agent` is level 5, so EVERY dedicated agent
  // got a 403 here — and the console's `FeatureFlagsContext` is fail-safe closed, so an
  // errored map resolves every flag to `false`. That drove `RequireFlag
  // flag="agency_dialer_enabled"` — which wraps all four agent routes
  // (`/dialer`, `/station`, `/dialer/performance`, `/dialer/attempts`) — into its
  // refusal state, under copy blaming the tenant's billing plan for what was an
  // RBAC floor.
  //
  // Net effect before this changed: the one role the Agency Dialer exists for
  // could not open any part of it, while `operator` and above never noticed
  // because they clear the `viewer` floor. That is why it shipped — every human
  // who tested the dialer held a role above the gate.
  //
  // Its OWN permission rather than lowering `proxy.stats.read`, which is shared
  // with the dialer runtime stats lane and must stay at `viewer`: an agent has no business
  // reading tenant call statistics, and widening that floor would grant exactly
  // the access the hierarchy comment forbids.
  //
  // Safe at this floor because the response is a per-tenant/account map of
  // boolean rollout switches — no customer data, no counts, no ids. The
  // disclosure is not literally nil: an agent learns which capabilities the
  // tenant has bought. It is judged acceptable rather than absent, and saying so
  // is the honest form — a dedicated agent renders almost no screens, so
  // "they could infer it anyway" would be the wrong argument to lean on.
  //
  // The name starts `agency.`, but it is not an ACTION permission — the four
  // below and `agency.softphone.dial` remain the only ones of those.
  'agency.flags.read': 'agent',
  'agency.campaigns.read': 'viewer',
  'agency.campaigns.write': 'account_admin',
  'agency.analysis_profiles.read': 'viewer',
  'agency.analysis_profiles.write': 'account_admin',
  // There is no manage permission for phone numbers: number inventory and
  // assignment are super-admin-only.
  'agency.phone_numbers.read': 'viewer',
  // ── Agency Dialer ────────────────────────────────────────────────────────
  // These four, with `agency.softphone.dial` below, are the only agency ACTION
  // permissions floored at `agent` — and, with `agency.flags.read` above, the
  // only `agent`-floored permissions at all. The distinction is worth keeping:
  // these authorise doing something to a live call, that one authorises reading
  // the boolean map the SPA needs to render. Each corresponds to an action an agent takes on the
  // call currently on their own station; the dialer runtime
  // additionally verifies the caller is that attempt's reserved agent, an
  // ownership check the generic `/proxy/webrtc-call/:id/end` route cannot
  // express (it floors at `operator`, so an agent cannot reach it at all).
  'agency.station.connect': 'agent', // open a station socket, join a campaign
  'agency.attempts.handle': 'agent', // receive a bridged call, hang up
  'agency.attempts.dispose': 'agent', // disposition, notes, schedule callback
  'agency.dnc.write': 'agent', // mark the contact on the line as do-not-call
  // Supervisory. Distinct from the four above in kind, not just in floor: it
  // authorises acting on an attempt reserved by *somebody else*, so the public API layer sets
  // the dialer runtime's `on_behalf` flag from it (`src/agency/agency-actor.ts`) and the
  // resulting disposition is filed against a customer under one person's name
  // while a different person chose it.
  //
  // FLOOR IS `account_admin` (30), per the dialer design and the frozen contract
  // in `./agency`, which agree. An `operator` is 20 and cannot hold this; an older
  // backlog note suggesting an `operator` can disposition on an agent's behalf
  // predates `on_behalf` and is stale. Lowering a supervisory floor is not a
  // change to make silently.
  'agency.supervise': 'account_admin',
  // ── The DNC list surface ──────────────────────────────────
  // Deliberately NOT floored at `agent`, and the two floors differ from each
  // other, because the two directions are not symmetric risks:
  //
  //  - READ floors at `viewer`. The list is every customer who asked not to be
  //    contacted; an agent has no reason to browse it, and agents get exactly
  //    four permissions on purpose. Reading it is a supervisory act.
  //  - MANAGE floors at `account_admin` and covers ADD (bulk/arbitrary numbers)
  //    and DELETE. Delete is the compliance-dangerous direction: it makes a
  //    number dialable again. Adding over-blocks at worst — safe, and still
  //    wrong — while removing UNDER-blocks, which is the regulatory event this
  //    whole feature exists to prevent. `agency.dnc.write` at `agent` cannot
  //    reach either: an agent can suppress the number in front of them and
  //    nothing else.
  'agency.dnc.read': 'viewer',
  'agency.dnc.manage': 'account_admin',
  // ── The soft phone ───────────────────────────────────────────────────────
  // DIAL floors at `agent`: every agent in an account where
  // `agency_softphone_enabled` is on gets the soft phone, with no per-agent
  // switch (SP4, Manas 2026-10-30). It is the fifth agent-floored ACTION
  // permission, and like the four above it acts only on the caller's own
  // session and calls: the dialer runtime checks the manual call's session is
  // the caller's, and acting on someone else's call (an outcome on behalf, the
  // account-wide list) needs `agency.supervise` as well. So does hearing or reading a
  // call's media, even the caller's own: a soft-phone call's recording, transcript
  // and AI analysis are supervise-only, as a campaign call's are (no recordings, no
  // analytics, above); DIAL reads the call record only. Every soft-phone route
  // that STARTS work (a new soft-phone session, a dial, the switch from a campaign)
  // also requires the `agency_softphone_enabled` flag, as do the recording and the
  // settings, so the floor alone starts nothing in an account that has not turned
  // the feature on. The routes that FINISH work already started (call details,
  // hang-up, the outcome, Mark DNC, reading the calls, Return to campaign,
  // rehydrating an existing session) are not gated, so an agent is never
  // stranded mid-call when the flag goes off (docs/softphone.md §6).
  //
  // MANAGE floors at `account_admin`: the settings it writes (the untagged
  // outcome catalog, call fields, recording, the default caller ID) apply to
  // every agent's calls in the account, which is a supervisory change. Reading
  // them is part of DIAL: the soft phone cannot render without its call fields.
  'agency.softphone.dial': 'agent',
  'agency.softphone.manage': 'account_admin',
};

/** Every permission, for enumeration (tests, route tables, admin screens). */
export const PERMISSIONS = Object.keys(PERMISSION_MATRIX) as Permission[];

/**
 * Check if a role has sufficient authority for a permission.
 *
 * Fails CLOSED on a missing role (a console that has not resolved a membership
 * yet must show nothing privileged), so it accepts `undefined`/`null` and an unknown
 * runtime string, and answers `false` for all three. For every real role the
 * answer is whether its level reaches the permission's floor.
 */
export function hasPermission(
  userRole: MembershipRole | null | undefined,
  permission: Permission,
): boolean {
  if (!userRole) return false;
  const userLevel = ROLE_HIERARCHY[userRole] as number | undefined;
  if (userLevel === undefined) return false;
  const requiredRole = PERMISSION_MATRIX[permission];
  return userLevel >= ROLE_HIERARCHY[requiredRole];
}

/** Check if roleA can manage roleB (must be strictly higher) */
export function canManageRole(managerRole: MembershipRole, targetRole: MembershipRole): boolean {
  return ROLE_HIERARCHY[managerRole] > ROLE_HIERARCHY[targetRole];
}

/**
 * Whether an invitation for `role` may be claimed ONLY by a sign-in whose email
 * is the invited address — `account_admin` and above (decision B25).
 *
 * ── Why the flexible claim stops at `account_admin` ───────────────────────
 * An invite token binds whatever Firebase identity presents it, and for most
 * roles that is the point: an agent whose only Google account is personal must
 * still get in, and the claim audits the mismatch instead of refusing it. But it
 * also makes a forwarded or leaked invitation mail a bearer credential for the
 * seat it names, and from `account_admin` up that seat can invite people, change
 * roles and supervise calls. So for those roles the token alone is not enough:
 * the identity claiming it must carry the address the mail was sent to.
 *
 * ── One rule, read by both sides ──────────────────────────────────────────
 * The server enforces it on `POST /invites/:token/claim` (against the
 * membership's CURRENT role, not the one the invitation was issued for) and
 * reports it on `GET /invites/:token` as `requires_matching_address`; the
 * console's join page reads that field to show the "use the invited address"
 * screen instead of offering to continue with another account. Declared here, by
 * floor rather than by list, so a role added above `account_admin` is covered
 * without anybody remembering this function. `test/rbac.test.ts` pins exactly
 * which roles it answers true for.
 */
export function inviteRequiresMatchingAddress(role: MembershipRole): boolean {
  return ROLE_HIERARCHY[role] >= ROLE_HIERARCHY.account_admin;
}
