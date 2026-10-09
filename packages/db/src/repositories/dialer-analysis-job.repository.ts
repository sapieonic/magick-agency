/*
 * Notes on this repository:
 *  - every statement targets `agency_calls` (the baseline's rename of `webrtc_calls`);
 *  - there is no settlement step: no `claimPendingSettlements`,
 *    `markSettlementSent`, `markSettlementAbandoned`, `oldestPendingSettlementAgeSeconds`
 *    and every `settlement_*` assignment are gone, as the baseline dropped the
 *    columns. `completeWithAnalysis` no longer stamps `next_attempt_at = now()`
 *    (its only reader was the settlement claim). `analysis_audio_seconds` is kept.
 */

import { getPool } from '../connection.js';
import type { PoolClient } from 'pg';
import type {
  DialerAnalysisJobRecord,
  EnqueueDialerAnalysisJobInput,
} from '../models/dialer-analysis-job.model.js';
import type { CallAnalysisResult } from '../models/call.model.js';
import type {
  DialerTranscriptEntry,
  TranscriptMeta,
} from '../models/agency-call.model.js';

/**
 * Durable DB primitives for the dialer-analysis job. The runner/worker built on
 * top stay thin: every state transition, claim, heartbeat and fence
 * step is one guarded statement (or one transaction) here.
 *
 * Multi-replica safety rests on two techniques used elsewhere in the repo:
 *   - `FOR UPDATE SKIP LOCKED` for claiming (the failStaleActive technique), so
 *     concurrent workers never double-claim a row.
 *   - claim-generation fencing (`WHERE ... AND claim_generation = $N`) on every
 *     persisting write, so a resurrected original runner can't stomp a recovered
 *     run's output.
 *
 * All identifiers are literal; every value is a bound parameter — injection-safe.
 */
export class DialerAnalysisJobRepository {
  // ── Enqueue ────────────────────────────────────────────────────────────

  /**
   * Idempotent enqueue driven by a DB read of the call row (B1): the job lands in
   * `queued` when the recording already arrived, else `awaiting_recording` — never
   * from (possibly stale) session state, so a recording that beat `endCall` isn't
   * hidden. `ON CONFLICT (call_id) DO NOTHING` makes a duplicate webhook a no-op.
   * Mirrors the derived state onto the call row's `analysis_status` in the SAME
   * statement (a CTE, atomic) — `pending` when queued, `awaiting_recording`
   * otherwise — so the UI's 'awaiting_recording' state renders from intake. The
   * mirror only fires for a freshly-inserted job, is guarded `IS DISTINCT FROM
   * 'deleted'` (FIX 4), and won't clobber a terminal state that somehow pre-exists.
   * Returns the (new or pre-existing) job, or null when the call row is absent.
   */
  async enqueueFromCall(input: EnqueueDialerAnalysisJobInput): Promise<DialerAnalysisJobRecord | null> {
    const pool = getPool();
    const inserted = await pool.query<DialerAnalysisJobRecord>(
      `WITH ins AS (
         INSERT INTO dialer_analysis_jobs
           (call_id, tenant_id, account_id, profile_id, profile_snapshot, analysis_language, status)
         SELECT c.id, c.tenant_id, c.account_id, $2, $3::jsonb, $4,
                CASE WHEN c.recording_url IS NOT NULL THEN 'queued' ELSE 'awaiting_recording' END
         FROM agency_calls c WHERE c.id = $1
         ON CONFLICT (call_id) DO NOTHING
         RETURNING *
       ),
       mirror AS (
         UPDATE agency_calls
         SET analysis_status = CASE WHEN ins.status = 'queued' THEN 'pending' ELSE 'awaiting_recording' END
         FROM ins
         WHERE agency_calls.id = ins.call_id
           AND agency_calls.analysis_status IS DISTINCT FROM 'deleted'
           AND (agency_calls.analysis_status IS NULL
                OR agency_calls.analysis_status IN ('awaiting_recording','pending'))
         RETURNING agency_calls.id
       )
       SELECT * FROM ins`,
      [
        input.call_id,
        input.profile_id ?? null,
        input.profile_snapshot === undefined || input.profile_snapshot === null
          ? null
          : JSON.stringify(input.profile_snapshot),
        input.analysis_language ?? null,
      ],
    );
    if (inserted.rows[0]) return inserted.rows[0];
    // Either the call row was missing, or a job already existed (ON CONFLICT). The
    // pre-existing job is the useful return; a missing call yields null.
    return this.findByCallId(input.call_id);
  }

