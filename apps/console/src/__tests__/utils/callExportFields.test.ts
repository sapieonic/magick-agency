import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/client';
import {
  CALL_EXPORT_ANALYSIS_COPY,
  EXPORT_FIELDS_INVALID_COPY,
  EXPORT_FIELDS_NOT_PERMITTED_COPY,
  callExportCeilingNote,
  callExportDatesWords,
  callExportFieldsRefusal,
  callExportGroups,
  callExportSubtitle,
  callExportTypeWords,
  callFieldLabel,
  callFieldTypeWords,
  callLogExportQuery,
  dimensionTypeWords,
  nameFromKey,
  offeredFieldNames,
  orderedChosenFields,
  rememberedStillOffered,
} from '../../utils/agency/callExportFields';
import { callExportFieldsKey, readRememberedFields, writeRememberedFields } from '../../utils/agency/callExportFieldsStore';
import { exportFieldsFixture } from '../helpers/callExportFields';

/**
 * Export with fields' rules (`docs/call-log.md` §10, CL43–CL52): the names, the type words, the
 * groups and their order, the order the chosen fields are sent in, the remembered choice and the
 * ceiling note. The dialog itself is `ExportFieldsDialog.test.tsx`.
 */

describe('nameFromKey (CL44: a dimension has no label)', () => {
  it('turns a snake_case key into a sentence-case name', () => {
    expect(nameFromKey('promise_strength')).toBe('Promise strength');
    expect(nameFromKey('loan_account_no')).toBe('Loan account no');
    expect(nameFromKey('dpd')).toBe('Dpd');
    expect(nameFromKey('a__b_')).toBe('A b');
  });

  it('keeps a key that has no words as it is', () => {
    expect(nameFromKey('_')).toBe('_');
  });
});

describe('dimensionTypeWords', () => {
  it('names one type, a choice with its options', () => {
    expect(dimensionTypeWords({ types: ['enum'], options: ['firm', 'vague', 'none'] })).toBe('Choice: firm, vague, none');
    expect(dimensionTypeWords({ types: ['enum'], options: [] })).toBe('Choice');
    expect(dimensionTypeWords({ types: ['boolean'], options: [] })).toBe('Yes / no');
    expect(dimensionTypeWords({ types: ['number'], options: [] })).toBe('Number');
    expect(dimensionTypeWords({ types: ['string'], options: [] })).toBe('Text');
  });

  it('says a key changed type, oldest first', () => {
    expect(dimensionTypeWords({ types: ['string', 'enum'], options: ['a'] })).toBe('Changed type: Text, then Choice');
  });

  it('says a key with no declaration was found in stored results', () => {
    expect(dimensionTypeWords({ types: [], options: [] })).toBe('Found in stored results');
  });
});

describe('call fields', () => {
  it('use the soft phone’s label, else the key as words', () => {
    expect(callFieldLabel({ key: 'loan_account_no', label: 'Loan account no.' })).toBe('Loan account no.');
    expect(callFieldLabel({ key: 'old_ref', label: null })).toBe('Old ref');
    expect(callFieldLabel({ key: 'old_ref', label: '  ' })).toBe('Old ref');
  });

  it('say their type, or that the soft phone no longer has them', () => {
    expect(callFieldTypeWords('boolean')).toBe('Yes / no');
    expect(callFieldTypeWords('date')).toBe('Date');
    expect(callFieldTypeWords(null)).toBe('No longer in the soft phone’s call details');
  });
});

