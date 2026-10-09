import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { insertWebrtcCall } from '../setup/factories.js';
/*
 * PORT NOTE (magick-agency): ported from core test/integration/flows/dialer-analysis-dsar.test.ts@4850d1d9
 * (1 case -> 1), real Postgres 5436. `webrtc_calls` -> `agency_calls`; ids from the UUID
 * factories. The job still completes (it no longer "settles").
 */
vi.mock('../../../src/connection.js', () => ({ getPool: () => getTestPool() }));
const { dialerAnalysisJobRepository: jobs } = await import('../../../src/repositories/dialer-analysis-job.repository.js');

describe('dialer analysis DSAR scenario', () => {
  beforeEach(truncateAll); afterAll(closeTestPool);
  it('does not resurrect transcript or analysis when a job completes after erasure, but still completes', async () => {
    const call = await insertWebrtcCall({ recording_url: 'https://rec.example/a.wav', conversation_log: JSON.stringify([{ content: 'sensitive' }]), call_analysis: JSON.stringify({ secret: 'summary' }), analysis_status: 'pending' });
    const job = (await jobs.enqueueFromCall({ call_id: call.id }))!;
    const [claim] = await jobs.claimRunnable(1);
    await getTestPool().query(`UPDATE agency_calls SET conversation_log = NULL, call_analysis = NULL, transcript_meta = NULL, analysis_status = 'deleted' WHERE id = $1`, [call.id]);
    const transcript = { conversation_log: [{ role: 'agent' as const, content: 'must not return' }], transcript_meta: { provider: 'gemini' as const, model: 'm', detected_language: 'en', duration_seconds: 3, turn_count: 1, latency_ms: 1, transcribed_at: new Date().toISOString() } };
    await jobs.persistTranscript(job.id, call.id, claim!.claim_generation, transcript);
    await jobs.markAnalyzing(job.id, claim!.claim_generation);
    const analysis = { common: { overall_sentiment: { label: 'positive', score: 1 }, turn_sentiments: [], key_topics: [], conversation_quality: { coherence: 1, resolution_achieved: true, effectiveness_score: 1 }, summary: 'must not return' }, custom: {}, _meta: { model: 'm', provider: 'p', latency_ms: 1, analyzed_at: new Date().toISOString() } } as any;
    await jobs.completeWithAnalysis(job.id, call.id, claim!.claim_generation, { call_analysis: analysis, analysis_audio_seconds: 3 });
    const row = await getTestPool().query(`SELECT analysis_status, conversation_log, call_analysis, transcript_meta FROM agency_calls WHERE id = $1`, [call.id]);
    expect(row.rows[0]).toEqual({ analysis_status: 'deleted', conversation_log: null, call_analysis: null, transcript_meta: null });
    expect(await jobs.findById(job.id)).toMatchObject({ status: 'completed', analysis_audio_seconds: 3 });
  });
});
