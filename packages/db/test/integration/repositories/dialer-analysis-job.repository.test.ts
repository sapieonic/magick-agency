import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { insertWebrtcCall } from '../setup/factories.js';

/*
 * Real Postgres. Rows live in `agency_calls`; ids come from the UUID factories.
 * There is no settlement: the persist/complete case asserts `analysis_audio_seconds`
 * is RECORDED and that the job table has no settlement column; the final case
 * covers queue depth and that a completed job is not reclaimed. Also covered end
 * to end: every mirrored `analysis_status` transition, `recoverStale` failing at
 * the lifetime ceiling, `gracefulRequeue`, `requeueRateLimited`, `list`,
 * `msUntilNextRunnable` (the worker's next-due timer) and `analysisDelayFor` (why a
 * pending summary is held up: the vendor's newest answer a refusal, AD1; the outage, the
 * drain, a later refusal, a requeue of an old refusal, and the columns' writers).
 */
vi.mock('../../../src/connection.js', () => ({ getPool: () => getTestPool() }));
const { dialerAnalysisJobRepository: repo } = await import('../../../src/repositories/dialer-analysis-job.repository.js');

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

  /** Claim exactly this queued job: every other queued job is put an hour out first. */
  async function claimJob(id: string) {
    await getTestPool().query(`UPDATE dialer_analysis_jobs SET next_attempt_at = now() + interval '1 hour' WHERE status = 'queued' AND id <> $1`, [id]);
    await getTestPool().query(`UPDATE dialer_analysis_jobs SET next_attempt_at = now() - interval '1 minute' WHERE id = $1`, [id]);
    const [claimed] = await repo.claimRunnable(1);
    expect(claimed!.id).toBe(id);
    return claimed!;
  }
  async function refuse(id: string) {
    const claimed = await claimJob(id);
    expect(await repo.requeueRateLimited(id, claimed.claim_generation, 60, 'rate-limited (transcribe, gemini): credits depleted')).toBe(true);
  }
  async function complete(job: { id: string; call_id: string }) {
    const claimed = await claimJob(job.id);
    expect(await repo.completeWithAnalysis(job.id, job.call_id, claimed.claim_generation, { call_analysis: ANALYSIS as never, analysis_audio_seconds: 10 })).toBe(true);
  }
  const delay = (call: { id: string }) => repo.analysisDelayFor(call.id);

  it('analysisDelayFor: delayed while the vendor\'s newest answer is a refusal, cleared by a later completion though refused jobs stay queued, on again at a later refusal', async () => {
    expect(await delay({ id: '99999999-9999-4999-8999-999999999999' })).toBeNull();
    const [a, b, c, d] = [await callWithRecording(), await callWithRecording(), await callWithRecording(), await callWithRecording()];
    const [aJob, bJob, , dJob] = [await enqueue(a), await enqueue(b), await enqueue(c), await enqueue(d)];
    // An ordinary queue, no completion yet: nothing held up.
    for (const call of [a, b, c, d]) expect(await delay(call)).toBeNull();

    // (a) The outage: A's run is refused through the runner's own write. C has never been tried
    // and the breaker holds it all the same; so is another tenant's call (the vendor is the server's).
    await refuse(aJob!.id);
    expect(await callStatus(a.id)).toBe('pending');
    expect(await delay(a)).toBe('vendor_unavailable');
    expect(await delay(c)).toBe('vendor_unavailable');
    const other = await callWithRecording({
      tenant_id: '88888888-8888-4888-8888-888888888888', account_id: '77777777-7777-4777-8777-777777777777',
    });
    await enqueue(other);
    expect(await delay(other)).toBe('vendor_unavailable');
    // A running job is not waiting.
    const bClaim = await claimJob(bJob!.id);
    expect(await delay(b)).toBeNull();

    // (b) The drain: B's summary is written after A's refusal. A is still queued with its refusal
    // (claimed last, with the longest backoff), and no queued job reads delayed any more.
    expect(await repo.completeWithAnalysis(bJob!.id, b.id, bClaim.claim_generation, { call_analysis: ANALYSIS as never, analysis_audio_seconds: 10 })).toBe(true);
    expect(await repo.findById(aJob!.id)).toMatchObject({ status: 'queued', error_code: 'RATE_LIMITED' });
    for (const call of [a, c, d, other]) expect(await delay(call)).toBeNull();

    // (c) The vendor refuses again after that completion (D's run): every queued job is held again.
    await refuse(dJob!.id);
    for (const call of [a, c, d, other]) expect(await delay(call)).toBe('vendor_unavailable');
    expect(await delay(b)).toBeNull();

    // A queued job requeued for an ordinary failure is no refusal: with D's code changed, the
    // newest refusal of a queued job is A's, older than B's completion.
    await getTestPool().query(`UPDATE dialer_analysis_jobs SET error_code = 'TRANSCRIPTION_FAILED' WHERE id = $1`, [dJob!.id]);
    expect(await delay(c)).toBeNull();
  });

  it('analysisDelayFor: a graceful requeue or a stale recovery of a refused job keeps its refusal as old as it was', async () => {
    const [a, b, c] = [await callWithRecording(), await callWithRecording(), await callWithRecording()];
    const aJob = await enqueue(a);
    const bJob = await enqueue(b);
    await enqueue(c);
    await refuse(aJob.id);
    const refusedAt = (await repo.findById(aJob.id))!.vendor_refused_at;
    expect(refusedAt).toBeInstanceOf(Date);
    await complete(bJob);
    expect(await delay(c)).toBeNull();

    // A deploy mid-run of the refused job: the graceful requeue puts it back with its old code.
    const claimed = await claimJob(aJob.id);
    expect(await repo.gracefulRequeue([{ id: aJob.id, generation: claimed.claim_generation }])).toBe(1);
    expect(await repo.findById(aJob.id)).toMatchObject({ status: 'queued', error_code: 'RATE_LIMITED', vendor_refused_at: refusedAt });
    expect(await delay(a)).toBeNull();
    expect(await delay(c)).toBeNull();

    // A crash mid-run: stale recovery puts it back the same way.
    await claimJob(aJob.id);
    await getTestPool().query(`UPDATE dialer_analysis_jobs SET heartbeat_at = now() - interval '1 hour' WHERE id = $1`, [aJob.id]);
    const [recovered] = await repo.recoverStale(new Date(Date.now() - 60_000), 8);
    expect(recovered).toMatchObject({ id: aJob.id, status: 'queued', error_code: 'RATE_LIMITED', vendor_refused_at: refusedAt });
    expect(await delay(a)).toBeNull();
    expect(await delay(c)).toBeNull();

    // Its next run is refused: that refusal is new.
    await refuse(aJob.id);
    expect(await delay(c)).toBe('vendor_unavailable');
  });

  it('only requeueRateLimited stamps vendor_refused_at; completion and manual retry clear it, and completion stamps completed_at', async () => {
    const [a, b, c] = [await callWithRecording(), await callWithRecording(), await callWithRecording()];
    const [aJob, bJob, cJob] = [await enqueue(a), await enqueue(b), await enqueue(c)];
    expect(await repo.findById(aJob!.id)).toMatchObject({ vendor_refused_at: null, completed_at: null });

    await refuse(aJob!.id);
    expect((await repo.findById(aJob!.id))!.vendor_refused_at).toBeInstanceOf(Date);
    await complete(aJob!);
    const done = (await repo.findById(aJob!.id))!;
    expect(done).toMatchObject({ status: 'completed', vendor_refused_at: null, error_code: null });
    expect(done.completed_at).toBeInstanceOf(Date);

    // An ordinary retryable failure writes no refusal.
    const cClaim = await claimJob(cJob!.id);
    expect(await repo.requeueForRetry(cJob!.id, cClaim.claim_generation, 30, 'TRANSCRIPTION_FAILED', 'boom')).toBe(true);
    expect(await repo.findById(cJob!.id)).toMatchObject({ status: 'queued', vendor_refused_at: null, completed_at: null });

    // A refused job that then fails keeps the refusal until a person retries it.
    await refuse(bJob!.id);
    const bClaim = await claimJob(bJob!.id);
    expect(await repo.markFailed(bJob!.id, b.id, bClaim.claim_generation, 'BAD_AUDIO', 'bad')).toBe(true);
    expect((await repo.findById(bJob!.id))!.vendor_refused_at).toBeInstanceOf(Date);
    expect(await repo.requeueForManualRetry(b.id, { extraAttempts: 3, attemptsTotalCeiling: 8, settleSeconds: 0 })).toMatchObject({
      status: 'queued', vendor_refused_at: null, error_code: null, completed_at: null,
    });
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
});
