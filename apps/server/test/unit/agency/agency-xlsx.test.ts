import { describe, it, expect } from 'vitest';
import { Readable } from 'node:stream';
import {
  classifyNumberFormat,
  excelSerialToText,
  openXlsxWorkbook,
  parseCellRef,
  plainNumber,
  type XlsxLimits,
} from '../../../src/agency/agency-xlsx.js';
import {
  detectUploadFormat,
  isWorkbookName,
  xlsxRefusalMessage,
  XlsxLimitError,
  XlsxRefusal,
  XLSX_MAX_CELL_CHARS,
} from '../../../src/agency/agency-xlsx-refusals.js';
import {
  ingestAgencyCsv,
  type AgencyIngestContact,
  type AgencyIngestRejection,
} from '../../../src/agency/agency-csv-ingest.js';
import { compoundFile, excelParts, exceljsWorkbook, handWorkbook, zipParts } from '../../helpers/xlsx-fixtures.js';

/*
 * The Excel upload's conversion (IM8). Each `describe` is one rule of the ruling; the
 * hand-built workbooks (`excelParts`) are laid out as Excel writes them, the others are
 * written by exceljs.
 */

const LIMITS: XlsxLimits = { maxDataRows: 1_000_000, maxColumns: 100, maxCsvBytes: 512 * 1024 * 1024 };

async function convert(buf: Buffer, limits: Partial<XlsxLimits> = {}) {
  const workbook = await openXlsxWorkbook(buf, { ...LIMITS, ...limits });
  const chunks: Buffer[] = [];
  for await (const chunk of workbook.toCsv() as AsyncIterable<Buffer>) chunks.push(chunk);
  return { workbook, csv: Buffer.concat(chunks).toString('utf8') };
}

async function refusal(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error('expected a refusal');
}

/** The CSV read by the real ingest, as the check would read it. */
async function ingest(csv: string, phoneColumn: string) {
  const contacts: AgencyIngestContact[] = [];
  const rejections: AgencyIngestRejection[] = [];
  const summary = await ingestAgencyCsv({
    source: Readable.from([Buffer.from(csv, 'utf8')]),
    phoneColumn,
    onBatch: (batch) => { contacts.push(...batch); },
    onRejected: (r) => { rejections.push(r); },
  });
  return { summary, contacts, rejections };
}

const row = (r: number, cells: string) => `<row r="${r}">${cells}</row>`;
const inline = (ref: string, text: string) => `<c r="${ref}" t="inlineStr"><is><t>${text}</t></is></c>`;
const num = (ref: string, v: string, s?: number) => `<c r="${ref}"${s !== undefined ? ` s="${s}"` : ''}><v>${v}</v></c>`;
const shared = (ref: string, index: number) => `<c r="${ref}" t="s"><v>${index}</v></c>`;

// ─── Detection ──────────────────────────────────────────────────────────────

describe('detectUploadFormat: by the bytes, then the name', () => {
  it('reads a zip as a workbook whatever it is called, and text as CSV unless it is named .xlsx', async () => {
    const zip = handWorkbook({ sheets: [{ name: 'Sheet1' }] });
    expect(detectUploadFormat(zip, 'customers.xlsx')).toBe('xlsx');
    expect(detectUploadFormat(zip, 'customers.csv')).toBe('xlsx');
    expect(detectUploadFormat(Buffer.from('Mobile\n9876543210\n'), 'customers.csv')).toBe('csv');
    expect(detectUploadFormat(Buffer.from('Mobile\n9876543210\n'), 'customers.xls')).toBe('csv');
    expect(detectUploadFormat(Buffer.from('Mobile\n9876543210\n'), 'customers.txt')).toBe('csv');
  });

  it('refuses an .xls or a password-protected workbook (a compound file) under any name, in words covering both', () => {
    for (const name of ['customers.xls', 'customers.xlsx', 'customers.csv']) {
      const err = (() => { try { detectUploadFormat(compoundFile(), name); } catch (e) { return e; } return null; })();
      expect(err).toBeInstanceOf(XlsxRefusal);
      expect((err as XlsxRefusal).kind).toBe('legacy_or_encrypted');
    }
    expect(xlsxRefusalMessage('legacy_or_encrypted')).toBe(
      'This is an older Excel file (.xls) or a workbook with a password, which cannot be read. '
      + 'Open it in Excel and save it as an Excel Workbook (.xlsx) without a password, or as CSV, then upload it again.',
    );
  });

  it('refuses text named .xlsx rather than reading it as CSV', () => {
    expect(() => detectUploadFormat(Buffer.from('Mobile\n9876543210\n'), 'customers.XLSX')).toThrow(XlsxRefusal);
  });
});

// ─── Which sheet ────────────────────────────────────────────────────────────

describe('which sheet: the first visible worksheet in tab order', () => {
  it('skips a hidden first sheet and a chart sheet, and names the other visible worksheets in tab order', async () => {
    const buf = handWorkbook({
      sheets: [
        { name: 'Lookup', state: 'hidden', xml: `<sheetData>${row(1, inline('A1', 'secret'))}</sheetData>` },
        { name: 'Chart', chart: true },
        { name: 'Customers', xml: `<sheetData>${row(1, inline('A1', 'Mobile'))}${row(2, num('A2', '9876543210'))}</sheetData>` },
        { name: 'Very hidden', state: 'veryHidden', xml: '<sheetData/>' },
        { name: 'Archive', xml: '<sheetData/>' },
        { name: 'Notes', state: 'visible', xml: '<sheetData/>' },
      ],
    });
    const { workbook, csv } = await convert(buf);
    expect(workbook.sheet).toEqual({ name: 'Customers', other_sheet_names: ['Archive', 'Notes'], other_sheet_count: 2 });
    expect(csv).toBe('Mobile\n9876543210\n');
  });

  it('follows tab order, not the order of the parts in the zip or their file names', async () => {
    // exceljs writes sheet1.xml for the first sheet it was given; the tabs are reordered by
    // `orderNo`, so the first tab is the SECOND sheet added.
    const buf = await exceljsWorkbook((wb) => {
      const a = wb.addWorksheet('Added first');
      a.addRow(['from the first part']);
      const b = wb.addWorksheet('Added second');
      b.addRow(['from the second part']);
      // `orderNo` is exceljs's tab position; its typings leave it out.
      (a as unknown as { orderNo: number }).orderNo = 2;
      (b as unknown as { orderNo: number }).orderNo = 1;
    });
    const { workbook, csv } = await convert(buf);
    expect(workbook.sheet.name).toBe('Added second');
    expect(csv).toBe('from the second part\n');
  });

  it('reads a hidden first sheet written by exceljs as hidden', async () => {
    const buf = await exceljsWorkbook((wb) => {
      wb.addWorksheet('Hidden', { state: 'hidden' }).addRow(['no']);
      wb.addWorksheet('Shown').addRow(['yes']);
    });
    const { workbook, csv } = await convert(buf);
    expect(workbook.sheet).toEqual({ name: 'Shown', other_sheet_names: [], other_sheet_count: 0 });
    expect(csv).toBe('yes\n');
  });

  it('refuses a workbook with no visible worksheet', async () => {
    const hiddenOnly = handWorkbook({ sheets: [{ name: 'A', state: 'hidden', xml: '<sheetData/>' }, { name: 'Chart', chart: true }] });
    const err = await refusal(openXlsxWorkbook(hiddenOnly, LIMITS));
    expect(err).toBeInstanceOf(XlsxRefusal);
    expect((err as XlsxRefusal).kind).toBe('no_visible_sheet');
  });

  it('reads parts whose relationship targets are absolute, and SpreadsheetML written with a prefix', async () => {
    const buf = handWorkbook({
      absoluteTargets: true,
      prefix: 'x',
      sheets: [{ name: 'S', xml: `<x:sheetData><x:row r="1"><x:c r="A1" t="inlineStr"><x:is><x:t>Mobile</x:t></x:is></x:c></x:row><x:row r="2"><x:c r="A2"><x:v>9876543210</x:v></x:c></x:row></x:sheetData>` }],
    });
    expect((await convert(buf)).csv).toBe('Mobile\n9876543210\n');
  });
});

