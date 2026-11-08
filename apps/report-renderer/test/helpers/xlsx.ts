import ExcelJS from 'exceljs';

/** Read an xlsx buffer back with exceljs' (non-streaming) reader. */
export async function readWorkbook(buf: Buffer): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  return wb;
}

export function headerOf(ws: ExcelJS.Worksheet, row = 1): string[] {
  const out: string[] = [];
  ws.getRow(row).eachCell({ includeEmpty: false }, (c) => out.push(String(c.value)));
  return out;
}

/**
 * A cell's Excel serial number. exceljs' reader turns any number under a date-like format
 * (`[h]:mm:ss` too) back into a Date, so durations come back as dates near 1900; this undoes it.
 */
export function serial(value: unknown): number {
  if (typeof value === 'number') return value;
  if (value instanceof Date) return (value.getTime() - Date.UTC(1899, 11, 30)) / 86_400_000;
  throw new Error(`not a number or date: ${String(value)}`);
}
