import { Navigate, useSearchParams } from 'react-router-dom';
import { FileText } from 'lucide-react';
import { PageHeader } from '@magick-agency/web-ui/components/PageHeader';
import { LoadingSpinner } from '@magick-agency/web-ui/components/LoadingSpinner';
import { EmptyState } from '@magick-agency/web-ui/components/EmptyState';
import { useTenant } from '../../contexts/TenantContext';
import { useReportsAccess } from '../../hooks/useReportsAccess';
import { isDedicatedAgent } from '../../utils/agencyPersona';
import { AgentSurfaceShell } from '../../components/agency/AgentSurfaceShell';
import { CapabilityUnavailable } from '../../components/common/CapabilityUnavailable';
import { ReportHistory } from '../../components/agency/reports/ReportHistory';
import { SubscriptionsPanel } from '../../components/agency/reports/SubscriptionsPanel';
import { ExportReportButton } from '../../components/agency/reports/ExportReportButton';
import styles from '../../components/agency/reports/Reports.module.css';

/**
 * Reports (`docs/reports.md`): the History of runs and, for supervisors, the
 * Subscriptions that produce them on a schedule.
 *
 * Served twice, like customer history: at `/agency/reports` in the agency shell, and
 * at `/dialer/reports` in a dedicated agent's own frame (`AgentSurfaceShell`),
 * because an `agent` is below every entry of the agency shell. A dedicated agent who
 * opens the agency path (a shared link) is sent to their own.
 *
 * Both routes sit inside the dialer gate and the `agency_reports_enabled` flag gate;
 * the flag is read again here so a page mounted without its route (a test, a future
 * move) still fails closed.
 */

type Surface = 'agency' | 'agent';
type Tab = 'history' | 'subscriptions';

export default function ReportsPage({ surface = 'agency' }: { surface?: Surface }) {
  const { role, accounts, accountId } = useTenant();
  const access = useReportsAccess();
  const [params, setParams] = useSearchParams();

  if (role === undefined) return <LoadingSpinner />;
  if (surface === 'agency' && isDedicatedAgent(role)) {
    const tab = params.get('tab');
    return <Navigate to={`/dialer/reports${tab ? `?tab=${encodeURIComponent(tab)}` : ''}`} replace />;
  }
  if (!access.enabled) return <CapabilityUnavailable />;

  const tab: Tab = access.canSupervise && params.get('tab') === 'subscriptions' ? 'subscriptions' : 'history';
  const setTab = (next: Tab) =>
    setParams(
      (prev) => {
        const out = new URLSearchParams(prev);
        if (next === 'history') out.delete('tab');
        else out.set('tab', next);
        return out;
      },
      { replace: true },
    );

  const accountName = accounts.find((a) => a.id === accountId)?.name ?? null;
  const headerAction = access.canSupervise ? (
    accountId ? (
      <ExportReportButton
        entry="reports_page"
        target={{ kind: 'account', subject: { id: accountId, name: accountName } }}
      />
    ) : null
  ) : (
    <ExportReportButton entry="reports_page" target={{ self: true }} />
  );

  let body;
  if (!access.canSelf) {
    body = (
      <EmptyState
        icon={<FileText size={32} />}
        title="Reports aren’t available to you"
        description="Ask an account admin if you need a report."
      />
    );
  } else {
    body = (
      <>
        {access.canSupervise ? (
          <div className={styles.tabs} role="tablist" aria-label="Reports">
            <button
              type="button"
              role="tab"
              id="reports-tab-history"
              aria-selected={tab === 'history'}
              aria-controls="reports-panel"
              className={styles.tab}
              onClick={() => setTab('history')}
            >
              History
            </button>
            <button
              type="button"
              role="tab"
              id="reports-tab-subscriptions"
              aria-selected={tab === 'subscriptions'}
              aria-controls="reports-panel"
              className={styles.tab}
              onClick={() => setTab('subscriptions')}
              data-testid="reports-tab-subscriptions"
            >
              Subscriptions
            </button>
          </div>
        ) : null}
        <div
          id="reports-panel"
          role={access.canSupervise ? 'tabpanel' : undefined}
          aria-labelledby={access.canSupervise ? `reports-tab-${tab}` : undefined}
        >
          {tab === 'subscriptions' ? (
            <SubscriptionsPanel />
          ) : (
            <ReportHistory canSupervise={access.canSupervise} userId={access.userId} />
          )}
        </div>
      </>
    );
  }

  if (surface === 'agent') {
    return (
      <AgentSurfaceShell
        icon={<FileText size={20} />}
        title="My reports"
        subtitle="Your exported reviews. Each one stays available to download for 90 days."
        current="reports"
      >
        <div className={styles.page}>
          <div className={styles.toolbar}>
            <span />
            {headerAction}
          </div>
          {body}
        </div>
      </AgentSurfaceShell>
    );
  }

  return (
    <div className={styles.page}>
      <PageHeader
        title="Reports"
        subtitle={
          access.canSupervise
            ? 'Agent reviews, campaign reports and account reports as PDF and Excel, ad hoc or on a schedule.'
            : 'Your exported reviews, as PDF and Excel.'
        }
        actions={headerAction}
      />
      {body}
    </div>
  );
}

/** `/dialer/reports`: the same page in a dedicated agent's own frame. */
export function AgentReportsPage() {
  return <ReportsPage surface="agent" />;
}
