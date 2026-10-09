import { StatusBadge } from '../../components/common/StatusBadge';
import type { AgencyCampaignStatus } from '../../types/agency-campaign';

/**
 * Campaign status, in the operator's words.
 *
 * `stopping` gets its own label rather than collapsing into "Stopped", because
 * it is a state a supervisor genuinely sits in: `POST /stop` answers 200 with
 * `stopping`, and only core's pacing leader writes `stopped`, once in-flight
 * attempts drain. Showing "Stopped" while calls are still connected would be
 * telling them the opposite of what is happening on the phones.
 */
const STATUS_META: Record<AgencyCampaignStatus, { label: string; color: string; tooltip: string }> = {
  draft: {
    label: 'Draft',
    color: 'var(--text-muted)',
    tooltip: 'Not started. Nothing is being dialed.',
  },
  running: {
    label: 'Running',
    color: 'var(--success)',
    tooltip: 'Dialing now, within the campaign’s calling hours.',
  },
  paused: {
    label: 'Paused',
    color: 'var(--warning)',
    tooltip: 'No new calls. Calls already in progress finish normally.',
  },
  stopping: {
    label: 'Stopping',
    color: 'var(--warning)',
    tooltip: 'No new calls. Waiting for calls already in progress to finish.',
  },
  stopped: {
    label: 'Stopped',
    color: 'var(--text-muted)',
    tooltip: 'Ended by a supervisor. It cannot be restarted.',
  },
  completed: {
    label: 'Completed',
    color: 'var(--accent)',
    tooltip: 'Every contact has been dialed or exhausted its retries.',
  },
};

function isKnown(status: string): status is AgencyCampaignStatus {
  return status in STATUS_META;
}

export function AgencyCampaignStatusBadge({ status }: { status: string }) {
  // An unrecognised status is shown verbatim rather than mapped to a default.
  // Core's CHECK constraint is the authority on this column; if it grows a value
  // this build has never heard of, showing it raw is honest and showing
  // "Draft" would be a fabrication.
  if (!isKnown(status)) {
    return <StatusBadge label={status} status={status} />;
  }
  const meta = STATUS_META[status];
  return <StatusBadge label={meta.label} color={meta.color} tooltip={meta.tooltip} status={status} />;
}