// ─── Refusals: not a readable workbook ──────────────────────────────────────

describe('a zip that is not a readable workbook is refused', () => {
  it.each([
    ['a zip with no workbook in it (a Word file, an .ods)', zipParts([['word/document.xml', '<w/>']])],
    ['a truncated workbook', handWorkbook({ sheets: [{ name: 'S' }] }).subarray(0, 200)],
    ['a workbook whose sheet XML is broken', handWorkbook({ sheets: [{ name: 'S', xml: '<sheetData><row r="1"><c r="A1"><v>1</v></row></sheetData>' }] })],
    ['a workbook with an encrypted part', zipParts(excelParts({ sheets: [{ name: 'S' }] }), { forge: { 'xl/worksheets/sheet1.xml': { flags: 1 } } })],
    ['a workbook compressed in a way that cannot be read', zipParts(excelParts({ sheets: [{ name: 'S' }] }), { forge: { 'xl/worksheets/sheet1.xml': { method: 12 } } })],
    ['rows out of order', handWorkbook({ sheets: [{ name: 'S', xml: `<sheetData>${row(5, num('A5', '1'))}${row(2, num('A2', '1'))}</sheetData>` }] })],
    ['an entity the XML does not declare', handWorkbook({ sheets: [{ name: 'S', xml: `<sheetData>${row(1, inline('A1', '&boom;'))}</sheetData>` }] })],
  ])('%s', async (_label, buf) => {
    const err = await refusal(openXlsxWorkbook(buf, LIMITS));
    expect(err).toBeInstanceOf(XlsxRefusal);
    expect((err as XlsxRefusal).kind).toBe('unreadable');
  });
});

// ─── Cell values ────────────────────────────────────────────────────────────

describe('cell values, read as Excel shows them', () => {
  it('reads a hand-built workbook laid out as Excel writes it: shared strings after the sheet, inline strings, rich text, a shared formula', async () => {
    const buf = handWorkbook({
      sharedStrings:
        '<si><t>Mobile</t></si>'
        + '<si><t>Name</t></si>'
        + '<si><r><t>Asha </t></r><r><rPr><b/></rPr><t>Rao</t></r></si>'
        // A phonetic run (Japanese furigana) is not part of the text.
        + '<si><t>東京</t><rPh sb="0" eb="2"><t>トウキョウ</t></rPh></si>'
        + '<si><t>Line_x000D_ break and a literal _x005F_x0041_</t></si>',
      sheets: [{
        name: 'Customers',
        xml: '<sheetData>'
          + row(1, shared('A1', 0) + shared('B1', 1) + inline('C1', 'Total') + inline('D1', 'City'))
          + row(2, num('A2', '9876543210') + shared('B2', 2) + '<c r="C2"><f t="shared" ref="C2:C3" si="0">A2*2</f><v>19753086420</v></c>' + shared('D2', 3))
          // The shared formula's other cell carries only `si` and its cached value.
          + row(3, num('A3', '9123456780') + `<c r="B3" t="inlineStr"><is><r><t>Ravi</t></r><r><t> K</t></r></is></c>` + '<c r="C3"><f t="shared" si="0"/><v>18246913560</v></c>' + shared('D3', 4))
          + '</sheetData>',
      }],
    });
    expect((await convert(buf)).csv).toBe(
      'Mobile,Name,Total,City\n'
      + '9876543210,Asha Rao,19753086420,東京\n'
      + '9123456780,Ravi K,18246913560,"Line\r break and a literal _x0041_"\n',
    );
  });

  it('reads a formula as its cached result and as empty without one; booleans as TRUE/FALSE; errors as their text', async () => {
    const buf = handWorkbook({
      sheets: [{
        name: 'S',
        xml: '<sheetData>' + row(1,
          '<c r="A1" t="str"><f>"a"&amp;"b"</f><v>ab</v></c>'
          + '<c r="B1"><f>1/0</f></c>'
          + '<c r="C1" t="b"><f>1=1</f><v>1</v></c>'
          + '<c r="D1" t="b"><v>0</v></c>'
          + '<c r="E1" t="e"><f>NA()</f><v>#N/A</v></c>'
          + '<c r="F1" t="e"><v>#DIV/0!</v></c>'
          + '<c r="G1"><f>2+2</f><v>4</v></c>',
        ) + '</sheetData>',
      }],
    });
    expect((await convert(buf)).csv).toBe('ab,,TRUE,FALSE,#N/A,#DIV/0!,4\n');
  });

  it('reads rich text, hyperlinks, booleans, errors and formulas written by exceljs', async () => {
    const buf = await exceljsWorkbook((wb) => {
      const ws = wb.addWorksheet('S');
      ws.getCell('A1').value = { richText: [{ text: 'Asha ' }, { font: { bold: true }, text: 'Rao' }] };
      ws.getCell('B1').value = { text: 'Pay here', hyperlink: 'https://example.com/pay' };
      ws.getCell('C1').value = true;
      ws.getCell('D1').value = { error: '#REF!' };
      ws.getCell('E1').value = { formula: 'B2*2', result: 84 };
      ws.getCell('F1').value = { formula: 'NOW()' };
      ws.getCell('G1').value = { formula: 'B2&"x"', result: 'yx' };
    });
    expect((await convert(buf)).csv).toBe('Asha Rao,Pay here,TRUE,#REF!,84,,yx\n');
  });

  it('keeps Hindi text whole across the XML chunk boundaries (the streaming reader exceljs has does not)', async () => {
    const names = Array.from({ length: 20_000 }, (_, i) => `राजेश कुमार ${i}`);
    const buf = handWorkbook({
      sharedStrings: names,
      sheets: [{ name: 'S', xml: `<sheetData>${names.map((_, i) => row(i + 1, shared(`A${i + 1}`, i))).join('')}</sheetData>` }],
    });
    const { csv } = await convert(buf);
    expect(csv).not.toContain('�');
    expect(csv.split('\n').slice(0, -1)).toEqual(names);
  });
});

// ─── Numbers ────────────────────────────────────────────────────────────────

