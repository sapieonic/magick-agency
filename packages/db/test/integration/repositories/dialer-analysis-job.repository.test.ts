import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { OTHER_TENANT, insertWebrtcCall } from '../setup/factories.js';

/*
 * Real Postgres. Rows live in `agency_calls`; ids come from the UUID factories.
 * There is no settlement: the persist/complete case asserts `analysis_audio_seconds`
 * is RECORDED and that the job table has no settlement column; the final case
 * covers queue depth and that a completed job is not reclaimed. Also covered end
 * to end: every mirrored `analysis_status` transition, `recoverStale` failing at
 * the lifetime ceiling, `gracefulRequeue`, `requeueRateLimited`, `list` and
 * `msUntilNextRunnable` (the worker's next-due timer), and `findRecordingHostRefusals`, the
 * operator re-queue's selector: only failed jobs a recording-host refusal ended, by window,
 * tenant and host, then re-queued with `requeueForManualRetry`.
 */
vi.mock('../../../src/connection.js', () => ({ getPool: () => getTestPool() }));
const { dialerAnalysisJobRepository: repo, RECORDING_HOST_REFUSAL_MESSAGE } = await import('../../../src/repositories/dialer-analysis-job.repository.js');

async function callWithRecording(overrides: Record<string, unknown> = {}) {
  return insertWebrtcCall({ recording_requested: true, recording_url: 'https://recording.example/call.wav', ...overrides });
}
async function enqueue(call: { id: string }) {
  return (await repo.enqueueFromCall({ call_id: call.id, profile_snapshot: { custom_dimensions: [] } }))!;
}
async function callStatus(id: string) {
  return (await getTestPool().query(`SELECT analysis_status FROM agency_calls WHERE id = $1`, [id])).rows[0]!.analysis_status as string | null;
}
const ANALYSIS = { common: { overall_sentiment: { label: 'positive', score: 1 }, turn_sentiments: [], key_topics: [], conversation_quality: { coherence: 1, resolution_achieved: true, effectiveness_score: 1 }, summary: 'secret' }, custom: {}, _meta: { model: 'm', provider: 'openai', latency_ms: 1, prompt_tokens: 1, completion_tokens: 1, analyzed_at: new Date().toISOString() } } as const;
const TRANSCRIPT = { conversation_log: [{ role: 'agent' as const, content: 'hello' }], transcript_meta: {
  provider: 'gemini' as const, model: 'gemini', detected_language: 'en', duration_seconds: 80, turn_count: 1, latency_ms: 5, transcribed_at: new Date().toISOString(),
} };

