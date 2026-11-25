import { Readable } from 'node:stream';
import { SaxesParser } from 'saxes';
import {
  openZipEntry,
  readZipDirectory,
  ZipEntryTooLargeError,
  ZipFormatError,
  type ZipEntry,
} from './agency-xlsx-zip.js';
import {
  builtInStyle,
  classifyNumberFormat,
  padNumber,
  plainNumber,
  PLAIN,
  renderFormattedNumber,
  type NumberStyle,
} from './agency-xlsx-numfmt.js';
import { looksLikePhoneHeader } from './phone-header.js';
import { XlsxLimitError, XlsxRefusal, XLSX_MAX_CELL_CHARS } from './agency-xlsx-refusals.js';

export { classifyNumberFormat, plainNumber } from './agency-xlsx-numfmt.js';

/**
 * An Excel workbook (`.xlsx`) uploaded as a customer list, converted to the CSV the
 * roster ingest reads (IM8, `docs/decisions.md`).
 *
 * The upload route converts ONCE, at upload, and stores the CSV. The column analysis,
 * the check, the import, a re-import and the rejected- and skipped-rows downloads then
 * read that CSV exactly as they read an uploaded one: nothing after the upload knows
 * the file was a workbook. So the one question this module answers is: what CSV
 * would the supervisor's first sheet be, read the way they see it?
 *
 * Transport-free like `agency-csv-ingest.ts`: a Buffer in, a `Readable` of CSV out,
 * so the fixture matrix runs in the unit tier. The upload route never runs it in the
 * server's process: `agency-xlsx-runner.ts` runs it in a child process with its own heap
 * cap and a deadline (`agency-xlsx-worker.ts`), one at a time.
 *
 * ── The rules (IM8) ─────────────────────────────────────────────────────────
 *  - **Which sheet:** the first VISIBLE worksheet in tab order (the order of
 *    `<sheets>` in the workbook part). Hidden and very hidden sheets, chart sheets
 *    (and dialog and macro sheets) are never read and never named. No visible
 *    worksheet: refused.
 *  - **Cells:** text as written; rich text runs joined (phonetic runs left out, and
 *    only `<t>` text counts, so a pretty-printed `<is>` adds no whitespace); a
 *    hyperlink is its display text (the cell's own value); a formula is its cached
 *    result, empty when it has none; a boolean is TRUE or FALSE; an error is its text
 *    (`#N/A`), as Excel's own Save As CSV writes them. `_xHHHH_` escapes are decoded.
 *  - **Numbers, as the sheet shows them** (`agency-xlsx-numfmt.ts`): `1,25,000.00`,
 *    `15%`, `₹1,250.50`. Under General a whole number in full digits, never an exponent
 *    (919876543210, not 9.19877E+11), any other number at 15 significant digits (0.1+0.2
 *    reads 0.3); an all-zeros format (`0000000000`, up to 32 zeros) pads, so a leading
 *    zero the sheet shows survives.
 *  - **Dates:** a cell with a date format as `YYYY-MM-DD`, then ` HH:mm` (and `:ss`
 *    when the seconds are not zero) when the time is not midnight; a time-only
 *    format as `HH:mm[:ss]`; an elapsed format (`[h]:mm`, `[mm]:ss`) as the duration
 *    in hours, `HH:mm[:ss]` (90 minutes is `01:30`). That is the year-first form the
 *    agent station's date facts read (`parseDateFact` in `@magick-agency/domain`).
 *    Both date systems (1900, with its 29 Feb 1900, and 1904). A `t="d"` cell (an ISO
 *    date) is read through the same rule and its cell's style.
 *  - **Merged cells:** the value of the top-left cell only, the rest empty.
 *    Overlapping merges are refused.
 *  - **Shape:** columns A to the last column holding a value, every row padded to
 *    that width; one line per sheet row, a blank row as an empty line, trailing blank
 *    rows dropped. The ingest numbers a row by the records and blank lines before it
 *    (as a spreadsheet does), so row N of the review and the downloads is row N of
 *    the sheet.
 *  - **Text is written raw** through RFC 4180 quoting, with NO formula guard: the
 *    guard is for files that leave the organisation, and this one is only read back
 *    by the ingest, which reads it as it would a CSV holding that text. U+0000,
 *    which Postgres cannot store, is dropped.
 *
 * ── Limits: bytes, work and live objects ────────────────────────────────────
 * The workbook is already under the upload's size limit; its CSV must be too, and
 * hold no more rows than the ingest takes. A first pass over the sheet counts its
 * rows and finds its width (and its merges, which a sheet lists after its rows), and
 * stops at the first row or column over the limit, before anything is stored; the
 * second pass writes the CSV and stops once it passes the byte limit. Every part is
 * decompressed as a bounded stream (`agency-xlsx-zip.ts`), its bound the smaller of
 * an absolute cap and 100 times its compressed size plus 16 MiB. What a small file
 * could otherwise make expensive is capped where it is read: XML nesting, the zip's
 * entries, cell references, format codes and styles, shared strings (characters and
 * count), a cell's text, the cells a pass may visit, merges, sheet names. Each cap is
 * a named constant below, with the input that showed it was needed in the tests.
 *
 * ── Why not exceljs's streaming reader ──────────────────────────────────────
 * Its `WorkbookReader` writes every sheet to a temporary file when the shared
 * strings come later in the zip (they do, in what Excel writes), decodes each
 * chunk of XML as UTF-8 on its own (a character split across two chunks becomes
 * U+FFFD: 25 of 20,000 Hindi names in a probe), reads only `xl/worksheets/sheetN.xml`,
 * keeps only the last run of an inline rich string, reads a formula's boolean or
 * error result as a number, and caps nothing. This reader uses the XML parser
 * exceljs itself uses (`saxes`) on parts it opens by their relationships.
 */

