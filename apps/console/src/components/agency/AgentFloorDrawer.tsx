import { useState } from 'react';
import { useTenant } from '../../contexts/TenantContext';
import { useToast } from '../../contexts/ToastContext';
import { forceAgentAvailable } from '../../api/agency';
import { ApiError } from '../../api/client';
import { Modal } from '../common/Modal';
import { ConfirmDialog } from '../common/ConfirmDialog';
import {
  AGENCY_FLOOR_STATE_LABELS,
  FORCE_AVAILABLE_CONFIRM,
  FORCE_AVAILABLE_REASON_MAX,
  agentDisplayName,
  canForceAvailable,
  forceAvailableConfirmMessage,
  hasResolvedName,
  secondsInStateBucket,
  timeInStateMs,
  type AgencyFloorSort,
} from '../../utils/agencyAgentFloor';
import { formatDuration } from '../../utils/agencyClock';
import { trackAgencyFloorIntervention } from '../../analytics/events';
import type { AgencySupervisorAgent } from '../../types/agency-campaign';
import styles from './AgentFloorDrawer.module.css';

/**
 * The tile's drawer (§C.4) and MAG-142's force-return control.
 *
 * ── What this drawer deliberately does NOT show ─────────────────────────────
 * §C.4 also asks for a shift timeline, the dispositions this agent has given,
 * and the contact they are on. **No endpoint serves any of the three.** Core's
 * supervisor payload carries the eight roster fields below and nothing else,
 * there is no `GET /agency/sessions/:id`, and no master proxy for one. Rather
 * than invent an endpoint or fabricate a timeline out of `state_since` — which
 * would be one transition presented as a history — the drawer is scoped to what
 * the roster provides plus the control that acts on it. The three gaps are
 * ticketed separately.
 *
 * Everything here is therefore already on screen in the tile; the drawer's job
 * is to give it room and to be the place the control lives, because a
 * destructive action reachable by a stray click on a grid tile is a destructive
 * action that will be taken by accident.
 */

export interface AgentFloorDrawerProps {
  /** Attributes the force-available analytics event to a campaign — never an agent identity. */
  campaignId: string;
  agent: AgencySupervisorAgent;
  /** The floor's shared ticking clock, so the drawer's duration matches the tile. */
  now: number;
  /** `hasPermission(role, 'agency.supervise')` — master's gate, mirrored. */
  canSupervise: boolean;
  /** The floor's sort mode when this drawer was opened, for `trackAgencyFloorIntervention`. */
  sort: AgencyFloorSort;
  onClose: () => void;
  /** Called after a successful force-return so the page re-reads the floor. */
  onForced: () => void;
}

/** "Connected", "Disconnected", or the honest third answer. */
function connectionCopy(connected: boolean | null): { label: string; tone: string } {
  if (connected === true) return { label: 'Station connected', tone: 'ok' };
  if (connected === false) return { label: 'Station disconnected — no heartbeat', tone: 'bad' };
  /*
    `null` is core's Redis read having failed, and it gets its own sentence.
    Collapsing it into "Disconnected" would be the console reporting a fault of
    its own as a fact about a person, on the screen where a supervisor decides
    whether to go and find them.
  */
  return { label: 'Couldn’t check whether their station is connected', tone: 'unknown' };
}

