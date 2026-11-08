import { useCallback, useEffect, useRef, useState } from 'react';
import type { AgencyReportRun } from '@magick-agency/contracts/api/agency/reports';
import { useTenant } from '../contexts/TenantContext';
import { getReport, reportErrorMessage } from '../api/reports';
import { ApiError } from '../api/client';
import { isPendingStatus } from '../utils/reports/reportCopy';

/** How soon a run still being prepared is re-read, and again after each change of status. */
export const REPORT_POLL_INTERVAL_MS = 3_000;

/** The longest wait between reads of a run that stays in one pending status. */
export const REPORT_POLL_MAX_INTERVAL_MS = 30_000;

export interface UseReportRunOptions {
  /**
   * A run already in hand (a history row, the 202 body). Shown at once; re-read only
   * while it is pending, and the first re-read waits one interval. Without it the run
   * is read on mount.
   */
  initial?: AgencyReportRun | null;
}

export interface ReportRunState {
  run: AgencyReportRun | null;
  /** The last read's failure, in the console's words; cleared by the next good read. */
  error: string | null;
  /** True until the first answer (or failure) when there was no `initial`. */
  loading: boolean;
  /** Read again now (after a retry button, or a refusal that stopped polling). */
  reload: () => void;
}

/**
 * One report run, polled while it is pending (`queued`, `assembling`, `rendering`)
 * and left alone once it is `ready`, `failed` or `expired`, or when the component
 * unmounts.
 *
 *  - **Backs off.** The first re-read waits {@link REPORT_POLL_INTERVAL_MS}; each
 *    answer that brings the same pending status doubles the wait, up to
 *    {@link REPORT_POLL_MAX_INTERVAL_MS} (3 s, 6, 12, 24, 30, ...). A new status
 *    starts again at 3 s.
 *  - **Visible only.** A read that falls due while the tab is hidden is not sent;
 *    the tab becoming visible again sends one at once. The history mounts one of
 *    these per row, so a backgrounded tab would otherwise keep reading.
 *  - **Failures.** A read that fails is retried at the current interval (or after
 *    the server's `Retry-After`, when that is longer), except a refusal that will not
 *    change by waiting (a 4xx other than 429: the run is gone or not this caller's),
 *    which stops polling and is shown.
 *  - **One timer at a time.** Each answer schedules the next read, so a slow answer
 *    can never overlap the next request.
 */
export function useReportRun(runId: string | null, options: UseReportRunOptions = {}): ReportRunState {
  const { tenantId, accountId } = useTenant();
  const initial = options.initial ?? null;
  const [run, setRun] = useState<AgencyReportRun | null>(initial);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(initial === null && runId !== null);
  const [reloadToken, setReloadToken] = useState(0);

  // A newer history page hands a fresher copy of the same run: take it.
  const initialStatus = initial?.status;
  useEffect(() => {
    if (initial) setRun(initial);
    // Keyed on the status: the row object is rebuilt on every page render.
  }, [initial?.id, initialStatus]);

  const startedFromInitial = useRef(initial !== null);

  useEffect(() => {
    if (runId === null || !tenantId || !accountId) return undefined;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    // A read fell due while the tab was hidden: send it when the tab comes back.
    let dueWhileHidden = false;
    let interval = REPORT_POLL_INTERVAL_MS;
    let lastStatus = startedFromInitial.current && reloadToken === 0 ? initial?.status : undefined;

    const schedule = (ms: number) => {
      if (cancelled) return;
      timer = setTimeout(read, ms);
    };

    function read() {
      timer = null;
      if (document.visibilityState === 'hidden') {
        dueWhileHidden = true;
        return;
      }
      getReport(runId as string, tenantId ?? undefined, accountId ?? undefined)
        .then((next) => {
          if (cancelled) return;
          setRun(next);
          setError(null);
          setLoading(false);
          if (!isPendingStatus(next.status)) return;
          interval = next.status === lastStatus ? Math.min(interval * 2, REPORT_POLL_MAX_INTERVAL_MS) : REPORT_POLL_INTERVAL_MS;
          lastStatus = next.status;
          schedule(interval);
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          setError(reportErrorMessage(err, 'We couldn’t check on this report.'));
          setLoading(false);
          const final = err instanceof ApiError && err.statusCode >= 400 && err.statusCode < 500 && err.statusCode !== 429;
          if (final) return;
          const wait = err instanceof ApiError && err.retryAfterSeconds ? err.retryAfterSeconds * 1000 : 0;
          schedule(Math.max(interval, wait));
        });
    }

    const onVisibilityChange = () => {
      if (document.visibilityState !== 'visible' || !dueWhileHidden) return;
      dueWhileHidden = false;
      read();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);

    // A run handed in already: wait one interval, and only while it is pending. A
    // reload (the token) always reads at once.
    if (startedFromInitial.current && reloadToken === 0) {
      if (initial && isPendingStatus(initial.status)) schedule(REPORT_POLL_INTERVAL_MS);
    } else {
      read();
    }

    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
    // `initial` is read only to decide the first step; its status is the dependency.
  }, [runId, tenantId, accountId, reloadToken, initialStatus]);

  const reload = useCallback(() => setReloadToken((n) => n + 1), []);

  return { run, error, loading, reload };
}