export interface XlsxLimits {
  /** Data rows the ingest takes (`AGENCY_MAX_ROWS`); the header row is on top. */
  maxDataRows: number;
  /** Columns the ingest takes (`AGENCY_MAX_COLUMNS`). */
  maxColumns: number;
  /** Bytes the CSV may run to (the upload's own limit). */
  maxCsvBytes: number;
  /** Decompressed bytes of the sheet's XML, at most. Default 4 × `maxCsvBytes`. */
  maxSheetXmlBytes?: number;
  /** Characters of shared-string text held in memory, each string charged 16 more. Default 256 Mi. */
  maxSharedStringChars?: number;
  /** `<c>` elements one pass over the sheet may visit, empty ones included. Default 2 × (rows + 1) × columns. */
  maxCells?: number;
}

/** The sheet that was read and the other visible sheets, in tab order (the contract's `AgencyUploadSheet`). */
export interface XlsxSheetChoice {
  name: string;
  /** The other visible sheets' names, at most the first 255, each cut to 31 characters. */
  other_sheet_names: string[];
  /** How many other visible sheets there are, past the 255 names too. */
  other_sheet_count: number;
}

export interface XlsxWorkbook {
  sheet: XlsxSheetChoice;
  /** Data rows plus the header: non-blank rows of the sheet, as the first pass counted them. */
  rows: number;
  /** Columns in the CSV: A to the last column holding a value. */
  columns: number;
  /**
   * The CSV, streamed. Fails with {@link XlsxLimitError} (`too_large`, or `too_many_rows`) past a
   * limit; call it once.
   */
  toCsv(): Readable;
}

// ─── Caps ───────────────────────────────────────────────────────────────────

/** Workbook, relationship and style parts are small; anything past this is not a workbook anyone saved. */
const MAX_SMALL_PART_BYTES = 16 * 1024 * 1024;
/** A part may expand to this many times its compressed size, plus {@link PART_ALLOWANCE_BYTES}. */
const MAX_EXPANSION_RATIO = 100;
const PART_ALLOWANCE_BYTES = 16 * 1024 * 1024;
/** Excel's own sheet size. */
const MAX_SHEET_COLUMNS = 16_384;
const MAX_SHEET_ROWS = 1_048_576;
/** A cell reference (`XFD1048576` is 10): anything longer is not one. */
const MAX_REF_CHARS = 16;
/** XML nesting in any part; a sheet's deepest is about 6. */
const MAX_XML_DEPTH = 64;
/** Merged ranges kept for one sheet. */
const MAX_MERGES = 10_000;
/** Cell styles (`cellXfs`): Excel's own limit is 64,000. */
const MAX_CELL_STYLES = 65_536;
/** Custom number formats: Excel keeps a few hundred. */
const MAX_NUMBER_FORMATS = 4_096;
/** What each shared string costs against the character budget, on top of its text. */
const SHARED_STRING_OVERHEAD_CHARS = 16;
/** Sheet names: Excel's longest is 31 characters; the others named at most this many. */
const MAX_SHEET_NAME_CHARS = 31;
const MAX_OTHER_SHEETS = 255;
/** CSV text gathered before it is handed on. */
const CSV_CHUNK_CHARS = 256 * 1024;

/** A part's decompression bound: the absolute cap, or less for a part that compressed suspiciously well. */
function partBound(entry: ZipEntry, absolute: number): number {
  return Math.min(absolute, entry.compressedSize * MAX_EXPANSION_RATIO + PART_ALLOWANCE_BYTES);
}

// ─── XML ────────────────────────────────────────────────────────────────────

type Attrs = Record<string, string>;

interface SaxHandlers {
  open?: (name: string, attrs: Attrs) => void;
  close?: (name: string) => void;
  text?: (text: string) => void;
  /**
   * What to refuse with when text saxes holds between two tags outgrows
   * {@link MAX_PENDING_TEXT_CHARS}: set for the sheet and the shared strings, whose text is
   * cells'. The small parts (workbook, relationships, styles) are bounded by their size alone
   * (a styles part's 8 MB format code is read, and not rendered).
   */
  textTooLong?: () => Error;
}

/**
 * Text saxes may hold between two tags (it hands text on only at the next tag): four times
 * the longest cell, so a cell's own cap can still answer for a cell, and a run of text no
 * cell could hold is refused as it streams in, a chunk past this at most, never held whole.
 */
const MAX_PENDING_TEXT_CHARS = 4 * XLSX_MAX_CELL_CHARS;

/** The element or attribute name without its namespace prefix (`x:c` is `c`). */
function local(name: string): string {
  const colon = name.indexOf(':');
  return colon === -1 ? name : name.slice(colon + 1);
}

/**
 * Parse a part, yielding after each chunk so a caller can hand on what the handlers
 * gathered. The UTF-8 is decoded as one stream (a character split across two chunks
 * stays whole). A handler's throw ends the parse with that error. Nesting past
 * {@link MAX_XML_DEPTH} is refused.
 */
