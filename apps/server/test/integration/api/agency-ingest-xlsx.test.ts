import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * An Excel customer list (IM8) through the real routes on real Postgres: upload, column
 * analysis, check, import, the rejected- and skipped-rows downloads, and a re-import. The
 * ingest runs detached, as in production; the test polls like the wizard. S3 is an
 * in-memory map at its module boundary (`storage/s3.js`); the roster hand-off, the screen
 * and the DNC lookup are real.
 *
 * What it pins:
 *  - the upload answers `format: 'xlsx'` and the sheet it read (the first VISIBLE one) with
 *    the other visible sheets, keeps the supervisor's file name and the workbook's size, and
 *    stores CSV (`text/csv`, a key ending `.csv`) that every later step reads unchanged;
 *  - row N of the review, of the stored contacts and of both downloads is row N of the
 *    sheet: blank rows before the header and between rows, and a cell holding line breaks;
 *  - a CSV upload answers `format: 'csv'` and no sheet;
 *  - an `.xls` (or a workbook with a password), text named `.xlsx`, a zip that is not a
 *    workbook and a workbook with no visible sheet are refused 400 in plain words and
 *    nothing is stored; a sheet over the ingest's row limit is refused with the ingest's own
 *    code and words, before anything is stored.
 */

const s3 = vi.hoisted(() => ({ files: new Map<string, { body: Buffer; contentType: string }>() }));
const mocks = vi.hoisted(() => ({ verifyIdToken: vi.fn(), csvBytesLimit: null as number | null, deadlineMs: null as number | null, s3Missing: false }));
vi.mock('../../../src/auth/firebase.js', () => ({ initFirebase: vi.fn(), verifyIdToken: mocks.verifyIdToken }));
// The real conversion, in its worker; one case lowers the CSV byte limit, since a 512 MB CSV is not a fixture.
vi.mock('../../../src/agency/agency-xlsx-runner.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../src/agency/agency-xlsx-runner.js')>();
  return {
    ...real,
    convertXlsxInWorker: (
      buf: Buffer,
      limits: import('../../../src/agency/agency-xlsx.js').XlsxLimits,
      options?: import('../../../src/agency/agency-xlsx-runner.js').XlsxConversionOptions,
    ) => real.convertXlsxInWorker(
      buf,
      mocks.csvBytesLimit === null ? limits : { ...limits, maxCsvBytes: mocks.csvBytesLimit, maxSheetXmlBytes: limits.maxCsvBytes },
      mocks.deadlineMs === null ? options : { ...options, deadlineMs: mocks.deadlineMs },
    ),
  };
});
vi.mock('../../../src/storage/s3.js', async () => {
  const { Readable } = await import('node:stream');
  const read = (key: string) => {
    const file = s3.files.get(key);
    if (!file) throw Object.assign(new Error('The specified key does not exist.'), { name: 'NoSuchKey' });
    return file.body;
  };
  return {
    uploadFile: async (key: string, body: Buffer, contentType: string) => {
      s3.files.set(key, { body: Buffer.from(body), contentType });
    },
    uploadStream: async (key: string, body: AsyncIterable<Buffer>, contentType: string) => {
      // As `getClient()` does with no S3 configured: it throws before it reads the body.
      if (mocks.s3Missing) throw new Error('S3 client not initialized. Call initS3Client() first.');
      const chunks: Buffer[] = [];
      try {
        for await (const chunk of body) chunks.push(chunk);
      } catch {
        // As lib-storage may when its own abort of the multipart upload fails: not the body's error.
        throw new Error('AbortMultipartUpload failed');
      }
      const all = Buffer.concat(chunks);
      s3.files.set(key, { body: all, contentType });
      return all.length;
    },
    getFile: async (key: string) => read(key),
    headFile: async (key: string) => ({ contentLength: read(key).length }),
    getFileStream: async (key: string) => ({ body: Readable.from([read(key)]), contentLength: read(key).length }),
    isS3NotFound: (err: { name?: string }) => err?.name === 'NoSuchKey',
  };
});

