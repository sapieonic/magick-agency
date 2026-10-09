import { useCallback, useEffect, useMemo, useState } from 'react';
import { UserMinus, UserPlus } from 'lucide-react';
import { useTenant } from '../../contexts/TenantContext';
import { useToast } from '../../contexts/ToastContext';
import { useTeam } from '../../hooks/useTeam';
import { assignAgent, listCampaignAgents, unassignAgent } from '../../api/agency';
import { ErrorAlert } from '../common/ErrorAlert';
import { ROLES } from '../../config';
import { agencyPersonaLabel } from '../../utils/agencyPersona';
import type { Role } from '../../types/auth';
import type { AgencyAssignedAgent } from '../../types/agency-campaign';
import styles from './CampaignAgentAssignments.module.css';

/**
 * Who is staffed on this campaign.
 *
 * ── This is not the agent floor, and the two must not be confused ───────────
 * `AgentFloor` immediately below is **live session state**: who is signed in
 * right now, what they are doing, how long they have been doing it. This is the
 * campaign's *people* — a supervisor's standing decision about who works here,
 * true whether or not anyone is logged in. A supervisor reading a floor with no
 * tiles on it needs to be able to tell "nobody is on shift" from "nobody is
 * assigned", and only one of those two panels can answer either question.
 *
 * The word **roster** is avoided on purpose: in this codebase a roster is a list
 * of CONTACTS (`useRosterIngest`, the CSV upload). Reusing it for people would
 * make two unrelated things share a noun in a product where both are lists of
 * humans attached to a campaign.
 *
 * ── Staffing, never authorization ──────────────────────────────────────────
 * An assignment decides where an `agent` is *sent by default* when they open
 * the app — nothing more. Joining a station is gated on
 * `agency.station.connect` alone, so a supervisor covering a shift can still
 * join a campaign nobody assigned them to, which is the case the API's RBAC
 * comments protect explicitly.
 *
 * ── Several campaigns per person, one at a time, and no live session touched ──
 * The API enforces one active assignment per user per CAMPAIGN (the `uq_agency_campaign_agent_active_campaign` index),
 * so assigning someone already staffed elsewhere **adds** — it does not move them.
 * That is what lets an agency run Renewals in the morning and Collections after
 * lunch with the same people; under the previous per-tenant rule the second
 * assignment silently unstaffed them from the first.
 *
 * Being LIVE on one campaign at a time is unchanged and is the API's, not this table's:
 * if they are still joined to another campaign, their next join is refused with
 * `session_on_other_campaign` and their console tells them to leave that station
 * first. Nobody is yanked off a call by a staffing change, which is why this panel
 * says so out loud rather than leaving a supervisor to discover it from an agent's
 * screen.
 */

export interface CampaignAgentAssignmentsProps {
  campaignId: string;
  /**
   * `hasPermission(role, 'agency.supervise')`, computed by the page.
   *
   * **This must be that exact permission** — the same rule `AgentFloor`'s props
   * state. All four assignment routes are floored on `agency.supervise` in
   * the API, so a looser gate renders a panel whose first read 403s, and a
   * tighter one hides staffing from an `account_admin` who holds it.
   */
  canSupervise: boolean;
  /**
   * `agent_user_id` of everyone with a LIVE session on this campaign, or `null`
   * when that is unknown.
   *
   * Read off the stats payload the page already has for `AgentFloor` — a prop,
   * never a second fetch. It is what makes "assigned but not here" sayable.
   *
   * **`null` is not an empty floor.** The API may not have produced the per-agent
   * rows, or the stats read may have failed; claiming everyone is missing on the
   * strength of a payload we did not get would put a warning against every name
   * on the page. Unknown renders no signal at all.
   */
  liveAgentUserIds: readonly string[] | null;
}

/**
 * The permission gate sits **outside** the panel, and that is not cosmetic.
 *
 * The panel calls `useTeam()`, which reads `GET /tenants/:id/members`. Hooks
 * cannot be called conditionally, so with the gate inside the component that
 * request fired for every `viewer`, `operator` and `agent` who opened a campaign
 * page — a permission-shaped 403 on every page view, invisible because nothing
 * read the hook's error. Splitting the component is what makes "issues no
 * request" true rather than merely intended.
 */
