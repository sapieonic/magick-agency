import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { initDbPool, closePool, getPool } from '@magick-agency/db';
import { dialerAnalysisJobRepository } from '@magick-agency/db/repositories/dialer-analysis-job.repository';
import { TEST_DB_URL, truncateAll } from '../../../../../packages/db/test/helpers/test-db.js';
import { insertWebrtcCall } from '../../../../../packages/db/test/integration/setup/factories.js';
import { requeueRecordingHostRefusals, type RequeueArgs } from '../../../scripts/requeue-recording-host-refusals.js';

/**
 * The operator re-queue of analysis jobs a recording-host refusal failed, on real Postgres:
 * a dry run changes nothing; `apply` re-queues exactly the matched jobs as a manual retry
 * would (queued, full attempt budget, the call mirrored `pending`) and leaves every other
 * failure alone; a job at its lifetime ceiling is reported, not re-queued. The selector's
 * own cases are in packages/db's `dialer-analysis-job.repository.test.ts`.
 */
const LIMITS = { maxAttempts: 3, maxAttemptsTotal: 8 };
const REFUSED = 'Recording host "aps1.media.plivo.com" is not on the recording-host allow-list';
const args = (over: Partial<RequeueArgs> = {}): RequeueArgs => ({ limit: 1000, apply: false, ...over });

async function failedJob(errorMessage: string, attemptsTotal = 1) {
  const call = await insertWebrtcCall({ provider: 'plivo', recording_requested: true, recording_url: 'https://aps1.media.plivo.com/r.mp3' });
  const job = (await dialerAnalysisJobRepository.enqueueFromCall({ call_id: call.id, profile_snapshot: { custom_dimensions: [] } }))!;
  await getPool().query(
    `UPDATE dialer_analysis_jobs SET status = 'failed', error_code = 'TRANSCRIPTION_FAILED', error_message = $2,
       attempts = 1, attempts_total = $3 WHERE id = $1`,
    [job.id, errorMessage, attemptsTotal],
  );
  await getPool().query(`UPDATE agency_calls SET analysis_status = 'failed' WHERE id = $1`, [call.id]);
  return { callId: call.id as string, jobId: job.id };
}
async function state(jobId: string) {
  const { rows } = await getPool().query<{ status: string; attempts: number; error_code: string | null; analysis_status: string }>(
    `SELECT j.status, j.attempts, j.error_code, c.analysis_status
     FROM dialer_analysis_jobs j JOIN agency_calls c ON c.id = j.call_id WHERE j.id = $1`,
    [jobId],
  );
  return rows[0]!;
}

describe('scripts/requeue-recording-host-refusals (integration)', () => {
  beforeAll(() => { initDbPool({ url: TEST_DB_URL, poolMin: 0, poolMax: 2 }); });
  beforeEach(async () => { await truncateAll(); });
  afterAll(async () => { await closePool(); });

  it('a dry run lists the refused jobs and changes nothing', async () => {
    const refused = await failedJob(REFUSED);
    await failedJob('Recording fetch failed with status 404');
    const result = await requeueRecordingHostRefusals(args({ host: 'aps1.media.plivo.com' }), LIMITS);
    expect(result.matched.map((j) => j.id)).toEqual([refused.jobId]);
    expect(result.requeued).toEqual([]);
    expect(await state(refused.jobId)).toMatchObject({ status: 'failed', analysis_status: 'failed' });
  });

  it('--apply re-queues the refused jobs with the full budget, mirrors pending, and leaves other failures failed', async () => {
    const a = await failedJob(REFUSED);
    const b = await failedJob(`${REFUSED} (redirect hop 1)`);
    const other = await failedJob('Recording fetch failed with status 401');
    const result = await requeueRecordingHostRefusals(args({ apply: true }), LIMITS);
    expect(result.requeued.sort()).toEqual([a.jobId, b.jobId].sort());
    expect(result.notRequeued).toEqual([]);
    for (const { jobId } of [a, b]) {
      expect(await state(jobId)).toEqual({ status: 'queued', attempts: 0, error_code: null, analysis_status: 'pending' });
    }
    expect(await state(other.jobId)).toMatchObject({ status: 'failed', error_code: 'TRANSCRIPTION_FAILED', analysis_status: 'failed' });
    // A second run finds nothing left to do.
    expect((await requeueRecordingHostRefusals(args({ apply: true }), LIMITS)).matched).toEqual([]);
  });

  it('a job at its lifetime attempt ceiling is matched but not re-queued', async () => {
    const spent = await failedJob(REFUSED, 8);
    const result = await requeueRecordingHostRefusals(args({ apply: true }), LIMITS);
    expect(result.notRequeued).toEqual([spent.jobId]);
    expect(await state(spent.jobId)).toMatchObject({ status: 'failed', analysis_status: 'failed' });
  });
});
