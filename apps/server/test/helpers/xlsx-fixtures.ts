/**
 * Workbooks for the Excel upload's tests (IM8, `src/agency/agency-xlsx.ts`).
 *
 * Two kinds, on purpose. `exceljsWorkbook` builds one with exceljs's writer, which is
 * quick for the bulk of the rules but would let a reader that only understands what
 * exceljs writes pass. `zipParts` and `excelParts` build one by hand from its XML parts,
 * laid out the way Excel and LibreOffice write them (the sheets ahead of the shared
 * strings in the zip, inline strings, a shared formula, a hidden first sheet, a merge),
 * so the reader is tested against those too.
 */
import { crc32, deflateRawSync } from 'node:zlib';
import ExcelJS from 'exceljs';

export type Parts = Array<[name: string, content: string | Buffer]>;

/**
 * A zip of `parts`, in the order given (deflated unless `store`). Optional `flags` and
 * `method` per part forge what a test needs (an encrypted part, an unknown method).
 */
export function zipParts(
  parts: Parts,
  options: { store?: boolean; forge?: Record<string, { flags?: number; method?: number }> } = {},
): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of parts) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    const forged = options.forge?.[name] ?? {};
    const method = forged.method ?? (options.store ? 0 : 8);
    const body = method === 8 ? deflateRawSync(data) : data;
    const nameBytes = Buffer.from(name, 'utf8');
    const flags = (forged.flags ?? 0) | 0x800;
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    locals.push(local, nameBytes, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);

    offset += 30 + nameBytes.length + body.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(parts.length, 8);
  end.writeUInt16LE(parts.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

const NS_MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const NS_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PKG_REL = 'http://schemas.openxmlformats.org/package/2006/relationships';

export interface HandSheet {
  name: string;
  state?: 'visible' | 'hidden' | 'veryHidden';
  /** The `<sheetData>` and anything after it (`<mergeCells>`), as raw XML. A chart sheet when `chart` is set. */
  xml?: string;
  chart?: boolean;
}

export interface HandWorkbook {
  sheets: HandSheet[];
  sharedStrings?: string[] | string;
  /** `<numFmts>` and `<cellXfs>` content, raw. Default: General only. */
  styles?: { numFmts?: string; cellXfs: string };
  date1904?: boolean;
  /** Write the relationship targets absolute (`/xl/worksheets/sheet1.xml`), as some writers do. */
  absoluteTargets?: boolean;
  /** Prefix SpreadsheetML elements (`x:`), as the .NET Open XML SDK writes them. */
  prefix?: string;
}

const xmlEscape = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** A shared-string table from plain strings (each a `<si><t>`), or raw `<si>` XML. */
function sharedStringsXml(strings: string[] | string): string {
  const body = typeof strings === 'string'
    ? strings
    : strings.map((s) => `<si><t xml:space="preserve">${xmlEscape(s)}</t></si>`).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<sst xmlns="${NS_MAIN}">${body}</sst>`;
}

/**
 * The parts of a workbook, in the order Excel stores them: content types, package rels,
 * workbook, workbook rels, the sheets, styles, and the shared strings LAST.
 */
export function excelParts(book: HandWorkbook): Parts {
  const p = book.prefix ? `${book.prefix}:` : '';
  const xmlns = book.prefix ? `xmlns:${book.prefix}="${NS_MAIN}"` : `xmlns="${NS_MAIN}"`;
  const target = (path: string) => (book.absoluteTargets ? `/xl/${path}` : path);
  const parts: Parts = [];
  parts.push(['[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>']);
  parts.push(['_rels/.rels', `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="${PKG_REL}"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`]);

  const sheetEls = book.sheets
    .map((s, i) => `<${p}sheet name="${xmlEscape(s.name)}" sheetId="${i + 1}"${s.state ? ` state="${s.state}"` : ''} r:id="rId${i + 1}"/>`)
    .join('');
  parts.push(['xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8"?><${p}workbook ${xmlns} xmlns:r="${NS_REL}">${book.date1904 ? `<${p}workbookPr date1904="1"/>` : `<${p}workbookPr/>`}<${p}sheets>${sheetEls}</${p}sheets></${p}workbook>`]);

  const n = book.sheets.length;
  const rels = book.sheets.map((s, i) => s.chart
    ? `<Relationship Id="rId${i + 1}" Type="${REL}/chartsheet" Target="${target(`chartsheets/sheet${i + 1}.xml`)}"/>`
    : `<Relationship Id="rId${i + 1}" Type="${REL}/worksheet" Target="${target(`worksheets/sheet${i + 1}.xml`)}"/>`);
  rels.push(`<Relationship Id="rId${n + 1}" Type="${REL}/styles" Target="${target('styles.xml')}"/>`);
  if (book.sharedStrings !== undefined) rels.push(`<Relationship Id="rId${n + 2}" Type="${REL}/sharedStrings" Target="${target('sharedStrings.xml')}"/>`);
  parts.push(['xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="${PKG_REL}">${rels.join('')}</Relationships>`]);

  book.sheets.forEach((s, i) => {
    if (s.chart) {
      parts.push([`xl/chartsheets/sheet${i + 1}.xml`, `<?xml version="1.0" encoding="UTF-8"?><chartsheet xmlns="${NS_MAIN}"/>`]);
    } else {
      parts.push([`xl/worksheets/sheet${i + 1}.xml`, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<${p}worksheet ${xmlns} xmlns:r="${NS_REL}">${s.xml ?? `<${p}sheetData/>`}</${p}worksheet>`]);
    }
  });

  const styles = book.styles ?? { cellXfs: '<xf numFmtId="0"/>' };
  parts.push(['xl/styles.xml', `<?xml version="1.0" encoding="UTF-8"?><styleSheet xmlns="${NS_MAIN}">${styles.numFmts ? `<numFmts>${styles.numFmts}</numFmts>` : ''}<cellStyleXfs><xf numFmtId="14"/></cellStyleXfs><cellXfs>${styles.cellXfs}</cellXfs></styleSheet>`]);
  if (book.sharedStrings !== undefined) parts.push(['xl/sharedStrings.xml', sharedStringsXml(book.sharedStrings)]);
  return parts;
}

/** A hand-built workbook as bytes. */
export function handWorkbook(book: HandWorkbook): Buffer {
  return zipParts(excelParts(book));
}

/** A workbook written by exceljs. */
export async function exceljsWorkbook(build: (wb: ExcelJS.Workbook) => void): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  build(wb);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** The compound-file signature an `.xls` (or a password-protected `.xlsx`) starts with, and some padding. */
export function compoundFile(): Buffer {
  return Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(504)]);
}
