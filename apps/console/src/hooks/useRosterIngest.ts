import { useCallback, useEffect, useRef, useState } from 'react';
import {
  analyzeRosterColumns,
  cancelIngestJob,
  downloadRejectedRows,
  getIngestJob,
  getIngestLimits,
  startRosterIngest,
  uploadRosterCsv,
} from '../api/agencyCampaigns';
import {
  buildIngestRequest,
  initialMapping,
  type MappingState,
} from '../utils/agencyColumnMapping';
import { HIGH_REJECTION_RATIO, isTerminal } from '../utils/agencyIngestSummary';
import {
  trackAgencyRosterIngestCompleted,
  trackAgencyRosterIngestFailed,
  trackAgencyRosterIngestStarted,
} from '../analytics/events';
import type {
  AgencyColumnAnalysis,
  AgencyIngestFailureCode,
  AgencyIngestJob,
  AgencyIngestLimits,
  AgencyIngestReasonCode,
  AgencyUploadResponse,
} from '../types/agency-campaign';

/**
 * The seven codes {@link AgencyIngestFailureCode} declares — mirrored here only
 * so `trackAgencyRosterIngestFailed` can tell a recognised whole-file failure
 * from `AgencyIngestJob.error_code`'s wider `| string` (a code this build does
 * not know about yet). An unrecognised code is not sent — the event's `code`
 * field is a closed union, and there is nothing safe to substitute.
 */
const INGEST_FAILURE_CODES: readonly AgencyIngestFailureCode[] = [
  'malformed_csv',
  'phone_column_missing',
  'timezone_column_missing',
  'too_many_columns',
  'too_many_rows',
  'unsupported_encoding',
  'dnc_unavailable',
];

/** The most common rejection reason, or `null` when nothing was rejected (or
 *  the job predates `rejected_by_reason`). Ties break on the reason itself, so
 *  the answer is stable across polls the way `agencyIngestSummary`'s own
 *  grouping is. */
function topRejectionReason(
  byReason: Partial<Record<AgencyIngestReasonCode, number>> | undefined,
): AgencyIngestReasonCode | null {
  const entries = Object.entries(byReason ?? {}) as [AgencyIngestReasonCode, number][];
  const withCounts = entries.filter(([, count]) => typeof count === 'number' && count > 0);
  if (withCounts.length === 0) return null;
  withCounts.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return withCounts[0]![0];
}

/** How often the ingest job is polled while it runs. */
const POLL_MS = 1500;

export type UploadPhase = 'idle' | 'uploading' | 'analyzing' | 'mapping' | 'ingesting' | 'done';

export interface UseRosterIngestOptions {
  /**
   * Which flow is running this hook — a brand-new campaign's roster (the
   * builder, where `resolveCampaignId` creates the draft on first need) or an
   * addition to one that already exists (the "add contacts" page). Analytics
   * only: the two entry points share this hook's actual ingest behaviour
   * byte-for-byte, and this is purely which event property to stamp on it.
   */
  source: 'builder' | 'top_up';
  /**
   * Resolve the campaign the roster loads into, called at ingest time rather
   * than at mount. The builder creates a draft on first need; the top-up page
   * already knows its id. Returning `undefined` is only valid for a dry run.
   */
  resolveCampaignId: () => Promise<string | undefined>;
  /**
   * Runs **before** the ingest is submitted, once the campaign id is resolved,
   * and its failure **blocks** the ingest — a rejection surfaces as "Could not
   * start the import" and nothing is sent.
   *
   * That ordering is inherited from the builder, deliberately: the hook exists
   * to move the flow without changing it. It also happens to be the ordering
   * this particular caller wants — the builder writes `context_display` here,
   * and those hero fields are what the Agent Console reads to decide which
   * contact fields get the big type. Persisting them after the roster is
   * accepted would leave a window where agents take calls against a contact
   * panel rendering the wrong field as the headline.
   *
   * Named `onIngestStarted`, which reads as after-the-fact and is not. Renaming
   * it is the obvious fix and is deliberately not done here: the name is load
   * bearing in the builder and its tests, and a rename buried in a comment-fix
   * commit is how a behavioural change gets waved through. Filed rather than
   * smuggled.
   */
  onIngestStarted?: (campaignId: string, mapping: MappingState) => Promise<void>;
}

