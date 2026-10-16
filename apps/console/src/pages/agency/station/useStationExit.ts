import { useCallback, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { leaveAgencySession } from '../../../api/agency';
import { clearLiveSession } from '../../../utils/agencyLiveSession';
import { agentLandingPath } from '../../../utils/agencyStationExit';
import { getRoleLevel } from '../../../utils/permissions';
import { trackAgencyStationExit } from '../../../analytics/events';
import type { Role } from '../../../types/auth';
import type { AgencyAgentState, AgencySessionBootstrap } from '../../../types/agency';

/**
 * The two ways off a working station: `Leave station` (ends the session, behind
 * a confirmation) and `Exit station` (navigation only, for a supervisor).
 *
 * Split out of `AgentConsolePage`; the page renders the menu and the dialog.
 */
export interface StationExit {
  /** Whether `Exit station` is offered at all (above `agent`). */
  canExitToCampaign: boolean;
  /** Bootstrap's id is the authority; the query param is only how we got here. */
  stationCampaignId: string;
  leaveConfirm: boolean;
  leaving: boolean;
  leaveFailure: string | null;
  openLeave: () => void;
  confirmLeave: () => void;
  cancelLeave: () => void;
  exitStation: () => void;
}

export function useStationExit({
  campaignId,
  bootstrap,
  tenantId,
  accountId,
  role,
  agentState,
}: {
  campaignId: string;
  bootstrap: AgencySessionBootstrap | null;
  tenantId: string | null;
  accountId: string | null;
  role: Role | undefined;
  agentState: AgencyAgentState;
}): StationExit {
  const navigate = useNavigate();
  const [leaveConfirm, setLeaveConfirm] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [leaveFailure, setLeaveFailure] = useState<string | null>(null);

  /**
   * Where `Exit station` goes, and who is offered it at all.
   *
   * Above `agent` only: `/agency/campaigns/:id` sits inside the Agency
   * workspace, whose nav floors at `agency.campaigns.read` — a level-5 agent
   * would be navigated into a shell with nothing in it. Leaving, by contrast, is
   * everyone's: it is the only control that frees their live-session slot.
   *
   * A role level rather than a permission because this is not a gate on an API
   * call. Nothing about `agency.supervise` decides whether a page is worth
   * landing on, and borrowing it here would hide the exit from an `operator` or
   * `viewer` who can see the campaign perfectly well.
   */
  const canExitToCampaign = role !== undefined && getRoleLevel(role) > getRoleLevel('agent');
  /** Bootstrap's id is the authority; the query param is only how we got here. */
  const stationCampaignId = bootstrap?.campaign_id ?? campaignId;

  /**
   * Leave the station — the session-ending exit.
   *
   * `leaveAgencySession` has existed since Phase 1 and was **called from
   * nowhere**: the console had no way out except closing the tab, which tells
   * the API nothing until the heartbeat grace expires. It is wired here rather than
   * rewritten.
   *
   * Behind a confirmation because it is not undoable in one click — rejoining
   * means a fresh session and a fresh place in the pool — and because the same
   * menu carries an item one row away that does something quite different.
   *
   * On failure the dialog **stays open** carrying the reason, and the confirm
   * button becomes the retry. Navigating away on a leave that did not land would
   * leave the agent believing they had stopped receiving calls while the API still
   * had them in the pool — the one outcome this control exists to prevent.
   */
  const confirmLeave = useCallback(() => {
    const sessionId = bootstrap?.session_id;
    if (!sessionId) return;
    setLeaving(true);
    setLeaveFailure(null);
    leaveAgencySession(sessionId, tenantId ?? undefined, accountId ?? undefined)
      .then(() => {
        if (tenantId) clearLiveSession(tenantId);
        setLeaveConfirm(false);
        /**
         * An agent goes to their landing screen, carrying `?left=station`: their
         * assignment is unchanged, so a plain `/app` would resolve it and send
         * them straight back into the station they just left. A supervisor goes
         * to the campaign they were watching.
         */
        navigate(
          canExitToCampaign ? `/agency/campaigns/${stationCampaignId}` : agentLandingPath('station'),
        );
        trackAgencyStationExit({
          campaign_id: stationCampaignId,
          action: 'leave',
          outcome: 'completed',
          blocked_reason: null,
          agent_state: agentState,
          destination: canExitToCampaign ? 'campaign' : 'landing',
        });
      })
      .catch((err: unknown) => {
        setLeaving(false);
        setLeaveFailure(
          err instanceof Error ? err.message : 'Your station is still open. Try again.',
        );
        trackAgencyStationExit({
          campaign_id: stationCampaignId,
          action: 'leave',
          outcome: 'failed',
          blocked_reason: null,
          agent_state: agentState,
          destination: null,
        });
      });
  }, [
    bootstrap?.session_id,
    tenantId,
    accountId,
    navigate,
    canExitToCampaign,
    stationCampaignId,
    agentState,
  ]);

  /**
   * Exit station — navigation, and nothing else.
   *
   * The session stays live and the socket closes on unmount (the station hook's
   * cleanup, unchanged). That is the point of having two controls: a supervisor
   * who joined to cover ten minutes gets their screen back without telling the
   * dialer they have gone home. It is also why the two never share a label.
   */
  const exitStation = useCallback(() => {
    navigate(`/agency/campaigns/${stationCampaignId}`);
    trackAgencyStationExit({
      campaign_id: stationCampaignId,
      action: 'exit',
      outcome: 'completed',
      blocked_reason: null,
      agent_state: agentState,
      destination: 'campaign',
    });
    /**
     * `blocked_reason` is only ever `null` from this page: `StationMenu`'s
     * click handlers return early on `leaveBlocked`/`exitBlocked` before
     * calling `onLeave`/`onExit` at all (`aria-disabled` plus a handler guard,
     * never `disabled`), so a blocked attempt is never observable from here.
     * There is deliberately no `outcome: 'blocked'` variant wired up.
     */
  }, [navigate, stationCampaignId, agentState]);

  const openLeave = useCallback(() => setLeaveConfirm(true), []);

  /**
   * **Refused while the request is in flight.**
   *
   * `ConfirmDialog`'s `disabled` guards the confirm button only —
   * Escape and a click on the overlay call `onCancel` unconditionally.
   * Without this, cancelling mid-request unmounts the dialog, the
   * rejection then sets `leaveFailure` on a surface nobody can see, and
   * the menu item reads "Leave station" again: the agent believes they
   * left while the API still has them in the pool. That is exactly the
   * outcome `confirmLeave` refuses to produce by navigation, arriving
   * through the Escape key instead.
   */
  const cancelLeave = useCallback(() => {
    if (leaving) return;
    setLeaveConfirm(false);
    setLeaveFailure(null);
  }, [leaving]);

  return {
    canExitToCampaign,
    stationCampaignId,
    leaveConfirm,
    leaving,
    leaveFailure,
    openLeave,
    confirmLeave,
    cancelLeave,
    exitStation,
  };
}
