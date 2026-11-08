import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { CalendarClock, Plus } from 'lucide-react';
import type { AgencyReportSubscription } from '@magick-agency/contracts/api/agency/reports';
import { EmptyState } from '@magick-agency/web-ui/components/EmptyState';
import { ErrorAlert } from '@magick-agency/web-ui/components/ErrorAlert';
import { LoadingSpinner } from '@magick-agency/web-ui/components/LoadingSpinner';
import { useToast } from '@magick-agency/web-ui/contexts/ToastContext';
import { useTenant } from '../../../contexts/TenantContext';
import {
  deleteReportSubscription,
  listReportSubscriptions,
  reportErrorMessage,
  runReportSubscriptionNow,
  updateReportSubscription,
} from '../../../api/reports';
import { listTenantMembers } from '../../../api/tenants';
import { listAgencyCampaigns } from '../../../api/agencyCampaigns';
import type { TenantMember } from '../../../types/team';
import type { AgencyCampaign } from '../../../types/agency-campaign';
import { reportRunPath } from '../../../hooks/useReportsAccess';
import { trackAgencyReportSubscriptionChanged } from '../../../analytics/events';
import {
  REPORT_KIND_LABELS,
  cadenceDescription,
  formatReportWhen,
  subjectLabel,
} from '../../../utils/reports/reportCopy';
import { ReportStatusPill } from './ReportStatusPill';
import { SubscriptionFormDialog } from './SubscriptionFormDialog';
import styles from './Reports.module.css';

type ListState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; subscriptions: AgencyReportSubscription[] };

/** The recipients' names, for the table. */
function recipientNames(sub: AgencyReportSubscription): string {
  return sub.recipients.map((r) => r.name ?? 'A former team member').join(', ') || '—';
}

/**
 * The Reports page's Subscriptions tab (supervisors only): every scheduled report of
 * the account, with its schedule, recipients, next send and last run; pause and
 * resume in place, edit, run now, and delete behind an in-page confirmation.
 */
