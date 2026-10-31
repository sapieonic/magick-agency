import { describe, it, expect } from 'vitest';
import {
  cleanFieldValues,
  fieldValueFromInput,
  formatFieldValue,
  validateCallFieldValues,
  FIELD_REQUIRED_COPY,
} from '../../utils/softphone/callFields';
import {
  editFieldRows,
  keyFromLabel,
  removedSavedKeys,
  rowsFromFields,
  validateCallFieldRows,
  newFieldRow,
} from '../../utils/softphone/fieldSettings';
import { draftFromSettings, payloadFromDraft, validateSettingsDraft } from '../../utils/softphone/settingsForm';
import { overrideNoteBlock, overrideNoteLength, withOverride } from '../../utils/softphone/overrides';
import { refusalCopy, SOFTPHONE_REFUSAL_COPY } from '../../utils/softphone/refusalCopy';
import { summariseCalls, queryFromDraft, EMPTY_SOFTPHONE_CALLS_DRAFT } from '../../utils/softphone/callStats';
import { AGENCY_SOFTPHONE_ERROR_CODES, type AgencyCallField } from '../../types/softphone';
import { manualCall } from '../helpers/softphone';

const FIELDS: AgencyCallField[] = [
  { key: 'customer_name', label: 'Customer name', type: 'text', required: true },
  { key: 'amount', label: 'Amount', type: 'number' },
  { key: 'reason', label: 'Reason', type: 'choice', options: ['Rate query', 'Documents'], required: true },
  { key: 'follow_up', label: 'Follow-up', type: 'boolean' },
  { key: 'due', label: 'Due date', type: 'date' },
];

describe('call-field values', () => {
  it('lets a required field be empty while live, and not when the outcome is saved', () => {
    expect(validateCallFieldValues(FIELDS, {}, { requireFilled: false })).toEqual({});
    const saving = validateCallFieldValues(FIELDS, { customer_name: '  ' }, { requireFilled: true });
    expect(saving).toEqual({ customer_name: FIELD_REQUIRED_COPY, reason: FIELD_REQUIRED_COPY });
  });

  it('refuses a value of the wrong type for its field', () => {
    const errors = validateCallFieldValues(
      FIELDS,
      { amount: 'abc', reason: 'Other', follow_up: 'yes', due: '2026-02-30' },
      { requireFilled: false },
    );
    expect(Object.keys(errors).sort()).toEqual(['amount', 'due', 'follow_up', 'reason']);
  });

  it('types an input for its field, and empty text is absent', () => {
    expect(fieldValueFromInput(FIELDS[1]!, '12.5')).toBe(12.5);
    expect(fieldValueFromInput(FIELDS[1]!, 'x')).toBe('x');
    expect(fieldValueFromInput(FIELDS[0]!, '')).toBeNull();
    expect(fieldValueFromInput(FIELDS[3]!, true)).toBe(true);
  });

  it('sends only this set’s keys, trimmed, with empties left out', () => {
    expect(
      cleanFieldValues(FIELDS, { customer_name: ' Rahul ', amount: null, stray: 'x', follow_up: false }),
    ).toEqual({ customer_name: 'Rahul', follow_up: false });
  });

  it('reads a value back for a person', () => {
    expect(formatFieldValue(FIELDS[3], true)).toBe('Yes');
    expect(formatFieldValue(FIELDS[4], '2026-11-14')).toBe('14 Nov 2026');
    expect(formatFieldValue(FIELDS[0], '')).toBeNull();
  });
});

describe('the call-fields editor', () => {
  it('follows the label with a new field’s key, until the admin types one', () => {
    let rows = editFieldRows([], { type: 'add' });
    rows = editFieldRows(rows, { type: 'label', index: 0, label: 'Loan account no.' });
    expect(rows[0]!.key).toBe('loan_account_no');
    rows = editFieldRows(rows, { type: 'key', index: 0, key: 'loan' });
    rows = editFieldRows(rows, { type: 'label', index: 0, label: 'Loan' });
    expect(rows[0]!.key).toBe('loan');
  });

  it('never changes a saved field’s key', () => {
    let rows = rowsFromFields(FIELDS);
    rows = editFieldRows(rows, { type: 'key', index: 0, key: 'renamed' });
    rows = editFieldRows(rows, { type: 'label', index: 0, label: 'Full name' });
    expect(rows[0]!.key).toBe('customer_name');
    expect(rows[0]!.label).toBe('Full name');
  });

  it('caps the set at 20', () => {
    let rows = Array.from({ length: 20 }, () => newFieldRow());
    rows = editFieldRows(rows, { type: 'add' });
    expect(rows).toHaveLength(20);
  });

  it('validates the key pattern, uniqueness, labels and choice options', () => {
    const rows = [
      { ...newFieldRow(), key: 'Bad Key', label: 'A' },
      { ...newFieldRow(), key: 'dup', label: 'B' },
      { ...newFieldRow(), key: 'dup', label: '' },
      { ...newFieldRow(), key: 'pick', label: 'C', type: 'choice' as const, optionsText: 'x\nx' },
      { ...newFieldRow(), key: '1st', label: 'D', type: 'choice' as const, optionsText: '' },
    ];
    const errors = validateCallFieldRows(rows);
    expect(Object.keys(errors).sort()).toEqual([
      'call_fields[0].key',
      'call_fields[2].key',
      'call_fields[2].label',
      'call_fields[3].options',
      'call_fields[4].key',
      'call_fields[4].options',
    ]);
    expect(keyFromLabel('123 Go!')).toBe('go');
  });

  it('names saved keys that the draft drops', () => {
    const rows = rowsFromFields(FIELDS).slice(1);
    expect(removedSavedKeys(FIELDS, rows)).toEqual(['customer_name']);
  });

  it('round-trips settings and holds the outcome list to the campaign builder’s rules', () => {
    const draft = draftFromSettings({
      disposition_catalog: [],
      call_fields: FIELDS,
      analysis_profile_id: null,
      record_calls: true,
      default_caller_id: '+912248908888',
      updated_at: null,
    });
    expect(payloadFromDraft(draft)).toEqual({
      disposition_catalog: [],
      call_fields: FIELDS,
      analysis_profile_id: null,
      record_calls: true,
      default_caller_id: '+912248908888',
    });
    expect(validateSettingsDraft(draft)).toEqual({});
    const bad = { ...draft, catalog: [{ code: 'Bad Code', label: '' }] };
    expect(Object.keys(validateSettingsDraft(bad)).sort()).toEqual([
      'disposition_catalog[0].code',
      'disposition_catalog[0].label',
    ]);
  });
});