async function* saxChunks(source: Readable, handlers: SaxHandlers): AsyncGenerator<void> {
  const parser = new SaxesParser({ position: false });
  let failure: Error | undefined;
  let depth = 0;
  parser.on('error', (err) => {
    failure ??= err;
  });
  const open = handlers.open;
  parser.on('opentag', (tag) => {
    depth += 1;
    if (depth > MAX_XML_DEPTH) throw new XlsxRefusal('unreadable', `XML nested deeper than ${MAX_XML_DEPTH}.`);
    open?.(local(tag.name), tag.attributes as Attrs);
  });
  const close = handlers.close;
  parser.on('closetag', (tag) => {
    depth -= 1;
    close?.(local(tag.name));
  });
  if (handlers.text) {
    parser.on('text', handlers.text);
    parser.on('cdata', handlers.text);
  }
  const decoder = new TextDecoder('utf-8');
  try {
    for await (const chunk of source as AsyncIterable<Buffer>) {
      parser.write(decoder.decode(chunk, { stream: true }));
      if (failure) throw new XlsxRefusal('unreadable', `XML: ${failure.message}`);
      // saxes keeps the text (and attribute value) it has not handed on in `text`, a public
      // field its typings omit.
      if (handlers.textTooLong && ((parser as unknown as { text?: string }).text?.length ?? 0) > MAX_PENDING_TEXT_CHARS) {
        throw handlers.textTooLong();
      }
      yield;
    }
    parser.write(decoder.decode());
    parser.close();
    if (failure) throw new XlsxRefusal('unreadable', `XML: ${failure.message}`);
  } finally {
    source.destroy();
  }
}

async function parsePart(source: Readable, handlers: SaxHandlers): Promise<void> {
  for await (const _ of saxChunks(source, handlers)) { /* drain */ }
}

/** Excel's escape for characters XML cannot carry: `_x000D_` is CR, `_x005F_` a literal `_`. */
function unescapeXstring(text: string): string {
  return text.includes('_x') ? text.replace(/_x([0-9A-Fa-f]{4})_/g, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16))) : text;
}

/** At most `max` characters (by code point), so a long name never splits a surrogate pair. */
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  return Array.from(text.slice(0, max * 2)).slice(0, max).join('');
}

// ─── Parts and relationships ────────────────────────────────────────────────

interface Relationship {
  type: string;
  target: string;
}

class Package {
  private readonly entries: Map<string, ZipEntry>;

  constructor(private readonly buf: Buffer) {
    this.entries = readZipDirectory(buf);
  }

  has(path: string): boolean {
    return this.entries.has(path.toLowerCase());
  }

  /** A part's bytes, decompressed up to the smaller of `absolute` and its ratio bound ({@link partBound}). */
  open(path: string, absolute: number): Readable {
    const entry = this.entries.get(path.toLowerCase());
    if (!entry) throw new XlsxRefusal('unreadable', `The part ${path} is missing.`);
    return openZipEntry(this.buf, entry, partBound(entry, absolute));
  }

  /** A part's relationships by id (`xl/_rels/workbook.xml.rels` for `xl/workbook.xml`); none when it has no rels part. */
  async relationships(partPath: string): Promise<Map<string, Relationship>> {
    const slash = partPath.lastIndexOf('/');
    const dir = slash === -1 ? '' : partPath.slice(0, slash + 1);
    const relsPath = `${dir}_rels/${partPath.slice(slash + 1)}.rels`;
    const rels = new Map<string, Relationship>();
    if (!this.has(relsPath)) return rels;
    await parsePart(this.open(relsPath, MAX_SMALL_PART_BYTES), {
      open(name, attrs) {
        if (name !== 'Relationship' || attrs['TargetMode'] === 'External') return;
        const id = attrs['Id'];
        const target = attrs['Target'];
        if (id && target) rels.set(id, { type: attrs['Type'] ?? '', target: resolveTarget(dir, target) });
      },
    });
    return rels;
  }
}

/** A relationship's target as a part path: relative to the source part's folder, or absolute from the package root. */
function resolveTarget(baseDir: string, target: string): string {
  let decoded = target;
  try {
    decoded = decodeURIComponent(target);
  } catch { /* kept as written */ }
  const joined = decoded.startsWith('/') ? decoded.slice(1) : baseDir + decoded;
  const out: string[] = [];
  for (const segment of joined.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') out.pop();
    else out.push(segment);
  }
  return out.join('/');
}

/** A relationship type's last segment (`…/officeDocument/2006/relationships/worksheet` is `worksheet`), the transitional and strict namespaces alike. */
function relKind(type: string): string {
  return type.slice(type.lastIndexOf('/') + 1);
}

function firstOfKind(rels: Map<string, Relationship>, kind: string): string | null {
  for (const rel of rels.values()) if (relKind(rel.type) === kind) return rel.target;
  return null;
}

// ─── Workbook ───────────────────────────────────────────────────────────────

interface SheetEntry {
  name: string;
  state: string;
  rid: string | null;
}

interface WorkbookPart {
  date1904: boolean;
  sheets: SheetEntry[];
}

async function readWorkbookPart(pkg: Package, path: string): Promise<WorkbookPart> {
  const part: WorkbookPart = { date1904: false, sheets: [] };
  await parsePart(pkg.open(path, MAX_SMALL_PART_BYTES), {
    open(name, attrs) {
      if (name === 'workbookPr') {
        const v = attrs['date1904'];
        part.date1904 = v === '1' || v === 'true';
      } else if (name === 'sheet') {
        // The relationship id is the namespaced `id` (`r:id`), not `sheetId`.
        const ridKey = Object.keys(attrs).find((k) => k.includes(':') && local(k) === 'id');
        part.sheets.push({
          name: attrs['name'] ?? '',
          state: attrs['state'] ?? 'visible',
          rid: ridKey ? attrs[ridKey]! : null,
        });
      }
    },
  });
  return part;
}

// ─── Styles: what a number format makes of a number ─────────────────────────