describe('numbers: whole numbers in full, leading zeros a format shows, 15 significant digits', () => {
  it('plainNumber', () => {
    expect(plainNumber(919876543210)).toBe('919876543210');
    expect(plainNumber(9.1987654321e11)).toBe('919876543210');
    expect(plainNumber(1e20)).toBe('100000000000000000000');
    // Past 1e21 `String` switches to an exponent; Excel holds numbers to about 1e308.
    expect(plainNumber(1e21)).toBe('1000000000000000000000');
    expect(plainNumber(0.1 + 0.2)).toBe('0.3');
    expect(plainNumber(1250.5)).toBe('1250.5');
    expect(plainNumber(-0)).toBe('0');
    expect(plainNumber(-42)).toBe('-42');
    expect(plainNumber(1.5e-7)).toBe('0.00000015');
    expect(plainNumber(-2.25e-10)).toBe('-0.000000000225');
    expect(plainNumber(123456.7890123456789)).toBe('123456.789012346');
  });

  it('writes phone numbers stored as numbers in full, padded to an all-zeros format', async () => {
    const buf = await exceljsWorkbook((wb) => {
      const ws = wb.addWorksheet('S');
      ws.addRow(['Mobile', 'Padded', 'Pin', 'Amount', 'Ratio']);
      ws.addRow([919876543210, 9876543210, 560001, 125000, 0.1 + 0.2]);
      ws.getCell('B2').numFmt = '00000000000';
      ws.getCell('C2').numFmt = '000000';
    });
    expect((await convert(buf)).csv).toBe('Mobile,Padded,Pin,Amount,Ratio\n919876543210,09876543210,560001,125000,0.3\n');
  });

  it('reads a number Excel wrote with an exponent in full', async () => {
    const buf = handWorkbook({ sheets: [{ name: 'S', xml: `<sheetData>${row(1, num('A1', '9.19876543210E+11') + num('B1', '1E-3'))}</sheetData>` }] });
    expect((await convert(buf)).csv).toBe('919876543210,0.001\n');
  });

  it('classifyNumberFormat', () => {
    expect(classifyNumberFormat('0000000000')).toMatchObject({ kind: 'pad', width: 10 });
    expect(classifyNumberFormat('General')).toEqual({ kind: 'plain' });
    // Number formats are compiled and rendered (`agency-xlsx-numfmt.test.ts`).
    for (const code of ['0', '#,##0.00_);[Red](#,##0.00)', '"Rs." #,##0', '[$₹-4009] #,##0', '0.00E+00', '"ID"00000']) {
      expect(classifyNumberFormat(code).kind, code).toBe('format');
    }
    expect(classifyNumberFormat('dd/mm/yyyy')).toEqual({ kind: 'date', hasTime: false });
    expect(classifyNumberFormat('dd/mm/yyyy hh:mm')).toEqual({ kind: 'date', hasTime: true });
    expect(classifyNumberFormat('[$-409]d-mmm-yy;@')).toEqual({ kind: 'date', hasTime: false });
    expect(classifyNumberFormat('mmmm')).toEqual({ kind: 'date', hasTime: false });
    expect(classifyNumberFormat('h:mm AM/PM')).toEqual({ kind: 'time', elapsed: false });
    expect(classifyNumberFormat('[h]:mm:ss')).toEqual({ kind: 'time', elapsed: true });
  });
});

// ─── Dates ──────────────────────────────────────────────────────────────────

describe('dates: YYYY-MM-DD, the time when it is not midnight, both date systems', () => {
  it('excelSerialToText', () => {
    const date = { kind: 'date', hasTime: false } as const;
    expect(excelSerialToText(46351, date, false)).toBe('2026-11-25');
    expect(excelSerialToText(46351.5, date, false)).toBe('2026-11-25 12:00');
    expect(excelSerialToText(46351 + (13 * 3600 + 5 * 60 + 9) / 86400, date, false)).toBe('2026-11-25 13:05:09');
    expect(excelSerialToText(1, date, false)).toBe('1900-01-01');
    expect(excelSerialToText(59, date, false)).toBe('1900-02-28');
    expect(excelSerialToText(60, date, false)).toBe('1900-02-29');
    expect(excelSerialToText(61, date, false)).toBe('1900-03-01');
    expect(excelSerialToText(0, date, true)).toBe('1904-01-01');
    expect(excelSerialToText(44889, date, true)).toBe('2026-11-25');
    expect(excelSerialToText(0.75, { kind: 'time', elapsed: false }, false)).toBe('18:00');
    expect(excelSerialToText(1.5, { kind: 'time', elapsed: true }, false)).toBe('36:00');
    expect(excelSerialToText(-1, date, false)).toBeNull();
  });

  it('reads date cells written by exceljs (1900 system), with and without a time', async () => {
    const buf = await exceljsWorkbook((wb) => {
      const ws = wb.addWorksheet('S');
      ws.addRow(['Due date', 'Promised at', 'Time']);
      ws.addRow([new Date(Date.UTC(2026, 10, 25)), new Date(Date.UTC(2026, 10, 25, 15, 30)), 0.5]);
      ws.getCell('A2').numFmt = 'dd/mm/yyyy';
      ws.getCell('B2').numFmt = 'dd/mm/yyyy hh:mm';
      ws.getCell('C2').numFmt = 'hh:mm';
    });
    expect((await convert(buf)).csv).toBe('Due date,Promised at,Time\n2026-11-25,2026-11-25 15:30,12:00\n');
  });

  it('reads the 1904 date system from the workbook, and the built-in date formats', async () => {
    const buf = handWorkbook({
      date1904: true,
      styles: { cellXfs: '<xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="22"/>' },
      sheets: [{ name: 'S', xml: `<sheetData>${row(1, num('A1', '44889', 1) + num('B1', '44889.25', 2) + num('C1', '44889'))}</sheetData>` }],
    });
    expect((await convert(buf)).csv).toBe('2026-11-25,2026-11-25 06:00,44889\n');
  });

  it('reads the dates in the form the agent station reads as a date fact', async () => {
    const { parseDateFact } = await import('@magick-agency/domain/context-facts');
    expect(parseDateFact('2026-11-25')).toBe('2026-11-25');
    expect(parseDateFact('2026-11-25 15:30')).toBe('2026-11-25');
    expect(parseDateFact('2026-11-25 13:05:09')).toBe('2026-11-25');
  });
});

// ─── Merged cells ───────────────────────────────────────────────────────────

describe('merged cells: the top-left value only', () => {
  it('empties a value a merge hides (written by a tool, never shown by Excel), keeping the top-left one', async () => {
    const buf = handWorkbook({
      sheets: [{
        name: 'S',
        xml: '<sheetData>'
          + row(1, inline('A1', 'Mobile') + inline('B1', 'Branch') + inline('C1', 'Zone'))
          + row(2, num('A2', '9876543210') + inline('B2', 'Pune') + inline('C2', 'hidden by the merge'))
          + row(3, num('A3', '9123456780') + inline('B3', 'also hidden') + '<c r="C3" s="0"/>')
          + row(4, num('A4', '9000000001') + inline('B4', 'Nagpur') + inline('C4', 'West'))
          + '</sheetData><mergeCells count="1"><mergeCell ref="B2:C3"/></mergeCells>',
      }],
    });
    expect((await convert(buf)).csv).toBe('Mobile,Branch,Zone\n9876543210,Pune,\n9123456780,,\n9000000001,Nagpur,West\n');
  });

  it('reads merges written by exceljs', async () => {
    const buf = await exceljsWorkbook((wb) => {
      const ws = wb.addWorksheet('S');
      ws.addRow(['Mobile', 'Address', '']);
      ws.addRow([9876543210, 'MG Road, Pune', '']);
      ws.mergeCells('B2:C2');
    });
    expect((await convert(buf)).csv).toBe('Mobile,Address\n9876543210,"MG Road, Pune"\n');
  });
});

