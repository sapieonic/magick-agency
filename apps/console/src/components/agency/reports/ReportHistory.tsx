import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { FileText } from 'lucide-react';
import type { AgencyReportRun, ReportKind } from '@magick-agency/contracts/api/agency/reports';
import { REPORT_KINDS, REPORT_RUN_PAGE_DEFAULT_LIMIT } from '@magick-agency/contracts/api/agency/reports';
import { EmptyState } from '@magick-agency/web-ui/components/EmptyState';
import { ErrorAlert } from '@magick-agency/web-ui/components/ErrorAlert';
import { LoadingSpinner } from '@magick-agency/web-ui/components/LoadingSpinner';
import { useTenant } from '../../../contexts/TenantContext';
import { listReports, reportErrorMessage } from '../../../api/reports';
import { useReportRun } from '../../../hooks/useReportRun';
import { reportRunPath } from '../../../hooks/useReportsAccess';
import {
  REPORT_KIND_LABELS,
  formatReportWhen,
  formatReportWindow,
  subjectLabel,
} from '../../../utils/reports/reportCopy';
import { ReportStatusPill } from './ReportStatusPill';
import { ReportDownloads } from './ReportDownloads';
import styles from './Reports.module.css';

const KIND_FILTER_LABELS: Record<ReportKind, string> = {
  agent: 'Agent reviews',
  campaign: 'Campaign reports',
  account: 'Account reports',
};

type HistoryState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; runs: AgencyReportRun[]; nextCursor: string | null; loadingMore: boolean; moreError: string | null };

/** Who asked for a run: a name, "Scheduled" for a subscription's run, or a stand-in. */
export function requestedByLabel(run: AgencyReportRun): string {
  if (run.requested_by) return run.requested_by.name ?? 'A former team member';
  return run.subscription_id ? 'Scheduled' : '—';
}

/**
 * The Reports page's History tab: runs newest first, a page at a time by the
 * server's keyset cursor ("Load more"). Supervisors read the account's runs and can
 * filter by kind and to "Only mine"; anyone else is served only the runs they
 * requested, so neither filter is offered to them.
 *
 * "Only mine" filters the loaded rows by `requested_by` (the list query has no
 * requester filter), so with it on a page can show fewer rows than it loaded and
 * "Load more" reads further back.
 */