  // ── Lookups ────────────────────────────────────────────────────────────

  async findById(id: string): Promise<DialerAnalysisJobRecord | null> {
    const pool = getPool();
    const result = await pool.query<DialerAnalysisJobRecord>(
      'SELECT * FROM dialer_analysis_jobs WHERE id = $1',
      [id],
    );
    return result.rows[0] ?? null;
  }

  async findByCallId(callId: string): Promise<DialerAnalysisJobRecord | null> {
    const pool = getPool();
    const result = await pool.query<DialerAnalysisJobRecord>(
      'SELECT * FROM dialer_analysis_jobs WHERE call_id = $1',
      [callId],
    );
    return result.rows[0] ?? null;
  }

  /** Support/internal listing ("why is there no summary"). Scoped when tenant given. */
  async list(opts: {
    tenant_id?: string;
    call_id?: string;
    status?: string;
    limit?: number;
    offset?: number;
  }): Promise<DialerAnalysisJobRecord[]> {
    const pool = getPool();
    const values: unknown[] = [];
    const clauses: string[] = [];
    if (opts.tenant_id) {
      values.push(opts.tenant_id);
      clauses.push(`tenant_id = $${values.length}`);
    }
    if (opts.call_id) {
      values.push(opts.call_id);
      clauses.push(`call_id = $${values.length}`);
    }
    if (opts.status) {
      values.push(opts.status);
      clauses.push(`status = $${values.length}`);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    values.push(opts.limit ?? 50);
    const limitIdx = values.length;
    values.push(opts.offset ?? 0);
    const offsetIdx = values.length;
    const result = await pool.query<DialerAnalysisJobRecord>(
      `SELECT * FROM dialer_analysis_jobs ${where}
       ORDER BY created_at DESC, id DESC LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
      values,
    );
    return result.rows;
  }

  // ── Recording readiness (B1) ─────────────────────────────────────────────

  /**
   * The recording webhook landed: promote this call's job awaiting → queued,
   * guarded on `status='awaiting_recording'` so a duplicate webhook (C3) can't
   * re-queue a running or completed job. A short settle delay (default 0) defers
   * the first claim past a possible pre-finalization URL. Returns the updated
   * job, or null when nothing was in `awaiting_recording` (duplicate/late webhook).
   */
  async markRecordingReady(callId: string, settleSeconds = 0): Promise<DialerAnalysisJobRecord | null> {
    const pool = getPool();
    const result = await pool.query<DialerAnalysisJobRecord>(
      `WITH promoted AS (
         UPDATE dialer_analysis_jobs
         SET status = 'queued',
             next_attempt_at = now() + ($2::int * INTERVAL '1 second')
         WHERE call_id = $1 AND status = 'awaiting_recording'
         RETURNING *
       ),
       mirror AS (
         UPDATE agency_calls
         SET analysis_status = 'pending'
         FROM promoted
         WHERE agency_calls.id = promoted.call_id
           AND agency_calls.analysis_status IS DISTINCT FROM 'deleted'
           AND agency_calls.analysis_status IN ('awaiting_recording','pending')
         RETURNING agency_calls.id
       )
       SELECT * FROM promoted`,
      [callId, settleSeconds],
    );
    return result.rows[0] ?? null;
  }

  /**
   * Sweep promotion (B1): any `awaiting_recording` job whose call row now carries a
   * `recording_url` is queued — this self-heals every lost-wake cause. MUST run
   * before {@link expireAwaitingRecording}. Returns the number promoted.
   */
  async promoteRecordingReady(settleSeconds = 0, limit = 500): Promise<number> {
    const pool = getPool();
    const result = await pool.query(
      `WITH promoted AS (
         UPDATE dialer_analysis_jobs j
         SET status = 'queued',
             next_attempt_at = now() + ($1::int * INTERVAL '1 second')
         FROM agency_calls c
         WHERE j.call_id = c.id
           AND j.status = 'awaiting_recording'
           AND c.recording_url IS NOT NULL
           AND j.id IN (
             SELECT id FROM dialer_analysis_jobs
             WHERE status = 'awaiting_recording'
             ORDER BY created_at
             LIMIT $2
             FOR UPDATE SKIP LOCKED
           )
         RETURNING j.call_id
       ),
       mirror AS (
         UPDATE agency_calls
         SET analysis_status = 'pending'
         FROM promoted
         WHERE agency_calls.id = promoted.call_id
           AND agency_calls.analysis_status IS DISTINCT FROM 'deleted'
           AND agency_calls.analysis_status IN ('awaiting_recording','pending')
         RETURNING agency_calls.id
       )
       SELECT call_id FROM promoted`,
      [settleSeconds, limit],
    );
    return result.rowCount ?? 0;
  }

  /**
   * Expire `awaiting_recording` jobs older than `olderThan` whose call still has no
   * recording_url — the carrier never delivered. Runs AFTER promotion, so a
   * delivered-but-unpromoted job is never wrongly expired. Mirrors
   * `analysis_status='expired'` onto each swept call row in the SAME statement (a
   * CTE, atomic) so the UI's `expired` state renders and the retry route is
   * reachable; the call-row write is guarded `IS DISTINCT FROM 'deleted'` so a DSAR
   * erasure is never resurrected (FIX 4). Returns the expired job rows.
   */
  async expireAwaitingRecording(olderThan: Date, limit = 500): Promise<DialerAnalysisJobRecord[]> {
    const pool = getPool();
    const result = await pool.query<DialerAnalysisJobRecord>(
      `WITH to_expire AS (
         SELECT j.id FROM dialer_analysis_jobs j
         JOIN agency_calls c ON c.id = j.call_id
         WHERE j.status = 'awaiting_recording'
           AND j.created_at < $1
           AND c.recording_url IS NULL
         ORDER BY j.created_at
         LIMIT $2
         FOR UPDATE SKIP LOCKED
       ),
       expired AS (
         UPDATE dialer_analysis_jobs
         SET status = 'expired',
             error_code = 'RECORDING_NEVER_ARRIVED',
             error_message = 'no recording delivered within the wait window'
         WHERE id IN (SELECT id FROM to_expire)
         RETURNING *
       ),
       mirror AS (
         UPDATE agency_calls
         SET analysis_status = 'expired'
         FROM expired
         WHERE agency_calls.id = expired.call_id
           AND agency_calls.analysis_status IS DISTINCT FROM 'deleted'
         RETURNING agency_calls.id
       )
       SELECT * FROM expired`,
      [olderThan, limit],
    );
    return result.rows;
  }

  // ── Claim + heartbeat ────────────────────────────────────────────────────

  /**
   * Claim up to `limit` runnable jobs (status queued, next_attempt_at due): flip to
   * `transcribing`, stamp claim/heartbeat, bump `claim_generation` (the fence),
   * `attempts`, and `attempts_total`. `FOR UPDATE SKIP LOCKED` makes it
   * multi-replica-safe with no extra coordination. Returns the claimed rows.
   */
  async claimRunnable(limit: number): Promise<DialerAnalysisJobRecord[]> {
    const pool = getPool();
    const result = await pool.query<DialerAnalysisJobRecord>(
      `UPDATE dialer_analysis_jobs
       SET status = 'transcribing',
           claimed_at = now(),
           heartbeat_at = now(),
           claim_generation = claim_generation + 1,
           attempts = attempts + 1,
           attempts_total = attempts_total + 1
       WHERE id IN (
         SELECT id FROM dialer_analysis_jobs
         WHERE status = 'queued'
           AND (next_attempt_at IS NULL OR next_attempt_at <= now())
         ORDER BY next_attempt_at NULLS FIRST, created_at
         LIMIT $1
         FOR UPDATE SKIP LOCKED
       )
       RETURNING *`,
      [limit],
    );
    return result.rows;
  }

  /** Heartbeat, fenced on the claim generation. Returns false when the fence rejects it. */
  async heartbeat(id: string, generation: number): Promise<boolean> {
    const pool = getPool();
    const result = await pool.query(
      `UPDATE dialer_analysis_jobs SET heartbeat_at = now()
       WHERE id = $1 AND claim_generation = $2 AND status IN ('transcribing','analyzing')`,
      [id, generation],
    );
    return (result.rowCount ?? 0) > 0;
  }

  /** transcribing → analyzing, fenced. Returns false when the fence rejects it. */
  async markAnalyzing(id: string, generation: number): Promise<boolean> {
    const pool = getPool();
    const result = await pool.query(
      `UPDATE dialer_analysis_jobs
       SET status = 'analyzing', heartbeat_at = now()
       WHERE id = $1 AND claim_generation = $2 AND status = 'transcribing'`,
      [id, generation],
    );
    return (result.rowCount ?? 0) > 0;
  }

  // ── Persist transcript / complete ────────────────────────────────────────

  /**
   * Persist the transcript to the CALL row (conversation_log + transcript_meta +
   * analysis_status='pending'), fenced on the job's claim generation. Job and call
   * are separate tables, so the fence is enforced by checking the job's generation
   * inside the same transaction before writing the call row; a stale runner's write
   * is rejected (returns false). Idempotent step 7 — a retry with an existing
   * conversation_log skips re-transcription.
   */
  async persistTranscript(
    jobId: string,
    callId: string,
    generation: number,
    transcript: {
      conversation_log: DialerTranscriptEntry[];
      transcript_meta: TranscriptMeta;
    },
  ): Promise<boolean> {
    const pool = getPool();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const fenced = await this.assertGeneration(client, jobId, generation);
      if (!fenced) {
        await client.query('ROLLBACK');
        return false;
      }
      await client.query(
        `UPDATE agency_calls
         SET conversation_log = $2::jsonb,
             transcript_meta = $3::jsonb,
             analysis_status = 'pending'
         WHERE id = $1 AND analysis_status IS DISTINCT FROM 'deleted'`,
        [callId, JSON.stringify(transcript.conversation_log), JSON.stringify(transcript.transcript_meta)],
      );
      await client.query('COMMIT');
      return true;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Complete BOTH tables in one transaction (M8), fenced on the job generation: the
   * call row gets `call_analysis` + `analysis_status='completed'`, the job goes
   * `completed`. A crash between the two writes can't leave the job completed and the call
   * pending forever. Returns false when the fence rejects it.
   */
  async completeWithAnalysis(
    jobId: string,
    callId: string,
    generation: number,
    result: {
      call_analysis: CallAnalysisResult;
      analysis_audio_seconds: number;
    },
  ): Promise<boolean> {
    const pool = getPool();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const fenced = await this.assertGeneration(client, jobId, generation);
      if (!fenced) {
        await client.query('ROLLBACK');
        return false;
      }
      await client.query(
        `UPDATE agency_calls
         SET call_analysis = $2::jsonb, analysis_status = 'completed'
         WHERE id = $1 AND analysis_status IS DISTINCT FROM 'deleted'`,
        [callId, JSON.stringify(result.call_analysis)],
      );
      await client.query(
        `UPDATE dialer_analysis_jobs
         SET status = 'completed',
             analysis_audio_seconds = $2,
             error_code = NULL,
             error_message = NULL
         WHERE id = $1`,
        [jobId, result.analysis_audio_seconds],
      );
      await client.query('COMMIT');
      return true;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  // ── Failure / requeue / skip ──────────────────────────────────────────────

  /**
   * Requeue for a retryable failure, fenced. Increments nothing (the claim already
   * charged an attempt); sets `next_attempt_at` to the caller-computed backoff and
   * records the last error for support. Returns false when the fence rejects it.
   */
  async requeueForRetry(
    id: string,
    generation: number,
    backoffSeconds: number,
    errorCode: string,
    errorMessage: string,
  ): Promise<boolean> {
    const pool = getPool();
    const result = await pool.query(
      `WITH requeued AS (
         UPDATE dialer_analysis_jobs
         SET status = 'queued',
             next_attempt_at = now() + ($3::int * INTERVAL '1 second'),
             error_code = $4,
             error_message = $5
         WHERE id = $1 AND claim_generation = $2 AND status IN ('transcribing','analyzing')
         RETURNING call_id
       ),
       mirror AS (
         UPDATE agency_calls
         SET analysis_status = 'pending'
         FROM requeued
         WHERE agency_calls.id = requeued.call_id
           AND agency_calls.analysis_status IS DISTINCT FROM 'deleted'
           AND agency_calls.analysis_status IN ('awaiting_recording','pending')
         RETURNING agency_calls.id
       )
       SELECT call_id FROM requeued`,
      [id, generation, backoffSeconds, errorCode, errorMessage.slice(0, 2000)],
    );
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * `RATE_LIMITED` requeue that does NOT consume an attempt (M4): we were never
   * given a chance to succeed. Decrements `attempts` and `attempts_total` back to
   * pre-claim, applies a longer jittered backoff. Fenced. Never drops below 0.
   */
  async requeueRateLimited(
    id: string,
    generation: number,
    backoffSeconds: number,
  ): Promise<boolean> {
    const pool = getPool();
    const result = await pool.query(
      `WITH requeued AS (
         UPDATE dialer_analysis_jobs
         SET status = 'queued',
             attempts = GREATEST(attempts - 1, 0),
             attempts_total = GREATEST(attempts_total - 1, 0),
             next_attempt_at = now() + ($3::int * INTERVAL '1 second'),
             error_code = 'RATE_LIMITED',
             error_message = 'transcriber rate-limited; retrying without consuming an attempt'
         WHERE id = $1 AND claim_generation = $2 AND status IN ('transcribing','analyzing')
         RETURNING call_id
       ),
       mirror AS (
         UPDATE agency_calls
         SET analysis_status = 'pending'
         FROM requeued
         WHERE agency_calls.id = requeued.call_id
           AND agency_calls.analysis_status IS DISTINCT FROM 'deleted'
           AND agency_calls.analysis_status IN ('awaiting_recording','pending')
         RETURNING agency_calls.id
       )
       SELECT call_id FROM requeued`,
      [id, generation, backoffSeconds],
    );
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * Terminal failure (attempts exhausted or non-retryable), fenced.
   * Mirrors `analysis_status='failed'` onto the call row in the SAME transaction (M8)
   * so the retry route — which gates on `record.analysis_status ∈ {failed,expired}` —
   * is actually reachable and a transcribed-then-failed call doesn't sit at 'pending'
   * forever. The call-row write is guarded `IS DISTINCT FROM 'deleted'` so a DSAR
   * erasure is never resurrected (FIX 4). Returns false when the fence rejects it.
   */
  async markFailed(
    id: string,
    callId: string,
    generation: number,
    errorCode: string,
    errorMessage: string,
  ): Promise<boolean> {
    const pool = getPool();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const jobResult = await client.query(
        `UPDATE dialer_analysis_jobs
         SET status = 'failed',
             error_code = $3,
             error_message = $4
         WHERE id = $1 AND claim_generation = $2 AND status IN ('transcribing','analyzing')`,
        [id, generation, errorCode, errorMessage.slice(0, 2000)],
      );
      if ((jobResult.rowCount ?? 0) === 0) {
        // Fence rejected — a recovered run owns this job now. Leave the call row alone.
        await client.query('ROLLBACK');
        return false;
      }
      await client.query(
        `UPDATE agency_calls SET analysis_status = 'failed'
         WHERE id = $1 AND analysis_status IS DISTINCT FROM 'deleted'`,
        [callId],
      );
      await client.query('COMMIT');
      return true;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Skip a job (empty transcript, gate flipped, etc.), fenced. Mirrors the call
   * row's `analysis_status='skipped'`. The call
   * write is DSAR-guarded so an erased call is never resurrected. Returns false
   * when the fence rejects it.
   */
  async markSkipped(
    id: string,
    callId: string,
    generation: number,
    errorCode: string,
    errorMessage: string,
  ): Promise<boolean> {
    const pool = getPool();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const fenced = await this.assertGeneration(client, id, generation);
      if (!fenced) {
        await client.query('ROLLBACK');
        return false;
      }
      await client.query(
        `UPDATE dialer_analysis_jobs
         SET status = 'skipped',
             error_code = $2, error_message = $3
         WHERE id = $1`,
        [id, errorCode, errorMessage.slice(0, 2000)],
      );
      await client.query(
        `UPDATE agency_calls SET analysis_status = 'skipped'
         WHERE id = $1 AND analysis_status IS DISTINCT FROM 'deleted'`,
        [callId],
      );
      await client.query('COMMIT');
      return true;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  // ── Crash recovery ────────────────────────────────────────────────────────

  /**
   * Recover in-flight jobs whose heartbeat went stale (owning process died):
   * back to `queued`, **decrementing `attempts`** (infra churn is not a real
   * attempt, M7) but NOT `attempts_total`, and bumping `claim_generation` so any
   * resurrected original runner is fenced out. Once `attempts_total` reaches its
   * higher ceiling the row is failed `SYSTEM_REBOOTED` instead. Returns recovered rows.
   */
  async recoverStale(
    staleBefore: Date,
    attemptsTotalCeiling: number,
    limit = 100,
  ): Promise<DialerAnalysisJobRecord[]> {
    const pool = getPool();
    const result = await pool.query<DialerAnalysisJobRecord>(
      `WITH recovered AS (
         UPDATE dialer_analysis_jobs
         SET status = CASE WHEN attempts_total >= $2 THEN 'failed' ELSE 'queued' END,
             attempts = CASE WHEN attempts_total >= $2 THEN attempts ELSE GREATEST(attempts - 1, 0) END,
             claim_generation = claim_generation + 1,
             next_attempt_at = now(),
             error_code = CASE WHEN attempts_total >= $2 THEN 'SYSTEM_REBOOTED' ELSE error_code END,
             error_message = CASE WHEN attempts_total >= $2
               THEN 'recovered too many times; owning process kept dying' ELSE error_message END
         WHERE id IN (
           SELECT id FROM dialer_analysis_jobs
           WHERE status IN ('transcribing','analyzing')
             AND (heartbeat_at IS NULL OR heartbeat_at < $1)
           ORDER BY heartbeat_at NULLS FIRST
           LIMIT $3
           FOR UPDATE SKIP LOCKED
         )
         RETURNING *
       ), mirrored AS (
         UPDATE agency_calls AS c
         SET analysis_status = CASE WHEN recovered.status = 'failed' THEN 'failed' ELSE 'pending' END
         FROM recovered
         WHERE c.id = recovered.call_id
           AND c.analysis_status IS DISTINCT FROM 'deleted'
         RETURNING c.id
       )
       SELECT * FROM recovered`,
      [staleBefore, attemptsTotalCeiling, limit],
    );
    return result.rows;
  }

  /**
   * Graceful shutdown: re-queue THIS replica's in-flight jobs (by id + the exact
   * claim generation it holds) and decrement `attempts` so a deploy mid-job costs
   * nothing. Generation-matched so a job already recovered by another replica is
   * left alone; the generation is then advanced to fence the original runner if it
   * completes while shutdown is still draining. Returns the number re-queued.
   */
  async gracefulRequeue(claims: Array<{ id: string; generation: number }>): Promise<number> {
    if (claims.length === 0) return 0;
    const pool = getPool();
    const ids = claims.map((c) => c.id);
    const gens = claims.map((c) => c.generation);
    const result = await pool.query(
      `WITH requeued AS (
         UPDATE dialer_analysis_jobs AS j
         SET status = 'queued',
             attempts = GREATEST(j.attempts - 1, 0),
             claim_generation = j.claim_generation + 1,
             next_attempt_at = now()
         FROM unnest($1::uuid[], $2::int[]) AS claim(id, generation)
         WHERE j.id = claim.id
           AND j.claim_generation = claim.generation
           AND j.status IN ('transcribing','analyzing')
         RETURNING j.call_id
       ), mirrored AS (
         UPDATE agency_calls AS c
         SET analysis_status = 'pending'
         FROM requeued
         WHERE c.id = requeued.call_id
           AND c.analysis_status IS DISTINCT FROM 'deleted'
         RETURNING c.id
       )
       SELECT call_id FROM requeued`,
      [ids, gens],
    );
    return result.rowCount ?? 0;
  }

  // ── Async retry (route) ───────────────────────────────────────────────────

  /**
   * User-initiated retry (async / 202). Only `failed` or `expired` jobs are
   * eligible; grants `+extraAttempts` headroom (raises `attempts` so the claim's
   * increment doesn't immediately re-exhaust it) but NEVER resets `attempts_total`
   * (M5), and refuses once `attempts_total` hits the lifetime ceiling. Sets
   * `queued` + settle delay so the worker picks it up. Returns the updated row, or
   * null when the job isn't retry-eligible or has hit its lifetime ceiling — the
   * caller distinguishes the two by reading the current row.
   */
  async requeueForManualRetry(
    callId: string,
    opts: { extraAttempts: number; attemptsTotalCeiling: number; settleSeconds: number },
  ): Promise<DialerAnalysisJobRecord | null> {
    const pool = getPool();
    const result = await pool.query<DialerAnalysisJobRecord>(
      `WITH requeued AS (
         UPDATE dialer_analysis_jobs
         SET status = 'queued',
             attempts = GREATEST(attempts - $2, 0),
             next_attempt_at = now() + ($4::int * INTERVAL '1 second'),
             error_code = NULL,
             error_message = NULL
         WHERE call_id = $1
           AND status IN ('failed','expired')
           AND attempts_total < $3
         RETURNING *
       ), mirrored AS (
         UPDATE agency_calls AS c
         SET analysis_status = 'pending'
         FROM requeued
         WHERE c.id = requeued.call_id
           AND c.analysis_status IS DISTINCT FROM 'deleted'
         RETURNING c.id
       )
       SELECT * FROM requeued`,
      [callId, opts.extraAttempts, opts.attemptsTotalCeiling, opts.settleSeconds],
    );
    return result.rows[0] ?? null;
  }

  // ── Observability ─────────────────────────────────────────────────────────

  /** Backlog visibility: COUNT(*) GROUP BY status. */
  async queueDepthByStatus(): Promise<Array<{ status: string; count: number }>> {
    const pool = getPool();
    const result = await pool.query<{ status: string; count: string }>(
      `SELECT status, COUNT(*)::text AS count FROM dialer_analysis_jobs GROUP BY status`,
    );
    return result.rows.map((r) => ({ status: r.status, count: parseInt(r.count, 10) }));
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  /** Row-lock the job and assert its claim generation still matches (the fence). */
  private async assertGeneration(client: PoolClient, id: string, generation: number): Promise<boolean> {
    const result = await client.query<{ claim_generation: number }>(
      `SELECT claim_generation FROM dialer_analysis_jobs WHERE id = $1 FOR UPDATE`,
      [id],
    );
    return result.rows[0]?.claim_generation === generation;
  }
}

export const dialerAnalysisJobRepository = new DialerAnalysisJobRepository();
