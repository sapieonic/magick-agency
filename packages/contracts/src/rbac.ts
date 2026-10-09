/**
 * Roles and permissions — ONE source for the server and both UIs.
 *
 * In MagickVoice this was a hand mirror: master's `src/rbac/roles.ts` (the
 * authority) and cusui's `src/utils/permissions.ts` (a copy that had to be kept
 * "in lockstep", `agency.md` §6.4 "Role hierarchy"). Magick Agency imports this
 * module on both sides, so the mirror — and the class of bug where the UI shows
 * a control the API 403s, or hides one it would allow — goes away.
 *
 * Ported from `magick-master/src/rbac/roles.ts` at master v3.24.0
 * (a1f0756a58a63bf8a19baf74298a702f9fe7b430). Role levels are master's exactly.
 * The permission SET is narrowed to what Magick Agency uses (extraction plan
 * §3.1), and four permissions are RENAMED to agency names with master's floors
 * unchanged; every one is listed with its master source line in
 * `packages/contracts/PORTING.md`.
 */

/**
 * The six membership roles. Master's `MembershipRole`
 * (`src/db/models/membership.model.ts`), mirrored by cusui's `Role`
 * (`src/types/auth.ts`); here it is declared once.
 */
export type Role =
  | 'tenant_owner'
  | 'tenant_admin'
  | 'account_admin'
  | 'operator'
  | 'viewer'
  | 'agent';

/** Master's name for the same union. */
export type MembershipRole = Role;