/** Each cell style's (`cellXfs` index) number style, each format classified once. */
async function readStyles(pkg: Package, path: string | null): Promise<NumberStyle[]> {
  if (path === null || !pkg.has(path)) return [];
  const custom = new Map<number, string>();
  const xfIds: number[] = [];
  let inCellXfs = false;
  let inNumFmts = false;
  await parsePart(pkg.open(path, MAX_SMALL_PART_BYTES), {
    open(name, attrs) {
      // Only the cells' formats: a `<numFmt>` inside `<dxfs>` is conditional formatting's.
      if (name === 'numFmt' && inNumFmts) {
        if (custom.size >= MAX_NUMBER_FORMATS) throw new XlsxRefusal('unreadable', `More than ${MAX_NUMBER_FORMATS} number formats.`);
        const id = Number(attrs['numFmtId']);
        if (Number.isInteger(id)) custom.set(id, attrs['formatCode'] ?? '');
      } else if (name === 'numFmts') {
        inNumFmts = true;
      } else if (name === 'cellXfs') {
        inCellXfs = true;
      } else if (name === 'xf' && inCellXfs) {
        if (xfIds.length >= MAX_CELL_STYLES) throw new XlsxRefusal('unreadable', `More than ${MAX_CELL_STYLES} cell styles.`);
        const id = Number(attrs['numFmtId'] ?? '0');
        xfIds.push(Number.isInteger(id) ? id : 0);
      }
    },
    close(name) {
      if (name === 'cellXfs') inCellXfs = false;
      else if (name === 'numFmts') inNumFmts = false;
    },
  });
  const byFormat = new Map<number, NumberStyle>();
  return xfIds.map((id) => {
    let style = byFormat.get(id);
    if (style === undefined) {
      const code = custom.get(id);
      style = code !== undefined ? classifyNumberFormat(code) : builtInStyle(id);
      byFormat.set(id, style);
    }
    return style;
  });
}

// ─── Shared strings ─────────────────────────────────────────────────────────

async function readSharedStrings(
  pkg: Package,
  path: string | null,
  maxChars: number,
  maxCount: number,
): Promise<string[]> {
  if (path === null || !pkg.has(path)) return [];
  const strings: string[] = [];
  let charged = 0;
  let current: string | null = null;
  let inT = false;
  let phonetic = 0;
  const charge = (chars: number) => {
    charged += chars;
    if (charged > maxChars) throw new XlsxLimitError('too_large');
  };
  // The XML is about the text it holds plus its tags: four times the text budget is ample.
  await parsePart(pkg.open(path, maxChars * 4), {
    textTooLong: () => new XlsxRefusal('cell_too_long'),
    open(name) {
      if (name === 'si') {
        if (strings.length >= maxCount) throw new XlsxLimitError('too_large');
        charge(SHARED_STRING_OVERHEAD_CHARS);
        current = '';
      } else if (name === 'rPh') phonetic += 1;
      else if (name === 't' && current !== null && phonetic === 0) inT = true;
    },
    text(text) {
      if (!inT || current === null) return;
      if (current.length + text.length > XLSX_MAX_CELL_CHARS) throw new XlsxRefusal('cell_too_long');
      charge(text.length);
      current += text;
    },
    close(name) {
      if (name === 't') inT = false;
      else if (name === 'rPh') phonetic -= 1;
      else if (name === 'si' && current !== null) {
        strings.push(unescapeXstring(current));
        current = null;
      }
    },
  });
  return strings;
}

// ─── Values ─────────────────────────────────────────────────────────────────

const DAY_MS = 86_400_000;
/** Day 0 of each date system, as Excel counts: the 1900 system's day 1 is 1 Jan 1900 and it has a 29 Feb 1900 (day 60). */
const EPOCH_1900_BEFORE_LEAP = Date.UTC(1899, 11, 31);
const EPOCH_1900_AFTER_LEAP = Date.UTC(1899, 11, 30);
const EPOCH_1904 = Date.UTC(1904, 0, 1);
/** 31 Dec 9999, Excel's last date, in the 1900 system. */
const MAX_SERIAL = 2_958_465;
/** 31 Dec 9999 in the 1904 system (day 0 is 1 Jan 1904). */
const MAX_SERIAL_1904 = 2_957_003;

const two = (n: number): string => String(n).padStart(2, '0');

