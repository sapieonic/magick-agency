import { describe, it, expect, vi, beforeEach } from 'vitest';

/*
 * PORT NOTE (magick-agency): ported from core test/unit/db/repositories/dialer-analysis-job.repository.test.ts
 * @4850d1d9 (32 cases -> 27). Statements target `agency_calls`. Deleted with the settlement
 * step (plan §4): "settlement age gauge anchors on settlement_pending_since" (2) and
 * "settlement sweep primitives" (3). Modified: the two `completeWithAnalysis` cases no
 * longer assert settlement columns; they assert the job completes with
 * `analysis_audio_seconds` recorded and that NO settlement column is written. Mocked-SQL
 * cases cannot catch column drift, so every method is also run on real Postgres in
 * test/integration/repositories/dialer-analysis-job.repository.test.ts.
 */

// ── Hoisted mocks ──────────────────────────────────────────────────────
// A single pool.query mock plus a fake client for transaction paths. connect()
// returns a client whose query() shares the same mock so assertions are uniform.

const mocks = vi.hoisted(() => ({
  poolQuery: vi.fn(),
  clientQuery: vi.fn(),
  release: vi.fn(),
}));

vi.mock('../../../../src/connection.js', () => ({
  getPool: () => ({
    query: mocks.poolQuery,
    connect: async () => ({ query: mocks.clientQuery, release: mocks.release }),
  }),
}));

import { DialerAnalysisJobRepository } from '../../../../src/repositories/dialer-analysis-job.repository.js';

const repo = new DialerAnalysisJobRepository();

function poolText(idx = 0): string {
  return mocks.poolQuery.mock.calls[idx]![0] as string;
}
function poolValues(idx = 0): unknown[] {
  return mocks.poolQuery.mock.calls[idx]![1] as unknown[];
}

