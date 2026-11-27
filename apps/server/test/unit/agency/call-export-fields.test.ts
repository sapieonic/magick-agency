import { describe, it, expect } from 'vitest';
import {
  AGENCY_CALL_EXPORT_AI_ROW_LIMIT,
  AGENCY_CALL_EXPORT_MAX_FIELDS,
} from '@magick-agency/contracts/api/agency/call-export-fields';
import {
  attachCallExportExtras,
  callExportCell,
  callExportCsvHeader,
  callExportCsvRow,
  callExportFieldsInvalidBody,
  callExportFieldsNotPermittedBody,
  callExportInclude,
  callExportPreambleLines,
  callExportValue,
  parseCallExportFields,
  parseCallLogInclude,
  planCallExportFields,
  toCallExportCallFields,
  toCallExportDimensions,
  toCallExportFieldsResponse,
  type CallExportField,
  type CallExportRow,
} from '../../../src/agency/call-export-fields.js';
import { ATTEMPT_CSV_COLUMNS, SPINE_EXPORT_MAX_ROWS, attemptCsvRow } from '../../../src/agency/agency-spine.js';

/**
 * Export with fields (`docs/call-log.md` §10, CL43–CL52): the leaf module's rules, one by one.
 * The routes' use of them is `proxy-agency-call-export-fields.routes.test.ts`; the reads on real
 * Postgres are `test/integration/api/agency-call-export-fields.test.ts`.
 */

const fieldsOf = (raw: unknown): CallExportField[] => {
  const parsed = parseCallExportFields(raw);
  if (!parsed.ok) throw new Error(`refused: ${parsed.invalid.join(',')}`);
  return parsed.fields;
};

const ROW: CallExportRow = {
  source: 'dialler',
  id: 'attempt-1', contact_id: 'contact-1', attempt_number: 1, phone_e164: '+919876500001',
  caller_id: '+919000000001', agent_user_id: null, agent_name: null, state: 'ended', outcome: 'connected',
  disposition_code: 'will_pay', notes: null, callback_at: null, dispositioned_by_user_id: null, dispositioned_at: null,
  dispositioned_on_behalf: false, webrtc_call_id: 'leg-1', dialed_at: null, answered_at: null, bridged_at: null,
  ended_at: null, talk_seconds: 40, wrapup_seconds: null, created_at: '2026-11-27T10:00:00.000Z',
};

