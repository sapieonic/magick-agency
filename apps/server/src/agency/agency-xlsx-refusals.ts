/**
 * What an Excel upload can be refused for, and what the upload is (IM8): a LEAF, no imports,
 * so the upload route, the conversion's runner and the conversion itself (`agency-xlsx.ts`)
 * share one definition without the route or the runner loading the XML parser.
 */

/** What was uploaded. Detected from the bytes first, then the name. */
export type UploadFormat = 'csv' | 'xlsx';

/** Why a workbook cannot be read at all: refused 400 with {@link xlsxRefusalMessage}. */
export type XlsxRefusalKind = 'legacy_or_encrypted' | 'not_a_workbook' | 'unreadable' | 'no_visible_sheet' | 'cell_too_long';

export class XlsxRefusal extends Error {
  constructor(public readonly kind: XlsxRefusalKind, detail?: string) {
    super(detail ?? xlsxRefusalMessage(kind));
    this.name = 'XlsxRefusal';
  }
}

/**
 * A workbook over one of the upload's limits. `too_many_rows`, `too_many_columns` and
 * `too_large` (the CSV it becomes is over the CSV path's size limit, and only that) are
 * refused as the CSV path refuses them; `too_complex` is one of the converter's own caps on
 * its work (shared strings, cells a pass visits, a part that expands past its bound); `too_slow`
 * and `too_much_memory` are the conversion's deadline and heap cap (`agency-xlsx-runner.ts`).
 */
export type XlsxLimitKind =
  | 'too_many_rows'
  | 'too_many_columns'
  | 'too_large'
  | 'too_complex'
  | 'too_slow'
  | 'too_much_memory';

export class XlsxLimitError extends Error {
  constructor(
    public readonly kind: XlsxLimitKind,
    /** For `too_many_columns`: the column number found over the limit. */
    public readonly columns?: number,
  ) {
    super(`The workbook is over the upload's limit (${kind}).`);
    this.name = 'XlsxLimitError';
  }
}

/** The most characters a cell may hold: past Excel's 32,767 and Google Sheets' 50,000. */
export const XLSX_MAX_CELL_CHARS = 65_536;

const REFUSAL_MESSAGE: Record<XlsxRefusalKind, string> = {
  legacy_or_encrypted:
    'This is an older Excel file (.xls) or a workbook with a password, which cannot be read. ' +
    'Open it in Excel and save it as an Excel Workbook (.xlsx) without a password, or as CSV, then upload it again.',
  not_a_workbook:
    'This file is named like an Excel workbook but is not one. ' +
    'Open it in Excel and save it as an Excel Workbook (.xlsx) or as CSV, then upload it again.',
  unreadable:
    'This Excel file could not be read. ' +
    'Open it in Excel and save it again as an Excel Workbook (.xlsx) or as CSV, then upload it again.',
  no_visible_sheet:
    'This workbook has no sheet to read: every sheet is hidden or is a chart. ' +
    'Unhide the sheet with your customers, save the workbook and upload it again.',
  cell_too_long:
    `A cell in this workbook holds more than ${XLSX_MAX_CELL_CHARS.toLocaleString('en-IN')} characters, more than a spreadsheet cell can. ` +
    'Shorten it, save the workbook and upload it again.',
};

/** The plain-words message a refusal is answered with. */
export function xlsxRefusalMessage(kind: XlsxRefusalKind): string {
  return REFUSAL_MESSAGE[kind];
}

/** A name a workbook goes by (`.xlsx`, or `.xlsm` for one with macros), whatever its case. */
export function isWorkbookName(fileName: string): boolean {
  return /\.xls[xm]$/i.test(fileName.trim());
}

/** The compound-file (OLE) signature: an Excel 97–2003 `.xls`, and also what a password-protected `.xlsx` is. */
const CFB_SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
/** A zip's first four bytes: a local file header (`PK\x03\x04`), or the end record of an empty zip (`PK\x05\x06`). */
const ZIP_LOCAL = [0x50, 0x4b, 0x03, 0x04];
const ZIP_EMPTY = [0x50, 0x4b, 0x05, 0x06];

function startsWith(head: Uint8Array, signature: readonly number[]): boolean {
  if (head.length < signature.length) return false;
  for (let i = 0; i < signature.length; i += 1) if (head[i] !== signature[i]) return false;
  return true;
}

/**
 * What the upload is, by its bytes and then its name:
 *
 *  - a compound file (`.xls`, or a `.xlsx` with a password): refused, whatever its name;
 *  - a zip: read as a workbook, whatever its name (a workbook renamed `.csv` is still a
 *    workbook, and no zip is a CSV); a zip that is not a workbook is refused when it is read;
 *  - text named `.xlsx` or `.xlsm`: refused (it is not the workbook its name says, and
 *    reading it as CSV would show whatever it holds as columns);
 *  - anything else: CSV, as before (a CSV named `.txt` or `.xls` included).
 */
export function detectUploadFormat(head: Uint8Array, fileName: string): UploadFormat {
  if (startsWith(head, CFB_SIGNATURE)) throw new XlsxRefusal('legacy_or_encrypted');
  if (startsWith(head, ZIP_LOCAL) || startsWith(head, ZIP_EMPTY)) return 'xlsx';
  if (isWorkbookName(fileName)) throw new XlsxRefusal('not_a_workbook');
  return 'csv';
}
