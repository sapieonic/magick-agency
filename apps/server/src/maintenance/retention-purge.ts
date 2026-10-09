import { getPool } from '@magick-agency/db';
import { createChildLogger } from '@magick-agency/observability';
import { config } from '../config/index.js';
import { withRetry } from '../utils/retry.js';

/*
 * PORT NOTE (magick-agency): the AGENCY SLICE of core `src/maintenance/retention-purge.ts`
 * (v1.123.2). Changes, each in PORTING.md:
 *  - only the agency-owned population is purged: `dialer_analysis_jobs` and
 *    `agency_calls` on the agency window (core's `window: 'agency'` targets, now
 *    without the `campaign_id IS NOT NULL` split - every `agency_calls` row is
 *    agency's). Every AI-call, IVR, messaging, KB and softphone target is deleted;
 *  - core's run window (`retention_days` from the retention Lambda's request) has no
 *    counterpart: the window is `AGENCY_RETENTION_DAYS`, and when it is unset the
 *    row purge does NOT run (default, pending Manas);
 *  - core's `purgeAuditPartitions` (the `audit_logs` partition drop and the
 *    default-partition row delete) and its report fields are NOT here: lane A owns
 *    audit partition maintenance, creating and dropping
 *    (`audit/audit-partition-maintenance.ts`), so two jobs never drop the same
 *    partitions;
 *  - the transcript step nulls `conversation_log` AND `transcript_meta` (the
 *    transcript and its provenance, which carries `source_url`) on
 *    `AGENCY_TRANSCRIPT_RETENTION_DAYS`, leaving `call_analysis` to survive until
 *    the row expires; unset = transcripts are not nulled early;
 *  - it is invoked by a timer in `bootstrap/analysis.ts`, not by an internal route.
 * Batching, FK-safe ordering and the Slack summary are core's, verbatim.
 */

const log = createChildLogger({ component: 'retention-purge' });

/** Rows deleted per DELETE statement — keeps locks short and WAL spikes bounded. */
const BATCH_SIZE = 5000;

interface PurgeTarget {
  table: string;
  /** $1 = cutoff. Returns the number of rows that would be deleted. */
  countSql: string;
  /** $1 = cutoff, $2 = batch size. Deletes one batch. */
  deleteSql: string;
}

/**
 * Deletion order matters for FK integrity: dialer_analysis_jobs before
 * agency_calls (jobs.call_id FK-references agency_calls ON DELETE CASCADE, so the
 * cascade would also cover it; the explicit delete keeps the FK-safe order, and
 * lets the report say how many jobs went).
 *
 * A job is part of its call's record, so it ages out on the same (agency) window:
 * keyed on the JOB's own created_at, as in core.
 */
export const PURGE_TARGETS: PurgeTarget[] = [
  {
    table: 'dialer_analysis_jobs',
    countSql: `SELECT count(*)::int AS n FROM dialer_analysis_jobs j
      WHERE j.created_at < $1`,
    deleteSql: `DELETE FROM dialer_analysis_jobs WHERE id IN (
      SELECT j.id FROM dialer_analysis_jobs j
      WHERE j.created_at < $1
      LIMIT $2)`,
  },
  {
    table: 'agency_calls',
    countSql: `SELECT count(*)::int AS n FROM agency_calls
      WHERE created_at < $1`,
    deleteSql: `DELETE FROM agency_calls WHERE id IN (
      SELECT id FROM agency_calls
      WHERE created_at < $1
      LIMIT $2)`,
  },
];

export interface RetentionPurgeReport {
  dry_run: boolean;
  /** `AGENCY_RETENTION_DAYS`, or null when unset (no row purge ran). */
  retention_days: number | null;
  /** Row cutoff ISO, or null when `retention_days` is null. */
  cutoff: string | null;
  started_at: string;
  finished_at: string;
  duration_ms: number;
  /** Rows deleted per table (rows that would be deleted, in dry-run mode). */
  tables: Record<string, number>;
  /**
   * Agency transcripts nulled by the transcript-window step: `conversation_log` and
   * `transcript_meta` cleared on agency_calls older than
   * AGENCY_TRANSCRIPT_RETENTION_DAYS while the row (and `call_analysis`) survives
   * until the row cutoff.
   */
  agency_transcripts_nulled: number;
  error?: string;
}

export interface RetentionPurgeOptions {
  dryRun?: boolean;
  /** Free-text origin tag for logs/Slack (e.g. 'scheduler', 'manual'). */
  requestedBy?: string;
}

let purgeRunning = false;

export function isPurgeRunning(): boolean {
  return purgeRunning;
}

/**
 * Deletes agency call rows and their analysis jobs older than
 * `AGENCY_RETENTION_DAYS` and nulls agency transcripts older than
 * `AGENCY_TRANSCRIPT_RETENTION_DAYS`. Config tables are never touched.
 *
 * Runs batched deletes to avoid long locks. Posts a summary to the Slack
 * webhook (RETENTION_SLACK_WEBHOOK_URL) when configured. Never throws except when a
 * purge is already running — errors are logged, reported to Slack, and returned on
 * the report.
 */
