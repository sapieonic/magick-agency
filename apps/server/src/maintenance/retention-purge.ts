import { getPool } from '@magick-agency/db';
import { createChildLogger } from '@magick-agency/observability';
import { config } from '../config/index.js';
import { withRetry } from '../utils/retry.js';
import { deleteFile, isStorageConfigured } from '../storage/s3.js';
import { AGENCY_SUPERVISOR_MESSAGE_RETENTION_DAYS } from '@magick-agency/contracts/agency';

/*
 * Retention purge for call data:
 *  - the rows purged are `dialer_analysis_jobs` and `agency_calls`, on the
 *    `AGENCY_RETENTION_DAYS` window; when it is unset the row purge does NOT run
 *    (the default, pending Manas);
 *  - on the same window, inbound voicemails (docs/inbound.md §7): the call's recording, kept in
 *    the app's bucket (a carrier-recorded call keeps its recording at the carrier, which the
 *    `agency_calls` row points at), is deleted and the spine row forgets it
 *    (`voicemail_key`, `voicemail_seconds`); the inbound spine row itself is kept;
 *  - audit partitions are NOT purged here: `audit/audit-partition-maintenance.ts`
 *    owns creating and dropping them, so two jobs never drop the same partitions;
 *  - the transcript step nulls `conversation_log` AND `transcript_meta` (the
 *    transcript and its provenance, which carries `source_url`) on
 *    `AGENCY_TRANSCRIPT_RETENTION_DAYS`, leaving `call_analysis` to survive until
 *    the row expires; unset = transcripts are not nulled early;
 *  - recordings a call did not ask for (RC5, Manas 2026-11-15): on every run, whatever the
 *    windows, `recording_url` and `recording_duration_seconds` are cleared on every
 *    `agency_calls` row whose `recording_requested` is false. Since RC1 none is stored, so this
 *    clears the links stored before it (VoiceLink recorded on its own default and we kept the
 *    link) and any a future writer lets through. Its failure is the step's own: it is logged and
 *    reported, and the transcript and voicemail steps still run;
 *  - the Live floor's supervisor messages (LF5): on every run, whatever the windows,
 *    `agency_supervisor_messages` rows sent more than `AGENCY_SUPERVISOR_MESSAGE_RETENTION_DAYS` (90)
 *    ago are deleted, in batches; a fixed policy, not `AGENCY_RETENTION_DAYS`. Its failure is its
 *    own step's, as the recording step's;
 *  - it is invoked by a timer in `bootstrap/analysis.ts`.
 * Deletes are batched, in FK-safe order, and the run posts a Slack summary.
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
 * keyed on the JOB's own created_at.
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
  /**
   * Recording links cleared on calls that did not ask for a recording (RC5): every run, any age
   * (that would be, in dry-run mode). On a failed step, the batches committed before it.
   */
  unrequested_recordings_cleared: number;
  /**
   * Why the recording step (RC5) failed this run, when it did. Its own failure, not the run's:
   * the steps after it still ran, and the next run carries on where it stopped.
   */
  unrequested_recordings_error?: string;
  /**
   * Inbound voicemails past the row cutoff: their objects deleted from the bucket and their
   * calls' `voicemail_key` cleared (that would be, in dry-run mode). 0 with the window unset.
   */
  inbound_voicemails_deleted: number;
  /** Inbound voicemails whose object could not be deleted this run: their rows keep the key for the next. */
  inbound_voicemails_failed: number;
  /**
   * Supervisor messages older than 90 days deleted (LF5): every run, whatever the windows (that
   * would be, in dry-run mode). On a failed step, the batches committed before it.
   */
  supervisor_messages_deleted: number;
  /** Why the messages step failed this run, when it did; the other steps still ran. */
  supervisor_messages_error?: string;
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
    unrequested_recordings_cleared: 0,
    inbound_voicemails_deleted: 0,
    inbound_voicemails_failed: 0,
    supervisor_messages_deleted: 0,
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

    // Recordings a call did not ask for (RC5): every run, any age, before the windows below. Its
    // failure (a statement timeout on a large backlog, say) is caught here, so it never holds
    // back the transcript and voicemail steps; the batches it committed stay cleared.
    try {
      await purgeUnrequestedRecordings(dryRun, report);
    } catch (err: any) {
      report.unrequested_recordings_error = err?.message ?? String(err);
      log.error({ err, recordingsCleared: report.unrequested_recordings_cleared },
        'Clearing recording links on calls that did not ask for one failed — the other retention steps still run; the next run carries on');
    }

    // Supervisor messages past 90 days (LF5): every run, whatever the windows. Its failure is its
    // own, as the recording step's: the steps after it still run.
    try {
      await purgeSupervisorMessages(dryRun, report);
    } catch (err: any) {
      report.supervisor_messages_error = err?.message ?? String(err);
      log.error({ err, messagesDeleted: report.supervisor_messages_deleted },
        'Deleting supervisor messages past their 90 days failed — the other retention steps still run; the next run carries on');
    }

    // Transcript window: null conversation_log + transcript_meta on agency_calls
    // older than the (shorter) transcript-retention window, leaving call_analysis +
    // the row intact until the row cutoff above handles agency_calls.
    const transcriptDays = config.retention.agencyTranscriptRetentionDays;
    if (transcriptDays !== undefined) {
      report.agency_transcripts_nulled = await purgeAgencyTranscripts(dryRun, transcriptDays);
    }

    // Last: the one step that depends on the bucket, so an object store that is down (or not
    // configured) never holds back the database steps above.
    if (cutoff) {
      const voicemails = await purgeInboundVoicemails(dryRun, cutoff);
      report.inbound_voicemails_deleted = voicemails.deleted;
      report.inbound_voicemails_failed = voicemails.failed;
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
 * writing.
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

/**
 * The calls holding a recording link they did not ask for. Spelled exactly as
 * `idx_agency_calls_recording_unrequested`'s predicate (0046), so the planner can prove each read
 * implies it and walk that index, which holds only these rows.
 */
const UNREQUESTED_RECORDING = 'recording_url IS NOT NULL AND NOT recording_requested';

/** Below every id: the recording step's keyset starts here (`gen_random_uuid` never returns it). */
const NIL_UUID = '00000000-0000-0000-0000-000000000000';

/**
 * One batch of the recording step: $1 = batch size, $2 = the last id of the previous batch.
 * Picks with `WITH picked AS MATERIALIZED (… FOR UPDATE SKIP LOCKED)` (packages/db/CLAUDE.md), so
 * the batch is exactly the rows picked, never a re-run of the pick; a row another transaction
 * holds is skipped for the next run. A keyset on id, so no batch walks the index entries the
 * batches before it cleared. `picked` below the batch size means the walk reached the end.
 */
export const CLEAR_UNREQUESTED_RECORDINGS_SQL = `WITH picked AS MATERIALIZED (
         SELECT id FROM agency_calls
          WHERE ${UNREQUESTED_RECORDING} AND id > $2::uuid
          ORDER BY id
          LIMIT $1
          FOR UPDATE SKIP LOCKED
       ), cleared AS (
         UPDATE agency_calls k SET recording_url = NULL, recording_duration_seconds = NULL
           FROM picked WHERE k.id = picked.id
         RETURNING k.id
       )
       SELECT (SELECT count(*) FROM picked)::int AS picked,
              (SELECT count(*) FROM cleared)::int AS cleared,
              (SELECT id FROM picked ORDER BY id DESC LIMIT 1) AS last_id`;

/**
 * Recordings a call did not ask for (RC5, Manas 2026-11-15): clear `recording_url` and
 * `recording_duration_seconds` on every call whose `recording_requested` is false, in batches,
 * adding each batch to `report.unrequested_recordings_cleared` as it commits (so a failure part
 * way still reports what was done). Every read already treats such a link as "not recorded"
 * (RC1); this removes the link itself. Our link only: a carrier that recorded anyway (VoiceLink,
 * on its own account default) still holds the audio. Only rows that still carry a link, so a
 * no-op once cleared; reads `idx_agency_calls_recording_unrequested` (0046), which then holds
 * nothing, so a run with nothing to clear reads next to nothing.
 *
 * Insights: 0012's row trigger on `recording_url` fires for each cleared call and inserts one
 * dirty mark for its attempt's bucket (none for a soft-phone or inbound call, which has no
 * attempt). The recompute counts the same as before (RC1's reads already left the link out, and
 * 0043 had marked those buckets), and the job claims every mark of a bucket at once, so the cost
 * is one small insert per cleared row, once, on the first run after RC1; nothing else needs doing.
 * In dry-run mode it counts.
 */
async function purgeUnrequestedRecordings(dryRun: boolean, report: RetentionPurgeReport): Promise<void> {
  const pool = getPool();
  if (dryRun) {
    const result = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM agency_calls WHERE ${UNREQUESTED_RECORDING}`,
    );
    report.unrequested_recordings_cleared = result.rows[0]?.n ?? 0;
    return;
  }
  let after = NIL_UUID;
  for (;;) {
    const { rows }: { rows: Array<{ picked: number; cleared: number; last_id: string | null }> } =
      await pool.query(CLEAR_UNREQUESTED_RECORDINGS_SQL, [BATCH_SIZE, after]);
    const batch = rows[0];
    report.unrequested_recordings_cleared += batch?.cleared ?? 0;
    if (!batch || batch.picked < BATCH_SIZE || batch.last_id === null) break;
    after = batch.last_id;
  }
  if (report.unrequested_recordings_cleared > 0) {
    log.info({ recordingsCleared: report.unrequested_recordings_cleared }, 'Recording links cleared on calls that did not ask for a recording');
  }
}

/**
 * One batch of the messages step: $1 = cutoff, $2 = batch size. Picks with `MATERIALIZED … FOR
 * UPDATE SKIP LOCKED` (packages/db/CLAUDE.md), so a batch deletes exactly the rows picked, on
 * `idx_agency_supervisor_messages_sent_at` (0052).
 */
export const DELETE_OLD_SUPERVISOR_MESSAGES_SQL = `WITH old_messages AS MATERIALIZED (
         SELECT id FROM agency_supervisor_messages
          WHERE sent_at < $1
          ORDER BY sent_at
          LIMIT $2
          FOR UPDATE SKIP LOCKED
       )
       DELETE FROM agency_supervisor_messages m USING old_messages WHERE m.id = old_messages.id`;

/**
 * The Live floor's supervisor messages (LF5): kept {@link AGENCY_SUPERVISOR_MESSAGE_RETENTION_DAYS}
 * days from when they were sent, then deleted, in batches, adding each batch to
 * `report.supervisor_messages_deleted` as it commits. A fixed policy (Manas, LF5), so it runs on
 * every run whatever `AGENCY_RETENTION_DAYS` says. In dry-run mode it counts.
 */
async function purgeSupervisorMessages(dryRun: boolean, report: RetentionPurgeReport): Promise<void> {
  const pool = getPool();
  const cutoff = new Date(Date.now() - AGENCY_SUPERVISOR_MESSAGE_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  if (dryRun) {
    const result = await pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM agency_supervisor_messages WHERE sent_at < $1', [cutoff],
    );
    report.supervisor_messages_deleted = result.rows[0]?.n ?? 0;
    return;
  }
  let deleted: number;
  do {
    const result = await pool.query(DELETE_OLD_SUPERVISOR_MESSAGES_SQL, [cutoff, BATCH_SIZE]);
    deleted = result.rowCount ?? 0;
    report.supervisor_messages_deleted += deleted;
  } while (deleted === BATCH_SIZE);
  if (report.supervisor_messages_deleted > 0) {
    log.info({ messagesDeleted: report.supervisor_messages_deleted }, 'Supervisor messages past their 90 days deleted');
  }
}

/** Voicemails deleted per batch: each is one object delete, so far fewer than a row batch. */
const VOICEMAIL_BATCH_SIZE = 200;

/**
 * Inbound voicemails on the call-data window (docs/inbound.md §7): for every call that arrived
 * before `cutoff` and still names a voicemail, the object is deleted from the bucket, THEN the
 * row forgets it (only while it still names that key), so an object is never orphaned by a
 * cleared row. A delete that fails leaves its row naming the object for the next run and is
 * counted in `failed`; the rest go on (a keyset walk, so a failing row is not read again in this
 * run). With no bucket configured nothing can be deleted: the step is skipped with a warning and
 * the rows keep their keys. In dry-run mode it counts.
 */
async function purgeInboundVoicemails(dryRun: boolean, cutoff: Date): Promise<{ deleted: number; failed: number }> {
  const pool = getPool();
  if (dryRun) {
    const result = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM agency_inbound_calls
        WHERE voicemail_key IS NOT NULL AND arrived_at < $1`,
      [cutoff],
    );
    return { deleted: result.rows[0]?.n ?? 0, failed: 0 };
  }
  if (!isStorageConfigured()) {
    log.warn('No audio bucket is configured — inbound voicemails past the window are left for a run that can delete them');
    return { deleted: 0, failed: 0 };
  }
  let deleted = 0;
  let failed = 0;
  let after = null as { arrivedAt: Date; id: string } | null;
  for (;;) {
    const { rows }: { rows: Array<{ id: string; voicemail_key: string; arrived_at: Date }> } = await pool.query(
      `SELECT id, voicemail_key, arrived_at FROM agency_inbound_calls
        WHERE voicemail_key IS NOT NULL AND arrived_at < $1
          AND ($3::timestamptz IS NULL OR (arrived_at, id) > ($3::timestamptz, $4::uuid))
        ORDER BY arrived_at, id
        LIMIT $2`,
      [cutoff, VOICEMAIL_BATCH_SIZE, after?.arrivedAt ?? null, after?.id ?? null],
    );
    for (const row of rows) {
      try {
        await deleteFile(row.voicemail_key);
        const cleared = await pool.query(
          `UPDATE agency_inbound_calls SET voicemail_key = NULL, voicemail_seconds = NULL
            WHERE id = $1 AND voicemail_key = $2`,
          [row.id, row.voicemail_key],
        );
        deleted += cleared.rowCount ?? 0;
      } catch (err) {
        failed++;
        log.warn({ err, inboundCallId: row.id }, 'Could not delete an inbound voicemail — the next run retries it');
      }
    }
    const last = rows.at(-1);
    if (!last || rows.length < VOICEMAIL_BATCH_SIZE) break;
    after = { arrivedAt: last.arrived_at, id: last.id };
  }
  if (deleted > 0 || failed > 0) log.info({ voicemailsDeleted: deleted, voicemailsFailed: failed }, 'Inbound voicemails deleted (retention window)');
  return { deleted, failed };
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
    : report.unrequested_recordings_error || report.supervisor_messages_error
      ? ':warning: Retention purge complete, one step failed'
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
    `recording links cleared (calls that did not ask for one): ${report.unrequested_recordings_cleared.toLocaleString()}`,
    report.unrequested_recordings_error
      ? `recording links step FAILED (the other steps ran; the next run carries on): ${report.unrequested_recordings_error}`
      : null,
    `supervisor messages past 90 days ${report.dry_run ? 'matched' : 'deleted'}: ${report.supervisor_messages_deleted.toLocaleString()}`,
    report.supervisor_messages_error
      ? `supervisor messages step FAILED (the other steps ran; the next run carries on): ${report.supervisor_messages_error}`
      : null,
    `inbound voicemails ${report.dry_run ? 'matched' : 'deleted'}: ${report.inbound_voicemails_deleted.toLocaleString()}`,
    report.inbound_voicemails_failed > 0
      ? `inbound voicemails not deleted (retried next run): ${report.inbound_voicemails_failed.toLocaleString()}`
      : null,
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
