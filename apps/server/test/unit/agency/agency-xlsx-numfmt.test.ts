import { describe, it, expect } from 'vitest';
import { Readable } from 'node:stream';
import {
  builtInStyle,
  classifyNumberFormat,
  compileFormat,
  formatsCompiled,
  plainNumber,
  renderFormattedNumber,
  type NumberStyle,
} from '../../../src/agency/agency-xlsx-numfmt.js';
import { openXlsxWorkbook } from '../../../src/agency/agency-xlsx.js';
import { ingestAgencyCsv, type AgencyIngestContact } from '../../../src/agency/agency-csv-ingest.js';
import { parseContextFact, parseMoneyFact, parseNumberFact } from '@magick-agency/domain/context-facts';
import { exceljsWorkbook, handWorkbook } from '../../helpers/xlsx-fixtures.js';

/*
 * Number cells as the sheet shows them (IM8, ruled by Manas 2026-11-25): the number-format
 * renderer (`agency-xlsx-numfmt.ts`), case by case, then through the converter with a
 * styles.xml written by hand as Excel writes it and with exceljs, then the rendered text
 * through the import and the agent station's fact rules (the knock-on).
 */

function show(code: string, x: number): string | null {
  const style = classifyNumberFormat(code);
  if (style.kind !== 'format') throw new Error(`${code} is ${style.kind}, not a number format`);
  return renderFormattedNumber(x, style);
}

function showBuiltIn(id: number, x: number): string | null {
  const style = builtInStyle(id) as NumberStyle;
  if (style.kind !== 'format') throw new Error(`built-in ${id} is ${style.kind}`);
  return renderFormattedNumber(x, style);
}

const LAKH = '[>=10000000]##\\,##\\,##\\,##0;[>=100000]##\\,##\\,##0;##,##0';

describe('sections and signs', () => {
  it('one section: a negative number gets a leading minus (before a currency symbol)', () => {
    expect(show('#,##0.00', -1250.5)).toBe('-1,250.50');
    expect(show('[$₹-4009]#,##0.00', -1250.5)).toBe('-₹1,250.50');
  });

  it('two sections: the negative one writes its own sign', () => {
    expect(show('#,##0.00;(#,##0.00)', -1250)).toBe('(1,250.00)');
    expect(show('#,##0.00;(#,##0.00)', 1250)).toBe('1,250.00');
    expect(show('#,##0.00;(#,##0.00)', 0)).toBe('0.00');
    expect(show('[Red]0;[Blue]-0', -5)).toBe('-5');
  });

  it('three sections: zero has its own; an empty section shows nothing', () => {
    expect(show('#,##0.00;(#,##0.00);"-"', 0)).toBe('-');
    expect(show('0;-0;;@', 0)).toBe('');
  });

  it('conditions pick the section: Excel\'s Indian lakh format', () => {
    expect(show(LAKH, 123_456_789)).toBe('12,34,56,789');
    expect(show(LAKH, 10_000_000)).toBe('1,00,00,000');
    expect(show(LAKH, 150_000)).toBe('1,50,000');
    expect(show(LAKH, 99_999)).toBe('99,999');
    expect(show(LAKH, 500)).toBe('500');
    // Past 99 crore the first placeholder takes the extra digits, as Excel shows it.
    expect(show(LAKH, 1_234_567_890)).toBe('123,45,67,890');
    expect(show(LAKH, -150_000)).toBe('-1,50,000');
    expect(show('[=0]"zero";0', 0)).toBe('zero');
    expect(show('[=0]"zero";0', 5)).toBe('5');
    // LibreOffice's rule: a section for values below zero writes its own sign.
    expect(show('[<0]"owes "0;0', -5)).toBe('owes 5');
  });
});