export async function runRetentionPurge(opts: RetentionPurgeOptions = {}): Promise<RetentionPurgeReport> {
  if (purgeRunning) {
    throw new Error('A retention purge is already running');
  }
  purgeRunning = true;

  const dryRun = opts.dryRun ?? false;
  const agencyRetentionDays = config.retention.agencyRetentionDays;
  const cutoff = agencyRetentionDays === undefined
    ? null
    : new Date(Date.now() - agencyRetentionDays * 24 * 60 * 60 * 1000);
  const startedAt = new Date();

  const report: RetentionPurgeReport = {
    dry_run: dryRun,
    retention_days: agencyRetentionDays ?? null,
    cutoff: cutoff?.toISOString() ?? null,
    started_at: startedAt.toISOString(),
    finished_at: '',
    duration_ms: 0,
    tables: {},
    agency_transcripts_nulled: 0,
  };

  log.info(
    { retentionDays: report.retention_days, cutoff: report.cutoff, dryRun, requestedBy: opts.requestedBy },
    'Retention purge started',
  );

  try {
    const pool = getPool();

    if (cutoff) {
      for (const target of PURGE_TARGETS) {
        const reportKey = target.table;
        if (dryRun) {
          const result = await pool.query<{ n: number }>(target.countSql, [cutoff]);
          report.tables[reportKey] = result.rows[0]?.n ?? 0;
        } else {
          let total = 0;
          let deleted: number;
          do {
            const result = await pool.query(target.deleteSql, [cutoff, BATCH_SIZE]);
            deleted = result.rowCount ?? 0;
            total += deleted;
          } while (deleted === BATCH_SIZE);
          report.tables[reportKey] = total;
          log.info({ table: target.table, reportKey, deleted: total }, 'Table purged');
        }
      }
    }

    // Transcript window: null conversation_log + transcript_meta on agency_calls
    // older than the (shorter) transcript-retention window, leaving call_analysis +
    // the row intact until the row cutoff above handles agency_calls.
    const transcriptDays = config.retention.agencyTranscriptRetentionDays;
    if (transcriptDays !== undefined) {
      report.agency_transcripts_nulled = await purgeAgencyTranscripts(dryRun, transcriptDays);
    }
  } catch (err: any) {
    report.error = err?.message ?? String(err);
    log.error({ err, report }, 'Retention purge failed');
  } finally {
    purgeRunning = false;
    report.finished_at = new Date().toISOString();
    report.duration_ms = Date.now() - startedAt.getTime();
  }

  if (!report.error) {
    log.info({ report }, 'Retention purge complete');
  }

  await postSlackSummary(report, opts.requestedBy);
  return report;
}

/**
 * Transcript window: NULL `conversation_log` and `transcript_meta` on agency_calls
 * whose transcript has aged past the transcript-retention window, while leaving
 * `call_analysis` (the durable business value) and the row itself intact until the
 * row purge. `transcript_meta` goes too: it carries `source_url`, the recording
 * location, and is the transcript's provenance. Only touches rows that still carry
 * a transcript, so it's a no-op once cleared. In dry-run mode it counts without
 * writing. (Core's `purgeWebrtcTranscripts` nulled `conversation_log` alone and
 * split by product; the product split is gone with the softphone.)
 */
async function purgeAgencyTranscripts(dryRun: boolean, retentionDays: number): Promise<number> {
  const pool = getPool();
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
  const hasTranscript = '(conversation_log IS NOT NULL OR transcript_meta IS NOT NULL)';

  if (dryRun) {
    const result = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM agency_calls
       WHERE created_at < $1 AND ${hasTranscript}`,
      [cutoff],
    );
    return result.rows[0]?.n ?? 0;
  }

  let total = 0;
  let updated: number;
  do {
    const result = await pool.query(
      `UPDATE agency_calls SET conversation_log = NULL, transcript_meta = NULL
       WHERE id IN (
         SELECT id FROM agency_calls
         WHERE created_at < $1 AND ${hasTranscript}
         LIMIT $2)`,
      [cutoff, BATCH_SIZE],
    );
    updated = result.rowCount ?? 0;
    total += updated;
  } while (updated === BATCH_SIZE);
  if (total > 0) {
    log.info({ transcriptsNulled: total }, 'Transcripts nulled (retention window)');
  }
  return total;
}

/** Posts the run summary to the configured Slack incoming webhook. Best-effort. */
async function postSlackSummary(report: RetentionPurgeReport, requestedBy?: string): Promise<void> {
  const webhookUrl = config.retention.slackWebhookUrl;
  if (!webhookUrl) return;

  const totalRows = Object.values(report.tables).reduce((a, b) => a + b, 0);
  const tableLines = Object.entries(report.tables)
    .map(([table, n]) => `• \`${table}\`: ${n.toLocaleString()}`)
    .join('\n');

  const title = report.error
    ? ':rotating_light: Retention purge FAILED'
    : report.dry_run
      ? ':mag: Retention purge — dry run'
      : ':wastebasket: Retention purge complete';

  const text = [
    `*${title}*`,
    `Environment: \`${config.server.env}\` · Retention: ${report.retention_days ?? 'unset'} days · Cutoff: ${report.cutoff ?? 'n/a'}`,
    requestedBy ? `Triggered by: ${requestedBy}` : null,
    report.error ? `Error: ${report.error}` : null,
    `Rows ${report.dry_run ? 'matched' : 'deleted'} (${totalRows.toLocaleString()} total):`,
    tableLines,
    `agency transcripts nulled: ${report.agency_transcripts_nulled.toLocaleString()}`,
    `Duration: ${(report.duration_ms / 1000).toFixed(1)}s`,
  ]
    .filter((line): line is string => line !== null)
    .join('\n');

  try {
    await withRetry(
      async () => {
        const res = await fetch(webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text }),
          signal: AbortSignal.timeout(10000),
        });
        if (!res.ok) {
          throw new Error(`Slack webhook returned ${res.status}`);
        }
      },
      { maxRetries: 2, baseDelayMs: 1000 },
    );
  } catch (err) {
    log.error({ err }, 'Failed to post retention purge summary to Slack');
  }
}
