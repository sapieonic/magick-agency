import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { useTenant } from '../../contexts/TenantContext';
import { useToast } from '@magick-agency/web-ui/contexts/ToastContext';
import { ErrorAlert } from '@magick-agency/web-ui/components/ErrorAlert';
import { getErrorMessage } from '@magick-agency/web-ui/errors';
import { getAssignmentProgress } from '../../api/agencyAssignment';
import {
  BUCKET_ROSTER_STATES,
  CONTACT_BUCKET_LABELS,
  FORMER_MEMBER_LABEL,
  UNASSIGNED_LABEL,
  assignmentResultToast,
  dueWhileAbsentFlag,
  unassignedOpenWarning,
} from '../../utils/agencyAssignmentCopy';
import { rosterLinkFor } from '../../utils/agencyAssignmentOps';
import { formatSpineTimestamp } from '../../utils/agencySpineCopy';
import { AgencyAssignmentDialog, type AssignmentAgentOption } from './AgencyAssignmentDialog';
import {
  AGENCY_UNASSIGNED_FILTER,
} from '../../types/agency-spine';
import type {
  AgencyAssignmentProgress,
  AgencyAssignmentProgressRow,
  AgencyContactBucketCounts,
  AgencyMyContactBucket,
} from '@magick-agency/contracts/api/agency/assignment';
import styles from './CampaignAssignmentProgress.module.css';

/**
 * How far each agent has got through the contacts assigned to them, under the
 * staffing list on the campaign's Agents panel (contact assignment).
 *
 * One row per agent who is staffed or holds contacts, then the pool. Each count
 * links to the roster narrowed to that owner and state, so "12 not reached" is
 * one click from the twelve rows. Two things are called out rather than left in
 * the numbers:
 *
 *  - **Strict mode's unassigned contacts.** They are never dialled and keep the
 *    campaign from completing, so a banner says how many.
 *  - **Contacts falling due while their agent is away.** `due_while_absent` is the
 *    supervisor's cue to move them; the flag carries a "Reassign…" that opens the
 *    reassign dialog with that agent filled in.
 *
 * The parent mounts this only for a supervisor while the
 * `agency_contact_assignment_enabled` flag is on: the read answers 403 otherwise.
 */

/** The bucket columns, in the order a supervisor reads a shift. */
const BUCKET_COLUMNS: ReadonlyArray<{ bucket: AgencyMyContactBucket; label: string }> = [
  { bucket: 'pending', label: 'Pending' },
  { bucket: 'callback', label: 'Callbacks' },
  { bucket: 'not_reached', label: 'Not reached' },
  { bucket: 'reached', label: 'Reached' },
  { bucket: 'exhausted', label: 'Exhausted' },
  { bucket: 'suppressed', label: 'DNC / suppressed' },
];

