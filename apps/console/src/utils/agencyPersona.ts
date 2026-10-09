import { getRoleLevel, hasPermission } from './permissions';
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
 * ── `viewer` and `operator` resolve to `agent`, and that is NOT a licence to
 *    take their navigation away ─────────────────────────────────────────────
 * `viewer` (10) and `operator` (20) are above `agent` (5), so both inherit
 * `agency.station.connect` and both resolve to the `agent` persona. That is the
 * right answer to "which agency surface suits them" — neither holds
 * `agency.supervise`, so the supervisor surfaces would be controls they cannot
 * use.
 *
 * It is the WRONG answer to "may this person be redirected out of the platform",
 * and an earlier revision of this file conflated the two with real consequences.
 * `AgentLanding` gated on this persona and so bounced every `viewer` and
 * `operator` out of `/app` to `/dialer` — where, the `agency` capability being
 * off by default, they met a full-viewport "not part of your plan" with no
 * navigation and no way back, in every tenant that had not bought the dialer.
 * A `viewer` holds around twenty read permissions across the platform; an
 * `operator` runs calls, schedules and bulk dispatch. Both had a fully populated
 * product before that change and neither could reach any of it after.
 *
 * That is what {@link isDedicatedAgent} is for, and why it is a separate
 * predicate rather than a tidier version of this one. The two questions are
 * genuinely different:
 *
 *   - `agencyPersona` — "inside the dialer, which of the two jobs is this?"
 *   - `isDedicatedAgent` — "is the dialer the ONLY thing this person has?"
 *
 * Only the second may take navigation away, and only `agent` (level 5) answers
 * yes to it.
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
 * Deciding whether it is safe to redirect somebody AWAY from `AppLayout`. For a
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

/** The word for each persona, in the product's voice. */
export const AGENCY_PERSONA_LABELS: Record<AgencyPersona, string> = {
  supervisor: 'Supervisor',
  agent: 'Agent',
};

/**
 * What to call this person on an agency screen.
 *
 * Agency surfaces show the PERSONA rather than the RBAC role: on a campaign's
 * staffing list "Operator" and "Account Admin" name platform concepts that say
 * nothing about the dialer, while "Agent" and "Supervisor" are the two words the
 * supervisor reading that list is actually sorting people by.
 *
 * Deliberately NOT a rename of the platform's role labels. `account_admin` does a
 * great deal that has nothing to do with watching a campaign, and calling it
 * "Supervisor" in Team settings would mislead every tenant that does not use the
 * dialer. The role keeps its name where the role is the subject; the persona gets
 * the name where the dialer is.
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