export function SubscriptionsPanel() {
  const { tenantId, accountId, role } = useTenant();
  const navigate = useNavigate();
  const { showToast } = useToast();
  const [state, setState] = useState<ListState>({ status: 'loading' });
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<AgencyReportSubscription | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ id: string; message: string } | null>(null);
  const [members, setMembers] = useState<TenantMember[] | null>(null);
  const [campaigns, setCampaigns] = useState<AgencyCampaign[] | null>(null);
  const pickersRequested = useRef(false);

  const load = useCallback(() => {
    if (!tenantId || !accountId) return undefined;
    let cancelled = false;
    setState({ status: 'loading' });
    listReportSubscriptions(tenantId, accountId)
      .then((list) => {
        if (!cancelled) setState({ status: 'ready', subscriptions: list.subscriptions });
      })
      .catch((err: unknown) => {
        if (!cancelled) setState({ status: 'error', message: reportErrorMessage(err, 'We couldn’t load the scheduled reports.') });
      });
    return () => {
      cancelled = true;
    };
  }, [tenantId, accountId]);

  useEffect(load, [load]);

  /** The form's pickers (team members and campaigns), read once, the first time it opens. */
  const loadPickers = () => {
    if (pickersRequested.current || !tenantId || !accountId) return;
    pickersRequested.current = true;
    listTenantMembers(tenantId)
      .then(setMembers)
      .catch(() => setMembers([]));
    listAgencyCampaigns(tenantId, accountId)
      .then(setCampaigns)
      .catch(() => setCampaigns([]));
  };

  const openForm = (sub: AgencyReportSubscription | null) => {
    loadPickers();
    setEditing(sub);
    setFormOpen(true);
  };

  const replace = (sub: AgencyReportSubscription) =>
    setState((prev) =>
      prev.status === 'ready'
        ? {
            status: 'ready',
            subscriptions: prev.subscriptions.some((s) => s.id === sub.id)
              ? prev.subscriptions.map((s) => (s.id === sub.id ? sub : s))
              : [sub, ...prev.subscriptions],
          }
        : prev,
    );

  const act = async (sub: AgencyReportSubscription, action: 'pause' | 'resume' | 'delete' | 'run_now') => {
    if (!tenantId || !accountId) return;
    setBusy(sub.id);
    setRowError(null);
    try {
      if (action === 'delete') {
        await deleteReportSubscription(sub.id, tenantId, accountId);
        setState((prev) =>
          prev.status === 'ready' ? { status: 'ready', subscriptions: prev.subscriptions.filter((s) => s.id !== sub.id) } : prev,
        );
        setConfirmDelete(null);
        trackAgencyReportSubscriptionChanged({ kind: sub.kind, cadence: sub.cadence, action: 'deleted' });
        showToast('Scheduled report deleted. The reports it already sent are kept.', 'success');
      } else if (action === 'run_now') {
        const run = await runReportSubscriptionNow(sub.id, tenantId, accountId);
        trackAgencyReportSubscriptionChanged({ kind: sub.kind, cadence: sub.cadence, action: 'run_now' });
        const path = reportRunPath(role, run.id);
        showToast('The report is being prepared.', 'success', 8000, { label: 'View report', onClick: () => navigate(path) });
      } else {
        const updated = await updateReportSubscription(sub.id, { enabled: action === 'resume' }, tenantId, accountId);
        replace(updated);
        trackAgencyReportSubscriptionChanged({
          kind: sub.kind,
          cadence: sub.cadence,
          action: action === 'resume' ? 'resumed' : 'paused',
        });
      }
    } catch (err) {
      setRowError({ id: sub.id, message: reportErrorMessage(err, 'That didn’t work. Try again.') });
    } finally {
      setBusy(null);
    }
  };

  const newButton = (
    <button type="button" className="btn-primary" onClick={() => openForm(null)} data-testid="subscription-new">
      <Plus size={14} aria-hidden="true" />
      New scheduled report
    </button>
  );

  return (
    <section className={styles.page} aria-label="Scheduled reports">
      {state.status === 'loading' ? (
        <LoadingSpinner />
      ) : state.status === 'error' ? (
        <ErrorAlert message={state.message} onRetry={load} />
      ) : state.subscriptions.length === 0 ? (
        <EmptyState
          icon={<CalendarClock size={32} />}
          title="No scheduled reports"
          description="Send an agent review, a campaign report or the account report to supervisors every day, week or month."
          action={newButton}
        />
      ) : (
        <>
          <div className={styles.toolbar}>
            <p className={styles.muted}>Scheduled reports are emailed to their recipients as a link to the report.</p>
            {newButton}
          </div>
          <div className={styles.tableCard}>
            <div className={styles.tableWrap}>
              <table>
                <thead>
                  <tr>
                    <th>Report</th>
                    <th>Schedule</th>
                    <th>Recipients</th>
                    <th>Next send</th>
                    <th>Last run</th>
                    <th>Enabled</th>
                    <th>
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {state.subscriptions.map((sub) => (
                    <tr key={sub.id} data-testid="subscription-row" data-subscription-id={sub.id}>
                      <td>
                        <div className={styles.subjectCell}>
                          <span>{subjectLabel(sub.kind, sub.subject)}</span>
                          <span className={styles.muted}>{REPORT_KIND_LABELS[sub.kind]}</span>
                        </div>
                      </td>
                      <td data-testid="subscription-cadence">{cadenceDescription(sub)}</td>
                      <td>{recipientNames(sub)}</td>
                      <td>{sub.enabled ? formatReportWhen(sub.next_run_at) : 'Paused'}</td>
                      <td>
                        {sub.last_run ? (
                          <Link to={reportRunPath(role, sub.last_run.id)} aria-label="Open the last run">
                            <ReportStatusPill status={sub.last_run.status} />
                          </Link>
                        ) : (
                          <span className={styles.muted}>Not sent yet</span>
                        )}
                      </td>
                      <td>
                        <label className={styles.checkOption}>
                          <input
                            type="checkbox"
                            role="switch"
                            checked={sub.enabled}
                            disabled={busy === sub.id}
                            onChange={(e) => void act(sub, e.target.checked ? 'resume' : 'pause')}
                            aria-label={`${sub.enabled ? 'Pause' : 'Resume'} ${subjectLabel(sub.kind, sub.subject)}`}
                          />
                          {sub.enabled ? 'On' : 'Paused'}
                        </label>
                      </td>
                      <td>
                        {confirmDelete === sub.id ? (
                          <div className={styles.confirm} role="group" aria-label="Confirm delete">
                            <span>Delete this scheduled report?</span>
                            <button
                              type="button"
                              className="btn-danger"
                              onClick={() => void act(sub, 'delete')}
                              disabled={busy === sub.id}
                              data-testid="subscription-confirm-delete"
                            >
                              Delete
                            </button>
                            <button type="button" className="btn-secondary" onClick={() => setConfirmDelete(null)}>
                              Keep it
                            </button>
                          </div>
                        ) : (
                          <div className={styles.actions}>
                            <button type="button" className="btn-secondary" onClick={() => openForm(sub)} disabled={busy === sub.id}>
                              Edit
                            </button>
                            <button
                              type="button"
                              className="btn-secondary"
                              onClick={() => void act(sub, 'run_now')}
                              disabled={busy === sub.id}
                            >
                              Run now
                            </button>
                            <button
                              type="button"
                              className="btn-secondary"
                              onClick={() => setConfirmDelete(sub.id)}
                              disabled={busy === sub.id}
                            >
                              Delete
                            </button>
                          </div>
                        )}
                        {rowError?.id === sub.id ? (
                          <p className={styles.inlineError} role="alert">
                            {rowError.message}
                          </p>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      <SubscriptionFormDialog
        open={formOpen}
        onClose={() => setFormOpen(false)}
        editing={editing}
        members={members}
        campaigns={campaigns}
        onSaved={(sub, action) => {
          replace(sub);
          setFormOpen(false);
          trackAgencyReportSubscriptionChanged({ kind: sub.kind, cadence: sub.cadence, action });
          showToast(action === 'created' ? 'Scheduled report created.' : 'Scheduled report saved.', 'success');
        }}
      />
    </section>
  );
}

export default SubscriptionsPanel;