describe('literals, tags and placeholders', () => {
  it('quoted text, escapes, _x as a space, *x dropped, colours dropped, currency tags as their symbol', () => {
    expect(show('"Rs."#,##0', 125_000)).toBe('Rs.1,25,000');
    expect(show('#,##0 "nos"', 12_345)).toBe('12,345 nos');
    expect(show('#,##0.00 \\m', 5)).toBe('5.00 m');
    expect(show('#,##0_);[Red](#,##0)', 5)).toBe('5 ');
    expect(show('* #,##0', 5)).toBe('5');
    expect(show('[$₹-4009] #,##0.00', 1250.5)).toBe('₹ 1,250.50');
    expect(show('[$-409]#,##0', 1250)).toBe('1,250');
    expect(show('[$€-x-euro2] #,##0.00', 1250)).toBe('€ 1,250.00');
    expect(show('"Total "General', 12.5)).toBe('Total 12.5');
  });

  it('0, # and ? placeholders, literals among the digits', () => {
    expect(show('#.##', 5)).toBe('5.');
    expect(show('#.00', 0.5)).toBe('.50');
    expect(show('0.0?', 1.5)).toBe('1.5 ');
    expect(show('000-000', 12_345)).toBe('012-345');
    expect(show('(###) ###-####', 9_876_543_210)).toBe('(987) 654-3210');
    expect(show('"ID"00000', 42)).toBe('ID00042');
  });

  it('grouping is Indian whatever the commas say: #,##0 as an Indian Excel shows it, #,##,##0 as Sheets and LibreOffice write it', () => {
    expect(show('#,##0', 1_250_000)).toBe('12,50,000');
    expect(show('#,##,##0.00', 125_000)).toBe('1,25,000.00');
    expect(show('#,##,##0.00', 1_25_00_000.5)).toBe('1,25,00,000.50');
    expect(show('#,##0', 999)).toBe('999');
    expect(show('#,##0', 0)).toBe('0');
  });

  it('percent multiplies by 100 for each %, a trailing comma divides by 1,000 for each', () => {
    expect(show('0%', 0.15)).toBe('15%');
    expect(show('0.00%', 0.1234)).toBe('12.34%');
    expect(show('#,##0,', 1_250_000)).toBe('1,250');
    expect(show('0.0,,"M"', 12_345_678)).toBe('12.3M');
  });

  it('rounds half away from zero on the decimal value, as Excel does', () => {
    expect(show('0.00', 1.005)).toBe('1.01');
    expect(show('0.00', 2.675)).toBe('2.68');
    expect(show('0.00', -1.005)).toBe('-1.01');
    expect(show('0.0', 9.96)).toBe('10.0');
    expect(show('0', 0.5)).toBe('1');
    expect(show('0.00', -0.004)).toBe('0.00');
  });
});

describe('built-in formats by id', () => {
  it('1–4, 9–10, 37–40 as ECMA-376 lists them; 5–8 and 41–44 in their en-IN form', () => {
    expect(showBuiltIn(1, 5.6)).toBe('6');
    expect(showBuiltIn(2, 1.005)).toBe('1.01');
    expect(showBuiltIn(3, 1_250_000)).toBe('12,50,000');
    expect(showBuiltIn(4, 1_250_000.5)).toBe('12,50,000.50');
    expect(showBuiltIn(9, 0.15)).toBe('15%');
    expect(showBuiltIn(10, 0.155)).toBe('15.50%');
    expect(showBuiltIn(37, -1250)).toBe('(1,250)');
    expect(showBuiltIn(39, -1250.5)).toBe('(1,250.50)');
    expect(showBuiltIn(5, -1250)).toBe('-₹1,250');
    expect(showBuiltIn(7, 1250.5)).toBe('₹1,250.50');
    // Written with its alignment spaces, as the sheet holds them (the import trims a cell).
    expect(showBuiltIn(44, 1250)).toBe(' ₹1,250.00 ');
    expect(showBuiltIn(44, -1250)).toBe(' ₹-1,250.00 ');
    expect(showBuiltIn(44, 0)).toBe(' ₹-   ');
    expect(builtInStyle(49)).toEqual({ kind: 'plain' });
    expect(builtInStyle(0)).toEqual({ kind: 'plain' });
  });
});

