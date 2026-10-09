import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { DialerAnalysisJobStatus, DialerAnalysisJobRecord } from '../../../src/models/dialer-analysis-job.model.js';

/*
 * The job-status case (the call-model case lives in dialer-analysis-models.test.ts),
 * read from the baseline. There is no settlement status; the job record carries no
 * settlement field, pinned against the baseline's column list.
 */
const migration = readFileSync(new URL('../../../migrations/0001_baseline.sql', import.meta.url), 'utf8');

describe('dialer analysis job model / baseline drift', () => {
  it('keeps the job status CHECK values aligned with the TypeScript union', () => {
    const match = migration.match(/CONSTRAINT ck_dialer_analysis_job_status CHECK \(\s*status IN \(([^)]*)\)/s);
    expect(match, 'missing ck_dialer_analysis_job_status CHECK').not.toBeNull();
    const db = [...match![1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
    const ts: DialerAnalysisJobStatus[] = ['awaiting_recording', 'queued', 'transcribing', 'analyzing', 'completed', 'failed', 'skipped', 'expired'];
    expect(db).toEqual(ts);
  });

  it('the baseline job table has no settlement column and the model carries none', () => {
    const table = /CREATE TABLE dialer_analysis_jobs \(([\s\S]*?)\n\);/.exec(migration)![1]!;
    expect(table).not.toMatch(/settlement/);
    expect(table).toContain('analysis_audio_seconds');
    // A compile-time probe: the model must not have the field.
    const key: keyof DialerAnalysisJobRecord = 'analysis_audio_seconds';
    expect(key).toBe('analysis_audio_seconds');
    // @ts-expect-error settlement_status is not part of the record any more
    const gone: keyof DialerAnalysisJobRecord = 'settlement_status';
    expect(gone).toBe('settlement_status');
  });
});