describe('override notes', () => {
  it('needs 10–500 characters after trimming', () => {
    expect(overrideNoteBlock('   short   ')).toBe('too_short');
    expect(overrideNoteBlock('Customer asked for this')).toBeNull();
    // Characters, as the server and the database count them: an emoji is one, not two
    // UTF-16 units (nine characters stay too short; 500 with an emoji are not too long).
    expect(overrideNoteLength('12345678😀')).toBe(9);
    expect(overrideNoteBlock('12345678😀')).toBe('too_short');
    expect(overrideNoteBlock(`${'x'.repeat(499)}😀`)).toBeNull();
    expect(overrideNoteBlock(`${'x'.repeat(500)}😀`)).toBe('too_long');
    expect(overrideNoteBlock('x'.repeat(501))).toBe('too_long');
  });

  it('keeps the first override when the second refusal arrives', () => {
    const first = withOverride({}, 'dnc', '  Customer called us back first ');
    expect(withOverride(first, 'hours', 'They asked for a call now')).toEqual({
      dnc_note: 'Customer called us back first',
      hours_note: 'They asked for a call now',
    });
  });
});

describe('refusal copy', () => {
  it('gives the refusals an agent can hit by mistake a next step, not just a fact', () => {
    expect(SOFTPHONE_REFUSAL_COPY.wrong_session_kind).toMatch(/Close the soft phone, then join the campaign/);
    expect(SOFTPHONE_REFUSAL_COPY.call_not_found).toMatch(/Reload the page/);
    expect(SOFTPHONE_REFUSAL_COPY.fields_invalid).toMatch(/marked in Call details/);
  });

  it('a status change Redis did not take is not a call that was not placed', () => {
    const refusal = { code: 'dial_failed', status: 503, message: 'x' } as const;
    expect(refusalCopy(refusal)).toMatch(/call couldn’t be placed/);
    expect(refusalCopy(refusal, 'status')).toBe('Couldn’t change your status just now; nothing changed. Try again.');
    expect(refusalCopy(refusal, 'status')).not.toMatch(/call|dialled/i);
    // Codes the status context does not reword keep their one sentence.
    expect(refusalCopy({ code: 'session_not_found', status: 404, message: 'x' }, 'status')).toBe(SOFTPHONE_REFUSAL_COPY.session_not_found);
    expect(refusalCopy({ code: 'unknown', raw_code: 'boom', status: 500, message: 'The server’s words' }, 'status')).toBe('The server’s words');
  });

  it('has a sentence for every soft-phone code', () => {
    for (const code of AGENCY_SOFTPHONE_ERROR_CODES) {
      expect(SOFTPHONE_REFUSAL_COPY[code], code).toMatch(/\S/);
    }
  });
});

describe('the list’s stats strip and query', () => {
  it('counts the rows on screen', () => {
    const stats = summariseCalls([
      manualCall({ id: 'a', state: 'ended', outcome: 'connected', bridged_at: 'x', talk_seconds: 120, settled_at: 'y' }),
      manualCall({ id: 'b', state: 'ended', outcome: 'connected', bridged_at: 'x', talk_seconds: 60, requires_disposition: true, tag: { campaign_id: 'c', campaign_name: 'C' } }),
      manualCall({ id: 'c', state: 'ended', outcome: 'no_answer', settled_at: 'y' }),
    ]);
    expect(stats).toEqual({ calls: 3, connected: 2, avgTalkSeconds: 90, notLogged: 2, awaitingOutcome: 1 });
  });

  it('turns the draft into the §6 query, the “to” day inclusive', () => {
    const query = queryFromDraft(
      { ...EMPTY_SOFTPHONE_CALLS_DRAFT, from: '2026-10-30', to: '2026-10-30', campaignId: 'untagged', outcome: 'busy', phone: '+91 98204' },
      { agentUserId: 'u-1' },
    );
    expect(query).toEqual({
      from: new Date('2026-10-30T00:00:00').toISOString(),
      to: new Date('2026-10-31T00:00:00').toISOString(),
      agent_user_id: 'u-1',
      campaign_id: 'untagged',
      outcome: 'busy',
      phone: '9198204',
    });
  });
});