/**
 * The roster ingest flow: upload → analyze → map → ingest → poll.
 *
 * Extracted from `CampaignBuilderPage` so the builder and the "add more
 * contacts" page run the *same* flow rather than two copies of it. This
 * codebase already argues the point for the DNC routes — a second
 * implementation is where normalisation drifts, and the difference is invisible
 * until rows silently fail to load. The polling contract below is exactly the
 * kind of detail that would have been reproduced imperfectly.
 *
 * Two behaviours are load-bearing and must survive any edit here:
 *
 *  - **The first poll is immediate; only later ones wait.** A job that is
 *    already terminal when the 202 arrives must render its real counters, not a
 *    fabricated all-zero summary.
 *  - **Counters are never invented locally.** Every number rendered comes from a
 *    job master actually served, so a poll failure reports lost contact rather
 *    than claiming the import died — the ingest is still running server-side.
 */
export function useRosterIngest(
  tenantId: string | undefined,
  accountId: string | undefined,
  options: UseRosterIngestOptions,
) {
  const [limits, setLimits] = useState<AgencyIngestLimits | null>(null);
  const [phase, setPhase] = useState<UploadPhase>('idle');
  const [upload, setUpload] = useState<AgencyUploadResponse | null>(null);
  const [analysis, setAnalysis] = useState<AgencyColumnAnalysis | null>(null);
  const [mapping, setMapping] = useState<MappingState | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [job, setJob] = useState<AgencyIngestJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  // Held in a ref so a caller can pass an inline closure without restarting the
  // poll loop on every render.
  const optionsRef = useRef(options);
  optionsRef.current = options;

  /**
   * The limits the operator is told must be the REAL ones (§B.2), so they come
   * from master rather than from a constant here that would go stale.
   */
  useEffect(() => {
    let cancelled = false;
    getIngestLimits(tenantId, accountId)
      .then((value) => {
        if (!cancelled) setLimits(value);
      })
      .catch(() => {
        // A limits failure must not block the upload: the file still has a real
        // server-side limit, and the operator finds out at ingest instead.
      });
    return () => {
      cancelled = true;
    };
  }, [tenantId, accountId]);

  useEffect(() => {
    if (!jobId) return;
    if (job && isTerminal(job.status)) return;
    let cancelled = false;
    const timer = window.setTimeout(
      () => {
        getIngestJob(jobId, tenantId, accountId)
          .then((next) => {
            if (cancelled) return;
            setJob(next);
            if (isTerminal(next.status)) {
              setPhase('done');
              const source = optionsRef.current.source;
              if (next.status === 'failed') {
                const code = next.error_code;
                if (
                  typeof code === 'string' &&
                  (INGEST_FAILURE_CODES as readonly string[]).includes(code)
                ) {
                  trackAgencyRosterIngestFailed({ source, code: code as AgencyIngestFailureCode });
                }
              } else if (next.status === 'completed' && next.campaign_id) {
                // `campaign_id` is required on this event; a dry run (which
                // never carries one) is a preview, not something to report as
                // "ingested".
                const byReason = next.rejected_by_reason ?? {};
                const rejected = next.rejected;
                const rowsRead = next.rows_read;
                trackAgencyRosterIngestCompleted({
                  campaign_id: next.campaign_id,
                  source,
                  rows_read: rowsRead,
                  accepted: next.accepted,
                  rejected,
                  duplicates: next.duplicates,
                  dnc_suppressed: byReason.dnc_suppressed ?? 0,
                  high_rejection: rowsRead > 0 && rejected / rowsRead >= HIGH_REJECTION_RATIO,
                  reconciles: next.accepted + rejected === rowsRead,
                  top_reason: topRejectionReason(byReason),
                });
              }
            }
          })
          .catch((err: unknown) => {
            if (cancelled) return;
            setError(
              `Lost contact with the import — it is still running. ${
                err instanceof Error ? err.message : ''
              }`.trim(),
            );
          });
      },
      job ? POLL_MS : 0,
    );
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [jobId, job, tenantId, accountId]);

  const onPickFile = useCallback(
    async (file: File) => {
      setError(null);
      setJob(null);
      setJobId(null);
      setPhase('uploading');
      try {
        const uploaded = await uploadRosterCsv(file, tenantId, accountId);
        setUpload(uploaded);
        setPhase('analyzing');
        const columns = await analyzeRosterColumns({ s3_key: uploaded.s3_key }, tenantId, accountId);
        setAnalysis(columns);
        setMapping(initialMapping(columns));
        setPhase('mapping');
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : 'Could not read that file.');
        setPhase('idle');
      }
    },
    [tenantId, accountId],
  );

  const startIngest = useCallback(
    async (dryRun: boolean) => {
      if (!mapping || !upload) return;
      setError(null);
      try {
        const id = dryRun ? undefined : await optionsRef.current.resolveCampaignId();
        const request = buildIngestRequest(mapping, {
          s3Key: upload.s3_key,
          fileName: upload.file_name,
          ...(id ? { campaignId: id } : {}),
          ...(dryRun ? { dryRun: true } : {}),
        });
        if (!request) return;

        if (!dryRun && id) {
          await optionsRef.current.onIngestStarted?.(id, mapping);
        }

        const roles = Object.values(mapping.roles);
        trackAgencyRosterIngestStarted({
          campaign_id: id ?? null,
          source: optionsRef.current.source,
          dry_run: dryRun,
          // Column headers are contact data — count only, per role: `detail`
          // and `hero` are the columns kept as the contact's variables, `hero`
          // is the subset of those given the agent's big-type treatment.
          column_count: roles.length,
          mapped_variable_count: roles.filter((role) => role === 'detail' || role === 'hero').length,
          hero_field_count: mapping.heroOrder.length,
        });

        const started = await startRosterIngest(request, tenantId, accountId);
        setPhase('ingesting');
        setJob(null);
        setJobId(started.job_id);
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : 'Could not start the import.');
      }
    },
    [mapping, upload, tenantId, accountId],
  );

  const onCancelIngest = useCallback(async () => {
    if (!job) return;
    try {
      await cancelIngestJob(job.job_id, tenantId, accountId);
    } catch (err: unknown) {
      // 409 means it already finished — which is information, not a failure to
      // hide: the roster IS loaded.
      setError(err instanceof Error ? err.message : 'Could not stop the import.');
    }
  }, [job, tenantId, accountId]);

  const onDownloadRejected = useCallback(async () => {
    if (!job) return;
    setDownloading(true);
    setDownloadError(null);
    try {
      const blob = await downloadRejectedRows(job.job_id, tenantId, accountId);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `${job.file_name.replace(/\.csv$/i, '')}-rejected-rows.csv`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (err: unknown) {
      setDownloadError(err instanceof Error ? err.message : 'Could not download the report.');
    } finally {
      setDownloading(false);
    }
  }, [job, tenantId, accountId]);

  /** Back to a clean upload, keeping the campaign context around it. */
  const reset = useCallback(() => {
    setPhase('idle');
    setUpload(null);
    setAnalysis(null);
    setMapping(null);
    setJobId(null);
    setJob(null);
    setError(null);
    setDownloadError(null);
  }, []);

  // Derived here rather than in each page. Two pages re-deriving "is it still
  // running" off `jobId` and `isTerminal` is two chances to get the
  // no-job-read-yet case wrong, which is the case that renders "Starting…".
  const running = jobId !== null && (!job || !isTerminal(job.status));
  const finished = job !== null && isTerminal(job.status);

  return {
    limits,
    phase,
    /** Exposed for "back to mapping" — re-entering a step, not a state machine hop. */
    setPhase,
    running,
    finished,
    upload,
    analysis,
    mapping,
    setMapping,
    job,
    error,
    setError,
    downloading,
    downloadError,
    onPickFile,
    startIngest,
    onCancelIngest,
    onDownloadRejected,
    reset,
  };
}