describe('what is not rendered keeps the value rule', () => {
  it('fractions, scientific formats, a thousands comma among literals, too many forced digits or decimals', () => {
    for (const code of ['# ?/?', '# ??/??', '0.00E+00', '##0.0E+0', '#,##0\\-00', `${'0'.repeat(33)}.0`, `0.${'0'.repeat(31)}`, '#'.repeat(65), '"unclosed']) {
      expect(show(code, 1.5), code).toBeNull();
    }
  });

  it('a format whose only section is General is General', () => {
    expect(compileFormat('General')).toEqual({ kind: 'plain' });
  });
});

const LIMITS = { maxDataRows: 1_000, maxColumns: 100, maxCsvBytes: 1_000_000 };

async function csvOf(buf: Buffer, limits: Partial<typeof LIMITS> = {}): Promise<string> {
  const workbook = await openXlsxWorkbook(buf, { ...LIMITS, ...limits });
  let csv = '';
  for await (const chunk of workbook.toCsv() as AsyncIterable<Buffer>) csv += chunk.toString('utf8');
  return csv;
}

async function importOf(csv: string): Promise<AgencyIngestContact[]> {
  const contacts: AgencyIngestContact[] = [];
  await ingestAgencyCsv({ source: Readable.from([Buffer.from(csv)]), phoneColumn: 'Mobile', onBatch: (b) => { contacts.push(...b); } });
  return contacts;
}

describe('through the converter', () => {
  it('a styles.xml written by hand as an Indian Excel writes it: custom codes from 164, the accounting format spelled out under id 44', async () => {
    const buf = handWorkbook({
      styles: {
        numFmts:
          '<numFmt numFmtId="44" formatCode="_ &quot;₹&quot;\\ * #,##0.00_ ;_ &quot;₹&quot;\\ * \\-#,##0.00_ ;_ &quot;₹&quot;\\ * &quot;-&quot;??_ ;_ @_ "/>'
          + '<numFmt numFmtId="164" formatCode="[$₹-4009]\\ #,##0.00"/>'
          + `<numFmt numFmtId="165" formatCode="${LAKH.replace(/>/g, '&gt;')}"/>`
          + '<numFmt numFmtId="166" formatCode="0.0%"/>'
          + '<numFmt numFmtId="167" formatCode="#,##0.00;\\(#,##0.00\\)"/>',
        cellXfs: '<xf numFmtId="0"/><xf numFmtId="44" applyNumberFormat="1"/><xf numFmtId="164" applyNumberFormat="1"/>'
          + '<xf numFmtId="165" applyNumberFormat="1"/><xf numFmtId="166" applyNumberFormat="1"/><xf numFmtId="167" applyNumberFormat="1"/>'
          + '<xf numFmtId="3" applyNumberFormat="1"/><xf numFmtId="11" applyNumberFormat="1"/>',
      },
      sheets: [{
        name: 'S',
        xml: '<sheetData>'
          + '<row r="1"><c r="A1" t="inlineStr"><is><t>Mobile</t></is></c><c r="B1" t="inlineStr"><is><t>Due</t></is></c><c r="C1" t="inlineStr"><is><t>EMI</t></is></c>'
          + '<c r="D1" t="inlineStr"><is><t>Loan</t></is></c><c r="E1" t="inlineStr"><is><t>Rate</t></is></c><c r="F1" t="inlineStr"><is><t>Balance</t></is></c>'
          + '<c r="G1" t="inlineStr"><is><t>Units</t></is></c><c r="H1" t="inlineStr"><is><t>Sci</t></is></c></row>'
          + '<row r="2"><c r="A2"><v>919876543210</v></c><c r="B2" s="1"><v>125000</v></c><c r="C2" s="2"><v>1250.5</v></c>'
          + '<c r="D2" s="3"><v>12345678</v></c><c r="E2" s="4"><v>0.125</v></c><c r="F2" s="5"><v>-1250</v></c>'
          + '<c r="G2" s="6"><v>1250000</v></c><c r="H2" s="7"><v>919876543210</v></c></row>'
          + '</sheetData>',
      }],
    });
    const csv = await csvOf(buf);
    expect(csv.split('\n')[1]).toBe('919876543210," ₹ 1,25,000.00 ","₹ 1,250.50","1,23,45,678",12.5%,"(1,250.00)","12,50,000",919876543210');
    // Read back by the import as the text the sheet shows (trimmed, as any CSV cell).
    const [contact] = await importOf(csv);
    expect(contact!.context).toEqual({
      Due: '₹ 1,25,000.00', EMI: '₹ 1,250.50', Loan: '1,23,45,678', Rate: '12.5%', Balance: '(1,250.00)', Units: '12,50,000', Sci: '919876543210',
    });
  });

  it('formats set with exceljs', async () => {
    const buf = await exceljsWorkbook((wb) => {
      const ws = wb.addWorksheet('S');
      ws.addRow(['Mobile', 'Amount', 'Share', 'Plain', 'Padded']);
      ws.addRow([9876543210, 125000, 0.15, 1250.5, 9876543210]);
      ws.getCell('B2').numFmt = '#,##,##0.00';
      ws.getCell('C2').numFmt = '0%';
      ws.getCell('E2').numFmt = '00000000000';
    });
    expect((await csvOf(buf)).split('\n')[1]).toBe('9876543210,"1,25,000.00",15%,1250.5,09876543210');
  });
});