function clock(seconds: number, elapsedHours: number | null): string {
  const h = elapsedHours ?? Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${two(h)}:${two(m)}${s === 0 ? '' : `:${two(s)}`}`;
}

/**
 * A serial date as `YYYY-MM-DD[ HH:mm[:ss]]` (time-only styles: `HH:mm[:ss]`; elapsed: the
 * duration in hours); null when it is not a date Excel can name, which is then written as
 * the number: negative, past 31 Dec 9999, or day 0 of the 1900 system under a format with no
 * time ("0 Jan 1900").
 */
export function excelSerialToText(serial: number, style: NumberStyle, date1904: boolean): string | null {
  if (!(serial >= 0) || serial >= MAX_SERIAL + 1) return null;
  let days = Math.floor(serial);
  let seconds = Math.round((serial - days) * 86_400);
  if (seconds >= 86_400) {
    days += 1;
    seconds -= 86_400;
  }
  // Past 31 Dec 9999 of its own system once rounded: not a date Excel can name.
  if (style.kind === 'date' && days > (date1904 ? MAX_SERIAL_1904 : MAX_SERIAL)) return null;
  if (style.kind === 'time') {
    return clock(seconds, style.elapsed ? days * 24 + Math.floor(seconds / 3600) : null);
  }
  // Day 0 of the 1900 system is not a date: a date-and-time format shows only the time.
  if (!date1904 && days === 0) return style.kind === 'date' && style.hasTime ? clock(seconds, null) : null;
  let ymd: string;
  if (date1904) {
    ymd = new Date(EPOCH_1904 + days * DAY_MS).toISOString().slice(0, 10);
  } else if (days === 60) {
    ymd = '1900-02-29';
  } else {
    ymd = new Date((days < 60 ? EPOCH_1900_BEFORE_LEAP : EPOCH_1900_AFTER_LEAP) + days * DAY_MS).toISOString().slice(0, 10);
  }
  return seconds === 0 ? ymd : `${ymd} ${clock(seconds, null)}`;
}

/**
 * A `t="d"` cell (an ISO 8601 date, from strict OOXML writers) by the same rule, through
 * its cell's style: a time style gives the time of day; anything else the date, and the
 * time when it is not midnight. A zone, if written, is left out (the wall clock is kept).
 */
function isoDateText(raw: string, style: NumberStyle): string {
  const m = /^(\d{4}-\d{2}-\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(raw.trim());
  if (!m) return raw.trim();
  const [, ymd, h = '00', min = '00', s = '00'] = m;
  const seconds = Number(h) * 3600 + Number(min) * 60 + Number(s);
  if (style.kind === 'time') return clock(seconds, null);
  return seconds === 0 ? ymd! : `${ymd} ${clock(seconds, null)}`;
}

interface CellContext {
  sharedStrings: string[];
  styles: NumberStyle[];
  date1904: boolean;
  /**
   * The columns whose header looks like a phone column's (`looksLikePhoneHeader`, the column
   * analysis's own rule): a whole number in one is written in full digits whatever its
   * format (Manas, 2026-11-25). Found by the first pass, from the first row holding a value.
   */
  phoneColumns: Set<number>;
}

function styleOf(ctx: CellContext, styleIndex: number): NumberStyle {
  return ctx.styles[styleIndex] ?? ctx.styles[0] ?? PLAIN;
}

/** One cell's text in the CSV. `raw` is its `<v>`, `inline` its `<is>` text; either may be absent. */
function cellText(
  type: string | undefined,
  raw: string | null,
  inline: string | null,
  styleIndex: number,
  ctx: CellContext,
  column: number,
): string {
  if (inline !== null) return unescapeXstring(inline);
  if (raw === null) return '';
  switch (type) {
    case 's': {
      const index = Number(raw.trim());
      return Number.isInteger(index) ? ctx.sharedStrings[index] ?? '' : '';
    }
    case 'str':
    case 'inlineStr':
      return unescapeXstring(raw);
    case 'b': {
      const v = raw.trim();
      if (v === '') return '';
      return v === '1' || v.toLowerCase() === 'true' ? 'TRUE' : 'FALSE';
    }
    case 'e':
      return raw.trim();
    case 'd':
      return isoDateText(raw, styleOf(ctx, styleIndex));
    default: {
      const text = raw.trim();
      if (text === '') return '';
      const x = Number(text);
      if (!Number.isFinite(x)) return text;
      const style = styleOf(ctx, styleIndex);
      // A date or time is one in any column ("Last Contact Date" reads as a phone header).
      if (style.kind === 'date' || style.kind === 'time') return excelSerialToText(x, style, ctx.date1904) ?? plainNumber(x);
      // A phone column's whole number: its digits, whatever the format (padding still pads).
      if (ctx.phoneColumns.has(column) && Number.isInteger(x)) {
        return style.kind === 'pad' ? padNumber(x, style.width) : plainNumber(x);
      }
      if (style.kind === 'pad' && Number.isInteger(x)) return padNumber(x, style.width);
      // As the sheet shows it (`1,25,000.00`, `15%`), or the value where the format is not rendered.
      const format = style.kind === 'pad' ? style.format : style;
      if (format.kind === 'format') return renderFormattedNumber(x, format) ?? plainNumber(x);
      return plainNumber(x);
    }
  }
}

// ─── The sheet ──────────────────────────────────────────────────────────────

/**
 * `AB12` as column 28, row 12 in one pass: letters, then digits, nothing else, at most
 * {@link MAX_REF_CHARS} characters. Row 0 when there are no digits; null for anything else.
 */
export function parseCellRef(ref: string): { column: number; row: number } | null {
  if (ref.length === 0 || ref.length > MAX_REF_CHARS) return null;
  let i = 0;
  let column = 0;
  for (; i < ref.length; i += 1) {
    const code = ref.charCodeAt(i) | 0x20;
    if (code < 0x61 || code > 0x7a) break;
    column = column * 26 + (code - 0x60);
  }
  let row = 0;
  for (; i < ref.length; i += 1) {
    const digit = ref.charCodeAt(i) - 0x30;
    if (digit < 0 || digit > 9) return null;
    row = row * 10 + digit;
  }
  return { column, row };
}

function cellRef(ref: string): { column: number; row: number } {
  const parsed = parseCellRef(ref);
  if (parsed === null || parsed.column < 1 || parsed.column > MAX_SHEET_COLUMNS || parsed.row > MAX_SHEET_ROWS) {
    throw new XlsxRefusal('unreadable', `Cell reference ${clip(ref, MAX_REF_CHARS)} is not one.`);
  }
  return parsed;
}

interface Merge {
  r1: number;
  c1: number;
  r2: number;
  c2: number;
}

/** One row of the sheet: its number and its non-empty cells as `[column, text]`, in column order. */
type SheetRowHandler = (row: number, cells: Array<[number, string]>) => void;

interface SheetReadOptions {
  /** `<c>` elements this pass may visit, empty ones included. */
  maxCells: number;
  /** A non-empty cell past this column ends the read with `too_many_columns` (the first pass). */
  maxColumns?: number;
  onMerge?: (merge: Merge) => void;
}

/**
 * Read a sheet's rows, yielding after each chunk of XML. Rows come in order with their
 * own numbers (a `<row>` or `<c>` without `r` follows the one before); only cells with
 * text are passed on.
 */
function readSheet(
  source: Readable,
  ctx: CellContext,
  onRow: SheetRowHandler,
  options: SheetReadOptions,
): AsyncGenerator<void> {
  let rowNumber = 0;
  let cells: Array<[number, string]> | null = null;
  let column = 0;
  let cellCount = 0;
  let cellsVisited = 0;

  let inCell = false;
  let type: string | undefined;
  let styleIndex = 0;
  let raw: string | null = null;
  let inline: string | null = null;
  let target: 'v' | 'is' | null = null;
  let inT = false;
  let phonetic = 0;
  let cellChars = 0;
  let pastLimit = false;

  const tooWide = () => new XlsxLimitError('too_many_columns', column);

  return saxChunks(source, {
    // Text past the cap inside a cell is that cell's; anywhere else in a sheet it is not a workbook's.
    textTooLong: () => (inCell ? new XlsxRefusal('cell_too_long') : new XlsxRefusal('unreadable', 'Text outside any cell.')),
    open(name, attrs) {
      switch (name) {
        case 'row': {
          const r = attrs['r'] !== undefined ? Number(attrs['r']) : rowNumber + 1;
          if (!Number.isInteger(r) || r <= rowNumber || r > MAX_SHEET_ROWS) {
            throw new XlsxRefusal('unreadable', `Row ${clip(attrs['r'] ?? '', MAX_REF_CHARS)} is out of order.`);
          }
          rowNumber = r;
          cells = [];
          column = 0;
          cellCount = 0;
          break;
        }
        case 'c': {
          if (cells === null) return;
          cellsVisited += 1;
          if (cellsVisited > options.maxCells) throw new XlsxLimitError('too_large');
          const ref = attrs['r'];
          const c = ref !== undefined ? cellRef(ref).column : column + 1;
          cellCount += 1;
          if (c > MAX_SHEET_COLUMNS || cellCount > MAX_SHEET_COLUMNS) {
            throw new XlsxRefusal('unreadable', `Row ${rowNumber} has cells out of range.`);
          }
          column = c;
          inCell = true;
          type = attrs['t'];
          styleIndex = attrs['s'] !== undefined ? Number(attrs['s']) || 0 : 0;
          raw = null;
          inline = null;
          cellChars = 0;
          pastLimit = options.maxColumns !== undefined && c > options.maxColumns;
          break;
        }
        case 'v':
          if (inCell) {
            target = 'v';
            raw = '';
          }
          break;
        case 'is':
          if (inCell) {
            target = 'is';
            inline = '';
          }
          break;
        case 't':
          if (target === 'is' && phonetic === 0) inT = true;
          break;
        case 'rPh':
          phonetic += 1;
          break;
        case 'mergeCell': {
          const ref = attrs['ref'];
          if (!options.onMerge || ref === undefined) return;
          const colon = ref.indexOf(':');
          if (colon === -1) return;
          const from = cellRef(ref.slice(0, colon));
          const to = cellRef(ref.slice(colon + 1));
          const merge = { r1: from.row, c1: from.column, r2: to.row, c2: to.column };
          if (merge.r1 > 0 && merge.r2 >= merge.r1 && merge.c2 >= merge.c1) options.onMerge(merge);
          break;
        }
        default:
          break;
      }
    },
    text(text) {
      if (!inCell || target === null || text.length === 0) return;
      // Inside `<is>` only `<t>` text counts (not a phonetic run, not the whitespace of a
      // pretty-printed `<is>`); `<v>` holds its text directly.
      if (target === 'is' && !inT) return;
      // Text in a cell past the last column the ingest takes is a value there: refused as saxes
      // hands it on, before this reader holds it (saxes itself holds at most
      // MAX_PENDING_TEXT_CHARS of it; a shared-string index or number is judged when the cell closes).
      if (pastLimit && (target === 'is' || type === 'str' || type === 'inlineStr')) throw tooWide();
      cellChars += text.length;
      if (cellChars > XLSX_MAX_CELL_CHARS) throw new XlsxRefusal('cell_too_long');
      if (target === 'v') raw += text;
      else inline += text;
    },
    close(name) {
      switch (name) {
        case 'v':
        case 'is':
          target = null;
          inT = false;
          break;
        case 't':
          inT = false;
          break;
        case 'rPh':
          phonetic -= 1;
          break;
        case 'c': {
          if (!inCell) return;
          inCell = false;
          target = null;
          inT = false;
          const text = cellText(type, raw, inline, styleIndex, ctx, column);
          if (text !== '' && cells !== null) {
            if (pastLimit) throw tooWide();
            cells.push([column, text]);
          }
          break;
        }
        case 'row':
          if (cells !== null) {
            cells.sort((a, b) => a[0] - b[0]);
            onRow(rowNumber, cells);
            cells = null;
          }
          break;
        default:
          break;
      }
    },
  });
}

/**
 * The merged ranges over each row in turn: is a cell one a merge hides (in a range, not its
 * top-left)? Asked only of rows that have cells, in ascending order. The ranges over a row
 * are kept sorted by first column (a lookup is a binary search) and leave in order of last
 * row (a heap), so a row costs the ranges that start or end there, not every range. Two
 * ranges over the same cell are refused: Excel never writes them.
 */
class MergeMask {
  private readonly pending: Merge[];
  private next = 0;
  /** The ranges over the current row, by first column. */
  private active: Merge[] = [];
  /** The same ranges, a min-heap on last row. */
  private ends: Merge[] = [];

  constructor(merges: Merge[]) {
    this.pending = [...merges].sort((a, b) => a.r1 - b.r1);
  }

  enterRow(row: number): void {
    while (this.ends.length > 0 && this.ends[0]!.r2 < row) {
      const gone = this.popEnd();
      const at = this.indexOf(gone.c1);
      if (at !== -1 && this.active[at] === gone) this.active.splice(at, 1);
    }
    while (this.next < this.pending.length && this.pending[this.next]!.r1 <= row) {
      const merge = this.pending[this.next]!;
      this.next += 1;
      if (merge.r2 < row) continue;
      const at = this.insertionPoint(merge.c1);
      const before = this.active[at - 1];
      const after = this.active[at];
      if ((before && before.c2 >= merge.c1) || (after && after.c1 <= merge.c2)) {
        throw new XlsxRefusal('unreadable', 'Two merged ranges overlap.');
      }
      this.active.splice(at, 0, merge);
      this.pushEnd(merge);
    }
  }

  hides(row: number, column: number): boolean {
    const at = this.insertionPoint(column + 1) - 1;
    const found = this.active[at];
    if (!found || column > found.c2) return false;
    return !(row === found.r1 && column === found.c1);
  }

  /** The first index whose range starts at or after `column`. */
  private insertionPoint(column: number): number {
    let lo = 0;
    let hi = this.active.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.active[mid]!.c1 < column) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  private indexOf(c1: number): number {
    const at = this.insertionPoint(c1);
    return this.active[at]?.c1 === c1 ? at : -1;
  }

  private pushEnd(merge: Merge): void {
    const heap = this.ends;
    heap.push(merge);
    let i = heap.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (heap[parent]!.r2 <= heap[i]!.r2) break;
      [heap[parent], heap[i]] = [heap[i]!, heap[parent]!];
      i = parent;
    }
  }

  private popEnd(): Merge {
    const heap = this.ends;
    const top = heap[0]!;
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let smallest = i;
        if (l < heap.length && heap[l]!.r2 < heap[smallest]!.r2) smallest = l;
        if (r < heap.length && heap[r]!.r2 < heap[smallest]!.r2) smallest = r;
        if (smallest === i) break;
        [heap[smallest], heap[i]] = [heap[i]!, heap[smallest]!];
        i = smallest;
      }
    }
    return top;
  }
}

/** One CSV field: RFC 4180 quoting, nothing else (no formula guard: see the module header). */
function csvField(text: string): string {
  const clean = text.includes('\u0000') ? text.replace(/\u0000/g, '') : text;
  return /[",\r\n]/.test(clean) ? `"${clean.replace(/"/g, '""')}"` : clean;
}

