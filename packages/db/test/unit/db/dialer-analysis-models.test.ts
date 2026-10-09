import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { DialerAnalysisStatus } from '../../../src/models/agency-call.model.js';

/*
 * PORT NOTE (magick-agency): ported from core
 * test/unit/db/dialer-analysis-models.test.ts@4850d1d9 — the ONE case about the
 * call model (`DialerAnalysisStatus` vs `ck_webrtc_analysis_status`), read from
 * the baseline instead of core's migration 059. The constraint keeps its name in
 * the baseline but is declared inline in `CREATE TABLE agency_calls`, so the
 * pattern drops 059's `ADD`. The other two cases are about
 * `dialer-analysis-job.model.ts` (lane D's port): the job-status case moves with
 * that model, and the settlement-status case is deleted with settlement (plan §4).
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
