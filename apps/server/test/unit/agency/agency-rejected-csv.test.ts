import { describe, it, expect } from 'vitest';
import {
  rejectedCsvHeader,
  rejectedCsvRow,
  renderRejectedCsv,
  REJECTED_REASON_COLUMN,
} from '../../../src/agency/agency-rejected-csv.js';
import { Readable } from 'node:stream';
import {
  ingestAgencyCsv,
  ROW_REASON,
  type AgencyIngestContact,
  type AgencyIngestRejection,
} from '../../../src/agency/agency-csv-ingest.js';

function rejection(overrides: Partial<AgencyIngestRejection> = {}): AgencyIngestRejection {
  return {
    row_number: 88,
    column: 'Mobile',
    raw_value: '9820-41772x',
    reason_code: 'invalid_phone',
    reason: "'9820-41772x' is not a valid phone number.",
    context: { Name: 'Asha', City: 'Mumbai' },
    ...overrides,
  };
}

describe('rejected-rows CSV export', () => {
  it('emits the original columns plus a `_reason` column', async () => {
    const header = rejectedCsvHeader('Mobile', ['Name', 'City']);
    expect(header).toBe('_row,Mobile,Name,City,_reason\n');
    expect(header).toContain(REJECTED_REASON_COLUMN);
  });

  it('reproduces the row so it can be fixed in Excel and re-uploaded', async () => {
    const row = rejectedCsvRow(rejection(), ['Name', 'City']);
    expect(row).toBe('88,9820-41772x,Asha,Mumbai,\'9820-41772x\' is not a valid phone number.\n');
  });

  it('quotes values containing commas, quotes or newlines', async () => {
    const row = rejectedCsvRow(
      rejection({ context: { Name: 'Doe, Jane', City: 'say "hi"', Note: 'a\nb' } }),
      ['Name', 'City', 'Note'],
    );
    expect(row).toContain('"Doe, Jane"');
    expect(row).toContain('"say ""hi"""');
    expect(row).toContain('"a\nb"');
  });

  it('renders a missing context value as empty rather than `undefined`', async () => {
    const row = rejectedCsvRow(rejection({ context: { Name: 'Asha' } }), ['Name', 'City']);
    expect(row).toBe("88,9820-41772x,Asha,,'9820-41772x' is not a valid phone number.\n");
    expect(row).not.toContain('undefined');
  });

  it('omits ignored columns, so the export is not the leak `Ignore` prevented', async () => {
    // `context` never contains an ignored column, and the export reads only from
    // `context` — so an ignored column cannot reappear here.
    const row = rejectedCsvRow(
      rejection({ context: { Name: 'Asha' } }),
      ['Name'],
    );
    expect(row).not.toContain('Mumbai');
  });

  it('streams a full document from an async source', async () => {
    async function* source(): AsyncGenerator<AgencyIngestRejection> {
      yield rejection({ row_number: 2, raw_value: 'abc', reason: 'Not a valid phone number' });
      yield rejection({
        row_number: 3,
        raw_value: '',
        reason_code: 'missing_phone_value',
        reason: 'Empty phone number',
        context: { Name: 'Ravi', City: 'Pune' },
      });
    }

    let document = '';
    for await (const chunk of renderRejectedCsv('Mobile', ['Name', 'City'], source())) {
      document += chunk;
    }

    expect(document).toBe(
      '_row,Mobile,Name,City,_reason\n' +
        '2,abc,Asha,Mumbai,Not a valid phone number\n' +
        '3,,Ravi,Pune,Empty phone number\n',
    );
  });
});

describe('spreadsheet formulas (IM6): the downloads are opened in Excel or Sheets', () => {
  it('neutralises a cell that would be read as a formula, the phone cell and the operator\'s columns alike', () => {
    const row = rejectedCsvRow(
      rejection({ raw_value: '+919876543001', context: { Name: '=HYPERLINK("http://x","y")', City: '@SUM(A1)', Note: ' -2+3' } }),
      ['Name', 'City', 'Note'],
    );
    expect(row).toBe(`88,'+919876543001,"'=HYPERLINK(""http://x"",""y"")",'@SUM(A1),' -2+3,'9820-41772x' is not a valid phone number.\n`);
    // A header is a cell too.
    expect(rejectedCsvHeader('+Mobile', ['=Name'])).toBe("_row,'+Mobile,'=Name,_reason\n");
  });

  it('no reason starts with a formula character: a duplicate names its row in words, never the number', () => {
    const reasons = [
      ROW_REASON.missingPhone('Mobile'), ROW_REASON.invalidPhone('+12', '91'), ROW_REASON.duplicatePhone(2),
      ROW_REASON.duplicateKey('Loan No', 2), ROW_REASON.ragged(4, 3), ROW_REASON.valueTooLarge('Notes', 8192),
      ROW_REASON.rowTooLarge(65536), ROW_REASON.dnc('campaign'), ROW_REASON.alreadyInCampaign(),
    ];
    for (const reason of reasons) expect(reason).not.toMatch(/^[=+\-@\t\r]/);
    expect(ROW_REASON.duplicatePhone(2)).toBe(
      'The same phone number is already on row 2 of this file, so this row was left out. Delete one of the two rows, or keep both by choosing "Don\'t remove duplicates".',
    );
  });

  it('a downloaded row fixed and uploaded again imports as the values it had, apostrophes and all undone', async () => {
    const document = rejectedCsvHeader('Mobile', ['Name', 'Balance'])
      + rejectedCsvRow(rejection({ raw_value: '+919876543001', context: { Name: 'Asha', Balance: '-1200' } }), ['Name', 'Balance'])
      // A value that only looks guarded keeps its apostrophe: only the guard's own is read back off.
      + rejectedCsvRow(rejection({ row_number: 89, raw_value: '+919876543002', context: { Name: "'Ravi'", Balance: '0' } }), ['Name', 'Balance']);
    expect(document).toContain("'+919876543001");

    const contacts: AgencyIngestContact[] = [];
    const summary = await ingestAgencyCsv({
      source: Readable.from([Buffer.from(document, 'utf8')]),
      phoneColumn: 'Mobile',
      ignoreColumns: ['_row', '_reason'],
      onBatch: (batch) => { contacts.push(...batch); },
    });
    expect(summary.rejected).toBe(0);
    expect(contacts.map((c) => [c.phone_e164, c.context])).toEqual([
      ['+919876543001', { Name: 'Asha', Balance: '-1200' }],
      ['+919876543002', { Name: "'Ravi'", Balance: '0' }],
    ]);
  });
});