// ─── Shape and row numbers ──────────────────────────────────────────────────

describe('shape: A to the last used column, one line per sheet row', () => {
  it('pads every row to the width, keeps blank rows as blank lines and drops trailing ones', async () => {
    const buf = handWorkbook({
      sheets: [{
        name: 'S',
        xml: '<sheetData>'
          + row(3, inline('A3', 'Mobile') + inline('B3', 'Name'))
          + row(4, num('A4', '9876543210'))
          + row(6, num('A6', '9123456780') + num('D6', '7'))
          // Formatted but empty cells, and a row of them, write nothing.
          + row(7, '<c r="A7" s="0"/><c r="B7" t="str"><f>""</f><v></v></c>')
          + row(9, '<c r="A9" s="0"/>')
          + '</sheetData>',
      }],
    });
    const { csv, workbook } = await convert(buf);
    expect(csv).toBe('\n\nMobile,Name,,\n9876543210,,,\n\n9123456780,,,7\n');
    expect(workbook.rows).toBe(3);
    expect(workbook.columns).toBe(4);
  });

  it('numbers rows without an `r` from the row before, and cells without one from the cell before', async () => {
    const buf = handWorkbook({ sheets: [{ name: 'S', xml: '<sheetData><row><c t="inlineStr"><is><t>a</t></is></c><c><v>1</v></c></row><row r="3"><c r="B3"><v>2</v></c><c><v>3</v></c></row></sheetData>' }] });
    expect((await convert(buf)).csv).toBe('a,1,\n\n,2,3\n');
  });

  it('row N of the review and the downloads is row N of the sheet: blank rows before the header and between rows, and a cell with line breaks', async () => {
    const buf = await exceljsWorkbook((wb) => {
      const ws = wb.addWorksheet('Customers');
      ws.getCell('A2').value = 'Mobile';
      ws.getCell('B2').value = 'Address';
      ws.getCell('A3').value = 9876543210;
      ws.getCell('B3').value = 'Flat 4\nMG Road\nPune';
      ws.getCell('A4').value = 'not a number';
      ws.getCell('A7').value = 9123456780;
      ws.getCell('B8').value = 'no phone on this row';
      ws.getCell('A10').value = 9876543210;
    });
    const { csv } = await convert(buf);
    const { contacts, rejections } = await ingest(csv, 'Mobile');
    expect(contacts.map((c) => c.source_row_number)).toEqual([3, 7]);
    expect(contacts[0]!.context['Address']).toBe('Flat 4\nMG Road\nPune');
    expect(rejections.map((r) => [r.row_number, r.reason_code])).toEqual([
      [4, 'invalid_phone'],
      [8, 'missing_phone_value'],
      [10, 'duplicate_phone'],
    ]);
  });
});

// ─── Text is written raw ────────────────────────────────────────────────────