describe('dialerAnalysisJobRepository (integration)', () => {
  beforeEach(truncateAll);
  afterAll(closeTestPool);

  it('enqueues from the DB recording state idempotently and mirrors pending without clobbering deleted', async () => {
    const call = await callWithRecording();
    const first = await enqueue(call);
    const second = await enqueue(call);
    expect(first.status).toBe('queued');
    expect(second.id).toBe(first.id);
    expect(await callStatus(call.id)).toBe('pending');

    await getTestPool().query(`UPDATE agency_calls SET analysis_status = 'deleted' WHERE id = $1`, [call.id]);
    await getTestPool().query(`DELETE FROM dialer_analysis_jobs WHERE id = $1`, [first.id]);
    await enqueue(call);
    expect(await callStatus(call.id)).toBe('deleted');
  });

  it('guards recording readiness, applies settle delay, and promotion rescues delivered recordings before expiry', async () => {
    const call = await insertWebrtcCall({ recording_requested: true, recording_url: null });
    const job = await enqueue(call);
    expect(job.status).toBe('awaiting_recording');
    expect(await callStatus(call.id)).toBe('awaiting_recording');
    const ready = await repo.markRecordingReady(call.id, 15);
    expect(ready!.status).toBe('queued');
    expect(ready!.next_attempt_at!.getTime()).toBeGreaterThan(Date.now() + 5_000);
    expect(await callStatus(call.id)).toBe('pending');
    expect(await repo.markRecordingReady(call.id, 15)).toBeNull();

    const strandedCall = await insertWebrtcCall({ recording_requested: true, recording_url: 'https://recording.example/late.wav' });
    const stranded = await enqueue(strandedCall);
    await getTestPool().query(`UPDATE dialer_analysis_jobs SET status = 'awaiting_recording', created_at = now() - interval '2 hours' WHERE id = $1`, [stranded.id]);
    expect(await repo.promoteRecordingReady()).toBe(1);
    expect((await repo.findById(stranded.id))!.status).toBe('queued');
    expect(await callStatus(strandedCall.id)).toBe('pending');
    expect(await repo.expireAwaitingRecording(new Date())).toEqual([]);
  });

  it('a link the call did not ask for is no recording: never queued, never promoted, expired (RC1)', async () => {
    const legacy = await insertWebrtcCall({ recording_requested: false, recording_url: 'https://recording.example/unasked.wav' });
    const job = await enqueue(legacy);
    expect(job.status).toBe('awaiting_recording');
    await getTestPool().query(`UPDATE dialer_analysis_jobs SET created_at = now() - interval '2 hours' WHERE id = $1`, [job.id]);
    expect(await repo.promoteRecordingReady()).toBe(0);
    const expired = await repo.expireAwaitingRecording(new Date(Date.now() - 30 * 60_000));
    expect(expired.map((j) => j.id)).toEqual([job.id]);
  });

  it('expires only awaiting jobs whose call still has no recording, mirroring expired (never onto deleted)', async () => {
    const waiting = await insertWebrtcCall({ recording_requested: true, recording_url: null });
    const erased = await insertWebrtcCall({ recording_requested: true, recording_url: null });
    const wJob = await enqueue(waiting);
    const eJob = await enqueue(erased);
    await getTestPool().query(`UPDATE dialer_analysis_jobs SET created_at = now() - interval '2 hours'`);
    await getTestPool().query(`UPDATE agency_calls SET analysis_status = 'deleted' WHERE id = $1`, [erased.id]);
    const expired = await repo.expireAwaitingRecording(new Date(Date.now() - 30 * 60_000));
    expect(expired.map((j) => j.id).sort()).toEqual([wJob.id, eJob.id].sort());
    expect(expired[0]).toMatchObject({ status: 'expired', error_code: 'RECORDING_NEVER_ARRIVED' });
    expect(await callStatus(waiting.id)).toBe('expired');
    expect(await callStatus(erased.id)).toBe('deleted');
  });

  it('claims runnable work once across concurrent workers and fences stale writes', async () => {
    const calls = await Promise.all([callWithRecording(), callWithRecording()]);
    await Promise.all(calls.map(enqueue));
    const [left, right] = await Promise.all([repo.claimRunnable(2), repo.claimRunnable(2)]);
    const ids = [...left, ...right].map((job) => job.id);
    expect(new Set(ids).size).toBe(2);
    const claimed = (left[0] ?? right[0])!;
    expect(claimed).toMatchObject({ status: 'transcribing', attempts: 1, attempts_total: 1, claim_generation: 1 });
    expect(await repo.heartbeat(claimed.id, 0)).toBe(false);
    expect(await repo.markAnalyzing(claimed.id, 0)).toBe(false);
    expect(await repo.markAnalyzing(claimed.id, 1)).toBe(true);
  });

  it('persists transcript and analysis atomically, RECORDS analysis_audio_seconds, and respects the DSAR guard', async () => {
    const call = await callWithRecording({ recording_duration_seconds: 100 });
    const job = await enqueue(call);
    const [claimed] = await repo.claimRunnable(1);
    expect(await repo.persistTranscript(job.id, call.id, claimed!.claim_generation, TRANSCRIPT)).toBe(true);
    expect(await repo.markAnalyzing(job.id, claimed!.claim_generation)).toBe(true);
    expect(await repo.completeWithAnalysis(job.id, call.id, claimed!.claim_generation, { call_analysis: ANALYSIS as never, analysis_audio_seconds: 80 })).toBe(true);
    const complete = await repo.findById(job.id);
    // analysis_audio_seconds is recorded (kept for metering).
    expect(complete).toMatchObject({ status: 'completed', analysis_audio_seconds: 80, error_code: null });
    expect(complete).not.toHaveProperty('settlement_status');
    const row = (await getTestPool().query(`SELECT analysis_status, conversation_log, call_analysis FROM agency_calls WHERE id = $1`, [call.id])).rows[0]!;
    expect(row.analysis_status).toBe('completed');
    expect(row.conversation_log).toEqual(TRANSCRIPT.conversation_log);
    expect(row.call_analysis.common.summary).toBe('secret');

    // DSAR: an erased call keeps no blobs even though the job completes.
    const erased = await callWithRecording({ analysis_status: 'deleted' });
    const erasedJob = await enqueue(erased);
    const [erasedClaim] = await repo.claimRunnable(1);
    expect(await repo.persistTranscript(erasedJob.id, erased.id, erasedClaim!.claim_generation, TRANSCRIPT)).toBe(true);
    expect(await repo.markAnalyzing(erasedJob.id, erasedClaim!.claim_generation)).toBe(true);
    expect(await repo.completeWithAnalysis(erasedJob.id, erased.id, erasedClaim!.claim_generation, { call_analysis: ANALYSIS as never, analysis_audio_seconds: 80 })).toBe(true);
    const erasedRow = await getTestPool().query(`SELECT analysis_status, conversation_log, call_analysis FROM agency_calls WHERE id = $1`, [erased.id]);
    expect(erasedRow.rows[0]).toMatchObject({ analysis_status: 'deleted', conversation_log: null, call_analysis: null });
    expect(await repo.findById(erasedJob.id)).toMatchObject({ status: 'completed', analysis_audio_seconds: 80 });
  });

  it('a stale generation cannot persist, complete, fail or skip (claim_generation fencing)', async () => {
    const call = await callWithRecording();
    const job = await enqueue(call);
    const [claimed] = await repo.claimRunnable(1);
    const stale = claimed!.claim_generation - 1;
    expect(await repo.persistTranscript(job.id, call.id, stale, TRANSCRIPT)).toBe(false);
    expect(await repo.completeWithAnalysis(job.id, call.id, stale, { call_analysis: ANALYSIS as never, analysis_audio_seconds: 1 })).toBe(false);
    expect(await repo.markFailed(job.id, call.id, stale, 'X', 'x')).toBe(false);
    expect(await repo.markSkipped(job.id, call.id, stale, 'X', 'x')).toBe(false);
    expect(await repo.requeueForRetry(job.id, stale, 30, 'X', 'x')).toBe(false);
    const after = (await getTestPool().query(`SELECT conversation_log, analysis_status FROM agency_calls WHERE id = $1`, [call.id])).rows[0]!;
    expect(after.conversation_log).toBeNull();
    expect(await callStatus(call.id)).toBe('pending');
    expect((await repo.findById(job.id))!.status).toBe('transcribing');
    // The live generation still can.
    expect(await repo.markSkipped(job.id, call.id, claimed!.claim_generation, 'NO_RECORDING', 'n')).toBe(true);
    expect(await callStatus(call.id)).toBe('skipped');
  });

  it('mirrors failed/expired states, recovery preserves attempts_total, and manual retry respects ceiling', async () => {
    const call = await callWithRecording();
    const job = await enqueue(call);
    const [claimed] = await repo.claimRunnable(1);
    expect(await repo.markFailed(job.id, call.id, claimed!.claim_generation, 'BAD_AUDIO', 'bad')).toBe(true);
    expect(await callStatus(call.id)).toBe('failed');
    await getTestPool().query(`UPDATE dialer_analysis_jobs SET attempts = 2, attempts_total = 3, status = 'transcribing', heartbeat_at = now() - interval '1 hour' WHERE id = $1`, [job.id]);
    const [recovered] = await repo.recoverStale(new Date(), 8);
    expect(recovered).toMatchObject({ status: 'queued', attempts: 1, attempts_total: 3 });
    expect(await callStatus(call.id)).toBe('pending');
    await getTestPool().query(`UPDATE dialer_analysis_jobs SET status = 'failed' WHERE id = $1`, [job.id]);
    expect(await repo.requeueForManualRetry(call.id, { extraAttempts: 3, attemptsTotalCeiling: 8, settleSeconds: 0 })).not.toBeNull();
    expect(await callStatus(call.id)).toBe('pending');
    await getTestPool().query(`UPDATE dialer_analysis_jobs SET status = 'failed', attempts_total = 8 WHERE id = $1`, [job.id]);
    expect(await repo.requeueForManualRetry(call.id, { extraAttempts: 3, attemptsTotalCeiling: 8, settleSeconds: 0 })).toBeNull();
  });

  it('recovery fails a job SYSTEM_REBOOTED at the lifetime ceiling, graceful requeue is generation-matched, rate-limit refunds the attempt', async () => {
    const a = await callWithRecording();
    const aJob = await enqueue(a);
    await repo.claimRunnable(1);
    await getTestPool().query(`UPDATE dialer_analysis_jobs SET attempts_total = 8, heartbeat_at = now() - interval '1 hour' WHERE id = $1`, [aJob.id]);
    const [dead] = await repo.recoverStale(new Date(), 8);
    expect(dead).toMatchObject({ status: 'failed', error_code: 'SYSTEM_REBOOTED' });
    expect(await callStatus(a.id)).toBe('failed');

    const b = await callWithRecording();
    const bJob = await enqueue(b);
    const [bClaim] = await repo.claimRunnable(1);
    expect(await repo.gracefulRequeue([{ id: bJob.id, generation: bClaim!.claim_generation + 5 }])).toBe(0);
    expect(await repo.gracefulRequeue([{ id: bJob.id, generation: bClaim!.claim_generation }])).toBe(1);
    expect(await repo.findById(bJob.id)).toMatchObject({ status: 'queued', attempts: 0, claim_generation: bClaim!.claim_generation + 1 });

    const [again] = await repo.claimRunnable(1);
    // The row keeps why the vendor refused, trimmed to 2000 characters like every error.
    const reason = `rate-limited (transcribe, gemini): You exceeded your current quota ${'x'.repeat(3000)}`;
    expect(await repo.requeueRateLimited(bJob.id, again!.claim_generation, 60, reason)).toBe(true);
    expect(await repo.findById(bJob.id)).toMatchObject({
      status: 'queued', attempts: 0, error_code: 'RATE_LIMITED', error_message: reason.slice(0, 2000),
    });
    expect(await callStatus(b.id)).toBe('pending');
  });

  it('exposes queue depth, lookups and the support listing', async () => {
    const call = await callWithRecording();
    const job = await enqueue(call);
    const [claimed] = await repo.claimRunnable(1);
    await repo.markAnalyzing(job.id, claimed!.claim_generation);
    await repo.completeWithAnalysis(job.id, call.id, claimed!.claim_generation, { call_analysis: ANALYSIS as never, analysis_audio_seconds: 10 });
    expect(await repo.queueDepthByStatus()).toEqual(expect.arrayContaining([expect.objectContaining({ status: 'completed', count: 1 })]));
    // A completed job is never claimable again.
    expect(await repo.claimRunnable(5)).toEqual([]);
    expect((await repo.findByCallId(call.id))!.id).toBe(job.id);
    expect((await repo.list({ tenant_id: call.tenant_id, status: 'completed' })).map((j) => j.id)).toEqual([job.id]);
    expect(await repo.list({ tenant_id: '99999999-9999-4999-8999-999999999999' })).toEqual([]);
  });

  it('msUntilNextRunnable: null with nothing queued, 0 when one is due, else the wait to the earliest queued job', async () => {
    expect(await repo.msUntilNextRunnable()).toBeNull();

    // Only a far-future and an in-flight job: the in-flight one does not count.
    const later = await enqueue(await callWithRecording());
    await getTestPool().query(`UPDATE dialer_analysis_jobs SET next_attempt_at = now() + interval '90 seconds' WHERE id = $1`, [later.id]);
    const running = await enqueue(await callWithRecording());
    await getTestPool().query(`UPDATE dialer_analysis_jobs SET status = 'transcribing' WHERE id = $1`, [running.id]);
    const far = (await repo.msUntilNextRunnable())!;
    expect(far).toBeGreaterThan(85_000);
    expect(far).toBeLessThanOrEqual(90_000);

    // A sooner one (a settle delay) wins.
    const soon = await enqueue(await callWithRecording());
    await getTestPool().query(`UPDATE dialer_analysis_jobs SET next_attempt_at = now() + interval '15 seconds' WHERE id = $1`, [soon.id]);
    const near = (await repo.msUntilNextRunnable())!;
    expect(near).toBeGreaterThan(10_000);
    expect(near).toBeLessThanOrEqual(15_000);

    // An overdue one, or one with no next_attempt_at at all, is due now.
    await getTestPool().query(`UPDATE dialer_analysis_jobs SET next_attempt_at = now() - interval '1 minute' WHERE id = $1`, [soon.id]);
    expect(await repo.msUntilNextRunnable()).toBe(0);
    await getTestPool().query(`UPDATE dialer_analysis_jobs SET next_attempt_at = NULL WHERE id = $1`, [soon.id]);
    expect(await repo.msUntilNextRunnable()).toBe(0);
  });

  describe('findRecordingHostRefusals (the operator re-queue after an allow-list fix)', () => {
    // What the analysis runner stores for a refused host: `RecordingHostRefusedError`'s
    // message unchanged (pinned against the server's class in the server's unit tests).
    const APS1_HOP0 = 'Recording host "aps1.media.plivo.com" is not on the recording-host allow-list';
    const APS1_HOP1 = 'Recording host "aps1.media.plivo.com" is not on the recording-host allow-list (redirect hop 1)';
    const OTHER_HOST = 'Recording host "evil.example" is not on the recording-host allow-list';

    /** A call whose analysis job ended as given (the call row mirrors `failed`, as markFailed does). */
    async function ended(errorCode: string, errorMessage: string, over: { tenant_id?: string; status?: string; callStatus?: string } = {}) {
      const call = await callWithRecording({ provider: 'plivo', ...(over.tenant_id ? { tenant_id: over.tenant_id } : {}) });
      const job = await enqueue(call);
      await getTestPool().query(
        `UPDATE dialer_analysis_jobs SET status = $2, error_code = $3, error_message = $4, attempts = 1, attempts_total = 1 WHERE id = $1`,
        [job.id, over.status ?? 'failed', errorCode, errorMessage],
      );
      await getTestPool().query(`UPDATE agency_calls SET analysis_status = $2 WHERE id = $1`, [call.id, over.callStatus ?? 'failed']);
      return { call, job };
    }
    const ids = (rows: Array<{ id: string }>) => rows.map((r) => r.id).sort();
    const dbNow = async () => (await getTestPool().query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0]!.now;

    it('matches only a failed TRANSCRIPTION_FAILED job whose message is a host refusal, on a call not erased', async () => {
      const hop0 = await ended('TRANSCRIPTION_FAILED', APS1_HOP0);
      const hop1 = await ended('TRANSCRIPTION_FAILED', APS1_HOP1);
      // Every other ending is left alone: none of them is cured by an allow-list fix.
      await ended('TRANSCRIPTION_FAILED', 'Recording fetch failed with status 404');
      await ended('TRANSCRIPTION_FAILED', 'Recording fetch followed more than 3 redirects');
      await ended('TRANSCRIPTION_FAILED', 'Recording host (unparseable or non-https URL) is not on the recording-host allow-list');
      await ended('TRANSCRIPTION_FAILED', 'Recording access refused for provider "plivo": credential_unavailable (status)');
      await ended('TRANSCRIPTION_FAILED', `Failed to fetch recording: ${APS1_HOP0}`);
      await ended('TRANSCRIPTION_FAILED', `${APS1_HOP0}; and more`);
      await ended('TIMEOUT', APS1_HOP0);
      await ended('TRANSCRIPTION_FAILED', APS1_HOP0, { status: 'queued', callStatus: 'pending' });
      await ended('TRANSCRIPTION_FAILED', APS1_HOP0, { status: 'completed', callStatus: 'completed' });
      await ended('TRANSCRIPTION_FAILED', APS1_HOP0, { callStatus: 'deleted' });

      expect(ids(await repo.findRecordingHostRefusals())).toEqual([hop0.job.id, hop1.job.id].sort());
      expect(new RegExp(RECORDING_HOST_REFUSAL_MESSAGE).test(APS1_HOP1)).toBe(true);
    });

    it('narrows by refused host, tenant, failure window and limit, oldest failure first', async () => {
      const first = await ended('TRANSCRIPTION_FAILED', APS1_HOP0);
      const between = await dbNow();
      const other = await ended('TRANSCRIPTION_FAILED', OTHER_HOST);
      const otherTenant = await ended('TRANSCRIPTION_FAILED', APS1_HOP1, { tenant_id: OTHER_TENANT });

      expect(ids(await repo.findRecordingHostRefusals({ host: 'aps1.media.plivo.com' })))
        .toEqual([first.job.id, otherTenant.job.id].sort());
      expect(ids(await repo.findRecordingHostRefusals({ host: 'media.plivo.com' }))).toEqual([]);
      expect(ids(await repo.findRecordingHostRefusals({ tenantId: OTHER_TENANT }))).toEqual([otherTenant.job.id]);
      expect(ids(await repo.findRecordingHostRefusals({ failedBefore: between }))).toEqual([first.job.id]);
      expect(ids(await repo.findRecordingHostRefusals({ failedSince: between })))
        .toEqual([other.job.id, otherTenant.job.id].sort());
      expect((await repo.findRecordingHostRefusals({ limit: 1 })).map((r) => r.id)).toEqual([first.job.id]);
    });

    it('a matched job re-queued with requeueForManualRetry is queued, mirrored pending, and no longer matched', async () => {
      const { call, job } = await ended('TRANSCRIPTION_FAILED', APS1_HOP0);
      const requeued = await repo.requeueForManualRetry(call.id, { extraAttempts: 3, attemptsTotalCeiling: 8, settleSeconds: 0 });
      expect(requeued).toMatchObject({ id: job.id, status: 'queued', attempts: 0, attempts_total: 1, error_code: null, error_message: null });
      expect(await callStatus(call.id)).toBe('pending');
      expect(await repo.findRecordingHostRefusals()).toEqual([]);
      expect((await repo.claimRunnable(5)).map((r) => r.id)).toEqual([job.id]);
    });
  });
});
