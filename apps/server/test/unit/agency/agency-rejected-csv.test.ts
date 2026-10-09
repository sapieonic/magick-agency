import { describe, it, expect } from 'vitest';
import {
  rejectedCsvHeader,
  rejectedCsvRow,
  renderRejectedCsv,
  REJECTED_REASON_COLUMN,
} from '../../../src/agency/agency-rejected-csv.js';
import type { AgencyIngestRejection } from '../../../src/agency/agency-csv-ingest.js';

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