/**
 * Open a workbook held in memory: choose its sheet, read its strings and styles, and
 * make the first pass over the sheet (rows, width, merges). Throws {@link XlsxRefusal}
 * for a workbook that cannot be read or has no visible sheet, and {@link XlsxLimitError}
 * for one over a limit, before any CSV is written.
 */
export async function openXlsxWorkbook(buf: Buffer, limits: XlsxLimits): Promise<XlsxWorkbook> {
  try {
    return await openWorkbook(buf, limits);
  } catch (err) {
    throw asXlsxError(err);
  }
}

/**
 * Every failure as a refusal: a part over its bound is `too_large`, anything else this
 * module did not throw itself (a damaged zip, a string the engine cannot build) is the
 * workbook being unreadable, never a 500.
 */
function asXlsxError(err: unknown): XlsxRefusal | XlsxLimitError {
  if (err instanceof XlsxRefusal || err instanceof XlsxLimitError) return err;
  if (err instanceof ZipEntryTooLargeError) return new XlsxLimitError('too_large');
  if (err instanceof RangeError && /string length|array length|allocation/i.test(err.message)) return new XlsxLimitError('too_large');
  return new XlsxRefusal('unreadable', err instanceof Error ? `${err.name}: ${err.message}` : 'unknown error');
}

