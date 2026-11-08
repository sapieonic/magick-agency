import { useState } from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, FileText, RotateCcw } from 'lucide-react';
import type { AgencyReportRun } from '@magick-agency/contracts/api/agency/reports';
import { LoadingSpinner } from '@magick-agency/web-ui/components/LoadingSpinner';
import { EmptyState } from '@magick-agency/web-ui/components/EmptyState';
import { ErrorAlert } from '@magick-agency/web-ui/components/ErrorAlert';
import { useToast } from '@magick-agency/web-ui/contexts/ToastContext';
import { useTenant } from '../../contexts/TenantContext';
import { retryReport, reportErrorMessage } from '../../api/reports';
import { useReportRun } from '../../hooks/useReportRun';
import { reportRunPath, reportsBasePath, useReportsAccess } from '../../hooks/useReportsAccess';
import { isDedicatedAgent } from '../../utils/agencyPersona';
import { trackAgencyReportRunAgain } from '../../analytics/events';
import {
  REPORT_FORMAT_LABELS,
  REPORT_KIND_LABELS,
  SELF_REVIEW_NOTE,
  failureMessage,
  formatReportWhen,
  formatReportWindow,
  isPendingStatus,
  subjectLabel,
} from '../../utils/reports/reportCopy';
import { requestedByLabel } from '../../components/agency/reports/ReportHistory';
import { AgentSurfaceShell } from '../../components/agency/AgentSurfaceShell';
import { CapabilityUnavailable } from '../../components/common/CapabilityUnavailable';
import { ReportStatusPill } from '../../components/agency/reports/ReportStatusPill';
import { ReportDownloads } from '../../components/agency/reports/ReportDownloads';
import styles from '../../components/agency/reports/Reports.module.css';

/**
 * One report run (`/agency/reports/:runId`, and `/dialer/reports/:runId` for a
 * dedicated agent): its parameters, its status (polled while it is being prepared),
 * the downloads once it is ready, why it failed, and "Run again" (a new run with the
 * same parameters). The "report ready" email links here.
 */

type Surface = 'agency' | 'agent';

export default function ReportRunPage({ surface = 'agency' }: { surface?: Surface }) {
  const { runId = '' } = useParams();
  const { role } = useTenant();
  const access = useReportsAccess();

  if (role === undefined) return <LoadingSpinner />;
  if (surface === 'agency' && isDedicatedAgent(role)) {
    return <Navigate to={`/dialer/reports/${encodeURIComponent(runId)}`} replace />;
  }
  if (!access.enabled) return <CapabilityUnavailable />;

  const body = <ReportRunBody key={runId} runId={runId} />;
  if (surface === 'agent') {
    return (
      <AgentSurfaceShell icon={<FileText size={20} />} title="Report" subtitle="One of your exported reviews." current="reports">
        <div className={styles.page}>{body}</div>
      </AgentSurfaceShell>
    );
  }
  return <div className={styles.page}>{body}</div>;
}

