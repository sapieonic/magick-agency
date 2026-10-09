import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { insertWebrtcCall } from '../setup/factories.js';
/*
 * Real Postgres. Rows live in `agency_calls`; ids come from the UUID factories.
 */
vi.mock('../../../src/connection.js', () => ({ getPool: () => getTestPool() }));
const { dialerAnalysisJobRepository: jobs } = await import('../../../src/repositories/dialer-analysis-job.repository.js');

describe('dialer analysis recovery scenarios', () => {
  beforeEach(truncateAll); afterAll(closeTestPool);
  it('recovers stale claims without burning attempts, fences resurrected writers, and hits total ceiling', async () => {
    const call = await insertWebrtcCall({ recording_url: 'https://rec.example/a.wav' });
    const job = (await jobs.enqueueFromCall({ call_id: call.id }))!;
    const [first] = await jobs.claimRunnable(1);
    await getTestPool().query(`UPDATE dialer_analysis_jobs SET heartbeat_at = now() - interval '1 hour' WHERE id = $1`, [job.id]);
    const [recovered] = await jobs.recoverStale(new Date(), 2);
    expect(recovered).toMatchObject({ status: 'queued', attempts: 0, attempts_total: 1, claim_generation: 2 });
    expect((await getTestPool().query(`SELECT analysis_status FROM agency_calls WHERE id = $1`, [call.id])).rows[0]!.analysis_status).toBe('pending');
    expect(await jobs.heartbeat(job.id, first!.claim_generation)).toBe(false);
    const [second] = await jobs.claimRunnable(1);
    await getTestPool().query(`UPDATE dialer_analysis_jobs SET heartbeat_at = now() - interval '1 hour' WHERE id = $1`, [job.id]);
    const [terminal] = await jobs.recoverStale(new Date(), 2);
    expect(second!.attempts_total).toBe(2);
    expect(terminal).toMatchObject({ status: 'failed', error_code: 'SYSTEM_REBOOTED' });
    expect((await getTestPool().query(`SELECT analysis_status FROM agency_calls WHERE id = $1`, [call.id])).rows[0]!.analysis_status).toBe('failed');
  });

  it('graceful requeue is generation-owned and does not requeue a different recovered runner', async () => {
    const call = await insertWebrtcCall({ recording_url: 'https://rec.example/a.wav' });
    const job = (await jobs.enqueueFromCall({ call_id: call.id }))!;
    const [claim] = await jobs.claimRunnable(1);
    expect(await jobs.gracefulRequeue([{ id: job.id, generation: claim!.claim_generation }])).toBe(1);
    expect((await jobs.findById(job.id))!.status).toBe('queued');
    expect((await getTestPool().query(`SELECT analysis_status FROM agency_calls WHERE id = $1`, [call.id])).rows[0]!.analysis_status).toBe('pending');
    expect(await jobs.heartbeat(job.id, claim!.claim_generation)).toBe(false);
    expect(await jobs.gracefulRequeue([{ id: job.id, generation: claim!.claim_generation }])).toBe(0);
  });
});