async function openWorkbook(buf: Buffer, limits: XlsxLimits): Promise<XlsxWorkbook> {
  const maxSheetXmlBytes = limits.maxSheetXmlBytes ?? limits.maxCsvBytes * 4;
  const maxSharedStringChars = limits.maxSharedStringChars ?? 256 * 1024 * 1024;
  const maxCells = limits.maxCells ?? 2 * (limits.maxDataRows + 1) * limits.maxColumns;
  const pkg = new Package(buf);

  const rootRels = await pkg.relationships('');
  const workbookPath = firstOfKind(rootRels, 'officeDocument') ?? 'xl/workbook.xml';
  if (!pkg.has(workbookPath)) throw new XlsxRefusal('unreadable', 'The workbook part is missing.');
  const workbook = await readWorkbookPart(pkg, workbookPath);
  const workbookRels = await pkg.relationships(workbookPath);

  const visible = workbook.sheets
    .filter((s) => s.state !== 'hidden' && s.state !== 'veryHidden')
    .map((s) => ({ sheet: s, rel: s.rid !== null ? workbookRels.get(s.rid) : undefined }))
    .filter((s): s is { sheet: SheetEntry; rel: Relationship } => s.rel !== undefined && relKind(s.rel.type) === 'worksheet');
  const chosen = visible[0];
  if (!chosen) throw new XlsxRefusal('no_visible_sheet');
  if (!pkg.has(chosen.rel.target)) throw new XlsxRefusal('unreadable', 'The sheet part is missing.');

  const ctx: CellContext = {
    styles: await readStyles(pkg, firstOfKind(workbookRels, 'styles')),
    sharedStrings: await readSharedStrings(
      pkg,
      firstOfKind(workbookRels, 'sharedStrings'),
      maxSharedStringChars,
      (limits.maxDataRows + 1) * limits.maxColumns,
    ),
    date1904: workbook.date1904,
    phoneColumns: new Set<number>(),
  };

  // First pass: rows, width and merges, stopping at the first row or column over the limit.
  let rows = 0;
  let columns = 0;
  const merges: Merge[] = [];
  // The candidates for the row the import takes as its header: the first row holding a value,
  // and the first holding one that is not only spaces, tabs or form feeds (a one-column CSV's
  // line of those is a blank line to the import's parser, which skips it).
  let firstRow: Array<[number, string]> | null = null;
  let firstSolidRow: Array<[number, string]> | null = null;
  // Up to SAMPLED_ROWS rows each column holds a value on, to tell once the merges are known
  // (they come after the rows) whether a merge hides every value of a column.
  const sampled = new Map<number, { rows: number[]; more: boolean }>();
  await drain(readSheet(
    pkg.open(chosen.rel.target, maxSheetXmlBytes),
    ctx,
    (row, cells) => {
      if (cells.length === 0) return;
      firstRow ??= cells;
      if (firstSolidRow === null && cells.some(([, text]) => !/^[ \t\f]*$/.test(text))) firstSolidRow = cells;
      rows += 1;
      if (rows > limits.maxDataRows + 1) throw new XlsxLimitError('too_many_rows');
      for (const [c] of cells) {
        let sample = sampled.get(c);
        if (!sample) sampled.set(c, (sample = { rows: [], more: false }));
        if (sample.rows.length < SAMPLED_ROWS) sample.rows.push(row);
        else sample.more = true;
      }
      const last = cells[cells.length - 1]![0];
      if (last > columns) columns = last;
    },
    {
      maxCells,
      maxColumns: limits.maxColumns,
      onMerge(merge) {
        if (merges.length >= MAX_MERGES) throw new XlsxRefusal('unreadable', `The sheet has more than ${MAX_MERGES} merged ranges.`);
        merges.push(merge);
      },
    },
  ));

  // The width: the last column holding a value a merge does not hide.
  if (merges.length > 0) columns = visibleWidth(sampled, merges);
  // The phone rule's header row is the row the import takes as its header.
  const header = columns === 1 ? firstSolidRow : firstRow;
  for (const [c, text] of (header ?? []) as Array<[number, string]>) {
    if (c <= columns && looksLikePhoneHeader(text.trim())) ctx.phoneColumns.add(c);
  }

  let used = false;
  return {
    sheet: {
      name: clip(chosen.sheet.name, MAX_SHEET_NAME_CHARS),
      other_sheet_names: visible.slice(1, 1 + MAX_OTHER_SHEETS).map((s) => clip(s.sheet.name, MAX_SHEET_NAME_CHARS)),
      other_sheet_count: visible.length - 1,
    },
    rows,
    columns,
    toCsv() {
      if (used) throw new Error('toCsv() was already called.');
      used = true;
      return Readable.from(
        writeCsv(pkg, chosen.rel.target, maxSheetXmlBytes, maxCells, ctx, merges, columns, limits),
        { objectMode: false },
      );
    },
  };
}

