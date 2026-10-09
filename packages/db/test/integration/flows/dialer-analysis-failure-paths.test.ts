import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { insertWebrtcCall } from '../setup/factories.js';
/*
 * Real Postgres. Rows live in `agency_calls`; ids come from the UUID factories.
 * There is no settlement, so no `settlement_status` / `claimPendingSettlements` assertions.
 */
vi.mock('../../../src/connection.js', () => ({ getPool: () => getTestPool() }));
const { dialerAnalysisJobRepository: jobs } = await import('../../../src/repositories/dialer-analysis-job.repository.js');

async function claimed() {
  const call = await insertWebrtcCall({ recording_url: 'https://rec.example/a.wav' });
  const job = (await jobs.enqueueFromCall({ call_id: call.id }))!;
  const [claim] = await jobs.claimRunnable(1);
  return { call, job, claim: claim! };
}

describe('dialer analysis failure scenarios', () => {
  beforeEach(truncateAll); afterAll(closeTestPool);
  it('requeues retryable work, fails terminal work on call row, and rate limiting refunds attempts', async () => {
    const retry = await claimed();
    expect(await jobs.requeueForRetry(retry.job.id, retry.claim.claim_generation, 0, 'TRANSCRIPTION_FAILED', 'retry')).toBe(true);
    expect((await jobs.findById(retry.job.id))!.status).toBe('queued');
    const [retryClaim] = await jobs.claimRunnable(1);
    expect(await jobs.markFailed(retry.job.id, retry.call.id, retryClaim!.claim_generation, 'UNAUTHORIZED', '401')).toBe(true);
    expect((await getTestPool().query(`SELECT analysis_status FROM agency_calls WHERE id = $1`, [retry.call.id])).rows[0]!.analysis_status).toBe('failed');

    const rate = await claimed();
    expect(await jobs.requeueRateLimited(rate.job.id, rate.claim.claim_generation, 0)).toBe(true);
    expect(await jobs.findById(rate.job.id)).toMatchObject({ attempts: 0, attempts_total: 0, status: 'queued' });
  });

  it('marks an empty transcript skipped and expires no-recording jobs onto the call row', async () => {
    const empty = await claimed();
    expect(await jobs.markSkipped(empty.job.id, empty.call.id, empty.claim.claim_generation, 'TRANSCRIPTION_EMPTY', 'silent')).toBe(true);
    expect(await jobs.findById(empty.job.id)).toMatchObject({ status: 'skipped' });
    expect(await jobs.claimRunnable(10)).toEqual([]);

    const erased = await claimed();
    await getTestPool().query(`UPDATE agency_calls SET analysis_status = 'deleted' WHERE id = $1`, [erased.call.id]);
    expect(await jobs.markSkipped(erased.job.id, erased.call.id, erased.claim.claim_generation, 'TRANSCRIPTION_EMPTY', 'silent')).toBe(true);
    expect((await getTestPool().query(`SELECT analysis_status FROM agency_calls WHERE id = $1`, [erased.call.id])).rows[0]!.analysis_status).toBe('deleted');

    const noRecording = await insertWebrtcCall({ recording_url: null });
    const waiting = (await jobs.enqueueFromCall({ call_id: noRecording.id }))!;
    await getTestPool().query(`UPDATE dialer_analysis_jobs SET created_at = now() - interval '1 hour' WHERE id = $1`, [waiting.id]);
    const [expired] = await jobs.expireAwaitingRecording(new Date());
    expect(expired).toMatchObject({ status: 'expired' });
    expect((await getTestPool().query(`SELECT analysis_status FROM agency_calls WHERE id = $1`, [noRecording.id])).rows[0]!.analysis_status).toBe('expired');
  });
});