describe('parseCallExportFields (CL52)', () => {
  it('reads comma-separated and repeated items, trims, drops blanks and keeps a repeat in its first place', () => {
    expect(fieldsOf('ai_summary, dim_promise_strength ,,field_loan_no').map((f) => f.name))
      .toEqual(['ai_summary', 'dim_promise_strength', 'field_loan_no']);
    expect(fieldsOf(['dim_b,ai_summary', ' dim_a', 'dim_b', 'ai_summary']).map((f) => f.name))
      .toEqual(['dim_b', 'ai_summary', 'dim_a']);
  });

  it('absent or blank is no field at all', () => {
    expect(fieldsOf(undefined)).toEqual([]);
    expect(fieldsOf('')).toEqual([]);
    expect(fieldsOf(' , ')).toEqual([]);
  });

  it('classifies each item and keeps a key as asked, never respelled', () => {
    expect(fieldsOf('analysis_status,dim_outcome,field_outcome')).toEqual([
      { kind: 'analysis', name: 'analysis_status' },
      { kind: 'dimension', name: 'dim_outcome', key: 'outcome' },
      { kind: 'call_field', name: 'field_outcome', key: 'outcome' },
    ]);
  });

  it('refuses an item of any other shape, naming every bad one', () => {
    const parsed = parseCallExportFields('ai_summary,transcript,dim_,dim_Bad,field_1x,phone,dim_a-b');
    expect(parsed).toEqual({ ok: false, invalid: ['transcript', 'dim_', 'dim_Bad', 'field_1x', 'phone', 'dim_a-b'], count: 7 });
  });

  it('accepts a 50-character key and refuses 51', () => {
    expect(fieldsOf(`dim_a${'b'.repeat(49)}`)).toHaveLength(1);
    expect(parseCallExportFields(`dim_a${'b'.repeat(50)}`).ok).toBe(false);
  });

  it('cuts a long bad item to a name\'s length in what it echoes back', () => {
    const parsed = parseCallExportFields(`x${'y'.repeat(500)}`);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.invalid[0]!.length).toBeLessThanOrEqual(65);
  });

  it('allows exactly the maximum and refuses one more, after the repeats are dropped', () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => `dim_k${i}`);
    expect(fieldsOf(many(AGENCY_CALL_EXPORT_MAX_FIELDS))).toHaveLength(AGENCY_CALL_EXPORT_MAX_FIELDS);
    expect(fieldsOf([...many(AGENCY_CALL_EXPORT_MAX_FIELDS), 'dim_k0'])).toHaveLength(AGENCY_CALL_EXPORT_MAX_FIELDS);
    expect(parseCallExportFields(many(AGENCY_CALL_EXPORT_MAX_FIELDS + 1)))
      .toEqual({ ok: false, invalid: [], count: AGENCY_CALL_EXPORT_MAX_FIELDS + 1 });
  });

  it('the refusals say what is wrong in plain words, with the wire codes', () => {
    expect(callExportFieldsInvalidBody({ invalid: ['transcript'], count: 1 })).toMatchObject({
      code: 'export_fields_invalid',
      message: 'These fields cannot be added to the export: transcript.',
      details: { invalid: ['transcript'], count: 1, max: 100 },
    });
    expect(callExportFieldsInvalidBody({ invalid: [], count: 101 }).message)
      .toBe('At most 100 fields can be added to one export; 101 were asked for.');
    expect(callExportFieldsNotPermittedBody(['ai_summary', 'dim_x'])).toEqual({
      error: 'Forbidden',
      code: 'export_fields_not_permitted',
      message: 'Call analysis is turned off for this campaign\'s account, so these fields cannot be added to the export: ai_summary, dim_x.',
      details: { fields: ['ai_summary', 'dim_x'] },
    });
  });
});

describe('planCallExportFields: the grant, the extras and the ceiling (CL47, CL48)', () => {
  it('lowers the ceiling for any analysis field but analysis_status, and for any dimension', () => {
    for (const lowering of ['ai_summary', 'ai_sentiment', 'ai_sentiment_score', 'ai_key_topics', 'dim_x']) {
      expect(planCallExportFields(fieldsOf(`field_a,${lowering}`)).rowLimit, lowering).toBe(AGENCY_CALL_EXPORT_AI_ROW_LIMIT);
    }
    expect(planCallExportFields(fieldsOf('analysis_status')).rowLimit).toBe(SPINE_EXPORT_MAX_ROWS);
    expect(planCallExportFields(fieldsOf('field_a,field_b')).rowLimit).toBe(SPINE_EXPORT_MAX_ROWS);
    expect(AGENCY_CALL_EXPORT_AI_ROW_LIMIT).toBeLessThan(SPINE_EXPORT_MAX_ROWS);
  });

  it('needs the grant for the analysis and dimension fields, never for call details', () => {
    expect(planCallExportFields(fieldsOf('field_a,analysis_status,dim_x')).needsAnalysisGrant).toEqual(['analysis_status', 'dim_x']);
    expect(planCallExportFields(fieldsOf('field_a')).needsAnalysisGrant).toEqual([]);
  });

  it('asks the read for each kind of extra only when a field of that kind is chosen', () => {
    expect(callExportInclude(planCallExportFields(fieldsOf('field_a')))).toBe('call_fields');
    expect(callExportInclude(planCallExportFields(fieldsOf('analysis_status')))).toBe('analysis');
    expect(callExportInclude(planCallExportFields(fieldsOf('dim_x,field_a')))).toBe('analysis,call_fields');
    expect(callExportInclude(planCallExportFields([]))).toBeNull();
  });
});

describe('parseCallLogInclude (the internal read)', () => {
  it('reads either form, and refuses a value it does not know', () => {
    expect(parseCallLogInclude(undefined)).toEqual({ ok: true, include: new Set() });
    expect(parseCallLogInclude('analysis,call_fields')).toEqual({ ok: true, include: new Set(['analysis', 'call_fields']) });
    expect(parseCallLogInclude(['call_fields'])).toEqual({ ok: true, include: new Set(['call_fields']) });
    expect(parseCallLogInclude('analysis,transcript')).toEqual({ ok: false, unknown: ['transcript'] });
  });
});

