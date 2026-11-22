import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { ErrorAlert } from '@magick-agency/web-ui/components/ErrorAlert';
import { ChoiceCardGroup, type ChoiceCardOption } from '../../../../components/campaign-setup';
import { UserAvatar } from '../../../../components/common/UserAvatar';
import type { StaffingAgent } from '../../../../hooks/useCampaignStaffing';
import styles from './AgentPicker.module.css';

export interface AgentPickerProps {
  /** Everyone who can be picked (`useCampaignStaffing().agents`). */
  agents: readonly StaffingAgent[];
  /** The ticked user ids. */
  selected: readonly string[];
  onChange: (ids: string[]) => void;
  loading: boolean;
  error: string | null;
  onRetry?: () => void;
  disabled?: boolean;
  /** Where to invite people (`useCampaignStaffing().invitePath`); `null` when the reader may not. */
  invitePath?: string | null;
  /** The list's accessible name; the step's heading says it on screen. */
  legend?: string;
  /** For `aria-describedby`, e.g. the line under the list. */
  describedBy?: string;
}

/**
 * Step 4's agent cards (CS10): a tick box, the initials, the name and the person's persona
 * (Agent or Supervisor) on the right. Languages are not shown: there are none yet (CS5).
 * Controlled; `useCampaignStaffing` loads the people and applies the ticks on save.
 */
export function AgentPicker({
  agents,
  selected,
  onChange,
  loading,
  error,
  onRetry,
  disabled = false,
  invitePath = null,
  legend = 'Agents who will call',
  describedBy,
}: AgentPickerProps) {
  const options = useMemo<ChoiceCardOption[]>(
    () =>
      agents.map((agent) => ({
        value: agent.id,
        title: agent.name,
        icon: <UserAvatar user={agent.avatar} size="md" />,
        aside: agent.persona ?? undefined,
        description: agent.notSignedIn
          ? 'Has not signed in yet'
          : !agent.inTeam
            ? 'Not in this account’s team'
            : undefined,
      })),
    [agents],
  );

  if (loading && agents.length === 0) {
    return (
      <p className={styles.note} role="status" data-testid="agent-picker-loading">
        Loading your team…
      </p>
    );
  }

  return (
    <div className={styles.picker}>
      {error ? <ErrorAlert message={error} onRetry={onRetry} /> : null}
      {agents.length === 0 ? (
        // A failed read is not an empty team: the alert above is the whole answer then.
        error ? null : (
          <div className={styles.empty} data-testid="agent-picker-empty">
            <p className={styles.emptyTitle}>Nobody in this account can take calls yet.</p>
            {invitePath ? (
              <p className={styles.note}>
                <Link to={invitePath} className={styles.link} data-testid="agent-picker-invite">
                  Invite people
                </Link>{' '}
                to your team, then come back to pick them.
              </p>
            ) : (
              <p className={styles.note}>Ask an administrator to invite your agents, then come back to pick them.</p>
            )}
          </div>
        )
      ) : (
        <ChoiceCardGroup
          multiple
          columns={1}
          options={options}
          value={selected}
          // A tick the list cannot show (its person not loaded) is kept, never dropped by a click.
          onChange={(ids) => onChange([...ids, ...selected.filter((id) => !agents.some((a) => a.id === id))])}
          legend={legend}
          hideLegend
          disabled={disabled}
          describedBy={describedBy}
          testId="agent-picker"
        />
      )}
    </div>
  );
}