import { getTestPool, truncateAll } from '../../../../../packages/db/test/helpers/test-db.js';
import {
  call, expectHealthy, headersFor, seedFloor, startLoadApp, stopLoadApp, verifyTestToken,
  type LoadApp, type TenantFloor,
} from '../load/load-harness.js';
import { compoundFile, exceljsWorkbook, handWorkbook, zipParts } from '../../helpers/xlsx-fixtures.js';
import { parse as parseCsv } from 'csv-parse/sync';
import { AGENCY_MAX_ROWS } from '../../../src/agency/agency-csv-ingest.js';
import { convertXlsxInWorker, xlsxConversionRunning } from '../../../src/agency/agency-xlsx-runner.js';

/** A download's `_row` column, read as CSV (a cell may hold line breaks). */
const rowColumn = (csv: string): string[] => (parseCsv(csv) as string[][]).slice(1).map((r) => r[0]!);

let loaded: LoadApp;
let floor: TenantFloor;
const app = () => loaded.app;

beforeAll(async () => {
  mocks.verifyIdToken.mockImplementation(verifyTestToken);
  loaded = await startLoadApp();
});

beforeEach(async () => {
  await truncateAll();
  s3.files.clear();
  mocks.csvBytesLimit = null;
  mocks.deadlineMs = null;
  mocks.s3Missing = false;
  floor = (await seedFloor({ tenants: 1, agentsPerTenant: 0, supervisorsPerTenant: 1, campaignsPerTenant: 1 }))[0]!;
});

afterAll(async () => {
  await stopLoadApp(loaded);
});

const supervisor = () => floor.supervisors[0]!;
const campaign = () => floor.campaigns[0]!;