describe('the knock-on: rendered amounts through the agent station\'s fact rules', () => {
  it('money reads ₹1,25,000.00 and 1,25,000.00; brackets and percentages are shown as written', () => {
    expect(parseMoneyFact(show('[$₹-4009]#,##0.00', 125000)!)).toBe('125000.00');
    expect(parseMoneyFact('₹1,25,000.00')).toBe('125000.00');
    expect(parseMoneyFact('1,25,000.00')).toBe('125000.00');
    expect(parseMoneyFact('₹ 1,25,000.00')).toBe('125000.00');
    expect(parseMoneyFact(show('#,##0.00;(#,##0.00)', -1250)!)).toBeNull();
    expect(parseMoneyFact('15%')).toBeNull();
  });

  it('number reads 1,25,000.00; not a currency, brackets or a percentage', () => {
    expect(parseNumberFact('1,25,000.00')).toBe('125000.00');
    expect(parseNumberFact(show(LAKH, 12_345_678)!)).toBe('12345678');
    expect(parseNumberFact('₹1,25,000.00')).toBeNull();
    expect(parseNumberFact('(1,250.00)')).toBeNull();
    expect(parseNumberFact('15%')).toBeNull();
  });

  it('text is never read as anything (the raw text is shown)', () => {
    for (const raw of ['₹1,25,000.00', '1,25,000.00', '(1,250.00)', '15%']) expect(parseContextFact(raw, 'text')).toBeNull();
  });

  it('a phone column\'s whole numbers are written in full whatever the format; other columns as shown (Manas, 2026-11-25)', async () => {
    const headers = ['Mobile', 'Phone No.', 'Contact Number', 'Alt mobile', 'EMI', 'Loan No'];
    const cell = (col: string, s: number, v: string) => `<c r="${col}2" s="${s}"><v>${v}</v></c>`;
    const buf = handWorkbook({
      styles: { numFmts: '<numFmt numFmtId="164" formatCode="00000000000"/>', cellXfs: '<xf numFmtId="0"/><xf numFmtId="3" applyNumberFormat="1"/><xf numFmtId="164" applyNumberFormat="1"/><xf numFmtId="4" applyNumberFormat="1"/>' },
      sheets: [{
        name: 'S',
        xml: '<sheetData><row r="1">' + headers.map((h, i) => `<c r="${'ABCDEF'[i]}1" t="inlineStr"><is><t>${h}</t></is></c>`).join('') + '</row>'
          + '<row r="2">' + cell('A', 1, '9876543210') + cell('B', 2, '9876543210') + cell('C', 1, '9876543211') + cell('D', 3, '9876543212.5')
          + cell('E', 1, '125000') + cell('F', 1, '9876543213') + '</row></sheetData>',
      }],
    });
    const csv = await csvOf(buf);
    // Mobile and Contact Number under #,##0: digits; Phone No. padded; a non-whole number in a
    // phone column, and EMI and Loan No (not phone-like headers), as shown.
    expect(csv.split('\n')[1]).toBe('9876543210,09876543210,9876543211,"9,87,65,43,212.50","1,25,000","9,87,65,43,213"');
    expect((await importOf(csv)).map((c) => c.phone_e164)).toEqual(['+919876543210']);
  });

  it('the conversion and the column analysis use one header rule', async () => {
    const { looksLikePhoneHeader } = await import('../../../src/agency/phone-header.js');
    for (const h of ['Mobile', 'Phone No.', 'Contact Number', 'Alt mobile', 'MSISDN', 'Tel']) expect(looksLikePhoneHeader(h), h).toBe(true);
    for (const h of ['EMI', 'Loan No', 'Name', 'Due date']) expect(looksLikePhoneHeader(h), h).toBe(false);
  });
});