describe('callExportCell: how a value is written (CL49)', () => {
  it('every value type', () => {
    expect(callExportCell(true)).toBe('true');
    expect(callExportCell(false)).toBe('false');
    expect(callExportCell(0)).toBe('0');
    expect(callExportCell(0.85)).toBe('0.85');
    expect(callExportCell(-3)).toBe('-3');
    expect(callExportCell('strong')).toBe('strong');
    expect(callExportCell('line one\nline two')).toBe('line one\nline two');
    expect(callExportCell(['emi', 'waiver'])).toBe('emi; waiver');
    expect(callExportCell([1, true, null, { a: 1 }, ['x']])).toBe('1; true; ; {"a":1}; ["x"]');
    expect(callExportCell({ amount: 5000, date: '2026-12-01' })).toBe('{"amount":5000,"date":"2026-12-01"}');
    expect(callExportCell(null)).toBe('');
    expect(callExportCell(undefined)).toBe('');
    expect(callExportCell([])).toBe('');
  });
});

describe('callExportValue: where each field reads from', () => {
  const current = {
    common: { summary: 'Agreed to pay', key_topics: ['emi', 'waiver'], overall_sentiment: { label: 'positive', score: 0.8 } },
    custom: { promise_strength: 'strong', will_pay: true, amount: 5000 },
  };
  const legacy = {
    summary: 'Old summary', key_topics: ['old'], overall_sentiment: { label: 'negative', score: -0.4 },
    custom_dimensions: { promise_strength: 'weak', legacy_only: 'yes' },
  };
  const row = (callAnalysis: unknown, status: string | null = 'completed', extra: Partial<CallExportRow> = {}): CallExportRow => ({
    ...ROW, ...extra, export_extras: { analysis_status: status, call_analysis: callAnalysis, call_fields: null },
  });
  const value = (name: string, r: CallExportRow) => callExportValue(fieldsOf(name)[0]!, r);

  it('the current shape: common.* and custom.*', () => {
    const r = row(current);
    expect(value('analysis_status', r)).toBe('completed');
    expect(value('ai_summary', r)).toBe('Agreed to pay');
    expect(value('ai_sentiment', r)).toBe('positive');
    expect(value('ai_sentiment_score', r)).toBe(0.8);
    expect(value('ai_key_topics', r)).toEqual(['emi', 'waiver']);
    expect(value('dim_promise_strength', r)).toBe('strong');
    expect(value('dim_will_pay', r)).toBe(true);
  });

  it('the legacy flat shape, when the current one has no value', () => {
    const r = row(legacy);
    expect(value('ai_summary', r)).toBe('Old summary');
    expect(value('ai_sentiment', r)).toBe('negative');
    expect(value('ai_sentiment_score', r)).toBe(-0.4);
    expect(value('ai_key_topics', r)).toEqual(['old']);
    expect(value('dim_promise_strength', r)).toBe('weak');
    // Both present: the current shape wins, and a key only in the legacy one is still read.
    const both = row({ ...legacy, ...current });
    expect(value('ai_summary', both)).toBe('Agreed to pay');
    expect(value('dim_promise_strength', both)).toBe('strong');
    expect(value('dim_legacy_only', both)).toBe('yes');
  });

  it('analysis_status is none for a row with no leg or never queued; an erased leg exports nothing', () => {
    expect(value('analysis_status', row(null, null))).toBe('none');
    expect(value('analysis_status', { ...ROW })).toBe('none');
    const erased = row(current, 'deleted');
    expect(value('analysis_status', erased)).toBe('deleted');
    expect(value('ai_summary', erased)).toBeUndefined();
    expect(value('dim_promise_strength', erased)).toBeUndefined();
  });

  it('a key shaped like an Object.prototype member reads only the result\'s own key', () => {
    expect(value('dim_constructor', row(current))).toBeUndefined();
    expect(value('dim_constructor', row({ custom: { constructor: 'own' } }))).toBe('own');
    expect(value('field_constructor', row(null, null, { source: 'soft_phone' }))).toBeUndefined();
  });

  it('a call detail is read only on a soft-phone row', () => {
    const fields = { loan_no: 'LN-42', visited: false };
    const soft: CallExportRow = { ...ROW, source: 'soft_phone', export_extras: { analysis_status: null, call_analysis: null, call_fields: fields } };
    expect(value('field_loan_no', soft)).toBe('LN-42');
    expect(value('field_visited', soft)).toBe(false);
    expect(value('field_missing', soft)).toBeUndefined();
    expect(value('field_loan_no', { ...soft, source: 'dialler' })).toBeUndefined();
  });
});