export function ReportHistory({ canSupervise, userId }: { canSupervise: boolean; userId: string | null }) {
  const { tenantId, accountId, role } = useTenant();
  const ids = useId();
  const [kind, setKind] = useState<ReportKind | ''>('');
  const [onlyMine, setOnlyMine] = useState(false);
  const [state, setState] = useState<HistoryState>({ status: 'loading' });
  const generation = useRef(0);

  const load = useCallback(() => {
    if (!tenantId || !accountId) return;
    const mine = (generation.current += 1);
    setState({ status: 'loading' });
    listReports({ limit: REPORT_RUN_PAGE_DEFAULT_LIMIT, ...(kind ? { kind } : {}) }, tenantId, accountId)
      .then((page) => {
        if (generation.current !== mine) return;
        setState({ status: 'ready', runs: page.runs, nextCursor: page.next_cursor, loadingMore: false, moreError: null });
      })
      .catch((err: unknown) => {
        if (generation.current !== mine) return;
        setState({ status: 'error', message: reportErrorMessage(err, 'We couldn’t load the reports.') });
      });
  }, [tenantId, accountId, kind]);

  useEffect(() => {
    load();
    return () => {
      generation.current += 1;
    };
  }, [load]);

  const loadMore = () => {
    if (state.status !== 'ready' || state.nextCursor === null || !tenantId || !accountId) return;
    const mine = generation.current;
    const cursor = state.nextCursor;
    setState({ ...state, loadingMore: true, moreError: null });
    listReports(
      { cursor, limit: REPORT_RUN_PAGE_DEFAULT_LIMIT, ...(kind ? { kind } : {}) },
      tenantId,
      accountId,
    )
      .then((page) => {
        if (generation.current !== mine) return;
        setState((prev) =>
          prev.status === 'ready'
            ? {
                status: 'ready',
                // A run that moved onto the next page between reads is kept once.
                runs: [...prev.runs, ...page.runs.filter((r) => !prev.runs.some((p) => p.id === r.id))],
                nextCursor: page.next_cursor,
                loadingMore: false,
                moreError: null,
              }
            : prev,
        );
      })
      .catch((err: unknown) => {
        if (generation.current !== mine) return;
        setState((prev) =>
          prev.status === 'ready'
            ? { ...prev, loadingMore: false, moreError: reportErrorMessage(err, 'We couldn’t load more reports.') }
            : prev,
        );
      });
  };

  const rows =
    state.status === 'ready'
      ? state.runs.filter((r) => !(canSupervise && onlyMine) || r.requested_by?.user_id === userId)
      : [];

  return (
    <section className={styles.page} aria-label="Report history">
      {canSupervise ? (
        <div className={styles.filters}>
          <div className="form-group">
            <label htmlFor={`${ids}-kind`}>Kind</label>
            <select
              id={`${ids}-kind`}
              className={styles.filterSelect}
              value={kind}
              onChange={(e) => setKind(e.target.value as ReportKind | '')}
            >
              <option value="">All kinds</option>
              {REPORT_KINDS.map((k) => (
                <option key={k} value={k}>
                  {KIND_FILTER_LABELS[k]}
                </option>
              ))}
            </select>
          </div>
          <label className={styles.checkOption}>
            <input type="checkbox" checked={onlyMine} onChange={(e) => setOnlyMine(e.target.checked)} />
            Only mine
          </label>
        </div>
      ) : null}

      {state.status === 'loading' ? (
        <LoadingSpinner />
      ) : state.status === 'error' ? (
        <ErrorAlert message={state.message} onRetry={load} />
      ) : rows.length === 0 && state.nextCursor === null ? (
        <EmptyState
          icon={<FileText size={32} />}
          title={state.runs.length === 0 ? 'No reports yet' : 'No reports match'}
          description={
            state.runs.length === 0
              ? canSupervise
                ? 'Export a report from an agent’s record, a campaign’s Insights or the account’s analytics, and it will appear here.'
                : 'Export your review from My performance, and it will appear here.'
              : 'None of the reports you asked for match these filters.'
          }
        />
      ) : (
        <>
          <div className={styles.tableCard}>
            <div className={styles.tableWrap}>
              <table>
                <thead>
                  <tr>
                    <th>Kind</th>
                    <th>Subject</th>
                    <th>Window</th>
                    <th>Requested by</th>
                    <th>Created</th>
                    <th>Status</th>
                    <th>Downloads</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((run) => (
                    <ReportHistoryRow key={run.id} run={run} runPath={reportRunPath(role, run.id)} />
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          {rows.length === 0 ? (
            <p className={styles.muted} data-testid="report-history-filtered">
              None of the reports loaded so far match. Load more to look further back.
            </p>
          ) : null}
          {state.moreError ? <p className={styles.inlineError} role="alert">{state.moreError}</p> : null}
          {state.nextCursor !== null ? (
            <div className={styles.loadMore}>
              <button type="button" className="btn-secondary" onClick={loadMore} disabled={state.loadingMore}>
                {state.loadingMore ? 'Loading…' : 'Load more'}
              </button>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}

/** One run. A row still being prepared polls itself, so its status and downloads update in place. */
function ReportHistoryRow({ run: initial, runPath }: { run: AgencyReportRun; runPath: string }) {
  const { run } = useReportRun(initial.id, { initial });
  const current = run ?? initial;
  return (
    <tr data-testid="report-history-row" data-run-id={current.id}>
      <td>{REPORT_KIND_LABELS[current.kind]}</td>
      <td>
        <div className={styles.subjectCell}>
          <Link to={runPath}>{subjectLabel(current.kind, current.subject)}</Link>
        </div>
      </td>
      <td>
        <div className={styles.subjectCell}>
          <span>{formatReportWindow(current.range)}</span>
          <span className={styles.muted}>{current.range.timezone}</span>
        </div>
      </td>
      <td>{requestedByLabel(current)}</td>
      <td>{formatReportWhen(current.created_at)}</td>
      <td>
        <ReportStatusPill status={current.status} />
      </td>
      <td>
        <ReportDownloads run={current} compact />
      </td>
    </tr>
  );
}

export default ReportHistory;