function upload(name: string, content: Buffer) {
  const boundary = '----xlsxIntegration';
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\n`
    + 'Content-Type: application/octet-stream\r\n\r\n',
  );
  return app().inject({
    method: 'POST',
    url: '/proxy/agency/ingest/upload',
    headers: { ...headersFor(supervisor(), floor), 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.concat([head, content, Buffer.from(`\r\n--${boundary}--\r\n`)]),
  });
}

async function settle(jobId: string) {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const res = await call(app(), 'GET', `/proxy/agency/ingest/jobs/${jobId}`, supervisor(), floor);
    expectHealthy(res, 'poll');
    expect(res.statusCode, res.body).toBe(200);
    const job = res.json();
    if (['completed', 'failed', 'cancelled'].includes(job.status)) return job;
    if (Date.now() > deadline) throw new Error(`job ${jobId} still ${job.status}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function checkThenImport(s3Key: string, fileName: string) {
  const started = await call(app(), 'POST', '/proxy/agency/ingest/jobs', supervisor(), floor, {
    s3_key: s3Key, file_name: fileName, phone_column: 'Mobile', default_country_code: '91',
    campaign_id: campaign(), dry_run: true,
  });
  expect(started.statusCode, started.body).toBe(202);
  const check = await settle(started.json().job_id);
  expect(check.status, JSON.stringify(check)).toBe('completed');
  const imported = await call(app(), 'POST', `/proxy/agency/ingest/jobs/${check.job_id}/import`, supervisor(), floor, {});
  expect(imported.statusCode, imported.body).toBe(202);
  const job = await settle(imported.json().job_id);
  expect(job.status, JSON.stringify(job)).toBe('completed');
  return { check, job };
}

function download(jobId: string, which: 'rejected' | 'skipped') {
  return call(app(), 'GET', `/proxy/agency/ingest/jobs/${jobId}/${which}.csv`, supervisor(), floor);
}

/**
 * The supervisor's workbook: a hidden lookup sheet first, the customers on the first visible
 * sheet with two blank rows above the header, blank rows between, and an address over three
 * lines; two more visible sheets after it.
 */
async function customersWorkbook(): Promise<Buffer> {
  return exceljsWorkbook((wb) => {
    wb.addWorksheet('Lookup', { state: 'hidden' }).addRow(['Mobile', 'Name']);
    const ws = wb.addWorksheet('Customers May');
    const put = (ref: string, value: ExcelJSValue, numFmt?: string) => {
      ws.getCell(ref).value = value;
      if (numFmt) ws.getCell(ref).numFmt = numFmt;
    };
    put('A3', 'Mobile'); put('B3', 'Name'); put('C3', 'Due date'); put('D3', 'Address');
    put('A4', 9876500001); put('B4', 'Asha'); put('C4', new Date(Date.UTC(2026, 11, 5)), 'dd/mm/yyyy'); put('D4', 'Flat 4\nMG Road\nPune');
    put('A5', 'not a phone'); put('B5', 'Bhim');                               // row 5: rejected
    put('A7', 919876500003); put('B7', 'Chitra');                              // row 7: after a blank row
    put('A8', 9876500001); put('B8', 'Asha again');                            // row 8: duplicate of row 4
    put('B10', 'No number');                                                   // row 10: empty phone
    put('A11', 9876500004, '00000000000'); put('B11', 'Dev');                   // row 11
    wb.addWorksheet('Archive').addRow(['old']);
    wb.addWorksheet('Notes').addRow(['n']);
  });
}
type ExcelJSValue = string | number | Date;

describe('an Excel customer list, upload to downloads (integration)', () => {
  it('stores the first visible sheet as CSV and lines every row number up with the sheet', async () => {
    const workbook = await customersWorkbook();
    const res = await upload('Customers May.xlsx', workbook);
    expect(res.statusCode, res.body).toBe(201);
    const body = res.json();
    expect(body).toMatchObject({
      file_name: 'Customers May.xlsx',
      file_size_bytes: workbook.length,
      format: 'xlsx',
      sheet: { name: 'Customers May', other_sheet_names: ['Archive', 'Notes'] },
    });
    expect(body.s3_key).toMatch(new RegExp(`^agency-ingest/${floor.tenant}/[0-9a-f-]{36}/Customers_May\\.xlsx\\.csv$`));
    const stored = s3.files.get(body.s3_key)!;
    expect(stored.contentType).toBe('text/csv');
    expect(stored.body.toString('utf8')).toBe(
      '\n\nMobile,Name,Due date,Address\n'
      + '9876500001,Asha,2026-12-05,"Flat 4\nMG Road\nPune"\n'
      + 'not a phone,Bhim,,\n'
      + '\n'
      + '919876500003,Chitra,,\n'
      + '9876500001,Asha again,,\n'
      + '\n'
      + ',No number,,\n'
      + '09876500004,Dev,,\n',
    );

    // The column analysis reads the stored CSV as it reads any upload.
    const analysis = await call(app(), 'POST', '/proxy/agency/ingest/analyze', supervisor(), floor, { s3_key: body.s3_key, default_country_code: '91' });
    expect(analysis.statusCode, analysis.body).toBe(200);
    const columns = analysis.json().columns as Array<{ name: string; samples: string[] }>;
    expect(columns.map((c) => c.name)).toEqual(['Mobile', 'Name', 'Due date', 'Address']);
    expect(columns[2]!.samples).toEqual(['2026-12-05']);
    expect(analysis.json().suggested_phone_column).toBe('Mobile');

    const { check, job } = await checkThenImport(body.s3_key, body.file_name);
    expect(job).toMatchObject({ rows_read: 6, accepted: 3, rejected: 3, skipped: 0, duplicates: 1, file_name: 'Customers May.xlsx' });
    expect(check.rejected_sample.map((r: { row_number: number; reason_code: string }) => [r.row_number, r.reason_code])).toEqual([
      [5, 'invalid_phone'], [8, 'duplicate_phone'], [10, 'missing_phone_value'],
    ]);
    expect(check.rejected_sample[1].reason).toContain('row 4 of this file');

    const contacts = (await getTestPool().query<{ phone_e164: string; csv_line_number: number; context: Record<string, string> }>(
      'SELECT phone_e164, csv_line_number, context FROM agency_contacts WHERE campaign_id = $1 ORDER BY csv_line_number',
      [campaign()],
    )).rows;
    expect(contacts.map((c) => [c.csv_line_number, c.phone_e164])).toEqual([
      [4, '+919876500001'], [7, '+919876500003'], [11, '+919876500004'],
    ]);
    expect(contacts[0]!.context).toEqual({ Name: 'Asha', 'Due date': '2026-12-05', Address: 'Flat 4\nMG Road\nPune' });

    const rejected = await download(job.job_id, 'rejected');
    expect(rejected.statusCode, rejected.body).toBe(200);
    expect(rejected.headers['content-disposition']).toContain('Customers May-rejected-rows.csv');
    expect(rowColumn(rejected.body)).toEqual(['5', '8', '10']);

    // The same workbook again: every row already imported is skipped, under its sheet row.
    const again = await upload('Customers May.xlsx', workbook);
    const second = await checkThenImport(again.json().s3_key, 'Customers May.xlsx');
    expect(second.job).toMatchObject({ rows_read: 6, accepted: 0, skipped: 4, rejected: 2 });
    const skipped = await download(second.job.job_id, 'skipped');
    expect(skipped.statusCode, skipped.body).toBe(200);
    expect(skipped.headers['content-disposition']).toContain('Customers May-skipped-rows.csv');
    expect(rowColumn(skipped.body)).toEqual(['4', '7', '8', '11']);
  });

  it('a Mobile column formatted #,##0 imports (its whole numbers in full digits), and an amount keeps its format', async () => {
    const workbook = await exceljsWorkbook((wb) => {
      const ws = wb.addWorksheet('Customers');
      ws.addRow(['Mobile', 'Due']);
      ws.addRow([9876500001, 125000]);
      ws.addRow([9876500002, 2500.5]);
      ws.getColumn(1).numFmt = '#,##0';
      ws.getColumn(2).numFmt = '#,##0.00';
    });
    const res = await upload('customers.xlsx', workbook);
    expect(res.statusCode, res.body).toBe(201);
    expect(s3.files.get(res.json().s3_key)!.body.toString('utf8')).toBe('Mobile,Due\n9876500001,"1,25,000.00"\n9876500002,"2,500.50"\n');
    const { job } = await checkThenImport(res.json().s3_key, 'customers.xlsx');
    expect(job).toMatchObject({ rows_read: 2, accepted: 2, rejected: 0 });
    const contacts = (await getTestPool().query<{ phone_e164: string; context: Record<string, string> }>(
      'SELECT phone_e164, context FROM agency_contacts WHERE campaign_id = $1 ORDER BY phone_e164', [campaign()],
    )).rows;
    expect(contacts).toEqual([
      { phone_e164: '+919876500001', context: { Due: '1,25,000.00' } },
      { phone_e164: '+919876500002', context: { Due: '2,500.50' } },
    ]);
  });

  it('answers a CSV upload with format csv and no sheet, stored as it came', async () => {
    const csv = Buffer.from('Mobile,Name\n9876500001,Asha\n');
    const res = await upload('customers.csv', csv);
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()).toEqual({
      s3_key: expect.stringMatching(/\/customers\.csv$/),
      file_name: 'customers.csv',
      file_size_bytes: csv.length,
      format: 'csv',
    });
    expect(s3.files.get(res.json().s3_key)!.body.equals(csv)).toBe(true);
  });

  it('reads a workbook renamed .csv as the workbook it is', async () => {
    const res = await upload('customers.csv', handWorkbook({
      sheets: [{ name: 'S', xml: '<sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Mobile</t></is></c></row><row r="2"><c r="A2"><v>9876500001</v></c></row></sheetData>' }],
    }));
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()).toMatchObject({ format: 'xlsx', sheet: { name: 'S', other_sheet_names: [] } });
    expect(s3.files.get(res.json().s3_key)!.body.toString('utf8')).toBe('Mobile\n9876500001\n');
  });
});

