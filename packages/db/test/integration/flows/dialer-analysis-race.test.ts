import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { insertWebrtcCall } from '../setup/factories.js';
/*
 * PORT NOTE (magick-agency): ported from core test/integration/flows/dialer-analysis-race.test.ts@4850d1d9
 * (2 cases -> 2), real Postgres 5436. `webrtc_calls` -> `agency_calls`; ids from the UUID
 * factories. Verbatim apart from paths and the table name.
 */
vi.mock('../../../src/connection.js', () => ({ getPool: () => getTestPool() }));
const { dialerAnalysisJobRepository: jobs } = await import('../../../src/repositories/dialer-analysis-job.repository.js');

describe('dialer analysis B1 races', () => {
  beforeEach(truncateAll); afterAll(closeTestPool);
  it('webhook-before-job and duplicate webhooks yield one queued job that never expires', async () => {
    const call = await insertWebrtcCall({ recording_url: 'https://rec.example/early.wav' });
    expect(await jobs.markRecordingReady(call.id)).toBeNull(); // webhook before enqueue
    const first = (await jobs.enqueueFromCall({ call_id: call.id }))!;
    const duplicate = await jobs.markRecordingReady(call.id);
    expect(first.status).toBe('queued');
    expect(duplicate).toBeNull();
    expect((await jobs.expireAwaitingRecording(new Date())).map((j) => j.id)).not.toContain(first.id);
    expect((await jobs.findByCallId(call.id))!.id).toBe(first.id);
  });

  it('promotion sweep rescues a lost wake before expiry', async () => {
    const call = await insertWebrtcCall({ recording_url: null });
    const job = (await jobs.enqueueFromCall({ call_id: call.id }))!;
    await getTestPool().query(`UPDATE agency_calls SET recording_url = 'https://rec.example/lost-wake.wav' WHERE id = $1`, [call.id]);
    await getTestPool().query(`UPDATE dialer_analysis_jobs SET created_at = now() - interval '2 hours' WHERE id = $1`, [job.id]);
    expect(await jobs.promoteRecordingReady()).toBe(1);
    expect((await jobs.findById(job.id))!.status).toBe('queued');
    expect(await jobs.expireAwaitingRecording(new Date())).toEqual([]);
  });
});
