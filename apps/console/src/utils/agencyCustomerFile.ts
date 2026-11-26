import type { AgencyUploadResponse } from '../types/agency-campaign';
import { formatCount } from './format/number';

/**
 * The customer file a campaign takes: CSV, or an Excel workbook (`.xlsx`). New campaign's
 * Customers step and a campaign's Add contacts both offer it, so the picker's list, its label
 * and the sheet notice live here once (CS7; the server's rules are IM8 in `docs/decisions.md`).
 *
 * A legacy `.xls` is not offered: the server refuses it, and says why, when one is dropped.
 */
export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** The file input's `accept`: by extension and by type, for browsers that read either. */
export const CUSTOMER_FILE_ACCEPT = ['.csv', 'text/csv', '.xlsx', XLSX_MIME].join(',');

/** The file input's accessible name. */
export const CUSTOMER_FILE_LABEL = 'Excel or CSV file';

/**
 * An uploaded file's name without its `.csv`, `.xlsx` or `.xlsm`, to name a file made from it
 * (`Customers.xlsx` → `Customers`, then `Customers-rejected-rows.csv`). The downloads are CSV
 * whatever was uploaded. The same rule as the server's own download names: it reads a workbook
 * by its content, so a macro workbook (`.xlsm`) the picker does not offer can still be dropped.
 */
export function uploadBaseName(fileName: string): string {
  return fileName.replace(/\.(csv|xlsx|xlsm)$/i, '');
}

/** A workbook's name, `.xlsx` or `.xlsm`: the server reads one by its content, a macro workbook included. */
const WORKBOOK_NAME = /\.xls[xm]$/i;

/**
 * Whether a picked file looks like a workbook, by its name or its type. Only to say what the
 * upload is doing: an Excel file is read on the server before the upload answers, which can take
 * a while after the bytes are sent. The server decides by the file's content.
 */
export function isWorkbookFile(file: Pick<File, 'name' | 'type'>): boolean {
  return WORKBOOK_NAME.test(file.name.trim()) || file.type === XLSX_MIME;
}

/** The upload's busy line while the file is sent (and, for a workbook, read on the server). */
export function uploadingLine(workbook: boolean): string {
  return workbook ? 'Uploading and reading the file…' : 'Uploading…';
}

/**
 * What a refused upload says. The server's `message` as it is, except a 413 that is not the
 * server's own `file_too_large`: Fastify's bare one says "request file too large", and behind
 * nginx a 413 is an HTML page the client can only call "API error 413". Those are said plainly,
 * with the size the page knows (`AgencyIngestLimits.max_file_bytes`) when it has it.
 */
export function uploadErrorMessage(err: unknown, maxFileBytes: number | null | undefined): string {
  const refusal = err as { statusCode?: unknown; details?: unknown } | null;
  if (refusal && typeof refusal === 'object' && refusal.statusCode === 413) {
    const body = refusal.details as { code?: unknown; message?: unknown } | undefined;
    if (body && body.code === 'file_too_large' && typeof body.message === 'string' && body.message !== '') {
      return body.message;
    }
    return maxFileBytes && maxFileBytes > 0
      ? `This file is too large. A file can be up to ${formatCount(Math.floor(maxFileBytes / (1024 * 1024)))} MB.`
      : 'This file is too large to upload.';
  }
  return err instanceof Error && err.message !== '' ? err.message : 'Could not read that file.';
}

export interface SheetNoticeCopy {
  /** "Read from the sheet ‘Customers’." */
  read: string;
  /** The sheets that were not read and what to do about them, or null when there are none. */
  others: string | null;
}

/** The other sheets named in the notice; the rest are counted. */
const LISTED_SHEETS = 5;

/**
 * What an Excel upload says about its sheets: which one was read (only the first visible sheet
 * is, IM8) and, when the workbook has more, that they were not, and where to move their
 * customers: the sheet read, by name, since "the first sheet" can be a hidden tab. Counted from
 * `other_sheet_count` (the names stop at 255); at most five are named, each in quotes, as a
 * name can hold a comma. Null for a CSV.
 */
export function sheetNotice(
  upload: Pick<AgencyUploadResponse, 'sheet'> | null | undefined,
): SheetNoticeCopy | null {
  const sheet = upload?.sheet;
  if (!sheet) return null;
  const read = `Read from the sheet ‘${sheet.name}’.`;
  const names = sheet.other_sheet_names;
  const count = Math.max(sheet.other_sheet_count, names.length);
  if (count === 0) return { read, others: null };
  const listed = names.slice(0, LISTED_SHEETS).map((name) => `‘${name}’`).join(', ');
  const rest = count - Math.min(names.length, LISTED_SHEETS);
  const list = rest > 0 ? `${listed} and ${formatCount(rest)} more` : listed;
  const target = `move those customers to the sheet ‘${sheet.name}’`;
  const others = count === 1
    ? `This file has 1 other sheet (${list}) that was not read. To import it, ${target}, or save that sheet as its own file.`
    : `This file has ${formatCount(count)} other sheets (${list}) that were not read. To import them, ${target}, or save each sheet as its own file.`;
  return { read, others };
}
