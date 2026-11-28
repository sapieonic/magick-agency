import type { AgencyCallExportFieldsResponse } from '@magick-agency/contracts/api/agency/call-export-fields';

/**
 * An export-fields answer (`GET …/call-log/export-fields`) with each case the dialog must draw:
 * the analysis sent out of the contract's order, a choice dimension on the dialler and the soft
 * phone, a yes / no dimension on inbound calls only, a key whose type changed between profile
 * versions, a key found only in stored results, and a call field the soft phone has since
 * removed (no label, no type).
 */
export function exportFieldsFixture(overrides: Partial<AgencyCallExportFieldsResponse> = {}): AgencyCallExportFieldsResponse {
  return {
    calls: 24_812,
    analysis_available: true,
    analysed: 18_003,
    analysis: [
      { name: 'ai_key_topics', calls: 17_950 },
      { name: 'analysis_status', calls: 24_812 },
      { name: 'ai_summary', calls: 18_003 },
      { name: 'ai_sentiment', calls: 17_990 },
      { name: 'ai_sentiment_score', calls: 17_990 },
    ],
    dimensions: [
      {
        name: 'dim_promise_strength', key: 'promise_strength', types: ['enum'], options: ['firm', 'vague', 'none'],
        description: 'How firm the customer’s promise to pay was', calls: 9_120, sources: ['dialler', 'soft_phone'],
      },
      {
        name: 'dim_callback_requested', key: 'callback_requested', types: ['boolean'], options: [],
        description: null, calls: 4_100, sources: ['inbound'],
      },
      {
        name: 'dim_reason_code', key: 'reason_code', types: ['string', 'enum'], options: ['moved', 'deceased'],
        description: 'Why the call ended', calls: 800, sources: ['dialler'],
      },
      {
        name: 'dim_legacy_flag', key: 'legacy_flag', types: [], options: [],
        description: null, calls: 12, sources: ['dialler', 'inbound'],
      },
    ],
    call_fields: [
      { name: 'field_loan_account_no', key: 'loan_account_no', label: 'Loan account no.', type: 'text', calls: 2_200 },
      { name: 'field_old_ref', key: 'old_ref', label: null, type: null, calls: 40 },
    ],
    row_limit: 50_000,
    ai_row_limit: 20_000,
    ...overrides,
  };
}
