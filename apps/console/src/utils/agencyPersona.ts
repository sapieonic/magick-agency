import { getRoleLevel, hasPermission } from './permissions';
import { HOME_PATH, canSeeHome } from './consoleNav';
import type { Role } from '../types/auth';

/**
 * Who someone IS in the Agency Dialer — as opposed to which RBAC role they hold.
 *
 * ── The problem this solves ─────────────────────────────────────────────────
 * The agency product has two jobs and six roles. A supervisor sets campaigns up
 * and watches them; an agent takes the calls. Nothing in the platform said which
 * was which, so every agency surface that needed to know asked `role === 'agent'`
 * — and that predicate is wrong in both directions:
 *
 *  - it treats an `operator` as a supervisor. An operator holds no supervisory
 *    permission at all (`agency.supervise` floors at `account_admin`), so they
 *    were being sent to campaign-setup screens whose every control 403s;
 *  - it hard-codes ONE role as the agent, when the four agent permissions floor
 *    at level 5 and are therefore inherited by every role above it.
 *
 * ── Derived from permissions, never from a list of role names ───────────────
 * The two predicates below are the two permissions that already define the split,
 * read through the same mirror the rest of the UI gates on. That is the whole
 * design: a persona list written out by hand would be a third copy of the role
 * hierarchy — after the API's `roles.ts` and our `permissions.ts` mirror of it —
 * and the one most likely to be forgotten when a floor moves. Deriving means a
 * change to a floor moves the personas with it, in the same direction, for free.
 *
 * ── `viewer` and `operator` resolve to `agent` ON THE DIALLER'S OWN PAGES, and
 *    that is a licence for nothing else ──────────────────────────────────────
 * `viewer` (10) and `operator` (20) are above `agent` (5), so both inherit
 * `agency.station.connect` and both resolve to the `agent` persona. That is the
 * right answer to "which of the two jobs is this person doing on the agent
 * surfaces" (`/station`, `/dialer/*`, where `AgentSurfaceShell` and the station
 * join read it): neither holds `agency.supervise`, so on a station they are taking
 * calls, not watching other people take them.
 *
 * It is the WRONG answer to two other questions, and each has its own predicate:
 *
 *   - `agencyPersona` — "on an agent surface, which of the two jobs is this?"
 *   - `isDedicatedAgent` — "is the dialler the ONLY thing this person has?", the
 *     one question that may take navigation away;
 *   - `agencyLandingPath` — "where does `/agency` send them?". Only a dedicated
 *     agent lands on `/dialer`. A `viewer` or `operator` reads the campaign list
 *     (`agency.campaigns.read` floors at `viewer`) and has the console around it,
 *     so they land there; an earlier revision landed them on the agent home, whose
 *     only way out opened Profile and appearance.
 *
 * An earlier revision of this file used the persona for "may this person be
 * redirected out of the platform", with real consequences: `AgentLanding` bounced
 * every `viewer` and `operator` out of `/app` to `/dialer`, where, the `agency`
 * capability being off by default, they met a full-viewport "not part of your
 * plan" with no navigation and no way back. Only `agent` (level 5) answers yes to
 * `isDedicatedAgent`.
 *
 * ── This is presentation, not enforcement ──────────────────────────────────
 * A persona decides which page someone LANDS on and which word describes them.
 * It authorizes nothing. The API's 403 is the enforcement, exactly as it is for
 * `hasPermission` and `RequireCapability`; a persona that guessed generously
 * would show a screen that fails on click, and one that guessed meanly would hide
 * a surface the backend would have allowed. Neither is a security boundary.
 */
export type AgencyPersona = 'supervisor' | 'agent';

/**
 * The persona, or `null` for someone the Agency Dialer has no place for at all
 * (no role resolved yet, or a role below the station floor should one ever exist).
 *
 * Supervisor is tested FIRST and the order is load-bearing: `agency.supervise`
 * floors at `account_admin` (30), above `agency.station.connect`'s `agent` (5), so
 * every supervisor also holds the agent permissions and would match both arms.
 * A supervisor covering a shift genuinely can take calls — that inheritance is
 * deliberate and `roles.ts` protects it — but they must not LAND on the agent
 * home, because the campaigns they supervise are not the campaigns they are
 * staffed on and they would arrive at "nobody has assigned you a campaign".
 */
export function agencyPersona(role: Role | undefined): AgencyPersona | null {
  if (hasPermission(role, 'agency.supervise')) return 'supervisor';
  if (hasPermission(role, 'agency.station.connect')) return 'agent';
  return null;
}