export function CampaignAgentAssignments({
  campaignId,
  canSupervise,
  liveAgentUserIds,
}: CampaignAgentAssignmentsProps) {
  if (!canSupervise) return null;
  return <AssignmentPanel campaignId={campaignId} liveAgentUserIds={liveAgentUserIds} />;
}

function AssignmentPanel({
  campaignId,
  liveAgentUserIds,
}: Omit<CampaignAgentAssignmentsProps, 'canSupervise'>) {
  const { tenantId, accountId } = useTenant();
  const { showToast, showErrorToast } = useToast();
  // Tenant members are the pool to pick from. Every role can hold a station
  // (`agency.station.connect` floors at `agent`), so nobody is filtered out on
  // capability — only on being assigned here already.
  const { members, error: membersError } = useTeam();

  const [agents, setAgents] = useState<AgencyAssignedAgent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [picked, setPicked] = useState('');
  const [busyUserId, setBusyUserId] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!campaignId || !tenantId || !accountId) return;
    setError(null);
    try {
      const response = await listCampaignAgents(campaignId, tenantId, accountId);
      setAgents(response.agents);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not load the assigned agents.');
    } finally {
      setLoading(false);
    }
  }, [campaignId, tenantId, accountId]);

  useEffect(() => {
    void load();
  }, [load]);

  const assigned = useMemo(() => new Set(agents.map((a) => a.user_id)), [agents]);
  const candidates = useMemo(
    () => members.filter((m) => !assigned.has(m.user.id)),
    [members, assigned],
  );
  /** `null` ⇒ we do not know who is live, so nothing is claimed either way. */
  const liveHere = useMemo(
    () => (liveAgentUserIds ? new Set(liveAgentUserIds) : null),
    [liveAgentUserIds],
  );

  const onAssign = useCallback(async () => {
    if (!picked || !tenantId || !accountId) return;
    setBusyUserId(picked);
    try {
      await assignAgent(campaignId, picked, tenantId, accountId);
      setPicked('');
      showToast('Assigned to this campaign.', 'success');
      await load();
    } catch (err: unknown) {
      // A 404 here is "not a member of this tenant" — the API's own answer, and
      // worth showing as-is rather than flattening to "could not assign".
      showErrorToast(err, 'Could not assign that person.');
    } finally {
      setBusyUserId(null);
    }
  }, [picked, campaignId, tenantId, accountId, load, showToast, showErrorToast]);

  const onUnassign = useCallback(
    async (userId: string) => {
      if (!tenantId || !accountId) return;
      setBusyUserId(userId);
      try {
        await unassignAgent(campaignId, userId, tenantId, accountId);
        showToast('Removed from this campaign.', 'success');
        await load();
      } catch (err: unknown) {
        showErrorToast(err, 'Could not remove that person.');
      } finally {
        setBusyUserId(null);
      }
    },
    [campaignId, tenantId, accountId, load, showToast, showErrorToast],
  );

  return (
    <section className={styles.panel} aria-labelledby="campaign-agents-heading">
      <div className={styles.header}>
        <div>
          <h2 className={styles.title} id="campaign-agents-heading">
            Assigned agents
          </h2>
          <p className={styles.description}>
            Who works this campaign. Agents can be assigned to more than one and choose
            where to work when they sign in — assigning someone who is on another campaign
            adds this one, and never interrupts a call in progress.
          </p>
        </div>
      </div>

      {error && <ErrorAlert message={error} onRetry={() => void load()} />}

      <div className={styles.assignRow}>
        <label className={styles.assignLabel} htmlFor="campaign-agent-picker">
          Add someone
        </label>
        <select
          id="campaign-agent-picker"
          className={styles.picker}
          value={picked}
          onChange={(event) => setPicked(event.target.value)}
          disabled={candidates.length === 0}
        >
          <option value="">Choose a team member…</option>
          {candidates.map((member) => (
            <option key={member.user.id} value={member.user.id}>
              {member.user.display_name || member.user.email} — {roleLabel(member.membership.role)}
            </option>
          ))}
        </select>
        <button
          type="button"
          className={`${styles.assignButton} btn-primary`}
          onClick={() => void onAssign()}
          disabled={!picked || busyUserId !== null}
        >
          <UserPlus size={15} aria-hidden="true" />
          Assign
        </button>
        {/* A disabled control states its reason, here as everywhere else — and
            the reason has to be TRUE. An empty picker because the member read
            failed is not "everyone is already assigned"; that sentence would
            report a permissions or network failure as a finished job. */}
        {candidates.length === 0 && (
          <span className={styles.pickerNote}>
            {membersError
              ? 'We couldn’t load your team, so there is nobody to pick from. Try reloading.'
              : 'Everyone in this workspace is already assigned here.'}
          </span>
        )}
      </div>

      {loading ? (
        <p className={styles.empty}>Loading…</p>
      ) : error ? (
        // The alert above is the whole answer. "Nobody is assigned yet" beside a
        // failed read asserts a fact about staffing on the strength of a request
        // that did not happen — and it is the one sentence that would send a
        // supervisor off to staff a campaign that may be fully staffed already.
        null
      ) : agents.length === 0 ? (
        // Absence with a consequence attached: an unassigned campaign is not
        // merely empty, it is one nobody will be sent to.
        <p className={styles.empty} data-testid="no-assigned-agents">
          Nobody is assigned yet. Agents signing in will have nowhere to go.
        </p>
      ) : (
        <ul className={styles.list}>
          {agents.map((agent) => (
            <li key={agent.user_id} className={styles.row}>
              <span className={styles.person}>
                {/* `name: null` means the API could not resolve the person — a
                    removed user, or one outside this tenant. The id is shown
                    rather than a blank, so a supervisor can still unassign a row
                    they cannot name. */}
                <span className={styles.name}>
                  {agent.name ?? agent.email ?? agent.user_id}
                </span>
                {agent.email && agent.name ? (
                  <span className={styles.email}>{agent.email}</span>
                ) : null}
              </span>
              {agent.role ? <span className={styles.role}>{roleLabel(agent.role)}</span> : null}
              {/*
                ── Assigned here, but not AT a station here ────────────────────
                Staffing and sessions are deliberately independent: a
                reassignment moves the API's row and never touches a live
                session, so an agent moved mid-shift appears on this list
                immediately while still working their old campaign — and the API
                refuses their next join here until they leave that station. A
                supervisor reading a name with no tile on the floor beside it
                has no way to tell "hasn't started yet" from "is elsewhere and
                stuck" unless the list says so.

                Rendered only when the floor is KNOWN (see `liveAgentUserIds`):
                with no per-agent rows this would mark everyone absent on the
                strength of a payload we never received.
              */}
              {liveHere && !liveHere.has(agent.user_id) ? (
                <span className={styles.notJoined} data-testid={`not-joined-${agent.user_id}`}>
                  Not at this station
                </span>
              ) : null}
              <button
                type="button"
                className={styles.remove}
                onClick={() => void onUnassign(agent.user_id)}
                disabled={busyUserId !== null}
                aria-label={`Remove ${agent.name ?? agent.user_id} from this campaign`}
              >
                <UserMinus size={15} aria-hidden="true" />
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * What to call this person on this screen.
 *
 * ── The PERSONA, not the platform role ─────────────────────────────────────
 * This used to print the RBAC role's label — "Operator", "Account Admin" — which
 * named platform concepts that say nothing about the dialer. A supervisor reading
 * a staffing list is sorting people by one question, "can this person take calls
 * or do they run campaigns", and the role labels answered it only by implication:
 * an `operator` holds every agent permission and no supervisory one, so
 * "Operator" on a list of agents was a word the reader had to translate.
 *
 * So agency surfaces show `Supervisor` / `Agent`. That is deliberately NOT a
 * rename of the platform's role labels — `account_admin` does a great deal that
 * has nothing to do with watching a campaign, and calling it "Supervisor" in Team
 * settings would mislead every tenant that does not use the dialer. See
 * `utils/agencyPersona.ts`.
 *
 * ── The fallback still matters, for the reason the old note gave ───────────
 * `role` comes off the wire from the API, so it is typed as a plain string and a
 * role added there before it is mirrored here must render as itself rather than
 * crash a supervisor's page. `agencyPersonaLabel` returns `null` for anything it
 * cannot place — including that unmirrored role, since `hasPermission` scores an
 * unknown role at 0 — and we fall through to the platform label, then to the raw
 * string.
 */
function roleLabel(role: string): string {
  const persona = agencyPersonaLabel(role as Role);
  if (persona) return persona;
  return ROLES.find((entry) => entry.value === role)?.label ?? role;
}

export default CampaignAgentAssignments;