describe('refusals (integration)', () => {
  it.each([
    ['an .xls', 'customers.xls', () => compoundFile(), 'This is an older Excel file (.xls) or a workbook with a password, which cannot be read. Open it in Excel and save it as an Excel Workbook (.xlsx) without a password, or as CSV, then upload it again.'],
    ['a password-protected workbook', 'customers.xlsx', () => compoundFile(), 'This is an older Excel file (.xls) or a workbook with a password, which cannot be read. Open it in Excel and save it as an Excel Workbook (.xlsx) without a password, or as CSV, then upload it again.'],
    ['text named .xlsx', 'customers.xlsx', () => Buffer.from('Mobile\n9876500001\n'), 'This file is named like an Excel workbook but is not one. Open it in Excel and save it as an Excel Workbook (.xlsx) or as CSV, then upload it again.'],
    ['a zip that is not a workbook', 'customers.xlsx', () => zipParts([['word/document.xml', '<w/>']]), 'This Excel file could not be read. Open it in Excel and save it again as an Excel Workbook (.xlsx) or as CSV, then upload it again.'],
    ['a workbook with no visible sheet', 'customers.xlsx', () => handWorkbook({ sheets: [{ name: 'A', state: 'hidden', xml: '<sheetData/>' }] }), 'This workbook has no sheet to read: every sheet is hidden or is a chart. Unhide the sheet with your customers, save the workbook and upload it again.'],
  ])('%s: 400 in plain words, nothing stored', async (_label, name, content, message) => {
    const res = await upload(name, content());
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json()).toEqual({ error: 'Validation Error', message });
    expect(s3.files.size).toBe(0);
  });

  it('a sheet over the row limit is refused with the ingest\'s own code and words, before anything is stored', async () => {
    // One header and AGENCY_MAX_ROWS + 1 data rows, each a single number: small once zipped.
    const rows: string[] = ['<row r="1"><c r="A1" t="inlineStr"><is><t>Mobile</t></is></c></row>'];
    for (let r = 2; r <= AGENCY_MAX_ROWS + 2; r++) rows.push(`<row r="${r}"><c r="A${r}"><v>${r}</v></c></row>`);
    const workbook = handWorkbook({ sheets: [{ name: 'S', xml: `<sheetData>${rows.join('')}</sheetData>` }] });
    const res = await upload('big.xlsx', workbook);
    expect(res.statusCode, res.body).toBe(422);
    expect(res.json()).toEqual({
      error: 'Validation Error',
      code: 'too_many_rows',
      message: 'The file has more than 1,000,000 rows. Split it into smaller campaigns.',
    });
    expect(s3.files.size).toBe(0);
  }, 120_000);

  it('a value past the 100th column is refused too_many_columns, as the analysis refuses a CSV that wide', async () => {
    const workbook = handWorkbook({ sheets: [{ name: 'S', xml: '<sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Mobile</t></is></c><c r="CX1" t="inlineStr"><is><t>far</t></is></c></row></sheetData>' }] });
    const res = await upload('wide.xlsx', workbook);
    expect(res.statusCode, res.body).toBe(422);
    expect(res.json()).toEqual({ error: 'Validation Error', code: 'too_many_columns', message: 'The file has 102 columns. The maximum is 100.' });
    expect(s3.files.size).toBe(0);
  });

  it("a sheet whose CSV passes the size limit is refused with the upload's own 413, and nothing is stored", async () => {
    mocks.csvBytesLimit = 1_000;
    const rows = Array.from({ length: 200 }, (_, i) => `<row r="${i + 1}"><c r="A${i + 1}"><v>${9876500000 + i}</v></c></row>`);
    const res = await upload('big.xlsx', handWorkbook({ sheets: [{ name: 'S', xml: `<sheetData>${rows.join('')}</sheetData>` }] }));
    expect(res.statusCode, res.body).toBe(413);
    // The body the multipart plugin's own limit answers a CSV over `CSV_MAX_BYTES` with.
    expect(res.json()).toMatchObject({ statusCode: 413, message: 'request file too large' });
    expect(s3.files.size).toBe(0);
  });

  it('a second Excel upload while one converts is told to try again in a minute (429), and the first is not disturbed', async () => {
    const rows = Array.from({ length: 40_000 }, (_, i) => `<row r="${i + 1}"><c r="A${i + 1}"><v>${9_000_000_000 + i}</v></c><c r="B${i + 1}" t="inlineStr"><is><t>${'n'.repeat(40)}</t></is></c></row>`);
    const held = await convertXlsxInWorker(handWorkbook({ sheets: [{ name: 'S', xml: `<sheetData>${rows.join('')}</sheetData>` }] }), { maxDataRows: 1_000_000, maxColumns: 100, maxCsvBytes: 512 * 1024 * 1024 });
    try {
      const res = await upload('second.xlsx', handWorkbook({ sheets: [{ name: 'S', xml: '<sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData>' }] }));
      expect(res.statusCode, res.body).toBe(429);
      expect(res.headers['retry-after']).toBe('60');
      expect(res.json()).toEqual({
        error: 'Too Many Requests',
        code: 'workbook_busy',
        message: 'Another Excel file is being read just now. Try again in a minute.',
        retry_after_seconds: 60,
      });
      // A CSV is never held up by it.
      expect((await upload('customers.csv', Buffer.from('Mobile\n9876500001\n'))).statusCode).toBe(201);
      let csvBytes = 0;
      for await (const chunk of held.csv as AsyncIterable<Buffer>) csvBytes += chunk.length;
      expect(csvBytes).toBeGreaterThan(40_000 * 50);
    } finally {
      held.csv.destroy();
      while (xlsxConversionRunning()) await new Promise((r) => setTimeout(r, 10));
    }
  });

  it('a workbook that takes longer than the deadline is refused in words (422), and nothing is stored', async () => {
    mocks.deadlineMs = 50;
    const res = await upload('slow.xlsx', handWorkbook({ sheets: [{ name: 'S', xml: '<sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData>' }] }));
    expect(res.statusCode, res.body).toBe(422);
    expect(res.json()).toEqual({
      error: 'Validation Error',
      code: 'workbook_too_slow',
      message: 'This workbook took too long to read. Save the sheet with your customers as a CSV file, or as a workbook with only that sheet, and upload it again.',
    });
    expect(s3.files.size).toBe(0);
  });

  it('S3 failing before it reads the CSV (not configured) is an error for that upload only: the slot is free for the next', async () => {
    const workbook = handWorkbook({ sheets: [{ name: 'S', xml: `<sheetData>${Array.from({ length: 20_000 }, (_, i) => `<row r="${i + 1}"><c r="A${i + 1}"><v>${9_000_000_000 + i}</v></c></row>`).join('')}</sheetData>` }] });
    mocks.s3Missing = true;
    const failed = await upload('customers.xlsx', workbook);
    expect(failed.statusCode).toBe(500);
    const freed = Date.now() + 3_000;
    while (xlsxConversionRunning() && Date.now() < freed) await new Promise((r) => setTimeout(r, 20));
    expect(xlsxConversionRunning()).toBe(false);
    mocks.s3Missing = false;
    expect((await upload('customers.xlsx', workbook)).statusCode).toBe(201);
  });

  it('a second workbook while one converts is refused before its body is read', async () => {
    const rows = Array.from({ length: 40_000 }, (_, i) => `<row r="${i + 1}"><c r="A${i + 1}"><v>${9_000_000_000 + i}</v></c></row>`);
    const held = await convertXlsxInWorker(handWorkbook({ sheets: [{ name: 'S', xml: `<sheetData>${rows.join('')}</sheetData>` }] }), { maxDataRows: 1_000_000, maxColumns: 100, maxCsvBytes: 512 * 1024 * 1024 });
    try {
      // A body cut off mid-file: had it been read, this would be the 400 for a malformed form.
      const boundary = '----xlsxEarly';
      const res = await app().inject({
        method: 'POST',
        url: '/proxy/agency/ingest/upload',
        headers: { ...headersFor(supervisor(), floor), 'content-type': `multipart/form-data; boundary=${boundary}` },
        payload: `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="second.xlsx"\r\nContent-Type: application/octet-stream\r\n\r\nPK\u0003\u0004 cut off`,
      });
      expect(res.statusCode, res.body).toBe(429);
      expect(res.json()).toMatchObject({ code: 'workbook_busy' });
    } finally {
      held.dispose();
      while (xlsxConversionRunning()) await new Promise((r) => setTimeout(r, 10));
    }
  });
});