describe('DialerAnalysisJobRepository', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.poolQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    mocks.clientQuery.mockResolvedValue({ rows: [], rowCount: 0 });
  });

  describe('enqueueFromCall — atomic CASE + DB read (B1)', () => {
    it('derives status in SQL from the call row recording_url with ON CONFLICT DO NOTHING', async () => {
      mocks.poolQuery.mockResolvedValueOnce({ rows: [{ id: 'job-1', status: 'queued' }], rowCount: 1 });

      const job = await repo.enqueueFromCall({
        call_id: 'wc-1',
        profile_id: 'prof-1',
        profile_snapshot: { custom_dimensions: [], context: 'ctx' },
        analysis_language: 'hi-IN',
      });

      const text = poolText();
      // Status is a CASE on the call row, never chosen by the caller.
      expect(text).toContain("CASE WHEN c.recording_url IS NOT NULL THEN 'queued' ELSE 'awaiting_recording'");
      expect(text).toContain('FROM agency_calls c WHERE c.id = $1');
      expect(text).toContain('ON CONFLICT (call_id) DO NOTHING');

      const values = poolValues();
      expect(values[0]).toBe('wc-1');
      expect(values[1]).toBe('prof-1');
      expect(values[2]).toBe(JSON.stringify({ custom_dimensions: [], context: 'ctx' }));
      expect(values[3]).toBe('hi-IN');
      expect(job).toEqual({ id: 'job-1', status: 'queued' });
    });

    it('serializes a null profile_snapshot as null (not the string "null")', async () => {
      mocks.poolQuery.mockResolvedValueOnce({ rows: [{ id: 'job-2' }], rowCount: 1 });
      await repo.enqueueFromCall({ call_id: 'wc-2' });
      expect(poolValues()[2]).toBeNull();
    });

    it('on ON CONFLICT no-op, returns the pre-existing job via findByCallId', async () => {
      mocks.poolQuery
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })                 // INSERT ... DO NOTHING (no row)
        .mockResolvedValueOnce({ rows: [{ id: 'existing' }], rowCount: 1 }); // findByCallId

      const job = await repo.enqueueFromCall({ call_id: 'wc-3' });
      expect(job).toEqual({ id: 'existing' });
      expect(poolText(1)).toContain('WHERE call_id = $1');
    });
  });

  describe('markRecordingReady — guarded awaiting → queued + settle delay', () => {
    it('guards on status=awaiting_recording and applies the settle delay', async () => {
      mocks.poolQuery.mockResolvedValueOnce({ rows: [{ id: 'job-1', status: 'queued' }], rowCount: 1 });

      const result = await repo.markRecordingReady('wc-1', 15);

      const text = poolText();
      expect(text).toContain("status = 'queued'");
      expect(text).toContain("WHERE call_id = $1 AND status = 'awaiting_recording'");
      expect(text).toContain("INTERVAL '1 second'");
      expect(text).toContain("SET analysis_status = 'pending'");
      expect(text).toContain("analysis_status IS DISTINCT FROM 'deleted'");
      expect(poolValues()).toEqual(['wc-1', 15]);
      expect(result).toEqual({ id: 'job-1', status: 'queued' });
    });

    it('returns null when nothing was awaiting (duplicate/late webhook is a no-op)', async () => {
      mocks.poolQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
      const result = await repo.markRecordingReady('wc-1');
      expect(result).toBeNull();
    });
  });

  describe('promoteRecordingReady before expireAwaitingRecording (B1 ordering)', () => {
    it('promotion joins the call row and requires a recording_url', async () => {
      mocks.poolQuery.mockResolvedValueOnce({ rowCount: 3 });
      const promoted = await repo.promoteRecordingReady(0, 500);
      const text = poolText();
      expect(text).toContain("j.status = 'awaiting_recording'");
      expect(text).toContain('c.recording_url IS NOT NULL');
      expect(text).toContain('FOR UPDATE SKIP LOCKED');
      expect(text).toContain("SET analysis_status = 'pending'");
      expect(promoted).toBe(3);
    });

    it('expiry only touches rows whose call has NO recording_url', async () => {
      mocks.poolQuery.mockResolvedValueOnce({ rows: [{ id: 'j1' }], rowCount: 1 });
      await repo.expireAwaitingRecording(new Date('2026-07-28T00:00:00Z'));
      const text = poolText();
      expect(text).toContain("status = 'expired'");
      expect(text).toContain("error_code = 'RECORDING_NEVER_ARRIVED'");
      expect(text).toContain('c.recording_url IS NULL');
    });
  });

  describe('claimRunnable — SKIP LOCKED + generation/attempts bump', () => {
    it('increments claim_generation, attempts and attempts_total under SKIP LOCKED', async () => {
      mocks.poolQuery.mockResolvedValueOnce({ rows: [{ id: 'j1' }], rowCount: 1 });
      await repo.claimRunnable(2);
      const text = poolText();
      expect(text).toContain("status = 'transcribing'");
      expect(text).toContain('claim_generation = claim_generation + 1');
      expect(text).toContain('attempts = attempts + 1');
      expect(text).toContain('attempts_total = attempts_total + 1');
      expect(text).toContain('FOR UPDATE SKIP LOCKED');
      expect(poolValues()).toEqual([2]);
    });
  });

  describe('heartbeat / markAnalyzing — generation fencing', () => {
    it('heartbeat is fenced on id + claim_generation', async () => {
      mocks.poolQuery.mockResolvedValueOnce({ rowCount: 1 });
      const ok = await repo.heartbeat('j1', 4);
      expect(poolText()).toContain('WHERE id = $1 AND claim_generation = $2');
      expect(poolValues()).toEqual(['j1', 4]);
      expect(ok).toBe(true);
    });

    it('heartbeat returns false when the fence rejects it (rowCount 0)', async () => {
      mocks.poolQuery.mockResolvedValueOnce({ rowCount: 0 });
      expect(await repo.heartbeat('j1', 999)).toBe(false);
    });

    it('markAnalyzing transitions transcribing → analyzing fenced', async () => {
      mocks.poolQuery.mockResolvedValueOnce({ rowCount: 1 });
      await repo.markAnalyzing('j1', 2);
      const text = poolText();
      expect(text).toContain("status = 'analyzing'");
      expect(text).toContain("status = 'transcribing'");
      expect(text).toContain('claim_generation = $2');
    });
  });

  describe('persistTranscript — fenced transaction, JSON serialized', () => {
    it('commits when the fence matches and stringifies the blobs', async () => {
      // BEGIN, SELECT ... FOR UPDATE (gen 5), UPDATE agency_calls, COMMIT
      mocks.clientQuery
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({ rows: [{ claim_generation: 5 }] }) // fence
        .mockResolvedValueOnce({ rowCount: 1 }) // UPDATE call
        .mockResolvedValueOnce({}); // COMMIT

      const conversation_log = [{ role: 'agent', content: 'hi' }] as never;
      const transcript_meta = { provider: 'gemini', model: 'g' } as never;
      const ok = await repo.persistTranscript('j1', 'wc-1', 5, { conversation_log, transcript_meta });

      expect(ok).toBe(true);
      // 3rd client call is the agency_calls UPDATE
      const updateCall = mocks.clientQuery.mock.calls[2]!;
      expect(updateCall[0]).toContain("analysis_status = 'pending'");
      expect(updateCall[1]).toEqual(['wc-1', JSON.stringify(conversation_log), JSON.stringify(transcript_meta)]);
      expect(mocks.clientQuery).toHaveBeenLastCalledWith('COMMIT');
      expect(mocks.release).toHaveBeenCalled();
    });

    it('rolls back and returns false when the generation fence mismatches (M9)', async () => {
      mocks.clientQuery
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({ rows: [{ claim_generation: 9 }] }) // fence returns a DIFFERENT gen
        .mockResolvedValueOnce({}); // ROLLBACK

      const ok = await repo.persistTranscript('j1', 'wc-1', 5, {
        conversation_log: [] as never,
        transcript_meta: {} as never,
      });

      expect(ok).toBe(false);
      expect(mocks.clientQuery).toHaveBeenCalledWith('ROLLBACK');
      // Never wrote the call row.
      const wroteCall = mocks.clientQuery.mock.calls.some((c) => String(c[0]).includes('UPDATE agency_calls'));
      expect(wroteCall).toBe(false);
    });
  });

  describe('completeWithAnalysis — one transaction, audio seconds recorded (M8)', () => {
    it('writes both tables and records analysis_audio_seconds when fenced ok', async () => {
      mocks.clientQuery
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({ rows: [{ claim_generation: 3 }] }) // fence
        .mockResolvedValueOnce({ rowCount: 1 }) // UPDATE agency_calls
        .mockResolvedValueOnce({ rowCount: 1 }) // UPDATE job
        .mockResolvedValueOnce({}); // COMMIT

      const call_analysis = { common: { summary: 's' } } as never;
      const ok = await repo.completeWithAnalysis('j1', 'wc-1', 3, {
        call_analysis,
        analysis_audio_seconds: 120,
      });

      expect(ok).toBe(true);
      const callUpdate = mocks.clientQuery.mock.calls[2]!;
      expect(callUpdate[0]).toContain("analysis_status = 'completed'");
      // FIX 4: DSAR-erasure guard on the call-row write (never the job write).
      expect(callUpdate[0]).toContain("analysis_status IS DISTINCT FROM 'deleted'");
      expect(callUpdate[1]).toEqual(['wc-1', JSON.stringify(call_analysis)]);
      const jobUpdate = mocks.clientQuery.mock.calls[3]!;
      expect(jobUpdate[0]).toContain("status = 'completed'");
      expect(jobUpdate[0]).toContain('analysis_audio_seconds = $2');
      // Settlement is removed: no settlement column is written, anywhere.
      expect(jobUpdate[0]).not.toContain('settlement');
      expect(jobUpdate[1]).toEqual(['j1', 120]);
    });

    it('FIX 4: a DSAR erasure mid-flight → job still completes even though the call-row write matches 0 rows', async () => {
      mocks.clientQuery
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({ rows: [{ claim_generation: 3 }] }) // fence ok
        .mockResolvedValueOnce({ rowCount: 0 }) // UPDATE agency_calls → 0 rows (erased)
        .mockResolvedValueOnce({ rowCount: 1 }) // UPDATE job → still completes
        .mockResolvedValueOnce({}); // COMMIT

      const ok = await repo.completeWithAnalysis('j1', 'wc-1', 3, {
        call_analysis: { common: { summary: 's' } } as never,
        analysis_audio_seconds: 60,
      });

      // The analysis ran and its audio is to be recorded — the job must still complete.
      expect(ok).toBe(true);
      const jobUpdate = mocks.clientQuery.mock.calls[3]!;
      expect(jobUpdate[0]).toContain("status = 'completed'");
      expect(jobUpdate[0]).toContain('analysis_audio_seconds = $2');
      expect(jobUpdate[1]).toEqual(['j1', 60]);
      expect(mocks.clientQuery).toHaveBeenLastCalledWith('COMMIT');
    });
  });

  describe('persistTranscript — DSAR erasure guard (FIX 4)', () => {
    it('guards the call-row write with IS DISTINCT FROM deleted (job/blob write only)', async () => {
      mocks.clientQuery
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({ rows: [{ claim_generation: 5 }] }) // fence
        .mockResolvedValueOnce({ rowCount: 0 }) // UPDATE agency_calls (erased → no-op)
        .mockResolvedValueOnce({}); // COMMIT

      const ok = await repo.persistTranscript('j1', 'wc-1', 5, {
        conversation_log: [] as never,
        transcript_meta: {} as never,
      });

      expect(ok).toBe(true);
      const updateCall = mocks.clientQuery.mock.calls[2]!;
      expect(updateCall[0]).toContain("analysis_status = 'pending'");
      expect(updateCall[0]).toContain("analysis_status IS DISTINCT FROM 'deleted'");
    });
  });

  describe('markFailed — mirrors analysis_status=failed onto the call row (FIX 2)', () => {
    it('flips the job to failed then mirrors failed onto the call row in one transaction', async () => {
      mocks.clientQuery
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({ rowCount: 1 }) // UPDATE job → failed (fence ok)
        .mockResolvedValueOnce({ rowCount: 1 }) // UPDATE agency_calls → failed
        .mockResolvedValueOnce({}); // COMMIT

      const ok = await repo.markFailed('j1', 'wc-1', 4, 'ANALYSIS_FAILED', 'boom');

      expect(ok).toBe(true);
      const jobUpdate = mocks.clientQuery.mock.calls[1]!;
      expect(jobUpdate[0]).toContain("status = 'failed'");
      expect(jobUpdate[0]).toContain('claim_generation = $2');
      const callUpdate = mocks.clientQuery.mock.calls[2]!;
      // The retry route reads agency_calls.analysis_status ∈ {failed,expired}; without
      // this mirror it stayed 'pending' and the route was unreachable.
      expect(callUpdate[0]).toContain("analysis_status = 'failed'");
      expect(callUpdate[0]).toContain("analysis_status IS DISTINCT FROM 'deleted'");
      expect(callUpdate[1]).toEqual(['wc-1']);
      expect(mocks.clientQuery).toHaveBeenLastCalledWith('COMMIT');
    });

    it('does NOT touch the call row when the generation fence rejects the job update', async () => {
      mocks.clientQuery
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({ rowCount: 0 }) // fence rejected
        .mockResolvedValueOnce({}); // ROLLBACK

      const ok = await repo.markFailed('j1', 'wc-1', 999, 'X', 'y');

      expect(ok).toBe(false);
      const wroteCall = mocks.clientQuery.mock.calls.some((c) => String(c[0]).includes('UPDATE agency_calls'));
      expect(wroteCall).toBe(false);
      expect(mocks.clientQuery).toHaveBeenCalledWith('ROLLBACK');
    });
  });

  describe('expireAwaitingRecording — mirrors analysis_status=expired (FIX 2)', () => {
    it('mirrors expired onto the swept call rows via a CTE (atomic)', async () => {
      mocks.poolQuery.mockResolvedValueOnce({ rows: [{ id: 'j1', call_id: 'wc-1' }], rowCount: 1 });
      await repo.expireAwaitingRecording(new Date('2026-07-28T00:00:00Z'));
      const text = poolText();
      expect(text).toContain("status = 'expired'");
      expect(text).toContain("error_code = 'RECORDING_NEVER_ARRIVED'");
      expect(text).toContain('c.recording_url IS NULL');
      // Mirror CTE onto the call row, DSAR-guarded.
      expect(text).toContain('UPDATE agency_calls');
      expect(text).toContain("analysis_status = 'expired'");
      expect(text).toContain("analysis_status IS DISTINCT FROM 'deleted'");
    });
  });

  describe('enqueueFromCall — mirrors analysis_status onto the call row (FIX 2)', () => {
    it('mirrors pending/awaiting via a CTE, DSAR- and terminal-state-guarded', async () => {
      mocks.poolQuery.mockResolvedValueOnce({ rows: [{ id: 'job-1', status: 'awaiting_recording' }], rowCount: 1 });
      await repo.enqueueFromCall({ call_id: 'wc-1' });
      const text = poolText();
      // Derived state mirrored: queued→pending, else awaiting_recording.
      expect(text).toContain("WHEN ins.status = 'queued' THEN 'pending' ELSE 'awaiting_recording'");
      expect(text).toContain('UPDATE agency_calls');
      expect(text).toContain("analysis_status IS DISTINCT FROM 'deleted'");
      // Won't clobber a terminal state that somehow pre-exists.
      expect(text).toContain("IN ('awaiting_recording','pending')");
    });
  });

  describe('requeueForRetry — keeps the call lifecycle visibly pending', () => {
    it('requeues the fenced job and mirrors pending without resurrecting deleted calls', async () => {
      mocks.poolQuery.mockResolvedValueOnce({ rows: [{ call_id: 'wc-1' }], rowCount: 1 });
      const updated = await repo.requeueForRetry('j1', 2, 30, 'TRANSCRIPTION_FAILED', 'retry');
      const text = poolText();
      expect(updated).toBe(true);
      expect(text).toContain("status = 'queued'");
      expect(text).toContain("SET analysis_status = 'pending'");
      expect(text).toContain("analysis_status IS DISTINCT FROM 'deleted'");
      expect(text).toContain("IN ('awaiting_recording','pending')");
    });
  });

  describe('requeueRateLimited — does not burn an attempt (M4)', () => {
    it('decrements attempts and attempts_total (floored at 0), fenced', async () => {
      mocks.poolQuery.mockResolvedValueOnce({ rowCount: 1 });
      await repo.requeueRateLimited('j1', 2, 300);
      const text = poolText();
      expect(text).toContain('attempts = GREATEST(attempts - 1, 0)');
      expect(text).toContain('attempts_total = GREATEST(attempts_total - 1, 0)');
      expect(text).toContain("error_code = 'RATE_LIMITED'");
      expect(text).toContain('claim_generation = $2');
      expect(text).toContain("SET analysis_status = 'pending'");
    });
  });

  describe('recoverStale — decrements attempts, not attempts_total (M7)', () => {
    it('re-queues with a fresh generation and does not touch attempts_total', async () => {
      mocks.poolQuery.mockResolvedValueOnce({ rows: [{ id: 'j1' }], rowCount: 1 });
      await repo.recoverStale(new Date('2026-07-28T00:00:00Z'), 8);
      const text = poolText();
      expect(text).toContain('GREATEST(attempts - 1, 0)');
      expect(text).not.toContain('attempts_total = attempts_total');
      expect(text).toContain('claim_generation = claim_generation + 1');
      expect(text).toContain("'SYSTEM_REBOOTED'");
      expect(text).toContain('FOR UPDATE SKIP LOCKED');
      expect(text).toContain("recovered.status = 'failed'");
      expect(text).toContain("ELSE 'pending'");
      expect(text).toContain("analysis_status IS DISTINCT FROM 'deleted'");
    });
  });

  describe('gracefulRequeue — generation-matched, decrements attempts, fences old runner', () => {
    it('no-ops on an empty claim list', async () => {
      const n = await repo.gracefulRequeue([]);
      expect(n).toBe(0);
      expect(mocks.poolQuery).not.toHaveBeenCalled();
    });

    it('matches id + generation via unnest and decrements attempts', async () => {
      mocks.poolQuery.mockResolvedValueOnce({ rowCount: 2 });
      const n = await repo.gracefulRequeue([
        { id: 'j1', generation: 1 },
        { id: 'j2', generation: 3 },
      ]);
      const text = poolText();
      expect(text).toContain('unnest($1::uuid[], $2::int[])');
      expect(text).toContain('j.claim_generation = claim.generation');
      expect(text).toContain('GREATEST(j.attempts - 1, 0)');
      expect(text).toContain('claim_generation = j.claim_generation + 1');
      expect(text).toContain("SET analysis_status = 'pending'");
      expect(text).toContain("analysis_status IS DISTINCT FROM 'deleted'");
      expect(poolValues()).toEqual([['j1', 'j2'], [1, 3]]);
      expect(n).toBe(2);
    });
  });

  describe('requeueForManualRetry — only failed/expired, keeps attempts_total (M5)', () => {
    it('guards status and the lifetime ceiling; never resets attempts_total', async () => {
      mocks.poolQuery.mockResolvedValueOnce({ rows: [{ id: 'j1', status: 'queued' }], rowCount: 1 });
      const row = await repo.requeueForManualRetry('wc-1', {
        extraAttempts: 3,
        attemptsTotalCeiling: 8,
        settleSeconds: 15,
      });
      const text = poolText();
      expect(text).toContain("status IN ('failed','expired')");
      expect(text).toContain('attempts_total < $3');
      expect(text).not.toContain('attempts_total = 0');
      expect(text).toContain("SET analysis_status = 'pending'");
      expect(text).toContain("analysis_status IS DISTINCT FROM 'deleted'");
      expect(poolValues()).toEqual(['wc-1', 3, 8, 15]);
      expect(row).toEqual({ id: 'j1', status: 'queued' });
    });

    it('returns null when not retry-eligible or at the lifetime ceiling', async () => {
      mocks.poolQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
      expect(await repo.requeueForManualRetry('wc-1', {
        extraAttempts: 3, attemptsTotalCeiling: 8, settleSeconds: 15,
      })).toBeNull();
    });
  });
});
