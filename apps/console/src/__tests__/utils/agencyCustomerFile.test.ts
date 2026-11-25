import { describe, expect, it } from 'vitest';
import { ApiError } from '../../api/client';
import {
  CUSTOMER_FILE_ACCEPT,
  isWorkbookFile,
  sheetNotice,
  uploadBaseName,
  uploadErrorMessage,
} from '../../utils/agencyCustomerFile';
import type { AgencyUploadSheet } from '../../types/agency-campaign';
import { WORKBOOK_TOO_LARGE } from '../helpers/uploadRefusals';

/** A sheet as the server sends it: the names, cut at 255, and the true count. */
function sheet(name: string, others: string[], count = others.length): { sheet: AgencyUploadSheet } {
  return { sheet: { name, other_sheet_names: others, other_sheet_count: count } };
}

const MB_512 = 512 * 1024 * 1024;

describe('the customer file (CS7)', () => {
  it('takes .csv and .xlsx by extension and type, never a legacy .xls', () => {
    expect(CUSTOMER_FILE_ACCEPT).not.toMatch(/xlsm|macroEnabled/i);
    expect(CUSTOMER_FILE_ACCEPT.split(',')).toEqual([
      '.csv',
      'text/csv',
      '.xlsx',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ]);
  });

  it('names a download from the upload without its .csv, .xlsx or .xlsm, whatever the case (the server’s rule)', () => {
    expect(uploadBaseName('Customers.xlsx')).toBe('Customers');
    expect(uploadBaseName('Customers May.XLSX')).toBe('Customers May');
    expect(uploadBaseName('nov list.CSV')).toBe('nov list');
    // A macro workbook: not offered by the picker, but the server reads a workbook by its content.
    expect(uploadBaseName('Customers.xlsm')).toBe('Customers');
    expect(uploadBaseName('Customers.XLSM')).toBe('Customers');
    // Only the last extension, and only those three.
    expect(uploadBaseName('export.csv.xlsx')).toBe('export.csv');
    expect(uploadBaseName('old.xls')).toBe('old.xls');
    expect(uploadBaseName('xlsx')).toBe('xlsx');
  });

  it('knows a workbook by its name or its type, to say the upload is also being read', () => {
    expect(isWorkbookFile(new File(['PK'], 'Customers.xlsx'))).toBe(true);
    expect(isWorkbookFile(new File(['PK'], 'Macros.XLSM'))).toBe(true);
    expect(isWorkbookFile(new File(['PK'], 'no-extension', { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }))).toBe(true);
    expect(isWorkbookFile(new File(['a'], 'list.csv', { type: 'text/csv' }))).toBe(false);
  });
});

describe('the sheet notice (CS7)', () => {
  it('says nothing about sheets for a CSV', () => {
    expect(sheetNotice({})).toBeNull();
    expect(sheetNotice(null)).toBeNull();
  });

  it('names the sheet read, and nothing more when it is the only one', () => {
    expect(sheetNotice(sheet('Customers', []))).toEqual({ read: 'Read from the sheet ‘Customers’.', others: null });
  });

  it('names one other sheet, and the sheet to move its customers to (the one read, not "the first")', () => {
    expect(sheetNotice(sheet('Customers', ['Paid']))?.others).toBe(
      'This file has 1 other sheet (‘Paid’) that was not read. To import it, move those customers to the sheet ‘Customers’, or save that sheet as its own file.',
    );
  });

  it('names several other sheets, each in quotes', () => {
    expect(sheetNotice(sheet('Customers', ['Paid', 'Archive']))?.others).toBe(
      'This file has 2 other sheets (‘Paid’, ‘Archive’) that were not read. To import them, move those customers to the sheet ‘Customers’, or save each sheet as its own file.',
    );
    // A name with a comma is one sheet.
    expect(sheetNotice(sheet('All', ['North, East']))?.others).toBe(
      'This file has 1 other sheet (‘North, East’) that was not read. To import it, move those customers to the sheet ‘All’, or save that sheet as its own file.',
    );
  });

  it('lists at most five, then says how many more', () => {
    expect(sheetNotice(sheet('Customers', ['A', 'B', 'C', 'D', 'E']))?.others).toMatch(
      /^This file has 5 other sheets \(‘A’, ‘B’, ‘C’, ‘D’, ‘E’\) that were not read\./,
    );
    expect(sheetNotice(sheet('Customers', ['A', 'B', 'C', 'D', 'E', 'F']))?.others).toMatch(
      /^This file has 6 other sheets \(‘A’, ‘B’, ‘C’, ‘D’, ‘E’ and 1 more\) that were not read\./,
    );
  });

  it('counts from other_sheet_count: the names stop at 255, the sheets do not', () => {
    const names = Array.from({ length: 255 }, (_, i) => `Day ${i + 1}`);
    expect(sheetNotice(sheet('Summary', names, 1_300))?.others).toBe(
      'This file has 1,300 other sheets (‘Day 1’, ‘Day 2’, ‘Day 3’, ‘Day 4’, ‘Day 5’ and 1,295 more) that were not read. '
      + 'To import them, move those customers to the sheet ‘Summary’, or save each sheet as its own file.',
    );
  });
});

describe('an upload refused for its size (413)', () => {
  it('uses the server’s words when it says file_too_large', () => {
    const err = new ApiError(413, WORKBOOK_TOO_LARGE.body);
    expect(uploadErrorMessage(err, MB_512)).toBe(WORKBOOK_TOO_LARGE.body.message);
  });

  it('says it plainly, with the limit the page knows, for any other 413 (an HTML page from the proxy, or a bare one)', () => {
    // Behind nginx a 413 is an HTML page: no JSON body, so the client's text is "API error 413".
    expect(uploadErrorMessage(new ApiError(413, undefined), MB_512)).toBe('This file is too large. A file can be up to 512 MB.');
    expect(uploadErrorMessage(new ApiError(413, { error: 'Payload Too Large', message: 'request file too large' }), MB_512))
      .toBe('This file is too large. A file can be up to 512 MB.');
    expect(uploadErrorMessage(new ApiError(413, undefined), 2 * 1024 * 1024 * 1024)).toBe('This file is too large. A file can be up to 2,048 MB.');
    expect(uploadErrorMessage(new ApiError(413, undefined), null)).toBe('This file is too large to upload.');
  });

  it('leaves every other refusal in the server’s words', () => {
    const message = 'Another Excel file is being read just now. Try again in a minute.';
    expect(uploadErrorMessage(new ApiError(429, { error: 'Too Many Requests', code: 'workbook_busy', message, retry_after_seconds: 60 }), MB_512)).toBe(message);
    expect(uploadErrorMessage(new Error('Could not reach the server.'), MB_512)).toBe('Could not reach the server.');
    expect(uploadErrorMessage('nonsense', MB_512)).toBe('Could not read that file.');
  });
});
