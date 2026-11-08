import { useCallback, useEffect, useRef, useState } from 'react';
import type { AgencyReportRun } from '@magick-agency/contracts/api/agency/reports';
import { useTenant } from '../contexts/TenantContext';
import { getReport, reportErrorMessage } from '../api/reports';
import { ApiError } from '../api/client';
import { isPendingStatus } from '../utils/reports/reportCopy';

/** How often a run still being prepared is re-read. */
export const REPORT_POLL_INTERVAL_MS = 3_000;

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
 * One report run, polled every {@link REPORT_POLL_INTERVAL_MS} while it is pending
 * (`queued`, `assembling`, `rendering`) and left alone once it is `ready`, `failed`
 * or `expired`, or when the component unmounts.
 *
 * A read that fails is retried at the next interval (or after the server's
 * `Retry-After`, when that is longer), except a refusal that will not change by
 * waiting (a 4xx other than 429: the run is gone or not this caller's), which stops
 * polling and is shown. One timer at a time: each answer schedules the next read, so
 * a slow answer can never overlap the next request.
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

    const schedule = (ms: number) => {
      if (cancelled) return;
      timer = setTimeout(read, ms);
    };

    function read() {
      timer = null;
      getReport(runId as string, tenantId ?? undefined, accountId ?? undefined)
        .then((next) => {
          if (cancelled) return;
          setRun(next);
          setError(null);
          setLoading(false);
          if (isPendingStatus(next.status)) schedule(REPORT_POLL_INTERVAL_MS);
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          setError(reportErrorMessage(err, 'We couldn’t check on this report.'));
          setLoading(false);
          const final = err instanceof ApiError && err.statusCode >= 400 && err.statusCode < 500 && err.statusCode !== 429;
          if (final) return;
          const wait = err instanceof ApiError && err.retryAfterSeconds ? err.retryAfterSeconds * 1000 : 0;
          schedule(Math.max(REPORT_POLL_INTERVAL_MS, wait));
        });
    }

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
    };
    // `initial` is read only to decide the first step; its status is the dependency.
  }, [runId, tenantId, accountId, reloadToken, initialStatus]);

  const reload = useCallback(() => setReloadToken((n) => n + 1), []);

  return { run, error, loading, reload };
}