describe('review of 2026-11-25: signs, sections, zero, fallbacks', () => {
  it('a red-negative format keeps the minus: the negative section looks like the positive one, the colour carried the sign', () => {
    expect(show('0.00;[Red]0.00', -1250)).toBe('-1250.00');
    expect(show('#,##0.00;[Red]#,##0.00', -1250.5)).toBe('-1,250.50');
    expect(show('"₹"#,##0.00;[Red]"₹"#,##0.00', -5)).toBe('-₹5.00');
    expect(show('[Blue]#,##0;[Red]#,##0;0', -1250)).toBe('-1,250');
    expect(show('0;General', -5)).toBe('-5');
  });

  it('a negative section with words or brackets of its own is written as shown, no minus added', () => {
    expect(show('0" Cr";0" Dr"', -5)).toBe('5 Dr');
    expect(show('0" Cr";0" Dr"', 5)).toBe('5 Cr');
    expect(show('0;"minus "0', -5)).toBe('minus 5');
    expect(show('0;"owes "0', -5)).toBe('owes 5');
    expect(show('0.00;0.00" CR"', -5)).toBe('5.00 CR');
    expect(show('#,##0.00;(#,##0.00)', -1250)).toBe('(1,250.00)');
    expect(show('#,##0;-#,##0', -1250)).toBe('-1,250');
  });

  it('a last section with an unquoted @ is the text section, not the negative or zero one', () => {
    expect(show('#,##0.00;@', -1250.5)).toBe('-1,250.50');
    expect(show('0.00;-0.00;@', 0)).toBe('0.00');
    expect(show('0.00;@', 0)).toBe('0.00');
    expect(show('0.00;(0.00);"zero";@', 0)).toBe('zero');
    // A quoted @ is text to show, not the text section: this is the negative section, as written.
    expect(show('0;"@"', -5)).toBe('@');
  });

  it('zero is zero: never -0, -₹0 or (0); the zero section if there is one, else the positive', () => {
    expect(show('0', -0.4)).toBe('0');
    expect(show('0.00', -0.004)).toBe('0.00');
    expect(show('[$₹-4009]#,##0', -0.4)).toBe('₹0');
    expect(show('#,##0;(#,##0)', -0.4)).toBe('0');
    expect(show('#,##0;(#,##0);"-"', -0.4)).toBe('-');
    expect(show('0%;(0%)', -0.004)).toBe('0%');
    expect(show('#,##0;[Red]-#,##0', -0.4)).toBe('0');
  });

  it('a format with no integer placeholder puts the integer before its own point, not a literal one', () => {
    expect(show('"Rs.".00', 12.5)).toBe('Rs.12.50');
    expect(show('.00', 12.5)).toBe('12.50');
    expect(show('"v.1 "#.00', 12.5)).toBe('v.1 12.50');
  });

  it('caps % signs and scaling commas, and writes the value when scaling leaves a double', () => {
    expect(show(`0${'%'.repeat(11)}`, 1)).toBeNull();
    expect(show(`0${','.repeat(11)}`, 1)).toBeNull();
    expect(show(`0${'%'.repeat(10)}`, 1)).toBe(`100000000000000000000${'%'.repeat(10)}`);
    expect(show('0%', 1e307)).toBeNull();
  });

  it('pads a whole number only under a single section of zeros; anything else is rendered', async () => {
    expect(classifyNumberFormat('00000;(00000)').kind).toBe('format');
    expect(show('00000;(00000)', -5)).toBe('(00005)');
    expect(classifyNumberFormat('000000')).toMatchObject({ kind: 'pad', width: 6 });
    const buf = handWorkbook({
      styles: { numFmts: '<numFmt numFmtId="164" formatCode="000000"/>', cellXfs: '<xf numFmtId="0"/><xf numFmtId="164"/>' },
      sheets: [{ name: 'S', xml: '<sheetData><row r="1"><c r="A1" s="1"><v>12345.6</v></c><c r="B1" s="1"><v>42</v></c><c r="C1" s="1"><v>-42</v></c></row></sheetData>' }],
    });
    expect(await csvOf(buf)).toBe('012346,000042,-000042\n');
  });

  it('extremes: 1e21 and 2^53 grouped at 15 digits, 1e-300 as zero', () => {
    expect(show('#,##0', 1e21)).toBe('1,00,00,00,00,00,00,00,00,00,000');
    expect(show('#,##0', 2 ** 53)).toBe('9,00,71,99,25,47,40,990');
    expect(show('0.00', 1e-300)).toBe('0.00');
  });

  it('_x, *x and \\x take a whole character, an emoji included', () => {
    expect(show('0_😀', 5)).toBe('5 ');
    expect(show('0*😀', 5)).toBe('5');
    expect(show('0\\😀', 5)).toBe('5😀');
    expect(show('0_😀;(0)', -5)).toBe('(5)');
  });

  it('a bracket that looks like a condition but does not parse makes the format fall back', () => {
    expect(show('[>=1E5]0;0.00', 200_000)).toBeNull();
    expect(show('[<abc]0', 5)).toBeNull();
    expect(show('[Red]0', 5)).toBe('5');
  });
});