/** Rows sampled per column for {@link visibleWidth}. */
const SAMPLED_ROWS = 64;

/**
 * The last column holding a value no merge hides (a value in a merged range other than its
 * top-left cell is not shown, so it must not widen the CSV). A column whose sampled rows all
 * sit hidden, with no more rows than were sampled, holds no shown value; a column with more
 * values than were sampled counts as shown (a merge hiding all of them is not worth holding
 * every row for).
 */
function visibleWidth(sampled: Map<number, { rows: number[]; more: boolean }>, merges: Merge[]): number {
  let width = 0;
  for (const [column, sample] of sampled) {
    if (column <= width) continue;
    const covering = merges.filter((m) => m.c1 <= column && column <= m.c2);
    const hidden = (row: number) => covering.some((m) => m.r1 <= row && row <= m.r2 && !(row === m.r1 && column === m.c1));
    if (sample.more || sample.rows.some((row) => !hidden(row))) width = column;
  }
  return width;
}

async function drain(chunks: AsyncGenerator<void>): Promise<void> {
  for await (const _ of chunks) { /* drain */ }
}

/** The second pass: the sheet as CSV, a line per row from row 1 to the last row holding a value. */
async function* writeCsv(
  pkg: Package,
  sheetPath: string,
  maxSheetXmlBytes: number,
  maxCells: number,
  ctx: CellContext,
  merges: Merge[],
  width: number,
  limits: XlsxLimits,
): AsyncGenerator<Buffer> {
  const mask = merges.length > 0 ? new MergeMask(merges) : null;
  let pending = '';
  let bytes = 0;
  let rows = 0;
  let lastWritten = 0;
  try {
    for await (const _ of readSheet(pkg.open(sheetPath, maxSheetXmlBytes), ctx, (row, cells) => {
      if (cells.length === 0) return;
      if (mask) {
        mask.enterRow(row);
        cells = cells.filter(([c]) => !mask.hides(row, c));
        if (cells.length === 0) return;
      }
      rows += 1;
      if (rows > limits.maxDataRows + 1) throw new XlsxLimitError('too_many_rows');
      // Blank rows since the last one written are empty lines, so this row is line `row`.
      const fields: string[] = new Array<string>(width).fill('');
      for (const [c, text] of cells) if (c <= width) fields[c - 1] = csvField(text);
      const line = '\n'.repeat(row - lastWritten - 1) + fields.join(',') + '\n';
      lastWritten = row;
      bytes += Buffer.byteLength(line, 'utf8');
      if (bytes > limits.maxCsvBytes) throw new XlsxLimitError('too_large');
      pending += line;
    }, { maxCells })) {
      if (pending.length >= CSV_CHUNK_CHARS) {
        const out = Buffer.from(pending, 'utf8');
        pending = '';
        yield out;
      }
    }
  } catch (err) {
    throw asXlsxError(err);
  }
  if (pending.length > 0) yield Buffer.from(pending, 'utf8');
}
