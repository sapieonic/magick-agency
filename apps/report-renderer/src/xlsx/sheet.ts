/**
 * Writing one typed table to a streaming worksheet: a bold, frozen header row with an
 * autofilter, cells converted from dataset units to Excel's (durations as time values shown
 * `[h]:mm:ss`, percentages as fractions shown `0.0%`, instants as local date-times in the
 * dataset's zone), column widths from the header and the first rows, and an optional first-row
 * note (a truncated detail sheet, RP12). Rows are committed as they are written, so a
 * 100,000-row sheet never sits in memory.
 */
import type ExcelJS from 'exceljs';
import type { ReportDetailColumnType } from '@magick-agency/contracts/reports';
import { zonedParts } from '../format';

export type CellType = ReportDetailColumnType;

export interface SheetColumn {
  header: string;
  type: CellType;
  /** Overrides the computed width (characters). */
  width?: number;
}

/** The number format Excel shows each type in. */
export const NUM_FMT: Partial<Record<CellType, string>> = {
  int: '#,##0',
  number: '#,##0.00',
  percent: '0.0%',
  duration_s: '[h]:mm:ss',
  datetime: 'yyyy-mm-dd hh:mm:ss',
  date: 'yyyy-mm-dd',
};

const DEFAULT_WIDTH: Record<CellType, number> = {
  text: 14,
  int: 10,
  number: 12,
  percent: 9,
  duration_s: 11,
  datetime: 20,
  date: 12,
  bool: 9,
};

/** An ISO instant as an Excel date whose wall clock is the instant's in `zone`. */
export function localExcelDate(iso: string, zone: string): Date {
  const p = zonedParts(iso, zone);
  return new Date(Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second));
}

/**
 * One dataset cell as an Excel value. A string in a numeric column is words ("Not enough calls
 * to rate") and is written as text, never coerced to a number; a value that does not parse is
 * written as its text rather than dropped.
 */
export function excelValue(value: unknown, type: CellType, zone: string): ExcelJS.CellValue {
  if (value === null || value === undefined) return null;
  switch (type) {
    case 'text':
      return typeof value === 'string' ? value : String(value);
    case 'bool':
      return typeof value === 'boolean' ? value : String(value);
    case 'int':
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) ? value : String(value);
    case 'percent':
      return typeof value === 'number' && Number.isFinite(value) ? value / 100 : String(value);
    case 'duration_s':
      return typeof value === 'number' && Number.isFinite(value) ? value / 86_400 : String(value);
    case 'datetime': {
      if (typeof value !== 'string') return String(value);
      const t = Date.parse(value);
      return Number.isNaN(t) ? value : localExcelDate(value, zone);
    }
    case 'date': {
      if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return String(value);
      return new Date(`${value}T00:00:00Z`);
    }
    default: {
      const never: never = type;
      return String(never);
    }
  }
}

const HEADER_FILL: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F3F6' } };

export interface WriteTableOptions {
  zone: string;
  /** A sentence in the first row (the header moves to row 2). */
  note?: string;
  /** Rows used to size the columns, when the rows themselves are a stream. */
  sample?: unknown[][];
}

/** Add a worksheet, write the table into it, commit it. Returns the data rows written. */
export async function writeTable(
  workbook: ExcelJS.stream.xlsx.WorkbookWriter,
  name: string,
  columns: SheetColumn[],
  rows: Iterable<unknown[]> | AsyncIterable<unknown[]>,
  options: WriteTableOptions,
): Promise<number> {
  const headerRow = options.note ? 2 : 1;
  const sheet = workbook.addWorksheet(sheetName(name), {
    views: [{ state: 'frozen', ySplit: headerRow, xSplit: 0 }],
  });
  const sample = options.sample ?? (Array.isArray(rows) ? (rows as unknown[][]).slice(0, 200) : []);
  sheet.columns = columns.map((c, i) => ({ width: c.width ?? columnWidth(c, sample.map((r) => r[i])) }));
  sheet.autoFilter = { from: { row: headerRow, column: 1 }, to: { row: headerRow, column: Math.max(1, columns.length) } };

  if (options.note) {
    const noteRow = sheet.addRow([options.note]);
    noteRow.getCell(1).font = { italic: true, bold: true, color: { argb: 'FF9A3412' } };
    noteRow.commit();
  }
  const header = sheet.addRow(columns.map((c) => c.header));
  header.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: 'FF151A22' } };
    cell.fill = HEADER_FILL;
    cell.alignment = { vertical: 'bottom', wrapText: true };
  });
  header.commit();

  let n = 0;
  for await (const raw of rows as AsyncIterable<unknown[]>) {
    const values = columns.map((c, i) => excelValue(raw[i], c.type, options.zone));
    const row = sheet.addRow(values);
    values.forEach((v, i) => {
      const fmt = NUM_FMT[columns[i]!.type];
      if (fmt && (typeof v === 'number' || v instanceof Date)) row.getCell(i + 1).numFmt = fmt;
    });
    row.commit();
    n += 1;
  }
  sheet.commit();
  return n;
}

/** Excel's sheet-name rules: at most 31 characters, none of `[]:*?/\`. */
export function sheetName(name: string): string {
  return name.replace(/[[\]:*?/\\]/g, ' ').slice(0, 31) || 'Sheet';
}

function columnWidth(c: SheetColumn, values: unknown[]): number {
  let w = Math.max(DEFAULT_WIDTH[c.type], c.header.length + 2);
  if (c.type === 'text') {
    for (const v of values) if (typeof v === 'string') w = Math.max(w, Math.min(60, v.length + 2));
  }
  return w;
}