function ReportRunBody({ runId }: { runId: string }) {
  const { tenantId, accountId, role } = useTenant();
  const navigate = useNavigate();
  const { showToast } = useToast();
  const { run, error, loading, reload } = useReportRun(runId);
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  const back = (
    <Link to={reportsBasePath(role)} className={styles.backLink}>
      <ArrowLeft size={14} aria-hidden="true" />
      All reports
    </Link>
  );

  if (loading) return <LoadingSpinner />;
  if (!run) {
    return (
      <>
        {back}
        {error ? (
          <EmptyState icon={<FileText size={32} />} title="Report not available" description={error} />
        ) : (
          <ErrorAlert message="We couldn’t load this report." onRetry={reload} />
        )}
      </>
    );
  }

  const runAgain = async () => {
    if (!tenantId || !accountId) return;
    setRetrying(true);
    setRetryError(null);
    try {
      const next = await retryReport(run.id, tenantId, accountId);
      trackAgencyReportRunAgain({ kind: run.kind });
      showToast('A new report is being prepared.', 'success');
      navigate(reportRunPath(role, next.id));
    } catch (err) {
      setRetryError(reportErrorMessage(err, 'We couldn’t run this report again. Try again.'));
    } finally {
      setRetrying(false);
    }
  };

  const pending = isPendingStatus(run.status);
  const title = `${REPORT_KIND_LABELS[run.kind]}: ${subjectLabel(run.kind, run.subject)}`;

  return (
    <>
      {back}
      <article className={styles.runCard} aria-labelledby="report-run-title">
        <div className={styles.runHead}>
          <h1 id="report-run-title" className={styles.runTitle}>
            {title}
          </h1>
          <ReportStatusPill status={run.status} />
        </div>

        <p className="sr-only" aria-live="polite" data-testid="report-run-announcement">
          {pending ? 'Preparing the report.' : run.status === 'ready' ? 'The report is ready to download.' : ''}
        </p>

        <RunFacts run={run} />

        {run.audience === 'self' ? <p className={styles.note}>{SELF_REVIEW_NOTE}</p> : null}

        {pending ? (
          <p className={styles.hint} data-testid="report-run-pending">
            The report is being prepared. This page updates on its own; you can also leave it and come back.
          </p>
        ) : null}

        {run.status === 'ready' ? (
          <>
            {run.truncated ? (
              <p className={styles.note} data-testid="report-run-truncated">
                Some detail sheets reached their row limit, so they don’t list every row. The first row of each such
                sheet says so; the summary figures are complete.
              </p>
            ) : null}
            <ReportDownloads run={run} />
          </>
        ) : null}

        {run.status === 'failed' ? (
          <p className={styles.inlineError} role="alert" data-testid="report-run-error">
            {failureMessage(run.error)}
          </p>
        ) : null}

        {run.status === 'expired' ? (
          <p className={styles.hint} data-testid="report-run-expired">
            This report has expired and its files have been deleted. Run it again to get new files.
          </p>
        ) : null}

        {error ? (
          <p className={styles.inlineError} role="alert">
            {error}
          </p>
        ) : null}

        {!pending ? (
          <div className={styles.actions}>
            <button
              type="button"
              className={run.status === 'ready' ? 'btn-secondary' : 'btn-primary'}
              onClick={() => void runAgain()}
              disabled={retrying}
              data-testid="report-run-again"
            >
              <RotateCcw size={14} aria-hidden="true" />
              {retrying ? 'Starting…' : 'Run again'}
            </button>
          </div>
        ) : null}
        {retryError ? (
          <p className={styles.inlineError} role="alert" data-testid="report-run-again-error">
            {retryError}
          </p>
        ) : null}
      </article>
    </>
  );
}

function RunFacts({ run }: { run: AgencyReportRun }) {
  return (
    <dl className={styles.facts} data-testid="report-run-facts">
      <dt>Report</dt>
      <dd>{REPORT_KIND_LABELS[run.kind]}</dd>
      <dt>{run.kind === 'agent' ? 'Agent' : run.kind === 'campaign' ? 'Campaign' : 'Account'}</dt>
      <dd>{subjectLabel(run.kind, run.subject)}</dd>
      <dt>Window</dt>
      <dd>{`${formatReportWindow(run.range)} (${run.range.timezone})`}</dd>
      <dt>Formats</dt>
      <dd>{run.formats.map((f) => REPORT_FORMAT_LABELS[f]).join(' and ')}</dd>
      <dt>Requested by</dt>
      <dd>{requestedByLabel(run)}</dd>
      <dt>Created</dt>
      <dd>{formatReportWhen(run.created_at)}</dd>
      {run.finished_at ? (
        <>
          <dt>Finished</dt>
          <dd>{formatReportWhen(run.finished_at)}</dd>
        </>
      ) : null}
      {run.status === 'ready' && run.expires_at ? (
        <>
          <dt>Available until</dt>
          <dd>{formatReportWhen(run.expires_at)}</dd>
        </>
      ) : null}
    </dl>
  );
}

/** `/dialer/reports/:runId`: the same page in a dedicated agent's own frame. */
export function AgentReportRunPage() {
  return <ReportRunPage surface="agent" />;
}
