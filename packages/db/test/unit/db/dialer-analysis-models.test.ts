import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { DialerAnalysisStatus } from '../../../src/models/agency-call.model.js';

/*
 * The call-model case (`DialerAnalysisStatus` vs `ck_webrtc_analysis_status`), read
 * from the baseline. The constraint is declared inline in `CREATE TABLE agency_calls`.
 * The job-status case lives in dialer-analysis-job-model.test.ts; there is no
 * settlement status.
 */
const migration = readFileSync(new URL('../../../migrations/0001_baseline.sql', import.meta.url), 'utf8');

describe('dialer analysis model / migration status drift', () => {
  it('keeps WebRTC analysis status CHECK values aligned with the TypeScript union', () => {
    const match = migration.match(/CONSTRAINT ck_webrtc_analysis_status CHECK \(\s*analysis_status IS NULL OR analysis_status IN \(([^)]*)\)/s);
    expect(match, 'missing ck_webrtc_analysis_status CHECK').not.toBeNull();
    const db = [...match![1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
    const ts: DialerAnalysisStatus[] = ['awaiting_recording', 'pending', 'completed', 'failed', 'skipped', 'expired', 'deleted'];
    expect(db).toEqual(ts);
  });
});