describe('work: compiled once per format, linearly', () => {
  it('a format used by 20,000 cell styles is compiled once', async () => {
    const before = formatsCompiled();
    const buf = handWorkbook({
      sheets: [{ name: 'S', xml: '<sheetData><row r="1"><c r="A1" s="5"><v>1</v></c></row></sheetData>' }],
      styles: { numFmts: '<numFmt numFmtId="164" formatCode="#,##0.00"/>', cellXfs: '<xf numFmtId="164"/>'.repeat(20_000) },
    });
    expect(await csvOf(buf)).toBe('1.00\n');
    expect(formatsCompiled() - before).toBe(1);
  });

  it('an adversarial code at Excel\'s 255-character limit compiles in linear time', () => {
    const codes = [
      '"[\\'.repeat(85),
      '[\\"'.repeat(85),
      '\\['.repeat(127),
      '['.repeat(255),
      '"'.repeat(255),
      '_"*['.repeat(63),
      'General'.repeat(36),
    ];
    for (const code of codes) {
      expect(code.length).toBeLessThanOrEqual(255);
      // Under the cap, so the compiler runs (a longer code never reaches it).
      const before = formatsCompiled();
      compileFormat(code);
      expect(formatsCompiled() - before, code.slice(0, 12)).toBe(1);
      const t0 = performance.now();
      for (let i = 0; i < 1_000; i += 1) compileFormat(code);
      expect(performance.now() - t0, code.slice(0, 12)).toBeLessThan(1_000);
    }
  });
});

