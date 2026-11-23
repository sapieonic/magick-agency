import { useCallback, useMemo } from 'react';
import { useAsyncResource } from '@magick-agency/web-ui/hooks/useAsyncResource';
import { useTenant } from '../contexts/TenantContext';
import { useTeam } from './useTeam';
import { useNavGate } from './useNavGate';
import { assignAgent, listCampaignAgents, unassignAgent } from '../api/agency';
import { hasPermission } from '../utils/permissions';
import { agencyPersonaLabel } from '../utils/agencyPersona';
import { passesGate, settingsEntry } from '../utils/consoleNav';
import { joinAnd } from '../utils/agencyCampaignConfigForm';
import type { AvatarUser } from '../components/common/UserAvatar';
import type { AgencyAssignedAgent } from '../types/agency-campaign';
import type { TenantMember } from '../types/team';
import type { Role } from '../types/auth';

/**
 * Who can be picked to call on a campaign, and who is (CS10): step 4's agent list.
 *
 * ── Who is an agent ─────────────────────────────────────────────────────────
 * Anyone who may hold a station: `agency.station.connect`, through the permission mirror, never
 * a list of role names. That floors at `agent`, so every role holds it, as the campaign page's
 * staffing panel (`CampaignAgentAssignments`) already assumes; the persona (Agent or Supervisor,
 * `agencyPersonaLabel`) is shown beside each name. Only active memberships of this account (or of
 * the whole organisation) are offered: someone who belongs to another account only would be
 * staffed somewhere they cannot work. Anyone already assigned here is listed whatever their
 * membership, so a tick that the server holds can always be taken off.
 *
 * ── Staffing is applied, not edited ─────────────────────────────────────────
 * The step only holds ticks. {@link UseCampaignStaffing.applyStaffing} reads what the server
 * has for the campaign at that moment, then assigns and unassigns the difference (the routes
 * the campaign page uses), one call per person, and reports each failure without undoing the
 * others. New campaign calls it once the draft exists; Settings calls it with the save bar.
 * Unassigning returns that agent's open contacts to the pool when the campaign says so (CA6) and
 * releases any dedicated number, as the campaign page's Remove does.
 */

export interface StaffingAgent {
  /** The user id: what the assignment routes take. */
  id: string;
  name: string;
  email: string | null;
  /** "Agent" or "Supervisor", or `null` for a role this console cannot place. */
  persona: string | null;
  /** For `UserAvatar` (initials, or the picture). */
  avatar: AvatarUser;
  /** The person has never finished signing in (`invite_state: 'pending'`). */
  notSignedIn: boolean;
  /** Assigned here but not among this account's people (another account's member, or removed). */
  inTeam: boolean;
}

export interface StaffingFailure {
  userId: string;
  name: string;
  action: 'add' | 'remove';
  message: string;
}

export interface StaffingApplyResult {
  /** Assigned by this apply. */
  added: string[];
  /** Unassigned by this apply. */
  removed: string[];
  failures: StaffingFailure[];
  /** The campaign's current staffing could not be read, so nothing was changed. */
  readError: string | null;
}

export interface UseCampaignStaffing {
  /** Everyone who can be picked, by name. */
  agents: StaffingAgent[];
  /** Who the server has on the campaign; empty while `campaignId` is null. */
  assignedIds: string[];
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
  applyStaffing: (campaignId: string, nextIds: readonly string[]) => Promise<StaffingApplyResult>;
  /** Where to invite people (Settings › Team), when the reader may; else `null`. */
  invitePath: string | null;
}

const NO_ASSIGNMENTS: AgencyAssignedAgent[] = [];

function messageOf(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

/** Whether a membership makes someone pickable on `accountId`'s campaigns. */
function canTakeCalls(member: TenantMember, accountId: string | null): boolean {
  const { membership } = member;
  if (membership.status !== 'active') return false;
  if (membership.account_id !== null && membership.account_id !== accountId) return false;
  return hasPermission(membership.role, 'agency.station.connect');
}

function fromMember(member: TenantMember): StaffingAgent {
  const { user, membership } = member;
  return {
    id: user.id,
    name: user.display_name || user.email || user.id,
    email: user.email || null,
    persona: agencyPersonaLabel(membership.role),
    avatar: { display_name: user.display_name, email: user.email || null, avatar_url: user.avatar_url },
    notSignedIn: membership.invite_state === 'pending',
    inTeam: true,
  };
}

function fromAssignment(agent: AgencyAssignedAgent): StaffingAgent {
  return {
    id: agent.user_id,
    name: agent.name ?? agent.email ?? agent.user_id,
    email: agent.email,
    persona: agent.role ? agencyPersonaLabel(agent.role as Role) : null,
    avatar: { display_name: agent.name, email: agent.email, avatar_url: null },
    notSignedIn: false,
    inTeam: false,
  };
}

/** The people who can be picked, plus anyone assigned who is not among them; by name. */
export function staffingAgentsOf(
  members: readonly TenantMember[],
  assigned: readonly AgencyAssignedAgent[],
  accountId: string | null,
): StaffingAgent[] {
  const byId = new Map<string, StaffingAgent>();
  // An account membership first, so its role names the person over an organisation-wide one.
  const ordered = [...members].sort(
    (a, b) => Number(b.membership.account_id === accountId) - Number(a.membership.account_id === accountId),
  );
  for (const member of ordered) {
    if (!canTakeCalls(member, accountId) || byId.has(member.user.id)) continue;
    byId.set(member.user.id, fromMember(member));
  }
  for (const agent of assigned) {
    if (!byId.has(agent.user_id)) byId.set(agent.user_id, fromAssignment(agent));
  }
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name, 'en-IN', { sensitivity: 'base' }));
}

