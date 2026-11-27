import { describe, expect, it } from 'vitest';
import {
  AGENCY_CALL_EXPORT_AI_ROW_LIMIT,
  AGENCY_CALL_EXPORT_ANALYSIS_FIELDS,
  AGENCY_CALL_EXPORT_ANALYSIS_STATUSES,
  AGENCY_CALL_EXPORT_CALL_FIELD_PREFIX,
  AGENCY_CALL_EXPORT_DIMENSION_PREFIX,
  AGENCY_CALL_EXPORT_KEY_PATTERN,
  AGENCY_CALL_EXPORT_MAX_FIELDS,
  isCallExportAnalysisField,
  lowersCallExportRowLimit,
} from '../src/api/agency/call-export-fields';
import { AgencyApi } from '../src/index';

describe('call export fields (docs/call-log.md §10)', () => {
  it('offers the analysis fields in a fixed order, under the ai_ prefix but for the status', () => {
    expect(AGENCY_CALL_EXPORT_ANALYSIS_FIELDS).toEqual([
      'analysis_status', 'ai_summary', 'ai_sentiment', 'ai_sentiment_score', 'ai_key_topics',
    ]);
  });

  it('names each analysis status by the media leg\'s own wire code, plus none', () => {
    expect(AGENCY_CALL_EXPORT_ANALYSIS_STATUSES).toEqual([
      'none', 'awaiting_recording', 'pending', 'completed', 'failed', 'skipped', 'expired', 'deleted',
    ]);
  });

  it('keeps the prefixes and limits the server and console agree on', () => {
    expect(AGENCY_CALL_EXPORT_DIMENSION_PREFIX).toBe('dim_');
    expect(AGENCY_CALL_EXPORT_CALL_FIELD_PREFIX).toBe('field_');
    expect(AGENCY_CALL_EXPORT_AI_ROW_LIMIT).toBe(20_000);
    expect(AGENCY_CALL_EXPORT_MAX_FIELDS).toBe(100);
  });

  it('accepts the keys the profile validator accepts and nothing else', () => {
    for (const ok of ['a', 'promise_strength', 'kb_answer_grounded', 'x1', 'a'.repeat(50)]) {
      expect(AGENCY_CALL_EXPORT_KEY_PATTERN.test(ok), ok).toBe(true);
    }
    for (const bad of ['', '1abc', '_a', 'Promise', 'a-b', 'a b', 'a'.repeat(51), 'a,b']) {
      expect(AGENCY_CALL_EXPORT_KEY_PATTERN.test(bad), bad).toBe(false);
    }
  });

  it('knows which fields are the analysis\'s own', () => {
    expect(isCallExportAnalysisField('ai_summary')).toBe(true);
    expect(isCallExportAnalysisField('analysis_status')).toBe(true);
    expect(isCallExportAnalysisField('dim_ai_summary')).toBe(false);
    expect(isCallExportAnalysisField('summary')).toBe(false);
  });

  it('lowers the ceiling for an AI field or a dimension, not for the status or a call field (CL48)', () => {
    expect(lowersCallExportRowLimit('ai_summary')).toBe(true);
    expect(lowersCallExportRowLimit('ai_sentiment')).toBe(true);
    expect(lowersCallExportRowLimit('ai_key_topics')).toBe(true);
    expect(lowersCallExportRowLimit('dim_promise_strength')).toBe(true);
    expect(lowersCallExportRowLimit('analysis_status')).toBe(false);
    expect(lowersCallExportRowLimit('field_loan_account_no')).toBe(false);
  });

  it('is on the AgencyApi namespace', () => {
    expect(AgencyApi.AGENCY_CALL_EXPORT_AI_ROW_LIMIT).toBe(20_000);
  });
});