export function AgentFloorDrawer({
  campaignId,
  agent,
  now,
  canSupervise,
  sort,
  onClose,
  onForced,
}: AgentFloorDrawerProps) {
  const { tenantId, accountId } = useTenant();
  const { showToast, showErrorToast } = useToast();

  const [reason, setReason] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  const displayName = agentDisplayName(agent);
  const elapsedMs = timeInStateMs(agent, now);
  const connection = connectionCopy(agent.connected);

  /*
    Both halves, and both are required. `canForceAvailable` is the SESSION's
    state — the route is the only thing that can end a held wrap-up and is for
    nothing else. `canSupervise` is the VIEWER's permission and must be the same
    `agency.supervise` master gates the route on, or the button 403s on click.
  */
  const showForce = canSupervise && canForceAvailable(agent);

  const runForce = async () => {
    setBusy(true);
    try {
      await forceAgentAvailable(
        agent.session_id,
        reason,
        tenantId ?? undefined,
        accountId ?? undefined,
      );
      showToast(`${displayName} is back in the pool.`, 'success');
      // Bucketed state, never the agent's id/name — see events.ts.
      trackAgencyFloorIntervention({
        campaign_id: campaignId,
        action: 'force_available',
        target_state: agent.state,
        seconds_in_state_bucket: secondsInStateBucket(elapsedMs),
        sort,
      });
      onForced();
    } catch (err: unknown) {
      /*
        A 403 here is an answer, not a transport failure — and it means the UI
        gate and the API gate have drifted, which is worth saying plainly rather
        than showing master's masked body. Handled rather than swallowed: a
        control that silently does nothing is worse than one that refuses, because
        the supervisor's next move is to click it again.
      */
      if (err instanceof ApiError && err.statusCode === 403) {
        showErrorToast(
          new Error('You don’t have permission to end another agent’s wrap-up.'),
        );
      } else {
        showErrorToast(err, 'Could not return this agent to the pool.');
      }
      setBusy(false);
    }
  };

  return (
    <>
      <Modal
        open
        onClose={onClose}
        title={displayName}
        subtitle={hasResolvedName(agent) ? undefined : 'We couldn’t look up this person’s name.'}
        size="sm"
      >
        <dl className={styles.facts} data-testid="agent-drawer-facts">
          <div className={styles.fact}>
            <dt>State</dt>
            <dd data-testid="agent-drawer-state">
              {AGENCY_FLOOR_STATE_LABELS[agent.state]}
              {agent.state === 'break' && agent.break_reason ? ` · ${agent.break_reason}` : ''}
            </dd>
          </div>
          <div className={styles.fact}>
            <dt>Time in state</dt>
            {/* Never `0:00` for an unparseable anchor — a dash says "we can't say". */}
            <dd data-testid="agent-drawer-elapsed">
              {elapsedMs === null ? '—' : formatDuration(elapsedMs)}
            </dd>
          </div>
          <div className={styles.fact}>
            <dt>Calls this shift</dt>
            <dd>{agent.calls_handled.toLocaleString()}</dd>
          </div>
          <div className={styles.fact}>
            <dt>Station</dt>
            <dd data-tone={connection.tone} data-testid="agent-drawer-connection">
              {connection.label}
            </dd>
          </div>
          <div className={styles.fact}>
            <dt>User id</dt>
            {/*
              Shown in full here even when the name resolved: it is what a
              supervisor quotes to support, and the tile only ever has room for
              a truncation of it.
            */}
            <dd className={styles.mono}>{agent.agent_user_id}</dd>
          </div>
        </dl>

        {showForce ? (
          <div className={styles.control}>
            <label className={styles.reasonLabel} htmlFor="force-available-reason">
              Reason <span className={styles.optional}>(optional)</span>
            </label>
            <textarea
              id="force-available-reason"
              className={styles.reason}
              value={reason}
              maxLength={FORCE_AVAILABLE_REASON_MAX}
              rows={2}
              placeholder="Recorded against this override — e.g. “left for the day”."
              onChange={(e) => setReason(e.target.value)}
              disabled={busy}
            />
            <button
              type="button"
              className="btn-danger"
              onClick={() => setConfirming(true)}
              disabled={busy}
              data-testid="force-available-button"
            >
              {busy ? 'Working…' : 'End wrap-up'}
            </button>
          </div>
        ) : null}
      </Modal>

      {confirming && (
        <ConfirmDialog
          open
          title={FORCE_AVAILABLE_CONFIRM.title}
          message={forceAvailableConfirmMessage(displayName)}
          confirmLabel={FORCE_AVAILABLE_CONFIRM.confirmLabel}
          danger
          disabled={busy}
          onConfirm={() => {
            setConfirming(false);
            void runForce();
          }}
          onCancel={() => setConfirming(false)}
        />
      )}
    </>
  );
}

export default AgentFloorDrawer;
