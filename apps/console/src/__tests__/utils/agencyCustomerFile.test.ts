import { describe, expect, it } from 'vitest';
import { CUSTOMER_FILE_ACCEPT, sheetNotice, uploadBaseName } from '../../utils/agencyCustomerFile';

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
    // Only the last extension, and only those two.
    expect(uploadBaseName('export.csv.xlsx')).toBe('export.csv');
    expect(uploadBaseName('old.xls')).toBe('old.xls');
    expect(uploadBaseName('xlsx')).toBe('xlsx');
  });

  it('says nothing about sheets for a CSV', () => {
    expect(sheetNotice({})).toBeNull();
    expect(sheetNotice(null)).toBeNull();
  });

  it('names the sheet read, and the ones that were not', () => {
    expect(sheetNotice({ sheet: { name: 'Customers', other_sheet_names: [] } })).toEqual({
      read: 'Read from the sheet ‘Customers’.',
      others: null,
    });
    expect(sheetNotice({ sheet: { name: 'Customers', other_sheet_names: ['Paid'] } })?.others).toBe(
      'This file has 1 other sheet (‘Paid’) that was not read. To import it, move those customers to the first sheet, or save that sheet as its own file.',
    );
    expect(sheetNotice({ sheet: { name: 'Customers', other_sheet_names: ['Paid', 'Archive'] } })?.others).toBe(
      'This file has 2 other sheets (‘Paid’, ‘Archive’) that were not read. To import them, move those customers to the first sheet, or save each sheet as its own file.',
    );
  });

  it('quotes each other sheet, so a name with a comma reads as one sheet', () => {
    expect(sheetNotice({ sheet: { name: 'All', other_sheet_names: ['North, East'] } })?.others).toBe(
      'This file has 1 other sheet (‘North, East’) that was not read. To import it, move those customers to the first sheet, or save that sheet as its own file.',
    );
    expect(sheetNotice({ sheet: { name: 'All', other_sheet_names: ['North, East', 'South'] } })?.others).toMatch(
      /^This file has 2 other sheets \(‘North, East’, ‘South’\) that were not read\./,
    );
  });
});