describe('the file: header order and rows (CL43)', () => {
  const fields = fieldsOf('dim_b,ai_summary,field_a,analysis_status');

  it('today\'s columns first, then the chosen ones in the order asked', () => {
    expect(callExportCsvHeader(fields)).toBe(`${[...ATTEMPT_CSV_COLUMNS, 'dim_b', 'ai_summary', 'field_a', 'analysis_status'].join(',')}\n`);
  });

  it('a row is the plain row\'s cells, then the chosen cells', () => {
    const line = callExportCsvRow({ ...ROW, export_extras: { analysis_status: 'completed', call_analysis: { common: { summary: 'ok' }, custom: { b: 2 } }, call_fields: null } }, fields);
    const plain = attemptCsvRow(ROW).trimEnd();
    expect(line).toBe(`${plain},2,ok,,completed\n`);
  });

  it('with no fields chosen the row is exactly the plain export\'s', () => {
    expect(callExportCsvRow(ROW, [])).toBe(attemptCsvRow(ROW));
    expect(callExportCsvHeader([])).toBe(`${ATTEMPT_CSV_COLUMNS.join(',')}\n`);
  });

  it('a model-written summary that looks like a formula comes out guarded, once', () => {
    const line = callExportCsvRow({
      ...ROW, export_extras: { analysis_status: 'completed', call_analysis: { common: { summary: '=HYPERLINK("http://evil","x")' } }, call_fields: null },
    }, fieldsOf('ai_summary'));
    expect(line.trimEnd().endsWith(',"\'=HYPERLINK(""http://evil"",""x"")"')).toBe(true);
    expect(line).not.toContain("''=");
  });

  it('a summary with line breaks and commas stays one quoted cell', () => {
    const line = callExportCsvRow({
      ...ROW, export_extras: { analysis_status: 'completed', call_analysis: { common: { summary: 'Paid, partly.\nCall back' } }, call_fields: null },
    }, fieldsOf('ai_summary'));
    expect(line.endsWith(',"Paid, partly.\nCall back"\n')).toBe(true);
  });
});

describe('attachCallExportExtras', () => {
  it('puts each leg\'s analysis on its row and a soft-phone row\'s details on it alone', () => {
    const rows = [
      { source: 'dialler', id: 'a1', webrtc_call_id: 'leg-1' },
      { source: 'soft_phone', id: 'm1', webrtc_call_id: 'leg-2' },
      { source: 'inbound', id: 'i1', webrtc_call_id: null },
      { source: 'dialler', id: 'm1', webrtc_call_id: 'leg-9' },
    ];
    const out = attachCallExportExtras(
      rows,
      new Map([['leg-1', { analysis_status: 'completed', call_analysis: { custom: {} } }], ['leg-2', { analysis_status: 'pending', call_analysis: null }]]),
      new Map([['m1', { loan_no: 'LN-1' }]]),
    );
    expect(out.map((r) => r.export_extras)).toEqual([
      { analysis_status: 'completed', call_analysis: { custom: {} }, call_fields: null },
      { analysis_status: 'pending', call_analysis: null, call_fields: { loan_no: 'LN-1' } },
      { analysis_status: null, call_analysis: null, call_fields: null },
      // A dialler row whose id happens to be a soft-phone call's gets no details.
      { analysis_status: null, call_analysis: null, call_fields: null },
    ]);
    expect(attachCallExportExtras(rows, null, null)[0]!.export_extras).toEqual({ analysis_status: null, call_analysis: null, call_fields: null });
  });
});

