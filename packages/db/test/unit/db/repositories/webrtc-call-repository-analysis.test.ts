import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Hoisted mocks ──────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  poolQuery: vi.fn(),
}));

vi.mock('../../../../src/connection.js', () => ({
  getPool: () => ({ query: mocks.poolQuery }),
}));

import { WebRtcCallRepository } from '../../../../src/repositories/agency-call.repository.js';

const repo = new WebRtcCallRepository();

// PORT NOTE (magick-agency): ported from core
// test/unit/db/repositories/webrtc-call-repository-analysis.test.ts@4850d1d9.
// MODIFIED: the INSERT no longer binds `telephony_credential_id` or
// `sip_connection_id` (baseline dropped both), so the analysis fields sit at
// $9..$12 (indexes 8..11) instead of $11..$14; `listByTenant` passes the only
// remaining scope, `'agency'`.

function firstQueryText(): string {
  return mocks.poolQuery.mock.calls[0]![0] as string;
}
function firstQueryValues(): unknown[] {
  return mocks.poolQuery.mock.calls[0]![1] as unknown[];
}

describe('WebRtcCallRepository — analysis columns', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.poolQuery.mockResolvedValue({ rows: [{ id: 'wc-1' }], rowCount: 1 });
  });

  describe('create()', () => {
    it('persists the immutable analysis fields (profile/language/consent)', async () => {
      const consentAt = new Date('2026-07-28T10:00:00Z');
      await repo.create({
        tenant_id: 't1',
        account_id: 'a1',
        caller_id: '+91000',
        destination_phone: '+91999',
        analysis_profile_id: 'prof-1',
        analysis_language: 'hi-IN',
        analysis_consent: true,
        analysis_consent_at: consentAt,
      });

      const text = firstQueryText();
      expect(text).toContain('analysis_profile_id');
      expect(text).toContain('analysis_language');
      expect(text).toContain('analysis_consent');
      expect(text).toContain('analysis_consent_at');

      const values = firstQueryValues();
      // Order: ...recording_requested($8), analysis_profile_id($9),
      // analysis_language($10), analysis_consent($11), analysis_consent_at($12).
      expect(values[8]).toBe('prof-1');
      expect(values[9]).toBe('hi-IN');
      expect(values[10]).toBe(true);
      expect(values[11]).toBe(consentAt);
    });

    it('defaults the analysis fields to null when omitted', async () => {
      await repo.create({
        tenant_id: 't1',
        account_id: 'a1',
        caller_id: '+91000',
        destination_phone: '+91999',
      });
      const values = firstQueryValues();
      expect(values[8]).toBeNull();
      expect(values[9]).toBeNull();
      expect(values[10]).toBeNull();
      expect(values[11]).toBeNull();
    });
  });

  describe('update() — JSON serialization + allow-list', () => {
    it('JSON.stringifies call_analysis / conversation_log / transcript_meta', async () => {
      const call_analysis = { common: { summary: 'x' } } as never;
      const conversation_log = [{ role: 'agent', content: 'hi' }] as never;
      const transcript_meta = { provider: 'gemini' } as never;

      await repo.update('wc-1', {
        analysis_status: 'completed',
        call_analysis,
        conversation_log,
        transcript_meta,
      });

      const values = firstQueryValues();
      // analysis_status is a plain scalar; the three blobs are stringified.
      expect(values).toContain('completed');
      expect(values).toContain(JSON.stringify(call_analysis));
      expect(values).toContain(JSON.stringify(conversation_log));
      expect(values).toContain(JSON.stringify(transcript_meta));
    });

    it('rejects an immutable analysis column (analysis_profile_id) via the allow-list', async () => {
      await expect(
        repo.update('wc-1', { analysis_profile_id: 'nope' } as never),
      ).rejects.toThrow(/Disallowed update column: analysis_profile_id/);
    });
  });

  describe('listByTenant() — WEBRTC_LIST_COLUMNS excludes heavy blobs', () => {
    beforeEach(() => {
      mocks.poolQuery
        .mockResolvedValueOnce({ rows: [{ count: '0' }] }) // COUNT
        .mockResolvedValueOnce({ rows: [] });               // SELECT
    });

    it('SELECT excludes call_analysis/conversation_log/transcript_meta but keeps analysis_status', async () => {
      await repo.listByTenant('t1', 'a1', 'agency');

      const selectQuery = mocks.poolQuery.mock.calls[1]![0] as string;
      // The heavy blobs are never selected as full columns. call_analysis appears
      // only inside the scalar-sentiment COALESCE (FIX 6), so assert the blob column
      // itself isn't projected rather than a bare substring.
      expect(selectQuery).not.toMatch(/(^|[\s,])call_analysis(\s*,|\s*$|\s+FROM)/);
      expect(selectQuery).not.toContain('conversation_log');
      expect(selectQuery).not.toContain('transcript_meta');
      expect(selectQuery).not.toMatch(/SELECT \*/);
      expect(selectQuery).toContain('analysis_status');
      expect(selectQuery).toContain('analysis_profile_id');
    });

    it('applies the optional analysis_status filter', async () => {
      await repo.listByTenant('t1', 'a1', 'agency', 20, 0, { analysis_status: 'completed' });

      const countQuery = mocks.poolQuery.mock.calls[0]![0] as string;
      expect(countQuery).toContain('analysis_status = $3');
      const dataValues = mocks.poolQuery.mock.calls[1]![1] as unknown[];
      expect(dataValues).toEqual(['t1', 'a1', 'completed', 20, 0]);
    });

    it('FIX 6: projects a scalar analysis_sentiment_label from call_analysis (COALESCE both shapes)', async () => {
      await repo.listByTenant('t1', 'a1', 'agency');

      const selectQuery = mocks.poolQuery.mock.calls[1]![0] as string;
      // Scalar label projected without selecting the blob column.
      expect(selectQuery).toContain('AS analysis_sentiment_label');
      expect(selectQuery).not.toContain('call_analysis,');
      // Nested `common.overall_sentiment.label` AND legacy-flat `overall_sentiment.label`.
      expect(selectQuery).toContain("call_analysis->'common'->'overall_sentiment'->>'label'");
      expect(selectQuery).toContain("call_analysis->'overall_sentiment'->>'label'");
    });

    it('FIX 6: returns the projected label on a completed row and null otherwise', async () => {
      mocks.poolQuery.mockReset();
      mocks.poolQuery
        .mockResolvedValueOnce({ rows: [{ count: '2' }] }) // COUNT
        .mockResolvedValueOnce({
          rows: [
            { id: 'wc-1', analysis_status: 'completed', analysis_sentiment_label: 'positive' },
            { id: 'wc-2', analysis_status: null, analysis_sentiment_label: null },
          ],
        }); // SELECT

      const { rows } = await repo.listByTenant('t1', 'a1', 'agency');
      expect(rows[0]!.analysis_sentiment_label).toBe('positive');
      expect(rows[1]!.analysis_sentiment_label).toBeNull();
    });
  });
});