describe('callExportGroups', () => {
  it('orders the groups (call details, analysis, dimensions) and each group’s options', () => {
    const groups = callExportGroups(exportFieldsFixture());
    expect(groups.map((g) => g.id)).toEqual(['call_fields', 'analysis', 'dimensions']);
    expect(groups[0]!.hint).toBe('Soft-phone calls only');
    expect(groups[1]!.hint).toBe('18,003 of 24,812 calls analysed');
    // The analysis follows the contract's order, whatever order the server sent.
    expect(groups[1]!.options.map((o) => o.name)).toEqual([
      'analysis_status', 'ai_summary', 'ai_sentiment', 'ai_sentiment_score', 'ai_key_topics',
    ]);
    expect(groups[1]!.options.map((o) => o.label)).toEqual(
      ['Analysis status', 'Summary', 'Sentiment', 'Sentiment score', 'Key topics'],
    );
    expect(groups[1]!.options[0]!.detail).toBe(CALL_EXPORT_ANALYSIS_COPY.analysis_status.hint);
    // Dimensions and call fields keep the server's order (most calls first).
    expect(groups[2]!.options.map((o) => o.name)).toEqual([
      'dim_promise_strength', 'dim_callback_requested', 'dim_reason_code', 'dim_legacy_flag',
    ]);
  });

  it('names a dimension from its key, says its type, and badges a one-type dimension', () => {
    const dims = callExportGroups(exportFieldsFixture())[2]!.options;
    expect(dims.map((d) => [d.label, d.detail, d.badge])).toEqual([
      ['Promise strength', 'Choice: firm, vague, none', null],
      ['Callback requested', 'Yes / no', 'Inbound'],
      ['Reason code', 'Changed type: Text, then Choice', 'Dialler'],
      ['Legacy flag', 'Found in stored results', null],
    ]);
    expect(dims[0]!.description).toBe('How firm the customer’s promise to pay was');
  });

  it('leaves out an empty group', () => {
    const groups = callExportGroups(exportFieldsFixture({ call_fields: [], dimensions: [] }));
    expect(groups.map((g) => g.id)).toEqual(['analysis']);
  });

  it('with analysis off, offers no analysis or dimension group whatever the response holds (CL47)', () => {
    const groups = callExportGroups(exportFieldsFixture({ analysis_available: false, analysed: null }));
    expect(groups.map((g) => g.id)).toEqual(['call_fields']);
  });
});