/**
 * Whether the Agency Dialer is the ONLY thing this role can reach — i.e. whether
 * they have any platform navigation to lose.
 *
 * ── The property, stated as a property ─────────────────────────────────────
 * Every permission that predates the dialer floors at `viewer` (10) or higher, and
 * the four agent permissions floor at `agent` (5). So "holds nothing but the agent
 * permissions" is exactly "sits below the `viewer` floor", which today is the
 * `agent` role alone. Expressed as the comparison rather than as `role === 'agent'`
 * so that a future role added below `viewer` is handled correctly by construction
 * instead of silently rendering an empty shell.
 *
 * ── The one thing this may be used for ────────────────────────────────────
 * Deciding whether it is safe to redirect somebody AWAY from the console shell. For a
 * dedicated agent the shell is an empty sidebar around an empty dashboard —
 * *"that is not navigation, it is noise"*. For everybody else it is their product.
 *
 * Do not reach for {@link agencyPersona} for that decision; see its docstring for
 * the regression that caused.
 */
export function isDedicatedAgent(role: Role | undefined): boolean {
  if (!role) return false;
  return (
    hasPermission(role, 'agency.station.connect') &&
    getRoleLevel(role) < getRoleLevel(PLATFORM_NAVIGATION_FLOOR)
  );
}

/**
 * The lowest role that holds any pre-dialer permission, and therefore the lowest
 * role with navigation of its own. Named rather than inlined because it is the
 * hinge of {@link isDedicatedAgent} and reads as a magic role otherwise.
 */
const PLATFORM_NAVIGATION_FLOOR: Role = 'viewer';

/** The campaign list: where someone who reads campaigns but does not supervise lands. */
export const CAMPAIGNS_LANDING_PATH = '/agency/campaigns';

/** The agent home: where a dedicated agent lands. */
export const AGENT_LANDING_PATH = '/dialer';

/**
 * Where `/agency` sends this person (`AgencyHomeRedirect`), and so where every door
 * that defaults to `/agency` (sign-in, an account switch) ends up. `null` while the
 * role is unresolved, so the caller waits instead of guessing.
 *
 *  - whoever passes Home's gate (`canSeeHome`, `agency.supervise`) → Home;
 *  - a dedicated agent ({@link isDedicatedAgent}) → `/dialer`, outside the shell;
 *  - everyone else with a place in the dialler (`viewer`, `operator`) → the campaign
 *    list, inside the console. They can read it, and its campaign pages carry "Join
 *    as agent" for taking calls; `/dialer` still serves them when they go there.
 *
 * Only the role is read: every caller renders inside `/agency`'s capability and flag
 * gates (or `/dialer`'s, which are the same), so Home's gate comes down to its
 * permission.
 */
export function agencyLandingPath(role: Role | undefined): string | null {
  if (agencyPersona(role) === null) return null;
  if (canSeeHome({ role, isFlagEnabled: () => true, isCapabilityEnabled: () => true })) return HOME_PATH;
  if (isDedicatedAgent(role)) return AGENT_LANDING_PATH;
  return CAMPAIGNS_LANDING_PATH;
}

/** The word for each persona, in the product's voice. */
export const AGENCY_PERSONA_LABELS: Record<AgencyPersona, string> = {
  supervisor: 'Supervisor',
  agent: 'Agent',
};

/**
 * What to call this person on an agency screen.
 *
 * Agency surfaces show the PERSONA rather than the RBAC role: on a campaign's
 * staffing list "Operator" and "Viewer" name access levels that say nothing about
 * the dialler, while "Agent" and "Supervisor" are the two words the supervisor
 * reading that list is actually sorting people by.
 *
 * The role labels (`config.ts` `ROLES`, Team and the invite pickers) call
 * `account_admin` "Supervisor" too, so the two agree for that role; the persona
 * differs from the role label only for a tenant admin or owner (a Supervisor here,
 * an Admin or Owner on Team) and for an operator or viewer (an Agent here).
 *
 * `null` for a role with no agency standing, so callers render nothing rather
 * than a misleading default.
 */
export function agencyPersonaLabel(role: Role | undefined): string | null {
  const persona = agencyPersona(role);
  return persona ? AGENCY_PERSONA_LABELS[persona] : null;
}

/** Convenience for the common branch. */
export function isAgencySupervisor(role: Role | undefined): boolean {
  return agencyPersona(role) === 'supervisor';
}

/** Convenience for the common branch. */
export function isAgencyAgent(role: Role | undefined): boolean {
  return agencyPersona(role) === 'agent';
}