describe('callExportPreambleLines (CL51)', () => {
  it('lists the fields, each dimension\'s description, the ceiling, and that the columns are customer content', () => {
    const fields = fieldsOf('ai_summary,dim_promise_strength,dim_found_only,field_loan_no');
    const lines = callExportPreambleLines({
      fields,
      descriptions: new Map([['promise_strength', 'How firm the promise was'], ['found_only', null]]),
      rowLimit: AGENCY_CALL_EXPORT_AI_ROW_LIMIT,
    });
    const text = lines.join('');
    expect(lines.every((l) => l.startsWith('# ') && l.endsWith('\n'))).toBe(true);
    expect(text).toContain('# Fields added after callback_of, in this order: ai_summary, dim_promise_strength, dim_found_only, field_loan_no\n');
    expect(text).toContain('# dim_promise_strength: How firm the promise was\n');
    expect(text).toContain('# dim_found_only: (no description: the key is found only in stored results)\n');
    expect(text).toContain('Row ceiling: 20,000 rows, because an AI field was chosen');
    expect(text).toContain('analysis_status says why an analysis cell is empty');
    expect(text).toContain('customer content');
  });

  it('a call-details-only choice keeps the export\'s ceiling and says nothing about analysis', () => {
    const text = callExportPreambleLines({ fields: fieldsOf('field_a'), descriptions: new Map(), rowLimit: SPINE_EXPORT_MAX_ROWS }).join('');
    expect(text).toContain('# Row ceiling: 50,000 rows.\n');
    expect(text).not.toContain('analysis_status says');
  });

  it('a description cannot break out of its line or plant a formula', () => {
    const text = callExportPreambleLines({
      fields: fieldsOf('dim_x'), descriptions: new Map([['x', 'line\n=SUM(A1), =cmd']]), rowLimit: AGENCY_CALL_EXPORT_AI_ROW_LIMIT,
    }).join('');
    expect(text).toContain("# dim_x: line =SUM(A1),' =cmd\n");
  });
});

describe('the field list\'s normalising', () => {
  it('dimensions: types narrowed, sources in call-type order, a blank description as null, most calls first then key', () => {
    expect(toCallExportDimensions([
      { key: 'b', types: ['string', 'bogus'], options: [], description: '  ', calls: '3', sources: ['inbound', 'dialler'] },
      { key: 'a', types: ['enum'], options: ['x', 'y'], description: 'A', calls: 3, sources: ['soft_phone'] },
      { key: 'c', types: [], options: null, description: null, calls: 9, sources: null },
    ])).toEqual([
      { name: 'dim_c', key: 'c', types: [], options: [], description: null, calls: 9, sources: [] },
      { name: 'dim_a', key: 'a', types: ['enum'], options: ['x', 'y'], description: 'A', calls: 3, sources: ['soft_phone'] },
      { name: 'dim_b', key: 'b', types: ['string'], options: [], description: null, calls: 3, sources: ['dialler', 'inbound'] },
    ]);
  });

  it('call fields: a removed field\'s label and type are null', () => {
    expect(toCallExportCallFields([
      { key: 'gone', calls: 2, label: null, type: null },
      { key: 'loan_no', calls: '5', label: 'Loan number', type: 'text' },
      { key: 'odd', calls: 2, label: 'Odd', type: 'weird' },
    ])).toEqual([
      { name: 'field_loan_no', key: 'loan_no', label: 'Loan number', type: 'text', calls: 5 },
      { name: 'field_gone', key: 'gone', label: null, type: null, calls: 2 },
      { name: 'field_odd', key: 'odd', label: 'Odd', type: null, calls: 2 },
    ]);
  });

  it('the public answer: without the grant the analysis groups are empty, whatever the read held', () => {
    const read = {
      calls: 7,
      analysis: { analysed: 4, fields: [{ name: 'analysis_status' as const, calls: 7 }], dimensions: toCallExportDimensions([{ key: 'a', types: [], options: [], description: null, calls: 1, sources: [] }]) },
      call_fields: [],
    };
    expect(toCallExportFieldsResponse(read, false)).toEqual({
      calls: 7, analysis_available: false, analysed: null, analysis: [], dimensions: [], call_fields: [],
      row_limit: 50_000, ai_row_limit: 20_000,
    });
    expect(toCallExportFieldsResponse(read, true)).toMatchObject({ analysis_available: true, analysed: 4, analysis: read.analysis.fields });
  });
});