describe('the order the chosen fields are sent in', () => {
  it('is the display order, not the order they were ticked in', () => {
    const groups = callExportGroups(exportFieldsFixture());
    const ticked = new Set(['dim_promise_strength', 'ai_summary', 'field_loan_account_no', 'analysis_status']);
    expect(orderedChosenFields(groups, ticked)).toEqual([
      'field_loan_account_no', 'analysis_status', 'ai_summary', 'dim_promise_strength',
    ]);
  });

  it('drops a chosen name nothing offers', () => {
    const groups = callExportGroups(exportFieldsFixture());
    expect(orderedChosenFields(groups, new Set(['dim_gone', 'ai_summary']))).toEqual(['ai_summary']);
  });

  it('offers every option once, in display order', () => {
    const names = offeredFieldNames(callExportGroups(exportFieldsFixture()));
    expect(names[0]).toBe('field_loan_account_no');
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('rememberedStillOffered (CL50)', () => {
  const groups = callExportGroups(exportFieldsFixture());

  it('ticks the remembered fields still offered and drops the rest', () => {
    expect([...rememberedStillOffered(['ai_summary', 'dim_gone', 'field_old_ref'], groups)].sort())
      .toEqual(['ai_summary', 'field_old_ref']);
  });

  it('ticks nothing when nothing is remembered', () => {
    expect(rememberedStillOffered(null, groups).size).toBe(0);
    expect(rememberedStillOffered([], groups).size).toBe(0);
  });
});

describe('callExportCeilingNote (CL48)', () => {
  const response = { calls: 18_000, ai_row_limit: 20_000 };

  it('says nothing without a field that lowers the ceiling', () => {
    expect(callExportCeilingNote([], response)).toBeNull();
    expect(callExportCeilingNote(['analysis_status', 'field_loan_account_no'], response)).toBeNull();
  });

  it('names the ceiling from the response for an AI field or a dimension', () => {
    expect(callExportCeilingNote(['ai_summary'], response)).toEqual({
      limit: 'With AI fields the file holds at most 20,000 rows.', overLimit: null,
    });
    expect(callExportCeilingNote(['dim_promise_strength'], { calls: 10, ai_row_limit: 1_50_000 })!.limit)
      .toBe('With AI fields the file holds at most 1,50,000 rows.');
  });

  it('says how to get the rest only above the ceiling', () => {
    expect(callExportCeilingNote(['ai_summary'], { calls: 20_000, ai_row_limit: 20_000 })!.overLimit).toBeNull();
    expect(callExportCeilingNote(['ai_summary'], { calls: 1_24_812, ai_row_limit: 20_000 })!.overLimit)
      .toBe('This view has 1,24,812 calls: narrow the dates to get the rest.');
  });
});

describe('callLogExportQuery: the one query for the export and its field list', () => {
  it('is the filters, the status and the chip as source', () => {
    expect(callLogExportQuery({ outcome: ['connected'], from: 'f' }, { type: 'soft_phone', status: 'settled' }))
      .toEqual({ outcome: ['connected'], from: 'f', status: 'settled', source: 'soft_phone' });
  });

  it('sends no source for All and no status when none is chosen', () => {
    expect(callLogExportQuery({ phone: '98' }, { type: 'all', status: null })).toEqual({ phone: '98' });
  });
});

describe('the subtitle', () => {
  it('says the dates as days', () => {
    expect(callExportDatesWords({ from: '2026-11-20T00:00:00.000Z', to: '2026-11-27T23:59:59.999Z' }, 'all')).toBe('20 Nov to 27 Nov');
    expect(callExportDatesWords({ from: '2026-11-20T00:00:00.000Z', to: '2026-11-20T23:59:59.999Z' }, 'all')).toBe('20 Nov');
    expect(callExportDatesWords({ from: '2026-11-20T00:00:00.000Z' }, 'dialler')).toBe('from 20 Nov');
    expect(callExportDatesWords({ to: '2026-11-27T23:59:59.999Z' }, 'dialler')).toBe('up to 27 Nov');
    expect(callExportDatesWords({}, 'all')).toBe('every date');
  });

  it('says To follow up is not narrowed by the dates', () => {
    expect(callExportDatesWords({ from: '2026-11-20T00:00:00.000Z' }, 'to_follow_up')).toBe('whatever the dates');
  });

  it('names the chip in the list’s words', () => {
    expect(callExportTypeWords('all')).toBe('all call types');
    expect(callExportTypeWords('soft_phone')).toBe('Soft phone');
    expect(callExportTypeWords('to_follow_up')).toBe('To follow up');
  });

  it('joins the count, dates and type, and leaves out a count not known yet', () => {
    expect(callExportSubtitle(4812, '20 Nov', 'Dialler')).toBe('4,812 calls · 20 Nov · Dialler');
    expect(callExportSubtitle(1, '20 Nov', 'Dialler')).toBe('1 call · 20 Nov · Dialler');
    expect(callExportSubtitle(null, 'every date', 'all call types')).toBe('Every date · all call types');
    expect(callExportSubtitle(12, 'every date', 'all call types')).toBe('12 calls · every date · all call types');
  });
});

describe('callExportFieldsRefusal', () => {
  it('maps the two refusals and nothing else', () => {
    expect(callExportFieldsRefusal(new ApiError(403, { code: 'export_fields_not_permitted', message: 'x' })))
      .toBe(EXPORT_FIELDS_NOT_PERMITTED_COPY);
    expect(callExportFieldsRefusal(new ApiError(400, { code: 'export_fields_invalid', message: 'x' })))
      .toBe(EXPORT_FIELDS_INVALID_COPY);
    expect(callExportFieldsRefusal(new ApiError(500, { message: 'x' }))).toBeNull();
    expect(callExportFieldsRefusal(new Error('offline'))).toBeNull();
  });
});

describe('the remembered choice in storage', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    window.localStorage.clear();
  });

  it('is kept under the user, tenant, account and campaign', () => {
    expect(callExportFieldsKey('u-1', 't-1', 'a-1', 'c-1')).toBe('magick.callExport.fields.v1:u-1:t-1:a-1:c-1');
  });

  it('reads back what was written, and an empty choice forgets it', () => {
    const key = callExportFieldsKey('u-1', 't-1', 'a-1', 'c-1');
    writeRememberedFields(key, ['ai_summary', 'dim_x']);
    expect(readRememberedFields(key)).toEqual(['ai_summary', 'dim_x']);
    writeRememberedFields(key, []);
    expect(window.localStorage.getItem(key)).toBeNull();
    writeRememberedFields(key, ['ai_summary']);
    writeRememberedFields(key, null);
    expect(readRememberedFields(key)).toBeNull();
  });

  it('reads nothing from a value that is not a list of names', () => {
    const key = 'k';
    window.localStorage.setItem(key, '{"a":1}');
    expect(readRememberedFields(key)).toBeNull();
    window.localStorage.setItem(key, 'not json');
    expect(readRememberedFields(key)).toBeNull();
    window.localStorage.setItem(key, '[1,"ai_summary"]');
    expect(readRememberedFields(key)).toEqual(['ai_summary']);
    expect(readRememberedFields(null)).toBeNull();
  });

  it('never throws when storage is blocked', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new Error('blocked'); });
    expect(readRememberedFields('k')).toBeNull();
    expect(() => writeRememberedFields('k', ['ai_summary'])).not.toThrow();
    expect(() => writeRememberedFields('k', null)).not.toThrow();
  });
});