/**
 * Role hierarchy: higher number = more authority.
 *
 * `agent` (Agency Dialer, design D6) is deliberately placed at 5 — BELOW
 * `viewer`. The hierarchy is linear and PERMISSION_MATRIX maps each permission
 * to a *minimum* role, so a floor of `viewer` (10) or higher is unreachable at
 * level 5. Every permission that predates the agency feature floors at `viewer`
 * or above, which means an `agent` membership grants access to exactly the four
 * `agency.*` permissions below, PLUS `proxy.feature_flags.read`, and to nothing
 * else — no campaign list, no analytics, no contacts, no recordings, and no
 * other `/proxy/*` route. That is the design, not an oversight: agent actions
 * get agency-native routes that can additionally verify the caller is the
 * reserved agent for the attempt.
 *
 * The flag map is the single exception, and it is not a softening of the rule —
 * it is the read the rule forgot. cusui must resolve it before it can render
 * ANY flag-gated route, so while it floored at `viewer` an agent was locked out
 * of the very product the other four permissions exist to run. See its matrix
 * entry. `test/unit/rbac/roles.agent.test.ts` pins both halves.
 *
 * Do not raise this number to "make something work" — raising it silently grants
 * an agent every viewer-floored read on the platform.
 *
 * PORT NOTE (magick-agency): `proxy.feature_flags.read` is `agency.flags.read`
 * here (same `agent` floor). In this package the pin is `test/rbac.test.ts`.
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

type MissingRole = Exclude<Role, (typeof ROLES)[number]>;
const _allRolesListed: MissingRole extends never ? true : MissingRole = true;
void _allRolesListed;

export type Permission =
  // ── Platform permissions Magick Agency keeps, names unchanged ──────────────
  | 'tenant.read'
  | 'account.read'
  | 'user.invite' | 'user.update_role' | 'user.remove'
  | 'audit.read'
  // ── Renamed to agency names (master's name → here), floors unchanged ──────
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
  // PATCH, roster upload). In MagickVoice these rode the contact-list
  // permissions (`agency.md` §7.1, "Campaign writes … floor at
  // `proxy.contact_lists.write`").
  | 'agency.campaigns.read'
  | 'agency.campaigns.write'
  // Call-analysis profiles (plan §4 "Profiles: CRUD"). In MagickVoice the
  // profile routes rode the call-script permissions
  // (`proxy-call-analysis-profiles.routes.ts:68-72`).
  | 'agency.analysis_profiles.read'
  | 'agency.analysis_profiles.write'
  // The tenant's assigned caller IDs (`GET /phone-numbers`, the campaign
  // builder's caller-ID picker). Added in session 3 for Phase 8.
  | 'agency.phone_numbers.read'
  // Agency Dialer (design D6). The four agent-scoped permissions floor at
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
  // agent's own line, and core verifies they are that attempt's reserved agent.
  // These two are number-scoped and list-scoped, so neither floors at `agent`.
  | 'agency.dnc.read'
  | 'agency.dnc.manage';

/** Minimum role required for each permission */
export const PERMISSION_MATRIX: Record<Permission, MembershipRole> = {
  // Master `roles.ts:80`. Behind `GET /tenants/:id/members` (the team page).
  'tenant.read': 'viewer',
  // Master `roles.ts:83`. Behind `GET /accounts` (full rows). NOTE:
  // `GET /accounts/mine` itself carries NO permission check in master — it is
  // membership-scoped and returns `{id, name, tenant_id}` only — which is how an
  // `agent` (below this floor) resolves its account (`TenantContext.tsx`).
  'account.read': 'viewer',
  'user.invite': 'account_admin', // master `roles.ts:86`
  'user.update_role': 'tenant_admin', // master `roles.ts:87`
  'user.remove': 'tenant_admin', // master `roles.ts:88`
  // MAG-157: supervisors (`account_admin`) read the trail they write. Rows are
  // account-scoped in `platform_audit_log` so this does not leak sibling accounts.
  'audit.read': 'account_admin',
  // ── The feature-flag map ─────────────────────────────────────────────────
  // Floored at `agent`, and the ONLY non-`agency.*` permission that is. Read the
  // hierarchy comment above first: this is not a relaxation of D6's "four
  // permissions and nothing else" rule, it is the read that rule overlooked.
  //
  // The route returns the client-exposed FLAG MAP, which cusui must fetch before
  // it can render any flag-gated route. It used to carry `proxy.stats.read`
  // (floor `viewer`, level 10). An `agent` is level 5, so EVERY dedicated agent
  // got a 403 here — and cusui's `FeatureFlagsContext` is fail-safe closed, so an
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
  // with the core stats lane and must stay at `viewer`: an agent has no business
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
  // PORT NOTE (magick-agency): master's `proxy.feature_flags.read`
  // (`roles.ts:164`), renamed. The name now starts `agency.`, but it is still
  // not an ACTION permission — the four below remain the only ones of those.
  'agency.flags.read': 'agent',
  // PORT NOTE (magick-agency): master's `proxy.contact_lists.read` /
  // `.write` (`roles.ts:118-119`), renamed; floors unchanged.
  'agency.campaigns.read': 'viewer',
  'agency.campaigns.write': 'account_admin',
  // PORT NOTE (magick-agency): master's `proxy.prompts.read` / `.write`
  // (`roles.ts:94` / `:93`), renamed; floors unchanged.
  'agency.analysis_profiles.read': 'viewer',
  'agency.analysis_profiles.write': 'account_admin',
  // PORT NOTE (magick-agency): master's `proxy.phone_numbers.read` (`roles.ts:122`),
  // renamed; floor unchanged. `proxy.phone_numbers.manage` is not carried: number
  // inventory and assignment are super-admin-only in agency (plan §3.4).
  'agency.phone_numbers.read': 'viewer',
  // ── Agency Dialer ────────────────────────────────────────────────────────
  // These four are the only agency ACTION permissions floored at `agent` — and,
  // with `proxy.feature_flags.read` above, the only `agent`-floored permissions
  // at all. The distinction is worth keeping: these four authorise doing
  // something to a live call, that one authorises reading the boolean map the
  // SPA needs to render. Each corresponds to an action an agent takes on the
  // call currently on their own station; core
  // additionally verifies the caller is that attempt's reserved agent, an
  // ownership check the generic `/proxy/webrtc-call/:id/end` route cannot
  // express (it floors at `operator`, so an agent cannot reach it at all).
  'agency.station.connect': 'agent', // open a station socket, join a campaign
  'agency.attempts.handle': 'agent', // receive a bridged call, hang up
  'agency.attempts.dispose': 'agent', // disposition, notes, schedule callback
  'agency.dnc.write': 'agent', // mark the contact on the line as do-not-call
  // Supervisory. Distinct from the four above in kind, not just in floor: it
  // authorises acting on an attempt reserved by *somebody else*, so master sets
  // core's `on_behalf` flag from it (`src/agency/agency-actor.ts`) and the
  // resulting disposition is filed against a customer under one person's name
  // while a different person chose it.
  //
  // FLOOR IS `account_admin` (30), per design §8, core's contract
  // (`contracts.ts:945`) and UX spec §C, which agree. The Phase 2 backlog line
  // for `AD-P2-M-01` says acceptance (d) is "an `operator` can disposition on an
  // agent's behalf" — an `operator` is 20 and cannot hold this. That line
  // predates the freeze that introduced `on_behalf` and is the stale side; it is
  // flagged rather than built to, because lowering a supervisory floor is not a
  // change to make silently.
  'agency.supervise': 'account_admin',
  // ── The DNC list surface (`AD-P3-M-01`) ──────────────────────────────────
  // Deliberately NOT floored at `agent`, and the two floors differ from each
  // other, because the two directions are not symmetric risks:
  //
  //  - READ floors at `viewer`. The list is every customer who asked not to be
  //    contacted; an agent has no reason to browse it, and D6 gives them exactly
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
};

/** Every permission, for enumeration (tests, route tables, admin screens). */
export const PERMISSIONS = Object.keys(PERMISSION_MATRIX) as Permission[];

/**
 * Check if a role has sufficient authority for a permission.
 *
 * PORT NOTE (magick-agency): master's signature took a `MembershipRole`; cusui's
 * mirror took `Role | undefined` and failed CLOSED on a missing role (a console
 * that has not resolved a membership yet must show nothing privileged). One
 * function now serves both, so it accepts `undefined`/`null` and an unknown
 * runtime string, and answers `false` for all three. For every real role the
 * result is master's, unchanged.
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