/** "Could not add Asha and Ravi. Could not take Meena off." — or `null` when nothing failed. */
export function staffingFailureMessage(result: StaffingApplyResult): string | null {
  if (result.readError) return `Could not change who calls on this campaign: ${result.readError}`;
  const adds = result.failures.filter((f) => f.action === 'add').map((f) => f.name);
  const removes = result.failures.filter((f) => f.action === 'remove').map((f) => f.name);
  const parts = [
    ...(adds.length > 0 ? [`Could not add ${joinAnd(adds)} to this campaign.`] : []),
    ...(removes.length > 0 ? [`Could not take ${joinAnd(removes)} off this campaign.`] : []),
  ];
  return parts.length > 0 ? parts.join(' ') : null;
}

export function useCampaignStaffing(campaignId: string | null): UseCampaignStaffing {
  const { tenantId, accountId } = useTenant();
  const team = useTeam();
  const navInput = useNavGate();

  const fetchAssigned = useCallback(
    async (): Promise<AgencyAssignedAgent[]> =>
      (await listCampaignAgents(campaignId!, tenantId ?? undefined, accountId ?? undefined)).agents,
    [campaignId, tenantId, accountId],
  );
  const assigned = useAsyncResource(fetchAssigned, {
    initialData: NO_ASSIGNMENTS,
    errorMessage: 'Could not load who is on this campaign.',
    enabled: campaignId !== null && tenantId !== null && accountId !== null,
  });
  const reloadAssigned = assigned.reload;

  const agents = useMemo(
    () => staffingAgentsOf(team.members, assigned.data, accountId),
    [team.members, assigned.data, accountId],
  );
  const assignedIds = useMemo(() => assigned.data.map((a) => a.user_id), [assigned.data]);
  const nameOf = useCallback(
    (userId: string) => agents.find((a) => a.id === userId)?.name ?? userId,
    [agents],
  );

  const applyStaffing = useCallback(
    async (target: string, nextIds: readonly string[]): Promise<StaffingApplyResult> => {
      const scope = [tenantId ?? undefined, accountId ?? undefined] as const;
      let current: string[];
      try {
        current = (await listCampaignAgents(target, ...scope)).agents.map((a) => a.user_id);
      } catch (err: unknown) {
        return { added: [], removed: [], failures: [], readError: messageOf(err, 'Could not load who is on this campaign.') };
      }
      const next = new Set(nextIds);
      const have = new Set(current);
      const toAdd = [...next].filter((id) => !have.has(id));
      const toRemove = current.filter((id) => !next.has(id));
      const settled = await Promise.allSettled([
        ...toAdd.map((id) => assignAgent(target, id, ...scope)),
        ...toRemove.map((id) => unassignAgent(target, id, ...scope)),
      ]);
      const result: StaffingApplyResult = { added: [], removed: [], failures: [], readError: null };
      settled.forEach((outcome, index) => {
        const adding = index < toAdd.length;
        const userId = adding ? toAdd[index]! : toRemove[index - toAdd.length]!;
        if (outcome.status === 'fulfilled') {
          (adding ? result.added : result.removed).push(userId);
        } else {
          result.failures.push({
            userId,
            name: nameOf(userId),
            action: adding ? 'add' : 'remove',
            message: messageOf(outcome.reason, adding ? 'Could not assign that person.' : 'Could not remove that person.'),
          });
        }
      });
      // What the server now has, for the campaign this hook shows.
      if (target === campaignId) await reloadAssigned();
      return result;
    },
    [tenantId, accountId, campaignId, reloadAssigned, nameOf],
  );

  const reloadTeam = team.reload;
  const reload = useCallback(async () => {
    await Promise.all([reloadTeam(), campaignId !== null ? reloadAssigned() : Promise.resolve()]);
  }, [reloadTeam, campaignId, reloadAssigned]);

  const invitePath = passesGate(settingsEntry('team').gate, navInput) ? settingsEntry('team').path : null;
  const error = [team.error, campaignId !== null ? assigned.error : null].filter(Boolean).join(' ') || null;

  return {
    agents,
    assignedIds,
    loading: team.loading || (campaignId !== null && assigned.loading),
    error,
    reload,
    applyStaffing,
    invitePath,
  };
}
