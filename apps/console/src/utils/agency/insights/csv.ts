import { outcomeReportFilename } from '../../../api/exportCsv';

/**
 * "Download CSV" for every table on the Insights tab, built in the browser from
 * the data the section already holds. There is no export endpoint behind it: the
 * file is exactly the rows on screen, at the moment they were read.
 *
 * ── RFC 4180 ────────────────────────────────────────────────────────────────
 * One header row; CRLF between records; a field is quoted when it holds a comma,
 * a double quote, CR or LF, and a double quote inside is doubled. Every other
 * field goes out bare, so a spreadsheet reads `12345` as a number.
 *
 * ── Numbers unformatted ─────────────────────────────────────────────────────
 * `12345`, never `12,345`: grouping is display, and a grouped number is a string
 * to every tool that opens the file. A rate goes out as its full value (a
 * withheld or absent rate as an empty cell, never `0`), and the caller passes the
 * raw count rather than the text on screen.
 */

export type CsvCell = string | number | boolean | null | undefined;

export interface CsvColumn<Row> {
  header: string;
  value: (row: Row) => CsvCell;
}

function cell(value: CsvCell): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** A header and rows as RFC 4180 text. */
export function toCsv(header: readonly string[], rows: readonly (readonly CsvCell[])[]): string {
  return [header, ...rows].map((record) => record.map(cell).join(',')).join('\r\n') + '\r\n';
}

/** The same, from column definitions. */
export function csvFromColumns<Row>(columns: readonly CsvColumn<Row>[], rows: readonly Row[]): string {
  return toCsv(
    columns.map((column) => column.header),
    rows.map((row) => columns.map((column) => column.value(row))),
  );
}

/** `insights-<section>-<campaign>.csv`, through the same sanitiser as every other export. */
export function insightsCsvFilename(campaignName: string | null | undefined, section: string, campaignId: string): string {
  return `insights-${section}-${outcomeReportFilename(campaignName ?? null, campaignId)}`;
}

/** Hand the text to the browser as a download. */
export function downloadCsv(filename: string, csv: string): void {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}