describe('a text cell imports as the same value a CSV holding that text does', () => {
  it('formula sigils, an apostrophe our downloads add, quotes, commas and line breaks', async () => {
    const texts = ['=SUM(A1:A9)', '+919876543210', "'+919876543210", '-5', '@home', 'say "hi"', 'a, b', 'line\nbreak', ' padded '];
    const buf = await exceljsWorkbook((wb) => {
      const ws = wb.addWorksheet('S');
      ws.addRow(['Mobile', ...texts.map((_, i) => `T${i}`)]);
      ws.addRow(['9876543210', ...texts]);
    });
    const { csv } = await convert(buf);
    const quote = (t: string) => (/[",\r\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t);
    const handCsv = `Mobile,${texts.map((_, i) => `T${i}`).join(',')}\n9876543210,${texts.map(quote).join(',')}\n`;
    // Written raw: no apostrophe ahead of a sigil (the guard is for files that leave the organisation).
    expect(csv).toBe(handCsv);
    const fromWorkbook = await ingest(csv, 'Mobile');
    const fromCsv = await ingest(handCsv, 'Mobile');
    expect(fromWorkbook.contacts[0]!.context).toEqual(fromCsv.contacts[0]!.context);
    expect(fromWorkbook.contacts[0]!.context['T0']).toBe('=SUM(A1:A9)');
    expect(fromWorkbook.contacts[0]!.context['T2']).toBe('+919876543210');
  });
});

// ─── Limits ─────────────────────────────────────────────────────────────────

describe('limits: stop as soon as one is passed', () => {
  const rows = (n: number) => handWorkbook({
    sheets: [{ name: 'S', xml: `<sheetData>${row(1, inline('A1', 'Mobile'))}${Array.from({ length: n }, (_, i) => row(i + 2, num(`A${i + 2}`, String(9000000000 + i)))).join('')}</sheetData>` }],
  });

  it('takes the header plus maxDataRows rows, and refuses one more', async () => {
    expect((await convert(rows(5), { maxDataRows: 5 })).workbook.rows).toBe(6);
    const err = await refusal(openXlsxWorkbook(rows(6), { ...LIMITS, maxDataRows: 5 }));
    expect(err).toBeInstanceOf(XlsxLimitError);
    expect((err as XlsxLimitError).kind).toBe('too_many_rows');
  });

  it('refuses a value past the last column the ingest takes', async () => {
    const buf = handWorkbook({ sheets: [{ name: 'S', xml: `<sheetData>${row(1, inline('A1', 'Mobile') + inline('F1', 'x'))}</sheetData>` }] });
    const err = await refusal(openXlsxWorkbook(buf, { ...LIMITS, maxColumns: 5 }));
    expect(err).toBeInstanceOf(XlsxLimitError);
    expect(err).toMatchObject({ kind: 'too_many_columns', columns: 6 });
  });

  it('stops writing the CSV once it passes the byte limit', async () => {
    const workbook = await openXlsxWorkbook(rows(10_000), { ...LIMITS, maxCsvBytes: 50_000, maxSheetXmlBytes: 10_000_000 });
    const err = await refusal((async () => { for await (const _ of workbook.toCsv()) { /* read */ } })());
    expect(err).toBeInstanceOf(XlsxLimitError);
    expect((err as XlsxLimitError).kind).toBe('too_large');
  });

  it('stops decompressing a sheet that expands past its bound (a zip bomb of empty cells)', async () => {
    const empty = '<c s="0"/>'.repeat(1000);
    const xml = `<sheetData>${Array.from({ length: 5_000 }, (_, i) => `<row r="${i + 1}">${empty}</row>`).join('')}</sheetData>`;
    const buf = handWorkbook({ sheets: [{ name: 'S', xml }] });
    expect(buf.length).toBeLessThan(200_000);
    const err = await refusal(openXlsxWorkbook(buf, { ...LIMITS, maxSheetXmlBytes: 10_000_000 }));
    expect(err).toBeInstanceOf(XlsxLimitError);
    expect((err as XlsxLimitError).kind).toBe('too_large');
  });

  it('caps the shared strings held in memory', async () => {
    const buf = handWorkbook({ sharedStrings: Array.from({ length: 1000 }, () => 'x'.repeat(100)), sheets: [{ name: 'S', xml: '<sheetData/>' }] });
    const err = await refusal(openXlsxWorkbook(buf, { ...LIMITS, maxSharedStringChars: 50_000 }));
    expect(err).toBeInstanceOf(XlsxLimitError);
    expect((err as XlsxLimitError).kind).toBe('too_large');
  });
});

// ─── Work and live objects: small hostile workbooks (review of 2026-11-24) ───
//
// Each case is a few kilobytes that, before the cap it pins, held the event loop for
// seconds or grew the heap past a gigabyte. Each asserts the refusal (or the plain answer)
// and that it came quickly.

/** Run `fn`, returning what it returned or threw and how long it took. */
async function timed<T>(fn: () => Promise<T> | T): Promise<{ ms: number; value?: T; error?: unknown }> {
  const t0 = performance.now();
  try {
    const value = await fn();
    return { ms: performance.now() - t0, value };
  } catch (error) {
    return { ms: performance.now() - t0, error };
  }
}

const oneCell = '<sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData>';
const letters = (n: number): string => {
  let out = '';
  for (let x = n; x > 0; x = Math.floor((x - 1) / 26)) out = String.fromCharCode(65 + ((x - 1) % 26)) + out;
  return out;
};

describe('number formats: linear, memoised and capped', () => {
  it('reads a format of 100,000 "[" in linear time, as a plain number', async () => {
    // An unclosed bracket is not rendered: the value is written. Past 255 characters a code is plain.
    expect(classifyNumberFormat('['.repeat(255))).toMatchObject({ kind: 'format', sections: [{ fallback: true }] });
    expect(classifyNumberFormat('['.repeat(256))).toEqual({ kind: 'plain' });
    const buf = handWorkbook({ sheets: [{ name: 'S', xml: oneCell }], styles: { numFmts: `<numFmt numFmtId="164" formatCode="${'['.repeat(100_000)}"/>`, cellXfs: '<xf numFmtId="164"/>' } });
    const run = await timed(() => convert(buf));
    expect(run.error).toBeUndefined();
    expect(run.value!.csv).toBe('1\n');
    expect(run.ms).toBeLessThan(2_000);
  });

  it('classifies a format once however many styles use it, and reads a code past 255 characters as plain', async () => {
    expect(classifyNumberFormat(`0.${'#'.repeat(2_000)}`)).toEqual({ kind: 'plain' });
    expect(classifyNumberFormat(`dd/mm/yyyy${' '.repeat(250)}`)).toEqual({ kind: 'plain' });
    const buf = handWorkbook({
      sheets: [{ name: 'S', xml: oneCell }],
      styles: { numFmts: `<numFmt numFmtId="164" formatCode="0.${'#'.repeat(1_000)}"/>`, cellXfs: '<xf numFmtId="164"/>'.repeat(20_000) },
    });
    const run = await timed(() => openXlsxWorkbook(buf, LIMITS));
    expect(run.error).toBeUndefined();
    expect(run.ms).toBeLessThan(2_000);
  });

  it('refuses more cell styles or number formats than Excel keeps', async () => {
    const xfs = handWorkbook({ sheets: [{ name: 'S', xml: oneCell }], styles: { cellXfs: '<xf numFmtId="0"/>'.repeat(65_537) } });
    expect(await refusal(openXlsxWorkbook(xfs, LIMITS))).toMatchObject({ kind: 'unreadable' });
    const fmts = Array.from({ length: 4_097 }, (_, i) => `<numFmt numFmtId="${164 + i}" formatCode="0"/>`).join('');
    const many = handWorkbook({ sheets: [{ name: 'S', xml: oneCell }], styles: { numFmts: fmts, cellXfs: '<xf numFmtId="0"/>' } });
    expect(await refusal(openXlsxWorkbook(many, LIMITS))).toMatchObject({ kind: 'unreadable' });
  });

  it('pads to an all-zeros format of up to 32 zeros, and reads a wider one as plain', async () => {
    expect(classifyNumberFormat('0'.repeat(32))).toMatchObject({ kind: 'pad', width: 32 });
    // Wider: compiled, and past 32 forced digits not rendered (the value is written).
    expect(classifyNumberFormat('0'.repeat(33))).toMatchObject({ kind: 'format', sections: [{ fallback: true }] });
    const buf = handWorkbook({ sheets: [{ name: 'S', xml: oneCell }], styles: { numFmts: `<numFmt numFmtId="164" formatCode="${'0'.repeat(8_000_000)}"/>`, cellXfs: '<xf numFmtId="164"/>' } });
    const run = await timed(() => convert(buf));
    expect(run.value?.csv).toBe('1\n');
    expect(run.ms).toBeLessThan(5_000);
  });
});

describe('cell references: one linear parse, at most 16 characters', () => {
  it('parseCellRef', () => {
    expect(parseCellRef('A1')).toEqual({ column: 1, row: 1 });
    expect(parseCellRef('XFD1048576')).toEqual({ column: 16_384, row: 1_048_576 });
    expect(parseCellRef('ab12')).toEqual({ column: 28, row: 12 });
    expect(parseCellRef('B')).toEqual({ column: 2, row: 0 });
    expect(parseCellRef('A1x')).toBeNull();
    expect(parseCellRef('$A$1')).toBeNull();
    expect(parseCellRef(`A${'1'.repeat(16)}`)).toBeNull();
  });

  it('refuses a merge reference of 50,000 digits at once', async () => {
    const ref = `A${'1'.repeat(50_000)}x:B2`;
    const buf = handWorkbook({ sheets: [{ name: 'S', xml: `${oneCell}<mergeCells><mergeCell ref="${ref}"/></mergeCells>` }] });
    const run = await timed(() => openXlsxWorkbook(buf, LIMITS));
    expect(run.error).toMatchObject({ kind: 'unreadable' });
    expect(run.ms).toBeLessThan(1_000);
  });

  it('refuses a cell reference past column XFD', async () => {
    const buf = handWorkbook({ sheets: [{ name: 'S', xml: '<sheetData><row r="1"><c r="XFE1"><v>1</v></c></row></sheetData>' }] });
    expect(await refusal(openXlsxWorkbook(buf, LIMITS))).toMatchObject({ kind: 'unreadable' });
  });
});

describe('merges: capped, overlapping ones refused, a row costs only the ranges that start or end on it', () => {
  const manyRows = (rows: number) => {
    let data = row(1, inline('A1', 'x'));
    for (let r = 2; r <= rows; r++) data += row(r, num(`A${r}`, String(r)));
    return data;
  };

  it('10,000 merges over 10,000 rows convert quickly', async () => {
    const merges = Array.from({ length: 10_000 }, (_, i) => `<mergeCell ref="${letters(2 + (i % 50))}${1 + Math.floor(i / 50) * 50}:${letters(2 + (i % 50))}${50 + Math.floor(i / 50) * 50}"/>`).join('');
    const buf = handWorkbook({ sheets: [{ name: 'S', xml: `<sheetData>${manyRows(10_000)}</sheetData><mergeCells>${merges}</mergeCells>` }] });
    const run = await timed(() => convert(buf));
    expect(run.error).toBeUndefined();
    expect(run.ms).toBeLessThan(5_000);
  });

  it('refuses more than 10,000 merges', async () => {
    const merges = Array.from({ length: 10_001 }, (_, i) => `<mergeCell ref="B${i + 1}:C${i + 1}"/>`).join('');
    const buf = handWorkbook({ sheets: [{ name: 'S', xml: `<sheetData>${row(1, inline('A1', 'x'))}</sheetData><mergeCells>${merges}</mergeCells>` }] });
    expect(await refusal(openXlsxWorkbook(buf, LIMITS))).toMatchObject({ kind: 'unreadable' });
  });

  it('refuses two merged ranges over the same cell', async () => {
    const buf = handWorkbook({ sheets: [{ name: 'S', xml: `<sheetData>${row(1, inline('A1', 'x') + inline('B1', 'y'))}${row(2, inline('A2', 'z'))}</sheetData><mergeCells><mergeCell ref="A1:B2"/><mergeCell ref="B2:C3"/></mergeCells>` }] });
    const workbook = await openXlsxWorkbook(buf, LIMITS);
    expect(await refusal((async () => { for await (const _ of workbook.toCsv()) { /* read */ } })())).toMatchObject({ kind: 'unreadable' });
  });

  it('a merge down every row of a column, 100,000 times over the same range, is refused rather than walked per row', async () => {
    const merges = '<mergeCell ref="C1:C1048576"/>'.repeat(10_000);
    const buf = handWorkbook({ sheets: [{ name: 'S', xml: `<sheetData>${manyRows(2_000)}</sheetData><mergeCells>${merges}</mergeCells>` }] });
    const run = await timed(async () => {
      const workbook = await openXlsxWorkbook(buf, LIMITS);
      for await (const _ of workbook.toCsv()) { /* read */ }
    });
    expect(run.error).toMatchObject({ kind: 'unreadable' });
    expect(run.ms).toBeLessThan(2_000);
  });
});

describe('the zip directory: bounded before it is walked, and consistent', () => {
  it('refuses a directory of more than 10,000 entries from its end record', async () => {
    const n = 5_000_000;
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(0xffff, 10);
    const z64 = Buffer.alloc(56);
    z64.writeUInt32LE(0x06064b50, 0);
    z64.writeBigUInt64LE(BigInt(n), 32);
    z64.writeBigUInt64LE(BigInt(n * 54), 40);
    z64.writeBigUInt64LE(30n, 48);
    const loc = Buffer.alloc(20);
    loc.writeUInt32LE(0x07064b50, 0);
    loc.writeBigUInt64LE(30n, 8);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    const run = await timed(() => openXlsxWorkbook(Buffer.concat([local, z64, loc, eocd]), LIMITS));
    expect(run.error).toMatchObject({ kind: 'unreadable' });
    expect(run.ms).toBeLessThan(500);
    // A readable workbook padded to 10,001 parts is refused for its count alone; 10,000 is read.
    const workbookParts = excelParts({ sheets: [{ name: 'S', xml: oneCell }] });
    const padded = (total: number) => zipParts([
      ...workbookParts,
      ...Array.from({ length: total - workbookParts.length }, (_, i) => [`x/${i}.xml`, '<a/>'] as [string, string]),
    ], { store: true });
    const err = await refusal(openXlsxWorkbook(padded(10_001), LIMITS));
    expect(err).toMatchObject({ kind: 'unreadable' });
    expect((err as Error).message).toContain('10001 parts');
    expect((await openXlsxWorkbook(padded(10_000), LIMITS)).rows).toBe(1);
  });

  it('refuses a part listed twice', async () => {
    const parts = excelParts({ sheets: [{ name: 'S', xml: oneCell }] });
    expect(await refusal(openXlsxWorkbook(zipParts([...parts, ['XL/Workbook.xml', '<x/>']]), LIMITS))).toMatchObject({ kind: 'unreadable' });
  });

  it('refuses a local header that names another part than the directory', async () => {
    const buf = handWorkbook({ sheets: [{ name: 'S', xml: oneCell }] });
    const at = buf.indexOf('xl/workbook.xml');
    buf.write('xl/workbook.xmm', at, 'latin1');
    expect(await refusal(openXlsxWorkbook(buf, LIMITS))).toMatchObject({ kind: 'unreadable' });
  });

  it('refuses a zip64 field past the end of its extra field (it was a RangeError, a masked 500)', async () => {
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt32LE(0xffffffff, 24);
    cd.writeUInt16LE(1, 28);
    cd.writeUInt16LE(4, 30);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(1, 8);
    eocd.writeUInt16LE(1, 10);
    eocd.writeUInt32LE(51, 12);
    eocd.writeUInt32LE(52, 16);
    const buf = Buffer.concat([local, eocd, cd, Buffer.from('a'), Buffer.from([0x01, 0x00, 0xff, 0xff])]);
    const err = await refusal(openXlsxWorkbook(buf, LIMITS));
    expect(err).toMatchObject({ kind: 'unreadable' });
    // Refused by the clamp itself, not by the catch-all a RangeError would now meet.
    expect((err as Error).message).toContain('zip64 field is cut short');
  });
});

describe('XML: nesting capped', () => {
  it('refuses nesting deeper than 64', async () => {
    const parts = excelParts({ sheets: [{ name: 'S', xml: oneCell }] });
    for (const p of parts) if (p[0] === 'xl/workbook.xml') p[1] = (p[1] as string).replace('</workbook>', `${'<a>'.repeat(65)}${'</a>'.repeat(65)}</workbook>`);
    expect(await refusal(openXlsxWorkbook(zipParts(parts), LIMITS))).toMatchObject({ kind: 'unreadable' });
    const deep = excelParts({ sheets: [{ name: 'S', xml: oneCell }] });
    for (const p of deep) if (p[0] === 'xl/workbook.xml') p[1] = (p[1] as string).replace('</workbook>', `${'<a>'.repeat(5_000_000)}</workbook>`);
    const run = await timed(() => openXlsxWorkbook(zipParts(deep), LIMITS));
    expect(run.error).toMatchObject({ kind: 'unreadable' });
    expect(run.ms).toBeLessThan(2_000);
  });
});

describe('cells: the first pass stops at a value past the last column, a cell holds at most 65,536 characters', () => {
  it('refuses a row of 300 one-megabyte cells at its first cell, and a wide row at its first value past column 100', async () => {
    const big = 'a'.repeat(1_000_000);
    const parts = excelParts({ sheets: [{ name: 'S', xml: '@@' }] });
    const cells = Array.from({ length: 300 }, () => `<c t="inlineStr"><is><t>${big}</t></is></c>`).join('');
    for (const p of parts) if (typeof p[1] === 'string' && p[1].includes('@@')) p[1] = p[1].replace('@@', `<sheetData><row r="1">${cells}</row></sheetData>`);
    const run = await timed(() => openXlsxWorkbook(zipParts(parts), { ...LIMITS, maxCells: 1_000_000 }));
    // The first cell is already past 65,536 characters: refused for that before any column limit.
    expect(run.error).toMatchObject({ kind: 'cell_too_long' });
    const wide = handWorkbook({ sheets: [{ name: 'S', xml: `<sheetData><row r="1">${Array.from({ length: 300 }, () => '<c t="inlineStr"><is><t>x</t></is></c>').join('')}</row></sheetData>` }] });
    expect(await refusal(openXlsxWorkbook(wide, LIMITS))).toMatchObject({ kind: 'too_many_columns', columns: 101 });
  });

  it('refuses text in a cell past the last column as it arrives, before holding it', async () => {
    // 70,000 characters past column 100: the column limit, not the cell's length, refuses it.
    const buf = handWorkbook({ sheets: [{ name: 'S', xml: `<sheetData>${row(1, inline('A1', 'x') + inline('CX1', 'a'.repeat(70_000)))}</sheetData>` }] });
    expect(await refusal(openXlsxWorkbook(buf, LIMITS))).toMatchObject({ kind: 'too_many_columns', columns: 102 });
  });

  it('refuses a cell over 65,536 characters, inline or shared, and keeps one at the limit', async () => {
    const inlineLong = handWorkbook({ sheets: [{ name: 'S', xml: `<sheetData>${row(1, inline('A1', 'a'.repeat(65_537)))}</sheetData>` }] });
    expect(await refusal(openXlsxWorkbook(inlineLong, LIMITS))).toMatchObject({ kind: 'cell_too_long' });
    const sharedLong = handWorkbook({ sharedStrings: ['a'.repeat(65_537)], sheets: [{ name: 'S', xml: `<sheetData>${row(1, shared('A1', 0))}</sheetData>` }] });
    expect(await refusal(openXlsxWorkbook(sharedLong, LIMITS))).toMatchObject({ kind: 'cell_too_long' });
    const atLimit = handWorkbook({ sharedStrings: ['a'.repeat(65_536)], sheets: [{ name: 'S', xml: `<sheetData>${row(1, shared('A1', 0) + shared('B1', 0))}</sheetData>` }] });
    expect((await convert(atLimit)).csv.length).toBe(65_536 * 2 + 2);
  });
});

describe('shared strings: each string costs, and their number is capped', () => {
  it('charges an empty string 16 characters: 20 million of them are refused at once', { timeout: 30_000 }, async () => {
    const buf = handWorkbook({ sharedStrings: '<si/>'.repeat(20_000_000), sheets: [{ name: 'S', xml: oneCell }] });
    const run = await timed(() => openXlsxWorkbook(buf, LIMITS));
    expect(run.error).toMatchObject({ kind: 'too_large' });
    expect(run.ms).toBeLessThan(10_000);
  });

  it('counts 16 characters for every string, empty ones included', async () => {
    const buf = handWorkbook({ sharedStrings: '<si/>'.repeat(1_000), sheets: [{ name: 'S', xml: oneCell }] });
    expect(await refusal(openXlsxWorkbook(buf, { ...LIMITS, maxSharedStringChars: 15_000 }))).toMatchObject({ kind: 'too_large' });
    expect((await openXlsxWorkbook(buf, { ...LIMITS, maxSharedStringChars: 16_000 })).rows).toBe(1);
  });

  it('refuses more strings than the sheet could hold cells', async () => {
    const buf = handWorkbook({ sharedStrings: Array.from({ length: 101 }, (_, i) => String(i)), sheets: [{ name: 'S', xml: oneCell }] });
    expect(await refusal(openXlsxWorkbook(buf, { ...LIMITS, maxDataRows: 9, maxColumns: 10 }))).toMatchObject({ kind: 'too_large' });
    expect((await openXlsxWorkbook(buf, { ...LIMITS, maxDataRows: 10, maxColumns: 10 })).rows).toBe(1);
  });
});

describe('work: decompression bounded by the compressed size, cells by a budget', () => {
  it('refuses 256 MiB of empty cells packed into a small upload, at once', { timeout: 30_000 }, async () => {
    const rowXml = `<row>${'<c/>'.repeat(16_000)}</row>`;
    const parts = excelParts({ sheets: [{ name: 'S', xml: '@@' }] });
    const reps = Math.ceil((256 * 2 ** 20) / rowXml.length);
    for (const p of parts) {
      if (typeof p[1] === 'string' && p[1].includes('@@')) {
        const [a, b] = p[1].split('@@');
        p[1] = Buffer.concat([Buffer.from(`${a}<sheetData>`), ...Array<Buffer>(reps).fill(Buffer.from(rowXml)), Buffer.from(`</sheetData>${b}`)]);
      }
    }
    const buf = zipParts(parts);
    const run = await timed(() => openXlsxWorkbook(buf, LIMITS));
    expect(run.error).toMatchObject({ kind: 'too_large' });
    expect(run.ms).toBeLessThan(5_000);
  });

  it('counts empty cells against the budget a pass may visit', async () => {
    const xml = `<sheetData>${Array.from({ length: 100 }, (_, r) => `<row>${'<c/>'.repeat(1_000)}</row>`).join('')}</sheetData>`;
    const buf = handWorkbook({ sheets: [{ name: 'S', xml }] });
    expect(await refusal(openXlsxWorkbook(buf, { ...LIMITS, maxCells: 50_000 }))).toMatchObject({ kind: 'too_large' });
    expect((await openXlsxWorkbook(buf, { ...LIMITS, maxCells: 100_000 })).rows).toBe(0);
  });
});

describe('sheet names: at most 255 others, each at most 31 characters', () => {
  it('caps the names the answer carries', async () => {
    const sheets = [{ name: 'Customers with a very long name indeed', xml: oneCell }, ...Array.from({ length: 300 }, (_, i) => ({ name: `${'N'.repeat(40)}${i}` }))];
    const { workbook } = await convert(handWorkbook({ sheets }));
    expect(workbook.sheet.name).toBe('Customers with a very long name');
    expect(workbook.sheet.other_sheet_names).toHaveLength(255);
    expect(workbook.sheet.other_sheet_names.every((n) => n.length === 31)).toBe(true);
    // The count is the true number, past the 255 names the answer carries.
    expect(workbook.sheet.other_sheet_count).toBe(300);
  });

  it('counts the other sheets when there are few', async () => {
    const { workbook } = await convert(handWorkbook({ sheets: [{ name: 'A', xml: oneCell }, { name: 'B' }, { name: 'H', state: 'hidden' }] }));
    expect(workbook.sheet).toEqual({ name: 'A', other_sheet_names: ['B'], other_sheet_count: 1 });
  });
});

describe('correctness (review of 2026-11-24)', () => {
  it('a pretty-printed inline string carries only its <t> text', async () => {
    const buf = handWorkbook({ sheets: [{ name: 'S', xml: '<sheetData><row r="1"><c r="A1" t="inlineStr">\n  <is>\n    <t>abc</t>\n  </is>\n</c></row></sheetData>' }] });
    expect((await convert(buf)).csv).toBe('abc\n');
  });

  it('stops at 31 Dec 9999 and writes day 0 under a date-only format as the number', () => {
    expect(excelSerialToText(2_958_465, { kind: 'date', hasTime: false }, false)).toBe('9999-12-31');
    expect(excelSerialToText(2_958_466, { kind: 'date', hasTime: false }, false)).toBeNull();
    expect(excelSerialToText(0, { kind: 'date', hasTime: false }, false)).toBeNull();
    expect(excelSerialToText(0.5, { kind: 'date', hasTime: true }, false)).toBe('12:00');
  });

  it('reads an elapsed [mm]:ss as the duration in hours', () => {
    expect(classifyNumberFormat('[mm]:ss')).toEqual({ kind: 'time', elapsed: true });
    expect(excelSerialToText(90 / 1440, classifyNumberFormat('[mm]:ss'), false)).toBe('01:30');
  });

  it('a t="d" cell follows its cell\'s style', async () => {
    const buf = handWorkbook({
      styles: { cellXfs: '<xf numFmtId="0"/><xf numFmtId="20"/><xf numFmtId="14"/>' },
      sheets: [{ name: 'S', xml: '<sheetData><row r="1"><c r="A1" t="d" s="1"><v>1899-12-30T10:30:00</v></c><c r="B1" t="d" s="2"><v>2026-11-24T00:00:00</v></c><c r="C1" t="d"><v>2026-11-24T10:30:00Z</v></c><c r="D1" s="2"><v>0</v></c></row></sheetData>' }],
    });
    expect((await convert(buf)).csv).toBe('10:30,2026-11-24,2026-11-24 10:30,0\n');
  });
});

// ─── Fresh review of 4bde1c1 ────────────────────────────────────────────────

describe('fresh review: dates, serials, merges, the header row, dxfs, huge text', () => {
  const dateStyles = { numFmts: '<numFmt numFmtId="164" formatCode="#,##0"/><numFmt numFmtId="165" formatCode="dd/mm/yyyy"/>', cellXfs: '<xf numFmtId="0"/><xf numFmtId="164"/><xf numFmtId="165"/>' };

  it('a date in a phone-like column ("Last Contact Date", "Cancellation Date") is a date, not its serial', async () => {
    const buf = handWorkbook({
      styles: dateStyles,
      sheets: [{ name: 'S', xml: `<sheetData>${row(1, inline('A1', 'Mobile') + inline('B1', 'Last Contact Date') + inline('C1', 'Cancellation Date'))}${row(2, num('A2', '9876543210', 1) + num('B2', '46346', 2) + num('C2', '46347', 2))}</sheetData>` }],
    });
    expect((await convert(buf)).csv).toBe('Mobile,Last Contact Date,Cancellation Date\n9876543210,2026-11-20,2026-11-21\n');
  });

  it('a serial past 31 Dec 9999 of its own date system, after rounding, is the number', () => {
    const date = { kind: 'date', hasTime: false } as const;
    expect(excelSerialToText(2_957_003, date, true)).toBe('9999-12-31');
    expect(excelSerialToText(2_957_004, date, true)).toBeNull();
    expect(excelSerialToText(2_958_465, date, true)).toBeNull();
    expect(excelSerialToText(2_958_465, date, false)).toBe('9999-12-31');
    expect(excelSerialToText(2_958_465.999999999, date, false)).toBeNull();
  });

  it('a value a merge hides does not widen the CSV', async () => {
    const buf = handWorkbook({
      sheets: [{ name: 'S', xml: `<sheetData>${row(2, inline('C2', 'Name') + inline('D2', 'Mobile'))}${row(3, inline('C3', 'a') + num('D3', '9876543210'))}${row(4, inline('C4', 'b') + num('D4', '9876543211') + inline('E4', 'hidden'))}</sheetData><mergeCells count="1"><mergeCell ref="D4:E4"/></mergeCells>` }],
    });
    const { csv, workbook } = await convert(buf);
    expect(csv).toBe('\n,,Name,Mobile\n,,a,9876543210\n,,b,9876543211\n');
    expect(workbook.columns).toBe(4);
  });

  it('the phone rule\'s header row is the row the import takes as its header (a row of spaces in a one-column sheet is skipped)', async () => {
    const buf = handWorkbook({
      styles: dateStyles,
      sheets: [{ name: 'S', xml: `<sheetData>${row(1, '<c r="A1" t="inlineStr"><is><t xml:space="preserve"> </t></is></c>')}${row(2, inline('A2', 'Mobile'))}${row(3, num('A3', '9876543210', 1))}</sheetData>` }],
    });
    const { csv } = await convert(buf);
    expect(csv).toBe(' \nMobile\n9876543210\n');
    expect((await ingest(csv, 'Mobile')).contacts.map((c) => c.phone_e164)).toEqual(['+919876543210']);
  });

  it('a number format inside <dxfs> (conditional formatting) does not replace a cell\'s own', async () => {
    const buf = handWorkbook({
      styles: { numFmts: '<numFmt numFmtId="164" formatCode="#,##0.00"/>', cellXfs: '<xf numFmtId="0"/><xf numFmtId="164"/></cellXfs><dxfs count="1"><dxf><numFmt numFmtId="164" formatCode="0%"/></dxf></dxfs><cellXfs>' },
      sheets: [{ name: 'S', xml: `<sheetData>${row(1, inline('A1', 'Amount'))}${row(2, num('A2', '1250.5', 1))}</sheetData>` }],
    });
    expect((await convert(buf)).csv).toBe('Amount\n"1,250.50"\n');
  });

  it('text outside any cell is refused as it streams in, before it is all held', async () => {
    const parts = excelParts({ sheets: [{ name: 'S', xml: '@@' }] });
    for (const p of parts) if (typeof p[1] === 'string' && p[1].includes('@@')) p[1] = p[1].replace('@@', `<sheetData>${'a'.repeat(1_000_000)}${row(1, inline('A1', 'x'))}</sheetData>`);
    expect(await refusal(openXlsxWorkbook(zipParts(parts), LIMITS))).toMatchObject({ kind: 'unreadable' });
  });

  it('a cell of a million characters is refused as it streams in', async () => {
    const buf = handWorkbook({ sheets: [{ name: 'S', xml: `<sheetData>${row(1, inline('A1', 'a'.repeat(1_000_000)))}</sheetData>` }] });
    const err = await refusal(openXlsxWorkbook(buf, LIMITS));
    expect(err).toMatchObject({ kind: 'cell_too_long' });
  });
});

describe('the refusals leaf', () => {
  it('isWorkbookName: .xlsx and .xlsm, any case, spaces trimmed', () => {
    for (const name of ['a.xlsx', 'A.XLSX', 'b.xlsm', ' c.xlsx ']) expect(isWorkbookName(name), name).toBe(true);
    for (const name of ['a.xls', 'a.csv', 'a.xlsx.csv', 'xlsx']) expect(isWorkbookName(name), name).toBe(false);
  });

  it('the cell-too-long message names the cap it is refused at', () => {
    expect(xlsxRefusalMessage('cell_too_long')).toContain(XLSX_MAX_CELL_CHARS.toLocaleString('en-IN'));
  });
});