describe('fresh review: text-only formats, digitless sections, huge Generals, the hog', () => {
  it('a format whose only section is text writes the number as General', async () => {
    for (const code of ['@', '"Ref "@', '[Red]@']) expect(classifyNumberFormat(code), code).toEqual({ kind: 'plain' });
    const buf = handWorkbook({
      styles: { numFmts: '<numFmt numFmtId="164" formatCode="@"/><numFmt numFmtId="165" formatCode="&quot;Ref &quot;@"/>', cellXfs: '<xf numFmtId="0"/><xf numFmtId="164"/><xf numFmtId="165"/>' },
      sheets: [{ name: 'S', xml: '<sheetData><row r="1"><c r="A1" s="1"><v>123456</v></c><c r="B1" s="2"><v>1250.5</v></c></row></sheetData>' }],
    });
    expect(await csvOf(buf)).toBe('123456,1250.5\n');
    // With a numeric section before it, the text section is only for text.
    expect(show('General;@', -3)).toBe('-3');
  });

  it('a section with no digits is never switched by the zero rule', () => {
    expect(show('"Cr";"Dr"', -0.3)).toBe('Dr');
    expect(show('"Cr";"Dr"', -5)).toBe('Dr');
    expect(show('"Due";"Overdue";"None"', -0.25)).toBe('Overdue');
    expect(show('"Due";"Overdue";"None"', 0)).toBe('None');
  });

  it('General writes a whole number past 2^53 as Excel holds it, at 15 significant digits', () => {
    expect(plainNumber(9.87654321098765e19)).toBe('98765432109876500000');
    expect(plainNumber(2 ** 53)).toBe('9007199254740990');
    expect(plainNumber(2 ** 53 - 1)).toBe('9007199254740991');
    expect(plainNumber(-9.87654321098765e19)).toBe('-98765432109876500000');
    expect(plainNumber(1e308).length).toBe(309);
  });

  it('a section with more than one General, or a code past Excel\'s 255 characters, is plain', () => {
    expect(show('General General', 5)).toBeNull();
    expect(classifyNumberFormat('General'.repeat(146))).toEqual({ kind: 'plain' });
    expect(classifyNumberFormat(`0${' '.repeat(255)}`)).toEqual({ kind: 'plain' });
    expect(classifyNumberFormat(`0${' '.repeat(254)}`).kind).toBe('format');
  });

  it('the hog: 10,000 rows of 1e308 under a General-heavy format convert in a couple of seconds', { timeout: 30_000 }, async () => {
    const code = 'General'.repeat(36);
    const cells = Array.from({ length: 10_000 }, (_, i) => `<row r="${i + 1}">${Array.from({ length: 10 }, (_, c) => `<c r="${String.fromCharCode(65 + c)}${i + 1}" s="1"><v>1E+308</v></c>`).join('')}</row>`).join('');
    const buf = handWorkbook({ styles: { numFmts: `<numFmt numFmtId="164" formatCode="${code}"/>`, cellXfs: '<xf numFmtId="0"/><xf numFmtId="164"/>' }, sheets: [{ name: 'S', xml: `<sheetData>${cells}</sheetData>` }] });
    const t0 = performance.now();
    const csv = await csvOf(buf, { maxDataRows: 20_000, maxCsvBytes: 512 * 1024 * 1024 });
    expect(performance.now() - t0).toBeLessThan(5_000);
    expect(csv.split('\n')[0]!.split(',')[0]).toHaveLength(309);
  });
});