export function CampaignAssignmentProgress({ campaignId }: { campaignId: string }) {
  const { tenantId, accountId } = useTenant();
  const { showToast } = useToast();
  const [progress, setProgress] = useState<AgencyAssignmentProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [reassignFrom, setReassignFrom] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!tenantId || !accountId) return;
    setLoading(true);
    setError(null);
    try {
      setProgress(await getAssignmentProgress(campaignId, {}, tenantId, accountId));
    } catch (err: unknown) {
      setError(getErrorMessage(err, 'Could not load each agent’s progress.'));
    } finally {
      setLoading(false);
    }
  }, [campaignId, tenantId, accountId]);

  useEffect(() => {
    void load();
  }, [load]);

  const nameOf = useCallback(
    (row: Pick<AgencyAssignmentProgressRow, 'agent_name'>) => row.agent_name ?? FORMER_MEMBER_LABEL,
    [],
  );
  const names = useMemo(
    () => new Map((progress?.agents ?? []).map((row) => [row.agent_user_id, nameOf(row)])),
    [progress, nameOf],
  );
  /** Targets: staffed agents only, as the server requires. */
  const targets = useMemo((): AssignmentAgentOption[] => (progress?.agents ?? [])
    .filter((row) => row.staffed)
    .map((row) => ({ user_id: row.agent_user_id, name: nameOf(row) })), [progress, nameOf]);
  /** Sources: anyone holding contacts, staffed or not. */
  const owners = useMemo((): AssignmentAgentOption[] => (progress?.agents ?? [])
    .map((row) => ({ user_id: row.agent_user_id, name: nameOf(row) })), [progress, nameOf]);

  const countCell = (owner: string, counts: AgencyContactBucketCounts, bucket: AgencyMyContactBucket) => {
    const count = counts[bucket];
    return (
      <td key={bucket} className={styles.numeric}>
        {count > 0 ? (
          <Link
            to={rosterLinkFor(campaignId, owner, BUCKET_ROSTER_STATES[bucket])}
            aria-label={`${count.toLocaleString()} ${CONTACT_BUCKET_LABELS[bucket]}`}
          >
            {count.toLocaleString()}
          </Link>
        ) : (
          <span className={styles.zero}>0</span>
        )}
      </td>
    );
  };

  return (
    <section className={styles.panel} aria-labelledby="assignment-progress-heading" data-testid="assignment-progress">
      <div className={styles.header}>
        <div>
          <h2 className={styles.title} id="assignment-progress-heading">Contacts by agent</h2>
          <p className={styles.description}>
            How far each agent has got through the contacts assigned to them. Select a number to see
            those contacts.
          </p>
        </div>
        <button
          type="button"
          className="btn-secondary"
          onClick={() => void load()}
          disabled={loading}
          aria-label="Refresh contacts by agent"
        >
          <RefreshCw size={14} aria-hidden="true" />
        </button>
      </div>

      {error && <ErrorAlert message={error} onRetry={() => void load()} />}

      {progress && progress.assignment_mode === 'strict' && progress.unassigned_open > 0 ? (
        <p className={styles.warning} role="status" data-testid="progress-unassigned-open">
          <AlertTriangle size={15} aria-hidden="true" />
          <span>
            {unassignedOpenWarning(progress.unassigned_open)}{' '}
            <Link to={rosterLinkFor(campaignId, AGENCY_UNASSIGNED_FILTER, ['pending'])}>
              Show them
            </Link>
          </span>
        </p>
      ) : null}

      {progress && (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <caption className={styles.srOnly}>Contacts assigned to each agent on this campaign</caption>
            <thead>
              <tr>
                <th scope="col">Agent</th>
                <th scope="col" className={styles.numeric}>Assigned</th>
                {BUCKET_COLUMNS.map((column) => (
                  <th key={column.bucket} scope="col" className={styles.numeric}>{column.label}</th>
                ))}
                <th scope="col" className={styles.numeric}>Attempted</th>
                <th scope="col" className={styles.numeric}>Due now</th>
                <th scope="col">Last activity</th>
              </tr>
            </thead>
            <tbody>
              {progress.agents.length === 0 ? (
                <tr>
                  <td colSpan={BUCKET_COLUMNS.length + 5} className={styles.zero}>
                    No contacts are assigned to anyone yet. Assign them from the Contacts tab.
                  </td>
                </tr>
              ) : null}
              {progress.agents.map((row) => (
                <tr key={row.agent_user_id} data-testid={`progress-row-${row.agent_user_id}`}>
                  <th scope="row" className={styles.agent}>
                    <span
                      className={styles.liveDot}
                      data-live={row.live ? 'true' : 'false'}
                      aria-hidden="true"
                    />
                    <span className={styles.srOnly}>{row.live ? 'On the campaign now: ' : 'Not on the campaign: '}</span>
                    {nameOf(row)}
                    {!row.staffed ? <span className={styles.muted}> (not on this campaign)</span> : null}
                    {row.due_while_absent > 0 ? (
                      <span className={styles.absent} data-testid={`progress-absent-${row.agent_user_id}`}>
                        <AlertTriangle size={13} aria-hidden="true" />
                        {dueWhileAbsentFlag(row.due_while_absent, progress.absent_after_minutes)}
                        <button
                          type="button"
                          className={styles.linkButton}
                          onClick={() => setReassignFrom(row.agent_user_id)}
                          data-testid={`progress-reassign-${row.agent_user_id}`}
                        >
                          Reassign…
                        </button>
                      </span>
                    ) : null}
                  </th>
                  <td className={styles.numeric}>
                    {row.assigned > 0 ? (
                      <Link to={rosterLinkFor(campaignId, row.agent_user_id)}>{row.assigned.toLocaleString()}</Link>
                    ) : <span className={styles.zero}>0</span>}
                  </td>
                  {BUCKET_COLUMNS.map((column) => countCell(row.agent_user_id, row.counts, column.bucket))}
                  <td className={styles.numeric}>{row.attempted.toLocaleString()}</td>
                  <td className={styles.numeric}>{row.due_now.toLocaleString()}</td>
                  <td className={styles.when}>{formatSpineTimestamp(row.last_activity_at)}</td>
                </tr>
              ))}
              <tr className={styles.poolRow} data-testid="progress-pool">
                <th scope="row" className={styles.agent}>{`${UNASSIGNED_LABEL} (pool)`}</th>
                <td className={styles.numeric}>
                  {progress.pool.total > 0 ? (
                    <Link to={rosterLinkFor(campaignId, AGENCY_UNASSIGNED_FILTER)}>
                      {progress.pool.total.toLocaleString()}
                    </Link>
                  ) : <span className={styles.zero}>0</span>}
                </td>
                {BUCKET_COLUMNS.map((column) => countCell(AGENCY_UNASSIGNED_FILTER, progress.pool.counts, column.bucket))}
                <td className={styles.numeric}>—</td>
                <td className={styles.numeric}>{progress.pool.due_now.toLocaleString()}</td>
                <td className={styles.when}>—</td>
              </tr>
            </tbody>
          </table>
        </div>
      )}

      {reassignFrom !== null && (
        <AgencyAssignmentDialog
          campaignId={campaignId}
          kind="reassign"
          agents={targets.filter((agent) => agent.user_id !== reassignFrom)}
          owners={owners}
          agentName={(userId) => names.get(userId) ?? FORMER_MEMBER_LABEL}
          prefill={{ fromId: reassignFrom }}
          origin="progress"
          onClose={() => setReassignFrom(null)}
          onCommitted={(result) => {
            setReassignFrom(null);
            showToast(assignmentResultToast(result), 'success');
            void load();
          }}
        />
      )}
    </section>
  );
}
